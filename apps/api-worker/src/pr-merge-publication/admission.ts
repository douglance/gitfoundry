import { Effect } from "effect";

import { buildPrMergePublicationIntent, type PrMergePublicationIntentInput } from "../../../../packages/core/src/git-publication/pr-merge.js";
import type { GitPublicationIntent } from "../../../../packages/core/src/git-publication/index.js";
import type { D1DatabaseLike, Clock } from "../../../../packages/core/src/live/index.js";
import type { ImmutableBlobLocator } from "../merge-candidate/artifact-store.js";
import { makeTrustedNativeJobCandidateCheckQualifier, rawNativeDigestFromPublicDigest, readNativeJobCheckToken } from "../native-jobs/check-reporting.js";
import type { NativeJobConclusion } from "../native-jobs/store.js";

export class PrMergeAdmissionError extends Error {
  readonly name = "PrMergeAdmissionError";
}

export interface PrMergeAdmissionInput {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly pullRequestId: string;
  readonly principalId: string;
  readonly eligibilityOperationId: string;
  readonly eligibilityGeneration: number;
  readonly userIdempotencyKey: string;
}

export interface AdmittedRequiredCheckEvidence { readonly context: string; readonly producerId: string; readonly checkId: string; readonly tokenId: string; readonly conclusion: string }
export interface PrMergeAdmissionEvidence {
  readonly eligibilityOperationId: string;
  readonly eligibilityGeneration: number;
  readonly pullRequestVersion: number;
  readonly issueVersion: number;
  readonly policyDigest: string;
  readonly planDigest: string;
  readonly candidateTreeSha: string;
  readonly candidateArtifacts: { readonly manifest: ImmutableBlobLocator; readonly rawCommit: ImmutableBlobLocator; readonly pack: ImmutableBlobLocator };
  readonly requiredChecks: readonly AdmittedRequiredCheckEvidence[];
}
export interface PrMergeAdmissionResult { readonly admissionKind: "read_only_prepublication_evidence"; readonly intent: GitPublicationIntent; readonly evidence: PrMergeAdmissionEvidence }
export interface PrMergeAdmission { readonly admit: (input: PrMergeAdmissionInput) => Promise<PrMergeAdmissionResult> }

interface AdmissionOptions { readonly clock?: Clock }
interface EligibilityGenerationRow { readonly tenant_id: string; readonly pull_request_id: string; readonly operation_id: string; readonly logical_key: string; readonly generation: number; readonly state: string; readonly expires_at: string; readonly head_sha: string; readonly base_sha: string; readonly method: string; readonly policy_digest: string; readonly snapshot_json: string | null }
interface ActiveEligibilityRow { readonly operation_id: string; readonly generation: number; readonly expires_at: string }
interface OperationRow { readonly result_key: string | null }
interface PullRequestRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly issue_version: number; readonly issue_state: string; readonly repository_id: string; readonly source_repository_id: string; readonly source_ref: string; readonly target_ref: string; readonly head_sha: string; readonly base_sha: string; readonly draft: number; readonly closed_at: string | null; readonly merged_at: string | null; readonly merge_sha: string | null }
interface RepositoryRow { readonly version: number; readonly archived: number }
interface TenantRow { readonly state: string; readonly policy_epoch: number }
interface PrincipalRow { readonly active: number }
interface RuleRow { readonly id: string; readonly version: number; readonly priority: number; readonly enabled: number; readonly rules_json: string }
interface CheckRow { readonly id: string; readonly conclusion: string | null; readonly status: string; readonly provider_evidence_ref: string | null; readonly job_attempt_id: string | null; readonly plan_digest: string; readonly policy_digest: string; readonly updated_at: string }
interface NativeWriteFence { readonly sql: string; readonly bindings: readonly (string | number | null)[] }
interface RequiredCheck { readonly context: string; readonly producer_id: string; readonly accepted_conclusions: readonly string[]; readonly max_age_seconds: number | null }

const systemClock: Clock = { now: () => new Date() };
const digestPattern = /^[0-9a-f]{64}$/u;

export function makeD1PrMergeAdmission(db: D1DatabaseLike, options: AdmissionOptions = {}): PrMergeAdmission {
  const clock = options.clock ?? systemClock;
  return { admit: (input) => admit(db, clock, input) };
}

async function admit(db: D1DatabaseLike, clock: Clock, input: PrMergeAdmissionInput): Promise<PrMergeAdmissionResult> {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new PrMergeAdmissionError("admission clock is unavailable");
  const nowIso = now.toISOString();
  const generation = await requireEligibilityGeneration(db, input, nowIso);
  await requireActiveEligibilityBinding(db, input, generation, nowIso);
  const operationResult = await requireOperationResult(db, input);
  const snapshot = requireRecord(operationResult.snapshot, "eligibility snapshot");
  const candidate = requireRecord(operationResult.candidate, "eligibility candidate");
  const outcome = requireRecord(operationResult.outcome, "eligibility outcome");
  const source = requireRecord(operationResult.source, "eligibility source");
  const policy = requireRecord(operationResult.policy, "eligibility policy");
  const checkPlan = requireRecord(operationResult.checkPlan, "eligibility check plan");
  const plan = requireRecord(checkPlan.plan, "eligibility check plan payload");
  const reviewedDiff = requireRecord(operationResult.reviewedDiff, "eligibility reviewed diff");

  const pr = await requireCurrentPullRequest(db, input);
  const tenant = await requireTenant(db, input.tenantId);
  const principal = await requirePrincipal(db, input.tenantId, input.principalId, "merge principal");
  const producerChecks = requiredChecks(policy);
  const targetRepository = await requireRepository(db, input.tenantId, input.repositoryId, "target repository");
  await requireRepository(db, input.tenantId, pr.source_repository_id, "source repository");
  const observedRules = await readRuleRows(db, input.tenantId, input.repositoryId);

  if (tenant.state !== "active") throw new PrMergeAdmissionError("tenant is not active");
  if (principal.active !== 1) throw new PrMergeAdmissionError("merge principal is not active");
  if (targetRepository.archived !== 0) throw new PrMergeAdmissionError("target repository is archived");
  if (tenant.policy_epoch !== numberField(snapshot.policy_epoch, "snapshot policy epoch")) throw new PrMergeAdmissionError("policy epoch is stale");
  if (pr.issue_state !== "open" || pr.draft !== 0 || pr.closed_at !== null || pr.merged_at !== null || pr.merge_sha !== null) throw new PrMergeAdmissionError("pull request is not open for merge");

  const baseSha = stringField(snapshot.base_sha, "snapshot base");
  const headSha = stringField(snapshot.head_sha, "snapshot head");
  const candidateSha = stringField(snapshot.candidate_sha, "snapshot candidate");
  const method = stringField(snapshot.method, "snapshot merge method");
  const policyDigest = rawDigest(stringField(snapshot.policy_digest, "snapshot policy digest"));
  const diffDigest = rawDigest(stringField(snapshot.diff_digest, "snapshot diff digest"));
  const candidateResult = requireRecord(candidate.result, "candidate result");
  const candidateTreeSha = stringField(candidateResult.candidateTree, "candidate tree");
  const rawCommitSha = stringField(candidateResult.candidateBytesSha256, "candidate raw digest");
  const manifest = requireLocator(candidate.manifest, "candidate_manifest");
  const rawCommit = requireLocator(candidate.rawCommit, "candidate_raw_commit");
  const pack = requireLocator(candidate.pack, "candidate_pack");
  const candidateRequestSha256 = stringField(candidate.requestSha256, "candidate request digest");
  const planDigest = rawDigest(stringField(checkPlan.planDigest, "check plan digest"));

  assertEqual(input.tenantId, generation.tenant_id, "eligibility tenant mismatch");
  assertEqual(input.pullRequestId, generation.pull_request_id, "eligibility PR mismatch");
  assertEqual("complete", generation.state, "eligibility generation is not complete");
  assertEqual(input.eligibilityGeneration, generation.generation, "eligibility generation mismatch");
  assertEqual(headSha, generation.head_sha, "eligibility head mismatch");
  assertEqual(baseSha, generation.base_sha, "eligibility base mismatch");
  assertEqual(policyDigest, rawDigest(generation.policy_digest), "eligibility policy digest mismatch");
  assertEqual(method, generation.method, "eligibility merge method mismatch");
  assertEqual(input.tenantId, stringField(snapshot.tenant_id, "snapshot tenant"), "snapshot tenant mismatch");
  assertEqual(input.pullRequestId, stringField(snapshot.pull_request_id, "snapshot PR"), "snapshot PR mismatch");
  assertEqual(input.eligibilityOperationId, stringField(snapshot.id, "snapshot id"), "snapshot id mismatch");
  assertEqual("eligible", stringField(snapshot.status, "snapshot status"), "eligibility is not eligible");
  if (arrayField(snapshot.blockers, "snapshot blockers").length !== 0) throw new PrMergeAdmissionError("eligibility snapshot has blockers");

  assertEqual(pr.repository_id, input.repositoryId, "pull request repository mismatch");
  assertEqual(input.tenantId, stringField(source.tenantId, "source tenant"), "source tenant mismatch");
  assertEqual(pr.source_repository_id, stringField(source.sourceRepositoryId, "source repository"), "source repository mismatch");
  assertEqual(pr.repository_id, stringField(source.targetRepositoryId, "target repository"), "target repository mismatch");
  assertEqual(pr.source_ref, stringField(source.sourceRef, "source ref"), "source ref mismatch");
  assertEqual(pr.target_ref, stringField(source.targetRef, "target ref"), "target ref mismatch");
  assertEqual(pr.head_sha, headSha, "pull request head is stale");
  assertEqual(pr.base_sha, baseSha, "pull request base is stale");
  assertEqual(pr.version, numberField(operationResult.internalPrRevision, "internal PR revision"), "pull request revision is stale");
  assertEqual(pr.issue_version, numberField(operationResult.exposedIssueVersion, "public issue version"), "public PR issue version is stale");
  assertEqual(pr.issue_version, numberField(snapshot.pr_version, "snapshot public PR version"), "snapshot public PR version is stale");

  assertEqual(true, Boolean(candidateResult.ok), "candidate result is not prepared");
  assertEqual("prepared", stringField(candidateResult.status, "candidate status"), "candidate result is not prepared");
  assertEqual(candidateSha, stringField(candidateResult.candidateOid, "candidate result oid"), "candidate result candidate mismatch");
  assertEqual(candidateSha, stringField(outcome.candidateOid, "outcome candidate"), "outcome candidate mismatch");
  assertEqual(candidateTreeSha, stringField(outcome.candidateTree, "outcome candidate tree"), "outcome tree mismatch");
  assertEqual(rawCommitSha, stringField(outcome.candidateBytesSha256, "outcome raw digest"), "outcome raw digest mismatch");
  assertEqual(candidateTreeSha, stringField(plan.candidateTreeOid, "plan candidate tree"), "plan candidate tree mismatch");
  assertEqual(candidateSha, stringField(plan.candidateOid, "plan candidate"), "plan candidate mismatch");
  assertEqual(policyDigest, rawDigest(stringField(plan.policyDigest, "plan policy digest")), "plan policy digest mismatch");
  assertEqual(diffDigest, rawDigest(stringField(reviewedDiff.patchSha256, "reviewed diff digest")), "reviewed diff mismatch");
  assertEqual(manifest.requestSha256, candidateRequestSha256, "candidate request digest mismatch");
  assertEqual(manifest.requestSha256, stringField(operationResult.preparationRequestSha256, "preparation request digest"), "preparation request digest mismatch");
  assertLocatorSet({ manifest, rawCommit, pack }, input, rawCommitSha);
  assertObservedRules(observedRules, operationResult);
  rejectUnsupportedPolicy(policy);
  assertAllowedMergeMethod(policy, method);

  const requiredCheckEvidence = await Promise.all(producerChecks.map((requirement) => requireSatisfiedNativeCheck(db, now, input, requirement, { pr, candidateSha, headSha, baseSha, candidateTreeSha, candidateRequestSha256, policyDigest, planDigest, diffDigest, rawCommitSha })));
  const authorityFence = `${input.eligibilityOperationId}:${input.repositoryId}:${pr.target_ref}:${input.eligibilityGeneration}:${baseSha}:${candidateSha}`;
  const intentInput: PrMergePublicationIntentInput = { tenantId: input.tenantId, repositoryId: input.repositoryId, principalId: input.principalId, pullRequestId: input.pullRequestId, eligibilityOperationId: input.eligibilityOperationId, eligibilityGeneration: input.eligibilityGeneration, targetRef: pr.target_ref, baseSha, candidateSha, expectedRepositoryVersion: targetRepository.version, policyEpoch: tenant.policy_epoch, authorityFence, userIdempotencyKey: input.userIdempotencyKey, reason: `merge ${input.pullRequestId} checked candidate` };
  return { admissionKind: "read_only_prepublication_evidence", intent: buildPrMergePublicationIntent(intentInput), evidence: { eligibilityOperationId: input.eligibilityOperationId, eligibilityGeneration: input.eligibilityGeneration, pullRequestVersion: pr.version, issueVersion: pr.issue_version, policyDigest, planDigest, candidateTreeSha, candidateArtifacts: { manifest, rawCommit, pack }, requiredChecks: requiredCheckEvidence } };
}

async function requireEligibilityGeneration(db: D1DatabaseLike, input: PrMergeAdmissionInput, now: string): Promise<EligibilityGenerationRow> {
  const row = await db.prepare("SELECT tenant_id,pull_request_id,operation_id,logical_key,generation,state,expires_at,head_sha,base_sha,method,policy_digest,snapshot_json FROM pr_eligibility_generations WHERE tenant_id = ? AND operation_id = ? AND generation = ? LIMIT 1").bind(input.tenantId, input.eligibilityOperationId, input.eligibilityGeneration).first<EligibilityGenerationRow>();
  if (!row) throw new PrMergeAdmissionError("completed eligibility generation is missing");
  requireFutureTimestamp(row.expires_at, "eligibility generation expiry", now);
  return row;
}

async function requireActiveEligibilityBinding(db: D1DatabaseLike, input: PrMergeAdmissionInput, generation: EligibilityGenerationRow, now: string): Promise<void> {
  const row = await db.prepare("SELECT operation_id,generation,expires_at FROM pr_eligibility_active WHERE tenant_id = ? AND pull_request_id = ? AND logical_key = ? LIMIT 1").bind(input.tenantId, input.pullRequestId, generation.logical_key).first<ActiveEligibilityRow>();
  if (!row) throw new PrMergeAdmissionError("active eligibility binding is missing");
  assertEqual(input.eligibilityOperationId, row.operation_id, "active eligibility operation mismatch");
  assertEqual(input.eligibilityGeneration, row.generation, "active eligibility generation mismatch");
  requireFutureTimestamp(row.expires_at, "active eligibility expiry", now);
}

async function requireOperationResult(db: D1DatabaseLike, input: PrMergeAdmissionInput): Promise<Record<string, unknown>> {
  const row = await db.prepare("SELECT result_key FROM operations WHERE tenant_id = ? AND id = ? AND kind = 'pr.eligibility.prepare' AND state = 'complete' LIMIT 1").bind(input.tenantId, input.eligibilityOperationId).first<OperationRow>();
  if (!row?.result_key?.startsWith("json:")) throw new PrMergeAdmissionError("completed eligibility result is unavailable");
  return requireRecord(parseJson(row.result_key.slice(5), "eligibility result"), "eligibility result");
}

async function requireCurrentPullRequest(db: D1DatabaseLike, input: PrMergeAdmissionInput): Promise<PullRequestRow> {
  const row = await db.prepare("SELECT pr.tenant_id,pr.id,pr.version,i.version AS issue_version,i.state AS issue_state,pr.repository_id,pr.source_repository_id,pr.source_ref,pr.target_ref,pr.head_sha,pr.base_sha,pr.draft,pr.closed_at,pr.merged_at,pr.merge_sha FROM pull_requests pr JOIN issues i ON i.tenant_id = pr.tenant_id AND i.id = pr.issue_id WHERE pr.tenant_id = ? AND pr.repository_id = ? AND pr.id = ? LIMIT 1").bind(input.tenantId, input.repositoryId, input.pullRequestId).first<PullRequestRow>();
  if (!row) throw new PrMergeAdmissionError("pull request is missing");
  return row;
}

async function requireTenant(db: D1DatabaseLike, tenantId: string): Promise<TenantRow> {
  const row = await db.prepare("SELECT state, policy_epoch FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first<TenantRow>();
  if (!row) throw new PrMergeAdmissionError("tenant is missing");
  return row;
}

async function requirePrincipal(db: D1DatabaseLike, tenantId: string, principalId: string, label: string): Promise<PrincipalRow> {
  const row = await db.prepare("SELECT active FROM principals WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, principalId).first<PrincipalRow>();
  if (!row) throw new PrMergeAdmissionError(`${label} is missing`);
  return row;
}

async function requireRepository(db: D1DatabaseLike, tenantId: string, repositoryId: string, label: string): Promise<RepositoryRow> {
  const row = await db.prepare("SELECT version, archived FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, repositoryId).first<RepositoryRow>();
  if (!row) throw new PrMergeAdmissionError(`${label} is missing`);
  return row;
}

async function readRuleRows(db: D1DatabaseLike, tenantId: string, repositoryId: string): Promise<readonly RuleRow[]> {
  const result = await db.prepare("SELECT id, version, priority, enabled, rules_json FROM rulesets WHERE tenant_id = ? AND repository_id = ? ORDER BY priority ASC, id ASC").bind(tenantId, repositoryId).all<RuleRow>();
  if (result.success === false || !Array.isArray(result.results)) throw new PrMergeAdmissionError("rules storage unavailable");
  return result.results;
}

async function requireSatisfiedNativeCheck(db: D1DatabaseLike, now: Date, input: PrMergeAdmissionInput, requirement: RequiredCheck, facts: { readonly pr: PullRequestRow; readonly candidateSha: string; readonly headSha: string; readonly baseSha: string; readonly candidateTreeSha: string; readonly candidateRequestSha256: string; readonly policyDigest: string; readonly planDigest: string; readonly diffDigest: string; readonly rawCommitSha: string }): Promise<AdmittedRequiredCheckEvidence> {
  const publicPolicyDigest = `sha256:${facts.policyDigest}`;
  const publicPlanDigest = `sha256:${facts.planDigest}`;
  const rows = await db.prepare(`SELECT id,status,conclusion,provider_evidence_ref,job_attempt_id,plan_digest,policy_digest,updated_at FROM checks WHERE tenant_id = ? AND repository_id = ? AND name = ? AND producer_id = ? AND commit_sha = ? AND head_sha = ? AND base_sha = ? AND execution_sha = ? AND candidate_bound = 1 AND evidence_kind = 'native_job' AND policy_digest IN (?, ?) AND plan_digest IN (?, ?) AND status = 'completed' ORDER BY updated_at DESC, id DESC LIMIT 10`).bind(input.tenantId, input.repositoryId, requirement.context, requirement.producer_id, facts.candidateSha, facts.headSha, facts.baseSha, facts.candidateSha, facts.policyDigest, publicPolicyDigest, facts.planDigest, publicPlanDigest).all<CheckRow>();
  const checks = rows.results ?? [];
  for (const check of checks) {
    if (rawDigest(check.policy_digest) !== facts.policyDigest || rawDigest(check.plan_digest) !== facts.planDigest) continue;
    if (check.conclusion === null || !requirement.accepted_conclusions.includes(check.conclusion)) continue;
    if (!withinMaxAge(check.updated_at, requirement.max_age_seconds, now)) continue;
    if (!check.job_attempt_id || check.provider_evidence_ref !== null) continue;
    const token = await requireNativeToken(db, now, input, requirement, check, facts, publicPlanDigest, publicPolicyDigest);
    return { context: requirement.context, producerId: requirement.producer_id, checkId: check.id, tokenId: token.id, conclusion: check.conclusion };
  }
  throw new PrMergeAdmissionError(`required native check ${requirement.context} is not satisfied`);
}

async function requireNativeToken(db: D1DatabaseLike, now: Date, input: PrMergeAdmissionInput, requirement: RequiredCheck, check: CheckRow, facts: { readonly pr: PullRequestRow; readonly candidateSha: string; readonly headSha: string; readonly baseSha: string; readonly candidateTreeSha: string; readonly candidateRequestSha256: string; readonly policyDigest: string; readonly planDigest: string; readonly diffDigest: string; readonly rawCommitSha: string }, publicPlanDigest: string, publicPolicyDigest: string) {
  const conclusion = check.conclusion as NativeJobConclusion;
  const proof = await Effect.runPromise(makeTrustedNativeJobCandidateCheckQualifier(db, { clock: { now: () => now } }).qualifyCandidateCheck({ tenantId: input.tenantId, targetRepositoryId: input.repositoryId, producerId: requirement.producer_id, context: requirement.context, commitSha: facts.candidateSha, headSha: facts.headSha, baseSha: facts.baseSha, executionSha: facts.candidateSha, planDigest: publicPlanDigest, policyDigest: publicPolicyDigest, actor: { id: requirement.producer_id, tenantId: input.tenantId, revoked: false, capabilities: ["check.write"] }, input: { repository_id: input.repositoryId, commit_sha: facts.candidateSha, evidence_kind: "native_job", candidate_bound: true, head_sha: facts.headSha, base_sha: facts.baseSha, execution_sha: facts.candidateSha, plan_digest: publicPlanDigest, policy_digest: publicPolicyDigest, job_attempt_id: check.job_attempt_id, provider_evidence_ref: null, name: requirement.context, status: "completed", conclusion, details_url: null, output: null, annotations: [] } }));
  await requireSatisfiedWriteFence(db, proof.writeFence, requirement.context);
  assertEqual(input.eligibilityOperationId, proof.eligibilityId, "native check eligibility mismatch");
  assertEqual(input.pullRequestId, proof.prId, "native check PR mismatch");
  assertEqual(publicPlanDigest, proof.planDigest, "native check plan digest mismatch");
  assertEqual(publicPolicyDigest, proof.policyDigest, "native check policy digest mismatch");
  const token = await readNativeJobCheckToken(db, { tenantId: input.tenantId, jobAttemptId: check.job_attempt_id!, status: "completed", conclusion });
  if (!token) throw new PrMergeAdmissionError(`required native check ${requirement.context} has no qualification token`);
  requireFutureTimestamp(token.expiresAt, `required native check ${requirement.context} token expiry`, now.toISOString());
  assertEqual(input.repositoryId, token.targetRepositoryId, "native check target repository mismatch");
  assertEqual(facts.pr.source_repository_id, token.sourceRepositoryId, "native check source repository mismatch");
  assertEqual(input.pullRequestId, token.pullRequestId, "native check PR mismatch");
  assertEqual(facts.pr.version, token.pullRequestVersion, "native check PR revision mismatch");
  assertEqual(facts.pr.issue_version, token.issueVersion, "native check public PR version mismatch");
  assertEqual(input.eligibilityOperationId, token.eligibilityOperationId, "native check eligibility mismatch");
  assertEqual(input.eligibilityGeneration, token.eligibilityGeneration, "native check generation mismatch");
  assertEqual(requirement.producer_id, token.producerId, "native check producer mismatch");
  assertEqual(requirement.context, token.context, "native check context mismatch");
  assertEqual(facts.candidateSha, token.candidateSha, "native check candidate mismatch");
  assertEqual(facts.headSha, token.headSha, "native check head mismatch");
  assertEqual(facts.baseSha, token.baseSha, "native check base mismatch");
  assertEqual(facts.candidateSha, token.executionSha, "native check execution mismatch");
  assertEqual(facts.candidateTreeSha, token.candidateTreeSha, "native check tree mismatch");
  assertEqual(facts.candidateRequestSha256, token.candidateRequestSha256, "native check candidate request mismatch");
  assertEqual(facts.policyDigest, rawDigest(token.policyDigest), "native check policy digest mismatch");
  assertEqual(facts.planDigest, rawDigest(token.planDigest), "native check plan digest mismatch");
  assertEqual(facts.diffDigest, rawDigest(token.reviewedDiffDigest), "native check diff digest mismatch");
  assertEqual("native_job", token.evidenceKind, "native check evidence kind mismatch");
  assertEqual("completed", token.status, "native check status mismatch");
  assertEqual(check.conclusion, token.conclusion, "native check conclusion mismatch");
  assertEqual(check.job_attempt_id, token.jobAttemptId, "native check job attempt mismatch");
  assertLocatorSet(token.candidateArtifacts, input, facts.rawCommitSha);
  const producer = await requirePrincipal(db, input.tenantId, requirement.producer_id, "native check producer");
  if (producer.active !== 1) throw new PrMergeAdmissionError(`required native check ${requirement.context} producer is not active`);
  return token;
}

async function requireSatisfiedWriteFence(db: D1DatabaseLike, fence: NativeWriteFence | unknown, context: string): Promise<void> {
  if (typeof fence !== "object" || fence === null || typeof (fence as NativeWriteFence).sql !== "string" || (fence as NativeWriteFence).sql.length === 0 || !Array.isArray((fence as NativeWriteFence).bindings)) throw new PrMergeAdmissionError(`required native check ${context} has no authoritative fence`);
  const trusted = fence as NativeWriteFence;
  const row = await db.prepare(`SELECT 1 AS ok WHERE ${trusted.sql}`).bind(...trusted.bindings).first<{ ok: number }>();
  if (!row) throw new PrMergeAdmissionError(`required native check ${context} authoritative fence is not satisfied`);
}

function requiredChecks(policy: Record<string, unknown>): readonly RequiredCheck[] {
  const enforcement = requireRecord(policy.enforcement, "policy enforcement");
  const checks = arrayField(enforcement.requiredChecks, "required checks");
  return checks.map((value) => {
    const item = requireRecord(value, "required check");
    return { context: stringField(item.context, "check context"), producer_id: stringField(item.producer_id, "check producer"), accepted_conclusions: arrayField(item.accepted_conclusions, "accepted conclusions").map((conclusion) => stringField(conclusion, "accepted conclusion")), max_age_seconds: item.max_age_seconds === null ? null : numberField(item.max_age_seconds, "check max age") };
  });
}

function assertAllowedMergeMethod(policy: Record<string, unknown>, method: string): void {
  const enforcement = requireRecord(policy.enforcement, "policy enforcement");
  const allowed = arrayField(enforcement.allowedMergeMethods, "allowed merge methods").map((value) => stringField(value, "allowed merge method"));
  if (method !== "merge") throw new PrMergeAdmissionError("merge method is not supported by this admission reader");
  if (!allowed.includes(method)) throw new PrMergeAdmissionError("merge method is not allowed by current policy");
}

function rejectUnsupportedPolicy(policy: Record<string, unknown>): void {
  const enforcement = requireRecord(policy.enforcement, "policy enforcement");
  const unsupported: string[] = [];
  if (numberField(enforcement.requiredApprovals, "required approvals") > 0) unsupported.push("approval count");
  for (const [key, label] of [["requireHumanApproval", "human approval"], ["requireLatestPushApproval", "latest push approval"], ["requireCodeOwners", "code owner"], ["requireResolvedThreads", "thread resolution"], ["requireMergeQueue", "merge queue"], ["requireLinearHistory", "linear history"], ["requireSignedCommits", "signed commits"]] as const) if (booleanField(enforcement[key], key)) unsupported.push(label);
  if (arrayField(enforcement.requiredEnvironmentIds, "required environments").length > 0) unsupported.push("deployment environment");
  if (arrayField(enforcement.allowedWriterGroupClauses, "writer groups").length > 0) unsupported.push("writer group");
  if (arrayField(enforcement.forbiddenPathPatterns, "forbidden paths").length > 0) unsupported.push("forbidden path");
  if (enforcement.maxBlobSizeBytes !== null) unsupported.push("maximum blob size");
  if (unsupported.length > 0) throw new PrMergeAdmissionError(`policy requires authoritative evidence not implemented for ${unsupported[0]}`);
}

function assertObservedRules(rows: readonly RuleRow[], result: Record<string, unknown>): void {
  const policy = requireRecord(result.policy, "policy");
  const identities = arrayField(policy.identityRules, "policy identity rules").map((value) => requireRecord(value, "policy identity rule"));
  const current = rows.map((row) => `${row.id}\0${row.version}\0${row.priority}\0${row.enabled === 1}\0${canonicalJson(parseJson(row.rules_json, "rules"))}`).sort();
  const observed = identities.map((identity) => `${stringField(identity.rowId, "row id")}\0${numberField(identity.rowVersion, "row version")}\0${numberField(identity.rowPriority, "row priority")}\0${booleanField(identity.rowEnabled, "row enabled")}\0${canonicalJson(identity.rule)}`).sort();
  if (current.length !== observed.length || current.some((value, index) => value !== observed[index])) throw new PrMergeAdmissionError("observed rules changed");
}

function assertLocatorSet(artifacts: { readonly manifest: ImmutableBlobLocator; readonly rawCommit: ImmutableBlobLocator; readonly pack: ImmutableBlobLocator }, input: PrMergeAdmissionInput, rawCommitSha: string): void {
  assertLocator(artifacts.manifest, "candidate_manifest", input);
  assertLocator(artifacts.rawCommit, "candidate_raw_commit", input, rawCommitSha);
  assertLocator(artifacts.pack, "candidate_pack", input);
  const requestSha256 = artifacts.manifest.requestSha256;
  if (artifacts.rawCommit.requestSha256 !== requestSha256 || artifacts.pack.requestSha256 !== requestSha256) throw new PrMergeAdmissionError("candidate artifact request digest mismatch");
}

function assertLocator(locator: ImmutableBlobLocator, kind: string, input: PrMergeAdmissionInput, expectedSha256?: string): void {
  if (locator.tenantId !== input.tenantId || locator.repositoryId !== input.repositoryId || locator.operationId !== input.eligibilityOperationId || locator.kind !== kind || !digestPattern.test(locator.requestSha256) || !digestPattern.test(locator.sha256) || (expectedSha256 !== undefined && locator.sha256 !== expectedSha256) || !Number.isSafeInteger(locator.sizeBytes) || locator.sizeBytes < 0 || typeof locator.etag !== "string" || locator.etag.length === 0 || typeof locator.version !== "string" || locator.version.length === 0 || locator.key !== `v1/tenants/${input.tenantId}/repositories/${input.repositoryId}/merge-operations/${input.eligibilityOperationId}/${locator.requestSha256}/${kind}`) throw new PrMergeAdmissionError("candidate artifact locator mismatch");
}

function requireLocator(value: unknown, kind: string): ImmutableBlobLocator {
  const locator = requireRecord(value, `${kind} locator`) as unknown as ImmutableBlobLocator;
  if (locator.kind !== kind) throw new PrMergeAdmissionError(`${kind} locator mismatch`);
  return locator;
}

function requireFutureTimestamp(value: string, label: string, now: string): void {
  const observed = Date.parse(value);
  const current = Date.parse(now);
  if (!Number.isFinite(observed)) throw new PrMergeAdmissionError(`${label} is malformed`);
  if (!Number.isFinite(current)) throw new PrMergeAdmissionError("admission clock is unavailable");
  if (observed <= current) throw new PrMergeAdmissionError(`${label} is expired`);
}

function withinMaxAge(observedAt: string, maxAgeSeconds: number | null, now: Date): boolean {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || observed > now.getTime()) return false;
  return maxAgeSeconds === null || now.getTime() - observed <= maxAgeSeconds * 1000;
}

function rawDigest(value: string): string {
  const raw = rawNativeDigestFromPublicDigest(value);
  if (!digestPattern.test(raw)) throw new PrMergeAdmissionError("digest is malformed");
  return raw;
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new PrMergeAdmissionError(`${label} is malformed`); }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PrMergeAdmissionError(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new PrMergeAdmissionError(`${label} is malformed`);
  return value;
}

function numberField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new PrMergeAdmissionError(`${label} is malformed`);
  return value;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new PrMergeAdmissionError(`${label} is malformed`);
  return value;
}

function arrayField(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new PrMergeAdmissionError(`${label} is malformed`);
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

function assertEqual<T>(expected: T, actual: T, message: string): void {
  if (actual !== expected) throw new PrMergeAdmissionError(message);
}
