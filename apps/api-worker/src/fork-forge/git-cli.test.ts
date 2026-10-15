import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeForgeService } from "@gitfoundry/core";

import { makeGitCliForgePort, type GitCliRunInput, type GitCliRunResult } from "./git-cli.js";

vi.setConfig({ testTimeout: 30000 });

const author = { name: "GitFoundry", email: "forge@gitfoundry.invalid" };
const timestamp = "2026-10-09T00:00:00.000Z";

describe("Git CLI fork-forge port", () => {
  it("stores code and forge-state as independent Git roots and publishes through CAS refs", async () => {
    const repo = await fixture();
    const codeRoot = await repo.port.writeCommit({ base: null, parents: [], changes: [{ path: "src/app.ts", content_base64: b64("export const answer = 1;\n") }], message: "code root", author, timestamp });
    const stateRoot = await repo.port.writeCommit({ base: null, parents: [], changes: [{ path: "issues/issue-a.json", content_base64: b64(JSON.stringify({ id: "issue-a", title: "First" }) + "\n") }], message: "state root", author, timestamp });

    expect(await repo.port.compareAndSwapRef("refs/heads/code", null, codeRoot)).toBe(true);
    expect(await repo.port.compareAndSwapRef("refs/heads/forge-state", null, stateRoot)).toBe(true);

    const stateOnly = await repo.port.writeCommit({ base: stateRoot, parents: [stateRoot], changes: [{ path: "reviews/review-a.json", content_base64: b64(JSON.stringify({ id: "review-a", code: codeRoot, decision: "approved" }) + "\n") }], message: "approve exact code", author, timestamp });

    expect(await repo.port.compareAndSwapRef("refs/heads/forge-state", stateRoot, stateOnly)).toBe(true);
    expect(await repo.port.readRef("refs/heads/code")).toBe(codeRoot);
    expect(await repo.port.readRef("refs/heads/forge-state")).toBe(stateOnly);
    expect(await repo.port.readFile(stateOnly, "reviews/review-a.json")).toBe(b64(JSON.stringify({ id: "review-a", code: codeRoot, decision: "approved" }) + "\n"));
  });

  it("allows only one concurrent CAS winner and rejects stale same-candidate publication", async () => {
    const repo = await fixture();
    const root = await repo.port.writeCommit({ base: null, parents: [], changes: [{ path: "README.md", content_base64: b64("root\n") }], message: "root", author, timestamp });
    const left = await repo.port.writeCommit({ base: root, parents: [root], changes: [{ path: "README.md", content_base64: b64("left\n") }], message: "left", author, timestamp });
    const right = await repo.port.writeCommit({ base: root, parents: [root], changes: [{ path: "README.md", content_base64: b64("right\n") }], message: "right", author, timestamp });

    expect(await repo.port.compareAndSwapRef("refs/heads/main", null, root)).toBe(true);
    const first = await repo.port.compareAndSwapRef("refs/heads/main", root, left);
    const second = await repo.port.compareAndSwapRef("refs/heads/main", root, right);
    const replayStale = await repo.port.compareAndSwapRef("refs/heads/main", root, left);

    expect([first, second]).toEqual([true, false]);
    expect(replayStale).toBe(false);
    expect(await repo.port.readRef("refs/heads/main")).toBe(left);
  });

  it("preserves binary content and newline/BOM filenames through real Git objects", async () => {
    const repo = await fixture();
    const binary = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const path = "docs/\ufeffname\nline.bin";
    const commit = await repo.port.writeCommit({ base: null, parents: [], changes: [{ path, content_base64: toBase64(binary) }], message: "binary", author, timestamp });

    const tree = await repo.port.listTree(commit);

    expect(tree).toMatchObject([{ path, mode: "100644", type: "blob", size: binary.length }]);
    expect(await repo.port.readFile(commit, path)).toBe(toBase64(binary));
  });

  it("compares commits with normalized file status objects", async () => {
    const repo = await fixture();
    const base = await repo.port.writeCommit({ base: null, parents: [], changes: [
      { path: "keep.txt", content_base64: b64("one\n") },
      { path: "delete.txt", content_base64: b64("remove\n") }
    ], message: "base", author, timestamp });
    const head = await repo.port.writeCommit({ base, parents: [base], changes: [
      { path: "keep.txt", content_base64: b64("two\n") },
      { path: "delete.txt", content_base64: null },
      { path: "add.txt", content_base64: b64("new\n") }
    ], message: "head", author, timestamp });

    expect(await repo.port.compareCommits(base, head)).toEqual({ files: [
      { path: "add.txt", status: "added" },
      { path: "delete.txt", status: "deleted" },
      { path: "keep.txt", status: "modified" }
    ] });
  });

  it("creates clean merge commits and retains explicit conflicts without moving refs", async () => {
    const repo = await fixture();
    const base = await repo.port.writeCommit({ base: null, parents: [], changes: [
      { path: "api.ts", content_base64: b64("export const value = 1;\n") },
      { path: "client.ts", content_base64: b64("export const client = 1;\n") },
      { path: "shared.txt", content_base64: b64("base\n") }
    ], message: "base", author, timestamp });
    const left = await repo.port.writeCommit({ base, parents: [base], changes: [{ path: "api.ts", content_base64: b64("export const value = 2;\n") }], message: "api change", author, timestamp });
    const right = await repo.port.writeCommit({ base, parents: [base], changes: [{ path: "client.ts", content_base64: b64("export const client = 2;\n") }], message: "client change", author, timestamp });

    const merged = await repo.port.mergeCommits({ base, left, right, message: "integrate forks", author, timestamp });

    expect(merged.status).toBe("merged");
    if (merged.status === "merged") {
      expect(await repo.port.isAncestor(left, merged.commit)).toBe(true);
      expect(await repo.port.isAncestor(right, merged.commit)).toBe(true);
      expect(await repo.port.readFile(merged.commit, "api.ts")).toBe(b64("export const value = 2;\n"));
      expect(await repo.port.readFile(merged.commit, "client.ts")).toBe(b64("export const client = 2;\n"));
    }

    const conflictLeft = await repo.port.writeCommit({ base, parents: [base], changes: [{ path: "shared.txt", content_base64: b64("left\n") }], message: "left conflict", author, timestamp });
    const conflictRight = await repo.port.writeCommit({ base, parents: [base], changes: [{ path: "shared.txt", content_base64: b64("right\n") }], message: "right conflict", author, timestamp });
    const conflicted = await repo.port.mergeCommits({ base, left: conflictLeft, right: conflictRight, message: "conflict", author, timestamp });

    expect(conflicted).toEqual({ status: "conflict", paths: ["shared.txt"] });
    expect(await repo.port.readRef("refs/heads/main")).toBeNull();
  });

  it("lists retained refs under a bounded exact prefix", async () => {
    const repo = await fixture();
    const root = await repo.port.writeCommit({ base: null, parents: [], changes: [{ path: "forge/version.json", content_base64: b64("{}\n") }], message: "root", author, timestamp });
    const child = await repo.port.writeCommit({ base: root, parents: [root], changes: [{ path: "forge/version.json", content_base64: b64("{\"child\":true}\n") }], message: "child", author, timestamp });
    expect(await repo.port.compareAndSwapRef("refs/gitfoundry/forks/root", null, root)).toBe(true);
    expect(await repo.port.compareAndSwapRef("refs/gitfoundry/forks/child", null, child)).toBe(true);
    expect(await repo.port.compareAndSwapRef("refs/heads/main", null, root)).toBe(true);

    await expect(repo.port.listRefs("refs/gitfoundry/forks/")).resolves.toEqual([
      { ref: "refs/gitfoundry/forks/child", target: child },
      { ref: "refs/gitfoundry/forks/root", target: root }
    ]);
    await expect(repo.port.listRefs("refs/gitfoundry/forks")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(makeGitCliForgePort({ gitDir: repo.gitDir, indexDir: repo.indexDir, run: runGit, maxRefEntries: 1 }).listRefs("refs/gitfoundry/forks/")).rejects.toMatchObject({ code: "bound_exceeded" });
  });

  it("mirrors retained refs without missing objects", async () => {
    const repo = await fixture();
    const root = await repo.port.writeCommit({ base: null, parents: [], changes: [{ path: "forge/version.json", content_base64: b64("{}\n") }], message: "root", author, timestamp });
    const child = await repo.port.writeCommit({ base: root, parents: [root], changes: [{ path: "forge/version.json", content_base64: b64("{\"child\":true}\n") }], message: "child", author, timestamp });
    expect(await repo.port.compareAndSwapRef("refs/gitfoundry/forks/root", null, root)).toBe(true);
    expect(await repo.port.compareAndSwapRef("refs/gitfoundry/forks/child", null, child)).toBe(true);

    const mirror = await mkdtemp(join(tmpdir(), "gfy-mirror-"));
    await gitFile(["clone", "--mirror", repo.gitDir, mirror]);
    const fsck = await gitFile(["--git-dir", mirror, "fsck", "--no-dangling"]);
    const refs = await gitFile(["--git-dir", mirror, "for-each-ref", "--format=%(refname):%(objectname)", "refs/gitfoundry/forks"]);

    expect(fsck.stderr).toBe("");
    expect(refs.stdout).toContain(`refs/gitfoundry/forks/root:${root}`);
    expect(refs.stdout).toContain(`refs/gitfoundry/forks/child:${child}`);
  });

  it("preserves executable and symlink modes through snapshots mirrors and mode changes", async () => {
    const repo = await fixture();
    const script = b64("#!/bin/sh\necho gitfoundry\n");
    const root = await repo.port.writeCommit({ base: null, parents: [], changes: [
      { path: "bin/gitfoundry", content_base64: script, mode: "100755" },
      { path: "bin/current", content_base64: b64("gitfoundry"), mode: "120000" }
    ], message: "mode root", author, timestamp } as any);

    expect(await repo.port.listTree(root, "bin")).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "bin/gitfoundry", mode: "100755", type: "blob" }),
      expect.objectContaining({ path: "bin/current", mode: "120000", type: "blob" })
    ]));

    const mirror = await mkdtemp(join(tmpdir(), "gfy-mode-mirror-"));
    await gitFile(["clone", "--mirror", repo.gitDir, mirror]);
    const mirroredTree = await gitFile(["--git-dir", mirror, "ls-tree", "-r", root]);
    expect(mirroredTree.stdout).toContain("100755 blob");
    expect(mirroredTree.stdout).toContain("bin/gitfoundry");
    expect(mirroredTree.stdout).toContain("120000 blob");
    expect(mirroredTree.stdout).toContain("bin/current");

    const modeOnly = await repo.port.writeCommit({ base: root, parents: [root], changes: [
      { path: "bin/gitfoundry", content_base64: script, mode: "100644" }
    ], message: "drop executable bit", author, timestamp } as any);
    expect(await repo.port.compareCommits(root, modeOnly)).toEqual({ files: [{ path: "bin/gitfoundry", status: "modified" }] });
    expect(await repo.port.listTree(modeOnly, "bin/gitfoundry")).toEqual([expect.objectContaining({ path: "bin/gitfoundry", mode: "100644" })]);
  });
  it("recovers an interrupted conditional publisher and replays its durable result after a head reset", async () => {
    const repo = await fixture();
    const actor = { id: "release-agent", kind: "agent" as const };
    const headRef = "refs/heads/forge-head";
    const resultRef = "refs/heads/operations/publish-late/result";
    let held: Parameters<typeof repo.port.compareAndSwapRef> | undefined;
    let headUpdateAttempts = 0;
    const interruptedPort = {
      ...repo.port,
      compareAndSwapRef: async (...update: Parameters<typeof repo.port.compareAndSwapRef>) => {
        if (update[0] === headRef && update[1] !== null) {
          headUpdateAttempts += 1;
          held = [...update];
          throw new Error("interrupted before the conditional head update");
        }
        return repo.port.compareAndSwapRef(...update);
      }
    };
    const serviceFor = (git: typeof repo.port) => makeForgeService({
      git, tenant_id: "release", repository_id: "fencing",
      clock: () => timestamp, authorize: async () => {}, verifyEvidence: async () => {}
    });
    const service = serviceFor(interruptedPort);
    const root = await service.initialize({
      operation_id: "initialize", actor,
      initial_code: [{ path: "app.js", content_base64: b64("export const answer = 1;\n") }]
    });
    const candidate = await service.commit({
      operation_id: "candidate", parent_version: root.version_commit, actor,
      changes: [{ tree: "code", path: "app.js", content_base64: b64("export const answer = 2;\n") }]
    });
    await expect(service.publish({
      operation_id: "publish-late", expected_version: root.version_commit,
      new_version: candidate.version_commit, actor
    })).rejects.toThrow("interrupted before the conditional head update");
    expect(held).toBeDefined();
    expect(await repo.port.readRef(headRef)).toBe(root.version_commit);
    expect(await repo.port.readRef(resultRef)).toBeNull();

    const recovered = await serviceFor(repo.port).recover({ operation_id: "publish-late", actor });
    expect(recovered).toMatchObject({ status: "published", version: { version_commit: candidate.version_commit } });
    const resultCommit = await repo.port.readRef(resultRef);
    expect(resultCommit).not.toBeNull();
    expect(await repo.port.readRef(headRef)).toBe(candidate.version_commit);
    const record = await repo.port.readFile(resultCommit!, "operation.json");
    expect(record).not.toBeNull();

    expect(await repo.port.compareAndSwapRef(headRef, candidate.version_commit, root.version_commit)).toBe(true);
    expect(await repo.port.readRef(headRef)).toBe(root.version_commit);
    const replayed = await service.publish({
      operation_id: "publish-late", expected_version: root.version_commit,
      new_version: candidate.version_commit, actor
    });
    expect(replayed.version_commit).toBe(candidate.version_commit);
    expect(await service.recover({ operation_id: "publish-late", actor })).toMatchObject({ status: "published", version: { version_commit: candidate.version_commit } });
    expect(headUpdateAttempts).toBe(1);
    expect(await repo.port.readRef(headRef)).toBe(root.version_commit);
    expect(await repo.port.readRef(resultRef)).toBe(resultCommit);
    const refs = await gitFile(["--git-dir", repo.gitDir, "for-each-ref", "--format=%(objectname)"]);
    expect(refs.stdout).toContain(candidate.version_commit);
    await gitFile(["--git-dir", repo.gitDir, "fsck", "--no-dangling"]);
  });

});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gfy-forge-"));
  const gitDir = join(dir, "repo.git");
  const indexDir = join(dir, "indexes");
  await mkdir(indexDir);
  await gitFile(["init", "--bare", gitDir]);
  const port = makeGitCliForgePort({ gitDir, indexDir, run: runGit });
  return { gitDir, indexDir, port };
}

async function runGit(input: GitCliRunInput): Promise<GitCliRunResult> {
  const result = await spawnGit([...input.arg], input.env, input.stdin);
  return { exitCode: result.exitCode, stdout: new Uint8Array(result.stdout), stderr: new Uint8Array(result.stderr) };
}

async function gitFile(arg: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await spawnGit(arg);
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString("utf8"));
  return { stdout: Buffer.from(result.stdout).toString("utf8"), stderr: Buffer.from(result.stderr).toString("utf8") };
}

async function spawnGit(arg: readonly string[], entries?: readonly string[], stdin?: Uint8Array): Promise<{ readonly exitCode: number; readonly stdout: Buffer; readonly stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...arg], { env: envWith(entries), stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    if (stdin) child.stdin.end(Buffer.from(stdin));
    else child.stdin.end();
  });
}

function envWith(entries: readonly string[] | undefined = undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const entry of entries ?? []) {
    const at = entry.indexOf("=");
    env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
