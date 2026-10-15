import { Context, Effect } from "effect";

import { DomainContractError, InvalidStateTransitionError, NotFoundError, StalePreconditionError, UnauthorizedError, type Actor, type Repository } from "../index.js";
import type { PullRequest } from "../forge/index.js";

export const checksImplementedOperationIds = ["check.list", "check.create", "check.edit", "pr.checks"] as const;

export type ChecksImplementedOperationId = typeof checksImplementedOperationIds[number];

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

export interface CheckOutput {
  readonly title: string;
  readonly summary: string;
  readonly text: string | null;
}

export interface CheckAnnotation {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly start_column: number | null;
  readonly end_column: number | null;
  readonly level: "notice" | "warning" | "failure";
  readonly message: string;
  readonly title: string | null;
  readonly raw_details: string | null;
}

export interface Check {
  readonly tenant_id: string;
  readonly id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly repository_id: string;
  readonly commit_sha: string;
  readonly evidence_kind: "native_job" | "external" | "historical";
  readonly candidate_bound: boolean;
  readonly head_sha: string;
  readonly base_sha: string | null;
  readonly execution_sha: string | null;
  readonly plan_digest: string | null;
  readonly policy_digest: string | null;
  readonly job_attempt_id: string | null;
  readonly provider_evidence_ref: string | null;
  readonly name: string;
  readonly producer_id: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  readonly details_url: string | null;
  readonly output: CheckOutput | null;
  readonly annotations: readonly CheckAnnotation[];
}

export interface CheckCreateInput {
  readonly repository_id: string;
  readonly commit_sha: string;
  readonly head_sha: string;
  readonly base_sha: string | null;
  readonly execution_sha: string | null;
  readonly plan_digest: string | null;
  readonly policy_digest: string | null;
  readonly job_attempt_id: string | null;
  readonly evidence_kind: Check["evidence_kind"];
  readonly candidate_bound: boolean;
  readonly provider_evidence_ref: string | null;
  readonly name: string;
  readonly status: Check["status"];
  readonly conclusion: Check["conclusion"];
  readonly details_url: string | null;
  readonly output: CheckOutput | null;
  readonly annotations: readonly CheckAnnotation[];
}

export interface CheckPatchInput {
  readonly status?: Check["status"];
  readonly conclusion?: Check["conclusion"];
  readonly details_url?: string | null;
  readonly output?: CheckOutput | null;
  readonly annotations_append?: readonly CheckAnnotation[];
}

export type CheckListQuery = Record<string, unknown> & { readonly repository_id: string };
export type PrChecksQuery = Record<string, unknown>;
export type CheckAnnotationQuery = Record<string, unknown>;

export interface TrustedRevision {
  readonly tenant_id: string;
  readonly repository_id: string;
  readonly sha: string;
}

export interface CheckJobAttempt {
  readonly tenant_id: string;
  readonly id: string;
}

export type CheckStoreError = DomainContractError | InvalidStateTransitionError | NotFoundError | StalePreconditionError | UnauthorizedError;

export interface CheckStore {
  readonly list: (tenantId: string, query: CheckListQuery) => Effect.Effect<Page<Check>, NotFoundError>;
  readonly listForPullRequest: (tenantId: string, pullRequestId: string, query: PrChecksQuery) => Effect.Effect<Page<Check>, NotFoundError>;
  readonly view: (tenantId: string, id: string) => Effect.Effect<Check, NotFoundError>;
  readonly listAnnotations: (tenantId: string, id: string, query: CheckAnnotationQuery) => Effect.Effect<Page<CheckAnnotation>, NotFoundError>;
  readonly create: (tenantId: string, actor: Actor, input: CheckCreateInput) => Effect.Effect<Check, CheckStoreError>;
  readonly update: (tenantId: string, id: string, actor: Actor, expectedVersion: number, input: CheckPatchInput) => Effect.Effect<Check, CheckStoreError>;
}

export const CheckStore = Context.Service<CheckStore>("gitfoundry/CheckStore");

export function isChecksImplementedOperationId(operationId: string): operationId is ChecksImplementedOperationId {
  return (checksImplementedOperationIds as readonly string[]).includes(operationId);
}

export function makeFakeCheckStore(input: {
  readonly repositories: readonly Repository[];
  readonly pullRequests?: readonly PullRequest[];
  readonly checks?: readonly Check[];
  readonly trustedRevisions?: readonly TrustedRevision[];
  readonly jobAttempts?: readonly CheckJobAttempt[];
  readonly now?: string;
}): CheckStore {
  const now = input.now ?? "2026-10-08T00:00:00Z";
  const repositories = new Map(input.repositories.map((repository) => [key(repository.tenant_id, repository.id), { ...repository }]));
  const pullRequests = new Map((input.pullRequests ?? []).map((pullRequest) => [key(pullRequest.tenant_id, pullRequest.id), { ...pullRequest }]));
  const checks = new Map((input.checks ?? []).map((check) => [key(check.tenant_id, check.id), copyCheck(check)]));
  const trustedRevisions = new Set((input.trustedRevisions ?? []).map((revision) => revisionKey(revision.tenant_id, revision.repository_id, revision.sha)));
  const jobAttempts = new Set((input.jobAttempts ?? []).map((attempt) => key(attempt.tenant_id, attempt.id)));

  return {
    list: (tenantId, query) => Effect.gen(function* () {
      yield* requireRepository(repositories, tenantId, query.repository_id);
      return page(sortChecks(Array.from(checks.values()).filter((check) => check.tenant_id === tenantId && check.repository_id === query.repository_id && matchesQuery(check, query)), query).map(copyCheck));
    }),
    listForPullRequest: (tenantId, pullRequestId, query) => Effect.gen(function* () {
      const pullRequest = yield* getPullRequest(pullRequests, tenantId, pullRequestId);
      yield* requireRepository(repositories, tenantId, pullRequest.repository_id);
      return page(sortChecks(Array.from(checks.values()).filter((check) => check.tenant_id === tenantId && check.repository_id === pullRequest.repository_id && check.head_sha === pullRequest.head_sha && matchesQuery(check, query)), query).map(copyCheck));
    }),
    view: (tenantId, id) => Effect.gen(function* () {
      const check = yield* getCheck(checks, tenantId, id);
      yield* requireRepository(repositories, tenantId, check.repository_id);
      return copyCheck(check);
    }),
    listAnnotations: (tenantId, id, query) => Effect.gen(function* () {
      const check = yield* getCheck(checks, tenantId, id);
      yield* requireRepository(repositories, tenantId, check.repository_id);
      return pageCheckAnnotations(check.annotations, query);
    }),
    create: (tenantId, actor, request) => Effect.gen(function* () {
      yield* requireRepository(repositories, tenantId, request.repository_id);
      yield* validateCheckCreate(tenantId, request, trustedRevisions, jobAttempts);
      const check: Check = {
        tenant_id: tenantId,
        id: makeId("check", request.repository_id, nextNumber(checks, tenantId, request.repository_id)),
        version: 1,
        created_at: now,
        updated_at: now,
        repository_id: request.repository_id,
        commit_sha: request.commit_sha,
        evidence_kind: request.evidence_kind,
        candidate_bound: request.candidate_bound,
        head_sha: request.head_sha,
        base_sha: request.base_sha,
        execution_sha: request.execution_sha,
        plan_digest: request.plan_digest,
        policy_digest: request.policy_digest,
        job_attempt_id: request.job_attempt_id,
        provider_evidence_ref: request.provider_evidence_ref,
        name: request.name,
        producer_id: actor.id,
        status: request.status,
        conclusion: request.conclusion,
        details_url: request.details_url,
        output: copyOutput(request.output),
        annotations: copyAnnotations(request.annotations)
      };
      checks.set(key(tenantId, check.id), copyCheck(check));
      return copyCheck(check);
    }),
    update: (tenantId, id, actor, expectedVersion, patch) => Effect.gen(function* () {
      const current = yield* getCheck(checks, tenantId, id);
      yield* requireRepository(repositories, tenantId, current.repository_id);
      if (current.producer_id !== actor.id) return yield* Effect.fail(new UnauthorizedError({ reason: "check producer mismatch", actorId: actor.id, tenantId, capability: "check.write" }));
      yield* requireVersion(expectedVersion, current.version);
      const updated = yield* transitionCheck(current, patch, now);
      checks.set(key(tenantId, id), copyCheck(updated));
      return copyCheck(updated);
    })
  };
}

export function validateCheckCreateInput(tenantId: string, input: CheckCreateInput, trustedRevisions: ReadonlySet<string>, jobAttempts: ReadonlySet<string>): Effect.Effect<void, DomainContractError | NotFoundError> {
  return validateCheckCreate(tenantId, input, trustedRevisions, jobAttempts);
}

export function validateCheckPatch(current: Check, patch: CheckPatchInput, now: string): Effect.Effect<Check, DomainContractError | InvalidStateTransitionError> {
  return transitionCheck(current, patch, now);
}

export function pageCheckAnnotations(annotations: readonly CheckAnnotation[], query: CheckAnnotationQuery): Page<CheckAnnotation> {
  const start = annotationCursor(query.cursor);
  const limit = annotationLimit(query.limit);
  const items = copyAnnotations(annotations.slice(start, start + limit));
  const next = start + items.length;
  return { items, next_cursor: next < annotations.length ? String(next) : null, has_more: next < annotations.length };
}

function validateCheckCreate(tenantId: string, input: CheckCreateInput, trustedRevisions: ReadonlySet<string>, jobAttempts: ReadonlySet<string>): Effect.Effect<void, DomainContractError | NotFoundError> {
  return Effect.gen(function* () {
    yield* requireTrustedRevision(tenantId, input.repository_id, input.commit_sha, trustedRevisions);
    yield* requireTrustedRevision(tenantId, input.repository_id, input.head_sha, trustedRevisions);
    if (input.base_sha !== null) yield* requireTrustedRevision(tenantId, input.repository_id, input.base_sha, trustedRevisions);
    if (input.execution_sha !== null) yield* requireTrustedRevision(tenantId, input.repository_id, input.execution_sha, trustedRevisions);
    if (input.candidate_bound) {
      if (!input.base_sha || !input.execution_sha || !input.plan_digest || !input.policy_digest) return yield* domainError("candidate-bound checks require base_sha, execution_sha, plan_digest, and policy_digest");
      if (input.commit_sha !== input.execution_sha) return yield* domainError("candidate-bound checks must report commit_sha equal to execution_sha");
    } else if (input.commit_sha !== input.head_sha) {
      return yield* domainError("head-only checks must report commit_sha equal to head_sha");
    }
    if (input.evidence_kind === "native_job") {
      if (!input.job_attempt_id) return yield* domainError("native_job checks require job_attempt_id");
      if (input.provider_evidence_ref !== null) return yield* domainError("native_job checks must not use provider_evidence_ref");
      if (!jobAttempts.has(key(tenantId, input.job_attempt_id))) return yield* Effect.fail(new NotFoundError({ resource: "job_attempt", id: input.job_attempt_id }));
    } else {
      if (input.job_attempt_id !== null) return yield* domainError("external and historical checks must not use job_attempt_id");
      if (!input.provider_evidence_ref) return yield* domainError("external and historical checks require provider_evidence_ref");
    }
    if (input.evidence_kind === "historical") {
      if (input.candidate_bound) return yield* domainError("historical checks must be head-only");
      if (input.status !== "completed") return yield* domainError("historical checks must be completed");
    }
    yield* requireConclusionForStatus(input.status, input.conclusion);
    yield* validateCheckAnnotations(input.annotations);
  });
}

function transitionCheck(current: Check, patch: CheckPatchInput, now: string): Effect.Effect<Check, DomainContractError | InvalidStateTransitionError> {
  return Effect.gen(function* () {
    if (current.status === "completed") return yield* Effect.fail(new InvalidStateTransitionError({ resource: "check", id: current.id, state: "completed", expectedState: "non_terminal" }));
    const status = patch.status ?? current.status;
    const conclusion = patch.conclusion !== undefined ? patch.conclusion : current.conclusion;
    yield* requireConclusionForStatus(status, conclusion);
    const annotations = patch.annotations_append ? [...current.annotations, ...copyAnnotations(patch.annotations_append)] : copyAnnotations(current.annotations);
    yield* validateCheckAnnotations(annotations);
    return {
      ...current,
      version: current.version + 1,
      updated_at: now,
      status,
      conclusion,
      details_url: patch.details_url !== undefined ? patch.details_url : current.details_url,
      output: patch.output !== undefined ? copyOutput(patch.output) : copyOutput(current.output),
      annotations
    };
  });
}

function requireConclusionForStatus(status: Check["status"], conclusion: Check["conclusion"]): Effect.Effect<void, DomainContractError> {
  if (status === "completed" && conclusion === null) return domainError("completed checks require a terminal conclusion");
  if (status !== "completed" && conclusion !== null) return domainError("queued and in_progress checks must have null conclusion");
  return Effect.void;
}

function validateCheckAnnotations(annotations: readonly CheckAnnotation[]): Effect.Effect<void, DomainContractError> {
  return Effect.gen(function* () {
    if (annotations.length > 50) return yield* domainError("checks may contain at most 50 annotations");
    for (const annotation of annotations) yield* validateCheckAnnotation(annotation);
  });
}

function validateCheckAnnotation(annotation: CheckAnnotation): Effect.Effect<void, DomainContractError> {
  if (annotation.path.length < 1 || annotation.path.length > 1024) return domainError("check annotation path must be 1-1024 characters");
  if (!isPositiveInteger(annotation.start_line) || !isPositiveInteger(annotation.end_line)) return domainError("check annotation line numbers must be positive integers");
  if (!isNullablePositiveInteger(annotation.start_column) || !isNullablePositiveInteger(annotation.end_column)) return domainError("check annotation columns must be null or positive integers");
  if (annotation.level !== "notice" && annotation.level !== "warning" && annotation.level !== "failure") return domainError("check annotation level is invalid");
  if (annotation.message.length < 1 || annotation.message.length > 65536) return domainError("check annotation message must be 1-65536 characters");
  if (annotation.title !== null && annotation.title.length > 512) return domainError("check annotation title must be at most 512 characters");
  if (annotation.raw_details !== null && annotation.raw_details.length > 65536) return domainError("check annotation raw_details must be at most 65536 characters");
  return Effect.void;
}

function requireTrustedRevision(tenantId: string, repositoryId: string, sha: string, trustedRevisions: ReadonlySet<string>): Effect.Effect<void, NotFoundError> {
  return trustedRevisions.has(revisionKey(tenantId, repositoryId, sha)) ? Effect.void : Effect.fail(new NotFoundError({ resource: "git_revision", id: sha }));
}

function matchesQuery(check: Check, query: Record<string, unknown>): boolean {
  const record = check as unknown as Record<string, unknown>;
  for (const [queryKey, queryValue] of Object.entries(query)) {
    if (queryValue === undefined || queryValue === null || queryKey === "cursor" || queryKey === "limit" || queryKey === "sort" || queryKey === "direction") continue;
    if (queryKey === "since") {
      if (typeof queryValue === "string" && check.updated_at < queryValue) return false;
      continue;
    }
    if (record[queryKey] !== queryValue) return false;
  }
  return true;
}

function sortChecks<T extends Check>(items: readonly T[], query: Record<string, unknown>): readonly T[] {
  const field = query.sort === "updated_at" || query.sort === "id" ? query.sort : "created_at";
  const direction = query.direction === "asc" ? 1 : -1;
  const limit = Number.isInteger(query.limit) ? Math.max(0, Math.min(1000, query.limit as number)) : 1000;
  return [...items].sort((left, right) => String(left[field]).localeCompare(String(right[field])) * direction || left.id.localeCompare(right.id) * direction).slice(0, limit);
}

function annotationLimit(value: unknown): number { return Number.isInteger(value) ? Math.max(1, Math.min(50, value as number)) : 50; }
function annotationCursor(value: unknown): number { return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0; }
function isPositiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 1; }
function isNullablePositiveInteger(value: unknown): boolean { return value === null || isPositiveInteger(value); }

function page<T>(items: readonly T[]): Page<T> { return { items, next_cursor: null, has_more: false }; }
function key(tenantId: string, id: string): string { return tenantId + ":" + id; }
function revisionKey(tenantId: string, repositoryId: string, sha: string): string { return tenantId + ":" + repositoryId + ":" + sha; }
function makeId(kind: string, repositoryId: string, number: number): string { return repositoryId + "-" + kind + "-" + number; }
function nextNumber<T extends { readonly tenant_id: string; readonly repository_id: string }>(items: Map<string, T>, tenantId: string, repositoryId: string): number { return Array.from(items.values()).filter((item) => item.tenant_id === tenantId && item.repository_id === repositoryId).length + 1; }
function requireVersion(expected: number, actual: number): Effect.Effect<void, StalePreconditionError> { return expected === actual ? Effect.void : Effect.fail(new StalePreconditionError({ expected, actual })); }
function requireRepository(repositories: Map<string, Repository>, tenantId: string, id: string): Effect.Effect<Repository, NotFoundError> { const repository = repositories.get(key(tenantId, id)); return repository ? Effect.succeed({ ...repository }) : Effect.fail(new NotFoundError({ resource: "repository", id })); }
function getPullRequest(pullRequests: Map<string, PullRequest>, tenantId: string, id: string): Effect.Effect<PullRequest, NotFoundError> { const pullRequest = pullRequests.get(key(tenantId, id)); return pullRequest ? Effect.succeed({ ...pullRequest }) : Effect.fail(new NotFoundError({ resource: "pull_request", id })); }
function getCheck(checks: Map<string, Check>, tenantId: string, id: string): Effect.Effect<Check, NotFoundError> { const check = checks.get(key(tenantId, id)); return check ? Effect.succeed(copyCheck(check)) : Effect.fail(new NotFoundError({ resource: "check", id })); }
function domainError(message: string): Effect.Effect<never, DomainContractError> { return Effect.fail(new DomainContractError({ message })); }
function copyOutput(output: CheckOutput | null): CheckOutput | null { return output ? { ...output } : null; }
function copyAnnotations(annotations: readonly CheckAnnotation[]): readonly CheckAnnotation[] { return annotations.map((annotation) => ({ ...annotation })); }
function copyCheck(check: Check): Check { return { ...check, output: copyOutput(check.output), annotations: copyAnnotations(check.annotations) }; }
