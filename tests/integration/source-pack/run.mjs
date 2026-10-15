#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { access, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const helperPath = resolve(repoRoot, "images/git-helper/gitfoundry-source-pack");
const workerSourcePackPath = resolve(repoRoot, "apps/api-worker/src/merge-candidate/source-packs.ts");
const dockerContext = resolve(repoRoot, "images");
const image = process.env.GITFOUNDRY_SOURCE_PACK_IMAGE || "gitfoundry-source-pack-test:local";
const produceFrame = "gitfoundry.source-pack.produce.v1";
const exportFrame = "gitfoundry.source-pack.export.v1";
const resultFrame = "gitfoundry.source-pack.result.v1";
const tenant = "tenant-a";
const repository = "repo-a";
const operation = "op-a";
const fence = "fence-a";
const username = "reader";
const password = "secret-token-do-not-leak";
const egressProof = "proof-token-123456";

async function main() {
  await access(helperPath, constants.F_OK);
  await run("docker", ["build", "--platform", "linux/amd64", "-f", resolve(dockerContext, "git-helper/Dockerfile"), "-t", image, dockerContext], { cwd: repoRoot, expectExit: 0 });
  const root = await mkdtemp(join(tmpdir(), "gitfoundry-source-pack-"));
  let server;
  try {
    await mkdir(join(root, "work"), { recursive: true });
    const worker = await loadWorkerSourcePackModule(root);
    const fixture = await createHttpFixture(root);
    server = fixture.server;
    await runAll(root, fixture, worker);
    console.log(JSON.stringify({ ok: true, image, helper: "/usr/local/bin/gitfoundry-source-pack", artifact_root: root }));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (!process.env.GITFOUNDRY_KEEP_SOURCE_PACK_TMP) await rm(root, { recursive: true, force: true });
  }
}

async function runAll(root, fixture, worker) {
  const { frame, fixturePublic } = buildWorkerProduceFrame(worker, fixture);
  const producedStdout = await invokeProduceFrame(root, frame);
  const workerResult = worker.parseSourcePackResult(producedStdout, frame);
  const produced = JSON.parse(producedStdout.trim());
  if (produced.ok !== true || produced.status !== "packed") throw new Error("source pack was not produced: " + JSON.stringify(produced));
  if (produced.frame !== resultFrame || produced.tip !== fixture.tip || produced.expected_oid !== fixture.tip || produced.role !== "source_head_pack") throw new Error("result identity/tip fields mismatch");
  if (produced.pack_size_bytes <= 0 || produced.pack_filename !== "source.pack" || !/^[0-9a-f]{64}$/.test(produced.pack_sha256)) throw new Error("pack digest/size missing");
  if (frame.requestSha256 !== sha256(canonicalJson(fixturePublic))) throw new Error("Worker request digest does not match fixture canonical public identity");
  if (workerResult.packSha256 !== produced.pack_sha256 || workerResult.packSizeBytes !== produced.pack_size_bytes || workerResult.manifestSha256 !== produced.manifest_sha256) throw new Error("Worker parsed result does not match helper output");
  assertWorkerRejectsTipSubstitution(worker, frame, producedStdout, fixture);

  const manifestBytes = await invokeExport(root, "manifest", produced.manifest_sha256);
  worker.validateSourcePackManifest(manifestBytes.toString("utf8"), frame, workerResult);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.private || manifest.credential || JSON.stringify(manifest).includes(password) || JSON.stringify(manifest).includes(fixture.url)) throw new Error("manifest retained private provider material");
  if (manifest.request_sha256 !== produced.request_sha256 || manifest.public.expected_oid !== fixture.tip) throw new Error("manifest public identity binding mismatch");
  if (manifest.pack.sha256 !== produced.pack_sha256 || manifest.pack.size_bytes !== produced.pack_size_bytes || manifest.pack.filename !== produced.pack_filename) throw new Error("manifest pack binding mismatch");

  const packBytes = await invokeExport(root, "pack", produced.pack_sha256);
  if (sha256(packBytes) !== produced.pack_sha256) throw new Error("exported pack digest mismatch");
  await hydrateOffline(root, packBytes, fixture);

  await assertMalformedRefRejected(root, fixture);
  await assertMissingOrWrongProofDenied(root, fixture, produced.request_sha256);
  await assertUnknownPublicFieldRejected(root, fixture);
  await assertOversizeOpenInputRejected(root, fixture);
  await assertOutputAliasRejected(root, fixture);
  await assertExportLeafAliasRejected(root, produced);
  await assertChangedTipRejected(root, fixture);
}

async function loadWorkerSourcePackModule(root) {
  const bundlePath = join(root, "worker-source-packs.bundle.mjs");
  await run("pnpm", ["exec", "esbuild", workerSourcePackPath, "--bundle", "--platform=node", "--format=esm", `--outfile=${bundlePath}`], { cwd: repoRoot, expectExit: 0 });
  return import(pathToFileURL(bundlePath).href + `?t=${Date.now()}`);
}

function buildWorkerProduceFrame(worker, fixture) {
  const fixturePublic = {
    tenant_id: tenant,
    repository_id: repository,
    operation_id: operation,
    fence_token: fence,
    provider_repository: "local/repo.git",
    ref: "refs/heads/main",
    expected_oid: fixture.tip,
    role: "source_head_pack",
    output_dir: `/work/${tenant}/${repository}/${operation}/source-pack`,
  };
  const frame = worker.buildSourcePackRequest({
    tenantId: tenant,
    repositoryId: repository,
    operationId: operation,
    fenceToken: fence,
    providerRepositoryId: "local/repo.git",
    ref: "refs/heads/main",
    expectedOid: fixture.tip,
    role: "source_head_pack",
    remoteUrl: fixture.url,
    username,
    password,
    opaqueProof: egressProof,
    allowWrite: false,
  });
  if (canonicalJson(frame.public) !== canonicalJson(fixturePublic)) throw new Error("Worker public frame does not match fixture public identity");
  if (frame.requestSha256 !== sha256(canonicalJson(fixturePublic))) throw new Error("Worker public digest does not match fixture canonical public identity");
  const stdin = JSON.parse(frame.stdin);
  if (stdin.private?.provider_url !== fixture.url || stdin.private?.credential?.username !== username || stdin.private?.credential?.password !== password || stdin.private?.artifacts_egress_proof !== egressProof) throw new Error("Worker private frame does not match actual helper credentials/proof");
  return { frame, fixturePublic };
}

function assertWorkerRejectsTipSubstitution(worker, frame, stdout, fixture) {
  const value = JSON.parse(stdout.trim());
  value.tip = fixture.base;
  let rejected = false;
  try { worker.parseSourcePackResult(JSON.stringify(value) + "\n", frame); }
  catch (error) { rejected = String(error?.message || error).includes("source pack result identity mismatch"); }
  if (!rejected) throw new Error("Worker parser accepted a source-pack result with a substituted tip");
}

async function createHttpFixture(root) {
  const reposRoot = join(root, "http-root");
  const work = join(root, "remote-work");
  const bare = join(reposRoot, "repo.git");
  await mkdir(reposRoot, { recursive: true });
  await mkdir(work, { recursive: true });
  await git(["-C", work, "init", "-q", "-b", "main"]);
  await git(["-C", work, "config", "user.name", "Source Author"]);
  await git(["-C", work, "config", "user.email", "source@example.invalid"]);
  const commits = [];
  for (const text of ["one", "two", "three"]) {
    await writeFile(join(work, "file.txt"), text + "\n", "utf8");
    await git(["-C", work, "add", "."]);
    await git(["-C", work, "commit", "-q", "-m", text]);
    commits.push((await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim());
  }
  await git(["clone", "--bare", work, bare]);
  const server = http.createServer((req, res) => serveGitHttp(req, res, reposRoot));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, work, bare, commits, base: commits[0], tip: commits.at(-1), url: `http://host.docker.internal:${port}/repo.git` };
}

async function serveGitHttp(req, res, reposRoot) {
  const auth = req.headers.authorization || "";
  const proof = req.headers["x-gitfoundry-egress-proof"] || "";
  const expected = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  if (auth !== expected || proof !== egressProof) { res.writeHead(401, { "WWW-Authenticate": "Basic" }); res.end("denied"); return; }
  const body = await readRequest(req);
  const url = new URL(req.url, "http://127.0.0.1");
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: reposRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method,
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] || "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: username,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(body);
  const chunks = [];
  const stderr = [];
  child.stdout.on("data", (c) => chunks.push(c));
  child.stderr.on("data", (c) => stderr.push(c));
  const code = await waitFor(child);
  if (code !== 0) { res.writeHead(500); res.end(Buffer.concat(stderr)); return; }
  const raw = Buffer.concat(chunks);
  const split = raw.indexOf(Buffer.from("\r\n\r\n"));
  const offset = split >= 0 ? split + 4 : raw.indexOf(Buffer.from("\n\n")) + 2;
  const headerText = raw.slice(0, offset).toString("latin1").trim();
  const headers = {};
  let status = 200;
  for (const line of headerText.split(/\r?\n/).filter(Boolean)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    if (key.toLowerCase() === "status") status = Number(value.split(/\s+/)[0]);
    else headers[key] = value;
  }
  res.writeHead(status, headers);
  res.end(raw.slice(offset));
}

async function invokeProduce(root, fixture, overrides = {}) {
  const operationId = overrides.operationId || operation;
  const request = {
    frame: produceFrame,
    public: {
      tenant_id: tenant,
      repository_id: repository,
      operation_id: operationId,
      fence_token: fence,
      provider_repository: "local/repo.git",
      ref: overrides.ref || "refs/heads/main",
      expected_oid: overrides.expectedTip || fixture.tip,
      role: overrides.role || "source_head_pack",
      output_dir: overrides.outputDir || `/work/${tenant}/${repository}/${operationId}/source-pack`,
    },
    private: {
      provider_url: fixture.url,
      credential: { type: "basic", username, password },
      artifacts_egress_proof: overrides.proof === undefined ? egressProof : overrides.proof,
    },
  };
  if (overrides.publicExtra) Object.assign(request.public, overrides.publicExtra);
  const stdin = JSON.stringify(request) + "\n";
  const requestSha = sha256(canonicalJson(request.public));
  const result = await run("docker", [
    "run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-i", "--platform", "linux/amd64",
    "--add-host", "host.docker.internal:host-gateway",
    "--mount", `type=bind,source=${root}/work,target=/work`,
    "--entrypoint", "/usr/local/bin/gitfoundry-source-pack",
    image, "produce", "--request-format", produceFrame, "--request-sha256", requestSha,
  ], { input: stdin, expectExit: 0 });
  if (result.stdout.includes(password) || result.stderr.includes(password) || result.stdout.includes(egressProof) || result.stderr.includes(egressProof)) throw new Error("private source-pack material leaked in helper output");
  const lines = result.stdout.trim().split(/\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("unexpected produce stdout: " + JSON.stringify(result.stdout));
  return JSON.parse(lines[0]);
}

async function invokeProduceFrame(root, frame) {
  const result = await run("docker", [
    "run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-i", "--platform", "linux/amd64",
    "--add-host", "host.docker.internal:host-gateway",
    "--mount", `type=bind,source=${root}/work,target=/work`,
    "--entrypoint", frame.argv[0],
    image, ...frame.argv.slice(1),
  ], { input: frame.stdin, expectExit: 0 });
  if (result.stdout.includes(password) || result.stderr.includes(password) || result.stdout.includes(egressProof) || result.stderr.includes(egressProof)) throw new Error("private source-pack material leaked in helper output");
  const lines = result.stdout.trim().split(/\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("unexpected produce stdout: " + JSON.stringify(result.stdout));
  return result.stdout;
}

async function invokeExport(root, artifact, expectedSha) {
  const request = { frame: exportFrame, public: { tenant_id: tenant, repository_id: repository, operation_id: operation, state_dir: `/work/${tenant}/${repository}/${operation}/source-pack`, artifact, expected_sha256: expectedSha } };
  const stdin = JSON.stringify(request) + "\n";
  const requestSha = sha256(canonicalJson(request.public));
  const result = await run("docker", [
    "run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-i", "--platform", "linux/amd64", "--network", "none",
    "--mount", `type=bind,source=${root}/work,target=/work`,
    "--entrypoint", "/usr/local/bin/gitfoundry-source-pack",
    image, "export", "--request-format", exportFrame, "--request-sha256", requestSha,
  ], { input: stdin, expectExit: 0, encoding: "buffer" });
  return result.stdout;
}

async function hydrateOffline(root, packBytes, fixture) {
  const packPath = join(root, "work", "exported.pack");
  await writeFile(packPath, packBytes);
  await run("docker", ["run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "--platform", "linux/amd64", "--network", "none", "--mount", `type=bind,source=${root}/work,target=/work`, "--entrypoint", "/bin/sh", image, "-c", `git init --bare /work/hydrated.git >/dev/null && git -C /work/hydrated.git unpack-objects < /work/exported.pack >/dev/null && git -C /work/hydrated.git cat-file -e ${fixture.tip}^{commit} && test $(git -C /work/hydrated.git rev-list --count ${fixture.tip}) -eq 3 && git -C /work/hydrated.git merge-base --is-ancestor ${fixture.base} ${fixture.tip}`], { expectExit: 0 });
}

async function assertChangedTipRejected(root, fixture) {
  await writeFile(join(fixture.work, "file.txt"), "four\n", "utf8");
  await git(["-C", fixture.work, "commit", "-am", "four", "-q"]);
  await git(["-C", fixture.work, "push", "-q", fixture.bare, "main"]);
  const result = await invokeProduce(root, fixture, { expectedTip: fixture.tip });
  if (result.ok !== false || result.status !== "changed_tip") throw new Error("changed tip was not rejected: " + JSON.stringify(result));
}

async function assertMalformedRefRejected(root, fixture) {
  const result = await invokeProduce(root, fixture, { ref: "main" });
  if (result.ok !== false || result.status !== "rejected") throw new Error("malformed ref was not rejected: " + JSON.stringify(result));
}

async function assertMissingOrWrongProofDenied(root, fixture, originalRequestSha) {
  const noProof = await invokeProduce(root, fixture, { operationId: "op-no-proof", proof: null });
  if (noProof.ok !== false || noProof.status !== "rejected") throw new Error("missing proof was not rejected: " + JSON.stringify(noProof));
  const wrongProof = await invokeProduce(root, fixture, { operationId: "op-wrong-proof", proof: "wrong-proof-123456" });
  if (wrongProof.ok !== false || wrongProof.status !== "rejected") throw new Error("wrong proof was not rejected: " + JSON.stringify(wrongProof));
  const rotated = await invokeProduce(root, fixture, { operationId: operation, proof: "proof-token-rotated-456" });
  if (rotated.request_sha256 !== originalRequestSha) throw new Error("public digest changed when proof changed");
}

async function assertUnknownPublicFieldRejected(root, fixture) {
  const result = await invokeProduce(root, fixture, { operationId: "op-extra", publicExtra: { ignored_extra: "must reject" } });
  if (result.ok !== false || result.status !== "rejected") throw new Error("unknown public field was not rejected: " + JSON.stringify(result));
}

async function assertOversizeOpenInputRejected(root, fixture) {
  const child = spawn("docker", ["run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-i", "--platform", "linux/amd64", "--mount", `type=bind,source=${root}/work,target=/work`, "--entrypoint", "/usr/local/bin/gitfoundry-source-pack", image, "produce", "--request-format", produceFrame, "--request-sha256", "0".repeat(64)], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (c) => stderr.push(c));
  child.stdin.write("{" + "x".repeat(9000));
  const exit = await waitForExitOrKill(child, 20000);
  const text = Buffer.concat(stderr).toString("utf8");
  if (exit.timedOut) throw new Error("oversized source-pack stdin did not fail before EOF");
  if (exit.code === 0 || !text.includes("request exceeds stdin bound")) throw new Error("oversized source-pack stdin diagnostic mismatch: " + text);
}

async function assertOutputAliasRejected(root, fixture) {
  const aliasOperation = "op-alias";
  const outside = join(root, "outside-output");
  await mkdir(outside, { recursive: true });
  await mkdir(join(root, "work", tenant, repository, aliasOperation), { recursive: true });
  await symlink(outside, join(root, "work", tenant, repository, aliasOperation, "source-pack"));
  const result = await invokeProduce(root, fixture, { expectedTip: fixture.tip, operationId: aliasOperation });
  if (result.ok !== false || result.status !== "rejected") throw new Error("output symlink alias was not rejected: " + JSON.stringify(result));
}

async function assertExportLeafAliasRejected(root, produced) {
  const packPath = join(root, "work", tenant, repository, operation, "source-pack", "source.pack");
  const aliasPath = join(root, "work", tenant, repository, operation, "source-pack", "source.pack.alias");
  await link(packPath, aliasPath);
  const request = { frame: exportFrame, public: { tenant_id: tenant, repository_id: repository, operation_id: operation, state_dir: `/work/${tenant}/${repository}/${operation}/source-pack`, artifact: "pack", expected_sha256: produced.pack_sha256 } };
  const stdin = JSON.stringify(request) + "\n";
  const requestSha = sha256(canonicalJson(request.public));
  const result = await run("docker", ["run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-i", "--platform", "linux/amd64", "--network", "none", "--mount", `type=bind,source=${root}/work,target=/work`, "--entrypoint", "/usr/local/bin/gitfoundry-source-pack", image, "export", "--request-format", exportFrame, "--request-sha256", requestSha], { input: stdin, expectExit: 2 });
  await rm(aliasPath, { force: true });
  if (!result.stderr.includes("hardlink")) throw new Error("hardlinked export leaf was not rejected: " + result.stderr);
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function waitFor(child) {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function waitForExitOrKill(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ timedOut: true, code: null }); }, timeoutMs);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ timedOut: false, code, signal }); });
  });
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

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
