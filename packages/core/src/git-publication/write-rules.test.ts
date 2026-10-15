import { describe, expect, it } from "vitest";

import type { GitPublicationIntent } from "./index.js";
import { evaluateWriteRules, type ForgeRuleSet, type WriteRuleFacts } from "./write-rules.js";

const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const candidateSha = newSha;
const otherSha = "cccccccccccccccccccccccccccccccccccccccc";
const now = new Date("2026-10-08T00:00:00.000Z");

function intent(overrides: Partial<GitPublicationIntent> = {}): GitPublicationIntent {
  return { tenantId: "tenant-a", repositoryId: "repo-a", principalId: "principal-a", operationId: "repo.ref-update", idempotencyKey: "idem-rules", expectedVersion: 1, policyEpoch: 1, leaseFence: "lease-rules", atomic: true, eligibilityId: "elig-a", reason: "evaluate write rules", changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: newSha, force: false }], ...overrides };
}

function rule(overrides: Partial<ForgeRuleSet> = {}): ForgeRuleSet {
  return { id: "rule-a", name: "main", state: "active", target: "branch", include_patterns: ["refs/heads/main"], exclude_patterns: [], require_pull_request: true, required_approvals: 2, require_human_approval: true, dismiss_stale_reviews: true, require_latest_push_approval: true, require_code_owners: true, require_resolved_threads: true, require_linear_history: true, require_signed_commits: true, require_merge_queue: true, allow_force_push: false, allow_deletion: false, allowed_writer_group_ids: ["group-writers"], required_checks: [{ context: "test", producer_id: "ci", accepted_conclusions: ["success"], max_age_seconds: 3600 }], required_environment_ids: ["env-prod"], allowed_merge_methods: ["merge"], bypass: [], max_blob_size_bytes: 1024, forbidden_path_patterns: ["secrets/**"], mandatory: false, ...overrides };
}

function facts(overrides: Partial<WriteRuleFacts> = {}): WriteRuleFacts {
  return { refs: [{ ref: "refs/heads/main", oldSha, newSha, objectType: "commit", fastForward: true, changedPaths: ["src/app.ts"], maxBlobSizeBytes: 512, signatures: ["valid"], hasMergeCommit: false }], principal: { groupIds: ["group-writers"] }, pullRequest: { id: "pr-a", candidateSha, method: "merge", approvals: 2, humanApprovals: 1, latestPushApproved: true, codeOwnersApproved: true, threadsResolved: true, mergeQueueEntry: true, environmentIds: ["env-prod"], checks: [{ context: "test", producerId: "ci", conclusion: "success", observedAt: "2026-10-07T23:59:00.000Z", candidateSha, repositoryId: "repo-a" }], fresh: true }, ...overrides };
}

describe("live write rule evaluator", () => {
  it("allows a fully evidenced write satisfying every canonical rule field", () => {
    const decision = evaluateWriteRules({ intent: intent(), rulesets: [rule()], facts: facts(), now });

    expect(decision).toMatchObject({ allowed: true, blockers: [], matchedRuleIds: ["rule-a"] });
  });

  it("denies malformed and incomplete canonical rules instead of silently ignoring fields", () => {
    const missingMandatory = { ...rule() } as Record<string, unknown>;
    delete missingMandatory.mandatory;
    const unknownField = { ...rule(), admin_bypass: true };
    const malformedChecks = { ...rule(), id: "rule-bad-checks", required_checks: [{ context: "test", producer_id: "ci", accepted_conclusions: ["success"], max_age_seconds: 3600, leaked: "nope" }] };

    const decision = evaluateWriteRules({ intent: intent(), rulesets: [missingMandatory, unknownField, malformedChecks], facts: facts(), now });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers.map((blocker) => blocker.code)).toEqual(["ruleset_malformed", "ruleset_malformed", "ruleset_malformed"]);
    expect(decision.blockers.map((blocker) => blocker.detail).join("\n")).toContain("missing mandatory");
    expect(decision.blockers.map((blocker) => blocker.detail).join("\n")).toContain("unknown field admin_bypass");
    expect(decision.blockers.map((blocker) => blocker.detail).join("\n")).toContain("rule-bad-checks");
  });

  it("composes overlapping active rules conservatively and leaves evaluate rules nonblocking", () => {
    const second = rule({ id: "rule-b", required_approvals: 3, required_checks: [{ context: "lint", producer_id: "ci", accepted_conclusions: ["success"], max_age_seconds: null }], allowed_writer_group_ids: ["release-managers"] });
    const evaluate = rule({ id: "rule-eval", state: "evaluate", required_approvals: 4 });
    const decision = evaluateWriteRules({ intent: intent(), rulesets: [rule(), second, evaluate, rule({ id: "rule-disabled", state: "disabled", required_approvals: 20 })], facts: facts(), now });

    expect(decision.allowed).toBe(false);
    expect(decision.matchedRuleIds).toEqual(["rule-a", "rule-b"]);
    expect(decision.evaluatedRuleIds).toEqual(["rule-eval"]);
    expect(decision.blockers.map((blocker) => blocker.code)).toEqual(["writer_group_denied", "approval_count_denied", "required_check_missing"]);
    expect(decision.observations.map((observation) => observation.code)).toEqual(["evaluate:approval_count_denied"]);
  });

  it("requires current PR, review, check, environment, queue and method evidence for PR-gated branches", () => {
    const stale = facts({ pullRequest: { ...facts().pullRequest!, fresh: false, approvals: 0, humanApprovals: 0, latestPushApproved: false, codeOwnersApproved: false, threadsResolved: false, mergeQueueEntry: false, environmentIds: [], checks: [], method: "rebase" } });

    const decision = evaluateWriteRules({ intent: intent(), rulesets: [rule()], facts: stale, now });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(["pull_request_stale", "merge_method_denied", "approval_count_denied", "human_approval_denied", "stale_reviews_denied", "latest_push_approval_denied", "code_owner_denied", "threads_unresolved", "merge_queue_required", "environment_required", "required_check_missing"]));
  });

  it("binds pull request eligibility and check evidence to the exact pushed candidate", () => {
    const wrongCandidate = facts({ pullRequest: { ...facts().pullRequest!, candidateSha: otherSha, checks: [{ ...facts().pullRequest!.checks[0]!, candidateSha: otherSha }] } });
    const futureCheck = facts({ pullRequest: { ...facts().pullRequest!, checks: [{ ...facts().pullRequest!.checks[0]!, observedAt: "2026-10-09T00:00:00.000Z" }] } });

    const wrongCandidateDecision = evaluateWriteRules({ intent: intent(), rulesets: [rule()], facts: wrongCandidate, now });
    const futureCheckDecision = evaluateWriteRules({ intent: intent(), rulesets: [rule()], facts: futureCheck, now });

    expect(wrongCandidateDecision.allowed).toBe(false);
    expect(wrongCandidateDecision.blockers.map((blocker) => blocker.code)).toContain("pull_request_candidate_mismatch");
    expect(futureCheckDecision.allowed).toBe(false);
    expect(futureCheckDecision.blockers.map((blocker) => blocker.code)).toContain("required_check_missing");
  });

  it("denies force, delete, path, blob, signature and linear-history violations with explicit reasons", () => {
    const violatingFacts = facts({ refs: [{ ref: "refs/heads/main", oldSha, newSha: null, objectType: "none", fastForward: false, changedPaths: ["secrets/token.txt"], maxBlobSizeBytes: 4096, signatures: ["invalid"], hasMergeCommit: true }] });
    const deleteIntent = intent({ changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: null, force: true }] });

    const decision = evaluateWriteRules({ intent: deleteIntent, rulesets: [rule()], facts: violatingFacts, now });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(["deletion_denied", "force_push_denied", "linear_history_denied", "signed_commit_denied", "blob_size_denied", "forbidden_path_denied"]));
  });

  it("requires an explicit server-owned bypass request before bypassing nonmandatory rules", () => {
    const bypassRule = rule({ id: "repo-rule", required_approvals: 20, bypass: [{ subject_kind: "group", subject_id: "group-writers", mode: "always", expires_at: "2026-10-09T00:00:00.000Z" }] });
    const mandatoryRule = rule({ id: "tenant-rule", mandatory: true, required_approvals: 20, bypass: [{ subject_kind: "group", subject_id: "group-writers", mode: "always", expires_at: "2026-10-09T00:00:00.000Z" }] });

    const decision = evaluateWriteRules({ intent: intent(), rulesets: [bypassRule, mandatoryRule], facts: facts(), now });

    expect(decision.allowed).toBe(false);
    expect(decision.observations.map((observation) => observation.code)).not.toContain("bypassed:approval_count_denied");
    expect(decision.blockers).toMatchObject([{ code: "approval_count_denied", ruleId: "repo-rule" }, { code: "approval_count_denied", ruleId: "tenant-rule" }]);
  });


  it("matches refs with deterministic wildcard include and exclude semantics", () => {
    const releaseRef = "refs/heads/release/2026.10";
    const privateRef = "refs/heads/release/private/hotfix";
    const releaseRule = rule({ id: "release-rule", include_patterns: ["refs/heads/release/**"], exclude_patterns: ["refs/heads/release/private/**"] });

    const releaseDecision = evaluateWriteRules({ intent: intent({ changes: [{ ref: releaseRef, old_sha: oldSha, new_sha: newSha, force: false }] }), rulesets: [releaseRule], facts: facts({ refs: [{ ...facts().refs[0]!, ref: releaseRef }] }), now });
    const privateDecision = evaluateWriteRules({ intent: intent({ changes: [{ ref: privateRef, old_sha: oldSha, new_sha: newSha, force: false }] }), rulesets: [releaseRule], facts: facts({ refs: [{ ...facts().refs[0]!, ref: privateRef }] }), now });

    expect(releaseDecision.matchedRuleIds).toEqual(["release-rule"]);
    expect(privateDecision.allowed).toBe(true);
    expect(privateDecision.matchedRuleIds).toEqual([]);
  });

  it("matches path wildcards by Unicode code point and lets double-star span slash and newline", () => {
    const unicodePath = "docs/notes\n2026/secret-🧪.txt";
    const nestedPath = "src/nested/file.ts";
    const decision = evaluateWriteRules({
      intent: intent(),
      rulesets: [rule({ forbidden_path_patterns: ["docs/**/secret-?.txt", "src/*"] })],
      facts: facts({ refs: [{ ...facts().refs[0]!, changedPaths: [unicodePath, nestedPath] }] }),
      now
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers.filter((blocker) => blocker.code === "forbidden_path_denied")).toHaveLength(1);
    expect(decision.blockers.find((blocker) => blocker.code === "forbidden_path_denied")?.detail).toContain(unicodePath);
  });

  it("bounds malformed-rule diagnostics and rejects unsupported UTF-8 pattern strings", () => {
    const hugeId = "rule-" + "x".repeat(1000);
    const hugeField = "unknown_" + "y".repeat(1000);
    const unknown = { ...rule(), id: hugeId, [hugeField]: true };
    const unsupportedPattern = rule({ id: "bad-pattern", include_patterns: ["refs/heads/\ud800"] });

    const decision = evaluateWriteRules({ intent: intent(), rulesets: [unknown, unsupportedPattern], facts: facts(), now });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers.map((blocker) => blocker.code)).toEqual(["ruleset_malformed", "ruleset_malformed"]);
    expect(decision.blockers[0]!.detail.length).toBeLessThan(220);
    expect(decision.blockers[0]!.detail).not.toContain("x".repeat(128));
    expect(decision.blockers[0]!.detail).not.toContain("y".repeat(128));
    expect(decision.blockers[0]!.ruleId).toBeUndefined();
    expect(decision.blockers[1]!.detail).toContain("invalid pattern");
  });


  it("fails closed when wildcard matching exhausts bounded work", () => {
    const costlyPattern = "a*".repeat(511) + "b";
    const costlyPath = "a".repeat(5000);
    const decision = evaluateWriteRules({
      intent: intent(),
      rulesets: [rule({ forbidden_path_patterns: [costlyPattern] })],
      facts: facts({ refs: [{ ...facts().refs[0]!, changedPaths: [costlyPath] }] }),
      now
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers.map((blocker) => blocker.code)).toContain("rule_match_work_exhausted");
    expect(decision.blockers.map((blocker) => blocker.code)).not.toContain("forbidden_path_denied");
  });
});
