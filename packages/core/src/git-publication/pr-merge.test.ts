import { describe, expect, it } from "vitest";

import { PrMergePublicationAdmissionError, buildPrMergePublicationIntent } from "./pr-merge.js";

const baseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const candidateSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function input(overrides: Partial<Parameters<typeof buildPrMergePublicationIntent>[0]> = {}): Parameters<typeof buildPrMergePublicationIntent>[0] {
  return {
    tenantId: "tenant-a",
    repositoryId: "repo-a",
    principalId: "actor-a",
    pullRequestId: "pr-a",
    eligibilityOperationId: "pr-eligibility-a-g2",
    eligibilityGeneration: 2,
    targetRef: "refs/heads/main",
    baseSha,
    candidateSha,
    expectedRepositoryVersion: 9,
    policyEpoch: 7,
    authorityFence: "pr-eligibility-a-g2:repo-a:refs/heads/main:2",
    userIdempotencyKey: "merge-button-request-a",
    reason: "merge exact checked candidate",
    ...overrides
  };
}

describe("PR merge publication causal mapping", () => {
  it("maps one checked candidate to one atomic repo.ref-update intent", () => {
    const intent = buildPrMergePublicationIntent(input());

    expect(intent).toMatchObject({
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      principalId: "actor-a",
      operationId: "repo.ref-update",
      expectedVersion: 9,
      policyEpoch: 7,
      leaseFence: "pr-eligibility-a-g2:repo-a:refs/heads/main:2",
      atomic: true,
      eligibilityId: "pr-eligibility-a-g2",
      reason: "merge exact checked candidate",
      changes: [{ ref: "refs/heads/main", old_sha: baseSha, new_sha: candidateSha, force: false }]
    });
    expect(intent.idempotencyKey).toMatch(/^pr-merge:[0-9a-f]{64}$/u);
  });

  it("preserves exact checked candidate mapping when C already equals B", () => {
    const intent = buildPrMergePublicationIntent(input({ candidateSha: baseSha }));

    expect(intent.changes).toEqual([{ ref: "refs/heads/main", old_sha: baseSha, new_sha: baseSha, force: false }]);
  });

  it("binds idempotency to PR, eligibility generation, B, C and caller key", () => {
    const first = buildPrMergePublicationIntent(input());
    const replay = buildPrMergePublicationIntent(input());
    const variants = [
      buildPrMergePublicationIntent(input({ pullRequestId: "pr-b" })),
      buildPrMergePublicationIntent(input({ eligibilityGeneration: 3 })),
      buildPrMergePublicationIntent(input({ baseSha: "c".repeat(40) })),
      buildPrMergePublicationIntent(input({ candidateSha: "d".repeat(40) })),
      buildPrMergePublicationIntent(input({ userIdempotencyKey: "merge-button-request-b" }))
    ];

    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
    for (const variant of variants) expect(variant.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("rejects malformed causal merge evidence instead of inventing a publication", () => {
    expect(() => buildPrMergePublicationIntent(input({ targetRef: "refs/heads/../main" }))).toThrow(PrMergePublicationAdmissionError);
    expect(() => buildPrMergePublicationIntent(input({ targetRef: "refs/heads/.hidden" }))).toThrow(PrMergePublicationAdmissionError);
    expect(() => buildPrMergePublicationIntent(input({ targetRef: "refs/heads/release.lock" }))).toThrow(PrMergePublicationAdmissionError);
    expect(() => buildPrMergePublicationIntent(input({ candidateSha: "0".repeat(40) }))).toThrow(/candidateSha/i);
    expect(() => buildPrMergePublicationIntent(input({ eligibilityGeneration: 0 }))).toThrow(/generation/i);
  });
});
