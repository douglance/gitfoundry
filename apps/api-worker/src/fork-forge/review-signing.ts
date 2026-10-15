import { canonicalJson, decodeBase64Utf8, type ForgeActor, type ForgeGitPort, type ForgeVersion } from "@gitfoundry/core";

import {
  canonicalPublicationEvidencePayload,
  configurationReviewFor,
  publicationEvidenceSchemaVersion,
  publicationPolicyPath,
  type PublicationEvidencePolicy,
  type PublicationReviewEvidenceRecord
} from "./evidence.js";

export interface ReviewSigningContext {
  readonly tenant_id: string;
  readonly repository_id: string;
  readonly actor: ForgeActor;
  readonly parent: ForgeVersion;
  readonly record: Record<string, unknown>;
}

export type ReviewSigningCallback = (context: ReviewSigningContext) => Promise<Record<string, unknown>>;

export interface ReviewSigningInput {
  readonly gitFactory: Pick<ForgeGitPort, "readFile"> & Partial<Pick<ForgeGitPort, "readRef">> | ((input: { readonly tenantId: string; readonly repositoryId: string }) => Pick<ForgeGitPort, "readFile"> & Partial<Pick<ForgeGitPort, "readRef">> | undefined | Promise<Pick<ForgeGitPort, "readFile"> & Partial<Pick<ForgeGitPort, "readRef">> | undefined>);
  readonly keyId?: string;
  readonly signingKeyJwk?: string;
}

export class ReviewSigningConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSigningConfigurationError";
  }
}

const safeIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const sha40Pattern = /^[0-9a-f]{40}$/u;

export function makeReviewSigningCallback(input: ReviewSigningInput): ReviewSigningCallback | undefined {
  if (!input.keyId && !input.signingKeyJwk) return undefined;
  return async (context) => {
    const keyId = requiredKeyId(input.keyId);
    const privateJwk = parsePrivateJwk(input.signingKeyJwk);
    const git = await reviewGit(input.gitFactory, context.tenant_id, context.repository_id);
    const configuration = await configurationReviewFor(git, context);
    const policy = await readPublicationPolicy(git, configuration?.policyStateCommit ?? context.parent.descriptor.state_commit);
    const record = bindReviewRecord({ ...context.record, ...(configuration ? { configuration: configuration.configuration } : {}) }, context.actor, context.parent.descriptor.code_commit, policy.evaluator_digest, keyId);
    assertPolicyAllowsReview(policy, record);
    const signature = await signReviewRecord(privateJwk, record);
    return { ...record, signature };
  };
}

async function reviewGit(factory: ReviewSigningInput["gitFactory"], tenantId: string, repositoryId: string): Promise<Pick<ForgeGitPort, "readFile"> & Partial<Pick<ForgeGitPort, "readRef">>> {
  const git = typeof factory === "function" ? await factory({ tenantId, repositoryId }) : factory;
  if (!git) throw new ReviewSigningConfigurationError("forge Git backend unavailable for review signing");
  return git;
}

async function readPublicationPolicy(git: Pick<ForgeGitPort, "readFile"> & Partial<Pick<ForgeGitPort, "readRef">>, stateCommit: string): Promise<PublicationEvidencePolicy> {
  const content = await git.readFile(stateCommit, publicationPolicyPath);
  if (content === null) throw new ReviewSigningConfigurationError("publication policy missing for review signing");
  let value: unknown;
  try { value = JSON.parse(decodeBase64Utf8(content)) } catch { throw new ReviewSigningConfigurationError("publication policy is not valid JSON") }
  return parsePolicy(value);
}

function bindReviewRecord(record: Record<string, unknown>, actor: ForgeActor, candidateCodeCommit: string, evaluatorDigest: string, keyId: string): PublicationReviewEvidenceRecord {
  const id = safeId(record.id, "review id");
  const decision = reviewDecision(record.decision);
  rejectConflicting(record.actor_id, actor.id, "actor_id");
  rejectConflicting(record.actor_kind, actor.kind, "actor_kind");
  rejectConflicting(record.candidate_code_commit, candidateCodeCommit, "candidate_code_commit");
  rejectConflicting(record.evaluator_digest, evaluatorDigest, "evaluator_digest");
  rejectConflicting(record.key_id, keyId, "key_id");
  if (record.kind !== "review") throw new ReviewSigningConfigurationError("review signing only accepts review records");
  if (record.signature !== undefined) throw new ReviewSigningConfigurationError("review record is already signed");
  return {
    ...record,
    actor_id: actor.id,
    actor_kind: actor.kind,
    candidate_code_commit: sha40(candidateCodeCommit, "candidate_code_commit"),
    decision,
    evaluator_digest: nonEmpty(evaluatorDigest, "evaluator_digest"),
    id,
    key_id: keyId,
    kind: "review",
    schema_version: publicationEvidenceSchemaVersion,
    signature: ""
  };
}

function assertPolicyAllowsReview(policy: PublicationEvidencePolicy, record: PublicationReviewEvidenceRecord): void {
  if (!policy.reviews.trusted_reviewer_ids.includes(record.actor_id) || !policy.reviews.actor_kinds.includes(record.actor_kind)) throw new ReviewSigningConfigurationError("review actor is not trusted by publication policy");
  if (!policy.reviews.key_ids.includes(record.key_id)) throw new ReviewSigningConfigurationError("review signing key is not trusted by publication policy");
}

async function signReviewRecord(privateJwk: JsonWebKey, record: PublicationReviewEvidenceRecord): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ReviewSigningConfigurationError("WebCrypto is unavailable for review signing");
  let privateKey: CryptoKey;
  try {
    privateKey = await subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
  } catch (error) {
    throw new ReviewSigningConfigurationError(`review signing key is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const signature = await subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(canonicalPublicationEvidencePayload(record)));
  return standardBase64(signature);
}

function parsePrivateJwk(value: string | undefined): JsonWebKey {
  if (!value) throw new ReviewSigningConfigurationError("review signing key is not configured");
  let jwk: unknown;
  try { jwk = JSON.parse(value) } catch { throw new ReviewSigningConfigurationError("review signing key is not valid JSON") }
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) throw new ReviewSigningConfigurationError("review signing key must be a private Ed25519 JWK");
  const key = jwk as JsonWebKey;
  if (key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.x !== "string" || typeof key.d !== "string") throw new ReviewSigningConfigurationError("review signing key must be a private Ed25519 JWK");
  return key;
}

function parsePolicy(value: unknown): PublicationEvidencePolicy {
  const input = object(value, "publication policy");
  if (input.schema_version !== publicationEvidenceSchemaVersion) throw new ReviewSigningConfigurationError("unsupported publication policy schema");
  const reviews = object(input.reviews, "reviews");
  const policy: PublicationEvidencePolicy = {
    checks: Array.isArray(input.checks) ? input.checks as never : [],
    evaluator_digest: nonEmpty(input.evaluator_digest, "evaluator_digest"),
    reviews: {
      actor_kinds: stringArray(reviews.actor_kinds, "reviews.actor_kinds") as PublicationEvidencePolicy["reviews"]["actor_kinds"],
      key_ids: stringArray(reviews.key_ids, "reviews.key_ids"),
      required_approvals: nonNegativeInteger(reviews.required_approvals, "reviews.required_approvals"),
      trusted_reviewer_ids: stringArray(reviews.trusted_reviewer_ids, "reviews.trusted_reviewer_ids")
    },
    schema_version: publicationEvidenceSchemaVersion
  };
  if (policy.reviews.actor_kinds.some((kind) => kind !== "human" && kind !== "agent" && kind !== "service")) throw new ReviewSigningConfigurationError("reviews.actor_kinds contains an unsupported actor kind");
  return policy;
}

function requiredKeyId(value: string | undefined): string {
  return safeId(value, "review key id");
}

function safeId(value: unknown, field: string): string {
  const id = nonEmpty(value, field);
  if (!safeIdPattern.test(id)) throw new ReviewSigningConfigurationError(`${field} is invalid`);
  return id;
}

function sha40(value: unknown, field: string): string {
  const sha = nonEmpty(value, field);
  if (!sha40Pattern.test(sha)) throw new ReviewSigningConfigurationError(`${field} must be a lower-case SHA-1`);
  return sha;
}

function reviewDecision(value: unknown): PublicationReviewEvidenceRecord["decision"] {
  if (value === "approve" || value === "reject") return value;
  throw new ReviewSigningConfigurationError("review decision must be approve or reject");
}

function rejectConflicting(value: unknown, expected: string, field: string): void {
  if (value !== undefined && value !== expected) throw new ReviewSigningConfigurationError(`${field} conflicts with authenticated review binding`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReviewSigningConfigurationError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ReviewSigningConfigurationError(`${field} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ReviewSigningConfigurationError(`${field} must be a non-empty array`);
  return value.map((item, index) => nonEmpty(item, `${field}[${index}]`));
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ReviewSigningConfigurationError(`${field} must be a non-negative integer`);
  return value;
}

function standardBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function encodeReviewSigningJson(value: unknown): string {
  return standardBase64(new TextEncoder().encode(canonicalJson(value)).buffer as ArrayBuffer);
}
