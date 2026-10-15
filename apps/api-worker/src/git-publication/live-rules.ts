import { Effect } from "effect";

import { PublicationDeniedError, PublicationProviderError, type GitPublicationIntent } from "../../../../packages/core/src/git-publication/index.js";
import { evaluateWriteRules, type PreparedRefFacts, type PullRequestRuleFacts, type WriteRuleFacts } from "../../../../packages/core/src/git-publication/write-rules.js";
import type { Clock, D1DatabaseLike, D1Result } from "../../../../packages/core/src/live/index.js";

export interface D1WriteRuleValidatorOptions { readonly clock?: Clock; readonly loadPreparedRefFacts: (intent: GitPublicationIntent) => Effect.Effect<readonly PreparedRefFacts[], PublicationDeniedError | PublicationProviderError> }

interface RuleSetRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly repository_id: string; readonly priority: number; readonly rules_json: string; readonly enabled: number }
interface GroupRow { readonly group_id: string }
interface EligibilityRow { readonly tenant_id: string; readonly id: string; readonly repository_id: string; readonly pull_request_id: string; readonly head_sha: string; readonly base_sha: string; readonly candidate_sha: string; readonly policy_epoch: number; readonly snapshot_json: string; readonly expires_at: string }
interface CurrentReviewRow { readonly id: string; readonly reviewer_id: string; readonly head_sha: string; readonly state: string; readonly updated_at: string; readonly created_at: string; readonly principal_active: number | null; readonly principal_kind: string | null }
interface ReviewEvidence { readonly id: string; readonly reviewerId: string; readonly eligible: boolean; readonly headSha: string; readonly diffDigest: string; readonly policyDigest: string }
interface QueueRow { readonly state: string }
interface PullRequestRow { readonly tenant_id: string; readonly id: string; readonly repository_id: string; readonly version: number; readonly head_sha: string; readonly base_sha: string; readonly target_ref: string; readonly draft: number; readonly merged_at: string | null; readonly closed_at: string | null; readonly merge_sha: string | null }

const capability = "repository.write" as const;
const systemClock: Clock = { now: () => new Date() };
const eligibilityFields = new Set(["tenant_id", "pull_request_id", "pr_version", "id", "status", "head_sha", "base_sha", "candidate_sha", "method", "diff_digest", "policy_digest", "policy_epoch", "expires_at", "blockers", "reviews", "checks"]);
const reviewFields = new Set(["review_id", "reviewer_id", "head_sha", "diff_digest", "policy_digest", "eligible", "reason"]);
const checkFields = new Set(["check_id", "producer_id", "context", "commit_sha", "generation", "satisfied"]);
const mergeMethods = new Set(["merge", "squash", "rebase", "fast-forward"]);
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

export function makeD1WriteRulesValidator(db: D1DatabaseLike, options: D1WriteRuleValidatorOptions): (intent: GitPublicationIntent) => Effect.Effect<void, PublicationDeniedError | PublicationProviderError> {
  const clock = options.clock ?? systemClock;
  return (intent) => Effect.gen(function* () {
    const now = yield* serverNow(clock);
    const [rulesets, groupIds, preparedRefs, pullRequest] = yield* Effect.all([
      readRuleSets(db, intent),
      readPrincipalGroups(db, intent),
      options.loadPreparedRefFacts(intent),
      readEligibility(db, intent, now)
    ], { concurrency: "unbounded" });
    const decision = evaluateWriteRules({ intent, rulesets, facts: { refs: preparedRefs, principal: { groupIds }, pullRequest } satisfies WriteRuleFacts, now });
    if (!decision.allowed) {
      const unsupported = decision.blockers.find((blocker) => blocker.code.includes("unavailable") || blocker.code.includes("missing") || blocker.code.includes("malformed"));
      if (unsupported) return yield* Effect.fail(new PublicationProviderError({ kind: "unsupported", detail: `live write rule evidence unavailable: ${unsupported.code}` }));
      return yield* Effect.fail(new PublicationDeniedError({ reason: decision.blockers[0]?.code ?? "write rule denied", tenantId: intent.tenantId, principalId: intent.principalId, capability }));
    }
  });
}

function readRuleSets(db: D1DatabaseLike, intent: GitPublicationIntent): Effect.Effect<readonly unknown[], PublicationProviderError> {
  return Effect.tryPromise({
    try: async () => {
      const rows = await db.prepare("SELECT tenant_id, id, version, repository_id, priority, rules_json, enabled FROM rulesets WHERE tenant_id = ? AND repository_id = ? AND enabled = 1 ORDER BY priority ASC, id ASC").bind(intent.tenantId, intent.repositoryId).all<RuleSetRow>();
      return successfulRows(rows).map((row) => {
        if (row.tenant_id !== intent.tenantId || row.repository_id !== intent.repositoryId || row.enabled !== 1 || !Number.isSafeInteger(row.version) || row.version < 1 || !Number.isSafeInteger(row.priority)) throw new Error("malformed ruleset row");
        return parseJson(row.rules_json);
      });
    },
    catch: () => unavailable("live write rulesets storage failed")
  });
}

function readPrincipalGroups(db: D1DatabaseLike, intent: GitPublicationIntent): Effect.Effect<readonly string[], PublicationProviderError> {
  return Effect.tryPromise({
    try: async () => {
      const rows = await db.prepare("SELECT gm.group_id AS group_id FROM group_memberships gm JOIN groups g ON g.tenant_id = gm.tenant_id AND g.id = gm.group_id JOIN connections c ON c.tenant_id = g.tenant_id AND c.id = g.connection_id JOIN principals p ON p.tenant_id = gm.tenant_id AND p.id = gm.principal_id WHERE gm.tenant_id = ? AND gm.principal_id = ? AND g.active = 1 AND c.active = 1 AND p.active = 1 ORDER BY gm.group_id ASC").bind(intent.tenantId, intent.principalId).all<GroupRow>();
      return successfulRows(rows).map((row) => row.group_id).filter((id) => typeof id === "string" && id.length > 0);
    },
    catch: () => unavailable("live write rule group membership storage failed")
  });
}

function readEligibility(db: D1DatabaseLike, intent: GitPublicationIntent, now: Date): Effect.Effect<PullRequestRuleFacts | null, PublicationDeniedError | PublicationProviderError> {
  if (intent.eligibilityId === null) return Effect.succeed(null);
  return Effect.tryPromise({
    try: async () => {
      const row = await db.prepare("SELECT tenant_id, id, repository_id, pull_request_id, head_sha, base_sha, candidate_sha, policy_epoch, snapshot_json, expires_at FROM eligibility WHERE tenant_id = ? AND repository_id = ? AND id = ? LIMIT 1").bind(intent.tenantId, intent.repositoryId, intent.eligibilityId).first<EligibilityRow>();
      if (!row || row.tenant_id !== intent.tenantId || row.repository_id !== intent.repositoryId) throw denied(intent, "pull request eligibility is missing");
      if (row.policy_epoch !== intent.policyEpoch) throw denied(intent, "pull request eligibility policy epoch is stale");
      if (intent.changes.some((change) => change.old_sha !== null && change.old_sha !== row.base_sha)) throw denied(intent, "pull request eligibility base is stale");

      if (intent.changes.some((change) => change.new_sha !== null && change.new_sha !== row.candidate_sha)) throw denied(intent, "pull request eligibility candidate is stale");
      const expires = Date.parse(row.expires_at);
      if (!Number.isFinite(expires) || expires <= now.getTime()) throw denied(intent, "pull request eligibility is expired");
      const snapshot = parseJson(row.snapshot_json);
      if (!record(snapshot)) throw new Error("malformed eligibility snapshot");
      const pr = await db.prepare("SELECT tenant_id, id, repository_id, version, head_sha, base_sha, target_ref, draft, merged_at, closed_at, merge_sha FROM pull_requests WHERE tenant_id = ? AND repository_id = ? AND id = ? LIMIT 1").bind(intent.tenantId, intent.repositoryId, row.pull_request_id).first<PullRequestRow>();
      if (!pr || pr.tenant_id !== row.tenant_id || pr.repository_id !== row.repository_id || pr.id !== row.pull_request_id || pr.draft !== 0 || pr.closed_at !== null || pr.merged_at !== null || pr.merge_sha !== null) throw denied(intent, "pull request is not open for publication");
      if (pr.head_sha !== row.head_sha || pr.base_sha !== row.base_sha || pr.version !== integerField(snapshot.pr_version)) throw denied(intent, "pull request eligibility revision is stale");
      if (intent.changes.length !== 1 || intent.changes[0]?.ref !== pr.target_ref || intent.changes[0]?.old_sha !== pr.base_sha || intent.changes[0]?.new_sha !== row.candidate_sha) throw denied(intent, "pull request publication target is stale");
      const queueRow = await db.prepare("SELECT state FROM merge_queue WHERE tenant_id = ? AND repository_id = ? AND pull_request_id = ? AND eligibility_id = ? ORDER BY position ASC LIMIT 1").bind(intent.tenantId, intent.repositoryId, row.pull_request_id, intent.eligibilityId).first<QueueRow>();
      const reviewRows = await db.prepare("SELECT r.id, r.reviewer_id, r.head_sha, r.state, r.updated_at, r.created_at, p.active AS principal_active, p.kind AS principal_kind FROM reviews r LEFT JOIN principals p ON p.tenant_id = r.tenant_id AND p.id = r.reviewer_id WHERE r.tenant_id = ? AND r.repository_id = ? AND r.pull_request_id = ? ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC LIMIT 10001").bind(intent.tenantId, intent.repositoryId, row.pull_request_id).all<CurrentReviewRow>();
      const currentReviews = successfulRows(reviewRows);
      if (currentReviews.length > 10000) throw new Error("review evidence bound exceeded");
      return snapshotToPullRequestFacts(row, snapshot, currentReviews, queueRow?.state === "queued" || queueRow?.state === "ready" || queueRow?.state === "running", now, intent);
    },
    catch: (error) => isDenied(error) ? error : unavailable("live write eligibility storage failed")
  });
}

function snapshotToPullRequestFacts(row: EligibilityRow, snapshot: Record<string, unknown>, currentReviews: readonly CurrentReviewRow[], queued: boolean, now: Date, intent: GitPublicationIntent): PullRequestRuleFacts {
  assertOnlyFields(snapshot, eligibilityFields);
  const expiresAt = timestampField(snapshot.expires_at);
  if (expiresAt <= now.getTime()) throw new Error("expired eligibility snapshot");
  if (stringField(snapshot.tenant_id) !== row.tenant_id || stringField(snapshot.id) !== row.id || stringField(snapshot.pull_request_id) !== row.pull_request_id) throw new Error("eligibility identity mismatch");
  if (stringField(snapshot.head_sha) !== row.head_sha || stringField(snapshot.base_sha) !== row.base_sha || stringField(snapshot.candidate_sha) !== row.candidate_sha) throw new Error("eligibility git mismatch");
  if (integerField(snapshot.policy_epoch) !== row.policy_epoch) throw new Error("eligibility policy mismatch");
  if (stringField(snapshot.expires_at) !== row.expires_at) throw new Error("eligibility expiry mismatch");
  const status = enumString(snapshot.status, ["computing", "eligible", "blocked", "expired", "reconciling"]);
  const method = enumString(snapshot.method, Array.from(mergeMethods)) as PullRequestRuleFacts["method"];
  const diffDigest = digestField(snapshot.diff_digest);
  const policyDigest = digestField(snapshot.policy_digest);
  if (integerField(snapshot.pr_version) < 1) throw new Error("malformed PR version");
  const blockers = array(snapshot.blockers);
  const reviews = array(snapshot.reviews).map(parseReview);
  array(snapshot.checks).forEach(parseCheckEvidence);
  const latest = new Map<string, CurrentReviewRow>();
  for (const review of currentReviews) {
    const updated = timestampField(review.updated_at);
    const created = timestampField(review.created_at);
    if (updated > now.getTime() || created > updated) throw new Error("malformed current review timestamp");
    if (!["approved", "changes_requested", "dismissed"].includes(review.state)) continue;
    const prior = latest.get(review.reviewer_id);
    if (!prior || updated > timestampField(prior.updated_at)) latest.set(review.reviewer_id, review);
    else if (updated === timestampField(prior.updated_at) && (prior.state !== review.state || prior.head_sha !== review.head_sha)) throw denied(intent, "review decision ordering is ambiguous");
  }
  if ([...latest.values()].some((review) => review.principal_active === 1 && review.state === "changes_requested" && review.head_sha === row.head_sha)) throw denied(intent, "changes_requested");
  const approved = new Map<string, CurrentReviewRow>();
  for (const review of reviews) {
    const current = latest.get(review.reviewerId);
    if (review.eligible && review.headSha === row.head_sha && review.diffDigest === diffDigest && review.policyDigest === policyDigest &&
        current?.id === review.id && current.head_sha === row.head_sha && current.state === "approved" && current.principal_active === 1 &&
        (current.principal_kind === "human" || current.principal_kind === "service")) approved.set(review.reviewerId, current);
  }
  const fresh = status === "eligible" && blockers.length === 0 && row.candidate_sha === stringField(snapshot.candidate_sha) && row.head_sha === stringField(snapshot.head_sha) && row.base_sha === stringField(snapshot.base_sha);

  return {
    id: row.pull_request_id,
    candidateSha: row.candidate_sha,
    method,
    approvals: approved.size,
    humanApprovals: [...approved.values()].filter((review) => review.principal_kind === "human").length,
    latestPushApproved: null,
    codeOwnersApproved: null,
    threadsResolved: null,
    mergeQueueEntry: queued,
    environmentIds: [],
    checks: [],
    fresh
  };
}

function parseReview(value: unknown): ReviewEvidence {
  if (!record(value)) throw new Error("malformed review");
  assertOnlyFields(value, reviewFields);
  if (value.reason !== null) stringField(value.reason);
  return { id: stringField(value.review_id), reviewerId: stringField(value.reviewer_id), eligible: booleanField(value.eligible), headSha: shaField(value.head_sha), diffDigest: digestField(value.diff_digest), policyDigest: digestField(value.policy_digest) };
}

function parseCheckEvidence(value: unknown): void {
  if (!record(value)) throw new Error("malformed check");
  assertOnlyFields(value, checkFields);
  stringField(value.check_id); stringField(value.producer_id); stringField(value.context);
  shaField(value.commit_sha); booleanField(value.satisfied);
  if (integerField(value.generation) < 1) throw new Error("malformed check generation");
}

function serverNow(clock: Clock): Effect.Effect<Date, PublicationProviderError> {
  return Effect.try({ try: () => { const now = clock.now(); if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("invalid clock"); return now; }, catch: () => unavailable("live write rule clock is unavailable") });
}

function successfulRows<T>(result: D1Result<T>): readonly T[] { if (result.success !== true || !Array.isArray(result.results)) throw new Error("failed or malformed query result"); return result.results; }
function parseJson(text: string): unknown { try { return JSON.parse(text) as unknown; } catch { throw new Error("malformed json"); } }
function unavailable(detail: string): PublicationProviderError { return new PublicationProviderError({ kind: "unreachable", detail }); }
function denied(intent: GitPublicationIntent, reason: string): PublicationDeniedError { return new PublicationDeniedError({ reason, tenantId: intent.tenantId, principalId: intent.principalId, capability }); }
function isDenied(error: unknown): error is PublicationDeniedError { return typeof error === "object" && error !== null && "_tag" in error && (error as { readonly _tag?: unknown })._tag === "PublicationDeniedError"; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function assertOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error("malformed object field"); for (const key of allowed) if (!Object.hasOwn(value, key)) throw new Error("missing object field"); }
function array(value: unknown): readonly unknown[] { if (!Array.isArray(value) || value.length > 10000) throw new Error("malformed array"); return value; }
function stringField(value: unknown): string { if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error("malformed string"); return value; }
function enumString(value: unknown, allowed: readonly string[]): string { const text = stringField(value); if (!allowed.includes(text)) throw new Error("malformed enum"); return text; }
function shaField(value: unknown): string { const text = stringField(value); if (!shaPattern.test(text)) throw new Error("malformed sha"); return text; }
function timestampField(value: unknown): number { const parsed = Date.parse(stringField(value)); if (!Number.isFinite(parsed)) throw new Error("malformed timestamp"); return parsed; }
function booleanField(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("malformed boolean"); return value; }
function integerField(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("malformed integer"); return value; }
function digestField(value: unknown): string { const text = stringField(value); if (!digestPattern.test(text)) throw new Error("malformed digest"); return text; }
