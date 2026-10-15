import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "../index.js";

// Acceptance tests for docs/requirements/email-code-sign-in.md, driven through the Worker's fetch handler.
type WorkerModule = typeof import("../index.js");
type Jwk = JsonWebKey & { kid: string; alg: string };
interface SentEmail { readonly to: string; readonly from: string; readonly subject: string; readonly text: string }

let api: WorkerModule;

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class<Env = unknown> {
    readonly env: Env;
    constructor(_ctx?: unknown, env?: Env) { this.env = env as Env }
  }
}));

beforeAll(async () => { api = await import("../index.js") });

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
const ownerSubject = "owner-access-subject-a";
const start = new Date("2026-10-11T12:00:00.000Z");
const minute = 60 * 1000;
const day = 24 * 60 * minute;
const request = (path: string, init?: RequestInit) => new Request("https://gitfoundry.test" + path, init);
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function makeFixture(extra: Record<string, unknown> = {}) {
  const sql = new SqliteD1();
  sql.db.exec(readFileSync(new URL("../../../../docs/source/handoff/contracts/schema.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0007_owner_access.sql", import.meta.url), "utf8"));
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0012_email_sign_in.sql", import.meta.url), "utf8"));
  const keys = await makeKeys();
  const sent: SentEmail[] = [];
  let now = start.getTime();
  const env = {
    GFY_AUTH_ISSUER: "https://issuer.example", GFY_AUTH_AUDIENCE: "public-audience", GFY_MCP_AUTH_AUDIENCE: "mcp-audience",
    GFY_AUTH_JWKS_URL: "https://issuer.example/cdn-cgi/access/certs", GFY_OWNER_ACCESS_SUBJECT: ownerSubject, GFY_OWNER_ACCESS_EMAIL: ownerEmail,
    GFY_DB: sql, clock: { now: () => new Date(now) }, jwksFetch: async () => Response.json({ keys: [keys.publicJwk] }),
    GFY_LOGIN_EMAIL: { send: async (message: SentEmail) => { sent.push(message); return { messageId: "message-" + sent.length } } },
    ...extra
  } as unknown as Env;
  const fetch = (path: string, init?: RequestInit) => api.default.fetch(request(path, init), env);
  const startSignIn = (email: string) => fetch("/auth/email/start", json({ email }));
  const lastCode = (email: string) => {
    const message = [...sent].reverse().find(item => item.to === email);
    const match = /\b(\d{6})\b/u.exec(message?.text ?? "");
    if (!match) throw new Error("no sign-in code was emailed to " + email);
    return match[1]!;
  };
  const verify = (email: string, code: string) => fetch("/auth/email/verify", json({ email, code }));
  const signIn = async (email: string) => {
    await startSignIn(email);
    const response = await verify(email, lastCode(email));
    expect(response.status).toBe(200);
    return { cookie: sessionCookie(response), tenantId: ((await response.json()) as { tenant_id: string }).tenant_id };
  };
  const repositories = (tenantId: string, cookie?: string) => fetch(`/api/v1/tenants/${tenantId}/repositories`, cookie ? { headers: { cookie } } : undefined);
  const advance = (ms: number) => { now += ms };
  const count = (table: string) => (sql.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  const agent = (path: string, payload: unknown) => new api.AgentApi({} as ExecutionContext, env).fetch(request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
  return { sent, fetch, agent, startSignIn, lastCode, verify, signIn, repositories, advance, count };
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /(?:^|,\s*)(gfy_session=[^;]+)/u.exec(header);
  if (!match) throw new Error("no session cookie was set");
  return match[1]!;
}

describe("email-code sign-in", () => {
  it("R1 emails a six-digit code from login@gitfoundry.dev", async () => {
    const f = await makeFixture();
    const response = await f.startSignIn("new@example.com");
    expect(response.status).toBe(202);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ to: "new@example.com", from: "login@gitfoundry.dev" });
    expect(f.sent[0]!.text).toMatch(/\b\d{6}\b/u);
  });

  it("R2 accepts a code only for its address, within ten minutes, and once", async () => {
    const f = await makeFixture();
    await f.startSignIn("new@example.com");
    const code = f.lastCode("new@example.com");
    const otherAddress = await f.verify("other@example.com", code);
    expect(otherAddress.status).toBe(401);
    expect(otherAddress.headers.get("set-cookie")).toBeNull();
    f.advance(10 * minute + 1000);
    const late = await f.verify("new@example.com", code);
    expect(late.status).toBe(401);
    expect(late.headers.get("set-cookie")).toBeNull();

    const fresh = await makeFixture();
    await fresh.startSignIn("new@example.com");
    const once = fresh.lastCode("new@example.com");
    expect((await fresh.verify("new@example.com", once)).status).toBe(200);
    const again = await fresh.verify("new@example.com", once);
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();

    const earlier = await makeFixture();
    await earlier.startSignIn("new@example.com");
    const first = earlier.lastCode("new@example.com");
    await earlier.startSignIn("new@example.com");
    const second = earlier.lastCode("new@example.com");
    expect((await earlier.verify("new@example.com", second)).status).toBe(200);
    const older = await earlier.verify("new@example.com", first);
    expect(older.status).toBe(401);
    expect(older.headers.get("set-cookie")).toBeNull();
  });

  it("R3 rejects the correct code after five incorrect codes", async () => {
    const f = await makeFixture();
    await f.startSignIn("new@example.com");
    const code = f.lastCode("new@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await f.verify("new@example.com", wrong)).status).toBe(401);
    const correct = await f.verify("new@example.com", code);
    expect(correct.status).toBe(401);
    expect(correct.headers.get("set-cookie")).toBeNull();
  });

  it("R4 creates an account and an owned workspace on first sign-in", async () => {
    const f = await makeFixture();
    const tenantsBefore = f.count("tenants");
    const session = await f.signIn("new@example.com");
    expect(session.tenantId).not.toBe("owner");
    expect(f.count("tenants")).toBe(tenantsBefore + 1);
    const listed = await f.repositories(session.tenantId, session.cookie);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ items: [], next_cursor: null, has_more: false });
  });

  it("R5 signs the configured owner in to the existing owner workspace", async () => {
    const f = await makeFixture();
    expect((await f.signIn(ownerEmail)).tenantId).toBe("owner");
    const tenantsBefore = f.count("tenants");
    f.advance(61 * 60 * 1000);
    const session = await f.signIn(ownerEmail);
    expect(session.tenantId).toBe("owner");
    expect(f.count("tenants")).toBe(tenantsBefore);
    expect((await f.repositories("owner", session.cookie)).status).toBe(200);
  });

  it("R6 keeps a sign-in for thirty days", async () => {
    const f = await makeFixture();
    const session = await f.signIn("new@example.com");
    f.advance(29 * day);
    expect((await f.repositories(session.tenantId, session.cookie)).status).toBe(200);
    f.advance(day + 1000);
    expect((await f.repositories(session.tenantId, session.cookie)).status).toBe(401);
  });

  it("R7 rejects a previous sign-in after signing out", async () => {
    const f = await makeFixture();
    const session = await f.signIn("new@example.com");
    const signedOut = await f.fetch("/auth/sign-out", { method: "POST", headers: { cookie: session.cookie } });
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.get("set-cookie")).toMatch(/gfy_session=;.*Max-Age=0/u);
    expect((await f.repositories(session.tenantId, session.cookie)).status).toBe(401);
  });

  it("R8 rejects another person's workspace and requests without a sign-in", async () => {
    const f = await makeFixture();
    const first = await f.signIn("first@example.com");
    const second = await f.signIn("second@example.com");
    expect(first.tenantId).not.toBe(second.tenantId);
    expect((await f.repositories(second.tenantId, first.cookie)).status).toBe(403);
    expect((await f.repositories(second.tenantId)).status).toBe(401);
  });

  it("R9 answers the same for existing and unknown addresses", async () => {
    const f = await makeFixture();
    await f.signIn(ownerEmail);
    const existing = await f.startSignIn(ownerEmail);
    const unknown = await f.startSignIn("new@example.com");
    expect(existing.status).toBe(unknown.status);
    expect(await existing.text()).toBe(await unknown.text());
  });

  it("R10 sends at most five sign-in emails per address per hour", async () => {
    const f = await makeFixture();
    const answers: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await f.startSignIn("new@example.com");
      answers.push(response.status + " " + await response.text());
    }
    expect(f.sent.filter(item => item.to === "new@example.com")).toHaveLength(5);
    expect(new Set(answers).size).toBe(1);
    f.advance(60 * minute + 1000);
    await f.startSignIn("new@example.com");
    expect(f.sent.filter(item => item.to === "new@example.com")).toHaveLength(6);
  });
});

describe("web page entry", () => {
  const page = '<html><head><meta name="gitfoundry-default-tenant" content="" /></head><body></body></html>';
  it("R13 returns the sign-in token in the body to command-line clients", async () => {
    const f = await makeFixture();
    await f.startSignIn("new@example.com");
    const response = await f.fetch("/auth/email/verify", json({ email: "new@example.com", code: f.lastCode("new@example.com"), client: "cli" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(((await response.json()) as { session_token: string }).session_token).toMatch(/^gfys_[A-Za-z0-9_-]{40,}$/u);
  });

  it("R14 accepts the sign-in token as a bearer header until sign-out", async () => {
    const f = await makeFixture();
    await f.startSignIn("new@example.com");
    const body = await (await f.fetch("/auth/email/verify", json({ email: "new@example.com", code: f.lastCode("new@example.com"), client: "cli" }))).json() as { session_token: string; tenant_id: string };
    const bearer = { authorization: "Bearer " + body.session_token };
    expect((await f.fetch(`/api/v1/tenants/${body.tenant_id}/repositories`, { headers: bearer })).status).toBe(200);
    expect((await f.fetch("/auth/sign-out", { method: "POST", headers: bearer })).status).toBe(204);
    expect((await f.fetch(`/api/v1/tenants/${body.tenant_id}/repositories`, { headers: bearer })).status).toBe(401);
  });

  it("R14 accepts the sign-in token from an MCP client", async () => {
    const f = await makeFixture();
    await f.startSignIn("new@example.com");
    const body = await (await f.fetch("/auth/email/verify", json({ email: "new@example.com", code: f.lastCode("new@example.com"), client: "cli" }))).json() as { session_token: string; tenant_id: string };
    const identity = await f.agent("/identity", { requested_tenant_id: body.tenant_id, userAuthorization: "Bearer " + body.session_token });
    expect(identity.status).toBe(200);
    expect(await identity.json()).toMatchObject({ tenant_id: body.tenant_id });
  });

  it("R11 serves the page to a signed-out visitor with no workspace selected", async () => {
    const f = await makeFixture({ ASSETS: { fetch: async () => new Response(page, { headers: { "content-type": "text/html" } }) } });
    const opened = await f.fetch("/");
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain('name="gitfoundry-default-tenant" content=""');
  });
  it("R12 serves the page to a signed-in person with their workspace selected", async () => {
    const f = await makeFixture({ ASSETS: { fetch: async () => new Response(page, { headers: { "content-type": "text/html" } }) } });
    const session = await f.signIn("new@example.com");
    const opened = await f.fetch("/", { headers: { cookie: session.cookie } });
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain(`name="gitfoundry-default-tenant" content="${session.tenantId}"`);
  });
});

async function makeKeys(): Promise<{ privateKey: CryptoKey; publicJwk: Jwk }> {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "email-sign-in-test", alg: "RS256" } as Jwk;
  return { privateKey: pair.privateKey, publicJwk };
}
async function signJwt(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const header = encode({ alg: "RS256", typ: "JWT", kid });
  const payload = encode(claims);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}
function encode(value: unknown): string { return base64Url(new TextEncoder().encode(JSON.stringify(value))) }
function base64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") }
