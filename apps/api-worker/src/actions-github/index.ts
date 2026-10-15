import { Effect } from "effect";

import { ActionsConfigurationError, ActionsRegistrationExchangeError, ActionsUpstreamProxyError, errorMessage, type GitHubActionsError } from "./errors.js";
import { bearerToken, mintRegistrationJwt, verifyRegistrationJwt, type RegistrationJwtEnv, type RegistrationScope } from "./jwt.js";
import { GitHubActionsServices, makeGitHubActionsServicesLayer } from "./services.js";
import { handleActionsStorage, handleActionsStorageEffect, type ActionsStorageEnv, type ActionsStoragePointerPort } from "./storage.js";

export interface GitHubActionsEnv extends RegistrationJwtEnv, ActionsStorageEnv {
  readonly GFY_ACTIONS_OWNER_TENANT_ID?: string;
  readonly GFY_ACTIONS_OWNER_REPOSITORY_ID?: string;
  readonly GFY_ACTIONS_OWNER_REPOSITORY?: string;
  readonly GFY_ACTIONS_PUBLIC_ORIGIN?: string;
  readonly GFY_ACTIONS_UPSTREAM_ORIGIN?: string;
  readonly GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN?: string;
  readonly GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY?: string;
}

export interface GitHubActionsPorts {
  authenticateOwner(input: { readonly request: Request; readonly tenant_id: string; readonly repository_id: string; readonly capability: "actions:runner-registration" }): Promise<{ readonly ok: true; readonly actor_id: string } | { readonly ok: false; readonly response: Response }>;
  proxyUpstream?(request: Request): Promise<Response>;
  storagePointer?: ActionsStoragePointerPort;
  now?(): Date;
}

type ProtocolAuth = "none" | "upstream-jwt";
type ProtocolPolicy = { readonly auth: ProtocolAuth } | { readonly denied: true } | undefined;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function handleGitHubActionsEffect(request: Request, env: GitHubActionsEnv): Effect.Effect<Response | undefined, GitHubActionsError, GitHubActionsServices> {
  return Effect.gen(function* () {
    const services = yield* GitHubActionsServices;
    const storage = yield* handleActionsStorageEffect(request, env, services.storagePointer, () => Effect.runSync(services.now));
    if (storage) return storage;
    const url = new URL(request.url);
    if (url.pathname === "/api/v3/actions/runner-registration-token") return yield* mintOwnerRegistrationToken(request, env);
    if (url.pathname === "/api/v3/actions/runner-registration") return yield* exchangeRunnerRegistration(request, env);
    const policy = protocolPolicy(url.pathname, request.method);
    if (policy && "denied" in policy) return Response.json({ error: "route_not_available" }, { status: 404 });
    if (policy) return yield* proxyProtocol(request, env, policy.auth);
    if (url.pathname.startsWith("/api/v3/actions/") || url.pathname.startsWith("/_apis/") || url.pathname.startsWith("/runner/server")) return Response.json({ error: "route_not_available" }, { status: 404 });
    return undefined;
  });
}

export async function handleGitHubActions(request: Request, env: GitHubActionsEnv, ports: GitHubActionsPorts): Promise<Response | undefined> {
  return Effect.runPromise(handleGitHubActionsEffect(request, env).pipe(Effect.provide(makeGitHubActionsServicesLayer(ports))), { signal: request.signal });
}

export interface GitHubActionsSchedulePort {
  schedule(input: { readonly repository: string; readonly event: string; readonly payload: unknown }): Promise<{ readonly id: string }>;
}

export async function scheduleGitHubActionsRun(port: GitHubActionsSchedulePort, input: { readonly repository: string; readonly event: string; readonly payload: unknown }): Promise<{ readonly id: string }> {
  return port.schedule(input);
}

function mintOwnerRegistrationToken(request: Request, env: GitHubActionsEnv): Effect.Effect<Response, GitHubActionsError, GitHubActionsServices> {
  return Effect.gen(function* () {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const services = yield* GitHubActionsServices;
    const scope = yield* configuredScopeEffect(env);
    const auth = yield* services.authenticateOwner({ request, tenant_id: scope.tenantId, repository_id: scope.repositoryId, capability: "actions:runner-registration" });
    if (!auth.ok) return auth.response;
    const now = yield* services.now;
    const registration = yield* Effect.tryPromise({
      try: () => mintRegistrationJwt(env, scope, now),
      catch: (cause) => new ActionsConfigurationError({ message: errorMessage(cause, "actions registration token mint failed"), cause })
    });
    const origin = publicOrigin(request, env);
    return Response.json({
      schema_version: 1,
      repository: scope.repository,
      runner_server_url: new URL("/runner/server", origin).toString(),
      registration_url: new URL("/api/v3/actions/runner-registration", origin).toString(),
      token_type: "RemoteAuth",
      token: registration.token,
      expires_at: registration.expires_at
    }, { status: 201 });
  });
}

function exchangeRunnerRegistration(request: Request, env: GitHubActionsEnv): Effect.Effect<Response, GitHubActionsError, GitHubActionsServices> {
  return Effect.gen(function* () {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const token = remoteAuthToken(request);
    const scope = yield* configuredScopeEffect(env);
    const services = yield* GitHubActionsServices;
    const now = yield* services.now;
    const claims = token ? yield* Effect.tryPromise({
      try: () => verifyRegistrationJwt(env, token, scope, now),
      catch: (cause) => new ActionsConfigurationError({ message: errorMessage(cause, "actions registration token verify failed"), cause })
    }) : null;
    if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });
    const upstream = yield* upstreamRegistrationRequest(request, env);
    if (upstream instanceof Response) return upstream;
    return yield* proxyOrFetch(upstream, env);
  });
}

function proxyProtocol(request: Request, env: GitHubActionsEnv, auth: ProtocolAuth): Effect.Effect<Response, GitHubActionsError, GitHubActionsServices> {
  return Effect.gen(function* () {
    const services = yield* GitHubActionsServices;
    const now = yield* services.now;
    if (auth === "upstream-jwt" && !(yield* verifyUpstreamBearerJwt(request, env, now))) return Response.json({ error: "unauthorized" }, { status: 401 });
    return yield* proxyOrFetch(yield* preserveRequest(request), env);
  });
}

function proxyOrFetch(request: Request, env: GitHubActionsEnv): Effect.Effect<Response, ActionsUpstreamProxyError, GitHubActionsServices> {
  return Effect.gen(function* () {
    const services = yield* GitHubActionsServices;
    return yield* services.proxyUpstream(request, env.GFY_ACTIONS_UPSTREAM_ORIGIN);
  });
}

function upstreamRegistrationRequest(request: Request, env: GitHubActionsEnv): Effect.Effect<Request | Response, ActionsConfigurationError | ActionsRegistrationExchangeError> {
  return Effect.tryPromise({
    try: async () => {
      const token = env.GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN;
      if (!token) throw new ActionsConfigurationError({ message: "actions upstream runner token missing" });
      const parsed = await request.json().catch(() => null) as unknown;
      if (!isRegistrationExchangeBody(parsed)) return Response.json({ error: "registration_body_invalid" }, { status: 400 });
      const headers = new Headers(request.headers);
      headers.set("authorization", `RemoteAuth ${token}`);
      headers.set("content-type", "application/json");
      headers.set("x-gitfoundry-actions-proxy", "registration");
      headers.delete("content-length");
      headers.delete("cookie");
      return new Request(request.url, { method: request.method, headers, body: JSON.stringify({ Url: parsed.Url, RunnerEvent: parsed.RunnerEvent }), redirect: "manual" });
    },
    catch: (cause) => cause instanceof ActionsConfigurationError ? cause : new ActionsRegistrationExchangeError({ message: errorMessage(cause, "actions registration exchange body failed"), cause })
  });
}

function preserveRequest(request: Request): Effect.Effect<Request, ActionsRegistrationExchangeError> {
  return Effect.tryPromise({
    try: async () => {
      const headers = new Headers(request.headers);
      headers.set("x-gitfoundry-actions-proxy", "protocol");
      headers.delete("cookie");
      const init: RequestInit = { method: request.method, headers, redirect: "manual" };
      if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
      return new Request(request.url, init);
    },
    catch: (cause) => new ActionsRegistrationExchangeError({ message: errorMessage(cause, "actions protocol request copy failed"), cause })
  });
}

function verifyUpstreamBearerJwt(request: Request, env: GitHubActionsEnv, now: Date): Effect.Effect<boolean> {
  return Effect.promise(async () => {
    try {
      const token = bearerToken(request);
      if (!token || !env.GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY) return false;
      const parts = token.split(".");
      const [encodedHeader, encodedClaims, encodedSignature] = parts;
      if (parts.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature) return false;
      const header = JSON.parse(decoder.decode(fromBase64Url(encodedHeader))) as Record<string, unknown>;
      const claims = JSON.parse(decoder.decode(fromBase64Url(encodedClaims))) as Record<string, unknown>;
      if (header.alg !== "RS256") return false;
      const exp = typeof claims.exp === "number" ? claims.exp : null;
      const nbf = typeof claims.nbf === "number" ? claims.nbf : null;
      const seconds = Math.floor(now.getTime() / 1000);
      if (exp !== null && exp <= seconds) return false;
      if (nbf !== null && nbf > seconds + 60) return false;
      const key = await importRsaPublicKey(env.GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY);
      return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64Url(encodedSignature), encoder.encode(`${encodedHeader}.${encodedClaims}`));
    } catch {
      return false;
    }
  });
}

function remoteAuthToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const match = /^RemoteAuth\s+(.+)$/i.exec(value);
  return match?.[1] ?? null;
}

function configuredScopeEffect(env: GitHubActionsEnv): Effect.Effect<RegistrationScope, ActionsConfigurationError> {
  return Effect.try({
    try: () => configuredScope(env),
    catch: (cause) => new ActionsConfigurationError({ message: errorMessage(cause, "actions owner scope invalid"), cause })
  });
}

function configuredScope(env: GitHubActionsEnv): RegistrationScope {
  const tenantId = requiredId(env.GFY_ACTIONS_OWNER_TENANT_ID, "actions owner tenant");
  const repositoryId = requiredId(env.GFY_ACTIONS_OWNER_REPOSITORY_ID, "actions owner repository");
  const repository = env.GFY_ACTIONS_OWNER_REPOSITORY || "core/gitfoundry";
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new Error("actions owner repository name invalid");
  return { tenantId, repositoryId, repository };
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} invalid`);
  return value;
}
function publicOrigin(request: Request, env: GitHubActionsEnv): string {
  const configured = env.GFY_ACTIONS_PUBLIC_ORIGIN;
  if (configured) return new URL(configured).toString();
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/`;
}

function protocolPolicy(pathname: string, method: string): ProtocolPolicy {
  const path = stripRunnerServerPrefix(pathname);
  const normalized = path.toLowerCase();
  if (method === "GET" && path === "/runner/server") return { auth: "none" };
  if (method === "GET" && /^\/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)?_apis\/connectiondata$/i.test(path)) return { auth: "none" };
  if (method === "POST" && /^\/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)?_apis\/v1\/auth$/i.test(path)) return { auth: "none" };
  if (/\/_apis\/v1\/message(?:\/schedule2)?$/i.test(path) && method === "POST") return { denied: true };
  if (normalized.includes("dashboard") || normalized.includes("workflow/run") || normalized.includes("rerun") || normalized.includes("cancel")) return { denied: true };
  if (/^\/(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)?_apis\/v1\/(agentpools|agentsession\/[^/]+|agentrequest\/[^/]+\/[^/]+|message\/[^/]+|finishjob\/[^/]+\/[^/]+\/[^/]+|timeline(?:\/.*)?|logfiles(?:\/.*)?|tasks(?:\/.*)?)$/i.test(path)) return { auth: "upstream-jwt" };
  return undefined;
}
function stripRunnerServerPrefix(pathname: string): string { return pathname.startsWith("/runner/server/") ? pathname.slice("/runner/server".length) : pathname; }

function isRegistrationExchangeBody(value: unknown): value is { readonly Url: string; readonly RunnerEvent: string } {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.Url === "string" && body.Url.length > 0 && typeof body.RunnerEvent === "string" && body.RunnerEvent.length > 0;
}

async function importRsaPublicKey(value: string): Promise<CryptoKey> {
  const parsed = parseJwk(value);
  if (parsed) return crypto.subtle.importKey("jwk", parsed, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.importKey("spki", pemToDer(value), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}
function parseJwk(value: string): JsonWebKey | null {
  try { const jwk = JSON.parse(value) as JsonWebKey; return jwk?.kty === "RSA" && typeof jwk.n === "string" && typeof jwk.e === "string" ? { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true } : null; } catch { return null; }
}
function pemToDer(value: string): ArrayBuffer {
  const base64 = value.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  return fromBase64(base64);
}
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> { return new Uint8Array(fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"))); }
function fromBase64(value: string): ArrayBuffer {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
export { handleActionsStorage } from "./storage.js";
export { mintRegistrationJwt, verifyRegistrationJwt } from "./jwt.js";
export { GitHubActionsServices, makeGitHubActionsServices, makeGitHubActionsServicesLayer } from "./services.js";
export * from "./errors.js";
