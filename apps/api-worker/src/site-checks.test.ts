import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { handleEmailSignInRequest } from "./email-sign-in/index.js";
import type { RepositoryLoadPorts } from "./repository-load-check.js";
import { handleSiteChecks, recordSiteCheck } from "./site-checks.js";
import { SourceReadUnavailableError } from "./source-read.js";

// Acceptance tests for docs/requirements/live-site-checks.md.
class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  async batch(statements: readonly { run(): Promise<any> }[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  prepare(sql: string) {
    const database = this.db;
    return { values: [] as any[], bind(...values: unknown[]) { return { ...this, values } }, async first<T>() { return database.prepare(sql).get(...this.values) as T | null }, async all<T>() { return { results: database.prepare(sql).all(...this.values) as T[], success: true } }, async run() { const result = database.prepare(sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } } } };
  }
}

const ownerEmail = "doug.lance@gmail.com";
const checkTime = new Date("2026-10-12T18:00:00.000Z");
const migration = (name: string) => readFileSync(new URL("../../../infra/migrations/" + name, import.meta.url), "utf8");

function makeFixture() {
  const sql = new SqliteD1();
  sql.db.exec(readFileSync(new URL("../../../docs/source/handoff/contracts/schema.sql", import.meta.url), "utf8"));
  sql.db.exec(migration("0007_owner_access.sql"));
  sql.db.exec(migration("0012_email_sign_in.sql"));
  sql.db.exec(migration("0013_site_checks.sql"));
  const sent: { to: string; text: string }[] = [];
  const env = {
    GFY_DB: sql, GFY_OWNER_ACCESS_EMAIL: ownerEmail, GFY_OWNER_TENANT_ID: "owner",
    GFY_RUNNER_TENANT_ID: "owner", GFY_RUNNER_REPOSITORY_ID: "repo-canonical",
    clock: { now: () => checkTime },
    GFY_LOGIN_EMAIL: { send: async (message: { to: string; text: string }) => { sent.push(message); return {} } }
  } as any;
  const post = (path: string, body: unknown) => handleEmailSignInRequest(new Request("https://gitfoundry.test" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, ["repository.read"]);
  const signIn = async (email: string) => {
    await post("/auth/email/start", { email });
    const code = /\b(\d{6})\b/u.exec([...sent].reverse().find(item => item.to === email)!.text)![1];
    const response = await post("/auth/email/verify", { email, code });
    return /(gfy_session=[^;]+)/u.exec(response!.headers.get("set-cookie") ?? "")![1]!;
  };
  const list = (cookie?: string) => handleSiteChecks(new Request("https://gitfoundry.test/api/v1/site-checks", cookie ? { headers: { cookie } } : undefined), env);
  const rows = () => sql.db.prepare("SELECT checked_at, ok, stage, code, duration_ms FROM site_checks ORDER BY checked_at").all() as { checked_at: string; ok: number; stage: string | null; code: string | null; duration_ms: number }[];
  return { sql, env, signIn, list, rows };
}

const readable: RepositoryLoadPorts = {
  head: async () => ({ version_commit: "a".repeat(40), code_commit: "b".repeat(40) }),
  list: async () => [{}],
  tree: async () => ({ items: [{}, {}] })
};

describe("live site checks", () => {
  it("R1 R2 records a passing scheduled check with its time and duration", async () => {
    const f = makeFixture();
    await recordSiteCheck(f.env, readable, checkTime);
    const rows = f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checked_at: "2026-10-12T18:00:00.000Z", ok: 1, stage: null, code: null });
    expect(rows[0]!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("R2 records the failing stage and code", async () => {
    const f = makeFixture();
    await recordSiteCheck(f.env, { ...readable, tree: async () => { throw new SourceReadUnavailableError({ code: "unsupported", reason: "provider tree capability unavailable", repositoryId: "repo-canonical" }) } }, checkTime);
    expect(f.rows()[0]).toMatchObject({ ok: 0, stage: "tree", code: "unsupported" });
  });

  it("R3 lists the 50 newest checks, newest first", async () => {
    const f = makeFixture();
    for (let index = 0; index < 60; index++) f.sql.db.prepare("INSERT INTO site_checks(checked_at, ok, stage, code, duration_ms) VALUES(?,?,?,?,?)").run(new Date(checkTime.getTime() - (60 - index) * 300_000).toISOString(), 1, null, null, 900);
    const response = await f.list(await f.signIn(ownerEmail));
    expect(response!.status).toBe(200);
    const body = await response!.json() as { checks: { checked_at: string }[] };
    expect(body.checks).toHaveLength(50);
    expect(body.checks[0]!.checked_at).toBe("2026-10-12T17:55:00.000Z");
    expect(body.checks[49]!.checked_at).toBe("2026-10-12T13:50:00.000Z");
  });

  it("R4 rejects a request without a session", async () => {
    const f = makeFixture();
    expect((await f.list())!.status).toBe(401);
  });

  it("R5 rejects a session from another workspace", async () => {
    const f = makeFixture();
    expect((await f.list(await f.signIn("someone@example.com")))!.status).toBe(403);
  });

  it("R8 deletes checks older than seven days when a check is recorded", async () => {
    const f = makeFixture();
    f.sql.db.prepare("INSERT INTO site_checks(checked_at, ok, stage, code, duration_ms) VALUES(?,?,?,?,?)").run("2026-10-01T00:00:00.000Z", 1, null, null, 900);
    f.sql.db.prepare("INSERT INTO site_checks(checked_at, ok, stage, code, duration_ms) VALUES(?,?,?,?,?)").run("2026-10-06T00:00:00.000Z", 1, null, null, 900);
    await recordSiteCheck(f.env, readable, checkTime);
    expect(f.rows().map(row => row.checked_at)).toEqual(["2026-10-06T00:00:00.000Z", "2026-10-12T18:00:00.000Z"]);
  });
});
