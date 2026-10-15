#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalPublicationEvidencePayload,
  publicationEvidenceSchemaVersion,
  publicationPolicyPath
} from "../apps/api-worker/dist/fork-forge/evidence.js";

const evaluatorConfigPath = "config/evaluator.json";
const sha40Pattern = /^[0-9a-f]{40}$/;
const actorKindValues = new Set(["human", "agent", "service"]);

export async function runForgeEvidenceCli(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  try {
    if (command === "check") return await runCheck(parseArgs(rest), env);
    if (command === "review") return await runReview(parseArgs(rest));
    throw new CliError(2, "usage: forge-evidence <check|review> [options]");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}

async function runCheck(args, env) {
  const gitDir = required(args, "git-dir");
  const codeSha = sha(required(args, "code-sha"), "code-sha");
  const expectedStateSha = sha(required(args, "expected-state-sha"), "expected-state-sha");
  const checkId = safeId(required(args, "check-id"), "check-id");
  const actorId = safeId(required(args, "actor-id"), "actor-id");
  const actorKind = parseActorKind(args["actor-kind"] ?? "agent", "actor-kind");
  const keyId = safeId(required(args, "key-id"), "key-id");
  const signingKey = await readSigningKey(required(args, "signing-key-jwk"));
  const policy = await readGitJson(gitDir, expectedStateSha, publicationPolicyPath);
  const evaluator = await readGitJson(gitDir, expectedStateSha, evaluatorConfigPath);
  const checkPolicy = findCheckPolicy(policy, checkId);
  assertAllowed(checkPolicy.actor_ids, checkPolicy.actor_kinds, checkPolicy.key_ids, actorId, actorKind, keyId, checkId);
  const digest = await evaluatorDigest(gitDir, codeSha, evaluator);
  if (digest !== stringField(policy.evaluator_digest, "publication.evaluator_digest")) throw new CliError(1, "evaluator digest does not match publication policy");

  const workDir = await materializeCandidate(gitDir, codeSha);
  let exitCode = 1;
  try {
    exitCode = await runDockerEvaluator(env.FORGE_EVIDENCE_DOCKER ?? "docker", evaluator, workDir);
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }

  const record = await signRecord(signingKey, {
    actor_id: actorId,
    actor_kind: actorKind,
    candidate_code_commit: codeSha,
    evaluator_digest: digest,
    id: checkId,
    key_id: keyId,
    kind: "check",
    outcome: exitCode === 0 ? "passed" : "failed",
    schema_version: publicationEvidenceSchemaVersion,
    signature: ""
  });
  process.stdout.write(`${JSON.stringify(record)}\n`);
  return 0;
}

async function runReview(args) {
  const gitDir = required(args, "git-dir");
  const codeSha = sha(required(args, "code-sha"), "code-sha");
  const expectedStateSha = sha(required(args, "expected-state-sha"), "expected-state-sha");
  const reviewId = safeId(required(args, "review-id"), "review-id");
  const actorId = safeId(required(args, "actor-id"), "actor-id");
  const actorKind = parseActorKind(args["actor-kind"] ?? "human", "actor-kind");
  const keyId = safeId(required(args, "key-id"), "key-id");
  const decision = reviewDecision(args.decision ?? "approve");
  const signingKey = await readSigningKey(required(args, "signing-key-jwk"));
  const policy = await readGitJson(gitDir, expectedStateSha, publicationPolicyPath);
  assertAllowed(policy.reviews?.trusted_reviewer_ids, policy.reviews?.actor_kinds, policy.reviews?.key_ids, actorId, actorKind, keyId, reviewId);
  const record = await signRecord(signingKey, {
    actor_id: actorId,
    actor_kind: actorKind,
    candidate_code_commit: codeSha,
    decision,
    evaluator_digest: stringField(policy.evaluator_digest, "publication.evaluator_digest"),
    id: reviewId,
    key_id: keyId,
    kind: "review",
    schema_version: publicationEvidenceSchemaVersion,
    signature: ""
  });
  process.stdout.write(`${JSON.stringify(record)}\n`);
  return 0;
}

export async function evaluatorDigest(gitDir, codeSha, evaluator) {
  const command = stringArray(evaluator.command, "evaluator.command");
  const files = stringArray(evaluator.files, "evaluator.files").map((path) => forgePath(path, "evaluator.files[]")).sort();
  const image = pinnedImage(evaluator.image);
  const mapping = {};
  for (const file of files) mapping[file] = (await gitFile(gitDir, ["show", `${codeSha}:${file}`])).toString("base64");
  const payload = { command, files: mapping, image };
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

async function materializeCandidate(gitDir, codeSha) {
  const workDir = await mkdtemp(join(tmpdir(), "forge-evidence-code-"));
  const archive = spawn("git", ["--git-dir", gitDir, "archive", codeSha], { stdio: ["ignore", "pipe", "pipe"] });
  const tar = spawn("tar", ["-xf", "-", "-C", workDir], { stdio: ["pipe", "ignore", "pipe"] });
  archive.stdout.pipe(tar.stdin);
  const [archiveResult, tarResult] = await Promise.all([waitProcess(archive), waitProcess(tar)]);
  if (archiveResult.code !== 0) throw new CliError(1, `git archive failed: ${archiveResult.stderr}`);
  if (tarResult.code !== 0) throw new CliError(1, `tar extract failed: ${tarResult.stderr}`);
  return workDir;
}

async function runDockerEvaluator(docker, evaluator, workDir) {
  const image = pinnedImage(evaluator.image);
  const command = stringArray(evaluator.command, "evaluator.command");
  const args = [
    "run",
    "--rm",
    "--network", "none",
    "--read-only",
    "--pids-limit", "128",
    "--memory", "512m",
    "--cpus", "1",
    "--mount", `type=bind,source=${workDir},target=/workspace,readonly`,
    "--workdir", "/workspace",
    image,
    ...command
  ];
  const result = await waitProcess(spawn(docker, args, { stdio: ["ignore", "ignore", "pipe"] }));
  if (result.signal) throw new CliError(1, `docker evaluator ended by signal ${result.signal}`);
  return result.code;
}

async function signRecord(signingKey, record) {
  const privateKey = await webcrypto.subtle.importKey("jwk", signingKey, { name: "Ed25519" }, false, ["sign"]);
  const signature = await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(canonicalPublicationEvidencePayload(record)));
  return { ...record, signature: Buffer.from(signature).toString("base64") };
}

async function readSigningKey(path) {
  const key = JSON.parse(await readFile(path, "utf8"));
  if (key?.kty !== "OKP" || key?.crv !== "Ed25519" || typeof key?.d !== "string") throw new CliError(1, "signing key must be an Ed25519 private JWK");
  return key;
}

async function readGitJson(gitDir, commit, path) {
  const content = await gitFile(gitDir, ["show", `${commit}:${path}`]);
  return JSON.parse(content.toString("utf8"));
}

async function gitFile(gitDir, arg) {
  const result = await waitProcess(spawn("git", ["--git-dir", gitDir, ...arg], { stdio: ["ignore", "pipe", "pipe"] }));
  if (result.code !== 0) throw new CliError(1, `git ${arg[0]} failed: ${result.stderr}`);
  return result.stdout;
}

function findCheckPolicy(policy, checkId) {
  const checks = Array.isArray(policy.checks) ? policy.checks : [];
  const match = checks.find((check) => check?.id === checkId);
  if (!match) throw new CliError(1, `check ${checkId} is not declared by publication policy`);
  return match;
}

function assertAllowed(actorIds, actorKinds, keyIds, actorId, kind, keyId, recordId) {
  if (!Array.isArray(actorIds) || !actorIds.includes(actorId)) throw new CliError(1, `actor ${actorId} is not authorized for ${recordId}`);
  if (!Array.isArray(actorKinds) || !actorKinds.includes(kind)) throw new CliError(1, `actor kind ${kind} is not authorized for ${recordId}`);
  if (!Array.isArray(keyIds) || !keyIds.includes(keyId)) throw new CliError(1, `key ${keyId} is not authorized for ${recordId}`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new CliError(2, `unexpected argument ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(2, `missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new CliError(2, `missing --${key}`);
  return value;
}

function sha(value, field) {
  if (!sha40Pattern.test(value)) throw new CliError(2, `${field} must be a lower-case SHA-1`);
  return value;
}

function safeId(value, field) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new CliError(2, `${field} must be a safe identifier`);
  return value;
}

function parseActorKind(value, field) {
  if (!actorKindValues.has(value)) throw new CliError(2, `${field} must be human, agent, or service`);
  return value;
}

function reviewDecision(value) {
  if (value === "approve" || value === "reject") return value;
  throw new CliError(2, "decision must be approve or reject");
}

function stringField(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new CliError(1, `${field} must be a non-empty string`);
  return value;
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new CliError(1, `${field} must be a string array`);
  return value;
}

function forgePath(value, field) {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new CliError(1, `${field} contains an unsafe path`);
  return value;
}

function pinnedImage(value) {
  const image = stringField(value, "evaluator.image");
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new CliError(1, "evaluator.image must be pinned by digest");
  return image;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) output[key] = canonicalize(value[key]);
    return output;
  }
  throw new CliError(1, `unsupported JSON value ${typeof value}`);
}

async function waitProcess(child) {
  const stdout = [];
  const stderr = [];
  child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8").slice(0, 4000) }));
  });
}

class CliError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runForgeEvidenceCli();
}
