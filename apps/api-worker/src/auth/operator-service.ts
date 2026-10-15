import { createHash, timingSafeEqual } from "node:crypto";

const MAX_SERVICE_CREDENTIAL_BYTES = 4096;
const operatorClientIdHeader = "x-gitfoundry-operator-client-id";
const operatorSecretHeader = "x-gitfoundry-operator-secret";

export interface OperatorServiceAuthEnv {
  readonly GFY_AUTH_ISSUER?: string;
  readonly GFY_AUTH_AUDIENCE?: string;
  readonly GFY_AUTH_JWKS_URL?: string;
  readonly GFY_QUALIFIER_CLIENT_ID?: string;
  readonly GFY_QUALIFIER_CLIENT_SECRET?: string;
  readonly jwksFetch?: typeof fetch;
  readonly clock?: { readonly now: () => Date };
}

export interface AuthorizedOperatorIdentity {
  readonly kind: "operator_service";
  readonly issuer: string;
  readonly audience: string;
  readonly client_id: string;
}

export type OperatorServiceAuthResult =
  | { readonly ok: true; readonly identity: AuthorizedOperatorIdentity }
  | { readonly ok: false; readonly status: 401 | 503; readonly reason: string };

interface OperatorClaims extends Readonly<Record<string, unknown>> {
  readonly type: "app";
  readonly iss: string;
  readonly sub: "";
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly nbf?: number;
  readonly common_name: string;
}

interface VerifiedOperatorConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly clientId: string;
}

export async function verifyOperatorServiceRequest(request: Request, env: OperatorServiceAuthEnv): Promise<OperatorServiceAuthResult> {
  const config = operatorConfig(env);
  if (!config.ok) return config;
  const token = accessTokenFromHeaders(request.headers);
  if (!token) return verifyOperatorSecretHeaders(request.headers, env, config.config);
  const verified = await verifyOperatorJwt(token, env, config.config);
  if (!verified.ok) return { ok: false, status: 401, reason: verified.reason };
  return operatorIdentity(config.config, verified.claims.common_name, verified.claims.iss);
}

function operatorConfig(env: OperatorServiceAuthEnv): { ok: true; config: VerifiedOperatorConfig } | { ok: false; status: 503; reason: string } {
  const issuer = env.GFY_AUTH_ISSUER;
  const audience = env.GFY_AUTH_AUDIENCE;
  const jwksUrl = env.GFY_AUTH_JWKS_URL;
  const clientId = env.GFY_QUALIFIER_CLIENT_ID;
  if (!issuer || !audience || !jwksUrl || !clientId) return { ok: false, status: 503, reason: "operator auth unconfigured" };
  return { ok: true, config: { issuer, audience, jwksUrl, clientId } };
}

function verifyOperatorSecretHeaders(headers: Headers, env: OperatorServiceAuthEnv, config: VerifiedOperatorConfig): OperatorServiceAuthResult {
  const configuredSecret = env.GFY_QUALIFIER_CLIENT_SECRET;
  const headerClientId = headers.get(operatorClientIdHeader);
  const headerSecret = headers.get(operatorSecretHeader);
  if (headerClientId !== config.clientId) return serviceCredentialInvalid();
  if (!isBoundedCredential(configuredSecret) || !isBoundedCredential(headerSecret)) return serviceCredentialInvalid();
  if (!secretMatches(headerSecret, configuredSecret)) return serviceCredentialInvalid();
  return operatorIdentity(config, config.clientId, config.issuer);
}

async function verifyOperatorJwt(token: string, env: OperatorServiceAuthEnv, config: VerifiedOperatorConfig): Promise<{ ok: true; claims: OperatorClaims } | { ok: false; reason: string }> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "jwt must have exactly three parts" };
    const [headerPart, payloadPart, signaturePart] = parts;
    if (!headerPart || !payloadPart || !signaturePart) return { ok: false, reason: "jwt must have exactly three parts" };
    const header = parseJwtHeader(JSON.parse(decodeBase64Url(headerPart)) as unknown);
    if (!header.ok) return header;
    const nowSeconds = Math.floor((env.clock?.now() ?? new Date()).getTime() / 1000);
    const claims = parseOperatorClaims(JSON.parse(decodeBase64Url(payloadPart)) as unknown, config, nowSeconds);
    if (!claims.ok) return claims;
    const jwksResponse = await (env.jwksFetch ?? fetch)(config.jwksUrl);
    if (!jwksResponse.ok) return { ok: false, reason: "jwks unavailable" };
    const jwks = await jwksResponse.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string }> };
    const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.alg === "RS256" && key.kty === "RSA");
    if (!jwk) return { ok: false, reason: "jwks key missing" };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signatureBytes = base64UrlBytes(signaturePart);
    const signature = new Uint8Array(signatureBytes).buffer;
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${headerPart}.${payloadPart}`));
    return valid ? { ok: true, claims: claims.claims } : { ok: false, reason: "signature invalid" };
  } catch {
    return { ok: false, reason: "jwt invalid" };
  }
}

function parseJwtHeader(value: unknown): { ok: true; alg: "RS256"; kid: string } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "jwt header must be an object" };
  const header = value as Record<string, unknown>;
  return header.alg === "RS256" && typeof header.kid === "string" && header.kid.length > 0 ? { ok: true, alg: "RS256", kid: header.kid } : { ok: false, reason: "unsupported jwt algorithm" };
}

function parseOperatorClaims(value: unknown, config: VerifiedOperatorConfig, nowSeconds: number): { ok: true; claims: OperatorClaims } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "jwt claims must be an object" };
  const claims = value as Record<string, unknown>;
  const iss = claims.iss;
  const sub = claims.sub;
  const exp = claims.exp;
  const nbf = claims.nbf;
  const iat = claims.iat;
  const type = claims.type;
  const commonName = claims.common_name;
  if (iss !== config.issuer || typeof iss !== "string" || iss.length === 0) return { ok: false, reason: "issuer mismatch" };
  if (type !== "app") return { ok: false, reason: "service token type required" };
  if (sub !== "") return { ok: false, reason: "service token subject required" };
  if (typeof commonName !== "string" || commonName !== config.clientId) return { ok: false, reason: "service token client mismatch" };
  if (typeof exp !== "number" || !Number.isInteger(exp) || !Number.isFinite(exp)) return { ok: false, reason: "exp missing" };
  if (exp <= nowSeconds) return { ok: false, reason: "token expired" };
  if (typeof iat !== "number" || !Number.isInteger(iat) || !Number.isFinite(iat) || iat < 0 || iat >= exp) return { ok: false, reason: "iat invalid" };
  if (iat > nowSeconds) return { ok: false, reason: "token issued in future" };
  if (nbf !== undefined && (typeof nbf !== "number" || !Number.isInteger(nbf) || !Number.isFinite(nbf))) return { ok: false, reason: "nbf invalid" };
  if (typeof nbf === "number" && nbf > nowSeconds) return { ok: false, reason: "token not yet valid" };
  const audiences = normalizeAudience(claims.aud);
  if (!audiences || !audiences.includes(config.audience)) return { ok: false, reason: "audience mismatch" };
  return { ok: true, claims: { ...claims, type: "app", iss, sub: "", aud: Array.isArray(claims.aud) ? [...audiences] : audiences[0] ?? config.audience, exp, iat, ...(nbf === undefined ? {} : { nbf }), common_name: commonName } as OperatorClaims };
}

function normalizeAudience(value: unknown): readonly string[] | undefined {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)) return value;
  return undefined;
}

function operatorIdentity(config: VerifiedOperatorConfig, clientId: string, issuer: string): { ok: true; identity: AuthorizedOperatorIdentity } {
  return { ok: true, identity: { kind: "operator_service", issuer, audience: config.audience, client_id: clientId } };
}

function serviceCredentialInvalid(): OperatorServiceAuthResult { return { ok: false, status: 401, reason: "service credential invalid" } }
function isBoundedCredential(value: string | null | undefined): value is string { return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= MAX_SERVICE_CREDENTIAL_BYTES }
function secretMatches(incoming: string, configured: string): boolean { const actual = createHash("sha256").update(incoming).digest(); const expected = createHash("sha256").update(configured).digest(); return actual.length === 32 && expected.length === 32 && timingSafeEqual(actual, expected) }
function accessTokenFromHeaders(headers: Headers): string | undefined { return authorizationToken(headers.get("authorization")) ?? assertionToken(headers.get("cf-access-jwt-assertion")) }
function authorizationToken(value: string | null | undefined): string | undefined { return /^Bearer (.+)$/i.exec(value ?? "")?.[1] }
function assertionToken(value: string | null | undefined): string | undefined { return value || undefined }
function decodeBase64Url(value: string): string { return new TextDecoder().decode(base64UrlBytes(value)) }
function base64UrlBytes(value: string): Uint8Array { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); const padded = normalized + "===".slice((normalized.length + 3) % 4); const binary = atob(padded); return Uint8Array.from(binary, (char) => char.charCodeAt(0)) }
