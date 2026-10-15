import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { Actor } from "../../../../packages/core/src/index.js";
import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";
import { makeNativeCandidateCheckStore } from "../native-jobs/check-reporting.js";
import { nativeCandidateCiCommand } from "../native-jobs/controller.js";
import type { CandidateArtifactKind, ImmutableBlobLocator } from "../merge-candidate/artifact-store.js";
import { makeD1NativeJobStore, type NativeJobIdFactory } from "../native-jobs/store.js";
import { makeD1PrMergeAdmission } from "./admission.js";

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

const now = new Date().toISOString();
const later = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const baseSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const candidateSha = "cccccccccccccccccccccccccccccccccccccccc";
const treeSha = "dddddddddddddddddddddddddddddddddddddddd";
const rawSha = digest("raw-commit");
const policyDigest = digest("policy");
const planDigest = digest("plan");
const diffDigest = digest("diff");
const operationId = "pr-eligibility-checked-g2";
const producer: Actor = { id: "producer-a", tenantId: "tenant-a", revoked: false, capabilities: ["check.write"] };

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function rule(overrides: Record<string, unknown> = {}) {
  return { id: "rule-a", name: "main", state: "active", target: "branch", include_patterns: ["refs/heads/main"], exclude_patterns: [], require_pull_request: true, required_approvals: 0, require_human_approval: false, dismiss_stale_reviews: false, require_latest_push_approval: false, require_code_owners: false, require_resolved_threads: false, require_linear_history: false, require_signed_commits: false, require_merge_queue: false, allow_force_push: true, allow_deletion: true, allowed_writer_group_ids: [], required_checks: [{ context: "native-ci", producer_id: "producer-a", accepted_conclusions: ["success"], max_age_seconds: 3600 }], required_environment_ids: [], allowed_merge_methods: ["merge"], bypass: [], max_blob_size_bytes: null, forbidden_path_patterns: [], mandatory: false, ...overrides };
}

function install(sql: SqliteD1) {
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0001_handbook.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0003_pr_eligibility.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0004_pr_eligibility_finalization.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0005_candidate_jobs.sql", import.meta.url), "utf8"));
}

async function seed(sql: SqliteD1, options: { checkConclusion?: "success" | "failure"; policyOverrides?: Record<string, unknown> } = {}) {
  const prVersion = 3;
  const issueVersion = 5;
  const activeRule = rule(options.policyOverrides);
  const rulesJson = JSON.stringify(activeRule);
  const observedRuleRows = [{ id: "rule-a", version: 1, priority: 1, enabled: 1 as const, rules_json: rulesJson }];
  const candidateArtifacts = { manifest: locator("candidate_manifest"), rawCommit: locator("candidate_raw_commit", rawSha), pack: locator("candidate_pack") };
  const requiredChecks = activeRule.required_checks;
  const snapshot = { tenant_id: "tenant-a", pull_request_id: "pr-a", pr_version: issueVersion, id: operationId, status: "eligible", head_sha: headSha, base_sha: baseSha, candidate_sha: candidateSha, method: "merge", diff_digest: diffDigest, policy_digest: policyDigest, policy_epoch: 7, expires_at: later, blockers: [], reviews: [], checks: [] };
  const result = {
    snapshot,
    candidate: { requestSha256: candidateArtifacts.manifest.requestSha256, result: { ok: true, status: "prepared", candidateOid: candidateSha, candidateTree: treeSha, candidateBytesSha256: rawSha, gitVersion: "2.39.5", stateRef: `merge-candidates/requests/${candidateArtifacts.manifest.requestSha256}/manifest.json`, originalToRebased: [] }, manifest: candidateArtifacts.manifest, rawCommit: candidateArtifacts.rawCommit, pack: candidateArtifacts.pack, reviewedDiff: { algorithmVersion: "git-cli-unified-v1", comparison: "three_dot", contextLines: 3, headSha, baseSha, mergeBaseShas: [baseSha], patchSha256: diffDigest, patchSizeBytes: 12, changedPathsSha256: digest("paths") } },
    outcome: { ok: true, status: "prepared", candidateOid: candidateSha, candidateTree: treeSha, candidateBytesSha256: rawSha, gitVersion: "2.39.5", stateRef: `merge-candidates/requests/${candidateArtifacts.manifest.requestSha256}/manifest.json`, originalToRebased: [] },
    reviewedDiff: { patchSha256: diffDigest },
    policy: { identityRules: [{ rowId: "rule-a", rowVersion: 1, rowPriority: 1, rowEnabled: true, rule: activeRule }], enforcement: { ...enforcement(), requiredChecks, allowedMergeMethods: activeRule.allowed_merge_methods, requireCodeOwners: Boolean(activeRule.require_code_owners) } },
    checkPlan: { planDigest, plan: { candidateOid: candidateSha, candidateTreeOid: treeSha, policyDigest, requiredChecks } },
    preparationRequestSha256: candidateArtifacts.manifest.requestSha256,
    source: { tenantId: "tenant-a", sourceRepositoryId: "repo-source", targetRepositoryId: "repo-a", sourceRef: "refs/heads/topic", targetRef: "refs/heads/main", headSha, baseSha },
    exposedIssueVersion: issueVersion,
    internalPrRevision: prVersion,
    committedAt: now,
    expiresAt: later,
    generation: 2
  };

  sql.db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 7, "shard-a", "US", "{}");
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "actor-a", 1, now, now, "human", "Actor A", 1, 1);
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "producer-a", 1, now, now, "service", "Producer A", 1, 11);
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "author-a", 1, now, now, "human", "Author A", 1, 1);
  sql.db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run("tenant-a", "ns-a", 1, now, now, "ns-a", "Namespace A");
  sql.db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 9, now, now, "ns-a", "target", "private", "main", 0, "tenant-a", "repo-a", null);
  sql.db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-source", 4, now, now, "ns-a", "source", "private", "topic", 0, "tenant-a", "repo-source", "repo-a");
  sql.db.prepare("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "issue-a", issueVersion, now, now, "repo-a", 1, "PR", "Body", "open", "", "author-a", "pull_request");
  sql.db.prepare("INSERT INTO pull_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", prVersion, now, now, "issue-a", "repo-a", "repo-source", "refs/heads/topic", "refs/heads/main", headSha, baseSha, 0, null, null, null);
  sql.db.prepare("INSERT INTO rulesets VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "rule-a", 1, now, now, "repo-a", 1, rulesJson, 1);
  sql.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", operationId, 1, now, now, "pr.eligibility.prepare", "actor-a", "complete", JSON.stringify({ observedRuleRows }), `json:${JSON.stringify(result)}`, null);
  sql.db.prepare("INSERT INTO pr_eligibility_generations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", operationId, "logical-a", 2, "actor-a", "complete", now, now, later, now, headSha, baseSha, "merge", policyDigest, JSON.stringify({ observedRuleRows }), JSON.stringify(snapshot), null, "nonce-a");
  sql.db.prepare("INSERT INTO pr_eligibility_active VALUES(?,?,?,?,?,?,?)").run("tenant-a", "pr-a", "logical-a", operationId, 2, later, now);
  sql.db.prepare("INSERT INTO eligibility VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", operationId, 1, now, now, "repo-a", "pr-a", headSha, baseSha, candidateSha, 7, JSON.stringify(snapshot), later);

  const nativeJobs = makeD1NativeJobStore(sql, ids());
  const scheduled = await nativeJobs.schedule({ tenantId: "tenant-a", producerId: "producer-a", producerAuthEpoch: 11, tenantPolicyEpoch: 7, now, expiresAt: later, context: "native-ci", command: nativeCandidateCiCommand, imageDigest: "sha256:" + digest("image"), sourceRepositoryId: "repo-source", targetRepositoryId: "repo-a", pullRequestId: "pr-a", pullRequestVersion: prVersion, issueVersion, eligibilityOperationId: operationId, eligibilityGeneration: 2, candidateSha, headSha, baseSha, candidateTreeSha: treeSha, policyDigest, planDigest, reviewedDiffDigest: diffDigest, candidateArtifacts, observedRuleRows });
  const running = await nativeJobs.start({ tenantId: "tenant-a", producerId: "producer-a", producerAuthEpoch: 11, tenantPolicyEpoch: 7, now, expiresAt: later, context: "native-ci", command: nativeCandidateCiCommand, imageDigest: "sha256:" + digest("image"), sourceRepositoryId: "repo-source", targetRepositoryId: "repo-a", pullRequestId: "pr-a", pullRequestVersion: prVersion, issueVersion, eligibilityOperationId: operationId, eligibilityGeneration: 2, candidateSha, headSha, baseSha, candidateTreeSha: treeSha, policyDigest, planDigest, reviewedDiffDigest: diffDigest, candidateArtifacts, observedRuleRows, jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken });
  const terminalStatus = options.checkConclusion === "failure" ? "failed" : "completed";
  const exitCode = options.checkConclusion === "failure" ? 1 : 0;
  const completed = await nativeJobs.finalize({ tenantId: "tenant-a", producerId: "producer-a", producerAuthEpoch: 11, tenantPolicyEpoch: 7, now, expiresAt: later, context: "native-ci", command: nativeCandidateCiCommand, imageDigest: "sha256:" + digest("image"), sourceRepositoryId: "repo-source", targetRepositoryId: "repo-a", pullRequestId: "pr-a", pullRequestVersion: prVersion, issueVersion, eligibilityOperationId: operationId, eligibilityGeneration: 2, candidateSha, headSha, baseSha, candidateTreeSha: treeSha, policyDigest, planDigest, reviewedDiffDigest: diffDigest, candidateArtifacts, observedRuleRows, jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken, terminalStatus, exitCode, providerEvidenceRef: `native-job://tenant-a/${scheduled.attemptId}/completed`, logSha256: digest("native-log"), logBytes: 64 });

  const check = await Effect.runPromise(makeNativeCandidateCheckStore(sql, { clock: { now: () => new Date(now) } }).create("tenant-a", producer, { repository_id: "repo-a", commit_sha: candidateSha, evidence_kind: "native_job", candidate_bound: true, head_sha: headSha, base_sha: baseSha, execution_sha: candidateSha, plan_digest: `sha256:${planDigest}`, policy_digest: `sha256:${policyDigest}`, job_attempt_id: completed.jobAttemptId, provider_evidence_ref: null, name: "native-ci", status: "completed", conclusion: completed.conclusion, details_url: null, output: null, annotations: [] }));
  return { checkId: check.id, tokenId: completed.id };
}

function ids(): NativeJobIdFactory {
  let token = 0;
  return { newRunId: () => "run-a", newJobId: () => "job-a", newAttemptId: () => "attempt-a", newFenceToken: () => "fence-a", newNonce: () => `nonce-${++token}`, newTokenId: () => `token-${++token}` };
}

function enforcement() {
  return { allowDeletion: true, allowForcePush: false, allowedMergeMethods: ["merge"], allowedWriterGroupClauses: [], dismissStaleReviews: false, forbiddenPathPatterns: [], maxBlobSizeBytes: null, requireCodeOwners: false, requireHumanApproval: false, requireLatestPushApproval: false, requireLinearHistory: false, requireMergeQueue: false, requirePullRequest: true, requireResolvedThreads: false, requireSignedCommits: false, requiredApprovals: 0, requiredChecks: [{ context: "native-ci", producer_id: "producer-a", accepted_conclusions: ["success"], max_age_seconds: 3600 }], requiredEnvironmentIds: [] };
}

function locator(kind: CandidateArtifactKind, sha256 = digest(kind)): ImmutableBlobLocator {
  const requestSha256 = digest("candidate-request");
  return { tenantId: "tenant-a", repositoryId: "repo-a", operationId, requestSha256, kind, key: `v1/tenants/tenant-a/repositories/repo-a/merge-operations/${operationId}/${requestSha256}/${kind}`, sha256, sizeBytes: 42, etag: `etag-${kind}`, version: `version-${kind}`, expiresAt: null };
}

describe("D1 PR merge admission", () => {
  it("admits only a current checked candidate and returns read-only evidence for a future publication intent", async () => {
    const sql = new SqliteD1(); install(sql); const fixture = await seed(sql);
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    const result = await admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" });

    expect(result.intent).toMatchObject({ tenantId: "tenant-a", repositoryId: "repo-a", principalId: "actor-a", operationId: "repo.ref-update", atomic: true, expectedVersion: 9, policyEpoch: 7, eligibilityId: operationId, changes: [{ ref: "refs/heads/main", old_sha: baseSha, new_sha: candidateSha, force: false }] });
    expect(result.intent.idempotencyKey).toMatch(/^pr-merge:[0-9a-f]{64}$/u);
    expect(result.admissionKind).toBe("read_only_prepublication_evidence");
    expect(result.evidence.requiredChecks).toEqual([{ context: "native-ci", producerId: "producer-a", checkId: fixture.checkId, tokenId: fixture.tokenId, conclusion: "success" }]);
    expect(result.evidence.candidateArtifacts.rawCommit.sha256).toBe(rawSha);
  });

  it("admits production-native checks whose persisted check row stores raw digests", async () => {
    const sql = new SqliteD1(); install(sql); await seed(sql);
    sql.db.prepare("UPDATE checks SET plan_digest = ?, policy_digest = ? WHERE tenant_id = 'tenant-a' AND name = 'native-ci'").run(planDigest, policyDigest);
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    const result = await admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" });

    expect(result.evidence.requiredChecks).toHaveLength(1);
  });

  it("rejects producer authority drift by executing the native qualification fence", async () => {
    const sql = new SqliteD1(); install(sql); await seed(sql);
    sql.db.prepare("UPDATE principals SET auth_epoch = auth_epoch + 1 WHERE tenant_id = 'tenant-a' AND id = 'producer-a'").run();
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    await expect(admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" })).rejects.toThrow(/authoritative fence|native check/i);
  });

  it("rejects native attempt mutation by executing the native qualification fence", async () => {
    const sql = new SqliteD1(); install(sql); await seed(sql);
    sql.db.prepare("UPDATE native_candidate_job_attempts SET finalization_nonce = 'changed-after-completion' WHERE tenant_id = 'tenant-a' AND attempt_id = 'attempt-a'").run();
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    await expect(admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" })).rejects.toThrow(/authoritative fence|native check/i);
  });

  it("rejects invalid active eligibility expiry even when no check is required", async () => {
    const sql = new SqliteD1(); install(sql); await seed(sql, { policyOverrides: { required_checks: [] } });
    sql.db.prepare("UPDATE pr_eligibility_active SET expires_at = 'not-a-date' WHERE tenant_id = 'tenant-a' AND pull_request_id = 'pr-a'").run();
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    await expect(admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" })).rejects.toThrow(/active eligibility/i);
  });

  it("rejects a merge candidate when current policy no longer allows merge", async () => {
    const sql = new SqliteD1(); install(sql); await seed(sql, { policyOverrides: { allowed_merge_methods: ["squash"] } });
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    await expect(admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" })).rejects.toThrow(/merge method/i);
  });

  it("does not trust eligible snapshots when current native success evidence is missing", async () => {
    const sql = new SqliteD1(); install(sql); await seed(sql, { checkConclusion: "failure" });
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    await expect(admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" })).rejects.toThrow(/required native check native-ci is not satisfied/i);
  });

  it("fails closed when policy requires evidence the admission reader cannot authoritatively qualify", async () => {
    const sql = new SqliteD1(); install(sql); await seed(sql, { policyOverrides: { require_code_owners: true } });
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    await expect(admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" })).rejects.toThrow(/code owner/i);
  });

  it("rejects current PR revision drift instead of accepting a stale completed generation", async () => {
    const sql = new SqliteD1(); install(sql); await seed(sql);
    sql.db.prepare("UPDATE pull_requests SET version = version + 1 WHERE tenant_id = 'tenant-a' AND id = 'pr-a'").run();
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    await expect(admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" })).rejects.toThrow(/pull request revision/i);
  });

  it("rejects current public issue version drift separately from internal PR revision", async () => {
    const sql = new SqliteD1(); install(sql); await seed(sql);
    sql.db.prepare("UPDATE issues SET version = version + 1 WHERE tenant_id = 'tenant-a' AND id = 'issue-a'").run();
    const admission = makeD1PrMergeAdmission(sql, { clock: { now: () => new Date(now) } });

    await expect(admission.admit({ tenantId: "tenant-a", repositoryId: "repo-a", pullRequestId: "pr-a", principalId: "actor-a", eligibilityOperationId: operationId, eligibilityGeneration: 2, userIdempotencyKey: "merge-click-a" })).rejects.toThrow(/public PR issue version/i);
  });
});
