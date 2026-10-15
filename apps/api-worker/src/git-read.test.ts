import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../packages/core/src/live/index.js";
import { GitReferenceUnavailableError } from "../../../packages/core/src/live/forge.js";
import type { ArtifactsBinding, WorkersArtifactsRepoInfo } from "./git-provider.js";
import { makeD1ArtifactsGitRead } from "./git-read.js";

const timestamp = "2026-10-08T00:00:00.000Z";
const goodSha = "a".repeat(40);
const otherTenantSha = "b".repeat(40);

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

class FakeArtifactsError extends Error {
  readonly name = "ArtifactsError";
  constructor(readonly code: string, message: string) { super(message) }
}

class FakeRepo {
  readonly logCalls: Array<{ ref?: string; limit?: number; offset?: number }> = [];
  readonly createTokenCalls: Array<{ scope?: "read" | "write"; ttl?: number }> = [];
  disposeCount = 0;
  history: ArtifactsCommitMetadata[] = [commit(goodSha)];
  infoError: unknown;
  logError: unknown;

  constructor(readonly infoValue: WorkersArtifactsRepoInfo) {}

  async info(): Promise<WorkersArtifactsRepoInfo> {
    if (this.infoError) throw this.infoError;
    return this.infoValue;
  }

  async log(options?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]> {
    this.logCalls.push(options ?? {});
    if (this.logError) throw this.logError;
    return this.history;
  }

  async createToken(scope?: "read" | "write", ttl?: number): Promise<ArtifactsCreateTokenResult> {
    const call: { scope?: "read" | "write"; ttl?: number } = {};
    if (scope) call.scope = scope;
    if (ttl !== undefined) call.ttl = ttl;
    this.createTokenCalls.push(call);
    throw new Error("credential secret should not be minted during git reads");
  }

  async revokeToken(): Promise<boolean> { return true }
  [Symbol.dispose](): void { this.disposeCount += 1 }
}

class FakeArtifacts {
  readonly getCalls: string[] = [];
  readonly repos = new Map<string, unknown>();
  getError: unknown;

  async get(name: string): Promise<unknown> {
    this.getCalls.push(name);
    if (this.getError) throw this.getError;
    const repo = this.repos.get(name);
    if (!repo) throw new FakeArtifactsError("NOT_FOUND", `missing repo ${name} secret-token`);
    return repo;
  }

  async create(): Promise<never> { throw new Error("create is not part of git read") }
  async list(): Promise<{ repos: []; total: number }> { return { repos: [], total: 0 } }
}

describe("D1 Artifacts git read adapter", () => {
  it("resolves refs from the tenant-scoped stored Artifacts name and never mints credentials", async () => {
    const sql = fixture();
    const artifacts = new FakeArtifacts();
    const storedRepo = new FakeRepo(repoInfo("stored-provider-name"));
    const crossedTenantRepo = new FakeRepo(repoInfo("wrong-tenant-provider"));
    crossedTenantRepo.history = [commit(otherTenantSha)];
    artifacts.repos.set("stored-provider-name", storedRepo);
    artifacts.repos.set("wrong-tenant-provider", crossedTenantRepo);
    sql.db.prepare("UPDATE repositories SET name = ? WHERE tenant_id = ? AND id = ?").run("renamed-display", "tenant-a", "repo-a");
    const read = makeD1ArtifactsGitRead(sql, artifacts as unknown as ArtifactsBinding, { namespace: "gitfoundry-staging" });

    const result = await Effect.runPromise(read.resolveRef({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main" }));

    expect(result).toEqual({ sha: goodSha });
    expect(artifacts.getCalls).toEqual(["stored-provider-name"]);
    expect(storedRepo.logCalls).toEqual([{ ref: "main", limit: 1 }]);
    expect(storedRepo.createTokenCalls).toEqual([]);
    expect(storedRepo.disposeCount).toBe(1);
    expect(crossedTenantRepo.logCalls).toEqual([]);
  });

  it("rejects repository rows outside the configured Artifacts namespace before provider access", async () => {
    const sql = fixture({ artifactsNamespace: "other-namespace" });
    const artifacts = new FakeArtifacts();
    const read = makeD1ArtifactsGitRead(sql, artifacts as unknown as ArtifactsBinding, { namespace: "gitfoundry-staging" });

    await expectUnavailable(read.resolveRef({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main" }), "repository namespace unavailable");
    expect(artifacts.getCalls).toEqual([]);
  });

  it("rejects malformed stored repository names and missing repositories", async () => {
    const malformed = makeD1ArtifactsGitRead(fixture({ artifactsName: "bad/name" }), new FakeArtifacts() as unknown as ArtifactsBinding, { namespace: "gitfoundry-staging" });
    await expectUnavailable(malformed.resolveRef({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main" }), "repository identity unavailable");

    const missing = makeD1ArtifactsGitRead(fixture(), new FakeArtifacts() as unknown as ArtifactsBinding, { namespace: "gitfoundry-staging" });
    await expectUnavailable(missing.resolveRef({ tenantId: "tenant-a", repositoryId: "repo-missing", ref: "main" }), "repository unavailable");
  });

  it("rejects empty history, malformed history, and invalid commit hashes without leaking metadata", async () => {
    const emptyRepo = new FakeRepo(repoInfo("stored-provider-name"));
    emptyRepo.history = [];
    await expectFailureFromRepo(emptyRepo, "reference unavailable");
    expect(emptyRepo.disposeCount).toBe(1);

    const malformedHistoryRepo = new FakeRepo(repoInfo("stored-provider-name"));
    malformedHistoryRepo.history = [undefined as unknown as ArtifactsCommitMetadata];
    await expectFailureFromRepo(malformedHistoryRepo, "reference unavailable");
    expect(malformedHistoryRepo.disposeCount).toBe(1);

    const invalidShaRepo = new FakeRepo(repoInfo("stored-provider-name"));
    invalidShaRepo.history = [commit("A".repeat(40))];
    try {
      await Effect.runPromise(readWithRepo(invalidShaRepo).resolveRef({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main" }));
    } catch (error) {
      expect(error).toMatchObject({ _tag: "GitReferenceUnavailableError", reason: "reference unavailable" });
      expect(JSON.stringify(error)).not.toContain("A".repeat(40));
    }
    expect(invalidShaRepo.disposeCount).toBe(1);
  });

  it("rejects provider identity mismatches, missing log capability, and provider errors with sanitized failures", async () => {
    const identityMismatch = new FakeRepo(repoInfo("wrong-provider-name"));
    await expectFailureFromRepo(identityMismatch, "repository identity unavailable");
    expect(identityMismatch.disposeCount).toBe(1);

    let disposedWithoutLog = false;
    const withoutLog = {
      info: async () => repoInfo("stored-provider-name"),
      createToken: async () => { throw new Error("secret token should not be minted") },
      revokeToken: async () => true,
      [Symbol.dispose]: () => { disposedWithoutLog = true }
    };
    await expectFailureFromCapability(withoutLog, "provider capability unavailable");
    expect(disposedWithoutLog).toBe(true);

    const providerFailure = new FakeRepo(repoInfo("stored-provider-name"));
    providerFailure.logError = new FakeArtifactsError("INTERNAL_ERROR", "internal included secret-token and provider metadata");
    try {
      await Effect.runPromise(readWithRepo(providerFailure).resolveRef({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main" }));
    } catch (error) {
      expect(error).toMatchObject({ _tag: "GitReferenceUnavailableError", reason: "provider unavailable" });
      expect(JSON.stringify(error)).not.toContain("secret-token");
      expect(JSON.stringify(error)).not.toContain("INTERNAL_ERROR");
    }
    expect(providerFailure.disposeCount).toBe(1);

    const unbound = makeD1ArtifactsGitRead(fixture(), undefined, { namespace: "gitfoundry-staging" });
    await expectUnavailable(unbound.resolveRef({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main" }), "provider unavailable");
  });
});

async function expectFailureFromRepo(repo: FakeRepo, reason: string): Promise<void> {
  await expectUnavailable(readWithRepo(repo).resolveRef({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main" }), reason);
}

async function expectFailureFromCapability(capability: unknown, reason: string): Promise<void> {
  const artifacts = new FakeArtifacts();
  artifacts.repos.set("stored-provider-name", capability);
  const read = makeD1ArtifactsGitRead(fixture(), artifacts as unknown as ArtifactsBinding, { namespace: "gitfoundry-staging" });
  await expectUnavailable(read.resolveRef({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main" }), reason);
}

function readWithRepo(repo: FakeRepo) {
  const artifacts = new FakeArtifacts();
  artifacts.repos.set("stored-provider-name", repo);
  return makeD1ArtifactsGitRead(fixture(), artifacts as unknown as ArtifactsBinding, { namespace: "gitfoundry-staging" });
}

async function expectUnavailable(effect: Effect.Effect<unknown, GitReferenceUnavailableError>, reason: string): Promise<void> {
  await expect(Effect.runPromise(effect)).rejects.toMatchObject({ _tag: "GitReferenceUnavailableError", reason });
}

function fixture(options: { readonly artifactsNamespace?: string; readonly artifactsName?: string } = {}): SqliteD1 {
  const sql = new SqliteD1();
  sql.db.exec("CREATE TABLE repositories(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, namespace_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL, default_branch TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, artifacts_namespace TEXT NOT NULL, artifacts_name TEXT NOT NULL, fork_of TEXT, PRIMARY KEY(tenant_id,id));");
  insertRepository(sql, { tenantId: "tenant-0", repositoryId: "repo-a", artifactsNamespace: "gitfoundry-staging", artifactsName: "wrong-tenant-provider" });
  insertRepository(sql, { tenantId: "tenant-a", repositoryId: "repo-a", artifactsNamespace: options.artifactsNamespace ?? "gitfoundry-staging", artifactsName: options.artifactsName ?? "stored-provider-name" });
  return sql;
}

function insertRepository(sql: SqliteD1, input: { readonly tenantId: string; readonly repositoryId: string; readonly artifactsNamespace: string; readonly artifactsName: string }): void {
  sql.db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(input.tenantId, input.repositoryId, 1, timestamp, timestamp, "namespace-a", "demo", "private", "main", 0, input.artifactsNamespace, input.artifactsName, null);
}

function repoInfo(name: string): WorkersArtifactsRepoInfo {
  return {
    id: `provider-${name}`,
    name,
    description: null,
    defaultBranch: "main",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastPushAt: null,
    source: null,
    readOnly: false,
    remote: `https://artifacts.example/${name}.git`
  };
}

function commit(hash: string): ArtifactsCommitMetadata {
  return {
    hash,
    treeHash: "c".repeat(40),
    message: "commit",
    author: { name: "A", email: "a@example.test" },
    committer: { name: "C", email: "c@example.test" },
    parents: [],
    authoredAt: 1,
    committedAt: 1
  };
}
