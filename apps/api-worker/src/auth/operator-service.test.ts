import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { verifyOperatorServiceRequest, type OperatorServiceAuthEnv } from "./operator-service.js";

type Jwk = JsonWebKey & { kid: string; alg: string };

const now = new Date("2026-10-08T00:00:00.000Z");
const issuer = "https://team.cloudflareaccess.com";
const audience = "operator-qualifier-app";
const clientId = "qualifier-client.access";
const clientSecret = "expected-secret-from-redacted-binding";
const jwksUrl = `${issuer}/cdn-cgi/access/certs`;

const baseEnv = (publicJwk: Jwk, secret?: string): OperatorServiceAuthEnv => ({
  GFY_AUTH_ISSUER: issuer,
  GFY_AUTH_AUDIENCE: audience,
  GFY_AUTH_JWKS_URL: jwksUrl,
  GFY_QUALIFIER_CLIENT_ID: clientId,
  ...(secret === undefined ? {} : { GFY_QUALIFIER_CLIENT_SECRET: secret }),
  clock: { now: () => now },
  jwksFetch: async (url) => {
    expect(url).toBe(jwksUrl);
    return Response.json({ keys: [publicJwk] });
  }
});

const requestWithJwt = (token: string, header: "authorization" | "assertion" = "authorization", extraHeaders: Record<string, string> = {}) => new Request("https://gitfoundry.test/operator", {
  headers: header === "authorization"
    ? { ...extraHeaders, authorization: `Bearer ${token}` }
    : { ...extraHeaders, "cf-access-jwt-assertion": token }
});
const requestWithServiceCredential = (headers: Record<string, string> = {}) => new Request("https://gitfoundry.test/operator", {
  headers: { "X-GitFoundry-Operator-Client-Id": clientId, "X-GitFoundry-Operator-Secret": clientSecret, ...headers }
});

describe("operator service Access JWT verifier", () => {
  it("fails closed when operator auth configuration is incomplete", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());

    const { GFY_QUALIFIER_CLIENT_ID: _clientId, ...missingClientId } = baseEnv(keys.publicJwk, clientSecret);
    await expect(verifyOperatorServiceRequest(requestWithJwt(token), missingClientId)).resolves.toMatchObject({ ok: false, status: 503, reason: "operator auth unconfigured" });
    await expect(verifyOperatorServiceRequest(requestWithServiceCredential(), baseEnv(keys.publicJwk))).resolves.toMatchObject({ ok: false, status: 401, reason: "service credential invalid" });
  });

  it("authorizes only a signed Cloudflare Access service token for the configured qualifier client", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());

    await expect(verifyOperatorServiceRequest(requestWithJwt(token), baseEnv(keys.publicJwk, clientSecret))).resolves.toEqual({
      ok: true,
      identity: { kind: "operator_service", issuer, audience, client_id: clientId }
    });
    await expect(verifyOperatorServiceRequest(requestWithJwt(token, "assertion"), baseEnv(keys.publicJwk, clientSecret))).resolves.toMatchObject({ ok: true });
  });

  it("accepts the documented Cloudflare service-token claims without nbf", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ nbf: undefined }));
    await expect(verifyOperatorServiceRequest(requestWithJwt(token), baseEnv(keys.publicJwk))).resolves.toMatchObject({ ok: true });
  });

  it("authorizes a configured service credential only through dedicated GitFoundry headers", async () => {
    const keys = await makeKeys("kid-a");
    const env = baseEnv(keys.publicJwk, clientSecret);

    await expect(verifyOperatorServiceRequest(requestWithServiceCredential(), env)).resolves.toEqual({
      ok: true,
      identity: { kind: "operator_service", issuer, audience, client_id: clientId }
    });
    await expect(verifyOperatorServiceRequest(new Request("https://gitfoundry.test/operator", {
      headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret }
    }), env)).resolves.toMatchObject({ ok: false, status: 401, reason: "service credential invalid" });
  });

  it("denies missing, wrong, oversized, or spoofed service credentials", async () => {
    const keys = await makeKeys("kid-a");
    const env = baseEnv(keys.publicJwk, clientSecret);
    const spoofedFlagEnv = { ...env, GFY_OPERATOR_TRUST_ACCESS_SERVICE_HEADERS: "true" } as OperatorServiceAuthEnv;
    const oversizedSecret = "s".repeat(4097);

    const cases: Array<[string, Request, OperatorServiceAuthEnv]> = [
      ["missing dedicated secret header", requestWithServiceCredential({ "X-GitFoundry-Operator-Secret": "" }), env],
      ["wrong dedicated secret", requestWithServiceCredential({ "X-GitFoundry-Operator-Secret": "wrong-secret" }), env],
      ["wrong dedicated client id", requestWithServiceCredential({ "X-GitFoundry-Operator-Client-Id": "wrong.access" }), env],
      ["client id only", new Request("https://gitfoundry.test/operator", { headers: { "X-GitFoundry-Operator-Client-Id": clientId } }), env],
      ["missing configured secret", requestWithServiceCredential(), baseEnv(keys.publicJwk)],
      ["empty configured secret", requestWithServiceCredential(), baseEnv(keys.publicJwk, "")],
      ["oversized incoming secret", requestWithServiceCredential({ "X-GitFoundry-Operator-Secret": oversizedSecret }), env],
      ["oversized configured secret", requestWithServiceCredential({ "X-GitFoundry-Operator-Secret": oversizedSecret }), baseEnv(keys.publicJwk, oversizedSecret)],
      ["spoofed env flag with CF headers", new Request("https://gitfoundry.test/operator", { headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret } }), spoofedFlagEnv]
    ];

    for (const [name, request, testEnv] of cases) {
      await expect(verifyOperatorServiceRequest(request, testEnv), name).resolves.toMatchObject({ ok: false, status: 401, reason: "service credential invalid" });
    }
  });

  it("never falls back to service credentials when a JWT is malformed or invalid", async () => {
    const keys = await makeKeys("kid-a");
    const trusted = baseEnv(keys.publicJwk, clientSecret);
    const attacker = await makeKeys("kid-a");
    const forged = await signJwt(attacker.privateKey, attacker.publicJwk.kid, serviceClaims());
    const serviceHeaders = { "X-GitFoundry-Operator-Client-Id": clientId, "X-GitFoundry-Operator-Secret": clientSecret };

    await expect(verifyOperatorServiceRequest(requestWithJwt("not-a-jwt", "authorization", serviceHeaders), trusted)).resolves.toMatchObject({ ok: false, status: 401, reason: "jwt must have exactly three parts" });
    await expect(verifyOperatorServiceRequest(requestWithJwt(forged, "authorization", serviceHeaders), trusted)).resolves.toMatchObject({ ok: false, status: 401, reason: "signature invalid" });
  });

  it("denies human or malformed service token shapes without trusting identity headers", async () => {
    const keys = await makeKeys("kid-a");
    const env = baseEnv(keys.publicJwk, clientSecret);
    const valid = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());

    const cases: Array<[string, string]> = [
      ["human-subject", await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ sub: "human-user" }))],
      ["wrong-type", await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ type: "org" }))],
      ["wrong-common-name", await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ common_name: "other-client.access" }))],
      ["empty-audience", await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ aud: [] }))],
      ["missing-iat", await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ iat: undefined }))],
      ["future-iat", await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ iat: seconds(now) + 60 }))],
      ["future-nbf", await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ nbf: seconds(now) + 60 }))],
      ["expired", await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ exp: seconds(now) - 1 }))],
      ["weak-alg", await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims(), { alg: "HS256" })],
      ["extra-segment", `${valid}.extra`]
    ];

    for (const [name, token] of cases) {
      await expect(verifyOperatorServiceRequest(requestWithJwt(token), env), name).resolves.toMatchObject({ ok: false, status: 401 });
    }
    await expect(verifyOperatorServiceRequest(new Request("https://gitfoundry.test/operator", { headers: { "CF-Access-Client-Id": clientId } }), env), "header-only identity").resolves.toMatchObject({ ok: false, status: 401, reason: "service credential invalid" });
  });

  it("denies forged signatures even when the key id matches", async () => {
    const trusted = await makeKeys("kid-a");
    const attacker = await makeKeys("kid-a");
    const forged = await signJwt(attacker.privateKey, attacker.publicJwk.kid, serviceClaims());

    await expect(verifyOperatorServiceRequest(requestWithJwt(forged), baseEnv(trusted.publicJwk, clientSecret))).resolves.toMatchObject({ ok: false, status: 401, reason: "signature invalid" });
  });

  it("verifies signed JWTs and dedicated service credentials inside actual installed workerd", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims({ nbf: undefined }));

    const jwtResponse = await runInWorkerd({ publicJwk: keys.publicJwk, headers: { authorization: `Bearer ${token}` }, clientSecret });
    expect(jwtResponse.status).toBe(200);
    expect(jwtResponse.body).toEqual({ ok: true, identity: { kind: "operator_service", issuer, audience, client_id: clientId } });

    const serviceResponse = await runInWorkerd({ publicJwk: keys.publicJwk, headers: { "X-GitFoundry-Operator-Client-Id": clientId, "X-GitFoundry-Operator-Secret": clientSecret }, clientSecret });
    expect(serviceResponse.status).toBe(200);
    expect(serviceResponse.body).toEqual({ ok: true, identity: { kind: "operator_service", issuer, audience, client_id: clientId } });

    const deniedResponse = await runInWorkerd({ publicJwk: keys.publicJwk, headers: { "X-GitFoundry-Operator-Client-Id": clientId, "X-GitFoundry-Operator-Secret": "wrong-secret" }, clientSecret });
    expect(deniedResponse.status).toBe(401);
    expect(deniedResponse.body).toMatchObject({ ok: false, reason: "service credential invalid" });
  }, 30_000);
});

function serviceClaims(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return cleanClaims({
    type: "app",
    iss: issuer,
    aud: [audience],
    exp: seconds(now) + 3600,
    nbf: seconds(now) - 60,
    iat: seconds(now) - 60,
    sub: "",
    common_name: clientId,
    ...overrides
  });
}

function cleanClaims(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined)) }
async function makeKeys(kid: string): Promise<{ privateKey: CryptoKey; publicJwk: Jwk }> { const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]); const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as Jwk; return { privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid, alg: "RS256" } } }
async function signJwt(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>, headerOverrides: Partial<Record<string, unknown>> = {}): Promise<string> { const header = encode({ alg: "RS256", typ: "JWT", kid, ...headerOverrides }); const payload = encode(claims); const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`)); return `${header}.${payload}.${base64Url(new Uint8Array(signature))}` }
function encode(value: unknown): string { return base64Url(new TextEncoder().encode(JSON.stringify(value))) }
function base64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") }
function seconds(date: Date): number { return Math.floor(date.getTime() / 1000) }

async function runInWorkerd(input: { publicJwk: Jwk; headers: Record<string, string>; clientSecret?: string }): Promise<{ status: number; body: unknown }> {
  const root = path.resolve(__dirname, "../../../..");
  const fixture = JSON.stringify({ ...input, issuer, audience, jwksUrl, clientId, now: now.toISOString() });
  const script = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = ${JSON.stringify(root)};
const fixture = JSON.parse(process.env.OPERATOR_FIXTURE ?? "{}");
const runtimeRoot = path.join(root, "node_modules/.pnpm/node_modules/@alchemy.run/cloudflare-runtime");
const effectRoot = path.join(root, "node_modules/.pnpm/effect@4.0.2/node_modules/effect/dist");
const platformNode = path.join(root, "node_modules/.pnpm/@effect+platform-node@4.0.2_effect@4.0.2_redis@6.3.0/node_modules/@effect/platform-node/dist/NodeServices.js");
const rolldownPackage = path.join(root, "node_modules/.pnpm/node_modules/rolldown/dist/index.mjs");
for (const file of [path.join(runtimeRoot, "dist/core/node/workerd/Workerd.mjs"), path.join(runtimeRoot, "dist/core/node/internal/internal-modules.mjs"), path.join(runtimeRoot, "dist/core/node/internal/internal-worker.mjs"), path.join(runtimeRoot, "dist/core/node/bindings/d1/D1Options.shared.mjs"), path.join(effectRoot, "Effect.js"), path.join(effectRoot, "Layer.js"), platformNode, rolldownPackage]) {
  if (fs.readFileSync(file).byteLength <= 0) throw new Error("runtime module missing");
}
const [Effect, Layer, NodeServices, Workerd, _internalModules, _internalWorker, _d1Options, { rolldown }] = await Promise.all([
  import(pathToFileURL(path.join(effectRoot, "Effect.js")).href),
  import(pathToFileURL(path.join(effectRoot, "Layer.js")).href),
  import(pathToFileURL(platformNode).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/workerd/Workerd.mjs")).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/internal/internal-modules.mjs")).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/internal/internal-worker.mjs")).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/bindings/d1/D1Options.shared.mjs")).href),
  import(pathToFileURL(rolldownPackage).href)
]);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitfoundry-operator-auth-"));
const wrapperPath = path.join(tempDir, "operator-wrapper.mjs");
fs.writeFileSync(wrapperPath, "import { verifyOperatorServiceRequest } from " + JSON.stringify(pathToFileURL(path.join(root, "apps/api-worker/src/auth/operator-service.ts")).href) + ";\\n" +
  "const jwks = " + JSON.stringify({ keys: [fixture.publicJwk] }) + ";\\n" +
  "const fixedNow = " + JSON.stringify(fixture.now) + ";\\n" +
  "globalThis.fetch = async () => Response.json(jwks);\\n" +
  "export default { async fetch(request, env) { const result = await verifyOperatorServiceRequest(request, { GFY_AUTH_ISSUER: env.GFY_AUTH_ISSUER, GFY_AUTH_AUDIENCE: env.GFY_AUTH_AUDIENCE, GFY_AUTH_JWKS_URL: env.GFY_AUTH_JWKS_URL, GFY_QUALIFIER_CLIENT_ID: env.GFY_QUALIFIER_CLIENT_ID, GFY_QUALIFIER_CLIENT_SECRET: env.GFY_QUALIFIER_CLIENT_SECRET, clock: { now: () => new Date(fixedNow) }, jwksFetch: async () => Response.json(jwks) }); return Response.json(result, { status: result.ok ? 200 : result.status }); } };");
const bundle = await rolldown({ input: wrapperPath });
const output = await bundle.generate({ format: "es", codeSplitting: false, sourcemap: false });
const chunk = output.output.find((item) => item.type === "chunk");
if (!chunk) throw new Error("operator verifier bundle missing");
const bindings = [{ name: "GFY_AUTH_ISSUER", text: fixture.issuer }, { name: "GFY_AUTH_AUDIENCE", text: fixture.audience }, { name: "GFY_AUTH_JWKS_URL", text: fixture.jwksUrl }, { name: "GFY_QUALIFIER_CLIENT_ID", text: fixture.clientId }];
if (fixture.clientSecret !== undefined) bindings.push({ name: "GFY_QUALIFIER_CLIENT_SECRET", text: fixture.clientSecret });
const services = Layer.provide(Workerd.WorkerdLive, NodeServices.layer);
const program = Effect.scoped(Effect.gen(function* () {
  const workerd = yield* Workerd.Workerd;
  const ports = yield* workerd.serve({
    sockets: [{ name: "http", address: "127.0.0.1:0", service: { name: "operator" } }],
    services: [
      { name: "operator", worker: { compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"], modules: [{ name: "index.js", esModule: chunk.code }], bindings } }
    ]
  });
  return yield* Effect.promise(async () => {
    const response = await fetch("http://127.0.0.1:" + ports.http + "/", { headers: fixture.headers, signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) };
  });
}));
console.log(JSON.stringify(await Effect.runPromise(Effect.provide(program, services))));
`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: { ...process.env, OPERATOR_FIXTURE: fixture }, encoding: "utf8", timeout: 30_000 })) as { status: number; body: unknown };
}
