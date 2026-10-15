import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { buildCandidateCiAdmission, type StoredCandidateCiRequest } from "../candidate-ci/index.js";
import type { LinuxExecReceipt } from "../linux/execution.js";
import type { CandidateArtifactKind } from "../merge-candidate/artifact-store.js";
import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";
import { NativeCandidateJobControllerError, makeNativeCandidateJobController } from "./controller.js";
import { makeD1NativeJobStore, type NativeCandidateJobScheduleInput, type NativeJobObservedRuleRow } from "./store.js";

class SqliteStatement<T = Record<string, unknown>> implements D1PreparedStatement<T> {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly values: readonly unknown[] = []) {}
  bind(...values: readonly unknown[]): D1PreparedStatement<T> { return new SqliteStatement<T>(this.db, this.sql, values); }
  async first<R = T>(): Promise<R | null> { return this.db.prepare(this.sql).get(...this.values as SQLInputValue[]) as R | null; }
  async all<R = T>(): Promise<D1Result<R>> { return { success: true, results: this.db.prepare(this.sql).all(...this.values as SQLInputValue[]) as R[] }; }
  async run(): Promise<D1Result<T>> { const result = this.db.prepare(this.sql).run(...this.values as SQLInputValue[]); return { success: true, meta: { changes: Number(result.changes) } }; }
}

class SqliteD1 implements D1DatabaseLike {
  readonly db = new DatabaseSync(":memory:");
  prepare<T = Record<string, unknown>>(sql: string): D1PreparedStatement<T> { return new SqliteStatement<T>(this.db, sql); }
  async batch(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

const now = "2026-10-09T00:00:00.000Z";
const startedAt = "2026-10-09T00:00:01.000Z";
const finishedAt = "2026-10-09T00:00:02.000Z";
const expiresAt = "2099-10-09T00:10:00.000Z";
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const candidate = "cccccccccccccccccccccccccccccccccccccccc";
const tree = "dddddddddddddddddddddddddddddddddddddddd";
const requestSha256 = sha("candidate-request");
const rawSha256 = sha("raw-commit-bytes");
const packSha256 = sha("candidate-pack");
const manifestSha256 = sha("candidate-manifest");
const policyDigest = sha("policy");
const planDigest = sha("plan");
const reviewedDiffDigest = sha("reviewed-diff-patch");
const imageDigest = `sha256:${sha("native-image")}`;
const configuredCiImage = `registry.local/gitfoundry/native-ci@${imageDigest}`;
const observedRules: readonly NativeJobObservedRuleRow[] = [{ id: "ruleset-a", version: 1, priority: 1, enabled: 1, rules_json: "{}" }];

describe("native candidate job controller", () => {
  it("dispatches the stored candidate CI request through the private adapter and qualifies a successful receipt", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    installCheckTransitionAudit(sql);
    const seen: StoredCandidateCiRequest[] = [];
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => {
      seen.push(request);
      expect(sql.db.prepare("SELECT old_status, new_status FROM check_transitions ORDER BY rowid").all()).toEqual([{ old_status: "queued", new_status: "in_progress" }]);
      expect(sql.db.prepare("SELECT version, status, conclusion, commit_sha, head_sha, base_sha, execution_sha, candidate_bound, job_attempt_id, provider_evidence_ref, name FROM checks WHERE job_attempt_id = ?").get("attempt-a")).toEqual({ version: 2, status: "in_progress", conclusion: null, commit_sha: candidate, head_sha: head, base_sha: base, execution_sha: candidate, candidate_bound: 1, job_attempt_id: "attempt-a", provider_evidence_ref: null, name: "ci/build" });
      return Response.json({ ok: true, receipt: linuxReceipt(request, "succeeded", 0) });
    } });

    const token = await controller.run(scheduleInput());

    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request).toMatchObject({ commandId: "attempt-a", operationId: "eligibility-a", context: "ci/build", imageDigest, plan: { planDigest, policySha256: policyDigest, scriptPath: ".gitfoundry/ci.sh" } });
    expect(request.candidate.reviewedDiff).toEqual(reviewedDiff());
    expect(token).toMatchObject({ status: "completed", conclusion: "success", jobAttemptId: "attempt-a", providerEvidenceRef: providerEvidenceRef(request, linuxReceipt(request, "succeeded", 0)) });
    expect(sql.db.prepare("SELECT old_status, new_status FROM check_transitions ORDER BY rowid").all()).toEqual([{ old_status: "queued", new_status: "in_progress" }, { old_status: "in_progress", new_status: "completed" }]);
    const check = sql.db.prepare("SELECT version, commit_sha, head_sha, base_sha, execution_sha, status, conclusion, candidate_bound, job_attempt_id, provider_evidence_ref, name, details_key FROM checks WHERE job_attempt_id = ?").get("attempt-a") as Record<string, unknown>;
    expect({ ...check, details_key: undefined }).toEqual({ version: 3, commit_sha: candidate, head_sha: head, base_sha: base, execution_sha: candidate, status: "completed", conclusion: "success", candidate_bound: 1, job_attempt_id: "attempt-a", provider_evidence_ref: null, name: "ci/build", details_key: undefined });
    expect(JSON.parse(String(check.details_key)).output.summary).toContain("exited 0");
    expect(JSON.parse(String(check.details_key)).output.summary).not.toContain("native-ci:");
    expect(sql.db.prepare("SELECT state, exit_code FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "completed", exit_code: 0 });
  });

  it("rejects non-ok helper responses even when they carry a plausible success receipt", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => Response.json({ ok: false, receipt: linuxReceipt(request, "succeeded", 0) }, { status: 503 }) });

    await expect(controller.run(scheduleInput())).rejects.toThrow(NativeCandidateJobControllerError);

    expect(sql.db.prepare("SELECT state FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "in_progress" });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
  });

  it("derives failure from the helper exit code instead of a caller asserted status", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => ({ ok: true, receipt: linuxReceipt(request, "failed", 42) }) });

    const token = await controller.run(scheduleInput());

    expect(token.conclusion).toBe("failure");
    expect(sql.db.prepare("SELECT exit_code FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ exit_code: 42 });
  });

  it("rejects a helper receipt whose bound candidate CI identity was tampered", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => {
      const receipt = linuxReceipt(request, "succeeded", 0);
      return { ok: true, receipt: { ...receipt, candidateCi: { ...receipt.candidateCi!, candidateSha: head } } };
    } });

    await expect(controller.run(scheduleInput())).rejects.toThrow(NativeCandidateJobControllerError);

    expect(sql.db.prepare("SELECT state FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "in_progress" });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
    expect(completedCheckCount(sql)).toEqual({ count: 0 });
  });

  it("rejects cleanup-required helper receipts before qualification", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => ({ ok: false, receipt: { ...linuxReceipt(request, "succeeded", 0), cleanupRequired: true, cleanupError: "container cleanup failed" } }) });

    await expect(controller.run(scheduleInput())).rejects.toThrow(NativeCandidateJobControllerError);

    expect(sql.db.prepare("SELECT state FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "in_progress" });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
  });

  it("rejects receipts from an unpinned or changed helper image", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => ({ ok: true, receipt: { ...linuxReceipt(request, "succeeded", 0), image: "registry.local/gitfoundry/native-ci:latest" } }) });

    await expect(controller.run(scheduleInput())).rejects.toThrow(NativeCandidateJobControllerError);

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
  });

  it("uses a fresh controller clock for finalization after awaited dispatch", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql, { expiresAt: "2099-10-09T00:00:01.500Z" });
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => ({ ok: true, receipt: linuxReceipt(request, "succeeded", 0) }) }, { clock: sequenceClock(["2099-10-09T00:00:00.500Z", "2099-10-09T00:00:00.750Z", "2099-10-09T00:00:01.000Z", "2099-10-09T00:00:02.000Z"]) });

    await expect(controller.run(scheduleInput({ expiresAt: "2099-10-09T00:00:01.500Z" }))).rejects.toThrow();

    expect(sql.db.prepare("SELECT state FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "in_progress" });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
    expect(completedCheckCount(sql)).toEqual({ count: 0 });
  });

  it("does not publish a completed check if the producer is revoked after dispatch", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => {
      sql.db.exec("UPDATE principals SET active = 0 WHERE id = 'actor-a'");
      return { ok: true, receipt: linuxReceipt(request, "succeeded", 0) };
    } });

    await expect(controller.run(scheduleInput())).rejects.toThrow();

    expect(sql.db.prepare("SELECT state FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "in_progress" });
    expect(sql.db.prepare("SELECT status, conclusion FROM checks WHERE job_attempt_id = 'attempt-a'").get()).toEqual({ status: "in_progress", conclusion: null });
    expect(completedCheckCount(sql)).toEqual({ count: 0 });
  });

  it("rejects receipt timestamps that are not ordered", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => ({ ok: true, receipt: { ...linuxReceipt(request, "succeeded", 0), startedAt: finishedAt, finishedAt: startedAt } }) });

    await expect(controller.run(scheduleInput())).rejects.toThrow(NativeCandidateJobControllerError);

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
  });

  it("rejects cancellation that lands after helper dispatch", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const controller = makeNativeCandidateJobController(sql, makeD1NativeJobStore(sql, ids()), { execute: async (request) => {
      sql.db.exec("UPDATE native_candidate_job_attempts SET cancel_requested = 1 WHERE attempt_id = 'attempt-a'");
      return { ok: true, receipt: linuxReceipt(request, "succeeded", 0) };
    } });

    await expect(controller.run(scheduleInput())).rejects.toThrow();

    expect(sql.db.prepare("SELECT state FROM job_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "in_progress" });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 0 });
  });

  it("records cancellation and rejects a late successful result for the same attempt", async () => {
    const sql = new SqliteD1(); install(sql); seed(sql);
    const store = makeD1NativeJobStore(sql, ids());
    const controller = makeNativeCandidateJobController(sql, store, { execute: async (request) => ({ ok: true, receipt: linuxReceipt(request, "canceled", null) }) });

    const token = await controller.run(scheduleInput());

    expect(token.conclusion).toBe("cancelled");
    await expect(store.finalize({ ...scheduleInput(), jobId: "job-a", attemptId: "attempt-a", attemptGeneration: 1, fenceToken: "fence-a", now: finishedAt, terminalStatus: "completed", exitCode: 0, providerEvidenceRef: "late", logSha256: sha("late"), logBytes: 4 })).rejects.toThrow();
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE status = 'completed'").get()).toEqual({ count: 1 });
  });
});

function installCheckTransitionAudit(sql: SqliteD1): void {
  sql.db.exec("CREATE TABLE check_transitions(old_status TEXT NOT NULL, new_status TEXT NOT NULL); CREATE TRIGGER check_transition_audit BEFORE UPDATE ON checks BEGIN INSERT INTO check_transitions VALUES(OLD.status, NEW.status); END");
}

function completedCheckCount(sql: SqliteD1) {
  return sql.db.prepare("SELECT COUNT(*) AS count FROM checks WHERE job_attempt_id = 'attempt-a' AND status = 'completed'").get();
}

function linuxReceipt(request: StoredCandidateCiRequest, status: LinuxExecReceipt["status"], exitCode: number | null): LinuxExecReceipt {
  const admission = buildCandidateCiAdmission(request);
  return { commandId: request.commandId, tenantId: request.tenantId, repositoryId: request.repositoryId, operationId: request.operationId, fenceToken: request.fenceToken, profile: "untrusted_ci_job", containerIdentity: `container-${request.attemptId}`, status, exitCode, stdout: status === "succeeded" ? "ok\n" : "", stderr: status === "failed" ? "failed\n" : "", stdoutTruncated: false, stderrTruncated: false, startedAt, finishedAt, image: configuredCiImage, egressProfile: "deny_all", attemptGeneration: request.attemptGeneration, cleanupRequired: false, candidateCiRequestSha256: admission.requestSha256, candidateCi: admission.binding };
}

function providerEvidenceRef(request: StoredCandidateCiRequest, receipt: LinuxExecReceipt): string {
  const candidateRequest = buildCandidateCiAdmission(request).requestSha256;
  const evidenceDigest = sha(JSON.stringify({ candidateRequest, containerIdentity: receipt.containerIdentity, finishedAt: receipt.finishedAt, journalRef: receipt.journalRef ?? null, startedAt: receipt.startedAt }));
  return `native-ci:${candidateRequest}:${evidenceDigest}`;
}

function install(sql: SqliteD1): void {
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0001_handbook.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0003_pr_eligibility.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0004_pr_eligibility_finalization.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0005_candidate_jobs.sql", import.meta.url), "utf8"));
}

function seed(sql: SqliteD1, options: { readonly expiresAt?: string } = {}): void {
  const activeExpiresAt = options.expiresAt ?? expiresAt;
  sql.db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 7, "shard-a", "US", "{}");
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "actor-a", 1, now, now, "human", "Actor A", 1, 1);
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "author-a", 1, now, now, "human", "Author A", 1, 1);
  sql.db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run("tenant-a", "ns-a", 1, now, now, "ns-a", "Namespace A");
  sql.db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 1, now, now, "ns-a", "target", "private", "main", 0, "tenant-a", "repo-a", null);
  sql.db.prepare("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "issue-a", 5, now, now, "repo-a", 1, "PR", "Body", "open", "", "author-a", "pull_request");
  sql.db.prepare("INSERT INTO pull_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", 3, now, now, "issue-a", "repo-a", "repo-a", "refs/heads/topic", "refs/heads/main", head, base, 0, null, null, null);
  sql.db.prepare("INSERT INTO rulesets VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "ruleset-a", 1, now, now, "repo-a", 1, "{}", 1);
  sql.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "eligibility-a", 1, now, now, "pr.eligibility.prepare", "actor-a", "complete", "{}", `json:${JSON.stringify(eligibilityOperationResult())}`, null);
  sql.db.prepare("INSERT INTO pr_eligibility_active VALUES(?,?,?,?,?,?,?)").run("tenant-a", "pr-a", "eligibility-key", "eligibility-a", 1, activeExpiresAt, now);
  sql.db.prepare("INSERT INTO pr_eligibility_generations(tenant_id,pull_request_id,operation_id,logical_key,generation,actor_id,state,created_at,updated_at,expires_at,committed_at,head_sha,base_sha,method,policy_digest,progress_json,snapshot_json,error_json,finalization_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", "eligibility-a", "eligibility-key", 1, "actor-a", "complete", now, now, activeExpiresAt, now, head, base, "merge", policyDigest, JSON.stringify({ observedRuleRows: observedRules }), JSON.stringify({ id: "eligibility-a", candidate_sha: candidate }), null, "eligibility-nonce");
  sql.db.prepare("INSERT INTO eligibility VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "eligibility-a", 1, now, now, "repo-a", "pr-a", head, base, candidate, 7, JSON.stringify({ id: "eligibility-a", candidate_sha: candidate }), activeExpiresAt);
}

function ids() { let token = 0; let nonce = 0; return { newRunId: () => "run-a", newJobId: () => "job-a", newAttemptId: () => "attempt-a", newFenceToken: () => "fence-a", newTokenId: () => `token-${["a", "b", "c", "d"][token++] ?? token}`, newNonce: () => `nonce-${["a", "b", "c", "d"][nonce++] ?? nonce}` }; }

function scheduleInput(overrides: Partial<NativeCandidateJobScheduleInput> = {}): NativeCandidateJobScheduleInput {
  return { tenantId: "tenant-a", producerId: "actor-a", producerAuthEpoch: 1, tenantPolicyEpoch: 7, now, expiresAt, context: "ci/build", command: ["/bin/sh", "-lc", ".gitfoundry/ci.sh"], imageDigest, sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", pullRequestId: "pr-a", pullRequestVersion: 3, issueVersion: 5, eligibilityOperationId: "eligibility-a", eligibilityGeneration: 1, candidateSha: candidate, headSha: head, baseSha: base, candidateTreeSha: tree, policyDigest, planDigest, reviewedDiffDigest, candidateArtifacts: artifacts(), observedRuleRows: observedRules, ...overrides };
}

function sequenceClock(values: readonly string[]) {
  let index = 0;
  return { now: () => new Date(values[Math.min(index++, values.length - 1)]!) };
}

function artifacts() {
  return { manifest: locator(requestSha256, "candidate_manifest", manifestSha256, 345), rawCommit: locator(requestSha256, "candidate_raw_commit", rawSha256, 456), pack: locator(requestSha256, "candidate_pack", packSha256, 567) };
}

function locator(request: string, kind: CandidateArtifactKind, digest: string, sizeBytes: number) {
  return { tenantId: "tenant-a", repositoryId: "repo-a", operationId: "eligibility-a", requestSha256: request, kind, sha256: digest, sizeBytes, key: `v1/tenants/tenant-a/repositories/repo-a/merge-operations/eligibility-a/${request}/${kind}`, etag: `etag-${kind}`, version: `version-${kind}`, expiresAt: null };
}

function reviewedDiff() {
  return { algorithmVersion: "git-cli-unified-v1", comparison: "three_dot", contextLines: 3, headSha: head, baseSha: base, mergeBaseShas: [base], patchSha256: reviewedDiffDigest, patchSizeBytes: 0, changedPathsSha256: sha("paths") };
}

function eligibilityOperationResult() {
  return { snapshot: { id: "eligibility-a", candidate_sha: candidate }, candidate: { requestSha256, result: { ok: true, candidateOid: candidate, candidateTree: tree, candidateBytesSha256: rawSha256, gitVersion: "git version 2.39.5", stateRef: `merge-candidates/requests/${requestSha256}/manifest.json`, originalToRebased: [] }, reviewedDiff: reviewedDiff(), ...artifacts() }, checkPlan: { plan: { tenantId: "tenant-a", sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", pullRequestId: "pr-a", pullRequestVersion: 3, headOid: head, baseOid: base, candidateOid: candidate, candidateTreeOid: tree, policyDigest }, planDigest }, reviewedDiff: { patchSha256: reviewedDiffDigest }, source: { tenantId: "tenant-a", sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", headSha: head, baseSha: base }, exposedIssueVersion: 5, internalPrRevision: 3, generation: 1 };
}

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
