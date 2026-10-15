import { Data, Effect } from "effect";

import {
  WorkflowBackendIdentityMismatch,
  WorkflowBackendRejectedError,
  WorkflowBackendUnavailableError,
  WorkflowReplayConflict,
  WorkflowSourceInvalidError,
  WorkflowSourceUnavailableError,
  WorkflowStoreError,
  type GitHubWorkflowRun,
  type GitHubWorkflowServiceShape,
  type WorkflowBackendUncertainAckError,
  type WorkflowDispatchInput
} from "./workflows.js";

export type WorkflowRepositoryCapability = "repository.read" | "repository.write";

export interface GitHubWorkflowHttpScope {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly repository: string;
}

export interface GitHubWorkflowVerifiedActor {
  readonly actorId: string;
}

export interface GitHubWorkflowVerifiedVersion extends GitHubWorkflowHttpScope {
  readonly versionCommit: string;
  readonly codeCommit: string;
}

export interface GitHubWorkflowAuthenticateInput {
  readonly request: Request;
  readonly scope: GitHubWorkflowHttpScope;
  readonly capability: WorkflowRepositoryCapability;
}

export type GitHubWorkflowAuthenticationResult =
  | { readonly ok: true; readonly actor: GitHubWorkflowVerifiedActor }
  | { readonly ok: false; readonly denialResponse: Response };

export interface GitHubWorkflowVerifyVersionInput {
  readonly request: Request;
  readonly scope: GitHubWorkflowHttpScope;
  readonly versionCommit: string;
}

export interface GitHubWorkflowServiceFactoryInput {
  readonly request: Request;
  readonly scope: GitHubWorkflowHttpScope;
  readonly actor: GitHubWorkflowVerifiedActor;
  readonly capability: WorkflowRepositoryCapability;
  readonly version?: GitHubWorkflowVerifiedVersion;
}

export interface GitHubWorkflowHttpPorts {
  readonly owner: GitHubWorkflowHttpScope;
  readonly authenticate: (input: GitHubWorkflowAuthenticateInput) => Effect.Effect<GitHubWorkflowAuthenticationResult, GitHubWorkflowHttpPortError>;
  readonly verifyVersion: (input: GitHubWorkflowVerifyVersionInput) => Effect.Effect<GitHubWorkflowVerifiedVersion, GitHubWorkflowHttpPortError>;
  readonly workflowService: (input: GitHubWorkflowServiceFactoryInput) => Effect.Effect<GitHubWorkflowServiceShape, GitHubWorkflowHttpPortError>;
}

export class GitHubWorkflowHttpPortError extends Data.TaggedError("GitHubWorkflowHttpPortError")<{ readonly message: string; readonly cause?: unknown }> {}

const maxJsonBytes = 64 * 1024;
const idPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const operationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const eventPattern = /^[A-Za-z0-9_.:-]{1,128}$/u;

interface RouteMatch {
  readonly kind: "collection" | "run" | "reconcile" | "cancel";
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly runId?: string;
}

type MutationBody = Record<string, unknown>;
type WorkflowHttpError = { readonly status: 400 | 403 | 404 | 409 | 503; readonly error: string; readonly detail?: string };

export function handleGitHubWorkflowRequestEffect(request: Request, ports: GitHubWorkflowHttpPorts): Effect.Effect<Response | undefined> {
  return Effect.gen(function* () {
    const route = matchWorkflowRoute(new URL(request.url));
    if (route === undefined) return undefined;
    if (route instanceof Response) return route;

    // Only the one repository configured for GitHub workflows runs them here; every other repository's
    // runs, and every run when none is configured, belong to GitFoundry's own runner.
    if (route.tenantId !== ports.owner.tenantId || route.repositoryId !== ports.owner.repositoryId) return undefined;
    const scope = validateOwnerScope(ports.owner);
    if (!scope.ok) return jsonError(scope.error);

    const capability = route.kind === "collection" && request.method === "GET" || route.kind === "run" && request.method === "GET" ? "repository.read" : "repository.write";
    const method = validateMethod(route, request.method);
    if (!method.ok) return jsonError(method.error);

    const query = validateQuery(new URL(request.url), route);
    if (!query.ok) return jsonError(query.error);

    const authAttempt = yield* effectResult(ports.authenticate({ request, scope: scope.value, capability }));
    if (!authAttempt.ok) return jsonError({ status: 503, error: "workflow_port_unavailable", detail: authAttempt.error.message });
    const auth = authAttempt.value;
    if (!auth.ok) return auth.denialResponse;

    if (route.kind === "collection" && request.method === "POST") return yield* dispatchWorkflow(request, ports, scope.value, auth.actor);
    if (route.kind === "collection" && request.method === "GET") return yield* listWorkflowRuns(request, ports, scope.value, auth.actor, query.limit);
    if (route.kind === "run" && request.method === "GET" && route.runId) return yield* readWorkflowRun(request, ports, scope.value, auth.actor, route.runId);
    if (route.kind === "reconcile" && request.method === "POST" && route.runId) return yield* mutateExistingWorkflow(request, ports, scope.value, auth.actor, route.runId, "reconcile");
    if (route.kind === "cancel" && request.method === "POST" && route.runId) return yield* mutateExistingWorkflow(request, ports, scope.value, auth.actor, route.runId, "cancel");
    return jsonError({ status: 404, error: "workflow_route_not_found" });
  });
}

export async function handleGitHubWorkflowRequest(request: Request, ports: GitHubWorkflowHttpPorts): Promise<Response | undefined> {
  return Effect.runPromise(handleGitHubWorkflowRequestEffect(request, ports), { signal: request.signal });
}

function dispatchWorkflow(request: Request, ports: GitHubWorkflowHttpPorts, scope: GitHubWorkflowHttpScope, actor: GitHubWorkflowVerifiedActor): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const body = yield* readMutationBody(request);
    if (!body.ok) return jsonError(body.error);
    const operationId = operationIdFromBodyAndHeader(request, body.value);
    if (!operationId.ok) return jsonError(operationId.error);
    const event = workflowEventFromBody(body.value);
    if (!event.ok) return jsonError(event.error);
    const versionCommit = stringField(body.value, "versionCommit") ?? stringField(body.value, "version_commit");
    if (!versionCommit || !shaPattern.test(versionCommit)) return jsonError({ status: 400, error: "workflow_body_invalid", detail: "versionCommit is required" });

    const verified = yield* effectResult(ports.verifyVersion({ request, scope, versionCommit }));
    if (!verified.ok) return jsonError({ status: 503, error: "workflow_version_unavailable", detail: verified.error.message });
    const version = verified.value;
    const versionCheck = validateVerifiedVersion(scope, version, versionCommit);
    if (!versionCheck.ok) return jsonError(versionCheck.error);
    const identity = rejectForgedIdentity(body.value, scope, actor, version);
    if (!identity.ok) return jsonError(identity.error);

    const service = yield* ports.workflowService({ request, scope, actor, capability: "repository.write", version }).pipe(toResult);
    if (!service.ok) return jsonError({ status: 503, error: "workflow_service_unavailable", detail: service.error.message });

    const input: WorkflowDispatchInput = {
      tenantId: scope.tenantId,
      repositoryId: scope.repositoryId,
      repository: version.repository,
      operationId: operationId.value,
      versionCommit: version.versionCommit,
      codeCommit: version.codeCommit,
      actorId: actor.actorId,
      event: event.value
    };
    const result = yield* service.value.dispatch(input).pipe(toResult);
    if (!result.ok) return workflowErrorResponse(result.error);
    return runResponse(result.value);
  });
}

function listWorkflowRuns(request: Request, ports: GitHubWorkflowHttpPorts, scope: GitHubWorkflowHttpScope, actor: GitHubWorkflowVerifiedActor, limit: number | undefined): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const service = yield* ports.workflowService({ request, scope, actor, capability: "repository.read" }).pipe(toResult);
    if (!service.ok) return jsonError({ status: 503, error: "workflow_service_unavailable", detail: service.error.message });
    const result = yield* service.value.list({ tenantId: scope.tenantId, repositoryId: scope.repositoryId, ...(limit === undefined ? {} : { limit }) }).pipe(toResult);
    if (!result.ok) return workflowErrorResponse(result.error);
    return Response.json({ schema_version: 1, runs: result.value.map(runDto) }, { status: 200 });
  });
}

function readWorkflowRun(request: Request, ports: GitHubWorkflowHttpPorts, scope: GitHubWorkflowHttpScope, actor: GitHubWorkflowVerifiedActor, runId: string): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const service = yield* ports.workflowService({ request, scope, actor, capability: "repository.read" }).pipe(toResult);
    if (!service.ok) return jsonError({ status: 503, error: "workflow_service_unavailable", detail: service.error.message });
    const result = yield* service.value.get({ tenantId: scope.tenantId, repositoryId: scope.repositoryId, runId }).pipe(toResult);
    if (!result.ok) return workflowErrorResponse(result.error);
    return result.value ? runResponse(result.value, 200) : jsonError({ status: 404, error: "workflow_run_not_found" });
  });
}

function mutateExistingWorkflow(request: Request, ports: GitHubWorkflowHttpPorts, scope: GitHubWorkflowHttpScope, actor: GitHubWorkflowVerifiedActor, runId: string, action: "reconcile" | "cancel"): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const body = yield* readMutationBody(request);
    if (!body.ok) return jsonError(body.error);
    const operationId = operationIdFromBodyAndHeader(request, body.value);
    if (!operationId.ok) return jsonError(operationId.error);
    const suppliedRunId = stringField(body.value, "runId") ?? stringField(body.value, "run_id");
    if (suppliedRunId !== undefined && suppliedRunId !== runId) return jsonError({ status: 400, error: "workflow_body_invalid", detail: "run id mismatch" });

    const service = yield* ports.workflowService({ request, scope, actor, capability: "repository.write" }).pipe(toResult);
    if (!service.ok) return jsonError({ status: 503, error: "workflow_service_unavailable", detail: service.error.message });
    const result = yield* (action === "reconcile"
      ? service.value.reconcile({ tenantId: scope.tenantId, repositoryId: scope.repositoryId, runId })
      : service.value.cancel({ tenantId: scope.tenantId, repositoryId: scope.repositoryId, runId })).pipe(toResult);
    if (!result.ok) return workflowErrorResponse(result.error);
    return runResponse(result.value);
  });
}

function matchWorkflowRoute(url: URL): RouteMatch | Response | undefined {
  const parts = url.pathname.split("/");
  if (parts[0] !== "" || parts[1] !== "api" || parts[2] !== "v2" || parts[3] !== "tenants" || parts[5] !== "repositories" || parts[7] !== "actions" || parts[8] !== "runs") return undefined;
  if (parts.length !== 9 && parts.length !== 10 && parts.length !== 11) return jsonError({ status: 404, error: "workflow_route_not_found" });
  if (parts[5] !== "repositories" || parts[7] !== "actions" || parts[8] !== "runs") return jsonError({ status: 404, error: "workflow_route_not_found" });
  const tenantId = decodeIdSegment(parts[4] ?? "");
  const repositoryId = decodeIdSegment(parts[6] ?? "");
  if (!tenantId.ok || !repositoryId.ok) return jsonError({ status: 400, error: "workflow_route_invalid", detail: "tenant or repository id invalid" });
  if (parts.length === 9) return { kind: "collection", tenantId: tenantId.value, repositoryId: repositoryId.value };
  const runId = decodeIdSegment(parts[9] ?? "");
  if (!runId.ok) return jsonError({ status: 400, error: "workflow_route_invalid", detail: "run id invalid" });
  if (parts.length === 10) return { kind: "run", tenantId: tenantId.value, repositoryId: repositoryId.value, runId: runId.value };
  if (parts[10] === "reconcile") return { kind: "reconcile", tenantId: tenantId.value, repositoryId: repositoryId.value, runId: runId.value };
  if (parts[10] === "cancel") return { kind: "cancel", tenantId: tenantId.value, repositoryId: repositoryId.value, runId: runId.value };
  return jsonError({ status: 404, error: "workflow_route_not_found" });
}

function validateMethod(route: RouteMatch, method: string): { readonly ok: true } | { readonly ok: false; readonly error: WorkflowHttpError } {
  if (route.kind === "collection" && (method === "GET" || method === "POST")) return { ok: true };
  if (route.kind === "run" && method === "GET") return { ok: true };
  if ((route.kind === "reconcile" || route.kind === "cancel") && method === "POST") return { ok: true };
  return { ok: false, error: { status: 404, error: "workflow_route_not_found" } };
}

function validateQuery(url: URL, route: RouteMatch): { readonly ok: true; readonly limit?: number } | { readonly ok: false; readonly error: WorkflowHttpError } {
  const allowed = route.kind === "collection" && url.searchParams.has("limit") ? new Set(["limit"]) : new Set<string>();
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!allowed.has(key)) return { ok: false, error: { status: 400, error: "workflow_query_invalid", detail: `query parameter ${key} is not allowed` } };
    if (url.searchParams.getAll(key).length !== 1) return { ok: false, error: { status: 400, error: "workflow_query_invalid", detail: `query parameter ${key} is duplicated` } };
  }
  if (!url.searchParams.has("limit")) return { ok: true };
  const raw = url.searchParams.get("limit") ?? "";
  if (!/^\d{1,3}$/u.test(raw)) return { ok: false, error: { status: 400, error: "workflow_query_invalid", detail: "limit is invalid" } };
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { ok: false, error: { status: 400, error: "workflow_query_invalid", detail: "limit is out of range" } };
  return { ok: true, limit };
}

function validateOwnerScope(scope: GitHubWorkflowHttpScope): { readonly ok: true; readonly value: GitHubWorkflowHttpScope } | { readonly ok: false; readonly error: WorkflowHttpError } {
  if (!idPattern.test(scope.tenantId) || !idPattern.test(scope.repositoryId) || !repositoryPattern.test(scope.repository)) return { ok: false, error: { status: 503, error: "workflow_scope_unavailable" } };
  return { ok: true, value: scope };
}

function decodeIdSegment(value: string): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  try {
    const decoded = decodeURIComponent(value);
    if (!idPattern.test(decoded)) return { ok: false };
    return { ok: true, value: decoded };
  } catch {
    return { ok: false };
  }
}

function effectResult<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: E }> {
  return effect.pipe(toResult);
}

function toResult<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: E }> {
  return effect.pipe(Effect.match({
    onFailure: error => ({ ok: false as const, error }),
    onSuccess: value => ({ ok: true as const, value })
  }));
}

function readMutationBody(request: Request): Effect.Effect<{ readonly ok: true; readonly value: MutationBody } | { readonly ok: false; readonly error: WorkflowHttpError }> {
  return Effect.tryPromise({
    try: async signal => {
      const length = request.headers.get("content-length");
      if (length !== null && Number(length) > maxJsonBytes) return { ok: false as const, error: { status: 400 as const, error: "workflow_body_too_large" } };
      const bytes = await readBoundedBody(request, signal);
      if (!bytes.ok) return bytes;
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.value); } catch { return { ok: false as const, error: { status: 400 as const, error: "workflow_body_invalid", detail: "body must be utf-8" } }; }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return { ok: false as const, error: { status: 400 as const, error: "workflow_body_invalid", detail: "body must be json" } }; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false as const, error: { status: 400 as const, error: "workflow_body_invalid", detail: "body must be an object" } };
      return { ok: true as const, value: parsed as MutationBody };
    },
    catch: cause => ({ ok: false as const, error: { status: 400 as const, error: "workflow_body_invalid", detail: String(cause) } })
  }).pipe(Effect.match({ onFailure: error => error, onSuccess: value => value }));
}

async function readBoundedBody(request: Request, signal: AbortSignal): Promise<{ readonly ok: true; readonly value: Uint8Array } | { readonly ok: false; readonly error: WorkflowHttpError }> {
  if (!request.body) return { ok: false, error: { status: 400, error: "workflow_body_invalid", detail: "body is required" } };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maxJsonBytes) return { ok: false, error: { status: 400, error: "workflow_body_too_large" } };
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return { ok: true, value: out };
}

function operationIdFromBodyAndHeader(request: Request, body: MutationBody): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: WorkflowHttpError } {
  const bodyOperationId = stringField(body, "operationId") ?? stringField(body, "operation_id");
  const headerOperationId = request.headers.get("idempotency-key") ?? request.headers.get("x-idempotency-key") ?? request.headers.get("x-gfy-operation-id");
  if (!bodyOperationId || !operationPattern.test(bodyOperationId)) return { ok: false, error: { status: 400, error: "workflow_idempotency_invalid", detail: "operationId is required" } };
  if (!headerOperationId || headerOperationId !== bodyOperationId) return { ok: false, error: { status: 400, error: "workflow_idempotency_invalid", detail: "idempotency header must match operationId" } };
  return { ok: true, value: bodyOperationId };
}

function workflowEventFromBody(body: MutationBody): { readonly ok: true; readonly value: WorkflowDispatchInput["event"] } | { readonly ok: false; readonly error: WorkflowHttpError } {
  const event = body.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return { ok: false, error: { status: 400, error: "workflow_body_invalid", detail: "event is required" } };
  const record = event as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || !eventPattern.test(name)) return { ok: false, error: { status: 400, error: "workflow_body_invalid", detail: "event name is invalid" } };
  return { ok: true, value: { name, payload: Object.hasOwn(record, "payload") ? record.payload : null } };
}

function validateVerifiedVersion(scope: GitHubWorkflowHttpScope, version: GitHubWorkflowVerifiedVersion, requestedVersionCommit: string): { readonly ok: true } | { readonly ok: false; readonly error: WorkflowHttpError } {
  if (version.tenantId !== scope.tenantId || version.repositoryId !== scope.repositoryId || version.repository !== scope.repository || version.versionCommit !== requestedVersionCommit || !shaPattern.test(version.codeCommit)) {
    return { ok: false, error: { status: 403, error: "workflow_version_forbidden" } };
  }
  return { ok: true };
}

function rejectForgedIdentity(body: MutationBody, scope: GitHubWorkflowHttpScope, actor: GitHubWorkflowVerifiedActor, version: GitHubWorkflowVerifiedVersion): { readonly ok: true } | { readonly ok: false; readonly error: WorkflowHttpError } {
  const checks: ReadonlyArray<readonly [string, string]> = [
    ["tenantId", scope.tenantId], ["tenant_id", scope.tenantId],
    ["repositoryId", scope.repositoryId], ["repository_id", scope.repositoryId],
    ["repository", version.repository], ["actorId", actor.actorId], ["actor_id", actor.actorId],
    ["codeCommit", version.codeCommit], ["code_commit", version.codeCommit]
  ];
  for (const [key, expected] of checks) {
    const value = stringField(body, key);
    if (value !== undefined && value !== expected) return { ok: false, error: { status: 403, error: "workflow_identity_forbidden", detail: `${key} is derived from verified context` } };
  }
  return { ok: true };
}

function stringField(body: MutationBody, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function runResponse(run: GitHubWorkflowRun, forcedStatus?: 200): Response {
  const terminal = run.status === "completed" || run.status === "failed";
  const state = run.status === "reconciliation_required" ? "reconciliation_required" : terminal ? "terminal" : "pending";
  return Response.json({ schema_version: 1, state, run: runDto(run) }, { status: forcedStatus ?? (terminal ? 200 : 202) });
}

function runDto(run: GitHubWorkflowRun) {
  return {
    tenant_id: run.tenantId,
    repository_id: run.repositoryId,
    id: run.id,
    operation_id: run.operationId,
    actor_id: run.actorId,
    repository: run.repository,
    version_commit: run.versionCommit,
    code_commit: run.codeCommit,
    event: run.event,
    workflow_files: run.workflows.map(file => ({ path: file.path, sha256: file.sha256 })),
    status: run.status,
    conclusion: run.conclusion,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    ...(run.error ? { error: run.error } : {})
  };
}

function workflowErrorResponse(error: WorkflowStoreError | WorkflowBackendRejectedError | WorkflowBackendUnavailableError | WorkflowBackendIdentityMismatch | WorkflowBackendUncertainAckError | WorkflowReplayConflict | WorkflowSourceInvalidError | WorkflowSourceUnavailableError): Response {
  if (error instanceof WorkflowSourceInvalidError) return jsonError({ status: 400, error: "workflow_source_invalid", detail: error.message });
  if (error instanceof WorkflowReplayConflict) return jsonError({ status: 409, error: "workflow_idempotency_conflict", detail: error.message });
  if (error instanceof WorkflowBackendRejectedError) return jsonError({ status: 409, error: "workflow_backend_rejected", detail: error.message });
  if (error instanceof WorkflowBackendIdentityMismatch) return jsonError({ status: 409, error: "workflow_backend_identity_mismatch", detail: error.message });
  if (error instanceof WorkflowStoreError && error.message.includes("not found")) return jsonError({ status: 404, error: "workflow_run_not_found", detail: error.message });
  return jsonError({ status: 503, error: "workflow_unavailable", detail: error.message });
}

function jsonError(input: WorkflowHttpError): Response {
  return Response.json({ ok: false, error: input.error, status: input.status, ...(input.detail ? { detail: input.detail } : {}) }, { status: input.status });
}
