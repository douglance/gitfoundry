import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";
import type { CandidateArtifactKind } from "../merge-candidate/artifact-store.js";
import { NativeJobStoreConflictError, buildNativeJobQualificationGuard, makeD1NativeJobStore, readNativeJobQualificationToken, type NativeCandidateJobReceiptInput, type NativeCandidateJobScheduleInput, type NativeJobObservedRuleRow } from "./store.js";

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

const now = "2026-10-09T00:00:00.000Z";
const expiresAt = "2099-10-09T00:10:00.000Z";
const completedAt = "2026-10-09T00:02:00.000Z";
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const candidate = "cccccccccccccccccccccccccccccccccccccccc";
const tree = "dddddddddddddddddddddddddddddddddddddddd";
const policyDigest = sha("policy");
const planDigest = sha("plan");
const reviewedDiffDigest = sha("reviewed-diff");
const imageDigest = `sha256:${sha("native-image")}`;
const observedRules: readonly NativeJobObservedRuleRow[] = [{ id: "ruleset-a", version: 1, priority: 1, enabled: 1, rules_json: "{}" }];

describe("root independent native candidate job boundary", () => {
  it("finalizes an unchanged started attempt as the positive control", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());
    await store.schedule(scheduleInput());
    const running = await store.start({ ...receiptInput(), now });
    expect(running.status).toBe("in_progress");
    expect(sql.db.prepare("SELECT state, version FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "in_progress", version: 2 });
    const token = await store.finalize(receiptInput());
    expect(token.status).toBe("completed");
    expect(token.conclusion).toBe("success");
    expect(sql.db.prepare("SELECT state, version FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "completed", version: 3 });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 1 });
  });
  it("rejects receipt identity changed from the persisted scheduled attempt", async () => {
    const changes: readonly [string, Partial<NativeCandidateJobReceiptInput>][] = [
      ["candidate", { candidateSha: "ffffffffffffffffffffffffffffffffffffffff" }],
      ["candidate tree", { candidateTreeSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
      ["plan", { planDigest: sha("different-plan") }],
      ["context", { context: "ci/different-context" }],
      ["producer", { producerId: "author-a" }],
      ["command", { command: ["/bin/sh", "-lc", "printf forged-success"] }],
      ["artifact", { candidateArtifacts: { ...artifacts(), pack: { ...artifacts().pack, sha256: sha("different-pack") } } }]
    ];
    for (const [label, changed] of changes) {
      const sql = new SqliteD1(); install(sql); seed(sql);
      const store = makeD1NativeJobStore(sql, ids());
      await store.schedule(scheduleInput());
      await store.start({ ...receiptInput(), now });
      await expect(store.finalize(receiptInput(changed)), label).rejects.toThrow(NativeJobStoreConflictError);
      expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get(), label).toEqual({ count: 0 });
      expect(sql.db.prepare("SELECT state, receipt_json FROM native_candidate_job_attempts WHERE attempt_id = 'attempt-a'").get(), label).toEqual({ state: "in_progress", receipt_json: null });
    }
  });

  it("does not partially finalize when normative attempt state changes before the batch", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());
    await store.schedule(scheduleInput());
    await store.start({ ...receiptInput(), now });
    sql.beforeBatch = () => {
      sql.beforeBatch = undefined;
      sql.db.exec("UPDATE job_attempts SET state = 'cancelled', version = 3 WHERE id = 'attempt-a'");
    };
    await expect(store.finalize(receiptInput())).rejects.toThrow(NativeJobStoreConflictError);
    expect(sql.db.prepare("SELECT state, receipt_json FROM native_candidate_job_attempts WHERE attempt_id = 'attempt-a'").get()).toEqual({ state: "in_progress", receipt_json: null });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT status FROM jobs WHERE id = 'job-a'").get()).toEqual({ status: "in_progress" });
  });
});

function install(sql: SqliteD1): void {
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0001_handbook.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0003_pr_eligibility.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0004_pr_eligibility_finalization.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0005_candidate_jobs.sql", import.meta.url), "utf8"));
}

function seed(sql: SqliteD1, options: { operationResultKey?: string } = {}): void {
  sql.db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 7, "shard-a", "US", "{}");
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "actor-a", 1, now, now, "human", "Actor A", 1, 1);
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "author-a", 1, now, now, "human", "Author A", 1, 1);
  sql.db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run("tenant-a", "ns-a", 1, now, now, "ns-a", "Namespace A");
  sql.db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 1, now, now, "ns-a", "target", "private", "main", 0, "tenant-a", "repo-a", null);
  sql.db.prepare("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "issue-a", 5, now, now, "repo-a", 1, "PR", "Body", "open", "", "author-a", "pull_request");
  sql.db.prepare("INSERT INTO pull_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", 3, now, now, "issue-a", "repo-a", "repo-a", "refs/heads/topic", "refs/heads/main", head, base, 0, null, null, null);
  sql.db.prepare("INSERT INTO rulesets VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "ruleset-a", 1, now, now, "repo-a", 1, "{}", 1);
  sql.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "eligibility-a", 1, now, now, "pr.eligibility.prepare", "actor-a", "complete", "{}", options.operationResultKey ?? `json:${JSON.stringify(eligibilityOperationResult())}`, null);
  sql.db.prepare("INSERT INTO pr_eligibility_active VALUES(?,?,?,?,?,?,?)").run("tenant-a", "pr-a", "eligibility-key", "eligibility-a", 1, expiresAt, now);
  sql.db.prepare("INSERT INTO pr_eligibility_generations(tenant_id,pull_request_id,operation_id,logical_key,generation,actor_id,state,created_at,updated_at,expires_at,committed_at,head_sha,base_sha,method,policy_digest,progress_json,snapshot_json,error_json,finalization_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", "eligibility-a", "eligibility-key", 1, "actor-a", "complete", now, now, expiresAt, now, head, base, "merge", policyDigest, JSON.stringify({ observedRuleRows: observedRules }), JSON.stringify({ id: "eligibility-a", candidate_sha: candidate }), null, "eligibility-nonce");
  sql.db.prepare("INSERT INTO eligibility VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "eligibility-a", 1, now, now, "repo-a", "pr-a", head, base, candidate, 7, JSON.stringify({ id: "eligibility-a", candidate_sha: candidate }), expiresAt);
}

function ids() { let token = 0; let nonce = 0; return { newRunId: () => "run-a", newJobId: () => "job-a", newAttemptId: () => "attempt-a", newFenceToken: () => "fence-a", newTokenId: () => `token-${++token}`, newNonce: () => `nonce-${++nonce}` }; }

function scheduleInput(): NativeCandidateJobScheduleInput {
  return { tenantId: "tenant-a", producerId: "actor-a", producerAuthEpoch: 1, tenantPolicyEpoch: 7, now, expiresAt, context: "ci/build", command: ["/bin/sh", "-lc", "npm test"], imageDigest, sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", pullRequestId: "pr-a", pullRequestVersion: 3, issueVersion: 5, eligibilityOperationId: "eligibility-a", eligibilityGeneration: 1, candidateSha: candidate, headSha: head, baseSha: base, candidateTreeSha: tree, policyDigest, planDigest, reviewedDiffDigest, candidateArtifacts: artifacts(), observedRuleRows: observedRules };
}

function receiptInput(overrides: Partial<NativeCandidateJobReceiptInput> = {}): NativeCandidateJobReceiptInput {
  return { ...scheduleInput(), jobId: "job-a", attemptId: "attempt-a", attemptGeneration: 1, fenceToken: "fence-a", now: completedAt, terminalStatus: "completed", exitCode: 0, providerEvidenceRef: "r2://logs/attempt-a", logSha256: sha("log"), logBytes: 123, ...overrides };
}

function artifacts() {
  const requestSha256 = sha("candidate-request");
  return {
    manifest: locator(requestSha256, "candidate_manifest", sha("manifest"), 345),
    rawCommit: locator(requestSha256, "candidate_raw_commit", sha("raw"), 456),
    pack: locator(requestSha256, "candidate_pack", sha("pack"), 567)
  };
}

function locator(requestSha256: string, kind: CandidateArtifactKind, digest: string, sizeBytes: number) {
  return { tenantId: "tenant-a", repositoryId: "repo-a", operationId: "eligibility-a", requestSha256, kind, sha256: digest, sizeBytes, key: `v1/tenants/tenant-a/repositories/repo-a/merge-operations/eligibility-a/${requestSha256}/${kind}`, etag: `etag-${kind}`, version: `version-${kind}`, expiresAt: null };
}

function eligibilityOperationResult() {
  return {
    snapshot: { id: "eligibility-a", candidate_sha: candidate },
    candidate: { requestSha256: sha("candidate-request"), result: { candidateOid: candidate, candidateTree: tree, candidateBytesSha256: sha("raw") }, ...artifacts() },
    checkPlan: { plan: { tenantId: "tenant-a", sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", pullRequestId: "pr-a", pullRequestVersion: 3, headOid: head, baseOid: base, candidateOid: candidate, candidateTreeOid: tree, policyDigest }, planDigest },
    reviewedDiff: { patchSha256: reviewedDiffDigest },
    source: { tenantId: "tenant-a", sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", headSha: head, baseSha: base },
    exposedIssueVersion: 5,
    internalPrRevision: 3,
    generation: 1
  };
}

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
