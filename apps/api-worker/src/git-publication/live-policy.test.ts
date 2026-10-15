import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { GitPublicationIntent } from "../../../../packages/core/src/git-publication/index.js";
import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";
import { makeD1PublicationPolicy } from "./live-policy.js";

const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const now = new Date("2026-10-08T00:00:00.000Z");
const clock = { now: () => now };

class SqliteD1 implements D1DatabaseLike {
  readonly db = new DatabaseSync(":memory:");
  readonly prepareCalls: string[] = [];

  prepare<T = Record<string, unknown>>(sql: string): D1PreparedStatement<T> {
    this.prepareCalls.push(sql);
    const statement = this.db.prepare(sql);
    return {
      bind: (...values: readonly unknown[]) => {
        const sqliteValues = values as readonly SQLInputValue[];
        return {
          bind: (...nextValues: readonly unknown[]) => this.prepare<T>(sql).bind(...nextValues),
          first: async <R = T>() => statement.get(...sqliteValues) as R | null,
          all: async <R = T>() => ({ results: statement.all(...sqliteValues) as R[], success: true }) satisfies D1Result<R>,
          run: async () => { statement.run(...sqliteValues); return { success: true } satisfies D1Result<T> }
        };
      },
      first: async <R = T>() => statement.get() as R | null,
      all: async <R = T>() => ({ results: statement.all() as R[], success: true }) satisfies D1Result<R>,
      run: async () => { statement.run(); return { success: true } satisfies D1Result<T> }
    };
  }
}

class ThrowingD1 extends SqliteD1 {
  override prepare<T = Record<string, unknown>>(_sql: string): D1PreparedStatement<T> {
    throw new Error("D1 unavailable secret-token");
  }
}

function intent(overrides: Partial<GitPublicationIntent> = {}): GitPublicationIntent {
  return { tenantId: "tenant-a", repositoryId: "repo-a", principalId: "principal-a", operationId: "repo.ref-update", idempotencyKey: "idem-live-policy", expectedVersion: 1, policyEpoch: 1, leaseFence: "lease-live-policy", atomic: true, eligibilityId: null, reason: "authorize live D1 publication", changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: newSha, force: false }], ...overrides };
}

describe("D1-backed live publication policy", () => {
  it("mints a server-owned policy receipt after identity, repository and validator admission", async () => {
    const sql = fixture(["repository.write"]);
    const finalNow = new Date("2026-10-08T00:05:00.000Z");
    let currentNow = now;
    const validatorCalls: GitPublicationIntent[] = [];
    const policy = makeD1PublicationPolicy(sql, { clock: { now: () => currentNow }, validatePreparedChanges: (request) => Effect.sync(() => { validatorCalls.push(request); currentNow = finalNow; }) });

    const receipt = await Effect.runPromise(policy.revalidate(intent()));

    expect(receipt).toMatchObject({ tenantId: "tenant-a", repositoryId: "repo-a", principalId: "principal-a", capability: "repository.write", policyEpoch: 1, leaseFence: "lease-live-policy", observedAt: finalNow.toISOString() });
    expect(receipt.receiptId).toMatch(/^policy-gitpub-/);
    expect(validatorCalls).toHaveLength(1);
  });

  it("validates intent before D1 effects and maps invalid input to publication denial", async () => {
    for (const request of [
      intent({ changes: [{ ref: "main", old_sha: oldSha, new_sha: newSha, force: false }] }),
      null,
      "not-an-intent",
      7,
      true,
      []
    ] as readonly unknown[]) {
      const sql = fixture(["repository.write"]);
      const denied = await capture(makeD1PublicationPolicy(sql, { clock, validatePreparedChanges: () => Effect.void }).revalidate(request as GitPublicationIntent));
      const malformedDirectIntent = request === null || typeof request !== "object" || Array.isArray(request);

      expect(denied).toMatchObject({ ok: false, tag: "PublicationDeniedError", ...(malformedDirectIntent ? { reason: "invalid publication intent" } : {}) });
      expect(sql.prepareCalls).toEqual([]);
    }
  });

  it("fails closed when the server prepared-change validator is omitted", async () => {
    const denied = await capture(makeD1PublicationPolicy(fixture(["repository.write"]), { clock }).revalidate(intent()));

    expect(denied).toMatchObject({ ok: false, tag: "PublicationProviderError", kind: "unreachable" });
  });

  it("rejects tenant-isolated repository ids before calling the validator", async () => {
    const sql = fixture(["repository.write"]);
    sql.db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-b", "tenant-b", "active", 1, "shard-b", "US", "{}");
    sql.db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run("tenant-b", "namespace-b", 1, now.toISOString(), now.toISOString(), "namespace-b", "Namespace B");
    sql.db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-b", "repo-cross", 1, now.toISOString(), now.toISOString(), "namespace-b", "demo", "private", "main", 0, "tenant-b", "repo-cross", null);
    let called = false;

    const denied = await capture(makeD1PublicationPolicy(sql, { clock, validatePreparedChanges: () => Effect.sync(() => { called = true; }) }).revalidate(intent({ repositoryId: "repo-cross" })));

    expect(denied).toMatchObject({ ok: false, tag: "PublicationDeniedError" });
    expect(called).toBe(false);
  });

  it("rejects inactive and historical principals before calling the validator", async () => {
    for (const mutate of [
      (db: DatabaseSync) => db.prepare("UPDATE principals SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'").run(),
      (db: DatabaseSync) => db.prepare("UPDATE principals SET kind = 'historical' WHERE tenant_id = 'tenant-a' AND id = 'principal-a'").run()
    ]) {
      const sql = fixture(["repository.write"]);
      mutate(sql.db);
      let called = false;
      const denied = await capture(makeD1PublicationPolicy(sql, { clock, validatePreparedChanges: () => Effect.sync(() => { called = true; }) }).revalidate(intent()));

      expect(denied).toMatchObject({ ok: false, tag: "PublicationDeniedError" });
      expect(called).toBe(false);
    }
  });

  it("rejects missing and expired repository.write grants before calling the validator", async () => {
    for (const mutate of [
      (db: DatabaseSync) => db.prepare("UPDATE roles SET capabilities_json = '[]' WHERE tenant_id = 'tenant-a' AND id = 'role-a'").run(),
      (db: DatabaseSync) => db.prepare("UPDATE grants SET expires_at = ? WHERE tenant_id = 'tenant-a' AND id = 'grant-a'").run("2026-10-07T23:59:59.000Z")
    ]) {
      const sql = fixture(["repository.write"]);
      mutate(sql.db);
      let called = false;
      const denied = await capture(makeD1PublicationPolicy(sql, { clock, validatePreparedChanges: () => Effect.sync(() => { called = true; }) }).revalidate(intent()));

      expect(denied).toMatchObject({ ok: false, tag: "PublicationDeniedError" });
      expect(called).toBe(false);
    }
  });

  it("rejects stale tenant policy epochs before calling the validator", async () => {
    const sql = fixture(["repository.write"]);
    let called = false;

    const denied = await capture(makeD1PublicationPolicy(sql, { clock, validatePreparedChanges: () => Effect.sync(() => { called = true; }) }).revalidate(intent({ policyEpoch: 2 })));

    expect(denied).toMatchObject({ ok: false, tag: "PublicationDeniedError" });
    expect(called).toBe(false);
  });

  it("rejects archived repositories, stale versions and malformed repository state before validation", async () => {
    for (const mutate of [
      (db: DatabaseSync) => db.prepare("UPDATE repositories SET archived = 1 WHERE tenant_id = 'tenant-a' AND id = 'repo-a'").run(),
      (db: DatabaseSync) => db.prepare("UPDATE repositories SET version = 2 WHERE tenant_id = 'tenant-a' AND id = 'repo-a'").run(),
      (db: DatabaseSync) => db.prepare("UPDATE repositories SET archived = 7 WHERE tenant_id = 'tenant-a' AND id = 'repo-a'").run(),
      (db: DatabaseSync) => db.prepare("UPDATE repositories SET version = 0 WHERE tenant_id = 'tenant-a' AND id = 'repo-a'").run()
    ]) {
      const sql = fixture(["repository.write"]);
      mutate(sql.db);
      let called = false;
      const denied = await capture(makeD1PublicationPolicy(sql, { clock, validatePreparedChanges: () => Effect.sync(() => { called = true; }) }).revalidate(intent()));

      expect(denied).toMatchObject({ ok: false, tag: "PublicationDeniedError" });
      expect(called).toBe(false);
    }
  });

  it("fails closed for malformed storage and invalid server clocks", async () => {
    const storageFailure = await capture(makeD1PublicationPolicy(new ThrowingD1(), { clock, validatePreparedChanges: () => Effect.void }).revalidate(intent()));
    const malformedIdentity = fixture(["repository.write"]);
    const privateSentinel = "private-live-policy-sentinel";
    malformedIdentity.db.prepare("UPDATE roles SET capabilities_json = ? WHERE tenant_id = 'tenant-a' AND id = 'role-a'").run(`{\"capabilities\": [\"repository.write\"], \"secret\": \"${privateSentinel}`);
    const malformedIdentityFailure = await capture(makeD1PublicationPolicy(malformedIdentity, { clock, validatePreparedChanges: () => Effect.void }).revalidate(intent()));
    const timeFailure = await capture(makeD1PublicationPolicy(fixture(["repository.write"]), { clock: { now: () => new Date("invalid") }, validatePreparedChanges: () => Effect.void }).revalidate(intent()));
    let mutableNow = now;
    const finalClockFailure = await capture(makeD1PublicationPolicy(fixture(["repository.write"]), { clock: { now: () => mutableNow }, validatePreparedChanges: () => Effect.sync(() => { mutableNow = new Date("invalid"); }) }).revalidate(intent()));

    expect(storageFailure).toMatchObject({ ok: false, tag: "PublicationProviderError", kind: "unreachable" });
    expect(JSON.stringify(storageFailure)).not.toContain("secret-token");
    expect(malformedIdentityFailure).toMatchObject({ ok: false, tag: "PublicationProviderError", kind: "unreachable" });
    expect(JSON.stringify(malformedIdentityFailure)).not.toContain(privateSentinel);
    expect(JSON.stringify(malformedIdentityFailure)).not.toContain("SyntaxError");
    expect(JSON.stringify(malformedIdentityFailure)).not.toContain("JSON");
    expect(timeFailure).toMatchObject({ ok: false, tag: "PublicationProviderError", kind: "unreachable" });
    expect(finalClockFailure).toMatchObject({ ok: false, tag: "PublicationProviderError", kind: "unreachable" });
  });

  it("rechecks identity, grant, repository archive, version and epoch after validation", async () => {
    for (const [name, mutate] of [
      ["revoke grant", (db: DatabaseSync) => db.prepare("DELETE FROM grants WHERE tenant_id = 'tenant-a' AND id = 'grant-a'").run()],
      ["archive repository", (db: DatabaseSync) => db.prepare("UPDATE repositories SET archived = 1 WHERE tenant_id = 'tenant-a' AND id = 'repo-a'").run()],
      ["bump version", (db: DatabaseSync) => db.prepare("UPDATE repositories SET version = 2 WHERE tenant_id = 'tenant-a' AND id = 'repo-a'").run()],
      ["bump epoch", (db: DatabaseSync) => db.prepare("UPDATE tenants SET policy_epoch = 2 WHERE id = 'tenant-a'").run()]
    ] as const) {
      const sql = fixture(["repository.write"]);
      let calls = 0;
      const denied = await capture(makeD1PublicationPolicy(sql, { clock, validatePreparedChanges: () => Effect.sync(() => { calls += 1; mutate(sql.db); }) }).revalidate(intent()));

      expect(denied, name).toMatchObject({ ok: false, tag: "PublicationDeniedError" });
      expect(calls, name).toBe(1);
    }
  });
});

async function capture<A>(effect: Effect.Effect<A, unknown>): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly tag: string | undefined; readonly reason: string | undefined; readonly kind: string | undefined }> {
  return await Effect.runPromise(effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, tag: tagOf(error), reason: reasonOf(error), kind: kindOf(error) }))
  ));
}

function tagOf(error: unknown): string | undefined { return typeof error === "object" && error !== null && "_tag" in error ? String((error as { readonly _tag?: unknown })._tag) : undefined }
function reasonOf(error: unknown): string | undefined { return typeof error === "object" && error !== null && "reason" in error ? String((error as { readonly reason?: unknown }).reason) : undefined }
function kindOf(error: unknown): string | undefined { return typeof error === "object" && error !== null && "kind" in error ? String((error as { readonly kind?: unknown }).kind) : undefined }

function fixture(capabilities: string[]): SqliteD1 {
  const sql = new SqliteD1();
  installSchema(sql.db);
  seed(sql.db, capabilities);
  return sql;
}

function installSchema(db: DatabaseSync) {
  db.exec("CREATE TABLE tenants(id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, state TEXT NOT NULL, policy_epoch INTEGER NOT NULL DEFAULT 1, shard_id TEXT NOT NULL, jurisdiction TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}'); CREATE TABLE connections(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, issuer TEXT NOT NULL, external_tenant_id TEXT NOT NULL, audience TEXT NOT NULL, claims_json TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE principals(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, kind TEXT NOT NULL, display_name TEXT NOT NULL, active INTEGER NOT NULL, auth_epoch INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,id)); CREATE TABLE identity_links(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, principal_id TEXT NOT NULL, connection_id TEXT NOT NULL, issuer TEXT NOT NULL, stable_subject TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, verified INTEGER NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE directory_members(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, connection_id TEXT NOT NULL, external_id TEXT NOT NULL, principal_id TEXT NOT NULL, active INTEGER NOT NULL, emails_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(tenant_id,id)); CREATE TABLE groups(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, connection_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE group_memberships(tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, principal_id TEXT NOT NULL, directory_version INTEGER NOT NULL, PRIMARY KEY(tenant_id,group_id,principal_id)); CREATE TABLE roles(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, name TEXT NOT NULL, capabilities_json TEXT NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE grants(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, role_id TEXT NOT NULL, expires_at TEXT, PRIMARY KEY(tenant_id,id)); CREATE TABLE organization_namespaces(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, PRIMARY KEY(tenant_id,id)); CREATE TABLE repositories(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, namespace_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL, default_branch TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, artifacts_namespace TEXT NOT NULL, artifacts_name TEXT NOT NULL, fork_of TEXT, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,namespace_id,name));");
}

function seed(db: DatabaseSync, capabilities: string[]) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 1, "shard-a", "US", "{}");
  db.prepare("INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "conn-a", 1, timestamp, timestamp, "https://issuer.example", "access", "public-audience", qualifiedConnectionClaims("conn-a-marker"), 1);
  db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-a", 1, timestamp, timestamp, "human", "Principal A", 1, 1);
  db.prepare("INSERT INTO identity_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "link-a", 1, timestamp, timestamp, "principal-a", "conn-a", "https://issuer.example", "directory-subject-a", "directory", "directory-user-a", 1);
  db.prepare("INSERT INTO directory_members VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "member-a", 1, timestamp, timestamp, "conn-a", "directory-user-a", "principal-a", 1, "[]");
  db.prepare("INSERT INTO roles VALUES(?,?,?,?,?,?,?)").run("tenant-a", "role-a", 1, timestamp, timestamp, "writer", JSON.stringify(capabilities));
  db.prepare("INSERT INTO grants VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "grant-a", 1, timestamp, timestamp, "service", "principal-a", "tenant", "tenant-a", "role-a", null);
  db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run("tenant-a", "namespace-a", 1, timestamp, timestamp, "namespace-a", "Namespace A");
  db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 1, timestamp, timestamp, "namespace-a", "demo", "private", "main", 0, "tenant-a", "repo-a", null);
}

function qualifiedConnectionClaims(marker: string): string { return JSON.stringify({ identity_qualified: true, provider_account_claim: "cf_account_id", provider_account_id: "cf-account-a", connection_marker_claim: "gfy_connection_id", connection_marker: marker, immutable_subject_claim: "directory_subject", max_subject_bytes: 256 }) }
