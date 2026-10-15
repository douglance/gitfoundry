import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";
import { buildTrustedHelperFrame, CloudForgeGitError, makeArtifactsForgeGitFactory, makeCloudForgeGitPort, type CloudForgeGitRpcInvokeInput, type DurableObjectIdLike, type NormalizedArtifactsToken } from "./cloud-git.js";

const sha = "1".repeat(40);
const next = "2".repeat(40);
const timestamp = "2026-10-09T00:00:00.000Z";
const expiresAt = "2026-10-09T00:15:00.000Z";
const expiresAtMs = Date.parse(expiresAt);
const proof = "opaque-proof-123456";
const requestId = "123e4567-e89b-12d3-a456-426614174000";
const actualArtifactsRemote = "https://artifacts.example/provider/repos/stored-provider-name.git";
const scopedGatewayRemote = "https://artifacts.example/git/gitfoundry-staging/stored-provider-name.git";

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

class FakeArtifacts {
  readonly repos = new Map<string, unknown>();
  readonly getCalls: string[] = [];
  async get(name: string): Promise<unknown> {
    this.getCalls.push(name);
    const repo = this.repos.get(name);
    if (!repo) throw new Error("missing provider private-token");
    return repo;
  }
  async create(): Promise<never> { throw new Error("not used") }
  async list(): Promise<{ repos: []; total: number }> { return { repos: [], total: 0 } }
}

class FakeRepo {
  readonly createTokenCalls: Array<{ scope?: "read" | "write"; ttl?: number }> = [];
  readonly revokeTokenCalls: string[] = [];
  disposeCount = 0;
  constructor(readonly name: string, readonly options: { readonly token?: Record<string, unknown>; readonly remote?: string | null } = {}) {}
  async info(): Promise<{ name: string; remote?: string | null }> { return { name: this.name, remote: this.options.remote === undefined ? actualArtifactsRemote : this.options.remote } }
  async createToken(scope?: "read" | "write", ttl?: number): Promise<Record<string, unknown>> {
    const call: { scope?: "read" | "write"; ttl?: number } = {};
    if (scope !== undefined) call.scope = scope;
    if (ttl !== undefined) call.ttl = ttl;
    this.createTokenCalls.push(call);
    return this.options.token ?? { id: `token-${this.createTokenCalls.length}`, plaintext: "private-write-token", scope, expiresAt };
  }
  async revokeToken(token?: string): Promise<boolean> { if (token) this.revokeTokenCalls.push(token); return true }
  [Symbol.dispose](): void { this.disposeCount += 1 }
}

class FakeNamespace {
  readonly requests: Request[] = [];
  busy = 0;
  idFromName(name: string): DurableObjectIdLike { return { name } as DurableObjectIdLike }
  get(id: DurableObjectIdLike) { const named = id as { name: string }; return { fetch: async (request: Request) => { this.requests.push(request); if (this.busy > 0) { this.busy -= 1; return Response.json({ ok: false, error: "gfy_linux_active_attempt_exists" }, { status: 409 }); } const body = await request.clone().json() as { operation?: { method?: string } }; return Response.json({ ok: true, receipt: receipt({ stdout: JSON.stringify({ ok: true, result: `${named.name}:${body.operation?.method ?? "unknown"}:ok` }) + "\n" }) }) } } }
}

describe("cloud ForgeGitPort RPC transport", () => {
  it("maps every ForgeGitPort method to one exact RPC method and args tuple", async () => {
    const calls: CloudForgeGitRpcInvokeInput[] = [];
    const port = makeCloudForgeGitPort({ invoke: async (input) => { calls.push(input); return { receipt: receipt({ stdout: JSON.stringify({ ok: true, result: resultFor(input.method) }) + "\n" }) } } });

    await expect(port.readRef("refs/heads/main")).resolves.toBe(sha);
    await expect(port.listRefs("refs/gitfoundry/forks/")).resolves.toEqual([{ ref: "refs/gitfoundry/forks/a", target: sha }]);
    await expect(port.readFile(sha, "README.md")).resolves.toBe("UmVhZG1l");
    await expect(port.listTree(sha, "src")).resolves.toEqual([{ path: "src/app.ts", oid: sha, mode: "100644", type: "blob" }]);
    await expect(port.writeCommit({ base: sha, parents: [sha], changes: [], message: "m", author: { name: "A", email: "a@example.test" }, timestamp })).resolves.toBe(next);
    await expect(port.compareCommits(sha, next)).resolves.toEqual({ files: [{ path: "a", status: "modified" }] });
    await expect(port.mergeCommits({ base: sha, left: sha, right: next, author: { name: "A", email: "a@example.test" }, timestamp, message: "merge" })).resolves.toEqual({ status: "merged", commit: next });
    await expect(port.compareAndSwapRef("refs/heads/main", sha, next)).resolves.toBe(true);
    await expect(port.compareAndSwapRefs([{ ref: "refs/heads/main", expected: sha, next }])).resolves.toBe(true);
    await expect(port.isAncestor(sha, next)).resolves.toBe(false);

    expect(calls.map((call) => call.method)).toEqual(["readRef", "listRefs", "readFile", "listTree", "writeCommit", "compareCommits", "mergeCommits", "compareAndSwapRef", "compareAndSwapRefs", "isAncestor"]);
    expect(calls[3]).toEqual({ method: "listTree", args: [sha, "src"] });
    expect(calls[8]).toEqual({ method: "compareAndSwapRefs", args: [[{ ref: "refs/heads/main", expected: sha, next }]] });
    expect(calls[9]).toEqual({ method: "isAncestor", args: [sha, next] });
  });

  it("rejects failed, truncated, cleanup-required, ambiguous, and error RPC receipts without leaking stderr", async () => {
    for (const bad of [
      receipt({ status: "failed", exitCode: 1, stdout: "", stderr: "private-token" }),
      receipt({ stdout: JSON.stringify({ ok: true, result: sha }) + "\n", stdoutTruncated: true }),
      receipt({ stdout: JSON.stringify({ ok: true, result: sha }) + "\n", cleanupRequired: true, cleanupError: "private-token" }),
      receipt({ stdout: JSON.stringify({ ok: true, result: sha }) + "\n" + JSON.stringify({ ok: true, result: next }) + "\n" }),
      receipt({ stdout: JSON.stringify({ ok: false, error: "private-token" }) + "\n" })
    ]) {
      const port = makeCloudForgeGitPort({ invoke: async () => ({ receipt: bad }) });
      await expect(port.readRef("refs/heads/main")).rejects.toBeInstanceOf(CloudForgeGitError);
      await expect(port.readRef("refs/heads/main")).rejects.not.toThrow(/private-token/u);
    }
  });

  it("builds the exact trusted helper request consumed by the Linux forge RPC route", () => {
    const token: NormalizedArtifactsToken = { username: "x-access-token", plaintext: "private-write-token", expiresAtMs, revokeId: "token-1", opaqueProof: proof };
    const body = buildTrustedHelperFrame({ tenantId: "tenant-a", repositoryId: "repo-a", namespace: "gitfoundry-staging", artifactsName: "stored-provider-name", provider: { hostname: "artifacts.example", operationRemoteUrl: scopedGatewayRemote, artifactsRemoteUrl: actualArtifactsRemote }, token, serviceId: "worker-a", method: "readRef", args: ["refs/heads/main"], requestId, deadlineMs: 900_000 });

    expect(body).toEqual({
      commandId: `forge-git-readRef-${requestId}`,
      tenantId: "tenant-a",
      repositoryId: "repo-a",
      operationId: `forge-rpc-readRef-${requestId}`,
      fenceToken: `fence-${requestId}`,
      deadlineMs: 900_000,
      cwd: `/work/tenant-a/repo-a/forge-rpc-readRef-${requestId}/trusted-git`,
      providerId: "cloudflare-artifacts",
      providerRepositoryId: "gitfoundry-staging/stored-provider-name",
      operation: { kind: "forge_rpc", remoteUrl: scopedGatewayRemote, method: "readRef", args: ["refs/heads/main"] },
      credential: { tenantId: "tenant-a", repositoryId: "repo-a", providerId: "cloudflare-artifacts", providerRepositoryId: "gitfoundry-staging/stored-provider-name", username: "x-access-token", password: "private-write-token", expiresAtMs },
      artifactsEgress: { allowedProviderHostname: "artifacts.example", namespace: "gitfoundry-staging", repository: "stored-provider-name", artifactsRemoteUrl: actualArtifactsRemote, opaqueProof: proof, allowWrite: true },
      egressProfile: "gfy_internal_only"
    });
  });

  it("resolves scoped Artifacts metadata, mints per-call SDK tokens, derives scoped gateway remotes, and invokes Linux", async () => {
    const sql = fixture();
    const artifacts = new FakeArtifacts();
    const repo = new FakeRepo("stored-provider-name");
    artifacts.repos.set("stored-provider-name", repo);
    const ns = new FakeNamespace();
    const uuids = [requestId, proof, "223e4567-e89b-12d3-a456-426614174001", "opaque-proof-654321"];
    const factory = makeArtifactsForgeGitFactory({ GFY_DB: sql, GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns, GFY_SERVICE_ID: "worker-a", clock: { now: () => new Date(timestamp) }, randomUUID: () => uuids.shift() ?? "323e4567-e89b-12d3-a456-426614174002" });

    const port = await factory({ tenantId: "tenant-a", repositoryId: "repo-a" });
    await expect(port?.readRef("refs/heads/main")).resolves.toMatch(/:readRef:ok$/u);
    await expect(port?.writeCommit({ base: null, parents: [], changes: [], message: "m", author: { name: "A", email: "a@example.test" }, timestamp })).resolves.toMatch(/:writeCommit:ok$/u);

    expect(artifacts.getCalls).toEqual(["stored-provider-name", "stored-provider-name", "stored-provider-name"]);
    expect(repo.createTokenCalls).toEqual([{ scope: "read", ttl: 900 }, { scope: "write", ttl: 900 }]);
    expect(repo.revokeTokenCalls).toEqual(["token-1", "token-2"]);
    expect(repo.disposeCount).toBe(3);
    expect(ns.requests).toHaveLength(2);
    const readBody = await ns.requests[0]!.clone().json() as Record<string, any>;
    const writeBody = await ns.requests[1]!.clone().json() as Record<string, any>;
    expect(readBody.operation.remoteUrl).toBe(scopedGatewayRemote);
    expect(readBody.artifactsEgress.artifactsRemoteUrl).toBe(actualArtifactsRemote);
    expect(readBody.credential).toMatchObject({ username: "x-access-token", password: "private-write-token", expiresAtMs });
    expect(readBody.artifactsEgress).toMatchObject({ allowWrite: true, opaqueProof: proof });
    expect(writeBody.operation).toMatchObject({ kind: "forge_rpc", method: "writeCommit", remoteUrl: scopedGatewayRemote });
    expect(writeBody.cwd).toBe(`/work/tenant-a/repo-a/forge-rpc-writeCommit-223e4567-e89b-12d3-a456-426614174001/trusted-git`);
    expect(writeBody.artifactsEgress.opaqueProof).toBe("opaque-proof-654321");
  });


  it("serves forge reads and writes from Artifacts without starting the helper when direct reads are on", async () => {
    const artifacts = new FakeArtifacts();
    const repo = Object.assign(new FakeRepo("stored-provider-name"), {
      readCommit: async (hash: string) => hash === sha ? { hash, treeHash: next } : null,
      readTree: async (hash: string) => hash === next ? [{ name: "a.txt", mode: "100644", hash: "4".repeat(40), type: "blob" }] : null,
      readBlob: async () => new Blob(["hi"])
    });
    artifacts.repos.set("stored-provider-name", repo);
    const ns = new FakeNamespace();
    const advertised = "001e# service=git-upload-pack\n0000" + "0042" + sha + " refs/heads/forge-head\n" + "0000";
    const pushes: string[] = [];
    let advertisements = 0;
    const fetch = async (request: Request) => {
      if (!request.url.endsWith("/git-receive-pack")) { advertisements += 1; return new Response(advertised); }
      const command = new TextDecoder().decode(new Uint8Array(await request.arrayBuffer())).slice(4).split("\0")[0]!;
      const ref = command.split(" ")[2]!;
      pushes.push(ref);
      const line = (text: string) => (text.length + 4).toString(16).padStart(4, "0") + text;
      return new Response(line("unpack ok\n") + line(`ok ${ref}\n`) + "0000");
    };
    const factory = makeArtifactsForgeGitFactory({ GFY_DB: fixture(), GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns, clock: { now: () => new Date(timestamp) }, randomUUID: () => requestId }, { directReads: { fetch } });
    const port = await factory({ tenantId: "tenant-a", repositoryId: "repo-a" });
    await expect(port?.readRef("refs/heads/forge-head")).resolves.toBe(sha);
    await expect(port?.readFile(sha, "a.txt")).resolves.toBe(btoa("hi"));
    expect(ns.requests).toHaveLength(0);
    const written = await port?.writeCommit({ base: null, parents: [], changes: [], message: "m", author: { name: "A", email: "a@example.test" }, timestamp });
    expect(written).toMatch(/^[0-9a-f]{40}$/u);
    expect(pushes).toEqual(["refs/heads/retained/objects/" + written]);
    expect(ns.requests).toHaveLength(0);
    // Refs are read once per request, and a write makes the next read fetch them again.
    const before = advertisements;
    await port?.readRef("refs/heads/forge-head");
    expect(advertisements).toBe(before + 1);
    await port?.readRef("refs/heads/forge-head");
    expect(advertisements).toBe(before + 1);
  });

  it("waits for a busy repository helper instead of failing the request", async () => {
    const sql = fixture();
    const artifacts = new FakeArtifacts();
    artifacts.repos.set("stored-provider-name", new FakeRepo("stored-provider-name"));
    const ns = new FakeNamespace();
    const factory = makeArtifactsForgeGitFactory({ GFY_DB: sql, GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns, clock: { now: () => new Date(timestamp) } }, { busyRetryDelayMs: 0 });
    const port = await factory({ tenantId: "tenant-a", repositoryId: "repo-a" });

    ns.busy = 2;
    await expect(port?.readRef("refs/heads/main")).resolves.toMatch(/:readRef:ok$/u);
    expect(ns.requests).toHaveLength(3);

    ns.busy = Number.POSITIVE_INFINITY;
    await expect(port?.readRef("refs/heads/main")).rejects.toMatchObject({ code: "trusted_execution_failed" });
  });

  it("accepts the documented SDK token response without echoed scope or ID", async () => {
    const artifacts = new FakeArtifacts();
    const repo = new FakeRepo("stored-provider-name", { token: { plaintext: "private-write-token", expiresAt } });
    artifacts.repos.set("stored-provider-name", repo);
    const ns = new FakeNamespace();
    const factory = makeArtifactsForgeGitFactory({ GFY_DB: fixture(), GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns, clock: { now: () => new Date(timestamp) }, randomUUID: () => requestId });
    const port = await factory({ tenantId: "tenant-a", repositoryId: "repo-a" });
    await expect(port?.readRef("refs/heads/main")).resolves.toMatch(/:readRef:ok$/u);
    await expect(port?.writeCommit({ base: null, parents: [], changes: [], message: "m", author: { name: "A", email: "a@example.test" }, timestamp })).resolves.toMatch(/:writeCommit:ok$/u);
    expect(repo.createTokenCalls).toEqual([{ scope: "read", ttl: 900 }, { scope: "write", ttl: 900 }]);
    expect(repo.revokeTokenCalls).toEqual(["private-write-token", "private-write-token"]);
    expect(ns.requests).toHaveLength(2);
  });

  it.each([
    ["stamped by a provider clock ahead of the Worker", "2026-10-09T00:15:01.500Z"],
    ["stamped at the far edge of the clock drift allowance", "2026-10-09T00:16:00.000Z"]
  ])("accepts a credential expiry %s", async (_label, providerExpiresAt) => {
    const artifacts = new FakeArtifacts();
    artifacts.repos.set("stored-provider-name", new FakeRepo("stored-provider-name", { token: { plaintext: "private-write-token", scope: "read", expiresAt: providerExpiresAt } }));
    const ns = new FakeNamespace();
    const factory = makeArtifactsForgeGitFactory({ GFY_DB: fixture(), GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns, clock: { now: () => new Date(timestamp) }, randomUUID: () => requestId });
    const port = await factory({ tenantId: "tenant-a", repositoryId: "repo-a" });
    await expect(port?.readRef("refs/heads/main")).resolves.toMatch(/:readRef:ok$/u);
    expect(ns.requests).toHaveLength(1);
  });

  it.each([
    ["beyond the requested lifetime plus clock drift", "2026-10-09T00:16:00.001Z"],
    ["already expired", timestamp]
  ])("rejects a credential expiry %s and names the failed check", async (_label, providerExpiresAt) => {
    const artifacts = new FakeArtifacts();
    artifacts.repos.set("stored-provider-name", new FakeRepo("stored-provider-name", { token: { plaintext: "private-write-token", scope: "read", expiresAt: providerExpiresAt } }));
    const ns = new FakeNamespace();
    const factory = makeArtifactsForgeGitFactory({ GFY_DB: fixture(), GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns, clock: { now: () => new Date(timestamp) }, randomUUID: () => requestId });
    const port = await factory({ tenantId: "tenant-a", repositoryId: "repo-a" });
    await expect(port?.readRef("refs/heads/main")).rejects.toMatchObject({ code: "credential_unavailable", reason: "credential_expiry_invalid" });
    expect(ns.requests).toHaveLength(0);
  });

  it("names a failed credential request separately from an invalid credential response", async () => {
    const failing = new FakeRepo("stored-provider-name");
    failing.createToken = async () => { throw new Error("private-provider-token") };
    for (const [repo, reason] of [[failing, "credential_request_failed"], [new FakeRepo("stored-provider-name", { token: { plaintext: "short", expiresAt } }), "credential_response_invalid"]] as const) {
      const artifacts = new FakeArtifacts();
      artifacts.repos.set("stored-provider-name", repo);
      const factory = makeArtifactsForgeGitFactory({ GFY_DB: fixture(), GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: new FakeNamespace(), clock: { now: () => new Date(timestamp) }, randomUUID: () => requestId });
      const port = await factory({ tenantId: "tenant-a", repositoryId: "repo-a" });
      await expect(port?.readRef("refs/heads/main")).rejects.toMatchObject({ code: "credential_unavailable", reason });
    }
  });

  it("records why the trusted helper failed without carrying its output", async () => {
    const failedReceipt = makeCloudForgeGitPort({ invoke: async () => ({ receipt: receipt({ status: "failed", exitCode: 128, stderr: "fatal: private-token" }) }) });
    const error = await failedReceipt.readRef("refs/heads/main").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "trusted_execution_failed", detail: { receipt_status: "failed", exit_code: 128 } });
    expect(JSON.stringify(error)).not.toContain("private-token");

    const failedStep = makeCloudForgeGitPort({ invoke: async () => ({ receipt: receipt({ status: "failed", exitCode: 1, stdout: JSON.stringify({ ok: false, error: "forge_git_rpc_failed", phase: "snapshot" }) + "\n" }) }) });
    await expect(failedStep.readRef("refs/heads/main")).rejects.toMatchObject({ detail: { rpc_error: "forge_git_rpc_failed", rpc_phase: "snapshot" } });
    const unsafeStep = makeCloudForgeGitPort({ invoke: async () => ({ receipt: receipt({ status: "failed", exitCode: 1, stdout: JSON.stringify({ ok: false, error: "x private-token", phase: "private-token" }) + "\n" }) }) });
    const unsafe = await unsafeStep.readRef("refs/heads/main").catch((caught: unknown) => caught);
    expect(JSON.stringify(unsafe)).not.toContain("private-token");

    for (const [body, detail] of [
      [{ ok: false, error: "gfy_linux_container_start_failed" }, { helper_status: 500, helper_error: "gfy_linux_container_start_failed" }],
      [{ ok: false, error: "password=private-token" }, { helper_status: 500 }],
      [{ ok: false, error: "invalid_request", detail: "deadlineMs is outside the supported P0 range" }, { helper_status: 500, helper_error: "invalid_request", helper_detail: "deadlineMs is outside the supported P0 range" }],
      [{ ok: false, error: "invalid_request", detail: "token=private-token" }, { helper_status: 500, helper_error: "invalid_request" }]
    ] as const) {
      const artifacts = new FakeArtifacts();
      artifacts.repos.set("stored-provider-name", new FakeRepo("stored-provider-name"));
      const helper = { idFromName: (name: string) => ({ name }) as DurableObjectIdLike, get: () => ({ fetch: async () => Response.json(body, { status: 500 }) }) };
      const factory = makeArtifactsForgeGitFactory({ GFY_DB: fixture(), GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: helper, clock: { now: () => new Date(timestamp) }, randomUUID: () => requestId });
      const port = await factory({ tenantId: "tenant-a", repositoryId: "repo-a" });
      const failure = await port?.readRef("refs/heads/main").catch((caught: unknown) => caught);
      expect(failure).toMatchObject({ code: "trusted_execution_failed" });
      expect((failure as CloudForgeGitError).detail).toEqual(detail);
      expect(JSON.stringify(failure)).not.toContain("private-token");
    }
  });

  it("rejects an explicit token scope mismatch before invoking Linux", async () => {
    const artifacts = new FakeArtifacts();
    artifacts.repos.set("stored-provider-name", new FakeRepo("stored-provider-name", { token: { plaintext: "private-write-token", scope: "write", expiresAt } }));
    const ns = new FakeNamespace();
    const factory = makeArtifactsForgeGitFactory({ GFY_DB: fixture(), GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns, clock: { now: () => new Date(timestamp) }, randomUUID: () => requestId });
    const port = await factory({ tenantId: "tenant-a", repositoryId: "repo-a" });
    await expect(port?.readRef("refs/heads/main")).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(ns.requests).toHaveLength(0);
  });

  it("rejects scope mismatches, missing provider remotes, and non-SDK token aliases before invoking Linux", async () => {
    const sql = fixture({ artifactsNamespace: "other" });
    const artifacts = new FakeArtifacts();
    const ns = new FakeNamespace();
    const missing = makeArtifactsForgeGitFactory({ GFY_DB: sql, GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns });
    await expect(missing({ tenantId: "tenant-a", repositoryId: "repo-a" })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(ns.requests).toHaveLength(0);

    const noRemoteSql = fixture();
    const noRemoteArtifacts = new FakeArtifacts();
    noRemoteArtifacts.repos.set("stored-provider-name", new FakeRepo("stored-provider-name", { remote: null }));
    const noRemoteFactory = makeArtifactsForgeGitFactory({ GFY_DB: noRemoteSql, GFY_GIT: noRemoteArtifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns });
    await expect(noRemoteFactory({ tenantId: "tenant-a", repositoryId: "repo-a" })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(ns.requests).toHaveLength(0);

    const aliasSql = fixture();
    const aliasArtifacts = new FakeArtifacts();
    aliasArtifacts.repos.set("stored-provider-name", new FakeRepo("stored-provider-name", { token: { id: "token-1", token: "private-write-token", scope: "read", expiresAt } }));
    const aliasFactory = makeArtifactsForgeGitFactory({ GFY_DB: aliasSql, GFY_GIT: aliasArtifacts as never, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_TRUSTED_GIT_HELPER: ns, clock: { now: () => new Date(timestamp) }, randomUUID: () => requestId });
    const port = await aliasFactory({ tenantId: "tenant-a", repositoryId: "repo-a" });
    await expect(port?.readRef("refs/heads/main")).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(ns.requests).toHaveLength(0);
  });
});

function receipt(overrides: Partial<{ status: string; exitCode: number | null; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean; cleanupRequired: boolean; cleanupError: string }> = {}) {
  return { status: "succeeded", exitCode: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupRequired: false, ...overrides };
}

function resultFor(method: string): unknown {
  switch (method) {
    case "readRef": return sha;
    case "listRefs": return [{ ref: "refs/gitfoundry/forks/a", target: sha }];
    case "readFile": return "UmVhZG1l";
    case "listTree": return [{ path: "src/app.ts", oid: sha, mode: "100644", type: "blob" }];
    case "writeCommit": return next;
    case "compareCommits": return { files: [{ path: "a", status: "modified" }] };
    case "mergeCommits": return { status: "merged", commit: next };
    case "compareAndSwapRef": return true;
    case "compareAndSwapRefs": return true;
    case "isAncestor": return false;
    default: return null;
  }
}

function fixture(options: { readonly artifactsNamespace?: string; readonly artifactsName?: string } = {}): SqliteD1 {
  const sql = new SqliteD1();
  sql.db.exec("CREATE TABLE repositories(tenant_id TEXT NOT NULL, id TEXT NOT NULL, artifacts_namespace TEXT NOT NULL, artifacts_name TEXT NOT NULL, PRIMARY KEY(tenant_id,id));");
  sql.db.prepare("INSERT INTO repositories(tenant_id,id,artifacts_namespace,artifacts_name) VALUES(?,?,?,?)").run("tenant-0", "repo-a", "gitfoundry-staging", "wrong-provider-name");
  sql.db.prepare("INSERT INTO repositories(tenant_id,id,artifacts_namespace,artifacts_name) VALUES(?,?,?,?)").run("tenant-a", "repo-a", options.artifactsNamespace ?? "gitfoundry-staging", options.artifactsName ?? "stored-provider-name");
  return sql;
}
