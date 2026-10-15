#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const helperPath = resolve(repoRoot, "images/git-helper/gitfoundry-hydrate-source");
const pipelinePath = resolve(repoRoot, "apps/api-worker/src/merge-candidate/pipeline.ts");
const dockerContext = resolve(repoRoot, "images");
const image = process.env.GITFOUNDRY_SOURCE_HYDRATE_IMAGE || "gitfoundry-source-hydrate-test:local";
const frame = "gitfoundry.source-hydrate.v1";
const resultFrame = "gitfoundry.source-hydrate.result.v1";
const tenant = "tenant-a";
const repository = "repo-a";
const operation = "op-a";

async function main() {
  await access(helperPath, constants.F_OK);
  await run("docker", ["build", "--platform", "linux/amd64", "-f", resolve(dockerContext, "git-helper/Dockerfile"), "-t", image, dockerContext], { cwd: repoRoot, expectExit: 0 });
  const root = await mkdtemp(join(tmpdir(), "gitfoundry-source-hydrate-"));
  try {
    await mkdir(join(root, "work"), { recursive: true });
    const fixture = await createDivergentFixture(root);
    await runAll(root, fixture);
    const pipeline = await loadPipelineModule(root);
    await assertWorkerPipelinePreparesCandidates(root, pipeline);
    console.log(JSON.stringify({ ok: true, image, helper: "/usr/local/bin/gitfoundry-hydrate-source", artifact_root: root }));
  } finally {
    if (!process.env.GITFOUNDRY_KEEP_SOURCE_HYDRATE_TMP) await rm(root, { recursive: true, force: true });
  }
}

async function runAll(root, fixture) {
  const before = await sourceRefs(fixture);
  const target = await hydrate(root, fixture, { role: "source_target_pack", expectedOid: fixture.target, pack: fixture.targetPack });
  assertHydrated(target, "source_target_pack", fixture.target, fixture.targetPack);
  const head = await hydrate(root, fixture, { role: "source_head_pack", expectedOid: fixture.head, pack: fixture.headPack });
  assertHydrated(head, "source_head_pack", fixture.head, fixture.headPack);
  await assertOfflineGraph(root, fixture);
  const after = await sourceRefs(fixture);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("source refs changed during hydration");

  await assertReplayConflictRejected(root, fixture);
  await assertDigestRejected(root, fixture);
  await assertSizeRejected(root, fixture);
  await assertTruncatedRejected(root, fixture);
  await assertSubstitutedTipRejected(root, fixture);
  await assertGitVersionCheckedBeforeMutation(root, fixture);
  await assertSymlinkCwdRejected(root, fixture);
  await assertHardlinkStateRejected(root, fixture);
  await assertHostileConfigRejected(root, fixture);
}

async function createDivergentFixture(root) {
  const work = join(root, "source-work");
  await mkdir(work, { recursive: true });
  await git(["-C", work, "init", "-q", "-b", "main"]);
  await git(["-C", work, "config", "user.name", "Source Author"]);
  await git(["-C", work, "config", "user.email", "source@example.invalid"]);
  await writeFile(join(work, "base.txt"), "base\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "base"]);
  const base = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "checkout", "-q", "-b", "target"]);
  await writeFile(join(work, "target.txt"), "target\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "target"]);
  const target = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "checkout", "-q", "main"]);
  await git(["-C", work, "checkout", "-q", "-b", "head"]);
  await writeFile(join(work, "head.txt"), "head\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "head"]);
  const head = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  const targetPack = await makePack(work, target);
  const headPack = await makePack(work, head);
  return { work, base, target, head, targetPack, headPack };
}

async function loadPipelineModule(root) {
  const shim = join(root, "cloudflare-workers-shim.js");
  const bundle = join(root, "merge-candidate-pipeline.bundle.mjs");
  await writeFile(shim, "export class DurableObject {}\nexport class WorkerEntrypoint {}\n", "utf8");
  await run("pnpm", ["exec", "esbuild", pipelinePath, "--bundle", "--platform=node", "--format=esm", "--alias:cloudflare:workers=" + shim, "--outfile=" + bundle], { cwd: repoRoot, expectExit: 0 });
  return import("file://" + bundle + "?t=" + Date.now());
}

async function assertWorkerPipelinePreparesCandidates(root, pipeline) {
  for (const method of ["merge", "squash", "rebase", "fast_forward"]) {
    await runPipelineCase(root, pipeline, { method, name: method, sourceRepositoryId: repository, providerRepository: "fixture/source.git" });
  }
  await runPipelineCase(root, pipeline, { method: "merge", name: "fork-merge", sourceRepositoryId: "repo-fork", providerRepository: "fork/source.git" });
  await runPipelineConflictCase(root, pipeline, { name: "conflict", sourceRepositoryId: repository, providerRepository: "fixture/source.git" });
}

async function runPipelineCase(root, pipeline, options) {
  const fixture = await createPipelineFixture(root, options.name);
  const before = await pipelineRefs(fixture);
  const store = new FixtureArtifactPort();
  const sources = await seedSourceArtifacts(store, fixture, options.name, options.sourceRepositoryId, options.providerRepository);
  const op = `pipe-${options.name}`;
  await mkdir(join(root, "work", tenant, repository, op, "trusted-git"), { recursive: true });
  const input = {
    commandId: `cmd-${options.name}`,
    tenantId: tenant,
    repositoryId: repository,
    operationId: op,
    fenceToken: `fence-${options.name}`,
    pullRequestId: "pr-a",
    pullRequestVersion: 7,
    headSha: fixture.head,
    baseSha: fixture.base,
    method: options.method,
    committerName: "GitFoundry Merge Bot",
    committerEmail: "merge-bot@gitfoundry.invalid",
    committedAt: "2026-10-08T00:00:00.000Z",
    message: `${options.name} candidate`,
  };
  const env = { GFY_TRUSTED_GIT_HELPER_IMAGE: "registry.example.com/gitfoundry/helper@sha256:" + "a".repeat(64) };
  const outcome = await pipeline.prepareStoredMergeCandidate(new DockerContainer(root), input, sources, store, env);
  if (outcome.result.ok !== true || !outcome.candidate) throw new Error(`pipeline ${options.name} did not prepare candidate: ${JSON.stringify(outcome.result)}`);
  await assertPipelineCandidate(store, outcome.candidate, fixture, options.method);
  const after = await pipelineRefs(fixture);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`pipeline ${options.name} mutated source refs`);
}

async function runPipelineConflictCase(root, pipeline, options) {
  const fixture = await createConflictPipelineFixture(root, options.name);
  const before = await pipelineRefs(fixture);
  const store = new FixtureArtifactPort();
  const sources = await seedSourceArtifacts(store, fixture, options.name, options.sourceRepositoryId, options.providerRepository);
  const op = `pipe-${options.name}`;
  await mkdir(join(root, "work", tenant, repository, op, "trusted-git"), { recursive: true });
  const input = {
    commandId: `cmd-${options.name}`,
    tenantId: tenant,
    repositoryId: repository,
    operationId: op,
    fenceToken: `fence-${options.name}`,
    pullRequestId: "pr-a",
    pullRequestVersion: 7,
    headSha: fixture.head,
    baseSha: fixture.base,
    method: "merge",
    committerName: "GitFoundry Merge Bot",
    committerEmail: "merge-bot@gitfoundry.invalid",
    committedAt: "2026-10-08T00:00:00.000Z",
    message: `${options.name} candidate`,
  };
  const env = { GFY_TRUSTED_GIT_HELPER_IMAGE: "registry.example.com/gitfoundry/helper@sha256:" + "a".repeat(64) };
  const outcome = await pipeline.prepareStoredMergeCandidate(new DockerContainer(root), input, sources, store, env);
  if (outcome.result.ok !== false || outcome.result.status !== "conflict") throw new Error(`pipeline ${options.name} did not return conflict: ${JSON.stringify(outcome.result)}`);
  if (outcome.candidate) throw new Error("pipeline conflict unexpectedly produced a candidate artifact");
  await assertReviewedDiff(outcome.reviewedDiff, fixture);
  if ([...store.objects.keys()].some((key) => key.includes("candidate_"))) throw new Error("pipeline conflict stored candidate artifacts");
  const after = await pipelineRefs(fixture);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`pipeline ${options.name} mutated source refs`);
}


async function createPipelineFixture(root, method) {
  const work = join(root, `pipeline-${method}-source`);
  await mkdir(work, { recursive: true });
  await git(["-C", work, "init", "-q", "-b", "main"]);
  await git(["-C", work, "config", "user.name", "Source Author"]);
  await git(["-C", work, "config", "user.email", "source@example.invalid"]);
  await writeFile(join(work, "base.txt"), "base\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "base"]);
  const rootBase = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  if (method === "fast_forward") {
    await writeFile(join(work, "ff.txt"), "ff\n", "utf8");
    await git(["-C", work, "add", "."]);
    await git(["-C", work, "commit", "-q", "-m", "ff"]);
    const head = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
    return { work, base: rootBase, head, sourceCommits: [head], targetPack: await makePack(work, rootBase), headPack: await makePack(work, head) };
  }
  await git(["-C", work, "checkout", "-q", "-b", "head", rootBase]);
  await writeFile(join(work, "head.txt"), method + " head\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", `${method} head`]);
  const head = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "checkout", "-q", "-b", "target", rootBase]);
  await writeFile(join(work, "target.txt"), method + " target\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", `${method} target`]);
  const base = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  return { work, base, head, sourceCommits: [head], targetPack: await makePack(work, base), headPack: await makePack(work, head) };
}

async function createConflictPipelineFixture(root, name) {
  const work = join(root, `pipeline-${name}-source`);
  await mkdir(work, { recursive: true });
  await git(["-C", work, "init", "-q", "-b", "main"]);
  await git(["-C", work, "config", "user.name", "Source Author"]);
  await git(["-C", work, "config", "user.email", "source@example.invalid"]);
  await writeFile(join(work, "shared.txt"), "base\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "base"]);
  const rootBase = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "checkout", "-q", "-b", "head", rootBase]);
  await writeFile(join(work, "shared.txt"), "head\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "conflicting head"]);
  const head = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "checkout", "-q", "-b", "target", rootBase]);
  await writeFile(join(work, "shared.txt"), "target\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "conflicting target"]);
  const base = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  return { work, base, head, sourceCommits: [head], targetPack: await makePack(work, base), headPack: await makePack(work, head) };
}

async function seedSourceArtifacts(store, fixture, name, sourceRepositoryId, providerRepository) {
  const target = await seedSourceArtifact(store, fixture, name, "source_target_pack", repository, "fixture/target.git", fixture.base, fixture.targetPack);
  const head = await seedSourceArtifact(store, fixture, name, "source_head_pack", sourceRepositoryId, providerRepository, fixture.head, fixture.headPack);
  return { target, head, sourceRepositoryId };
}

async function seedSourceArtifact(store, fixture, name, role, sourceRepoId, providerRepository, oid, pack) {
  const sourceOp = `fixture-${name}-${role}`;
  const publicInput = {
    tenant_id: tenant,
    repository_id: sourceRepoId,
    operation_id: sourceOp,
    fence_token: `fence-${name}`,
    provider_repository: providerRepository,
    ref: role === "source_target_pack" ? "refs/heads/target" : "refs/heads/head",
    expected_oid: oid,
    role,
    output_dir: `/work/${tenant}/${sourceRepoId}/${sourceOp}/source-pack`,
  };
  const requestSha256 = sha256(canonicalJson(publicInput));
  const packSha = sha256(pack);
  const manifest = JSON.stringify({ frame: "gitfoundry.source-pack.manifest.v1", public: publicInput, request_sha256: requestSha256, pack: { filename: "source.pack", sha256: packSha, size_bytes: pack.length }, git_version: "2.39.5" }) + "\n";
  const manifestBytes = Buffer.from(manifest, "utf8");
  const manifestLocator = await store.putAppendOnly({ tenantId: tenant, repositoryId: sourceRepoId, operationId: sourceOp, requestSha256, kind: "source_manifest", body: bytesToStream(manifestBytes), expectedSha256: sha256(manifestBytes), expectedSizeBytes: manifestBytes.length, contentType: "application/json" });
  const packLocator = await store.putAppendOnly({ tenantId: tenant, repositoryId: sourceRepoId, operationId: sourceOp, requestSha256, kind: role, body: bytesToStream(pack), expectedSha256: packSha, expectedSizeBytes: pack.length, contentType: "application/octet-stream" });
  return { public: publicInput, manifest: manifestLocator, pack: packLocator };
}

async function assertPipelineCandidate(store, candidate, fixture, method) {
  await assertReviewedDiff(candidate.reviewedDiff, fixture);
  const raw = await streamToBuffer(await store.getVerified(candidate.rawCommit));
  if (sha256(raw) !== candidate.result.candidateBytesSha256 || raw.length !== candidate.rawCommit.sizeBytes) throw new Error(`pipeline ${method} raw commit digest/length mismatch`);
  const oid = gitObjectId("commit", raw);
  if (oid !== candidate.result.candidateOid) throw new Error(`pipeline ${method} raw Git OID mismatch`);
  const parsed = parseRawCommit(raw);
  const expectedTree = method === "fast_forward" ? (await git(["-C", fixture.work, "rev-parse", fixture.head + "^{tree}"])).stdout.trim() : (await git(["-C", fixture.work, "merge-tree", "--write-tree", fixture.base, fixture.head])).stdout.trim();
  if (parsed.tree !== expectedTree || candidate.result.candidateTree !== expectedTree) throw new Error(`pipeline ${method} candidate tree mismatch`);
  const expectedParents = method === "merge" ? [fixture.base, fixture.head] : [fixture.base];
  if (JSON.stringify(parsed.parents) !== JSON.stringify(expectedParents)) throw new Error(`pipeline ${method} candidate parents mismatch: ${JSON.stringify(parsed.parents)}`);
  if (method === "rebase") {
    if (candidate.result.originalToRebased.length !== fixture.sourceCommits.length || candidate.result.originalToRebased[0].original !== fixture.sourceCommits[0] || candidate.result.originalToRebased.at(-1).rebased !== candidate.result.candidateOid) throw new Error("pipeline rebase map mismatch");
  } else if (candidate.result.originalToRebased.length !== 0) throw new Error(`pipeline ${method} unexpectedly returned rebase map`);
  const pack = await streamToBuffer(await store.getVerified(candidate.pack));
  if (sha256(pack) !== candidate.pack.sha256 || pack.length !== candidate.pack.sizeBytes) throw new Error(`pipeline ${method} candidate pack digest/length mismatch`);
  const verifyRoot = await mkdtemp(join(tmpdir(), `gitfoundry-candidate-pack-${method}-`));
  try {
    await mkdir(join(verifyRoot, "objects"), { recursive: true });
    const packPath = join(verifyRoot, "candidate.pack");
    await writeFile(packPath, pack);
    await git(["init", "--bare", "-q", verifyRoot]);
    await run("git", ["-C", verifyRoot, "unpack-objects"], { input: pack, expectExit: 0 });
    await git(["-C", verifyRoot, "cat-file", "-e", candidate.result.candidateOid + "^{commit}"]);
  } finally {
    await rm(verifyRoot, { recursive: true, force: true });
  }
  const manifest = await streamToBuffer(await store.getVerified(candidate.manifest));
  if (sha256(manifest) !== candidate.manifest.sha256 || manifest.length !== candidate.manifest.sizeBytes) throw new Error(`pipeline ${method} manifest digest/length mismatch`);
}

async function assertReviewedDiff(diff, fixture) {
  const patch = (await git(["-C",fixture.work,"diff","--no-ext-diff","--no-textconv","--patch","--full-index","--find-renames","--find-copies","--unified=3",fixture.base+"..."+fixture.head])).stdout;
  const paths = (await git(["-C",fixture.work,"diff","--no-ext-diff","--no-textconv","--name-only","-z",fixture.base+"..."+fixture.head])).stdout;
  const mergeBases = (await git(["-C",fixture.work,"merge-base","--all",fixture.base,fixture.head])).stdout.trim().split(/\n/);
  if (!diff || diff.algorithmVersion !== "git-cli-unified-v1" || diff.comparison !== "three_dot" || diff.contextLines !== 3 ||
      diff.headSha !== fixture.head || diff.baseSha !== fixture.base || diff.patchSha256 !== sha256(Buffer.from(patch)) ||
      diff.patchSizeBytes !== Buffer.byteLength(patch) || diff.changedPathsSha256 !== sha256(Buffer.from(paths)) ||
      JSON.stringify(diff.mergeBaseShas) !== JSON.stringify(mergeBases)) throw new Error("reviewed diff evidence does not match independent Git");
}

async function pipelineRefs(fixture) {
  return (await git(["-C", fixture.work, "show-ref", "--heads"])).stdout.trim().split(/\n/).sort();
}

class DockerContainer {
  constructor(root) { this.root = root; }
  async exec(argv, options) {
    const envArgs = Object.entries(options.env || {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const child = spawn("docker", ["run", "--rm", "-i", "--platform", "linux/amd64", "--network", "none", ...envArgs, "--mount", `type=bind,source=${this.root}/work,target=/work`, "--workdir", options.cwd, "--entrypoint", argv[0], image, ...argv.slice(1)], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
    return { stdin: nodeWritableToWeb(child.stdin), stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr), exitCode: waitFor(child), kill: () => child.kill("SIGKILL") };
  }
}

class FixtureArtifactPort {
  constructor() { this.objects = new Map(); }
  async putAppendOnly(input) {
    const bytes = await streamToBuffer(input.body);
    if (sha256(bytes) !== input.expectedSha256 || bytes.length !== input.expectedSizeBytes) throw new Error("fixture artifact digest or size mismatch");
    const key = `fixture/${input.tenantId}/${input.repositoryId}/${input.operationId}/${input.requestSha256}/${input.kind}`;
    const prior = this.objects.get(key);
    if (prior && prior.sha256 !== input.expectedSha256) throw new Error("fixture artifact append-only collision");
    const locator = { tenantId: input.tenantId, repositoryId: input.repositoryId, operationId: input.operationId, requestSha256: input.requestSha256, kind: input.kind, sha256: input.expectedSha256, sizeBytes: bytes.length, contentType: input.contentType, key };
    this.objects.set(key, { locator, bytes });
    return locator;
  }
  async getVerified(locator) {
    const entry = this.objects.get(locator.key);
    if (!entry || entry.locator.sha256 !== locator.sha256 || entry.bytes.length !== locator.sizeBytes || sha256(entry.bytes) !== locator.sha256) throw new Error("fixture artifact verification failed");
    return bytesToStream(entry.bytes);
  }
}

function nodeWritableToWeb(writable) {
  return new WritableStream({
    write(chunk) { return new Promise((resolve, reject) => writable.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve())); },
    close() { return new Promise((resolve, reject) => writable.end((error) => error ? reject(error) : resolve())); },
    abort() { writable.destroy(); },
  });
}

function bytesToStream(bytes) {
  return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } });
}

async function streamToBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      chunks.push(chunk);
      length += chunk.length;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function gitObjectId(type, body) {
  return createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
}

function parseRawCommit(raw) {
  const text = raw.toString("utf8");
  const header = text.slice(0, text.indexOf("\n\n"));
  const tree = header.match(/^tree ([0-9a-f]{40})$/m)?.[1];
  const parents = [...header.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]);
  if (!tree) throw new Error("raw commit tree missing");
  return { tree, parents };
}

async function makePack(work, oid) {
  const result = await run("git", ["-C", work, "pack-objects", "--revs", "--stdout"], { input: `${oid}\n`, expectExit: 0, encoding: "buffer" });
  return result.stdout;
}

async function sourceRefs(fixture) {
  return {
    target: (await git(["-C", fixture.work, "rev-parse", "refs/heads/target"])).stdout.trim(),
    head: (await git(["-C", fixture.work, "rev-parse", "refs/heads/head"])).stdout.trim(),
  };
}

async function hydrate(root, fixture, options) {
  const operationId = options.operationId || operation;
  const request = {
    frame,
    tenant_id: tenant,
    repository_id: repository,
    operation_id: operationId,
    role: options.role,
    expected_oid: options.expectedOid,
    pack_sha256: options.packSha256 || sha256(options.pack),
    pack_size_bytes: options.packSizeBytes ?? options.pack.length,
  };
  if (options.extra) Object.assign(request, options.extra);
  const line = JSON.stringify(request) + "\n";
  const input = Buffer.concat([Buffer.from(line, "utf8"), options.pack]);
  const requestSha = options.requestSha || sha256(line);
  const cwd = options.cwd || await ensureTrustedGit(root, operationId);
  const result = await run("docker", [
    "run", "--rm", "-i", "--platform", "linux/amd64", "--network", "none",
    "--mount", `type=bind,source=${root}/work,target=/work`,
    "--workdir", cwd,
    "--entrypoint", "/usr/local/bin/gitfoundry-hydrate-source",
    ...(options.dockerArgs || []),
    options.imageName || image, "hydrate", "--request-format", frame, "--request-sha256", requestSha,
  ], { input, expectExit: options.expectExit ?? 0 });
  if ((options.expectExit ?? 0) !== 0) return result;
  const lines = result.stdout.trim().split(/\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("unexpected hydrate stdout: " + JSON.stringify(result.stdout));
  const parsed = JSON.parse(lines[0]);
  parsed.request = request;
  return parsed;
}

async function ensureTrustedGit(root, operationId) {
  const dir = join(root, "work", tenant, repository, operationId, "trusted-git");
  await mkdir(dir, { recursive: true });
  return `/work/${tenant}/${repository}/${operationId}/trusted-git`;
}

function assertHydrated(result, role, expectedOid, pack) {
  if (result.frame !== resultFrame || result.ok !== true || result.status !== "hydrated") throw new Error("hydrate failed: " + JSON.stringify(result));
  if (result.tenant_id !== tenant || result.repository_id !== repository || result.operation_id !== result.request.operation_id || result.role !== role) throw new Error("hydrate identity mismatch");
  if (result.expected_oid !== expectedOid || result.tip !== expectedOid) throw new Error("hydrate tip mismatch");
  if (result.pack_sha256 !== sha256(pack) || result.pack_size_bytes !== pack.length || result.request_sha256 !== sha256(JSON.stringify(result.request) + "\n") || result.git_version !== "2.39.5") throw new Error("hydrate digest/version mismatch");
}

async function assertOfflineGraph(root, fixture) {
  const dir = `/work/${tenant}/${repository}/${operation}/trusted-git`;
  const script = [
    `test "$(git -C ${dir} rev-parse refs/source-hydrate/source_target_pack)" = ${fixture.target}`,
    `test "$(git -C ${dir} rev-parse refs/source-hydrate/source_head_pack)" = ${fixture.head}`,
    `git -C ${dir} cat-file -e ${fixture.target}^{commit}`,
    `git -C ${dir} cat-file -e ${fixture.head}^{commit}`,
    `test "$(git -C ${dir} show ${fixture.target}:target.txt)" = target`,
    `test "$(git -C ${dir} show ${fixture.head}:head.txt)" = head`,
    `test "$(git -C ${dir} merge-base ${fixture.target} ${fixture.head})" = ${fixture.base}`,
    `! git -C ${dir} rev-list --objects --missing=print ${fixture.target} ${fixture.head} | grep '^?'`,
  ].join(" && ");
  await run("docker", ["run", "--rm", "--platform", "linux/amd64", "--network", "none", "--mount", `type=bind,source=${root}/work,target=/work`, "--entrypoint", "/bin/sh", image, "-c", script], { expectExit: 0 });
}

async function assertReplayConflictRejected(root, fixture) {
  const op = "op-conflict";
  await hydrate(root, fixture, { operationId: op, role: "source_head_pack", expectedOid: fixture.head, pack: fixture.headPack });
  const result = await hydrate(root, fixture, { operationId: op, role: "source_head_pack", expectedOid: fixture.target, pack: fixture.targetPack, expectExit: 2 });
  if (!result.stderr.includes("role conflict")) throw new Error("conflicting role replay diagnostic mismatch: " + result.stderr);
}

async function assertDigestRejected(root, fixture) {
  const result = await hydrate(root, fixture, { operationId: "op-digest", role: "source_head_pack", expectedOid: fixture.head, pack: fixture.headPack, packSha256: "0".repeat(64), expectExit: 2 });
  if (!result.stderr.includes("pack sha256 mismatch")) throw new Error("digest rejection diagnostic mismatch: " + result.stderr);
}

async function assertSizeRejected(root, fixture) {
  const result = await hydrate(root, fixture, { operationId: "op-size", role: "source_head_pack", expectedOid: fixture.head, pack: fixture.headPack, packSizeBytes: fixture.headPack.length + 1, expectExit: 2 });
  if (!result.stderr.includes("pack size mismatch")) throw new Error("size rejection diagnostic mismatch: " + result.stderr);
}

async function assertTruncatedRejected(root, fixture) {
  const result = await hydrate(root, fixture, { operationId: "op-truncated", role: "source_head_pack", expectedOid: fixture.head, pack: fixture.headPack.subarray(0, fixture.headPack.length - 1), packSha256: sha256(fixture.headPack), packSizeBytes: fixture.headPack.length, expectExit: 2 });
  if (!result.stderr.includes("pack size mismatch")) throw new Error("truncated rejection diagnostic mismatch: " + result.stderr);
}

async function assertSubstitutedTipRejected(root, fixture) {
  const result = await hydrate(root, fixture, { operationId: "op-tip", role: "source_head_pack", expectedOid: fixture.target, pack: fixture.headPack, expectExit: 2 });
  if (!result.stderr.includes("expected tip missing")) throw new Error("substituted tip rejection diagnostic mismatch: " + result.stderr);
}

async function assertGitVersionCheckedBeforeMutation(root, fixture) {
  const op = "op-git-version";
  const dir = join(root, "work", tenant, repository, op, "trusted-git");
  await mkdir(dir, { recursive: true });
  const badGitImage = await buildWrongGitImage(root);
  const result = await hydrate(root, fixture, {
    operationId: op,
    role: "source_head_pack",
    expectedOid: fixture.head,
    pack: fixture.headPack,
    imageName: badGitImage,
    expectExit: 2,
  });
  if (!result.stderr.includes("wrong git version")) throw new Error("git version rejection diagnostic mismatch: " + result.stderr);
  try {
    await access(join(dir, ".gitfoundry-source-hydrate"), constants.F_OK);
    throw new Error("git version check created hydrate state before rejecting");
  } catch (error) {
    if (error.message === "git version check created hydrate state before rejecting") throw error;
    if (error.code !== "ENOENT") throw error;
  }
}

async function buildWrongGitImage(root) {
  const dir = join(root, "wrong-git-image");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Dockerfile"), `FROM ${image}\nCOPY fake-git /usr/local/bin/git\nRUN chmod 755 /usr/local/bin/git\n`, "utf8");
  await writeFile(join(dir, "fake-git"), "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = \"--version\" ]; then echo 'git version 9.9.9'; exit 0; fi; done\necho 'fake git reached mutation path' >&2\nexit 7\n", "utf8");
  const tag = `${image}-wrong-git`;
  await run("docker", ["build", "--platform", "linux/amd64", "-t", tag, dir], { expectExit: 0 });
  return tag;
}

async function assertSymlinkCwdRejected(root, fixture) {
  const op = "op-symlink";
  const dir = join(root, "work", tenant, repository, op, "trusted-git");
  const outside = join(root, "outside-hydrate-state");
  await mkdir(dir, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(dir, ".gitfoundry-source-hydrate"));
  const result = await hydrate(root, fixture, { operationId: op, role: "source_head_pack", expectedOid: fixture.head, pack: fixture.headPack, expectExit: 2 });
  if (!result.stderr.includes("state dir symlink") && !result.stderr.includes("path symlink")) throw new Error("symlink state rejection diagnostic mismatch: " + result.stderr);
}

async function assertHardlinkStateRejected(root, fixture) {
  const op = "op-hardlink";
  await hydrate(root, fixture, { operationId: op, role: "source_head_pack", expectedOid: fixture.head, pack: fixture.headPack });
  const state = join(root, "work", tenant, repository, op, "trusted-git", ".gitfoundry-source-hydrate", "source_head_pack.json");
  await link(state, state + ".alias");
  const result = await hydrate(root, fixture, { operationId: op, role: "source_head_pack", expectedOid: fixture.head, pack: fixture.headPack, expectExit: 2 });
  if (!result.stderr.includes("hardlink")) throw new Error("hardlink state rejection diagnostic mismatch: " + result.stderr);
}

async function assertHostileConfigRejected(root, fixture) {
  const op = "op-config";
  await hydrate(root, fixture, { operationId: op, role: "source_target_pack", expectedOid: fixture.target, pack: fixture.targetPack });
  const configPath = join(root, "work", tenant, repository, op, "trusted-git", ".git", "config");
  await writeFile(configPath, "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n[filter \"evil\"]\n\tclean = touch /work/filter-ran\n", "utf8");
  const result = await hydrate(root, fixture, { operationId: op, role: "source_head_pack", expectedOid: fixture.head, pack: fixture.headPack, expectExit: 2 });
  if (!result.stderr.includes("git config unsafe")) throw new Error("hostile config rejection diagnostic mismatch: " + result.stderr);
}

async function git(args) {
  return run("git", args, { expectExit: 0, env: { GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "tester@example.invalid", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "tester@example.invalid" } });
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd || repoRoot, env: { ...process.env, ...(options.env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (c) => stdout.push(c));
  child.stderr.on("data", (c) => stderr.push(c));
  if (options.input) child.stdin.end(options.input); else child.stdin.end();
  const code = await waitFor(child);
  const out = Buffer.concat(stdout);
  const err = Buffer.concat(stderr);
  if (code !== options.expectExit) throw new Error(`${command} ${args.join(" ")} exited ${code}\nstdout=${out.toString("utf8")}\nstderr=${err.toString("utf8")}`);
  if (options.encoding === "buffer") return { stdout: out, stderr: err, code };
  return { stdout: out.toString("utf8"), stderr: err.toString("utf8"), code };
}

function waitFor(child) {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
