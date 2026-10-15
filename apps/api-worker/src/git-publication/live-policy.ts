import { Effect } from "effect";

import {
  PublicationDeniedError,
  PublicationProviderError,
  makePublicationScope,
  type GitPublicationIntent,
  type PolicyAdmissionPort,
  type PolicyReceipt
} from "../../../../packages/core/src/git-publication/index.js";
import { makeD1IdentityPort, type Clock, type D1DatabaseLike } from "../../../../packages/core/src/live/index.js";

export interface D1PublicationPolicyOptions {
  readonly clock?: Clock;
  readonly validatePreparedChanges?: (intent: GitPublicationIntent) => Effect.Effect<void, PublicationDeniedError | PublicationProviderError>;
}

interface RepositoryAdmissionRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly version: number;
  readonly archived: number;
}

const systemClock: Clock = { now: () => new Date() };
const capability = "repository.write" as const;
const unresolvedId = "unresolved";
const identityDenialReasons = new Set([
  "policy epoch is not current",
  "principal inactive or missing",
  "qualified directory membership inactive or missing",
  "capability grant denied",
  "principal inactive or policy epoch stale"
]);

export function makeD1PublicationPolicy(db: D1DatabaseLike, options: D1PublicationPolicyOptions = {}): PolicyAdmissionPort {
  const clock = options.clock ?? systemClock;
  const identity = makeD1IdentityPort(db, clock);
  return {
    revalidate: (intent) => Effect.gen(function* () {
      if (!isRecord(intent)) return yield* Effect.fail(denied(intent, "invalid publication intent"));
      const scope = yield* makePublicationScope(intent).pipe(Effect.mapError((error) => denied(intent, error.reason)));
      yield* serverNow(clock);
      const validator = options.validatePreparedChanges;
      if (!validator) return yield* Effect.fail(unavailable("live publication prepared-change validator is not configured"));

      yield* admit(identity, db, intent);
      yield* validator(intent);
      yield* admit(identity, db, intent);
      const observedAt = yield* serverNow(clock);

      return {
        receiptId: `policy-${scope.journalId}`,
        tenantId: intent.tenantId,
        repositoryId: intent.repositoryId,
        principalId: intent.principalId,
        capability,
        policyEpoch: intent.policyEpoch,
        leaseFence: intent.leaseFence,
        observedAt
      } satisfies PolicyReceipt;
    })
  };
}

function admit(identity: ReturnType<typeof makeD1IdentityPort>, db: D1DatabaseLike, intent: GitPublicationIntent): Effect.Effect<void, PublicationDeniedError | PublicationProviderError> {
  return Effect.gen(function* () {
    yield* identity.describePrincipal({ tenantId: intent.tenantId, principalId: intent.principalId, policyEpoch: intent.policyEpoch }).pipe(Effect.mapError((error) => identityAdmissionError(intent, error, "principal is not authorized for publication")));
    yield* identity.verifyGrant({ tenantId: intent.tenantId, principalId: intent.principalId, capability, policyEpoch: intent.policyEpoch }).pipe(Effect.mapError((error) => identityAdmissionError(intent, error, "repository.write grant denied")));
    yield* requireRepositoryAdmission(db, intent);
  });
}

function requireRepositoryAdmission(db: D1DatabaseLike, intent: GitPublicationIntent): Effect.Effect<void, PublicationDeniedError | PublicationProviderError> {
  return Effect.tryPromise({
    try: async () => {
      const row = await db.prepare("SELECT tenant_id, id, version, archived FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(intent.tenantId, intent.repositoryId).first<RepositoryAdmissionRow>();
      if (!row) throw denied(intent, "repository is not active for tenant");
      if (row.tenant_id !== intent.tenantId || row.id !== intent.repositoryId) throw denied(intent, "repository tenant isolation failed");
      if (!Number.isSafeInteger(row.version) || row.version < 1) throw denied(intent, "repository version is malformed");
      if (row.archived !== 0 && row.archived !== 1) throw denied(intent, "repository archive state is malformed");
      if (row.archived !== 0) throw denied(intent, "repository is archived");
      if (row.version !== intent.expectedVersion) throw denied(intent, "repository version is stale");
    },
    catch: (error) => {
      if (isPublicationDenied(error)) return error;
      return unavailable("live publication repository admission storage failed");
    }
  });
}

function serverNow(clock: Clock): Effect.Effect<string, PublicationProviderError> {
  return Effect.try({
    try: () => {
      const now = clock.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("invalid server clock");
      return now.toISOString();
    },
    catch: () => unavailable("live publication policy clock is unavailable")
  });
}

function denied(intent: unknown, reason: string): PublicationDeniedError {
  return new PublicationDeniedError({ reason, tenantId: stringField(intent, "tenantId"), principalId: stringField(intent, "principalId"), capability });
}

function unavailable(detail: string): PublicationProviderError {
  return new PublicationProviderError({ kind: "unreachable", detail });
}

function isPublicationDenied(error: unknown): error is PublicationDeniedError {
  return typeof error === "object" && error !== null && "_tag" in error && (error as { readonly _tag?: unknown })._tag === "PublicationDeniedError";
}

function identityAdmissionError(intent: GitPublicationIntent, error: unknown, _fallback: string): PublicationDeniedError | PublicationProviderError {
  const reason = reasonOf(error);
  return reason !== undefined && identityDenialReasons.has(reason) ? denied(intent, reason) : unavailable("live publication identity admission storage failed");
}

function reasonOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "reason" in error && typeof (error as { readonly reason?: unknown }).reason === "string" ? (error as { readonly reason: string }).reason : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string {
  return isRecord(value) && typeof value[field] === "string" && value[field].length > 0 ? value[field] : unresolvedId;
}
