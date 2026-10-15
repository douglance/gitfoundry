import { Effect } from "effect";

import { UnauthorizedError } from "../index.js";

export interface D1Result<T = Record<string, unknown>> { readonly results?: readonly T[]; readonly success?: boolean; readonly meta?: { readonly changes?: number } }
export interface D1PreparedStatement<T = Record<string, unknown>> {
  readonly bind: (...values: readonly unknown[]) => D1PreparedStatement<T>;
  readonly first: <R = T>() => Promise<R | null>;
  readonly all: <R = T>() => Promise<D1Result<R>>;
  readonly run: () => Promise<D1Result<T>>;
}
export interface D1DatabaseLike { readonly prepare: <T = Record<string, unknown>>(sql: string) => D1PreparedStatement<T>; readonly batch?: (statements: readonly D1PreparedStatement[]) => Promise<readonly D1Result[]> }
export interface Clock { readonly now: () => Date }

export type PrincipalKind = "human" | "service" | "extension" | "job" | "migration" | "system" | "historical";
export type ResourceKind = "tenant" | "namespace" | "repository" | "environment" | "runner_pool";

export interface ResourceRef {
  readonly kind: ResourceKind;
  readonly id: string;
  readonly tenant_id?: string;
}

export interface ResourceVerifiedIdentity {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly grant_ref: string;
  readonly policy_epoch: number;
  readonly kind?: PrincipalKind;
  readonly auth_epoch?: number;
}

export interface CredentialConstraint {
  readonly credential_id?: string;
  readonly scopes?: readonly string[];
  readonly resources?: readonly ResourceRef[];
}

export interface ResourceAuthorizationInput {
  readonly identity: ResourceVerifiedIdentity;
  readonly capability: string;
  readonly resource: ResourceRef;
  readonly grant_ref?: string;
  readonly expected_policy_epoch?: number;
  readonly expected_auth_epoch?: number;
  readonly credential?: CredentialConstraint;
}

export interface ResourceAuthorizationDecision {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly capability: string;
  readonly resource: ResourceRef;
  readonly grant_ref: string;
  readonly policy_epoch: number;
  readonly auth_epoch: number;
  readonly metadata: {
    readonly subject_kind: string;
    readonly matched_resource: ResourceRef;
    readonly credential_id?: string;
  };
}

export interface D1ResourceAuthorizer {
  readonly authorize: (input: ResourceAuthorizationInput) => Effect.Effect<ResourceAuthorizationDecision, UnauthorizedError>;
}

interface PrincipalState {
  readonly kind: PrincipalKind;
  readonly active: number;
  readonly auth_epoch: number;
  readonly tenant_state: string;
  readonly policy_epoch: number;
}

interface ResolvedResource {
  readonly requested: ResourceRef;
  readonly candidates: readonly ResourceRef[];
}

interface GrantRow {
  readonly grant_id: string;
  readonly subject_kind: "group" | "service" | "tenant_role" | "recovery_human";
  readonly subject_id: string;
  readonly resource_kind: ResourceKind;
  readonly resource_id: string;
  readonly role_capabilities: string;
  readonly expires_at: string | null;
}

interface CredentialRow {
  readonly id: string;
  readonly scopes_json: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

const systemClock: Clock = { now: () => new Date() };

export function makeD1ResourceAuthorizer(db: D1DatabaseLike, clock: Clock = systemClock): D1ResourceAuthorizer {
  return {
    authorize: (input) => Effect.tryPromise({
      try: async () => authorizeResource(db, clock, input),
      catch: (error) => error instanceof UnauthorizedError ? error : unauthorized(input, "resource authorization failed")
    })
  };
}

async function authorizeResource(db: D1DatabaseLike, clock: Clock, input: ResourceAuthorizationInput): Promise<ResourceAuthorizationDecision> {
  validateInput(input);
  const tenantId = input.identity.tenant_id;
  const principalId = input.identity.principal_id;
  const now = readClock(clock);
  const principal = await requireAdmissiblePrincipal(db, input, await readPrincipal(db, tenantId, principalId));

  const resolved = await resolveResource(db, tenantId, input.resource, input);
  await requireCredentialIntersection(db, input, resolved, now);

  const grants = await readCandidateGrants(db, tenantId, input.grant_ref, resolved.candidates);
  for (const grant of grants) {
    if (!grantIsLive(grant.expires_at, now)) continue;
    if (grant.subject_kind === "recovery_human" && grant.expires_at === null) continue;
    if (!grantMatchesAnyResource(grant, resolved.candidates)) continue;
    if (!roleHasCapability(grant.role_capabilities, input.capability)) continue;
    if (!(await subjectMatches(db, tenantId, principalId, principal.kind, grant))) continue;
    const finalPrincipal = await requireAdmissiblePrincipal(db, input, await readPrincipal(db, tenantId, principalId));
    if (principal.kind !== finalPrincipal.kind || principal.policy_epoch !== finalPrincipal.policy_epoch || principal.auth_epoch !== finalPrincipal.auth_epoch) throw unauthorized(input, "authorization state changed during evaluation");
    return {
      tenant_id: tenantId,
      principal_id: principalId,
      capability: input.capability,
      resource: resolved.requested,
      grant_ref: grant.grant_id,
      policy_epoch: principal.policy_epoch,
      auth_epoch: principal.auth_epoch,
      metadata: {
        subject_kind: grant.subject_kind,
        matched_resource: { kind: grant.resource_kind, id: grant.resource_id, tenant_id: tenantId },
        ...(input.credential?.credential_id ? { credential_id: input.credential.credential_id } : {})
      }
    };
  }

  throw unauthorized(input, "capability grant denied for resource");
}

async function requireAdmissiblePrincipal(db: D1DatabaseLike, input: ResourceAuthorizationInput, principal: PrincipalState | null): Promise<PrincipalState> {
  if (!principal || principal.active !== 1 || principal.tenant_state !== "active" || principal.kind === "historical") throw unauthorized(input, "principal or tenant inactive or missing");
  if (input.identity.kind !== undefined && input.identity.kind !== principal.kind) throw unauthorized(input, "verified identity kind is stale");
  if (input.identity.policy_epoch !== principal.policy_epoch || (input.expected_policy_epoch !== undefined && input.expected_policy_epoch !== principal.policy_epoch)) throw unauthorized(input, "tenant policy epoch is stale");
  if ((input.identity.auth_epoch !== undefined && input.identity.auth_epoch !== principal.auth_epoch) || (input.expected_auth_epoch !== undefined && input.expected_auth_epoch !== principal.auth_epoch)) throw unauthorized(input, "principal auth epoch is stale");
  if (principal.kind === "human" && !(await hasActiveQualifiedHumanMembership(db, input.identity.tenant_id, input.identity.principal_id))) throw unauthorized(input, "qualified human directory membership inactive or missing");
  return principal;
}

function validateInput(input: ResourceAuthorizationInput): void {
  if (!nonEmpty(input.identity.tenant_id)) throw unauthorized(input, "verified tenant missing");
  if (!nonEmpty(input.identity.principal_id)) throw unauthorized(input, "verified principal missing");
  if (!nonEmpty(input.identity.grant_ref)) throw unauthorized(input, "verified identity grant reference missing");
  if (!nonEmpty(input.capability)) throw unauthorized(input, "capability missing");
  validateEpoch(input.identity.policy_epoch, input, "verified policy epoch invalid");
  if (input.identity.auth_epoch !== undefined) validateEpoch(input.identity.auth_epoch, input, "verified auth epoch invalid");
  if (input.expected_policy_epoch !== undefined) validateEpoch(input.expected_policy_epoch, input, "expected policy epoch invalid");
  if (input.expected_auth_epoch !== undefined) validateEpoch(input.expected_auth_epoch, input, "expected auth epoch invalid");
  validateResource(input.resource, input, "resource invalid");
  if (input.resource.kind === "tenant" && input.resource.id !== input.identity.tenant_id) throw unauthorized(input, "tenant resource mismatch");
  if (input.resource.kind !== "tenant" && input.resource.tenant_id !== input.identity.tenant_id) throw unauthorized(input, "resource tenant mismatch");
  if (input.grant_ref !== undefined && !nonEmpty(input.grant_ref)) throw unauthorized(input, "grant reference invalid");
  if (input.credential?.credential_id !== undefined && !nonEmpty(input.credential.credential_id)) throw unauthorized(input, "credential reference invalid");
  for (const scope of input.credential?.scopes ?? []) if (!nonEmpty(scope)) throw unauthorized(input, "credential scope invalid");
  for (const resource of input.credential?.resources ?? []) validateResource(resource, input, "credential resource invalid");
}

function validateEpoch(value: number, input: ResourceAuthorizationInput, reason: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw unauthorized(input, reason);
}

function validateResource(resource: ResourceRef, input: ResourceAuthorizationInput, reason: string): void {
  if (!resource || !nonEmpty(resource.kind) || !nonEmpty(resource.id)) throw unauthorized(input, reason);
  if (!["tenant", "namespace", "repository", "environment", "runner_pool"].includes(resource.kind)) throw unauthorized(input, reason);
  if (resource.tenant_id !== undefined && !nonEmpty(resource.tenant_id)) throw unauthorized(input, reason);
}

async function readPrincipal(db: D1DatabaseLike, tenantId: string, principalId: string): Promise<PrincipalState | null> {
  return await db.prepare("SELECT p.kind AS kind, p.active AS active, p.auth_epoch AS auth_epoch, t.state AS tenant_state, t.policy_epoch AS policy_epoch FROM principals p JOIN tenants t ON t.id = p.tenant_id WHERE p.tenant_id = ? AND p.id = ? LIMIT 1").bind(tenantId, principalId).first<PrincipalState>();
}

async function hasActiveQualifiedHumanMembership(db: D1DatabaseLike, tenantId: string, principalId: string): Promise<boolean> {
  const rows = await db.prepare(`SELECT c.claims_json AS claims_json FROM directory_members dm JOIN identity_links l ON l.tenant_id = dm.tenant_id AND l.connection_id = dm.connection_id AND l.principal_id = dm.principal_id AND l.source_id = dm.external_id JOIN connections c ON c.tenant_id = dm.tenant_id AND c.id = dm.connection_id WHERE dm.tenant_id = ? AND dm.principal_id = ? AND dm.active = 1 AND l.verified = 1 AND l.source_kind = 'directory' AND c.active = 1`).bind(tenantId, principalId).all<{ claims_json: string }>();
  return (rows.results ?? []).some((row) => connectionIsQualified(row.claims_json));
}

function connectionIsQualified(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.identity_qualified === true && typeof parsed.immutable_subject_claim === "string" && parsed.immutable_subject_claim.length > 0;
  } catch {
    return false;
  }
}

async function resolveResource(db: D1DatabaseLike, tenantId: string, resource: ResourceRef, input: ResourceAuthorizationInput): Promise<ResolvedResource> {
  if (resource.kind === "runner_pool") throw unauthorized(input, "runner pool resources are not present in the current D1 schema");
  if (resource.kind === "tenant") return { requested: { kind: "tenant", id: tenantId, tenant_id: tenantId }, candidates: [{ kind: "tenant", id: tenantId, tenant_id: tenantId }] };
  if (resource.kind === "namespace") {
    const row = await db.prepare("SELECT id FROM organization_namespaces WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, resource.id).first<{ id: string }>();
    if (!row) throw unauthorized(input, "namespace resource missing");
    return { requested: { kind: "namespace", id: row.id, tenant_id: tenantId }, candidates: [{ kind: "namespace", id: row.id, tenant_id: tenantId }, { kind: "tenant", id: tenantId, tenant_id: tenantId }] };
  }
  if (resource.kind === "repository") {
    const row = await db.prepare("SELECT id, namespace_id FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, resource.id).first<{ id: string; namespace_id: string }>();
    if (!row) throw unauthorized(input, "repository resource missing");
    return { requested: { kind: "repository", id: row.id, tenant_id: tenantId }, candidates: [{ kind: "repository", id: row.id, tenant_id: tenantId }, { kind: "namespace", id: row.namespace_id, tenant_id: tenantId }, { kind: "tenant", id: tenantId, tenant_id: tenantId }] };
  }
  const row = await db.prepare("SELECT e.id AS environment_id, e.repository_id AS repository_id, r.namespace_id AS namespace_id FROM environments e JOIN repositories r ON r.tenant_id = e.tenant_id AND r.id = e.repository_id WHERE e.tenant_id = ? AND e.id = ? LIMIT 1").bind(tenantId, resource.id).first<{ environment_id: string; repository_id: string; namespace_id: string }>();
  if (!row) throw unauthorized(input, "environment resource missing");
  return { requested: { kind: "environment", id: row.environment_id, tenant_id: tenantId }, candidates: [{ kind: "environment", id: row.environment_id, tenant_id: tenantId }, { kind: "repository", id: row.repository_id, tenant_id: tenantId }, { kind: "namespace", id: row.namespace_id, tenant_id: tenantId }, { kind: "tenant", id: tenantId, tenant_id: tenantId }] };
}

async function readCandidateGrants(db: D1DatabaseLike, tenantId: string, grantRef: string | undefined, resources: readonly ResourceRef[]): Promise<readonly GrantRow[]> {
  const predicates = resources.map(() => "(g.resource_kind = ? AND g.resource_id = ?)").join(" OR ");
  const resourceParams = resources.flatMap((resource) => [resource.kind, resource.id]);
  const rows = await db.prepare(`SELECT g.id AS grant_id, g.subject_kind AS subject_kind, g.subject_id AS subject_id, g.resource_kind AS resource_kind, g.resource_id AS resource_id, g.expires_at AS expires_at, r.capabilities_json AS role_capabilities FROM grants g JOIN roles r ON r.tenant_id = g.tenant_id AND r.id = g.role_id WHERE g.tenant_id = ? AND (${predicates}) AND (? IS NULL OR g.id = ?)`).bind(tenantId, ...resourceParams, grantRef ?? null, grantRef ?? null).all<GrantRow>();
  return rows.results ?? [];
}

function grantMatchesAnyResource(grant: GrantRow, resources: readonly ResourceRef[]): boolean {
  return resources.some((resource) => grant.resource_kind === resource.kind && grant.resource_id === resource.id);
}

function roleHasCapability(value: string, capability: string): boolean {
  try {
    const capabilities = JSON.parse(value) as unknown;
    return Array.isArray(capabilities) && capabilities.some((entry) => entry === capability);
  } catch {
    return false;
  }
}

async function subjectMatches(db: D1DatabaseLike, tenantId: string, principalId: string, principalKind: PrincipalState["kind"], grant: GrantRow): Promise<boolean> {
  if (grant.subject_kind === "service") return principalKind === "service" && grant.subject_id === principalId;
  if (grant.subject_kind === "tenant_role") return grant.subject_id === principalId;
  if (grant.subject_kind === "recovery_human") return principalKind === "human" && grant.subject_id === principalId;
  const row = await db.prepare("SELECT gm.group_id FROM group_memberships gm JOIN groups g ON g.tenant_id = gm.tenant_id AND g.id = gm.group_id WHERE gm.tenant_id = ? AND gm.principal_id = ? AND gm.group_id = ? AND g.active = 1 LIMIT 1").bind(tenantId, principalId, grant.subject_id).first<{ group_id: string }>();
  return Boolean(row);
}

async function requireCredentialIntersection(db: D1DatabaseLike, input: ResourceAuthorizationInput, resolved: ResolvedResource, now: number): Promise<void> {
  const credential = input.credential;
  if (!credential) return;
  const inlineScopes = credential.scopes ?? null;
  if (credential.credential_id) {
    const row = await db.prepare("SELECT id, scopes_json, expires_at, revoked_at FROM credentials WHERE tenant_id = ? AND principal_id = ? AND id = ? LIMIT 1").bind(input.identity.tenant_id, input.identity.principal_id, credential.credential_id).first<CredentialRow>();
    if (!row || row.revoked_at !== null || !grantIsLive(row.expires_at, now)) throw unauthorized(input, "credential inactive or missing");
    if (!parseStringArray(row.scopes_json).includes(input.capability)) throw unauthorized(input, "credential scope does not include capability");
  }
  if (inlineScopes !== null && !inlineScopes.includes(input.capability)) throw unauthorized(input, "credential scope does not include capability");
  if (credential.resources !== undefined && credential.resources.length === 0) throw unauthorized(input, "credential resource filter empty");
  if (credential.resources !== undefined && !credential.resources.some((resource) => credentialResourceAllows(resource, resolved))) throw unauthorized(input, "credential resource filter does not include resource");
}

function credentialResourceAllows(resource: ResourceRef, resolved: ResolvedResource): boolean {
  return resolved.candidates.some((candidate) => candidate.kind === resource.kind && candidate.id === resource.id && (resource.tenant_id === undefined || resource.tenant_id === candidate.tenant_id));
}

function parseStringArray(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function grantIsLive(expiresAt: string | null, now: number): boolean {
  if (expiresAt === null) return true;
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) && expires > now;
}

function readClock(clock: Clock): number {
  const now = clock.now().getTime();
  if (!Number.isFinite(now)) throw new Error("resource authorizer clock invalid");
  return now;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function unauthorized(input: Pick<ResourceAuthorizationInput, "identity" | "capability">, reason: string): UnauthorizedError {
  return new UnauthorizedError({ reason, actorId: input.identity?.principal_id ?? "unresolved", tenantId: input.identity?.tenant_id ?? "unresolved", capability: input.capability ?? "unknown" });
}
