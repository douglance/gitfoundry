import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { SourceReadUnavailableError, makeD1ArtifactsSourceRead, makeGitCliSourceRead } from "./source-read.js";

const exec = promisify(execFile);

describe("git cli source read adapter", () => {
  it("rejects incomplete Git tree listings", async () => {
    const port = makeGitCliSourceRead({
      cursorSecret: "test-cursor-secret",
      resolveRepository: async () => ({ gitDir: "/fixture" }),
      git: { run: async (_dir, args) => ({
        stdout: new TextEncoder().encode(args[0] === "ls-tree" ? "100644 blob " + "b".repeat(40) + " 4\tREADME.md\0" : args[0] === "cat-file" ? "tree\n" : "a".repeat(40) + "\n"),
        truncated: args[0] === "ls-tree"
      }) }
    });
    await expect(Effect.runPromise(port.tree({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main" }))).rejects.toMatchObject({ _tag: "SourceReadUnavailableError", code: "unsupported" });
  });

  it("reads immutable trees, source files and diffs from a real bare repository", async () => {
    const fixture = await makeGitFixture();
    try {
      const port = makeSourceRead(fixture);

      const first = await Effect.runPromise(port.tree({ tenantId: "tenant-a", repositoryId: "repo-a", ref: fixture.second, recursive: true, limit: 2, direction: "asc" }));
      expect(first).toMatchObject({ repository_id: "repo-a", resolved_sha: fixture.second, has_more: true, truncated: false });
      expect(first.items.map((item) => item.path)).toEqual(["binary.dat", "dir/nested.txt"]);
      expect(first.items[0]).toMatchObject({ kind: "blob", mode: "100644", size_bytes: 4 });
      expect(first.next_cursor).toEqual(expect.any(String));

      const next = await Effect.runPromise(port.tree({ tenantId: "tenant-a", repositoryId: "repo-a", ref: fixture.second, recursive: true, limit: 2, direction: "asc", cursor: first.next_cursor ?? undefined }));
      expect(next.items.map((item) => item.path)).toEqual(["invalid.bin", "large.txt"]);
      expect(next.resolved_sha).toBe(fixture.second);

      const defaultDirection = await Effect.runPromise(port.tree({ tenantId: "tenant-a", repositoryId: "repo-a", ref: fixture.second, recursive: true, limit: 2 }));
      expect(defaultDirection.items.map((item) => item.path)).toEqual(["README.md", "large.txt"]);

      const text = await Effect.runPromise(port.readFile({ tenantId: "tenant-a", repositoryId: "repo-a", ref: fixture.second, path: "README.md", maxBytes: 64 }));
      expect(text).toMatchObject({ encoding: "utf-8", contents: "hello world\nsecond line\n", truncated: false, resolved_sha: fixture.second });

      const binary = await Effect.runPromise(port.readFile({ tenantId: "tenant-a", repositoryId: "repo-a", ref: fixture.second, path: "binary.dat" }));
      expect(binary).toMatchObject({ encoding: "binary", contents: null, truncated: false });

      const invalid = await Effect.runPromise(port.readFile({ tenantId: "tenant-a", repositoryId: "repo-a", ref: fixture.second, path: "invalid.bin" }));
      expect(invalid).toMatchObject({ encoding: "unsupported", contents: null, truncated: false });

      const large = await Effect.runPromise(port.readFile({ tenantId: "tenant-a", repositoryId: "repo-a", ref: fixture.second, path: "large.txt", maxBytes: 16 }));
      expect(large).toMatchObject({ encoding: "utf-8", contents: "abcdefghijklmnop", truncated: true, size_bytes: 40 });

      const diff = await Effect.runPromise(port.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: fixture.first, head: fixture.second, comparison: "two_dot", contextLines: 1 }));
      expect(diff).toMatchObject({ repository_id: "repo-a", base_sha: fixture.first, head_sha: fixture.second, has_more: false, truncated: false });
      expect(diff.items.find((item) => item.new_path === "README.md")).toMatchObject({ change: "modified", additions: 1, deletions: 0, binary: false });
      expect(diff.items.find((item) => item.new_path === "README.md")?.hunks[0]?.lines.some((line) => line.kind === "addition" && line.text === "second line")).toBe(true);

      await expect(Effect.runPromise(port.readFile({ tenantId: "tenant-a", repositoryId: "repo-a", ref: fixture.second, path: "../README.md" }))).rejects.toMatchObject({ _tag: "SourceReadUnavailableError", code: "invalid_input" });
      await expect(Effect.runPromise(port.readFile({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "f".repeat(40), path: "README.md" }))).rejects.toBeInstanceOf(SourceReadUnavailableError);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("continues tree pagination from the pinned commit after the input branch moves", async () => {
    const fixture = await makeGitFixture();
    try {
      const firstPort = makeSourceRead(fixture);
      const first = await Effect.runPromise(firstPort.tree({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main", recursive: true, limit: 2, direction: "asc" }));
      expect(first).toMatchObject({ resolved_sha: fixture.second, has_more: true });
      expect(first.items.map((item) => item.path)).toEqual(["binary.dat", "dir/nested.txt"]);
      expect(first.next_cursor).toEqual(expect.any(String));

      const moved = await advanceMainBranch(fixture);
      expect(moved).not.toBe(fixture.second);

      const freshPort = makeSourceRead(fixture);
      const next = await Effect.runPromise(freshPort.tree({ tenantId: "tenant-a", repositoryId: "repo-a", ref: "main", recursive: true, limit: 2, direction: "asc", cursor: first.next_cursor ?? undefined }));
      expect(next).toMatchObject({ resolved_sha: fixture.second, tree_sha: first.tree_sha });
      expect(next.items.map((item) => item.path)).toEqual(["invalid.bin", "large.txt"]);
      expect(next.items.map((item) => item.path)).not.toContain("after-move.txt");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("continues diff pagination from the pinned base and head after the input branch moves", async () => {
    const fixture = await makeGitFixture();
    try {
      const firstPort = makeSourceRead(fixture);
      const first = await Effect.runPromise(firstPort.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: fixture.first, head: "main", comparison: "two_dot", contextLines: 1, limit: 1, direction: "asc" }));
      expect(first).toMatchObject({ base_sha: fixture.first, head_sha: fixture.second, has_more: true });
      expect(first.items.map((item) => item.new_path)).toEqual(["README.md"]);
      expect(first.next_cursor).toEqual(expect.any(String));

      const moved = await advanceMainBranch(fixture);
      expect(moved).not.toBe(fixture.second);

      const freshPort = makeSourceRead(fixture);
      const next = await Effect.runPromise(freshPort.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: fixture.first, head: "main", comparison: "two_dot", contextLines: 1, limit: 1, direction: "asc", cursor: first.next_cursor ?? undefined }));
      expect(next).toMatchObject({ base_sha: fixture.first, head_sha: fixture.second, diff_digest: first.diff_digest });
      expect(next.items.map((item) => item.new_path)).toEqual(["binary.dat"]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects tree cursors replayed across tenants even when repository id and objects match", async () => {
    const fixture = await makeGitFixture();
    try {
      const port = makeSourceRead(fixture, { allowTenantB: true });
      const first = await Effect.runPromise(port.tree({ tenantId: "tenant-a", repositoryId: "repo-a", ref: fixture.second, recursive: true, limit: 2, direction: "asc" }));
      await expectInvalidCursor(port.tree({ tenantId: "tenant-b", repositoryId: "repo-a", ref: fixture.second, recursive: true, limit: 2, direction: "asc", cursor: first.next_cursor ?? undefined }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects diff cursors when query scope changes or the signed cursor is tampered", async () => {
    const fixture = await makeGitFixture();
    try {
      const port = makeSourceRead(fixture);
      const first = await Effect.runPromise(port.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: fixture.first, head: fixture.second, comparison: "two_dot", pathPrefix: "", contextLines: 1, limit: 1, direction: "asc" }));
      const cursor = first.next_cursor ?? "";
      expect(cursor).toEqual(expect.any(String));

      await expectInvalidCursor(port.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: fixture.first, head: fixture.second, comparison: "two_dot", pathPrefix: "dir", contextLines: 1, limit: 1, direction: "asc", cursor }));
      await expectInvalidCursor(port.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: fixture.first, head: fixture.second, comparison: "three_dot", pathPrefix: "", contextLines: 1, limit: 1, direction: "asc", cursor }));
      await expectInvalidCursor(port.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: fixture.first, head: fixture.second, comparison: "two_dot", pathPrefix: "", contextLines: 2, limit: 1, direction: "asc", cursor }));
      await expectInvalidCursor(port.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: fixture.first, head: fixture.second, comparison: "two_dot", pathPrefix: "", contextLines: 1, limit: 1, direction: "asc", cursor: tamperCursor(cursor) }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  it("rejects diff patches that are not valid UTF-8 text", async () => {
    const invalidPatch = Buffer.concat([
      Buffer.from(`diff --git a/bad.txt b/bad.txt\nindex ${"a".repeat(40)}..${"b".repeat(40)} 100644\n--- a/bad.txt\n+++ b/bad.txt\n@@ -1 +1 @@\n-old\n+`, "utf8"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from("\n", "utf8")
    ]);
    const port = makePatchSourceRead(new Uint8Array(invalidPatch));

    await expect(Effect.runPromise(port.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: "a".repeat(40), head: "b".repeat(40), comparison: "two_dot" }))).rejects.toMatchObject({ _tag: "SourceReadUnavailableError", code: "unsupported" });
  });

  it("marks parsed diff files truncated when the Git patch stream is byte-truncated", async () => {
    const port = makePatchSourceRead(Buffer.from(`diff --git a/README.md b/README.md\nindex ${"a".repeat(40)}..${"b".repeat(40)} 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n`, "utf8"), true);

    const page = await Effect.runPromise(port.diff({ tenantId: "tenant-a", repositoryId: "repo-a", base: "a".repeat(40), head: "b".repeat(40), comparison: "two_dot" }));

    expect(page).toMatchObject({ truncated: true, truncation_reason: "byte_limit" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ new_path: "README.md", truncated: true });
  });
});

function makeSourceRead(fixture: Awaited<ReturnType<typeof makeGitFixture>>, options?: { readonly allowTenantB?: boolean }) {
  return makeGitCliSourceRead({
    cursorSecret: "test-cursor-secret",
    maxFileBytes: 16,
    resolveRepository: async ({ tenantId, repositoryId }) => {
      const allowedTenant = tenantId === "tenant-a" || (options?.allowTenantB === true && tenantId === "tenant-b");
      if (!allowedTenant || repositoryId !== "repo-a") throw new Error("wrong repository");
      return { gitDir: fixture.bare };
    },
    git: { run: runGit }
  });
}

function makePatchSourceRead(patch: Uint8Array, truncated = false) {
  return makeGitCliSourceRead({
    cursorSecret: "test-cursor-secret",
    resolveRepository: async ({ tenantId, repositoryId }) => {
      if (tenantId !== "tenant-a" || repositoryId !== "repo-a") throw new Error("wrong repository");
      return { gitDir: "/fake/repo.git" };
    },
    git: {
      run: async (_gitDir, args) => {
        if (args[0] === "rev-parse" && typeof args[2] === "string") return { stdout: Buffer.from(args[2].slice(0, 40), "utf8") };
        if (args[0] === "diff") return { stdout: patch, truncated };
        throw new Error(`unexpected git command: ${args.join(" ")}`);
      }
    }
  });
}

async function expectInvalidCursor(effect: Effect.Effect<unknown, SourceReadUnavailableError>) {
  await expect(Effect.runPromise(effect)).rejects.toMatchObject({ _tag: "SourceReadUnavailableError", code: "invalid_input" });
}

function tamperCursor(cursor: string): string {
  return cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
}

async function makeGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "gitfoundry-source-read-"));
  const work = join(root, "work");
  const bare = join(root, "repo.git");
  await mkdir(work);
  await exec("git", ["init", "--initial-branch=main"], { cwd: work });
  await exec("git", ["config", "user.email", "tester@example.invalid"], { cwd: work });
  await exec("git", ["config", "user.name", "Tester"], { cwd: work });
  await writeFile(join(work, "README.md"), "hello world\n");
  await mkdir(join(work, "dir"));
  await writeFile(join(work, "dir", "nested.txt"), "nested\n");
  await writeFile(join(work, "invalid.bin"), Buffer.from([0xc3, 0x28]));
  await exec("git", ["add", "."], { cwd: work });
  await exec("git", ["commit", "-m", "initial"], { cwd: work });
  const first = (await exec("git", ["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
  await writeFile(join(work, "README.md"), "hello world\nsecond line\n");
  await writeFile(join(work, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(work, "large.txt"), "abcdefghijklmnopqrstuvwxyz0123456789ABCD");
  await exec("git", ["add", "."], { cwd: work });
  await exec("git", ["commit", "-m", "second"], { cwd: work });
  const second = (await exec("git", ["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
  await exec("git", ["clone", "--bare", work, bare]);
  return { root, work, bare, first, second };
}

async function advanceMainBranch(fixture: Awaited<ReturnType<typeof makeGitFixture>>): Promise<string> {
  await writeFile(join(fixture.work, "after-move.txt"), "branch moved\n");
  await exec("git", ["add", "."], { cwd: fixture.work });
  await exec("git", ["commit", "-m", "third"], { cwd: fixture.work });
  const third = (await exec("git", ["rev-parse", "HEAD"], { cwd: fixture.work })).stdout.trim();
  await exec("git", ["push", fixture.bare, "HEAD:main"], { cwd: fixture.work });
  return third;
}

async function runGit(gitDir: string, args: readonly string[], options?: { readonly maxBuffer?: number }) {
  try {
    const result = await exec("git", ["--git-dir=" + gitDir, ...args], { encoding: "buffer", maxBuffer: options?.maxBuffer ?? 1024 * 1024 });
    return { stdout: new Uint8Array(result.stdout as Buffer) };
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && error.stdout instanceof Buffer) {
      return { stdout: new Uint8Array(error.stdout as Buffer), truncated: true };
    }
    throw error;
  }
}

describe("Artifacts source read failures", () => {
  it("names an unexpected provider failure by its kind without carrying its message", async () => {
    const row = { artifacts_namespace: "gitfoundry-production", artifacts_name: "stored-provider-name" };
    const db = { prepare: () => ({ bind: () => ({ first: async () => row }) }) } as never;
    const repo = { info: async () => ({ name: "stored-provider-name" }), tree: async () => { throw new TypeError("private-provider-token") } };
    const source = makeD1ArtifactsSourceRead(db, { get: async () => repo } as never, { namespace: "gitfoundry-production" });
    const error = await Effect.runPromise(Effect.flip(source.tree({ tenantId: "owner", repositoryId: "repo-a", ref: "a".repeat(40) })));
    expect(error).toBeInstanceOf(SourceReadUnavailableError);
    expect(error.code).toBe("unavailable");
    expect(error.reason).toContain("TypeError");
    expect(JSON.stringify(error)).not.toContain("private-provider-token");
  });
});

describe("Artifacts source reads through the documented repository methods", () => {
  const commit = "c".repeat(40);
  const rootTree = "1".repeat(40), srcTree = "2".repeat(40), libTree = "3".repeat(40);
  const readme = "a".repeat(40), main = "b".repeat(40), util = "d".repeat(40), run = "e".repeat(40);
  const trees: Record<string, { name: string; mode: string; hash: string; type: string }[]> = {
    [rootTree]: [{ name: "README.md", mode: "100644", hash: readme, type: "blob" }, { name: "run.sh", mode: "100755", hash: run, type: "exec" }, { name: "src", mode: "40000", hash: srcTree, type: "tree" }],
    [srcTree]: [{ name: "lib", mode: "40000", hash: libTree, type: "tree" }, { name: "main.ts", mode: "100644", hash: main, type: "blob" }],
    [libTree]: [{ name: "util.ts", mode: "100644", hash: util, type: "blob" }]
  };
  const blobs: Record<string, string> = { [readme]: "hello world\n", [main]: "export {}\n", [util]: "export const x = 1\n", [run]: "#!/bin/sh\n" };
  // A Workers RPC stub answers every property with a callable; undocumented methods fail only when called.
  const repoStub = () => new Proxy({
    info: async () => ({ name: "stored-provider-name" }),
    readCommit: async (hash: string) => hash === commit ? { hash: commit, treeHash: rootTree, message: "m", parents: [] } : null,
    readTree: async (hash: string) => trees[hash] ?? null,
    readBlob: async (hash: string) => hash in blobs ? new Blob([blobs[hash]!]) : null,
    log: async (options?: { ref?: string; limit?: number }) => options?.ref === "main" ? [{ hash: commit, treeHash: rootTree }] : []
  } as Record<string | symbol, unknown>, { get: (target, key) => key in target || typeof key === "symbol" || key === "then" ? target[key] : async () => { throw new Error("method not found on remote private-provider-token") } });
  const source = () => makeD1ArtifactsSourceRead({ prepare: () => ({ bind: () => ({ first: async () => ({ artifacts_namespace: "gitfoundry-production", artifacts_name: "stored-provider-name" }) }) }) } as never, { get: async () => repoStub() } as never, { namespace: "gitfoundry-production" });
  const run_ = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const fail = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));
  const base = { tenantId: "owner", repositoryId: "repo-a" };

  it("lists the immediate children of the root tree at a commit", async () => {
    const page = await run_(source().tree({ ...base, ref: commit, direction: "asc" }));
    expect(page).toMatchObject({ repository_id: "repo-a", resolved_sha: commit, tree_sha: rootTree, has_more: false, next_cursor: null, truncated: false });
    expect(page.items).toEqual([
      { path: "README.md", path_base64: null, mode: "100644", kind: "blob", sha: readme, size_bytes: null },
      { path: "run.sh", path_base64: null, mode: "100755", kind: "blob", sha: run, size_bytes: null },
      { path: "src", path_base64: null, mode: "040000", kind: "tree", sha: srcTree, size_bytes: null }
    ]);
  });

  it("lists a subdirectory and the whole tree recursively with full paths", async () => {
    const sub = await run_(source().tree({ ...base, ref: commit, path: "src", direction: "asc" }));
    expect(sub.tree_sha).toBe(srcTree);
    expect(sub.items.map((item) => item.path)).toEqual(["src/lib", "src/main.ts"]);
    const all = await run_(source().tree({ ...base, ref: commit, recursive: true, direction: "asc", limit: 1000 }));
    expect(all.items.map((item) => item.path)).toEqual(["README.md", "run.sh", "src", "src/lib", "src/lib/util.ts", "src/main.ts"]);
  });

  it("pages a recursive listing with a cursor", async () => {
    const first = await run_(source().tree({ ...base, ref: commit, recursive: true, direction: "asc", limit: 4 }));
    expect(first.items.map((item) => item.path)).toEqual(["README.md", "run.sh", "src", "src/lib"]);
    expect(first.has_more).toBe(true);
    const second = await run_(source().tree({ ...base, ref: commit, recursive: true, direction: "asc", limit: 4, cursor: first.next_cursor! }));
    expect(second.items.map((item) => item.path)).toEqual(["src/lib/util.ts", "src/main.ts"]);
    expect(second.has_more).toBe(false);
  });

  it("resolves a branch name to its newest commit", async () => {
    const page = await run_(source().tree({ ...base, ref: "main", direction: "asc" }));
    expect(page.resolved_sha).toBe(commit);
  });

  it("reads a file's text, object ID, and size", async () => {
    const file = await run_(source().readFile({ ...base, ref: commit, path: "src/lib/util.ts" }));
    expect(file).toEqual({ repository_id: "repo-a", resolved_sha: commit, path: "src/lib/util.ts", sha: util, size_bytes: 19, encoding: "utf-8", contents: "export const x = 1\n", truncated: false });
  });

  it("reports missing commits and paths as not found, without provider messages", async () => {
    for (const effect of <Effect.Effect<unknown, SourceReadUnavailableError>[]>[source().tree({ ...base, ref: "f".repeat(40) }), source().tree({ ...base, ref: commit, path: "missing" }), source().readFile({ ...base, ref: commit, path: "src/missing.ts" })]) {
      const error = await fail(effect);
      expect(error.code).toBe("not_found");
      expect(JSON.stringify(error)).not.toContain("private-provider-token");
    }
  });
});
