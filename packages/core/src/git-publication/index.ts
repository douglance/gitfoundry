import { Data, Effect } from "effect";

export type PublicationState = "prepared" | "publishing" | "accepted" | "rejected" | "unknown";
export type SourceOperationStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";

export interface SourceRefChange { readonly ref: string; readonly old_sha: string | null; readonly new_sha: string | null; readonly force: boolean }

export interface GitPublicationIntent {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly principalId: string;
  readonly operationId: "repo.ref-update";
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly policyEpoch: number;
  readonly leaseFence: string;
  readonly atomic: boolean;
  readonly eligibilityId: string | null;
  readonly reason: string;
  readonly changes: readonly SourceRefChange[];
}

export interface PublicationScope { readonly scope: string; readonly requestDigest: string; readonly journalId: string }
export interface PublicationRecoveryScope { readonly tenantId: string; readonly repositoryId: string; readonly journalId: string }
export interface PolicyReceipt { readonly receiptId: string; readonly tenantId: string; readonly repositoryId: string; readonly principalId: string; readonly capability: "repository.write"; readonly policyEpoch: number; readonly leaseFence: string; readonly observedAt: string }
export interface ProviderRefObservation { readonly ref: string; readonly oid: string | null }
export interface ProviderObservationReceipt { readonly receiptId: string; readonly providerRequestId: string; readonly observedAt: string; readonly refs: readonly ProviderRefObservation[] }
export interface ProviderPublicationReceipt { readonly receiptId: string; readonly providerRequestId: string; readonly submittedAt: string; readonly capability: "old-oid-cas"; readonly tenantId: string; readonly repositoryId: string; readonly principalId: string; readonly operationId: "repo.ref-update"; readonly idempotencyKey: string; readonly policyEpoch: number; readonly leaseFence: string; readonly refs: readonly SourceRefChange[] }

export interface RefPublicationResult {
  readonly repository_id: string;
  readonly atomic: boolean;
  readonly changes: readonly { readonly ref: string; readonly old_sha: string | null; readonly new_sha: string | null; readonly outcome: "accepted" | "rejected" | "unchanged" | "unknown"; readonly reason_code: string | null }[];
  readonly journal_id: string;
}

export interface SourceOperationRecord { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly status: SourceOperationStatus; readonly kind: "repo.ref-update"; readonly progress: Record<string, unknown>; readonly result: Record<string, unknown> | RefPublicationResult; readonly error: null | { readonly code: string; readonly detail: string; readonly request_id: string; readonly retryable: boolean; readonly details: Record<string, unknown> } }
export interface PublicationOutcome { readonly state: PublicationState; readonly replayed: boolean; readonly operation: SourceOperationRecord; readonly journal: PublicationJournalRecord }

export interface PublicationJournalRecord {
  readonly tenantId: string; readonly repositoryId: string; readonly principalId: string; readonly operationId: "repo.ref-update"; readonly idempotencyKey: string; readonly requestDigest: string; readonly journalId: string; readonly expectedVersion: number; readonly policyEpoch: number; readonly leaseFence: string; readonly state: PublicationState; readonly sequence: number; readonly attempt: number; readonly createdAt: string; readonly updatedAt: string; readonly changes: readonly SourceRefChange[]; readonly atomic: boolean; readonly eligibilityId: string | null; readonly reason: string; readonly policyReceipt: PolicyReceipt | null; readonly providerReceipt: ProviderPublicationReceipt | null; readonly observationReceipt: ProviderObservationReceipt | null; readonly reasonCode: string | null
}

export interface PublicationJournalExpected { readonly state: PublicationState; readonly attempt: number }
export interface PublicationJournal {
  readonly reservePrepared: (intent: GitPublicationIntent, scope: PublicationScope, now: string) => Effect.Effect<{ readonly record: PublicationJournalRecord; readonly replayed: boolean }, PublicationConflictError | PublicationStorageError>;
  readonly markPublishing: (journalId: string, expected: PublicationJournalExpected, policyReceipt: PolicyReceipt, now: string) => Effect.Effect<PublicationJournalRecord, PublicationConflictError | PublicationStorageError>;
  readonly finish: (journalId: string, expected: PublicationJournalExpected, state: "accepted" | "rejected" | "unknown", receipt: ProviderPublicationReceipt | null, observation: ProviderObservationReceipt | null, reasonCode: string | null, now: string) => Effect.Effect<PublicationJournalRecord, PublicationConflictError | PublicationStorageError>;
  readonly get: (journalId: string) => Effect.Effect<PublicationJournalRecord | undefined, PublicationConflictError | PublicationStorageError>;
}

export interface PolicyAdmissionPort { readonly revalidate: (intent: GitPublicationIntent) => Effect.Effect<PolicyReceipt, PublicationDeniedError | PublicationProviderError> }
export interface TrustedGitPublicationPort { readonly observeRefs: (intent: Pick<GitPublicationIntent, "tenantId" | "repositoryId" | "changes">) => Effect.Effect<ProviderObservationReceipt, PublicationProviderError>; readonly publishRefs: (intent: GitPublicationIntent, policy: PolicyReceipt) => Effect.Effect<ProviderPublicationReceipt, PublicationProviderError> }
export interface PublicationClock { readonly now: () => Date }

export class PublicationInputError extends Data.TaggedError("PublicationInputError")<{ readonly reason: string }> {}
export class PublicationConflictError extends Data.TaggedError("PublicationConflictError")<{ readonly reason: string; readonly journalId?: string }> {}
export class PublicationStorageError extends Data.TaggedError("PublicationStorageError")<{ readonly reason: string; readonly cause: string }> {}
export class PublicationDeniedError extends Data.TaggedError("PublicationDeniedError")<{ readonly reason: string; readonly tenantId: string; readonly principalId: string; readonly capability: string }> {}
export class PublicationProviderError extends Data.TaggedError("PublicationProviderError")<{ readonly kind: "unreachable" | "unsupported" | "timeout_after_handoff" | "cas_mismatch"; readonly detail: string; readonly receipt?: ProviderPublicationReceipt }> {}

export function makePublicationCoordinator(input: { readonly journal: PublicationJournal; readonly policy: PolicyAdmissionPort; readonly provider: TrustedGitPublicationPort; readonly clock?: PublicationClock }) {
  const clock = input.clock ?? { now: () => new Date() };
  return {
    recover: (scope: PublicationRecoveryScope): Effect.Effect<PublicationOutcome, PublicationInputError | PublicationConflictError | PublicationStorageError | PublicationProviderError> => Effect.gen(function* () {
      if (typeof scope.tenantId !== "string" || !scope.tenantId || typeof scope.repositoryId !== "string" || !scope.repositoryId || typeof scope.journalId !== "string" || !/^gitpub-[0-9a-f]{32}$/.test(scope.journalId)) {
        return yield* Effect.fail(new PublicationInputError({ reason: "recovery requires tenant, repository and a publication journal ID" }));
      }
      const record = yield* input.journal.get(scope.journalId);
      if (!record || record.tenantId !== scope.tenantId || record.repositoryId !== scope.repositoryId || record.journalId !== scope.journalId) {
        return yield* Effect.fail(new PublicationConflictError({ reason: "publication recovery scope mismatch or missing record", journalId: scope.journalId }));
      }
      const storedScope = yield* makePublicationScope(toIntent(record));
      if (storedScope.journalId !== record.journalId || storedScope.requestDigest !== record.requestDigest) {
        return yield* Effect.fail(new PublicationConflictError({ reason: "publication recovery intent binding mismatch", journalId: scope.journalId }));
      }
      if (record.state === "accepted") {
        if (!validProviderReceipt(record, record.providerReceipt) || !record.observationReceipt || acceptedReason(record.changes, record.observationReceipt) !== "accepted") {
          return yield* Effect.fail(new PublicationConflictError({ reason: "accepted publication recovery evidence mismatch", journalId: scope.journalId }));
        }
        return outcome(record, true);
      }
      if (record.state === "prepared" || record.state === "rejected") return outcome(record, true);
      return yield* reconcile(record, true);
    }),
    publish: (intent: GitPublicationIntent): Effect.Effect<PublicationOutcome, PublicationInputError | PublicationConflictError | PublicationStorageError | PublicationDeniedError | PublicationProviderError> => Effect.gen(function* () {
      yield* validateIntentEffect(intent);
      const scope = yield* makePublicationScope(intent);
      const reserved = yield* input.journal.reservePrepared(intent, scope, clock.now().toISOString());
      if (reserved.replayed) {
        const replayPolicy = yield* input.policy.revalidate(toIntent(reserved.record));
        yield* assertPolicyReceiptMatches(reserved.record, replayPolicy);
        if (reserved.record.state === "accepted" || reserved.record.state === "rejected") return outcome(reserved.record, true);
        if (reserved.record.state === "publishing" || reserved.record.state === "unknown") return yield* reconcile(reserved.record, true);
      }
      return yield* finalizePrepared(reserved.record, false);
    })
  };

  function finalizePrepared(record: PublicationJournalRecord, replayed: boolean): Effect.Effect<PublicationOutcome, PublicationConflictError | PublicationStorageError | PublicationDeniedError | PublicationProviderError> {
    return Effect.gen(function* () {
      const preflight = yield* input.provider.observeRefs({ tenantId: record.tenantId, repositoryId: record.repositoryId, changes: record.changes }).pipe(Effect.map((receipt) => ({ kind: "receipt" as const, receipt })), Effect.catch((error) => Effect.map(markRejected(record, "provider_unreachable", null, null, replayed), (handled) => ({ kind: "outcome" as const, outcome: handled, error }))));
      if (preflight.kind === "outcome") return preflight.outcome;
      const stale = staleReason(record.changes, preflight.receipt);
      if (stale) return yield* markRejected(record, stale, null, preflight.receipt, replayed);
      const policyDecision = yield* input.policy.revalidate(toIntent(record)).pipe(Effect.map((receipt) => ({ kind: "receipt" as const, receipt })), Effect.catch((error) => Effect.map(markRejected(record, "policy_denied", null, preflight.receipt, replayed), () => ({ kind: "denied" as const, error }))));
      if (policyDecision.kind === "denied") return yield* Effect.fail(policyDecision.error);
      const policyMismatch = policyReceiptMismatch(record, policyDecision.receipt);
      if (policyMismatch) {
        yield* markRejected(record, policyMismatch, null, preflight.receipt, replayed);
        return yield* Effect.fail(new PublicationConflictError({ reason: policyMismatch, journalId: record.journalId }));
      }
      const publishing = yield* input.journal.markPublishing(record.journalId, expected(record), policyDecision.receipt, clock.now().toISOString());
      const submitted = yield* input.provider.publishRefs(toIntent(publishing), policyDecision.receipt).pipe(Effect.map((receipt) => ({ kind: "receipt" as const, receipt })), Effect.catch((error) => {
        if (error.kind === "timeout_after_handoff") return Effect.map(markUnknown(publishing, validProviderReceipt(publishing, error.receipt ?? null), null, "provider_timeout_after_handoff", replayed), (handled) => ({ kind: "outcome" as const, outcome: handled }));
        return Effect.map(markRejected(publishing, error.kind === "unsupported" ? "provider_capability_unsupported" : error.kind === "cas_mismatch" ? "provider_cas_mismatch" : "provider_unreachable", null, null, replayed), (handled) => ({ kind: "outcome" as const, outcome: handled }));
      }));
      if (submitted.kind === "outcome") return submitted.outcome;
      const ownReceipt = validProviderReceipt(publishing, submitted.receipt);
      if (!ownReceipt) return yield* markUnknown(publishing, null, null, "provider_receipt_mismatch", replayed);
      const readback = yield* input.provider.observeRefs({ tenantId: publishing.tenantId, repositoryId: publishing.repositoryId, changes: publishing.changes }).pipe(Effect.map((receipt) => ({ kind: "receipt" as const, receipt })), Effect.catch(() => Effect.map(markUnknown(publishing, ownReceipt, null, "readback_unavailable", replayed), (handled) => ({ kind: "outcome" as const, outcome: handled }))));
      if (readback.kind === "outcome") return readback.outcome;
      return yield* classifyReadback(publishing, ownReceipt, readback.receipt, replayed);
    });
  }

  function reconcile(record: PublicationJournalRecord, replayed: boolean): Effect.Effect<PublicationOutcome, PublicationConflictError | PublicationStorageError | PublicationProviderError> {
    return Effect.gen(function* () {
      const readback = yield* input.provider.observeRefs({ tenantId: record.tenantId, repositoryId: record.repositoryId, changes: record.changes }).pipe(Effect.map((receipt) => ({ kind: "receipt" as const, receipt })), Effect.catch(() => Effect.map(markUnknown(record, record.providerReceipt, null, "reconcile_readback_unavailable", replayed), (handled) => ({ kind: "outcome" as const, outcome: handled }))));
      if (readback.kind === "outcome") return readback.outcome;
      const ownReceipt = validProviderReceipt(record, record.providerReceipt);
      if (!ownReceipt) return yield* markUnknown(record, null, readback.receipt, "missing_provider_commit_receipt", replayed);
      return yield* classifyReadback(record, ownReceipt, readback.receipt, replayed);
    });
  }

  function classifyReadback(record: PublicationJournalRecord, receipt: ProviderPublicationReceipt, observation: ProviderObservationReceipt, replayed: boolean): Effect.Effect<PublicationOutcome, PublicationConflictError | PublicationStorageError> {
    return Effect.gen(function* () {
      const state = acceptedReason(record.changes, observation);
      if (state === "accepted") return outcome(yield* input.journal.finish(record.journalId, expected(record), "accepted", receipt, observation, null, clock.now().toISOString()), replayed);
      if (state === "rejected") return yield* markRejected(record, "provider_not_applied", receipt, observation, replayed);
      return yield* markUnknown(record, receipt, observation, "provider_partial_or_diverged", replayed);
    });
  }

  function markRejected(record: PublicationJournalRecord, reasonCode: string, receipt: ProviderPublicationReceipt | null, observation: ProviderObservationReceipt | null, replayed = false): Effect.Effect<PublicationOutcome, PublicationConflictError | PublicationStorageError> {
    return Effect.gen(function* () { return outcome(yield* input.journal.finish(record.journalId, expected(record), "rejected", receipt, observation, reasonCode, clock.now().toISOString()), replayed); });
  }

  function markUnknown(record: PublicationJournalRecord, receipt: ProviderPublicationReceipt | null, observation: ProviderObservationReceipt | null, reasonCode: string, replayed = false): Effect.Effect<PublicationOutcome, PublicationConflictError | PublicationStorageError> {
    return Effect.gen(function* () { return outcome(yield* input.journal.finish(record.journalId, expected(record), "unknown", receipt, observation, reasonCode, clock.now().toISOString()), replayed); });
  }
}

export function makePublicationScope(intent: GitPublicationIntent): Effect.Effect<PublicationScope, PublicationInputError> {
  return Effect.gen(function* () {
    yield* validateIntentEffect(intent);
    const keyHex = yield* sha256Hex(canonicalJson(["gitfoundry.git-publication.key.v1", intent.idempotencyKey]));
    const scope = canonicalJson([intent.tenantId, intent.repositoryId, intent.principalId, intent.operationId, `sha256:${keyHex}`]);
    const scopeHex = yield* sha256Hex(canonicalJson(["gitfoundry.git-publication.scope.v1", scope]));
    const requestHex = yield* sha256Hex(canonicalJson(["gitfoundry.git-publication.request.v1", semanticIntent(intent)]));
    return { scope, requestDigest: `sha256:${requestHex}`, journalId: `gitpub-${scopeHex.slice(0, 32)}` };
  });
}

export function makeInMemoryPublicationJournal(): PublicationJournal & { readonly records: () => readonly PublicationJournalRecord[] } {
  const records = new Map<string, PublicationJournalRecord>();
  let sequence = 0;
  const openStates = new Set<PublicationState>(["prepared", "publishing", "unknown"]);
  return {
    reservePrepared: (intent, scope, now) => fromJournalSync(() => {
      const existing = records.get(scope.journalId);
      if (existing) {
        if (existing.requestDigest !== scope.requestDigest) throw new PublicationConflictError({ reason: "idempotency key was reused with different ref publication input", journalId: existing.journalId });
        return { record: cloneRecord(existing), replayed: true };
      }
      for (const record of records.values()) {
        if (record.tenantId === intent.tenantId && record.repositoryId === intent.repositoryId && openStates.has(record.state) && overlaps(record.changes, intent.changes)) throw new PublicationConflictError({ reason: "repository ref publication is already fenced by an unresolved journal", journalId: record.journalId });
      }
      const record = newRecord(intent, scope, ++sequence, now);
      records.set(record.journalId, record);
      return { record: cloneRecord(record), replayed: false };
    }),
    markPublishing: (journalId, expectedState, policyReceipt, now) => fromJournalSync(() => {
      const current = requiredRecord(records, journalId);
      assertTransitionCurrent(current, expectedState, journalId);
      const next = { ...current, state: "publishing" as const, attempt: current.attempt + 1, policyReceipt, updatedAt: now };
      records.set(journalId, next);
      return cloneRecord(next);
    }),
    finish: (journalId, expectedState, state, receipt, observation, reasonCode, now) => fromJournalSync(() => {
      const current = requiredRecord(records, journalId);
      assertTransitionCurrent(current, expectedState, journalId);
      const next = { ...current, state, providerReceipt: receipt, observationReceipt: observation, reasonCode, updatedAt: now };
      records.set(journalId, next);
      return cloneRecord(next);
    }),
    get: (journalId) => fromJournalSync(() => records.get(journalId) ? cloneRecord(requiredRecord(records, journalId)) : undefined),
    records: () => Array.from(records.values(), cloneRecord)
  };
}

export function makeFakePolicyPort(input: { readonly policyEpoch?: number; readonly deny?: boolean; readonly calls?: GitPublicationIntent[]; readonly clock?: PublicationClock; readonly receipt?: (intent: GitPublicationIntent, receipt: PolicyReceipt) => PolicyReceipt } = {}): PolicyAdmissionPort {
  const clock = input.clock ?? { now: () => new Date("2026-10-08T00:00:00.000Z") };
  return { revalidate: (intent) => {
    input.calls?.push(intent);
    if (input.deny) return Effect.fail(new PublicationDeniedError({ reason: "policy denied", tenantId: intent.tenantId, principalId: intent.principalId, capability: "repository.write" }));
    if ((input.policyEpoch ?? intent.policyEpoch) !== intent.policyEpoch) return Effect.fail(new PublicationDeniedError({ reason: "policy epoch is not current", tenantId: intent.tenantId, principalId: intent.principalId, capability: "repository.write" }));
    const receipt = { receiptId: `policy-${intent.leaseFence}`, tenantId: intent.tenantId, repositoryId: intent.repositoryId, principalId: intent.principalId, capability: "repository.write", policyEpoch: intent.policyEpoch, leaseFence: intent.leaseFence, observedAt: clock.now().toISOString() } satisfies PolicyReceipt;
    return Effect.succeed(input.receipt ? input.receipt(intent, receipt) : receipt);
  } };
}

export function makeFakeProviderPort(input: { readonly refs: Map<string, string | null>; readonly calls?: string[]; readonly failPublish?: PublicationProviderError; readonly failObserve?: PublicationProviderError; readonly beforePublish?: (intent: GitPublicationIntent) => void; readonly receipt?: (intent: GitPublicationIntent, receipt: ProviderPublicationReceipt) => ProviderPublicationReceipt; readonly clock?: PublicationClock }): TrustedGitPublicationPort {
  const clock = input.clock ?? { now: () => new Date("2026-10-08T00:00:00.000Z") };
  return {
    observeRefs: (intent) => {
      input.calls?.push("observe");
      if (input.failObserve) return Effect.fail(input.failObserve);
      return Effect.succeed({ receiptId: `observe-${input.calls?.length ?? 0}`, providerRequestId: `provider-observe-${input.calls?.length ?? 0}`, observedAt: clock.now().toISOString(), refs: intent.changes.map((change) => ({ ref: change.ref, oid: input.refs.get(change.ref) ?? null })) });
    },
    publishRefs: (intent, policy) => {
      input.calls?.push("publish");
      if (policy.policyEpoch !== intent.policyEpoch || policy.leaseFence !== intent.leaseFence) return Effect.fail(new PublicationProviderError({ kind: "unsupported", detail: "policy receipt does not match publication fence" }));
      if (input.failPublish) return Effect.fail(input.failPublish);
      input.beforePublish?.(intent);
      for (const change of intent.changes) if ((input.refs.get(change.ref) ?? null) !== change.old_sha) return Effect.fail(new PublicationProviderError({ kind: "cas_mismatch", detail: `old OID changed for ${change.ref}` }));
      for (const change of intent.changes) input.refs.set(change.ref, change.new_sha);
      const receipt = { receiptId: `publish-${intent.leaseFence}`, providerRequestId: `provider-publish-${intent.leaseFence}`, submittedAt: clock.now().toISOString(), capability: "old-oid-cas", tenantId: intent.tenantId, repositoryId: intent.repositoryId, principalId: intent.principalId, operationId: intent.operationId, idempotencyKey: intent.idempotencyKey, policyEpoch: intent.policyEpoch, leaseFence: intent.leaseFence, refs: intent.changes.map((change) => ({ ...change })) } satisfies ProviderPublicationReceipt;
      return Effect.succeed(input.receipt ? input.receipt(intent, receipt) : receipt);
    }
  };
}

export function sourceOperationFromJournal(record: PublicationJournalRecord, replayed = false): SourceOperationRecord {
  const status: SourceOperationStatus = record.state === "accepted" ? "succeeded" : record.state === "rejected" ? "failed" : "running";
  return { tenant_id: record.tenantId, id: record.journalId, version: Math.max(1, record.attempt + 1), created_at: record.createdAt, updated_at: record.updatedAt, status, kind: "repo.ref-update", progress: { state: record.state, sequence: record.sequence, attempt: record.attempt, replayed }, result: record.state === "accepted" || record.state === "rejected" || record.state === "unknown" ? refMutationResult(record) : {}, error: record.state === "rejected" ? { code: record.reasonCode ?? "ref_publication_rejected", detail: record.reasonCode ?? "ref publication rejected", request_id: record.journalId, retryable: false, details: {} } : null };
}

function expected(record: PublicationJournalRecord): PublicationJournalExpected { return { state: record.state, attempt: record.attempt }; }
function outcome(record: PublicationJournalRecord, replayed: boolean): PublicationOutcome { return { state: record.state, replayed, operation: sourceOperationFromJournal(record, replayed), journal: record }; }
function refMutationResult(record: PublicationJournalRecord): RefPublicationResult { return { repository_id: record.repositoryId, atomic: record.atomic, journal_id: record.journalId, changes: record.changes.map((change) => ({ ref: change.ref, old_sha: change.old_sha, new_sha: change.new_sha, outcome: record.state === "accepted" ? "accepted" : record.state === "rejected" ? "rejected" : "unknown", reason_code: record.state === "accepted" ? null : record.reasonCode })) }; }
function newRecord(intent: GitPublicationIntent, scope: PublicationScope, sequence: number, now: string): PublicationJournalRecord { return { tenantId: intent.tenantId, repositoryId: intent.repositoryId, principalId: intent.principalId, operationId: intent.operationId, idempotencyKey: intent.idempotencyKey, requestDigest: scope.requestDigest, journalId: scope.journalId, expectedVersion: intent.expectedVersion, policyEpoch: intent.policyEpoch, leaseFence: intent.leaseFence, state: "prepared", sequence, attempt: 0, createdAt: now, updatedAt: now, changes: intent.changes.map((change) => ({ ...change })), atomic: intent.atomic, eligibilityId: intent.eligibilityId, reason: intent.reason, policyReceipt: null, providerReceipt: null, observationReceipt: null, reasonCode: null }; }
function toIntent(record: PublicationJournalRecord): GitPublicationIntent { return { tenantId: record.tenantId, repositoryId: record.repositoryId, principalId: record.principalId, operationId: record.operationId, idempotencyKey: record.idempotencyKey, expectedVersion: record.expectedVersion, policyEpoch: record.policyEpoch, leaseFence: record.leaseFence, atomic: record.atomic, eligibilityId: record.eligibilityId, reason: record.reason, changes: record.changes }; }

function validateIntentEffect(intent: GitPublicationIntent): Effect.Effect<void, PublicationInputError> { const error = validateIntentError(intent); return error ? Effect.fail(error) : Effect.void; }

function validateIntentError(intent: GitPublicationIntent): PublicationInputError | null {
  if (intent.operationId !== "repo.ref-update") return new PublicationInputError({ reason: "operation must be repo.ref-update" });
  if (!intent.tenantId || !intent.repositoryId || !intent.principalId || !intent.idempotencyKey || !intent.leaseFence) return new PublicationInputError({ reason: "tenant, repository, principal, idempotency key and lease fence are required" });
  if (!Number.isInteger(intent.expectedVersion) || intent.expectedVersion < 1) return new PublicationInputError({ reason: "expected_version must be a positive integer" });
  if (!Number.isInteger(intent.policyEpoch) || intent.policyEpoch < 1) return new PublicationInputError({ reason: "policy epoch must be a positive integer" });
  if (intent.changes.length < 1 || intent.changes.length > 100) return new PublicationInputError({ reason: "ref publication requires 1 to 100 changes" });
  const refs = new Set<string>();
  for (const change of intent.changes) {
    if (!validPublicationRef(change.ref)) return new PublicationInputError({ reason: `invalid or reserved ref ${change.ref}` });
    if (refs.has(change.ref)) return new PublicationInputError({ reason: `duplicate ref ${change.ref}` });
    refs.add(change.ref);
    if (change.old_sha === null && change.new_sha === null) return new PublicationInputError({ reason: `ref ${change.ref} cannot delete an absent ref` });
    if (change.old_sha !== null && !isOid(change.old_sha)) return new PublicationInputError({ reason: `invalid old_sha for ${change.ref}` });
    if (change.new_sha !== null && !isOid(change.new_sha)) return new PublicationInputError({ reason: `invalid new_sha for ${change.ref}` });
    if (change.force && change.old_sha === null) return new PublicationInputError({ reason: `force intent for ${change.ref} still requires an old_sha lease` });
  }
  for (const ref of refs) {
    const components = ref.split("/");
    for (let index = 1; index < components.length; index++) {
      if (refs.has(components.slice(0, index).join("/"))) return new PublicationInputError({ reason: `ref path collision for ${ref}` });
    }
  }
  return null;
}

function validPublicationRef(ref: string): boolean {
  if (typeof ref !== "string" || !/^refs\/(heads|tags)\/.+$/u.test(ref)) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/u.test(ref) || ref.includes("..") || ref.includes("@{") || ref.endsWith(".")) return false;
  return ref.split("/").every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"));
}

function policyReceiptMismatch(record: PublicationJournalRecord, receipt: PolicyReceipt): string | null { if (receipt.tenantId !== record.tenantId) return "policy_receipt_tenant_mismatch"; if (receipt.repositoryId !== record.repositoryId) return "policy_receipt_repository_mismatch"; if (receipt.principalId !== record.principalId) return "policy_receipt_principal_mismatch"; if (receipt.capability !== "repository.write") return "policy_receipt_capability_mismatch"; if (receipt.policyEpoch !== record.policyEpoch) return "policy_receipt_epoch_mismatch"; if (receipt.leaseFence !== record.leaseFence) return "policy_receipt_fence_mismatch"; return null; }
function assertPolicyReceiptMatches(record: PublicationJournalRecord, receipt: PolicyReceipt): Effect.Effect<void, PublicationConflictError> { const mismatch = policyReceiptMismatch(record, receipt); return mismatch ? Effect.fail(new PublicationConflictError({ reason: mismatch, journalId: record.journalId })) : Effect.void; }
function validProviderReceipt(record: PublicationJournalRecord, receipt: ProviderPublicationReceipt | null): ProviderPublicationReceipt | null { if (!receipt) return null; if (receipt.capability !== "old-oid-cas") return null; if (receipt.tenantId !== record.tenantId || receipt.repositoryId !== record.repositoryId || receipt.principalId !== record.principalId) return null; if (receipt.operationId !== record.operationId || receipt.idempotencyKey !== record.idempotencyKey) return null; if (receipt.policyEpoch !== record.policyEpoch || receipt.leaseFence !== record.leaseFence) return null; if (!sameChanges(receipt.refs, record.changes)) return null; return clonePublicationReceipt(receipt); }
function staleReason(changes: readonly SourceRefChange[], receipt: ProviderObservationReceipt): string | null { for (const change of changes) { const observed = receipt.refs.find((candidate) => candidate.ref === change.ref); if (observed?.oid !== change.old_sha) return "stale_ref"; } return null; }
function acceptedReason(changes: readonly SourceRefChange[], receipt: ProviderObservationReceipt): "accepted" | "rejected" | "unknown" { let allNew = true; let allOld = true; for (const change of changes) { const observed = receipt.refs.find((candidate) => candidate.ref === change.ref); if (observed?.oid !== change.new_sha) allNew = false; if (observed?.oid !== change.old_sha) allOld = false; } if (allNew) return "accepted"; if (allOld) return "rejected"; return "unknown"; }
function isOid(value: string): boolean { return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) && value !== "0".repeat(40); }
function overlaps(left: readonly SourceRefChange[], right: readonly SourceRefChange[]): boolean { const refs = new Set(left.map((change) => change.ref)); return right.some((change) => refs.has(change.ref)); }
function assertTransitionCurrent(record: PublicationJournalRecord, expectedState: PublicationJournalExpected, journalId: string): void { if (record.state === "accepted" || record.state === "rejected") throw new PublicationConflictError({ reason: `terminal publication ${record.state} is immutable`, journalId }); if (record.state !== expectedState.state || record.attempt !== expectedState.attempt) throw new PublicationConflictError({ reason: `expected ${expectedState.state}/${expectedState.attempt}, got ${record.state}/${record.attempt}`, journalId }); }
function requiredRecord(records: Map<string, PublicationJournalRecord>, journalId: string): PublicationJournalRecord { const record = records.get(journalId); if (!record) throw new PublicationConflictError({ reason: "publication journal record not found", journalId }); return record; }
function fromJournalSync<A>(tryValue: () => A): Effect.Effect<A, PublicationConflictError | PublicationStorageError> { return Effect.try({ try: tryValue, catch: toJournalError }); }
function toJournalError(error: unknown): PublicationConflictError | PublicationStorageError { return hasTag(error, "PublicationConflictError") ? error as PublicationConflictError : new PublicationStorageError({ reason: "publication journal storage failure", cause: String(error) }); }
function hasTag(error: unknown, tag: string): boolean { return typeof error === "object" && error !== null && "_tag" in error && (error as { readonly _tag?: unknown })._tag === tag; }
function cloneRecord(record: PublicationJournalRecord): PublicationJournalRecord { return { ...record, changes: record.changes.map((change) => ({ ...change })), policyReceipt: record.policyReceipt ? { ...record.policyReceipt } : null, providerReceipt: clonePublicationReceipt(record.providerReceipt), observationReceipt: record.observationReceipt ? { ...record.observationReceipt, refs: record.observationReceipt.refs.map((ref) => ({ ...ref })) } : null }; }
function clonePublicationReceipt(receipt: ProviderPublicationReceipt | null): ProviderPublicationReceipt | null { return receipt ? { ...receipt, refs: receipt.refs.map((change) => ({ ...change })) } : null; }
function sameChanges(left: readonly SourceRefChange[], right: readonly SourceRefChange[]): boolean { if (left.length !== right.length) return false; return left.every((change, index) => { const other = right[index]; return !!other && change.ref === other.ref && change.old_sha === other.old_sha && change.new_sha === other.new_sha && change.force === other.force; }); }
function semanticIntent(intent: GitPublicationIntent): unknown { return { tenantId: intent.tenantId, repositoryId: intent.repositoryId, principalId: intent.principalId, operationId: intent.operationId, expectedVersion: intent.expectedVersion, policyEpoch: intent.policyEpoch, leaseFence: intent.leaseFence, atomic: intent.atomic, eligibilityId: intent.eligibilityId, reason: intent.reason, changes: intent.changes.map((change) => ({ ref: change.ref, old_sha: change.old_sha, new_sha: change.new_sha, force: change.force })) }; }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`; return JSON.stringify(value); }
function sha256Hex(value: string): Effect.Effect<string, PublicationInputError> { return Effect.tryPromise({ try: async () => { if (!globalThis.crypto?.subtle) throw new Error("WebCrypto subtle digest is unavailable"); const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }, catch: (error) => new PublicationInputError({ reason: String(error) }) }); }
