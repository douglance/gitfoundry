import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { UnauthorizedError } from "../index.js";
import { makeD1ResourceAuthorizer, type D1DatabaseLike, type ResourceRef, type ResourceVerifiedIdentity } from "./resource-authorizer.js";

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:"), readonly afterAll?: (sql: string) => void) {}
  prepare(sql: string) {
    const database = this.db;
    const afterAll = this.afterAll;
    type SqliteValue = string | number | bigint | null | Uint8Array;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) { return { ...this, values } },
      async first<T>() { return database.prepare(sql).get(...this.values as SqliteValue[]) as T | null },
      async all<T>() {
        const results = database.prepare(sql).all(...this.values as SqliteValue[]) as T[];
        afterAll?.(sql);
        return { results };
      },
      async run() { const result = database.prepare(sql).run(...this.values as SqliteValue[]); return { success: true, meta: { changes: Number(result.changes) } } }
    };
  }
}

const now = new Date("2026-10-08T00:00:00.000Z");
const clock = { now: () => now };
const humanIdentity: ResourceVerifiedIdentity = { tenant_id: "tenant-a", principal_id: "principal-a", kind: "human", grant_ref: "unused", policy_epoch: 1, auth_epoch: 1 };
const serviceIdentity: ResourceVerifiedIdentity = { tenant_id: "tenant-a", principal_id: "service-a", kind: "service", grant_ref: "unused", policy_epoch: 1, auth_epoch: 1 };

function repo(id: string, tenantId = "tenant-a"): ResourceRef { return { kind: "repository", tenant_id: tenantId, id } }
function env(id: string, tenantId = "tenant-a"): ResourceRef { return { kind: "environment", tenant_id: tenantId, id } }

function authorize(sql: D1DatabaseLike, identity: ResourceVerifiedIdentity, capability: string, resource: ResourceRef, extra: Partial<Parameters<ReturnType<typeof makeD1ResourceAuthorizer>["authorize"]>[0]> = {}) {
  return Effect.runPromise(makeD1ResourceAuthorizer(sql, clock).authorize({ identity, capability, resource, ...extra }));
}

describe("D1 resource authorizer", () => {
  it("allows the same actor on repo-a and denies repo-b without a matching resource grant", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-repo-a", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a" });

    await expect(authorize(sql, humanIdentity, "repo.read", repo("repo-a"))).resolves.toMatchObject({ grant_ref: "grant-repo-a" });
    await expect(authorize(sql, humanIdentity, "repo.read", repo("repo-b"))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("supports explicit tenant-wide grants without letting a repo grant become tenant-wide", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-tenant", roleId: "role-read", resourceKind: "tenant", resourceId: "tenant-a" });
    insertGrant(sql, { id: "grant-repo-a", roleId: "role-write", resourceKind: "repository", resourceId: "repo-a" });

    await expect(authorize(sql, humanIdentity, "repo.read", repo("repo-a"))).resolves.toMatchObject({ grant_ref: "grant-tenant" });
    await expect(authorize(sql, humanIdentity, "repo.read", repo("repo-b"))).resolves.toMatchObject({ grant_ref: "grant-tenant" });
    await expect(authorize(sql, humanIdentity, "repo.write", repo("repo-b"))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("denies expired grants", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-expired", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a", expiresAt: "2026-10-07T00:00:00.000Z" });
    await expect(authorize(sql, humanIdentity, "repo.read", repo("repo-a"))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("denies inactive groups, removed groups, and inactive directory membership", async () => {
    const inactiveGroup = fixture();
    insertGrant(inactiveGroup, { id: "grant-group", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a" });
    inactiveGroup.db.prepare("UPDATE groups SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'group-a'").run();
    await expect(authorize(inactiveGroup, humanIdentity, "repo.read", repo("repo-a"))).rejects.toBeInstanceOf(UnauthorizedError);

    const removedMember = fixture();
    insertGrant(removedMember, { id: "grant-group", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a" });
    removedMember.db.prepare("DELETE FROM group_memberships WHERE tenant_id = 'tenant-a' AND group_id = 'group-a' AND principal_id = 'principal-a'").run();
    await expect(authorize(removedMember, humanIdentity, "repo.read", repo("repo-a"))).rejects.toBeInstanceOf(UnauthorizedError);

    const inactiveDirectory = fixture();
    insertGrant(inactiveDirectory, { id: "grant-group", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a" });
    inactiveDirectory.db.prepare("UPDATE directory_members SET active = 0 WHERE tenant_id = 'tenant-a' AND principal_id = 'principal-a'").run();
    await expect(authorize(inactiveDirectory, humanIdentity, "repo.read", repo("repo-a"))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("denies stale principal auth and tenant policy epochs", async () => {
    const authChanged = fixture();
    insertGrant(authChanged, { id: "grant-repo-a", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a" });
    authChanged.db.prepare("UPDATE principals SET auth_epoch = 2 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'").run();
    await expect(authorize(authChanged, humanIdentity, "repo.read", repo("repo-a"), { expected_auth_epoch: 1 })).rejects.toBeInstanceOf(UnauthorizedError);

    const policyChanged = fixture();
    insertGrant(policyChanged, { id: "grant-repo-a", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a" });
    policyChanged.db.prepare("UPDATE tenants SET policy_epoch = 2 WHERE id = 'tenant-a'").run();
    await expect(authorize(policyChanged, humanIdentity, "repo.read", repo("repo-a"), { expected_policy_epoch: 1 })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rechecks tenant and principal admission immediately before returning", async () => {
    let revoked = false;
    const sql = fixture({
      afterAll(query) {
        if (!revoked && query.includes("FROM grants g JOIN roles")) {
          revoked = true;
          sql.db.prepare("UPDATE principals SET auth_epoch = 2 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'").run();
          sql.db.prepare("UPDATE directory_members SET active = 0 WHERE tenant_id = 'tenant-a' AND principal_id = 'principal-a'").run();
          sql.db.prepare("UPDATE tenants SET policy_epoch = 2 WHERE id = 'tenant-a'").run();
        }
      }
    });
    insertGrant(sql, { id: "grant-repo-a", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a" });

    await expect(authorize(sql, humanIdentity, "repo.read", repo("repo-a"))).rejects.toBeInstanceOf(UnauthorizedError);
    expect(revoked).toBe(true);
  });

  it("redacts raw D1 exception details from authorization failures", async () => {
    const leakingD1: D1DatabaseLike = {
      prepare: () => ({
        bind() { return this; },
        async first() { throw new Error("SQLITE_D1_RAW secret=tenant-a.token table=principals"); },
        async all() { throw new Error("SQLITE_D1_RAW secret=tenant-a.token table=grants"); },
        async run() { throw new Error("SQLITE_D1_RAW secret=tenant-a.token table=credentials"); }
      })
    };

    const error = await makeD1ResourceAuthorizer(leakingD1, clock).authorize({ identity: humanIdentity, capability: "repo.read", resource: repo("repo-a") }).pipe(Effect.flip, Effect.runPromise);
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error.reason).toBe("resource authorization failed");
    expect(JSON.stringify(error)).not.toContain("secret=tenant-a.token");
  });

  it("denies cross-tenant repository lookup", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-tenant", roleId: "role-read", resourceKind: "tenant", resourceId: "tenant-a" });
    await expect(authorize(sql, humanIdentity, "repo.read", repo("repo-x", "tenant-b"))).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(authorize(sql, { ...humanIdentity, tenant_id: "tenant-b" }, "repo.read", repo("repo-a", "tenant-b"))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("intersects credential scopes and resource filters with grants", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-tenant-write", roleId: "role-write", resourceKind: "tenant", resourceId: "tenant-a" });

    await expect(authorize(sql, humanIdentity, "repo.write", repo("repo-a"), { credential: { scopes: ["repo.read"], resources: [repo("repo-a")] } })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(authorize(sql, humanIdentity, "repo.write", repo("repo-a"), { credential: { scopes: ["repo.write"], resources: [repo("repo-a")] } })).resolves.toMatchObject({ grant_ref: "grant-tenant-write" });
    await expect(authorize(sql, humanIdentity, "repo.write", repo("repo-b"), { credential: { scopes: ["repo.write"], resources: [repo("repo-a")] } })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("checks persisted credential scopes and expiry", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-repo-a", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a" });
    insertGrant(sql, { id: "grant-write-a", roleId: "role-write", resourceKind: "repository", resourceId: "repo-a" });
    insertCredential(sql, { id: "cred-read", scopes: ["repo.read"], expiresAt: "2026-10-09T00:00:00.000Z" });
    insertCredential(sql, { id: "cred-write", scopes: ["repo.write"], expiresAt: "2026-10-09T00:00:00.000Z" });
    insertCredential(sql, { id: "cred-expired", scopes: ["repo.read"], expiresAt: "2026-10-07T00:00:00.000Z" });

    await expect(authorize(sql, humanIdentity, "repo.read", repo("repo-a"), { credential: { credential_id: "cred-read" } })).resolves.toMatchObject({ metadata: { credential_id: "cred-read" } });
    await expect(authorize(sql, humanIdentity, "repo.write", repo("repo-a"), { credential: { credential_id: "cred-write", scopes: ["repo.read"] } })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(authorize(sql, humanIdentity, "repo.read", repo("repo-a"), { credential: { credential_id: "cred-expired" } })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("requires recovery human grants to carry an expiry", async () => {
    const missingExpiry = fixture();
    missingExpiry.db.exec("PRAGMA ignore_check_constraints = ON");
    insertGrant(missingExpiry, { id: "grant-recovery-open", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a", subjectKind: "recovery_human", subjectId: "principal-a" });
    missingExpiry.db.exec("PRAGMA ignore_check_constraints = OFF");
    await expect(authorize(missingExpiry, humanIdentity, "repo.read", repo("repo-a"))).rejects.toBeInstanceOf(UnauthorizedError);

    const expiring = fixture();
    insertGrant(expiring, { id: "grant-recovery-expiring", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a", subjectKind: "recovery_human", subjectId: "principal-a", expiresAt: "2026-10-09T00:00:00.000Z" });
    await expect(authorize(expiring, humanIdentity, "repo.read", repo("repo-a"))).resolves.toMatchObject({ grant_ref: "grant-recovery-expiring" });
  });

  it("allows scoped service grants only on the named resource", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-service-repo-a", roleId: "role-write", resourceKind: "repository", resourceId: "repo-a", subjectKind: "service", subjectId: "service-a" });

    await expect(authorize(sql, serviceIdentity, "repo.write", repo("repo-a"))).resolves.toMatchObject({ grant_ref: "grant-service-repo-a" });
    await expect(authorize(sql, serviceIdentity, "repo.write", repo("repo-b"))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("does not grant capabilities to historical identities", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-historical", roleId: "role-read", resourceKind: "repository", resourceId: "repo-a", subjectKind: "tenant_role", subjectId: "historical-a" });
    const historical: ResourceVerifiedIdentity = { tenant_id: "tenant-a", principal_id: "historical-a", kind: "historical", grant_ref: "unused", policy_epoch: 1, auth_epoch: 1 };

    await expect(authorize(sql, historical, "repo.read", repo("repo-a"))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("inherits repository grants to resolved environments through actual ownership", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-repo-deploy", roleId: "role-deploy", resourceKind: "repository", resourceId: "repo-a" });

    await expect(authorize(sql, humanIdentity, "environment.deploy", env("env-a"))).resolves.toMatchObject({ grant_ref: "grant-repo-deploy" });
    await expect(authorize(sql, humanIdentity, "environment.deploy", env("env-b"))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("fails closed for runner pools until the schema has a resolvable runner pool table", async () => {
    const sql = fixture();
    insertGrant(sql, { id: "grant-runner", roleId: "role-runner", resourceKind: "tenant", resourceId: "tenant-a" });
    await expect(authorize(sql, humanIdentity, "runner.pool.manage", { kind: "runner_pool", tenant_id: "tenant-a", id: "pool-a" })).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

function fixture(options: { readonly afterAll?: (sql: string) => void } = {}): SqliteD1 {
  const sql = new SqliteD1(new DatabaseSync(":memory:"), options.afterAll);
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0001_handbook.sql", import.meta.url), "utf8"));
  seed(sql.db);
  return sql;
}

function seed(db: DatabaseSync) {
  const timestamp = now.toISOString();
  const qualifiedClaims = JSON.stringify({ identity_qualified: true, immutable_subject_claim: "directory_subject" });
  db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 1, "shard-a", "US", "{}");
  db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run("tenant-b", "tenant-b", "active", 1, "shard-b", "US", "{}");
  db.prepare("INSERT INTO connections(tenant_id,id,version,created_at,updated_at,issuer,external_tenant_id,audience,claims_json,active) VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "conn-a", 1, timestamp, timestamp, "https://issuer.example", "access", "public-audience", qualifiedClaims, 1);
  db.prepare("INSERT INTO connections(tenant_id,id,version,created_at,updated_at,issuer,external_tenant_id,audience,claims_json,active) VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-b", "conn-b", 1, timestamp, timestamp, "https://issuer.example", "access", "public-audience", qualifiedClaims, 1);
  insertPrincipal(db, "tenant-a", "principal-a", "human", "Principal A", 1);
  insertPrincipal(db, "tenant-a", "service-a", "service", "Service A", 1);
  insertPrincipal(db, "tenant-a", "historical-a", "historical", "Historical A", 0);
  insertPrincipal(db, "tenant-b", "principal-b", "human", "Principal B", 1);
  insertDirectory(db, "tenant-a", "conn-a", "principal-a", "dir-a");
  insertDirectory(db, "tenant-b", "conn-b", "principal-b", "dir-b");
  db.prepare("INSERT INTO groups(tenant_id,id,version,created_at,updated_at,connection_id,external_id,name,active) VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "group-a", 1, timestamp, timestamp, "conn-a", "group-a", "Group A", 1);
  db.prepare("INSERT INTO group_memberships(tenant_id,group_id,principal_id,directory_version) VALUES(?,?,?,?)").run("tenant-a", "group-a", "principal-a", 1);
  insertRole(db, "role-read", ["repo.read"]);
  insertRole(db, "role-write", ["repo.write"]);
  insertRole(db, "role-deploy", ["environment.deploy"]);
  insertRole(db, "role-runner", ["runner.pool.manage"]);
  db.prepare("INSERT INTO organization_namespaces(tenant_id,id,version,created_at,updated_at,name,description) VALUES(?,?,?,?,?,?,?)").run("tenant-a", "namespace-a", 1, timestamp, timestamp, "namespace-a", "Namespace A");
  db.prepare("INSERT INTO organization_namespaces(tenant_id,id,version,created_at,updated_at,name,description) VALUES(?,?,?,?,?,?,?)").run("tenant-b", "namespace-b", 1, timestamp, timestamp, "namespace-b", "Namespace B");
  insertRepository(db, "tenant-a", "namespace-a", "repo-a", "repo-a");
  insertRepository(db, "tenant-a", "namespace-a", "repo-b", "repo-b");
  insertRepository(db, "tenant-b", "namespace-b", "repo-x", "repo-x");
  db.prepare("INSERT INTO environments(tenant_id,id,version,created_at,updated_at,repository_id,name,policy_json) VALUES(?,?,?,?,?,?,?,?)").run("tenant-a", "env-a", 1, timestamp, timestamp, "repo-a", "production", "{}");
  db.prepare("INSERT INTO environments(tenant_id,id,version,created_at,updated_at,repository_id,name,policy_json) VALUES(?,?,?,?,?,?,?,?)").run("tenant-a", "env-b", 1, timestamp, timestamp, "repo-b", "production", "{}");
}

function insertPrincipal(db: DatabaseSync, tenantId: string, id: string, kind: string, displayName: string, active: number) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run(tenantId, id, 1, timestamp, timestamp, kind, displayName, active, 1);
}

function insertDirectory(db: DatabaseSync, tenantId: string, connectionId: string, principalId: string, externalId: string) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO directory_members(tenant_id,id,version,created_at,updated_at,connection_id,external_id,principal_id,active,emails_json) VALUES(?,?,?,?,?,?,?,?,?,?)").run(tenantId, `dm-${principalId}`, 1, timestamp, timestamp, connectionId, externalId, principalId, 1, "[]");
  db.prepare("INSERT INTO identity_links(tenant_id,id,version,created_at,updated_at,principal_id,connection_id,issuer,stable_subject,source_kind,source_id,verified) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(tenantId, `link-${principalId}`, 1, timestamp, timestamp, principalId, connectionId, "https://issuer.example", externalId, "directory", externalId, 1);
}

function insertRole(db: DatabaseSync, id: string, capabilities: readonly string[]) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO roles(tenant_id,id,version,created_at,updated_at,name,capabilities_json) VALUES(?,?,?,?,?,?,?)").run("tenant-a", id, 1, timestamp, timestamp, id, JSON.stringify(capabilities));
}

function insertRepository(db: DatabaseSync, tenantId: string, namespaceId: string, id: string, name: string) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(tenantId, id, 1, timestamp, timestamp, namespaceId, name, "private", "main", 0, tenantId, id, null);
}

function insertGrant(sql: SqliteD1, input: { readonly id: string; readonly roleId: string; readonly resourceKind: string; readonly resourceId: string; readonly subjectKind?: string; readonly subjectId?: string; readonly expiresAt?: string | null }) {
  const timestamp = now.toISOString();
  sql.db.prepare("INSERT INTO grants(tenant_id,id,version,created_at,updated_at,subject_kind,subject_id,resource_kind,resource_id,role_id,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", input.id, 1, timestamp, timestamp, input.subjectKind ?? "group", input.subjectId ?? "group-a", input.resourceKind, input.resourceId, input.roleId, input.expiresAt ?? null);
}

function insertCredential(sql: SqliteD1, input: { readonly id: string; readonly scopes: readonly string[]; readonly expiresAt: string }) {
  const timestamp = now.toISOString();
  sql.db.prepare("INSERT INTO credentials(tenant_id,id,version,created_at,updated_at,principal_id,token_hash,scopes_json,expires_at,revoked_at,credential_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", input.id, 1, timestamp, timestamp, "principal-a", `hash-${input.id}`, JSON.stringify(input.scopes), input.expiresAt, null, 1);
}
