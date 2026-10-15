import { Effect } from "effect";

import { DomainContractError, InvalidStateTransitionError, NotFoundError, StalePreconditionError, UnauthorizedError, type Actor } from "../index.js";
import { pageCheckAnnotations, type Check, type CheckAnnotation, type CheckAnnotationQuery, type CheckCreateInput, type CheckListQuery, type CheckOutput, type CheckPatchInput, type CheckStore as CoreCheckStore, type PrChecksQuery, validateCheckCreateInput, validateCheckPatch } from "../checks/index.js";
import type { Clock, D1DatabaseLike } from "./index.js";
import { GitReferenceUnavailableError, assertQualifiedSha, type QualifiedGitReadPort } from "./forge.js";

const systemClock: Clock = { now: () => new Date() };

export interface CandidateCheckQualificationRequest {
  readonly tenantId: string;
  readonly targetRepositoryId: string;
  readonly producerId: string;
  readonly context: string;
  readonly commitSha: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly executionSha: string;
  readonly planDigest: string;
  readonly policyDigest: string;
  readonly actor: Actor;
  readonly input: CheckCreateInput;
}

export interface CandidateCheckWriteFence {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
}

export interface CandidateCheckQualificationProof {
  readonly tenantId: string;
  readonly targetRepositoryId: string;
  readonly sourceRepositoryId: string;
  readonly producerId: string;
  readonly context: string;
  readonly candidateSha: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly planDigest: string;
  readonly policyDigest: string;
  readonly eligibilityId: string;
  readonly prId: string;
  readonly evidenceKind: CheckCreateInput["evidence_kind"];
  readonly jobAttemptId: string | null;
  readonly providerEvidenceRef: string | null;
  readonly status: CheckCreateInput["status"];
  readonly conclusion: CheckCreateInput["conclusion"];
  readonly writeFence: CandidateCheckWriteFence;
}

export interface CandidateCheckQualificationPort {
  readonly qualifyCandidateCheck: (request: CandidateCheckQualificationRequest) => Effect.Effect<CandidateCheckQualificationProof, DomainContractError>;
}

interface D1CheckStoreOptions {
  readonly clock?: Clock | undefined;
  readonly gitRead?: QualifiedGitReadPort | undefined;
  readonly candidateChecks?: CandidateCheckQualificationPort | undefined;
}

export function makeD1CheckStore(db: D1DatabaseLike, options: D1CheckStoreOptions = {}): CoreCheckStore {
  const clock = options.clock ?? systemClock;
  return {
    list: (tenantId, query) => Effect.tryPromise({ try: async () => {
      await requireRepository(db, tenantId, query.repository_id);
      return { items: await listChecks(db, tenantId, query), next_cursor: null, has_more: false };
    }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "check", id: query.repository_id }) }),
    listForPullRequest: (tenantId, pullRequestId, query) => Effect.tryPromise({ try: async () => {
      const pullRequest = await readPullRequestHead(db, tenantId, pullRequestId);
      if (!pullRequest) throw new NotFoundError({ resource: "pull_request", id: pullRequestId });
      await requireRepository(db, tenantId, pullRequest.repository_id);
      return { items: await listChecks(db, tenantId, { ...query, repository_id: pullRequest.repository_id, head_sha: pullRequest.head_sha }), next_cursor: null, has_more: false };
    }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "pull_request", id: pullRequestId }) }),
    view: (tenantId, id) => Effect.tryPromise({ try: async () => {
      const check = await readCheck(db, tenantId, id);
      if (!check) throw new NotFoundError({ resource: "check", id });
      await requireRepository(db, tenantId, check.repository_id);
      return check;
    }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "check", id }) }),
    listAnnotations: (tenantId, id, query) => Effect.tryPromise({ try: async () => {
      const check = await readCheck(db, tenantId, id);
      if (!check) throw new NotFoundError({ resource: "check", id });
      await requireRepository(db, tenantId, check.repository_id);
      return pageCheckAnnotations(check.annotations, query);
    }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "check", id }) }),
    create: (tenantId, actor, input) => Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => requireRepository(db, tenantId, input.repository_id), catch: () => new NotFoundError({ resource: "repository", id: input.repository_id }) });
      const authority = yield* Effect.tryPromise({ try: () => requireActivePrincipal(db, tenantId, actor.id), catch: (error) => error instanceof UnauthorizedError ? error : new UnauthorizedError({ reason: String(error), actorId: actor.id, tenantId, capability: "check.write" }) });
      const candidateFence = yield* Effect.mapError(requireQualifiedRevisions(tenantId, actor, input, options), (error) => error instanceof DomainContractError ? error : new DomainContractError({ message: error.reason }));
      const jobAttempts = yield* Effect.promise(async () => new Set((await db.prepare("SELECT id FROM job_attempts WHERE tenant_id = ?").bind(tenantId).all<{ id: string }>()).results?.map((row) => tenantId + ":" + row.id) ?? []));
      yield* validateCheckCreateInput(tenantId, input, new Set([input.commit_sha, input.head_sha, input.base_sha, input.execution_sha].filter((sha): sha is string => typeof sha === "string").map((sha) => tenantId + ":" + input.repository_id + ":" + sha)), jobAttempts);
      return yield* Effect.tryPromise({ try: async () => {
        const now = clock.now().toISOString();
        const id = `check-${crypto.randomUUID()}`;
        const result = await db.prepare("INSERT INTO checks(tenant_id,id,version,created_at,updated_at,repository_id,commit_sha,evidence_kind,candidate_bound,head_sha,base_sha,execution_sha,plan_digest,policy_digest,job_attempt_id,provider_evidence_ref,name,producer_id,status,conclusion,source_run_id,details_key) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,? WHERE " + checkWriteAuthoritySql + candidateWriteFenceSql(candidateFence)).bind(tenantId, id, 1, now, now, input.repository_id, input.commit_sha, input.evidence_kind, input.candidate_bound ? 1 : 0, input.head_sha, input.base_sha, input.execution_sha, input.plan_digest, input.policy_digest, input.job_attempt_id, input.provider_evidence_ref, input.name, actor.id, input.status, input.conclusion, encodeDetails(input.details_url, input.output, input.annotations), tenantId, actor.id, authority.auth_epoch, authority.policy_epoch, ...(candidateFence?.bindings ?? [])).run();
        if (result.meta?.changes !== 1) {
          await requireUnchangedCheckAuthority(db, tenantId, actor.id, authority);
          throw new DomainContractError({ message: "check insert was not applied" });
        }
        const created = await readCheck(db, tenantId, id);
        if (!created) throw new NotFoundError({ resource: "check", id });
        return created;
      }, catch: (error) => error instanceof NotFoundError || error instanceof UnauthorizedError || error instanceof DomainContractError ? error : new DomainContractError({ message: String(error) }) });
    }),
    update: (tenantId, id, actor, expectedVersion, input) => Effect.gen(function* () {
      const current = yield* Effect.tryPromise({ try: async () => { const check = await readCheck(db, tenantId, id); if (!check) throw new NotFoundError({ resource: "check", id }); return check; }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "check", id }) });
      yield* Effect.tryPromise({ try: () => requireRepository(db, tenantId, current.repository_id), catch: () => new NotFoundError({ resource: "repository", id: current.repository_id }) });
      const authority = yield* Effect.tryPromise({ try: () => requireActivePrincipal(db, tenantId, actor.id), catch: (error) => error instanceof UnauthorizedError ? error : new UnauthorizedError({ reason: String(error), actorId: actor.id, tenantId, capability: "check.write" }) });
      if (current.producer_id !== actor.id) return yield* Effect.fail(new UnauthorizedError({ reason: "check producer mismatch", actorId: actor.id, tenantId, capability: "check.write" }));
      if (current.version !== expectedVersion) return yield* Effect.fail(new StalePreconditionError({ expected: expectedVersion, actual: current.version }));
      const next = yield* validateCheckPatch(current, input, clock.now().toISOString());
      let candidateFence: CandidateCheckWriteFence | null = null;
      if (next.candidate_bound) {
        candidateFence = yield* requireQualifiedCandidateCheck(tenantId, actor, {
          repository_id: next.repository_id, commit_sha: next.commit_sha, head_sha: next.head_sha,
          base_sha: next.base_sha, execution_sha: next.execution_sha, plan_digest: next.plan_digest,
          policy_digest: next.policy_digest, job_attempt_id: next.job_attempt_id, evidence_kind: next.evidence_kind,
          candidate_bound: next.candidate_bound, provider_evidence_ref: next.provider_evidence_ref, name: next.name,
          status: next.status, conclusion: next.conclusion, details_url: next.details_url,
          output: next.output, annotations: next.annotations
        }, options.candidateChecks);
      }
      return yield* Effect.tryPromise({ try: async () => {
        const result = await db.prepare("UPDATE checks SET version = version + 1, updated_at = ?, status = ?, conclusion = ?, details_key = ? WHERE tenant_id = ? AND id = ? AND version = ? AND " + checkWriteAuthoritySql + candidateWriteFenceSql(candidateFence)).bind(next.updated_at, next.status, next.conclusion, encodeDetails(next.details_url, next.output, next.annotations), tenantId, id, expectedVersion, tenantId, actor.id, authority.auth_epoch, authority.policy_epoch, ...(candidateFence?.bindings ?? [])).run();
        if (result.meta?.changes !== 1) {
          await requireUnchangedCheckAuthority(db, tenantId, actor.id, authority);
          const observed = await readCheck(db, tenantId, id);
          if (!observed) throw new NotFoundError({ resource: "check", id });
          throw new StalePreconditionError({ expected: expectedVersion, actual: observed.version });
        }
        const updated = await readCheck(db, tenantId, id);
        if (!updated) throw new NotFoundError({ resource: "check", id });
        if (updated.version !== expectedVersion + 1) throw new StalePreconditionError({ expected: expectedVersion, actual: updated.version });
        return updated;
      }, catch: (error) => error instanceof NotFoundError || error instanceof StalePreconditionError || error instanceof UnauthorizedError ? error : new DomainContractError({ message: String(error) }) });
    })
  };
}

function requireQualifiedRevisions(tenantId: string, actor: Actor, input: CheckCreateInput, options: D1CheckStoreOptions): Effect.Effect<CandidateCheckWriteFence | null, GitReferenceUnavailableError | DomainContractError> {
  if (input.candidate_bound) return requireQualifiedCandidateCheck(tenantId, actor, input, options.candidateChecks);
  if (!options.gitRead) return Effect.fail(new GitReferenceUnavailableError({ reason: "qualified Git read port is not configured", repositoryId: input.repository_id, ref: input.commit_sha }));
  const gitRead = options.gitRead;
  return Effect.gen(function* () {
    yield* requireExactRevision(gitRead, tenantId, input.repository_id, input.commit_sha);
    yield* requireExactRevision(gitRead, tenantId, input.repository_id, input.head_sha);
    if (input.base_sha) yield* requireExactRevision(gitRead, tenantId, input.repository_id, input.base_sha);
    if (input.execution_sha) yield* requireExactRevision(gitRead, tenantId, input.repository_id, input.execution_sha);
    return null;
  });
}

function requireQualifiedCandidateCheck(tenantId: string, actor: Actor, input: CheckCreateInput, candidateChecks: CandidateCheckQualificationPort | undefined): Effect.Effect<CandidateCheckWriteFence, DomainContractError> {
  if (!input.base_sha || !input.execution_sha || !input.plan_digest || !input.policy_digest) return Effect.fail(new DomainContractError({ message: "candidate-bound checks require base_sha, execution_sha, plan_digest, and policy_digest" }));
  if (input.commit_sha !== input.execution_sha) return Effect.fail(new DomainContractError({ message: "candidate-bound checks must report commit_sha equal to execution_sha" }));
  if (!candidateChecks) return Effect.fail(new DomainContractError({ message: "candidate-bound checks require a trusted candidate qualification port" }));
  const request: CandidateCheckQualificationRequest = {
    tenantId,
    targetRepositoryId: input.repository_id,
    producerId: actor.id,
    context: input.name,
    commitSha: input.commit_sha,
    headSha: input.head_sha,
    baseSha: input.base_sha,
    executionSha: input.execution_sha,
    planDigest: input.plan_digest,
    policyDigest: input.policy_digest,
    actor,
    input
  };
  return Effect.gen(function* () {
    const proof = yield* candidateChecks.qualifyCandidateCheck(request);
    const mismatch = candidateProofMismatch(request, proof);
    if (mismatch) return yield* Effect.fail(new DomainContractError({ message: mismatch }));
    return { sql: proof.writeFence.sql, bindings: [...proof.writeFence.bindings] };
  });
}

function candidateProofMismatch(request: CandidateCheckQualificationRequest, proof: CandidateCheckQualificationProof | unknown): string | null {
  if (!isCandidateCheckQualificationProofRecord(proof)) return "candidate proof is malformed";
  if (proof.tenantId !== request.tenantId) return "candidate proof tenant mismatch";
  if (proof.targetRepositoryId !== request.targetRepositoryId) return "candidate proof target repository mismatch";
  if (proof.sourceRepositoryId.trim().length === 0) return "candidate proof source repository is missing";
  if (proof.producerId !== request.producerId) return "candidate proof producer mismatch";
  if (proof.context !== request.context) return "candidate proof context mismatch";
  if (proof.candidateSha !== request.commitSha || proof.candidateSha !== request.executionSha) return "candidate proof candidate SHA mismatch";
  if (proof.headSha !== request.headSha) return "candidate proof head SHA mismatch";
  if (proof.baseSha !== request.baseSha) return "candidate proof base SHA mismatch";
  if (proof.planDigest !== request.planDigest) return "candidate proof plan digest mismatch";
  if (proof.policyDigest !== request.policyDigest) return "candidate proof policy digest mismatch";
  if (proof.eligibilityId.trim().length === 0) return "candidate proof eligibility is missing";
  if (proof.prId.trim().length === 0) return "candidate proof pull request is missing";
  if (proof.evidenceKind !== request.input.evidence_kind) return "candidate proof evidence kind mismatch";
  if (proof.jobAttemptId !== request.input.job_attempt_id) return "candidate proof job attempt mismatch";
  if (proof.providerEvidenceRef !== request.input.provider_evidence_ref) return "candidate proof provider evidence mismatch";
  if (proof.status !== request.input.status) return "candidate proof status mismatch";
  if (proof.conclusion !== request.input.conclusion) return "candidate proof conclusion mismatch";
  return null;
}

function isCandidateCheckQualificationProofRecord(proof: unknown): proof is CandidateCheckQualificationProof {
  if (!proof || typeof proof !== "object") return false;
  const record = proof as Record<string, unknown>;
  return typeof record.tenantId === "string"
    && typeof record.targetRepositoryId === "string"
    && typeof record.sourceRepositoryId === "string"
    && typeof record.producerId === "string"
    && typeof record.context === "string"
    && typeof record.candidateSha === "string"
    && typeof record.headSha === "string"
    && typeof record.baseSha === "string"
    && typeof record.planDigest === "string"
    && typeof record.policyDigest === "string"
    && typeof record.eligibilityId === "string"
    && typeof record.prId === "string"
    && typeof record.evidenceKind === "string"
    && (record.jobAttemptId === null || typeof record.jobAttemptId === "string")
    && (record.providerEvidenceRef === null || typeof record.providerEvidenceRef === "string")
    && typeof record.status === "string"
    && (record.conclusion === null || typeof record.conclusion === "string")
    && isCandidateCheckWriteFence(record.writeFence);
}

function isCandidateCheckWriteFence(value: unknown): value is CandidateCheckWriteFence {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.sql === "string" && record.sql.trim().length > 0 && record.sql.length <= 65536 && !record.sql.includes("\u0000")
    && Array.isArray(record.bindings) && record.bindings.length <= 75
    && record.bindings.every((binding: unknown) => binding === null || typeof binding === "string" || (typeof binding === "number" && Number.isSafeInteger(binding)));
}

function candidateWriteFenceSql(fence: CandidateCheckWriteFence | null): string {
  return fence ? " AND (" + fence.sql + ")" : "";
}

function requireExactRevision(gitRead: QualifiedGitReadPort, tenantId: string, repositoryId: string, sha: string): Effect.Effect<void, GitReferenceUnavailableError> {
  assertQualifiedSha(sha, repositoryId, sha);
  return Effect.gen(function* () {
    const resolved = yield* gitRead.resolveRef({ tenantId, repositoryId, ref: sha });
    const qualified = assertQualifiedSha(resolved.sha, repositoryId, sha);
    if (qualified.sha !== sha) return yield* Effect.fail(new GitReferenceUnavailableError({ reason: "qualified Git read port resolved a different SHA", repositoryId, ref: sha }));
  });
}

async function listChecks(db: D1DatabaseLike, tenantId: string, query: CheckListQuery | PrChecksQuery & { repository_id: string; head_sha?: string } | CheckAnnotationQuery): Promise<readonly Check[]> {
  const params: unknown[] = [tenantId];
  const filters = ["tenant_id = ?"];
  const add = (field: string, value: unknown) => { if (value !== undefined && value !== null) { filters.push(`${field} = ?`); params.push(value) } };
  add("repository_id", (query as Record<string, unknown>).repository_id);
  add("commit_sha", (query as Record<string, unknown>).commit_sha);
  add("head_sha", (query as Record<string, unknown>).head_sha);
  add("name", (query as Record<string, unknown>).name);
  add("producer_id", (query as Record<string, unknown>).producer_id);
  add("status", (query as Record<string, unknown>).status);
  add("evidence_kind", (query as Record<string, unknown>).evidence_kind);
  if (typeof (query as Record<string, unknown>).candidate_bound === "boolean") add("candidate_bound", (query as Record<string, unknown>).candidate_bound ? 1 : 0);
  if (typeof (query as Record<string, unknown>).since === "string") { filters.push("updated_at >= ?"); params.push((query as Record<string, unknown>).since) }
  const rows = await db.prepare(`${checkSelectSql()} WHERE ${filters.join(" AND ")} ORDER BY ${sortColumn(typeof (query as Record<string, unknown>).sort === "string" ? String((query as Record<string, unknown>).sort) : undefined)} ${sortDirection(typeof (query as Record<string, unknown>).direction === "string" ? String((query as Record<string, unknown>).direction) : undefined)}, id ${sortDirection(typeof (query as Record<string, unknown>).direction === "string" ? String((query as Record<string, unknown>).direction) : undefined)} LIMIT ?`).bind(...params, readLimit((query as Record<string, unknown>).limit)).all<CheckRow>();
  return (rows.results ?? []).map(toCheck);
}

async function readCheck(db: D1DatabaseLike, tenantId: string, id: string): Promise<Check | undefined> {
  const row = await db.prepare(`${checkSelectSql()} WHERE tenant_id = ? AND id = ? LIMIT 1`).bind(tenantId, id).first<CheckRow>();
  return row ? toCheck(row) : undefined;
}

async function readPullRequestHead(db: D1DatabaseLike, tenantId: string, id: string): Promise<{ readonly repository_id: string; readonly head_sha: string } | undefined> {
  const row = await db.prepare("SELECT repository_id, head_sha FROM pull_requests WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, id).first<{ repository_id: string; head_sha: string }>();
  return row ?? undefined;
}

async function requireRepository(db: D1DatabaseLike, tenantId: string, id: string): Promise<void> {
  const row = await db.prepare("SELECT id FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, id).first<{ id: string }>();
  if (!row) throw new NotFoundError({ resource: "repository", id });
}

interface CheckWriteAuthority {
  readonly auth_epoch: number;
  readonly policy_epoch: number;
}

const checkWriteAuthoritySql = "EXISTS (SELECT 1 FROM principals p JOIN tenants t ON t.id = p.tenant_id WHERE p.tenant_id = ? AND p.id = ? AND p.active = 1 AND p.auth_epoch = ? AND t.state = 'active' AND t.policy_epoch = ?)";

async function requireActivePrincipal(db: D1DatabaseLike, tenantId: string, id: string): Promise<CheckWriteAuthority> {
  const row = await db.prepare("SELECT p.active, p.auth_epoch, t.state, t.policy_epoch FROM principals p JOIN tenants t ON t.id = p.tenant_id WHERE p.tenant_id = ? AND p.id = ? LIMIT 1").bind(tenantId, id).first<{ active: number; auth_epoch: number; state: string; policy_epoch: number }>();
  if (!row || row.active !== 1 || row.state !== "active" || !Number.isSafeInteger(row.auth_epoch) || !Number.isSafeInteger(row.policy_epoch)) throw new UnauthorizedError({ reason: "check producer or tenant inactive or missing", actorId: id, tenantId, capability: "check.write" });
  return { auth_epoch: row.auth_epoch, policy_epoch: row.policy_epoch };
}

async function requireUnchangedCheckAuthority(db: D1DatabaseLike, tenantId: string, actorId: string, expected: CheckWriteAuthority): Promise<void> {
  const current = await requireActivePrincipal(db, tenantId, actorId);
  if (current.auth_epoch !== expected.auth_epoch || current.policy_epoch !== expected.policy_epoch) throw new UnauthorizedError({ reason: "check write authority changed before commit", actorId, tenantId, capability: "check.write" });
}

function checkSelectSql(): string {
  return "SELECT tenant_id,id,version,created_at,updated_at,repository_id,commit_sha,evidence_kind,candidate_bound,head_sha,base_sha,execution_sha,plan_digest,policy_digest,job_attempt_id,provider_evidence_ref,name,producer_id,status,conclusion,details_key FROM checks";
}

function toCheck(row: CheckRow): Check {
  const details = decodeDetails(row.details_key);
  return { tenant_id: row.tenant_id, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, repository_id: row.repository_id, commit_sha: row.commit_sha, evidence_kind: row.evidence_kind, candidate_bound: row.candidate_bound === 1, head_sha: row.head_sha, base_sha: row.base_sha, execution_sha: row.execution_sha, plan_digest: row.plan_digest, policy_digest: row.policy_digest, job_attempt_id: row.job_attempt_id, provider_evidence_ref: row.provider_evidence_ref, name: row.name, producer_id: row.producer_id, status: row.status, conclusion: row.conclusion, details_url: details.details_url, output: details.output, annotations: details.annotations };
}

function encodeDetails(details_url: string | null, output: CheckOutput | null, annotations: readonly CheckAnnotation[]): string {
  return JSON.stringify({ details_url, output, annotations });
}

function decodeDetails(value: string): { readonly details_url: string | null; readonly output: CheckOutput | null; readonly annotations: readonly CheckAnnotation[] } {
  try {
    const parsed = JSON.parse(value) as Partial<{ details_url: string | null; output: CheckOutput | null; annotations: readonly CheckAnnotation[] }>;
    return { details_url: parsed.details_url ?? null, output: parsed.output ?? null, annotations: Array.isArray(parsed.annotations) ? parsed.annotations : [] };
  } catch {
    return { details_url: null, output: null, annotations: [] };
  }
}

function readLimit(value: unknown): number { return Number.isInteger(value) ? Math.max(0, Math.min(1000, value as number)) : 1000 }
function sortColumn(value: string | undefined): "created_at" | "updated_at" | "id" { return value === "updated_at" || value === "id" ? value : "created_at" }
function sortDirection(value: string | undefined): "ASC" | "DESC" { return value === "asc" ? "ASC" : "DESC" }

interface CheckRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly repository_id: string;
  readonly commit_sha: string;
  readonly evidence_kind: Check["evidence_kind"];
  readonly candidate_bound: number;
  readonly head_sha: string;
  readonly base_sha: string | null;
  readonly execution_sha: string | null;
  readonly plan_digest: string | null;
  readonly policy_digest: string | null;
  readonly job_attempt_id: string | null;
  readonly provider_evidence_ref: string | null;
  readonly name: string;
  readonly producer_id: string;
  readonly status: Check["status"];
  readonly conclusion: Check["conclusion"];
  readonly details_key: string;
}
