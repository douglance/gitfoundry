import { createHash } from "node:crypto";

import { decodeSourceSchema } from "@gitfoundry/contracts";
import { Effect } from "effect";

import type { D1DatabaseLike, Clock } from "../../../../packages/core/src/live/index.js";
import type { QualifiedGitReadPort } from "../../../../packages/core/src/live/forge.js";
import type { ImmutableBlobLocator, CandidateArtifactKind } from "../merge-candidate/artifact-store.js";
import { encodeMergeCandidatePrepareRequest, mergeCandidatePrepareOptions, type MergeCandidatePrepareInput, type MergeCandidateMethod, type MergeCandidateResult } from "../merge-candidate/index.js";
import type { ReviewedDiffEvidence, StoredMergeCandidate } from "../merge-candidate/pipeline.js";
import { sourceDomain } from "../source-catalog.generated.js";
import { buildCandidateCheckPlan, deriveEligibilityPolicy, type AuthoritativeEligibilityRuleRow, type EligibilityPolicy } from "./policy.js";
import type { CandidatePreparationRuntime } from "./runtime.js";
import { PrEligibilityStoreConflictError, makeD1PrEligibilityStore, type ObservedRuleRow } from "./store.js";

export type ForgePrEligibility = {
  readonly tenant_id: string; readonly pull_request_id: string; readonly pr_version: number; readonly id: string; readonly status: "computing" | "eligible" | "blocked" | "expired" | "reconciling";
  readonly head_sha: string; readonly base_sha: string; readonly candidate_sha: string | null; readonly method: "merge" | "squash" | "rebase" | "fast-forward"; readonly diff_digest: string; readonly policy_digest: string; readonly policy_epoch: number; readonly expires_at: string;
  readonly blockers: readonly EligibilityBlocker[]; readonly reviews: readonly unknown[]; readonly checks: readonly unknown[];
};
export type EligibilityBlockerCode = "draft" | "closed" | "conflict" | "stale_head" | "stale_base" | "stale_policy" | "approval_missing" | "changes_requested" | "code_owner_missing" | "thread_unresolved" | "check_pending" | "check_failed" | "deployment_missing" | "hook_denied" | "hook_pending" | "actor_ineligible" | "queue_required" | "provider_unqualified";
export interface EligibilityBlocker { readonly code: EligibilityBlockerCode; readonly resource_id: string | null; readonly detail: string; readonly required_action: string }
export interface PrEligibilityInput { readonly tenantId: string; readonly pullRequestId: string; readonly actorId: string; readonly method?: ForgePrEligibility["method"]; readonly headSha?: string; readonly baseSha?: string }
export interface PrEligibilityService { readonly get: (input: PrEligibilityInput) => Promise<ForgePrEligibility> }
export interface PrEligibilityServiceOptions { readonly runtime: CandidatePreparationRuntime; readonly gitRead: QualifiedGitReadPort; readonly clock?: Clock | undefined; readonly authorize: (input: { readonly tenantId: string; readonly actorId: string; readonly policyEpoch: number }) => Promise<void> }
export class PrEligibilityError extends Error { readonly name = "PrEligibilityError"; constructor(readonly code: "not_found" | "stale" | "unavailable" | "pending" | "denied", message: string = code, readonly operationId?: string) { super(message) } }

interface Context { readonly tenantId: string; readonly tenantState: string; readonly policyEpoch: number; readonly actorId: string; readonly actorActive: boolean; readonly repositoryId: string; readonly sourceRepositoryId: string; readonly pullRequestId: string; readonly prVersion: number; readonly issueVersion: number; readonly issueState: "open" | "closed"; readonly sourceRef: string; readonly targetRef: string; readonly headSha: string; readonly baseSha: string; readonly draft: boolean; readonly closedAt: string | null; readonly mergedAt: string | null; readonly rules: readonly RuleRow[] }
interface RuleRow { readonly id: string; readonly version: number; readonly priority: number; readonly enabled: number; readonly rules_json: string }
interface PreparedIdentity { readonly method: ForgePrEligibility["method"]; readonly committerName: string; readonly committerEmail: string; readonly message: string; readonly mergeOptions: ReturnType<typeof mergeCandidatePrepareOptions> }
const systemClock: Clock = { now: () => new Date() };
const sha40 = /^[0-9a-f]{40}$/u;
const sha64 = /^[0-9a-f]{64}$/u;

export function makeD1PrEligibilityService(db: D1DatabaseLike, options: PrEligibilityServiceOptions): PrEligibilityService {
  const store = makeD1PrEligibilityStore(db);
  const clock = options.clock ?? systemClock;
  return { get: async (input) => getEligibility(db, store, clock, options, input) };
}

async function getEligibility(db: D1DatabaseLike, store: ReturnType<typeof makeD1PrEligibilityStore>, clock: Clock, options: PrEligibilityServiceOptions, input: PrEligibilityInput): Promise<ForgePrEligibility> {
  const now = iso(clock.now());
  const method = input.method ?? "merge";
  const prepared = preparedIdentity(input.actorId, input.pullRequestId, method);
  const context = await readContext(db, input);
  await authorizeFresh(options, context);
  assertPreconditions(input, context);
  await validateRefs(options.gitRead, context);
  const policyResult = await derivePolicyForContext(context);
  const expiresAt = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();
  const observedRuleRows = observedRules(context.rules);
  const logicalKey = sha(canonical({ tenantId: context.tenantId, actorId: input.actorId, context: contextIdentity(context), observedRuleRows, policyDigest: policyResult.policyDigest, method, committerName: prepared.committerName, committerEmail: prepared.committerEmail, message: prepared.message, mergeOptions: prepared.mergeOptions }));
  const operationPrefix = `pr-eligibility-${logicalKey.slice(0, 32)}`;
  const progressBase = { committedAt: now, observedRuleRows, context: contextIdentity(context), policyDigest: policyResult.policyDigest, prepared };
  let reservation: Awaited<ReturnType<typeof store.reserve>>;
  try {
    reservation = await store.reserve({ tenantId: context.tenantId, pullRequestId: context.pullRequestId, actorId: input.actorId, logicalKey, operationPrefix, now, expiresAt, committedAt: now, headSha: context.headSha, baseSha: context.baseSha, method, policyDigest: policyResult.policyDigest, progress: progressBase });
  } catch (error) {
    throw storeError(error, "unavailable");
  }
  if (reservation.snapshot) {
    const replayContext = await readContext(db, input);
    await authorizeFresh(options, replayContext);
    assertContextStable(context, replayContext, input);
    await validateRefs(options.gitRead, replayContext);
    const replayNow = iso(clock.now());
    if (Date.parse(replayNow) >= Date.parse(reservation.expiresAt)) throw new PrEligibilityError("stale", "eligibility reservation expired", reservation.operationId);
    return decodeEligibilitySnapshot(reservation.snapshot);
  }
  const committedAt = reservation.committedAt;
  const operationId = reservation.operationId;
  const candidateInput: MergeCandidatePrepareInput = { commandId: operationId, tenantId: context.tenantId, repositoryId: context.repositoryId, operationId, fenceToken: `${operationId}-fence`, pullRequestId: context.pullRequestId, pullRequestVersion: context.prVersion, headSha: context.headSha, baseSha: context.baseSha, method: runtimeMethod(method), committerName: prepared.committerName, committerEmail: prepared.committerEmail, committedAt, message: prepared.message };
  const candidateRequest = encodeMergeCandidatePrepareRequest(candidateInput);
  const outcome = await options.runtime.prepare({ candidate: candidateInput, sourceRepositoryId: context.sourceRepositoryId, sourceRef: context.sourceRef, targetRef: context.targetRef }).catch(() => { throw new PrEligibilityError("unavailable", "candidate preparation unavailable", operationId); });
  const reviewedDiff = validateReviewedDiff(outcome.reviewedDiff ?? outcome.candidate?.reviewedDiff, context, operationId);
  const latest = await readContext(db, input);
  await authorizeFresh(options, latest);
  assertContextStable(context, latest, input);
  await validateRefs(options.gitRead, latest);
  const result = outcome.result;
  const candidateRecord = result.ok ? validateCandidate(outcome.candidate, result, reviewedDiff, context, operationId, candidateRequest.requestSha256) : null;
  const candidateSha = result.ok ? result.candidateOid : null;
  const checkPlan = result.ok ? await buildCandidateCheckPlan({ tenantId: context.tenantId, sourceRepositoryId: context.sourceRepositoryId, targetRepositoryId: context.repositoryId, pullRequestId: context.pullRequestId, pullRequestVersion: context.prVersion, headOid: context.headSha, baseOid: context.baseSha, candidateOid: result.candidateOid, candidateTreeOid: result.candidateTree, reviewedDiff: reviewedDiffForPlan(reviewedDiff), mergeMethod: method, mergeOptions: prepared.mergeOptions, policyDigest: policyResult.policyDigest, requiredChecks: policyResult.policy.enforcement.requiredChecks }) : null;
  const finalNow = iso(clock.now());
  if (Date.parse(finalNow) >= Date.parse(reservation.expiresAt)) throw new PrEligibilityError("stale", "eligibility reservation expired", operationId);
  const blockers = blockersFor(context, policyResult.policy, result.ok ? null : result.status);
  const snapshot = decodeEligibilitySnapshot({ tenant_id: context.tenantId, pull_request_id: context.pullRequestId, pr_version: context.issueVersion, id: operationId, status: blockers.length === 0 && candidateSha ? "eligible" : "blocked", head_sha: context.headSha, base_sha: context.baseSha, candidate_sha: candidateSha, method, diff_digest: reviewedDiff.patchSha256, policy_digest: policyResult.policyDigest, policy_epoch: context.policyEpoch, expires_at: reservation.expiresAt, blockers, reviews: [], checks: [] });
  const resultRecord = { snapshot, candidate: candidateRecord, outcome: result, reviewedDiff, policy: policyResult.policy, checkPlan, preparationRequestSha256: candidateRequest.requestSha256, source: { tenantId: context.tenantId, sourceRepositoryId: context.sourceRepositoryId, targetRepositoryId: context.repositoryId, sourceRef: context.sourceRef, targetRef: context.targetRef, headSha: context.headSha, baseSha: context.baseSha }, exposedIssueVersion: context.issueVersion, internalPrRevision: context.prVersion, committedAt, expiresAt: reservation.expiresAt, generation: reservation.generation };
  const progress = { ...progressBase, committedAt, outcome: result, reviewedDiff, candidate: candidateRecord, checkPlan };
  try {
    await store.complete({ tenantId: context.tenantId, operationId, logicalKey, generation: reservation.generation, now: finalNow, snapshot, result: resultRecord, progress, candidateSha, repositoryId: context.repositoryId, sourceRepositoryId: context.sourceRepositoryId, pullRequestId: context.pullRequestId, prVersion: context.prVersion, issueVersion: context.issueVersion, issueState: context.issueState, draft: context.draft, closedAt: context.closedAt, mergedAt: context.mergedAt, sourceRef: context.sourceRef, targetRef: context.targetRef, headSha: context.headSha, baseSha: context.baseSha, policyEpoch: context.policyEpoch, expiresAt: reservation.expiresAt, observedRuleRows });
  } catch (error) {
    throw storeError(error, "stale", operationId);
  }
  return snapshot;
}

async function readContext(db: D1DatabaseLike, input: PrEligibilityInput): Promise<Context> {
  const row = await db.prepare(`SELECT t.policy_epoch AS policy_epoch, t.state AS tenant_state, p.active AS actor_active, pr.tenant_id AS tenant_id, pr.id AS pull_request_id, pr.version AS pr_version, i.version AS issue_version, i.state AS issue_state, pr.repository_id AS repository_id, pr.source_repository_id AS source_repository_id, pr.source_ref AS source_ref, pr.target_ref AS target_ref, pr.head_sha AS head_sha, pr.base_sha AS base_sha, pr.draft AS draft, pr.closed_at AS closed_at, pr.merged_at AS merged_at FROM pull_requests pr JOIN issues i ON i.tenant_id = pr.tenant_id AND i.id = pr.issue_id JOIN tenants t ON t.id = pr.tenant_id LEFT JOIN principals p ON p.tenant_id = pr.tenant_id AND p.id = ? WHERE pr.tenant_id = ? AND pr.id = ? LIMIT 1`).bind(input.actorId, input.tenantId, input.pullRequestId).first<Record<string, unknown>>();
  if (!row) throw new PrEligibilityError("not_found", "pull request not found");
  const repositoryId = stringField(row.repository_id);
  const rulesResult = await db.prepare("SELECT id, version, priority, enabled, rules_json FROM rulesets WHERE tenant_id = ? AND repository_id = ? ORDER BY priority ASC, id ASC").bind(input.tenantId, repositoryId).all<RuleRow>();
  if (rulesResult.success === false || !Array.isArray(rulesResult.results)) throw new PrEligibilityError("unavailable", "rules storage unavailable");
  const rules = rulesResult.results.map(validateRuleRow);
  return { tenantId: stringField(row.tenant_id), tenantState: stringField(row.tenant_state), policyEpoch: intField(row.policy_epoch), actorId: input.actorId, actorActive: row.actor_active === 1, repositoryId, sourceRepositoryId: stringField(row.source_repository_id), pullRequestId: stringField(row.pull_request_id), prVersion: intField(row.pr_version), issueVersion: intField(row.issue_version), issueState: enumField(row.issue_state, ["open", "closed"]), sourceRef: stringField(row.source_ref), targetRef: stringField(row.target_ref), headSha: stringField(row.head_sha), baseSha: stringField(row.base_sha), draft: row.draft === 1, closedAt: nullableString(row.closed_at), mergedAt: nullableString(row.merged_at), rules };
}

async function derivePolicyForContext(context: Context) {
  const rows: AuthoritativeEligibilityRuleRow[] = context.rules.map((row) => ({ id: row.id, version: row.version, priority: row.priority, enabled: row.enabled === 1, rules: JSON.parse(row.rules_json) }));
  return deriveEligibilityPolicy({ tenantId: context.tenantId, repositoryId: context.repositoryId, targetRef: context.targetRef, policyEpoch: context.policyEpoch, rows });
}

function blockersFor(context: Context, policy: EligibilityPolicy, failure: string | null): readonly EligibilityBlocker[] {
  const blockers: EligibilityBlocker[] = [];
  if (context.draft) blockers.push(blocker("draft", context.pullRequestId, "Pull request is draft.", "pr.ready"));
  if (context.issueState === "closed" || context.closedAt !== null || context.mergedAt !== null) blockers.push(blocker("closed", context.pullRequestId, "Pull request is closed.", "pr.reopen"));
  if (failure === "conflict") blockers.push(blocker("conflict", context.pullRequestId, "Candidate preparation reported merge conflicts.", "pr.resolve_conflicts"));
  if (failure === "non_fast_forward" || failure === "stale_input") blockers.push(blocker("stale_head", context.pullRequestId, "Candidate preparation reported stale input.", "pr.refresh"));
  if (policy.enforcement.requiredApprovals > 0 || policy.enforcement.requireHumanApproval) blockers.push(blocker("approval_missing", context.pullRequestId, "Qualified approval evidence is missing.", "review.approve"));
  if (policy.enforcement.requireCodeOwners) blockers.push(blocker("code_owner_missing", context.pullRequestId, "Qualified code owner evidence is missing.", "review.code_owner"));
  if (policy.enforcement.requireResolvedThreads) blockers.push(blocker("thread_unresolved", context.pullRequestId, "Thread resolution evidence is unavailable.", "thread.resolve"));
  if (policy.enforcement.requireMergeQueue) blockers.push(blocker("queue_required", context.pullRequestId, "Merge queue admission is required.", "queue.enqueue"));
  if (policy.enforcement.requiredEnvironmentIds.length > 0) blockers.push(blocker("deployment_missing", context.pullRequestId, "Deployment evidence is unavailable.", "deployment.verify"));
  if (policy.enforcement.allowedWriterGroupClauses.length > 0) blockers.push(blocker("actor_ineligible", context.actorId, "Writer group eligibility is not qualified.", "actor.qualify"));
  blockers.push(blocker("provider_unqualified", null, "Publication and check provenance evidence is unavailable.", "pr.eligibility"));
  return blockers;
}

function preparedIdentity(actorId: string, pullRequestId: string, method: ForgePrEligibility["method"]): PreparedIdentity { return { method, committerName: actorId, committerEmail: `${actorId}@gitfoundry.invalid`, message: `Prepare candidate for ${pullRequestId}`, mergeOptions: mergeCandidatePrepareOptions() }; }
function observedRules(rules: readonly RuleRow[]): readonly ObservedRuleRow[] { return rules.map((row) => ({ id: row.id, version: row.version, priority: row.priority, enabled: row.enabled === 1 ? 1 : 0, rules_json: row.rules_json })); }
function contextIdentity(context: Context) { return { tenantId: context.tenantId, repositoryId: context.repositoryId, sourceRepositoryId: context.sourceRepositoryId, pullRequestId: context.pullRequestId, prVersion: context.prVersion, issueVersion: context.issueVersion, issueState: context.issueState, sourceRef: context.sourceRef, targetRef: context.targetRef, headSha: context.headSha, baseSha: context.baseSha, draft: context.draft, closedAt: context.closedAt, mergedAt: context.mergedAt, policyEpoch: context.policyEpoch }; }
function blocker(code: EligibilityBlockerCode, resourceId: string | null, detail: string, requiredAction: string): EligibilityBlocker { return { code, resource_id: resourceId, detail, required_action: requiredAction }; }
async function authorizeFresh(options: PrEligibilityServiceOptions, context: Context): Promise<void> { if (context.tenantState !== "active") throw new PrEligibilityError("denied", "tenant is not active"); if (!context.actorActive) throw new PrEligibilityError("denied", "actor is not active"); try { await options.authorize({ tenantId: context.tenantId, actorId: context.actorId, policyEpoch: context.policyEpoch }); } catch { throw new PrEligibilityError("denied", "actor is not authorized"); } }
function assertPreconditions(input: PrEligibilityInput, context: Context): void { if (input.headSha && input.headSha !== context.headSha) throw new PrEligibilityError("stale", "head precondition is stale"); if (input.baseSha && input.baseSha !== context.baseSha) throw new PrEligibilityError("stale", "base precondition is stale"); }
function assertContextStable(before: Context, after: Context, input: PrEligibilityInput): void { if (canonical(contextIdentity(before)) !== canonical(contextIdentity(after))) throw new PrEligibilityError("stale", "pull request changed"); if (canonical(observedRules(before.rules)) !== canonical(observedRules(after.rules))) throw new PrEligibilityError("stale", "rules changed"); assertPreconditions(input, after); }
async function validateRefs(gitRead: QualifiedGitReadPort, context: Context): Promise<void> { const target = await Effect.runPromise(gitRead.resolveRef({ tenantId: context.tenantId, repositoryId: context.repositoryId, ref: context.targetRef })); const source = await Effect.runPromise(gitRead.resolveRef({ tenantId: context.tenantId, repositoryId: context.sourceRepositoryId, ref: context.sourceRef })); if (target.sha !== context.baseSha) throw new PrEligibilityError("stale", "target ref changed"); if (source.sha !== context.headSha) throw new PrEligibilityError("stale", "source ref changed"); }
function validateReviewedDiff(diff: ReviewedDiffEvidence | undefined, context: Context, operationId: string): ReviewedDiffEvidence { if (!record(diff)) throw new PrEligibilityError("unavailable", "candidate reviewed diff unavailable", operationId); exactKeys(diff, ["algorithmVersion", "comparison", "contextLines", "headSha", "baseSha", "mergeBaseShas", "patchSha256", "patchSizeBytes", "changedPathsSha256"], operationId); if (diff.algorithmVersion !== "git-cli-unified-v1" || diff.comparison !== "three_dot" || diff.contextLines !== 3 || diff.headSha !== context.headSha || diff.baseSha !== context.baseSha || (typeof diff.patchSha256 !== "string" || !sha64.test(diff.patchSha256)) || (typeof diff.changedPathsSha256 !== "string" || !sha64.test(diff.changedPathsSha256)) || !Number.isSafeInteger(diff.patchSizeBytes) || diff.patchSizeBytes < 0 || diff.patchSizeBytes > 1024 * 1024 || !Array.isArray(diff.mergeBaseShas) || diff.mergeBaseShas.length < 1 || diff.mergeBaseShas.length > 64 || new Set(diff.mergeBaseShas).size !== diff.mergeBaseShas.length || diff.mergeBaseShas.some((shaValue) => typeof shaValue !== "string" || !sha40.test(shaValue))) throw new PrEligibilityError("unavailable", "candidate reviewed diff malformed", operationId); return { algorithmVersion: "git-cli-unified-v1", comparison: "three_dot", contextLines: 3, headSha: context.headSha, baseSha: context.baseSha, mergeBaseShas: [...diff.mergeBaseShas], patchSha256: diff.patchSha256, patchSizeBytes: diff.patchSizeBytes, changedPathsSha256: diff.changedPathsSha256 }; }
function validateCandidate(candidate: StoredMergeCandidate | undefined, result: Extract<MergeCandidateResult, { readonly ok: true }>, reviewedDiff: ReviewedDiffEvidence, context: Context, operationId: string, requestSha256: string): StoredMergeCandidate { if (!candidate) throw new PrEligibilityError("unavailable", "prepared candidate artifact missing", operationId); if (candidate.requestSha256 !== requestSha256 || result.stateRef !== `merge-candidates/requests/${requestSha256}/manifest.json` || canonical(candidate.result) !== canonical(result) || canonical(candidate.reviewedDiff) !== canonical(reviewedDiff)) throw new PrEligibilityError("unavailable", "prepared candidate artifact mismatched", operationId); validateLocator(candidate.manifest, "candidate_manifest", context, operationId, requestSha256); validateLocator(candidate.rawCommit, "candidate_raw_commit", context, operationId, requestSha256, result.candidateBytesSha256); validateLocator(candidate.pack, "candidate_pack", context, operationId, requestSha256); return candidate; }
function validateLocator(locator: ImmutableBlobLocator, kind: CandidateArtifactKind, context: Context, operationId: string, requestSha256: string, expectedSha256?: string): void { if (!record(locator) || locator.tenantId !== context.tenantId || locator.repositoryId !== context.repositoryId || locator.operationId !== operationId || locator.requestSha256 !== requestSha256 || locator.kind !== kind || locator.key !== `v1/tenants/${context.tenantId}/repositories/${context.repositoryId}/merge-operations/${operationId}/${requestSha256}/${kind}` || (typeof locator.sha256 !== "string" || !sha64.test(locator.sha256)) || (expectedSha256 !== undefined && locator.sha256 !== expectedSha256) || !Number.isSafeInteger(locator.sizeBytes) || locator.sizeBytes < 0 || locator.sizeBytes > 128 * 1024 * 1024 || typeof locator.etag !== "string" || locator.etag.length === 0 || typeof locator.version !== "string" || locator.version.length === 0 || (locator.expiresAt !== null && (typeof locator.expiresAt !== "string" || !Number.isFinite(Date.parse(locator.expiresAt)) || new Date(Date.parse(locator.expiresAt)).toISOString() !== locator.expiresAt))) throw new PrEligibilityError("unavailable", "prepared candidate artifact locator mismatched", operationId); }
function decodeEligibilitySnapshot(value: unknown): ForgePrEligibility { decodeSourceSchema(sourceDomain, "ForgePrEligibility", value); return value as ForgePrEligibility; }
function reviewedDiffForPlan(diff: ReviewedDiffEvidence) { return { headOid: diff.headSha, baseOid: diff.baseSha, diffPatchSha256: diff.patchSha256, diffPatchLength: diff.patchSizeBytes, pathsDigest: diff.changedPathsSha256, mergeBaseOids: diff.mergeBaseShas, algorithm: diff.algorithmVersion, comparison: diff.comparison, contextLines: diff.contextLines }; }
function runtimeMethod(method: ForgePrEligibility["method"]): MergeCandidateMethod { return method === "fast-forward" ? "fast_forward" : method; }
function storeError(error: unknown, code: PrEligibilityError["code"], operationId?: string): PrEligibilityError { if (error instanceof PrEligibilityError) return error; if (error instanceof PrEligibilityStoreConflictError) return new PrEligibilityError(code, code === "stale" ? "eligibility persistence guard failed" : "eligibility persistence unavailable", operationId); return new PrEligibilityError("unavailable", "eligibility storage unavailable", operationId); }
function validateRuleRow(row: RuleRow): RuleRow { if (typeof row.id !== "string" || !Number.isSafeInteger(row.version) || row.version <= 0 || !Number.isSafeInteger(row.priority) || (row.enabled !== 0 && row.enabled !== 1) || typeof row.rules_json !== "string") throw new PrEligibilityError("unavailable", "rules row malformed"); JSON.parse(row.rules_json); return row; }
function iso(date: Date): string { return date.toISOString(); }
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], operationId: string): void { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new PrEligibilityError("unavailable", "candidate reviewed diff malformed", operationId); }
function stringField(value: unknown): string { if (typeof value !== "string") throw new PrEligibilityError("unavailable", "storage row malformed"); return value; }
function nullableString(value: unknown): string | null { if (value === null) return null; return stringField(value); }
function intField(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new PrEligibilityError("unavailable", "storage row malformed"); return value; }
function enumField<const T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T; throw new PrEligibilityError("unavailable", "storage row malformed"); }
