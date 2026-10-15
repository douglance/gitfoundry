import { Effect } from "effect";

import {
  PublicationConflictError,
  PublicationInputError,
  PublicationProviderError,
  type PublicationDeniedError,
  PublicationStorageError,
  makePublicationCoordinator,
  makePublicationScope,
  type GitPublicationIntent,
  type PolicyAdmissionPort,
  type PolicyReceipt,
  type ProviderObservationReceipt,
  type ProviderPublicationReceipt,
  type PublicationJournal,
  type PublicationJournalExpected,
  type PublicationJournalRecord,
  type PublicationOutcome,
  type PublicationScope,
  type PublicationRecoveryScope,
  type PublicationState,
  type SourceRefChange,
  type TrustedGitPublicationPort
} from "../../../../packages/core/src/git-publication/index.js";

type SqlValue = ArrayBuffer | string | number | null;
type DurableSqlCursor<T extends Record<string, SqlValue>> = { readonly rowsWritten: number; readonly toArray: () => T[]; readonly one: () => T };
type DurableSqlStorage = { readonly exec: <T extends Record<string, SqlValue>>(query: string, ...bindings: readonly SqlValue[]) => DurableSqlCursor<T> };
export interface DurablePublicationStorage { readonly sql: DurableSqlStorage; readonly transactionSync: <T>(closure: () => T) => T }

interface JournalRow extends Record<string, SqlValue> { readonly tenant_id: string; readonly repository_id: string; readonly principal_id: string; readonly operation_id: "repo.ref-update"; readonly idempotency_key: string; readonly request_digest: string; readonly journal_id: string; readonly expected_version: number; readonly policy_epoch: number; readonly lease_fence: string; readonly state: PublicationState; readonly sequence: number; readonly attempt: number; readonly created_at: string; readonly updated_at: string; readonly changes_json: string; readonly atomic: number; readonly eligibility_id: string | null; readonly reason: string; readonly policy_receipt_json: string | null; readonly provider_receipt_json: string | null; readonly observation_receipt_json: string | null; readonly reason_code: string | null }

export interface GitPublicationRepositoryJournalEnv {}

export class GitPublicationRepositoryJournal {
  constructor(private readonly ctx: DurableObjectState, readonly env: GitPublicationRepositoryJournalEnv) { installDurablePublicationJournalSchema(ctx.storage); }
  async fetch(request: Request): Promise<Response> { return handleGitPublicationJournalRequest(this.ctx.storage, request); }
}

export function makeDurableObjectPublicationJournal(storage: DurablePublicationStorage): PublicationJournal {
  const withSchema = <A>(operation: () => A): Effect.Effect<A, PublicationConflictError | PublicationStorageError> => fromDurableSql(() => { installDurablePublicationJournalSchema(storage); return operation(); });
  return {
    reservePrepared: (intent, scope, now) => withSchema(() => reservePrepared(storage, intent, scope, now)),
    markPublishing: (journalId, expectedState, policyReceipt, now) => withSchema(() => markPublishing(storage, journalId, expectedState, policyReceipt, now)),
    finish: (journalId, expectedState, state, receipt, observation, reasonCode, now) => withSchema(() => finish(storage, journalId, expectedState, state, receipt, observation, reasonCode, now)),
    get: (journalId) => withSchema(() => { const row = first<JournalRow>(storage.sql.exec("SELECT * FROM git_publication_journal WHERE journal_id = ? LIMIT 1", journalId)); return row ? rowToRecord(row) : undefined; })
  };
}

export function installDurablePublicationJournalSchema(storage: DurablePublicationStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS git_publication_journal(
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
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS git_publication_ref_fences(
    tenant_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    journal_id TEXT NOT NULL,
    PRIMARY KEY(tenant_id, repository_id, ref)
  )`);
  storage.sql.exec("CREATE INDEX IF NOT EXISTS git_publication_open_ref_idx ON git_publication_journal(tenant_id, repository_id, state)");
}

export function makeUnavailableGitPublicationProvider(): TrustedGitPublicationPort {
  const unavailable = new PublicationProviderError({ kind: "unreachable", detail: "trusted Git publication helper is not configured" });
  return { observeRefs: () => Effect.fail(unavailable), publishRefs: () => Effect.fail(unavailable) };
}

export function makeUnavailablePolicyAdmissionPort(): PolicyAdmissionPort {
  const unavailable = new PublicationProviderError({ kind: "unreachable", detail: "live publication policy provider is not configured" });
  return { revalidate: () => Effect.fail(unavailable) };
}

export function publishWithDurableJournal(input: { readonly storage: DurablePublicationStorage; readonly intent: GitPublicationIntent; readonly policy?: PolicyAdmissionPort; readonly provider?: TrustedGitPublicationPort; readonly clock?: { readonly now: () => Date } }): Effect.Effect<PublicationOutcome, PublicationInputError | PublicationConflictError | PublicationStorageError | PublicationDeniedError | PublicationProviderError> {
  return makePublicationCoordinator({ journal: makeDurableObjectPublicationJournal(input.storage), policy: input.policy ?? makeUnavailablePolicyAdmissionPort(), provider: input.provider ?? makeUnavailableGitPublicationProvider(), ...(input.clock ? { clock: input.clock } : {}) }).publish(input.intent);
}

export function recoverWithDurableJournal(input: { readonly storage: DurablePublicationStorage; readonly scope: PublicationRecoveryScope; readonly provider?: TrustedGitPublicationPort; readonly clock?: { readonly now: () => Date } }): Effect.Effect<PublicationOutcome, PublicationInputError | PublicationConflictError | PublicationStorageError | PublicationProviderError> {
  return makePublicationCoordinator({ journal: makeDurableObjectPublicationJournal(input.storage), policy: makeUnavailablePolicyAdmissionPort(), provider: input.provider ?? makeUnavailableGitPublicationProvider(), ...(input.clock ? { clock: input.clock } : {}) }).recover(input.scope);
}

export async function handleGitPublicationJournalRequest(storage: DurablePublicationStorage, request: Request): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const url = new URL(request.url);
  const parsedBody = await request.json().catch(() => undefined) as unknown;
  if (parsedBody === undefined) return json({ ok: false, error: "invalid_json" }, 400);
  if (!isJsonObject(parsedBody)) return json({ ok: false, error: "invalid_publication_request" }, 400);
  const body = parsedBody;
  if (url.pathname === "/publish") {
    const intent = body.intent as GitPublicationIntent | undefined;
    if ("policy_receipt" in body) return json({ ok: false, error: "client_policy_receipt_not_accepted" }, 400);
    if (!intent) return json({ ok: false, error: "invalid_publication_request" }, 400);
    return Effect.runPromise(publishWithDurableJournal({ storage, intent }).pipe(
      Effect.map((outcome) => json({ ok: true, outcome })),
      Effect.catch((error) => Effect.succeed(json({ ok: false, error: error._tag, reason: "reason" in error ? error.reason : "publication unavailable" }, 409)))
    ));
  }
  if (url.pathname === "/get") {
    const journalId = typeof body.journal_id === "string" ? body.journal_id : "";
    if (!journalId) return json({ ok: false, error: "journal_id_required" }, 400);
    const exit = await Effect.runPromiseExit(makeDurableObjectPublicationJournal(storage).get(journalId));
    return exit._tag === "Success" ? json({ ok: true, record: exit.value ?? null }) : json({ ok: false, error: String(exit.cause) }, 500);
  }
  return json({ ok: false, error: "not_found" }, 404);
}

function reservePrepared(storage: DurablePublicationStorage, intent: GitPublicationIntent, scope: PublicationScope, now: string): { readonly record: PublicationJournalRecord; readonly replayed: boolean } {
  return storage.transactionSync(() => {
    const existing = first<JournalRow>(storage.sql.exec("SELECT * FROM git_publication_journal WHERE tenant_id = ? AND repository_id = ? AND principal_id = ? AND operation_id = ? AND idempotency_key = ? LIMIT 1", intent.tenantId, intent.repositoryId, intent.principalId, intent.operationId, intent.idempotencyKey));
    if (existing) {
      if (existing.request_digest !== scope.requestDigest) throw new PublicationConflictError({ reason: "idempotency key was reused with different ref publication input", journalId: existing.journal_id });
      return { record: rowToRecord(existing), replayed: true };
    }
    for (const change of intent.changes) {
      const fence = first<{ readonly journal_id: string }>(storage.sql.exec("SELECT journal_id FROM git_publication_ref_fences WHERE tenant_id = ? AND repository_id = ? AND ref = ? LIMIT 1", intent.tenantId, intent.repositoryId, change.ref));
      if (fence) throw new PublicationConflictError({ reason: "repository ref publication is already fenced by an unresolved journal", journalId: fence.journal_id });
    }
    const sequenceRow = first<{ readonly next_sequence: number }>(storage.sql.exec("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM git_publication_journal WHERE tenant_id = ? AND repository_id = ?", intent.tenantId, intent.repositoryId));
    const record = newRecord(intent, scope, Number(sequenceRow?.next_sequence ?? 1), now);
    insertRecord(storage, record);
    for (const change of intent.changes) storage.sql.exec("INSERT INTO git_publication_ref_fences(tenant_id, repository_id, ref, journal_id) VALUES(?,?,?,?)", intent.tenantId, intent.repositoryId, change.ref, record.journalId);
    return { record, replayed: false };
  });
}

function markPublishing(storage: DurablePublicationStorage, journalId: string, expectedState: PublicationJournalExpected, policyReceipt: PolicyReceipt, now: string): PublicationJournalRecord {
  return storage.transactionSync(() => {
    assertTransitionCurrent(rowToRecord(requireRow(storage, journalId)), expectedState, journalId);
    const changed = storage.sql.exec("UPDATE git_publication_journal SET state = 'publishing', attempt = attempt + 1, policy_receipt_json = ?, updated_at = ? WHERE journal_id = ? AND state = ? AND attempt = ? RETURNING journal_id", JSON.stringify(policyReceipt), now, journalId, expectedState.state, expectedState.attempt).toArray().length;
    if (changed !== 1) throw new PublicationConflictError({ reason: `expected ${expectedState.state}/${expectedState.attempt} before publishing`, journalId });
    return rowToRecord(requireRow(storage, journalId));
  });
}

function finish(storage: DurablePublicationStorage, journalId: string, expectedState: PublicationJournalExpected, state: "accepted" | "rejected" | "unknown", receipt: ProviderPublicationReceipt | null, observation: ProviderObservationReceipt | null, reasonCode: string | null, now: string): PublicationJournalRecord {
  return storage.transactionSync(() => {
    assertTransitionCurrent(rowToRecord(requireRow(storage, journalId)), expectedState, journalId);
    const changed = storage.sql.exec("UPDATE git_publication_journal SET state = ?, provider_receipt_json = ?, observation_receipt_json = ?, reason_code = ?, updated_at = ? WHERE journal_id = ? AND state = ? AND attempt = ? RETURNING journal_id", state, receipt ? JSON.stringify(receipt) : null, observation ? JSON.stringify(observation) : null, reasonCode, now, journalId, expectedState.state, expectedState.attempt).toArray().length;
    if (changed !== 1) throw new PublicationConflictError({ reason: `expected ${expectedState.state}/${expectedState.attempt} before finish`, journalId });
    if (state !== "unknown") storage.sql.exec("DELETE FROM git_publication_ref_fences WHERE journal_id = ?", journalId);
    return rowToRecord(requireRow(storage, journalId));
  });
}

function insertRecord(storage: DurablePublicationStorage, record: PublicationJournalRecord): void {
  storage.sql.exec("INSERT INTO git_publication_journal(journal_id,tenant_id,repository_id,principal_id,operation_id,idempotency_key,request_digest,expected_version,policy_epoch,lease_fence,state,sequence,attempt,created_at,updated_at,changes_json,atomic,eligibility_id,reason,policy_receipt_json,provider_receipt_json,observation_receipt_json,reason_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", record.journalId, record.tenantId, record.repositoryId, record.principalId, record.operationId, record.idempotencyKey, record.requestDigest, record.expectedVersion, record.policyEpoch, record.leaseFence, record.state, record.sequence, record.attempt, record.createdAt, record.updatedAt, JSON.stringify(record.changes), record.atomic ? 1 : 0, record.eligibilityId, record.reason, record.policyReceipt ? JSON.stringify(record.policyReceipt) : null, record.providerReceipt ? JSON.stringify(record.providerReceipt) : null, record.observationReceipt ? JSON.stringify(record.observationReceipt) : null, record.reasonCode);
}

function requireRow(storage: DurablePublicationStorage, journalId: string): JournalRow { const row = first<JournalRow>(storage.sql.exec("SELECT * FROM git_publication_journal WHERE journal_id = ? LIMIT 1", journalId)); if (!row) throw new PublicationConflictError({ reason: "publication journal record not found", journalId }); return row; }
function first<T extends Record<string, SqlValue>>(cursor: DurableSqlCursor<T>): T | undefined { return cursor.toArray()[0]; }
function rowToRecord(row: JournalRow): PublicationJournalRecord { return { tenantId: row.tenant_id, repositoryId: row.repository_id, principalId: row.principal_id, operationId: row.operation_id, idempotencyKey: row.idempotency_key, requestDigest: row.request_digest, journalId: row.journal_id, expectedVersion: row.expected_version, policyEpoch: row.policy_epoch, leaseFence: row.lease_fence, state: row.state, sequence: row.sequence, attempt: row.attempt, createdAt: row.created_at, updatedAt: row.updated_at, changes: JSON.parse(row.changes_json) as SourceRefChange[], atomic: row.atomic === 1, eligibilityId: row.eligibility_id, reason: row.reason, policyReceipt: row.policy_receipt_json ? JSON.parse(row.policy_receipt_json) as PolicyReceipt : null, providerReceipt: row.provider_receipt_json ? JSON.parse(row.provider_receipt_json) as ProviderPublicationReceipt : null, observationReceipt: row.observation_receipt_json ? JSON.parse(row.observation_receipt_json) as ProviderObservationReceipt : null, reasonCode: row.reason_code }; }
function newRecord(intent: GitPublicationIntent, scope: PublicationScope, sequence: number, now: string): PublicationJournalRecord { return { tenantId: intent.tenantId, repositoryId: intent.repositoryId, principalId: intent.principalId, operationId: intent.operationId, idempotencyKey: intent.idempotencyKey, requestDigest: scope.requestDigest, journalId: scope.journalId, expectedVersion: intent.expectedVersion, policyEpoch: intent.policyEpoch, leaseFence: intent.leaseFence, state: "prepared", sequence, attempt: 0, createdAt: now, updatedAt: now, changes: intent.changes.map((change) => ({ ...change })), atomic: intent.atomic, eligibilityId: intent.eligibilityId, reason: intent.reason, policyReceipt: null, providerReceipt: null, observationReceipt: null, reasonCode: null }; }
function assertTransitionCurrent(record: PublicationJournalRecord, expectedState: PublicationJournalExpected, journalId: string): void { if (record.state === "accepted" || record.state === "rejected") throw new PublicationConflictError({ reason: `terminal publication ${record.state} is immutable`, journalId }); if (record.state !== expectedState.state || record.attempt !== expectedState.attempt) throw new PublicationConflictError({ reason: `expected ${expectedState.state}/${expectedState.attempt}, got ${record.state}/${record.attempt}`, journalId }); }
function fromDurableSql<A>(tryValue: () => A): Effect.Effect<A, PublicationConflictError | PublicationStorageError> { return Effect.try({ try: tryValue, catch: toDurableSqlError }); }
function toDurableSqlError(error: unknown): PublicationConflictError | PublicationStorageError { return hasTag(error, "PublicationConflictError") ? error as PublicationConflictError : new PublicationStorageError({ reason: "durable publication journal storage failure", cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }); }
function hasTag(error: unknown, tag: string): boolean { return typeof error === "object" && error !== null && "_tag" in error && (error as { readonly _tag?: unknown })._tag === tag; }
function isJsonObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function json(body: unknown, status = 200): Response { return Response.json(body, { status }); }

export { makePublicationScope };
