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

describe("native candidate job store", () => {
  it("schedules a real run, job, and job_attempt from a current completed eligibility generation", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());

    const scheduled = await store.schedule(scheduleInput());

    expect(scheduled).toMatchObject({ runId: "run-a", jobId: "job-a", attemptId: "attempt-a", attemptGeneration: 1, fenceToken: "fence-a" });
    expect(sql.db.prepare("SELECT status, commit_sha, workflow_path FROM runs WHERE id = 'run-a'").get()).toEqual({ status: "queued", commit_sha: candidate, workflow_path: ".gitfoundry/native/ci-build" });
    expect(sql.db.prepare("SELECT status, logical_key FROM jobs WHERE id = 'job-a'").get()).toEqual({ status: "queued", logical_key: "ci/build" });
    expect(sql.db.prepare("SELECT state, lease_generation, fencing_token FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "queued", lease_generation: 1, fencing_token: "fence-a" });
    expect(sql.db.prepare("SELECT candidate_sha, json_extract(candidate_artifacts_json,'$.manifest.key') AS manifest_key FROM native_candidate_job_attempts WHERE attempt_id = 'attempt-a'").get()).toEqual({ candidate_sha: candidate, manifest_key: `v1/tenants/tenant-a/repositories/repo-a/merge-operations/eligibility-a/${sha("candidate-request")}/candidate_manifest` });
    expect(sql.db.prepare("SELECT status, conclusion FROM native_candidate_check_qualification_tokens WHERE job_attempt_id = 'attempt-a'").get()).toEqual({ status: "queued", conclusion: null });
  });

  it("does not schedule when PR state drifts inside the scheduling batch", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    sql.beforeBatch = () => { sql.beforeBatch = undefined; sql.db.exec("UPDATE pull_requests SET version = 4 WHERE id = 'pr-a'"); };

    await expect(makeD1NativeJobStore(sql, ids()).schedule(scheduleInput())).rejects.toThrow(NativeJobStoreConflictError);

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM job_attempts").get()).toEqual({ count: 0 });
  });

  it("does not schedule from a skeletal eligibility operation result", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql, { operationResultKey: "json:{}" });

    await expect(makeD1NativeJobStore(sql, ids()).schedule(scheduleInput())).rejects.toThrow(NativeJobStoreConflictError);

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_job_attempts").get()).toEqual({ count: 0 });
  });

  it("finalizes a receipt by deriving conclusion from the actual exit code and persists a guarded qualification token", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());
    const scheduled = await store.schedule(scheduleInput());
    await store.start({ ...scheduleInput(), jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken });

    const token = await store.finalize(receiptInput({ attemptId: scheduled.attemptId, fenceToken: scheduled.fenceToken, terminalStatus: "completed", exitCode: 7 }));

    expect(token).toMatchObject({ id: "token-c", evidenceKind: "native_job", status: "completed", conclusion: "failure", jobAttemptId: "attempt-a", candidateSha: candidate, executionSha: candidate });
    expect(sql.db.prepare("SELECT status FROM runs WHERE id = 'run-a'").get()).toEqual({ status: "completed" });
    expect(sql.db.prepare("SELECT state, exit_code FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "completed", exit_code: 7 });
    const row = sql.db.prepare("SELECT conclusion, evidence_kind, receipt_sha256 FROM native_candidate_check_qualification_tokens WHERE id = ?").get(token.id);
    expect(row).toEqual({ conclusion: "failure", evidence_kind: "native_job", receipt_sha256: sha(JSON.stringify(token.receipt)) });

    const guard = buildNativeJobQualificationGuard({ tenantId: "tenant-a", tokenId: token.id, receiptSha256: token.receiptSha256, now: completedAt, targetRepositoryId: "repo-a", sourceRepositoryId: "repo-a", producerId: "actor-a", context: "ci/build", candidateSha: candidate, headSha: head, baseSha: base, executionSha: candidate, policyDigest, planDigest, jobAttemptId: scheduled.attemptId, status: "completed", conclusion: "failure" });
    expect(sql.db.prepare(`SELECT 1 AS ok WHERE ${guard.sql}`).get(...guard.bindings as SQLInputValue[])).toEqual({ ok: 1 });
    const trusted = await readNativeJobQualificationToken(sql, { tenantId: "tenant-a", tokenId: token.id, now: completedAt });
    expect(trusted?.writeFence).toEqual(guard);
    sql.db.exec("UPDATE principals SET auth_epoch = 2 WHERE id = 'actor-a'");
    expect(sql.db.prepare(`SELECT 1 AS ok WHERE ${guard.sql}`).get(...guard.bindings as SQLInputValue[])).toBeUndefined();
  });

  it("rejects terminal success or failure callbacks while the attempt is still queued", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());
    const scheduled = await store.schedule(scheduleInput());

    await expect(store.finalize(receiptInput({ attemptId: scheduled.attemptId, fenceToken: scheduled.fenceToken, terminalStatus: "completed", exitCode: 0 }))).rejects.toThrow(NativeJobStoreConflictError);
    await expect(store.finalize(receiptInput({ attemptId: scheduled.attemptId, fenceToken: scheduled.fenceToken, terminalStatus: "failed", exitCode: 1 }))).rejects.toThrow(NativeJobStoreConflictError);

    expect(sql.db.prepare("SELECT status FROM runs WHERE id = 'run-a'").get()).toEqual({ status: "queued" });
    expect(sql.db.prepare("SELECT state, version, finished_at FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "queued", version: 1, finished_at: null });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
  });

  it("cancels a queued attempt before start and rejects later start or completion callbacks", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());
    const scheduled = await store.schedule(scheduleInput());

    const token = await store.cancel({ ...scheduleInput(), jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken, now: completedAt });

    expect(token).toMatchObject({ id: "token-b", status: "completed", conclusion: "cancelled", jobAttemptVersion: 2, jobAttemptId: "attempt-a", candidateSha: candidate });
    expect(sql.db.prepare("SELECT status FROM runs WHERE id = 'run-a'").get()).toEqual({ status: "completed" });
    expect(sql.db.prepare("SELECT status FROM jobs WHERE id = 'job-a'").get()).toEqual({ status: "completed" });
    expect(sql.db.prepare("SELECT state, version, started_at, finished_at, exit_code FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "cancelled", version: 2, started_at: null, finished_at: completedAt, exit_code: null });
    expect(sql.db.prepare("SELECT state, job_attempt_version, receipt_sha256 FROM native_candidate_job_attempts WHERE attempt_id = 'attempt-a'").get()).toEqual({ state: "cancelled", job_attempt_version: 2, receipt_sha256: token.receiptSha256 });
    const guard = buildNativeJobQualificationGuard({ tenantId: "tenant-a", tokenId: token.id, receiptSha256: token.receiptSha256, now: completedAt, targetRepositoryId: "repo-a", sourceRepositoryId: "repo-a", producerId: "actor-a", context: "ci/build", candidateSha: candidate, headSha: head, baseSha: base, executionSha: candidate, policyDigest, planDigest, jobAttemptId: scheduled.attemptId, status: "completed", conclusion: "cancelled" });
    expect(sql.db.prepare(`SELECT 1 AS ok WHERE ${guard.sql}`).get(...guard.bindings as SQLInputValue[])).toEqual({ ok: 1 });

    await expect(store.start({ ...scheduleInput(), jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken })).rejects.toThrow(NativeJobStoreConflictError);
    await expect(store.finalize(receiptInput({ attemptId: scheduled.attemptId, fenceToken: scheduled.fenceToken }))).rejects.toThrow(NativeJobStoreConflictError);
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 1 });
  });

  it("rolls back a queued cancellation when terminal token insertion fails", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());
    const scheduled = await store.schedule(scheduleInput());
    sql.db.exec("CREATE TRIGGER reject_cancel_token BEFORE INSERT ON native_candidate_check_qualification_tokens WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'reject queued cancel token'); END");

    await expect(store.cancel({ ...scheduleInput(), jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken, now: completedAt })).rejects.toThrow(NativeJobStoreConflictError);

    expect(sql.db.prepare("SELECT status FROM runs WHERE id = 'run-a'").get()).toEqual({ status: "queued" });
    expect(sql.db.prepare("SELECT status FROM jobs WHERE id = 'job-a'").get()).toEqual({ status: "queued" });
    expect(sql.db.prepare("SELECT state, version, finished_at FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "queued", version: 1, finished_at: null });
    expect(sql.db.prepare("SELECT state, job_attempt_version, receipt_sha256 FROM native_candidate_job_attempts WHERE attempt_id = 'attempt-a'").get()).toEqual({ state: "queued", job_attempt_version: 1, receipt_sha256: null });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
  });

  it("uses SQL wall-clock expiry in the qualification write fence", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());
    const scheduled = await store.schedule(scheduleInput());
    await store.start({ ...scheduleInput(), jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken });
    const token = await store.finalize(receiptInput({ attemptId: scheduled.attemptId, fenceToken: scheduled.fenceToken }));
    sql.db.exec("UPDATE native_candidate_check_qualification_tokens SET expires_at = '2000-01-01T00:00:00.000Z'; UPDATE native_candidate_job_attempts SET expires_at = '2000-01-01T00:00:00.000Z'; UPDATE pr_eligibility_generations SET expires_at = '2000-01-01T00:00:00.000Z'; UPDATE pr_eligibility_active SET expires_at = '2000-01-01T00:00:00.000Z'");

    const staleCallerNow = "1999-01-01T00:00:00.000Z";
    const guard = buildNativeJobQualificationGuard({ tenantId: "tenant-a", tokenId: token.id, receiptSha256: token.receiptSha256, now: staleCallerNow, targetRepositoryId: "repo-a", sourceRepositoryId: "repo-a", producerId: "actor-a", context: "ci/build", candidateSha: candidate, headSha: head, baseSha: base, executionSha: candidate, policyDigest, planDigest, jobAttemptId: scheduled.attemptId, status: "completed", conclusion: "success" });

    expect(sql.db.prepare(`SELECT 1 AS ok WHERE ${guard.sql}`).get(...guard.bindings as SQLInputValue[])).toBeUndefined();
  });

  it("does not persist a token or mark the attempt complete when finalization sees raw rule drift", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());
    const scheduled = await store.schedule(scheduleInput());
    await store.start({ ...scheduleInput(), jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken });
    sql.beforeBatch = () => { sql.beforeBatch = undefined; sql.db.exec("UPDATE rulesets SET rules_json = '{\"changed\":true}' WHERE id = 'ruleset-a'"); };

    await expect(store.finalize(receiptInput({ attemptId: scheduled.attemptId, fenceToken: scheduled.fenceToken }))).rejects.toThrow(NativeJobStoreConflictError);

    expect(sql.db.prepare("SELECT state, finished_at FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "in_progress", finished_at: null });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
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

function ids() { let token = 0; let nonce = 0; return { newRunId: () => "run-a", newJobId: () => "job-a", newAttemptId: () => "attempt-a", newFenceToken: () => "fence-a", newTokenId: () => `token-${["a", "b", "c", "d"][token++] ?? token}`, newNonce: () => `nonce-${["a", "b", "c", "d"][nonce++] ?? nonce}` }; }

function scheduleInput(): NativeCandidateJobScheduleInput {
  return { tenantId: "tenant-a", producerId: "actor-a", producerAuthEpoch: 1, tenantPolicyEpoch: 7, now, expiresAt, context: "ci/build", command: ["/bin/sh", "-lc", ".gitfoundry/ci.sh"], imageDigest, sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", pullRequestId: "pr-a", pullRequestVersion: 3, issueVersion: 5, eligibilityOperationId: "eligibility-a", eligibilityGeneration: 1, candidateSha: candidate, headSha: head, baseSha: base, candidateTreeSha: tree, policyDigest, planDigest, reviewedDiffDigest, candidateArtifacts: artifacts(), observedRuleRows: observedRules };
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
