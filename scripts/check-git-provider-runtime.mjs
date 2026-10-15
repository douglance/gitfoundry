#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const RUNTIME_ROOT = path.join(ROOT, "node_modules/.pnpm/node_modules/@alchemy.run/cloudflare-runtime");
const EFFECT_ROOT = path.join(ROOT, "node_modules/.pnpm/effect@4.0.2/node_modules/effect/dist");
const NODE_SERVICES = path.join(ROOT, "node_modules/.pnpm/@effect+platform-node@4.0.2_effect@4.0.2_redis@6.3.0/node_modules/@effect/platform-node/dist/NodeServices.js");
const COMPATIBILITY_DATE = "2026-09-25";
const COMPATIBILITY_FLAGS = ["nodejs_compat"];
const results = [];

function rel(file) {
  return path.relative(ROOT, file);
}

function note(name, detail = {}) {
  results.push({ name, ...detail, ok: true });
}

function fail(name, detail = {}) {
  results.push({ name, ok: false, ...detail });
  throw new Error(`${name}: ${JSON.stringify(detail)}`);
}

function assertRuntime(name, condition, detail = {}) {
  if (!condition) fail(name, detail);
  note(name, detail);
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
    packageJson: path.join(RUNTIME_ROOT, "package.json")
  };
  for (const [name, file] of Object.entries(files)) {
    assertRuntime(`runtime module exists: ${name}`, fs.existsSync(file), { file: rel(file) });
  }
  const [Effect, Layer, NodeServices, Workerd] = await Promise.all([
    importModule(files.effect),
    importModule(files.layer),
    importModule(files.nodeServices),
    importModule(files.workerd)
  ]);
  const pkg = JSON.parse(fs.readFileSync(files.packageJson, "utf8"));
  note("actual runtime imports", { package: "@alchemy.run/cloudflare-runtime", version: pkg.version });
  return { Effect, Layer, NodeServices, Workerd };
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

async function bundleProbeSource() {
  const rolldownPackage = path.join(ROOT, "node_modules/.pnpm/node_modules/rolldown/dist/index.mjs");
  assertRuntime("Rolldown exists", fs.existsSync(rolldownPackage), { file: rel(rolldownPackage) });
  const { rolldown } = await importModule(rolldownPackage);
  const bundle = await rolldown({
    input: path.join(ROOT, "tests/runtime/git-provider-probe.ts"),
    external: ["node:crypto"],
    treeshake: false
  });
  const output = await bundle.generate({ format: "es", codeSplitting: false, sourcemap: false });
  const chunk = output.output.find((item) => item.type === "chunk");
  if (!chunk) fail("git provider probe bundle emitted chunk", { output: output.output.map((item) => item.type) });
  const imports = [...new Set([...chunk.code.matchAll(/(?:import|from)\s*(?:[^'\"]*?from\s*)?[\"']([^\"']+)[\"']/g)].map((match) => match[1]))].sort();
  assertRuntime("probe bundle keeps runtime node crypto import", imports.includes("node:crypto"), { imports });
  note("git provider probe bundled", { bytes: chunk.code.length, imports });
  return chunk.code;
}

async function readJsonResponse(response) {
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, ok: response.ok, text: text.slice(0, 1000), json };
}

async function runProbe(runtime, code) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "gitfoundry-provider-runtime-"));
  const result = await withWorkerd(runtime, {
    sockets: [{ name: "probe", address: "127.0.0.1:0", service: { name: "probe" } }],
    services: [{
      name: "probe",
      worker: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: COMPATIBILITY_FLAGS,
        modules: [{ name: "index.js", esModule: code }]
      }
    }]
  }, async (ports) => {
    const response = await fetch(`http://127.0.0.1:${ports.probe}/probe`, { signal: AbortSignal.timeout(10_000) });
    return readJsonResponse(response);
  });

  assertRuntime("git provider probe runs inside actual workerd", result.status === 200 && result.json?.ok === true, { status: result.status, checks: result.json?.checks?.map((check) => check.name), error: result.json?.error, storage });
  assertRuntime("probe identifies fake provider boundary", result.json?.provider === "fake-artifacts-binding-not-cloud-proof", { provider: result.json?.provider });
  return result;
}

async function main() {
  const runtime = await loadRuntime();
  const code = await bundleProbeSource();
  const probe = await runProbe(runtime, code);
  const summary = { ok: results.every((result) => result.ok), checkedAt: new Date().toISOString(), runtime: "@alchemy.run/cloudflare-runtime Workerd.serve", compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: COMPATIBILITY_FLAGS, probe: { status: probe.status, checks: probe.json?.checks?.length ?? 0, provider: probe.json?.provider }, results };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, runtime: "@alchemy.run/cloudflare-runtime Workerd.serve", error: error instanceof Error ? error.message : String(error), results }, null, 2));
  process.exit(1);
});
