import type { D1DatabaseLike } from "../../../../packages/core/src/live/index.js";

// GitFoundry's own sign-in: a six-digit code emailed through Cloudflare Email Service,
// an account and workspace per email address, and a browser session cookie.

export interface LoginEmailMessage { readonly to: string; readonly from: string; readonly subject: string; readonly text: string; readonly html: string }
export interface LoginEmailSender { readonly send: (message: LoginEmailMessage) => Promise<unknown> }

export interface EmailSignInEnv {
  readonly GFY_DB?: D1DatabaseLike;
  readonly DB?: D1DatabaseLike;
  readonly GFY_LOGIN_EMAIL?: LoginEmailSender;
  readonly GFY_OWNER_ACCESS_EMAIL?: string;
  readonly GFY_OWNER_TENANT_ID?: string;
  readonly clock?: { readonly now: () => Date };
}

export interface WorkspaceSession {
  readonly tenantId: string;
  readonly principalId: string;
  readonly policyEpoch: number;
  readonly scopes: readonly string[];
  readonly grantRef: string;
  readonly kind: "human" | "service" | "extension" | "job" | "migration" | "system";
}

export type SessionCheck =
  | { readonly ok: true; readonly session: WorkspaceSession }
  | { readonly ok: false; readonly status: 401 | 403 | 503; readonly error: "gfy_auth_invalid" | "gfy_permission_denied" | "gfy_auth_unconfigured" };

export const sessionCookieName = "gfy_session";
const loginSender = "login@gitfoundry.dev";
const sessionTokenPrefix = "gfys_";
const codeLifetimeMs = 10 * 60 * 1000;
const maxFailedAttempts = 5;
const maxCodesPerHour = 5;
const sessionLifetimeSeconds = 30 * 24 * 60 * 60;
const ownerRoleId = "owner-admin";
const ownerGrantId = "owner-admin";
const workspacePrincipalId = "owner";
const workspaceNamespaceId = "core";
const ownerGrantExpiresAt = "9999-12-31T23:59:59.999Z";
const emailPattern = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/u;
const codeSentBody = JSON.stringify({ status: "code_sent" });

export async function handleEmailSignInRequest(request: Request, env: EmailSignInEnv, capabilities: readonly string[]): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/auth/email/start" && path !== "/auth/email/verify" && path !== "/auth/sign-out") return undefined;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  const db = env.GFY_DB ?? env.DB;
  if (!db) return json({ error: "gfy_auth_unconfigured" }, 503);
  if (path === "/auth/sign-out") return signOut(request, db, env);
  const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const email = normalizeEmail(body?.email);
  if (!email) return json({ error: "invalid_email" }, 400);
  if (path === "/auth/email/start") return startSignIn(db, env, email);
  const code = typeof body?.code === "string" && /^\d{6}$/u.test(body.code) ? body.code : undefined;
  return verifySignIn(db, env, email, code, capabilities, body?.client === "cli");
}

async function startSignIn(db: D1DatabaseLike, env: EmailSignInEnv, email: string): Promise<Response> {
  if (!env.GFY_LOGIN_EMAIL) return json({ error: "gfy_auth_unconfigured" }, 503);
  const now = currentTime(env);
  const recent = await db.prepare("SELECT COUNT(*) AS count FROM auth_email_codes WHERE email = ? AND created_at > ?").bind(email, new Date(now - 60 * 60 * 1000).toISOString()).first<{ count: number }>();
  if ((recent?.count ?? 0) >= maxCodesPerHour) return codeSent();
  const code = sixDigitCode();
  const id = randomHex(16);
  await db.prepare("INSERT INTO auth_email_codes(id,email,code_hash,created_at,expires_at,failed_attempts) VALUES(?,?,?,?,?,0)")
    .bind(id, email, await sha256Hex(email + ":" + code), new Date(now).toISOString(), new Date(now + codeLifetimeMs).toISOString()).run();
  try {
    await env.GFY_LOGIN_EMAIL.send({
      to: email, from: loginSender, subject: `${code} is your GitFoundry sign-in code`,
      text: `Your GitFoundry sign-in code is ${code}\n\nIt expires in 10 minutes. If you did not try to sign in, you can ignore this email.\n`,
      html: `<p>Your GitFoundry sign-in code is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you did not try to sign in, you can ignore this email.</p>`
    });
  } catch {
    await db.prepare("DELETE FROM auth_email_codes WHERE id = ?").bind(id).run();
    return json({ error: "email_unavailable" }, 503);
  }
  return codeSent();
}

async function verifySignIn(db: D1DatabaseLike, env: EmailSignInEnv, email: string, code: string | undefined, capabilities: readonly string[], cli = false): Promise<Response> {
  const now = currentTime(env);
  // Only the most recent code counts, so sending a new code retires the earlier ones.
  const row = await db.prepare("SELECT id, code_hash, failed_attempts FROM auth_email_codes WHERE email = ? AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(email, new Date(now).toISOString()).first<{ id: string; code_hash: string; failed_attempts: number }>();
  if (!row || row.failed_attempts >= maxFailedAttempts || !code) return invalidCode();
  if (!constantTimeEqual(row.code_hash, await sha256Hex(email + ":" + code))) {
    await db.prepare("UPDATE auth_email_codes SET failed_attempts = failed_attempts + 1 WHERE id = ?").bind(row.id).run();
    return invalidCode();
  }
  const consumed = await db.prepare("UPDATE auth_email_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(new Date(now).toISOString(), row.id).run();
  if ((consumed.meta?.changes ?? 0) !== 1) return invalidCode();
  const account = await accountFor(db, env, email, capabilities, now);
  const token = sessionTokenPrefix + randomBase64Url(32);
  await db.prepare("INSERT INTO auth_browser_sessions(token_hash,email,tenant_id,principal_id,created_at,expires_at) VALUES(?,?,?,?,?,?)")
    .bind(await sha256Hex(token), email, account.tenantId, account.principalId, new Date(now).toISOString(), new Date(now + sessionLifetimeSeconds * 1000).toISOString()).run();
  // Command-line and agent clients keep the token themselves and send it as a bearer header.
  if (cli) return json({ tenant_id: account.tenantId, email, session_token: token, expires_in: sessionLifetimeSeconds }, 200);
  return json({ tenant_id: account.tenantId, email }, 200, { "set-cookie": `${sessionCookieName}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${sessionLifetimeSeconds}` });
}

async function signOut(request: Request, db: D1DatabaseLike, env: EmailSignInEnv): Promise<Response> {
  const token = sessionToken(request.headers);
  if (token) await db.prepare("UPDATE auth_browser_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(new Date(currentTime(env)).toISOString(), await sha256Hex(token)).run();
  return new Response(null, { status: 204, headers: { "set-cookie": `${sessionCookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` } });
}

// The configured owner email signs in to the owner workspace; every other address gets its own.
async function accountFor(db: D1DatabaseLike, env: EmailSignInEnv, email: string, capabilities: readonly string[], now: number): Promise<{ readonly tenantId: string; readonly principalId: string }> {
  const existing = await db.prepare("SELECT tenant_id, principal_id FROM auth_accounts WHERE email = ? LIMIT 1").bind(email).first<{ tenant_id: string; principal_id: string }>();
  if (existing) return { tenantId: existing.tenant_id, principalId: existing.principal_id };
  const owner = normalizeEmail(env.GFY_OWNER_ACCESS_EMAIL) === email;
  const tenantId = owner ? ownerTenantId(env) : "ws-" + randomHex(12);
  const timestamp = new Date(now).toISOString();
  const statements = [];
  const tenant = await db.prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first<{ id: string }>();
  if (!tenant) statements.push(...workspaceRows(db, tenantId, email, capabilities, timestamp));
  statements.push(db.prepare("INSERT INTO auth_accounts(email,tenant_id,principal_id,created_at) VALUES(?,?,?,?)").bind(email, tenantId, workspacePrincipalId, timestamp));
  if (!db.batch) throw new Error("Atomic account creation requires D1 batch");
  await db.batch(statements);
  return { tenantId, principalId: workspacePrincipalId };
}

function workspaceRows(db: D1DatabaseLike, tenantId: string, email: string, capabilities: readonly string[], timestamp: string) {
  return [
    db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").bind(tenantId, tenantId, "active", 1, tenantId + "-shard", "US", "{}"),
    db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").bind(tenantId, workspacePrincipalId, 1, timestamp, timestamp, "human", email, 1, 1),
    db.prepare("INSERT INTO roles(tenant_id,id,version,created_at,updated_at,name,capabilities_json) VALUES(?,?,?,?,?,?,?)").bind(tenantId, ownerRoleId, 1, timestamp, timestamp, "owner", JSON.stringify([...capabilities].sort())),
    db.prepare("INSERT INTO owner_access_grants(tenant_id,id,principal_id,resource_kind,resource_id,role_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(tenantId, ownerGrantId, workspacePrincipalId, "tenant", tenantId, ownerRoleId, ownerGrantExpiresAt, timestamp),
    db.prepare("INSERT INTO organization_namespaces(tenant_id,id,version,created_at,updated_at,name,description) VALUES(?,?,?,?,?,?,?)").bind(tenantId, workspaceNamespaceId, 1, timestamp, timestamp, workspaceNamespaceId, email)
  ];
}

// Resolves the browser session on a request; undefined when the request carries none.
export async function authenticateSession(headers: Headers, env: EmailSignInEnv, tenantId: string, capability: string): Promise<SessionCheck | undefined> {
  const token = sessionToken(headers);
  if (!token) return undefined;
  const db = env.GFY_DB ?? env.DB;
  if (!db) return { ok: false, status: 503, error: "gfy_auth_unconfigured" };
  const session = await db.prepare("SELECT tenant_id, principal_id FROM auth_browser_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1")
    .bind(await sha256Hex(token), new Date(currentTime(env)).toISOString()).first<{ tenant_id: string; principal_id: string }>();
  if (!session) return { ok: false, status: 401, error: "gfy_auth_invalid" };
  if (session.tenant_id !== tenantId) return { ok: false, status: 403, error: "gfy_permission_denied" };
  const granted = await workspaceGrant(db, tenantId, session.principal_id, capability, currentTime(env));
  return granted ? { ok: true, session: granted } : { ok: false, status: 403, error: "gfy_permission_denied" };
}

// The workspace owner's capabilities come from its owner grant and role.
export async function workspaceGrant(db: D1DatabaseLike, tenantId: string, principalId: string, capability: string, now: number): Promise<WorkspaceSession | undefined> {
  const tenant = await db.prepare("SELECT policy_epoch, state FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first<{ policy_epoch: number; state: string }>();
  if (!tenant || tenant.state !== "active") return undefined;
  const principal = await db.prepare("SELECT kind, active FROM principals WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, principalId).first<{ kind: string; active: number }>();
  if (!principal || principal.kind === "historical" || principal.active !== 1) return undefined;
  const grants = await db.prepare("SELECT g.id AS grant_id, r.capabilities_json AS capabilities_json, g.expires_at AS expires_at FROM owner_access_grants g JOIN roles r ON r.tenant_id = g.tenant_id AND r.id = g.role_id WHERE g.tenant_id = ? AND g.principal_id = ? AND g.resource_kind = 'tenant' AND g.resource_id = ?")
    .bind(tenantId, principalId, tenantId).all<{ grant_id: string; capabilities_json: string; expires_at: string }>();
  const scopes = new Set<string>();
  let grantRef: string | undefined;
  for (const row of grants.results ?? []) {
    if (Date.parse(row.expires_at) <= now) continue;
    const capabilities = parseStringArray(row.capabilities_json);
    for (const value of capabilities) scopes.add(value);
    if (capabilities.includes(capability)) grantRef ??= row.grant_id;
  }
  const kind = principal.kind as WorkspaceSession["kind"];
  return grantRef ? { tenantId, principalId, policyEpoch: tenant.policy_epoch, scopes: Array.from(scopes).sort(), grantRef, kind } : undefined;
}

export function sessionTenantId(headers: Headers, env: EmailSignInEnv): Promise<string | undefined> {
  const token = sessionToken(headers);
  const db = env.GFY_DB ?? env.DB;
  if (!token || !db) return Promise.resolve(undefined);
  return sha256Hex(token).then(hash => db.prepare("SELECT tenant_id FROM auth_browser_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1")
    .bind(hash, new Date(currentTime(env)).toISOString()).first<{ tenant_id: string }>()).then(row => row?.tenant_id);
}

// A sign-in arrives as the browser cookie or, from command-line and agent clients, as a bearer header.
function sessionToken(headers: Headers): string | undefined {
  const bearer = /^Bearer\s+(gfys_[A-Za-z0-9_-]{40,})$/u.exec(headers.get("authorization") ?? "")?.[1];
  if (bearer) return bearer;
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === sessionCookieName && value.length > 0 && value.join("=").length > 0) return value.join("=");
  }
  return undefined;
}

function ownerTenantId(env: EmailSignInEnv): string {
  const configured = env.GFY_OWNER_TENANT_ID;
  return typeof configured === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(configured) ? configured : "owner";
}
function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) ? email : undefined;
}
function sixDigitCode(): string {
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0]! >= limit);
  return String(value[0]! % 1_000_000).padStart(6, "0");
}
function currentTime(env: EmailSignInEnv): number { return (env.clock?.now() ?? new Date()).getTime() }
function codeSent(): Response { return new Response(codeSentBody, { status: 202, headers: { "content-type": "application/json" } }) }
function invalidCode(): Response { return json({ error: "invalid_code" }, 401) }
function json(body: unknown, status: number, headers: Record<string, string> = {}): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }) }
function randomHex(bytes: number): string { return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("") }
function randomBase64Url(bytes: number): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") }
function parseStringArray(value: string): readonly string[] { try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : [] } catch { return [] } }
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
