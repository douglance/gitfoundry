#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const helperPath = resolve(repoRoot, "images/git-helper/gitfoundry-git-helper");
const mountedHelperPath = "/tmp/gitfoundry-git-helper-source";
const image = process.env.GFY_HELPER_IMAGE || "gitfoundry-p0-git-helper:local";

const username = "gitfoundry-http-user";
const password = "private-http-password-9f6e4bbf";
const proof = "proof-for-http-scope-3c5802d6";
const oid = "1234567890abcdef1234567890abcdef12345678";
const expectedAuth = "Basic " + Buffer.from(username + ":" + password).toString("base64");

function pktLine(payload) {
  const length = Buffer.byteLength(payload) + 4;
  return length.toString(16).padStart(4, "0") + payload;
}

function advertisement() {
  return Buffer.from([
    pktLine("# service=git-upload-pack\n"),
    "0000",
    pktLine(oid + " HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main object-format=sha1 agent=gitfoundry-test\n"),
    pktLine(oid + " refs/heads/main\n"),
    "0000",
  ].join(""), "utf8");
}

function privateCredential() {
  const b64 = (value) => Buffer.from(value, "utf8").toString("base64");
  return [
    "version=1",
    "providerId=provider-http-test",
    "providerRepositoryId=repo-http-test",
    "tenantId=tenant-http-test",
    "repositoryId=repository-http-test",
    "username_b64=" + b64(username),
    "password_b64=" + b64(password),
    "proof_b64=" + b64(proof),
    "",
  ].join("\n");
}

function assertNoPrivateCredentialSurface(label, value) {
  const text = Array.isArray(value) ? value.join("\n") : String(value || "");
  for (const secret of [password, Buffer.from(password).toString("base64")]) {
    if (text.includes(secret)) {
      throw new Error(label + " exposed the private credential");
    }
  }
}

async function main() {
  const requests = [];
  const server = createServer((request, response) => {
    const record = {
      url: request.url,
      authorization: request.headers.authorization || "",
      proof: request.headers["x-gitfoundry-egress-proof"] || "",
    };
    requests.push(record);

    if (request.method !== "GET" || request.url !== "/repo.git/info/refs?service=git-upload-pack") {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    if (record.proof !== proof) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("missing or wrong x-gitfoundry-egress-proof\n");
      return;
    }
    if (record.authorization !== expectedAuth) {
      response.writeHead(401, { "www-authenticate": "Basic realm=gitfoundry-test" });
      response.end("credential required\n");
      return;
    }

    response.writeHead(200, {
      "content-type": "application/x-git-upload-pack-advertisement",
      "cache-control": "no-cache",
    });
    response.end(advertisement());
  });

  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const { port } = server.address();
  const remote = "http://host.docker.internal:" + port + "/repo.git";
  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    "--platform",
    "linux/amd64",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--env",
    "GFY_HELPER_TEST_MODE=1",
    "--entrypoint",
    "/bin/sh",
    "--mount",
    "type=bind,source=" + helperPath + ",target=" + mountedHelperPath + ",readonly",
    image,
    mountedHelperPath,
    "ls-remote",
    remote,
    "refs/heads/main",
  ];
  assertNoPrivateCredentialSurface("docker argv", dockerArgs);
  assertNoPrivateCredentialSurface("docker env", Object.entries(process.env).map(([key, value]) => key + "=" + value));

  const child = spawn("docker", dockerArgs, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(privateCredential());
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const [code, signal] = await once(child, "exit");
  server.close();
  await once(server, "close");

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  assertNoPrivateCredentialSurface("stdout", stdout);
  assertNoPrivateCredentialSurface("stderr", stderr);

  if (code !== 0 || signal) {
    throw new Error("helper transport failed: code=" + code + " signal=" + signal + " stdout=" + JSON.stringify(stdout) + " stderr=" + JSON.stringify(stderr) + " requests=" + JSON.stringify(requests));
  }

  const expectedLine = oid + "\trefs/heads/main";
  const lines = stdout.trim().split(/\n/).filter(Boolean);
  if (lines.length !== 1 || lines[0] !== expectedLine) {
    throw new Error("unexpected ls-remote output: " + JSON.stringify(lines));
  }
  if (!requests.some((request) => request.proof === proof && request.authorization === expectedAuth)) {
    throw new Error("server never received both proof header and Basic credential: " + JSON.stringify(requests));
  }

  console.log("git-helper-http proof transport ok");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
