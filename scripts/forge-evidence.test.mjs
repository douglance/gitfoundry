import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalPublicationEvidencePayload, verifyPublicationEvidence } from "../apps/api-worker/src/fork-forge/evidence.ts";
import { evaluatorDigest } from "./forge-evidence.mjs";

const script = new URL("./forge-evidence.mjs", import.meta.url).pathname;
const image = "example.invalid/evaluator@sha256:" + "a".repeat(64);
const timestamp = "2026-10-09T00:00:00.000Z";

describe("forge evidence CLI", () => {
  it("signs a valid check receipt with actual Ed25519 key material", async () => {
    const fixture = await repoFixture();
    const keys = await keyPair();
    const digest = await evaluatorDigest(fixture.gitDir, fixture.code, evaluator());
    const state = await writeExpectedState(fixture, digest, keys.publicJwk);
    const keyPath = join(fixture.dir, "runner-key.json");
    await writeFile(keyPath, JSON.stringify(keys.privateJwk));
    const docker = await fakeDocker(fixture.dir, 0);

    const result = await runNode(["check", "--git-dir", fixture.gitDir, "--code-sha", fixture.code, "--expected-state-sha", state, "--check-id", "unit", "--actor-id", "runner-a", "--key-id", "runner-key", "--signing-key-jwk", keyPath], { FORGE_EVIDENCE_DOCKER: docker });

    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({ kind: "check", id: "unit", outcome: "passed", candidate_code_commit: fixture.code, evaluator_digest: digest, actor_id: "runner-a", key_id: "runner-key" });
    await expect(verifyPublicationEvidence({ context: context(fixture.code, state, fixture.code, await stateWithRecords(fixture, state, { "checks/unit.json": receipt })), git: fixture.git, trustedKeys: { "runner-key": keys.publicJwk, "reviewer-key": keys.publicJwk } })).rejects.toMatchObject({ code: "evidence_missing" });
  });

  it("emits failed check evidence when the evaluator exits non-zero", async () => {
    const fixture = await repoFixture();
    const keys = await keyPair();
    const digest = await evaluatorDigest(fixture.gitDir, fixture.code, evaluator());
    const state = await writeExpectedState(fixture, digest, keys.publicJwk);
    const keyPath = join(fixture.dir, "runner-key.json");
    await writeFile(keyPath, JSON.stringify(keys.privateJwk));
    const docker = await fakeDocker(fixture.dir, 7);

    const result = await runNode(["check", "--git-dir", fixture.gitDir, "--code-sha", fixture.code, "--expected-state-sha", state, "--check-id", "unit", "--actor-id", "runner-a", "--key-id", "runner-key", "--signing-key-jwk", keyPath], { FORGE_EVIDENCE_DOCKER: docker });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "check", outcome: "failed" });
  });

  it("signs exact SHA review receipts and rejects tampered candidate SHA during verification", async () => {
    const fixture = await repoFixture();
    const runnerKeys = await keyPair();
    const reviewerKeys = await keyPair();
    const digest = await evaluatorDigest(fixture.gitDir, fixture.code, evaluator());
    const state = await writeExpectedState(fixture, digest, runnerKeys.publicJwk, reviewerKeys.publicJwk);
    const runnerKeyPath = join(fixture.dir, "runner-key.json");
    await writeFile(runnerKeyPath, JSON.stringify(runnerKeys.privateJwk));
    const docker = await fakeDocker(fixture.dir, 0);
    const checkResult = await runNode(["check", "--git-dir", fixture.gitDir, "--code-sha", fixture.code, "--expected-state-sha", state, "--check-id", "unit", "--actor-id", "runner-a", "--key-id", "runner-key", "--signing-key-jwk", runnerKeyPath], { FORGE_EVIDENCE_DOCKER: docker });
    const keyPath = join(fixture.dir, "reviewer-key.json");
    await writeFile(keyPath, JSON.stringify(reviewerKeys.privateJwk));

    const result = await runNode(["review", "--git-dir", fixture.gitDir, "--code-sha", fixture.code, "--expected-state-sha", state, "--review-id", "review-a", "--actor-id", "reviewer-a", "--key-id", "reviewer-key", "--signing-key-jwk", keyPath, "--decision", "approve"]);

    expect(result.code).toBe(0);
    const check = JSON.parse(checkResult.stdout);
    const review = JSON.parse(result.stdout);
    const tampered = { ...review, candidate_code_commit: "9".repeat(40) };
    const recordsState = await stateWithRecords(fixture, state, { "checks/unit.json": check, "reviews/review-a.json": tampered });
    await expect(verifyPublicationEvidence({ context: context(fixture.code, state, fixture.code, recordsState), git: fixture.git, trustedKeys: { "runner-key": runnerKeys.publicJwk, "reviewer-key": reviewerKeys.publicJwk } })).rejects.toMatchObject({ code: "evidence_missing" });
  });
});

function evaluator() {
  return { schema_version: 1, command: ["node", "-e", "process.exit(0)"], files: ["src/app.txt"], image };
}

async function writeExpectedState(fixture, digest, runnerPublicJwk, reviewerPublicJwk = runnerPublicJwk) {
  return await fixture.git.writeCommit({
    base: null,
    parents: [],
    message: "expected state",
    author: author(),
    timestamp,
    changes: [
      { path: "config/evaluator.json", content_base64: b64(JSON.stringify(evaluator())) },
      { path: "config/publication.json", content_base64: b64(JSON.stringify(policy(digest))) }
    ]
  });
}

async function stateWithRecords(fixture, base, records) {
  return await fixture.git.writeCommit({
    base,
    parents: [base],
    message: "records",
    author: author(),
    timestamp,
    changes: Object.entries(records).map(([path, value]) => ({ path, content_base64: b64(JSON.stringify(value)) }))
  });
}

function policy(digest) {
  return { schema_version: 1, evaluator_digest: digest, checks: [{ id: "unit", actor_ids: ["runner-a"], actor_kinds: ["agent"], key_ids: ["runner-key"] }], reviews: { required_approvals: 1, trusted_reviewer_ids: ["reviewer-a"], actor_kinds: ["human"], key_ids: ["reviewer-key"] } };
}

function context(expectedCode, expectedState, candidateCode, candidateState) {
  return { actor: { id: "service-a", kind: "service" }, expected: version(expectedCode, expectedState, "1".repeat(40)), candidate: version(candidateCode, candidateState, "2".repeat(40)) };
}

function version(code, state, versionCommit) {
  return { version_commit: versionCommit, descriptor: { schema_version: 1, fork_id: "fork-a", tenant_id: "tenant-a", repository_id: "repo-a", parents: [], code_commit: code, state_commit: state, creator_id: "creator-a", creator_kind: "service", operation_id: "op-a", request_digest: "digest-a" } };
}

async function repoFixture() {
  const { makeGitCliForgePort } = await import("../apps/api-worker/src/fork-forge/git-cli.ts");
  const dir = await mkdtemp(join(tmpdir(), "forge-evidence-cli-"));
  const gitDir = join(dir, "repo.git");
  const indexDir = join(dir, "indexes");
  await mkdir(indexDir);
  await git(["init", "--bare", gitDir]);
  const gitPort = makeGitCliForgePort({ gitDir, indexDir, run: async (input) => {
    const result = await git(input.arg, input.env, input.stdin);
    return { exitCode: result.code, stdout: new Uint8Array(result.stdout), stderr: new Uint8Array(result.stderr) };
  } });
  const code = await gitPort.writeCommit({ base: null, parents: [], changes: [{ path: "src/app.txt", content_base64: b64("hello\n") }], message: "code", author: author(), timestamp });
  return { dir, gitDir, git: gitPort, code };
}

async function keyPair() {
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { privateKey: pair.privateKey, privateJwk: await webcrypto.subtle.exportKey("jwk", pair.privateKey), publicJwk: await webcrypto.subtle.exportKey("jwk", pair.publicKey) };
}

async function fakeDocker(dir, exitCode) {
  const path = join(dir, `fake-docker-${exitCode}.mjs`);
  await writeFile(path, `#!/usr/bin/env node\nprocess.exit(${exitCode});\n`, { mode: 0o755 });
  return path;
}

async function runNode(arg, env = {}) {
  const result = await spawnFile(process.execPath, [script, ...arg], { ...process.env, ...env });
  return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}

async function git(arg, envEntries, stdin) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const entry of envEntries ?? []) {
    const at = entry.indexOf("=");
    env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return await spawnFile("git", arg, env, stdin);
}

async function spawnFile(command, arg, env, stdin) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, arg, { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    if (stdin) child.stdin.end(Buffer.from(stdin));
    else child.stdin.end();
  });
}

function author() { return { name: "Forge", email: "forge@example.invalid" }; }
function b64(value) { return Buffer.from(value, "utf8").toString("base64"); }
