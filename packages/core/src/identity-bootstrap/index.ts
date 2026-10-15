import { Data, Effect, Schema } from "effect";

const Id = Schema.String.check(Schema.isBetweenLength(1, 128));
const NonEmpty = Schema.NonEmptyString;
const Hostname = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/));
const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/));
const Rfc3339 = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\//));
const MaxSubjectBytes = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 2048 }));

export const tenantBootstrapProviderGateNames = [
  "bootstrap.domain.ownership",
  "bootstrap.access.application",
  "bootstrap.identity.claim_mapping",
  "bootstrap.directory.snapshot"
] as const;

export type TenantBootstrapProviderGateName = typeof tenantBootstrapProviderGateNames[number];

export const TenantBootstrapManifestSchema = Schema.Struct({
  schema_version: Schema.Literal("gitfoundry.identity-bootstrap.v1"),
  idempotency_key: Id,
  expected_manifest_digest: Schema.optional(Sha256),
  not_before: Rfc3339,
  expires_at: Rfc3339,
  operator: Schema.Struct({
    subject: NonEmpty,
    deployment_id: Id
  }),
  tenant: Schema.Struct({
    id: Id,
    slug: Slug,
    hostname: Hostname,
    customer_id: Id,
    shard_id: Id,
    jurisdiction: Id
  }),
  verified_domain: Schema.Struct({
    domain: Hostname,
    verification_method: Schema.Union([Schema.Literal("cloudflare_zone"), Schema.Literal("dns_txt"), Schema.Literal("contracted_domain_registry")])
  }),
  access_application: Schema.Struct({
    account_id: Id,
    application_id: Id,
    audience: NonEmpty,
    team_domain: Hostname,
    issuer: HttpsUrl
  }),
  qualified_idp: Schema.Struct({
    connection_id: Id,
    provider_kind: Schema.Union([Schema.Literal("oidc"), Schema.Literal("saml")]),
    provider_id: Id,
    issuer: HttpsUrl,
    immutable_subject_claim: Id,
    connection_marker_claim: Id
  }),
  directory_connector: Schema.Struct({
    id: Id,
    namespace: Id,
    external_tenant_id: Id,
    mode: Schema.Union([Schema.Literal("dual_destination"), Schema.Literal("qualified_connector")])
  }),
  claim_mapping: Schema.Struct({
    subject_claim: Id,
    provider_account_claim: Id,
    connection_marker_claim: Id,
    connection_marker_value: Id,
    groups_claim: Id,
    max_subject_bytes: MaxSubjectBytes,
    display_email_claim: Schema.optional(Id)
  }),
  admin_groups: Schema.Array(Schema.Struct({
    id: Id,
    external_id: Id
  }))
});

export type TenantBootstrapManifest = typeof TenantBootstrapManifestSchema.Type;

export interface TenantBootstrapValidatedManifest {
  readonly manifest: TenantBootstrapManifest;
  readonly digest: string;
}

export interface TenantBootstrapResult {
  readonly status: "initialized" | "replayed";
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly admin_group_ids: readonly string[];
  readonly manifest_digest: string;
  readonly replayed: boolean;
}

export interface TenantBootstrapOptions {
  readonly now?: string;
}

export interface TenantBootstrapSql {
  readonly get: <T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => Promise<T | null>;
  readonly run: (sql: string, values?: readonly unknown[]) => Promise<void>;
}

export interface TenantBootstrapStore {
  readonly kind: "sqlite-transactional" | "durable-object-transactional";
  readonly transaction: <T>(body: (tx: TenantBootstrapSql) => Promise<T>) => Promise<T>;
}

export interface TenantBootstrapTrustedOperator {
  readonly subject: string;
  readonly deployment_id: string;
}

export interface TenantBootstrapProviderProofBase {
  readonly gate: TenantBootstrapProviderGateName;
  readonly manifest_digest: string;
  readonly checked_at: string;
  readonly evidence_digest: string;
}

export interface TenantBootstrapDomainProof extends TenantBootstrapProviderProofBase {
  readonly gate: "bootstrap.domain.ownership";
  readonly account_id: string;
  readonly domain: string;
  readonly hostname: string;
  readonly verification_method: TenantBootstrapManifest["verified_domain"]["verification_method"];
}

export interface TenantBootstrapAccessApplicationProof extends TenantBootstrapProviderProofBase {
  readonly gate: "bootstrap.access.application";
  readonly account_id: string;
  readonly application_id: string;
  readonly audience: string;
  readonly issuer: string;
  readonly team_domain: string;
}

export interface TenantBootstrapClaimMappingProof extends TenantBootstrapProviderProofBase {
  readonly gate: "bootstrap.identity.claim_mapping";
  readonly connection_id: string;
  readonly provider_id: string;
  readonly issuer: string;
  readonly access_issuer: string;
  readonly immutable_subject_claim: string;
  readonly provider_account_claim: string;
  readonly provider_account_id: string;
  readonly connection_marker_claim: string;
  readonly connection_marker: string;
  readonly groups_claim: string;
  readonly max_subject_bytes: number;
}

export interface TenantBootstrapDirectoryGroupSnapshot {
  readonly external_id: string;
  readonly display_name: string;
  readonly active: boolean;
}

export interface TenantBootstrapDirectoryMemberSnapshot {
  readonly external_id: string;
  readonly stable_subject: string;
  readonly display_name: string;
  readonly active: boolean;
  readonly group_external_ids: readonly string[];
  readonly emails?: readonly string[];
}

export interface TenantBootstrapDirectorySnapshot extends TenantBootstrapProviderProofBase {
  readonly gate: "bootstrap.directory.snapshot";
  readonly connector_id: string;
  readonly namespace: string;
  readonly external_tenant_id: string;
  readonly groups: readonly TenantBootstrapDirectoryGroupSnapshot[];
  readonly members: readonly TenantBootstrapDirectoryMemberSnapshot[];
}

export interface TenantBootstrapProviderPorts {
  readonly verifyDomainOwnership: (request: TenantBootstrapProviderRequest) => Promise<TenantBootstrapDomainProof>;
  readonly verifyAccessApplication: (request: TenantBootstrapProviderRequest) => Promise<TenantBootstrapAccessApplicationProof>;
  readonly verifyIdentityClaimMapping: (request: TenantBootstrapProviderRequest) => Promise<TenantBootstrapClaimMappingProof>;
  readonly fetchDirectorySnapshot: (request: TenantBootstrapProviderRequest) => Promise<TenantBootstrapDirectorySnapshot>;
}

export interface TenantBootstrapProviderRequest {
  readonly manifest: TenantBootstrapManifest;
  readonly manifest_digest: string;
  readonly now: string;
}

export interface TenantBootstrapTrustedContext {
  readonly operator: TenantBootstrapTrustedOperator;
  readonly provider: TenantBootstrapProviderPorts;
}

export interface StaticTenantBootstrapTrustedContext {
  readonly operator: TenantBootstrapTrustedOperator;
  readonly proofs: {
    readonly domain: TenantBootstrapDomainProof;
    readonly access_application: TenantBootstrapAccessApplicationProof;
    readonly claim_mapping: TenantBootstrapClaimMappingProof;
    readonly directory_snapshot: TenantBootstrapDirectorySnapshot;
  };
}

export class BootstrapValidationError extends Data.TaggedError("BootstrapValidationError")<{ readonly reason: string }> {}
export class BootstrapReplayConflictError extends Data.TaggedError("BootstrapReplayConflictError")<{ readonly tenantId: string; readonly key: string }> {}
export class BootstrapStorageError extends Data.TaggedError("BootstrapStorageError")<{ readonly reason: string }> {}

const weakSubjectClaims = new Set([
  "email",
  "mail",
  "preferred_username",
  "username",
  "user_name",
  "name",
  "display_name",
  "sub",
  "cf_access_sub",
  "cf-access-sub",
  "cf-access-authenticated-user-email"
]);

const adminCapabilities = [
  "tenant.settings.manage",
  "identity.connections.manage",
  "identity.groups.map",
  "permission.grants.manage",
  "role.definitions.manage",
  "audit.export"
] as const;

const providerProofMaxAgeMillis = 24 * 60 * 60 * 1000;

const allowedKeys = new Map<string, readonly string[]>([
  ["", ["schema_version", "idempotency_key", "expected_manifest_digest", "not_before", "expires_at", "operator", "tenant", "verified_domain", "access_application", "qualified_idp", "directory_connector", "claim_mapping", "admin_groups"]],
  ["operator", ["subject", "deployment_id"]],
  ["tenant", ["id", "slug", "hostname", "customer_id", "shard_id", "jurisdiction"]],
  ["verified_domain", ["domain", "verification_method"]],
  ["access_application", ["account_id", "application_id", "audience", "team_domain", "issuer"]],
  ["qualified_idp", ["connection_id", "provider_kind", "provider_id", "issuer", "immutable_subject_claim", "connection_marker_claim"]],
  ["directory_connector", ["id", "namespace", "external_tenant_id", "mode"]],
  ["claim_mapping", ["subject_claim", "provider_account_claim", "connection_marker_claim", "connection_marker_value", "groups_claim", "max_subject_bytes", "display_email_claim"]],
  ["admin_groups[]", ["id", "external_id"]]
]);

export function validateTenantBootstrapManifest(input: unknown, options: TenantBootstrapOptions = {}): Effect.Effect<TenantBootstrapValidatedManifest, BootstrapValidationError> {
  return Effect.tryPromise({
    try: async () => {
      assertKnownKeys(input, "");
      const manifest = Schema.decodeUnknownSync(TenantBootstrapManifestSchema)(input);
      validateBootstrapRequestSemantics(manifest, options.now ?? new Date().toISOString());
      const digest = await canonicalTenantBootstrapDigest(manifest);
      if (manifest.expected_manifest_digest !== undefined && manifest.expected_manifest_digest !== digest) {
        throw new BootstrapValidationError({ reason: "expected_manifest_digest does not match canonical manifest digest" });
      }
      return { manifest, digest };
    },
    catch: (error) => error instanceof BootstrapValidationError ? error : new BootstrapValidationError({ reason: String(error) })
  });
}

export function initializeTenantBootstrap(input: unknown, store: TenantBootstrapStore, trustedContext: TenantBootstrapTrustedContext, options: TenantBootstrapOptions = {}): Effect.Effect<TenantBootstrapResult, BootstrapValidationError | BootstrapReplayConflictError | BootstrapStorageError> {
  return Effect.gen(function* () {
    const now = options.now ?? new Date().toISOString();
    const validated = yield* validateTenantBootstrapManifest(input, { now });
    const trusted = yield* Effect.tryPromise({
      try: () => resolveTrustedBootstrap(validated, trustedContext, now),
      catch: (error) => error instanceof BootstrapValidationError ? error : new BootstrapValidationError({ reason: String(error) })
    });
    return yield* Effect.tryPromise({
      try: () => initializeTrustedTenantBootstrap(validated, trusted, store, now),
      catch: (error) => {
        if (error instanceof BootstrapReplayConflictError) return error;
        return new BootstrapStorageError({ reason: String(error) });
      }
    });
  });
}

export function initializeTenantBootstrapPromise(input: unknown, store: TenantBootstrapStore, trustedContext: TenantBootstrapTrustedContext, options: TenantBootstrapOptions = {}): Promise<TenantBootstrapResult> {
  return Effect.runPromise(initializeTenantBootstrap(input, store, trustedContext, options));
}

export function validateTenantBootstrapManifestPromise(input: unknown, options: TenantBootstrapOptions = {}): Promise<TenantBootstrapValidatedManifest> {
  return Effect.runPromise(validateTenantBootstrapManifest(input, options));
}

export function runTenantBootstrapEffect<T>(effect: Effect.Effect<T, unknown, never>): Promise<T> {
  return Effect.runPromise(effect);
}

export async function canonicalTenantBootstrapDigest(manifest: TenantBootstrapManifest): Promise<string> {
  const digestSubject = stripDigest(manifest);
  const bytes = new TextEncoder().encode(canonicalJson(digestSubject));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return hex(digest);
}

export function makeStaticTenantBootstrapTrustedContext(input: StaticTenantBootstrapTrustedContext): TenantBootstrapTrustedContext {
  const copy = JSON.parse(JSON.stringify(input)) as StaticTenantBootstrapTrustedContext;
  return {
    operator: copy.operator,
    provider: {
      verifyDomainOwnership: async () => copy.proofs.domain,
      verifyAccessApplication: async () => copy.proofs.access_application,
      verifyIdentityClaimMapping: async () => copy.proofs.claim_mapping,
      fetchDirectorySnapshot: async () => copy.proofs.directory_snapshot
    }
  };
}

interface TrustedBootstrapEvidence {
  readonly domain: TenantBootstrapDomainProof;
  readonly access: TenantBootstrapAccessApplicationProof;
  readonly claimMapping: TenantBootstrapClaimMappingProof;
  readonly directory: TenantBootstrapDirectorySnapshot;
}

interface PersistedDirectoryGroup {
  readonly groupId: string;
  readonly snapshot: TenantBootstrapDirectoryGroupSnapshot;
}

interface PersistedDirectoryMember {
  readonly memberId: string;
  readonly principalId: string;
  readonly linkId: string;
  readonly snapshot: TenantBootstrapDirectoryMemberSnapshot;
}

interface BootstrapRows {
  readonly operatorPrincipalId: string;
  readonly idempotencyId: string;
  readonly roleId: string;
  readonly auditId: string;
  readonly groups: readonly PersistedDirectoryGroup[];
  readonly members: readonly PersistedDirectoryMember[];
  readonly memberships: readonly { readonly groupId: string; readonly principalId: string }[];
  readonly grants: readonly { readonly grantId: string; readonly groupId: string }[];
}

async function resolveTrustedBootstrap(validated: TenantBootstrapValidatedManifest, context: TenantBootstrapTrustedContext, now: string): Promise<TrustedBootstrapEvidence> {
  const { manifest, digest } = validated;
  if (!context || !context.provider) throw new BootstrapValidationError({ reason: "trusted bootstrap context with provider ports is required" });
  if (context.operator.subject !== manifest.operator.subject || context.operator.deployment_id !== manifest.operator.deployment_id) {
    throw new BootstrapValidationError({ reason: "trusted operator context does not match the bootstrap manifest" });
  }
  const request = { manifest, manifest_digest: digest, now };
  const [domain, access, claimMapping, directory] = await Promise.all([
    context.provider.verifyDomainOwnership(request),
    context.provider.verifyAccessApplication(request),
    context.provider.verifyIdentityClaimMapping(request),
    context.provider.fetchDirectorySnapshot(request)
  ]);
  assertDomainProof(manifest, digest, now, domain);
  assertAccessProof(manifest, digest, now, access);
  assertClaimMappingProof(manifest, digest, now, claimMapping);
  assertDirectorySnapshot(manifest, digest, now, directory);
  return { domain, access, claimMapping, directory };
}

async function initializeTrustedTenantBootstrap(validated: TenantBootstrapValidatedManifest, trusted: TrustedBootstrapEvidence, store: TenantBootstrapStore, now: string): Promise<TenantBootstrapResult> {
  const { manifest, digest } = validated;
  const tenantId = manifest.tenant.id;
  const rows = await deriveBootstrapRows(manifest, digest, trusted.directory);
  const adminGroupIds = manifest.admin_groups.map((group) => group.id);

  return store.transaction(async (tx) => {
    const existingManifest = await tx.get<{ request_digest: string }>(
      "SELECT request_digest FROM idempotency WHERE tenant_id = ? AND operation_kind = ? AND key = ?",
      [tenantId, "tenant.bootstrap", manifest.idempotency_key]
    );
    if (existingManifest != null) {
      if (existingManifest.request_digest === digest) return result("replayed", manifest, digest);
      throw new BootstrapReplayConflictError({ tenantId, key: manifest.idempotency_key });
    }

    const existingTenant = await tx.get<{ id: string }>("SELECT id FROM tenants WHERE id = ?", [tenantId]);
    if (existingTenant != null) throw new BootstrapReplayConflictError({ tenantId, key: manifest.idempotency_key });

    const configJson = JSON.stringify({
      identity: {
        mode: "strict_directory",
        verified_domain: manifest.verified_domain,
        access_application: manifest.access_application,
        qualified_idp: manifest.qualified_idp,
        directory_connector: manifest.directory_connector,
        claim_mapping: manifest.claim_mapping,
        admin_group_ids: adminGroupIds,
        provider_gates: tenantBootstrapProviderGateNames,
        provider_evidence: {
          domain: trusted.domain,
          access_application: trusted.access,
          claim_mapping: trusted.claimMapping,
          directory_snapshot: evidenceSummary(trusted.directory)
        },
        bootstrap_manifest_digest: digest
      }
    });
    const claimsJson = JSON.stringify({
      identity_qualified: true,
      provider_account_claim: trusted.claimMapping.provider_account_claim,
      provider_account_id: trusted.claimMapping.provider_account_id,
      immutable_subject_claim: trusted.claimMapping.immutable_subject_claim,
      connection_marker_claim: trusted.claimMapping.connection_marker_claim,
      connection_marker: trusted.claimMapping.connection_marker,
      max_subject_bytes: trusted.claimMapping.max_subject_bytes,
      groups_claim: trusted.claimMapping.groups_claim,
      directory_namespace: manifest.directory_connector.namespace,
      provider_gates: tenantBootstrapProviderGateNames,
      evidence: {
        access_application: trusted.access.evidence_digest,
        claim_mapping: trusted.claimMapping.evidence_digest,
        directory_snapshot: trusted.directory.evidence_digest
      }
    });

    await tx.run("INSERT INTO tenants(id, slug, state, policy_epoch, shard_id, jurisdiction, config_json) VALUES(?, ?, ?, ?, ?, ?, ?)", [tenantId, manifest.tenant.slug, "active", 1, manifest.tenant.shard_id, manifest.tenant.jurisdiction, configJson]);
    await tx.run("INSERT INTO principals(tenant_id, id, version, created_at, updated_at, kind, display_name, active, auth_epoch) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)", [tenantId, rows.operatorPrincipalId, 1, now, now, "system", manifest.operator.subject, 1, 1]);
    await tx.run("INSERT INTO connections(tenant_id, id, version, created_at, updated_at, issuer, external_tenant_id, audience, claims_json, active) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [tenantId, manifest.qualified_idp.connection_id, 1, now, now, trusted.access.issuer, manifest.directory_connector.external_tenant_id, trusted.access.audience, claimsJson, 1]);
    await tx.run("INSERT INTO roles(tenant_id, id, version, created_at, updated_at, name, capabilities_json) VALUES(?, ?, ?, ?, ?, ?, ?)", [tenantId, rows.roleId, 1, now, now, "tenant_admin_bootstrap", JSON.stringify(adminCapabilities)]);

    for (const group of rows.groups) {
      await tx.run("INSERT INTO groups(tenant_id, id, version, created_at, updated_at, connection_id, external_id, name, active) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)", [tenantId, group.groupId, 1, now, now, manifest.qualified_idp.connection_id, group.snapshot.external_id, group.snapshot.display_name, group.snapshot.active ? 1 : 0]);
    }
    for (const member of rows.members) {
      await tx.run("INSERT INTO principals(tenant_id, id, version, created_at, updated_at, kind, display_name, active, auth_epoch) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)", [tenantId, member.principalId, 1, now, now, "human", member.snapshot.display_name, member.snapshot.active ? 1 : 0, 1]);
      await tx.run("INSERT INTO directory_members(tenant_id, id, version, created_at, updated_at, connection_id, external_id, principal_id, active, emails_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [tenantId, member.memberId, 1, now, now, manifest.qualified_idp.connection_id, member.snapshot.external_id, member.principalId, member.snapshot.active ? 1 : 0, JSON.stringify(member.snapshot.emails ?? [])]);
      await tx.run("INSERT INTO identity_links(tenant_id, id, version, created_at, updated_at, principal_id, connection_id, issuer, stable_subject, source_kind, source_id, verified) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [tenantId, member.linkId, 1, now, now, member.principalId, manifest.qualified_idp.connection_id, trusted.access.issuer, member.snapshot.stable_subject, "directory", member.snapshot.external_id, 1]);
    }
    for (const membership of rows.memberships) {
      await tx.run("INSERT INTO group_memberships(tenant_id, group_id, principal_id, directory_version) VALUES(?, ?, ?, ?)", [tenantId, membership.groupId, membership.principalId, 1]);
    }
    for (const grant of rows.grants) {
      await tx.run("INSERT INTO grants(tenant_id, id, version, created_at, updated_at, subject_kind, subject_id, resource_kind, resource_id, role_id, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [tenantId, grant.grantId, 1, now, now, "group", grant.groupId, "tenant", tenantId, rows.roleId, null]);
    }

    await tx.run("INSERT INTO idempotency(tenant_id, id, version, created_at, updated_at, actor_id, operation_kind, key, request_digest, response_key, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [tenantId, rows.idempotencyId, 1, now, now, rows.operatorPrincipalId, "tenant.bootstrap", manifest.idempotency_key, digest, `tenant:${tenantId}:bootstrap:${digest}`, manifest.expires_at]);
    await tx.run("INSERT INTO audit(tenant_id, id, version, created_at, updated_at, actor_id, operation, resource_kind, resource_id, decision, policy_epoch, request_id, payload_digest, r2_record_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [tenantId, rows.auditId, 1, now, now, rows.operatorPrincipalId, "tenant.bootstrap", "tenant", tenantId, "allowed", 1, manifest.idempotency_key, digest, `bootstrap-manifests/${tenantId}/${digest}.json`]);

    return result("initialized", manifest, digest);
  });
}

async function deriveBootstrapRows(manifest: TenantBootstrapManifest, digest: string, directory: TenantBootstrapDirectorySnapshot): Promise<BootstrapRows> {
  const tenantId = manifest.tenant.id;
  const groupIdByExternalId = new Map<string, string>();
  for (const group of directory.groups) groupIdByExternalId.set(group.external_id, await scopedId("group", [tenantId, manifest.qualified_idp.connection_id, group.external_id]));
  for (const group of manifest.admin_groups) groupIdByExternalId.set(group.external_id, group.id);

  const groups = directory.groups.map((snapshot) => ({ groupId: requiredMapValue(groupIdByExternalId, snapshot.external_id, "directory group"), snapshot }));
  const members: PersistedDirectoryMember[] = [];
  for (const member of directory.members) {
    const principalId = await scopedId("principal", [tenantId, manifest.qualified_idp.connection_id, member.stable_subject]);
    members.push({
      memberId: await scopedId("member", [tenantId, manifest.qualified_idp.connection_id, member.external_id]),
      principalId,
      linkId: await scopedId("identity_link", [tenantId, manifest.qualified_idp.connection_id, member.stable_subject, member.external_id]),
      snapshot: member
    });
  }
  const principalIdByExternalId = new Map(members.map((member) => [member.snapshot.external_id, member.principalId]));
  const memberships = directory.members.flatMap((member) => member.group_external_ids.map((externalGroupId) => ({
    groupId: requiredMapValue(groupIdByExternalId, externalGroupId, "member group"),
    principalId: requiredMapValue(principalIdByExternalId, member.external_id, "directory member")
  })));
  const grants = await Promise.all(manifest.admin_groups.map(async (group) => ({
    groupId: group.id,
    grantId: await scopedId("grant", [tenantId, group.id, "tenant", tenantId, digest])
  })));
  return {
    operatorPrincipalId: await scopedId("bootstrap_operator", [tenantId, manifest.operator.deployment_id, manifest.operator.subject]),
    idempotencyId: await scopedId("bootstrap_manifest", [tenantId, manifest.idempotency_key, digest]),
    roleId: await scopedId("bootstrap_tenant_admin", [tenantId, digest]),
    auditId: await scopedId("audit_bootstrap", [tenantId, manifest.idempotency_key, digest]),
    groups,
    members,
    memberships,
    grants
  };
}

function validateBootstrapRequestSemantics(manifest: TenantBootstrapManifest, now: string) {
  const nowTime = parseTime(now, "now");
  if (parseTime(manifest.not_before, "not_before") > nowTime) throw new BootstrapValidationError({ reason: "bootstrap manifest is not active yet" });
  if (parseTime(manifest.expires_at, "expires_at") <= nowTime) throw new BootstrapValidationError({ reason: "bootstrap manifest is expired" });
  if (!hostnameMatchesDomain(manifest.tenant.hostname, manifest.verified_domain.domain)) throw new BootstrapValidationError({ reason: "tenant hostname is outside the verified customer domain" });
  if (manifest.claim_mapping.subject_claim !== manifest.qualified_idp.immutable_subject_claim) throw new BootstrapValidationError({ reason: "claim_mapping.subject_claim must equal the requested immutable subject claim" });
  if (manifest.claim_mapping.connection_marker_claim !== manifest.qualified_idp.connection_marker_claim) throw new BootstrapValidationError({ reason: "claim_mapping.connection_marker_claim must equal the requested connection marker claim" });
  if (!Number.isInteger(manifest.claim_mapping.max_subject_bytes)) throw new BootstrapValidationError({ reason: "claim_mapping.max_subject_bytes must be an integer" });
  assertStrongSubjectClaim(manifest.qualified_idp.immutable_subject_claim);
  assertUnique(manifest.admin_groups.map((group) => group.id), "admin group id");
  assertUnique(manifest.admin_groups.map((group) => group.external_id), "admin group external_id");
  if (manifest.admin_groups.length === 0) throw new BootstrapValidationError({ reason: "at least one authoritative administrator group external ID is required" });
}

function assertDomainProof(manifest: TenantBootstrapManifest, digest: string, now: string, proof: TenantBootstrapDomainProof) {
  assertGate(proof, "bootstrap.domain.ownership", digest, now, manifest);
  if (proof.account_id !== manifest.access_application.account_id) throw new BootstrapValidationError({ reason: "domain proof account does not match Access account" });
  if (proof.domain !== manifest.verified_domain.domain) throw new BootstrapValidationError({ reason: "domain proof does not match requested verified domain" });
  if (proof.hostname !== manifest.tenant.hostname) throw new BootstrapValidationError({ reason: "domain proof does not match requested tenant hostname" });
  if (proof.verification_method !== manifest.verified_domain.verification_method) throw new BootstrapValidationError({ reason: "domain proof verification method does not match request" });
}

function assertAccessProof(manifest: TenantBootstrapManifest, digest: string, now: string, proof: TenantBootstrapAccessApplicationProof) {
  assertGate(proof, "bootstrap.access.application", digest, now, manifest);
  if (proof.account_id !== manifest.access_application.account_id) throw new BootstrapValidationError({ reason: "Access proof account_id mismatch" });
  if (proof.application_id !== manifest.access_application.application_id) throw new BootstrapValidationError({ reason: "Access proof application_id mismatch" });
  if (proof.audience !== manifest.access_application.audience) throw new BootstrapValidationError({ reason: "Access proof audience mismatch" });
  if (proof.issuer !== manifest.access_application.issuer) throw new BootstrapValidationError({ reason: "Access proof issuer mismatch" });
  if (proof.team_domain !== manifest.access_application.team_domain) throw new BootstrapValidationError({ reason: "Access proof team domain mismatch" });
}

function assertClaimMappingProof(manifest: TenantBootstrapManifest, digest: string, now: string, proof: TenantBootstrapClaimMappingProof) {
  assertGate(proof, "bootstrap.identity.claim_mapping", digest, now, manifest);
  if (proof.connection_id !== manifest.qualified_idp.connection_id) throw new BootstrapValidationError({ reason: "claim mapping proof connection_id mismatch" });
  if (proof.provider_id !== manifest.qualified_idp.provider_id) throw new BootstrapValidationError({ reason: "claim mapping proof provider_id mismatch" });
  if (proof.issuer !== manifest.qualified_idp.issuer) throw new BootstrapValidationError({ reason: "claim mapping proof issuer mismatch" });
  if (proof.access_issuer !== manifest.access_application.issuer) throw new BootstrapValidationError({ reason: "claim mapping proof Access issuer mismatch" });
  if (proof.immutable_subject_claim !== manifest.qualified_idp.immutable_subject_claim) throw new BootstrapValidationError({ reason: "claim mapping proof subject claim mismatch" });
  if (proof.provider_account_claim !== manifest.claim_mapping.provider_account_claim) throw new BootstrapValidationError({ reason: "claim mapping proof provider account claim mismatch" });
  if (proof.provider_account_id !== manifest.access_application.account_id) throw new BootstrapValidationError({ reason: "claim mapping proof provider account id mismatch" });
  if (proof.connection_marker_claim !== manifest.qualified_idp.connection_marker_claim) throw new BootstrapValidationError({ reason: "claim mapping proof marker claim mismatch" });
  if (proof.connection_marker !== manifest.claim_mapping.connection_marker_value) throw new BootstrapValidationError({ reason: "claim mapping proof marker value mismatch" });
  if (proof.groups_claim !== manifest.claim_mapping.groups_claim) throw new BootstrapValidationError({ reason: "claim mapping proof groups claim mismatch" });
  if (proof.max_subject_bytes !== manifest.claim_mapping.max_subject_bytes) throw new BootstrapValidationError({ reason: "claim mapping proof max subject bytes mismatch" });
  assertStrongSubjectClaim(proof.immutable_subject_claim);
}

function assertDirectorySnapshot(manifest: TenantBootstrapManifest, digest: string, now: string, snapshot: TenantBootstrapDirectorySnapshot) {
  assertGate(snapshot, "bootstrap.directory.snapshot", digest, now, manifest);
  if (snapshot.connector_id !== manifest.directory_connector.id) throw new BootstrapValidationError({ reason: "directory snapshot connector_id mismatch" });
  if (snapshot.namespace !== manifest.directory_connector.namespace) throw new BootstrapValidationError({ reason: "directory snapshot namespace mismatch" });
  if (snapshot.external_tenant_id !== manifest.directory_connector.external_tenant_id) throw new BootstrapValidationError({ reason: "directory snapshot external_tenant_id mismatch" });
  assertUnique(snapshot.groups.map((group) => group.external_id), "directory group external_id");
  assertUnique(snapshot.members.map((member) => member.external_id), "directory member external_id");
  assertUnique(snapshot.members.map((member) => member.stable_subject), "directory member stable_subject");
  const groupsByExternalId = new Map(snapshot.groups.map((group) => [group.external_id, group]));
  for (const member of snapshot.members) {
    if (weakSubjectClaims.has(member.stable_subject.toLowerCase())) throw new BootstrapValidationError({ reason: "directory member stable subject must be an immutable provider subject, not email/sub" });
    assertUnique(member.group_external_ids, `directory member ${member.external_id} group_external_ids`);
    for (const externalGroupId of member.group_external_ids) {
      if (!groupsByExternalId.has(externalGroupId)) throw new BootstrapValidationError({ reason: `directory member references unknown group ${externalGroupId}` });
    }
  }
  const activeMembers = snapshot.members.filter((member) => member.active);
  for (const adminGroup of manifest.admin_groups) {
    const sourceGroup = groupsByExternalId.get(adminGroup.external_id);
    if (!sourceGroup || !sourceGroup.active) throw new BootstrapValidationError({ reason: `admin group ${adminGroup.external_id} is absent or inactive in the authoritative directory snapshot` });
  }
  const usableAdminMember = activeMembers.some((member) => member.group_external_ids.some((externalGroupId) => manifest.admin_groups.some((group) => group.external_id === externalGroupId)));
  if (!usableAdminMember) throw new BootstrapValidationError({ reason: "at least one active directory member must belong to an approved admin group before tenant activation" });
}

function assertGate(proof: TenantBootstrapProviderProofBase, gate: TenantBootstrapProviderGateName, digest: string, now: string, manifest: TenantBootstrapManifest) {
  if (!proof || proof.gate !== gate) throw new BootstrapValidationError({ reason: `${gate} proof is missing or mislabeled` });
  if (proof.manifest_digest !== digest) throw new BootstrapValidationError({ reason: `${gate} proof is not bound to the manifest digest` });
  if (!/^[a-f0-9]{64}$/.test(proof.evidence_digest)) throw new BootstrapValidationError({ reason: `${gate} evidence_digest must be lowercase SHA-256` });
  const checkedAt = parseTime(proof.checked_at, `${gate}.checked_at`);
  const nowTime = parseTime(now, "now");
  if (checkedAt > nowTime) throw new BootstrapValidationError({ reason: `${gate} proof is from the future` });
  if (checkedAt < parseTime(manifest.not_before, "not_before")) throw new BootstrapValidationError({ reason: `${gate} proof predates the bootstrap manifest activation window` });
  if (checkedAt >= parseTime(manifest.expires_at, "expires_at")) throw new BootstrapValidationError({ reason: `${gate} proof is outside the bootstrap manifest expiry window` });
  if (nowTime - checkedAt > providerProofMaxAgeMillis) throw new BootstrapValidationError({ reason: `${gate} proof is stale` });
}

function assertStrongSubjectClaim(claim: string) {
  if (weakSubjectClaims.has(claim.toLowerCase())) {
    throw new BootstrapValidationError({ reason: "immutable subject claim must not be Cloudflare sub, email, username, or display-name derived" });
  }
}

function assertKnownKeys(value: unknown, path: string) {
  if (!isRecord(value)) return;
  const keys = allowedKeys.get(path);
  if (keys !== undefined) {
    const allowed = new Set(keys);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new BootstrapValidationError({ reason: `unknown field ${path ? `${path}.` : ""}${key}` });
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (Array.isArray(nested)) {
      for (const item of nested) assertKnownKeys(item, `${nestedPath}[]`);
    } else {
      assertKnownKeys(nested, nestedPath);
    }
  }
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new BootstrapValidationError({ reason: `duplicate ${label}` });
}

function parseTime(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new BootstrapValidationError({ reason: `${label} must be a UTC RFC3339 timestamp` });
  return time;
}

function hostnameMatchesDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function stripDigest(manifest: TenantBootstrapManifest) {
  const { expected_manifest_digest: _expectedManifestDigest, ...digestSubject } = manifest;
  return digestSubject;
}

function result(status: "initialized" | "replayed", manifest: TenantBootstrapManifest, digest: string): TenantBootstrapResult {
  return {
    status,
    tenant_id: manifest.tenant.id,
    connection_id: manifest.qualified_idp.connection_id,
    admin_group_ids: manifest.admin_groups.map((group) => group.id),
    manifest_digest: digest,
    replayed: status === "replayed"
  };
}

function evidenceSummary(snapshot: TenantBootstrapDirectorySnapshot) {
  return {
    gate: snapshot.gate,
    manifest_digest: snapshot.manifest_digest,
    checked_at: snapshot.checked_at,
    evidence_digest: snapshot.evidence_digest,
    connector_id: snapshot.connector_id,
    namespace: snapshot.namespace,
    external_tenant_id: snapshot.external_tenant_id,
    group_count: snapshot.groups.length,
    member_count: snapshot.members.length
  };
}

function requiredMapValue(map: Map<string, string>, key: string, label: string) {
  const value = map.get(key);
  if (value === undefined) throw new BootstrapValidationError({ reason: `${label} ${key} is missing` });
  return value;
}

async function scopedId(prefix: string, parts: readonly unknown[]) {
  const digest = await digestText(canonicalJson(parts));
  return `${prefix}_${digest.slice(0, 40)}`;
}

async function digestText(text: string) {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
