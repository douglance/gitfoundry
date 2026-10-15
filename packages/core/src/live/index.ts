import { Data, Effect } from "effect";

import {
  InvalidStateTransitionError,
  IdempotencyConflictError,
  NotFoundError,
  RepositoryHasForksError,
  RepositoryNameConflictError,
  RepositoryStoreUnavailableError,
  StalePreconditionError,
  UnsupportedOperationError,
  type IdempotencyStore,
  type Namespace,
  type NamespaceStore,
  type OperationRecord,
  type OperationReceipt,
  type OperationStore,
  type Repository,
  type ForgeForkRequest,
  type RepositoryCreateInput,
  type RepositoryPatchInput,
  type RepositoryStore,
  type RepositoryVersionActionInput,
  type TenantAuthorizer,
  UnauthorizedError
} from "../index.js";

export interface D1Result<T = Record<string, unknown>> { readonly results?: readonly T[]; readonly success?: boolean; readonly meta?: { readonly changes?: number } }
export interface D1PreparedStatement<T = Record<string, unknown>> {
  readonly bind: (...values: readonly unknown[]) => D1PreparedStatement<T>;
  readonly first: <R = T>() => Promise<R | null>;
  readonly all: <R = T>() => Promise<D1Result<R>>;
  readonly run: () => Promise<D1Result<T>>;
}
export interface D1DatabaseLike { readonly prepare: <T = Record<string, unknown>>(sql: string) => D1PreparedStatement<T>; readonly batch?: (statements: readonly D1PreparedStatement[]) => Promise<readonly D1Result[]> }
export interface Clock { readonly now: () => Date }
export interface GitProvisioner {
  readonly provisionRepository: (input: { readonly tenantId: string; readonly namespaceId: string; readonly name: string; readonly defaultBranch: string; readonly visibility: Repository["visibility"] }) => Effect.Effect<{ readonly gitUrl: string; readonly artifactsNamespace: string; readonly artifactsName: string }>;
  // Removes a repository's stored Git data. Deleting storage that is already gone succeeds, so a retried delete can finish.
  readonly deleteRepository?: (input: { readonly artifactsNamespace: string; readonly artifactsName: string }) => Effect.Effect<void>;
}
export class GitProvisionerUnavailableError extends Data.TaggedError("GitProvisionerUnavailableError")<{ reason: string }> {}
export interface VerifiedIdentity { readonly tenant_id: string; readonly principal_id: string; readonly grant_ref: string; readonly policy_epoch: number }
export interface SourceActorIdentity { readonly tenant_id: string; readonly principal_id: string; readonly kind: "human" | "service" | "extension" | "job" | "migration" | "system"; readonly policy_epoch: number; readonly scopes: readonly string[] }

export interface D1IdentityPort {
  readonly resolveAccessPrincipal: (input: { readonly issuer: string; readonly audience: string; readonly claims: Readonly<Record<string, unknown>>; readonly requestedTenantId: string }) => Effect.Effect<{ readonly tenantId: string; readonly principalId: string; readonly kind: SourceActorIdentity["kind"]; readonly policyEpoch: number }, UnauthorizedError>;
  readonly verifyGrant: (input: { readonly tenantId: string; readonly principalId: string; readonly capability: string; readonly grantRef?: string; readonly policyEpoch?: number }) => Effect.Effect<VerifiedIdentity, UnauthorizedError>;
  readonly describePrincipal: (input: { readonly tenantId: string; readonly principalId: string; readonly policyEpoch?: number }) => Effect.Effect<SourceActorIdentity, UnauthorizedError>;
}

const systemClock: Clock = { now: () => new Date() };

interface ConnectionQualification { readonly provider_account_claim: string; readonly provider_account_id: string; readonly connection_marker_claim: string; readonly connection_marker: string; readonly immutable_subject_claim: string; readonly max_subject_bytes: number }
interface ConnectionCandidate { readonly connection_id: string; readonly claims_json: string }

function resolveQualifiedConnectionSubject(connection: ConnectionCandidate, claims: Readonly<Record<string, unknown>>): { readonly ok: true; readonly stableSubject: string } | { readonly ok: false } {
  const mapping = parseConnectionQualification(connection.claims_json);
  if (!mapping) return { ok: false };
  const providerAccount = readClaimString(claims, mapping.provider_account_claim, 256);
  const marker = readClaimString(claims, mapping.connection_marker_claim, 256);
  const stableSubject = readClaimString(claims, mapping.immutable_subject_claim, mapping.max_subject_bytes);
  if (providerAccount !== mapping.provider_account_id || marker !== mapping.connection_marker || !stableSubject) return { ok: false };
  return { ok: true, stableSubject };
}

function parseConnectionQualification(value: string): ConnectionQualification | undefined {
  const parsed = parseJsonRecord(value);
  if (parsed.identity_qualified !== true) return undefined;
  const providerAccountClaim = boundedConfigString(parsed.provider_account_claim, 128);
  const providerAccountId = boundedConfigString(parsed.provider_account_id, 256);
  const connectionMarkerClaim = boundedConfigString(parsed.connection_marker_claim, 128);
  const connectionMarker = boundedConfigString(parsed.connection_marker, 256);
  const immutableSubjectClaim = boundedConfigString(parsed.immutable_subject_claim, 128);
  const configuredMax = parsed.max_subject_bytes;
  const maxSubjectBytes = configuredMax === undefined ? 512 : typeof configuredMax === "number" && Number.isInteger(configuredMax) && configuredMax > 0 && configuredMax <= 2048 ? configuredMax : undefined;
  if (!providerAccountClaim || !providerAccountId || !connectionMarkerClaim || !connectionMarker || !immutableSubjectClaim || !maxSubjectBytes) return undefined;
  return { provider_account_claim: providerAccountClaim, provider_account_id: providerAccountId, connection_marker_claim: connectionMarkerClaim, connection_marker: connectionMarker, immutable_subject_claim: immutableSubjectClaim, max_subject_bytes: maxSubjectBytes };
}

function boundedConfigString(value: unknown, maxBytes: number): string | undefined { return typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= maxBytes ? value : undefined }
function readClaimString(claims: Readonly<Record<string, unknown>>, key: string, maxBytes: number): string | undefined { const value = claims[key]; return typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= maxBytes ? value : undefined }
function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength }

async function hasActiveQualifiedHumanMembership(db: D1DatabaseLike, tenantId: string, principalId: string): Promise<boolean> {
  const rows = await db.prepare(`SELECT c.claims_json AS claims_json FROM directory_members dm JOIN identity_links l ON l.tenant_id = dm.tenant_id AND l.connection_id = dm.connection_id AND l.principal_id = dm.principal_id AND l.source_id = dm.external_id JOIN connections c ON c.tenant_id = dm.tenant_id AND c.id = dm.connection_id WHERE dm.tenant_id = ? AND dm.principal_id = ? AND dm.active = 1 AND l.verified = 1 AND l.source_kind = 'directory' AND c.active = 1`).bind(tenantId, principalId).all<{ claims_json: string }>();
  return (rows.results ?? []).some((row) => Boolean(parseConnectionQualification(row.claims_json)));
}

export function makeD1IdentityPort(db: D1DatabaseLike, clock: Clock = systemClock): D1IdentityPort {
  return {
    resolveAccessPrincipal: (input) => Effect.tryPromise({
      try: async () => {
        const connections = await db.prepare("SELECT id AS connection_id, claims_json FROM connections WHERE tenant_id = ? AND issuer = ? AND audience = ? AND active = 1").bind(input.requestedTenantId, input.issuer, input.audience).all<ConnectionCandidate>();
        const matches = (connections.results ?? []).map((connection) => ({ connectionId: connection.connection_id, resolved: resolveQualifiedConnectionSubject(connection, input.claims) })).filter((match): match is { readonly connectionId: string; readonly resolved: { readonly ok: true; readonly stableSubject: string } } => match.resolved.ok);
        const match = matches[0];
        if (!match || matches.length !== 1) throw new UnauthorizedError({ reason: matches.length === 0 ? "qualified identity claim mapping denied" : "identity connection ambiguous", actorId: "unresolved", tenantId: input.requestedTenantId, capability: "identity.read" });
        const row = await db.prepare(`SELECT p.id AS principal_id, p.kind AS principal_kind, p.active AS principal_active, t.policy_epoch AS policy_epoch, t.state AS tenant_state FROM connections c JOIN identity_links l ON l.tenant_id = c.tenant_id AND l.connection_id = c.id AND l.issuer = c.issuer JOIN principals p ON p.tenant_id = l.tenant_id AND p.id = l.principal_id JOIN directory_members dm ON dm.tenant_id = c.tenant_id AND dm.connection_id = c.id AND dm.principal_id = p.id AND dm.external_id = l.source_id AND dm.active = 1 JOIN tenants t ON t.id = c.tenant_id WHERE c.tenant_id = ? AND c.id = ? AND c.active = 1 AND l.stable_subject = ? AND l.verified = 1 AND l.source_kind = 'directory' LIMIT 1`).bind(input.requestedTenantId, match.connectionId, match.resolved.stableSubject).first<{ principal_id: string; principal_kind: SourceActorIdentity["kind"] | "historical"; principal_active: number; policy_epoch: number; tenant_state: string }>();
        if (!row || row.principal_active !== 1 || row.tenant_state !== "active" || row.principal_kind === "historical") throw new UnauthorizedError({ reason: "identity not linked to active tenant principal", actorId: match.resolved.stableSubject, tenantId: input.requestedTenantId, capability: "identity.read" });
        return { tenantId: input.requestedTenantId, principalId: row.principal_id, kind: row.principal_kind, policyEpoch: row.policy_epoch };
      },
      catch: (error) => error instanceof UnauthorizedError ? error : new UnauthorizedError({ reason: String(error), actorId: "unresolved", tenantId: input.requestedTenantId, capability: "identity.read" })
    }),
    verifyGrant: (input) => Effect.tryPromise({
      try: async () => {
        const current = await db.prepare("SELECT policy_epoch, state FROM tenants WHERE id = ? LIMIT 1").bind(input.tenantId).first<{ policy_epoch: number; state: string }>();
        if (!current || current.state !== "active" || (input.policyEpoch !== undefined && current.policy_epoch !== input.policyEpoch)) throw new UnauthorizedError({ reason: "policy epoch is not current", actorId: input.principalId, tenantId: input.tenantId, capability: input.capability });
        const principal = await db.prepare("SELECT kind, active FROM principals WHERE tenant_id = ? AND id = ? LIMIT 1").bind(input.tenantId, input.principalId).first<{ kind: SourceActorIdentity["kind"] | "historical"; active: number }>();
        if (!principal || principal.active !== 1) throw new UnauthorizedError({ reason: "principal inactive or missing", actorId: input.principalId, tenantId: input.tenantId, capability: input.capability });
        if (principal.kind === "human" && !(await hasActiveQualifiedHumanMembership(db, input.tenantId, input.principalId))) throw new UnauthorizedError({ reason: "qualified directory membership inactive or missing", actorId: input.principalId, tenantId: input.tenantId, capability: input.capability });
        const rows = await db.prepare(`SELECT g.id AS grant_id, r.capabilities_json AS capabilities_json, g.expires_at AS expires_at FROM grants g JOIN roles r ON r.tenant_id = g.tenant_id AND r.id = g.role_id WHERE g.tenant_id = ? AND g.resource_kind = 'tenant' AND g.resource_id = ? AND (? IS NULL OR g.id = ?) AND ((g.subject_kind = 'service' AND g.subject_id = ?) OR (g.subject_kind = 'tenant_role' AND g.subject_id = ?) OR (g.subject_kind = 'group' AND g.subject_id IN (SELECT gm.group_id FROM group_memberships gm JOIN groups gr ON gr.tenant_id = gm.tenant_id AND gr.id = gm.group_id WHERE gm.tenant_id = ? AND gm.principal_id = ? AND gr.active = 1)))`).bind(input.tenantId, input.tenantId, input.grantRef ?? null, input.grantRef ?? null, input.principalId, input.principalId, input.tenantId, input.principalId).all<{ grant_id: string; capabilities_json: string; expires_at: string | null }>();
        const now = grantClockMs(clock);
        for (const row of rows.results ?? []) {
          if (!grantIsLive(row.expires_at, now)) continue;
          const capabilities = JSON.parse(row.capabilities_json) as unknown;
          if (Array.isArray(capabilities) && capabilities.includes(input.capability)) return { tenant_id: input.tenantId, principal_id: input.principalId, grant_ref: row.grant_id, policy_epoch: current.policy_epoch };
        }
        throw new UnauthorizedError({ reason: "capability grant denied", actorId: input.principalId, tenantId: input.tenantId, capability: input.capability });
      },
      catch: (error) => error instanceof UnauthorizedError ? error : new UnauthorizedError({ reason: String(error), actorId: input.principalId, tenantId: input.tenantId, capability: input.capability })
    }),
    describePrincipal: (input) => Effect.tryPromise({
      try: async () => {
        const current = await db.prepare("SELECT p.kind AS kind, p.active AS principal_active, t.policy_epoch AS policy_epoch, t.state AS tenant_state FROM principals p JOIN tenants t ON t.id = p.tenant_id WHERE p.tenant_id = ? AND p.id = ? LIMIT 1").bind(input.tenantId, input.principalId).first<{ kind: SourceActorIdentity["kind"] | "historical"; principal_active: number; policy_epoch: number; tenant_state: string }>();
        if (!current || current.principal_active !== 1 || current.tenant_state !== "active" || current.kind === "historical" || (input.policyEpoch !== undefined && current.policy_epoch !== input.policyEpoch)) throw new UnauthorizedError({ reason: "principal inactive or policy epoch stale", actorId: input.principalId, tenantId: input.tenantId, capability: "identity.read" });
        if (current.kind === "human" && !(await hasActiveQualifiedHumanMembership(db, input.tenantId, input.principalId))) throw new UnauthorizedError({ reason: "qualified directory membership inactive or missing", actorId: input.principalId, tenantId: input.tenantId, capability: "identity.read" });
        const rows = await db.prepare(`SELECT r.capabilities_json AS capabilities_json, g.expires_at AS expires_at FROM grants g JOIN roles r ON r.tenant_id = g.tenant_id AND r.id = g.role_id WHERE g.tenant_id = ? AND g.resource_kind = 'tenant' AND g.resource_id = ? AND ((g.subject_kind IN ('service','tenant_role','recovery_human') AND g.subject_id = ?) OR (g.subject_kind = 'group' AND g.subject_id IN (SELECT gm.group_id FROM group_memberships gm JOIN groups gr ON gr.tenant_id = gm.tenant_id AND gr.id = gm.group_id WHERE gm.tenant_id = ? AND gm.principal_id = ? AND gr.active = 1)))`).bind(input.tenantId, input.tenantId, input.principalId, input.tenantId, input.principalId).all<{ capabilities_json: string; expires_at: string | null }>();
        const now = grantClockMs(clock);
        const scopes = new Set<string>();
        for (const row of rows.results ?? []) {
          if (!grantIsLive(row.expires_at, now)) continue;
          const capabilities = JSON.parse(row.capabilities_json) as unknown;
          if (Array.isArray(capabilities)) for (const capability of capabilities) if (typeof capability === "string") scopes.add(capability);
        }
        return { tenant_id: input.tenantId, principal_id: input.principalId, kind: current.kind, policy_epoch: current.policy_epoch, scopes: Array.from(scopes).sort() };
      },
      catch: (error) => error instanceof UnauthorizedError ? error : new UnauthorizedError({ reason: String(error), actorId: input.principalId, tenantId: input.tenantId, capability: "identity.read" })
    })
  };
}

function grantClockMs(clock: Clock): number {
  const now = clock.now().getTime();
  if (!Number.isFinite(now)) throw new Error("grant clock invalid");
  return now;
}

function grantIsLive(expiresAt: string | null, now: number): boolean {
  if (expiresAt === null) return true;
  if (typeof expiresAt !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(expiresAt);
  if (!match) return false;
  const date = new Date(match[1] + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || !date.toISOString().startsWith(match[1] + "T")) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

export function makeD1TenantAuthorizer(identity: D1IdentityPort): TenantAuthorizer {
  return {
    authorize: (actor, tenantId, capability) => {
      if (actor.revoked || actor.tenantId !== tenantId) return Effect.fail(new UnauthorizedError({ reason: actor.revoked ? "actor revoked" : "tenant mismatch", actorId: actor.id, tenantId, capability }));
      return identity.verifyGrant({ tenantId, principalId: actor.id, capability }).pipe(Effect.asVoid);
    }
  };
}

export function makeD1NamespaceStore(db: D1DatabaseLike): NamespaceStore {
  return { get: (tenantId, id) => Effect.tryPromise({ try: async () => { const row = await db.prepare("SELECT tenant_id, id FROM organization_namespaces WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, id).first<Namespace>(); if (!row) throw new NotFoundError({ resource: "namespace", id }); return row; }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "namespace", id }) }) };
}

export function makeD1RepositoryStore(db: D1DatabaseLike, options: { readonly gitProvisioner?: GitProvisioner; readonly gitUrlBase?: string; readonly clock?: Clock } = {}): RepositoryStore {
  const clock = options.clock ?? systemClock;
  const toRepository = (row: RepositoryRow): Repository => ({ tenant_id: row.tenant_id, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, namespace_id: row.namespace_id, name: row.name, visibility: row.visibility, default_branch: row.default_branch, archived: row.archived === 1, fork_of: row.fork_of, git_url: `${options.gitUrlBase ?? "https://gitfoundry.invalid/git"}/${encodeURIComponent(row.artifacts_namespace)}/${encodeURIComponent(row.artifacts_name)}.git` });
  return {
    get: (tenantId, id) => Effect.tryPromise({ try: async () => { const row = await db.prepare(repositorySelectSql("WHERE tenant_id = ? AND id = ? LIMIT 1")).bind(tenantId, id).first<RepositoryRow>(); if (!row) throw new NotFoundError({ resource: "repository", id }); return toRepository(row); }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "repository", id }) }),
    list: (tenantId) => Effect.promise(async () => { const rows = await db.prepare(repositorySelectSql("WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1000")).bind(tenantId).all<RepositoryRow>(); return (rows.results ?? []).map(toRepository); }),
    create: (tenantId, input: RepositoryCreateInput) => Effect.gen(function* () {
      if (!options.gitProvisioner) return yield* Effect.fail(new GitProvisionerUnavailableError({ reason: "repository Git provisioner is not configured" }));
      const visibility = input.visibility ?? "private";
      const defaultBranch = input.default_branch ?? "main";
      const provisioned = yield* options.gitProvisioner.provisionRepository({ tenantId, namespaceId: input.namespace_id, name: input.name, defaultBranch, visibility });
      const now = clock.now().toISOString();
      const id = `repo-${yield* Effect.promise(() => sha256Hex(JSON.stringify(["gitfoundry.repository.v1", tenantId, input.namespace_id, input.name])))}`;
      yield* Effect.promise(() => db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)").bind(tenantId, id, 1, now, now, input.namespace_id, input.name, visibility, defaultBranch, 0, provisioned.artifactsNamespace, provisioned.artifactsName).run());
      return { tenant_id: tenantId, id, version: 1, created_at: now, updated_at: now, namespace_id: input.namespace_id, name: input.name, visibility, default_branch: defaultBranch, archived: false, fork_of: null, git_url: provisioned.gitUrl };
    }) as Effect.Effect<Repository>,
    fork: (tenantId, actor, id, input: ForgeForkRequest) => Effect.tryPromise({
      try: async () => {
        if (!options.gitProvisioner) throw repositoryStoreUnavailable("repo.fork", id);
        const source = await db.prepare(repositorySelectSql("WHERE tenant_id = ? AND id = ? LIMIT 1")).bind(tenantId, id).first<RepositoryRow>();
        if (!source) throw new NotFoundError({ resource: "repository", id });
        if (source.version !== input.expected_version) throw new StalePreconditionError({ expected: input.expected_version, actual: source.version });
        const namespace = await db.prepare("SELECT id FROM organization_namespaces WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, input.target_namespace_id).first<{ id: string }>();
        if (!namespace) throw new NotFoundError({ resource: "namespace", id: input.target_namespace_id });
        const conflict = await repositoryNameConflict(db, tenantId, input.target_namespace_id, input.name, id);
        if (conflict) throw new RepositoryNameConflictError({ tenantId, namespaceId: input.target_namespace_id, name: input.name });
        const provisioned = await Effect.runPromise(options.gitProvisioner.provisionRepository({ tenantId, namespaceId: input.target_namespace_id, name: input.name, defaultBranch: source.default_branch, visibility: input.visibility }));
        const now = clock.now().toISOString();
        const repositoryId = `repo-${await sha256Hex(JSON.stringify(["gitfoundry.repository.v1", tenantId, input.target_namespace_id, input.name]))}`;
        const sourceSnapshotDigest = await sha256Hex(JSON.stringify(["gitfoundry.fork.source.v1", tenantId, id, source.version, source.artifacts_namespace, source.artifacts_name, actor.id, input.default_branch_only ?? false]));
        await db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(tenantId, repositoryId, 1, now, now, input.target_namespace_id, input.name, input.visibility, source.default_branch, 0, provisioned.artifactsNamespace, provisioned.artifactsName, id).run();
        return {
          tenant_id: tenantId,
          id: `op-fork-${sourceSnapshotDigest.slice(0, 32)}`,
          version: 1,
          created_at: now,
          updated_at: now,
          status: "succeeded",
          kind: "repo.fork",
          progress: { stage: "completed", completed: 1, total: 1, blocked_reason: null },
          result: { source_repository_id: id, repository_id: repositoryId, copied_ref_count: 0, copied_object_count: 0, source_snapshot_digest: sourceSnapshotDigest },
          error: null
        } satisfies OperationRecord;
      },
      catch: (error) => error instanceof NotFoundError || error instanceof RepositoryNameConflictError || error instanceof RepositoryStoreUnavailableError || error instanceof StalePreconditionError ? error : repositoryStoreUnavailable("repo.fork", id)
    }),
    update: (tenantId, id, expectedVersion, patch: RepositoryPatchInput) => Effect.tryPromise({
      try: async () => {
        const current = await db.prepare(repositorySelectSql("WHERE tenant_id = ? AND id = ? LIMIT 1")).bind(tenantId, id).first<RepositoryRow>();
        if (!current) throw new NotFoundError({ resource: "repository", id });
        if (current.version !== expectedVersion) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
        if (patch.description !== undefined) throw new UnsupportedOperationError({ operationId: "repo.edit", reason: "repository description metadata has no persisted contract field in the current D1 repository store" });
        if (patch.name !== undefined && patch.name !== current.name) {
          const conflict = await repositoryNameConflict(db, tenantId, current.namespace_id, patch.name, id);
          if (conflict) throw new RepositoryNameConflictError({ tenantId, namespaceId: current.namespace_id, name: patch.name });
        }
        const now = clock.now().toISOString();
        let row: RepositoryRow | null;
        try {
          row = await db.prepare(repositoryUpdateReturningSql("SET version = version + 1, updated_at = ?, name = ?, visibility = ?, default_branch = ? WHERE tenant_id = ? AND id = ? AND version = ?")).bind(now, patch.name ?? current.name, patch.visibility ?? current.visibility, patch.default_branch ?? current.default_branch, tenantId, id, expectedVersion).first<RepositoryRow>();
        } catch (error) {
          if (patch.name !== undefined && patch.name !== current.name) {
            const conflict = await repositoryNameConflict(db, tenantId, current.namespace_id, patch.name, id);
            if (conflict) throw new RepositoryNameConflictError({ tenantId, namespaceId: current.namespace_id, name: patch.name });
          }
          throw error;
        }
        if (!row) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
        return toRepository(row);
      },
      catch: (error) => error instanceof NotFoundError || error instanceof RepositoryNameConflictError || error instanceof StalePreconditionError || error instanceof UnsupportedOperationError ? error : repositoryStoreUnavailable("repo.edit", id)
    }),
    setArchived: (tenantId, id, action: RepositoryVersionActionInput, archived) => Effect.tryPromise({
      try: async () => {
        const current = await db.prepare(repositorySelectSql("WHERE tenant_id = ? AND id = ? LIMIT 1")).bind(tenantId, id).first<RepositoryRow>();
        if (!current) throw new NotFoundError({ resource: "repository", id });
        if (current.version !== action.expected_version) throw new StalePreconditionError({ expected: action.expected_version, actual: current.version });
        if ((current.archived === 1) === archived) throw new InvalidStateTransitionError({ resource: "repository", id, state: current.archived === 1 ? "archived" : "active", expectedState: archived ? "active" : "archived" });
        const now = clock.now().toISOString();
        const row = await db.prepare(repositoryUpdateReturningSql("SET version = version + 1, updated_at = ?, archived = ? WHERE tenant_id = ? AND id = ? AND version = ?")).bind(now, archived ? 1 : 0, tenantId, id, action.expected_version).first<RepositoryRow>();
        if (!row) throw new StalePreconditionError({ expected: action.expected_version, actual: current.version });
        return toRepository(row);
      },
      catch: (error) => error instanceof InvalidStateTransitionError || error instanceof NotFoundError || error instanceof StalePreconditionError ? error : repositoryStoreUnavailable(archived ? "repo.archive" : "repo.unarchive", id)
    }),
    delete: (tenantId, id, action: RepositoryVersionActionInput) => Effect.tryPromise({
      try: async () => {
        const deleteStorage = options.gitProvisioner?.deleteRepository;
        if (!deleteStorage) throw repositoryStoreUnavailable("repo.delete", id);
        const current = await db.prepare(repositorySelectSql("WHERE tenant_id = ? AND id = ? LIMIT 1")).bind(tenantId, id).first<RepositoryRow>();
        if (!current) throw new NotFoundError({ resource: "repository", id });
        if (current.version !== action.expected_version) throw new StalePreconditionError({ expected: action.expected_version, actual: current.version });
        // A fork records its parent, so the parent stays while any fork does.
        if (await db.prepare("SELECT id FROM repositories WHERE tenant_id = ? AND fork_of = ? LIMIT 1").bind(tenantId, id).first<{ id: string }>()) throw new RepositoryHasForksError({ tenantId, id });
        // Storage goes first: if removing the record then fails, the same delete can run again and finish.
        await Effect.runPromise(deleteStorage({ artifactsNamespace: current.artifacts_namespace, artifactsName: current.artifacts_name }));
        // The repository's activity events describe only it, so they go with its record, in one transaction when the database offers one.
        const removeEvents = db.prepare("DELETE FROM resource_events WHERE tenant_id = ? AND repository_id = ? AND EXISTS (SELECT 1 FROM repositories WHERE tenant_id = ? AND id = ? AND version = ?)").bind(tenantId, id, tenantId, id, action.expected_version);
        const removeRecord = db.prepare("DELETE FROM repositories WHERE tenant_id = ? AND id = ? AND version = ?").bind(tenantId, id, action.expected_version);
        const results = db.batch ? await db.batch([removeEvents, removeRecord]) : [await removeEvents.run(), await removeRecord.run()];
        if (!(Number(results[1]?.meta?.changes ?? 0) > 0)) throw new StalePreconditionError({ expected: action.expected_version, actual: current.version });
        const now = clock.now().toISOString();
        return {
          tenant_id: tenantId,
          id: `op-delete-${(await sha256Hex(JSON.stringify(["gitfoundry.repository.delete.v1", tenantId, id, current.version]))).slice(0, 32)}`,
          version: 1,
          created_at: now,
          updated_at: now,
          status: "succeeded",
          kind: "repo.delete",
          progress: { stage: "completed", completed: 1, total: 1, blocked_reason: null },
          result: { repository_id: id, name: current.name },
          error: null
        } satisfies OperationRecord;
      },
      catch: (error) => error instanceof NotFoundError || error instanceof RepositoryHasForksError || error instanceof RepositoryStoreUnavailableError || error instanceof StalePreconditionError ? error : repositoryStoreUnavailable("repo.delete", id)
    })
  };
}

function repositoryStoreUnavailable(operationId: string, id: string): RepositoryStoreUnavailableError {
  return new RepositoryStoreUnavailableError({ operationId, resource: "repository", id, reason: "storage_unavailable" });
}

async function repositoryNameConflict(db: D1DatabaseLike, tenantId: string, namespaceId: string, name: string, id: string): Promise<{ readonly id: string } | null> {
  return await db.prepare("SELECT id FROM repositories WHERE tenant_id = ? AND namespace_id = ? AND name = ? AND id <> ? LIMIT 1").bind(tenantId, namespaceId, name, id).first<{ id: string }>();
}

export function makeD1OperationStore(db: D1DatabaseLike): OperationStore {
  return {
    get: (tenantId, id) => Effect.tryPromise({ try: async () => { const row = await db.prepare("SELECT tenant_id,id,version,created_at,updated_at,kind,state,progress_json,result_key,error_json FROM operations WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, id).first<OperationRow>(); if (!row) throw new NotFoundError({ resource: "operation", id }); return toOperationRecord(row); }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "operation", id }) }),
    put: (record) => Effect.promise(() => db.prepare("INSERT INTO operations(tenant_id,id,version,created_at,updated_at,kind,actor_id,state,progress_json,result_key,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, state = excluded.state, progress_json = excluded.progress_json, result_key = excluded.result_key, error_json = excluded.error_json").bind(record.tenant_id, record.id, record.version, record.created_at, record.updated_at, record.kind, "system", record.status, JSON.stringify(record.progress), encodeJsonKey(record.result), record.error ? JSON.stringify(record.error) : null).run()).pipe(Effect.asVoid)
  };
}

export function makeD1IdempotencyStore(db: D1DatabaseLike, clock: Clock = systemClock): IdempotencyStore {
  return {
    replayOrReserve: (scope, fingerprint, pending) => Effect.tryPromise({
      try: async () => {
        const [tenantId, actorId, operationId, key] = parseScope(scope);
        const now = clock.now().toISOString();
        await db.prepare("DELETE FROM idempotency WHERE tenant_id = ? AND actor_id = ? AND operation_kind = ? AND key = ? AND expires_at <= ?").bind(tenantId, actorId, operationId, key, now).run();
        const expires = new Date(clock.now().getTime() + 86400000).toISOString();
        const id = `idem-${await sha256Hex(scope)}`;
        try {
          await db.prepare("INSERT INTO idempotency(tenant_id,id,version,created_at,updated_at,actor_id,operation_kind,key,request_digest,response_key,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(tenantId, id, 1, now, now, actorId, operationId, key, fingerprint, `pending:${pending.id}`, expires).run();
        } catch (error) {
          const row = await db.prepare("SELECT request_digest, response_key, expires_at FROM idempotency WHERE tenant_id = ? AND actor_id = ? AND operation_kind = ? AND key = ? LIMIT 1").bind(tenantId, actorId, operationId, key).first<{ request_digest: string; response_key: string; expires_at: string }>();
          if (!row || row.expires_at <= now) throw error;
          if (row.request_digest !== fingerprint) throw new IdempotencyConflictError({ key });
          const receipt = decodeReceipt(row.response_key);
          if (receipt) return receipt.status === "succeeded" ? { ...receipt, replayed: true } : receipt;
          return { status: "pending", operationId, reason: "in_progress", receiptId: row.response_key.slice("pending:".length) } satisfies OperationReceipt;
        }
        await db.prepare("INSERT OR IGNORE INTO operations(tenant_id,id,version,created_at,updated_at,kind,actor_id,state,progress_json,result_key,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(pending.tenant_id, pending.id, pending.version, pending.created_at, pending.updated_at, pending.kind, actorId, pending.status, JSON.stringify(pending.progress), encodeJsonKey(pending.result), null).run();
        return undefined;
      },
      catch: (error) => error instanceof IdempotencyConflictError ? error : new IdempotencyConflictError({ key: scope })
    }),
    commit: (scope, fingerprint, receipt, reservationId) => Effect.tryPromise({
      try: async () => {
        const [tenantId, actorId, operationId, key] = parseScope(scope);
        const now = clock.now().toISOString();
        const committed = await db.prepare("UPDATE idempotency SET response_key = ?, updated_at = ? WHERE tenant_id = ? AND actor_id = ? AND operation_kind = ? AND key = ? AND request_digest = ? AND response_key = ? AND expires_at > ? RETURNING id").bind(encodeReceipt(receipt), now, tenantId, actorId, operationId, key, fingerprint, `pending:${reservationId}`, now).first<{ id: string }>();
        if (!committed) throw new IdempotencyConflictError({ key });
      },
      catch: (error) => error instanceof IdempotencyConflictError ? error : new IdempotencyConflictError({ key: scope })
    })
  };
}

interface RepositoryRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly namespace_id: string; readonly name: string; readonly visibility: Repository["visibility"]; readonly default_branch: string; readonly archived: number; readonly artifacts_namespace: string; readonly artifacts_name: string; readonly fork_of: string | null }
interface OperationRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly kind: string; readonly state: OperationRecord["status"]; readonly progress_json: string; readonly result_key: string | null; readonly error_json: string | null }

function repositoryColumns(): string { return "tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of" }
function repositorySelectSql(where: string): string { return `SELECT ${repositoryColumns()} FROM repositories ${where}` }
function repositoryUpdateReturningSql(setAndWhere: string): string { return `UPDATE repositories ${setAndWhere} RETURNING ${repositoryColumns()}` }
function toOperationRecord(row: OperationRow): OperationRecord { return { tenant_id: row.tenant_id, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, status: row.state, kind: row.kind, progress: parseJsonRecord(row.progress_json), result: decodeJsonKey(row.result_key), error: row.error_json ? JSON.parse(row.error_json) as OperationRecord["error"] : null } }
async function sha256Hex(value: string): Promise<string> {
  const subtle = (globalThis as unknown as { readonly crypto?: { readonly subtle?: { readonly digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> } } }).crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto SHA-256 is unavailable");
  const encoder = new (globalThis as unknown as { readonly TextEncoder: new () => { readonly encode: (text: string) => Uint8Array } }).TextEncoder();
  const digest = await subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseScope(scope: string): [string, string, string, string] { const parsed = JSON.parse(scope) as unknown; if (!Array.isArray(parsed) || parsed.length !== 4 || !parsed.every((item) => typeof item === "string")) throw new Error("invalid idempotency scope"); return parsed as [string, string, string, string] }
function encodeReceipt(receipt: OperationReceipt): string { return `receipt:${JSON.stringify(receipt)}` }
function decodeReceipt(value: string): OperationReceipt | undefined { return value.startsWith("receipt:") ? JSON.parse(value.slice(8)) as OperationReceipt : undefined }
function encodeJsonKey(value: Record<string, unknown>): string { return `json:${JSON.stringify(value)}` }
function decodeJsonKey(value: string | null): Record<string, unknown> { return value?.startsWith("json:") ? parseJsonRecord(value.slice(5)) : {} }
function parseJsonRecord(value: string): Record<string, unknown> { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} }
function hashString(value: string): string { let hash = 5381; for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index); return (hash >>> 0).toString(16) }
