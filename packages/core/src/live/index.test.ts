import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { IdempotencyConflictError, InvalidStateTransitionError, NotFoundError, RepositoryNameConflictError, RepositoryStoreUnavailableError, StalePreconditionError, UnsupportedOperationError, type Actor, type OperationRecord } from "../index.js";
import {
  GitProvisionerUnavailableError,
  makeD1IdempotencyStore,
  makeD1IdentityPort,
  makeD1NamespaceStore,
  makeD1RepositoryStore,
  makeD1TenantAuthorizer
} from "./index.js";

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  prepare(sql: string) {
    const database = this.db;
    return {
      values: [] as any[],
      bind(...values: unknown[]) { return { ...this, values } },
      async first<T>() { return database.prepare(sql).get(...this.values) as T | null },
      async all<T>() { return { results: database.prepare(sql).all(...this.values) as T[] } },
      async run() { database.prepare(sql).run(...this.values); return { success: true } }
    };
  }
}

class FailingRepositoryUpdateD1 extends SqliteD1 {
  constructor(db: DatabaseSync, private readonly secret: string) {
    super(db);
  }

  override prepare(sql: string) {
    const prepared = super.prepare(sql);
    if (!sql.startsWith("UPDATE repositories")) return prepared;
    const secret = this.secret;
    return {
      ...prepared,
      bind: (...values: unknown[]) => {
        const bound = prepared.bind(...values);
        return {
          ...bound,
          async first<T>() {
            throw new Error(`D1 failed with ${secret}`);
          }
        };
      }
    };
  }
}

class RacingRepositoryNameD1 extends SqliteD1 {
  private inserted = false;

  constructor(db: DatabaseSync) {
    super(db);
  }

  override prepare(sql: string) {
    const prepared = super.prepare(sql);
    if (!sql.startsWith("UPDATE repositories")) return prepared;
    const insertConflict = () => {
      if (this.inserted) return;
      this.inserted = true;
      this.db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name) VALUES('tenant-a','repo-race',1,?,?,?,?,?,?,0,'tenant-a','repo-race')").run(now.toISOString(), now.toISOString(), "namespace-a", "raced", "internal", "main");
    };
    return {
      ...prepared,
      bind: (...values: unknown[]) => {
        const bound = prepared.bind(...values);
        return {
          ...bound,
          async first<T>() {
            insertConflict();
            return bound.first<T>();
          }
        };
      }
    };
  }
}

const now = new Date("2026-10-08T00:00:00Z");
const clock = { now: () => now };
const actor: Actor = { id: "principal-a", tenantId: "tenant-a", revoked: false, capabilities: [] };

describe("D1-backed live ports", () => {
  it("resolves a verified Access identity and revalidates current tenant-wide grants", async () => {
    const sql = fixture(["repository.read"]);
    const identity = makeD1IdentityPort(sql, clock);
    await expect(Effect.runPromise(identity.resolveAccessPrincipal({ issuer: "https://issuer.example", audience: "public-audience", claims: qualifiedClaims(), requestedTenantId: "tenant-a" }))).resolves.toEqual({ tenantId: "tenant-a", principalId: "principal-a", kind: "human", policyEpoch: 1 });
    await expect(Effect.runPromise(identity.verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.read", policyEpoch: 1 }))).resolves.toMatchObject({ grant_ref: "grant-a" });
    await expect(Effect.runPromise(identity.verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.write", policyEpoch: 1 }))).rejects.toThrow();
    sql.db.prepare("UPDATE tenants SET policy_epoch = 2 WHERE id = 'tenant-a'").run();
    await expect(Effect.runPromise(identity.verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.read", policyEpoch: 1 }))).rejects.toThrow();
  });

  it.each([
    [null, true],
    ["2026-10-08T00:00:00Z", false],
    ["2026-10-08T00:00:00.000Z", false],
    ["2026-10-08T00:00:00.001Z", true],
    ["2026-10-08T01:00:00+02:00", false],
    ["2026-10-08T02:00:00+02:00", false],
    ["2026-10-07T23:30:00-02:00", true],
    ["", false],
    ["not-a-timestamp", false],
    ["2099", false],
    ["2099-02-29T00:00:00Z", false],
    ["2099-02-30T00:00:00Z", false],
    ["2099-01-01T24:00:00Z", false]
  ] as const)("compares grant expiry %s as a validated instant in authorization and scopes", async (expiresAt, live) => {
    const sql = fixture(["repository.read"]);
    sql.db.prepare("UPDATE grants SET expires_at = ? WHERE tenant_id = 'tenant-a' AND id = 'grant-a'").run(expiresAt);
    const identity = makeD1IdentityPort(sql, clock);
    const verified = Effect.runPromise(identity.verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.read", policyEpoch: 1 }));
    if (live) await expect(verified).resolves.toMatchObject({ grant_ref: "grant-a" });
    else await expect(verified).rejects.toThrow();
    await expect(Effect.runPromise(identity.describePrincipal({ tenantId: "tenant-a", principalId: "principal-a", policyEpoch: 1 }))).resolves.toMatchObject({ scopes: live ? ["repository.read"] : [] });
  });

  it("fails closed when the grant clock is invalid", async () => {
    const identity = makeD1IdentityPort(fixture(["repository.read"]), { now: () => new Date(NaN) });
    await expect(Effect.runPromise(identity.verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.read", policyEpoch: 1 }))).rejects.toThrow();
    await expect(Effect.runPromise(identity.describePrincipal({ tenantId: "tenant-a", principalId: "principal-a", policyEpoch: 1 }))).rejects.toThrow();
  });

  it("uses the qualified immutable provider subject instead of Access sub or email", async () => {
    const sql = fixture(["identity.read"]);
    const timestamp = now.toISOString();
    sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-c", 1, timestamp, timestamp, "human", "Principal C", 1, 1);
    sql.db.prepare("INSERT INTO identity_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "link-c", 1, timestamp, timestamp, "principal-c", "conn-a", "https://issuer.example", "directory-subject-c", "directory", "directory-user-c", 1);
    sql.db.prepare("INSERT INTO directory_members VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "member-c", 1, timestamp, timestamp, "conn-a", "directory-user-c", "principal-c", 1, "[]");
    const resolved = await Effect.runPromise(makeD1IdentityPort(sql, clock).resolveAccessPrincipal({ issuer: "https://issuer.example", audience: "public-audience", requestedTenantId: "tenant-a", claims: qualifiedClaims({ sub: "same-cloudflare-sub", email: "principal-a@example.test", directory_subject: "directory-subject-c" }) }));
    expect(resolved.principalId).toBe("principal-c");
  });

  it("fails closed without the approved qualified claim mapping", async () => {
    const sql = fixture(["repository.read"]);
    const identity = makeD1IdentityPort(sql, clock);
    await expect(Effect.runPromise(identity.resolveAccessPrincipal({ issuer: "https://issuer.example", audience: "public-audience", claims: qualifiedClaims({ gfy_connection_id: "wrong-marker" }), requestedTenantId: "tenant-a" }))).rejects.toThrow();
    await expect(Effect.runPromise(identity.resolveAccessPrincipal({ issuer: "https://issuer.example", audience: "public-audience", claims: qualifiedClaims({ directory_subject: undefined }), requestedTenantId: "tenant-a" }))).rejects.toThrow();
    sql.db.prepare("UPDATE connections SET claims_json = '{}' WHERE tenant_id = 'tenant-a' AND id = 'conn-a'").run();
    await expect(Effect.runPromise(identity.resolveAccessPrincipal({ issuer: "https://issuer.example", audience: "public-audience", claims: qualifiedClaims(), requestedTenantId: "tenant-a" }))).rejects.toThrow();
  });

  it("denies grants after the qualified directory binding is disabled", async () => {
    const sql = fixture(["repository.read"]);
    const identity = makeD1IdentityPort(sql, clock);
    await expect(Effect.runPromise(identity.verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.read", policyEpoch: 1 }))).resolves.toMatchObject({ grant_ref: "grant-a" });
    sql.db.prepare("UPDATE connections SET claims_json = '{}' WHERE tenant_id = 'tenant-a' AND id = 'conn-a'").run();
    await expect(Effect.runPromise(identity.verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.read", policyEpoch: 1 }))).rejects.toThrow();
  });

  it("rejects scoped grants until resource-aware authorization exists", async () => {
    const sql = fixture(["repository.read"]);
    sql.db.prepare("UPDATE grants SET resource_kind = 'repository', resource_id = 'repo-a' WHERE id = 'grant-a'").run();
    await expect(Effect.runPromise(makeD1IdentityPort(sql, clock).verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.read", policyEpoch: 1 }))).rejects.toThrow();
  });

  it("requires active groups before group grants authorize", async () => {
    const sql = fixture([]);
    seedGroupGrant(sql.db, 0);
    const identity = makeD1IdentityPort(sql, clock);
    await expect(Effect.runPromise(identity.verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.read", policyEpoch: 1 }))).rejects.toThrow();
    sql.db.prepare("UPDATE groups SET active = 1 WHERE tenant_id = 'tenant-a' AND id = 'group-a'").run();
    await expect(Effect.runPromise(identity.verifyGrant({ tenantId: "tenant-a", principalId: "principal-a", capability: "repository.read", policyEpoch: 1 }))).resolves.toMatchObject({ grant_ref: "grant-group" });
  });

  it("live authorizer rejects crossed or revoked actors before grant lookup", async () => {
    const authorizer = makeD1TenantAuthorizer(makeD1IdentityPort(fixture(["repository.read"]), clock));
    await expect(Effect.runPromise(authorizer.authorize(actor, "tenant-a", "repository.read"))).resolves.toBeUndefined();
    await expect(Effect.runPromise(authorizer.authorize({ ...actor, tenantId: "tenant-b" }, "tenant-a", "repository.read"))).rejects.toThrow();
    await expect(Effect.runPromise(authorizer.authorize({ ...actor, revoked: true }, "tenant-a", "repository.read"))).rejects.toThrow();
  });

  it("looks up namespace ownership fresh and maps repository rows", async () => {
    const sql = fixture(["repository.read"]);
    await expect(Effect.runPromise(makeD1NamespaceStore(sql).get("tenant-a", "namespace-a"))).resolves.toEqual({ tenant_id: "tenant-a", id: "namespace-a" });
    await expect(Effect.runPromise(makeD1NamespaceStore(sql).get("tenant-b", "namespace-a"))).rejects.toBeInstanceOf(NotFoundError);
    const listed = await Effect.runPromise(makeD1RepositoryStore(sql, { gitUrlBase: "https://gitfoundry.example/git" }).list("tenant-a"));
    expect(listed[0]).toMatchObject({ tenant_id: "tenant-a", id: "repo-a", git_url: "https://gitfoundry.example/git/tenant-a/repo-a.git" });
  });

  it("keeps repository creation unavailable without a real Git provisioner", async () => {
    await expect(Effect.runPromise(makeD1RepositoryStore(fixture(["repository.write"]), { clock }).create("tenant-a", { namespace_id: "namespace-a", name: "new-repo" }))).rejects.toBeInstanceOf(GitProvisionerUnavailableError);
  });


  it("persists the provider physical identity so readback retains the same Git gateway URL", async () => {
    const sql = fixture(["repository.write"]);
    const store = makeD1RepositoryStore(sql, {
      clock, gitUrlBase: "https://gitfoundry.example/git",
      gitProvisioner: { provisionRepository: () => Effect.succeed({
        gitUrl: "https://gitfoundry.example/git/provider-space/physical.repo.git",
        artifactsNamespace: "provider-space", artifactsName: "physical.repo"
      }) }
    });
    const created = await Effect.runPromise(store.create("tenant-a", { namespace_id: "namespace-a", name: "new-repo" }));
    expect(created.git_url).toBe("https://gitfoundry.example/git/provider-space/physical.repo.git");
    expect(sql.db.prepare("SELECT artifacts_namespace,artifacts_name FROM repositories WHERE id=?").get(created.id)).toMatchObject({
      artifacts_namespace: "provider-space", artifacts_name: "physical.repo"
    });
    expect((await Effect.runPromise(store.get("tenant-a", created.id))).git_url).toBe("https://gitfoundry.example/git/provider-space/physical.repo.git");
  });

  it("does not collapse distinct namespace/name tuples into the same repository id", async () => {
    const sql = fixture(["repository.write"]);
    const store = makeD1RepositoryStore(sql, {
      clock, gitUrlBase: "https://gitfoundry.example/git",
      gitProvisioner: { provisionRepository: (input) => Effect.succeed({
        gitUrl: `https://gitfoundry.example/git/provider-space/${input.namespaceId}.git`,
        artifactsNamespace: "provider-space", artifactsName: input.namespaceId
      }) }
    });
    const first = await Effect.runPromise(store.create("tenant-a", { namespace_id: "namespace-a", name: "b" }));
    const second = await Effect.runPromise(store.create("tenant-a", { namespace_id: "namespace", name: "a-b" }));
    expect(first.id).not.toBe(second.id);
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM repositories WHERE name IN ('b','a-b')").get()?.count).toBe(2);
  });

  it("updates repository metadata with CAS and keeps provider Git identity immutable", async () => {
    const sql = fixture(["repository.write"]);
    const store = makeD1RepositoryStore(sql, { clock, gitUrlBase: "https://gitfoundry.example/git" });

    const edited = await Effect.runPromise(store.update("tenant-a", "repo-a", 1, { name: "renamed", visibility: "internal", default_branch: "trunk" }));
    expect(edited).toMatchObject({ id: "repo-a", version: 2, name: "renamed", visibility: "internal", default_branch: "trunk", git_url: "https://gitfoundry.example/git/tenant-a/repo-a.git" });
    expect(sql.db.prepare("SELECT artifacts_namespace,artifacts_name FROM repositories WHERE id='repo-a'").get()).toMatchObject({ artifacts_namespace: "tenant-a", artifacts_name: "repo-a" });

    await expect(Effect.runPromise(store.update("tenant-a", "repo-a", 1, { visibility: "public" }))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(store.update("tenant-b", "repo-a", 2, { visibility: "public" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(Effect.runPromise(store.update("tenant-a", "repo-a", 2, { description: "not yet stored" }))).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("rejects duplicate repository names without mutating version or provider mapping", async () => {
    const sql = fixture(["repository.admin"]);
    sql.db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name) VALUES('tenant-a','repo-b',1,?,?,?,?,?,?,0,'tenant-a','repo-b')").run(now.toISOString(), now.toISOString(), "namespace-a", "taken", "internal", "main");
    const store = makeD1RepositoryStore(sql, { clock, gitUrlBase: "https://gitfoundry.example/git" });

    await expect(Effect.runPromise(store.update("tenant-a", "repo-a", 1, { name: "taken" }))).rejects.toBeInstanceOf(RepositoryNameConflictError);

    expect(sql.db.prepare("SELECT version,name,artifacts_namespace,artifacts_name FROM repositories WHERE tenant_id='tenant-a' AND id='repo-a'").get()).toMatchObject({ version: 1, name: "demo", artifacts_namespace: "tenant-a", artifacts_name: "repo-a" });
  });

  it("maps repository name collisions that race after preflight to typed conflict", async () => {
    const base = fixture(["repository.admin"]);
    const store = makeD1RepositoryStore(new RacingRepositoryNameD1(base.db), { clock, gitUrlBase: "https://gitfoundry.example/git" });

    await expect(Effect.runPromise(store.update("tenant-a", "repo-a", 1, { name: "raced" }))).rejects.toBeInstanceOf(RepositoryNameConflictError);

    expect(base.db.prepare("SELECT COUNT(*) AS count FROM repositories WHERE tenant_id='tenant-a' AND id='repo-race' AND namespace_id='namespace-a' AND name='raced'").get()).toMatchObject({ count: 1 });
    expect(base.db.prepare("SELECT version,name,artifacts_namespace,artifacts_name FROM repositories WHERE tenant_id='tenant-a' AND id='repo-a'").get()).toMatchObject({ version: 1, name: "demo", artifacts_namespace: "tenant-a", artifacts_name: "repo-a" });
  });

  it("redacts D1 repository update failures and leaves metadata unchanged", async () => {
    const base = fixture(["repository.admin"]);
    const secret = "secret-token-should-not-leak";
    const store = makeD1RepositoryStore(new FailingRepositoryUpdateD1(base.db, secret), { clock, gitUrlBase: "https://gitfoundry.example/git" });

    const editError = await Effect.runPromise(store.update("tenant-a", "repo-a", 1, { visibility: "public" }).pipe(Effect.flip));
    expect(editError).toBeInstanceOf(RepositoryStoreUnavailableError);
    expect(JSON.stringify(editError)).not.toContain(secret);
    expect(String(editError)).not.toContain(secret);
    expect(base.db.prepare("SELECT version,visibility,archived,artifacts_namespace,artifacts_name FROM repositories WHERE tenant_id='tenant-a' AND id='repo-a'").get()).toMatchObject({ version: 1, visibility: "private", archived: 0, artifacts_namespace: "tenant-a", artifacts_name: "repo-a" });

    const archiveError = await Effect.runPromise(store.setArchived("tenant-a", "repo-a", { expected_version: 1 }, true).pipe(Effect.flip));
    expect(archiveError).toBeInstanceOf(RepositoryStoreUnavailableError);
    expect(JSON.stringify(archiveError)).not.toContain(secret);
    expect(String(archiveError)).not.toContain(secret);
    expect(base.db.prepare("SELECT version,visibility,archived,artifacts_namespace,artifacts_name FROM repositories WHERE tenant_id='tenant-a' AND id='repo-a'").get()).toMatchObject({ version: 1, visibility: "private", archived: 0, artifacts_namespace: "tenant-a", artifacts_name: "repo-a" });
  });

  it("archives and unarchives repository rows with version checks", async () => {
    const sql = fixture(["repository.admin"]);
    const store = makeD1RepositoryStore(sql, { clock, gitUrlBase: "https://gitfoundry.example/git" });

    const archived = await Effect.runPromise(store.setArchived("tenant-a", "repo-a", { expected_version: 1, reason: "quiet project" }, true));
    expect(archived).toMatchObject({ id: "repo-a", archived: true, version: 2, git_url: "https://gitfoundry.example/git/tenant-a/repo-a.git" });
    expect(sql.db.prepare("SELECT archived, artifacts_namespace, artifacts_name FROM repositories WHERE id='repo-a'").get()).toMatchObject({ archived: 1, artifacts_namespace: "tenant-a", artifacts_name: "repo-a" });

    await expect(Effect.runPromise(store.setArchived("tenant-a", "repo-a", { expected_version: 2 }, true))).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(Effect.runPromise(store.setArchived("tenant-a", "repo-a", { expected_version: 1 }, false))).rejects.toBeInstanceOf(StalePreconditionError);

    const unarchived = await Effect.runPromise(store.setArchived("tenant-a", "repo-a", { expected_version: 2, reason: "active again" }, false));
    expect(unarchived).toMatchObject({ id: "repo-a", archived: false, version: 3 });
  });

  it("stores idempotency receipts with conflict detection and principal partitioning", async () => {
    const store = makeD1IdempotencyStore(fixture(["repository.read"]), clock);
    const pending = operation("op-a");
    const scopeA = JSON.stringify(["tenant-a", "principal-a", "repo.view", "same-key"]);
    const scopeB = JSON.stringify(["tenant-a", "principal-b", "repo.view", "same-key"]);
    await expect(Effect.runPromise(store.replayOrReserve(scopeA, "digest-a", pending))).resolves.toBeUndefined();
    await expect(Effect.runPromise(store.replayOrReserve(scopeA, "digest-b", pending))).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(Effect.runPromise(store.replayOrReserve(scopeB, "digest-b", operation("op-b")))).resolves.toBeUndefined();
    await Effect.runPromise(store.commit(scopeA, "digest-a", { status: "succeeded", operationId: "repo.view", response: { ok: true }, replayed: false }, "op-a"));
    await expect(Effect.runPromise(store.replayOrReserve(scopeA, "digest-a", pending))).resolves.toMatchObject({ status: "succeeded", replayed: true });
  });

  it("does not allow a different digest or expired reservation to overwrite the active receipt", async () => {
    const sql = fixture(["repository.read"]);
    let currentTime = new Date(now);
    const store = makeD1IdempotencyStore(sql, { now: () => currentTime });
    const scope = JSON.stringify(["tenant-a", "principal-a", "repo.view", "fenced-key"]);
    const receipt = (value: string) => ({ status: "succeeded" as const, operationId: "repo.view", response: { value }, replayed: false });
    await Effect.runPromise(store.replayOrReserve(scope, "digest-a", operation("old-attempt")));
    await expect(Effect.runPromise(store.commit(scope, "different-digest", receipt("wrong"), "old-attempt"))).rejects.toThrow();
    expect(sql.db.prepare("SELECT response_key FROM idempotency WHERE key = 'fenced-key'").get()?.response_key).toBe("pending:old-attempt");
    currentTime = new Date(now.getTime() + 86400001);
    await Effect.runPromise(store.replayOrReserve(scope, "digest-a", operation("new-attempt")));
    await expect(Effect.runPromise(store.commit(scope, "digest-a", receipt("old"), "old-attempt"))).rejects.toThrow();
    expect(sql.db.prepare("SELECT response_key FROM idempotency WHERE key = 'fenced-key'").get()?.response_key).toBe("pending:new-attempt");
    await Effect.runPromise(store.commit(scope, "digest-a", receipt("new"), "new-attempt"));
    await expect(Effect.runPromise(store.commit(scope, "digest-a", receipt("overwrite"), "new-attempt"))).rejects.toThrow();
    await expect(Effect.runPromise(store.replayOrReserve(scope, "digest-a", operation("retry")))).resolves.toMatchObject({ response: { value: "new" }, replayed: true });
  });
});

function fixture(capabilities: string[]): SqliteD1 {
  const sql = new SqliteD1();
  installSchema(sql.db);
  seed(sql.db, capabilities);
  return sql;
}

function installSchema(db: DatabaseSync) {
  db.exec("CREATE TABLE tenants(id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, state TEXT NOT NULL, policy_epoch INTEGER NOT NULL DEFAULT 1, shard_id TEXT NOT NULL, jurisdiction TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}'); CREATE TABLE connections(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, issuer TEXT NOT NULL, external_tenant_id TEXT NOT NULL, audience TEXT NOT NULL, claims_json TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE principals(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, kind TEXT NOT NULL, display_name TEXT NOT NULL, active INTEGER NOT NULL, auth_epoch INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,id)); CREATE TABLE identity_links(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, principal_id TEXT NOT NULL, connection_id TEXT NOT NULL, issuer TEXT NOT NULL, stable_subject TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, verified INTEGER NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE directory_members(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, connection_id TEXT NOT NULL, external_id TEXT NOT NULL, principal_id TEXT NOT NULL, active INTEGER NOT NULL, emails_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(tenant_id,id)); CREATE TABLE groups(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, connection_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE group_memberships(tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, principal_id TEXT NOT NULL, directory_version INTEGER NOT NULL, PRIMARY KEY(tenant_id,group_id,principal_id)); CREATE TABLE roles(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, name TEXT NOT NULL, capabilities_json TEXT NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE grants(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, role_id TEXT NOT NULL, expires_at TEXT, PRIMARY KEY(tenant_id,id)); CREATE TABLE organization_namespaces(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE repositories(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, namespace_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL, default_branch TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, artifacts_namespace TEXT NOT NULL, artifacts_name TEXT NOT NULL, fork_of TEXT, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,namespace_id,name)); CREATE TABLE operations(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, kind TEXT NOT NULL, actor_id TEXT NOT NULL, state TEXT NOT NULL, progress_json TEXT NOT NULL, result_key TEXT, error_json TEXT, PRIMARY KEY(tenant_id,id)); CREATE TABLE idempotency(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, actor_id TEXT NOT NULL, operation_kind TEXT NOT NULL, key TEXT NOT NULL, request_digest TEXT NOT NULL, response_key TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,actor_id,operation_kind,key));");
}

function seed(db: DatabaseSync, capabilities: string[]) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 1, "shard-a", "US", "{}");
  db.prepare("INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "conn-a", 1, timestamp, timestamp, "https://issuer.example", "access", "public-audience", qualifiedConnectionClaims("conn-a-marker"), 1);
  db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-a", 1, timestamp, timestamp, "human", "Principal A", 1, 1);
  db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-b", 1, timestamp, timestamp, "human", "Principal B", 1, 1);
  db.prepare("INSERT INTO identity_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "link-a", 1, timestamp, timestamp, "principal-a", "conn-a", "https://issuer.example", "directory-subject-a", "directory", "directory-user-a", 1);
  db.prepare("INSERT INTO directory_members VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "member-a", 1, timestamp, timestamp, "conn-a", "directory-user-a", "principal-a", 1, "[]");
  db.prepare("INSERT INTO roles VALUES(?,?,?,?,?,?,?)").run("tenant-a", "role-a", 1, timestamp, timestamp, "reader", JSON.stringify(capabilities));
  db.prepare("INSERT INTO grants VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "grant-a", 1, timestamp, timestamp, "service", "principal-a", "tenant", "tenant-a", "role-a", null);
  db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run("tenant-a", "namespace-a", 1, timestamp, timestamp, "namespace-a", "Namespace A");
  db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 1, timestamp, timestamp, "namespace-a", "demo", "private", "main", 0, "tenant-a", "repo-a", null);
}

function seedGroupGrant(db: DatabaseSync, active: 0 | 1) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO groups VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "group-a", 1, timestamp, timestamp, "conn-a", "external-group-a", "Group A", active);
  db.prepare("INSERT INTO group_memberships VALUES(?,?,?,?)").run("tenant-a", "group-a", "principal-a", 1);
  db.prepare("INSERT INTO roles VALUES(?,?,?,?,?,?,?)").run("tenant-a", "role-group", 1, timestamp, timestamp, "group-reader", JSON.stringify(["repository.read"]));
  db.prepare("INSERT INTO grants VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "grant-group", 1, timestamp, timestamp, "group", "group-a", "tenant", "tenant-a", "role-group", null);
}

function operation(id: string): OperationRecord {
  return { tenant_id: "tenant-a", id, version: 1, created_at: now.toISOString(), updated_at: now.toISOString(), status: "running", kind: "repo.view", progress: {}, result: {}, error: null };
}

function qualifiedConnectionClaims(marker: string): string { return JSON.stringify({ identity_qualified: true, provider_account_claim: "cf_account_id", provider_account_id: "cf-account-a", connection_marker_claim: "gfy_connection_id", connection_marker: marker, immutable_subject_claim: "directory_subject", max_subject_bytes: 256 }) }
function qualifiedClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> { return Object.fromEntries(Object.entries({ iss: "https://issuer.example", aud: "public-audience", sub: "cf-access-sub-a", cf_account_id: "cf-account-a", gfy_connection_id: "conn-a-marker", directory_subject: "directory-subject-a", exp: Math.floor(now.getTime() / 1000) + 3600, ...overrides }).filter((entry) => entry[1] !== undefined)) }
