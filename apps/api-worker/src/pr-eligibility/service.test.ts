import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { decodeSourceSchema } from "@gitfoundry/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeD1OperationStore, type Clock, type D1DatabaseLike, type D1PreparedStatement, type D1Result } from "../../../../packages/core/src/live/index.js";
import type { CandidateArtifactKind, ImmutableBlobLocator } from "../merge-candidate/artifact-store.js";
import { encodeMergeCandidatePrepareRequest, type MergeCandidatePrepareInput, type MergeCandidateResult } from "../merge-candidate/index.js";
import type { ReviewedDiffEvidence, StoredMergeCandidate } from "../merge-candidate/pipeline.js";
import { sourceDomain } from "../source-catalog.generated.js";
import type { CandidatePreparationRuntime } from "./runtime.js";
import { makeD1PrEligibilityService } from "./service.js";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

class SqliteStatement<T = Record<string, unknown>> implements D1PreparedStatement<T> {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly values: readonly unknown[] = []) {}
  bind(...values: readonly unknown[]): D1PreparedStatement<T> { return new SqliteStatement<T>(this.db, this.sql, values); }
  async first<R = T>(): Promise<R | null> { return this.db.prepare(this.sql).get(...this.values as SQLInputValue[]) as R | null; }
  async all<R = T>(): Promise<D1Result<R>> { return { success: true, results: this.db.prepare(this.sql).all(...this.values as SQLInputValue[]) as R[] }; }
  async run(): Promise<D1Result<T>> { const result = this.db.prepare(this.sql).run(...this.values as SQLInputValue[]); return { success: true, meta: { changes: Number(result.changes) } }; }
}

class SqliteD1 implements D1DatabaseLike {
  readonly db = new DatabaseSync(":memory:");
  beforeBatch: ((statements: readonly D1PreparedStatement[]) => void) | undefined;
  prepare<T = Record<string, unknown>>(sql: string): D1PreparedStatement<T> { return new SqliteStatement<T>(this.db, sql); }
  async batch(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
    this.beforeBatch?.(statements);
    this.db.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

const ts = "2026-10-09T00:00:00.000Z";
const laterTs = "2026-10-09T00:11:00.000Z";
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const candidate = "cccccccccccccccccccccccccccccccccccccccc";
const tree = "dddddddddddddddddddddddddddddddddddddddd";
const helperMergeOptions = { preserve_source_commits: true, signing: "disabled", external_filters: "disabled", hooks: "disabled", replace_refs: "disabled" };

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function rule(overrides: Record<string, unknown> = {}) {
  return { id: "rule-a", name: "main", state: "active", target: "branch", include_patterns: ["refs/heads/main"], exclude_patterns: [], require_pull_request: true, required_approvals: 0, require_human_approval: false, dismiss_stale_reviews: false, require_latest_push_approval: false, require_code_owners: false, require_resolved_threads: false, require_linear_history: false, require_signed_commits: false, require_merge_queue: false, allow_force_push: true, allow_deletion: true, allowed_writer_group_ids: [], required_checks: [], required_environment_ids: [], allowed_merge_methods: ["merge", "squash", "rebase", "fast-forward"], bypass: [], max_blob_size_bytes: null, forbidden_path_patterns: [], mandatory: false, ...overrides };
}

function install(sql: SqliteD1) {
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0001_handbook.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0003_pr_eligibility.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0004_pr_eligibility_finalization.sql", import.meta.url), "utf8"));
}

function seed(sql: SqliteD1, options: { sourceRepo?: string; draft?: number; closed?: string | null; actorActive?: number; rule?: Record<string, unknown> } = {}) {
  const sourceRepo = options.sourceRepo ?? "repo-a";
  sql.db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 7, "shard-a", "US", "{}");
  sql.db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-b", "tenant-b", "active", 7, "shard-b", "US", "{}");
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "actor-a", 1, ts, ts, "human", "Actor A", options.actorActive ?? 1, 1);
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "author-a", 1, ts, ts, "human", "Author A", 1, 1);
  sql.db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run("tenant-a", "ns-a", 1, ts, ts, "ns-a", "Namespace A");
  sql.db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 1, ts, ts, "ns-a", "target", "private", "main", 0, "tenant-a", "repo-a", null);
  if (sourceRepo !== "repo-a") sql.db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", sourceRepo, 1, ts, ts, "ns-a", "source", "private", "topic", 0, "tenant-a", sourceRepo, "repo-a");
  sql.db.prepare("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "issue-a", 5, ts, ts, "repo-a", 1, "PR", "Body", options.closed ? "closed" : "open", "", "author-a", "pull_request");
  sql.db.prepare("INSERT INTO pull_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", 3, ts, ts, "issue-a", "repo-a", sourceRepo, "refs/heads/topic", "refs/heads/main", head, base, options.draft ?? 0, null, null, options.closed ?? null);
  sql.db.prepare("INSERT INTO rulesets VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "ruleset-a", 1, ts, ts, "repo-a", 1, JSON.stringify(rule(options.rule)), 1);
}

type RuntimeDraft = { input: MergeCandidatePrepareInput; result: MergeCandidateResult; reviewedDiff: ReviewedDiffEvidence; candidate?: StoredMergeCandidate };

function runtime(status: "prepared" | "conflict" | "throw" = "prepared", beforeReturn: () => void = () => {}, mutate: (draft: RuntimeDraft) => void = () => {}) {
  const calls: unknown[] = [];
  const reviewedDiff = { algorithmVersion: "git-cli-unified-v1" as const, comparison: "three_dot" as const, contextLines: 3 as const, headSha: head, baseSha: base, mergeBaseShas: [base], patchSha256: sha("patch"), patchSizeBytes: 12, changedPathsSha256: sha("paths") };
  const port: CandidatePreparationRuntime = { prepare: async (input) => {
    calls.push(input);
    if (status === "throw") throw new Error("runtime unavailable");
    const request = encodeMergeCandidatePrepareRequest(input.candidate);
    const result: MergeCandidateResult = status === "prepared" ? { ok: true as const, status: "prepared" as const, candidateOid: candidate, candidateTree: tree, candidateBytesSha256: sha("raw"), gitVersion: "2.39.5", stateRef: `merge-candidates/requests/${request.requestSha256}/manifest.json`, originalToRebased: [] } : { ok: false as const, status: "conflict" as const, gitVersion: "2.39.5", stateRef: `merge-candidates/requests/${request.requestSha256}/conflict.json`, diagnostics: [{ code: "content", path: "src/app.ts" }] };
    const draft: RuntimeDraft = { input: input.candidate, result, reviewedDiff };
    if (status === "prepared") draft.candidate = { requestSha256: request.requestSha256, result: result as Extract<MergeCandidateResult, { ok: true }>, manifest: locator(input.candidate, request.requestSha256, "candidate_manifest"), rawCommit: locator(input.candidate, request.requestSha256, "candidate_raw_commit", { sha256: sha("raw") }), pack: locator(input.candidate, request.requestSha256, "candidate_pack"), reviewedDiff };
    mutate(draft);
    beforeReturn();
    return { result: draft.result, reviewedDiff: draft.reviewedDiff, ...(draft.candidate ? { candidate: draft.candidate } : {}) } as Awaited<ReturnType<CandidatePreparationRuntime["prepare"]>>;
  } };
  return { port, calls };
}

function locator(input: MergeCandidatePrepareInput, requestSha256: string, kind: CandidateArtifactKind, overrides: Partial<ImmutableBlobLocator> = {}): ImmutableBlobLocator { return { tenantId: input.tenantId, repositoryId: input.repositoryId, operationId: input.operationId, requestSha256, kind, sha256: sha(kind), sizeBytes: 42, key: `v1/tenants/${input.tenantId}/repositories/${input.repositoryId}/merge-operations/${input.operationId}/${requestSha256}/${kind}`, etag: `etag-${kind}`, version: `version-${kind}`, expiresAt: null, ...overrides }; }

function gitRead() {
  return { resolveRef: ({ repositoryId, ref }: { repositoryId: string; ref: string }) => Effect.succeed({ sha: repositoryId === "repo-a" && ref === "refs/heads/main" ? base : head }) };
}

function service(sql: SqliteD1, runtimePort: CandidatePreparationRuntime, clockValue: string | Clock = ts, authorize: (input: { tenantId: string; actorId: string; policyEpoch: number }) => Promise<void> = async () => {}) {
  const clock = typeof clockValue === "string" ? { now: () => new Date(clockValue) } : clockValue;
  return makeD1PrEligibilityService(sql, { runtime: runtimePort, gitRead: gitRead(), clock, authorize });
}

async function operationResult(sql: SqliteD1, id: string) {
  return Effect.runPromise(makeD1OperationStore(sql).get("tenant-a", id)).then((record) => record.result);
}

describe("D1 PR eligibility service", () => {
  it("persists blocked actual candidates with provider_unqualified blocker and typed operation result", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const fake = runtime("prepared");
    const snapshot = await service(sql, fake.port).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });

    decodeSourceSchema(sourceDomain, "ForgePrEligibility", snapshot);
    expect(snapshot).toMatchObject({ status: "blocked", candidate_sha: candidate, diff_digest: sha("patch") });
    expect(snapshot.blockers.map((b) => b.code)).toContain("provider_unqualified");
    expect(sql.db.prepare("SELECT candidate_sha FROM eligibility WHERE id = ?").get(snapshot.id)).toEqual({ candidate_sha: candidate });
    const result = await operationResult(sql, snapshot.id);
    expect(result).toMatchObject({ snapshot: { id: snapshot.id, candidate_sha: candidate }, committedAt: ts, source: { sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a" } });
    expect(result).toHaveProperty("candidate");
    expect(result).toHaveProperty("checkPlan");
    const call = fake.calls[0]! as { candidate: MergeCandidatePrepareInput };
    const expectedRequest = encodeMergeCandidatePrepareRequest(call.candidate);
    expect(result.candidate).toMatchObject({ requestSha256: expectedRequest.requestSha256, manifest: { operationId: snapshot.id, key: `v1/tenants/tenant-a/repositories/repo-a/merge-operations/${snapshot.id}/${expectedRequest.requestSha256}/candidate_manifest` }, rawCommit: { sha256: sha("raw") } });
    expect((result.checkPlan as { plan: { mergeOptions: unknown } }).plan.mergeOptions).toEqual(helperMergeOptions);
  });

  it.each([
    ["manifest digest array", (draft: RuntimeDraft) => { draft.candidate = { ...draft.candidate!, manifest: { ...draft.candidate!.manifest, sha256: [sha("array-digest")] as never } }; }],
    ["candidate request sha", (draft: RuntimeDraft) => { draft.candidate = { ...draft.candidate!, requestSha256: sha("wrong-request") }; }],
    ["result candidate oid", (draft: RuntimeDraft) => { draft.result = { ...(draft.result as Extract<MergeCandidateResult, { ok: true }>), candidateOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }; }],
    ["manifest tenant", (draft: RuntimeDraft) => { draft.candidate = { ...draft.candidate!, manifest: { ...draft.candidate!.manifest, tenantId: "tenant-b" } }; }],
    ["raw commit operation", (draft: RuntimeDraft) => { draft.candidate = { ...draft.candidate!, rawCommit: { ...draft.candidate!.rawCommit, operationId: "other-op" } }; }],
    ["pack kind", (draft: RuntimeDraft) => { draft.candidate = { ...draft.candidate!, pack: { ...draft.candidate!.pack, kind: "candidate_manifest" } }; }],
    ["manifest key", (draft: RuntimeDraft) => { draft.candidate = { ...draft.candidate!, manifest: { ...draft.candidate!.manifest, key: "v1/tenants/tenant-a/repositories/repo-a/merge-operations/other/request/candidate_manifest" } }; }],
    ["empty locator version", (draft: RuntimeDraft) => { draft.candidate = { ...draft.candidate!, pack: { ...draft.candidate!.pack, version: "" } }; }],
    ["duplicate merge base", (draft: RuntimeDraft) => { draft.reviewedDiff = { ...draft.reviewedDiff, mergeBaseShas: [base, base] }; draft.candidate = { ...draft.candidate!, reviewedDiff: draft.reviewedDiff }; }],
    ["extra reviewed diff field", (draft: RuntimeDraft) => { draft.reviewedDiff = { ...draft.reviewedDiff, unexpected: true } as ReviewedDiffEvidence; draft.candidate = { ...draft.candidate!, reviewedDiff: draft.reviewedDiff }; }]
  ])("rejects mismatched prepared candidate evidence: %s", async (_label, mutateDraft) => {
    const sql = new SqliteD1(); install(sql); seed(sql);

    await expect(service(sql, runtime("prepared", () => {}, mutateDraft).port).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "unavailable" });

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT result_key FROM operations").get()).toEqual({ result_key: null });
  });

  it("persists schema-valid conflict with real diff and without fake eligibility candidate", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const snapshot = await service(sql, runtime("conflict").port).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });

    decodeSourceSchema(sourceDomain, "ForgePrEligibility", snapshot);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.candidate_sha).toBeNull();
    expect(snapshot.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["conflict", "provider_unqualified"]));
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
    expect((await operationResult(sql, snapshot.id)).reviewedDiff).toMatchObject({ patchSha256: sha("patch") });
  });

  it("resumes an interrupted running generation with the same operation identity and committedAt", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    await expect(service(sql, runtime("throw").port).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "unavailable" });
    const retryRuntime = runtime("prepared");
    const snapshot = await service(sql, retryRuntime.port, "2026-10-09T00:01:00.000Z").get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });

    expect(snapshot.id).toBe("pr-eligibility-1074c692d9e991050c5bc3f04dc3f4bf-g1");
    expect((retryRuntime.calls[0]! as { candidate: { operationId: string; committedAt: string } }).candidate).toMatchObject({ operationId: snapshot.id, committedAt: ts });
    expect(snapshot.expires_at).toBe("2026-10-09T00:10:00.000Z");
  });

  it("rejects a runtime result that crosses the reserved expiry before finalization", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    let nowValue = ts;
    const clock = { now: () => new Date(nowValue) };
    const crossingRuntime = runtime("prepared", () => { nowValue = "2026-10-09T00:10:01.000Z"; });

    await expect(service(sql, crossingRuntime.port, clock).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "stale" });

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT result_key FROM operations").get()).toEqual({ result_key: null });
  });

  it("rejects finalization at the exact reserved expiry boundary", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    let nowValue = ts;
    const clock = { now: () => new Date(nowValue) };
    const crossingRuntime = runtime("prepared", () => { nowValue = "2026-10-09T00:10:00.000Z"; });

    await expect(service(sql, crossingRuntime.port, clock).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "stale" });

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT result_key FROM operations").get()).toEqual({ result_key: null });
  });

  it("rejects when candidate validation and check-plan identity construction reach the reserved expiry", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    let nowValue = ts;
    const clock = { now: () => new Date(nowValue) };
    const expiringRuntime = runtime("prepared", () => {}, (draft) => {
      const prepared = draft.result as Extract<MergeCandidateResult, { ok: true }>;
      draft.result = Object.defineProperty({ ...prepared }, "candidateTree", { enumerable: true, get: () => { nowValue = "2026-10-09T00:10:00.000Z"; return tree; } }) as Extract<MergeCandidateResult, { ok: true }>;
      draft.candidate = { ...draft.candidate!, result: draft.result as Extract<MergeCandidateResult, { ok: true }> };
    });

    await expect(service(sql, expiringRuntime.port, clock).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "stale" });

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT result_key FROM operations").get()).toEqual({ result_key: null });
  });

  it("refreshes an expired unchanged logical key with a new generation operation", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    await expect(service(sql, runtime("throw").port).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "unavailable" });
    const retryRuntime = runtime("prepared");
    const snapshot = await service(sql, retryRuntime.port, laterTs).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });

    expect(snapshot.id).toBe("pr-eligibility-1074c692d9e991050c5bc3f04dc3f4bf-g2");
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM pr_eligibility_generations").get()).toEqual({ count: 2 });
  });

  it("uses final SQL guard for drift that occurs exactly before persistence batch", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    sql.beforeBatch = (statements) => {
      if (statements.some((statement) => statement instanceof SqliteStatement && statement.sql.includes("UPDATE pr_eligibility_generations SET state = 'complete'"))) {
        sql.beforeBatch = undefined;
        sql.db.exec("UPDATE rulesets SET enabled = 0 WHERE id = 'ruleset-a'");
      }
    };

    await expect(service(sql, runtime("prepared").port).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "stale" });

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT result_key FROM operations").get()).toEqual({ result_key: null });
  });

  it("revalidates cached replay against refs, actor and tenant", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const fake = runtime("prepared");
    const svc = service(sql, fake.port);
    const first = await svc.get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });
    const second = await svc.get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });
    expect(second).toEqual(first);
    expect(fake.calls).toHaveLength(1);

    sql.db.exec("UPDATE principals SET active = 0 WHERE id = 'actor-a'");
    await expect(svc.get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "denied" });
    await expect(svc.get({ tenantId: "tenant-b", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses cached replay when fresh validation reaches the original expiry", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const fake = runtime("prepared");
    const first = await service(sql, fake.port).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });
    let calls = 0;
    const replayClock = { now: () => new Date(calls++ === 0 ? "2026-10-09T00:09:59.000Z" : "2026-10-09T00:10:00.000Z") };
    const replayRuntime = runtime("prepared");

    await expect(service(sql, replayRuntime.port, replayClock).get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" })).rejects.toMatchObject({ code: "stale", operationId: first.id });

    expect(replayRuntime.calls).toHaveLength(0);
  });

  it("does not replay a completed snapshot after same-version raw rule JSON or draft-state drift", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const fake = runtime("prepared");
    const svc = service(sql, fake.port);
    const first = await svc.get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });
    const reorderedRule = { ...rule(), exclude_patterns: [], include_patterns: ["refs/heads/main"] };
    sql.db.prepare("UPDATE rulesets SET rules_json = ? WHERE id = 'ruleset-a'").run(JSON.stringify(reorderedRule, Object.keys(reorderedRule).reverse()));

    const second = await svc.get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });
    sql.db.exec("UPDATE pull_requests SET draft = 1 WHERE id = 'pr-a'");
    const third = await svc.get({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a" });

    expect(fake.calls).toHaveLength(3);
    expect([second.id, third.id]).not.toContain(first.id);
    expect(third.blockers.map((blocker) => blocker.code)).toContain("draft");
  });
});
