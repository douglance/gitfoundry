const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RegistrationScope {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly repository: string;
}

export interface RegistrationJwtEnv {
  readonly GFY_ACTIONS_REGISTRATION_ISSUER?: string;
  readonly GFY_ACTIONS_REGISTRATION_AUDIENCE?: string;
  readonly GFY_ACTIONS_REGISTRATION_TTL_SECONDS?: string;
  readonly GFY_ACTIONS_REGISTRATION_JWT_PRIVATE_KEY?: string;
  readonly GFY_ACTIONS_REGISTRATION_JWT_PUBLIC_KEY?: string;
}

export interface RegistrationClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly tenant_id: string;
  readonly repository_id: string;
  readonly repository: string;
  readonly iat: number;
  readonly exp: number;
}

const issuerDefault = "gitfoundry-actions";
const audienceDefault = "gitfoundry-actions-runner-registration";
const ttlDefault = 600;

export async function mintRegistrationJwt(env: RegistrationJwtEnv, scope: RegistrationScope, now: Date): Promise<{ readonly token: string; readonly expires_at: string }> {
  const privateKey = await importPrivateKey(env);
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttl = ttlSeconds(env);
  const claims: RegistrationClaims = {
    iss: issuer(env),
    aud: audience(env),
    sub: scope.repository,
    tenant_id: scope.tenantId,
    repository_id: scope.repositoryId,
    repository: scope.repository,
    iat: issuedAt,
    exp: issuedAt + ttl
  };
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(signingInput));
  return { token: `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`, expires_at: new Date(claims.exp * 1000).toISOString() };
}

export async function verifyRegistrationJwt(env: RegistrationJwtEnv, token: string, expected: RegistrationScope, now: Date): Promise<RegistrationClaims | null> {
  const parts = token.split(".");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (parts.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature) return null;
  let header: Record<string, unknown>;
  let claims: RegistrationClaims;
  try {
    header = JSON.parse(decoder.decode(fromBase64Url(encodedHeader))) as Record<string, unknown>;
    claims = JSON.parse(decoder.decode(fromBase64Url(encodedClaims))) as RegistrationClaims;
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || header.typ !== "JWT") return null;
  if (claims.iss !== issuer(env) || claims.aud !== audience(env)) return null;
  if (claims.tenant_id !== expected.tenantId || claims.repository_id !== expected.repositoryId || claims.repository !== expected.repository || claims.sub !== expected.repository) return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds || claims.iat > nowSeconds + 60) return null;
  const publicKey = await importPublicKey(env);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, fromBase64Url(encodedSignature), encoder.encode(`${encodedHeader}.${encodedClaims}`));
  return ok ? claims : null;
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] ?? null;
}

function issuer(env: RegistrationJwtEnv): string { return env.GFY_ACTIONS_REGISTRATION_ISSUER || issuerDefault; }
function audience(env: RegistrationJwtEnv): string { return env.GFY_ACTIONS_REGISTRATION_AUDIENCE || audienceDefault; }
function ttlSeconds(env: RegistrationJwtEnv): number {
  const parsed = Number.parseInt(env.GFY_ACTIONS_REGISTRATION_TTL_SECONDS || "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 60 && parsed <= 3600 ? parsed : ttlDefault;
}

async function importPrivateKey(env: RegistrationJwtEnv): Promise<CryptoKey> {
  const value = env.GFY_ACTIONS_REGISTRATION_JWT_PRIVATE_KEY;
  if (!value) throw new Error("actions registration private key missing");
  const jwk = parseJwk(value);
  if (jwk) return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.importKey("pkcs8", pemToDer(value), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function importPublicKey(env: RegistrationJwtEnv): Promise<CryptoKey> {
  const configured = env.GFY_ACTIONS_REGISTRATION_JWT_PUBLIC_KEY;
  const jwk = parseJwk(configured || env.GFY_ACTIONS_REGISTRATION_JWT_PRIVATE_KEY || "");
  if (jwk) {
    const publicJwk = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true } as JsonWebKey;
    return crypto.subtle.importKey("jwk", publicJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  if (!configured) throw new Error("actions registration public key missing");
  return crypto.subtle.importKey("spki", pemToDer(configured), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

function parseJwk(value: string): JsonWebKey | null {
  try {
    const parsed = JSON.parse(value) as JsonWebKey;
    return parsed && parsed.kty === "RSA" && typeof parsed.n === "string" && typeof parsed.e === "string" ? parsed : null;
  } catch { return null; }
}

function pemToDer(value: string): ArrayBuffer {
  const base64 = value.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  return fromBase64(base64);
}

function base64UrlJson(value: unknown): string { return base64UrlBytes(encoder.encode(JSON.stringify(value))); }
function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> { return new Uint8Array(fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"))); }
function fromBase64(value: string): ArrayBuffer {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
