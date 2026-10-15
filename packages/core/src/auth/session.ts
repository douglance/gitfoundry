import { Data, Effect } from "effect";

export interface D1Result<T = Record<string, unknown>> { readonly results?: readonly T[]; readonly success?: boolean; readonly meta?: { readonly changes?: number } }
export interface D1PreparedStatement<T = Record<string, unknown>> {
  readonly bind: (...values: readonly unknown[]) => D1PreparedStatement<T>;
  readonly first: <R = T>() => Promise<R | null>;
  readonly all: <R = T>() => Promise<D1Result<R>>;
  readonly run: () => Promise<D1Result<T>>;
}
export interface D1DatabaseLike { readonly prepare: <T = Record<string, unknown>>(sql: string) => D1PreparedStatement<T>; readonly batch?: (statements: readonly D1PreparedStatement[]) => Promise<readonly D1Result[]> }
export interface Clock { readonly now: () => Date }

export class AuthSessionDenied extends Data.TaggedError("AuthSessionDenied")<{ readonly reason: string; readonly tenantId: string; readonly principalId?: string }> {}
export class AuthSessionReplayDetected extends Data.TaggedError("AuthSessionReplayDetected")<{ readonly tenantId: string; readonly familyId: string }> {}
export class AuthSessionStoreUnavailable extends Data.TaggedError("AuthSessionStoreUnavailable")<{ readonly reason: string }> {}
export type AuthSessionError = AuthSessionDenied | AuthSessionReplayDetected | AuthSessionStoreUnavailable;

export interface SourceActorIdentityDto { readonly tenant_id: string; readonly principal_id: string; readonly kind: "human" | "service" | "extension" | "job" | "migration" | "system"; readonly policy_epoch: number; readonly scopes: readonly string[] }
export interface AuthCredentialProof { readonly auth_epoch: number; readonly session_id: string; readonly client_id: string; readonly audience: string; readonly scopes: readonly string[]; readonly resources: readonly string[]; readonly connection_id: string; readonly authenticated_at: string; readonly authentication_expires_at: string }
export interface AuthenticatedSession { readonly identity: SourceActorIdentityDto; readonly credential: AuthCredentialProof }

export interface SessionEligibilityProof {
  readonly tenantId: string;
  readonly principalId: string;
  readonly kind: SourceActorIdentityDto["kind"];
  readonly policyEpoch: number;
  readonly authEpoch: number;
  readonly grantRef: string;
  readonly connectionId: string;
  readonly authenticatedAt: string;
  readonly authenticationExpiresAt: string;
  readonly scopes: readonly string[];
  readonly resources: readonly string[];
}

export interface SessionEligibilityPort {
  readonly verifySessionEligibility: (input: { readonly tenantId: string; readonly principalId: string; readonly clientId: string; readonly audience: string; readonly scopes: readonly string[]; readonly resources: readonly string[] }) => Effect.Effect<SessionEligibilityProof, AuthSessionError>;
}

export interface OneShotSessionIssueMaterial {
  readonly tenantId: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly audience: string;
  readonly sessionId: string;
  readonly refreshFamilyId: string;
  readonly scopes: readonly string[];
  readonly resources: readonly string[];
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
  readonly now: string;
  readonly connectionId: string;
  readonly authenticatedAt: string;
  readonly authenticationExpiresAt: string;
}
export interface OneShotSessionIssueClaim { readonly claimStatements: readonly D1PreparedStatement[]; readonly assertionStatements: readonly D1PreparedStatement[]; readonly auditRef?: string }
export interface OneShotSessionIssuePort { readonly prepareSessionIssueClaim: (input: { readonly db: D1DatabaseLike; readonly material: OneShotSessionIssueMaterial }) => Effect.Effect<OneShotSessionIssueClaim, AuthSessionError> }

export interface IssueSessionInput { readonly tenantId: string; readonly principalId: string; readonly clientId: string; readonly audience: string; readonly scopes: readonly string[]; readonly resources: readonly string[]; readonly accessTtlSeconds: number; readonly refreshTtlSeconds: number; readonly requestId?: string; readonly oneShot?: OneShotSessionIssuePort }
export interface RotateRefreshInput { readonly tenantId: string; readonly refreshToken: string; readonly clientId: string; readonly audience: string; readonly scopes?: readonly string[]; readonly resources?: readonly string[]; readonly accessTtlSeconds: number; readonly refreshTtlSeconds: number; readonly requestId?: string }
export interface AuthenticateBearerInput { readonly tenantId: string; readonly accessToken: string; readonly clientId: string; readonly audience: string }
export interface RevokeSessionInput { readonly tenantId: string; readonly sessionId: string; readonly actorPrincipalId: string; readonly reason: string; readonly requestId?: string }
export interface ListSessionsInput { readonly tenantId: string; readonly principalId: string; readonly actorPrincipalId: string }
export interface SessionSummary { readonly id: string; readonly tenant_id: string; readonly principal_id: string; readonly client_id: string; readonly audience: string; readonly scopes: readonly string[]; readonly resources: readonly string[]; readonly created_at: string; readonly access_expires_at: string; readonly refresh_expires_at: string; readonly revoked_at: string | null }
export interface IssuedSession extends AuthenticatedSession { readonly accessToken: string; readonly refreshToken: string; readonly accessExpiresAt: string; readonly refreshExpiresAt: string }
export interface SessionAuthorityPort { readonly authorizeSessionAdministration: (input: { readonly tenantId: string; readonly actorPrincipalId: string; readonly targetPrincipalId: string; readonly capability: "session.list" | "session.revoke" }) => Effect.Effect<void, AuthSessionError> }

export interface AuthSessionStore {
  readonly issueSession: (input: IssueSessionInput) => Effect.Effect<IssuedSession, AuthSessionError>;
  readonly authenticateBearer: (input: AuthenticateBearerInput) => Effect.Effect<AuthenticatedSession, AuthSessionError>;
  readonly rotateRefresh: (input: RotateRefreshInput) => Effect.Effect<IssuedSession, AuthSessionError>;
  readonly listSessions: (input: ListSessionsInput) => Effect.Effect<readonly SessionSummary[], AuthSessionError>;
  readonly revokeSession: (input: RevokeSessionInput) => Effect.Effect<void, AuthSessionError>;
}

const systemClock: Clock = { now: () => new Date() };
const assertionId = "auth-transaction-assertion";
const maxAccessTtlSeconds = 600;
const maxRefreshTtlSeconds = 60 * 60 * 24 * 30;

type RefreshRow = { readonly tenant_id: string; readonly family_id: string; readonly generation: number; readonly session_id: string; readonly token_hash: string; readonly scopes_json: string; readonly resources_json: string; readonly expires_at: string; readonly consumed_at: string | null; readonly history_revoked_at: string | null; readonly family_revoked_at: string | null; readonly family_refresh_expires_at: string; readonly source_session_revoked_at: string | null; readonly principal_id: string; readonly principal_kind: SourceActorIdentityDto["kind"]; readonly client_id: string; readonly audience: string; readonly connection_id: string; readonly authenticated_at: string; readonly authentication_expires_at: string; readonly current_generation: number; readonly auth_epoch: number; readonly tenant_policy_epoch: number };
type SessionRow = { readonly id: string; readonly tenant_id: string; readonly principal_id: string; readonly client_id: string; readonly audience: string; readonly scopes_json: string; readonly resources_json: string; readonly auth_epoch: number; readonly tenant_policy_epoch: number; readonly access_expires_at: string; readonly refresh_expires_at: string; readonly kind: SourceActorIdentityDto["kind"]; readonly policy_epoch: number; readonly connection_id: string; readonly authenticated_at: string; readonly authentication_expires_at: string };

export function makeD1AuthSessionStore(db: D1DatabaseLike, eligibility: SessionEligibilityPort, options: { readonly clock?: Clock; readonly authority?: SessionAuthorityPort } = {}): AuthSessionStore {
  const clock = options.clock ?? systemClock;
  return {
    issueSession: (input) => Effect.gen(function* () {
      validateTokenRequest(input.tenantId, input.clientId, input.audience, input.scopes, input.resources, input.accessTtlSeconds, input.refreshTtlSeconds);
      const scopes = stableUnique(input.scopes);
      const resources = stableUnique(input.resources);
      const proof = yield* eligibility.verifySessionEligibility({ tenantId: input.tenantId, principalId: input.principalId, clientId: input.clientId, audience: input.audience, scopes, resources });
      const now = clock.now().toISOString();
      validateEligibilityProof(input, proof, now);
      const familyId = randomId("auth_family");
      const issued = yield* Effect.promise(() => buildIssuedMaterial(input.tenantId, input.clientId, input.audience, scopes, resources, input.accessTtlSeconds, input.refreshTtlSeconds, clock, proof.authenticationExpiresAt));
      const oneShot = input.oneShot ? yield* input.oneShot.prepareSessionIssueClaim({ db, material: { tenantId: input.tenantId, principalId: input.principalId, clientId: input.clientId, audience: input.audience, sessionId: issued.sessionId, refreshFamilyId: familyId, scopes, resources, accessExpiresAt: issued.accessExpiresAt, refreshExpiresAt: issued.refreshExpiresAt, now, connectionId: proof.connectionId, authenticatedAt: proof.authenticatedAt, authenticationExpiresAt: proof.authenticationExpiresAt } }) : emptyOneShot();
      const auditId = randomId("audit");
      yield* runAtomic(db, [
        ...oneShot.claimStatements,
        stmt(db, "INSERT INTO auth_refresh_families(tenant_id,id,version,created_at,updated_at,principal_id,client_id,audience,connection_id,authenticated_at,authentication_expires_at,refresh_expires_at,current_generation,revoked_at,revoked_reason) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL WHERE " + livePrincipalSql(), input.tenantId, familyId, 1, now, now, input.principalId, input.clientId, input.audience, proof.connectionId, proof.authenticatedAt, proof.authenticationExpiresAt, issued.refreshExpiresAt, input.tenantId, input.principalId, proof.kind, proof.authEpoch, proof.policyEpoch),
        stmt(db, "INSERT INTO auth_sessions(tenant_id,id,version,created_at,updated_at,principal_id,client_id,audience,scopes_json,resources_json,auth_epoch,tenant_policy_epoch,access_token_hash,access_expires_at,refresh_family_id,refresh_generation,refresh_token_hash,refresh_expires_at,revoked_at,revoked_reason,last_used_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,NULL,NULL,NULL WHERE EXISTS(SELECT 1 FROM auth_refresh_families WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL) AND " + livePrincipalSql(), input.tenantId, issued.sessionId, 1, now, now, input.principalId, input.clientId, input.audience, JSON.stringify(issued.scopes), JSON.stringify(issued.resources), proof.authEpoch, proof.policyEpoch, issued.accessHash, issued.accessExpiresAt, familyId, issued.refreshHash, issued.refreshExpiresAt, input.tenantId, familyId, input.tenantId, input.principalId, proof.kind, proof.authEpoch, proof.policyEpoch),
        stmt(db, "INSERT INTO auth_refresh_token_history(tenant_id,family_id,generation,session_id,token_hash,scopes_json,resources_json,created_at,expires_at,consumed_at,reused_at,revoked_at) SELECT ?,?,0,?,?,?,?,?,?,NULL,NULL,NULL WHERE EXISTS(SELECT 1 FROM auth_sessions WHERE tenant_id = ? AND id = ?)", input.tenantId, familyId, issued.sessionId, issued.refreshHash, JSON.stringify(issued.scopes), JSON.stringify(issued.resources), now, issued.refreshExpiresAt, input.tenantId, issued.sessionId),
        auditStmt(db, input.tenantId, auditId, now, input.principalId, "auth.session.issue", "auth_session", issued.sessionId, proof.policyEpoch, input.requestId ?? issued.sessionId, digestPayload([issued.sessionId, familyId, proof.grantRef, oneShot.auditRef ?? null, issued.scopes, issued.resources])),
        ...oneShot.assertionStatements,
        stmt(db, "INSERT INTO auth_transaction_assertions(id) SELECT ? WHERE NOT(EXISTS(SELECT 1 FROM auth_refresh_families WHERE tenant_id = ? AND id = ?) AND EXISTS(SELECT 1 FROM auth_sessions WHERE tenant_id = ? AND id = ?) AND EXISTS(SELECT 1 FROM auth_refresh_token_history WHERE tenant_id = ? AND family_id = ? AND generation = 0) AND EXISTS(SELECT 1 FROM audit WHERE tenant_id = ? AND id = ?))", assertionId, input.tenantId, familyId, input.tenantId, issued.sessionId, input.tenantId, familyId, input.tenantId, auditId)
      ]);
      return issuedResponse(issued, proof, input.principalId);
    }),

    authenticateBearer: (input) => Effect.tryPromise({
      try: async () => {
        if (!input.accessToken.startsWith("gfy_access_")) throw denied(input.tenantId, "access token prefix invalid");
        const hash = await sha256Hex(input.accessToken);
        const now = clock.now().toISOString();
        const row = await db.prepare(authenticateSelectSql()).bind(input.tenantId, hash, input.clientId, input.audience, now, now).first<SessionRow>();
        if (!row) throw denied(input.tenantId, "access token denied");
        const updated = await db.prepare("UPDATE auth_sessions SET last_used_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL AND EXISTS(" + authenticateLiveExistsSql("auth_sessions") + ")").bind(now, row.tenant_id, row.id, row.tenant_id, row.id, row.client_id, row.audience, now, now).run();
        if (updated.meta?.changes !== 1) throw denied(input.tenantId, "access token changed during authentication");
        return authenticatedFromRow(row);
      },
      catch: (error) => error instanceof AuthSessionDenied ? error : new AuthSessionStoreUnavailable({ reason: redactError(error) })
    }),

    rotateRefresh: (input) => Effect.gen(function* () {
      validateTokenRequest(input.tenantId, input.clientId, input.audience, input.scopes ?? [], input.resources ?? [], input.accessTtlSeconds, input.refreshTtlSeconds);
      if (!input.refreshToken.startsWith("gfy_refresh_")) return yield* Effect.fail(new AuthSessionDenied({ reason: "refresh token prefix invalid", tenantId: input.tenantId }));
      const refreshHash = yield* Effect.promise(() => sha256Hex(input.refreshToken));
      const row = yield* Effect.tryPromise({ try: () => readRefreshRow(db, input.tenantId, refreshHash), catch: (error) => error instanceof AuthSessionDenied ? error : new AuthSessionStoreUnavailable({ reason: redactError(error) }) });
      if (row.client_id !== input.clientId || row.audience !== input.audience) return yield* Effect.fail(new AuthSessionDenied({ reason: "refresh token client or audience mismatch", tenantId: input.tenantId, principalId: row.principal_id }));
      const now = clock.now().toISOString();
      if (row.consumed_at !== null) {
        yield* revokeFamilyForReplay(db, clock, row, input.requestId ?? row.session_id);
        return yield* Effect.fail(new AuthSessionReplayDetected({ tenantId: input.tenantId, familyId: row.family_id }));
      }
      if (row.family_revoked_at !== null || row.history_revoked_at !== null || row.source_session_revoked_at !== null || row.expires_at <= now || row.authentication_expires_at <= now || row.family_refresh_expires_at <= now) return yield* Effect.fail(new AuthSessionDenied({ reason: "refresh token expired or revoked", tenantId: input.tenantId, principalId: row.principal_id }));
      const currentScopes = parseStringArray(row.scopes_json, "stored scopes invalid");
      const currentResources = parseStringArray(row.resources_json, "stored resources invalid");
      const scopes = stableUnique(input.scopes ?? currentScopes);
      const resources = stableUnique(input.resources ?? currentResources);
      if (!containsAll(currentScopes, scopes) || !containsAll(currentResources, resources)) return yield* Effect.fail(new AuthSessionDenied({ reason: "refresh cannot expand scopes or resources", tenantId: input.tenantId, principalId: row.principal_id }));
      const material = yield* Effect.promise(() => buildIssuedMaterial(input.tenantId, input.clientId, input.audience, scopes, resources, input.accessTtlSeconds, input.refreshTtlSeconds, clock, earliestIso(row.family_refresh_expires_at, row.authentication_expires_at)));
      const nextGeneration = row.generation + 1;
      const auditId = randomId("audit");
      yield* runAtomic(db, [
        stmt(db, "INSERT INTO auth_sessions(tenant_id,id,version,created_at,updated_at,principal_id,client_id,audience,scopes_json,resources_json,auth_epoch,tenant_policy_epoch,access_token_hash,access_expires_at,refresh_family_id,refresh_generation,refresh_token_hash,refresh_expires_at,revoked_at,revoked_reason,last_used_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL WHERE EXISTS(SELECT 1 FROM auth_refresh_families f JOIN principals p ON p.tenant_id = f.tenant_id AND p.id = f.principal_id JOIN tenants t ON t.id = f.tenant_id JOIN auth_refresh_token_history h ON h.tenant_id = f.tenant_id AND h.family_id = f.id AND h.generation = ? JOIN auth_sessions source ON source.tenant_id = h.tenant_id AND source.id = h.session_id WHERE f.tenant_id = ? AND f.id = ? AND f.current_generation = ? AND f.revoked_at IS NULL AND f.refresh_expires_at > ? AND f.authentication_expires_at > ? AND h.token_hash = ? AND h.consumed_at IS NULL AND h.revoked_at IS NULL AND h.expires_at > ? AND source.revoked_at IS NULL AND p.active = 1 AND p.kind = ? AND p.auth_epoch = ? AND t.state = 'active' AND t.policy_epoch = ?)", input.tenantId, material.sessionId, 1, now, now, row.principal_id, input.clientId, input.audience, JSON.stringify(scopes), JSON.stringify(resources), row.auth_epoch, row.tenant_policy_epoch, material.accessHash, material.accessExpiresAt, row.family_id, nextGeneration, material.refreshHash, material.refreshExpiresAt, row.generation, input.tenantId, row.family_id, row.generation, now, now, refreshHash, now, row.principal_kind, row.auth_epoch, row.tenant_policy_epoch),
        stmt(db, "UPDATE auth_refresh_token_history SET consumed_at = ? WHERE tenant_id = ? AND family_id = ? AND generation = ? AND token_hash = ? AND consumed_at IS NULL AND EXISTS(SELECT 1 FROM auth_sessions WHERE tenant_id = ? AND id = ?)", now, input.tenantId, row.family_id, row.generation, refreshHash, input.tenantId, material.sessionId),
        stmt(db, "UPDATE auth_refresh_families SET current_generation = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND current_generation = ? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM auth_refresh_token_history WHERE tenant_id = ? AND family_id = ? AND generation = ? AND consumed_at = ?)", nextGeneration, now, input.tenantId, row.family_id, row.generation, input.tenantId, row.family_id, row.generation, now),
        stmt(db, "INSERT INTO auth_refresh_token_history(tenant_id,family_id,generation,session_id,token_hash,scopes_json,resources_json,created_at,expires_at,consumed_at,reused_at,revoked_at) SELECT ?,?,?,?,?,?,?,?,?,NULL,NULL,NULL WHERE EXISTS(SELECT 1 FROM auth_refresh_families WHERE tenant_id = ? AND id = ? AND current_generation = ? AND revoked_at IS NULL)", input.tenantId, row.family_id, nextGeneration, material.sessionId, material.refreshHash, JSON.stringify(scopes), JSON.stringify(resources), now, material.refreshExpiresAt, input.tenantId, row.family_id, nextGeneration),
        auditStmt(db, input.tenantId, auditId, now, row.principal_id, "auth.refresh.rotate", "auth_session", material.sessionId, row.tenant_policy_epoch, input.requestId ?? material.sessionId, digestPayload([row.session_id, material.sessionId, row.family_id, nextGeneration, scopes, resources])),
        stmt(db, "INSERT INTO auth_transaction_assertions(id) SELECT ? WHERE NOT(EXISTS(SELECT 1 FROM auth_sessions WHERE tenant_id = ? AND id = ?) AND EXISTS(SELECT 1 FROM auth_refresh_token_history WHERE tenant_id = ? AND family_id = ? AND generation = ? AND session_id = ?) AND EXISTS(SELECT 1 FROM auth_refresh_token_history WHERE tenant_id = ? AND family_id = ? AND generation = ? AND consumed_at = ?) AND EXISTS(SELECT 1 FROM auth_refresh_families WHERE tenant_id = ? AND id = ? AND current_generation = ?) AND EXISTS(SELECT 1 FROM audit WHERE tenant_id = ? AND id = ?))", assertionId, input.tenantId, material.sessionId, input.tenantId, row.family_id, nextGeneration, material.sessionId, input.tenantId, row.family_id, row.generation, now, input.tenantId, row.family_id, nextGeneration, input.tenantId, auditId)
      ]);
      return issuedResponse(material, { tenantId: input.tenantId, principalId: row.principal_id, kind: row.principal_kind, policyEpoch: row.tenant_policy_epoch, authEpoch: row.auth_epoch, grantRef: row.family_id, connectionId: row.connection_id, authenticatedAt: row.authenticated_at, authenticationExpiresAt: row.authentication_expires_at, scopes, resources }, row.principal_id);
    }),

    listSessions: (input) => Effect.gen(function* () {
      if (input.actorPrincipalId !== input.principalId) {
        if (!options.authority) return yield* Effect.fail(new AuthSessionDenied({ reason: "session administration authority unavailable", tenantId: input.tenantId, principalId: input.actorPrincipalId }));
        yield* options.authority.authorizeSessionAdministration({ tenantId: input.tenantId, actorPrincipalId: input.actorPrincipalId, targetPrincipalId: input.principalId, capability: "session.list" });
      }
      return yield* Effect.tryPromise({ try: async () => { const rows = await db.prepare("SELECT id,tenant_id,principal_id,client_id,audience,scopes_json,resources_json,created_at,access_expires_at,refresh_expires_at,revoked_at FROM auth_sessions WHERE tenant_id = ? AND principal_id = ? ORDER BY created_at DESC, id DESC LIMIT 100").bind(input.tenantId, input.principalId).all<SessionSummaryRow>(); return (rows.results ?? []).map(summaryFromRow); }, catch: (error) => new AuthSessionStoreUnavailable({ reason: redactError(error) }) });
    }),

    revokeSession: (input) => Effect.gen(function* () {
      const row = yield* Effect.tryPromise({ try: () => db.prepare("SELECT principal_id, refresh_family_id FROM auth_sessions WHERE tenant_id = ? AND id = ? LIMIT 1").bind(input.tenantId, input.sessionId).first<{ principal_id: string; refresh_family_id: string }>(), catch: (error) => new AuthSessionStoreUnavailable({ reason: redactError(error) }) });
      if (!row) return yield* Effect.fail(new AuthSessionDenied({ reason: "session missing", tenantId: input.tenantId, principalId: input.actorPrincipalId }));
      if (input.actorPrincipalId !== row.principal_id) {
        if (!options.authority) return yield* Effect.fail(new AuthSessionDenied({ reason: "session administration authority unavailable", tenantId: input.tenantId, principalId: input.actorPrincipalId }));
        yield* options.authority.authorizeSessionAdministration({ tenantId: input.tenantId, actorPrincipalId: input.actorPrincipalId, targetPrincipalId: row.principal_id, capability: "session.revoke" });
      }
      const now = clock.now().toISOString();
      const auditId = randomId("audit");
      yield* runAtomic(db, [
        stmt(db, "UPDATE auth_refresh_families SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, ?) WHERE tenant_id = ? AND id = ?", now, input.reason, input.tenantId, row.refresh_family_id),
        stmt(db, "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, ?) WHERE tenant_id = ? AND refresh_family_id = ?", now, input.reason, input.tenantId, row.refresh_family_id),
        stmt(db, "UPDATE auth_refresh_token_history SET revoked_at = COALESCE(revoked_at, ?) WHERE tenant_id = ? AND family_id = ?", now, input.tenantId, row.refresh_family_id),
        auditStmt(db, input.tenantId, auditId, now, input.actorPrincipalId, "auth.session.revoke", "auth_session", input.sessionId, 0, input.requestId ?? input.sessionId, digestPayload([input.sessionId, row.refresh_family_id, input.reason])),
        stmt(db, "INSERT INTO auth_transaction_assertions(id) SELECT ? WHERE NOT(EXISTS(SELECT 1 FROM auth_refresh_families WHERE tenant_id = ? AND id = ? AND revoked_at IS NOT NULL) AND EXISTS(SELECT 1 FROM audit WHERE tenant_id = ? AND id = ?))", assertionId, input.tenantId, row.refresh_family_id, input.tenantId, auditId)
      ]);
    })
  };
}

type SessionSummaryRow = Omit<SessionSummary, "scopes" | "resources"> & { readonly scopes_json: string; readonly resources_json: string };

function validateTokenRequest(tenantId: string, clientId: string, audience: string, scopes: readonly string[], resources: readonly string[], accessTtlSeconds: number, refreshTtlSeconds: number): void {
  if (!tenantId || !clientId || !audience) throw new AuthSessionDenied({ reason: "tenant client and audience are required", tenantId });
  if (!Number.isInteger(accessTtlSeconds) || accessTtlSeconds < 1 || accessTtlSeconds > maxAccessTtlSeconds) throw new AuthSessionDenied({ reason: "access ttl invalid", tenantId });
  if (!Number.isInteger(refreshTtlSeconds) || refreshTtlSeconds < accessTtlSeconds || refreshTtlSeconds > maxRefreshTtlSeconds) throw new AuthSessionDenied({ reason: "refresh ttl invalid", tenantId });
  stableUnique(scopes); stableUnique(resources);
}

function validateEligibilityProof(input: IssueSessionInput, proof: SessionEligibilityProof, now: string): void {
  if (proof.tenantId !== input.tenantId || proof.principalId !== input.principalId || proof.policyEpoch < 1 || proof.authEpoch < 1) throw new AuthSessionDenied({ reason: "eligibility proof does not match requested principal", tenantId: input.tenantId, principalId: input.principalId });
  if (!proof.connectionId || !proof.authenticatedAt || !proof.authenticationExpiresAt || proof.authenticationExpiresAt <= now || proof.authenticatedAt > now) throw new AuthSessionDenied({ reason: "eligibility authentication deadline invalid", tenantId: input.tenantId, principalId: input.principalId });
  if (!containsAll(proof.scopes, input.scopes) || !containsAll(proof.resources, input.resources)) throw new AuthSessionDenied({ reason: "eligibility proof does not cover requested credential", tenantId: input.tenantId, principalId: input.principalId });
}

async function readRefreshRow(db: D1DatabaseLike, tenantId: string, refreshHash: string): Promise<RefreshRow> {
  const row = await db.prepare(`SELECT h.tenant_id, h.family_id, h.generation, h.session_id, h.token_hash, h.scopes_json, h.resources_json, h.expires_at, h.consumed_at, h.revoked_at AS history_revoked_at, f.revoked_at AS family_revoked_at, f.refresh_expires_at AS family_refresh_expires_at, f.principal_id, f.client_id, f.audience, f.connection_id, f.authenticated_at, f.authentication_expires_at, f.current_generation, s.auth_epoch, s.tenant_policy_epoch, s.revoked_at AS source_session_revoked_at, p.kind AS principal_kind FROM auth_refresh_token_history h JOIN auth_refresh_families f ON f.tenant_id = h.tenant_id AND f.id = h.family_id JOIN auth_sessions s ON s.tenant_id = h.tenant_id AND s.id = h.session_id JOIN principals p ON p.tenant_id = f.tenant_id AND p.id = f.principal_id WHERE h.tenant_id = ? AND h.token_hash = ? LIMIT 1`).bind(tenantId, refreshHash).first<RefreshRow>();
  if (!row) throw new AuthSessionDenied({ reason: "refresh token denied", tenantId });
  return row;
}

function revokeFamilyForReplay(db: D1DatabaseLike, clock: Clock, row: RefreshRow, requestId: string): Effect.Effect<void, AuthSessionError> {
  return Effect.gen(function* () {
    const now = clock.now().toISOString();
    const auditId = randomId("audit");
    yield* runAtomic(db, [
      stmt(db, "UPDATE auth_refresh_families SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'refresh_reuse') WHERE tenant_id = ? AND id = ?", now, row.tenant_id, row.family_id),
      stmt(db, "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'refresh_reuse') WHERE tenant_id = ? AND refresh_family_id = ?", now, row.tenant_id, row.family_id),
      stmt(db, "UPDATE auth_refresh_token_history SET reused_at = COALESCE(reused_at, ?), revoked_at = COALESCE(revoked_at, ?) WHERE tenant_id = ? AND family_id = ? AND generation = ?", now, now, row.tenant_id, row.family_id, row.generation),
      auditStmt(db, row.tenant_id, auditId, now, row.principal_id, "auth.refresh.reuse", "auth_refresh_family", row.family_id, row.tenant_policy_epoch, requestId, digestPayload([row.family_id, row.generation, row.session_id])),
      stmt(db, "INSERT INTO auth_transaction_assertions(id) SELECT ? WHERE NOT(EXISTS(SELECT 1 FROM auth_refresh_families WHERE tenant_id = ? AND id = ? AND revoked_at IS NOT NULL) AND EXISTS(SELECT 1 FROM audit WHERE tenant_id = ? AND id = ?))", assertionId, row.tenant_id, row.family_id, row.tenant_id, auditId)
    ]);
  });
}

function runAtomic(db: D1DatabaseLike, statements: readonly D1PreparedStatement[]): Effect.Effect<void, AuthSessionStoreUnavailable> { return Effect.tryPromise({ try: async () => { if (!db.batch) throw new Error("D1 batch transaction support required"); await db.batch(statements); }, catch: (error) => new AuthSessionStoreUnavailable({ reason: redactError(error) }) }); }
function stmt(db: D1DatabaseLike, sql: string, ...values: readonly unknown[]): D1PreparedStatement { return db.prepare(sql).bind(...values) }
function auditStmt(db: D1DatabaseLike, tenantId: string, id: string, now: string, actorId: string, operation: string, resourceKind: string, resourceId: string, policyEpoch: number, requestId: string, payloadDigest: string): D1PreparedStatement { return stmt(db, "INSERT INTO audit(tenant_id,id,version,created_at,updated_at,actor_id,operation,resource_kind,resource_id,decision,policy_epoch,request_id,payload_digest,r2_record_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", tenantId, id, 1, now, now, actorId, operation, resourceKind, resourceId, "allow", policyEpoch, requestId, payloadDigest, "inline:" + payloadDigest) }
function livePrincipalSql(): string { return "EXISTS(SELECT 1 FROM principals p JOIN tenants t ON t.id = p.tenant_id WHERE p.tenant_id = ? AND p.id = ? AND p.kind = ? AND p.active = 1 AND p.auth_epoch = ? AND p.kind != 'historical' AND t.state = 'active' AND t.policy_epoch = ?)" }
function authenticateSelectSql(): string { return `SELECT s.id, s.tenant_id, s.principal_id, s.client_id, s.audience, s.scopes_json, s.resources_json, s.auth_epoch, s.tenant_policy_epoch, s.access_expires_at, s.refresh_expires_at, p.kind AS kind, t.policy_epoch AS policy_epoch, f.connection_id, f.authenticated_at, f.authentication_expires_at FROM auth_sessions s JOIN auth_refresh_families f ON f.tenant_id = s.tenant_id AND f.id = s.refresh_family_id JOIN principals p ON p.tenant_id = s.tenant_id AND p.id = s.principal_id JOIN tenants t ON t.id = s.tenant_id WHERE s.tenant_id = ? AND s.access_token_hash = ? AND s.client_id = ? AND s.audience = ? AND s.revoked_at IS NULL AND s.access_expires_at > ? AND f.revoked_at IS NULL AND f.authentication_expires_at > ? AND p.active = 1 AND p.auth_epoch = s.auth_epoch AND p.kind != 'historical' AND t.state = 'active' AND t.policy_epoch = s.tenant_policy_epoch LIMIT 1`; }
function authenticateLiveExistsSql(table: string): string { return `SELECT 1 FROM ${table} s JOIN auth_refresh_families f ON f.tenant_id = s.tenant_id AND f.id = s.refresh_family_id JOIN principals p ON p.tenant_id = s.tenant_id AND p.id = s.principal_id JOIN tenants t ON t.id = s.tenant_id WHERE s.tenant_id = ? AND s.id = ? AND s.client_id = ? AND s.audience = ? AND s.revoked_at IS NULL AND s.access_expires_at > ? AND f.revoked_at IS NULL AND f.authentication_expires_at > ? AND p.active = 1 AND p.auth_epoch = s.auth_epoch AND p.kind != 'historical' AND t.state = 'active' AND t.policy_epoch = s.tenant_policy_epoch`; }

async function buildIssuedMaterial(tenantId: string, clientId: string, audience: string, scopes: readonly string[], resources: readonly string[], accessTtlSeconds: number, refreshTtlSeconds: number, clock: Clock, deadlineIso: string): Promise<IssuedMaterial> {
  const now = clock.now().getTime();
  const deadline = Date.parse(deadlineIso);
  if (!Number.isFinite(deadline) || deadline <= now) throw new AuthSessionDenied({ reason: "authentication deadline expired", tenantId });
  const accessExpiresAt = new Date(Math.min(now + accessTtlSeconds * 1000, deadline)).toISOString();
  const refreshExpiresAt = new Date(Math.min(now + refreshTtlSeconds * 1000, deadline)).toISOString();
  const accessToken = "gfy_access_" + randomTokenPart();
  const refreshToken = "gfy_refresh_" + randomTokenPart();
  return { tenantId, sessionId: randomId("auth_session"), clientId, audience, scopes, resources, accessToken, refreshToken, accessHash: await sha256Hex(accessToken), refreshHash: await sha256Hex(refreshToken), accessExpiresAt, refreshExpiresAt };
}

interface IssuedMaterial { readonly tenantId: string; readonly sessionId: string; readonly clientId: string; readonly audience: string; readonly scopes: readonly string[]; readonly resources: readonly string[]; readonly accessToken: string; readonly refreshToken: string; readonly accessHash: string; readonly refreshHash: string; readonly accessExpiresAt: string; readonly refreshExpiresAt: string }
function issuedResponse(material: IssuedMaterial, proof: SessionEligibilityProof, principalId: string): IssuedSession { return { accessToken: material.accessToken, refreshToken: material.refreshToken, accessExpiresAt: material.accessExpiresAt, refreshExpiresAt: material.refreshExpiresAt, identity: { tenant_id: material.tenantId, principal_id: principalId, kind: proof.kind, policy_epoch: proof.policyEpoch, scopes: material.scopes }, credential: { auth_epoch: proof.authEpoch, session_id: material.sessionId, client_id: material.clientId, audience: material.audience, scopes: material.scopes, resources: material.resources, connection_id: proof.connectionId, authenticated_at: proof.authenticatedAt, authentication_expires_at: proof.authenticationExpiresAt } } }
function authenticatedFromRow(row: SessionRow): AuthenticatedSession { return { identity: { tenant_id: row.tenant_id, principal_id: row.principal_id, kind: row.kind, policy_epoch: row.policy_epoch, scopes: parseStringArray(row.scopes_json, "stored scopes invalid") }, credential: { auth_epoch: row.auth_epoch, session_id: row.id, client_id: row.client_id, audience: row.audience, scopes: parseStringArray(row.scopes_json, "stored scopes invalid"), resources: parseStringArray(row.resources_json, "stored resources invalid"), connection_id: row.connection_id, authenticated_at: row.authenticated_at, authentication_expires_at: row.authentication_expires_at } } }
function summaryFromRow(row: SessionSummaryRow): SessionSummary { return { ...row, scopes: parseStringArray(row.scopes_json, "stored scopes invalid"), resources: parseStringArray(row.resources_json, "stored resources invalid") } }
function emptyOneShot(): OneShotSessionIssueClaim { return { claimStatements: [], assertionStatements: [] } }
function stableUnique(values: readonly string[]): readonly string[] { const out = [...new Set(values)].sort(); if (out.some((value) => typeof value !== "string" || value.length === 0 || value.length > 512)) throw new AuthSessionDenied({ reason: "scope or resource value invalid", tenantId: "unknown" }); return out; }
function containsAll(haystack: readonly string[], needles: readonly string[]): boolean { const set = new Set(haystack); return needles.every((needle) => set.has(needle)) }
function parseStringArray(value: string, reason: string): readonly string[] { const parsed = JSON.parse(value) as unknown; if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new AuthSessionDenied({ reason, tenantId: "unknown" }); return stableUnique(parsed) }
function denied(tenantId: string, reason: string): AuthSessionDenied { return new AuthSessionDenied({ reason, tenantId }) }
function earliestIso(a: string, b: string): string { return Date.parse(a) <= Date.parse(b) ? a : b }
function redactError(error: unknown): string { return error instanceof AuthSessionDenied || error instanceof AuthSessionReplayDetected || error instanceof AuthSessionStoreUnavailable ? error._tag : "database operation failed" }
function randomTokenPart(): string { const bytes = new Uint8Array(32); globalThis.crypto.getRandomValues(bytes); return base64Url(bytes) }
function randomId(prefix: string): string { const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes); return `${prefix}_${base64Url(bytes)}` }
function base64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") }
async function sha256Hex(value: string): Promise<string> { const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") }
function digestPayload(value: unknown): string { return "sha256:" + stableDigest(JSON.stringify(value)) }
function stableDigest(value: string): string { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0") }
