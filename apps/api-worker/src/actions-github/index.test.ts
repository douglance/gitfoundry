import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { handleGitHubActions, handleGitHubActionsEffect, makeGitHubActionsServicesLayer, mintRegistrationJwt, verifyRegistrationJwt, type GitHubActionsEnv, type GitHubActionsPorts } from "./index.js";
import type { ActionsStoragePointerPort, SnapshotPointer } from "./storage.js";

const now = new Date("2026-10-09T18:00:00.000Z");
const ownerTenant = "tenant-a";
const ownerRepository = "repo-a";
const repositoryName = "core/gitfoundry";
const sqliteBytes = new TextEncoder().encode("SQLite format 3\0fixture");

function rsaJwks() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey,
    privateJwk: pair.privateKey.export({ format: "jwk" }) as JsonWebKey,
    publicJwk: pair.publicKey.export({ format: "jwk" }) as JsonWebKey
  };
}

function baseEnv(extra: Partial<GitHubActionsEnv> = {}): GitHubActionsEnv {
  const registrationKeys = rsaJwks();
  const upstreamKeys = rsaJwks();
  return {
    GFY_ACTIONS_OWNER_TENANT_ID: ownerTenant,
    GFY_ACTIONS_OWNER_REPOSITORY_ID: ownerRepository,
    GFY_ACTIONS_OWNER_REPOSITORY: repositoryName,
    GFY_ACTIONS_PUBLIC_ORIGIN: "https://gitfoundry.dev/",
    GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN: "private-upstream-token",
    GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY: JSON.stringify(upstreamKeys.publicJwk),
    GFY_ACTIONS_REGISTRATION_JWT_PRIVATE_KEY: JSON.stringify(registrationKeys.privateJwk),
    GFY_ACTIONS_REGISTRATION_JWT_PUBLIC_KEY: JSON.stringify(registrationKeys.publicJwk),
    GFY_ACTIONS_STORAGE_TOKEN: "storage-token",
    GFY_ACTIONS_STORAGE_GENERATION: "generation-a",
    ...(extra as Partial<GitHubActionsEnv> & { upstreamPrivateKey?: unknown })
  };
}

function ports(extra: Partial<GitHubActionsPorts> = {}): GitHubActionsPorts {
  return {
    now: () => now,
    authenticateOwner: vi.fn(async () => ({ ok: true as const, actor_id: "owner" })),
    ...extra
  };
}

async function registrationToken(env = baseEnv()): Promise<string> {
  return (await mintRegistrationJwt(env, { tenantId: ownerTenant, repositoryId: ownerRepository, repository: repositoryName }, now)).token;
}

describe("GitHub Actions runner registration", () => {
  it("mints an owner-authorized short RemoteAuth registration token on the management route", async () => {
    const env = baseEnv();
    const response = await handleGitHubActions(new Request("https://gitfoundry.dev/api/v3/actions/runner-registration-token", { method: "POST" }), env, ports());

    expect(response?.status).toBe(201);
    const body = await response!.json() as { token: string; runner_server_url: string; registration_url: string; expires_at: string; token_type: string };
    expect(body.runner_server_url).toBe("https://gitfoundry.dev/runner/server");
    expect(body.registration_url).toBe("https://gitfoundry.dev/api/v3/actions/runner-registration");
    expect(body.token_type).toBe("RemoteAuth");
    expect(JSON.stringify(body)).not.toContain("private-upstream-token");
    await expect(verifyRegistrationJwt(env, body.token, { tenantId: ownerTenant, repositoryId: ownerRepository, repository: repositoryName }, now)).resolves.toMatchObject({ repository: repositoryName });
    await expect(verifyRegistrationJwt(env, body.token + "x", { tenantId: ownerTenant, repositoryId: ownerRepository, repository: repositoryName }, now)).resolves.toBeNull();
    await expect(verifyRegistrationJwt(env, body.token, { tenantId: ownerTenant, repositoryId: ownerRepository, repository: "core/other" }, now)).resolves.toBeNull();
    expect(new Date(body.expires_at).getTime()).toBe(now.getTime() + 600_000);
  });

  it("accepts official-shaped RemoteAuth registration and injects only the private upstream RemoteAuth token", async () => {
    const env = baseEnv();
    const token = await registrationToken(env);
    const proxyUpstream = vi.fn(async (upstream: Request) => Response.json({ auth: upstream.headers.get("authorization"), marker: upstream.headers.get("x-gitfoundry-actions-proxy"), body: await upstream.json() }));

    const response = await handleGitHubActions(new Request("https://gitfoundry.dev/api/v3/actions/runner-registration", { method: "POST", headers: { authorization: `RemoteAuth ${token}`, "content-type": "application/json" }, body: JSON.stringify({ Url: "https://gitfoundry.dev/runner/server", RunnerEvent: "Register", ignored: "nope" }) }), env, ports({ proxyUpstream }));

    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({ auth: "RemoteAuth private-upstream-token", marker: "registration", body: { Url: "https://gitfoundry.dev/runner/server", RunnerEvent: "Register" } });
    expect(proxyUpstream).toHaveBeenCalledTimes(1);
  });

  it("rejects owner token minting and RemoteAuth exchange when the relevant credential is invalid", async () => {
    const authResponse = Response.json({ error: "forbidden" }, { status: 403 });
    const ownerDenied = await handleGitHubActions(new Request("https://gitfoundry.dev/api/v3/actions/runner-registration-token", { method: "POST" }), baseEnv(), ports({ authenticateOwner: vi.fn(async () => ({ ok: false as const, response: authResponse })) }));
    const exchangeDenied = await handleGitHubActions(new Request("https://gitfoundry.dev/api/v3/actions/runner-registration", { method: "POST", headers: { authorization: "RemoteAuth bad" }, body: "{}" }), baseEnv(), ports());

    expect(ownerDenied?.status).toBe(403);
    expect(exchangeDenied?.status).toBe(401);
  });

  it("exposes typed Effect failures before the Promise compatibility wrapper", async () => {
    const program = handleGitHubActionsEffect(new Request("https://gitfoundry.dev/api/v3/actions/runner-registration-token", { method: "POST" }), baseEnv({ GFY_ACTIONS_OWNER_TENANT_ID: "INVALID TENANT" })).pipe(Effect.provide(makeGitHubActionsServicesLayer(ports())));

    await expect(Effect.runPromise(program)).rejects.toMatchObject({ _tag: "ActionsConfigurationError", message: "actions owner tenant invalid" });
  });
});

describe("GitHub Actions protocol proxy", () => {
  it("preserves upstream signed agent JWTs and does not replace them with RUNNER_TOKEN", async () => {
    const keys = rsaJwks();
    const env = baseEnv({ GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY: JSON.stringify(keys.publicJwk) });
    const token = signJwt(keys.privateKey, { exp: Math.floor(now.getTime() / 1000) + 600, sub: "agent" });
    const proxyUpstream = vi.fn(async (upstream: Request) => Response.json({ path: new URL(upstream.url).pathname, auth: upstream.headers.get("authorization"), marker: upstream.headers.get("x-gitfoundry-actions-proxy"), body: await upstream.text() }));

    const response = await handleGitHubActions(new Request("https://gitfoundry.dev/runner/server/_apis/v1/AgentSession/1", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" }), env, ports({ proxyUpstream }));

    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({ path: "/runner/server/_apis/v1/AgentSession/1", auth: `Bearer ${token}`, marker: "protocol", body: "{}" });
  });

  it("denies unsigned JWTs, wrong signatures, public scheduler routes, and broad dashboard routes", async () => {
    const keys = rsaJwks();
    const otherKeys = rsaJwks();
    const env = baseEnv({ GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY: JSON.stringify(keys.publicJwk) });
    const proxyUpstream = vi.fn(async () => Response.json({ ok: true }));
    const noAuth = await handleGitHubActions(new Request("https://gitfoundry.dev/_apis/v1/AgentSession/1", { method: "POST" }), env, ports({ proxyUpstream }));
    const unsigned = await handleGitHubActions(new Request("https://gitfoundry.dev/_apis/v1/AgentSession/1", { method: "POST", headers: { authorization: "Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.e30." } }), env, ports({ proxyUpstream }));
    const wrongSignature = await handleGitHubActions(new Request("https://gitfoundry.dev/_apis/v1/AgentSession/1", { method: "POST", headers: { authorization: `Bearer ${signJwt(otherKeys.privateKey, { exp: Math.floor(now.getTime() / 1000) + 600 })}` } }), env, ports({ proxyUpstream }));
    const schedule = await handleGitHubActions(new Request("https://gitfoundry.dev/runner/server/_apis/v1/Message/schedule2", { method: "POST", headers: { authorization: `Bearer ${signJwt(keys.privateKey, { exp: Math.floor(now.getTime() / 1000) + 600 })}` } }), env, ports({ proxyUpstream }));
    const dashboard = await handleGitHubActions(new Request("https://gitfoundry.dev/runner/server/_apis/v1/Message/workflow/runs", { method: "GET" }), env, ports({ proxyUpstream }));

    expect(noAuth?.status).toBe(401);
    expect(unsigned?.status).toBe(401);
    expect(wrongSignature?.status).toBe(401);
    expect(schedule?.status).toBe(404);
    expect(dashboard?.status).toBe(404);
    expect(proxyUpstream).not.toHaveBeenCalled();
  });

  it("allows only source-audited anonymous metadata and auth exchange routes", async () => {
    const proxyUpstream = vi.fn(async (upstream: Request) => Response.json({ path: new URL(upstream.url).pathname, method: upstream.method, auth: upstream.headers.get("authorization") }));
    const metadata = await handleGitHubActions(new Request("https://gitfoundry.dev/runner/server/_apis/connectionData"), baseEnv(), ports({ proxyUpstream }));
    const auth = await handleGitHubActions(new Request("https://gitfoundry.dev/runner/server/_apis/v1/auth", { method: "POST", body: "client_assertion=x" }), baseEnv(), ports({ proxyUpstream }));

    expect(metadata?.status).toBe(200);
    expect(auth?.status).toBe(200);
    await expect(metadata!.json()).resolves.toMatchObject({ path: "/runner/server/_apis/connectionData", auth: null });
    await expect(auth!.json()).resolves.toMatchObject({ path: "/runner/server/_apis/v1/auth", method: "POST" });
  });

  it("propagates request cancellation into native upstream fetch", async () => {
    let aborted = false;
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn((_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
      notifyStarted();
    })));
    try {
      const controller = new AbortController();
      const request = new Request("https://gitfoundry.dev/runner/server/_apis/connectionData", { signal: controller.signal });
      const pending = handleGitHubActions(request, baseEnv({ GFY_ACTIONS_UPSTREAM_ORIGIN: "https://pipelines.actions.githubusercontent.com" }), ports());
      await started;
      controller.abort();
      await expect(pending).rejects.toBeDefined();
      expect(aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not start upstream fetch for an already cancelled request", async () => {
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);
    try {
      const controller = new AbortController();
      controller.abort();
      const request = new Request("https://gitfoundry.dev/runner/server/_apis/connectionData", { signal: controller.signal });
      await expect(handleGitHubActions(request, baseEnv({ GFY_ACTIONS_UPSTREAM_ORIGIN: "https://pipelines.actions.githubusercontent.com" }), ports())).rejects.toBeDefined();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("GitHub Actions sqlite snapshot storage", () => {
  it("commits immutable snapshots through the pointer port only after R2 writes", async () => {
    const bucket = new FakeR2Bucket();
    const pointer = new FakePointerPort();
    const env = baseEnv({ GFY_ACTIONS_SQLITE_BUCKET: bucket as unknown as R2Bucket });
    const digest = sha256(sqliteBytes);
    const post = await handleGitHubActions(storageRequest("/sqlite/backups?generation=generation-a", { method: "POST", headers: { authorization: "Bearer storage-token", "x-gfy-actions-generation": "generation-a", "x-gfy-actions-sha256": digest }, body: sqliteBytes }), env, ports({ storagePointer: pointer }));

    expect(post?.status).toBe(201);
    expect(post?.headers.get("x-gfy-actions-sha256")).toBe(digest);
    expect(post?.headers.get("x-gfy-actions-pointer-version")).toBe(digest);
    expect(bucket.puts.map(call => call.key)).toEqual([`actions-github/sqlite/generation-a/${digest}.db`]);
    expect(pointer.pointer?.sha256).toBe(digest);

    const get = await handleGitHubActions(storageRequest("/sqlite/latest?generation=generation-a", { headers: { authorization: "Bearer storage-token" } }), env, ports({ storagePointer: pointer }));
    expect(get?.status).toBe(200);
    expect(get?.headers.get("x-gfy-actions-pointer-version")).toBe(digest);
    expect(new Uint8Array(await get!.arrayBuffer())).toEqual(sqliteBytes);

    const health = await handleGitHubActions(storageRequest("/health?generation=generation-a", { headers: { authorization: "Bearer storage-token" } }), env, ports({ storagePointer: pointer }));
    expect(health?.status).toBe(200);
    await expect(health!.json()).resolves.toEqual({ generation: "generation-a", pointer_version: digest, latest: { sha256: digest, bytes: sqliteBytes.byteLength, created_at: now.toISOString() } });
  });

  it("rejects stale generations, missing checksums, non-sqlite bytes, failed writes, corrupt pointers, and stale pointer versions", async () => {
    const bucket = new FakeR2Bucket();
    const pointer = new FakePointerPort();
    const env = baseEnv({ GFY_ACTIONS_SQLITE_BUCKET: bucket as unknown as R2Bucket, GFY_ACTIONS_STORAGE_MAX_BYTES: "32" });
    const stale = await handleGitHubActions(storageRequest("/sqlite/latest?generation=old", { headers: { authorization: "Bearer storage-token" } }), env, ports({ storagePointer: pointer }));
    const missingSha = await handleGitHubActions(storageRequest("/sqlite/backups?generation=generation-a", { method: "POST", headers: { authorization: "Bearer storage-token" }, body: sqliteBytes }), env, ports({ storagePointer: pointer }));
    const notSqlite = await handleGitHubActions(storageRequest("/sqlite/backups?generation=generation-a", { method: "POST", headers: { authorization: "Bearer storage-token", "x-gfy-actions-sha256": sha256("not-db") }, body: "not-db" }), env, ports({ storagePointer: pointer }));
    bucket.failPuts = true;
    const failed = await handleGitHubActions(storageRequest("/sqlite/backups?generation=generation-a", { method: "POST", headers: { authorization: "Bearer storage-token", "x-gfy-actions-sha256": sha256(sqliteBytes) }, body: sqliteBytes }), env, ports({ storagePointer: pointer }));
    expect(failed?.status).toBe(503);
    expect(pointer.commits).toBe(0);
    expect(pointer.pointer).toBeNull();
    expect(pointer.version).toBeNull();
    bucket.failPuts = false;
    pointer.failRead = true;
    const corruptPointer = await handleGitHubActions(storageRequest("/sqlite/latest?generation=generation-a", { headers: { authorization: "Bearer storage-token" } }), env, ports({ storagePointer: pointer }));
    pointer.failRead = false;
    pointer.forceStale = true;
    const staleCommit = await handleGitHubActions(storageRequest("/sqlite/backups?generation=generation-a", { method: "POST", headers: { authorization: "Bearer storage-token", "x-gfy-actions-sha256": sha256(sqliteBytes) }, body: sqliteBytes }), env, ports({ storagePointer: pointer }));

    expect(stale?.status).toBe(409);
    expect(missingSha?.status).toBe(400);
    expect(notSqlite?.status).toBe(400);
    expect(corruptPointer?.status).toBe(503);
    expect(staleCommit?.status).toBe(409);
    expect(pointer.commits).toBe(1);
    expect(pointer.pointer).toBeNull();
    expect(pointer.version).toBeNull();
  });

  it("returns pointer versions on empty latest reads when a port has an external CAS token", async () => {
    const bucket = new FakeR2Bucket();
    const pointer = new FakePointerPort();
    pointer.version = "external-version";
    const response = await handleGitHubActions(storageRequest("/sqlite/latest?generation=generation-a", { headers: { authorization: "Bearer storage-token" } }), baseEnv({ GFY_ACTIONS_SQLITE_BUCKET: bucket as unknown as R2Bucket }), ports({ storagePointer: pointer }));

    expect(response?.status).toBe(204);
    expect(response?.headers.get("x-gfy-actions-pointer-version")).toBe("external-version");
  });

  it("does not intercept public health routes outside the internal storage prefix", async () => {
    const response = await handleGitHubActions(new Request("https://gitfoundry.dev/health?generation=generation-a", { headers: { authorization: "Bearer storage-token" } }), baseEnv({ GFY_ACTIONS_SQLITE_BUCKET: new FakeR2Bucket() as unknown as R2Bucket }), ports());

    expect(response).toBeUndefined();
  });
});

function storageRequest(path: string, init: RequestInit): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("content-length") && init.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") headers.set("content-length", String(new TextEncoder().encode(init.body).byteLength));
    else if (init.body instanceof Uint8Array) headers.set("content-length", String(init.body.byteLength));
  }
  return new Request(`https://gitfoundry.dev/__internal/actions-github/storage${path}`, { ...init, headers });
}
function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function signJwt(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = Buffer.from(createSign("RSA-SHA256").update(signingInput).end().sign(privateKey)).toString("base64url");
  return `${signingInput}.${signature}`;
}

class FakeR2Object {
  readonly size: number;
  readonly checksums: { readonly sha256: ArrayBuffer };

  constructor(readonly bytes: Uint8Array) {
    this.size = bytes.byteLength;
    this.checksums = { sha256: digestBytes(bytes) };
  }

  get body(): ReadableStream<Uint8Array> {
    const bytes = new Uint8Array(this.bytes);
    return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }

  async arrayBuffer(): Promise<ArrayBuffer> { return new Uint8Array(this.bytes).buffer; }
  async text(): Promise<string> { return new TextDecoder().decode(this.bytes); }
}

class FakeR2Bucket {
  readonly objects = new Map<string, FakeR2Object>();
  readonly puts: Array<{ key: string }> = [];
  failPuts = false;

  async get(key: string): Promise<FakeR2Object | null> { return this.objects.get(key) ?? null; }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>, options?: { sha256?: string | ArrayBuffer | ArrayBufferView }): Promise<void> {
    if (this.failPuts) throw new Error("put failed");
    const bytes = await bytesFromPutValue(value);
    if (options?.sha256 && sha256(bytes) !== checksumHex(options.sha256)) {
      const error = new Error("checksum mismatch");
      error.name = "R2ChecksumMismatch";
      throw error;
    }
    this.objects.set(key, new FakeR2Object(new Uint8Array(bytes)));
    this.puts.push({ key });
  }
}

function digestBytes(bytes: Uint8Array): ArrayBuffer {
  const digest = createHash("sha256").update(bytes).digest();
  const out = new Uint8Array(digest.byteLength);
  out.set(digest);
  return out.buffer;
}

function checksumHex(value: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof value === "string") return value;
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(bytes).toString("hex");
}

async function bytesFromPutValue(value: string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = value.getReader();
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

class FakePointerPort implements ActionsStoragePointerPort {
  pointer: SnapshotPointer | null = null;
  version: string | null = null;
  failRead = false;
  forceStale = false;
  commits = 0;

  async read(): Promise<{ pointer: SnapshotPointer | null; version: string | null }> {
    if (this.failRead) throw new Error("pointer corrupt");
    return { pointer: this.pointer, version: this.version };
  }

  async commit(input: { pointer: SnapshotPointer; expected_version: string | null }): Promise<{ ok: true; version: string } | { ok: false; reason: "stale" }> {
    this.commits += 1;
    if (this.forceStale || input.expected_version !== this.version) return { ok: false, reason: "stale" };
    this.pointer = input.pointer;
    this.version = input.pointer.sha256;
    return { ok: true, version: this.version };
  }
}
