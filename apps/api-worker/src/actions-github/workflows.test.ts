import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { ForgeTreePage, SourceReadPort, SourceTreeInput } from "../source-read.js";

import {
  GitHubWorkflowBackend,
  GitHubWorkflowService,
  GitHubWorkflowServiceLive,
  GitHubWorkflowSource,
  GitHubWorkflowStore,
  WorkflowBackendIdentityMismatch,
  WorkflowBackendRejectedError,
  WorkflowBackendUncertainAckError,
  WorkflowReplayConflict,
  WorkflowSourceInvalidError,
  makeD1GitHubWorkflowStore,
  makeGitHubWorkflowSourceFromSourceRead,
  type GitHubWorkflowBackendShape,
  type GitHubWorkflowSourceShape,
  type GitHubWorkflowStoreShape,
  type WorkflowBackendInspection,
  type WorkflowDispatchInput,
  type WorkflowFile
} from "./workflows.js";

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  async batch(statements: readonly { run(): Promise<any> }[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  prepare(sql: string) {
    const database = this.db;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) { return { ...this, values }; },
      async first<T>() { return database.prepare(sql).get(...(this.values as SQLInputValue[])) as T | null; },
      async all<T>() { return { results: database.prepare(sql).all(...(this.values as SQLInputValue[])) as T[] }; },
      async run() { const result = database.prepare(sql).run(...(this.values as SQLInputValue[])); return { success: true, meta: { changes: Number(result.changes) } }; }
    };
  }
}

const tenantId = "tenant-a";
const repositoryId = "repo-a";
const repository = "core/gitfoundry";
const versionCommit = "a".repeat(40);
const codeCommit = "b".repeat(40);
const now = new Date("2026-10-09T20:00:00.000Z");
let runCounter = 0;
let leaseCounter = 0;
let sql: SqliteD1;
let store: GitHubWorkflowStoreShape;
let source: FakeWorkflowSource;
let backend: FakeWorkflowBackend;

beforeEach(() => {
  runCounter = 0;
  leaseCounter = 0;
  sql = new SqliteD1();
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0009_github_workflow_runs.sql", import.meta.url), "utf8"));
  store = makeD1GitHubWorkflowStore(sql, {
    now: () => now,
    newRunId: () => `run-${++runCounter}`,
    newLeaseId: () => `lease-${++leaseCounter}`
  });
  source = new FakeWorkflowSource({ ".github/workflows/ci.yml": "name: ci\non: [push]\njobs: {}\n" });
  backend = new FakeWorkflowBackend();
});

describe("GitHub workflow dispatch service", () => {
  it("discovers only immutable .github workflow files and rejects escaped source paths", async () => {
    source.files.set(".github/workflows/../escape.yml", "name: escape\n");
    await expect(runDispatch()).rejects.toBeInstanceOf(WorkflowSourceInvalidError);
    expect(source.treeCalls).toEqual([{ tenantId, repositoryId, ref: codeCommit, path: ".github/workflows" }]);
    expect(source.treeCalls.map(call => call.path)).not.toContain(".tmppr");
    expect(backend.schedules).toHaveLength(0);

    source.files.delete(".github/workflows/../escape.yml");
    const run = await runDispatch();

    expect(run.status).toBe("running");
    expect(source.readCalls).toEqual([{ tenantId, repositoryId, ref: codeCommit, path: ".github/workflows/ci.yml" }]);
    expect(backend.schedules).toHaveLength(1);
    expect(backend.schedules[0]).toMatchObject({ tenantId, repositoryId, repository, versionCommit, codeCommit, operationId: "op-a" });
    expect(backend.schedules[0]?.workflows).toEqual([{ path: ".github/workflows/ci.yml", contents: "name: ci\non: [push]\njobs: {}\n", sha256: sha256("name: ci\non: [push]\njobs: {}\n") }]);
  });

  it("makes operation ids replayable only for the same source and event digest", async () => {
    const first = await runDispatch();
    const replay = await runDispatch();

    expect(replay.id).toBe(first.id);
    expect(backend.schedules).toHaveLength(1);

    await expect(runDispatch({ event: { name: "workflow_dispatch", payload: { changed: true } } })).rejects.toBeInstanceOf(WorkflowReplayConflict);
    source.files.set(".github/workflows/ci.yml", "name: ci\non: [push]\njobs:\n  test: {}\n");
    await expect(runDispatch()).rejects.toBeInstanceOf(WorkflowReplayConflict);
    expect(backend.schedules).toHaveLength(1);
  });

  it("lets only one concurrent dispatcher win the store lease", async () => {
    backend.delayMs = 25;

    const [first, second] = await Promise.all([runDispatch(), runDispatch()]);

    expect(first.id).toBe(second.id);
    expect(backend.schedules).toHaveLength(1);
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM github_workflow_runs WHERE status = 'running'").get()?.count).toBe(1);
  });

  it("records an uncertain backend acknowledgement for reconciliation and does not reschedule the operation", async () => {
    backend.scheduleFailure = new WorkflowBackendUncertainAckError({ message: "backend accepted before timeout", backendRunId: "backend-uncertain" });

    const first = await runDispatch();
    const replay = await runDispatch();

    expect(first.status).toBe("reconciliation_required");
    expect(first.backendRunId).toBe("backend-uncertain");
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("reconciliation_required");
    expect(backend.schedules).toHaveLength(1);
  });

  it("recovers and atomically attaches a complete backend id set during reconciliation", async () => {
    backend.scheduleFailure = new WorkflowBackendUncertainAckError({ message: "backend accepted before timeout" });

    const first = await runDispatch();
    backend.recoverBackendRunId = "backend-recovered";
    const recovered = await runReconcile(first.id);
    const replay = await runDispatch();

    expect(first.status).toBe("reconciliation_required");
    expect(first.backendRunId).toBeNull();
    expect(recovered.status).toBe("running");
    expect(recovered.backendRunId).toBe("backend-recovered");
    expect(replay.backendRunId).toBe("backend-recovered");
    expect(backend.schedules).toHaveLength(1);
    expect(backend.recovers).toHaveLength(2);
  });

  it("preserves reconciliation_required when recovery cannot prove the complete run set", async () => {
    backend.scheduleFailure = new WorkflowBackendUncertainAckError({ message: "backend accepted before timeout", backendRunId: "runner-server:partial:2:123" });

    const first = await runDispatch();
    backend.recoverFailure = new WorkflowBackendRejectedError({ message: "workflow runtime recovery incomplete" });
    const reconciled = await runReconcile(first.id);

    expect(reconciled.status).toBe("reconciliation_required");
    expect(reconciled.backendRunId).toBe("runner-server:partial:2:123");
    expect(backend.recovers).toHaveLength(2);
    expect(backend.inspects).toHaveLength(0);
  });

  it("rejects backend completion that does not match the persisted backend id and source identity", async () => {
    const run = await runDispatch();
    backend.inspectResult = { backendRunId: "other-backend", tenantId, repositoryId, repository, versionCommit, codeCommit, operationId: run.operationId, runId: run.id, sourceDigest: run.sourceDigest, status: "completed", conclusion: "success" };

    await expect(runReconcile(run.id)).rejects.toBeInstanceOf(WorkflowBackendIdentityMismatch);

    const stored = await Effect.runPromise(store.get({ tenantId, repositoryId, runId: run.id }));
    expect(stored?.status).toBe("running");
    expect(stored?.conclusion).toBeNull();
  });

  it("marks cancellation only after backend acknowledgement and never reports it as success", async () => {
    const run = await runDispatch();
    backend.cancelAck = false;

    await expect(runCancel(run.id)).rejects.toBeInstanceOf(WorkflowBackendRejectedError);
    expect((await Effect.runPromise(store.get({ tenantId, repositoryId, runId: run.id })))?.status).toBe("running");

    backend.cancelAck = true;
    const pending = await runCancel(run.id);
    expect(pending.status).toBe("running");
    expect(pending.conclusion).toBeNull();

    backend.inspectResult = { backendRunId: run.backendRunId!, tenantId, repositoryId, repository, versionCommit, codeCommit, operationId: run.operationId, runId: run.id, sourceDigest: run.sourceDigest, status: "cancelled", conclusion: "cancelled" };
    const cancelled = await runReconcile(run.id);
    expect(cancelled.status).toBe("completed");
    expect(cancelled.conclusion).toBe("cancelled");
    expect(cancelled.conclusion).not.toBe("success");
  });
});

describe("workflow source paging", () => {
  const page = (path: string, extra: Partial<ForgeTreePage> = {}): ForgeTreePage => ({
    items: [{ path, path_base64: null, mode: "100644", kind: "blob", sha: "d".repeat(40), size_bytes: 100 }],
    next_cursor: null, has_more: false, repository_id: repositoryId, resolved_sha: codeCommit,
    tree_sha: "e".repeat(40), truncated: false, truncation_reason: null, ...extra
  });

  it("reads every page at the same immutable code commit", async () => {
    const calls: SourceTreeInput[] = [];
    const source: SourceReadPort = {
      tree: input => { calls.push(input); return Effect.succeed(input.cursor ? page(".github/workflows/two.yml") : page(".github/workflows/one.yml", { next_cursor: "page-two", has_more: true })); },
      diff: () => Effect.die("unexpected diff"),
      readFile: () => Effect.die("unexpected file read")
    };
    const result = await Effect.runPromise(makeGitHubWorkflowSourceFromSourceRead(source).tree({ tenantId, repositoryId, ref: codeCommit, path: ".github/workflows" }));
    expect(result.entries.map(entry => entry.path)).toEqual([".github/workflows/one.yml", ".github/workflows/two.yml"]);
    expect(calls.map(call => ({ ref: call.ref, cursor: call.cursor }))).toEqual([{ ref: codeCommit, cursor: undefined }, { ref: codeCommit, cursor: "page-two" }]);
  });

  it("rejects truncated source instead of dispatching an incomplete workflow set", async () => {
    const source: SourceReadPort = {
      tree: () => Effect.succeed(page(".github/workflows/one.yml", { truncated: true, truncation_reason: "entry_limit" })),
      diff: () => Effect.die("unexpected diff"),
      readFile: () => Effect.die("unexpected file read")
    };
    await expect(Effect.runPromise(makeGitHubWorkflowSourceFromSourceRead(source).tree({ tenantId, repositoryId, ref: codeCommit, path: ".github/workflows" }))).rejects.toBeInstanceOf(WorkflowSourceInvalidError);
  });
});

function baseInput(extra: Partial<WorkflowDispatchInput> = {}): WorkflowDispatchInput {
  return {
    tenantId,
    repositoryId,
    repository,
    operationId: "op-a",
    versionCommit,
    codeCommit,
    actorId: "owner-a",
    event: { name: "workflow_dispatch", payload: { ref: "main" } },
    ...extra
  };
}

function layer() {
  const dependencies = Layer.mergeAll(
    Layer.succeed(GitHubWorkflowSource, source),
    Layer.succeed(GitHubWorkflowBackend, backend),
    Layer.succeed(GitHubWorkflowStore, store)
  );
  return Layer.mergeAll(dependencies, Layer.provide(GitHubWorkflowServiceLive, dependencies));
}

function runDispatch(extra: Partial<WorkflowDispatchInput> = {}) {
  return Effect.runPromise(Effect.gen(function* () {
    const service = yield* GitHubWorkflowService;
    return yield* service.dispatch(baseInput(extra));
  }).pipe(Effect.provide(layer())));
}

function runReconcile(runId: string) {
  return Effect.runPromise(Effect.gen(function* () {
    const service = yield* GitHubWorkflowService;
    return yield* service.reconcile({ tenantId, repositoryId, runId });
  }).pipe(Effect.provide(layer())));
}

function runCancel(runId: string) {
  return Effect.runPromise(Effect.gen(function* () {
    const service = yield* GitHubWorkflowService;
    return yield* service.cancel({ tenantId, repositoryId, runId });
  }).pipe(Effect.provide(layer())));
}

class FakeWorkflowSource implements GitHubWorkflowSourceShape {
  readonly files: Map<string, string>;
  readonly treeCalls: Array<{ tenantId: string; repositoryId: string; ref: string; path: string }> = [];
  readonly readCalls: Array<{ tenantId: string; repositoryId: string; ref: string; path: string }> = [];
  constructor(files: Record<string, string>) { this.files = new Map(Object.entries(files)); }
  tree(input: { tenantId: string; repositoryId: string; ref: string; path: string }) {
    this.treeCalls.push(input);
    return Effect.succeed({
      repositoryId: input.repositoryId,
      resolvedSha: input.ref,
      entries: [...this.files.keys()].map(path => ({ path, kind: "blob" as const }))
    });
  }
  readFile(input: { tenantId: string; repositoryId: string; ref: string; path: string }) {
    this.readCalls.push(input);
    const contents = this.files.get(input.path);
    return contents === undefined
      ? Effect.fail(new WorkflowSourceInvalidError({ message: "missing workflow", path: input.path }))
      : Effect.succeed({ repositoryId: input.repositoryId, resolvedSha: input.ref, path: input.path, contents, truncated: false });
  }
}

class FakeWorkflowBackend implements GitHubWorkflowBackendShape {
  readonly schedules: Array<{ tenantId: string; repositoryId: string; repository: string; operationId: string; runId: string; versionCommit: string; codeCommit: string; workflows: readonly WorkflowFile[] }> = [];
  readonly recovers: Array<{ tenantId: string; repositoryId: string; repository: string; operationId: string; runId: string; versionCommit: string; codeCommit: string; workflows: readonly WorkflowFile[] }> = [];
  readonly inspects: Array<Parameters<GitHubWorkflowBackendShape["inspect"]>[0]> = [];
  scheduleFailure: WorkflowBackendUncertainAckError | null = null;
  recoverBackendRunId: string | null = null;
  recoverFailure: WorkflowBackendRejectedError | null = null;
  inspectResult: WorkflowBackendInspection | null = null;
  cancelAck = true;
  delayMs = 0;

  schedule(input: Parameters<GitHubWorkflowBackendShape["schedule"]>[0]) {
    return Effect.tryPromise({
      try: async () => {
        if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
        this.schedules.push(input);
        if (this.scheduleFailure) throw this.scheduleFailure;
        return { backendRunId: `backend-${this.schedules.length}` };
      },
      catch: error => error as WorkflowBackendUncertainAckError
    });
  }
  recover(input: Parameters<GitHubWorkflowBackendShape["recover"]>[0]) {
    this.recovers.push(input);
    if (this.recoverFailure) return Effect.fail(this.recoverFailure);
    return this.recoverBackendRunId ? Effect.succeed({ backendRunId: this.recoverBackendRunId }) : Effect.fail(new WorkflowBackendRejectedError({ message: "workflow runtime recovery incomplete" }));
  }
  inspect(input: Parameters<GitHubWorkflowBackendShape["inspect"]>[0]) {
    this.inspects.push(input);
    return Effect.succeed(this.inspectResult ?? { ...input, status: "running" as const, conclusion: null });
  }
  cancel() {
    return this.cancelAck ? Effect.succeed({ acknowledged: true as const }) : Effect.succeed({ acknowledged: false as const });
  }
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
