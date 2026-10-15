#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { activeForgeToolNames, createNativeForgeFixture } from "../tests/runtime/forge-native-fixture.mjs";
let nativeFixture;

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const RUNTIME_ROOT = path.join(ROOT, "node_modules/.pnpm/node_modules/@alchemy.run/cloudflare-runtime");
const EFFECT_ROOT = path.join(ROOT, "node_modules/.pnpm/effect@4.0.2/node_modules/effect/dist");
const NODE_SERVICES = path.join(ROOT, "node_modules/.pnpm/@effect+platform-node@4.0.2_effect@4.0.2_redis@6.3.0/node_modules/@effect/platform-node/dist/NodeServices.js");
const DIAGNOSTIC = process.argv.includes("--diagnostic");
const ISSUER = "https://issuer.p0-runtime.local";
const AUDIENCE = "gitfoundry-runtime-harness";
const DATABASE_ID = "gitfoundry-p0-runtime";
const NOW = new Date("2026-10-08T00:00:00.000Z");
const BRIDGE_ISSUE_TITLE = "Code Mode bridge issue";
const BRIDGE_ISSUE_IDEMPOTENCY_KEY = "p0-codemode-bridge-issue-create";
const TENANT_SUBSTITUTION_TITLE = "Code Mode tenant substitution must not write";
const TENANT_SUBSTITUTION_IDEMPOTENCY_KEY = "p0-codemode-tenant-substitution-denied";
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream"
};

const results = [];
const blockers = [];

function rel(file) {
  return path.relative(ROOT, file);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function note(name, detail = {}) {
  results.push({ name, ...detail, ok: true });
}

function block(name, detail = {}) {
  const item = { name, ok: false, blocked: true, ...detail };
  blockers.push(item);
  results.push(item);
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
    internalModules: path.join(RUNTIME_ROOT, "dist/core/node/internal/internal-modules.mjs"),
    internalWorker: path.join(RUNTIME_ROOT, "dist/core/node/internal/internal-worker.mjs"),
    d1Options: path.join(RUNTIME_ROOT, "dist/core/node/bindings/d1/D1Options.shared.mjs"),
    packageJson: path.join(RUNTIME_ROOT, "package.json")
  };
  for (const [name, file] of Object.entries(files)) {
    assertRuntime(`runtime module exists: ${name}`, fs.existsSync(file), { file: rel(file) });
  }
  const [Effect, Layer, NodeServices, Workerd, internalModules, internalWorker, d1Options] = await Promise.all([
    importModule(files.effect),
    importModule(files.layer),
    importModule(files.nodeServices),
    importModule(files.workerd),
    importModule(files.internalModules),
    importModule(files.internalWorker),
    importModule(files.d1Options)
  ]);
  const pkg = JSON.parse(fs.readFileSync(files.packageJson, "utf8"));
  note("actual runtime imports", { package: "@alchemy.run/cloudflare-runtime", version: pkg.version });
  return { Effect, Layer, NodeServices, Workerd, ...internalModules, ...internalWorker, d1Options };
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

function validateCanonicalD1Fixture() {
  const fixture = readJson("tests/runtime/fixtures/canonical-d1-source.json");
  const sourcePath = path.join(ROOT, fixture.source);
  const source = fs.readFileSync(sourcePath);
  const count = (source.toString("utf8").match(/CREATE\s+TABLE/gi) ?? []).length;
  assertRuntime("canonical D1 source hash", sha256(source) === fixture.sha256, { source: fixture.source, sha256: fixture.sha256 });
  assertRuntime("canonical D1 table count", count === fixture.create_table_count, { count });
  return source.toString("utf8") + "\n" + ["0007_owner_access.sql", "0008_resource_events.sql", "0012_email_sign_in.sql"].map((file) => fs.readFileSync(path.join(ROOT, "infra/migrations", file), "utf8")).join("\n");
}

function validateMcpFixtureShape() {
  const fixture = readJson("tests/runtime/fixtures/mcp-json-rpc.json");
  const methods = [fixture.initialize.method, fixture.tools_list.method, fixture.direct_tool.method];
  assertRuntime("MCP JSON-RPC fixture shape", methods.join(",") === "initialize,tools/list,tools/call", { methods });
  return fixture;
}

function sourceMcpToolNames() { return activeForgeToolNames; }

function compareToolNames(actualTools, expectedNames) {
  const actualNames = actualTools.map((tool) => tool.name).sort();
  const expected = new Set(expectedNames);
  const actual = new Set(actualNames);
  return {
    actualNames,
    missing: expectedNames.filter((name) => !actual.has(name)),
    extra: actualNames.filter((name) => !expected.has(name))
  };
}

function inspectImports(code) {
  return [...new Set([...code.matchAll(/(?:import|from)\s*(?:[^'\"]*?from\s*)?[\"']([^\"']+)[\"']/g)].map((match) => match[1]))].sort();
}

async function bundleActualApiSource() {
  const rolldownPackage = path.join(ROOT, "node_modules/.pnpm/node_modules/rolldown/dist/index.mjs");
  assertRuntime("Rolldown API exists", fs.existsSync(rolldownPackage), { file: rel(rolldownPackage) });
  const { rolldown } = await importModule(rolldownPackage);
  const bundle = await rolldown({
    input: "\0native-forge-runtime",
    plugins: [{ name: "native-forge-fixture", resolveId: id => id === "\0native-forge-runtime" ? id : null, load: id => id === "\0native-forge-runtime" ? nativeFixture.apiModuleSource() : null }],
    external: ["cloudflare:workers"],
    treeshake: false
  });
  const output = await bundle.generate({ format: "es", codeSplitting: false, sourcemap: false });
  const chunk = output.output.find((item) => item.type === "chunk");
  if (!chunk) fail("actual API source bundle emitted chunk", { output: output.output.map((item) => item.type) });
  const imports = inspectImports(chunk.code);
  note("actual API source bundled with Rolldown", { bytes: chunk.code.length, imports });
  return { code: chunk.code, imports };
}

// Each principal signs in the way gfy login does; the seeder stores only the token hashes.
function makeJwtFixture() {
  const session = () => "gfys_" + crypto.randomBytes(32).toString("base64url");
  const tokens = { tenantA: session(), tenantB: session(), wrongMarker: session(), revokedPrincipal: session() };
  const hashes = {
    "principal-a": sha256(tokens.tenantA),
    "principal-b": sha256(tokens.tenantB),
    "principal-revoked": sha256(tokens.revokedPrincipal)
  };
  note("offline session fixture", { subjects: Object.keys(tokens), unseeded: ["wrongMarker"] });
  return { publicJwk: {}, tokens, hashes };
}

function textBinding(name, text) {
  return { name, text };
}

function d1Binding(name) {
  return {
    name,
    wrapped: {
      moduleName: "cloudflare-internal:d1-api",
      innerBindings: [{ name: "fetcher", service: { name: "d1", props: { json: JSON.stringify({ databaseId: DATABASE_ID }) } } }]
    }
  };
}

async function d1Services(runtime, storagePath) {
  const { BINDING_D1_OBJECT, D1_OBJECT_CLASS_NAME, SERVICE_D1, SERVICE_D1_STORAGE } = runtime.d1Options;
  const worker = await runtime.loadInternalWorker("#cloudflare-runtime-core-worker/bindings/d1/D1.worker");
  return [
    { name: SERVICE_D1_STORAGE, disk: { path: storagePath, writable: true } },
    {
      name: SERVICE_D1,
      worker: {
        compatibilityDate: "2026-03-10",
        modules: runtime.formatInternalWorkerModules(worker),
        durableObjectNamespaces: [{ className: D1_OBJECT_CLASS_NAME, enableSql: true, uniqueKey: `cloudflare-runtime-${D1_OBJECT_CLASS_NAME}`, preventEviction: true }],
        durableObjectStorage: { localDisk: SERVICE_D1_STORAGE },
        bindings: [{ name: BINDING_D1_OBJECT, durableObjectNamespace: { className: D1_OBJECT_CLASS_NAME } }]
      }
    }
  ];
}

function jwksWorkerSource(publicJwk) {
  return `const jwks = ${JSON.stringify({ keys: [publicJwk] })};\nexport default { fetch() { return Response.json(jwks, { headers: { \"cache-control\": \"no-store\" } }); } };`;
}

function seederWorkerSource(schema, sessionHashes) {
  return `
const schema = ${JSON.stringify(schema)};
const sessionHashes = ${JSON.stringify(sessionHashes)};
const now = ${JSON.stringify(NOW.toISOString())};
const allCapabilities = ["identity.read","repository.read","repository.write","review.write","forge.initialize","forge.read","forge.fork","forge.commit","forge.compare","forge.merge","forge.publish","forge.recover"];
const readerCapabilities = ["identity.read", "repository.read"];
function schemaStatements() {
  return schema
    .split(String.fromCharCode(10))
    .map((line) => line.replace(/--.*$/, ""))
    .join(" ")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement && !statement.startsWith("CREATE TRIGGER") && statement !== "END");
}
async function run(env, sql, ...values) { return await env.DB.prepare(sql).bind(...values).run(); }
async function installSchema(env) { for (const statement of schemaStatements()) await env.DB.exec(statement); }
async function insertTenant(env, tenant, principal, subject, grant, activePrincipal, capabilities) {
  await run(env, "INSERT INTO tenants VALUES(?,?,?,?,?,?,?)", tenant, tenant, "active", 1, tenant.replace("tenant", "shard"), "US", "{}");
  await run(env, "INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)", tenant, principal, 1, now, now, "human", principal, activePrincipal ? 1 : 0, 1);
  await run(env, "INSERT INTO roles VALUES(?,?,?,?,?,?,?)", tenant, "role-" + principal, 1, now, now, "runtime-role", JSON.stringify(capabilities));
  await run(env, "INSERT INTO owner_access_grants(tenant_id,id,principal_id,resource_kind,resource_id,role_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)", tenant, grant, principal, "tenant", tenant, "role-" + principal, "2999-01-01T00:00:00.000Z", now);
  await run(env, "INSERT INTO auth_browser_sessions(token_hash,email,tenant_id,principal_id,created_at,expires_at) VALUES(?,?,?,?,?,?)", sessionHashes[principal], principal + "@example.invalid", tenant, principal, now, "2999-01-01T00:00:00.000Z");
  await run(env, "INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)", tenant, "namespace-" + tenant, 1, now, now, "namespace-" + tenant, "Namespace " + tenant);
  await run(env, "INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", tenant, "repo-" + tenant, 1, now, now, "namespace-" + tenant, "demo", "private", "main", 0, tenant, "repo-" + tenant, null);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/seed") {
      await installSchema(env);
      await insertTenant(env, "tenant-a", "principal-a", "directory-subject-a", "grant-a", true, allCapabilities);
      await insertTenant(env, "tenant-b", "principal-b", "directory-subject-b", "grant-b", true, allCapabilities);
      await insertTenant(env, "tenant-a-revoked", "principal-revoked", "directory-subject-revoked", "grant-revoked", false, readerCapabilities);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/remove-grant-b") {
      await run(env, "DELETE FROM owner_access_grants WHERE tenant_id = ? AND id = ?", "tenant-b", "grant-b");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/deactivate-member-a") {
      await run(env, "UPDATE principals SET active = 0 WHERE tenant_id = ? AND id = ?", "tenant-a", "principal-a");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/bridge-issue-a") {
      const result = await env.DB.prepare("SELECT COUNT(*) AS count, MIN(id) AS id, MIN(title) AS title, MIN(repository_id) AS repository_id FROM issues WHERE tenant_id = ? AND repository_id = ? AND title = ?").bind("tenant-a", "repo-tenant-a", ${JSON.stringify(BRIDGE_ISSUE_TITLE)}).all();
      const row = result.results?.[0] ?? {};
      return Response.json({ ok: true, count: Number(row.count ?? 0), id: row.id ?? null, title: row.title ?? null, repository_id: row.repository_id ?? null });
    }
    if (url.pathname === "/tenant-substitution-issue-a") {
      const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM issues WHERE tenant_id = ? AND repository_id = ? AND title = ?").bind("tenant-a", "repo-tenant-a", ${JSON.stringify(TENANT_SUBSTITUTION_TITLE)}).all();
      const row = result.results?.[0] ?? {};
      return Response.json({ ok: true, count: Number(row.count ?? 0) });
    }
    if (url.pathname === "/issue-count-a") {
      const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM issues WHERE tenant_id = ? AND repository_id = ? AND title = ?").bind("tenant-a", "repo-tenant-a", "Directory deactivation probe").all();
      const row = result.results?.[0] ?? {};
      return Response.json({ ok: true, count: Number(row.count ?? 0) });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
};`;
}

function probeWorkerSource() {
  return `
async function readJson(response) {
  const text = await response.text();
  try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, text }; }
}
async function agent(env, path, body) {
  return await env.API.fetch(new Request("https://gitfoundry.internal" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
export default {
  async fetch(request, env) {
    const input = await request.json().catch(() => ({}));
    if (new URL(request.url).pathname === "/identity") {
      return agent(env, "/identity", { requested_tenant_id: input.tenant, userAuthorization: input.authorization });
    }
    if (new URL(request.url).pathname === "/deactivate-between-identity-and-invoke") {
      const identity = await agent(env, "/identity", { requested_tenant_id: "tenant-a", userAuthorization: input.authorization });
      const identityRead = await readJson(identity);
      const deactivated = await env.SEED.fetch(new Request("https://seed.internal/deactivate-member-a", { method: "POST" }));
      const invoke = await agent(env, "/invoke", {
        operation_id: "forge.fork",
        context: identityRead.json,
        arguments: { route: { tenant_id: "tenant-a", repository_id: "repo-tenant-a" }, query: {}, body: { parent_version: "a".repeat(40), operation_id: "directory-deactivation-probe" } },
        execution: { idempotency_key: "p0-directory-deactivation-issue-create" }
      });
      const issueCount = await env.SEED.fetch(new Request("https://seed.internal/issue-count-a", { method: "POST" }));
      return Response.json({ identity: identityRead, deactivated: await readJson(deactivated), invoke: await readJson(invoke), issueCount: await readJson(issueCount) });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
};`;
}

function apiWorkerService(apiBundle) {
  return {
    name: "api",
    worker: {
      compatibilityDate: "2026-10-07",
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ name: "index.js", esModule: apiBundle.code }],
      globalOutbound: { name: "jwks" },
      bindings: [
        textBinding("GFY_AUTH_ISSUER", ISSUER),
        textBinding("GFY_AUTH_AUDIENCE", AUDIENCE),
        textBinding("GFY_MCP_AUTH_AUDIENCE", AUDIENCE),
        textBinding("GFY_AUTH_JWKS_URL", `${ISSUER}/.well-known/jwks.json`),
        d1Binding("DB"),
        nativeFixture.binding
      ]
    }
  };
}

async function probeActualApi(runtime, apiBundle) {
  let result;
  try {
    result = await withWorkerd(runtime, {
      sockets: [{ name: "http", address: "127.0.0.1:0", service: { name: "api" } }],
      services: [{
        name: "api",
        worker: {
          compatibilityDate: "2026-10-07",
          compatibilityFlags: ["nodejs_compat"],
          modules: [{ name: "index.js", esModule: apiBundle.code }],
          bindings: [
            textBinding("GFY_AUTH_ISSUER", ISSUER),
            textBinding("GFY_AUTH_AUDIENCE", AUDIENCE),
            textBinding("GFY_AUTH_JWKS_URL", `${ISSUER}/.well-known/jwks.json`)
          ]
        }
      }]
    }, async (ports) => {
      const response = await fetch(`http://127.0.0.1:${ports.http}/health`, { signal: AbortSignal.timeout(5_000) });
      return { status: response.status, body: (await response.text()).slice(0, 240) };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    block("actual API worker runs under workerd", { error: message.slice(0, 320), imports: apiBundle.imports });
    return null;
  }
  if (result.status === 200) note("actual API worker health runs under workerd", result);
  else block("actual API worker health runs under workerd", result);
  return result;
}

function remoteWorkerModules() {
  const jsFile = path.join(ROOT, "target/p0-remote-worker-build/index.js");
  const wasmFile = path.join(ROOT, "target/p0-remote-worker-build/index_bg.wasm");
  assertRuntime("real Rust remote JS/WASM artifacts exist", fs.existsSync(jsFile) && fs.existsSync(wasmFile), { js: rel(jsFile), wasm: rel(wasmFile) });
  const js = fs.readFileSync(jsFile, "utf8");
  const wasm = fs.readFileSync(wasmFile);
  const wasmText = wasm.toString("latin1");
  assertRuntime("real Rust WASM contains MCP protocol strings", wasmText.includes("initialize") && wasmText.includes("tools/list") && wasmText.includes("tools/call"), { wasm: rel(wasmFile), wasmBytes: wasm.length });
  return { js, wasm };
}

function responseSummary(response) {
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    error: response.json?.error ?? response.json?.error?.message ?? response.json?.error_description ?? response.text?.slice(0, 120)
  };
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, text: text.slice(0, 1_000), json };
}

function toolResultPayload(json) {
  const result = json?.result;
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find?.((entry) => entry.type === "text")?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return result;
}

function findExecutionId(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.id === "string" && /^exec_|^01/.test(value.id)) return value.id;
  if (typeof value.execution_id === "string") return value.execution_id;
  for (const child of Object.values(value)) {
    const found = findExecutionId(child);
    if (found) return found;
  }
  return null;
}

function findExecutionStatus(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.status === "string") return value.status;
  if (typeof value.state === "string") return value.state;
  for (const child of Object.values(value)) {
    const found = findExecutionStatus(child);
    if (found) return found;
  }
  return null;
}

function findExecutionResult(value) {
  if (!value || typeof value !== "object") return undefined;
  if ((typeof value.id === "string" || typeof value.execution_id === "string") && Object.prototype.hasOwnProperty.call(value, "result")) return value.result;
  if ((typeof value.status === "string" || typeof value.state === "string") && Object.prototype.hasOwnProperty.call(value, "output")) return value.output;
  if (Object.prototype.hasOwnProperty.call(value, "return_value")) return value.return_value;
  for (const child of Object.values(value)) {
    const found = findExecutionResult(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findPendingAction(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.log)) {
    const pending = value.log.find((entry) => String(entry?.state ?? "").toLowerCase() === "pending" && Number.isInteger(entry?.seq));
    if (pending) return { seq: pending.seq, connector: pending.connector ?? null, method: pending.method ?? null };
  }
  for (const child of Object.values(value)) {
    const found = findPendingAction(child);
    if (found) return found;
  }
  return null;
}

function codeModeExecutionSummary(response) {
  const payload = toolResultPayload(response?.json);
  const id = findExecutionId(payload);
  const status = findExecutionStatus(payload);
  const error = payload?.error ?? response?.json?.error?.message ?? null;
  const result = findExecutionResult(payload);
  const pending = findPendingAction(payload);
  return { id, status, error, hasPayload: Boolean(payload), result, pending };
}

function executionHasState(response, expectedId, allowedStates) {
  const summary = codeModeExecutionSummary(response);
  return summary.id === expectedId && allowedStates.includes(String(summary.status ?? "").toLowerCase()) && !summary.error;
}

function typedAuthorizationDenial(response) {
  const error = response?.json?.error ?? response?.json?.message ?? response?.json?.detail ?? "";
  const text = `${error} ${JSON.stringify(response?.json ?? {})}`.toLowerCase();
  return response?.status === 403 && /forbidden|permission|denied|unauthori[sz]ed|authorization|grant|identity|principal/.test(text);
}

function scanDirectoryForNeedles(directory, needles) {
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, name.name);
      if (name.isDirectory()) walk(file);
      else if (name.isFile()) {
        const bytes = fs.readFileSync(file);
        const text = bytes.toString("utf8");
        for (const [label, needle] of Object.entries(needles)) {
          if (needle && text.includes(needle)) hits.push({ file: rel(file), label });
        }
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return hits;
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function sqliteFiles(directory) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const header = fs.readFileSync(file, { encoding: null, flag: "r" }).subarray(0, 16).toString("latin1");
        if (header === "SQLite format 3\0") files.push(file);
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return files;
}

function inspectCodeModeSqlStorage(directory, needles) {
  const files = sqliteFiles(directory);
  const tableInfo = [];
  const secretHits = [];
  let executionRows = 0;
  let eventRows = 0;
  for (const file of files) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      for (const table of tables) {
        const tableName = table.name;
        const columns = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all().map((column) => column.name);
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(tableName)}`).get();
        const count = Number(row?.count ?? 0);
        const isExecution = /execution/i.test(tableName);
        const isEvent = /event|log/i.test(tableName);
        if (isExecution) executionRows += count;
        if (isEvent) eventRows += count;
        if (isExecution || isEvent) tableInfo.push({ file: rel(file), table: tableName, columns, count });
        const textColumns = columns.filter((column) => /id|state|status|event|payload|result|error|code|stdout|stderr|message|request/i.test(column)).slice(0, 12);
        if (count > 0 && textColumns.length > 0) {
          const selected = textColumns.map(quoteIdent).join(", ");
          for (const sample of db.prepare(`SELECT ${selected} FROM ${quoteIdent(tableName)} LIMIT 25`).all()) {
            const text = JSON.stringify(sample);
            for (const [label, needle] of Object.entries(needles)) {
              if (needle && text.includes(needle)) secretHits.push({ file: rel(file), table: tableName, label });
            }
          }
        }
      }
    } finally {
      db.close();
    }
  }
  return { sqliteFileCount: files.length, tableInfo, executionRows, eventRows, secretHits };
}

function codeModeBridgeProgram() {
  const policy = { schema_version: 1, evaluator_digest: "runtime-transport-fixture", checks: [], reviews: { required_approvals: 0, trusted_reviewer_ids: ["principal-a"], actor_kinds: ["human"], key_ids: ["fixture-review-key"] } };
  const initialize = { tenant_id: "tenant-a", repository_id: "repo-tenant-a", operation_id: "codemode-runtime-initialize", initial_code: [{ path: "README.md", content_base64: Buffer.from("Code Mode runtime fixture\n").toString("base64") }], initial_state: [{ path: "config/publication.json", content_base64: Buffer.from(JSON.stringify(policy)).toString("base64") }] };
  const issue = { schema_version: 1, id: "code-mode-runtime", title: BRIDGE_ISSUE_TITLE, status: "open" };
  const content = Buffer.from(JSON.stringify(issue)).toString("base64");
  return `
const unwrap = value => value?.data ? unwrap(value.data) : value?.structuredContent ? unwrap(value.structuredContent) : value?.result && !value?.id ? unwrap(value.result) : value?.value ? unwrap(value.value) : value;
const initialized = unwrap(await gitfoundry.gfy_forge_initialize(${JSON.stringify(initialize)}));
const base = initialized.version ?? initialized;
const created = await gitfoundry.gfy_forge_commit({ tenant_id: "tenant-a", repository_id: "repo-tenant-a", operation_id: ${JSON.stringify(BRIDGE_ISSUE_IDEMPOTENCY_KEY)}, parent_version: base.version_commit, changes: [{ tree: "state", path: "issues/code-mode-runtime.json", content_base64: ${JSON.stringify(content)} }] });
const candidate = unwrap(created).version ?? unwrap(created);
const read = await gitfoundry.gfy_forge_read({ tenant_id: "tenant-a", repository_id: "repo-tenant-a", version: candidate.version_commit, tree: "state", path: "issues/code-mode-runtime.json" });
return { created, read };
`;
}

function codeModeTenantSubstitutionProgram() {
  return `
let denied = null;
try {
  denied = await gitfoundry.gfy_forge_initialize({ tenant_id: "tenant-b", repository_id: "repo-tenant-a", operation_id: ${JSON.stringify(TENANT_SUBSTITUTION_IDEMPOTENCY_KEY)}, initial_code: [{ path: "README.md", content_base64: "ZGVuaWVkCg==" }] });
} catch (error) { denied = { thrown: true, message: String(error) }; }
return { denied };
`;
}

function unwrapToolBridgeValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Object.prototype.hasOwnProperty.call(value, "data")) return unwrapToolBridgeValue(value.data);
  if (Object.prototype.hasOwnProperty.call(value, "structuredContent")) return unwrapToolBridgeValue(value.structuredContent);
  if (Object.prototype.hasOwnProperty.call(value, "result") && !Object.prototype.hasOwnProperty.call(value, "id")) return unwrapToolBridgeValue(value.result);
  return value;
}

function firstArray(value, names) {
  for (const name of names) {
    const candidate = value?.[name];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function bridgeIssueShape(summary) {
  const result = unwrapToolBridgeValue(summary.result);
  const envelope = unwrapToolBridgeValue(result?.created);
  const version = unwrapToolBridgeValue(envelope?.version ?? envelope);
  const read = unwrapToolBridgeValue(result?.read);
  let record = null;
  try { record = JSON.parse(Buffer.from(read?.content ?? "", "base64").toString("utf8")); } catch {}
  return {
    versionCommit: version?.version_commit,
    record,
    titleMatches: record?.title === BRIDGE_ISSUE_TITLE,
    tenantMatches: version?.descriptor?.tenant_id === "tenant-a",
    repositoryMatches: version?.descriptor?.repository_id === "repo-tenant-a",
    exactRecordRead: read?.encoding === "base64" && record?.id === "code-mode-runtime"
  };
}

function tenantSubstitutionDenied(summary) {
  const result = unwrapToolBridgeValue(summary.result);
  const denied = unwrapToolBridgeValue(result?.denied);
  const message = String(denied?.message ?? denied?.error ?? summary.error ?? "");
  return Boolean(denied?.thrown) && /UNAUTHORIZED|API_ERROR|tenant_id|verified tenant|403/i.test(message);
}

async function driveCodeModeExecution(mcp, tenant, authorization, executionId, rpcStart) {
  let latest = null;
  let nextId = rpcStart;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    latest = await mcp(tenant, authorization, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "codemode_execution", arguments: { id: executionId } } });
    const summary = codeModeExecutionSummary(latest);
    const status = String(summary.status ?? "").toLowerCase();
    if (["completed", "complete", "succeeded", "failed", "errored", "cancelled", "canceled"].includes(status) || summary.error) return latest;
    if (status === "paused" && summary.pending) {
      latest = await mcp(tenant, authorization, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "codemode_decide", arguments: { id: executionId, seq: summary.pending.seq, decision: "approve" } } });
      const decided = codeModeExecutionSummary(latest);
      const decidedStatus = String(decided.status ?? "").toLowerCase();
      if (["completed", "complete", "succeeded", "failed", "errored", "cancelled", "canceled"].includes(decidedStatus) || decided.error) return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

function runtimeSockets() {
  return [
    { name: "remote", address: "127.0.0.1:0", service: { name: "remote" } },
    { name: "seed", address: "127.0.0.1:0", service: { name: "seeder" } },
    { name: "probe", address: "127.0.0.1:0", service: { name: "probe" } }
  ];
}

async function runtimeServices(runtime, { codeModeStorage, d1Storage, apiBundle, schema, jwtFixture }) {
  const remote = remoteWorkerModules();
  return [
    { name: "codemode-disk", disk: { path: codeModeStorage, writable: true } },
    ...(await d1Services(runtime, d1Storage)),
    nativeFixture.service,
    { name: "jwks", worker: { compatibilityDate: "2026-03-10", modules: [{ name: "index.js", esModule: jwksWorkerSource(jwtFixture.publicJwk) }] } },
    { name: "seeder", worker: { compatibilityDate: "2026-03-10", modules: [{ name: "index.js", esModule: seederWorkerSource(schema, jwtFixture.hashes) }], bindings: [d1Binding("DB")] } },
    apiWorkerService(apiBundle),
    { name: "probe", worker: { compatibilityDate: "2026-03-10", modules: [{ name: "index.js", esModule: probeWorkerSource() }], bindings: [{ name: "API", service: { name: "api", entrypoint: "AgentApi" } }, { name: "SEED", service: { name: "seeder" } }] } },
    {
      name: "remote",
      worker: {
        compatibilityDate: "2026-03-10",
        modules: [
          { name: "index.js", esModule: remote.js },
          { name: "index_bg.wasm", wasm: remote.wasm }
        ],
        durableObjectNamespaces: [{ className: "GitFoundryCodeMode", uniqueKey: "p0-real-remote", enableSql: true }],
        durableObjectStorage: { localDisk: "codemode-disk" },
        bindings: [
          { name: "API", service: { name: "api", entrypoint: "AgentApi" } },
          { name: "CODEMODE", durableObjectNamespace: { className: "GitFoundryCodeMode" } },
          { name: "LOADER", workerLoader: { id: "p0-loader" } }
        ]
      }
    }
  ];
}

function runtimeConfig(services) {
  return { sockets: runtimeSockets(), services };
}

function makeMcpClient(remoteBase) {
  return (tenant, authorization, body) => jsonFetch(`${remoteBase}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, authorization, "x-gitfoundry-tenant-id": tenant },
    body: JSON.stringify(body)
  });
}

async function runActualRuntime(runtime, fixture, apiBundle, schema, jwtFixture) {
  const codeModeStorage = fs.mkdtempSync(path.join(os.tmpdir(), "gitfoundry-p0-runtime-codemode-"));
  const d1Storage = fs.mkdtempSync(path.join(os.tmpdir(), "gitfoundry-p0-runtime-d1-"));
  const shared = { codeModeStorage, d1Storage, apiBundle, schema, jwtFixture };
  const authHeaderA = `Bearer ${jwtFixture.tokens.tenantA}`;
  const authHeaderB = `Bearer ${jwtFixture.tokens.tenantB}`;
  const wrongMarkerHeader = `Bearer ${jwtFixture.tokens.wrongMarker}`;
  const revokedHeader = `Bearer ${jwtFixture.tokens.revokedPrincipal}`;

  const result = await withWorkerd(runtime, runtimeConfig(await runtimeServices(runtime, shared)), async (ports) => {
    const remoteBase = `http://127.0.0.1:${ports.remote}`;
    const seedBase = `http://127.0.0.1:${ports.seed}`;
    const probeBase = `http://127.0.0.1:${ports.probe}`;
    const seed = await jsonFetch(`${seedBase}/seed`, { method: "POST" });
    const mcp = makeMcpClient(remoteBase);
    const direct = (body) => jsonFetch(`${remoteBase}/mcp/tools`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });
    const startup = await jsonFetch(`${remoteBase}/`);
    const directInitialize = await direct(fixture.initialize);
    const directTools = await direct(fixture.tools_list);
    const authorizedInitialize = await mcp("tenant-a", authHeaderA, fixture.initialize);
    const authorizedTools = await mcp("tenant-a", authHeaderA, fixture.tools_list);
    const bridgeExecute = await mcp("tenant-a", authHeaderA, { jsonrpc: "2.0", id: 201, method: "tools/call", params: { name: "codemode_execute", arguments: { code: codeModeBridgeProgram() } } });
    const bridgeExecutionId = findExecutionId(toolResultPayload(bridgeExecute.json));
    const bridgeRead = bridgeExecutionId ? await driveCodeModeExecution(mcp, "tenant-a", authHeaderA, bridgeExecutionId, 202) : null;
    const bridgeShape = bridgeIssueShape(codeModeExecutionSummary(bridgeRead));
    const bridgeIssue = bridgeShape.versionCommit ? await nativeFixture.readStateRecord(bridgeShape.versionCommit, "issues/code-mode-runtime.json") : null;
    const beforeSubstitution = nativeFixture.requestCount;
    const tenantSubstitutionExecute = await mcp("tenant-a", authHeaderA, { jsonrpc: "2.0", id: 221, method: "tools/call", params: { name: "codemode_execute", arguments: { code: codeModeTenantSubstitutionProgram() } } });
    const tenantSubstitutionExecutionId = findExecutionId(toolResultPayload(tenantSubstitutionExecute.json));
    const tenantSubstitutionRead = tenantSubstitutionExecutionId ? await driveCodeModeExecution(mcp, "tenant-a", authHeaderA, tenantSubstitutionExecutionId, 222) : null;
    const tenantSubstitutionIssue = { gitRequests: nativeFixture.requestCount - beforeSubstitution };
    const authorizedInitializeB = await mcp("tenant-b", authHeaderB, fixture.initialize);
    const wrongMarkerIdentity = await jsonFetch(`${probeBase}/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant: "tenant-a", authorization: wrongMarkerHeader }) });
    const revokedIdentity = await jsonFetch(`${probeBase}/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant: "tenant-a-revoked", authorization: revokedHeader }) });
    const revokedPrincipal = await mcp("tenant-a-revoked", revokedHeader, fixture.initialize);
    const execute = await mcp("tenant-a", authHeaderA, { jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "codemode_execute", arguments: { code: "await new Promise(() => {})" } } });
    const executionId = findExecutionId(toolResultPayload(execute.json));
    const readA = executionId ? await mcp("tenant-a", authHeaderA, { jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "codemode_execution", arguments: { id: executionId } } }) : null;
    const readAReplay = executionId ? await mcp("tenant-a", authHeaderA, { jsonrpc: "2.0", id: 105, method: "tools/call", params: { name: "codemode_execution", arguments: { id: executionId } } }) : null;
    const readB = executionId ? await mcp("tenant-b", authHeaderB, { jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "codemode_execution", arguments: { id: executionId } } }) : null;
    const cancelA = executionId ? await mcp("tenant-a", authHeaderA, { jsonrpc: "2.0", id: 104, method: "tools/call", params: { name: "codemode_cancel", arguments: { id: executionId } } }) : null;
    const afterCancelA = executionId ? await mcp("tenant-a", authHeaderA, { jsonrpc: "2.0", id: 106, method: "tools/call", params: { name: "codemode_execution", arguments: { id: executionId } } }) : null;
    const removeGrant = await jsonFetch(`${seedBase}/remove-grant-b`, { method: "POST" });
    const removedGrantIdentity = await jsonFetch(`${probeBase}/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant: "tenant-b", authorization: authHeaderB }) });
    const removedGrant = await mcp("tenant-b", authHeaderB, fixture.initialize);
    return { seed, startup, directInitialize, directTools, authorizedInitialize, authorizedTools, bridgeExecute, bridgeExecutionId, bridgeRead, bridgeIssue, tenantSubstitutionExecute, tenantSubstitutionExecutionId, tenantSubstitutionRead, tenantSubstitutionIssue, authorizedInitializeB, wrongMarkerIdentity, revokedIdentity, revokedPrincipal, execute, executionId, readA, readAReplay, readB, cancelA, afterCancelA, removeGrant, removedGrantIdentity, removedGrant };
  });

  const restart = await withWorkerd(runtime, runtimeConfig(await runtimeServices(runtime, shared)), async (ports) => {
    const remoteBase = `http://127.0.0.1:${ports.remote}`;
    const probeBase = `http://127.0.0.1:${ports.probe}`;
    const mcp = makeMcpClient(remoteBase);
    const restartedReadA = result.executionId ? await mcp("tenant-a", authHeaderA, { jsonrpc: "2.0", id: 301, method: "tools/call", params: { name: "codemode_execution", arguments: { id: result.executionId } } }) : null;
    const deactivation = await jsonFetch(`${probeBase}/deactivate-between-identity-and-invoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorization: authHeaderA }) });
    return { restartedReadA, deactivation };
  });

  assertRuntime("actual D1 fixture seeded through workerd D1", result.seed.status === 200 && result.seed.json?.ok === true, responseSummary(result.seed));
  assertRuntime("actual Rust/WASM worker starts under workerd", result.startup.status === 404 && result.startup.text === "Not found", responseSummary(result.startup));
  assertRuntime("actual Rust/WASM MCP direct initialize", result.directInitialize.status === 200 && Boolean(result.directInitialize.json?.result), responseSummary(result.directInitialize));
  const directTools = result.directTools.json?.result?.tools ?? [];
  const expectedToolNames = sourceMcpToolNames();
  const directToolComparison = compareToolNames(directTools, expectedToolNames);
  assertRuntime("actual Rust/WASM MCP direct tools/list matches source catalog", result.directTools.status === 200 && directToolComparison.missing.length === 0 && directToolComparison.extra.length === 0, { toolCount: directTools.length, expectedToolCount: expectedToolNames.length, missing: directToolComparison.missing.slice(0, 5), extra: directToolComparison.extra.slice(0, 5) });
  const authedTools = result.authorizedTools.json?.result?.tools ?? [];
  assertRuntime("authorized MCP initializes through actual API identity", result.authorizedInitialize.status === 200 && Boolean(result.authorizedInitialize.json?.result), responseSummary(result.authorizedInitialize));
  assertRuntime("authorized MCP exposes Incurs Code Mode tools", result.authorizedTools.status === 200 && ["codemode_execute", "codemode_execution", "codemode_cancel"].every((name) => authedTools.some((tool) => tool.name === name)), { toolCount: authedTools.length });
  const bridgeSummary = codeModeExecutionSummary(result.bridgeRead);
  const bridgeShape = bridgeIssueShape(bridgeSummary);
  assertRuntime("Code Mode commits and reads exact collaboration records through the forge", result.bridgeExecute.status === 200 && typeof result.bridgeExecutionId === "string" && result.bridgeRead?.status === 200 && bridgeSummary.id === result.bridgeExecutionId && ["completed", "complete", "succeeded"].includes(String(bridgeSummary.status ?? "").toLowerCase()) && !bridgeSummary.error && bridgeShape.titleMatches && bridgeShape.tenantMatches && bridgeShape.repositoryMatches && bridgeShape.exactRecordRead, { execute: codeModeExecutionSummary(result.bridgeExecute), completed: bridgeSummary, bridge: bridgeShape });
  assertRuntime("Code Mode collaboration record persists in actual native Git", result.bridgeIssue?.id === "code-mode-runtime" && result.bridgeIssue?.title === BRIDGE_ISSUE_TITLE && result.bridgeIssue?.status === "open", { record: result.bridgeIssue, version: bridgeShape.versionCommit });
  const tenantSubstitutionSummary = codeModeExecutionSummary(result.tenantSubstitutionRead);
  assertRuntime("Code Mode bridge denies source tenant substitution with zero writes", result.tenantSubstitutionExecute.status === 200 && typeof result.tenantSubstitutionExecutionId === "string" && result.tenantSubstitutionRead?.status === 200 && tenantSubstitutionSummary.id === result.tenantSubstitutionExecutionId && ["completed", "complete", "succeeded"].includes(String(tenantSubstitutionSummary.status ?? "").toLowerCase()) && tenantSubstitutionDenied(tenantSubstitutionSummary) && result.tenantSubstitutionIssue.gitRequests === 0, { execute: codeModeExecutionSummary(result.tenantSubstitutionExecute), completed: tenantSubstitutionSummary, gitRequests: result.tenantSubstitutionIssue.gitRequests });
  assertRuntime("tenant B admission succeeds before grant removal", result.authorizedInitializeB.status === 200 && Boolean(result.authorizedInitializeB.json?.result), responseSummary(result.authorizedInitializeB));
  assertRuntime("an unknown sign-in is denied by actual API identity", result.wrongMarkerIdentity?.status === 401 && result.wrongMarkerIdentity?.json?.error === "gfy_auth_invalid", { identity: responseSummary(result.wrongMarkerIdentity) });
  assertRuntime("revoked principal is denied by typed actual API identity", typedAuthorizationDenial(result.revokedIdentity), { identity: responseSummary(result.revokedIdentity), remote: responseSummary(result.revokedPrincipal) });
  assertRuntime("Code Mode execute creates a running persisted execution", result.execute.status === 200 && typeof result.executionId === "string" && executionHasState(result.execute, result.executionId, ["running"]), { status: result.execute.status, execution: codeModeExecutionSummary(result.execute) });
  assertRuntime("Code Mode execution read reconnects by id", result.readA?.status === 200 && executionHasState(result.readA, result.executionId, ["running"]), { status: result.readA?.status, execution: codeModeExecutionSummary(result.readA) });
  assertRuntime("Code Mode same-runtime duplicate execution read replays by id", result.readAReplay?.status === 200 && executionHasState(result.readAReplay, result.executionId, ["running"]), { status: result.readAReplay?.status, execution: codeModeExecutionSummary(result.readAReplay) });
  const crossTenant = codeModeExecutionSummary(result.readB);
  assertRuntime("cross-tenant Code Mode partition rejects foreign execution", result.readB?.status === 200 && crossTenant.error && /not found|not owned|forbidden|missing/i.test(crossTenant.error), { status: result.readB?.status, execution: crossTenant });
  const cancelSummary = codeModeExecutionSummary(result.cancelA);
  const afterCancelSummary = codeModeExecutionSummary(result.afterCancelA);
  assertRuntime("Code Mode cancel reaches actual runtime", result.cancelA?.status === 200 && cancelSummary.id === result.executionId && ["cancelled", "canceled"].includes(String(cancelSummary.status ?? "").toLowerCase()), { status: result.cancelA?.status, execution: cancelSummary });
  assertRuntime("Code Mode execution state is cancelled after cancel", result.afterCancelA?.status === 200 && afterCancelSummary.id === result.executionId && ["cancelled", "canceled"].includes(String(afterCancelSummary.status ?? "").toLowerCase()), { status: result.afterCancelA?.status, execution: afterCancelSummary });
  const restartedSummary = codeModeExecutionSummary(restart.restartedReadA);
  assertRuntime("Code Mode execution reconnects after workerd restart with same SQL disk", restart.restartedReadA?.status === 200 && restartedSummary.id === result.executionId && ["cancelled", "canceled"].includes(String(restartedSummary.status ?? "").toLowerCase()), { status: restart.restartedReadA?.status, execution: restartedSummary });
  assertRuntime("grant removal after prior admission is denied by typed actual API identity", result.removeGrant.status === 200 && typedAuthorizationDenial(result.removedGrantIdentity), { admitted: responseSummary(result.authorizedInitializeB), removeGrant: responseSummary(result.removeGrant), identity: responseSummary(result.removedGrantIdentity), remote: responseSummary(result.removedGrant) });
  const deactivationInvoke = restart.deactivation.json?.invoke;
  const deactivationIssueCount = Number(restart.deactivation.json?.issueCount?.json?.count ?? -1);
  if (deactivationInvoke?.status === 403 && deactivationIssueCount === 0) {
    note("directory member deactivation blocks implemented invoke after identity", { identityStatus: restart.deactivation.json?.identity?.status, invokeStatus: deactivationInvoke.status, invokeError: deactivationInvoke.json?.error, issueCount: deactivationIssueCount });
  } else {
    block("directory member deactivation blocks implemented invoke after identity", { actual: restart.deactivation.json, issueCount: deactivationIssueCount, reason: "expected 403 and zero matching issue rows after directory_members.active was cleared" });
  }
  const secretNeedles = { jwt: jwtFixture.tokens.tenantA, authorization: "Authorization", bearer: "Bearer " };
  const rawSecretHits = scanDirectoryForNeedles(codeModeStorage, secretNeedles);
  const sqlEvidence = inspectCodeModeSqlStorage(codeModeStorage, secretNeedles);
  assertRuntime("Code Mode SQL has persisted execution/event rows without JWT or Authorization", sqlEvidence.sqliteFileCount > 0 && (sqlEvidence.executionRows > 0 || sqlEvidence.eventRows > 0) && rawSecretHits.length === 0 && sqlEvidence.secretHits.length === 0, { codeModeStorage, sqliteFileCount: sqlEvidence.sqliteFileCount, executionRows: sqlEvidence.executionRows, eventRows: sqlEvidence.eventRows, tables: sqlEvidence.tableInfo, rawHits: rawSecretHits, sqlHits: sqlEvidence.secretHits });
  return { ...result, restart };
}

async function main() {
  const schema = validateCanonicalD1Fixture();
  const mcpFixture = validateMcpFixtureShape();
  const runtime = await loadRuntime();
  nativeFixture = await createNativeForgeFixture(ROOT);
  try {
  const apiBundle = await bundleActualApiSource();
  const jwtFixture = makeJwtFixture();
  await probeActualApi(runtime, apiBundle);
  await runActualRuntime(runtime, mcpFixture, apiBundle, schema, jwtFixture);
  const summary = { ok: results.every((result) => result.ok), acceptance: !DIAGNOSTIC, diagnostic: DIAGNOSTIC, checkedAt: new Date().toISOString(), results, blockers };
  console.log(JSON.stringify(summary, null, 2));
  if (!DIAGNOSTIC && blockers.length > 0) process.exitCode = 1;
  if (!summary.ok && !DIAGNOSTIC) process.exitCode = 1;
  } finally { await nativeFixture.close(); }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, acceptance: !DIAGNOSTIC, diagnostic: DIAGNOSTIC, error: error instanceof Error ? error.message : String(error), results, blockers }, null, 2));
  process.exit(1);
});
