import { Effect } from "effect";

import {
  PublicationConflictError,
  PublicationStorageError,
  type GitPublicationIntent,
  type PolicyReceipt,
  type ProviderObservationReceipt,
  type ProviderPublicationReceipt,
  type PublicationJournal,
  type PublicationJournalExpected,
  type PublicationJournalRecord,
  type PublicationScope,
  type PublicationState,
  type SourceRefChange
} from "./index.js";

type SqliteValue = string | number | bigint | null | Uint8Array;
export interface SqliteRunResultLike { readonly changes?: number | bigint }
export interface SqliteStatementLike { readonly run: (...values: readonly SqliteValue[]) => SqliteRunResultLike | unknown; readonly get: (...values: readonly SqliteValue[]) => unknown; readonly all: (...values: readonly SqliteValue[]) => unknown[] }
export interface SqliteDatabaseLike { readonly exec: (sql: string) => void; readonly prepare: (sql: string) => SqliteStatementLike }

interface JournalRow { readonly tenant_id: string; readonly repository_id: string; readonly principal_id: string; readonly operation_id: "repo.ref-update"; readonly idempotency_key: string; readonly request_digest: string; readonly journal_id: string; readonly expected_version: number; readonly policy_epoch: number; readonly lease_fence: string; readonly state: PublicationState; readonly sequence: number; readonly attempt: number; readonly created_at: string; readonly updated_at: string; readonly changes_json: string; readonly atomic: number; readonly eligibility_id: string | null; readonly reason: string; readonly policy_receipt_json: string | null; readonly provider_receipt_json: string | null; readonly observation_receipt_json: string | null; readonly reason_code: string | null }

export function installSqlitePublicationJournalSchema(db: SqliteDatabaseLike): void {
  db.exec(`CREATE TABLE IF NOT EXISTS git_publication_journal(
    journal_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    expected_version INTEGER NOT NULL,
    policy_epoch INTEGER NOT NULL,
    lease_fence TEXT NOT NULL,
    state TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    changes_json TEXT NOT NULL,
    atomic INTEGER NOT NULL,
    eligibility_id TEXT,
    reason TEXT NOT NULL,
    policy_receipt_json TEXT,
    provider_receipt_json TEXT,
    observation_receipt_json TEXT,
    reason_code TEXT,
    UNIQUE(tenant_id, repository_id, principal_id, operation_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS git_publication_ref_fences(
    tenant_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    journal_id TEXT NOT NULL,
    PRIMARY KEY(tenant_id, repository_id, ref)
  );
  CREATE INDEX IF NOT EXISTS git_publication_open_ref_idx ON git_publication_journal(tenant_id, repository_id, state);`);
}

export function makeSqlitePublicationJournal(db: SqliteDatabaseLike): PublicationJournal {
  installSqlitePublicationJournalSchema(db);
  return {
    reservePrepared: (intent, scope, now) => fromSqliteSync(() => reservePrepared(db, intent, scope, now)),
    markPublishing: (journalId, expectedState, policyReceipt, now) => fromSqliteSync(() => markPublishing(db, journalId, expectedState, policyReceipt, now)),
    finish: (journalId, expectedState, state, receipt, observation, reasonCode, now) => fromSqliteSync(() => finish(db, journalId, expectedState, state, receipt, observation, reasonCode, now)),
    get: (journalId) => fromSqliteSync(() => { const row = db.prepare("SELECT * FROM git_publication_journal WHERE journal_id = ? LIMIT 1").get(journalId) as JournalRow | undefined; return row ? rowToRecord(row) : undefined; })
  };
}

function reservePrepared(db: SqliteDatabaseLike, intent: GitPublicationIntent, scope: PublicationScope, now: string): { readonly record: PublicationJournalRecord; readonly replayed: boolean } {
  beginImmediate(db);
  try {
    const existing = db.prepare("SELECT * FROM git_publication_journal WHERE tenant_id = ? AND repository_id = ? AND principal_id = ? AND operation_id = ? AND idempotency_key = ? LIMIT 1").get(intent.tenantId, intent.repositoryId, intent.principalId, intent.operationId, intent.idempotencyKey) as JournalRow | undefined;
    if (existing) {
      if (existing.request_digest !== scope.requestDigest) throw new PublicationConflictError({ reason: "idempotency key was reused with different ref publication input", journalId: existing.journal_id });
      commit(db);
      return { record: rowToRecord(existing), replayed: true };
    }
    for (const change of intent.changes) {
      const fence = db.prepare("SELECT journal_id FROM git_publication_ref_fences WHERE tenant_id = ? AND repository_id = ? AND ref = ? LIMIT 1").get(intent.tenantId, intent.repositoryId, change.ref) as { journal_id: string } | undefined;
      if (fence) throw new PublicationConflictError({ reason: "repository ref publication is already fenced by an unresolved journal", journalId: fence.journal_id });
    }
    const sequenceRow = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM git_publication_journal WHERE tenant_id = ? AND repository_id = ?").get(intent.tenantId, intent.repositoryId) as { next_sequence: number } | undefined;
    const record = newRecord(intent, scope, Number(sequenceRow?.next_sequence ?? 1), now);
    insertRecord(db, record);
    for (const change of intent.changes) db.prepare("INSERT INTO git_publication_ref_fences(tenant_id, repository_id, ref, journal_id) VALUES(?,?,?,?)").run(intent.tenantId, intent.repositoryId, change.ref, record.journalId);
    commit(db);
    return { record, replayed: false };
  } catch (error) { rollback(db); throw error; }
}

function markPublishing(db: SqliteDatabaseLike, journalId: string, expected: PublicationJournalExpected, policyReceipt: PolicyReceipt, now: string): PublicationJournalRecord {
  const current = requireRow(db, journalId);
  assertTransitionCurrent(rowToRecord(current), expected, journalId);
  const changed = changesOf(db.prepare("UPDATE git_publication_journal SET state = 'publishing', attempt = attempt + 1, policy_receipt_json = ?, updated_at = ? WHERE journal_id = ? AND state = ? AND attempt = ?").run(JSON.stringify(policyReceipt), now, journalId, expected.state, expected.attempt));
  if (changed !== 1) throw new PublicationConflictError({ reason: `expected ${expected.state}/${expected.attempt} before publishing`, journalId });
  return rowToRecord(requireRow(db, journalId));
}

function finish(db: SqliteDatabaseLike, journalId: string, expected: PublicationJournalExpected, state: "accepted" | "rejected" | "unknown", receipt: ProviderPublicationReceipt | null, observation: ProviderObservationReceipt | null, reasonCode: string | null, now: string): PublicationJournalRecord {
  beginImmediate(db);
  try {
    const current = requireRow(db, journalId);
    assertTransitionCurrent(rowToRecord(current), expected, journalId);
    const changed = changesOf(db.prepare("UPDATE git_publication_journal SET state = ?, provider_receipt_json = ?, observation_receipt_json = ?, reason_code = ?, updated_at = ? WHERE journal_id = ? AND state = ? AND attempt = ?").run(state, receipt ? JSON.stringify(receipt) : null, observation ? JSON.stringify(observation) : null, reasonCode, now, journalId, expected.state, expected.attempt));
    if (changed !== 1) throw new PublicationConflictError({ reason: `expected ${expected.state}/${expected.attempt} before finish`, journalId });
    if (state !== "unknown") db.prepare("DELETE FROM git_publication_ref_fences WHERE journal_id = ?").run(journalId);
    const next = rowToRecord(requireRow(db, journalId));
    commit(db);
    return next;
  } catch (error) { rollback(db); throw error; }
}

function insertRecord(db: SqliteDatabaseLike, record: PublicationJournalRecord): void {
  db.prepare("INSERT INTO git_publication_journal(journal_id,tenant_id,repository_id,principal_id,operation_id,idempotency_key,request_digest,expected_version,policy_epoch,lease_fence,state,sequence,attempt,created_at,updated_at,changes_json,atomic,eligibility_id,reason,policy_receipt_json,provider_receipt_json,observation_receipt_json,reason_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(record.journalId, record.tenantId, record.repositoryId, record.principalId, record.operationId, record.idempotencyKey, record.requestDigest, record.expectedVersion, record.policyEpoch, record.leaseFence, record.state, record.sequence, record.attempt, record.createdAt, record.updatedAt, JSON.stringify(record.changes), record.atomic ? 1 : 0, record.eligibilityId, record.reason, record.policyReceipt ? JSON.stringify(record.policyReceipt) : null, record.providerReceipt ? JSON.stringify(record.providerReceipt) : null, record.observationReceipt ? JSON.stringify(record.observationReceipt) : null, record.reasonCode);
}

function requireRow(db: SqliteDatabaseLike, journalId: string): JournalRow { const row = db.prepare("SELECT * FROM git_publication_journal WHERE journal_id = ? LIMIT 1").get(journalId) as JournalRow | undefined; if (!row) throw new PublicationConflictError({ reason: "publication journal record not found", journalId }); return row; }
function rowToRecord(row: JournalRow): PublicationJournalRecord { return { tenantId: row.tenant_id, repositoryId: row.repository_id, principalId: row.principal_id, operationId: row.operation_id, idempotencyKey: row.idempotency_key, requestDigest: row.request_digest, journalId: row.journal_id, expectedVersion: row.expected_version, policyEpoch: row.policy_epoch, leaseFence: row.lease_fence, state: row.state, sequence: row.sequence, attempt: row.attempt, createdAt: row.created_at, updatedAt: row.updated_at, changes: JSON.parse(row.changes_json) as SourceRefChange[], atomic: row.atomic === 1, eligibilityId: row.eligibility_id, reason: row.reason, policyReceipt: row.policy_receipt_json ? JSON.parse(row.policy_receipt_json) as PolicyReceipt : null, providerReceipt: row.provider_receipt_json ? JSON.parse(row.provider_receipt_json) as ProviderPublicationReceipt : null, observationReceipt: row.observation_receipt_json ? JSON.parse(row.observation_receipt_json) as ProviderObservationReceipt : null, reasonCode: row.reason_code }; }
function newRecord(intent: GitPublicationIntent, scope: PublicationScope, sequence: number, now: string): PublicationJournalRecord { return { tenantId: intent.tenantId, repositoryId: intent.repositoryId, principalId: intent.principalId, operationId: intent.operationId, idempotencyKey: intent.idempotencyKey, requestDigest: scope.requestDigest, journalId: scope.journalId, expectedVersion: intent.expectedVersion, policyEpoch: intent.policyEpoch, leaseFence: intent.leaseFence, state: "prepared", sequence, attempt: 0, createdAt: now, updatedAt: now, changes: intent.changes.map((change) => ({ ...change })), atomic: intent.atomic, eligibilityId: intent.eligibilityId, reason: intent.reason, policyReceipt: null, providerReceipt: null, observationReceipt: null, reasonCode: null }; }
function assertTransitionCurrent(record: PublicationJournalRecord, expected: PublicationJournalExpected, journalId: string): void { if (record.state === "accepted" || record.state === "rejected") throw new PublicationConflictError({ reason: `terminal publication ${record.state} is immutable`, journalId }); if (record.state !== expected.state || record.attempt !== expected.attempt) throw new PublicationConflictError({ reason: `expected ${expected.state}/${expected.attempt}, got ${record.state}/${record.attempt}`, journalId }); }
function beginImmediate(db: SqliteDatabaseLike): void { db.exec("BEGIN IMMEDIATE"); }
function commit(db: SqliteDatabaseLike): void { db.exec("COMMIT"); }
function rollback(db: SqliteDatabaseLike): void { try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ } }
function changesOf(result: unknown): number { if (result && typeof result === "object" && "changes" in result) return Number((result as { readonly changes?: number | bigint }).changes ?? 0); return 0; }
function fromSqliteSync<A>(tryValue: () => A): Effect.Effect<A, PublicationConflictError | PublicationStorageError> { return Effect.try({ try: tryValue, catch: toSqliteJournalError }); }
function toSqliteJournalError(error: unknown): PublicationConflictError | PublicationStorageError { return hasTag(error, "PublicationConflictError") ? error as PublicationConflictError : new PublicationStorageError({ reason: "publication journal storage failure", cause: String(error) }); }
function hasTag(error: unknown, tag: string): boolean { return typeof error === "object" && error !== null && "_tag" in error && (error as { readonly _tag?: unknown })._tag === tag; }
