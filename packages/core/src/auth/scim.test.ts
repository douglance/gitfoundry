import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeD1ScimDirectory, ScimDirectoryDenied, type D1PreparedStatement, type ProvisioningCredentialProof } from "./scim.js";

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:"), readonly options: { readonly failAudit?: boolean } = {}) {}
  prepare(sql: string) {
    const database = this.db;
    const failAudit = this.options.failAudit;
    type SqliteValue = string | number | bigint | null | Uint8Array;
    return {
      sql,
      values: [] as unknown[],
      bind(...values: unknown[]) { return { ...this, values } },
      async first<T>() { return database.prepare(sql).get(...this.values as SqliteValue[]) as T | null },
      async all<T>() { return { results: database.prepare(sql).all(...this.values as SqliteValue[]) as T[] } },
      async run() { if (failAudit && /^INSERT INTO audit\b/.test(sql)) throw new Error("audit unavailable"); const result = database.prepare(sql).run(...this.values as SqliteValue[]); return { success: true, meta: { changes: Number(result.changes) } } }
    };
  }
  async batch(statements: readonly D1PreparedStatement[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const now = new Date("2026-10-10T00:00:00.000Z");
const clock = { now: () => now };
const tenantId = "tenant-a";
const connectionId = "conn-a";
const provisionerId = "principal-provisioner";
const baseUrl = "https://gitfoundry.dev/scim/v2/tenants/tenant-a";
const proof: ProvisioningCredentialProof = { tenantId, connectionId, principalId: provisionerId, credentialId: "cred-provisioner", scopes: ["directory.write"] };
const context = { credential: proof, baseUrl, requestId: "request-a" };

describe("D1 SCIM directory", () => {
  it("creates a pre-provisioned user without enabling login before verified binding", async () => {
    const sql = fixture();
    const scim = makeD1ScimDirectory(sql, { clock });
    const user = await Effect.runPromise(scim.createUser({ context, user: { externalId: "dir-101", userName: "alex@acme.test", displayName: "Alex", name: { givenName: "Alex", familyName: "A" }, emails: [{ value: "alex@acme.test", primary: true }] } }));
    expect(user.id).toMatch(/^dir_user_/);
    expect(user.active).toBe(true);
    expect(sql.db.prepare("SELECT active FROM principals WHERE id = (SELECT principal_id FROM directory_members WHERE id = ?)").get(user.id)).toMatchObject({ active: 0 });
    expect(sql.db.prepare("SELECT verified FROM identity_links WHERE source_id = ?").get("dir-101")).toMatchObject({ verified: 0 });
    await expect(Effect.runPromise(scim.createUser({ context, user: { externalId: "dir-101", userName: "duplicate@acme.test" } }))).rejects.toMatchObject({ status: 409 });
  });

  it("lists and filters tenant users without crossing connections or tenants", async () => {
    const sql = fixture();
    const scim = makeD1ScimDirectory(sql, { clock });
    const user = await Effect.runPromise(scim.createUser({ context, user: { externalId: "dir-101", userName: "alex@acme.test" } }));
    await Effect.runPromise(scim.createUser({ context: { ...context, credential: { ...proof, connectionId: "conn-b" } }, user: { externalId: "dir-101", userName: "alex@other.test" } }));
    const listed = await Effect.runPromise(scim.listUsers({ context, query: { filter: `id eq "${user.id}"` } }));
    expect(listed.totalResults).toBe(1);
    expect(listed.Resources[0]?.userName).toBe("alex@acme.test");
    await expect(Effect.runPromise(scim.listUsers({ context, query: { filter: "emails.value co \"acme\"" } }))).rejects.toMatchObject({ scimType: "invalidFilter" });
  });

  it("deprovisions a verified user by bumping epochs and revoking credentials, then restores without restoring old tokens", async () => {
    const sql = fixture();
    const scim = makeD1ScimDirectory(sql, { clock });
    const user = await Effect.runPromise(scim.createUser({ context, user: { externalId: "dir-101", userName: "alex@acme.test" } }));
    sql.db.prepare("UPDATE identity_links SET verified = 1 WHERE source_id = ?").run("dir-101");
    sql.db.prepare("UPDATE principals SET active = 1 WHERE id = (SELECT principal_id FROM directory_members WHERE id = ?)").run(user.id);
    const principal = sql.db.prepare("SELECT principal_id FROM directory_members WHERE id = ?").get(user.id) as { principal_id: string };
    sql.db.prepare("INSERT INTO credentials(tenant_id,id,version,created_at,updated_at,principal_id,token_hash,scopes_json,expires_at,revoked_at,credential_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(tenantId, "cred-user", 1, now.toISOString(), now.toISOString(), principal.principal_id, "hash", JSON.stringify(["repo.read"]), "2026-10-11T00:00:00.000Z", null, 1);
    sql.db.prepare("INSERT INTO auth_refresh_families(tenant_id,id,version,created_at,updated_at,principal_id,client_id,audience,connection_id,authenticated_at,authentication_expires_at,refresh_expires_at,current_generation,revoked_at,revoked_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(tenantId, "family-a", 1, now.toISOString(), now.toISOString(), principal.principal_id, "client", "aud", connectionId, now.toISOString(), "2026-10-11T00:00:00.000Z", "2026-10-12T00:00:00.000Z", 0, null, null);
    const deprovisioned = await Effect.runPromise(scim.patchUser({ context, id: user.id, ifMatch: user.meta.version, operations: [{ op: "replace", path: "active", value: false }] }));
    expect(deprovisioned.active).toBe(false);
    expect(sql.db.prepare("SELECT active, auth_epoch FROM principals WHERE id = ?").get(principal.principal_id)).toMatchObject({ active: 0, auth_epoch: 2 });
    expect(sql.db.prepare("SELECT revoked_at FROM credentials WHERE id = 'cred-user'").get()).toMatchObject({ revoked_at: now.toISOString() });
    expect(sql.db.prepare("SELECT revoked_at FROM auth_refresh_families WHERE id = 'family-a'").get()).toMatchObject({ revoked_at: now.toISOString() });
    const restored = await Effect.runPromise(scim.patchUser({ context, id: user.id, operations: [{ op: "replace", path: "active", value: true }] }));
    expect(restored.active).toBe(true);
    expect(sql.db.prepare("SELECT active, auth_epoch FROM principals WHERE id = ?").get(principal.principal_id)).toMatchObject({ active: 1, auth_epoch: 3 });
    expect(sql.db.prepare("SELECT revoked_at FROM auth_refresh_families WHERE id = 'family-a'").get()).toMatchObject({ revoked_at: now.toISOString() });
    expect(sql.db.prepare("SELECT revoked_at FROM credentials WHERE id = 'cred-user'").get()).toMatchObject({ revoked_at: now.toISOString() });
  });

  it("rejects stale user versions before writes", async () => {
    const sql = fixture();
    const scim = makeD1ScimDirectory(sql, { clock });
    const user = await Effect.runPromise(scim.createUser({ context, user: { externalId: "dir-101", userName: "alex@acme.test" } }));
    await expect(Effect.runPromise(scim.replaceUser({ context, id: user.id, ifMatch: "W/\"99\"", user: { externalId: "dir-101", userName: "new@acme.test", active: true } }))).rejects.toMatchObject({ status: 412 });
    expect(sql.db.prepare("SELECT user_name FROM scim_directory_profiles WHERE external_id = 'dir-101'").get()).toMatchObject({ user_name: "alex@acme.test" });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM audit WHERE operation = 'identity.scim.user.replace'").get()).toMatchObject({ count: 0 });
  });

  it("keeps group membership atomic and bumps tenant policy epoch", async () => {
    const sql = fixture();
    const scim = makeD1ScimDirectory(sql, { clock });
    const alex = await Effect.runPromise(scim.createUser({ context, user: { externalId: "dir-101", userName: "alex@acme.test" } }));
    await expect(Effect.runPromise(scim.createGroup({ context, group: { externalId: "grp-builders", displayName: "Builders", members: [{ value: "missing" }] } }))).rejects.toBeInstanceOf(ScimDirectoryDenied);
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM groups WHERE external_id = 'grp-builders'").get()).toMatchObject({ count: 0 });
    const group = await Effect.runPromise(scim.createGroup({ context, group: { externalId: "grp-builders", displayName: "Builders", members: [{ value: alex.id }] } }));
    expect(group.members).toHaveLength(1);
    await Effect.runPromise(scim.patchGroup({ context, id: group.id, operations: [{ op: "remove", path: `members[value eq "${alex.id}"]` }] }));
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM group_memberships WHERE group_id = ?").get(group.id)).toMatchObject({ count: 0 });
    expect(sql.db.prepare("SELECT policy_epoch FROM tenants WHERE id = ?").get(tenantId)).toMatchObject({ policy_epoch: 3 });
  });

  it("requires an explicit connection-scoped provisioning credential", async () => {
    const sql = fixture();
    const scim = makeD1ScimDirectory(sql, { clock });
    await expect(Effect.runPromise(scim.createUser({ context: { ...context, credential: { ...proof, scopes: [] } }, user: { externalId: "dir-101", userName: "alex@acme.test" } }))).rejects.toMatchObject({ status: 403 });
    sql.db.prepare("UPDATE credentials SET revoked_at = ? WHERE id = ?").run(now.toISOString(), "cred-provisioner");
    await expect(Effect.runPromise(scim.createUser({ context, user: { externalId: "dir-101", userName: "alex@acme.test" } }))).rejects.toMatchObject({ status: 403 });
  });
});

function fixture(): SqliteD1 {
  const sql = new SqliteD1();
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0001_handbook.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0010_auth_sessions.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0011_auth_directory_scim.sql", import.meta.url), "utf8"));
  const timestamp = now.toISOString();
  sql.db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run(tenantId, tenantId, "active", 1, "shard-a", "US", "{}");
  sql.db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run("tenant-b", "tenant-b", "active", 1, "shard-b", "US", "{}");
  for (const connection of [connectionId, "conn-b"]) sql.db.prepare("INSERT INTO connections(tenant_id,id,version,created_at,updated_at,issuer,external_tenant_id,audience,claims_json,active) VALUES(?,?,?,?,?,?,?,?,?,?)").run(tenantId, connection, 1, timestamp, timestamp, "https://issuer.example", connection, "aud", JSON.stringify({ identity_qualified: true, immutable_subject_claim: "directory_subject" }), 1);
  sql.db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run(tenantId, provisionerId, 1, timestamp, timestamp, "service", "SCIM provisioner", 1, 1);
  sql.db.prepare("INSERT INTO credentials(tenant_id,id,version,created_at,updated_at,principal_id,token_hash,scopes_json,expires_at,revoked_at,credential_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(tenantId, "cred-provisioner", 1, timestamp, timestamp, provisionerId, "hash-provisioner", JSON.stringify(["directory.write"]), "2026-10-11T00:00:00.000Z", null, 1);
  return sql;
}
