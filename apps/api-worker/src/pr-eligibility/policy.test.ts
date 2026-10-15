import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ForgeMergeMethod, ForgeRuleSet } from "../../../../packages/core/src/git-publication/write-rules.js";
import { EligibilityPolicyError, buildCandidateCheckPlan, deriveEligibilityPolicy, writerSatisfiesEligibilityPolicy } from "./policy.js";

const textDecoder = new TextDecoder();

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function rule(overrides: Partial<ForgeRuleSet> = {}): ForgeRuleSet {
  return {
    id: "rule-a",
    name: "main",
    state: "active",
    target: "branch",
    include_patterns: ["refs/heads/main"],
    exclude_patterns: [],
    require_pull_request: true,
    required_approvals: 1,
    require_human_approval: false,
    dismiss_stale_reviews: false,
    require_latest_push_approval: false,
    require_code_owners: false,
    require_resolved_threads: false,
    require_linear_history: false,
    require_signed_commits: false,
    require_merge_queue: false,
    allow_force_push: true,
    allow_deletion: true,
    allowed_writer_group_ids: [],
    required_checks: [],
    required_environment_ids: [],
    allowed_merge_methods: ["merge", "squash", "rebase", "fast-forward"],
    bypass: [],
    max_blob_size_bytes: null,
    forbidden_path_patterns: [],
    mandatory: false,
    ...overrides
  };
}

function row(overrides: { readonly id?: string; readonly version?: number; readonly priority?: number; readonly enabled?: boolean; readonly rules?: unknown } = {}) {
  return { id: overrides.id ?? "row-a", version: overrides.version ?? 1, priority: overrides.priority ?? 10, enabled: overrides.enabled ?? true, rules: overrides.rules ?? rule() };
}

async function derive(rows: readonly ReturnType<typeof row>[], overrides: Partial<Parameters<typeof deriveEligibilityPolicy>[0]> = {}) {
  return deriveEligibilityPolicy({ tenantId: "tenant-a", repositoryId: "repo-a", targetRef: "refs/heads/main", policyEpoch: 7, rows, ...overrides });
}

function candidatePlanInput(overrides: Partial<Parameters<typeof buildCandidateCheckPlan>[0]> = {}): Parameters<typeof buildCandidateCheckPlan>[0] {
  return {
    tenantId: "tenant-a",
    sourceRepositoryId: "repo-source",
    targetRepositoryId: "repo-target",
    pullRequestId: "pr-123",
    pullRequestVersion: 4,
    headOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    candidateOid: "cccccccccccccccccccccccccccccccccccccccc",
    candidateTreeOid: "dddddddddddddddddddddddddddddddddddddddd",
    reviewedDiff: { headOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", baseOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", diffPatchSha256: "1".repeat(64), diffPatchLength: 1234, pathsDigest: "2".repeat(64), mergeBaseOids: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], algorithm: "git-cli-unified-v1", comparison: "three_dot", contextLines: 3 },
    mergeMethod: "squash",
    mergeOptions: { commitTitle: "Ship", trailers: ["Reviewed-by: qa"] },
    policyDigest: "e".repeat(64),
    requiredChecks: [{ context: "unit", producer_id: "ci", accepted_conclusions: ["success"], max_age_seconds: 300 }],
    ...overrides
  };
}

describe("PR eligibility policy identity", () => {
  it("emits literal canonical policy bytes with the declared frame and digest", async () => {
    const result = await derive([]);
    const expected = "{\"frame\":\"gitfoundry.pr-eligibility.policy.v1\",\"payload\":{\"activeRuleIds\":[],\"disabledRuleIds\":[],\"enforcement\":{\"allowDeletion\":true,\"allowForcePush\":true,\"allowedMergeMethods\":[\"merge\",\"squash\",\"rebase\",\"fast-forward\"],\"allowedWriterGroupClauses\":[],\"dismissStaleReviews\":false,\"forbiddenPathPatterns\":[],\"maxBlobSizeBytes\":null,\"requireCodeOwners\":false,\"requireHumanApproval\":false,\"requireLatestPushApproval\":false,\"requireLinearHistory\":false,\"requireMergeQueue\":false,\"requirePullRequest\":false,\"requireResolvedThreads\":false,\"requireSignedCommits\":false,\"requiredApprovals\":0,\"requiredChecks\":[],\"requiredEnvironmentIds\":[]},\"evaluateRuleIds\":[],\"identityRules\":[],\"policyEpoch\":7,\"repositoryId\":\"repo-a\",\"targetRef\":\"refs/heads/main\",\"tenantId\":\"tenant-a\"}}";

    expect(textDecoder.decode(result.canonicalBytes)).toBe(expected);
    const expectedBytes = new TextEncoder().encode(expected);
    expect(result.policyDigest).toBe(sha256Hex(expectedBytes));
  });

  it("orders equal-priority rows by UTF-8 bytes without localeCompare and accepts signed SQL priority", async () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => { throw new Error("localeCompare must not order policy rows"); });
    try {
      const result = await derive([
        row({ id: "é", priority: -1, rules: rule({ id: "rule-nfc" }) }),
        row({ id: "e\u0301", priority: -1, rules: rule({ id: "rule-nfd" }) })
      ]);

      expect(result.policy.identityRules.map((identity) => identity.rowId)).toEqual(["e\u0301", "é"]);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("keeps canonical bytes stable across reordered object keys and preserves original strings", async () => {
    const normal = rule({ id: "unicode", name: "Cafe\u0301", include_patterns: ["refs/heads/main"] });
    const reordered = JSON.parse(`{"mandatory":false,"forbidden_path_patterns":[],"max_blob_size_bytes":null,"bypass":[],"allowed_merge_methods":["merge","squash","rebase","fast-forward"],"required_environment_ids":[],"required_checks":[],"allowed_writer_group_ids":[],"allow_deletion":true,"allow_force_push":true,"require_merge_queue":false,"require_signed_commits":false,"require_linear_history":false,"require_resolved_threads":false,"require_code_owners":false,"require_latest_push_approval":false,"dismiss_stale_reviews":false,"require_human_approval":false,"required_approvals":1,"require_pull_request":true,"exclude_patterns":[],"include_patterns":["refs/heads/main"],"target":"branch","state":"active","name":"Cafe\\u0301","id":"unicode"}`) as ForgeRuleSet;
    const composed = rule({ id: "unicode", name: "Café", include_patterns: ["refs/heads/main"] });

    const a = await derive([row({ id: "row-u", rules: normal })]);
    const b = await derive([row({ id: "row-u", rules: reordered })]);
    const c = await derive([row({ id: "row-u", rules: composed })]);

    expect(a.policyDigest).toBe(b.policyDigest);
    expect(a.policy.identityRules[0]?.rule.name).toBe("Cafe\u0301");
    expect(a.policyDigest).not.toBe(c.policyDigest);
  });

  it("preserves matched writer groups as ANDed OR clauses", async () => {
    const result = await derive([
      row({ id: "row-a", priority: 1, rules: rule({ id: "rule-a", allowed_writer_group_ids: ["writer-a", "writer-shared"] }) }),
      row({ id: "row-open", priority: 2, rules: rule({ id: "rule-open", allowed_writer_group_ids: [] }) }),
      row({ id: "row-b", priority: 3, rules: rule({ id: "rule-b", allowed_writer_group_ids: ["writer-b"] }) })
    ]);

    expect(result.policy.enforcement.allowedWriterGroupClauses).toEqual([["writer-a", "writer-shared"], ["writer-b"]]);
    expect(writerSatisfiesEligibilityPolicy(result.policy, ["writer-a"])).toBe(false);
    expect(writerSatisfiesEligibilityPolicy(result.policy, ["writer-a", "writer-b"])).toBe(true);
    expect(writerSatisfiesEligibilityPolicy(result.policy, ["writer-shared", "writer-b"])).toBe(true);
  });

  it("enforces active matches, observes evaluate matches, and keeps disabled identities non-enforcing", async () => {
    const result = await derive([
      row({ id: "active-row", priority: 1, rules: rule({ id: "active-rule", required_approvals: 2 }) }),
      row({ id: "evaluate-row", priority: 2, rules: rule({ id: "evaluate-rule", state: "evaluate", required_approvals: 20 }) }),
      row({ id: "disabled-rule-row", priority: 3, rules: rule({ id: "disabled-rule", state: "disabled", required_approvals: 20 }) }),
      row({ id: "disabled-row", priority: 4, enabled: false, rules: rule({ id: "disabled-row-rule", required_approvals: 20 }) })
    ]);

    expect(result.policy.activeRuleIds).toEqual(["active-rule"]);
    expect(result.policy.evaluateRuleIds).toEqual(["evaluate-rule"]);
    expect(result.policy.disabledRuleIds).toEqual(["disabled-rule", "disabled-row-rule"]);
    expect(result.policy.enforcement.requiredApprovals).toBe(2);
    expect(result.policy.identityRules.map((identity) => [identity.rowId, identity.rowEnabled, identity.rule.id])).toEqual([
      ["active-row", true, "active-rule"],
      ["evaluate-row", true, "evaluate-rule"],
      ["disabled-rule-row", true, "disabled-rule"],
      ["disabled-row", false, "disabled-row-rule"]
    ]);
  });

  it("changes identity and removes enforcement when an authoritative row is disabled", async () => {
    const active = await derive([row({ rules: rule({ required_approvals: 4, require_code_owners: true }) })]);
    const disabled = await derive([row({ enabled: false, rules: rule({ required_approvals: 4, require_code_owners: true }) })]);

    expect(active.policyDigest).not.toBe(disabled.policyDigest);
    expect(active.policy.enforcement.requiredApprovals).toBe(4);
    expect(disabled.policy.enforcement.requiredApprovals).toBe(0);
    expect(disabled.policy.identityRules[0]?.rowEnabled).toBe(false);
  });

  it("combines required checks by context and producer with intersection and minimum max age", async () => {
    const result = await derive([
      row({ id: "row-a", priority: 1, rules: rule({ id: "rule-a", required_checks: [{ context: "unit", producer_id: "ci", accepted_conclusions: ["success", "neutral"], max_age_seconds: 3600 }] }) }),
      row({ id: "row-b", priority: 2, rules: rule({ id: "rule-b", required_checks: [{ context: "unit", producer_id: "ci", accepted_conclusions: ["success", "skipped"], max_age_seconds: 60 }, { context: "lint", producer_id: "bot", accepted_conclusions: ["neutral"], max_age_seconds: null }] }) })
    ]);

    expect(result.policy.enforcement.requiredChecks).toEqual([
      { context: "unit", producer_id: "ci", accepted_conclusions: ["success"], max_age_seconds: 60 },
      { context: "lint", producer_id: "bot", accepted_conclusions: ["neutral"], max_age_seconds: null }
    ]);
  });

  it("fails closed for contradictory required-check conclusions", async () => {
    await expect(derive([
      row({ id: "row-a", priority: 1, rules: rule({ id: "rule-a", required_checks: [{ context: "unit", producer_id: "ci", accepted_conclusions: ["success"], max_age_seconds: 3600 }] }) }),
      row({ id: "row-b", priority: 2, rules: rule({ id: "rule-b", required_checks: [{ context: "unit", producer_id: "ci", accepted_conclusions: ["neutral"], max_age_seconds: 60 }] }) })
    ])).rejects.toThrow(EligibilityPolicyError);
  });

  it("intersects merge methods, takes maximum approvals, and preserves prohibitions", async () => {
    const result = await derive([
      row({ id: "row-a", priority: 1, rules: rule({ id: "rule-a", allowed_merge_methods: ["merge", "squash"], required_approvals: 2, allow_force_push: true, allow_deletion: false, require_signed_commits: true, max_blob_size_bytes: 4096 }) }),
      row({ id: "row-b", priority: 2, rules: rule({ id: "rule-b", allowed_merge_methods: ["squash", "rebase"], required_approvals: 5, allow_force_push: false, allow_deletion: true, require_linear_history: true, forbidden_path_patterns: ["secrets/**"], max_blob_size_bytes: 1024 }) })
    ]);

    expect(result.policy.enforcement.allowedMergeMethods).toEqual(["squash"]);
    expect(result.policy.enforcement.requiredApprovals).toBe(5);
    expect(result.policy.enforcement.allowForcePush).toBe(false);
    expect(result.policy.enforcement.allowDeletion).toBe(false);
    expect(result.policy.enforcement.requireSignedCommits).toBe(true);
    expect(result.policy.enforcement.requireLinearHistory).toBe(true);
    expect(result.policy.enforcement.maxBlobSizeBytes).toBe(1024);
    expect(result.policy.enforcement.forbiddenPathPatterns).toEqual(["secrets/**"]);
  });

  it("rejects malformed rows, duplicate identities, malformed rules, and empty merge intersections", async () => {
    await expect(derive([{ ...row(), extra: true } as never])).rejects.toThrow(EligibilityPolicyError);
    for (const version of [0, -1]) await expect(derive([row({ version })])).rejects.toThrow(/row.version/);
    await expect(derive([row({ id: "dup" }), row({ id: "dup", version: 2 })])).rejects.toThrow(/duplicate/i);
    await expect(derive([row({ rules: { ...rule(), unexpected: true } })])).rejects.toThrow(/malformed/i);
    await expect(derive([
      row({ id: "row-a", priority: 1, rules: rule({ id: "rule-a", allowed_merge_methods: ["merge"] }) }),
      row({ id: "row-b", priority: 2, rules: rule({ id: "rule-b", allowed_merge_methods: ["squash"] }) })
    ])).rejects.toThrow(/merge methods/i);
  });

  it("parses disabled records for identity without spending matcher budget", async () => {
    const targetRef = `refs/heads/${"a".repeat(3000)}`;
    const costlyPattern = `refs/heads/${"a*".repeat(506)}b`;
    const result = await derive([
      row({ id: "disabled-row", priority: 1, rules: rule({ id: "disabled-costly", state: "disabled", include_patterns: [costlyPattern] }) }),
      row({ id: "inactive-row", priority: 2, enabled: false, rules: rule({ id: "inactive-costly", include_patterns: [costlyPattern] }) }),
      row({ id: "active-row", priority: 3, rules: rule({ id: "active", include_patterns: ["refs/heads/**"], required_approvals: 2 }) })
    ], { targetRef });

    expect(result.policy.activeRuleIds).toEqual(["active"]);
    expect(result.policy.disabledRuleIds).toEqual(["disabled-costly", "inactive-costly"]);
    expect(result.policy.enforcement.requiredApprovals).toBe(2);
  });

  it("uses the existing bounded matcher for matching active and evaluate rules", async () => {
    const result = await derive([
      row({ id: "row-release", priority: 1, rules: rule({ id: "release", include_patterns: ["refs/heads/release/**"], exclude_patterns: ["refs/heads/release/private/**"], required_approvals: 9 }) }),
      row({ id: "row-private", priority: 2, rules: rule({ id: "private", include_patterns: ["refs/heads/release/private/**"], required_approvals: 3 }) })
    ], { targetRef: "refs/heads/release/private/hotfix" });

    expect(result.policy.activeRuleIds).toEqual(["private"]);
    expect(result.policy.enforcement.requiredApprovals).toBe(3);
  });
});

describe("candidate check plan identity", () => {
  it("emits literal canonical plan bytes and digest", async () => {
    const result = await buildCandidateCheckPlan(candidatePlanInput({ mergeOptions: null, requiredChecks: [] }));
    const expected = "{\"frame\":\"gitfoundry.pr-eligibility.candidate-check-plan.v1\",\"payload\":{\"baseOid\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"candidateOid\":\"cccccccccccccccccccccccccccccccccccccccc\",\"candidateTreeOid\":\"dddddddddddddddddddddddddddddddddddddddd\",\"headOid\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"mergeMethod\":\"squash\",\"mergeOptions\":null,\"policyDigest\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\"pullRequestId\":\"pr-123\",\"pullRequestVersion\":4,\"requiredChecks\":[],\"reviewedDiff\":{\"algorithm\":\"git-cli-unified-v1\",\"baseOid\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"comparison\":\"three_dot\",\"contextLines\":3,\"diffPatchLength\":1234,\"diffPatchSha256\":\"1111111111111111111111111111111111111111111111111111111111111111\",\"headOid\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"mergeBaseOids\":[\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"],\"pathsDigest\":\"2222222222222222222222222222222222222222222222222222222222222222\"},\"sourceRepositoryId\":\"repo-source\",\"targetRepositoryId\":\"repo-target\",\"tenantId\":\"tenant-a\"}}";

    expect(textDecoder.decode(result.canonicalBytes)).toBe(expected);
    const expectedBytes = new TextEncoder().encode(expected);
    expect(result.planDigest).toBe(sha256Hex(expectedBytes));
    expect(Object.keys(result.plan)).not.toContain("proof");
  });

  it("binds every plan field and every trusted check requirement dimension", async () => {
    const base = await buildCandidateCheckPlan(candidatePlanInput());
    const changes: Array<[string, Partial<Parameters<typeof buildCandidateCheckPlan>[0]>]> = [
      ["tenant", { tenantId: "tenant-b" }],
      ["source repository", { sourceRepositoryId: "repo-source-b" }],
      ["target repository", { targetRepositoryId: "repo-target-b" }],
      ["PR id", { pullRequestId: "pr-456" }],
      ["PR version", { pullRequestVersion: 5 }],
      ["head", { headOid: "1111111111111111111111111111111111111111", reviewedDiff: { ...candidatePlanInput().reviewedDiff, headOid: "1111111111111111111111111111111111111111" } }],
      ["base", { baseOid: "2222222222222222222222222222222222222222", reviewedDiff: { ...candidatePlanInput().reviewedDiff, baseOid: "2222222222222222222222222222222222222222" } }],
      ["candidate", { candidateOid: "3333333333333333333333333333333333333333" }],
      ["tree", { candidateTreeOid: "4444444444444444444444444444444444444444" }],
      ["reviewed diff patch", { reviewedDiff: { ...candidatePlanInput().reviewedDiff, diffPatchSha256: "5".repeat(64) } }],
      ["reviewed diff length", { reviewedDiff: { ...candidatePlanInput().reviewedDiff, diffPatchLength: 4321 } }],
      ["reviewed diff paths", { reviewedDiff: { ...candidatePlanInput().reviewedDiff, pathsDigest: "6".repeat(64) } }],
      ["reviewed diff merge bases", { reviewedDiff: { ...candidatePlanInput().reviewedDiff, mergeBaseOids: ["7777777777777777777777777777777777777777"] } }],
      ["method", { mergeMethod: "merge" as ForgeMergeMethod }],
      ["options", { mergeOptions: { commitTitle: "Different" } }],
      ["policy", { policyDigest: "f".repeat(64) }],
      ["check context", { requiredChecks: [{ context: "integration", producer_id: "ci", accepted_conclusions: ["success"], max_age_seconds: 300 }] }],
      ["check producer", { requiredChecks: [{ context: "unit", producer_id: "ci-2", accepted_conclusions: ["success"], max_age_seconds: 300 }] }],
      ["check conclusions", { requiredChecks: [{ context: "unit", producer_id: "ci", accepted_conclusions: ["neutral"], max_age_seconds: 300 }] }],
      ["check age", { requiredChecks: [{ context: "unit", producer_id: "ci", accepted_conclusions: ["success"], max_age_seconds: null }] }]
    ];

    for (const [, patch] of changes) {
      const next = await buildCandidateCheckPlan(candidatePlanInput(patch));
      expect(next.planDigest).not.toBe(base.planDigest);
    }
  });

  it("rejects malformed candidate plan identities", async () => {
    await expect(buildCandidateCheckPlan(candidatePlanInput({ candidateOid: "not-a-sha" }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ policyDigest: "short" }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ pullRequestVersion: 0 }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ reviewedDiff: { ...candidatePlanInput().reviewedDiff, headOid: "9999999999999999999999999999999999999999" } }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ reviewedDiff: { ...candidatePlanInput().reviewedDiff, algorithm: "git-diff-tree-v2" } as never }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ reviewedDiff: { ...candidatePlanInput().reviewedDiff, comparison: "two_dot" } as never }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ reviewedDiff: { ...candidatePlanInput().reviewedDiff, contextLines: 4 } as never }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ reviewedDiff: { ...candidatePlanInput().reviewedDiff, mergeBaseOids: [] } }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ reviewedDiff: { ...candidatePlanInput().reviewedDiff, diffPatchLength: 1024 * 1024 + 1 } }))).rejects.toThrow(EligibilityPolicyError);
  });

  it("rejects unbounded or non-plain merge options before canonical plan encoding", async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const deep = Array.from({ length: 40 }).reduce<unknown>((inner) => [inner], "leaf");

    await expect(buildCandidateCheckPlan(candidatePlanInput({ mergeOptions: new Date("2026-10-09T00:00:00Z") as never }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ mergeOptions: cycle as never }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ mergeOptions: deep as never }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ mergeOptions: { value: Number.MAX_SAFE_INTEGER + 1 } as never }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ mergeOptions: { title: "bad\ud800" } as never }))).rejects.toThrow(EligibilityPolicyError);
    await expect(buildCandidateCheckPlan(candidatePlanInput({ mergeOptions: { body: "x".repeat(1024 * 1024) } }))).rejects.toThrow(EligibilityPolicyError);
  });
});
