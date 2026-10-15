import { Schema } from "effect";
import { decodeBase64Utf8, type ForgeGitPort } from "@gitfoundry/core";
import { publicationEvidenceSchemaVersion, protectedPublicationPaths, PublicationEvidenceVerificationError, type PublicationEvidenceErrorCode, type PublicationEvidencePolicy, type PublicationCheckPolicy, type PublicationReviewPolicy, type PublicationEvidenceRecord, type PublicationConfigurationApproval, type PublicationEvidenceActorKind, type PublicationCheckEvidenceRecord, type PublicationReviewEvidenceRecord } from "./evidence-model.js";

const evidenceRecordIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const sha40Pattern = /^[0-9a-f]{40}$/;
const standardBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseConfigurationApproval(value: Schema.Json | undefined): PublicationConfigurationApproval {
  const input = object(value, "configuration approval", "invalid_evidence");
  const files = object(input.files, "configuration files", "invalid_evidence");
  if (Object.keys(files).length !== protectedPublicationPaths.length) throw fail("invalid_evidence", "configuration approval must cover every protected record");
  const parsed: Record<string, string | null> = {};
  for (const path of protectedPublicationPaths) parsed[path] = files[path] === null ? null : standardBase64(files[path], path, "invalid_evidence");
  return { expected_version: sha40(input.expected_version, "configuration expected version", "invalid_evidence"), files: parsed, reason: nonEmptyString(input.reason, "configuration reason", "invalid_evidence") };
}

export async function readJson(git: Pick<ForgeGitPort, "readFile">, commit: string, path: string, missingCode: PublicationEvidenceErrorCode): Promise<Schema.Json> {
  const content = await git.readFile(commit, path);
  if (content === null) throw fail(missingCode, `missing ${path}`);
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(decodeBase64Utf8(content));
  } catch (error) {
    throw fail(missingCode === "policy_missing" ? "invalid_policy" : "invalid_evidence", `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parsePolicy(value: Schema.Json | undefined): PublicationEvidencePolicy {
  const input = object(value, "publication policy", "invalid_policy");
  if (input.schema_version !== publicationEvidenceSchemaVersion) throw fail("invalid_policy", "unsupported publication policy schema");
  const evaluator_digest = nonEmptyString(input.evaluator_digest, "evaluator_digest", "invalid_policy");
  const checksInput = array(input.checks, "checks", "invalid_policy");
  const seenChecks = new Set<string>();
  const checks = checksInput.map((item, index): PublicationCheckPolicy => {
    const check = object(item, `checks[${index}]`, "invalid_policy");
    const id = recordId(check.id, `checks[${index}].id`, "invalid_policy");
    if (seenChecks.has(id)) throw fail("invalid_policy", `duplicate required check ${id}`);
    seenChecks.add(id);
    return {
      actor_ids: nonEmptyStringArray(check.actor_ids, `checks[${index}].actor_ids`, "invalid_policy"),
      actor_kinds: actorKinds(check.actor_kinds, `checks[${index}].actor_kinds`, "invalid_policy"),
      id,
      key_ids: nonEmptyStringArray(check.key_ids, `checks[${index}].key_ids`, "invalid_policy")
    };
  });
  const reviewsInput = object(input.reviews, "reviews", "invalid_policy");
  const reviews: PublicationReviewPolicy = {
    actor_kinds: actorKinds(reviewsInput.actor_kinds, "reviews.actor_kinds", "invalid_policy"),
    key_ids: nonEmptyStringArray(reviewsInput.key_ids, "reviews.key_ids", "invalid_policy"),
    required_approvals: nonNegativeInteger(reviewsInput.required_approvals, "reviews.required_approvals", "invalid_policy"),
    trusted_reviewer_ids: nonEmptyStringArray(reviewsInput.trusted_reviewer_ids, "reviews.trusted_reviewer_ids", "invalid_policy")
  };
  if (reviews.required_approvals > reviews.trusted_reviewer_ids.length) throw fail("invalid_policy", "required approvals exceeds trusted reviewers");
  return { checks, evaluator_digest, reviews, schema_version: publicationEvidenceSchemaVersion };
}

export function parseEvidenceRecord(value: Schema.Json | undefined): PublicationEvidenceRecord {
  const input = object(value, "evidence record", "invalid_evidence");
  if (input.schema_version !== publicationEvidenceSchemaVersion) throw fail("invalid_evidence", "unsupported evidence schema");
  const kind = input.kind;
  const base = {
    actor_id: nonEmptyString(input.actor_id, "actor_id", "invalid_evidence"),
    actor_kind: actorKind(input.actor_kind, "actor_kind", "invalid_evidence"),
    candidate_code_commit: sha40(input.candidate_code_commit, "candidate_code_commit", "invalid_evidence"),
    evaluator_digest: nonEmptyString(input.evaluator_digest, "evaluator_digest", "invalid_evidence"),
    id: recordId(input.id, "id", "invalid_evidence"),
    key_id: nonEmptyString(input.key_id, "key_id", "invalid_evidence"),
    schema_version: publicationEvidenceSchemaVersion,
    signature: standardBase64(input.signature, "signature", "invalid_evidence")
  };
  if (kind === "check") return { ...base, kind, outcome: checkOutcome(input.outcome) };
  if (kind === "review") {
    const review: PublicationReviewEvidenceRecord = { ...base, kind, decision: reviewDecision(input.decision) };
    return input.configuration === undefined ? review : { ...review, configuration: parseConfigurationApproval(input.configuration) };
  }
  throw fail("invalid_evidence", "evidence kind must be check or review");
}

export function object(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): Schema.JsonObject {
  if (!Schema.is(Schema.JsonObject)(value)) throw fail(code, `${field} must be an object`);
  return value;
}

function array(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): readonly Schema.Json[] {
  if (!Schema.is(Schema.Array(Schema.Json))(value)) throw fail(code, `${field} must be an array`);
  return value;
}

export function nonEmptyString(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): string {
  if (!Schema.is(Schema.NonEmptyString)(value)) throw fail(code, `${field} must be a non-empty string`);
  return value;
}

function nonEmptyStringArray(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): readonly string[] {
  const values = array(value, field, code).map((item, index) => nonEmptyString(item, `${field}[${index}]`, code));
  if (values.length === 0) throw fail(code, `${field} must not be empty`);
  if (new Set(values).size !== values.length) throw fail(code, `${field} contains duplicates`);
  return values;
}

function actorKinds(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): readonly PublicationEvidenceActorKind[] {
  const values = array(value, field, code).map((item, index) => actorKind(item, `${field}[${index}]`, code));
  if (values.length === 0) throw fail(code, `${field} must not be empty`);
  if (new Set(values).size !== values.length) throw fail(code, `${field} contains duplicates`);
  return values;
}

function actorKind(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): PublicationEvidenceActorKind {
  if (value === "human" || value === "agent" || value === "service") return value;
  throw fail(code, `${field} must be human, agent, or service`);
}

function recordId(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): string {
  const id = nonEmptyString(value, field, code);
  if (!evidenceRecordIdPattern.test(id)) throw fail(code, `${field} must be a stable evidence identifier`);
  return id;
}

export function sha40(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): string {
  const sha = nonEmptyString(value, field, code);
  if (!sha40Pattern.test(sha)) throw fail(code, `${field} must be a lower-case SHA-1`);
  return sha;
}

function standardBase64(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): string {
  const base64 = nonEmptyString(value, field, code);
  if (!standardBase64Pattern.test(base64)) throw fail(code, `${field} must be standard base64`);
  return base64;
}

function nonNegativeInteger(value: Schema.Json | undefined, field: string, code: PublicationEvidenceErrorCode): number {
  if (!Schema.is(Schema.Natural)(value)) throw fail(code, `${field} must be a non-negative integer`);
  return value;
}

function checkOutcome(value: Schema.Json | undefined): PublicationCheckEvidenceRecord["outcome"] {
  if (value === "passed" || value === "failed") return value;
  throw fail("invalid_evidence", "check outcome must be passed or failed");
}

function reviewDecision(value: Schema.Json | undefined): PublicationReviewEvidenceRecord["decision"] {
  if (value === "approve" || value === "reject") return value;
  throw fail("invalid_evidence", "review decision must be approve or reject");
}


export function fail(code: PublicationEvidenceErrorCode, message: string): PublicationEvidenceVerificationError {
  return new PublicationEvidenceVerificationError(code, message);
}
