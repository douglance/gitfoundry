import { Context, Data, Effect, Layer } from "effect";

import type { D1DatabaseLike, D1Result } from "../../../../packages/core/src/live/index.js";
import type { SourceReadPort } from "../source-read.js";

export type WorkflowRunStatus = "queued" | "dispatching" | "running" | "completed" | "failed" | "reconciliation_required";
export type WorkflowRunConclusion = "success" | "failure" | "cancelled";
export type WorkflowBackendStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkflowEvent {
  readonly name: string;
  readonly payload: unknown;
}

export interface WorkflowFile {
  readonly path: string;
  readonly contents: string;
  readonly sha256: string;
}

export interface WorkflowDispatchInput {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly operationId: string;
  readonly versionCommit: string;
  readonly codeCommit: string;
  readonly actorId: string;
  readonly event: WorkflowEvent;
}

export interface GitHubWorkflowRun {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly id: string;
  readonly operationId: string;
  readonly actorId: string;
  readonly repository: string;
  readonly versionCommit: string;
  readonly codeCommit: string;
  readonly inputDigest: string;
  readonly sourceDigest: string;
  readonly event: WorkflowEvent;
  readonly workflows: readonly WorkflowFile[];
  readonly status: WorkflowRunStatus;
  readonly conclusion: WorkflowRunConclusion | null;
  readonly backendRunId: string | null;
  readonly leaseId: string | null;
  readonly leaseGeneration: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | null;
}

export interface WorkflowTreeEntry { readonly path: string; readonly kind: "blob" | "tree" | "symlink" | "submodule" }
export interface WorkflowTreeResult { readonly repositoryId: string; readonly resolvedSha: string; readonly entries: readonly WorkflowTreeEntry[] }
export interface WorkflowFileResult { readonly repositoryId: string; readonly resolvedSha: string; readonly path: string; readonly contents: string | null; readonly truncated: boolean }

export interface GitHubWorkflowSourceShape {
  readonly tree: (input: { readonly tenantId: string; readonly repositoryId: string; readonly ref: string; readonly path: string }) => Effect.Effect<WorkflowTreeResult, WorkflowSourceInvalidError | WorkflowSourceUnavailableError>;
  readonly readFile: (input: { readonly tenantId: string; readonly repositoryId: string; readonly ref: string; readonly path: string }) => Effect.Effect<WorkflowFileResult, WorkflowSourceInvalidError | WorkflowSourceUnavailableError>;
}

export interface WorkflowBackendScheduleInput extends WorkflowDispatchInput {
  readonly runId: string;
  readonly workflows: readonly WorkflowFile[];
  readonly sourceDigest: string;
}

export interface WorkflowBackendScheduleResult { readonly backendRunId: string }
export interface WorkflowBackendIdentity {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly operationId: string;
  readonly runId: string;
  readonly sourceDigest: string;
  readonly versionCommit: string;
  readonly codeCommit: string;
  readonly backendRunId: string;
  readonly workflows?: readonly WorkflowManifestEntry[];
}
export interface WorkflowManifestEntry { readonly path: string; readonly sha256: string }
export interface WorkflowBackendRecoveryInput {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly operationId: string;
  readonly runId: string;
  readonly sourceDigest: string;
  readonly versionCommit: string;
  readonly codeCommit: string;
  readonly workflows: readonly WorkflowFile[];
}
export interface WorkflowBackendRecoveryResult { readonly backendRunId: string }
export interface WorkflowBackendInspection extends WorkflowBackendIdentity {
  readonly backendRunId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly repository: string;
  readonly versionCommit: string;
  readonly codeCommit: string;
  readonly status: WorkflowBackendStatus;
  readonly conclusion: WorkflowRunConclusion | null;
}
export interface WorkflowBackendCancelAck { readonly acknowledged: boolean }

export interface GitHubWorkflowBackendShape {
  readonly schedule: (input: WorkflowBackendScheduleInput) => Effect.Effect<WorkflowBackendScheduleResult, WorkflowBackendRejectedError | WorkflowBackendUnavailableError | WorkflowBackendUncertainAckError>;
  readonly recover: (input: WorkflowBackendRecoveryInput) => Effect.Effect<WorkflowBackendRecoveryResult, WorkflowBackendRejectedError | WorkflowBackendUnavailableError>;
  readonly inspect: (input: WorkflowBackendIdentity) => Effect.Effect<WorkflowBackendInspection, WorkflowBackendRejectedError | WorkflowBackendUnavailableError>;
  readonly cancel: (input: WorkflowBackendIdentity) => Effect.Effect<WorkflowBackendCancelAck, WorkflowBackendRejectedError | WorkflowBackendUnavailableError>;
}

export interface GitHubWorkflowStoreShape {
  readonly reserve: (input: WorkflowStoreReserveInput) => Effect.Effect<GitHubWorkflowRun, WorkflowStoreError | WorkflowReplayConflict>;
  readonly claimDispatch: (input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string; readonly expectedLeaseGeneration: number }) => Effect.Effect<GitHubWorkflowRun | null, WorkflowStoreError>;
  readonly markRunning: (input: WorkflowStoreFenceInput & { readonly backendRunId: string }) => Effect.Effect<GitHubWorkflowRun, WorkflowStoreError>;
  readonly attachRecoveredBackend: (input: WorkflowStoreFenceInput & { readonly backendRunId: string }) => Effect.Effect<GitHubWorkflowRun, WorkflowStoreError>;
  readonly markReconciliationRequired: (input: WorkflowStoreFenceInput & { readonly backendRunId: string | null; readonly message: string }) => Effect.Effect<GitHubWorkflowRun, WorkflowStoreError>;
  readonly markFailed: (input: WorkflowStoreFenceInput & { readonly message: string }) => Effect.Effect<GitHubWorkflowRun, WorkflowStoreError>;
  readonly complete: (input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string; readonly backendRunId: string; readonly status: "completed" | "failed"; readonly conclusion: WorkflowRunConclusion; readonly message?: string }) => Effect.Effect<GitHubWorkflowRun, WorkflowStoreError>;
  readonly get: (input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string }) => Effect.Effect<GitHubWorkflowRun | null, WorkflowStoreError>;
  readonly getByOperation: (input: { readonly tenantId: string; readonly repositoryId: string; readonly operationId: string }) => Effect.Effect<GitHubWorkflowRun | null, WorkflowStoreError>;
  readonly list: (input: { readonly tenantId: string; readonly repositoryId: string; readonly limit?: number }) => Effect.Effect<readonly GitHubWorkflowRun[], WorkflowStoreError>;
}

export interface GitHubWorkflowServiceShape {
  readonly dispatch: (input: WorkflowDispatchInput) => Effect.Effect<GitHubWorkflowRun, GitHubWorkflowError>;
  readonly get: (input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string }) => Effect.Effect<GitHubWorkflowRun | null, WorkflowStoreError>;
  readonly list: (input: { readonly tenantId: string; readonly repositoryId: string; readonly limit?: number }) => Effect.Effect<readonly GitHubWorkflowRun[], WorkflowStoreError>;
  readonly cancel: (input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string }) => Effect.Effect<GitHubWorkflowRun, WorkflowStoreError | WorkflowBackendRejectedError | WorkflowBackendUnavailableError | WorkflowBackendIdentityMismatch>;
  readonly reconcile: (input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string }) => Effect.Effect<GitHubWorkflowRun, WorkflowStoreError | WorkflowBackendRejectedError | WorkflowBackendUnavailableError | WorkflowBackendIdentityMismatch>;
}

export interface WorkflowStoreReserveInput extends WorkflowDispatchInput {
  readonly inputDigest: string;
  readonly sourceDigest: string;
  readonly workflows: readonly WorkflowFile[];
}

export interface WorkflowStoreFenceInput {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
}

export class WorkflowSourceInvalidError extends Data.TaggedError("WorkflowSourceInvalidError")<{ readonly message: string; readonly path?: string; readonly cause?: unknown }> {}
export class WorkflowSourceUnavailableError extends Data.TaggedError("WorkflowSourceUnavailableError")<{ readonly message: string; readonly cause?: unknown }> {}
export class WorkflowReplayConflict extends Data.TaggedError("WorkflowReplayConflict")<{ readonly message: string; readonly operationId: string }> {}
export class WorkflowStoreError extends Data.TaggedError("WorkflowStoreError")<{ readonly message: string; readonly cause?: unknown }> {}
export class WorkflowBackendRejectedError extends Data.TaggedError("WorkflowBackendRejectedError")<{ readonly message: string; readonly cause?: unknown }> {}
export class WorkflowBackendUnavailableError extends Data.TaggedError("WorkflowBackendUnavailableError")<{ readonly message: string; readonly cause?: unknown }> {}
export class WorkflowBackendUncertainAckError extends Data.TaggedError("WorkflowBackendUncertainAckError")<{ readonly message: string; readonly backendRunId?: string; readonly cause?: unknown }> {}
export class WorkflowBackendIdentityMismatch extends Data.TaggedError("WorkflowBackendIdentityMismatch")<{ readonly message: string; readonly backendRunId?: string }> {}

export type GitHubWorkflowError = WorkflowSourceInvalidError | WorkflowSourceUnavailableError | WorkflowReplayConflict | WorkflowStoreError | WorkflowBackendRejectedError | WorkflowBackendUnavailableError | WorkflowBackendUncertainAckError | WorkflowBackendIdentityMismatch;

export class GitHubWorkflowSource extends Context.Service<GitHubWorkflowSource, GitHubWorkflowSourceShape>()("gitfoundry/GitHubWorkflowSource") {}
export class GitHubWorkflowBackend extends Context.Service<GitHubWorkflowBackend, GitHubWorkflowBackendShape>()("gitfoundry/GitHubWorkflowBackend") {}
export class GitHubWorkflowStore extends Context.Service<GitHubWorkflowStore, GitHubWorkflowStoreShape>()("gitfoundry/GitHubWorkflowStore") {}
export class GitHubWorkflowService extends Context.Service<GitHubWorkflowService, GitHubWorkflowServiceShape>()("gitfoundry/GitHubWorkflowService") {}

export const GitHubWorkflowServiceLive = Layer.effect(GitHubWorkflowService, Effect.gen(function* () {
  const source = yield* GitHubWorkflowSource;
  const backend = yield* GitHubWorkflowBackend;
  const store = yield* GitHubWorkflowStore;
  return makeGitHubWorkflowService(source, backend, store);
}));

const workflowDirectory = ".github/workflows";
const workflowPathPattern = /^\.github\/workflows\/[^/\0]+\.ya?ml$/u;
const idPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const operationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const eventPattern = /^[A-Za-z0-9_.:-]{1,128}$/u;
const encoder = new TextEncoder();

export function makeGitHubWorkflowService(source: GitHubWorkflowSourceShape, backend: GitHubWorkflowBackendShape, store: GitHubWorkflowStoreShape): GitHubWorkflowServiceShape {
  const dispatch = (input: WorkflowDispatchInput) => Effect.gen(function* () {
    yield* validateDispatchInput(input);
    const workflows = yield* discoverWorkflowFiles(source, input);
    const sourceDigest = yield* digestJson(workflows.map(file => ({ path: file.path, sha256: file.sha256 })));
    const inputDigest = yield* digestJson({ ...input, sourceDigest, workflows });
    const reserved = yield* store.reserve({ ...input, workflows, sourceDigest, inputDigest });
    if (reserved.status !== "queued") return reserved;
    const claimed = yield* store.claimDispatch({ tenantId: input.tenantId, repositoryId: input.repositoryId, runId: reserved.id, expectedLeaseGeneration: reserved.leaseGeneration });
    if (!claimed) return yield* requireOperation(store, input.tenantId, input.repositoryId, input.operationId);
    const scheduleInput = { ...input, runId: claimed.id, workflows, sourceDigest };
    return yield* Effect.matchEffect(backend.schedule(scheduleInput), {
      onFailure: error => Effect.gen(function* () {
        if (error._tag === "WorkflowBackendUncertainAckError") {
          return yield* Effect.matchEffect(backend.recover(scheduleInput), {
            onFailure: () => store.markReconciliationRequired({ tenantId: input.tenantId, repositoryId: input.repositoryId, runId: claimed.id, leaseId: claimed.leaseId ?? "", leaseGeneration: claimed.leaseGeneration, backendRunId: error.backendRunId ?? null, message: error.message }),
            onSuccess: recovered => store.markRunning({ tenantId: input.tenantId, repositoryId: input.repositoryId, runId: claimed.id, leaseId: claimed.leaseId ?? "", leaseGeneration: claimed.leaseGeneration, backendRunId: recovered.backendRunId })
          });
        }
        yield* store.markFailed({ tenantId: input.tenantId, repositoryId: input.repositoryId, runId: claimed.id, leaseId: claimed.leaseId ?? "", leaseGeneration: claimed.leaseGeneration, message: error.message });
        return yield* Effect.fail(error);
      }),
      onSuccess: scheduled => store.markRunning({ tenantId: input.tenantId, repositoryId: input.repositoryId, runId: claimed.id, leaseId: claimed.leaseId ?? "", leaseGeneration: claimed.leaseGeneration, backendRunId: scheduled.backendRunId })
    });
  });

  const reconcile = (input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string }) => Effect.gen(function* () {
    let run = yield* requireRun(store, input);
    if (run.status === "completed" || run.status === "failed") return run;
    if (!isCompleteBackendRunId(run.backendRunId)) {
      run = yield* Effect.matchEffect(backend.recover(recoveryInput(run)), {
        onFailure: () => run.status === "reconciliation_required"
          ? Effect.succeed(run)
          : store.markReconciliationRequired({ tenantId: run.tenantId, repositoryId: run.repositoryId, runId: run.id, leaseId: run.leaseId ?? "", leaseGeneration: run.leaseGeneration, backendRunId: run.backendRunId, message: "workflow backend recovery incomplete" }),
        onSuccess: recovered => store.attachRecoveredBackend({ tenantId: run.tenantId, repositoryId: run.repositoryId, runId: run.id, leaseId: run.leaseId ?? "", leaseGeneration: run.leaseGeneration, backendRunId: recovered.backendRunId })
      });
    }
    if (!isCompleteBackendRunId(run.backendRunId)) return run;
    const inspection = yield* backend.inspect(backendIdentity(run));
    yield* validateInspection(run, inspection);
    if (inspection.status === "running") return run;
    if (inspection.status === "completed") {
      if (inspection.conclusion !== "success" && inspection.conclusion !== "failure") return yield* Effect.fail(new WorkflowBackendIdentityMismatch({ message: "backend completion is incomplete", backendRunId: inspection.backendRunId }));
      return yield* store.complete({ tenantId: run.tenantId, repositoryId: run.repositoryId, runId: run.id, backendRunId: run.backendRunId, status: inspection.conclusion === "success" ? "completed" : "failed", conclusion: inspection.conclusion });
    }
    if (inspection.status === "cancelled") return yield* store.complete({ tenantId: run.tenantId, repositoryId: run.repositoryId, runId: run.id, backendRunId: run.backendRunId, status: "completed", conclusion: "cancelled" });
    return yield* store.complete({ tenantId: run.tenantId, repositoryId: run.repositoryId, runId: run.id, backendRunId: run.backendRunId, status: "failed", conclusion: "failure" });
  });

  const cancel = (input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string }) => Effect.gen(function* () {
    const run = yield* requireRun(store, input);
    if (run.status === "completed" || run.status === "failed") return run;
    if (!run.backendRunId) return yield* Effect.fail(new WorkflowBackendIdentityMismatch({ message: "workflow run has no backend id" }));
    const ack = yield* backend.cancel(backendIdentity(run));
    if (!ack.acknowledged) return yield* Effect.fail(new WorkflowBackendRejectedError({ message: "backend cancellation was not acknowledged" }));
    return yield* reconcile(input);
  });

  return { dispatch, get: store.get, list: store.list, cancel, reconcile };
}

export function makeGitHubWorkflowSourceFromSourceRead(sourceRead: SourceReadPort): GitHubWorkflowSourceShape {
  return {
    tree: (input) => Effect.gen(function* () {
      const entries: WorkflowTreeEntry[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let treeSha: string | undefined;
      for (;;) {
        const page = yield* sourceRead.tree({ tenantId: input.tenantId, repositoryId: input.repositoryId, ref: input.ref, path: input.path, recursive: true, direction: "asc", limit: 1000, ...(cursor ? { cursor } : {}) }).pipe(
          Effect.mapError(error => mapSourceReadError(error, input.path))
        );
        if (page.truncated || page.repository_id !== input.repositoryId || page.resolved_sha !== input.ref || treeSha !== undefined && treeSha !== page.tree_sha) {
          return yield* Effect.fail(new WorkflowSourceInvalidError({ message: "workflow source listing is incomplete or changed identity", path: input.path }));
        }
        treeSha = page.tree_sha;
        entries.push(...page.items.map(item => ({ path: item.path, kind: item.kind })));
        if (entries.length > 10000) return yield* Effect.fail(new WorkflowSourceInvalidError({ message: "workflow source listing exceeds entry limit", path: input.path }));
        if (!page.has_more) {
          if (page.next_cursor !== null) return yield* Effect.fail(new WorkflowSourceInvalidError({ message: "workflow source cursor is inconsistent", path: input.path }));
          return { repositoryId: input.repositoryId, resolvedSha: input.ref, entries };
        }
        if (!page.next_cursor || seen.has(page.next_cursor)) return yield* Effect.fail(new WorkflowSourceInvalidError({ message: "workflow source paging is incomplete", path: input.path }));
        seen.add(page.next_cursor);
        cursor = page.next_cursor;
      }
    }),
    readFile: (input) => sourceRead.readFile({ tenantId: input.tenantId, repositoryId: input.repositoryId, ref: input.ref, path: input.path, maxBytes: 1024 * 1024 }).pipe(
      Effect.map(file => ({ repositoryId: file.repository_id, resolvedSha: file.resolved_sha, path: file.path, contents: file.contents, truncated: file.truncated })),
      Effect.mapError(error => mapSourceReadError(error, input.path))
    )
  };
}

function mapSourceReadError(error: unknown, path: string): WorkflowSourceInvalidError | WorkflowSourceUnavailableError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unavailable";
  const reason = error && typeof error === "object" && "reason" in error ? String(error.reason) : "source read failed";
  return code === "invalid_input"
    ? new WorkflowSourceInvalidError({ message: reason, path, cause: error })
    : new WorkflowSourceUnavailableError({ message: reason, cause: error });
}

interface WorkflowStoreIds { readonly now?: () => Date; readonly newRunId?: () => string; readonly newLeaseId?: () => string }
type D1Value = string | number | null;
type WorkflowRunRow = {
  tenant_id: string; repository_id: string; id: string; version: number; created_at: string; updated_at: string; actor_id: string; repository: string; operation_id: string; input_digest: string; source_digest: string; event_json: string; workflows_json: string; version_commit: string; code_commit: string; status: WorkflowRunStatus; conclusion: WorkflowRunConclusion | null; backend_run_id: string | null; lease_id: string | null; lease_generation: number; error: string | null;
};

export function makeD1GitHubWorkflowStore(db: D1DatabaseLike, ids: WorkflowStoreIds = {}): GitHubWorkflowStoreShape {
  const now = () => (ids.now?.() ?? new Date()).toISOString();
  const newRunId = () => ids.newRunId?.() ?? crypto.randomUUID();
  const newLeaseId = () => ids.newLeaseId?.() ?? crypto.randomUUID();

  const reserve = (input: WorkflowStoreReserveInput) => Effect.tryPromise({
    try: async () => {
      const existing = await readByOperation(db, input.tenantId, input.repositoryId, input.operationId);
      if (existing) return replayOrConflict(existing, input.inputDigest, input.operationId);
      const createdAt = now();
      const runId = newRunId();
      try {
        await db.prepare(`INSERT INTO github_workflow_runs(tenant_id,repository_id,id,version,created_at,updated_at,actor_id,repository,operation_id,input_digest,source_digest,event_json,workflows_json,version_commit,code_commit,status,lease_generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(input.tenantId, input.repositoryId, runId, 1, createdAt, createdAt, input.actorId, input.repository, input.operationId, input.inputDigest, input.sourceDigest, JSON.stringify(input.event), JSON.stringify(input.workflows), input.versionCommit, input.codeCommit, "queued", 0).run();
      } catch {
        const raced = await readByOperation(db, input.tenantId, input.repositoryId, input.operationId);
        if (raced) return replayOrConflict(raced, input.inputDigest, input.operationId);
        throw new Error("workflow run insert failed");
      }
      return requireWorkflowRun(await readRunRow(db, input.tenantId, input.repositoryId, runId));
    },
    catch: error => isWorkflowReplayConflict(error) ? error : new WorkflowStoreError({ message: "workflow reserve failed", cause: error })
  });

  const claimDispatch = (input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string; readonly expectedLeaseGeneration: number }) => Effect.tryPromise({
    try: async () => {
      const leaseId = newLeaseId();
      const updatedAt = now();
      const result = await db.prepare(`UPDATE github_workflow_runs SET version = version + 1, updated_at = ?, status = 'dispatching', lease_id = ?, lease_generation = lease_generation + 1 WHERE tenant_id = ? AND repository_id = ? AND id = ? AND status = 'queued' AND lease_generation = ?`)
        .bind(updatedAt, leaseId, input.tenantId, input.repositoryId, input.runId, input.expectedLeaseGeneration).run();
      if (changes(result) !== 1) return null;
      return requireWorkflowRun(await readRunRow(db, input.tenantId, input.repositoryId, input.runId));
    },
    catch: error => new WorkflowStoreError({ message: "workflow claim failed", cause: error })
  });

  const fenced = (input: WorkflowStoreFenceInput, sql: string, bindings: readonly D1Value[]) => Effect.tryPromise({
    try: async () => {
      const result = await db.prepare(sql).bind(...bindings).run();
      if (changes(result) !== 1) throw new Error("workflow fence mismatch");
      return requireWorkflowRun(await readRunRow(db, input.tenantId, input.repositoryId, input.runId));
    },
    catch: error => new WorkflowStoreError({ message: "workflow store fence failed", cause: error })
  });

  return {
    reserve,
    claimDispatch,
    markRunning: input => fenced(input, `UPDATE github_workflow_runs SET version = version + 1, updated_at = ?, status = 'running', backend_run_id = ?, error = NULL WHERE tenant_id = ? AND repository_id = ? AND id = ? AND status = 'dispatching' AND lease_id = ? AND lease_generation = ?`, [now(), input.backendRunId, input.tenantId, input.repositoryId, input.runId, input.leaseId, input.leaseGeneration]),
    attachRecoveredBackend: input => fenced(input, `UPDATE github_workflow_runs SET version = version + 1, updated_at = ?, status = 'running', backend_run_id = ?, error = NULL WHERE tenant_id = ? AND repository_id = ? AND id = ? AND status IN ('dispatching','reconciliation_required') AND lease_id = ? AND lease_generation = ?`, [now(), input.backendRunId, input.tenantId, input.repositoryId, input.runId, input.leaseId, input.leaseGeneration]),
    markReconciliationRequired: input => fenced(input, `UPDATE github_workflow_runs SET version = version + 1, updated_at = ?, status = 'reconciliation_required', backend_run_id = ?, error = ? WHERE tenant_id = ? AND repository_id = ? AND id = ? AND status = 'dispatching' AND lease_id = ? AND lease_generation = ?`, [now(), input.backendRunId, input.message.slice(0, 512), input.tenantId, input.repositoryId, input.runId, input.leaseId, input.leaseGeneration]),
    markFailed: input => fenced(input, `UPDATE github_workflow_runs SET version = version + 1, updated_at = ?, status = 'failed', conclusion = 'failure', error = ? WHERE tenant_id = ? AND repository_id = ? AND id = ? AND status = 'dispatching' AND lease_id = ? AND lease_generation = ?`, [now(), input.message.slice(0, 512), input.tenantId, input.repositoryId, input.runId, input.leaseId, input.leaseGeneration]),
    complete: input => Effect.tryPromise({
      try: async () => {
        const result = await db.prepare(`UPDATE github_workflow_runs SET version = version + 1, updated_at = ?, status = ?, conclusion = ?, error = ? WHERE tenant_id = ? AND repository_id = ? AND id = ? AND backend_run_id = ? AND status IN ('dispatching','running','reconciliation_required')`)
          .bind(now(), input.status, input.conclusion, input.message?.slice(0, 512) ?? null, input.tenantId, input.repositoryId, input.runId, input.backendRunId).run();
        if (changes(result) !== 1) throw new Error("workflow completion fence mismatch");
        return requireWorkflowRun(await readRunRow(db, input.tenantId, input.repositoryId, input.runId));
      },
      catch: error => new WorkflowStoreError({ message: "workflow completion failed", cause: error })
    }),
    get: input => Effect.tryPromise({ try: () => readRunRow(db, input.tenantId, input.repositoryId, input.runId), catch: error => new WorkflowStoreError({ message: "workflow read failed", cause: error }) }),
    getByOperation: input => Effect.tryPromise({ try: () => readByOperation(db, input.tenantId, input.repositoryId, input.operationId), catch: error => new WorkflowStoreError({ message: "workflow operation read failed", cause: error }) }),
    list: input => Effect.tryPromise({ try: async () => {
      const limit = Math.max(1, Math.min(100, input.limit ?? 50));
      const rows = await all<WorkflowRunRow>(db, `SELECT * FROM github_workflow_runs WHERE tenant_id = ? AND repository_id = ? ORDER BY created_at DESC LIMIT ?`, input.tenantId, input.repositoryId, limit);
      return rows.map(rowToRun);
    }, catch: error => new WorkflowStoreError({ message: "workflow list failed", cause: error }) })
  };
}

function discoverWorkflowFiles(source: GitHubWorkflowSourceShape, input: WorkflowDispatchInput): Effect.Effect<readonly WorkflowFile[], WorkflowSourceInvalidError | WorkflowSourceUnavailableError> {
  return Effect.gen(function* () {
    const tree = yield* source.tree({ tenantId: input.tenantId, repositoryId: input.repositoryId, ref: input.codeCommit, path: workflowDirectory });
    if (tree.repositoryId !== input.repositoryId || tree.resolvedSha !== input.codeCommit) return yield* Effect.fail(new WorkflowSourceInvalidError({ message: "workflow source resolved to unexpected commit" }));
    const paths: string[] = [];
    for (const entry of tree.entries) {
      if (!entry.path.startsWith(workflowDirectory + "/")) continue;
      if (entry.kind !== "blob" || !workflowPathPattern.test(entry.path)) return yield* Effect.fail(new WorkflowSourceInvalidError({ message: "workflow source path invalid", path: entry.path }));
      paths.push(entry.path);
    }
    paths.sort();
    if (paths.length === 0) return yield* Effect.fail(new WorkflowSourceInvalidError({ message: "workflow source has no workflow files", path: workflowDirectory }));
    const files: WorkflowFile[] = [];
    for (const path of paths) {
      const file = yield* source.readFile({ tenantId: input.tenantId, repositoryId: input.repositoryId, ref: input.codeCommit, path });
      if (file.repositoryId !== input.repositoryId || file.resolvedSha !== input.codeCommit || file.path !== path || file.truncated || file.contents === null) return yield* Effect.fail(new WorkflowSourceInvalidError({ message: "workflow file source invalid", path }));
      files.push({ path, contents: file.contents, sha256: yield* sha256Text(file.contents) });
    }
    return files;
  });
}

function validateDispatchInput(input: WorkflowDispatchInput): Effect.Effect<void, WorkflowSourceInvalidError> {
  if (!idPattern.test(input.tenantId)) return Effect.fail(new WorkflowSourceInvalidError({ message: "tenant id invalid" }));
  if (!idPattern.test(input.repositoryId)) return Effect.fail(new WorkflowSourceInvalidError({ message: "repository id invalid" }));
  if (!repositoryPattern.test(input.repository)) return Effect.fail(new WorkflowSourceInvalidError({ message: "repository name invalid" }));
  if (!operationPattern.test(input.operationId)) return Effect.fail(new WorkflowSourceInvalidError({ message: "operation id invalid" }));
  if (!idPattern.test(input.actorId)) return Effect.fail(new WorkflowSourceInvalidError({ message: "actor id invalid" }));
  if (!shaPattern.test(input.versionCommit) || !shaPattern.test(input.codeCommit)) return Effect.fail(new WorkflowSourceInvalidError({ message: "commit id invalid" }));
  if (!eventPattern.test(input.event.name)) return Effect.fail(new WorkflowSourceInvalidError({ message: "workflow event invalid" }));
  return Effect.void;
}

function validateInspection(run: GitHubWorkflowRun, inspection: WorkflowBackendInspection): Effect.Effect<void, WorkflowBackendIdentityMismatch> {
  if (inspection.backendRunId !== run.backendRunId || inspection.tenantId !== run.tenantId || inspection.repositoryId !== run.repositoryId || inspection.repository !== run.repository || inspection.versionCommit !== run.versionCommit || inspection.codeCommit !== run.codeCommit || inspection.operationId !== run.operationId || inspection.runId !== run.id || inspection.sourceDigest !== run.sourceDigest) {
    return Effect.fail(new WorkflowBackendIdentityMismatch({ message: "backend inspection identity mismatch", backendRunId: inspection.backendRunId }));
  }
  return Effect.void;
}

function backendIdentity(run: GitHubWorkflowRun): WorkflowBackendIdentity {
  return { ...recoveryInput(run), backendRunId: run.backendRunId ?? "", workflows: run.workflows.map(workflowManifestEntry) };
}

function recoveryInput(run: GitHubWorkflowRun): WorkflowBackendRecoveryInput {
  return { tenantId: run.tenantId, repositoryId: run.repositoryId, repository: run.repository, versionCommit: run.versionCommit, codeCommit: run.codeCommit, operationId: run.operationId, runId: run.id, sourceDigest: run.sourceDigest, workflows: run.workflows };
}

function workflowManifestEntry(workflow: WorkflowFile): WorkflowManifestEntry {
  return { path: workflow.path, sha256: workflow.sha256 };
}

function isCompleteBackendRunId(backendRunId: string | null): backendRunId is string {
  return Boolean(backendRunId && !backendRunId.includes(":partial:"));
}

function requireRun(store: GitHubWorkflowStoreShape, input: { readonly tenantId: string; readonly repositoryId: string; readonly runId: string }): Effect.Effect<GitHubWorkflowRun, WorkflowStoreError> {
  return Effect.gen(function* () {
    const run = yield* store.get(input);
    if (!run) return yield* Effect.fail(new WorkflowStoreError({ message: "workflow run not found" }));
    return run;
  });
}

function requireOperation(store: GitHubWorkflowStoreShape, tenantId: string, repositoryId: string, operationId: string): Effect.Effect<GitHubWorkflowRun, WorkflowStoreError> {
  return Effect.gen(function* () {
    const run = yield* store.getByOperation({ tenantId, repositoryId, operationId });
    if (!run) return yield* Effect.fail(new WorkflowStoreError({ message: "workflow operation not found" }));
    return run;
  });
}

function replayOrConflict(run: GitHubWorkflowRun, inputDigest: string, operationId: string): GitHubWorkflowRun {
  if (run.inputDigest !== inputDigest) throw new WorkflowReplayConflict({ message: "operation id already belongs to different workflow input", operationId });
  return run;
}

function isWorkflowReplayConflict(error: unknown): error is WorkflowReplayConflict {
  return Boolean(error && typeof error === "object" && "_tag" in error && error._tag === "WorkflowReplayConflict");
}

async function readRunRow(db: D1DatabaseLike, tenantId: string, repositoryId: string, runId: string): Promise<GitHubWorkflowRun | null> {
  const row = await db.prepare(`SELECT * FROM github_workflow_runs WHERE tenant_id = ? AND repository_id = ? AND id = ? LIMIT 1`).bind(tenantId, repositoryId, runId).first<WorkflowRunRow>();
  return row ? rowToRun(row) : null;
}

async function readByOperation(db: D1DatabaseLike, tenantId: string, repositoryId: string, operationId: string): Promise<GitHubWorkflowRun | null> {
  const row = await db.prepare(`SELECT * FROM github_workflow_runs WHERE tenant_id = ? AND repository_id = ? AND operation_id = ? LIMIT 1`).bind(tenantId, repositoryId, operationId).first<WorkflowRunRow>();
  return row ? rowToRun(row) : null;
}

async function all<T>(db: D1DatabaseLike, sql: string, ...bindings: readonly D1Value[]): Promise<readonly T[]> {
  const result = await db.prepare(sql).bind(...bindings).all<T>();
  return result.results ?? [];
}

function rowToRun(row: WorkflowRunRow): GitHubWorkflowRun {
  const workflows = JSON.parse(row.workflows_json) as WorkflowFile[];
  const event = JSON.parse(row.event_json) as WorkflowEvent;
  if (!digestPattern.test(row.input_digest) || !digestPattern.test(row.source_digest) || !Array.isArray(workflows)) throw new Error("workflow run corrupt");
  return { tenantId: row.tenant_id, repositoryId: row.repository_id, id: row.id, operationId: row.operation_id, actorId: row.actor_id, repository: row.repository, versionCommit: row.version_commit, codeCommit: row.code_commit, inputDigest: row.input_digest, sourceDigest: row.source_digest, event, workflows, status: row.status, conclusion: row.conclusion, backendRunId: row.backend_run_id, leaseId: row.lease_id, leaseGeneration: row.lease_generation, createdAt: row.created_at, updatedAt: row.updated_at, error: row.error };
}

function requireWorkflowRun(run: GitHubWorkflowRun | null): GitHubWorkflowRun {
  if (!run) throw new Error("workflow run missing after write");
  return run;
}

function changes(result: D1Result): number { return Number(result.meta?.changes ?? 0); }
function digestJson(value: unknown): Effect.Effect<string> { return sha256Text(stableJson(value)); }
function sha256Text(value: string): Effect.Effect<string> { return Effect.promise(async () => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))))); }
function hex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
