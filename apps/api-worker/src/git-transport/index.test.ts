import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";
import { artifactsRepositoryIdentity, type ArtifactsBinding, type WorkersArtifactsCreateTokenResult, type WorkersArtifactsRepoInfo } from "../git-provider.js";
import { handleGitTransportRequest } from "./index.js";

const timestamp = "2026-10-08T00:00:00.000Z";
const namespace = "gitfoundry-staging";
const name = "stored-provider-name";

class SqliteD1 implements D1DatabaseLike {
  readonly db = new DatabaseSync(":memory:");

  prepare<T = Record<string, unknown>>(sql: string): D1PreparedStatement<T> {
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

class FakeRepo {
  readonly tokenCalls: Array<{ scope: "read" | "write" | undefined; ttl: number | undefined }> = [];
  readonly revokedTokens: string[] = [];
  disposed = false;
  infoValue: WorkersArtifactsRepoInfo = repoInfo(namespace, name);
  nextToken: WorkersArtifactsCreateTokenResult = tokenResult("token-1", "read-token");
  nextRevokeResult = true;
  revokeError: Error | undefined;
  disposeError: Error | undefined;

  async info(): Promise<WorkersArtifactsRepoInfo> { return this.infoValue }
  async createToken(scope?: "read" | "write", ttl?: number): Promise<WorkersArtifactsCreateTokenResult> {
    this.tokenCalls.push({ scope, ttl });
    return this.nextToken;
  }
  async revokeToken(token: string): Promise<boolean> {
    this.revokedTokens.push(token);
    if (this.revokeError) throw this.revokeError;
    return this.nextRevokeResult;
  }
  [Symbol.dispose](): void {
    this.disposed = true;
    if (this.disposeError) throw this.disposeError;
  }
}

class DisposeSensitiveRepo extends FakeRepo {
  async revokeToken(token: string): Promise<boolean> {
    if (this.disposed) throw new Error("disposed before revoke");
    return await super.revokeToken(token);
  }
}

class FakeArtifacts {
  readonly getCalls: string[] = [];
  readonly repos = new Map<string, FakeRepo>();
  async get(repoName: string): Promise<FakeRepo> {
    this.getCalls.push(repoName);
    const repo = this.repos.get(repoName);
    if (!repo) throw new Error(`missing repo ${repoName} provider-secret`);
    return repo;
  }
  async create(): Promise<never> { throw new Error("create not used") }
  async list(): Promise<{ repos: []; total: number }> { return { repos: [], total: 0 } }
}

interface FetchCall { readonly url: string; readonly init: RequestInit & { readonly duplex?: "half" } }

class Harness {
  readonly sql = fixture();
  readonly repo = new FakeRepo();
  readonly artifacts = new FakeArtifacts();
  readonly authorizeCalls: Array<{ tenantId: string; capability: "repository.read" | "repository.write"; authorization: string | null }> = [];
  readonly fetchCalls: FetchCall[] = [];
  readonly waitUntilPromises: Promise<unknown>[] = [];
  upstream = new Response(streamFrom(["001e# service=git-upload-pack\n", "0000PACK"]), { status: 200, headers: { "cache-control": "public, max-age=600", "content-type": "application/x-git-upload-pack-advertisement", "set-cookie": "secret=provider", "x-secret": "hidden" } });
  deny = false;

  constructor() { this.artifacts.repos.set(name, this.repo) }

  env() { return { GFY_DB: this.sql, GFY_GIT: this.artifacts as unknown as ArtifactsBinding, GFY_GIT_NAMESPACE: namespace } }
  deps() {
    return {
      authorize: async (request: Request, tenantId: string, capability: "repository.read" | "repository.write") => {
        this.authorizeCalls.push({ tenantId, capability, authorization: request.headers.get("authorization") });
        return this.deny ? new Response("denied", { status: 403 }) : undefined;
      },
      originFetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        this.fetchCalls.push({ url: String(url), init: init as FetchCall["init"] });
        return this.upstream;
      },
      waitUntil: (promise: Promise<unknown>) => { this.waitUntilPromises.push(promise) }
    };
  }
}

describe("Git transport", () => {
  it("returns undefined for non-git paths", async () => {
    const h = new Harness();
    await expect(handleGitTransportRequest(new Request("https://gitfoundry.example/health"), h.env(), h.deps())).resolves.toBeUndefined();
    expect(h.authorizeCalls).toEqual([]);
    expect(h.artifacts.getCalls).toEqual([]);
  });

  it("proxies info refs with a scoped read token and strips caller credentials", async () => {
    const h = new Harness();
    const request = new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`, { headers: { authorization: "Bearer caller-jwt", cookie: "sid=secret", "git-protocol": "version=2", accept: "application/x-git-upload-pack-advertisement" } });

    const response = await handleGitTransportRequest(request, h.env(), h.deps());

    expect(response?.status).toBe(200);
    expect(h.authorizeCalls).toEqual([{ tenantId: "tenant-a", capability: "repository.read", authorization: "Bearer caller-jwt" }]);
    expect(h.artifacts.getCalls).toEqual([name]);
    expect(h.repo.tokenCalls).toEqual([{ scope: "read", ttl: 60 }]);
    expect(h.fetchCalls).toHaveLength(1);
    const call = h.fetchCalls[0]!;
    expect(call.url).toBe(`https://artifacts.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`);
    expect(headersObject(call.init.headers)).toMatchObject({ authorization: "Bearer read-token", "git-protocol": "version=2", accept: "application/x-git-upload-pack-advertisement" });
    expect(headersObject(call.init.headers)).not.toHaveProperty("cookie");
    expect(headersObject(call.init.headers).authorization).not.toContain("caller-jwt");
    expect(response?.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("set-cookie")).toBeNull();

    await expect(response?.text()).resolves.toContain("PACK");
    await Promise.all(h.waitUntilPromises);
    expect(h.repo.revokedTokens).toEqual(["token-1"]);
    expect(h.repo.disposed).toBe(true);
  });

  it("proxies provider repository names with repeated dots from repository identity", async () => {
    const h = new Harness();
    const identity = artifactsRepositoryIdentity({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "project..dots" }, namespace);
    expect(identity.name.startsWith("gfy.project..dots.")).toBe(true);
    insertRepository(h.sql, { tenantId: "tenant-a", repositoryId: "repo-dots", artifactsNamespace: identity.namespace, artifactsName: identity.name });
    const stored = h.sql.db.prepare("SELECT artifacts_namespace AS artifactsNamespace, artifacts_name AS artifactsName FROM repositories WHERE tenant_id = ? AND id = ?").get("tenant-a", "repo-dots") as { artifactsNamespace: string; artifactsName: string };
    expect(stored).toEqual({ artifactsNamespace: identity.namespace, artifactsName: identity.name });
    const dottedRepo = new FakeRepo();
    dottedRepo.infoValue = repoInfo(identity.namespace, identity.name);
    expect(dottedRepo.infoValue.remote).toBe(`https://artifacts.example/git/${identity.namespace}/${identity.name}.git`);
    h.artifacts.repos.set(identity.name, dottedRepo);

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${identity.namespace}/${identity.name}.git/info/refs?service=git-upload-pack`), h.env(), h.deps());

    expect(response?.status).toBe(200);
    expect(h.authorizeCalls).toEqual([{ tenantId: "tenant-a", capability: "repository.read", authorization: null }]);
    expect(h.artifacts.getCalls).toEqual([identity.name]);
    expect(dottedRepo.tokenCalls).toEqual([{ scope: "read", ttl: 60 }]);
    await expect(response?.text()).resolves.toContain("PACK");
    await Promise.all(h.waitUntilPromises);
    expect(dottedRepo.revokedTokens).toEqual(["token-1"]);
  });

  it("streams upload-pack request bodies and response bodies without buffering", async () => {
    const h = new Harness();
    h.upstream = new Response(streamFrom(["pack-a", "pack-b"]), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
    const request = new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/git-upload-pack`, { method: "POST", body: streamFrom(["want ", "done"]), headers: { "content-type": "application/x-git-upload-pack-request" }, duplex: "half" } as RequestInit & { duplex: "half" });

    const response = await handleGitTransportRequest(request, h.env(), h.deps());

    expect(response?.status).toBe(200);
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0]!.init.body).toBeInstanceOf(ReadableStream);
    expect(h.fetchCalls[0]!.init.duplex).toBe("half");
    expect(await response?.text()).toBe("pack-apack-b");
    await Promise.all(h.waitUntilPromises);
    expect(h.repo.revokedTokens).toEqual(["token-1"]);
  });

  it("revokes read tokens when the returned stream is canceled", async () => {
    const h = new Harness();
    h.upstream = new Response(streamFrom(["chunk-1", "chunk-2"]), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), h.env(), h.deps());

    const reader = response?.body?.getReader();
    await reader?.read();
    await reader?.cancel("client went away");

    expect(h.repo.revokedTokens).toEqual(["token-1"]);
    expect(h.repo.disposed).toBe(true);
  });

  it("revokes read tokens when the returned body is left unconsumed until the session deadline", async () => {
    const h = new Harness();
    let upstreamCanceled = false;
    h.upstream = new Response(new ReadableStream<Uint8Array>({ cancel() { upstreamCanceled = true; } }), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), GFY_GIT_SESSION_TIMEOUT_MS: "1" }, h.deps());

    expect(response?.status).toBe(200);
    await eventually(() => upstreamCanceled && h.repo.revokedTokens.length === 1 && h.repo.disposed);
    await Promise.all(h.waitUntilPromises);
    expect(h.repo.revokedTokens).toEqual(["token-1"]);
  });

  it("aborts stalled response bodies at the session deadline", async () => {
    const h = new Harness();
    let upstreamCanceled = false;
    h.upstream = new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => undefined); }, cancel() { upstreamCanceled = true; } }), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), GFY_GIT_SESSION_TIMEOUT_MS: "1" }, h.deps());

    await expect(response?.text()).rejects.toThrow("git session deadline");
    await eventually(() => upstreamCanceled && h.repo.revokedTokens.length === 1 && h.repo.disposed);
    await Promise.all(h.waitUntilPromises);
  });

  it("cleans up tokens on upstream network errors and hides provider details", async () => {
    const h = new Harness();
    const deps = h.deps();
    const failingDeps = { ...deps, originFetch: async () => { throw new Error("provider secret redirect token") } };

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), h.env(), failingDeps);

    expect(response?.status).toBe(502);
    await expect(response?.text()).resolves.not.toContain("provider secret");
    expect(h.repo.revokedTokens).toEqual(["token-1"]);
    expect(h.repo.disposed).toBe(true);
  });

  it("catches D1 and authorization exceptions into bounded unavailable responses", async () => {
    const d1Failure = new Harness();
    const d1Response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...d1Failure.env(), GFY_DB: { prepare: () => { throw new Error("db private credential") } } }, d1Failure.deps());
    expect(d1Response?.status).toBe(503);
    await expect(d1Response?.text()).resolves.not.toContain("private credential");
    expect(d1Failure.authorizeCalls).toEqual([]);
    expect(d1Failure.artifacts.getCalls).toEqual([]);

    const authFailure = new Harness();
    const deps = authFailure.deps();
    const authResponse = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), authFailure.env(), { ...deps, authorize: async () => { throw new Error("jwt private credential") } });
    expect(authResponse?.status).toBe(503);
    await expect(authResponse?.text()).resolves.not.toContain("private credential");
    expect(authFailure.artifacts.getCalls).toEqual([]);
  });

  it("rejects denied, ambiguous, cross-namespace, and malformed requests before provider effects", async () => {
    const denied = new Harness();
    denied.deny = true;
    expect((await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), denied.env(), denied.deps()))?.status).toBe(403);
    expect(denied.artifacts.getCalls).toEqual([]);
    expect(denied.repo.tokenCalls).toEqual([]);

    const ambiguous = new Harness();
    insertRepository(ambiguous.sql, { tenantId: "tenant-b", repositoryId: "repo-b", artifactsNamespace: namespace, artifactsName: name });
    expect((await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), ambiguous.env(), ambiguous.deps()))?.status).toBe(409);
    expect(ambiguous.authorizeCalls).toEqual([]);
    expect(ambiguous.artifacts.getCalls).toEqual([]);

    const crossed = new Harness();
    expect((await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/other-namespace/${name}.git/info/refs?service=git-upload-pack`), crossed.env(), crossed.deps()))?.status).toBe(404);
    expect(crossed.authorizeCalls).toEqual([]);
    expect(crossed.artifacts.getCalls).toEqual([]);

    for (const path of ["/git/gitfoundry-staging/bad%2fname.git/info/refs?service=git-upload-pack", "/git/gitfoundry-staging/../info/refs?service=git-upload-pack", `/git/${namespace}/..git/info/refs?service=git-upload-pack`, `/git/${namespace}/...git/info/refs?service=git-upload-pack`, `/git/${namespace}/${name}.git/info/refs`, `/git/${namespace}/${name}.git/info/refs?service=git-upload-pack&x=1`, `/git/${namespace}/${name}.git/git-upload-pack?service=git-upload-pack`]) {
      const h = new Harness();
      const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example${path}`, { method: path.includes("git-upload-pack?") ? "POST" : "GET" }), h.env(), h.deps());
      expect(response?.status).toBeGreaterThanOrEqual(400);
      expect(h.authorizeCalls).toEqual([]);
      expect(h.artifacts.getCalls).toEqual([]);
    }
  });

  it("rejects receive-pack advertisements and posts without minting provider tokens", async () => {
    for (const request of [
      new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-receive-pack`),
      new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/git-receive-pack`, { method: "POST" })
    ]) {
      const h = new Harness();
      const response = await handleGitTransportRequest(request, h.env(), h.deps());
      expect(response?.status).toBe(501);
      expect(h.artifacts.getCalls).toEqual([]);
      expect(h.repo.tokenCalls).toEqual([]);
    }
  });

  it("hides redirects, invalid remotes, identity mismatches, and invalid tokens", async () => {
    let redirectBodyCanceled = false;
    const redirect = new Harness();
    redirect.upstream = new Response(new ReadableStream<Uint8Array>({ cancel() { redirectBodyCanceled = true; } }), { status: 302, headers: { location: "https://secret.example/token" } });
    const redirected = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), redirect.env(), redirect.deps());
    expect(redirected?.status).toBe(502);
    await expect(redirected?.text()).resolves.not.toContain("secret.example");
    expect(redirect.repo.revokedTokens).toEqual(["token-1"]);
    expect(redirect.repo.disposed).toBe(true);
    expect(redirectBodyCanceled).toBe(true);

    const invalidRemote = new Harness();
    invalidRemote.repo.infoValue = repoInfo(namespace, name, "https://user:secret@artifacts.example/wrong/path.git?token=secret");
    const invalidRemoteResponse = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), invalidRemote.env(), invalidRemote.deps());
    expect(invalidRemoteResponse?.status).toBe(502);
    await expect(invalidRemoteResponse?.text()).resolves.not.toContain("secret");
    expect(invalidRemote.repo.tokenCalls).toEqual([]);

    const mismatch = new Harness();
    mismatch.repo.infoValue = repoInfo(namespace, "wrong-provider-name");
    expect((await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), mismatch.env(), mismatch.deps()))?.status).toBe(502);
    expect(mismatch.repo.tokenCalls).toEqual([]);

    const wrongScope = new Harness();
    wrongScope.repo.nextToken = tokenResult("token-1", "write-token", "write");
    expect((await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), wrongScope.env(), wrongScope.deps()))?.status).toBe(502);
    expect(wrongScope.repo.revokedTokens).toEqual(["token-1"]);
    expect(wrongScope.fetchCalls).toEqual([]);

    const missingId = new Harness();
    missingId.repo.nextToken = { plaintext: "plaintext-only-token", scope: "read", expiresAt: new Date(Date.now() + 60_000).toISOString() } as WorkersArtifactsCreateTokenResult;
    expect((await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), missingId.env(), missingId.deps()))?.status).toBe(502);
    expect(missingId.repo.revokedTokens).toEqual(["plaintext-only-token"]);
    expect(missingId.fetchCalls).toEqual([]);

    const longTtl = new Harness();
    longTtl.repo.nextToken = tokenResult("token-1", "read-token", "read", new Date(Date.now() + 120_000).toISOString());
    expect((await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), longTtl.env(), longTtl.deps()))?.status).toBe(502);
    expect(longTtl.repo.revokedTokens).toEqual(["token-1"]);
    expect(longTtl.fetchCalls).toEqual([]);
  });

  it("rejects invalid bound configuration before provider effects", async () => {
    for (const envPatch of [
      { GFY_GIT_MAX_REQUEST_BYTES: "0" },
      { GFY_GIT_MAX_REQUEST_BYTES: "1.5" },
      { GFY_GIT_MAX_RESPONSE_BYTES: "-1" },
      { GFY_GIT_SESSION_TIMEOUT_MS: "55001" },
      { GFY_GIT_MAX_REQUEST_BYTES: 1 }
    ]) {
      const h = new Harness();
      const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), ...envPatch } as unknown as ReturnType<Harness["env"]>, h.deps());
      expect(response?.status).toBe(503);
      expect(h.artifacts.getCalls).toEqual([]);
      expect(h.repo.tokenCalls).toEqual([]);
    }
  });

  it("rejects declared oversize and malformed upload-pack requests before provider effects", async () => {
    const oversize = new Harness();
    const oversizeResponse = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/git-upload-pack`, { method: "POST", body: streamFrom(["want"]), headers: { "content-length": "5" }, duplex: "half" } as RequestInit & { duplex: "half" }), { ...oversize.env(), GFY_GIT_MAX_REQUEST_BYTES: "4" }, oversize.deps());
    expect(oversizeResponse?.status).toBe(413);
    expect(oversize.artifacts.getCalls).toEqual([]);
    expect(oversize.repo.tokenCalls).toEqual([]);

    const malformed = new Harness();
    const malformedResponse = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/git-upload-pack`, { method: "POST", body: streamFrom(["want"]), headers: { "content-length": "4x" }, duplex: "half" } as RequestInit & { duplex: "half" }), { ...malformed.env(), GFY_GIT_MAX_REQUEST_BYTES: "4" }, malformed.deps());
    expect(malformedResponse?.status).toBe(400);
    expect(malformed.artifacts.getCalls).toEqual([]);
    expect(malformed.repo.tokenCalls).toEqual([]);
  });

  it("enforces upload-pack request byte limits while preserving streaming", async () => {
    const boundary = new Harness();
    boundary.upstream = new Response(streamFrom(["ok"]), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
    let forwardedRequestBody = "";
    const boundaryDeps = {
      ...boundary.deps(),
      originFetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        boundary.fetchCalls.push({ url: String(url), init: init as FetchCall["init"] });
        forwardedRequestBody = await new Response(init?.body as BodyInit).text();
        return boundary.upstream;
      }
    };
    const boundaryRequest = new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/git-upload-pack`, { method: "POST", body: streamFrom(["wa", "nt"]), headers: { "content-type": "application/x-git-upload-pack-request" }, duplex: "half" } as RequestInit & { duplex: "half" });
    const boundaryResponse = await handleGitTransportRequest(boundaryRequest, { ...boundary.env(), GFY_GIT_MAX_REQUEST_BYTES: "4" }, boundaryDeps);
    expect(boundaryResponse?.status).toBe(200);
    expect(boundary.fetchCalls[0]!.init.body).not.toBe(boundaryRequest.body);
    expect(forwardedRequestBody).toBe("want");
    expect(await boundaryResponse?.text()).toBe("ok");
    await Promise.all(boundary.waitUntilPromises);
    expect(boundary.repo.revokedTokens).toEqual(["token-1"]);

    const actualOversize = new Harness();
    let upstreamReadError: unknown;
    const deps = actualOversize.deps();
    const actualOversizeDeps = {
      ...deps,
      originFetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        actualOversize.fetchCalls.push({ url: String(url), init: init as FetchCall["init"] });
        upstreamReadError = await readFailure(init?.body as ReadableStream<Uint8Array>);
        return actualOversize.upstream;
      }
    };
    const actualOversizeResponse = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/git-upload-pack`, { method: "POST", body: streamFrom(["wa", "nt!"]), duplex: "half" } as RequestInit & { duplex: "half" }), { ...actualOversize.env(), GFY_GIT_MAX_REQUEST_BYTES: "4" }, actualOversizeDeps);
    expect(actualOversizeResponse?.status).toBe(502);
    expect(upstreamReadError).toBeInstanceOf(Error);
    expect(String((upstreamReadError as Error).message)).toBe("git request too large");
    expect(actualOversize.repo.revokedTokens).toEqual(["token-1"]);
    expect(actualOversize.repo.disposed).toBe(true);
  });

  it("enforces response byte limits and cleans up scoped tokens", async () => {
    const h = new Harness();
    h.upstream = new Response(streamFrom(["pack", "!"]), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), GFY_GIT_MAX_RESPONSE_BYTES: "4" }, h.deps());

    await expect(response?.text()).rejects.toThrow("git response too large");
    expect(h.repo.revokedTokens).toEqual(["token-1"]);
    expect(h.repo.disposed).toBe(true);
    await Promise.all(h.waitUntilPromises);
  });

  it("aborts stalled upstream work at the session deadline and cleans up late tokens", async () => {
    const h = new Harness();
    let observedSignal: AbortSignal | undefined;
    let resolveFetch: ((response: Response) => void) | undefined;
    const deps = h.deps();
    const stalledDeps = {
      ...deps,
      originFetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        h.fetchCalls.push({ url: String(url), init: init as FetchCall["init"] });
        observedSignal = init?.signal as AbortSignal | undefined;
        return await new Promise<Response>((resolve) => { resolveFetch = resolve; });
      }
    };

    const promise = handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), GFY_GIT_SESSION_TIMEOUT_MS: "1" }, stalledDeps);
    await eventually(() => observedSignal?.aborted === true);
    resolveFetch?.(new Response(streamFrom(["late"]), { status: 200 }));
    const response = await promise;

    expect(response?.status).toBe(502);
    expect(h.repo.revokedTokens).toEqual(["token-1"]);
    expect(h.repo.disposed).toBe(true);
  });

  it("aborts upstream work when the caller aborts the request", async () => {
    const h = new Harness();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let resolveFetch: ((response: Response) => void) | undefined;
    const deps = h.deps();
    const abortDeps = {
      ...deps,
      originFetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        h.fetchCalls.push({ url: String(url), init: init as FetchCall["init"] });
        observedSignal = init?.signal as AbortSignal | undefined;
        return await new Promise<Response>((resolve) => { resolveFetch = resolve; });
      }
    };

    const promise = handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`, { signal: controller.signal }), h.env(), abortDeps);
    await eventually(() => observedSignal !== undefined);
    controller.abort();
    await eventually(() => observedSignal?.aborted === true);
    resolveFetch?.(new Response(streamFrom(["late"]), { status: 200 }));
    const response = await promise;

    expect(response?.status).toBe(502);
    expect(h.repo.revokedTokens).toEqual(["token-1"]);
    expect(h.repo.disposed).toBe(true);
  });

  it("does not touch the provider when the caller signal is already aborted", async () => {
    const h = new Harness();
    const controller = new AbortController();
    controller.abort();

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`, { signal: controller.signal }), h.env(), h.deps());

    expect(response?.status).toBe(502);
    expect(h.artifacts.getCalls).toEqual([]);
    expect(h.repo.tokenCalls).toEqual([]);
    expect(h.repo.revokedTokens).toEqual([]);
    expect(h.repo.disposed).toBe(false);
  });

  it("tracks a provider handle before it resolves after the session deadline", async () => {
    const h = new Harness();
    const lateRepo = new FakeRepo();
    const lateGet = deferred<FakeRepo>();
    h.artifacts.get = async (repoName: string) => {
      h.artifacts.getCalls.push(repoName);
      return await lateGet.promise;
    };

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), GFY_GIT_SESSION_TIMEOUT_MS: "1" }, h.deps());
    expect(response?.status).toBe(502);
    expect(h.waitUntilPromises.length).toBeGreaterThan(0);
    expect(lateRepo.disposed).toBe(false);

    lateGet.resolve(lateRepo);
    await eventually(() => lateRepo.disposed);
    await Promise.all(h.waitUntilPromises);
    expect(lateRepo.revokedTokens).toEqual([]);
  });

  it("keeps a late minted token handle undisposed until the pending revoke settles", async () => {
    const h = new Harness();
    const lateRepo = new DisposeSensitiveRepo();
    lateRepo.infoValue = repoInfo(namespace, name);
    h.artifacts.repos.set(name, lateRepo);
    const lateToken = deferred<WorkersArtifactsCreateTokenResult>();
    const lateRevoke = deferred<boolean>();
    lateRepo.createToken = async (scope?: "read" | "write", ttl?: number) => {
      lateRepo.tokenCalls.push({ scope, ttl });
      return await lateToken.promise;
    };
    lateRepo.revokeToken = async (token: string) => {
      if (lateRepo.disposed) throw new Error("disposed before revoke");
      lateRepo.revokedTokens.push(token);
      return await lateRevoke.promise;
    };

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), GFY_GIT_SESSION_TIMEOUT_MS: "1" }, h.deps());
    expect(response?.status).toBe(502);
    expect(h.waitUntilPromises.length).toBeGreaterThan(0);
    expect(lateRepo.disposed).toBe(false);

    lateToken.resolve(tokenResult("late-token", "late-read-token"));
    await eventually(() => lateRepo.revokedTokens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lateRepo.revokedTokens).toEqual(["late-token"]);
    expect(lateRepo.disposed).toBe(false);

    lateRevoke.resolve(true);
    await eventually(() => lateRepo.disposed);
    await Promise.all(h.waitUntilPromises);
    expect(lateRepo.revokedTokens).toEqual(["late-token"]);
  });

  it("disposes a late minted token handle after a timed-out revoke later fails", async () => {
    const h = new Harness();
    const lateRepo = new DisposeSensitiveRepo();
    lateRepo.infoValue = repoInfo(namespace, name);
    h.artifacts.repos.set(name, lateRepo);
    const lateToken = deferred<WorkersArtifactsCreateTokenResult>();
    const lateRevoke = deferred<boolean>();
    lateRepo.createToken = async (scope?: "read" | "write", ttl?: number) => {
      lateRepo.tokenCalls.push({ scope, ttl });
      return await lateToken.promise;
    };
    lateRepo.revokeToken = async (token: string) => {
      if (lateRepo.disposed) throw new Error("disposed before revoke");
      lateRepo.revokedTokens.push(token);
      return await lateRevoke.promise;
    };

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), GFY_GIT_SESSION_TIMEOUT_MS: "1" }, h.deps());
    expect(response?.status).toBe(502);

    lateToken.resolve(tokenResult("late-token", "late-read-token"));
    await eventually(() => lateRepo.revokedTokens.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lateRepo.revokedTokens).toEqual(["late-token"]);
    expect(lateRepo.disposed).toBe(false);

    lateRevoke.resolve(false);
    await eventually(() => lateRepo.disposed);
    await Promise.all(h.waitUntilPromises);
    expect(lateRepo.revokedTokens).toEqual(["late-token"]);
  });

  it("aborts stalled upload-pack request bodies at the session deadline", async () => {
    const h = new Harness();
    let requestCanceled = false;
    let upstreamReadError: unknown;
    const deps = h.deps();
    const stalledRequestDeps = {
      ...deps,
      originFetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        h.fetchCalls.push({ url: String(url), init: init as FetchCall["init"] });
        upstreamReadError = await readFailure(init?.body as ReadableStream<Uint8Array>);
        return h.upstream;
      }
    };
    const requestBody = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { requestCanceled = true; }
    });

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/git-upload-pack`, { method: "POST", body: requestBody, duplex: "half" } as RequestInit & { duplex: "half" }), { ...h.env(), GFY_GIT_SESSION_TIMEOUT_MS: "1" }, stalledRequestDeps);

    expect(response?.status).toBe(502);
    expect(upstreamReadError).toBeInstanceOf(Error);
    expect(String((upstreamReadError as Error).message)).toBe("git session deadline");
    expect(requestCanceled).toBe(true);
    expect(h.repo.revokedTokens).toEqual(["token-1"]);
    expect(h.repo.disposed).toBe(true);
  });

  it("bounds stalled cleanup work and tracks late cleanup without claiming revocation", async () => {
    const h = new Harness();
    h.repo.revokeToken = async (token: string) => {
      h.repo.revokedTokens.push(token);
      return await new Promise<boolean>(() => undefined);
    };
    h.upstream = new Response(streamFrom(["ok"]), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });

    const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), GFY_GIT_SESSION_TIMEOUT_MS: "20" }, h.deps());

    await expect(response?.text()).rejects.toThrow("git transport cleanup failed");
    expect(h.repo.revokedTokens).toEqual(["token-1"]);
    expect(h.repo.disposed).toBe(false);
    expect(h.waitUntilPromises.length).toBeGreaterThan(0);
  });

  it("handles deadline cleanup failures without unhandled rejections when waitUntil is absent", async () => {
    const h = new Harness();
    h.repo.nextRevokeResult = false;
    let upstreamCanceled = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    h.upstream = new Response(new ReadableStream<Uint8Array>({ cancel() { upstreamCanceled = true; } }), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
    const deps = h.deps();
    const noWaitUntilDeps = { authorize: deps.authorize, originFetch: deps.originFetch };
    try {
      const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), { ...h.env(), GFY_GIT_SESSION_TIMEOUT_MS: "1" }, noWaitUntilDeps);
      expect(response?.status).toBe(200);
      await eventually(() => upstreamCanceled && h.repo.disposed);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      await expect(response?.text()).rejects.toThrow(/git session deadline|git transport cleanup failed/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("turns cleanup and upstream stream failures into bounded stream errors", async () => {
    const revokeFalse = new Harness();
    revokeFalse.repo.nextRevokeResult = false;
    const revokeFalseResponse = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), revokeFalse.env(), revokeFalse.deps());
    await expect(revokeFalseResponse?.text()).rejects.toThrow("git transport cleanup failed");
    expect(revokeFalse.repo.revokedTokens).toEqual(["token-1"]);
    expect(revokeFalse.repo.disposed).toBe(true);
    await Promise.all(revokeFalse.waitUntilPromises);

    const revokeThrow = new Harness();
    revokeThrow.repo.revokeError = new Error("provider revoke secret");
    const revokeThrowResponse = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), revokeThrow.env(), revokeThrow.deps());
    await expect(revokeThrowResponse?.text()).rejects.toThrow("git transport cleanup failed");
    expect(revokeThrow.repo.revokedTokens).toEqual(["token-1"]);
    expect(revokeThrow.repo.disposed).toBe(true);
    await Promise.all(revokeThrow.waitUntilPromises);

    const disposeThrow = new Harness();
    disposeThrow.repo.disposeError = new Error("provider dispose secret");
    const disposeThrowResponse = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), disposeThrow.env(), disposeThrow.deps());
    await expect(disposeThrowResponse?.text()).rejects.toThrow("git transport cleanup failed");
    expect(disposeThrow.repo.revokedTokens).toEqual(["token-1"]);
    expect(disposeThrow.repo.disposed).toBe(true);
    await Promise.all(disposeThrow.waitUntilPromises);

    const streamError = new Harness();
    streamError.upstream = new Response(failingStream("upstream bearer secret"), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } });
    const streamErrorResponse = await handleGitTransportRequest(new Request(`https://gitfoundry.example/git/${namespace}/${name}.git/info/refs?service=git-upload-pack`), streamError.env(), streamError.deps());
    await expect(streamErrorResponse?.text()).rejects.toThrow("git upstream stream failed");
    expect(streamError.repo.revokedTokens).toEqual(["token-1"]);
    expect(streamError.repo.disposed).toBe(true);
    await Promise.all(streamError.waitUntilPromises);
  });
});

function fixture(): SqliteD1 {
  const sql = new SqliteD1();
  sql.db.exec("CREATE TABLE repositories(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, namespace_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL, default_branch TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, artifacts_namespace TEXT NOT NULL, artifacts_name TEXT NOT NULL, fork_of TEXT, PRIMARY KEY(tenant_id,id));");
  insertRepository(sql, { tenantId: "tenant-a", repositoryId: "repo-a", artifactsNamespace: namespace, artifactsName: name });
  insertRepository(sql, { tenantId: "tenant-z", repositoryId: "repo-z", artifactsNamespace: namespace, artifactsName: "other-provider-name" });
  return sql;
}

function insertRepository(sql: SqliteD1, input: { readonly tenantId: string; readonly repositoryId: string; readonly artifactsNamespace: string; readonly artifactsName: string }): void {
  sql.db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(input.tenantId, input.repositoryId, 1, timestamp, timestamp, "namespace-a", "demo", "private", "main", 0, input.artifactsNamespace, input.artifactsName, null);
}

function repoInfo(repoNamespace: string, repoName: string, remote = `https://artifacts.example/git/${repoNamespace}/${repoName}.git`): WorkersArtifactsRepoInfo {
  return { id: `provider-${repoName}`, name: repoName, description: null, defaultBranch: "main", createdAt: timestamp, updatedAt: timestamp, lastPushAt: null, source: null, readOnly: false, remote };
}

function tokenResult(id: string, plaintext: string, scope: "read" | "write" = "read", expiresAt = new Date(Date.now() + 60_000).toISOString()): WorkersArtifactsCreateTokenResult {
  return { id, plaintext, scope, expiresAt };
}

function streamFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    }
  });
}

function deferred<T>(): { readonly promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function failingStream(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() { throw new Error(message); }
  });
}

async function readFailure(body: ReadableStream<Uint8Array> | null | undefined): Promise<unknown> {
  if (!body) return new Error("missing body");
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return new Error("stream ended without failure");
    }
  } catch (error) {
    return error;
  }
}

async function eventually(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}
