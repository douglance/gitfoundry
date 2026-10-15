import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AuthSessionDenied, AuthSessionReplayDetected, makeD1AuthSessionStore, type D1DatabaseLike, type D1PreparedStatement, type OneShotSessionIssuePort, type SessionEligibilityPort } from "./session.js";

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:"), readonly options: { readonly failAudit?: boolean; readonly revokeBeforeLastUsed?: boolean } = {}) {}
  prepare(sql: string) {
    const database = this.db;
    const failAudit = this.options.failAudit;
    const revokeBeforeLastUsed = this.options.revokeBeforeLastUsed;
    type SqliteValue = string | number | bigint | null | Uint8Array;
    return {
      sql,
      values: [] as unknown[],
      bind(...values: unknown[]) { return { ...this, values } },
      async first<T>() { return database.prepare(sql).get(...this.values as SqliteValue[]) as T | null },
      async all<T>() { return { results: database.prepare(sql).all(...this.values as SqliteValue[]) as T[] } },
      async run() {
        if (failAudit && /^INSERT INTO audit\b/.test(sql)) throw new Error("audit unavailable with secret gfy_refresh_plaintext_should_not_leak");
        if (revokeBeforeLastUsed && /^UPDATE auth_sessions SET last_used_at\b/.test(sql)) database.prepare("UPDATE auth_sessions SET revoked_at = '2026-10-10T00:00:30.000Z' WHERE tenant_id = ? AND id = ?").run(this.values[1] as SqliteValue, this.values[2] as SqliteValue);
        const result = database.prepare(sql).run(...this.values as SqliteValue[]);
        return { success: true, meta: { changes: Number(result.changes) } };
      }
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
const authExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
const clock = { now: () => now };
const tenantId = "tenant-a";
const principalId = "principal-a";
const clientId = "web-client";
const audience = "https://gitfoundry.dev";
const scopes = ["repo.read", "repo.write"];
const resources = ["tenant:tenant-a", "repo:repo-a"];

const eligibility = (overrides: Partial<{ readonly tenantId: string; readonly principalId: string; readonly kind: "human" | "service"; readonly policyEpoch: number; readonly authEpoch: number; readonly grantRef: string; readonly connectionId: string; readonly authenticatedAt: string; readonly authenticationExpiresAt: string; readonly scopes: readonly string[]; readonly resources: readonly string[] }> = {}): SessionEligibilityPort => ({
  verifySessionEligibility: (input) => Effect.succeed({ tenantId: input.tenantId, principalId: input.principalId, kind: "human", policyEpoch: 1, authEpoch: 1, grantRef: "grant-session", connectionId: "conn-a", authenticatedAt: now.toISOString(), authenticationExpiresAt: authExpiresAt, scopes, resources, ...overrides })
});

describe("D1 auth session store", () => {
  it("issues and authenticates opaque access and refresh credentials without storing plaintext", async () => {
    const sql = fixture();
    const store = makeD1AuthSessionStore(sql, eligibility(), { clock });
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    expect(issued.accessToken).toMatch(/^gfy_access_/);
    expect(issued.refreshToken).toMatch(/^gfy_refresh_/);
    await expect(Effect.runPromise(store.authenticateBearer({ tenantId, accessToken: issued.accessToken, clientId, audience }))).resolves.toMatchObject({ identity: { tenant_id: tenantId, principal_id: principalId }, credential: { client_id: clientId, audience, scopes, resources: [...resources].sort(), connection_id: "conn-a" } });
    const stored = JSON.stringify(sql.db.prepare("SELECT access_token_hash, refresh_token_hash FROM auth_sessions").all());
    expect(stored).not.toContain(issued.accessToken);
    expect(stored).not.toContain(issued.refreshToken);
  });

  it("denies exact tenant audience client and expiry mismatches", async () => {
    const sql = fixture();
    const store = makeD1AuthSessionStore(sql, eligibility(), { clock });
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    await expect(Effect.runPromise(store.authenticateBearer({ tenantId: "tenant-b", accessToken: issued.accessToken, clientId, audience }))).rejects.toBeInstanceOf(AuthSessionDenied);
    await expect(Effect.runPromise(store.authenticateBearer({ tenantId, accessToken: issued.accessToken, clientId: "other-client", audience }))).rejects.toBeInstanceOf(AuthSessionDenied);
    await expect(Effect.runPromise(store.authenticateBearer({ tenantId, accessToken: issued.accessToken, clientId, audience: "https://other.example" }))).rejects.toBeInstanceOf(AuthSessionDenied);
    const expiredStore = makeD1AuthSessionStore(sql, eligibility(), { clock: { now: () => new Date(issued.accessExpiresAt) } });
    await expect(Effect.runPromise(expiredStore.authenticateBearer({ tenantId, accessToken: issued.accessToken, clientId, audience }))).rejects.toBeInstanceOf(AuthSessionDenied);
  });

  it("rechecks active principal auth epoch and tenant policy epoch on every authentication", async () => {
    const sql = fixture();
    const store = makeD1AuthSessionStore(sql, eligibility(), { clock });
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    sql.db.prepare("UPDATE principals SET auth_epoch = auth_epoch + 1 WHERE tenant_id = ? AND id = ?").run(tenantId, principalId);
    await expect(Effect.runPromise(store.authenticateBearer({ tenantId, accessToken: issued.accessToken, clientId, audience }))).rejects.toBeInstanceOf(AuthSessionDenied);
    sql.db.prepare("UPDATE principals SET auth_epoch = 1 WHERE tenant_id = ? AND id = ?").run(tenantId, principalId);
    sql.db.prepare("UPDATE tenants SET policy_epoch = policy_epoch + 1 WHERE id = ?").run(tenantId);
    await expect(Effect.runPromise(store.authenticateBearer({ tenantId, accessToken: issued.accessToken, clientId, audience }))).rejects.toBeInstanceOf(AuthSessionDenied);
  });

  it("denies a token revoked between the authentication read and last-used update", async () => {
    const sql = fixture();
    const issued = await Effect.runPromise(makeD1AuthSessionStore(sql, eligibility(), { clock }).issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    const racing = makeD1AuthSessionStore(new SqliteD1(sql.db, { revokeBeforeLastUsed: true }), eligibility(), { clock });
    await expect(Effect.runPromise(racing.authenticateBearer({ tenantId, accessToken: issued.accessToken, clientId, audience }))).rejects.toBeInstanceOf(AuthSessionDenied);
  });

  it("allows one refresh rotation and revokes descendants when an old refresh token is reused", async () => {
    const sql = fixture();
    const store = makeD1AuthSessionStore(sql, eligibility(), { clock });
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    const attempts = await Promise.allSettled([
      Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, accessTtlSeconds: 60, refreshTtlSeconds: 3600 })),
      Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }))
    ]);
    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rotated = fulfilled[0];
    if (rotated?.status !== "fulfilled") throw new Error("expected one successful rotation");
    await expect(Effect.runPromise(store.authenticateBearer({ tenantId, accessToken: rotated.value.accessToken, clientId, audience }))).resolves.toMatchObject({ credential: { session_id: rotated.value.credential.session_id } });
    await expect(Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }))).rejects.toBeInstanceOf(AuthSessionReplayDetected);
    await expect(Effect.runPromise(store.authenticateBearer({ tenantId, accessToken: rotated.value.accessToken, clientId, audience }))).rejects.toBeInstanceOf(AuthSessionDenied);
  });

  it("revokes the refresh family so logout cannot refresh into new tokens", async () => {
    const sql = fixture();
    const store = makeD1AuthSessionStore(sql, eligibility(), { clock });
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    await Effect.runPromise(store.revokeSession({ tenantId, sessionId: issued.credential.session_id, actorPrincipalId: principalId, reason: "logout" }));
    await expect(Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }))).rejects.toBeInstanceOf(AuthSessionDenied);
    expect(sql.db.prepare("SELECT revoked_at FROM auth_refresh_families").get()).toMatchObject({ revoked_at: expect.any(String) });
  });

  it("preserves service principal kind through refresh rotation", async () => {
    const sql = fixture();
    sql.db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run(tenantId, "service-a", 1, now.toISOString(), now.toISOString(), "service", "Service A", 1, 1);
    const store = makeD1AuthSessionStore(sql, eligibility({ principalId: "service-a", kind: "service" }), { clock });
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId: "service-a", clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    const rotated = await Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    expect(rotated.identity.kind).toBe("service");
    await expect(Effect.runPromise(store.authenticateBearer({ tenantId, accessToken: rotated.accessToken, clientId, audience }))).resolves.toMatchObject({ identity: { kind: "service" } });
  });

  it("caps ttl to ten minute access thirty day refresh and never extends the SSO deadline", async () => {
    const sql = fixture();
    const movingClock = { current: now, now() { return this.current; } };
    const ssoDeadline = new Date(now.getTime() + 20 * 60 * 1000).toISOString();
    const store = makeD1AuthSessionStore(sql, eligibility({ authenticationExpiresAt: ssoDeadline }), { clock: movingClock });
    await expect(Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 601, refreshTtlSeconds: 3600 }))).rejects.toBeInstanceOf(AuthSessionDenied);
    await expect(Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 600, refreshTtlSeconds: 30 * 24 * 60 * 60 + 1 }))).rejects.toBeInstanceOf(AuthSessionDenied);
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 600, refreshTtlSeconds: 30 * 24 * 60 * 60 }));
    expect(issued.refreshExpiresAt).toBe(ssoDeadline);
    movingClock.current = new Date(now.getTime() + 5 * 60 * 1000);
    const rotated = await Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, accessTtlSeconds: 600, refreshTtlSeconds: 30 * 24 * 60 * 60 }));
    expect(rotated.refreshExpiresAt).toBe(ssoDeadline);
    movingClock.current = new Date(now.getTime() + 21 * 60 * 1000);
    await expect(Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: rotated.refreshToken, clientId, audience, accessTtlSeconds: 600, refreshTtlSeconds: 3600 }))).rejects.toBeInstanceOf(AuthSessionDenied);
  });

  it("narrows refresh scopes and resources and rejects expansion", async () => {
    const sql = fixture();
    const store = makeD1AuthSessionStore(sql, eligibility(), { clock });
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    await expect(Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, scopes: ["repo.admin"], accessTtlSeconds: 60, refreshTtlSeconds: 3600 }))).rejects.toBeInstanceOf(AuthSessionDenied);
    const narrowed = await Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, scopes: ["repo.read"], resources: ["repo:repo-a"], accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    expect(narrowed.credential.scopes).toEqual(["repo.read"]);
    expect(narrowed.credential.resources).toEqual(["repo:repo-a"]);
  });

  it("rolls back refresh consumption and issuance when audit persistence fails without leaking raw errors", async () => {
    const sql = fixture();
    const store = makeD1AuthSessionStore(sql, eligibility(), { clock });
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    const failing = makeD1AuthSessionStore(new SqliteD1(sql.db, { failAudit: true }), eligibility(), { clock });
    await expect(Effect.runPromise(failing.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }))).rejects.toMatchObject({ reason: "database operation failed" });
    await expect(Effect.runPromise(failing.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }))).rejects.not.toMatchObject({ reason: expect.stringContaining("gfy_refresh_plaintext") });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toMatchObject({ count: 1 });
    expect(sql.db.prepare("SELECT consumed_at FROM auth_refresh_token_history WHERE generation = 0").get()).toMatchObject({ consumed_at: null });
  });

  it("failed live-state CAS leaves no replacement session audit or consumed token", async () => {
    const sql = fixture();
    const store = makeD1AuthSessionStore(sql, eligibility(), { clock });
    const issued = await Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }));
    sql.db.prepare("UPDATE principals SET auth_epoch = 2 WHERE tenant_id = ? AND id = ?").run(tenantId, principalId);
    await expect(Effect.runPromise(store.rotateRefresh({ tenantId, refreshToken: issued.refreshToken, clientId, audience, accessTtlSeconds: 60, refreshTtlSeconds: 3600 }))).rejects.toThrow();
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toMatchObject({ count: 1 });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM audit WHERE operation = 'auth.refresh.rotate'").get()).toMatchObject({ count: 0 });
    expect(sql.db.prepare("SELECT consumed_at FROM auth_refresh_token_history WHERE generation = 0").get()).toMatchObject({ consumed_at: null });
  });

  it("consumes one-shot grants in the same transaction and rolls back on later failure", async () => {
    const sql = fixture();
    installOneShotTable(sql);
    const store = makeD1AuthSessionStore(sql, eligibility(), { clock });
    const grant = oneShotPort(sql, "device-a");
    const attempts = await Promise.allSettled([
      Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600, oneShot: grant })),
      Effect.runPromise(store.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600, oneShot: grant }))
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toMatchObject({ count: 1 });
    expect(sql.db.prepare("SELECT consumed_session_id IS NOT NULL AS consumed FROM oauth_one_shot_grants WHERE id = 'device-a'").get()).toMatchObject({ consumed: 1 });

    sql.db.prepare("INSERT INTO oauth_one_shot_grants(tenant_id,id,principal_id,client_id,audience,scopes_json,resources_json,expires_at,consumed_at,consumed_session_id) VALUES(?,?,?,?,?,?,?,?,NULL,NULL)").run(tenantId, "device-b", principalId, clientId, audience, JSON.stringify([...scopes].sort()), JSON.stringify([...resources].sort()), authExpiresAt);
    const failing = makeD1AuthSessionStore(new SqliteD1(sql.db, { failAudit: true }), eligibility(), { clock });
    await expect(Effect.runPromise(failing.issueSession({ tenantId, principalId, clientId, audience, scopes, resources, accessTtlSeconds: 60, refreshTtlSeconds: 3600, oneShot: oneShotPort(sql, "device-b") }))).rejects.toThrow();
    expect(sql.db.prepare("SELECT consumed_session_id FROM oauth_one_shot_grants WHERE id = 'device-b'").get()).toMatchObject({ consumed_session_id: null });
  });
});

function fixture(): SqliteD1 {
  const sql = new SqliteD1();
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0001_handbook.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0010_auth_sessions.sql", import.meta.url), "utf8"));
  const timestamp = now.toISOString();
  sql.db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run(tenantId, tenantId, "active", 1, "shard-a", "US", "{}");
  sql.db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run("tenant-b", "tenant-b", "active", 1, "shard-b", "US", "{}");
  sql.db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run(tenantId, principalId, 1, timestamp, timestamp, "human", "Principal A", 1, 1);
  sql.db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-b", principalId, 1, timestamp, timestamp, "human", "Principal B", 1, 1);
  return sql;
}

function installOneShotTable(sql: SqliteD1): void {
  sql.db.exec("CREATE TABLE oauth_one_shot_grants(tenant_id TEXT NOT NULL, id TEXT NOT NULL, principal_id TEXT NOT NULL, client_id TEXT NOT NULL, audience TEXT NOT NULL, scopes_json TEXT NOT NULL, resources_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, consumed_session_id TEXT, PRIMARY KEY(tenant_id,id));");
  sql.db.prepare("INSERT INTO oauth_one_shot_grants(tenant_id,id,principal_id,client_id,audience,scopes_json,resources_json,expires_at,consumed_at,consumed_session_id) VALUES(?,?,?,?,?,?,?,?,NULL,NULL)").run(tenantId, "device-a", principalId, clientId, audience, JSON.stringify([...scopes].sort()), JSON.stringify([...resources].sort()), authExpiresAt);
}

function oneShotPort(sql: D1DatabaseLike, id: string): OneShotSessionIssuePort {
  return {
    prepareSessionIssueClaim: ({ material }) => Effect.succeed({
      auditRef: id,
      claimStatements: [sql.prepare("UPDATE oauth_one_shot_grants SET consumed_at = ?, consumed_session_id = ? WHERE tenant_id = ? AND id = ? AND principal_id = ? AND client_id = ? AND audience = ? AND consumed_at IS NULL AND expires_at > ? AND scopes_json = ? AND resources_json = ?").bind(material.now, material.sessionId, material.tenantId, id, material.principalId, material.clientId, material.audience, material.now, JSON.stringify(material.scopes), JSON.stringify(material.resources))],
      assertionStatements: [sql.prepare("INSERT INTO auth_transaction_assertions(id) SELECT 'auth-transaction-assertion' WHERE NOT EXISTS(SELECT 1 FROM oauth_one_shot_grants WHERE tenant_id = ? AND id = ? AND consumed_session_id = ? AND consumed_at = ?)").bind(material.tenantId, id, material.sessionId, material.now)]
    })
  };
}
