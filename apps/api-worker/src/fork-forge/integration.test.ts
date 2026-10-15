import { Schema } from "effect";
import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeBase64Utf8 as b64, makeForgeService, type ForgeActor, type ForgeGitPort } from "@gitfoundry/core";

import { canonicalPublicationEvidencePayload, verifyPublicationEvidence, type PublicationEvidenceRecord } from "./evidence.js";
import { makeGitCliForgePort, type GitCliRunInput, type GitCliRunResult } from "./git-cli.js";

vi.setConfig({ testTimeout: 60000 });

const timestamp = "2026-10-09T00:00:00.000Z";
const actor: ForgeActor = { id: "agent-a", kind: "agent" };
const publisher: ForgeActor = { id: "publisher-a", kind: "service" };

describe("fork forge exact evidence integration", () => {
  it("publishes only exact checked/reviewed candidates, preserves rejected forks, and restores from a mirror", async () => {
    const repo = await fixture();
    const runnerKeys = await keys();
    const reviewerKeys = await keys();
    const trustedKeys = { "runner-key": runnerKeys.publicJwk, "reviewer-key": reviewerKeys.publicJwk };
    const service = serviceFor(repo.port, trustedKeys);
    const codeRoot = await repo.port.writeCommit({ base: null, parents: [], changes: [{ path: "src/api.txt", content_base64: b64("api=v1\n") }, { path: "src/client.txt", content_base64: b64("client=v1\n") }], message: "code root", author: author(), timestamp });
    const initial = await service.initialize({ operation_id: "init-a", code_commit: codeRoot, actor: publisher, initial_state: [{ path: "config/publication.json", content_base64: b64(JSON.stringify(policy("sha256:evaluator-a"))) }] });

    const leftFork = await service.fork({ operation_id: "fork-left", parent_version: initial.version_commit, actor });
    const rightFork = await service.fork({ operation_id: "fork-right", parent_version: initial.version_commit, actor });
    const left = await service.commit({ operation_id: "left-change", parent_version: leftFork.version_commit, actor, changes: [{ tree: "code", path: "src/api.txt", content_base64: b64("api=v2\n") }] });
    const right = await service.commit({ operation_id: "right-change", parent_version: rightFork.version_commit, actor, changes: [{ tree: "code", path: "src/client.txt", content_base64: b64("client=v2\n") }] });
    const merged = await service.merge({ operation_id: "merge-left-right", base_version: initial.version_commit, left_version: left.version_commit, right_version: right.version_commit, actor });
    expect(merged.status).toBe("version");
    if (merged.status !== "version") throw new Error("expected merge version");
    expect(await repo.port.isAncestor(left.version_commit, merged.version.version_commit)).toBe(true);
    expect(await repo.port.isAncestor(right.version_commit, merged.version.version_commit)).toBe(true);

    const check = await sign(runnerKeys.privateKey, { schema_version: 1, kind: "check", id: "unit", candidate_code_commit: merged.version.descriptor.code_commit, evaluator_digest: "sha256:evaluator-a", outcome: "passed", actor_id: "runner-a", actor_kind: "agent", key_id: "runner-key", signature: "" });
    const review = await sign(reviewerKeys.privateKey, { schema_version: 1, kind: "review", id: "review-a", candidate_code_commit: merged.version.descriptor.code_commit, evaluator_digest: "sha256:evaluator-a", decision: "approve", actor_id: "reviewer-a", actor_kind: "human", key_id: "reviewer-key", signature: "" });
    const checkpoint = { id: "handoff-a", kind: "checkpoint", candidate_code_commit: merged.version.descriptor.code_commit, completed: ["api=v2", "client=v2"], next: "inspect signed check and review before publication" };
    const candidate = await service.commit({ operation_id: "attach-evidence", parent_version: merged.version.version_commit, actor, changes: [{ tree: "state", path: "checks/unit.json", content_base64: b64(JSON.stringify(check)) }, { tree: "state", path: "reviews/review-a.json", content_base64: b64(JSON.stringify(review)) }, { tree: "state", path: "checkpoints/handoff-a.json", content_base64: b64(JSON.stringify(checkpoint)) }] });
    const published = await service.publish({ operation_id: "publish-candidate", expected_version: initial.version_commit, new_version: candidate.version_commit, actor: publisher });
    expect(published.version_commit).toBe(candidate.version_commit);

    const rejectedFork = await service.fork({ operation_id: "stale-fork", parent_version: initial.version_commit, actor });
    await expect(service.publish({ operation_id: "publish-stale", expected_version: initial.version_commit, new_version: candidate.version_commit, actor: publisher })).rejects.toThrow(/forge-head/);
    await expect(service.read(rejectedFork.version_commit, actor)).resolves.toMatchObject({ version_commit: rejectedFork.version_commit });

    const mirrorDir = join(repo.dir, "mirror.git");
    await git(["clone", "--mirror", repo.gitDir, mirrorDir]);
    const restoredIndexDir = join(repo.dir, "restored-indexes");
    await mkdir(restoredIndexDir);
    const restored = serviceFor(makeGitCliForgePort({ gitDir: mirrorDir, indexDir: restoredIndexDir, run: runGit }), trustedKeys);
    await expect(restored.head(actor)).resolves.toMatchObject({ version_commit: candidate.version_commit });
    await expect(restored.read(rejectedFork.version_commit, actor)).resolves.toMatchObject({ version_commit: rejectedFork.version_commit });
    for (const [tree, path, expected] of [
      ["code", "src/api.txt", "api=v2\n"],
      ["code", "src/client.txt", "client=v2\n"],
      ["state", "checks/unit.json", JSON.stringify(check)],
      ["state", "reviews/review-a.json", JSON.stringify(review)],
      ["state", "checkpoints/handoff-a.json", JSON.stringify(checkpoint)],
    ] as const) {
      await expect(restored.read({ version: candidate.version_commit, tree, path, actor })).resolves.toMatchObject({ content_base64: b64(expected) });
    }
  });
});


describe("collaboration-only publication acceptance", () => {
  it("R1 publishes issue and comment changes without code acceptance receipts", async () => {
    const { service, initial } = await collaborationFixture();
    let head = initial;
    const changes = [
      { tree: "state", path: "issues/task.json", content_base64: b64('{"id":"task","kind":"issue","title":"Build the forge","state":"open"}') },
      { tree: "state", path: "issues/task.json", content_base64: b64('{"id":"task","kind":"issue","title":"Build the forge","state":"closed"}') },
      { tree: "state", path: "comments/note.json", content_base64: b64('{"id":"note","kind":"comment","body":"Reviewed the behavior"}') },
      { tree: "state", path: "comments/note.json", content_base64: null },
    ] as const;
    for (const [index, change] of changes.entries()) {
      const candidate = await service.commit({ operation_id: "collaboration-change-" + index, parent_version: head.version_commit, actor, changes: [change] });
      head = await service.publish({ operation_id: "collaboration-publish-" + index, expected_version: head.version_commit, new_version: candidate.version_commit, actor: publisher });
      expect(head.version_commit).toBe(candidate.version_commit);
      expect(head.descriptor.code_commit).toBe(initial.descriptor.code_commit);
    }
    await expect(service.read({ version: head.version_commit, tree: "state", path: "issues/task.json", actor })).resolves.toMatchObject({ content_base64: b64('{"id":"task","kind":"issue","title":"Build the forge","state":"closed"}') });
    await expect(service.head(actor)).resolves.toMatchObject({ version_commit: head.version_commit });
  });

  it("R2 rejects code, evidence, other state, and symbolic-link changes without receipts", async () => {
    const { service, initial } = await collaborationFixture();
    const changes = [
      { tree: "code", path: "README.md", content_base64: b64("changed code") },
      { tree: "state", path: "checks/forged.json", content_base64: b64('{"kind":"check","id":"forged"}') },
      { tree: "state", path: "reviews/forged.json", content_base64: b64('{"kind":"review","id":"forged"}') },
      { tree: "state", path: "unknown/record.json", content_base64: b64("{}") },
      { tree: "state", path: "issues/link.json", content_base64: b64("../config/publication.json"), mode: "120000" },
    ] as const;
    for (const [index, change] of changes.entries()) {
      const candidate = await service.commit({ operation_id: "non-collaboration-change-" + index, parent_version: initial.version_commit, actor, changes: [change] });
      await expect(service.publish({ operation_id: "non-collaboration-publish-" + index, expected_version: initial.version_commit, new_version: candidate.version_commit, actor: publisher })).rejects.toThrow();
      await expect(service.head(actor)).resolves.toMatchObject({ version_commit: initial.version_commit });
    }
    for (const [index, forbidden] of changes.slice(0, 4).entries()) {
      const candidate = await service.commit({ operation_id: "mixed-collaboration-change-" + index, parent_version: initial.version_commit, actor, changes: [forbidden, { tree: "state", path: "issues/allowed.json", content_base64: b64('{"id":"allowed","kind":"issue"}') }] });
      await expect(service.publish({ operation_id: "mixed-collaboration-publish-" + index, expected_version: initial.version_commit, new_version: candidate.version_commit, actor: publisher })).rejects.toThrow();
      await expect(service.head(actor)).resolves.toMatchObject({ version_commit: initial.version_commit });
    }
  });

  it("R3 rejects a stale collaboration publication without replacing the winner", async () => {
    const { service, initial } = await collaborationFixture();
    const left = await service.commit({ operation_id: "collaboration-left", parent_version: initial.version_commit, actor, changes: [{ tree: "state", path: "issues/left.json", content_base64: b64('{"id":"left","kind":"issue"}') }] });
    const right = await service.commit({ operation_id: "collaboration-right", parent_version: initial.version_commit, actor, changes: [{ tree: "state", path: "comments/right.json", content_base64: b64('{"id":"right","kind":"comment"}') }] });
    await service.publish({ operation_id: "collaboration-first", expected_version: initial.version_commit, new_version: left.version_commit, actor: publisher });
    await expect(service.publish({ operation_id: "collaboration-stale", expected_version: initial.version_commit, new_version: right.version_commit, actor: publisher })).rejects.toThrow(/forge-head/);
    await expect(service.head(actor)).resolves.toMatchObject({ version_commit: left.version_commit });
  });
});

async function collaborationFixture() {
  const repo = await fixture();
  const service = serviceFor(repo.port, {});
  const initial = await service.initialize({ operation_id: "collaboration-initialize", initial_code: [{ path: "README.md", content_base64: b64("initial code") }], initial_state: [{ path: "config/publication.json", content_base64: b64(JSON.stringify(policy("sha256:evaluator-a"))) }], actor: publisher });
  return { service, initial };
}

function serviceFor(git: ForgeGitPort, trustedKeys: Record<string, JsonWebKey>) {
  return makeForgeService({ git, tenant_id: "tenant-a", repository_id: "repo-a", clock: () => timestamp, authorize: async () => {}, verifyEvidence: async (context) => { await verifyPublicationEvidence({ git, trustedKeys, context, clock: () => new Date(timestamp) }); } });
}

function policy(digest: string) {
  return { schema_version: 1, evaluator_digest: digest, checks: [{ id: "unit", actor_ids: ["runner-a"], actor_kinds: ["agent"], key_ids: ["runner-key"] }], reviews: { required_approvals: 1, trusted_reviewer_ids: ["reviewer-a"], actor_kinds: ["human"], key_ids: ["reviewer-key"] } };
}

async function sign(privateKey: Parameters<typeof webcrypto.subtle.sign>[1], record: PublicationEvidenceRecord): Promise<PublicationEvidenceRecord> {
  const signature = await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(canonicalPublicationEvidencePayload(record)));
  return { ...record, signature: Buffer.from(signature).toString("base64") };
}

async function keys() {
  const pair = Schema.decodeUnknownSync(Schema.Struct({ publicKey: Schema.instanceOf(CryptoKey), privateKey: Schema.instanceOf(CryptoKey) }))(await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]));
  return { privateKey: pair.privateKey, publicJwk: await webcrypto.subtle.exportKey("jwk", pair.publicKey) };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "forge-integration-"));
  const gitDir = join(dir, "repo.git");
  const indexDir = join(dir, "indexes");
  await mkdir(indexDir);
  await git(["init", "--bare", gitDir]);
  return { dir, gitDir, indexDir, port: makeGitCliForgePort({ gitDir, indexDir, run: runGit }) };
}

async function runGit(input: GitCliRunInput): Promise<GitCliRunResult> {
  const result = await git(input.arg, input.env, input.stdin);
  return { exitCode: result.code, stdout: new Uint8Array(result.stdout), stderr: new Uint8Array(result.stderr) };
}

async function git(arg: readonly string[], envEntries?: readonly string[], stdin?: Uint8Array): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const entry of envEntries ?? []) {
    const at = entry.indexOf("=");
    env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...arg], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    if (stdin) child.stdin.end(Buffer.from(stdin));
    else child.stdin.end();
  });
}

function author() { return { name: "Forge", email: "forge@example.invalid" }; }
