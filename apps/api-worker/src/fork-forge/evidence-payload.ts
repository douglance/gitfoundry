import { canonicalJson } from "@gitfoundry/core";
import { publicationEvidenceSchemaVersion, type PublicationEvidenceRecord, type PublicationEvidencePayload } from "./evidence-model.js";

export function publicationEvidencePayload(record: PublicationEvidenceRecord): PublicationEvidencePayload {
  const base = {
    actor_id: record.actor_id,
    actor_kind: record.actor_kind,
    candidate_code_commit: record.candidate_code_commit,
    evaluator_digest: record.evaluator_digest,
    id: record.id,
    key_id: record.key_id,
    kind: record.kind,
    schema_version: publicationEvidenceSchemaVersion
  };
  if (record.kind === "check") return { ...base, kind: "check", outcome: record.outcome };
  const review: PublicationEvidencePayload = { ...base, kind: record.kind, decision: record.decision };
  return record.configuration ? { ...review, configuration: record.configuration } : review;
}

export function canonicalPublicationEvidencePayload(record: PublicationEvidenceRecord): string {
  return canonicalJson(publicationEvidencePayload(record));
}

