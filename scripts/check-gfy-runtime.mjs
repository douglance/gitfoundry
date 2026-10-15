#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { NativeGfyMcpClient, toolPayload, unwrapToolValue } from "../tests/runtime/gfy-runtime/native-mcp-client.mjs";
import { activeForgeToolNames, createNativeForgeFixture } from "../tests/runtime/forge-native-fixture.mjs";
import { exerciseResourceEventStream } from "../tests/runtime/gfy-runtime/resource-events.mjs";
import { exerciseNativeCli } from "../tests/runtime/gfy-runtime/native-cli.mjs";
let nativeFixture;

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const RUNTIME_ROOT = path.join(ROOT, "node_modules/.pnpm/node_modules/@alchemy.run/cloudflare-runtime");
const EFFECT_ROOT = path.join(ROOT, "node_modules/.pnpm/effect@4.0.2/node_modules/effect/dist");
const NODE_SERVICES = path.join(ROOT, "node_modules/.pnpm/@effect+platform-node@4.0.2_effect@4.0.2_redis@6.3.0/node_modules/@effect/platform-node/dist/NodeServices.js");
const DEFAULT_GFY = path.join(ROOT, "target/release/gfy");
const GFY_BINARY = process.env.GFY_BINARY ? path.resolve(process.env.GFY_BINARY) : DEFAULT_GFY;
const ISSUER = "https://issuer.p1-gfy-runtime.local";
const AUDIENCE = "gitfoundry-gfy-runtime-harness";
const DATABASE_ID = "gitfoundry-p1-gfy-runtime";
const NOW = new Date("2026-10-08T00:00:00.000Z");
const ISSUE_TITLE = "native gfy runtime issue";
const ISSUE_IDEMPOTENCY_KEY = "p1-native-gfy-runtime-issue-create";
const QUALIFIED_ACCOUNT = "gitfoundry-runtime-account";
const CLAIMS = {
  providerAccount: "gfy_provider_account_id",
  connectionMarker: "gfy_connection_id",
  stableSubject: "gfy_stable_subject"
};

const results = [];

function rel(file) { return path.relative(ROOT, file); }
function readJson(relativePath) { return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8")); }
function importModule(absPath) { return import(pathToFileURL(absPath).href); }
function note(name, detail = {}) { results.push({ name, ok: true, ...detail }); if (process.env.GFY_RUNTIME_PROGRESS === "1") console.log(JSON.stringify({ event: "runtime_assertion", name })); }
function fail(name, detail = {}) { results.push({ name, ok: false, ...detail }); throw new Error(`${name}: ${JSON.stringify(detail)}`); }
function assertRuntime(name, condition, detail = {}) { if (!condition) fail(name, detail); note(name, detail); }
function base64UrlJson(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

async function loadRuntime() {
  const files = {
    gfy: GFY_BINARY,
    effect: path.join(EFFECT_ROOT, "Effect.js"),
    layer: path.join(EFFECT_ROOT, "Layer.js"),
    nodeServices: NODE_SERVICES,
    workerd: path.join(RUNTIME_ROOT, "dist/core/node/workerd/Workerd.mjs"),
    internalModules: path.join(RUNTIME_ROOT, "dist/core/node/internal/internal-modules.mjs"),
    internalWorker: path.join(RUNTIME_ROOT, "dist/core/node/internal/internal-worker.mjs"),
    d1Options: path.join(RUNTIME_ROOT, "dist/core/node/bindings/d1/D1Options.shared.mjs"),
    packageJson: path.join(RUNTIME_ROOT, "package.json")
  };
  for (const [name, file] of Object.entries(files)) assertRuntime(`runtime artifact exists: ${name}`, fs.existsSync(file), { file: rel(file) });
  fs.accessSync(GFY_BINARY, fs.constants.X_OK);
  const [Effect, Layer, NodeServices, Workerd, internalModules, internalWorker, d1Options] = await Promise.all([
    importModule(files.effect), importModule(files.layer), importModule(files.nodeServices), importModule(files.workerd), importModule(files.internalModules), importModule(files.internalWorker), importModule(files.d1Options)
  ]);
  const pkg = JSON.parse(fs.readFileSync(files.packageJson, "utf8"));
  note("actual Cloudflare runtime imports", { package: "@alchemy.run/cloudflare-runtime", version: pkg.version });
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

async function bundleActualApiSource() {
  const rolldownPackage = path.join(ROOT, "node_modules/.pnpm/node_modules/rolldown/dist/index.mjs");
  assertRuntime("Rolldown API exists", fs.existsSync(rolldownPackage), { file: rel(rolldownPackage) });
  const { rolldown } = await importModule(rolldownPackage);
  const fixtureId = "\0native-forge-runtime";
  const bundle = await rolldown({ input: fixtureId, plugins: [{ name: "native-forge-fixture", resolveId: id => id === fixtureId ? fixtureId : null, load: id => id === fixtureId ? nativeFixture.apiModuleSource() : null }], external: ["cloudflare:workers"], treeshake: false });
  const output = await bundle.generate({ format: "es", codeSplitting: false, sourcemap: false });
  const chunk = output.output.find((item) => item.type === "chunk");
  if (!chunk) fail("actual API source bundle emitted chunk", { output: output.output.map((item) => item.type) });
  note("actual API Worker source bundled", { bytes: chunk.code.length });
  return { code: chunk.code };
}

// Each principal signs in the way gfy login does; the seeder stores only the token hashes.
function makeJwtFixture() {
  const session = () => "gfys_" + crypto.randomBytes(32).toString("base64url");
  const tokens = { tenantA: session(), tenantAWriter: session(), tenantB: session(), revoked: session() };
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const hashes = { "principal-a": digest(tokens.tenantA), "principal-a-writer": digest(tokens.tenantAWriter), "principal-b": digest(tokens.tenantB), "principal-revoked": digest(tokens.revoked) };
  note("offline session fixture", { tokenTransport: "0600 credential file" });
  return { publicJwk: {}, tokens, hashes };
}

function writeCredentialFile(tempDir, label, token) {
  const file = path.join(tempDir, `${label}.jwt`);
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const mode = fs.statSync(file).mode & 0o777;
  assertRuntime(`credential file mode 0600: ${label}`, mode === 0o600, { file: rel(file), mode: mode.toString(8) });
  return file;
}

function textBinding(name, text) { return { name, text }; }
function d1Binding(name) { return { name, wrapped: { moduleName: "cloudflare-internal:d1-api", innerBindings: [{ name: "fetcher", service: { name: "d1", props: { json: JSON.stringify({ databaseId: DATABASE_ID }) } } }] } }; }

async function d1Services(runtime, storagePath) {
  const { BINDING_D1_OBJECT, D1_OBJECT_CLASS_NAME, SERVICE_D1, SERVICE_D1_STORAGE } = runtime.d1Options;
  const worker = await runtime.loadInternalWorker("#cloudflare-runtime-core-worker/bindings/d1/D1.worker");
  return [
    { name: SERVICE_D1_STORAGE, disk: { path: storagePath, writable: true } },
    { name: SERVICE_D1, worker: { compatibilityDate: "2026-03-10", modules: runtime.formatInternalWorkerModules(worker), durableObjectNamespaces: [{ className: D1_OBJECT_CLASS_NAME, enableSql: true, uniqueKey: `cloudflare-runtime-${D1_OBJECT_CLASS_NAME}`, preventEviction: true }], durableObjectStorage: { localDisk: SERVICE_D1_STORAGE }, bindings: [{ name: BINDING_D1_OBJECT, durableObjectNamespace: { className: D1_OBJECT_CLASS_NAME } }] } }
  ];
}

function jwksWorkerSource(publicJwk) {
  return `const jwks = ${JSON.stringify({ keys: [publicJwk] })};\nexport default { fetch() { return Response.json(jwks, { headers: { \"cache-control\": \"no-store\" } }); } };`;
}

function seederWorkerSource(schema, sessionHashes) {
  const qualification = {
    identity_qualified: true,
    provider_account_claim: CLAIMS.providerAccount,
    provider_account_id: QUALIFIED_ACCOUNT,
    connection_marker_claim: CLAIMS.connectionMarker,
    immutable_subject_claim: CLAIMS.stableSubject,
    max_subject_bytes: 512
  };
  return `
const schema = ${JSON.stringify(schema)};
const sessionHashes = ${JSON.stringify(sessionHashes)};
const now = ${JSON.stringify(NOW.toISOString())};
const qualification = ${JSON.stringify(qualification)};
const allCapabilities = ["identity.read","repository.read","repository.write","review.write","forge.initialize","forge.read","forge.fork","forge.commit","forge.compare","forge.merge","forge.publish","forge.recover"];
function schemaStatements() {
  return schema.split(String.fromCharCode(10)).map((line) => line.replace(/--.*$/, "")).join(" ").split(";").map((statement) => statement.trim()).filter((statement) => statement && !statement.startsWith("CREATE TRIGGER") && statement !== "END");
}
async function run(env, sql, ...values) { return await env.DB.prepare(sql).bind(...values).run(); }
async function installSchema(env) { for (const statement of schemaStatements()) await env.DB.exec(statement); }
async function insertPrincipal(env, tenant, principal, subject, grant, activePrincipal, existingConnection) {
  await run(env, "INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)", tenant, principal, 1, now, now, "human", principal, activePrincipal ? 1 : 0, 1);
  await run(env, "INSERT INTO roles VALUES(?,?,?,?,?,?,?)", tenant, "role-" + principal, 1, now, now, existingConnection ? "runtime-role-" + principal : "runtime-role", JSON.stringify(allCapabilities));
  await run(env, "INSERT INTO owner_access_grants(tenant_id,id,principal_id,resource_kind,resource_id,role_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)", tenant, grant, principal, "tenant", tenant, "role-" + principal, "2999-01-01T00:00:00.000Z", now);
  await run(env, "INSERT INTO auth_browser_sessions(token_hash,email,tenant_id,principal_id,created_at,expires_at) VALUES(?,?,?,?,?,?)", sessionHashes[principal], principal + "@example.invalid", tenant, principal, now, "2999-01-01T00:00:00.000Z");
}
async function insertTenant(env, tenant, principal, subject, grant, activePrincipal) {
  await run(env, "INSERT INTO tenants VALUES(?,?,?,?,?,?,?)", tenant, tenant, "active", 1, tenant.replace("tenant", "shard"), "US", "{}");
  await insertPrincipal(env, tenant, principal, subject, grant, activePrincipal);
  await run(env, "INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)", tenant, "namespace-" + tenant, 1, now, now, "namespace-" + tenant, "Namespace " + tenant);
  await run(env, "INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", tenant, "repo-" + tenant, 1, now, now, "namespace-" + tenant, "demo", "private", "main", 0, tenant, "repo-" + tenant, null);
}
async function issueByTitle(env, tenant, repository, title) {
  const result = await env.DB.prepare("SELECT COUNT(*) AS count, MIN(id) AS id, MIN(title) AS title, MIN(repository_id) AS repository_id, MIN(author_id) AS author_id FROM issues WHERE tenant_id = ? AND repository_id = ? AND title = ? AND kind = 'issue'").bind(tenant, repository, title).all();
  const row = result.results?.[0] ?? {};
  return { count: Number(row.count ?? 0), id: row.id ?? null, title: row.title ?? null, repository_id: row.repository_id ?? null, author_id: row.author_id ?? null };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/seed") {
      await installSchema(env);
      await insertTenant(env, "tenant-a", "principal-a", "subject-a", "grant-a", true);
      await insertPrincipal(env, "tenant-a", "principal-a-writer", "subject-a-writer", "grant-a-writer", true, "conn-principal-a");
      await insertTenant(env, "tenant-b", "principal-b", "subject-b", "grant-b", true);
      await insertTenant(env, "tenant-a-revoked", "principal-revoked", "subject-revoked", "grant-revoked", false);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/repository-by-name") {
      const row = await env.DB.prepare("SELECT COUNT(*) AS count, MIN(id) AS id, MIN(namespace_id) AS namespace_id, MIN(default_branch) AS default_branch FROM repositories WHERE tenant_id = ? AND name = ?").bind(url.searchParams.get("tenant"), url.searchParams.get("name")).first();
      return Response.json({ ok: true, ...row });
    }
    if (url.pathname === "/event-rows") {
      const result = await env.DB.prepare("SELECT cursor,source_event_id,authoritative_revision FROM resource_events WHERE tenant_id = ? AND repository_id = ? ORDER BY id").bind(url.searchParams.get("tenant"), url.searchParams.get("repository")).all();
      return Response.json({ rows: result.results ?? [] });
    }
    if (url.pathname === "/deactivate-stream-principal" && request.method === "POST") {
      const result = await env.DB.prepare("UPDATE principals SET active = 0 WHERE tenant_id = ? AND id = ?").bind("tenant-a", "principal-a").run();
      return Response.json({ changed: Number(result.meta?.changes ?? 0) });
    }
    if (url.pathname === "/issue-by-title") return Response.json({ ok: true, ...(await issueByTitle(env, url.searchParams.get("tenant"), url.searchParams.get("repository"), url.searchParams.get("title"))) });
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
};`;
}

function apiWorkerService(apiBundle, name = "api") {
  return {
    name,
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

async function runtimeServices(runtime, { d1Storage, apiBundle, schema, jwtFixture }) {
  return [
    ...(await d1Services(runtime, d1Storage)),
    nativeFixture.service,
    { name: "jwks", worker: { compatibilityDate: "2026-03-10", modules: [{ name: "index.js", esModule: jwksWorkerSource(jwtFixture.publicJwk) }] } },
    { name: "seeder", worker: { compatibilityDate: "2026-03-10", modules: [{ name: "index.js", esModule: seederWorkerSource(schema, jwtFixture.hashes) }], bindings: [d1Binding("DB")] } },
    apiWorkerService(apiBundle),
    apiWorkerService(apiBundle, "api-peer")
  ];
}

function runtimeConfig(services) {
  return { sockets: [{ name: "api", address: "127.0.0.1:0", service: { name: "api" } }, { name: "seed", address: "127.0.0.1:0", service: { name: "seeder" } }, { name: "apiPeer", address: "127.0.0.1:0", service: { name: "api-peer" } }], services };
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, text: text.slice(0, 500), json };
}

function expectedToolNames() { return activeForgeToolNames; }
function toolNameComparison(actualTools, expectedNames) {
  const actualNames = actualTools.map((tool) => tool.name).sort();
  const expected = new Set(expectedNames);
  const actual = new Set(actualNames);
  return { actualNames, missing: expectedNames.filter((name) => !actual.has(name)), extra: actualNames.filter((name) => !expected.has(name)) };
}
function extractTools(payload) { return unwrapToolValue(payload)?.tools ?? payload?.tools ?? []; }
function firstArray(value, names) { for (const name of names) if (Array.isArray(value?.[name])) return value[name]; return []; }
function denied(response) { const text = JSON.stringify(response).toLowerCase(); return /unauthorized|permission|denied|403|gfy_permission_denied|qualified identity|inactive/.test(text); }
function issueShape(value) { return unwrapToolValue(value?.issue ?? value); }

function gfyEnv(apiBase, tenantId, credentialFile) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NO_COLOR: "1",
    GFY_API_BASE_URL: apiBase,
    GFY_TENANT_ID: tenantId,
    GFY_SESSION_FILE: credentialFile
  };
}

async function withClient(options, callback) {
  const client = NativeGfyMcpClient.start(options);
  try { return await callback(client); }
  finally { await client.close(); }
}

async function exerciseNativeGfy(apiBase, seedBase, credentialFiles) {
  const expectedNames = expectedToolNames();
  return withClient({ binary: GFY_BINARY, cwd: ROOT, env: gfyEnv(apiBase, "tenant-a", credentialFiles.tenantA) }, async (client) => {
    const initialized = await client.initialize();
    const progressive = await client.listTools();
    const progressiveNames = (progressive.result?.tools ?? []).map((tool) => tool.name).sort();
    assertRuntime("actual gfy stdio MCP initializes", initialized.result?.protocolVersion === "2025-11-25", { protocolVersion: initialized.result?.protocolVersion });
    assertRuntime("actual gfy stdio MCP exposes progressive Incurs client", ["call_read_tool", "call_write_tool", "search_tools"].every((name) => progressiveNames.includes(name)), { tools: progressiveNames });

    const searchedPayload = toolPayload(await client.callTool("search_tools", { query: "", limit: 250 }));
    const discovered = extractTools(searchedPayload);
    const comparison = toolNameComparison(discovered, expectedNames);
    assertRuntime("native gfy exposes only the fork-first operation contract", discovered.length === 15 && expectedNames.length === 15 && comparison.missing.length === 0 && comparison.extra.length === 0, { discovered: discovered.length, expected: expectedNames.length, missing: comparison.missing.slice(0, 5), extra: comparison.extra.slice(0, 5) });

    const whoami = unwrapToolValue(toolPayload(await client.callTool("call_read_tool", { name: "gfy_auth_whoami", arguments: {} })));
    assertRuntime("native gfy auth.whoami reaches actual API Worker identity", whoami?.tenant_id === "tenant-a" && whoami?.principal_id === "principal-a" && Array.isArray(whoami?.scopes) && whoami.scopes.includes("repository.write"), { tenant_id: whoami?.tenant_id, principal_id: whoami?.principal_id, scopeCount: whoami?.scopes?.length });

    const invoked = new Set(["gfy_auth_whoami"]);
    const scope = { tenant_id: "tenant-a", repository_id: "repo-tenant-a" };
    const call = async (name, arguments_, write = false) => {
      const response = await client.callTool(write ? "call_write_tool" : "call_read_tool", { name, arguments: arguments_ });
      assertRuntime("native MCP operation succeeds: " + name, !response.error && response.result?.isError !== true, { operation: name });
      invoked.add(name);
      return unwrapToolValue(toolPayload(response));
    };
    const version = value => unwrapToolValue(value?.version ?? value);

    const created = unwrapToolValue(await call("gfy_repo_create", { tenant_id: "tenant-a", idempotency_key: "native-runtime-repository-create", input: { namespace_id: "namespace-tenant-a", name: "native-created", default_branch: "code", visibility: "private" } }, true));
    const createdRepository = created.repository ?? created;
    assertRuntime("native MCP creates a repository through actual Git provisioning", createdRepository.name === "native-created" && createdRepository.default_branch === "code" && createdRepository.tenant_id === "tenant-a", { id: createdRepository.id });
    const storedRepository = await jsonFetch(seedBase + "/repository-by-name?tenant=tenant-a&name=native-created");
    assertRuntime("repository creation persists one exact D1 record", storedRepository.status === 200 && storedRepository.json?.count === 1 && storedRepository.json?.id === createdRepository.id && storedRepository.json?.namespace_id === "namespace-tenant-a" && storedRepository.json?.default_branch === "code", { row: storedRepository.json });
    const inspectedRepository = await nativeFixture.inspectRepository("tenant-a", createdRepository.id);
    assertRuntime("repository provisioning creates a real bare Git repository with the requested HEAD", inspectedRepository.bare && inspectedRepository.head === "refs/heads/code", inspectedRepository);
    const repositories = await call("gfy_repo_list", { tenant_id: "tenant-a" });
    const repositoryRows = Array.isArray(repositories) ? repositories : firstArray(repositories, ["items", "repositories"]);
    assertRuntime("native MCP lists both seeded and newly persisted repositories", repositoryRows.some(row => row.id === "repo-tenant-a") && repositoryRows.some(row => row.id === createdRepository.id), { count: repositoryRows.length });
    const viewedRepository = await call("gfy_repo_view", { tenant_id: "tenant-a", id: createdRepository.id });
    assertRuntime("native MCP views the exact newly created repository", (viewedRepository.repository ?? viewedRepository).id === createdRepository.id && (viewedRepository.repository ?? viewedRepository).name === "native-created", { id: (viewedRepository.repository ?? viewedRepository).id });
    const policy = { schema_version: 1, evaluator_digest: "runtime-transport-fixture", checks: [], reviews: { required_approvals: 0, trusted_reviewer_ids: ["principal-a"], actor_kinds: ["human"], key_ids: ["fixture-review-key"] } };
    const initializedForge = version(await call("gfy_forge_initialize", { ...scope, operation_id: "native-runtime-initialize", initial_code: [{ path: "README.md", content_base64: Buffer.from("Runtime fixture\n").toString("base64") }], initial_state: [{ path: "config/publication.json", content_base64: Buffer.from(JSON.stringify(policy)).toString("base64") }] }, true));
    assertRuntime("native MCP initializes a descriptor in actual Git", /^[0-9a-f]{40}$/.test(initializedForge.version_commit), { version: initializedForge.version_commit });
    const issue = { schema_version: 1, id: "native-runtime", title: ISSUE_TITLE, status: "open" };
    const committed = version(await call("gfy_forge_commit", { ...scope, operation_id: ISSUE_IDEMPOTENCY_KEY, parent_version: initializedForge.version_commit, changes: [{ tree: "state", path: "issues/native-runtime.json", content_base64: Buffer.from(JSON.stringify(issue)).toString("base64") }] }, true));
    assertRuntime("collaboration commit preserves exact code revision", committed.descriptor.code_commit === initializedForge.descriptor.code_commit && committed.version_commit !== initializedForge.version_commit, { version: committed.version_commit, code: committed.descriptor.code_commit });
    const readback = await call("gfy_forge_read", { ...scope, version: committed.version_commit, tree: "state", path: "issues/native-runtime.json" });
    assertRuntime("native MCP reads the exact committed issue document", readback.encoding === "base64" && JSON.parse(Buffer.from(readback.content, "base64").toString("utf8")).title === ISSUE_TITLE, { encoding: readback.encoding });
    const cliRead = await new Promise((resolveRead, rejectRead) => {
      const child = spawn(GFY_BINARY, ["forge", "read", "--repository-id", "repo-tenant-a", "--revision", committed.version_commit, "--tree", "state", "--path", "issues/native-runtime.json", "--format", "json"], { cwd: ROOT, env: gfyEnv(apiBase, "tenant-a", credentialFiles.tenantA), stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [], stderr = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.stdout.on("data", chunk => stdout.push(chunk));
      child.stderr.on("data", chunk => stderr.push(chunk));
      child.on("error", error => { clearTimeout(timer); rejectRead(error); });
      child.on("close", (code, signal) => { clearTimeout(timer); resolveRead({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
    });
    let cliFile = null;
    try { cliFile = unwrapToolValue(JSON.parse(cliRead.stdout)); } catch {}
    assertRuntime("compiled CLI reads the requested revision instead of printing its version", cliRead.code === 0 && !cliRead.signal && cliFile?.encoding === "base64" && JSON.parse(Buffer.from(cliFile.content, "base64").toString("utf8")).id === "native-runtime", { exitCode: cliRead.code, encoding: cliFile?.encoding, stderr: cliRead.stderr.slice(-300) });
    const cliCommit = await new Promise((resolveCommit, rejectCommit) => {
      const child = spawn(GFY_BINARY, ["forge", "commit", "--repository-id", "repo-tenant-a", "--parent-version", committed.version_commit, "--operation-id", "native-cli-structured-commit", "--changes", JSON.stringify([{ tree: "state", path: "coordination/native-cli.json", content_base64: Buffer.from(JSON.stringify({ id: "native-cli", objective: "CLI structured changes persist in Git" })).toString("base64") }]), "--format", "json"], { cwd: ROOT, env: gfyEnv(apiBase, "tenant-a", credentialFiles.tenantA), stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [], stderr = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.stdout.on("data", chunk => stdout.push(chunk));
      child.stderr.on("data", chunk => stderr.push(chunk));
      child.on("error", error => { clearTimeout(timer); rejectCommit(error); });
      child.on("close", (code, signal) => { clearTimeout(timer); resolveCommit({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
    });
    let cliCandidate = null;
    try { cliCandidate = version(unwrapToolValue(JSON.parse(cliCommit.stdout))); } catch {}
    assertRuntime("compiled CLI accepts structured file changes", cliCommit.code === 0 && !cliCommit.signal && cliCandidate?.descriptor?.code_commit === committed.descriptor.code_commit, { exitCode: cliCommit.code, stderr: cliCommit.stderr.slice(-300) });
    const cliRecord = await nativeFixture.readStateRecord(cliCandidate.version_commit, "coordination/native-cli.json");
    assertRuntime("compiled CLI commit persists its exact record in native Git", cliRecord.id === "native-cli" && cliRecord.objective === "CLI structured changes persist in Git", { version: cliCandidate.version_commit });
    const actualRecord = await nativeFixture.readStateRecord(committed.version_commit, "issues/native-runtime.json");
    assertRuntime("issue document persists in native Git independently of MCP responses", actualRecord.id === "native-runtime" && actualRecord.title === ISSUE_TITLE && actualRecord.status === "open", { record: actualRecord, gitRequests: nativeFixture.requestCount });
    const published = await call("gfy_forge_publish", { ...scope, operation_id: "native-runtime-publish", expected_head: initializedForge.version_commit, new_version: committed.version_commit }, true);
    assertRuntime("native MCP conditionally publishes the exact version", version(published)?.version_commit === committed.version_commit, { expected: committed.version_commit, actual: version(published)?.version_commit });
    const head = version(await call("gfy_forge_head", scope));
    assertRuntime("published head reads back from actual Git", head.version_commit === committed.version_commit, { expected: committed.version_commit, actual: head.version_commit });
    const stale = await client.callTool("call_write_tool", { name: "gfy_forge_publish", arguments: { ...scope, operation_id: "native-runtime-stale", expected_head: initializedForge.version_commit, new_version: committed.version_commit } });
    assertRuntime("stale expected head is rejected", stale.result?.isError === true && /stale|conflict|head.*changed/i.test(JSON.stringify(stale)), { response: stale });
    const afterStale = version(await call("gfy_forge_head", scope));
    assertRuntime("stale publication leaves the canonical head unchanged", afterStale.version_commit === committed.version_commit, { actual: afterStale.version_commit });

    const createdScope = { tenant_id: "tenant-a", repository_id: createdRepository.id };
    const createdForge = version(await call("gfy_forge_initialize", { ...createdScope, operation_id: "native-runtime-created-initialize", initial_code: [{ path: "README.md", content_base64: Buffer.from("Created through native MCP\n").toString("base64") }], initial_state: [{ path: "config/publication.json", content_base64: Buffer.from(JSON.stringify(policy)).toString("base64") }] }, true));
    const createdCode = await nativeFixture.readCodeFile(createdForge.version_commit, "README.md", "tenant-a", createdRepository.id);
    assertRuntime("newly provisioned repository supports a forge with independently read Git source", createdCode === "Created through native MCP\n", { version: createdForge.version_commit });

    const forked = version(await call("gfy_forge_fork", { ...scope, operation_id: "native-runtime-fork", parent_version: committed.version_commit }, true));
    assertRuntime("native MCP fork preserves exact roots and parent lineage", forked.descriptor.parents.length === 1 && forked.descriptor.parents[0] === committed.version_commit && forked.descriptor.code_commit === committed.descriptor.code_commit && forked.descriptor.state_commit === committed.descriptor.state_commit, { version: forked.version_commit });
    const viewedFork = version(await call("gfy_forge_view", { ...scope, version_commit: forked.version_commit }));
    assertRuntime("native MCP views the requested immutable fork descriptor", viewedFork.version_commit === forked.version_commit && viewedFork.descriptor.fork_id === "native-runtime-fork", { version: viewedFork.version_commit });
    const listedForks = await call("gfy_forge_list", scope);
    assertRuntime("native MCP lists retained fork versions from actual Git", listedForks.versions?.some(item => item.version_commit === forked.version_commit) && listedForks.versions?.some(item => item.version_commit === initializedForge.version_commit), { count: listedForks.versions?.length });

    const right = version(await call("gfy_forge_commit", { ...scope, operation_id: "native-runtime-right", parent_version: committed.version_commit, changes: [{ tree: "state", path: "coordination/right.json", content_base64: Buffer.from(JSON.stringify({ id: "right", body: "Independent right branch" })).toString("base64") }] }, true));
    const mergedResult = await call("gfy_forge_merge", { ...scope, operation_id: "native-runtime-merge", base_version: committed.version_commit, left_version: cliCandidate.version_commit, right_version: right.version_commit }, true);
    const merged = version(mergedResult);
    assertRuntime("native MCP merges divergent collaboration branches without changing source", mergedResult.status === "version" && merged.descriptor.code_commit === committed.descriptor.code_commit && merged.descriptor.parents[0] === cliCandidate.version_commit && merged.descriptor.parents[1] === right.version_commit, { version: merged.version_commit });
    const mergedLeft = await nativeFixture.readStateRecord(merged.version_commit, "coordination/native-cli.json");
    const mergedRight = await nativeFixture.readStateRecord(merged.version_commit, "coordination/right.json");
    assertRuntime("merged Git state independently retains both branch records", mergedLeft.objective === "CLI structured changes persist in Git" && mergedRight.body === "Independent right branch", { left: mergedLeft.id, right: mergedRight.id });
    const compared = await call("gfy_forge_compare", { ...scope, base_version: committed.version_commit, head_version: merged.version_commit });
    const comparedPaths = compared.state_changes?.map(item => item.path).sort();
    assertRuntime("native MCP comparison reports independently expected collaboration changes", compared.base_version === committed.version_commit && compared.head_version === merged.version_commit && compared.code_changes?.length === 0 && JSON.stringify(comparedPaths) === JSON.stringify(["coordination/native-cli.json", "coordination/right.json"]), { codeChanges: compared.code_changes?.length, statePaths: comparedPaths });

    const publishedMerge = version(await call("gfy_forge_publish", { ...scope, operation_id: "native-runtime-merge-publish", expected_head: committed.version_commit, new_version: merged.version_commit }, true));
    assertRuntime("native MCP publishes the merged descendant", publishedMerge.version_commit === merged.version_commit, { version: publishedMerge.version_commit });
    const recovered = await call("gfy_forge_recover", { ...scope, publication_operation_id: "native-runtime-merge-publish" }, true);
    assertRuntime("native MCP recovery reads the durable completed publication receipt", recovered.status === "published" && version(recovered).version_commit === merged.version_commit, { status: recovered.status });
    const recoveredHead = version(await call("gfy_forge_head", scope));
    assertRuntime("receipt recovery preserves the exact canonical Git head", recoveredHead.version_commit === merged.version_commit, { version: recoveredHead.version_commit });

    const replayedFork = version(await call("gfy_forge_fork", { ...scope, operation_id: "native-runtime-fork", parent_version: committed.version_commit }, true));
    assertRuntime("native MCP fork replay returns the same immutable version", replayedFork.version_commit === forked.version_commit, { version: replayedFork.version_commit });
    const changedReplay = await client.callTool("call_write_tool", { name: "gfy_forge_fork", arguments: { ...scope, operation_id: "native-runtime-fork", parent_version: merged.version_commit } });
    assertRuntime("native MCP rejects a reused operation ID with different input", changedReplay.result?.isError === true && /idempotency_conflict|HTTP_409/.test(JSON.stringify(changedReplay)), {});
    const unsafeRead = await client.callTool("call_read_tool", { name: "gfy_forge_read", arguments: { ...scope, version: merged.version_commit, tree: "code", path: "../README.md" } });
    assertRuntime("native MCP rejects path traversal", unsafeRead.result?.isError === true && /HTTP_400|path_invalid/.test(JSON.stringify(unsafeRead)), {});
    const absentReceipt = await client.callTool("call_write_tool", { name: "gfy_forge_recover", arguments: { ...scope, publication_operation_id: "native-runtime-no-such-publication" } });
    assertRuntime("native MCP recovery rejects an absent durable receipt", absentReceipt.result?.isError === true && /HTTP_404|not_found/.test(JSON.stringify(absentReceipt)), {});

    const conflictingBranches = [];
    for (const side of ["left", "right"]) {
      conflictingBranches.push(version(await call("gfy_forge_commit", { ...scope, operation_id: "native-runtime-conflict-" + side, parent_version: merged.version_commit, changes: [
        { tree: "code", path: "README.md", content_base64: Buffer.from("Conflicting " + side + " source\n").toString("base64") },
        { tree: "state", path: "issues/native-runtime.json", content_base64: Buffer.from(JSON.stringify({ ...issue, title: "Conflicting " + side + " issue" })).toString("base64") }
      ] }, true)));
    }
    const beforeConflict = await call("gfy_forge_list", scope);
    const conflictInput = { ...scope, operation_id: "native-runtime-conflicted-merge", base_version: merged.version_commit, left_version: conflictingBranches[0].version_commit, right_version: conflictingBranches[1].version_commit };
    const conflict = await call("gfy_forge_merge", conflictInput, true);
    const conflictPaths = conflict.conflicts?.map(item => item.tree + ":" + item.path).sort();
    assertRuntime("native MCP reports exact source and collaboration merge conflicts", conflict.status === "conflict" && JSON.stringify(conflictPaths) === JSON.stringify(["code:README.md", "state:issues/native-runtime.json"]), { paths: conflictPaths });
    const conflictReplay = await call("gfy_forge_merge", conflictInput, true);
    assertRuntime("conflicted merge replay returns the same durable conflict", JSON.stringify(conflictReplay) === JSON.stringify(conflict), {});
    const afterConflict = await call("gfy_forge_list", scope);
    const conflictHead = version(await call("gfy_forge_head", scope));
    assertRuntime("conflicted merge creates no candidate and leaves canonical Git head unchanged", afterConflict.versions.length === beforeConflict.versions.length && conflictHead.version_commit === merged.version_commit, { version: conflictHead.version_commit });
    for (const [index, side] of ["left", "right"].entries()) {
      const retainedSource = await nativeFixture.readCodeFile(conflictingBranches[index].version_commit, "README.md", "tenant-a", "repo-tenant-a");
      const retainedIssue = await nativeFixture.readStateRecord(conflictingBranches[index].version_commit, "issues/native-runtime.json");
      assertRuntime("conflicted merge preserves exact " + side + " branch contents in Git", retainedSource === "Conflicting " + side + " source\n" && retainedIssue.title === "Conflicting " + side + " issue", { side });
    }

    const operationCoverage = { discovered: comparison.actualNames, executed: [...invoked].sort(), missing: comparison.actualNames.filter(name => !invoked.has(name)) };
    assertRuntime("every discovered native MCP operation executes against the actual API and storage", operationCoverage.missing.length === 0 && operationCoverage.executed.length === operationCoverage.discovered.length, operationCoverage);
    return { versionCommit: merged.version_commit, createdRepositoryId: createdRepository.id, catalogCount: discovered.length, operationCoverage, gitBackend: "native-git-local-fixture" };

  });
}

async function exercisePopulatedTenantIsolation(apiBase, credentialFiles) {
  const marker = "Tenant B private source";
  return withClient({ binary: GFY_BINARY, cwd: ROOT, env: gfyEnv(apiBase, "tenant-b", credentialFiles.tenantB) }, async (tenantB) => {
    await tenantB.initialize();
    const scopeB = { tenant_id: "tenant-b", repository_id: "repo-tenant-b" };
    const initialized = await tenantB.callTool("call_write_tool", { name: "gfy_forge_initialize", arguments: { ...scopeB, operation_id: "native-runtime-tenant-b-initialize", initial_code: [{ path: "private.txt", content_base64: Buffer.from(marker).toString("base64") }] } });
    assertRuntime("second populated tenant initializes through authenticated native MCP", !initialized.error && initialized.result?.isError !== true, {});
    const versionB = unwrapToolValue(unwrapToolValue(toolPayload(initialized))?.version);
    assertRuntime("second tenant private contents persist independently in native Git", await nativeFixture.readCodeFile(versionB.version_commit, "private.txt", "tenant-b", "repo-tenant-b") === marker, { version: versionB.version_commit });
    const legitimate = unwrapToolValue(toolPayload(await tenantB.callTool("call_read_tool", { name: "gfy_forge_read", arguments: { ...scopeB, version: versionB.version_commit, tree: "code", path: "private.txt" } })));
    assertRuntime("second tenant can read its own private contents", legitimate.encoding === "base64" && Buffer.from(legitimate.content, "base64").toString("utf8") === marker, { encoding: legitimate.encoding });
    const refsBefore = (await nativeFixture.inspectRepository("tenant-b", "repo-tenant-b")).refs;
    await withClient({ binary: GFY_BINARY, cwd: ROOT, env: gfyEnv(apiBase, "tenant-a", credentialFiles.tenantA) }, async (tenantA) => {
      await tenantA.initialize();
      const denials = [
        await tenantA.callTool("call_read_tool", { name: "gfy_forge_read", arguments: { ...scopeB, version: versionB.version_commit, tree: "code", path: "private.txt" } }),
        await tenantA.callTool("call_read_tool", { name: "gfy_forge_head", arguments: { tenant_id: "tenant-a", repository_id: "repo-tenant-b" } }),
        await tenantA.callTool("call_write_tool", { name: "gfy_forge_commit", arguments: { ...scopeB, operation_id: "native-runtime-cross-tenant-write", parent_version: versionB.version_commit, changes: [{ tree: "code", path: "private.txt", content_base64: Buffer.from("Unauthorized overwrite").toString("base64") }] } }),
        await tenantB.callTool("call_read_tool", { name: "gfy_forge_head", arguments: { tenant_id: "tenant-a", repository_id: "repo-tenant-a" } })
      ];
      const denialStatuses = denials.map(response => Number(/HTTP_(\d{3})/.exec(JSON.stringify(response))?.[1]));
      assertRuntime("populated tenants reject foreign reads, repository IDs, and writes in both directions", denials.every(response => response.result?.isError === true) && JSON.stringify(denialStatuses) === JSON.stringify([403, 404, 403, 403]) && denials.every(response => !JSON.stringify(response).includes(marker)), { deniedOperations: denials.length, statuses: denialStatuses });
    });
    const after = unwrapToolValue(unwrapToolValue(toolPayload(await tenantB.callTool("call_read_tool", { name: "gfy_forge_head", arguments: scopeB })))?.version);
    const refsAfter = (await nativeFixture.inspectRepository("tenant-b", "repo-tenant-b")).refs;
    assertRuntime("denied foreign write creates no candidate or receipt and preserves every Git ref", JSON.stringify(refsAfter) === JSON.stringify(refsBefore), { retainedRefs: refsAfter.length });
    assertRuntime("denied foreign write leaves the second tenant Git head and private contents unchanged", after.version_commit === versionB.version_commit && await nativeFixture.readCodeFile(versionB.version_commit, "private.txt", "tenant-b", "repo-tenant-b") === marker, { version: after.version_commit });
    return { populatedTenants: 2, deniedOperations: 4 };
  });
}

async function expectDeniedClient(apiBase, tenantId, credentialFile, name) {
  return withClient({ binary: GFY_BINARY, cwd: ROOT, env: gfyEnv(apiBase, tenantId, credentialFile) }, async (client) => {
    await client.initialize();
    let denialText = null;
    try {
      const response = await client.callTool("call_read_tool", { name: "gfy_auth_whoami", arguments: {} });
      if (response?.error) denialText = JSON.stringify(response.error);
      else if (response?.result?.isError) denialText = JSON.stringify(response.result);
      else if (denied(response)) denialText = JSON.stringify(response);
    } catch (error) {
      denialText = String(error?.message ?? error);
    }
    assertRuntime(name, Boolean(denialText) && denied(denialText), { denied: Boolean(denialText), message: denialText?.slice(0, 180) });
  });
}

async function runActualRuntime(runtime, apiBundle, schema, jwtFixture) {
  const d1Storage = fs.mkdtempSync(path.join(os.tmpdir(), "gitfoundry-p1-gfy-d1-"));
  const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitfoundry-p1-gfy-credentials-"));
  const credentialFiles = {
    tenantA: writeCredentialFile(credentialDir, "tenant-a", jwtFixture.tokens.tenantA),
    tenantAWriter: writeCredentialFile(credentialDir, "tenant-a-writer", jwtFixture.tokens.tenantAWriter),
    tenantB: writeCredentialFile(credentialDir, "tenant-b", jwtFixture.tokens.tenantB),
    revoked: writeCredentialFile(credentialDir, "revoked", jwtFixture.tokens.revoked)
  };
  const result = await withWorkerd(runtime, runtimeConfig(await runtimeServices(runtime, { d1Storage, apiBundle, schema, jwtFixture })), async (ports) => {
    const apiBase = `http://127.0.0.1:${ports.api}`;
    const seedBase = `http://127.0.0.1:${ports.seed}`;
    const peerBase = `http://127.0.0.1:${ports.apiPeer}`;
    assertRuntime("event reader and native writer use distinct API worker instances", ports.api !== ports.apiPeer, {});
    const seed = await jsonFetch(`${seedBase}/seed`, { method: "POST" });
    assertRuntime("actual D1 fixture seeded through workerd D1", seed.status === 200 && seed.json?.ok === true, { status: seed.status });
    const health = await jsonFetch(`${apiBase}/health`);
    assertRuntime("actual API Worker runs under workerd", health.status === 200 && health.json?.operations === 16, { status: health.status, operations: health.json?.operations, implemented: health.json?.implementedOperations?.length });
    const exercised = await exerciseNativeGfy(apiBase, seedBase, credentialFiles);
    const tenantIsolation = await exercisePopulatedTenantIsolation(apiBase, credentialFiles);
    await expectDeniedClient(apiBase, "tenant-b", credentialFiles.tenantA, "wrong tenant route/auth pairing is denied by actual API route guard");
    await expectDeniedClient(apiBase, "tenant-a-revoked", credentialFiles.revoked, "revoked/inactive principal is denied by actual API identity guard");
    const cliOperations = await exerciseNativeCli({ binary: GFY_BINARY, cwd: ROOT, env: gfyEnv(apiBase, "tenant-a", credentialFiles.tenantA), seedBase, fixture: nativeFixture, assertRuntime });
    const eventStreams = await exerciseResourceEventStream({ apiBase, seedBase, credentialFiles, versionCommit: exercised.versionCommit, otherRepositoryId: exercised.createdRepositoryId, assertRuntime,
      withTenantClient: (callback, writer = false) => withClient({ binary: GFY_BINARY, cwd: ROOT, env: gfyEnv(peerBase, "tenant-a", writer ? credentialFiles.tenantAWriter : credentialFiles.tenantA) }, async client => { await client.initialize(); return callback(client); }),
      callNative: async (client, name, arguments_, write) => { const response = await client.callTool(write ? "call_write_tool" : "call_read_tool", { name, arguments: arguments_ }); assertRuntime("event-stream mutation succeeds through actual native MCP", !response.error && response.result?.isError !== true, { operation: name }); return unwrapToolValue(toolPayload(response)); }
    });
    return { apiBase: "loopback", d1Storage, apiWorkerInstances: 2, tenantIsolation, eventStreams, cliOperations, ...exercised };
  });
  return result;
}

async function main() {
  const schema = validateCanonicalD1Fixture();
  const runtime = await loadRuntime();
  nativeFixture = await createNativeForgeFixture(ROOT);
  try {
  const apiBundle = await bundleActualApiSource();
  const jwtFixture = makeJwtFixture();
  const runtimeResult = await runActualRuntime(runtime, apiBundle, schema, jwtFixture);
  const summary = { ok: results.every((result) => result.ok), checkedAt: new Date().toISOString(), runtime: runtimeResult, results };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
  } finally { await nativeFixture.close(); }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), results }, null, 2));
  process.exit(1);
});
