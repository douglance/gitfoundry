import type { ForgeActor, ForgeGitPort, ForkForgeEvidenceContext } from "@gitfoundry/core";

export const publicationEvidenceSchemaVersion = 1 as const;
export const publicationPolicyPath = "config/publication.json" as const;

export const protectedPublicationPaths = ["config/publication.json", "config/evaluator.json", "config/trusted-keys.json"] as const;

export interface PublicationConfigurationApproval {
  readonly expected_version: string;
  readonly files: Readonly<Record<string, string | null>>;
  readonly reason: string;
}

export type PublicationEvidenceKind = "check" | "review";
export type PublicationEvidenceActorKind = ForgeActor["kind"];

export interface PublicationCheckPolicy {
  readonly id: string;
  readonly actor_ids: readonly string[];
  readonly actor_kinds: readonly PublicationEvidenceActorKind[];
  readonly key_ids: readonly string[];
}

export interface PublicationReviewPolicy {
  readonly required_approvals: number;
  readonly trusted_reviewer_ids: readonly string[];
  readonly actor_kinds: readonly PublicationEvidenceActorKind[];
  readonly key_ids: readonly string[];
}

export interface PublicationEvidencePolicy {
  readonly schema_version: typeof publicationEvidenceSchemaVersion;
  readonly evaluator_digest: string;
  readonly checks: readonly PublicationCheckPolicy[];
  readonly reviews: PublicationReviewPolicy;
}

interface PublicationEvidenceBaseRecord {
  readonly schema_version: typeof publicationEvidenceSchemaVersion;
  readonly kind: PublicationEvidenceKind;
  readonly id: string;
  readonly candidate_code_commit: string;
  readonly evaluator_digest: string;
  readonly actor_id: string;
  readonly actor_kind: PublicationEvidenceActorKind;
  readonly key_id: string;
  readonly signature: string;
}

export interface PublicationCheckEvidenceRecord extends PublicationEvidenceBaseRecord {
  readonly kind: "check";
  readonly outcome: "passed" | "failed";
}

export interface PublicationReviewEvidenceRecord extends PublicationEvidenceBaseRecord {
  readonly kind: "review";
  readonly decision: "approve" | "reject";
  readonly configuration?: PublicationConfigurationApproval;
}

export type PublicationEvidenceRecord = PublicationCheckEvidenceRecord | PublicationReviewEvidenceRecord;

export type PublicationEvidencePayload =
  | Omit<PublicationCheckEvidenceRecord, "signature">
  | Omit<PublicationReviewEvidenceRecord, "signature">;

export interface PublicationEvidenceResult {
  readonly verified_at: string;
  readonly candidate_code_commit: string;
  readonly evaluator_digest: string;
  readonly checks: readonly string[];
  readonly approvals: readonly string[];
}

export type PublicationEvidenceErrorCode =
  | "candidate_mismatch"
  | "duplicate_evidence"
  | "evidence_missing"
  | "invalid_evidence"
  | "invalid_policy"
  | "policy_missing"
  | "signature_invalid"
  | "untrusted_actor"
  | "untrusted_key";

export class PublicationEvidenceVerificationError extends Error {
  readonly code: PublicationEvidenceErrorCode;

  constructor(code: PublicationEvidenceErrorCode, message: string) {
    super(message);
    this.name = "PublicationEvidenceVerificationError";
    this.code = code;
  }
}

export interface PublicationEvidenceVerifierInput {
  readonly git: Pick<ForgeGitPort, "readFile" | "listTree">;
  readonly trustedKeys: ReadonlyMap<string, JsonWebKey> | Readonly<Record<string, JsonWebKey>>;
  readonly context: ForkForgeEvidenceContext;
  readonly clock?: () => Date | string;
}

