import { describe, expect, it } from "vitest";
import type { ForgeGitPort, ForgeVersion } from "@gitfoundry/core";

import {
  canonicalPublicationEvidencePayload,
  publicationEvidenceSchemaVersion,
  publicationPolicyPath,
  verifyPublicationEvidence,
  type PublicationCheckEvidenceRecord,
  type PublicationEvidencePolicy,
  type PublicationEvidenceRecord,
  type PublicationReviewEvidenceRecord
} from "./evidence.js";

const expectedCode = "1".repeat(40);
const expectedState = "2".repeat(40);
const candidateCode = "3".repeat(40);
const candidateState = "4".repeat(40);
const candidateVersion = "5".repeat(40);
const evaluatorDigest = "sha256:evaluator-a";

interface TestKeys {
  readonly publicJwk: JsonWebKey;
  readonly privateKey: CryptoKey;
}

describe("publication evidence verifier", () => {

  it("matches independent wire messages for checks and configuration reviews", () => {
    const check: PublicationCheckEvidenceRecord = { schema_version: 1, kind: "check", id: "unit", candidate_code_commit: "3".repeat(40), evaluator_digest: "sha256:evaluator-a", actor_id: "runner-a", actor_kind: "agent", key_id: "check-key", outcome: "passed", signature: "AQ==" };
    expect(canonicalPublicationEvidencePayload(check)).toBe("{\"actor_id\":\"runner-a\",\"actor_kind\":\"agent\",\"candidate_code_commit\":\"3333333333333333333333333333333333333333\",\"evaluator_digest\":\"sha256:evaluator-a\",\"id\":\"unit\",\"key_id\":\"check-key\",\"kind\":\"check\",\"outcome\":\"passed\",\"schema_version\":1}");
    const review: PublicationReviewEvidenceRecord = { schema_version: 1, kind: "review", id: "review-a", candidate_code_commit: "3".repeat(40), evaluator_digest: "sha256:evaluator-a", actor_id: "reviewer-a", actor_kind: "human", key_id: "review-key", decision: "approve", signature: "AQ==", configuration: { expected_version: "9".repeat(40), files: { "config/publication.json": "e30=", "config/evaluator.json": null, "config/trusted-keys.json": null }, reason: "Replace policy" } };
    expect(canonicalPublicationEvidencePayload(review)).toBe("{\"actor_id\":\"reviewer-a\",\"actor_kind\":\"human\",\"candidate_code_commit\":\"3333333333333333333333333333333333333333\",\"configuration\":{\"expected_version\":\"9999999999999999999999999999999999999999\",\"files\":{\"config/evaluator.json\":null,\"config/publication.json\":\"e30=\",\"config/trusted-keys.json\":null},\"reason\":\"Replace policy\"},\"decision\":\"approve\",\"evaluator_digest\":\"sha256:evaluator-a\",\"id\":\"review-a\",\"key_id\":\"review-key\",\"kind\":\"review\",\"schema_version\":1}");
  });
  it("verifies exact candidate checks and approvals using signed Ed25519 receipts", async () => {
    const checkKeys = await generateKeys();
    const reviewKeys = await generateKeys();
    const policy = policyWith({ checkKeyId: "check-key", reviewKeyId: "review-key" });
    const check = await signRecord(checkKeys, {
      actor_id: "runner-a",
      actor_kind: "agent",
      candidate_code_commit: candidateCode,
      evaluator_digest: evaluatorDigest,
      id: "unit",
      key_id: "check-key",
      kind: "check",
      outcome: "passed",
      schema_version: publicationEvidenceSchemaVersion,
      signature: ""
    });
    const review = await signRecord(reviewKeys, {
      actor_id: "reviewer-a",
      actor_kind: "human",
      candidate_code_commit: candidateCode,
      decision: "approve",
      evaluator_digest: evaluatorDigest,
      id: "review-a",
      key_id: "review-key",
      kind: "review",
      schema_version: publicationEvidenceSchemaVersion,
      signature: ""
    });

    const historicalCheck = await signRecord(checkKeys, { ...check, id: "historical-check", candidate_code_commit: expectedCode, outcome: "failed", signature: "" });
    const historicalReview = await signRecord(reviewKeys, { ...review, id: "historical-review", candidate_code_commit: expectedCode, decision: "reject", signature: "" });
    const oldEvaluatorReview = await signRecord(reviewKeys, { ...review, id: "old-evaluator-review", evaluator_digest: "sha256:previous-evaluator", signature: "" });
    const configHistory = await signRecord(reviewKeys, { ...review, id: "config-history", configuration: { expected_version: "9".repeat(40), files: { "config/publication.json": encodeJson(policy), "config/evaluator.json": null, "config/trusted-keys.json": null }, reason: "Previous policy approval" }, signature: "" });
    const records = { "checks/unit.json": check, "checks/historical-check.json": historicalCheck, "reviews/review-a.json": review, "reviews/historical-review.json": historicalReview, "reviews/old-evaluator-review.json": oldEvaluatorReview, "reviews/config-history.json": configHistory };
    const result = await verifyPublicationEvidence({
      clock: () => new Date("2026-10-09T00:00:00.000Z"),
      context: context(),
      git: gitWith(policy, records),
      trustedKeys: new Map([["check-key", checkKeys.publicJwk], ["review-key", reviewKeys.publicJwk]])
    });

    const { "reviews/review-a.json": _currentReview, ...configurationOnly } = records;
    await expect(verifyPublicationEvidence({ context: context(), git: gitWith(policy, configurationOnly), trustedKeys: { "check-key": checkKeys.publicJwk, "review-key": reviewKeys.publicJwk } })).rejects.toMatchObject({ code: "evidence_missing" });
    expect(result).toEqual({
      approvals: ["reviewer-a"],
      candidate_code_commit: candidateCode,
      checks: ["unit"],
      evaluator_digest: evaluatorDigest,
      verified_at: "2026-10-09T00:00:00.000Z"
    });
  });

  it("rejects a signed stale candidate SHA so removing the exact-SHA check goes red", async () => {
    const checkKeys = await generateKeys();
    const reviewKeys = await generateKeys();
    const staleCodeCommit = "6".repeat(40);
    const policy = policyWith({ checkKeyId: "check-key", reviewKeyId: "review-key" });
    const check = await signRecord(checkKeys, {
      actor_id: "runner-a",
      actor_kind: "agent",
      candidate_code_commit: staleCodeCommit,
      evaluator_digest: evaluatorDigest,
      id: "unit",
      key_id: "check-key",
      kind: "check",
      outcome: "passed",
      schema_version: publicationEvidenceSchemaVersion,
      signature: ""
    });
    const review = await signRecord(reviewKeys, {
      actor_id: "reviewer-a",
      actor_kind: "human",
      candidate_code_commit: candidateCode,
      decision: "approve",
      evaluator_digest: evaluatorDigest,
      id: "review-a",
      key_id: "review-key",
      kind: "review",
      schema_version: publicationEvidenceSchemaVersion,
      signature: ""
    });

    await expect(verifyPublicationEvidence({
      context: context(),
      git: gitWith(policy, { "checks/unit.json": check, "reviews/review-a.json": review }),
      trustedKeys: { "check-key": checkKeys.publicJwk, "review-key": reviewKeys.publicJwk }
    })).rejects.toMatchObject({ code: "evidence_missing" });
  });

  it("rejects a tampered Ed25519 signature", async () => {
    const checkKeys = await generateKeys();
    const reviewKeys = await generateKeys();
    const policy = policyWith({ checkKeyId: "check-key", reviewKeyId: "review-key" });
    const signedCheck = await signRecord(checkKeys, {
      actor_id: "runner-a",
      actor_kind: "agent",
      candidate_code_commit: candidateCode,
      evaluator_digest: evaluatorDigest,
      id: "unit",
      key_id: "check-key",
      kind: "check",
      outcome: "passed",
      schema_version: publicationEvidenceSchemaVersion,
      signature: ""
    });
    const review = await signRecord(reviewKeys, {
      actor_id: "reviewer-a",
      actor_kind: "human",
      candidate_code_commit: candidateCode,
      decision: "approve",
      evaluator_digest: evaluatorDigest,
      id: "review-a",
      key_id: "review-key",
      kind: "review",
      schema_version: publicationEvidenceSchemaVersion,
      signature: ""
    });
    const tamperedCheck: PublicationCheckEvidenceRecord = { ...signedCheck, signature: review.signature };

    await expect(verifyPublicationEvidence({
      context: context(),
      git: gitWith(policy, { "checks/unit.json": tamperedCheck, "reviews/review-a.json": review }),
      trustedKeys: { "check-key": checkKeys.publicJwk, "review-key": reviewKeys.publicJwk }
    })).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("fails closed for absent policy and absent trusted key", async () => {
    const checkKeys = await generateKeys();
    const reviewKeys = await generateKeys();
    const policy = policyWith({ checkKeyId: "check-key", reviewKeyId: "review-key" });
    const check = await signRecord(checkKeys, {
      actor_id: "runner-a",
      actor_kind: "agent",
      candidate_code_commit: candidateCode,
      evaluator_digest: evaluatorDigest,
      id: "unit",
      key_id: "check-key",
      kind: "check",
      outcome: "passed",
      schema_version: publicationEvidenceSchemaVersion,
      signature: ""
    });
    const review = await signRecord(reviewKeys, {
      actor_id: "reviewer-a",
      actor_kind: "human",
      candidate_code_commit: candidateCode,
      decision: "approve",
      evaluator_digest: evaluatorDigest,
      id: "review-a",
      key_id: "review-key",
      kind: "review",
      schema_version: publicationEvidenceSchemaVersion,
      signature: ""
    });

    await expect(verifyPublicationEvidence({
      context: context(),
      git: gitWith(null, { "checks/unit.json": check, "reviews/review-a.json": review }),
      trustedKeys: { "check-key": checkKeys.publicJwk, "review-key": reviewKeys.publicJwk }
    })).rejects.toMatchObject({ code: "policy_missing" });

    await expect(verifyPublicationEvidence({
      context: context(),
      git: gitWith(policy, { "checks/unit.json": check, "reviews/review-a.json": review }),
      trustedKeys: { "check-key": checkKeys.publicJwk }
    })).rejects.toMatchObject({ code: "untrusted_key" });
  });
  it("requires a signed human approval for exact configuration contents while preserving accepted code", async () => {
    const keys = await generateKeys();
    const policy = policyWith({ checkKeyId: "check-key", reviewKeyId: "review-key" });
    const changedPolicy = { ...policy, evaluator_digest: "sha256:reviewed-evaluator-b" };
    const files = { "config/publication.json": encodeJson(changedPolicy), "config/evaluator.json": encodeJson({ command: ["node", "reviewed-tests.mjs"] }), "config/trusted-keys.json": null };
    const configuration = { expected_version: "7".repeat(40), files, reason: "Replace the reviewed test harness without changing accepted code" };
    const review = await signRecord(keys, { actor_id: "reviewer-a", actor_kind: "human", candidate_code_commit: expectedCode, decision: "approve", evaluator_digest: evaluatorDigest, id: "config-review", key_id: "review-key", kind: "review", schema_version: publicationEvidenceSchemaVersion, signature: "", configuration } satisfies PublicationReviewEvidenceRecord);
    const stateOnlyContext = { ...context(), candidate: version(expectedCode, candidateState, candidateVersion) };
    const historicalApproval = await signRecord(keys, { ...review, id: "previous-config-review", configuration: { ...configuration, expected_version: "9".repeat(40) }, signature: "" });
    function configGit(record?: PublicationReviewEvidenceRecord, protectedFiles = files) {
      const base = gitWith(policy, { "reviews/previous-config-review.json": historicalApproval, ...(record ? { "reviews/config-review.json": record } : {}) });
      return { ...base, readFile: async (commit: string, path: string) => commit === candidateState && path in protectedFiles ? protectedFiles[path as keyof typeof protectedFiles] : base.readFile(commit, path) };
    }
    const verify = (record?: PublicationReviewEvidenceRecord, protectedFiles = files, currentContext = stateOnlyContext) => verifyPublicationEvidence({ context: currentContext, git: configGit(record, protectedFiles), trustedKeys: { "review-key": keys.publicJwk } });
    await expect(verify()).rejects.toMatchObject({ code: "evidence_missing" });
    await expect(verify(review)).resolves.toMatchObject({ checks: [], approvals: ["reviewer-a"], candidate_code_commit: expectedCode });
    await expect(verify(review, { ...files, "config/evaluator.json": encodeJson({ command: ["true"] }) })).rejects.toMatchObject({ code: "candidate_mismatch" });
    await expect(verify(review, files, context())).rejects.toMatchObject({ code: "candidate_mismatch" });
    const agentReview = await signRecord(keys, { ...review, actor_kind: "agent", signature: "" });
    await expect(verify(agentReview)).rejects.toMatchObject({ code: "untrusted_actor" });
    const staleReview = await signRecord(keys, { ...review, configuration: { ...configuration, expected_version: "9".repeat(40) }, signature: "" });
    await expect(verify(staleReview)).rejects.toMatchObject({ code: "evidence_missing" });
    await expect(verify({ ...review, configuration: { ...configuration, reason: "Tampered authorization reason" } })).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("lets a fully automatic forge change its own rules without a person, except its trusted keys", async () => {
    const automatic = { ...policyWith({ checkKeyId: "check-key", reviewKeyId: "review-key" }), reviews: { actor_kinds: ["human"] as const, key_ids: ["review-key"], required_approvals: 0, trusted_reviewer_ids: ["reviewer-a"] } };
    const looser = { ...automatic, checks: [] };
    const stateOnlyContext = { ...context(), candidate: version(expectedCode, candidateState, candidateVersion) };
    const verify = (protectedFiles: Record<string, string | null>, currentContext = stateOnlyContext, headPolicy: PublicationEvidencePolicy = automatic) => {
      const base = gitWith(headPolicy, {});
      const git = { ...base, readFile: async (commit: string, path: string) => commit === candidateState && path in protectedFiles ? protectedFiles[path] ?? null : base.readFile(commit, path) };
      return verifyPublicationEvidence({ context: currentContext, git, trustedKeys: {} });
    };
    const rules = { "config/publication.json": encodeJson(looser), "config/evaluator.json": encodeJson({ command: ["node", "faster-tests.mjs"] }), "config/trusted-keys.json": null };
    await expect(verify(rules)).resolves.toMatchObject({ checks: [], approvals: [], candidate_code_commit: expectedCode });
    await expect(verify({ ...rules, "config/trusted-keys.json": encodeJson({ "agent-key": { kty: "OKP" } }) })).rejects.toMatchObject({ code: "evidence_missing" });
    await expect(verify(rules, context())).rejects.toMatchObject({ code: "candidate_mismatch" });
    await expect(verify(rules, stateOnlyContext, policyWith({ checkKeyId: "check-key", reviewKeyId: "review-key" }))).rejects.toMatchObject({ code: "evidence_missing" });
  });

});

function policyWith(input: { readonly checkKeyId: string; readonly reviewKeyId: string }): PublicationEvidencePolicy {
  return {
    checks: [{ actor_ids: ["runner-a"], actor_kinds: ["agent"], id: "unit", key_ids: [input.checkKeyId] }],
    evaluator_digest: evaluatorDigest,
    reviews: { actor_kinds: ["human"], key_ids: [input.reviewKeyId], required_approvals: 1, trusted_reviewer_ids: ["reviewer-a"] },
    schema_version: publicationEvidenceSchemaVersion
  };
}

function context() {
  return {
    actor: { id: "service-a", kind: "service" as const },
    candidate: version(candidateCode, candidateState, candidateVersion),
    expected: version(expectedCode, expectedState, "7".repeat(40))
  };
}

function version(codeCommit: string, stateCommit: string, versionCommit: string): ForgeVersion {
  return {
    descriptor: {
      code_commit: codeCommit,
      creator_id: "creator-a",
      creator_kind: "service",
      fork_id: "fork-a",
      operation_id: "op-a",
      parents: [],
      repository_id: "repo-a",
      request_digest: "digest-a",
      schema_version: 1,
      state_commit: stateCommit,
      tenant_id: "tenant-a"
    },
    version_commit: versionCommit
  };
}

function gitWith(policy: PublicationEvidencePolicy | null, records: Record<string, PublicationEvidenceRecord>): Pick<ForgeGitPort, "readFile" | "listTree"> {
  const files = new Map<string, string>();
  if (policy !== null) {
    files.set(`${expectedState}:${publicationPolicyPath}`, encodeJson(policy));
    files.set(`${candidateState}:${publicationPolicyPath}`, encodeJson(policy));
  }
  for (const [path, record] of Object.entries(records)) files.set(`${candidateState}:${path}`, encodeJson(record));
  return {
    listTree: async (commit, prefix = "") => [...files.keys()]
      .filter((key) => key.startsWith(`${commit}:${prefix}`))
      .map((key) => ({ mode: "100644", oid: "8".repeat(40), path: key.slice(commit.length + 1), type: "blob" as const })),
    readFile: async (commit, path) => files.get(`${commit}:${path}`) ?? null
  };
}

async function generateKeys(): Promise<TestKeys> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("publicKey" in keys)) throw new Error("expected asymmetric key pair");
  return { privateKey: keys.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", keys.publicKey) };
}

async function signRecord<T extends PublicationEvidenceRecord>(keys: TestKeys, record: T): Promise<T> {
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(canonicalPublicationEvidencePayload(record)));
  return { ...record, signature: base64(signature) };
}

function encodeJson(value: unknown): string {
  return base64(new TextEncoder().encode(JSON.stringify(value)));
}

function base64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
