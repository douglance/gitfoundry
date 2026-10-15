import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  BootstrapReplayConflictError,
  BootstrapValidationError,
  canonicalTenantBootstrapDigest,
  initializeTenantBootstrapPromise,
  makeStaticTenantBootstrapTrustedContext,
  runTenantBootstrapEffect,
  type StaticTenantBootstrapTrustedContext,
  type TenantBootstrapManifest,
  type TenantBootstrapStore,
  type TenantBootstrapTrustedContext
} from "../../../packages/core/src/identity-bootstrap/index.js";
import { makeD1IdentityPort } from "../../../packages/core/src/live/index.js";

const now = "2026-10-08T00:00:00Z";

class SqliteBootstrapStore implements TenantBootstrapStore {
  readonly kind = "sqlite-transactional" as const;

  constructor(readonly db = new DatabaseSync(":memory:")) {}

  async transaction<T>(body: Parameters<TenantBootstrapStore["transaction"]>[0]): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await body({
        get: async <R extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => this.db.prepare(sql).get(...values) as R | undefined ?? null,
        run: async (sql: string, values: readonly unknown[] = []) => { this.db.prepare(sql).run(...values); }
      });
      this.db.exec("COMMIT");
      return result as T;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  prepare(sql: string) {
    const statement = (values: readonly unknown[] = []) => ({
      bind: (...nextValues: readonly unknown[]) => statement(nextValues),
      first: async <R = Record<string, unknown>>() => this.db.prepare(sql).get(...values) as R | undefined ?? null,
      all: async <R = Record<string, unknown>>() => ({ results: this.db.prepare(sql).all(...values) as R[] }),
      run: async () => {
        const result = this.db.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      }
    });
    return statement();
  }
}

describe("identity tenant bootstrap initializer", () => {
  it("requires trusted provider gates, persists authoritative directory rows, and activates only after proof", async () => {
    const store = fixtureStore();
    const manifest = await validManifest();
    const trusted = await trustedContext(manifest);

    const result = await initializeTenantBootstrapPromise(manifest, store, trusted, { now });

    expect(result).toMatchObject({ status: "initialized", tenant_id: "tenant_acme", connection_id: "conn_acme_access", replayed: false });
    expect(result.manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(store.db.prepare("SELECT state, config_json FROM tenants WHERE id = ?").get("tenant_acme")).toMatchObject({ state: "active" });
    expect(JSON.parse(store.db.prepare("SELECT claims_json FROM connections WHERE tenant_id = ? AND id = ?").get("tenant_acme", "conn_acme_access")!.claims_json as string)).toMatchObject({ identity_qualified: true, provider_account_claim: "cf_account_id", provider_account_id: "88f9cbf5c4f4e217079bcbf0ca6cb181", immutable_subject_claim: "entra_object_id", connection_marker: "conn_acme_access", max_subject_bytes: 256, groups_claim: "gfy_group_external_ids" });
    expect(store.db.prepare("SELECT issuer FROM connections WHERE tenant_id = ? AND id = ?").get("tenant_acme", "conn_acme_access")).toMatchObject({ issuer: "https://solitary-poetry-b5fd.cloudflareaccess.com" });
    expect(store.db.prepare("SELECT count(*) AS count FROM groups WHERE tenant_id = ?").get("tenant_acme")).toMatchObject({ count: 4 });
    expect(store.db.prepare("SELECT count(*) AS count FROM grants WHERE tenant_id = ? AND subject_kind = ?").get("tenant_acme", "group")).toMatchObject({ count: 2 });
    expect(store.db.prepare("SELECT count(*) AS count FROM directory_members WHERE tenant_id = ?").get("tenant_acme")).toMatchObject({ count: 3 });
    expect(store.db.prepare("SELECT count(*) AS count FROM principals WHERE tenant_id = ? AND kind = ?").get("tenant_acme", "human")).toMatchObject({ count: 3 });
    expect(store.db.prepare("SELECT count(*) AS count FROM identity_links WHERE tenant_id = ? AND source_kind = ?").get("tenant_acme", "directory")).toMatchObject({ count: 3 });
    expect(store.db.prepare("SELECT count(*) AS count FROM group_memberships WHERE tenant_id = ?").get("tenant_acme")).toMatchObject({ count: 4 });
    expect(store.db.prepare("SELECT request_digest FROM idempotency WHERE tenant_id = ? AND operation_kind = ?").get("tenant_acme", "tenant.bootstrap")).toMatchObject({ request_digest: result.manifest_digest });
    expect(store.db.prepare("SELECT actor_id, payload_digest FROM audit WHERE tenant_id = ? AND operation = ?").get("tenant_acme", "tenant.bootstrap")).toMatchObject({ payload_digest: result.manifest_digest });
  });

  it("initializes rows that the live qualified identity port resolves with distinct Access, IdP, and directory subjects", async () => {
    const store = fixtureStore();
    const manifest = await validManifest({ qualified_idp: { issuer: "https://login.microsoftonline.com/acme/v2.0" } });
    const trusted = await trustedContext(manifest);

    await initializeTenantBootstrapPromise(manifest, store, trusted, { now });

    const link = store.db.prepare("SELECT issuer, stable_subject, source_kind, source_id, principal_id FROM identity_links WHERE tenant_id = ? AND source_id = ?").get("tenant_acme", "u-admin-1") as { issuer: string; stable_subject: string; source_kind: string; source_id: string; principal_id: string };
    expect(link).toMatchObject({ issuer: manifest.access_application.issuer, stable_subject: "entra-object-admin-1", source_kind: "directory", source_id: "u-admin-1" });
    expect(store.db.prepare("SELECT external_id, principal_id FROM directory_members WHERE tenant_id = ? AND external_id = ?").get("tenant_acme", "u-admin-1")).toMatchObject({ external_id: "u-admin-1", principal_id: link.principal_id });

    const identity = makeD1IdentityPort(store);
    const resolved = await runTenantBootstrapEffect(identity.resolveAccessPrincipal({
      issuer: manifest.access_application.issuer,
      audience: manifest.access_application.audience,
      requestedTenantId: manifest.tenant.id,
      claims: {
        cf_account_id: manifest.access_application.account_id,
        gfy_connection_id: manifest.claim_mapping.connection_marker_value,
        entra_object_id: "entra-object-admin-1",
        sub: "access-subject-admin-rotates",
        email: "not-authority@example.com"
      }
    }));
    expect(resolved).toMatchObject({ tenantId: "tenant_acme", principalId: link.principal_id, kind: "human", policyEpoch: 1 });
    await expect(runTenantBootstrapEffect(identity.verifyGrant({ tenantId: manifest.tenant.id, principalId: resolved.principalId, capability: "tenant.settings.manage", policyEpoch: resolved.policyEpoch }))).resolves.toMatchObject({ tenant_id: "tenant_acme", principal_id: link.principal_id });

    await expect(runTenantBootstrapEffect(identity.resolveAccessPrincipal({ issuer: manifest.access_application.issuer, audience: manifest.access_application.audience, requestedTenantId: manifest.tenant.id, claims: { cf_account_id: manifest.access_application.account_id, gfy_connection_id: "wrong-marker", entra_object_id: "entra-object-admin-1" } }))).rejects.toMatchObject({ _tag: "UnauthorizedError" });
    await expect(runTenantBootstrapEffect(identity.resolveAccessPrincipal({ issuer: manifest.access_application.issuer, audience: manifest.access_application.audience, requestedTenantId: manifest.tenant.id, claims: { cf_account_id: manifest.access_application.account_id, gfy_connection_id: manifest.claim_mapping.connection_marker_value, entra_object_id: "u-admin-1" } }))).rejects.toMatchObject({ _tag: "UnauthorizedError" });
  });

  it("replays the same consumed one-time manifest and rejects a changed manifest with the same key", async () => {
    const store = fixtureStore();
    const manifest = await validManifest();
    const trusted = await trustedContext(manifest);

    const first = await initializeTenantBootstrapPromise(manifest, store, trusted, { now });
    const second = await initializeTenantBootstrapPromise(manifest, store, trusted, { now });

    expect(second).toMatchObject({ status: "replayed", replayed: true, manifest_digest: first.manifest_digest });
    const changedManifest = await validManifest({ tenant: { ...manifest.tenant, slug: "acme-two" } });
    await expect(initializeTenantBootstrapPromise(changedManifest, store, await trustedContext(changedManifest), { now })).rejects.toBeInstanceOf(BootstrapReplayConflictError);
  });

  it("fails closed for email or Cloudflare-subject-only identity mappings", async () => {
    const emailManifest = await validManifest({ qualified_idp: { immutable_subject_claim: "email" }, claim_mapping: { subject_claim: "email" } });
    const subManifest = await validManifest({ qualified_idp: { immutable_subject_claim: "sub" }, claim_mapping: { subject_claim: "sub" } });

    await expect(initializeTenantBootstrapPromise(emailManifest, fixtureStore(), await trustedContext(emailManifest), { now })).rejects.toBeInstanceOf(BootstrapValidationError);
    await expect(initializeTenantBootstrapPromise(subManifest, fixtureStore(), await trustedContext(subManifest), { now })).rejects.toBeInstanceOf(BootstrapValidationError);
  });

  it("rejects fabricated manifest qualification, missing trusted ports, stale proofs, and mismatched operator context before writes", async () => {
    const manifest = await validManifest();
    const fabricatedQualification = { ...manifest, qualified_idp: { ...manifest.qualified_idp, qualification: { status: "qualified", checked_at: now, evidence_digest: "3".repeat(64), ports: [{ name: "access", endpoint: "https://example.com", status: "qualified" }] } } };
    const staleTrusted = await trustedContext(manifest, { proofTime: "2026-10-06T00:00:00Z" });
    const wrongOperator = await trustedContext(manifest, { operator: { subject: "operator:wrong", deployment_id: manifest.operator.deployment_id } });
    const wrongDigestTrusted = await trustedContext(manifest, { manifestDigest: "f".repeat(64) });

    await expect(initializeTenantBootstrapPromise(fabricatedQualification, fixtureStore(), await trustedContext(manifest), { now })).rejects.toBeInstanceOf(BootstrapValidationError);
    await expect(initializeTenantBootstrapPromise(manifest, fixtureStore(), undefined as unknown as TenantBootstrapTrustedContext, { now })).rejects.toBeInstanceOf(BootstrapValidationError);
    await expect(initializeTenantBootstrapPromise(manifest, fixtureStore(), staleTrusted, { now })).rejects.toBeInstanceOf(BootstrapValidationError);
    await expect(initializeTenantBootstrapPromise(manifest, fixtureStore(), wrongOperator, { now })).rejects.toBeInstanceOf(BootstrapValidationError);
    await expect(initializeTenantBootstrapPromise(manifest, fixtureStore(), wrongDigestTrusted, { now })).rejects.toBeInstanceOf(BootstrapValidationError);
    expect(fixtureStore().db.prepare("SELECT count(*) AS count FROM tenants").get()).toMatchObject({ count: 0 });
  });

  it("rejects admin groups that are not active in the authoritative directory snapshot", async () => {
    const missingAdmin = await validManifest({ admin_groups: [{ id: "grp_missing", external_id: "00g-missing" }] });
    const inactiveAdmin = await validManifest({ admin_groups: [{ id: "grp_inactive", external_id: "00g-inactive" }] });

    await expect(initializeTenantBootstrapPromise(missingAdmin, fixtureStore(), await trustedContext(missingAdmin), { now })).rejects.toBeInstanceOf(BootstrapValidationError);
    await expect(initializeTenantBootstrapPromise(inactiveAdmin, fixtureStore(), await trustedContext(inactiveAdmin), { now })).rejects.toBeInstanceOf(BootstrapValidationError);
  });

  it("rolls back the consumed manifest and tenant rows when a SQL write fails mid-bootstrap", async () => {
    const store = fixtureStore();
    store.db.exec("CREATE TRIGGER fail_bootstrap_group BEFORE INSERT ON groups WHEN NEW.name = 'Acme GitFoundry Administrators' BEGIN SELECT RAISE(ABORT, 'forced group insert failure'); END;");
    const manifest = await validManifest();

    await expect(initializeTenantBootstrapPromise(manifest, store, await trustedContext(manifest), { now })).rejects.toMatchObject({ _tag: "BootstrapStorageError", reason: expect.stringContaining("forced group insert failure") });

    expect(store.db.prepare("SELECT count(*) AS count FROM tenants WHERE id = ?").get("tenant_acme")).toMatchObject({ count: 0 });
    expect(store.db.prepare("SELECT count(*) AS count FROM idempotency WHERE tenant_id = ?").get("tenant_acme")).toMatchObject({ count: 0 });
    expect(store.db.prepare("SELECT count(*) AS count FROM audit WHERE tenant_id = ?").get("tenant_acme")).toMatchObject({ count: 0 });
  });

  it("derives unique grant ids from the canonical tuple instead of the printable group prefix", async () => {
    const common = "grp_common_prefix_with_more_than_forty_eight_characters_";
    const manifest = await validManifest({ admin_groups: [{ id: `${common}one`, external_id: "00g-admins" }, { id: `${common}two`, external_id: "00g-recovery" }] });
    const store = fixtureStore();

    await initializeTenantBootstrapPromise(manifest, store, await trustedContext(manifest), { now });

    const rows = store.db.prepare("SELECT id FROM grants WHERE tenant_id = ? ORDER BY id").all("tenant_acme") as { id: string }[];
    expect(rows.map((row) => row.id)).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });
});

function fixtureStore() {
  const store = new SqliteBootstrapStore();
  store.db.exec(readFileSync(resolve(process.cwd(), "docs/source/handoff/contracts/schema.sql"), "utf8"));
  return store;
}

async function validManifest(overrides: ManifestOverrides = {}): Promise<TenantBootstrapManifest> {
  const manifest = deepMerge({
    schema_version: "gitfoundry.identity-bootstrap.v1",
    idempotency_key: "bootstrap-acme-20261008-0001",
    not_before: "2026-10-07T23:00:00Z",
    expires_at: "2026-10-08T01:00:00Z",
    operator: {
      subject: "operator:cloudflare:88f9cbf5c4f4e217079bcbf0ca6cb181:bootstrap-root",
      deployment_id: "deploy_gfy_p0"
    },
    tenant: {
      id: "tenant_acme",
      slug: "acme-prod",
      hostname: "acme.example.com",
      customer_id: "customer_acme",
      shard_id: "shard_p0_acme",
      jurisdiction: "US"
    },
    verified_domain: {
      domain: "example.com",
      verification_method: "dns_txt"
    },
    access_application: {
      account_id: "88f9cbf5c4f4e217079bcbf0ca6cb181",
      application_id: "access_app_acme",
      audience: "acme-access-audience",
      team_domain: "solitary-poetry-b5fd.cloudflareaccess.com",
      issuer: "https://solitary-poetry-b5fd.cloudflareaccess.com"
    },
    qualified_idp: {
      connection_id: "conn_acme_access",
      provider_kind: "oidc",
      provider_id: "entra-acme",
      issuer: "https://solitary-poetry-b5fd.cloudflareaccess.com",
      immutable_subject_claim: "entra_object_id",
      connection_marker_claim: "gfy_connection_id"
    },
    directory_connector: {
      id: "dir_acme_scim",
      namespace: "entra_acme_directory",
      external_tenant_id: "entra-tenant-acme",
      mode: "dual_destination"
    },
    claim_mapping: {
      subject_claim: "entra_object_id",
      provider_account_claim: "cf_account_id",
      connection_marker_claim: "gfy_connection_id",
      connection_marker_value: "conn_acme_access",
      groups_claim: "gfy_group_external_ids",
      max_subject_bytes: 256,
      display_email_claim: "email"
    },
    admin_groups: [
      { id: "grp_acme_admins", external_id: "00g-admins" },
      { id: "grp_acme_recovery", external_id: "00g-recovery" }
    ]
  }, overrides) as TenantBootstrapManifest;
  return { ...manifest, expected_manifest_digest: await canonicalTenantBootstrapDigest(manifest) };
}

async function trustedContext(manifest: TenantBootstrapManifest, options: TrustedContextOptions = {}) {
  const digest = options.manifestDigest ?? await canonicalTenantBootstrapDigest(manifest);
  const proofTime = options.proofTime ?? "2026-10-07T23:30:00Z";
  const operator = options.operator ?? manifest.operator;
  const fixture: StaticTenantBootstrapTrustedContext = {
    operator,
    proofs: {
      domain: {
        gate: "bootstrap.domain.ownership",
        manifest_digest: digest,
        checked_at: proofTime,
        evidence_digest: "1".repeat(64),
        account_id: manifest.access_application.account_id,
        domain: manifest.verified_domain.domain,
        hostname: manifest.tenant.hostname,
        verification_method: manifest.verified_domain.verification_method
      },
      access_application: {
        gate: "bootstrap.access.application",
        manifest_digest: digest,
        checked_at: proofTime,
        evidence_digest: "2".repeat(64),
        account_id: manifest.access_application.account_id,
        application_id: manifest.access_application.application_id,
        audience: manifest.access_application.audience,
        issuer: manifest.access_application.issuer,
        team_domain: manifest.access_application.team_domain
      },
      claim_mapping: {
        gate: "bootstrap.identity.claim_mapping",
        manifest_digest: digest,
        checked_at: proofTime,
        evidence_digest: "3".repeat(64),
        connection_id: manifest.qualified_idp.connection_id,
        provider_id: manifest.qualified_idp.provider_id,
        issuer: manifest.qualified_idp.issuer,
        access_issuer: manifest.access_application.issuer,
        immutable_subject_claim: manifest.qualified_idp.immutable_subject_claim,
        provider_account_claim: manifest.claim_mapping.provider_account_claim,
        provider_account_id: manifest.access_application.account_id,
        connection_marker_claim: manifest.qualified_idp.connection_marker_claim,
        connection_marker: manifest.claim_mapping.connection_marker_value,
        max_subject_bytes: manifest.claim_mapping.max_subject_bytes,
        groups_claim: manifest.claim_mapping.groups_claim
      },
      directory_snapshot: {
        gate: "bootstrap.directory.snapshot",
        manifest_digest: digest,
        checked_at: proofTime,
        evidence_digest: "4".repeat(64),
        connector_id: manifest.directory_connector.id,
        namespace: manifest.directory_connector.namespace,
        external_tenant_id: manifest.directory_connector.external_tenant_id,
        groups: [
          { external_id: "00g-admins", display_name: "Acme GitFoundry Administrators", active: true },
          { external_id: "00g-recovery", display_name: "Acme GitFoundry Recovery Administrators", active: true },
          { external_id: "00g-developers", display_name: "Acme Developers", active: true },
          { external_id: "00g-inactive", display_name: "Acme Former Administrators", active: false }
        ],
        members: [
          { external_id: "u-admin-1", stable_subject: "entra-object-admin-1", display_name: "Admin One", active: true, group_external_ids: ["00g-admins", "00g-developers"], emails: ["admin.one@example.com"] },
          { external_id: "u-recovery-1", stable_subject: "entra-object-recovery-1", display_name: "Recovery One", active: true, group_external_ids: ["00g-recovery"], emails: ["recovery.one@example.com"] },
          { external_id: "u-former-1", stable_subject: "entra-object-former-1", display_name: "Former Admin", active: false, group_external_ids: ["00g-inactive"], emails: ["former@example.com"] }
        ]
      }
    }
  };
  return makeStaticTenantBootstrapTrustedContext(fixture);
}

type ManifestOverrides = Partial<TenantBootstrapManifest> & {
  readonly qualified_idp?: Partial<TenantBootstrapManifest["qualified_idp"]>;
  readonly directory_connector?: Partial<TenantBootstrapManifest["directory_connector"]>;
  readonly claim_mapping?: Partial<TenantBootstrapManifest["claim_mapping"]>;
};

interface TrustedContextOptions {
  readonly proofTime?: string;
  readonly operator?: TenantBootstrapManifest["operator"];
  readonly manifestDigest?: string;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) return override;
  if (!isRecord(base) || !isRecord(override)) return override ?? base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) merged[key] = deepMerge(merged[key], value);
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
