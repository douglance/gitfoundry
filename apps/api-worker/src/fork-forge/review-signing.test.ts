import { describe, expect, it } from "vitest";
import { canonicalJson, type ForgeGitPort, type ForgeVersion } from "@gitfoundry/core";

import { publicationEvidenceSchemaVersion, publicationPolicyPath, verifyPublicationEvidence, type PublicationEvidencePolicy, type PublicationEvidenceRecord } from "./evidence.js";
import { makeReviewSigningCallback } from "./review-signing.js";

const codeCommit = "1".repeat(40);
const parentState = "2".repeat(40);
const candidateState = "3".repeat(40);
const evaluatorDigest = "sha256:evaluator-a";

describe("cloud review signing", () => {
  it("seals an authenticated review with Ed25519 and the publication verifier accepts it", async () => {
    const keys = await generateKeys();
    const policy = publicationPolicy("review-key");
    const git = gitWith(policy, {});
    const factoryCalls: Array<{ tenantId: string; repositoryId: string }> = [];
    const signer = makeReviewSigningCallback({
      gitFactory: async (input) => { factoryCalls.push(input); return git; },
      keyId: "review-key",
      signingKeyJwk: JSON.stringify(keys.privateJwk)
    });

    const sealed = await signer!({
      actor: { id: "reviewer-a", kind: "human" },
      parent: version(codeCommit, parentState, "4".repeat(40)),
      record: { decision: "approve", id: "review-a", kind: "review", reason: "human-readable reason stays outside signed payload" },
      repository_id: "repo-a",
      tenant_id: "tenant-a"
    });
    git.put(candidateState, "reviews/review-a.json", sealed as unknown as PublicationEvidenceRecord);

    expect(factoryCalls).toEqual([{ tenantId: "tenant-a", repositoryId: "repo-a" }]);
    expect(sealed).toMatchObject({
      actor_id: "reviewer-a",
      actor_kind: "human",
      candidate_code_commit: codeCommit,
      evaluator_digest: evaluatorDigest,
      key_id: "review-key",
      schema_version: publicationEvidenceSchemaVersion,
      signature: expect.any(String)
    });
    await expect(verifyPublicationEvidence({
      context: { actor: { id: "service-a", kind: "service" }, candidate: version(codeCommit, candidateState, "5".repeat(40)), expected: version(codeCommit, parentState, "4".repeat(40)) },
      git,
      trustedKeys: { "review-key": keys.publicJwk }
    })).resolves.toMatchObject({ approvals: ["reviewer-a"], candidate_code_commit: codeCommit, evaluator_digest: evaluatorDigest });
  });

  it("fails closed for malformed signing configuration and missing publication policy", async () => {
    const keys = await generateKeys();
    const missingPolicyGit = gitWith(null, {});
    const missingPolicySigner = makeReviewSigningCallback({ gitFactory: missingPolicyGit, keyId: "review-key", signingKeyJwk: JSON.stringify(keys.privateJwk) });
    await expect(missingPolicySigner!({ actor: { id: "reviewer-a", kind: "human" }, parent: version(codeCommit, parentState, "4".repeat(40)), record: { decision: "approve", id: "review-a", kind: "review" }, repository_id: "repo-a", tenant_id: "tenant-a" })).rejects.toThrow(/publication policy missing/);

    const malformedSigner = makeReviewSigningCallback({ gitFactory: missingPolicyGit, keyId: "review-key", signingKeyJwk: "not-json" });
    await expect(malformedSigner!({ actor: { id: "reviewer-a", kind: "human" }, parent: version(codeCommit, parentState, "4".repeat(40)), record: { decision: "approve", id: "review-a", kind: "review" }, repository_id: "repo-a", tenant_id: "tenant-a" })).rejects.toThrow(/not valid JSON/);
  });

  it("rejects actor code digest and key bindings that conflict with the authenticated policy context", async () => {
    const keys = await generateKeys();
    const signer = makeReviewSigningCallback({ gitFactory: gitWith(publicationPolicy("review-key"), {}), keyId: "review-key", signingKeyJwk: JSON.stringify(keys.privateJwk) });
    const parent = version(codeCommit, parentState, "4".repeat(40));
    const context = { actor: { id: "reviewer-a", kind: "human" as const }, parent, repository_id: "repo-a", tenant_id: "tenant-a" };

    await expect(signer!({ ...context, record: { actor_id: "reviewer-b", decision: "approve", id: "review-a", kind: "review" } })).rejects.toThrow(/actor_id conflicts/);
    await expect(signer!({ ...context, record: { candidate_code_commit: "6".repeat(40), decision: "approve", id: "review-a", kind: "review" } })).rejects.toThrow(/candidate_code_commit conflicts/);
    await expect(signer!({ ...context, record: { decision: "approve", evaluator_digest: "sha256:stale", id: "review-a", kind: "review" } })).rejects.toThrow(/evaluator_digest conflicts/);
    await expect(signer!({ ...context, record: { decision: "approve", id: "review-a", key_id: "other-key", kind: "review" } })).rejects.toThrow(/key_id conflicts/);
  });
});

function publicationPolicy(reviewKeyId: string): PublicationEvidencePolicy {
  return {
    checks: [],
    evaluator_digest: evaluatorDigest,
    reviews: { actor_kinds: ["human"], key_ids: [reviewKeyId], required_approvals: 1, trusted_reviewer_ids: ["reviewer-a"] },
    schema_version: publicationEvidenceSchemaVersion
  };
}

function version(code: string, state: string, commit: string): ForgeVersion {
  return {
    descriptor: { code_commit: code, creator_id: "creator-a", creator_kind: "service", fork_id: "fork-a", operation_id: "op-a", parents: [], repository_id: "repo-a", request_digest: "digest-a", schema_version: 1, state_commit: state, tenant_id: "tenant-a" },
    version_commit: commit
  };
}

function gitWith(policy: PublicationEvidencePolicy | null, records: Record<string, PublicationEvidenceRecord>): Pick<ForgeGitPort, "readFile" | "listTree"> & { put(commit: string, path: string, value: unknown): void } {
  const files = new Map<string, string>();
  if (policy) {
    files.set(`${parentState}:${publicationPolicyPath}`, encodeJson(policy));
    files.set(`${candidateState}:${publicationPolicyPath}`, encodeJson(policy));
  }
  for (const [path, record] of Object.entries(records)) files.set(`${candidateState}:${path}`, encodeJson(record));
  return {
    listTree: async (commit, prefix = "") => [...files.keys()].filter((key) => key.startsWith(`${commit}:${prefix}`)).map((key) => ({ mode: "100644", oid: "8".repeat(40), path: key.slice(commit.length + 1), type: "blob" as const })),
    put: (commit, path, value) => { files.set(`${commit}:${path}`, encodeJson(value)) },
    readFile: async (commit, path) => files.get(`${commit}:${path}`) ?? null
  };
}

async function generateKeys(): Promise<{ readonly privateJwk: JsonWebKey; readonly publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey), publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
