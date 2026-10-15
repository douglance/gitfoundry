import { createHash } from "node:crypto";

import type { GitPublicationIntent } from "./index.js";

export class PrMergePublicationAdmissionError extends Error {
  readonly name = "PrMergePublicationAdmissionError";
}

export interface PrMergePublicationIntentInput {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly principalId: string;
  readonly pullRequestId: string;
  readonly eligibilityOperationId: string;
  readonly eligibilityGeneration: number;
  readonly targetRef: string;
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly expectedRepositoryVersion: number;
  readonly policyEpoch: number;
  readonly authorityFence: string;
  readonly userIdempotencyKey: string;
  readonly reason?: string;
}

const oidPattern = /^[0-9a-f]{40}$/u;
const refPattern = /^refs\/(heads|tags)\/[A-Za-z0-9._\/-]+$/u;
const invalidRefCharacterPattern = /[\x00-\x20\x7f~^:?*[\\\]]/u;

export function buildPrMergePublicationIntent(input: PrMergePublicationIntentInput): GitPublicationIntent {
  const tenantId = nonEmpty(input.tenantId, "tenantId");
  const repositoryId = nonEmpty(input.repositoryId, "repositoryId");
  const principalId = nonEmpty(input.principalId, "principalId");
  const pullRequestId = nonEmpty(input.pullRequestId, "pullRequestId");
  const eligibilityOperationId = nonEmpty(input.eligibilityOperationId, "eligibilityOperationId");
  const targetRef = validRef(input.targetRef);
  const baseSha = oid(input.baseSha, "baseSha");
  const candidateSha = oid(input.candidateSha, "candidateSha");
  const eligibilityGeneration = positiveInteger(input.eligibilityGeneration, "eligibilityGeneration");
  const expectedVersion = positiveInteger(input.expectedRepositoryVersion, "expectedRepositoryVersion");
  const policyEpoch = positiveInteger(input.policyEpoch, "policyEpoch");
  const authorityFence = nonEmpty(input.authorityFence, "authorityFence");
  const userIdempotencyKey = nonEmpty(input.userIdempotencyKey, "userIdempotencyKey");
  const idempotencyKey = "pr-merge:" + sha256(canonicalJson({ frame: "gitfoundry.pr-merge-publication.idempotency.v1", tenantId, repositoryId, pullRequestId, eligibilityOperationId, eligibilityGeneration, baseSha, candidateSha, userIdempotencyKey }));

  return {
    tenantId,
    repositoryId,
    principalId,
    operationId: "repo.ref-update",
    idempotencyKey,
    expectedVersion,
    policyEpoch,
    leaseFence: authorityFence,
    atomic: true,
    eligibilityId: eligibilityOperationId,
    reason: input.reason ?? `merge ${pullRequestId} checked candidate ${candidateSha}`,
    changes: [{ ref: targetRef, old_sha: baseSha, new_sha: candidateSha, force: false }]
  };
}

function nonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new PrMergePublicationAdmissionError(`${name} is required`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PrMergePublicationAdmissionError(`${name} must be a positive integer`);
  return value;
}

function oid(value: string, name: string): string {
  if (!oidPattern.test(value) || value === "0".repeat(40)) throw new PrMergePublicationAdmissionError(`${name} must be a Git object id`);
  return value;
}

function validRef(value: string): string {
  if (!refPattern.test(value) || invalidRefCharacterPattern.test(value) || value.includes("..") || value.includes("//") || value.includes("@{")) throw new PrMergePublicationAdmissionError("targetRef is invalid");
  if (value.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) throw new PrMergePublicationAdmissionError("targetRef is invalid");
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
