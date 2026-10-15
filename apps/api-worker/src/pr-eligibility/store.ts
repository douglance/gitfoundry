import { randomUUID } from "node:crypto";

import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";

export class PrEligibilityStoreConflictError extends Error {
  readonly name = "PrEligibilityStoreConflictError";
}

export interface PrEligibilityReservationInput {
  readonly tenantId: string;
  readonly pullRequestId: string;
  readonly actorId: string;
  readonly logicalKey: string;
  readonly operationPrefix: string;
  readonly now: string;
  readonly expiresAt: string;
  readonly committedAt: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly method: "merge" | "squash" | "rebase" | "fast-forward";
  readonly policyDigest: string;
  readonly progress: unknown;
}

export interface PrEligibilityReservation {
  readonly operationId: string;
  readonly replayed: boolean;
  readonly committedAt: string;
  readonly expiresAt: string;
  readonly generation: number;
  readonly snapshot: unknown | null;
  readonly progress: unknown | null;
}

export interface PrEligibilityGenerationRow {
  readonly tenant_id: string;
  readonly pull_request_id: string;
  readonly operation_id: string;
  readonly logical_key: string;
  readonly generation: number;
  readonly actor_id: string;
  readonly state: "running" | "complete" | "failed";
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly committed_at: string;
  readonly head_sha: string;
  readonly base_sha: string;
  readonly method: "merge" | "squash" | "rebase" | "fast-forward";
  readonly policy_digest: string;
  readonly progress_json: string;
  readonly snapshot_json: string | null;
  readonly error_json: string | null;
}

export interface ObservedRuleRow {
  readonly id: string;
  readonly version: number;
  readonly priority: number;
  readonly enabled: 0 | 1;
  readonly rules_json: string;
}

export interface PrEligibilityCompletionInput {
  readonly tenantId: string;
  readonly operationId: string;
  readonly logicalKey: string;
  readonly generation: number;
  readonly now: string;
  readonly snapshot: unknown;
  readonly result: Record<string, unknown>;
  readonly progress: unknown;
  readonly candidateSha: string | null;
  readonly repositoryId: string;
  readonly sourceRepositoryId: string;
  readonly pullRequestId: string;
  readonly prVersion: number;
  readonly issueVersion: number;
  readonly issueState: "open" | "closed";
  readonly draft: boolean;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly policyEpoch: number;
  readonly expiresAt: string;
  readonly observedRuleRows: readonly ObservedRuleRow[];
}

export interface PrEligibilityStore {
  readonly reserve: (input: PrEligibilityReservationInput) => Promise<PrEligibilityReservation>;
  readonly readActive: (tenantId: string, pullRequestId: string, logicalKey: string, now: string) => Promise<PrEligibilityGenerationRow | null>;
  readonly complete: (input: PrEligibilityCompletionInput) => Promise<void>;
}

export function makeD1PrEligibilityStore(db: D1DatabaseLike): PrEligibilityStore {
  return {
    reserve: (input) => reserve(db, input),
    readActive: (tenantId, pullRequestId, logicalKey, now) => readActive(db, tenantId, pullRequestId, logicalKey, now),
    complete: (input) => complete(db, input)
  };
}

const maxGeneration = 2147483647;

async function reserve(db: D1DatabaseLike, input: PrEligibilityReservationInput): Promise<PrEligibilityReservation> {
  validateReservation(input);
  const active = await readActive(db, input.tenantId, input.pullRequestId, input.logicalKey, input.now);
  if (active) return rowReservation(active, true);

  const pointer = await db.prepare("SELECT operation_id,generation,expires_at FROM pr_eligibility_active WHERE tenant_id = ? AND pull_request_id = ? AND logical_key = ? LIMIT 1").bind(input.tenantId, input.pullRequestId, input.logicalKey).first<{ operation_id: string; generation: number; expires_at: string }>();
  if (pointer && (!Number.isSafeInteger(pointer.generation) || pointer.generation <= 0 || pointer.generation >= maxGeneration)) throw new PrEligibilityStoreConflictError("eligibility generation exhausted");
  const nextGeneration = pointer ? pointer.generation + 1 : 1;
  const operationId = `${input.operationPrefix}-g${nextGeneration}`;
  const progress = JSON.stringify(input.progress);
  const batch = requireBatch(db);
  const statements = pointer ? [
    db.prepare("UPDATE pr_eligibility_active SET operation_id = ?, generation = ?, expires_at = ?, updated_at = ? WHERE tenant_id = ? AND pull_request_id = ? AND logical_key = ? AND operation_id = ? AND generation = ? AND expires_at <= ?").bind(operationId, nextGeneration, input.expiresAt, input.now, input.tenantId, input.pullRequestId, input.logicalKey, pointer.operation_id, pointer.generation, input.now),
    db.prepare("INSERT INTO operations(tenant_id,id,version,created_at,updated_at,kind,actor_id,state,progress_json,result_key,error_json) SELECT ?,?,?,?,?,?,?,?,?,NULL,NULL WHERE EXISTS (SELECT 1 FROM pr_eligibility_active WHERE tenant_id = ? AND pull_request_id = ? AND logical_key = ? AND operation_id = ?)").bind(input.tenantId, operationId, 1, input.now, input.now, "pr.eligibility.prepare", input.actorId, "running", progress, input.tenantId, input.pullRequestId, input.logicalKey, operationId),
    db.prepare("INSERT INTO pr_eligibility_generations(tenant_id,pull_request_id,operation_id,logical_key,generation,actor_id,state,created_at,updated_at,expires_at,committed_at,head_sha,base_sha,method,policy_digest,progress_json,snapshot_json,error_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL WHERE EXISTS (SELECT 1 FROM pr_eligibility_active WHERE tenant_id = ? AND pull_request_id = ? AND logical_key = ? AND operation_id = ?)").bind(input.tenantId, input.pullRequestId, operationId, input.logicalKey, nextGeneration, input.actorId, "running", input.now, input.now, input.expiresAt, input.committedAt, input.headSha, input.baseSha, input.method, input.policyDigest, progress, input.tenantId, input.pullRequestId, input.logicalKey, operationId)
  ] : [
    db.prepare("INSERT INTO pr_eligibility_active(tenant_id,pull_request_id,logical_key,operation_id,generation,expires_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM pr_eligibility_active WHERE tenant_id = ? AND pull_request_id = ? AND logical_key = ?)").bind(input.tenantId, input.pullRequestId, input.logicalKey, operationId, nextGeneration, input.expiresAt, input.now, input.tenantId, input.pullRequestId, input.logicalKey),
    db.prepare("INSERT INTO operations(tenant_id,id,version,created_at,updated_at,kind,actor_id,state,progress_json,result_key,error_json) SELECT ?,?,?,?,?,?,?,?,?,NULL,NULL WHERE EXISTS (SELECT 1 FROM pr_eligibility_active WHERE tenant_id = ? AND pull_request_id = ? AND logical_key = ? AND operation_id = ?)").bind(input.tenantId, operationId, 1, input.now, input.now, "pr.eligibility.prepare", input.actorId, "running", progress, input.tenantId, input.pullRequestId, input.logicalKey, operationId),
    db.prepare("INSERT INTO pr_eligibility_generations(tenant_id,pull_request_id,operation_id,logical_key,generation,actor_id,state,created_at,updated_at,expires_at,committed_at,head_sha,base_sha,method,policy_digest,progress_json,snapshot_json,error_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL WHERE EXISTS (SELECT 1 FROM pr_eligibility_active WHERE tenant_id = ? AND pull_request_id = ? AND logical_key = ? AND operation_id = ?)").bind(input.tenantId, input.pullRequestId, operationId, input.logicalKey, nextGeneration, input.actorId, "running", input.now, input.now, input.expiresAt, input.committedAt, input.headSha, input.baseSha, input.method, input.policyDigest, progress, input.tenantId, input.pullRequestId, input.logicalKey, operationId)
  ];
  try {
    const results = await runBatch(batch, statements);
    if ((results[0]?.meta?.changes ?? 0) === 1 && (results[1]?.meta?.changes ?? 0) === 1 && (results[2]?.meta?.changes ?? 0) === 1) return { operationId, replayed: false, committedAt: input.committedAt, expiresAt: input.expiresAt, generation: nextGeneration, snapshot: null, progress: input.progress };
  } catch {
    // A concurrent writer may have won the pointer CAS. Fall through to replay that winner.
  }
  const replay = await readActive(db, input.tenantId, input.pullRequestId, input.logicalKey, input.now);
  if (replay) return rowReservation(replay, true);
  throw new PrEligibilityStoreConflictError("eligibility reservation failed");
}

async function complete(db: D1DatabaseLike, input: PrEligibilityCompletionInput): Promise<void> {
  validateCompletion(input);
  const batch = requireBatch(db);
  const finalizationNonce = randomUUID();
  const snapshot = JSON.stringify(input.snapshot);
  const progress = JSON.stringify(input.progress);
  const resultKey = `json:${JSON.stringify(input.result)}`;
  const rulesJson = JSON.stringify(input.observedRuleRows);
  const closedAtParam = input.closedAt;
  const mergedAtParam = input.mergedAt;
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE pr_eligibility_generations SET state = 'complete', updated_at = ?, progress_json = ?, snapshot_json = ?, finalization_nonce = ?
      WHERE tenant_id = ? AND operation_id = ? AND logical_key = ? AND state = 'running' AND expires_at > ?
      AND generation = ?
      AND EXISTS (SELECT 1 FROM pr_eligibility_active a WHERE a.tenant_id = pr_eligibility_generations.tenant_id AND a.pull_request_id = pr_eligibility_generations.pull_request_id AND a.logical_key = pr_eligibility_generations.logical_key AND a.operation_id = pr_eligibility_generations.operation_id AND a.generation = pr_eligibility_generations.generation)
      AND EXISTS (
        SELECT 1 FROM tenants t
        JOIN principals p ON p.tenant_id = t.id AND p.id = pr_eligibility_generations.actor_id
        JOIN pull_requests pr ON pr.tenant_id = t.id AND pr.id = ?
        JOIN issues i ON i.tenant_id = pr.tenant_id AND i.id = pr.issue_id
        WHERE t.id = ? AND t.state = 'active' AND t.policy_epoch = ?
          AND p.active = 1
          AND pr.version = ? AND i.version = ? AND i.state = ?
          AND pr.repository_id = ? AND pr.source_repository_id = ? AND pr.source_ref = ? AND pr.target_ref = ?
          AND pr.head_sha = ? AND pr.base_sha = ? AND pr.draft = ?
          AND ((pr.closed_at IS NULL AND ? IS NULL) OR pr.closed_at = ?)
          AND ((pr.merged_at IS NULL AND ? IS NULL) OR pr.merged_at = ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM rulesets r WHERE r.tenant_id = ? AND r.repository_id = ? AND NOT EXISTS (
          SELECT 1 FROM json_each(?) observed WHERE json_extract(observed.value,'$.id') = r.id AND json_extract(observed.value,'$.version') = r.version AND json_extract(observed.value,'$.priority') = r.priority AND json_extract(observed.value,'$.enabled') = r.enabled AND json_extract(observed.value,'$.rules_json') = r.rules_json
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) observed WHERE NOT EXISTS (
          SELECT 1 FROM rulesets r WHERE r.tenant_id = ? AND r.repository_id = ? AND r.id = json_extract(observed.value,'$.id') AND r.version = json_extract(observed.value,'$.version') AND r.priority = json_extract(observed.value,'$.priority') AND r.enabled = json_extract(observed.value,'$.enabled') AND r.rules_json = json_extract(observed.value,'$.rules_json')
        )
      )`).bind(input.now, progress, snapshot, finalizationNonce, input.tenantId, input.operationId, input.logicalKey, input.now, input.generation, input.pullRequestId, input.tenantId, input.policyEpoch, input.prVersion, input.issueVersion, input.issueState, input.repositoryId, input.sourceRepositoryId, input.sourceRef, input.targetRef, input.headSha, input.baseSha, input.draft ? 1 : 0, closedAtParam, closedAtParam, mergedAtParam, mergedAtParam, input.tenantId, input.repositoryId, rulesJson, rulesJson, input.tenantId, input.repositoryId),
    db.prepare("UPDATE operations SET state = 'complete', updated_at = ?, progress_json = ?, result_key = ? WHERE tenant_id = ? AND id = ? AND state = 'running' AND EXISTS (SELECT 1 FROM pr_eligibility_generations g WHERE g.tenant_id = ? AND g.operation_id = ? AND g.logical_key = ? AND g.generation = ? AND g.state = 'complete' AND g.updated_at = ? AND g.progress_json = ? AND g.snapshot_json = ? AND g.finalization_nonce = ?)").bind(input.now, progress, resultKey, input.tenantId, input.operationId, input.tenantId, input.operationId, input.logicalKey, input.generation, input.now, progress, snapshot, finalizationNonce)
  ];
  if (input.candidateSha !== null) {
    statements.push(db.prepare("INSERT INTO eligibility(tenant_id,id,version,created_at,updated_at,repository_id,pull_request_id,head_sha,base_sha,candidate_sha,policy_epoch,snapshot_json,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM pr_eligibility_generations g WHERE g.tenant_id = ? AND g.operation_id = ? AND g.logical_key = ? AND g.generation = ? AND g.state = 'complete' AND g.updated_at = ? AND g.progress_json = ? AND g.snapshot_json = ? AND g.finalization_nonce = ?) AND EXISTS (SELECT 1 FROM operations o WHERE o.tenant_id = ? AND o.id = ? AND o.state = 'complete' AND o.updated_at = ? AND o.progress_json = ? AND o.result_key = ?)").bind(input.tenantId, input.operationId, 1, input.now, input.now, input.repositoryId, input.pullRequestId, input.headSha, input.baseSha, input.candidateSha, input.policyEpoch, snapshot, input.expiresAt, input.tenantId, input.operationId, input.logicalKey, input.generation, input.now, progress, snapshot, finalizationNonce, input.tenantId, input.operationId, input.now, progress, resultKey));
  }
  let results: readonly D1Result[];
  try {
    results = await runBatch(batch, statements);
  } catch {
    throw new PrEligibilityStoreConflictError("eligibility finalization failed");
  }
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) throw new PrEligibilityStoreConflictError("eligibility finalization lost reservation");
}

async function readActive(db: D1DatabaseLike, tenantId: string, pullRequestId: string, logicalKey: string, now: string): Promise<PrEligibilityGenerationRow | null> {
  return db.prepare(`SELECT g.tenant_id,g.pull_request_id,g.operation_id,g.logical_key,g.generation,g.actor_id,g.state,g.created_at,g.updated_at,g.expires_at,g.committed_at,g.head_sha,g.base_sha,g.method,g.policy_digest,g.progress_json,g.snapshot_json,g.error_json
    FROM pr_eligibility_active a JOIN pr_eligibility_generations g ON g.tenant_id = a.tenant_id AND g.operation_id = a.operation_id
    WHERE a.tenant_id = ? AND a.pull_request_id = ? AND a.logical_key = ? AND a.expires_at > ? LIMIT 1`).bind(tenantId, pullRequestId, logicalKey, now).first<PrEligibilityGenerationRow>();
}

function rowReservation(row: PrEligibilityGenerationRow, replayed: boolean): PrEligibilityReservation {
  return { operationId: row.operation_id, replayed, committedAt: row.committed_at, expiresAt: row.expires_at, generation: row.generation, snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null, progress: row.progress_json ? JSON.parse(row.progress_json) : null };
}

function validateReservation(input: PrEligibilityReservationInput): void {
  if (!input.headSha || !input.baseSha || !input.policyDigest) throw new PrEligibilityStoreConflictError("eligibility reservation requires complete identity");
  if (!/^[0-9a-f]{40}$/u.test(input.headSha) || !/^[0-9a-f]{40}$/u.test(input.baseSha) || !/^[0-9a-f]{64}$/u.test(input.policyDigest)) throw new PrEligibilityStoreConflictError("eligibility reservation identity malformed");
}

function validateCompletion(input: PrEligibilityCompletionInput): void {
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0 || input.generation > maxGeneration) throw new PrEligibilityStoreConflictError("generation malformed");
  if (!/^[0-9a-f]{40}$/u.test(input.headSha) || !/^[0-9a-f]{40}$/u.test(input.baseSha)) throw new PrEligibilityStoreConflictError("eligibility finalization identity malformed");
  if (input.candidateSha !== null && !/^[0-9a-f]{40}$/u.test(input.candidateSha)) throw new PrEligibilityStoreConflictError("candidate identity malformed");
  for (const row of input.observedRuleRows) if (!Number.isSafeInteger(row.version) || row.version <= 0 || !Number.isSafeInteger(row.priority) || (row.enabled !== 0 && row.enabled !== 1) || typeof row.rules_json !== "string") throw new PrEligibilityStoreConflictError("observed rules malformed");
}

function requireBatch(db: D1DatabaseLike): NonNullable<D1DatabaseLike["batch"]> {
  if (!db.batch) throw new PrEligibilityStoreConflictError("atomic D1 batch is required");
  return db.batch.bind(db);
}

async function runBatch(batch: NonNullable<D1DatabaseLike["batch"]>, statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
  const results = await batch(statements);
  if (results.some((result) => result.success === false)) throw new PrEligibilityStoreConflictError("atomic D1 batch failed");
  return results;
}
