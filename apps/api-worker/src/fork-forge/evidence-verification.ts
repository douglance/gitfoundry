import { Schema } from "effect";
import { canonicalJson } from "@gitfoundry/core";
import { canonicalPublicationEvidencePayload } from "./evidence-payload.js";
import { fail } from "./evidence-parsing.js";
import type { PublicationEvidenceRecord, PublicationEvidencePolicy, PublicationEvidenceVerifierInput, PublicationEvidenceResult, PublicationEvidenceActorKind, PublicationCheckPolicy, PublicationReviewEvidenceRecord, PublicationCheckEvidenceRecord } from "./evidence-model.js";

function assertAllowed(record: PublicationEvidenceRecord, actorIds: readonly string[], actorKinds: readonly PublicationEvidenceActorKind[], keyIds: readonly string[]): void {
  if (!actorIds.includes(record.actor_id) || !actorKinds.includes(record.actor_kind)) throw fail("untrusted_actor", `actor ${record.actor_id} is not authorized for ${record.id}`);
  if (!keyIds.includes(record.key_id)) throw fail("untrusted_key", `key ${record.key_id} is not authorized for ${record.id}`);
}

function keyFor(keys: PublicationEvidenceVerifierInput["trustedKeys"], keyId: string): JsonWebKey {
  const key = keys instanceof Map ? keys.get(keyId) : (keys as Readonly<Record<string, JsonWebKey>>)[keyId];
  if (key === undefined) throw fail("untrusted_key", `missing trusted key ${keyId}`);
  return key;
}

async function verifySignature(record: PublicationEvidenceRecord, jwk: JsonWebKey): Promise<void> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw fail("signature_invalid", "WebCrypto is unavailable");
  const algorithm = { name: "Ed25519" };
  let publicKey: CryptoKey;
  try {
    publicKey = await subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  } catch (error) {
    throw fail("untrusted_key", `invalid trusted key ${record.key_id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const verified = await subtle.verify(algorithm, publicKey, arrayBuffer(decodeBase64Bytes(record.signature)), arrayBuffer(new TextEncoder().encode(canonicalPublicationEvidencePayload(record))));
  if (!verified) throw fail("signature_invalid", `invalid signature for ${record.id}`);
}

function decodeBase64Bytes(value: string): Uint8Array {
  
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}


interface EvidenceContext {
  readonly input: PublicationEvidenceVerifierInput;
  readonly policy: PublicationEvidencePolicy;
  readonly code: string;
}

function matchesCandidate(record: PublicationEvidenceRecord, context: EvidenceContext): boolean {
  return record.candidate_code_commit === context.code && record.evaluator_digest === context.policy.evaluator_digest;
}

export async function verifyChecks(records: readonly PublicationEvidenceRecord[], context: EvidenceContext): Promise<Set<string>> {
  const required = new Map(context.policy.checks.map(check => [check.id, check]));
  const seen = new Set<string>();
  for (const record of records) {
    if (record.kind !== "check") throw fail("invalid_evidence", record.id + " is not a check record");
    const policy = required.get(record.id);
    if (!policy || !matchesCandidate(record, context)) continue;
    await verifyCheck(record, policy, context, seen);
  }
  for (const check of context.policy.checks) {
    if (!seen.has(check.id)) throw fail("evidence_missing", "missing required check evidence for " + check.id);
  }
  return seen;
}

async function verifyCheck(record: PublicationCheckEvidenceRecord, policy: PublicationCheckPolicy, context: EvidenceContext, seen: Set<string>): Promise<void> {
  if (record.outcome !== "passed") throw fail("invalid_evidence", "check " + record.id + " did not pass");
  if (seen.has(record.id)) throw fail("duplicate_evidence", "duplicate check evidence for " + record.id);
  await verifyAllowedSignature(record, policy, context);
  seen.add(record.id);
}

async function verifyAllowedSignature(record: PublicationEvidenceRecord, policy: PublicationCheckPolicy, context: EvidenceContext): Promise<void> {
  assertAllowed(record, policy.actor_ids, policy.actor_kinds, policy.key_ids);
  await verifySignature(record, keyFor(context.input.trustedKeys, record.key_id));
}

export async function verifyReviews(records: readonly PublicationEvidenceRecord[], context: EvidenceContext): Promise<Set<string>> {
  const actors = new Set<string>();
  const ids = new Set<string>();
  for (const record of records) {
    if (record.kind !== "review") throw fail("invalid_evidence", record.id + " is not a review record");
    if (record.configuration || !matchesCandidate(record, context)) continue;
    await verifyOrdinaryApproval(record, context, actors, ids);
  }
  if (actors.size < context.policy.reviews.required_approvals) throw fail("evidence_missing", "expected " + context.policy.reviews.required_approvals + " approval(s), found " + actors.size);
  return actors;
}

async function verifyOrdinaryApproval(record: PublicationReviewEvidenceRecord, context: EvidenceContext, actors: Set<string>, ids: Set<string>): Promise<void> {
  if (ids.has(record.id)) throw fail("duplicate_evidence", "duplicate review evidence for " + record.id);
  ids.add(record.id);
  if (record.decision !== "approve") throw fail("invalid_evidence", "review " + record.id + " is not an approval");
  await verifyApproval(record, context, actors);
}

async function verifyApproval(record: PublicationReviewEvidenceRecord, context: EvidenceContext, actors: Set<string>): Promise<void> {
  const policy = context.policy.reviews;
  assertAllowed(record, policy.trusted_reviewer_ids, policy.actor_kinds, policy.key_ids);
  if (actors.has(record.actor_id)) throw fail("duplicate_evidence", "duplicate approval from " + record.actor_id);
  await verifySignature(record, keyFor(context.input.trustedKeys, record.key_id));
  actors.add(record.actor_id);
}

export async function verifyConfiguration(records: readonly PublicationEvidenceRecord[], context: EvidenceContext, expectedVersion: string, files: Record<string, string | null>): Promise<Set<string>> {
  const actors = new Set<string>();
  for (const record of records) {
    if (record.kind !== "review" || !record.configuration) continue;
    if (!matchesCandidate(record, context) || record.configuration.expected_version !== expectedVersion) continue;
    await verifyConfigurationApproval(record, record.configuration.files, context, files, actors);
  }
  if (actors.size < Math.max(1, context.policy.reviews.required_approvals)) throw fail("evidence_missing", "protected configuration requires signed human approval of its exact contents");
  return actors;
}

export function verificationResult(context: EvidenceContext, checks: Set<string>, approvals: Set<string>): PublicationEvidenceResult {
  const time = context.input.clock?.() ?? new Date();
  return { approvals: [...approvals].sort(), candidate_code_commit: context.code, checks: [...checks].sort(), evaluator_digest: context.policy.evaluator_digest, verified_at: Schema.is(Schema.String)(time) ? time : time.toISOString() };
}

async function verifyConfigurationApproval(record: PublicationReviewEvidenceRecord, approvedFiles: Readonly<Record<string, string | null>>, context: EvidenceContext, files: Record<string, string | null>, actors: Set<string>): Promise<void> {
  if (record.actor_kind !== "human" || record.decision !== "approve") throw fail("untrusted_actor", "configuration approval requires an authenticated human approval");
  if (canonicalJson(approvedFiles) !== canonicalJson(files)) throw fail("candidate_mismatch", "configuration approval is stale or covers different records");
  if (actors.has(record.actor_id)) throw fail("duplicate_evidence", "duplicate configuration approval");
  await verifyApproval(record, context, actors);
}
