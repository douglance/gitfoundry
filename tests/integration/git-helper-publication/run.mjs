#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const helperPath = resolve(repoRoot, "images/git-helper/gitfoundry-git-helper");
const mountedHelperPath = "/tmp/gitfoundry-git-helper-source";
const image = process.env.GFY_HELPER_IMAGE || "gitfoundry-p0-git-helper:local";
const packagedMode = process.env.GFY_HELPER_PACKAGED;
if (packagedMode !== undefined && packagedMode !== "0" && packagedMode !== "1") throw new Error("GFY_HELPER_PACKAGED must be 0 or 1");
const usePackagedHelper = packagedMode === "1";
const helperExecutable = usePackagedHelper ? "/usr/local/bin/gitfoundry-git-helper" : mountedHelperPath;
const zeroOid = "0000000000000000000000000000000000000000";

const username = "gitfoundry-publication-user";
const password = "private-publication-password-0dcf1f6c";
const proof = "proof-for-publication-scope-22c7bb64";
const expectedAuth = "Basic " + Buffer.from(username + ":" + password).toString("base64");

function privateCredential() {
  const b64 = (value) => Buffer.from(value, "utf8").toString("base64");
  return [
    "version=1",
    "providerId=provider-publication-test",
    "providerRepositoryId=repo-publication-test",
    "tenantId=tenant-publication-test",
    "repositoryId=repository-publication-test",
    "username_b64=" + b64(username),
    "password_b64=" + b64(password),
    "proof_b64=" + b64(proof),
    "",
  ].join("\n");
}

function assertNoPrivateCredentialSurface(label, value) {
  const text = Array.isArray(value) ? value.join("\n") : String(value || "");
  for (const secret of [password, proof, Buffer.from(password).toString("base64"), Buffer.from(proof).toString("base64")]) {
    if (text.includes(secret)) {
      throw new Error(label + " exposed a private credential or proof");
    }
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertPathAbsent(label, path) {
  if (await pathExists(path)) {
    throw new Error(label + " marker was written: " + path);
  }
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  if (options.input !== undefined) {
    child.stdin.end(options.input);
  } else {
    child.stdin.end();
  }
  const [code, signal] = await once(child, "exit");
  const stdoutBuffer = Buffer.concat(stdoutChunks);
  const stdout = stdoutBuffer.toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const result = { code, signal, stdout, stdoutBuffer, stderr };
  if (options.expectExit !== undefined && code !== options.expectExit) {
    throw new Error(command + " " + args.join(" ") + " exited " + code + " signal=" + signal + " stdout=" + JSON.stringify(stdout) + " stderr=" + JSON.stringify(stderr));
  }
  return result;
}

async function git(args, options = {}) {
  const expectExit = Object.hasOwn(options, "expectExit") ? options.expectExit : 0;
  return await run("git", args, { ...options, expectExit });
}

async function commit(sourcePath, name, text) {
  await writeFile(join(sourcePath, "file.txt"), text + "\n", "utf8");
  await git(["-C", sourcePath, "add", "file.txt"]);
  await git(["-C", sourcePath, "commit", "-m", name]);
  const { stdout } = await git(["-C", sourcePath, "rev-parse", "HEAD"]);
  return stdout.trim();
}

async function commitRaw(sourcePath, body) {
  const { stdout } = await run("git", ["-C", sourcePath, "hash-object", "-t", "commit", "-w", "--stdin"], { input: body, expectExit: 0 });
  return stdout.trim();
}

async function writeBlob(sourcePath, text) {
  const { stdout } = await run("git", ["-C", sourcePath, "hash-object", "-w", "--stdin"], { input: text, expectExit: 0 });
  return stdout.trim();
}

async function annotatedTag(sourcePath, tagName, targetOid) {
  await git(["-C", sourcePath, "tag", "-a", tagName, "-m", tagName, targetOid]);
  const { stdout } = await git(["-C", sourcePath, "rev-parse", "refs/tags/" + tagName]);
  return stdout.trim();
}

async function revParse(remotePath, ref) {
  const result = await git(["--git-dir", remotePath, "rev-parse", "--verify", "--quiet", ref], { expectExit: undefined });
  if (result.code === 0) {
    return result.stdout.trim();
  }
  return null;
}

async function refsSnapshot(remotePath) {
  const { stdout } = await git(["--git-dir", remotePath, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]);
  return stdout.trim().split(/\n/).filter(Boolean).sort().join("\n");
}

function packetLine(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const length = (body.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(length, "ascii"), body]);
}

async function receivePackRequest(sourcePath, oldOid, newOid, ref, options = {}) {
  const separator = options.spaces || " ";
  const commandOld = options.uppercase ? oldOid.toUpperCase() : oldOid;
  const commandNew = options.uppercase ? newOid.toUpperCase() : newOid;
  const capabilities = options.capabilities === undefined ? "report-status side-band-64k object-format=sha1" : options.capabilities;
  const command = packetLine(commandOld + separator + commandNew + separator + ref + (capabilities === null ? "" : "\0 " + capabilities) + "\n");
  if (newOid === zeroOid) return Buffer.concat([command, Buffer.from("0000", "ascii")]);
  const revs = oldOid === zeroOid ? newOid + "\n" : newOid + "\n^" + oldOid + "\n";
  const pack = await run("git", ["-C", sourcePath, "pack-objects", "--stdout", "--revs"], { input: revs, expectExit: 0 });
  return Buffer.concat([command, Buffer.from("0000", "ascii"), pack.stdoutBuffer]);
}

function receivePackPack(raw) {
  let offset = 0;
  while (offset + 4 <= raw.length) {
    const length = Number.parseInt(raw.subarray(offset, offset + 4).toString("ascii"), 16);
    offset += 4;
    if (length === 0) return raw.subarray(offset);
    offset += length - 4;
  }
  throw new Error("receive-pack request has no flush packet");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseFacts(text) {
  const facts = new Map();
  const signatures = [];
  for (const line of text.trimEnd().split("\n")) {
    if (line === "gitfoundry-prepared-receive-pack-v1" || line === "end") continue;
    const [key, value] = line.split("\t");
    if (key === "signature_oid") signatures.push({ oid: value });
    else if (key === "signature_status") signatures[signatures.length - 1].status = value;
    else facts.set(key, value);
  }
  return { facts, signatures };
}

async function assertWorkerParserAcceptsPrepared(tmp, label, stdout, expected, limits) {
  const safeLabel = label.replace(/[^a-z0-9-]/gi, "-");
  const testPath = resolve(repoRoot, "apps/api-worker/src/git-quarantine/" + safeLabel + ".generated.test.ts");
  await writeFile(testPath, [
    "import { describe, expect, it } from 'vitest';",
    "import { parsePreparedReceivePackFacts } from './facts.js';",
    "const stdout = " + JSON.stringify(stdout) + ";",
    "const expected = " + JSON.stringify(expected) + ";",
    "const limits = " + JSON.stringify(limits) + ";",
    "describe('real helper facts', () => { it('parse with worker parser', () => { expect(parsePreparedReceivePackFacts(stdout, expected, limits).status).toBe('accepted'); }); });",
    "",
  ].join("\n"), "utf8");
  try {
    await run("pnpm", ["--filter", "@gitfoundry/api-worker", "exec", "vitest", "run", "src/git-quarantine/" + safeLabel + ".generated.test.ts"], { expectExit: 0 });
  } finally {
    await rm(testPath, { force: true });
  }
}

async function assertRemoteRef(remotePath, ref, oid) {
  const actual = await revParse(remotePath, ref);
  if (actual !== oid) {
    throw new Error("expected " + ref + " to be " + oid + ", got " + actual);
  }
  await git(["--git-dir", remotePath, "cat-file", "-e", oid + "^{commit}"]);
}

async function assertRemoteObject(remotePath, ref, oid, type) {
  const actual = await revParse(remotePath, ref);
  if (actual !== oid) {
    throw new Error("expected " + ref + " to be " + oid + ", got " + actual);
  }
  const typeResult = await git(["--git-dir", remotePath, "cat-file", "-t", oid]);
  if (typeResult.stdout.trim() !== type) {
    throw new Error("expected " + ref + " type " + type + ", got " + typeResult.stdout.trim());
  }
}

async function assertRemoteBlob(remotePath, ref, oid, expected) {
  await assertRemoteObject(remotePath, ref, oid, "blob");
  const { stdout } = await git(["--git-dir", remotePath, "cat-file", "-p", oid]);
  if (stdout !== expected) {
    throw new Error("unexpected blob content for " + ref + ": " + JSON.stringify(stdout));
  }
}

async function assertRemoteAnnotatedTag(remotePath, ref, tagOid, targetOid) {
  await assertRemoteObject(remotePath, ref, tagOid, "tag");
  const { stdout } = await git(["--git-dir", remotePath, "cat-file", "-p", tagOid]);
  if (!stdout.includes("object " + targetOid + "\n") || !stdout.includes("type commit\n")) {
    throw new Error("unexpected annotated tag content for " + ref + ": " + JSON.stringify(stdout));
  }
}

function parseCgiResponse(output) {
  const marker = output.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const splitAt = output.indexOf(marker);
  if (splitAt < 0) {
    throw new Error("git-http-backend returned malformed CGI response");
  }
  const headerText = output.slice(0, splitAt).toString("utf8");
  const body = output.slice(splitAt + marker.length);
  const headers = {};
  let status = 200;
  for (const line of headerText.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name.toLowerCase() === "status") {
      status = Number.parseInt(value, 10);
    } else {
      headers[name] = value;
    }
  }
  return { status, headers, body };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function createGitHttpServer(projectRoot, options = {}) {
  const stats = {
    requests: [],
    receivePackPosts: 0,
    racePosts: 0,
    redirects: 0,
    delayedAdvertisements: [],
  };
  const raceWaiters = [];

  async function waitForSecondRacePost(body) {
    if (!body.toString("latin1").includes("refs/heads/race")) {
      return;
    }
    stats.racePosts += 1;
    if (stats.racePosts >= 2) {
      while (raceWaiters.length) {
        raceWaiters.shift()();
      }
      return;
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for second race receive-pack post")), 15000);
      raceWaiters.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async function runBackend(request, body) {
    const url = new URL(request.url, "http://gitfoundry.test");
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers["content-type"] || "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: username,
      REMOTE_ADDR: "127.0.0.1",
    };
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.stdin.end(body);
    const [code] = await once(child, "exit");
    const stdout = Buffer.concat(stdoutChunks);
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (code !== 0) {
      throw new Error("git-http-backend exited " + code + ": " + stderr);
    }
    return parseCgiResponse(stdout);
  }

  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    if (request.url.startsWith("/redirect.git/")) {
      stats.redirects += 1;
      response.writeHead(302, { location: options.redirectLocation });
      response.end("redirect\n");
      return;
    }
    const record = {
      method: request.method,
      url: request.url,
      authOk: request.headers.authorization === expectedAuth,
      authPresent: Boolean(request.headers.authorization),
      proofOk: request.headers["x-gitfoundry-egress-proof"] === proof,
    };
    stats.requests.push(record);

    if (!record.proofOk) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("missing or wrong x-gitfoundry-egress-proof\n");
      return;
    }
    if (!record.authOk) {
      response.writeHead(401, { "www-authenticate": "Basic realm=gitfoundry-publication-test" });
      response.end("credential required\n");
      return;
    }

    try {
      if (options.rejectReads && request.url.includes("/info/refs")) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("provider read unavailable\n");
        return;
      }
      if (options.delayInfoRefsMs && request.url.includes("/info/refs")) {
        stats.delayedAdvertisements.push(performance.now());
        await new Promise((resolve) => setTimeout(resolve, options.delayInfoRefsMs));
        if (response.destroyed) return;
      }
      if (request.method === "POST" && request.url.includes("/git-receive-pack")) {
        stats.receivePackPosts += 1;
        await waitForSecondRacePost(body);
      }
      const backendResponse = await runBackend(request, body);
      response.writeHead(backendResponse.status, backendResponse.headers);
      response.end(backendResponse.body);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end((error.stack || error.message) + "\n");
    }
  });

  return { server, stats };
}

async function runHelper(remote, sourcePath, oldOid, newOid, ref, options = {}) {
  const dockerArgs = [
    "run",
    "--rm",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "-i",
    "--platform",
    "linux/amd64",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--entrypoint",
    "/bin/sh",
    "--workdir",
    "/work/source",
    ...(usePackagedHelper ? [] : ["--mount", "type=bind,source=" + helperPath + ",target=" + mountedHelperPath + ",readonly"]),
    "--mount",
    "type=bind,source=" + sourcePath + ",target=/work/source",
  ];
  if (options.testMode !== false) {
    dockerArgs.push("-e", "GFY_HELPER_TEST_MODE=1");
  }
  for (const [key, value] of Object.entries(options.env || {})) {
    dockerArgs.push("-e", key + "=" + value);
  }
  dockerArgs.push(image, helperExecutable, "publish-ref", remote, oldOid, newOid, ref);
  assertNoPrivateCredentialSurface("docker argv", dockerArgs);
  assertNoPrivateCredentialSurface("docker env", Object.entries(process.env).map(([key, value]) => key + "=" + value));

  const result = await run("docker", dockerArgs, { input: privateCredential() });
  assertNoPrivateCredentialSurface("stdout", result.stdout);
  assertNoPrivateCredentialSurface("stderr", result.stderr);
  return result;
}

async function runPrepareHelper(remote, workspacePath, rawRequest, oldOid, newOid, ref, options = {}) {
  await mkdir(join(workspacePath, "input"), { recursive: true });
  if (options.symlinkRaw) {
    const rawTarget = join(dirname(workspacePath), "escaped-receive-pack.raw");
    await writeFile(rawTarget, rawRequest);
    await symlink(rawTarget, join(workspacePath, "input", "receive-pack.raw"));
  } else {
    await writeFile(join(workspacePath, "input", "receive-pack.raw"), rawRequest);
  }
  const limitLines = options.limits || [
    "max_raw_bytes=8388608",
    "max_pack_bytes=8388608",
    "max_fact_stdout_bytes=65536",
    "max_new_objects=100",
    "max_new_commits=20",
    "max_changed_paths=100",
    "max_path_bytes=1024",
    "max_blob_bytes=1048576",
    "max_total_blob_bytes=10485760",
    "deadline_ms=55000",
    "",
  ];
  await writeFile(join(workspacePath, "input", "limits"), limitLines.join("\n"));
  const dockerArgs = [
    "run",
    "--rm",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "-i",
    "--platform",
    "linux/amd64",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--entrypoint",
    "/bin/sh",
    "--workdir",
    options.workdir || "/work/tenant/repository/operation/trusted-git",
    ...(usePackagedHelper ? [] : ["--mount", "type=bind,source=" + helperPath + ",target=" + mountedHelperPath + ",readonly"]),
    "--mount",
    "type=bind,source=" + workspacePath + ",target=/work/tenant/repository/operation/trusted-git",
  ];
  if (options.testMode !== false) dockerArgs.push("-e", "GFY_HELPER_TEST_MODE=1");
  dockerArgs.push(image, helperExecutable, "prepare-receive-pack", remote, oldOid, newOid, ref);
  assertNoPrivateCredentialSurface("prepare docker argv", dockerArgs);
  const result = await run("docker", dockerArgs, { input: privateCredential() });
  assertNoPrivateCredentialSurface("prepare stdout", result.stdout);
  assertNoPrivateCredentialSurface("prepare stderr", result.stderr);
  return result;
}

function assertSuccess(label, result) {
  if (result.code !== 0 || result.signal) {
    throw new Error(label + " failed: code=" + result.code + " signal=" + result.signal + " stdout=" + JSON.stringify(result.stdout) + " stderr=" + JSON.stringify(result.stderr));
  }
}

function assertFailure(label, result) {
  if (result.code === 0) {
    throw new Error(label + " unexpectedly succeeded: stdout=" + JSON.stringify(result.stdout) + " stderr=" + JSON.stringify(result.stderr));
  }
}

async function plantMaliciousOriginalRepoConfig(sourcePath, remote, port) {
  await git(["-C", sourcePath, "config", "--add", "credential.helper", ""]);
  await git(["-C", sourcePath, "config", "--add", "credential.helper", "!f() { echo local-helper > /work/source/local-credential-marker; }; f"]);
  await git(["-C", sourcePath, "config", "core.hooksPath", ".git/hooks"]);
  await writeFile(join(sourcePath, ".git/hooks/pre-push"), "#!/bin/sh\necho local-hook > /work/source/local-hook-marker\nexit 1\n", "utf8");
  await chmod(join(sourcePath, ".git/hooks/pre-push"), 0o755);
  await git(["-C", sourcePath, "config", "url.http://host.docker.internal:" + port + "/local-url-rewrite-marker.git.insteadOf", remote]);

  const templatePath = join(sourcePath, ".git/malicious-template");
  await mkdir(templatePath, { recursive: true });
  await writeFile(join(templatePath, "config"), [
    "[credential]",
    "\thelper = \"!f() { echo template-helper > /work/source/template-credential-marker; }; f\"",
    "[url \"http://host.docker.internal:" + port + "/template-url-rewrite-marker.git\"]",
    "\tinsteadOf = " + remote,
    "",
  ].join("\n"), "utf8");
  await git(["-C", sourcePath, "config", "init.templateDir", ".git/malicious-template"]);
}

function inheritedGitPoison(remote, port) {
  return {
    GIT_DIR: "/work/source/missing-git-dir",
    GIT_OBJECT_DIRECTORY: "/work/source/missing-objects",
    GIT_EXEC_PATH: "/work/source/missing-exec-path",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "!f() { echo inherited-helper > /work/source/inherited-credential-marker; }; f",
    GIT_CONFIG_KEY_2: "url.http://host.docker.internal:" + port + "/inherited-url-rewrite-marker.git.insteadOf",
    GIT_CONFIG_VALUE_2: remote,
    GIT_CONFIG_KEY_3: "protocol.ext.allow",
    GIT_CONFIG_VALUE_3: "always",
    GIT_CONFIG_PARAMETERS: "'url.http://host.docker.internal:" + port + "/parameters-url-rewrite-marker.git.insteadOf=" + remote + "'",
  };
}

async function assertMaliciousMarkersAbsent(sourcePath, stats) {
  await assertPathAbsent("local credential helper", join(sourcePath, "local-credential-marker"));
  await assertPathAbsent("local hook", join(sourcePath, "local-hook-marker"));
  await assertPathAbsent("inherited credential helper", join(sourcePath, "inherited-credential-marker"));
  await assertPathAbsent("template credential helper", join(sourcePath, "template-credential-marker"));
  const rewritten = stats.requests.filter((request) => request.url.includes("url-rewrite-marker"));
  if (rewritten.length > 0) {
    throw new Error("url rewrite marker reached server: " + JSON.stringify(rewritten));
  }
}

async function assertNativeStatusFrames(tmp) {
  const helperSource = await readFile(helperPath, "utf8");
  const statusSection = helperSource.slice(helperSource.indexOf("parse_receive_pack_status()"), helperSource.indexOf("limit_oid_stream()"));
  const parser = /perl -e '([\s\S]*?)' "\$1" "\$ref"/.exec(statusSection)?.[1];
  if (!parser) throw new Error("native status parser was not found");
  const fixturePath = join(tmp, "status-frames");
  await mkdir(fixturePath);
  await writeFile(join(fixturePath, "parser.pl"), parser, "utf8");
  const ok = packetLine("unpack ok\n");
  const refOk = packetLine("ok refs/heads/main\n");
  const flush = Buffer.from("0000", "ascii");
  const cases = [
    ["accepted", Buffer.concat([ok, refOk, flush]), true, "ok ok\n"],
    ["native-ng", Buffer.concat([ok, packetLine("ng refs/heads/main denied\n"), flush]), true, "ok ng\n"],
    ["unpack-error", Buffer.concat([packetLine("unpack bad object\n"), packetLine("ng refs/heads/main unpack failed\n"), flush]), true, "error ng\n"],
    ["empty", Buffer.alloc(0), true, "error missing\n"],
    ["other-ref", Buffer.concat([ok, packetLine("ok refs/heads/other\n"), flush]), false, ""],
    ["duplicate-ref", Buffer.concat([ok, refOk, refOk, flush]), false, ""],
    ["duplicate-unpack", Buffer.concat([ok, ok, refOk, flush]), false, ""],
    ["missing-flush", Buffer.concat([ok, refOk]), false, ""],
    ["missing-ref", Buffer.concat([ok, flush]), false, ""],
    ["trailing-data", Buffer.concat([ok, refOk, flush, Buffer.from("garbage")]), false, ""],
    ["unknown-line", Buffer.concat([ok, packetLine("option old-oid " + zeroOid + "\n"), refOk, flush]), false, ""],
    ["truncated-packet", Buffer.concat([ok, Buffer.from("0010ok refs")]), false, ""],
    ["sideband", Buffer.concat([packetLine(Buffer.concat([Buffer.from([1]), ok, refOk, flush])), flush]), false, ""],
    ["embedded-newline", Buffer.concat([ok, packetLine("ok refs/heads/main\nok refs/heads/other\n"), flush]), false, ""],
  ];
  const args = [];
  for (const [label, bytes, passes, stdout] of cases) {
    await writeFile(join(fixturePath, label), bytes);
    args.push("/fixtures/" + label, passes ? "0" : "nonzero", stdout);
  }
  const harness = String.raw`
use strict;
use warnings;
use IPC::Open3;
use Symbol qw(gensym);
my $parser_path = shift @ARGV;
open my $pf, "<", $parser_path or die "parser fixture missing\n";
my $parser = do { local $/; <$pf> };
close $pf;
while (@ARGV) {
  my ($path, $expected_code, $expected_stdout) = splice(@ARGV, 0, 3);
  my ($in, $out);
  my $err = gensym;
  my $pid = open3($in, $out, $err, $^X, "-e", $parser, $path, "refs/heads/main");
  close $in;
  my $stdout = do { local $/; <$out> } // "";
  my $stderr = do { local $/; <$err> } // "";
  waitpid($pid, 0);
  my $status = $?;
  if ($expected_code eq "0") {
    die "status fixture rejected or changed output: $path\n$stderr" unless $status == 0 && $stdout eq $expected_stdout;
  } else {
    die "malformed status fixture accepted: $path\n" if $status == 0;
  }
}
`;
  await run("docker", [
    "run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "--platform", "linux/amd64", "--network", "none",
    "--mount", "type=bind,source=" + fixturePath + ",target=/fixtures,readonly",
    "--entrypoint", "perl", image, "-e", harness, "/fixtures/parser.pl", ...args,
  ], { expectExit: 0 });
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), "gitfoundry-helper-publication-"));
  const remotePath = join(tmp, "repo.git");
  const sourcePath = join(tmp, "source");
  const bareSourcePath = join(tmp, "source-bare.git");
  const projectRoot = tmp;

  try {
    await assertNativeStatusFrames(tmp);
    await git(["init", "--bare", remotePath]);
    await git(["--git-dir", remotePath, "config", "http.receivepack", "true"]);
    await git(["--git-dir", remotePath, "config", "receive.denyDeleteCurrent", "ignore"]);
    await git(["init", sourcePath]);
    await git(["-C", sourcePath, "config", "user.name", "GitFoundry Publication Test"]);
    await git(["-C", sourcePath, "config", "user.email", "publication-test@gitfoundry.invalid"]);
    await git(["-C", sourcePath, "remote", "add", "origin", remotePath]);

    const oldOid = await commit(sourcePath, "base", "base");
    const updateOid = await commit(sourcePath, "update", "update");
    const staleOid = await commit(sourcePath, "stale", "stale");
    const raceA = await commit(sourcePath, "race-a", "race-a");
    const raceB = await commit(sourcePath, "race-b", "race-b");
    const annotatedTagOid = await annotatedTag(sourcePath, "annotated-fixture", updateOid);
    const blobOid = await writeBlob(sourcePath, "blob tag payload\n");
    await git(["-C", sourcePath, "push", "origin", oldOid + ":refs/heads/main"]);
    await git(["init", "--bare", bareSourcePath]);
    await git(["-C", sourcePath, "push", bareSourcePath, staleOid + ":refs/heads/object-carrier"]);

    const redirectTargetRequests = [];
    const redirectTarget = createServer((request, response) => {
      redirectTargetRequests.push({
        url: request.url,
        authorization: request.headers.authorization || "",
        proof: request.headers["x-gitfoundry-egress-proof"] || "",
      });
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("redirect target reached\n");
    });
    redirectTarget.listen(0, "0.0.0.0");
    await once(redirectTarget, "listening");
    const { port: redirectPort } = redirectTarget.address();

    const { server, stats } = createGitHttpServer(projectRoot, {
      redirectLocation: "http://host.docker.internal:" + redirectPort + "/leak.git/info/refs?service=git-receive-pack",
    });
    server.listen(0, "0.0.0.0");
    await once(server, "listening");
    const { port } = server.address();
    const remote = "http://host.docker.internal:" + port + "/repo.git";
    const redirectRemote = "http://host.docker.internal:" + port + "/redirect.git";
    await plantMaliciousOriginalRepoConfig(sourcePath, remote, port);

    try {
      const prepareWorkspace = join(tmp, "prepare", "trusted-git");
      await git(["-C", sourcePath, "checkout", "-B", "intermediate-fixture", oldOid]);
      const policyPaths = ["transient.txt", "café.txt", "\ufeffbom.txt", "line\nbreak.txt"];
      for (const path of policyPaths) await writeFile(join(sourcePath, path), "policy must see this\n", "utf8");
      await git(["-C", sourcePath, "add", "--", ...policyPaths]);
      await git(["-C", sourcePath, "commit", "-m", "add transient policy path"]);
      for (const path of policyPaths) await rm(join(sourcePath, path));
      await git(["-C", sourcePath, "add", "-A"]);
      await git(["-C", sourcePath, "commit", "-m", "remove transient policy path"]);
      const { stdout: intermediateStdout } = await git(["-C", sourcePath, "rev-parse", "HEAD"]);
      const intermediateOid = intermediateStdout.trim();
      await git(["-C", sourcePath, "checkout", "-B", "publish-fixture", updateOid]);

      const updateRaw = await receivePackRequest(sourcePath, oldOid, intermediateOid, "refs/heads/main");
      const deadlineFixture = createGitHttpServer(projectRoot, { delayInfoRefsMs: 8000 });
      deadlineFixture.server.listen(0, "0.0.0.0");
      await once(deadlineFixture.server, "listening");
      try {
        const slowRemote = "http://host.docker.internal:" + deadlineFixture.server.address().port + "/repo.git";
        const slowResult = await runPrepareHelper(slowRemote, join(tmp, "prepare-provider-deadline", "trusted-git"), updateRaw, oldOid, intermediateOid, "refs/heads/main", {
          limits: ["max_raw_bytes=8388608", "max_pack_bytes=8388608", "max_fact_stdout_bytes=65536", "max_new_objects=100", "max_new_commits=20", "max_changed_paths=100", "max_path_bytes=1024", "max_blob_bytes=1048576", "max_total_blob_bytes=10485760", "deadline_ms=2000", ""],
        });
        assertFailure("slow provider preparation", slowResult);
        const firstRequest = deadlineFixture.stats.delayedAdvertisements[0];
        if (firstRequest === undefined || performance.now() - firstRequest >= 6000) {
          throw new Error("provider ref read exceeded the preparation deadline: " + JSON.stringify({ reachedProvider: firstRequest !== undefined, elapsedMs: firstRequest === undefined ? null : performance.now() - firstRequest, helperExit: slowResult.code, helperDiagnostic: slowResult.stderr }));
        }
        if (deadlineFixture.stats.receivePackPosts !== 0) throw new Error("timed-out preparation wrote to provider");
      } finally {
        deadlineFixture.server.closeAllConnections();
        deadlineFixture.server.close();
        await once(deadlineFixture.server, "close");
      }
      const unavailableFixture = createGitHttpServer(projectRoot, { rejectReads: true });
      unavailableFixture.server.listen(0, "0.0.0.0");
      await once(unavailableFixture.server, "listening");
      try {
        const unavailableRemote = "http://host.docker.internal:" + unavailableFixture.server.address().port + "/repo.git";
        const newRef = "refs/heads/unavailable-preflight";
        const createRaw = await receivePackRequest(sourcePath, zeroOid, intermediateOid, newRef);
        const unavailableResult = await runPrepareHelper(unavailableRemote, join(tmp, "prepare-provider-unavailable", "trusted-git"), createRaw, zeroOid, intermediateOid, newRef);
        assertFailure("unavailable provider ref read", unavailableResult);
        if (unavailableFixture.stats.receivePackPosts !== 0) throw new Error("unavailable preparation wrote to provider");
      } finally {
        unavailableFixture.server.closeAllConnections();
        unavailableFixture.server.close();
        await once(unavailableFixture.server, "close");
      }
      const beforePrepareRefs = await refsSnapshot(remotePath);
      const prepareResult = await runPrepareHelper(remote, prepareWorkspace, updateRaw, oldOid, intermediateOid, "refs/heads/main");
      assertSuccess("prepare receive-pack update", prepareResult);
      const prepared = parseFacts(prepareResult.stdout);
      if (prepared.facts.get("status") !== "accepted" || prepared.facts.get("ref") !== "refs/heads/main" || prepared.facts.get("old") !== oldOid || prepared.facts.get("new") !== intermediateOid) {
        throw new Error("prepare facts did not bind the update command: " + JSON.stringify(prepareResult.stdout) + " stderr=" + JSON.stringify(prepareResult.stderr));
      }
      if (prepared.facts.get("raw_receive_pack_sha256") !== sha256(updateRaw)) throw new Error("prepare facts used the wrong raw request digest");
      if (prepared.facts.get("pack_sha256") !== sha256(receivePackPack(updateRaw))) throw new Error("prepare facts used the wrong pack digest");
      if (prepared.facts.get("object_type") !== "commit" || prepared.facts.get("fast_forward") !== "true" || Number(prepared.facts.get("new_commit_count")) < 1) {
        throw new Error("prepare facts missed commit graph facts: " + JSON.stringify(prepareResult.stdout));
      }
      const changedPaths = Buffer.from(prepared.facts.get("changed_path_b64z") || "", "base64").toString("utf8").split("\0").filter(Boolean);
      if (JSON.stringify(changedPaths.sort()) !== JSON.stringify([...policyPaths].sort())) throw new Error("prepare facts changed the exact intermediate path set: " + JSON.stringify(changedPaths));
      if (!prepared.signatures.some((signature) => signature.oid === intermediateOid && signature.status === "none")) throw new Error("prepare facts missed unsigned commit status: " + JSON.stringify(prepared.signatures));
      await assertWorkerParserAcceptsPrepared(tmp, "prepared-update", prepareResult.stdout, {
        ref: "refs/heads/main",
        oldOid,
        newOid: intermediateOid,
        rawReceivePackSha256: sha256(updateRaw),
        packSha256: sha256(receivePackPack(updateRaw)),
        signatureTrust: "unconfigured",
      }, { maxFactBytes: 65536, maxNewObjects: 100, maxNewCommits: 20, maxChangedPaths: 100, maxPathBytes: 1024, maxBlobBytes: 1048576, maxTotalBlobBytes: 10485760 });

      for (const [label, requestOptions] of [
        ["no-status-capability", { capabilities: null }],
        ["v2-status-capability", { capabilities: "report-status-v2 side-band-64k object-format=sha1" }],
        ["normalized-command", { uppercase: true, spaces: "   " }],
      ]) {
        const variantRaw = await receivePackRequest(sourcePath, oldOid, intermediateOid, "refs/heads/main", requestOptions);
        const variantResult = await runPrepareHelper(remote, join(tmp, "prepare-" + label, "trusted-git"), variantRaw, oldOid, intermediateOid, "refs/heads/main");
        assertSuccess("prepare " + label, variantResult);
        const variant = parseFacts(variantResult.stdout);
        if (variant.facts.get("status") !== "accepted" || variant.facts.get("raw_receive_pack_sha256") !== sha256(variantRaw) || variant.facts.get("pack_sha256") !== sha256(receivePackPack(variantRaw))) {
          throw new Error("private request normalization changed the original request identity: " + label);
        }
      }

      const policyAnnotatedTagOid = await annotatedTag(sourcePath, "policy-annotated-fixture", intermediateOid);
      const { stdout: policyTreeStdout } = await git(["-C", sourcePath, "rev-parse", intermediateOid + "^{tree}"]);
      for (const [label, tagOid, objectType, expectedPaths] of [
        ["commit", intermediateOid, "commit", ["file.txt", ...policyPaths]],
        ["annotated", policyAnnotatedTagOid, "tag", ["file.txt", ...policyPaths]],
        ["tree", policyTreeStdout.trim(), "tree", ["file.txt"]],
        ["blob", blobOid, "blob", []],
      ]) {
        const tagRef = "refs/tags/prepared-" + label;
        const tagRaw = await receivePackRequest(sourcePath, zeroOid, tagOid, tagRef);
        const tagResult = await runPrepareHelper(remote, join(tmp, "prepare-tag-" + label, "trusted-git"), tagRaw, zeroOid, tagOid, tagRef);
        assertSuccess("prepare " + label + " tag", tagResult);
        const tag = parseFacts(tagResult.stdout);
        const paths = Buffer.from(tag.facts.get("changed_path_b64z") || "", "base64").toString("utf8").split("\0").filter(Boolean);
        if (tag.facts.get("status") !== "accepted" || tag.facts.get("object_type") !== objectType || JSON.stringify(paths.sort()) !== JSON.stringify([...expectedPaths].sort())) {
          throw new Error("tag preparation missed exact object/history paths: " + label + " " + JSON.stringify(paths));
        }
        await assertWorkerParserAcceptsPrepared(tmp, "prepared-tag-" + label, tagResult.stdout, {
          ref: tagRef, oldOid: null, newOid: tagOid, rawReceivePackSha256: sha256(tagRaw),
          packSha256: sha256(receivePackPack(tagRaw)), signatureTrust: "unconfigured",
        }, { maxFactBytes: 65536, maxNewObjects: 100, maxNewCommits: 20, maxChangedPaths: 100, maxPathBytes: 1024, maxBlobBytes: 1048576, maxTotalBlobBytes: 10485760 });
      }

      const deleteRaw = await receivePackRequest(sourcePath, oldOid, zeroOid, "refs/heads/main");
      const deletePreparedResult = await runPrepareHelper(remote, join(tmp, "prepare-delete", "trusted-git"), deleteRaw, oldOid, zeroOid, "refs/heads/main");
      assertSuccess("prepare branch deletion", deletePreparedResult);
      const deletion = parseFacts(deletePreparedResult.stdout);
      if (deletion.facts.get("status") !== "accepted" || deletion.facts.get("object_type") !== "none" || deletion.facts.get("result_ref_oid") !== zeroOid || deletion.facts.get("new_object_count") !== "0" || deletion.facts.get("changed_path_b64z") !== "") {
        throw new Error("branch deletion preparation was rejected or invented object facts: " + JSON.stringify(deletePreparedResult.stdout));
      }
      await assertWorkerParserAcceptsPrepared(tmp, "prepared-delete", deletePreparedResult.stdout, {
        ref: "refs/heads/main", oldOid, newOid: null,
        rawReceivePackSha256: sha256(deleteRaw), packSha256: sha256(receivePackPack(deleteRaw)),
        signatureTrust: "unconfigured",
      }, { maxFactBytes: 65536, maxNewObjects: 100, maxNewCommits: 20, maxChangedPaths: 100, maxPathBytes: 1024, maxBlobBytes: 1048576, maxTotalBlobBytes: 10485760 });

      const { stdout: treeStdout } = await git(["-C", sourcePath, "rev-parse", updateOid + "^{tree}"]);
      const signedBody = [
        "tree " + treeStdout.trim(),
        "parent " + oldOid,
        "author GitFoundry Publication Test <publication-test@gitfoundry.invalid> 1700000000 +0000",
        "committer GitFoundry Publication Test <publication-test@gitfoundry.invalid> 1700000000 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " fake-signature-body",
        " -----END PGP SIGNATURE-----",
        "",
        "signed-looking fixture",
        "",
      ].join("\n");
      const signedOid = await commitRaw(sourcePath, signedBody);
      const signedRaw = await receivePackRequest(sourcePath, oldOid, signedOid, "refs/heads/main");
      const signedResult = await runPrepareHelper(remote, join(tmp, "prepare-signed", "trusted-git"), signedRaw, oldOid, signedOid, "refs/heads/main");
      assertSuccess("prepare signed-looking commit", signedResult);
      const signedPrepared = parseFacts(signedResult.stdout);
      if (!signedPrepared.signatures.some((signature) => signature.oid === signedOid && signature.status === "unsupported")) {
        throw new Error("signed-looking commit was not marked unsupported: " + JSON.stringify(signedPrepared.signatures));
      }
      if ((await refsSnapshot(remotePath)) !== beforePrepareRefs) throw new Error("prepare receive-pack mutated provider refs");
      if (stats.receivePackPosts !== 0) throw new Error("prepare receive-pack posted to provider receive-pack");

      assertFailure("symlinked receive-pack input", await runPrepareHelper(remote, join(tmp, "prepare-symlink", "trusted-git"), updateRaw, oldOid, intermediateOid, "refs/heads/main", { symlinkRaw: true }));
      assertFailure("bad trusted workspace shape", await runPrepareHelper(remote, join(tmp, "prepare-bad-workdir", "trusted-git"), updateRaw, oldOid, intermediateOid, "refs/heads/main", { workdir: "/work/tenant/repository/operation/trusted-git/child" }));
      assertFailure("missing required limit", await runPrepareHelper(remote, join(tmp, "prepare-missing-limit", "trusted-git"), updateRaw, oldOid, intermediateOid, "refs/heads/main", { limits: ["max_raw_bytes=8388608", ""] }));
      assertFailure("duplicate limit", await runPrepareHelper(remote, join(tmp, "prepare-duplicate-limit", "trusted-git"), updateRaw, oldOid, intermediateOid, "refs/heads/main", { limits: ["max_raw_bytes=8388608", "max_raw_bytes=8388608", "max_pack_bytes=8388608", "max_fact_stdout_bytes=65536", "max_new_objects=100", "max_new_commits=20", "max_changed_paths=100", "max_path_bytes=1024", "max_blob_bytes=1048576", "max_total_blob_bytes=10485760", "deadline_ms=55000", ""] }));
      assertFailure("pack byte limit", await runPrepareHelper(remote, join(tmp, "prepare-pack-limit", "trusted-git"), updateRaw, oldOid, intermediateOid, "refs/heads/main", { limits: ["max_raw_bytes=8388608", "max_pack_bytes=1", "max_fact_stdout_bytes=65536", "max_new_objects=100", "max_new_commits=20", "max_changed_paths=100", "max_path_bytes=1024", "max_blob_bytes=1048576", "max_total_blob_bytes=10485760", "deadline_ms=55000", ""] }));

      assertSuccess("update", await runHelper(remote, sourcePath, oldOid, updateOid, "refs/heads/main", { env: inheritedGitPoison(remote, port) }));
      await assertRemoteRef(remotePath, "refs/heads/main", updateOid);

      assertFailure("stale old already at candidate", await runHelper(remote, sourcePath, oldOid, updateOid, "refs/heads/main"));
      await assertRemoteRef(remotePath, "refs/heads/main", updateOid);

      assertFailure("existing create", await runHelper(remote, sourcePath, zeroOid, staleOid, "refs/heads/main"));
      await assertRemoteRef(remotePath, "refs/heads/main", updateOid);

      assertFailure("stale update", await runHelper(remote, sourcePath, oldOid, staleOid, "refs/heads/main"));
      await assertRemoteRef(remotePath, "refs/heads/main", updateOid);

      assertSuccess("branch create", await runHelper(remote, sourcePath, zeroOid, staleOid, "refs/heads/new-branch"));
      await assertRemoteRef(remotePath, "refs/heads/new-branch", staleOid);

      assertSuccess("bare source create", await runHelper(remote, bareSourcePath, zeroOid, staleOid, "refs/heads/from-bare-source"));
      await assertRemoteRef(remotePath, "refs/heads/from-bare-source", staleOid);

      assertSuccess("tag create", await runHelper(remote, sourcePath, zeroOid, updateOid, "refs/tags/v1"));
      await assertRemoteRef(remotePath, "refs/tags/v1", updateOid);

      assertSuccess("annotated tag object create", await runHelper(remote, sourcePath, zeroOid, annotatedTagOid, "refs/tags/annotated-object"));
      await assertRemoteAnnotatedTag(remotePath, "refs/tags/annotated-object", annotatedTagOid, updateOid);

      assertSuccess("blob tag object create", await runHelper(remote, sourcePath, zeroOid, blobOid, "refs/tags/blob-object"));
      await assertRemoteBlob(remotePath, "refs/tags/blob-object", blobOid, "blob tag payload\n");

      const raceResults = await Promise.all([
        runHelper(remote, sourcePath, zeroOid, raceA, "refs/heads/race"),
        runHelper(remote, sourcePath, zeroOid, raceB, "refs/heads/race"),
      ]);
      const raceSuccesses = raceResults.filter((result) => result.code === 0);
      const raceFailures = raceResults.filter((result) => result.code !== 0);
      if (raceSuccesses.length !== 1 || raceFailures.length !== 1) {
        throw new Error("expected exactly one race winner, got codes " + raceResults.map((result) => result.code).join(","));
      }
      if (stats.racePosts !== 2) {
        throw new Error("expected both race writers to reach receive-pack after advertisement, got " + stats.racePosts);
      }
      const raceRef = await revParse(remotePath, "refs/heads/race");
      if (raceRef !== raceA && raceRef !== raceB) {
        throw new Error("race ref was not written by either contender: " + raceRef);
      }

      assertSuccess("delete", await runHelper(remote, sourcePath, updateOid, zeroOid, "refs/heads/main"));
      if ((await revParse(remotePath, "refs/heads/main")) !== null) {
        throw new Error("delete left refs/heads/main present");
      }

      const beforeInvalidRefs = await refsSnapshot(remotePath);
      const beforeInvalidPosts = stats.receivePackPosts;
      const alternatesPath = join(bareSourcePath, "objects/info/alternates");
      await writeFile(alternatesPath, "/tmp/evil-objects\n", "utf8");
      assertFailure("source alternates", await runHelper(remote, bareSourcePath, zeroOid, staleOid, "refs/heads/alternates-rejected"));
      await rm(alternatesPath, { force: true });

      const malformedCases = [
        ["uppercase old oid", remote, "A".repeat(40), staleOid, "refs/heads/malformed-old", true],
        ["short new oid", remote, zeroOid, staleOid.slice(0, 39), "refs/heads/malformed-new", true],
        ["zero old zero new", remote, zeroOid, zeroOid, "refs/heads/absent-delete", true],
        ["reserved ref", remote, zeroOid, staleOid, "refs/gfy/internal", true],
        ["unsupported ref namespace", remote, zeroOid, staleOid, "refs/notes/test", true],
        ["invalid ref syntax", remote, zeroOid, staleOid, "refs/heads/bad..name", true],
        ["http without test mode", remote, zeroOid, staleOid, "refs/heads/no-test-mode", false],
        ["remote userinfo", "http://user@host.docker.internal:" + port + "/repo.git", zeroOid, staleOid, "refs/heads/bad-remote-userinfo", true],
        ["remote query", remote + "?token=bad", zeroOid, staleOid, "refs/heads/bad-remote-query", true],
        ["remote empty host", "http:///repo.git", zeroOid, staleOid, "refs/heads/bad-remote-empty-host", true],
        ["remote backslash", "http://host.docker.internal:" + port + "\\repo.git", zeroOid, staleOid, "refs/heads/bad-remote-backslash", true],
        ["remote quote", "http://host.docker.internal:" + port + "/repo.git\"bad", zeroOid, staleOid, "refs/heads/bad-remote-quote", true],
        ["remote control", "http://host.docker.internal:" + port + "/repo.git\nbad", zeroOid, staleOid, "refs/heads/bad-remote-control", true],
      ];
      for (const [label, badRemote, oldValue, newValue, ref, testMode] of malformedCases) {
        assertFailure(label, await runHelper(badRemote, sourcePath, oldValue, newValue, ref, { testMode }));
      }
      const afterInvalidRefs = await refsSnapshot(remotePath);
      if (afterInvalidRefs !== beforeInvalidRefs) {
        throw new Error("malformed inputs changed refs\nbefore:\n" + beforeInvalidRefs + "\nafter:\n" + afterInvalidRefs);
      }
      if (stats.receivePackPosts !== beforeInvalidPosts) {
        throw new Error("malformed inputs reached receive-pack: before=" + beforeInvalidPosts + " after=" + stats.receivePackPosts);
      }
      if (!stats.requests.some((request) => request.url.includes("/repo.git/") && request.authOk && request.proofOk)) {
        throw new Error("server never received correct repo path with both Basic credential and proof header");
      }

      const redirectResult = await runHelper(redirectRemote, sourcePath, zeroOid, staleOid, "refs/heads/redirect-rejected");
      assertFailure("redirect remote", redirectResult);
      if (stats.redirects < 1) {
        throw new Error("redirect fixture did not receive the original redirect request: stdout=" + JSON.stringify(redirectResult.stdout) + " stderr=" + JSON.stringify(redirectResult.stderr));
      }
      const redirectedOrCredentialedRequests = redirectTargetRequests.filter(request =>
        request.url?.startsWith("/leak.git/") || request.authorization || request.proof
      );
      if (redirectedOrCredentialedRequests.length !== 0) {
        throw new Error("redirect target was reached: " + JSON.stringify(redirectedOrCredentialedRequests));
      }

      await assertMaliciousMarkersAbsent(sourcePath, stats);
    } finally {
      server.close();
      redirectTarget.close();
      await Promise.all([once(server, "close"), once(redirectTarget, "close")]);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log("git-helper-publication publish-ref CAS and config isolation ok");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
