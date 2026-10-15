import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeArtifactsForgeWrites, type ArtifactsWriteRepo } from "./artifacts-write.js";

// A local bare repository stands in for Artifacts: reads use git cat-file, and pushes go through
// git receive-pack itself, so Git (not this code) decides whether the objects and ref updates are valid.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) });

const author = { name: "agent-a", email: "agent-a@gitfoundry.dev" };
const timestamp = "2026-10-13T12:00:00.000Z";
const b64 = (text: string) => Buffer.from(text).toString("base64");

function bareRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gfy-artifacts-write-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["--git-dir", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git("init", "--bare", "--quiet");
  git("config", "receive.advertiseAtomic", "true");
  const pushes: number[] = [];
  const repo: ArtifactsWriteRepo = {
    info: async () => ({ name: "repo", remote: "https://artifacts.test/git/ns/repo.git" }),
    createToken: async () => ({ plaintext: "token" }),
    readCommit: async (hash) => {
      try {
        const raw = git("cat-file", "commit", hash);
        return { hash, treeHash: /^tree ([0-9a-f]{40})/mu.exec(raw)![1]!, parents: [...raw.matchAll(/^parent ([0-9a-f]{40})/gmu)].map((m) => m[1]!) };
      } catch { return null }
    },
    readTree: async (hash) => {
      try {
        return git("ls-tree", hash).split("\n").filter(Boolean).map((line) => {
          const [meta, name] = line.split("\t");
          const [mode, type, oid] = meta!.split(" ");
          return { name: name!, mode: mode === "040000" ? "40000" : mode!, hash: oid!, type: type! };
        });
      } catch { return null }
    },
    readBlob: async (hash) => new Blob([execFileSync("git", ["--git-dir", dir, "cat-file", "blob", hash])])
  };
  const fetch = async (request: Request) => {
    expect(new URL(request.url).pathname).toBe("/git/ns/repo.git/git-receive-pack");
    pushes.push(Date.now());
    const result = spawnSync("git", ["receive-pack", "--stateless-rpc", dir], { input: Buffer.from(await request.arrayBuffer()) });
    return new Response(result.stdout, { status: result.status === 0 ? 200 : 500 });
  };
  return { dir, git, repo, fetch, pushes };
}

function seed(git: (...args: string[]) => string, files: Record<string, string>) {
  const index = { GIT_INDEX_FILE: join(git("rev-parse", "--absolute-git-dir"), "seed-index") };
  for (const [path, content] of Object.entries(files)) {
    const oid = execFileSync("git", ["--git-dir", git("rev-parse", "--absolute-git-dir"), "hash-object", "-w", "--stdin"], { input: content, encoding: "utf8" }).trim();
    execFileSync("git", ["--git-dir", git("rev-parse", "--absolute-git-dir"), "update-index", "--add", "--cacheinfo", "100644", oid, path], { env: { ...process.env, ...index } });
  }
  const tree = execFileSync("git", ["--git-dir", git("rev-parse", "--absolute-git-dir"), "write-tree"], { env: { ...process.env, ...index }, encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["--git-dir", git("rev-parse", "--absolute-git-dir"), "commit-tree", tree, "-m", "seed"], { env: { ...process.env, GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "seed@x", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "seed@x" }, encoding: "utf8" }).trim();
  git("update-ref", "refs/heads/main", commit);
  return commit;
}

describe("Worker-side forge writes", () => {
  it("writes a commit that passes Git's strict check and reads back exactly as written", async () => {
    const { git, repo, fetch } = bareRepo();
    const base = seed(git, { "src/cart.js": "export const a = 1;\n", "README.md": "# Cart\n" });
    const writes = makeArtifactsForgeWrites({ repo: async () => repo, fetch });
    const commit = await writes.writeCommit({ base, parents: [base], changes: [{ path: "src/cart.js", content_base64: b64("export const a = 2;\n") }, { path: "src/tax.js", content_base64: b64("export const rate = 0.1;\n"), mode: "100755" }, { path: "README.md", content_base64: null }, { path: "src.notes", content_base64: b64("sorted before src/ by Git\n") }], message: "agent-a: add tax", author, timestamp });
    expect(git("cat-file", "-t", commit)).toBe("commit");
    expect(git("fsck", "--strict", "--no-dangling")).toBe("");
    expect(git("rev-parse", "refs/heads/retained/objects/" + commit)).toBe(commit);
    expect(git("ls-tree", "-r", "--name-only", commit).split("\n")).toEqual(["src.notes", "src/cart.js", "src/tax.js"]);
    expect(git("ls-tree", commit + ":src")).toMatch(/^100755 blob [0-9a-f]{40}\ttax\.js$/mu);
    expect(git("show", commit + ":src/cart.js")).toBe("export const a = 2;");
    expect(git("log", "-1", "--format=%P|%an <%ae>|%at|%s", commit)).toBe(`${base}|agent-a <agent-a@gitfoundry.dev>|${Date.parse(timestamp) / 1000}|agent-a: add tax`);
  });

  it("swaps a ref only from its expected value, so a stale writer loses", async () => {
    const { git, repo, fetch } = bareRepo();
    const base = seed(git, { "a.txt": "a\n" });
    const writes = makeArtifactsForgeWrites({ repo: async () => repo, fetch });
    const left = await writes.writeCommit({ base, parents: [base], changes: [{ path: "a.txt", content_base64: b64("left\n") }], message: "left", author, timestamp });
    const right = await writes.writeCommit({ base, parents: [base], changes: [{ path: "a.txt", content_base64: b64("right\n") }], message: "right", author, timestamp });
    expect(await writes.compareAndSwapRef("refs/heads/forge-head", base, left)).toBe(false);
    expect(await writes.compareAndSwapRef("refs/heads/forge-head", null, left)).toBe(true);
    expect(await writes.compareAndSwapRef("refs/heads/forge-head", base, right)).toBe(false);
    expect(git("rev-parse", "refs/heads/forge-head")).toBe(left);
    expect(await writes.compareAndSwapRefs([{ ref: "refs/heads/forge-head", expected: left, next: right }, { ref: "refs/heads/other", expected: base, next: right }])).toBe(false);
    expect(git("rev-parse", "refs/heads/forge-head")).toBe(left);
    expect(await writes.compareAndSwapRef("refs/heads/forge-head", left, null)).toBe(true);
    expect(spawnSync("git", ["--git-dir", git("rev-parse", "--absolute-git-dir"), "rev-parse", "--verify", "refs/heads/forge-head"]).status).not.toBe(0);
  });

  it("answers ancestry and comparison from the repository's own history", async () => {
    const { git, repo, fetch } = bareRepo();
    const base = seed(git, { "a.txt": "a\n", "b.txt": "b\n" });
    const writes = makeArtifactsForgeWrites({ repo: async () => repo, fetch });
    const child = await writes.writeCommit({ base, parents: [base], changes: [{ path: "a.txt", content_base64: b64("A\n") }, { path: "c.txt", content_base64: b64("c\n") }, { path: "b.txt", content_base64: null }], message: "child", author, timestamp });
    expect(await writes.isAncestor(base, child)).toBe(true);
    expect(await writes.isAncestor(child, base)).toBe(false);
    expect((await writes.compareCommits(base, child)).files.map((file) => [file.path, file.status])).toEqual(git("diff-tree", "-r", "--no-commit-id", "--name-status", base, child).split("\n").map((line) => line.split("\t")).map(([status, path]) => [path, ({ A: "added", M: "modified", D: "deleted" } as Record<string, string>)[status!]]));
  });

  it("merges agents that changed different files and reports a conflict when both changed the same file", async () => {
    const { git, repo, fetch } = bareRepo();
    const base = seed(git, { "src/cart.js": "cart\n", "src/tax.js": "tax\n" });
    const writes = makeArtifactsForgeWrites({ repo: async () => repo, fetch });
    const a = await writes.writeCommit({ base, parents: [base], changes: [{ path: "src/cart.js", content_base64: b64("cart by a\n") }], message: "a", author, timestamp });
    const b = await writes.writeCommit({ base, parents: [base], changes: [{ path: "src/tax.js", content_base64: b64("tax by b\n") }], message: "b", author, timestamp });
    const merged = await writes.mergeCommits({ base, left: a, right: b, author, timestamp, message: "merge a and b" });
    expect(merged.status).toBe("merged");
    const commit = (merged as { commit: string }).commit;
    expect(git("log", "-1", "--format=%P", commit)).toBe(`${a} ${b}`);
    expect([git("show", commit + ":src/cart.js"), git("show", commit + ":src/tax.js")]).toEqual(["cart by a", "tax by b"]);
    const c = await writes.writeCommit({ base, parents: [base], changes: [{ path: "src/cart.js", content_base64: b64("cart by c\n") }], message: "c", author, timestamp });
    expect(await writes.mergeCommits({ base, left: a, right: c, author, timestamp, message: "merge a and c" })).toEqual({ status: "conflict", paths: ["src/cart.js"] });
    // The helper's line-level merge reports every differing file; only files both sides changed are conflicts.
    const withHelper = makeArtifactsForgeWrites({ repo: async () => repo, fetch, mergeFallback: async () => ({ status: "conflict", paths: ["src/cart.js", "src/tax.js"] }) });
    const ab = (merged as { commit: string }).commit;
    expect(await withHelper.mergeCommits({ base, left: ab, right: c, author, timestamp, message: "merge ab and c" })).toEqual({ status: "conflict", paths: ["src/cart.js"] });
  });

  it("sends a push again when the provider answers without running it", async () => {
    const { git, repo, fetch, pushes } = bareRepo();
    const base = seed(git, { "a.txt": "a\n" });
    let skipped = 0;
    const overlapping = async (request: Request) => (skipped++ < 2 ? new Response("0000") : fetch(request));
    const writes = makeArtifactsForgeWrites({ repo: async () => repo, fetch: overlapping });
    const commit = await writes.writeCommit({ base, parents: [base], changes: [{ path: "a.txt", content_base64: b64("b\n") }], message: "retry", author, timestamp });
    expect(skipped).toBe(3);
    expect(pushes).toHaveLength(1);
    expect(git("rev-parse", "refs/heads/retained/objects/" + commit)).toBe(commit);
  });

  it("names the provider's answer when it never runs the push", async () => {
    const { git, repo } = bareRepo();
    const base = seed(git, { "a.txt": "a\n" });
    let calls = 0;
    const writes = makeArtifactsForgeWrites({ repo: async () => repo, fetch: async () => (calls++, new Response("0014ERR busy, retry\n0000")) });
    await expect(writes.writeCommit({ base, parents: [base], changes: [{ path: "a.txt", content_base64: b64("b\n") }], message: "retry", author, timestamp }))
      .rejects.toMatchObject({ code: "provider_unavailable", message: "push unpack failed", detail: { helper_detail: "unpack missing: 0014ERR busy, retry 0000" } });
    expect(calls).toBe(5);
  });
});
