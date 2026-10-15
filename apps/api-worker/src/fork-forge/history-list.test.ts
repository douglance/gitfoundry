import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForgeVersionAuthenticationError, makeForgeService, type ForgeVersion } from "@gitfoundry/core";
import { makeGitCliForgePort, type GitCliRunInput, type GitCliRunResult } from "./git-cli.js";

const actor = { id: "history-reader", kind: "human" } as const;
let dir: string;
let gitDir: string;
let delayed = false;
let service: ReturnType<typeof makeForgeService>;
let expected: ForgeVersion[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-history-"));
  gitDir = join(dir, "repo.git");
  const indexDir = join(dir, "indexes");
  await mkdir(indexDir);
  await runGit({ arg: ["init", "--bare", gitDir] });
  const port = makeGitCliForgePort({ gitDir, indexDir, run: runGit });
  service = makeForgeService({
    git: port, tenant_id: "history-tenant", repository_id: "history-repository",
    clock: () => "2026-10-11T00:00:00.000Z",
    authorize: async () => {}, verifyEvidence: async () => {}
  });
  const root = await service.initialize({
    operation_id: "history-000", actor,
    initial_code: [{ path: "README.md", content_base64: Buffer.from("History fixture\n").toString("base64") }]
  });
  expected = [root];
  for (let index = 1; index <= 80; index += 1) {
    expected.push(await service.fork({
      operation_id: "history-" + String(index).padStart(3, "0"),
      parent_version: root.version_commit, actor
    }));
  }
  delayed = true;
}, 240000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.sequential("retained history loading", () => {
  it("R1 returns all 81 authenticated versions before the ten-second native deadline", async () => {
    const start = performance.now();
    const versions = await service.list(actor);
    const elapsed = performance.now() - start;
    expect(versions).toEqual(expected);
    expect(elapsed).toBeLessThan(10000);
  }, 30000);

  it("R2 rejects a mismatched retained code reference", async () => {
    const version = expected[40]!;
    const ref = "refs/heads/retained/" + version.descriptor.fork_id + "/code";
    delayed = false;
    try {
      const result = await runGit({ arg: ["--git-dir", gitDir, "update-ref", ref, version.descriptor.state_commit] });
      expect(result.exitCode).toBe(0);
      await expect(service.list(actor)).rejects.toBeInstanceOf(ForgeVersionAuthenticationError);
    } finally {
      const restored = await runGit({ arg: ["--git-dir", gitDir, "update-ref", ref, version.descriptor.code_commit] });
      expect(restored.exitCode).toBe(0);
      delayed = true;
    }
  }, 30000);
});

async function runGit(input: GitCliRunInput): Promise<GitCliRunResult> {
  if (delayed) await delay(40);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const entry of input.env ?? []) {
    const at = entry.indexOf("=");
    env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...input.arg], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => resolve({
      exitCode: code ?? 1, stdout: new Uint8Array(Buffer.concat(stdout)),
      stderr: new Uint8Array(Buffer.concat(stderr))
    }));
    child.stdin.end(input.stdin ? Buffer.from(input.stdin) : undefined);
  });
}
