import { Effect, Layer } from "effect";

import { ActionsBackend, type ActionsBackend as ActionsBackendShape } from "./backend.js";
import {
  GitHubWorkflowBackend,
  WorkflowBackendRejectedError,
  WorkflowBackendUnavailableError,
  WorkflowBackendUncertainAckError,
  type GitHubWorkflowBackendShape,
  type WorkflowBackendCancelAck,
  type WorkflowBackendInspection,
  type WorkflowBackendScheduleInput,
  type WorkflowBackendScheduleResult,
  type WorkflowBackendStatus,
  type WorkflowFile
} from "./workflows.js";

export interface UpstreamWorkflowBackendOptions {
  readonly origin?: string;
  readonly maxScheduleBytes?: number;
  readonly maxRecoveryPages?: number;
}

interface GitFoundryWorkflowIdentity {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly operationId: string;
  readonly runId: string;
  readonly versionCommit: string;
  readonly codeCommit: string;
  readonly sourceDigest: string;
  readonly workflows: readonly { readonly path: string; readonly sha256: string }[];
}

interface RuntimeAttempt {
  readonly attempt?: unknown;
  readonly eventName?: unknown;
  readonly eventPayload?: unknown;
  readonly sha?: unknown;
  readonly status?: unknown;
  readonly result?: unknown;
}

interface RuntimeJob {
  readonly runid?: unknown;
  readonly runId?: unknown;
  readonly status?: unknown;
  readonly result?: unknown;
}

interface RuntimeRun {
  readonly id?: unknown;
  readonly fileName?: unknown;
  readonly owner?: unknown;
  readonly repo?: unknown;
  readonly sha?: unknown;
  readonly status?: unknown;
  readonly result?: unknown;
}

interface RuntimeRunState {
  readonly status: WorkflowBackendStatus;
  readonly conclusion: WorkflowBackendInspection["conclusion"];
}

const defaultOrigin = "http://gitfoundry-actions.local";
const backendRunPrefix = "runner-server:";
const schedulePath = "/runner/server/_apis/v1/Message/schedule2";
const messagePath = "/runner/server/_apis/v1/Message";
const maxDefaultScheduleBytes = 256 * 1024;
const maxDefaultRecoveryPages = 10;
const runtimeRunsPageSize = 30;
const statusByNumber = ["pending", "waiting", "queued", "running", "completed"];
const resultByNumber = ["succeeded", "succeededwithissues", "failed", "canceled", "skipped", "abandoned"];

class MissingRuntimeRunId extends Error {}
class IncompleteRuntimeRunSet extends Error {
  constructor(readonly runIds: readonly number[]) {
    super("schedule response completed before every workflow run was acknowledged");
  }
}
class RuntimeScheduleStreamError extends Error {}

export function makeUpstreamGitHubWorkflowBackend(actions: ActionsBackendShape, options: UpstreamWorkflowBackendOptions = {}): GitHubWorkflowBackendShape {
  const origin = normalizeOrigin(options.origin ?? defaultOrigin);
  const maxScheduleBytes = options.maxScheduleBytes ?? maxDefaultScheduleBytes;
  const maxRecoveryPages = options.maxRecoveryPages ?? maxDefaultRecoveryPages;

  const schedule = (input: WorkflowBackendScheduleInput): Effect.Effect<WorkflowBackendScheduleResult, WorkflowBackendRejectedError | WorkflowBackendUnavailableError | WorkflowBackendUncertainAckError> => Effect.gen(function* () {
    const scheduledWorkflows = input.workflows;
    if (scheduledWorkflows.length === 0) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime has no workflow files" }));
    const fetched = yield* Effect.matchEffect(actions.fetch(scheduleRequest(origin, input, scheduledWorkflows)), {
      onFailure: error => Effect.succeed({ _tag: "Failure" as const, error }),
      onSuccess: response => Effect.succeed({ _tag: "Success" as const, response })
    });
    if (fetched._tag === "Failure") {
      const runtimeRunIds = yield* recoverSchedule(actions, origin, input, maxRecoveryPages, [], fetched.error);
      return { backendRunId: formatBackendRunId(runtimeRunIds) };
    }
    const response = fetched.response;
    yield* expectScheduleAccepted(response);
    const runtimeRunIds = yield* Effect.matchEffect(readRuntimeRunIds(response, scheduledWorkflows.length, maxScheduleBytes), {
      onFailure: error => recoverSchedule(actions, origin, input, maxRecoveryPages, error instanceof IncompleteRuntimeRunSet ? error.runIds : [], error),
      onSuccess: Effect.succeed
    });
    return { backendRunId: formatBackendRunId(runtimeRunIds) };
  });

  const recover: GitHubWorkflowBackendShape["recover"] = input => recoverRuntimeRunIds(actions, origin, input, maxRecoveryPages).pipe(
    Effect.map(runIds => ({ backendRunId: formatBackendRunId(runIds) }))
  );

  const inspect = (input: Parameters<GitHubWorkflowBackendShape["inspect"]>[0]): Effect.Effect<WorkflowBackendInspection, WorkflowBackendRejectedError | WorkflowBackendUnavailableError> => Effect.gen(function* () {
    const runtimeRunIds = yield* rejectedSync(() => parseBackendRunId(input.backendRunId), "workflow runtime backend id invalid");
    const states = yield* Effect.all(runtimeRunIds.map(runtimeRunId => inspectRuntimeRun(actions, origin, input, runtimeRunId)));
    const state = aggregateRuntimeStates(states);
    return { ...input, status: state.status, conclusion: state.conclusion };
  });

  const cancel = (input: Parameters<GitHubWorkflowBackendShape["cancel"]>[0]): Effect.Effect<WorkflowBackendCancelAck, WorkflowBackendRejectedError | WorkflowBackendUnavailableError> => Effect.gen(function* () {
    const runtimeRunIds = yield* rejectedSync(() => parseBackendRunId(input.backendRunId), "workflow runtime backend id invalid");
    yield* inspect(input);
    yield* Effect.all(runtimeRunIds.map(runtimeRunId => Effect.gen(function* () {
      const response = yield* actions.fetch(new Request(url(origin, `${messagePath}/cancelWorkflow/${runtimeRunId}`), { method: "POST" })).pipe(
        Effect.mapError(error => new WorkflowBackendUnavailableError({ message: "workflow runtime cancel request failed", cause: error }))
      );
      yield* expectMutableResponse(response, "workflow runtime cancel request failed");
    })));
    return { acknowledged: true };
  });

  return { schedule, recover, inspect, cancel };
}

export const UpstreamGitHubWorkflowBackendLive = (options: UpstreamWorkflowBackendOptions = {}) => Layer.effect(
  GitHubWorkflowBackend,
  Effect.gen(function* () {
    const actions = yield* ActionsBackend;
    return makeUpstreamGitHubWorkflowBackend(actions, options);
  })
);

function scheduleRequest(origin: string, input: WorkflowBackendScheduleInput, scheduledWorkflows: readonly WorkflowFile[]): Request {
  const event = scheduleEvent(input);
  const form = new FormData();
  form.set("event", new Blob([JSON.stringify(event)], { type: "application/json" }), "event.json");
  for (const workflow of scheduledWorkflows) {
    form.append("workflow", new Blob([workflow.contents], { type: "application/x-yaml" }), workflow.path);
  }
  const requestUrl = url(origin, schedulePath, {
    Repository: input.repository,
    Ref: event.ref,
    Sha: input.codeCommit,
    localcheckout: "true"
  });
  return new Request(requestUrl, {
    method: "POST",
    headers: {
      "X-GitHub-Event": input.event.name,
      "X-GitHub-Delivery": input.operationId,
      "X-GitFoundry-Tenant": input.tenantId,
      "X-GitFoundry-Repository": input.repositoryId,
      "X-GitFoundry-Run": input.runId,
      "X-GitFoundry-Version-Commit": input.versionCommit,
      "X-GitFoundry-Code-Commit": input.codeCommit
    },
    body: form
  });
}

function scheduleEvent(input: WorkflowBackendScheduleInput): Record<string, unknown> & { ref: string } {
  const payload: Record<string, unknown> = isRecord(input.event.payload) ? { ...input.event.payload } : { value: input.event.payload };
  const [owner, name] = input.repository.split("/");
  const ref = selectedRef(payload, input.codeCommit);
  const identity: GitFoundryWorkflowIdentity = {
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    repository: input.repository,
    operationId: input.operationId,
    runId: input.runId,
    versionCommit: input.versionCommit,
    codeCommit: input.codeCommit,
    sourceDigest: input.sourceDigest,
    workflows: input.workflows.map(workflowIdentity)
  };
  return {
    ...payload,
    ref,
    after: input.codeCommit,
    before: typeof payload.before === "string" ? payload.before : "0".repeat(40),
    repository: {
      ...(isRecord(payload.repository) ? payload.repository : {}),
      name,
      full_name: input.repository,
      default_branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "main",
      owner: { login: owner, ...(isRecord(payload.repository) && isRecord(payload.repository.owner) ? payload.repository.owner : {}) }
    },
    head_commit: {
      ...(isRecord(payload.head_commit) ? payload.head_commit : {}),
      id: input.codeCommit,
      message: `GitFoundry workflow dispatch ${input.operationId}`
    },
    commits: Array.isArray(payload.commits) && payload.commits.length > 0 ? payload.commits : [{ id: input.codeCommit, message: `GitFoundry workflow dispatch ${input.operationId}` }],
    sender: isRecord(payload.sender) ? payload.sender : { login: input.actorId, type: "User" },
    gitfoundry: identity
  };
}

function workflowIdentity(file: WorkflowFile): { readonly path: string; readonly sha256: string } {
  return { path: file.path, sha256: file.sha256 };
}

function selectedRef(payload: Record<string, unknown>, codeCommit: string): string {
  return typeof payload.ref === "string" && payload.ref.startsWith("refs/")
    ? payload.ref
    : `refs/heads/gitfoundry/${codeCommit.slice(0, 12)}`;
}

function expectScheduleAccepted(response: Response): Effect.Effect<void, WorkflowBackendRejectedError | WorkflowBackendUnavailableError> {
  if (response.status >= 200 && response.status < 300) return Effect.void;
  return response.status >= 500
    ? Effect.fail(new WorkflowBackendUnavailableError({ message: `workflow runtime schedule unavailable: ${response.status}` }))
    : Effect.fail(new WorkflowBackendRejectedError({ message: `workflow runtime rejected schedule: ${response.status}` }));
}

function expectMutableResponse(response: Response, message: string): Effect.Effect<void, WorkflowBackendRejectedError | WorkflowBackendUnavailableError> {
  if (response.status >= 200 && response.status < 300) return Effect.void;
  return response.status >= 500
    ? Effect.fail(new WorkflowBackendUnavailableError({ message: `${message}: ${response.status}` }))
    : Effect.fail(new WorkflowBackendRejectedError({ message: `${message}: ${response.status}` }));
}

function readRuntimeRunIds(response: Response, expectedCount: number, maxBytes: number): Effect.Effect<readonly number[], MissingRuntimeRunId | IncompleteRuntimeRunSet | RuntimeScheduleStreamError> {
  return Effect.tryPromise({
    try: async () => {
      if (!response.body) throw new MissingRuntimeRunId("schedule response has no body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      const runIds = new Set<number>();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new MissingRuntimeRunId("schedule response exceeded run id search limit");
          text += decoder.decode(chunk.value, { stream: true });
          for (const runId of parseScheduleRunIds(text, false)) runIds.add(runId);
          if (runIds.size >= expectedCount) {
            await reader.cancel().catch(() => undefined);
            return [...runIds];
          }
        }
        text += decoder.decode();
        for (const runId of parseScheduleRunIds(text, true)) runIds.add(runId);
        if (runIds.size >= expectedCount) return [...runIds];
        if (runIds.size > 0) throw new IncompleteRuntimeRunSet([...runIds]);
        throw new MissingRuntimeRunId("schedule response completed without a run id");
      } catch (error) {
        if (error instanceof MissingRuntimeRunId || error instanceof IncompleteRuntimeRunSet) throw error;
        throw new RuntimeScheduleStreamError(String(error));
      } finally {
        reader.releaseLock();
      }
    },
    catch: error => error instanceof MissingRuntimeRunId || error instanceof IncompleteRuntimeRunSet ? error : new RuntimeScheduleStreamError(String(error))
  });
}

function parseScheduleRunIds(text: string, includeLastBlock: boolean): readonly number[] {
  const blocks = text.split(/\r?\n\r?\n/u);
  const runIds: number[] = [];
  const limit = includeLastBlock ? blocks.length : blocks.length - 1;
  for (let index = 0; index < limit; index++) {
    const lines = blocks[index]!.split(/\r?\n/u);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    const runId = parseRunIdJson(data);
    if (runId !== null && !runIds.includes(runId)) runIds.push(runId);
  }
  return runIds;
}

function parseRunIdJson(data: string): number | null {
  if (!data) return null;
  try {
    const value = JSON.parse(data) as unknown;
    if (isRecord(value)) {
      const raw = value.runid ?? value.runId;
      if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw;
      if (typeof raw === "string" && /^[0-9]+$/u.test(raw)) return Number(raw);
    }
  } catch {
    return null;
  }
  return null;
}

function fetchJsonArray<T>(actions: ActionsBackendShape, requestUrl: string): Effect.Effect<readonly T[], WorkflowBackendRejectedError | WorkflowBackendUnavailableError> {
  return Effect.gen(function* () {
    const response = yield* actions.fetch(new Request(requestUrl)).pipe(
      Effect.mapError(error => new WorkflowBackendUnavailableError({ message: "workflow runtime inspect request failed", cause: error }))
    );
    if (response.status === 404) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime run not found" }));
    if (response.status < 200 || response.status >= 300) return yield* Effect.fail(new WorkflowBackendUnavailableError({ message: `workflow runtime inspect unavailable: ${response.status}` }));
    const value = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: error => new WorkflowBackendUnavailableError({ message: "workflow runtime returned invalid JSON", cause: error })
    });
    if (Array.isArray(value)) return value as readonly T[];
    if (isRecord(value) && Array.isArray(value.value)) return value.value as readonly T[];
    return yield* Effect.fail(new WorkflowBackendUnavailableError({ message: "workflow runtime returned unexpected JSON" }));
  });
}

function recoverSchedule(actions: ActionsBackendShape, origin: string, input: WorkflowBackendScheduleInput, maxRecoveryPages: number, partialRunIds: readonly number[], cause: unknown): Effect.Effect<readonly number[], WorkflowBackendUncertainAckError> {
  return Effect.matchEffect(recoverRuntimeRunIds(actions, origin, input, maxRecoveryPages), {
    onFailure: error => Effect.fail(new WorkflowBackendUncertainAckError({
      message: "workflow schedule acknowledgement uncertain",
      ...(partialRunIds.length > 0 ? { backendRunId: `${backendRunPrefix}partial:${input.workflows.length}:${partialRunIds.join(",")}` } : {}),
      cause: error ?? cause
    })),
    onSuccess: Effect.succeed
  });
}

function recoverRuntimeRunIds(actions: ActionsBackendShape, origin: string, input: WorkflowBackendScheduleInput | Parameters<GitHubWorkflowBackendShape["recover"]>[0], maxRecoveryPages: number): Effect.Effect<readonly number[], WorkflowBackendRejectedError | WorkflowBackendUnavailableError> {
  return Effect.gen(function* () {
    const [owner, repo] = input.repository.split("/");
    const expected = new Map(input.workflows.map(workflow => [workflow.path, workflow.sha256]));
    const recovered = new Map<string, number>();
    for (let page = 1; page <= maxRecoveryPages; page++) {
      const runs = yield* fetchJsonArray<RuntimeRun>(actions, url(origin, `${messagePath}/workflow/runs`, { owner: owner ?? "", repo: repo ?? "", page: String(page) }));
      for (const run of runs) {
        const runtimeRunId = runtimeRunNumber(run.id);
        const fileName = typeof run.fileName === "string" ? run.fileName : "";
        if (runtimeRunId === null || fileName.length === 0 || run.owner !== owner || run.repo !== repo || run.sha !== input.codeCommit || !expected.has(fileName)) continue;
        const attempts = yield* fetchJsonArray<RuntimeAttempt>(actions, url(origin, `${messagePath}/workflow/run/${runtimeRunId}/attempts`));
        const attempt = latestAttempt(attempts);
        if (!attempt) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime recovery candidate has no attempts" }));
        const identity = yield* rejectedSync(() => readIdentity(attempt), "workflow runtime recovery identity invalid");
        if (identity.operationId !== input.operationId && identity.runId !== input.runId) continue;
        yield* rejectedSync(() => verifyIdentity({ ...input, backendRunId: formatBackendRunId(runtimeRunId), workflows: input.workflows.map(workflowIdentity) }, identity), "workflow runtime recovery identity mismatch");
        if (identity.codeCommit !== input.codeCommit || !sameManifest(input.workflows.map(workflowIdentity), identity.workflows)) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime recovery manifest mismatch" }));
        if (recovered.has(fileName)) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime recovery duplicate candidate" }));
        recovered.set(fileName, runtimeRunId);
      }
      if (runs.length < runtimeRunsPageSize) break;
      if (page === maxRecoveryPages) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime recovery page limit reached" }));
    }
    const runIds: number[] = [];
    for (const workflow of input.workflows) {
      const runtimeRunId = recovered.get(workflow.path);
      if (runtimeRunId === undefined) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime recovery incomplete" }));
      runIds.push(runtimeRunId);
    }
    return runIds;
  });
}

function inspectRuntimeRun(actions: ActionsBackendShape, origin: string, input: Parameters<GitHubWorkflowBackendShape["inspect"]>[0], runtimeRunId: number): Effect.Effect<RuntimeRunState, WorkflowBackendRejectedError | WorkflowBackendUnavailableError> {
  return Effect.gen(function* () {
    const attempts = yield* fetchJsonArray<RuntimeAttempt>(actions, url(origin, `${messagePath}/workflow/run/${runtimeRunId}/attempts`));
    const attempt = latestAttempt(attempts);
    if (!attempt) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime run has no attempts" }));
    const identity = yield* rejectedSync(() => readIdentity(attempt), "workflow runtime identity invalid");
    yield* rejectedSync(() => verifyIdentity(input, identity), "workflow runtime identity mismatch");
    const attemptNumber = numeric(attempt.attempt);
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime attempt number invalid" }));
    const jobs = yield* fetchJsonArray<RuntimeJob>(actions, url(origin, `${messagePath}/workflow/run/${runtimeRunId}/attempt/${attemptNumber}/jobs`));
    return yield* rejectedSync(() => runtimeState(attempt, jobs), "workflow runtime state invalid");
  });
}

function aggregateRuntimeStates(states: readonly RuntimeRunState[]): RuntimeRunState {
  if (states.some(state => state.status === "running")) return { status: "running", conclusion: null };
  if (states.some(state => state.conclusion === "failure" || state.status === "failed")) return { status: "failed", conclusion: "failure" };
  if (states.some(state => state.conclusion === "cancelled" || state.status === "cancelled")) return { status: "cancelled", conclusion: "cancelled" };
  if (states.length > 0 && states.every(state => state.status === "completed" && state.conclusion === "success")) return { status: "completed", conclusion: "success" };
  throw new WorkflowBackendRejectedError({ message: "workflow runtime aggregate completion is incomplete" });
}

function latestAttempt(attempts: readonly RuntimeAttempt[]): RuntimeAttempt | null {
  return [...attempts].sort((left, right) => numeric(right.attempt) - numeric(left.attempt))[0] ?? null;
}

function rejectedSync<T>(try_: () => T, message: string): Effect.Effect<T, WorkflowBackendRejectedError> {
  return Effect.try({
    try: try_,
    catch: error => error instanceof WorkflowBackendRejectedError ? error : new WorkflowBackendRejectedError({ message, cause: error })
  });
}

function readIdentity(attempt: RuntimeAttempt): GitFoundryWorkflowIdentity {
  if (typeof attempt.eventPayload !== "string" && !isRecord(attempt.eventPayload)) throw new WorkflowBackendRejectedError({ message: "workflow runtime attempt has no persisted event payload" });
  const payload = typeof attempt.eventPayload === "string" ? JSON.parse(attempt.eventPayload) as unknown : attempt.eventPayload;
  if (!isRecord(payload) || !isRecord(payload.gitfoundry)) throw new WorkflowBackendRejectedError({ message: "workflow runtime attempt has no GitFoundry identity" });
  const identity = payload.gitfoundry;
  return {
    tenantId: requiredString(identity.tenantId, "tenant id"),
    repositoryId: requiredString(identity.repositoryId, "repository id"),
    repository: requiredString(identity.repository, "repository"),
    operationId: requiredString(identity.operationId, "operation id"),
    runId: requiredString(identity.runId, "run id"),
    versionCommit: requiredString(identity.versionCommit, "version commit"),
    codeCommit: requiredString(identity.codeCommit, "code commit"),
    sourceDigest: requiredString(identity.sourceDigest, "source digest"),
    workflows: Array.isArray(identity.workflows) ? identity.workflows.map(item => {
      if (!isRecord(item)) throw new WorkflowBackendRejectedError({ message: "workflow runtime identity workflow entry invalid" });
      return { path: requiredString(item.path, "workflow path"), sha256: requiredString(item.sha256, "workflow digest") };
    }) : []
  };
}

function verifyIdentity(input: Parameters<GitHubWorkflowBackendShape["inspect"]>[0], identity: GitFoundryWorkflowIdentity): void {
  if (identity.tenantId !== input.tenantId || identity.repositoryId !== input.repositoryId || identity.repository !== input.repository || identity.versionCommit !== input.versionCommit || identity.codeCommit !== input.codeCommit || identity.operationId !== input.operationId || identity.runId !== input.runId || identity.sourceDigest !== input.sourceDigest) {
    throw new WorkflowBackendRejectedError({ message: "workflow runtime identity mismatch" });
  }
  if (input.workflows && !sameManifest(input.workflows, identity.workflows)) throw new WorkflowBackendRejectedError({ message: "workflow runtime identity manifest mismatch" });
}

function sameManifest(left: readonly { readonly path: string; readonly sha256: string }[], right: readonly { readonly path: string; readonly sha256: string }[]): boolean {
  const normalize = (items: readonly { readonly path: string; readonly sha256: string }[]) => [...items].map(item => `${item.path}\0${item.sha256}`).sort();
  const leftItems = normalize(left);
  const rightItems = normalize(right);
  return leftItems.length === rightItems.length && leftItems.every((item, index) => item === rightItems[index]);
}

function runtimeRunNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return Number(value);
  return null;
}

function runtimeState(attempt: RuntimeAttempt, jobs: readonly RuntimeJob[]): { readonly status: WorkflowBackendStatus; readonly conclusion: WorkflowBackendInspection["conclusion"] } {
  const attemptStatus = normalizedStatus(attempt.status);
  const jobStatuses = jobs.map(job => normalizedStatus(job.status));
  const jobResults = jobs.map(job => normalizedResult(job.result));
  if (attemptStatus !== "completed" || jobStatuses.some(status => status !== "completed")) return { status: "running", conclusion: null };
  const results = [normalizedResult(attempt.result), ...jobResults];
  if (results.some(result => result === "failed" || result === "abandoned")) return { status: "failed", conclusion: "failure" };
  if (results.some(result => result === "canceled")) return { status: "cancelled", conclusion: "cancelled" };
  if (results.length > 0 && results.every(result => result === "succeeded" || result === "succeededwithissues" || result === "skipped")) return { status: "completed", conclusion: "success" };
  throw new WorkflowBackendRejectedError({ message: "workflow runtime completion is incomplete" });
}

function normalizedStatus(value: unknown): string {
  if (typeof value === "number") return statusByNumber[value] ?? "unknown";
  return String(value ?? "").replace(/[_\s-]/gu, "").toLowerCase();
}

function normalizedResult(value: unknown): string {
  if (typeof value === "number") return resultByNumber[value] ?? "unknown";
  return String(value ?? "").replace(/[_\s-]/gu, "").toLowerCase();
}

function parseBackendRunId(backendRunId: string): readonly number[] {
  if (!backendRunId.startsWith(backendRunPrefix)) throw new WorkflowBackendRejectedError({ message: "workflow runtime backend id is not from Runner.Server" });
  const raw = backendRunId.slice(backendRunPrefix.length);
  if (!/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/u.test(raw)) throw new WorkflowBackendRejectedError({ message: "workflow runtime backend id is invalid" });
  return raw.split(",").map(Number);
}

function formatBackendRunId(runIds: number | readonly number[]): string {
  const values = Array.isArray(runIds) ? runIds : [runIds];
  return `${backendRunPrefix}${values.join(",")}`;
}

function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

function url(origin: string, path: string, query: Record<string, string> = {}): string {
  const value = new URL(path, origin);
  for (const [key, item] of Object.entries(query)) value.searchParams.set(key, item);
  return value.toString();
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new WorkflowBackendRejectedError({ message: `workflow runtime identity ${name} invalid` });
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
