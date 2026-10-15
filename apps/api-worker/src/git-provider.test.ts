import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { ArtifactsGitProviderError, artifactsRepositoryIdentity, makeArtifactsGitProvider, type WorkersArtifactsCreateRepoResult, type WorkersArtifactsCreateTokenResult, type WorkersArtifactsRepoInfo } from "./git-provider.js";

class FakeArtifactsError extends Error {
  readonly name = "ArtifactsError";
  constructor(readonly code: string, message: string) { super(message) }
  readonly numericCode = 1;
}

class FakeRepo {
  readonly tokenCalls: Array<{ scope?: "read" | "write"; ttl?: number }> = [];
  readonly revokedTokens: string[] = [];
  disposed = false;
  revokeResult = true;
  nextTokenScope: "read" | "write" | undefined;
  nextTokenExpiresAt: string | undefined;
  constructor(readonly infoValue: WorkersArtifactsRepoInfo, readonly tokenPlaintext = "helper-secret-token") {}
  async info(): Promise<WorkersArtifactsRepoInfo> { return this.infoValue }
  async createToken(scope?: "read" | "write", ttl?: number): Promise<WorkersArtifactsCreateTokenResult> {
    const call: { scope?: "read" | "write"; ttl?: number } = {};
    if (scope) call.scope = scope;
    if (ttl !== undefined) call.ttl = ttl;
    this.tokenCalls.push(call);
    return { id: "token-1", plaintext: this.tokenPlaintext, scope: this.nextTokenScope ?? scope ?? "write", expiresAt: this.nextTokenExpiresAt ?? "2026-10-08T00:05:00.000Z" };
  }
  async revokeToken(tokenOrId: string): Promise<boolean> {
    this.revokedTokens.push(tokenOrId);
    return this.revokeResult;
  }
  [Symbol.dispose](): void { this.disposed = true }
}

class FakeArtifacts {
  readonly createCalls: Array<{ name: string; options: { readOnly?: boolean; setDefaultBranch?: string; description?: string } | undefined }> = [];
  readonly repos = new Map<string, FakeRepo>();
  createError: unknown;
  getError: unknown;
  constructor(readonly secret = "creation-secret-token") {}
  async create(name: string, options?: { readOnly?: boolean; setDefaultBranch?: string; description?: string }): Promise<WorkersArtifactsCreateRepoResult> {
    this.createCalls.push({ name, options });
    if (this.createError) throw this.createError;
    const info: WorkersArtifactsRepoInfo = { id: `provider-${name}`, name, description: null, defaultBranch: options?.setDefaultBranch ?? "main", createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", lastPushAt: null, source: null, readOnly: false, remote: `https://helper:${this.secret}@artifacts.example/${name}.git?token=query-secret#fragment-secret` };
    this.repos.set(name, new FakeRepo(info));
    return { id: info.id, name, description: null, defaultBranch: info.defaultBranch, remote: info.remote, token: this.secret };
  }
  async get(name: string): Promise<FakeRepo> {
    if (this.getError) throw this.getError;
    const repo = this.repos.get(name);
    if (!repo) throw new FakeArtifactsError("NOT_FOUND", `missing ${name}`);
    return repo;
  }
  async list(options?: { limit?: number; cursor?: string }) {
    const repos = Array.from(this.repos.values()).slice(0, options?.limit ?? 50).map((repo) => {
      const { remote: _remote, ...withoutRemote } = repo.infoValue;
      return withoutRemote;
    });
    return { repos, total: this.repos.size };
  }
}

describe("Artifacts git provider adapter", () => {
  it("uses a collision-resistant canonical tuple for provider repository names", () => {
    const left = artifactsRepositoryIdentity({ tenantId: "tenant.a", namespaceId: "b", name: "repo" }, "gitfoundry-staging");
    const right = artifactsRepositoryIdentity({ tenantId: "tenant", namespaceId: "a.b", name: "repo" }, "gitfoundry-staging");
    const long = artifactsRepositoryIdentity({ tenantId: "t".repeat(128), namespaceId: "n".repeat(128), name: "r".repeat(100) }, "gitfoundry-staging");

    expect(left).not.toEqual(right);
    expect(left.name).toMatch(/^gfy\.repo\.[0-9a-f]{64}$/);
    expect(right.name).toMatch(/^gfy\.repo\.[0-9a-f]{64}$/);
    expect(long.name.length).toBeLessThanOrEqual(255);
    expect(artifactsRepositoryIdentity({ tenantId: "tenant/a", namespaceId: "namespace-a", name: "demo" }, "gitfoundry-staging").name).toMatch(/^gfy\.demo\.[0-9a-f]{64}$/);
    expect(() => artifactsRepositoryIdentity({ tenantId: "", namespaceId: "namespace-a", name: "demo" }, "gitfoundry-staging")).toThrow(ArtifactsGitProviderError);
  });

  it("accepts only qualified Workers Artifacts namespace syntax", () => {
    expect(artifactsRepositoryIdentity({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }, "abc")).toMatchObject({ namespace: "abc" });

    for (const namespace of ["ab", "GitFoundry", "gfy_staging", "gitfoundry.staging", "-gitfoundry", "gitfoundry-", "a".repeat(64)]) {
      expect(() => artifactsRepositoryIdentity({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }, namespace)).toThrow(ArtifactsGitProviderError);
    }
  });

  it("provisions through Artifacts, verifies readback, revokes bootstrap token, and returns a gateway URL", async () => {
    const artifacts = new FakeArtifacts();
    const provider = makeArtifactsGitProvider(artifacts, { namespace: "gitfoundry-staging", publicGitUrlBase: "https://git.gitfoundry.example/repos" });
    const identity = artifactsRepositoryIdentity({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }, "gitfoundry-staging");

    const result = await Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "main", visibility: "private" }));

    expect(artifacts.createCalls).toEqual([{ name: identity.name, options: { readOnly: false, setDefaultBranch: "main" } }]);
    expect(result).toEqual({ gitUrl: `https://git.gitfoundry.example/repos/gitfoundry-staging/${identity.name}.git`, artifactsNamespace: "gitfoundry-staging", artifactsName: identity.name });
    expect(JSON.stringify(result)).not.toContain("creation-secret-token");
    expect(JSON.stringify(result)).not.toContain("query-secret");
    expect(JSON.stringify(result)).not.toContain("fragment-secret");
    expect(JSON.stringify(result)).not.toContain("artifacts.example");
    const repo = artifacts.repos.get(identity.name);
    expect(repo?.revokedTokens).toEqual(["creation-secret-token"]);
    const readback = await Effect.runPromise(provider.readRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }));
    expect(readback).toMatchObject({ namespace: "gitfoundry-staging", name: identity.name, provider_id: `provider-${identity.name}`, default_branch: "main", remote: `https://artifacts.example/${identity.name}.git` });
    expect(JSON.stringify(readback)).not.toContain("creation-secret-token");
  });

  it("rejects provider readback identity mismatches before accepting repository output", async () => {
    const artifacts = new FakeArtifacts();
    const provider = makeArtifactsGitProvider(artifacts, { namespace: "gitfoundry-staging" });
    await Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "main", visibility: "private" }));
    const identity = artifactsRepositoryIdentity({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }, "gitfoundry-staging");
    const repo = artifacts.repos.get(identity.name);
    if (!repo) throw new Error("fixture repository missing");
    (repo.infoValue as { name: string }).name = "wrong-provider-repo";

    await expect(Effect.runPromise(provider.readRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }))).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "provider_error", providerCode: "PROVIDER_IDENTITY_MISMATCH" });
  });

  it("deletes only storage in its own namespace", async () => {
    const artifacts = new FakeArtifacts();
    const deleted: string[] = [];
    const binding = Object.assign(artifacts, { delete: async (name: string) => { deleted.push(name); return true } });
    const provider = makeArtifactsGitProvider(binding, { namespace: "gitfoundry-staging" });
    await expect(Effect.runPromise(provider.deleteRepository({ artifactsNamespace: "another-deployment", artifactsName: "demo" }))).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "invalid_repository_identity" });
    expect(deleted).toEqual([]);
    await Effect.runPromise(provider.deleteRepository({ artifactsNamespace: "gitfoundry-staging", artifactsName: "demo" }));
    expect(deleted).toEqual(["demo"]);
  });

  it("finishes a retried delete whose storage is already gone", async () => {
    const binding = Object.assign(new FakeArtifacts(), { delete: async () => false });
    const provider = makeArtifactsGitProvider(binding, { namespace: "gitfoundry-staging" });
    await expect(Effect.runPromise(provider.deleteRepository({ artifactsNamespace: "gitfoundry-staging", artifactsName: "gone" }))).resolves.toBeUndefined();
  });

  it("creates short-lived helper-only tokens without exposing them through lifecycle readback", async () => {
    const artifacts = new FakeArtifacts();
    const provider = makeArtifactsGitProvider(artifacts, { namespace: "gitfoundry-staging" });
    const identity = artifactsRepositoryIdentity({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }, "gitfoundry-staging");
    await Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "trunk", visibility: "internal" }));

    const token = await Effect.runPromise(provider.createHelperToken({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", scope: "write", ttlSeconds: 120 }));

    expect(token).toEqual({ namespace: "gitfoundry-staging", name: identity.name, intended_for: "trusted_git_helper", token_id: "token-1", plaintext: "helper-secret-token", scope: "write", expires_at: "2026-10-08T00:05:00.000Z" });
    const repo = artifacts.repos.get(identity.name);
    expect(repo?.tokenCalls).toEqual([{ scope: "write", ttl: 120 }]);
    expect(JSON.stringify(await Effect.runPromise(provider.readRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" })))).not.toContain("helper-secret-token");
    await expect(Effect.runPromise(provider.createHelperToken({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", ttlSeconds: 3600 }))).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "provider_error", providerCode: "INVALID_TTL" });
  });

  it("rejects provider helper tokens whose scope or expiry does not match the request boundary", async () => {
    const artifacts = new FakeArtifacts();
    const provider = makeArtifactsGitProvider(artifacts, { namespace: "gitfoundry-staging" });
    const identity = artifactsRepositoryIdentity({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }, "gitfoundry-staging");
    await Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "trunk", visibility: "internal" }));
    const repo = artifacts.repos.get(identity.name);
    if (!repo) throw new Error("fixture repository missing");

    repo.nextTokenScope = "read";
    await expect(Effect.runPromise(provider.createHelperToken({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", scope: "write", ttlSeconds: 120 }))).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "provider_error" });

    repo.nextTokenScope = undefined;
    repo.nextTokenExpiresAt = "not-a-date";
    await expect(Effect.runPromise(provider.createHelperToken({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", scope: "write", ttlSeconds: 120 }))).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "provider_error", providerCode: "INVALID_TTL" });
  });

  it("returns explicit provider outcomes while allowlisting provider error codes", async () => {
    const artifacts = new FakeArtifacts("do-not-leak-token");
    artifacts.createError = new FakeArtifactsError("UPSTREAM_UNAVAILABLE", "upstream included do-not-leak-token");
    const provider = makeArtifactsGitProvider(artifacts, { namespace: "gitfoundry-staging" });

    await expect(Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "main", visibility: "private" }))).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "upstream_unavailable", providerCode: "UPSTREAM_UNAVAILABLE" });
    await expect(Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "main", visibility: "private" }))).rejects.not.toThrow(/do-not-leak-token/);

    artifacts.createError = new FakeArtifactsError("INTERNAL_ERROR", "internal included do-not-leak-token");
    await expect(Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "main", visibility: "private" }))).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "provider_error", providerCode: "INTERNAL_ERROR" });

    artifacts.createError = new FakeArtifactsError("SECRET_TOKEN_CODE", "do-not-leak-token");
    await expect(Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "main", visibility: "private" }))).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "provider_error", reason: "Cloudflare Artifacts provider error" });
    try {
      await Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "main", visibility: "private" }));
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("SECRET_TOKEN_CODE");
      expect(JSON.stringify(error)).not.toContain("do-not-leak-token");
    }
  });

  it("keeps protection and ref CAS unsupported until provider semantics are qualified", async () => {
    const provider = makeArtifactsGitProvider(new FakeArtifacts(), { namespace: "gitfoundry-staging" });

    await expect(Effect.runPromise(provider.configureBranchProtection())).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "unsupported_protection", providerCode: "UNSUPPORTED_PROTECTION" });
    await expect(Effect.runPromise(provider.compareAndSwapRef())).rejects.toMatchObject({ _tag: "ArtifactsGitProviderError", code: "unsupported_cas", providerCode: "UNSUPPORTED_CAS" });
  });
});
