import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";import { Effect } from "effect";


import type { Env } from "./index.js";
import type { ForgeGitPort, ForgeMergeInput, ForgeMergeResult, ForgeWriteCommitInput } from "@gitfoundry/core";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class<Env = unknown> {
    readonly env: Env;
    constructor(_ctx?: unknown, env?: Env) { this.env = env as Env }
  }
}));

type WorkerModule = typeof import("./index.js");
type Jwk = JsonWebKey & { kid: string; alg: string };

let api: WorkerModule;

beforeAll(async () => { api = await import("./index.js") });

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  async batch(statements: readonly { run(): Promise<any> }[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  prepare(sql: string) {
    const database = this.db;
    return { values: [] as any[], bind(...values: unknown[]) { return { ...this, values } }, async first<T>() { return database.prepare(sql).get(...this.values) as T | null }, async all<T>() { return { results: database.prepare(sql).all(...this.values) as T[] } }, async run() { const result = database.prepare(sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } } } };
  }
}

const now = new Date("2026-10-08T00:00:00Z");
const request = (path: string, init?: RequestInit) => new Request(`https://gitfoundry.test${path}`, init);

describe("api worker P0 routing and auth", () => {
  it("limits the production surface to fork operations and blocks retired writes through both dispatchers", async () => {
    const fixture = await makeFixture(["identity.read", "repository.read", "issue.read", "issue.write"], { GFY_FORK_ONLY: true });
    const health = await api.default.fetch(request("/health"), fixture.env);
    const healthBody = await health.json() as { operations: number; implementedOperations: string[] };
    expect(healthBody.operations).toBe(16);
    expect(healthBody.implementedOperations).toContain("forge.publish");
    expect(healthBody.implementedOperations).toContain("repo.delete");
    expect(healthBody.implementedOperations).not.toContain("issue.create");
    expect(healthBody.implementedOperations).not.toContain("pr.create");
    const body = { repository_id: "repo-a", title: "Must be a Git document" };
    const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/issues", { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": "retired-public" }), body: JSON.stringify(body) }), fixture.env);
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({ error: "gfy_unsupported_operation", detail: "issue.create" });
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    expect(identity.status).toBe(200);
    const denied = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "issue.create", context: await identity.json(), arguments: { route: { tenant_id: "tenant-a" }, body }, execution: { idempotency_key: "retired-private" } }) }));
    expect(denied.status).toBe(501);
    const rows = fixture.sql.db.prepare("SELECT COUNT(*) AS count FROM issues").get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("publishes fork-first forge versions through v2 routes and rejects stale publication", async () => {
    const port = new ApiForkGitPort();
    const verifyEvidence = vi.fn(async () => {});
    const fixture = await makeFixture(["identity.read", "forge.initialize", "forge.read", "forge.commit", "forge.publish"], { GFY_FORGE_GIT: port, GFY_FORGE_VERIFY_EVIDENCE: verifyEvidence });
    const basePath = "/api/v2/tenants/tenant-a/repositories/repo-a/forge";
    const post = async (path: string, key: string, body: Record<string, unknown>) => api.default.fetch(request(basePath + path, { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": key }), body: JSON.stringify(body) }), fixture.env);

    const publicationPolicy = { evaluator: "sha256:evaluator-a", required_checks: ["unit"] };
    const evaluatorPolicy = { signature: { algorithm: "fixture" }, rules: ["publication"] };
    const root = await post("/initialize", "init", { code_commit: rootForgeCode, initial_state: [
      { path: "config/publication.json", content_base64: base64Json(publicationPolicy) },
      { path: "evaluator/policy.json", content_base64: base64Json(evaluatorPolicy) }
    ] });
    expect(root.status).toBe(200);
    const rootBody = await root.json() as { version: { version_commit: string } };
    const publicationFile = await api.default.fetch(request(`${basePath}/files?version=${rootBody.version.version_commit}&tree=state&path=config%2Fpublication.json`, { headers: await fixture.headers() }), fixture.env);
    expect(publicationFile.status).toBe(200);
    await expect(publicationFile.json()).resolves.toMatchObject({ version: rootBody.version.version_commit, tree: "state", path: "config/publication.json", encoding: "base64", content: base64Json(publicationPolicy) });
    const evaluatorFile = await api.default.fetch(request(`${basePath}/files?version=${rootBody.version.version_commit}&tree=state&path=evaluator%2Fpolicy.json`, { headers: await fixture.headers() }), fixture.env);
    expect(evaluatorFile.status).toBe(200);
    await expect(evaluatorFile.json()).resolves.toMatchObject({ version: rootBody.version.version_commit, tree: "state", path: "evaluator/policy.json", encoding: "base64", content: base64Json(evaluatorPolicy) });
    const left = await post("/commit", "left", { parent_version: rootBody.version.version_commit, changes: [{ tree: "state", path: "issues/one.json", content_base64: base64Text("{}") }] });
    const right = await post("/commit", "right", { parent_version: rootBody.version.version_commit, changes: [{ tree: "state", path: "issues/two.json", content_base64: base64Text("{}") }] });
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const leftBody = await left.json() as { version: { version_commit: string } };
    const rightBody = await right.json() as { version: { version_commit: string } };

    const published = await post("/publish", "publish-left", { expected_head: rootBody.version.version_commit, new_version: leftBody.version.version_commit });
    expect(published.status, await published.clone().text()).toBe(200);
    expect(verifyEvidence).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a", repository_id: "repo-a" }));
    const stale = await post("/publish", "publish-right", { expected_head: rootBody.version.version_commit, new_version: rightBody.version.version_commit });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: "gfy_stale_precondition" });

    const head = await api.default.fetch(request(basePath + "/head", { headers: await fixture.headers() }), fixture.env);
    expect(head.status).toBe(200);
    await expect(head.json()).resolves.toMatchObject({ version: { version_commit: leftBody.version.version_commit } });
    const file = await api.default.fetch(request(`${basePath}/files?version=${leftBody.version.version_commit}&tree=state&path=issues%2Fone.json`, { headers: await fixture.headers() }), fixture.env);
    expect(file.status).toBe(200);
    await expect(file.json()).resolves.toMatchObject({ version: leftBody.version.version_commit, tree: "state", path: "issues/one.json", encoding: "base64", content: base64Text("{}") });
  });

  it("streams durable resource changes for committed forge writes", async () => {
    const port = new ApiForkGitPort({ seedRoot: false });
    const fixture = await makeFixture(["identity.read", "repository.read", "forge.initialize"], { GFY_FORGE_GIT: port });
    const basePath = "/api/v2/tenants/tenant-a/repositories/repo-a/forge";
    const initialized = await api.default.fetch(request(basePath + "/initialize", { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": "live-init" }), body: JSON.stringify({ code_commit: rootForgeCode }) }), fixture.env);
    expect(initialized.status, await initialized.clone().text()).toBe(200);
    expect(fixture.sql.db.prepare("SELECT tenant_id,repository_id,operation_id,cursor FROM resource_events").get()).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", operation_id: "forge.initialize", cursor: "gfy_1" });
    const denied = await api.default.fetch(request("/api/v1/tenants/tenant-a/events"), fixture.env);
    expect(denied.status).toBe(401);
    const stream = await api.default.fetch(request("/api/v1/tenants/tenant-a/events", { headers: await fixture.headers() }), fixture.env);
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: change");
    expect(text).toContain("forge.initialize");
    expect(text).toContain("gfy_1");
  });

  it("bootstraps empty repositories and lists exact forge trees through public and private dispatchers", async () => {
    const publicPort = new ApiForkGitPort({ seedRoot: false });
    const publicFixture = await makeFixture(["identity.read", "forge.initialize", "forge.read"], { GFY_FORGE_GIT: publicPort });
    const basePath = "/api/v2/tenants/tenant-a/repositories/repo-a/forge";
    const initialized = await api.default.fetch(request(basePath + "/initialize", { method: "POST", headers: await publicFixture.headers(undefined, { "content-type": "application/json", "idempotency-key": "bootstrap-public" }), body: JSON.stringify({ initial_code: [{ path: "README.md", content_base64: base64Text("hello"), mode: "100755" }], initial_state: [{ path: "issues/seed.json", content_base64: base64Text("{}"), mode: "100644" }] }) }), publicFixture.env);
    expect(initialized.status, await initialized.clone().text()).toBe(200);
    const initializedBody = await initialized.json() as { version: { version_commit: string } };
    const tree = await api.default.fetch(request(`${basePath}/files?version=${initializedBody.version.version_commit}&tree=code`, { headers: await publicFixture.headers() }), publicFixture.env);
    expect(tree.status).toBe(200);
    await expect(tree.json()).resolves.toMatchObject({ version: initializedBody.version.version_commit, tree: "code", prefix: "", entries: [{ path: "README.md", mode: "100755" }] });
    const file = await api.default.fetch(request(`${basePath}/files?version=${initializedBody.version.version_commit}&tree=code&path=README.md`, { headers: await publicFixture.headers() }), publicFixture.env);
    await expect(file.json()).resolves.toMatchObject({ content: base64Text("hello") });

    const privatePort = new ApiForkGitPort({ seedRoot: false });
    const privateFixture = await makeFixture(["identity.read", "forge.initialize", "forge.read"], { GFY_FORGE_GIT: privatePort });
    const entrypoint = new api.AgentApi({} as ExecutionContext, privateFixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await privateFixture.headers({ aud: "mcp-audience" })).authorization }) }));
    const context = await identity.json();
    const privateInitialized = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "forge.initialize", arguments: { route: { tenant_id: "tenant-a", repository_id: "repo-a" }, body: { initial_code: [{ path: "src/app.ts", content_base64: base64Text("export {}\n"), mode: "100755" }] } }, context, execution: { idempotency_key: "bootstrap-private" } }) }));
    expect(privateInitialized.status, await privateInitialized.clone().text()).toBe(200);
    const privateBody = await privateInitialized.json() as { version: { version_commit: string } };
    const privateRead = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "forge.read", arguments: { route: { tenant_id: "tenant-a", repository_id: "repo-a" }, query: { version: privateBody.version.version_commit, tree: "code", prefix: "src/" }, body: null }, context, execution: {} }) }));
    expect(privateRead.status).toBe(200);
    await expect(privateRead.json()).resolves.toMatchObject({ tree: "code", prefix: "src/", entries: [{ path: "src/app.ts", mode: "100755" }] });
  });

  it("fails closed before Git publication when evidence verification is not configured", async () => {
    const port = new ApiForkGitPort();
    let gitRequests = 0;
    const fixture = await makeFixture(["identity.read", "forge.initialize", "forge.commit", "forge.publish"], { GFY_FORGE_GIT: async () => { gitRequests += 1; return port; } });
    const basePath = "/api/v2/tenants/tenant-a/repositories/repo-a/forge";
    const post = async (path: string, key: string, body: Record<string, unknown>) => api.default.fetch(request(basePath + path, { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": key }), body: JSON.stringify(body) }), fixture.env);
    const root = await post("/initialize", "init-blocked", { code_commit: rootForgeCode });
    expect(root.status, await root.clone().text()).toBe(200);
    const rootBody = await root.json() as { version: { version_commit: string } };
    const candidate = await post("/commit", "candidate-blocked", { parent_version: rootBody.version.version_commit, changes: [{ tree: "state", path: "checks/one.json", content_base64: base64Text("{}") }] });
    expect(candidate.status, await candidate.clone().text()).toBe(200);
    const candidateBody = await candidate.json() as { version: { version_commit: string } };
    const beforePublish = gitRequests;
    const blocked = await post("/publish", "publish-blocked", { expected_head: rootBody.version.version_commit, new_version: candidateBody.version.version_commit });
    expect(blocked.status).toBe(503);
    expect(gitRequests).toBe(beforePublish);
  });

  it("routes eligibility through current authorization and schema-checked durable preparation", async () => {
    const calls: unknown[] = [];
    const idFromName = vi.fn((name: string) => ({ name }));
    const privateFetch = vi.fn(async (incoming: Request) => {
      calls.push(await incoming.json());
      return Response.json(eligibilitySnapshot());
    });
    const binding = { idFromName, get: vi.fn(() => ({ fetch: privateFetch })) };
    const fixture = await makeFixture(["identity.read", "pull_request.read"], { GFY_PR_ELIGIBILITY_DO: binding } as unknown as Partial<Env>);
    const path = "/api/v1/tenants/tenant-a/pull-requests/pr-a/eligibility?method=merge&head_sha=" + "a".repeat(40);
    const unauthorizedInit = await api.default.fetch(request("/api/v2/tenants/tenant-a/repositories/repo-a/forge/initialize", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "unauthorized-init" }, body: JSON.stringify({ code_commit: rootForgeCode, initial_state: [{ path: "config/publication.json", content_base64: base64Text("{}") }] }) }), fixture.env);
    expect(unauthorizedInit.status).toBe(401);

    const missing = await api.default.fetch(request(path), fixture.env);
    expect(missing.status).toBe(401);
    expect(privateFetch).not.toHaveBeenCalled();
    const authorized = await api.default.fetch(request(path, { headers: await fixture.headers() }), fixture.env);
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual(eligibilitySnapshot());
    expect(idFromName).toHaveBeenCalledWith(JSON.stringify(["tenant-a", "pr-a"]));
    expect(calls).toEqual([{ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "principal-a", method: "merge", headSha: "a".repeat(40) }]);
    expect(JSON.stringify(calls)).not.toContain("Bearer");
    privateFetch.mockClear();
    fixture.sql.db.prepare("UPDATE principals SET active = 0 WHERE tenant_id = ? AND id = ?").run("tenant-a", "principal-a");
    const revoked = await api.default.fetch(request(path, { headers: await fixture.headers() }), fixture.env);
    expect(revoked.status).toBe(403);
    expect(privateFetch).not.toHaveBeenCalled();
  });

  it("connects authenticated public eligibility to awaited coordination and durable SQLite conflict replay", async () => {
    const { makePrEligibilityCoordinator } = await import("./pr-eligibility/coordinator.js");
    const { makeD1PrEligibilityService } = await import("./pr-eligibility/service.js");
    const { makeD1IdentityPort } = await import("../../../packages/core/src/live/index.js");
    const fixture = await makeFixture(["identity.read", "pull_request.read"]);
    fixture.sql.db.exec(readFileSync(new URL("../../../infra/migrations/0003_pr_eligibility.sql", import.meta.url), "utf8"));
    fixture.sql.db.exec(readFileSync(new URL("../../../infra/migrations/0004_pr_eligibility_finalization.sql", import.meta.url), "utf8"));
    const timestamp = now.toISOString();
    const head = "a".repeat(40), base = "b".repeat(40);
    fixture.sql.db.prepare("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "issue-a", 5, timestamp, timestamp, "repo-a", 1, "PR", "Body", "open", "", "principal-a", "pull_request");
    fixture.sql.db.prepare("INSERT INTO pull_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", 3, timestamp, timestamp, "issue-a", "repo-a", "repo-a", "refs/heads/topic", "refs/heads/main", head, base, 0, null, null, null);
    let release: (() => void) | undefined;
    const preparing = new Promise<void>((resolve) => { release = resolve; });
    const prepare = vi.fn(async () => {
      await preparing;
      return {
        result: { ok: false as const, status: "conflict" as const, gitVersion: "2.39.5", stateRef: "merge-candidates/requests/request/conflict.json", diagnostics: [{ code: "content", path: "src/app.ts" }] },
        reviewedDiff: { algorithmVersion: "git-cli-unified-v1" as const, comparison: "three_dot" as const, contextLines: 3 as const, headSha: head, baseSha: base, mergeBaseShas: [base], patchSha256: "d".repeat(64), patchSizeBytes: 12, changedPathsSha256: "e".repeat(64) }
      };
    });
    const identity = makeD1IdentityPort(fixture.sql, fixture.env.clock);
    const service = makeD1PrEligibilityService(fixture.sql, {
      runtime: { prepare },
      gitRead: { resolveRef: ({ ref }) => Effect.succeed({ sha: ref === "refs/heads/main" ? base : head }) },
      clock: fixture.env.clock,
      authorize: async ({ tenantId, actorId, policyEpoch }) => {
        await Effect.runPromise(identity.verifyGrant({ tenantId, principalId: actorId, policyEpoch, capability: "pull_request.read" }));
      }
    });
    let coordinator = makePrEligibilityCoordinator(service);
    fixture.env.GFY_PR_ELIGIBILITY_DO = { idFromName: (name: string) => ({ name }), get: () => ({ fetch: (incoming: Request) => coordinator.fetch(incoming) }) } as unknown as Pick<DurableObjectNamespace, "idFromName" | "get">;
    const path = "/api/v1/tenants/tenant-a/pull-requests/pr-a/eligibility";
    const headers = await fixture.headers();
    const first = api.default.fetch(request(path, { headers }), fixture.env);
    const concurrent = api.default.fetch(request(path, { headers }), fixture.env);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(fixture.sql.db.prepare("SELECT state FROM pr_eligibility_generations").get()).toMatchObject({ state: "running" });
    expect(fixture.sql.db.prepare("SELECT count(*) AS n FROM eligibility").get()).toMatchObject({ n: 0 });
    release!();
    const responses = await Promise.all([first, concurrent]);
    expect(responses.map((value) => value.status)).toEqual([200, 200]);
    const snapshots = await Promise.all(responses.map((value) => value.json()));
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0]).toMatchObject({ tenant_id: "tenant-a", pull_request_id: "pr-a", pr_version: 5, candidate_sha: null, diff_digest: "d".repeat(64), status: "blocked", blockers: expect.arrayContaining([expect.objectContaining({ code: "conflict" })]) });
    const record = fixture.sql.db.prepare("SELECT result_key FROM operations WHERE kind = 'pr.eligibility.prepare'").get() as { result_key: string };
    expect(JSON.parse(record.result_key.slice(5))).toMatchObject({ snapshot: snapshots[0], exposedIssueVersion: 5, internalPrRevision: 3 });
    coordinator = makePrEligibilityCoordinator(service);
    const replay = await api.default.fetch(request(path, { headers }), fixture.env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(snapshots[0]);
    expect(prepare).toHaveBeenCalledTimes(1);
    fixture.sql.db.prepare("UPDATE issues SET version = 6 WHERE tenant_id = 'tenant-a' AND id = 'issue-a'").run();
    const refreshed = await api.default.fetch(request(path, { headers }), fixture.env);
    expect(refreshed.status).toBe(200);
    const refreshedSnapshot = await refreshed.json() as { id: string; pr_version: number };
    expect(refreshedSnapshot.pr_version).toBe(6);
    expect(refreshedSnapshot.id).not.toBe((snapshots[0] as { id: string }).id);
    expect(prepare).toHaveBeenCalledTimes(2);
    fixture.sql.db.prepare("UPDATE principals SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'").run();
    expect((await api.default.fetch(request(path, { headers }), fixture.env)).status).toBe(403);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("rejects unconfigured or malformed eligibility results and redacts pending provider details", async () => {
    const fixture = await makeFixture(["identity.read", "pull_request.read"]);
    const path = "/api/v1/tenants/tenant-a/pull-requests/pr-a/eligibility";
    const headers = await fixture.headers();
    const unconfigured = await api.default.fetch(request(path, { headers }), fixture.env);
    expect(unconfigured.status).toBe(503);
    let reply = Response.json({ ...eligibilitySnapshot(), tenant_id: "tenant-b" });
    const privateFetch = vi.fn(async () => reply);
    fixture.env.GFY_PR_ELIGIBILITY_DO = { idFromName: (name: string) => ({ name }), get: () => ({ fetch: privateFetch }) } as unknown as Pick<DurableObjectNamespace, "idFromName" | "get">;
    const wrongTenant = await api.default.fetch(request(path, { headers }), fixture.env);
    expect(wrongTenant.status).toBe(400);
    reply = Response.json({ ...eligibilitySnapshot(), diff_digest: "pending" });
    const fakeDiff = await api.default.fetch(request(path, { headers }), fixture.env);
    expect(fakeDiff.status).toBe(400);
    reply = Response.json({ ok: false, operation_id: "elig-operation-a", detail: "secret-provider-token" }, { status: 503 });
    const pending = await api.default.fetch(request(path, { headers }), fixture.env);
    expect(pending.status).toBe(503);
    const body = await pending.text();
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: "gfy_candidate_preparation_unavailable", operation_id: "elig-operation-a" });
    expect(body).not.toContain("secret-provider-token");
    expect(body).not.toContain("diff_digest");
    privateFetch.mockClear();
    const badQuery = await api.default.fetch(request(path + "?head_sha=branch-name", { headers }), fixture.env);
    expect(badQuery.status).toBe(400);
    expect(privateFetch).not.toHaveBeenCalled();
  });

  it("accepts public candidate-bound native checks only from trusted completed native job qualification", async () => {
    const fixture = await makeFixture(["identity.read", "check.write"]);
    installNativeJobSchema(fixture.sql.db);
    const trusted = await seedCompletedNativeJob(fixture.sql);
    const createBody = nativeCandidateCheckBody(trusted.token);
    const path = "/api/v1/tenants/tenant-a/checks";

    const missingAuth = await api.default.fetch(request(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "native-missing-auth" }, body: JSON.stringify(createBody) }), fixture.env);
    expect(missingAuth.status).toBe(401);
    expect(fixture.sql.db.prepare("SELECT COUNT(*) AS count FROM checks").get()).toEqual({ count: 0 });

    const created = await api.default.fetch(request(path, { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": "native-check-create" }), body: JSON.stringify(createBody) }), fixture.env);
    const createdText = await created.text();
    const createdBody = JSON.parse(createdText) as { candidate_bound: boolean; commit_sha: string; head_sha: string; base_sha: string; execution_sha: string; evidence_kind: string; status: string; conclusion: string; producer_id: string; provider_evidence_ref: string | null };
    if (created.status !== 200) throw new Error(`candidate check create failed ${created.status}: ${createdText}`);
    expect(createdBody).toMatchObject({ candidate_bound: true, commit_sha: nativeCandidateSha, head_sha: nativeHeadSha, base_sha: nativeBaseSha, execution_sha: nativeCandidateSha, evidence_kind: "native_job", status: "completed", conclusion: "success", producer_id: "principal-a", provider_evidence_ref: null });
    expect(JSON.stringify(createdBody)).not.toContain(trusted.token.id);
    expect(JSON.stringify(createdBody)).not.toContain(trusted.token.fenceToken);
    expect(JSON.stringify(createdBody)).not.toContain(trusted.token.providerEvidenceRef);

    for (const [label, body] of [
      ["candidate", { ...createBody, commit_sha: "d".repeat(40), execution_sha: "d".repeat(40) }],
      ["result", { ...createBody, conclusion: "failure" }],
      ["missing qualification", { ...createBody, job_attempt_id: "attempt-missing", provider_evidence_ref: null }]
    ] as const) {
      const denied = await api.default.fetch(request(path, { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": `native-check-denied-${label}` }), body: JSON.stringify(body) }), fixture.env);
      expect(denied.status, label).toBe(400);
    }
    expect(fixture.sql.db.prepare("SELECT COUNT(*) AS count FROM checks").get()).toEqual({ count: 1 });

    const forgedProducer = await makeFixture(["identity.read", "check.write"]);
    installNativeJobSchema(forgedProducer.sql.db);
    const principalB = await seedCompletedNativeJob(forgedProducer.sql, { producerId: "principal-b" });
    const producerDenied = await api.default.fetch(request(path, { method: "POST", headers: await forgedProducer.headers(undefined, { "content-type": "application/json", "idempotency-key": "native-check-forged-producer" }), body: JSON.stringify(nativeCandidateCheckBody(principalB.token)) }), forgedProducer.env);
    expect(producerDenied.status).toBe(400);
    expect(forgedProducer.sql.db.prepare("SELECT COUNT(*) AS count FROM checks").get()).toEqual({ count: 0 });

    const capabilityDenied = await makeFixture(["identity.read"]);
    installNativeJobSchema(capabilityDenied.sql.db);
    const deniedToken = await seedCompletedNativeJob(capabilityDenied.sql);
    const missingCapability = await api.default.fetch(request(path, { method: "POST", headers: await capabilityDenied.headers(undefined, { "content-type": "application/json", "idempotency-key": "native-check-missing-capability" }), body: JSON.stringify(nativeCandidateCheckBody(deniedToken.token)) }), capabilityDenied.env);
    expect(missingCapability.status).toBe(403);
    expect(capabilityDenied.sql.db.prepare("SELECT COUNT(*) AS count FROM checks").get()).toEqual({ count: 0 });
  });

  it("updates public candidate-bound native checks only through trusted native job lifecycle qualifications", async () => {
    const fixture = await makeFixture(["identity.read", "check.write"]);
    installNativeJobSchema(fixture.sql.db);
    const lifecycle = await seedScheduledNativeJob(fixture.sql);
    const path = "/api/v1/tenants/tenant-a/checks";
    const created = await api.default.fetch(request(path, { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": "native-check-queued-create" }), body: JSON.stringify(nativeCandidateCheckBody(lifecycle.queuedToken)) }), fixture.env);
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { id: string; version: number; status: string; conclusion: string | null; commit_sha: string; head_sha: string; base_sha: string; execution_sha: string; plan_digest: string; policy_digest: string; provider_evidence_ref: string | null };
    expect(createdBody).toMatchObject({ version: 1, status: "queued", conclusion: null, commit_sha: nativeCandidateSha, head_sha: nativeHeadSha, base_sha: nativeBaseSha, execution_sha: nativeCandidateSha, plan_digest: `sha256:${nativePlanDigest}`, policy_digest: `sha256:${nativePolicyDigest}`, provider_evidence_ref: null });

    const checkPath = `${path}/${createdBody.id}`;
    const missingAuth = await api.default.fetch(request(checkPath, { method: "PATCH", headers: { "content-type": "application/json", "if-match": "1" }, body: JSON.stringify(nativeCheckPatchBody({ status: "in_progress", conclusion: null })) }), fixture.env);
    expect(missingAuth.status).toBe(401);
    expect(fixture.sql.db.prepare("SELECT version, status, conclusion FROM checks WHERE id = ?").get(createdBody.id)).toEqual({ version: 1, status: "queued", conclusion: null });

    const inProgressToken = await lifecycle.store.start({ ...lifecycle.input, jobId: lifecycle.scheduled.jobId, attemptId: lifecycle.scheduled.attemptId, attemptGeneration: lifecycle.scheduled.attemptGeneration, fenceToken: lifecycle.scheduled.fenceToken });
    const inProgress = await api.default.fetch(request(checkPath, { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "1" }), body: JSON.stringify(nativeCheckPatchBody(inProgressToken)) }), fixture.env);
    expect(inProgress.status).toBe(200);
    await expect(inProgress.json()).resolves.toMatchObject({ id: createdBody.id, version: 2, status: "in_progress", conclusion: null, commit_sha: nativeCandidateSha, provider_evidence_ref: null });
    const runningRow = fixture.sql.db.prepare("SELECT version, status, conclusion, commit_sha, execution_sha FROM checks WHERE id = ?").get(createdBody.id);
    expect(runningRow).toEqual({ version: 2, status: "in_progress", conclusion: null, commit_sha: nativeCandidateSha, execution_sha: nativeCandidateSha });

    const stale = await api.default.fetch(request(checkPath, { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "1" }), body: JSON.stringify(nativeCheckPatchBody({ status: "completed", conclusion: "success" })) }), fixture.env);
    expect(stale.status).toBe(409);
    expect(fixture.sql.db.prepare("SELECT version, status, conclusion FROM checks WHERE id = ?").get(createdBody.id)).toEqual({ version: 2, status: "in_progress", conclusion: null });

    const forgedResult = await api.default.fetch(request(checkPath, { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "2" }), body: JSON.stringify(nativeCheckPatchBody({ status: "completed", conclusion: "failure" })) }), fixture.env);
    expect(forgedResult.status).toBe(400);
    expect(fixture.sql.db.prepare("SELECT version, status, conclusion FROM checks WHERE id = ?").get(createdBody.id)).toEqual({ version: 2, status: "in_progress", conclusion: null });

    const completedToken = await lifecycle.store.finalize({ ...lifecycle.input, jobId: lifecycle.scheduled.jobId, attemptId: lifecycle.scheduled.attemptId, attemptGeneration: lifecycle.scheduled.attemptGeneration, fenceToken: lifecycle.scheduled.fenceToken, now: nativeCompletedAt, terminalStatus: "completed", exitCode: 0, providerEvidenceRef: "r2://logs/attempt-a", logSha256: nativeSha("log"), logBytes: 123 });
    const completed = await api.default.fetch(request(checkPath, { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "2" }), body: JSON.stringify(nativeCheckPatchBody(completedToken)) }), fixture.env);
    expect(completed.status).toBe(200);
    const completedBody = await completed.json() as { version: number; status: string; conclusion: string | null; commit_sha: string; head_sha: string; base_sha: string; execution_sha: string; provider_evidence_ref: string | null };
    expect(completedBody).toMatchObject({ version: 3, status: "completed", conclusion: "success", commit_sha: nativeCandidateSha, head_sha: nativeHeadSha, base_sha: nativeBaseSha, execution_sha: nativeCandidateSha, provider_evidence_ref: null });
    expect(JSON.stringify(completedBody)).not.toContain(completedToken.id);
    expect(JSON.stringify(completedBody)).not.toContain(completedToken.fenceToken);
    expect(JSON.stringify(completedBody)).not.toContain(completedToken.providerEvidenceRef);
  });


  it("routes public Git reads through live authorization before provider access", async () => {
    const worker = await import("./worker.js");
    const native = nativeArtifactsFixture();
    const get = vi.fn(native.binding.get);
    const fixture = await makeFixture(["repository.read", "identity.read"], { GFY_GIT: { ...native.binding, get }, GFY_GIT_NAMESPACE: "tenant-a" });
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
    const path = "/git/tenant-a/repo-a.git/info/refs?service=git-upload-pack";
    const missing = await worker.default.fetch(request(path), fixture.env, ctx);
    expect(missing.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
    const authorized = await worker.default.fetch(request(path, { headers: await fixture.headers() }), fixture.env, ctx);
    expect(authorized.status).toBe(502);
    expect(get).toHaveBeenCalledExactlyOnceWith("repo-a");
    get.mockClear();
    fixture.sql.db.prepare("UPDATE principals SET active = 0 WHERE tenant_id = ? AND id = ?").run("tenant-a", "principal-a");
    const revoked = await worker.default.fetch(request(path, { headers: await fixture.headers() }), fixture.env, ctx);
    expect(revoked.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
    const write = await worker.default.fetch(request("/git/tenant-a/repo-a.git/git-receive-pack", { method: "POST", body: "unapproved pack" }), fixture.env, ctx);
    expect(write.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
    await Promise.all(pending);
  });

  it("returns authorized clone information without provisioning or exposing a provider token", async () => {
    const native = nativeArtifactsFixture();
    const fixture = await makeFixture(["repository.read", "identity.read"], { GFY_GIT: native.binding, GFY_GIT_NAMESPACE: "tenant-a", GFY_GIT_URL_BASE: "https://gitfoundry.test/git" });
    const path = "/api/v1/tenants/tenant-a/repositories/repo-a/clone-info";
    const response = await api.default.fetch(request(path, { headers: await fixture.headers() }), fixture.env);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ id: "repo-a", tenant_id: "tenant-a", git_url: "https://gitfoundry.test/git/tenant-a/repo-a.git" });
    expect(body).not.toContain(native.bootstrapToken);
    expect(native.created).toHaveLength(0);
    const denied = await api.default.fetch(request(path), fixture.env);
    expect(denied.status).toBe(401);
    const crossTenant = await api.default.fetch(request("/api/v1/tenants/tenant-b/repositories/repo-a/clone-info", { headers: await fixture.headers() }), fixture.env);
    expect(crossTenant.status).toBe(403);
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    const clone = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "repo.clone", arguments: { route: { tenant_id: "tenant-a", id: "repo-a" }, query: {} }, context, execution: {} }) }));
    expect(clone.status).toBe(200);
    await expect(clone.json()).resolves.toMatchObject({ git_url: "https://gitfoundry.test/git/tenant-a/repo-a.git" });
    expect(native.created).toHaveLength(0);
  });

  it("authorizes Git transport through current tenant identity and grants", async () => {
    const fixture = await makeFixture(["repository.read", "identity.read"]);
    const read = request("/git/tenant-a/repo-a.git/info/refs?service=git-upload-pack", { headers: await fixture.headers() });
    await expect(api.authorizeGitTransportRequest(read, fixture.env, "tenant-a", "repository.read")).resolves.toBeUndefined();
    const deniedWrite = await api.authorizeGitTransportRequest(read, fixture.env, "tenant-a", "repository.write");
    expect(deniedWrite?.status).toBe(403);
    const crossTenant = await api.authorizeGitTransportRequest(read, fixture.env, "tenant-b", "repository.read");
    expect(crossTenant?.status).toBe(403);
    fixture.sql.db.prepare("UPDATE principals SET active = 0 WHERE tenant_id = ? AND id = ?").run("tenant-a", "principal-a");
    const revoked = await api.authorizeGitTransportRequest(read, fixture.env, "tenant-a", "repository.read");
    expect(revoked?.status).toBe(403);
    const missing = await api.authorizeGitTransportRequest(request("/git/tenant-a/repo-a.git/git-upload-pack"), fixture.env, "tenant-a", "repository.read");
    expect(missing?.status).toBe(401);
    const unconfigured = await api.authorizeGitTransportRequest(read, {}, "tenant-a", "repository.read");
    expect(unconfigured?.status).toBe(503);
  });

  it("returns a repository name conflict without changing the repository", async () => {
    const fixture = await makeFixture(["repository.read", "repository.write", "identity.read"]);
    const timestamp = now.toISOString();
    fixture.sql.db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-conflict", 1, timestamp, timestamp, "namespace-a", "taken", "private", "main", 0, "tenant-a", "repo-conflict", null);
    const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a", { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "1", "idempotency-key": "repo-name-conflict" }), body: JSON.stringify({ name: "taken" }) }), fixture.env);
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({ status: 409, body: { error: "gfy_repository_name_conflict" } });
    expect(fixture.sql.db.prepare("SELECT version,name,artifacts_name FROM repositories WHERE tenant_id = ? AND id = ?").get("tenant-a", "repo-a")).toMatchObject({ version: 1, name: "demo", artifacts_name: "repo-a" });
  });

  it("returns a bounded unavailable response for repository storage faults", async () => {
    const fixture = await makeFixture(["repository.read", "repository.write", "identity.read"]);
    const secret = "database-private-credential-sentinel";
    fixture.env.GFY_DB = {
      prepare(sql: string) {
        if (sql.startsWith("UPDATE repositories")) throw new Error(secret);
        return fixture.sql.prepare(sql);
      },
      batch: (statements) => fixture.sql.batch(statements)
    };
    const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a", { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "1", "idempotency-key": "repo-storage-fault" }), body: JSON.stringify({ visibility: "internal" }) }), fixture.env);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: "gfy_repository_store_unavailable" });
    expect(body).not.toContain(secret);
    expect(fixture.sql.db.prepare("SELECT version,visibility FROM repositories WHERE tenant_id = ? AND id = ?").get("tenant-a", "repo-a")).toMatchObject({ version: 1, visibility: "private" });
  });

  it("uses the shared implemented catalog and returns identity through private MCP", async () => {
    const fixture = await makeFixture(["identity.read"]);
    const health = await api.default.fetch(request("/health"), fixture.env);
    const body = await health.json() as { implementedOperations: string[] };
    const core = await import("@gitfoundry/core");
    expect(body.implementedOperations).toEqual(["auth.whoami", ...core.implementedOperationIds, "repo.tree", "repo.diff", "forge.head", "forge.list", "forge.view", "forge.read", "forge.compare", "forge.initialize", "forge.fork", "forge.commit", "forge.merge", "forge.publish", "forge.recover", "pr.eligibility"].sort());
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    const whoami = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "auth.whoami", arguments: { route: { tenant_id: "tenant-a" }, query: {} }, context, execution: {} }) }));
    expect(whoami.status).toBe(200);
    await expect(whoami.json()).resolves.toMatchObject({ principal_id: "principal-a", tenant_id: "tenant-a" });
  });


  it("accepts a null body for private MCP forge reads while rejecting malformed bodies", async () => {
    const port = new ApiForkGitPort();
    const fixture = await makeFixture(["identity.read", "forge.initialize", "forge.read"], { GFY_FORGE_GIT: port });
    const initialized = await api.default.fetch(request("/api/v2/tenants/tenant-a/repositories/repo-a/forge/initialize", {
      method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": "private-null-body-init" }), body: JSON.stringify({ code_commit: rootForgeCode })
    }), fixture.env);
    expect(initialized.status).toBe(200);
    const initial = await initialized.json() as { version: { version_commit: string } };
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    const invoke = (body: unknown) => entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({
      operation_id: "forge.head", arguments: { route: { tenant_id: "tenant-a", repository_id: "repo-a" }, query: {}, body }, context, execution: {}
    }) }));
    const head = await invoke(null);
    expect(head.status, await head.clone().text()).toBe(200);
    await expect(head.json()).resolves.toMatchObject({ version: { version_commit: initial.version.version_commit, descriptor: { code_commit: rootForgeCode } } });
    expect((await invoke([])).status).toBe(400);
  });

  it("fails closed for private MCP fork publication before Git when evidence verification is missing", async () => {
    const port = new ApiForkGitPort();
    let gitRequests = 0;
    const fixture = await makeFixture(["identity.read", "forge.publish"], { GFY_FORGE_GIT: async () => { gitRequests += 1; return port; } });
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    const blocked = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({
      operation_id: "forge.publish",
      arguments: { route: { tenant_id: "tenant-a", repository_id: "repo-a" }, body: { expected_head: "a".repeat(40), new_version: "b".repeat(40) } },
      context,
      execution: { idempotency_key: "private-publish-blocked" }
    }) }));
    expect(blocked.status).toBe(503);
    expect(gitRequests).toBe(0);
  });

  it("reauthorizes private MCP fork mutations after the request enters the production dispatcher", async () => {
    const port = new ApiForkGitPort();
    const fixture = await makeFixture(["identity.read", "forge.initialize"], {
      GFY_FORGE_GIT: async () => {
        fixture.sql.db.prepare("UPDATE roles SET capabilities_json = ? WHERE tenant_id = 'tenant-a' AND id = 'role-a'").run(JSON.stringify(["identity.read"]));
        return port;
      }
    });
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    const denied = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({
      operation_id: "forge.initialize",
      arguments: { route: { tenant_id: "tenant-a", repository_id: "repo-a" }, body: { code_commit: rootForgeCode } },
      context,
      execution: { idempotency_key: "private-init-revoked" }
    }) }));
    expect(denied.status).toBe(403);
    expect(port.refs.size).toBe(0);
    expect(port.commits.size).toBe(1);
  });

  it("seals unsigned public review records with the authenticated actor and exact candidate code", async () => {
    const port = new ApiForkGitPort();
    const signer = vi.fn(async ({ record }: Parameters<NonNullable<Env["GFY_FORGE_SIGN_REVIEW"]>>[0]) => ({ ...record, signature: { algorithm: "fixture", covers: ["actor_id", "actor_kind", "candidate_code_commit"] } }));
    const fixture = await makeFixture(["identity.read", "forge.initialize", "forge.read", "forge.commit", "review.write"], { GFY_FORGE_GIT: port, GFY_FORGE_SIGN_REVIEW: signer });
    const basePath = "/api/v2/tenants/tenant-a/repositories/repo-a/forge";
    const post = async (path: string, key: string, body: Record<string, unknown>) => api.default.fetch(request(basePath + path, { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": key }), body: JSON.stringify(body) }), fixture.env);

    const root = await post("/initialize", "review-init", { code_commit: rootForgeCode });
    const rootBody = await root.json() as { version: { version_commit: string } };
    const review = { kind: "review", id: "review-a", decision: "approved", reason: "looks good" };
    const signedCopy = { kind: "review", id: "copied", signature: { algorithm: "external" }, actor_id: "other", candidate_code_commit: "b".repeat(40) };
    const committed = await post("/commit", "review-commit", { parent_version: rootBody.version.version_commit, changes: [
      { tree: "state", path: "reviews/review-a.json", content_base64: base64Json(review) },
      { tree: "state", path: "reviews/copied.json", content_base64: base64Json(signedCopy) }
    ] });
    expect(committed.status, await committed.clone().text()).toBe(200);
    expect(signer).toHaveBeenCalledTimes(1);
    const committedBody = await committed.json() as { version: { version_commit: string } };
    const file = await api.default.fetch(request(`${basePath}/files?version=${committedBody.version.version_commit}&tree=state&path=reviews%2Freview-a.json`, { headers: await fixture.headers() }), fixture.env);
    expect(file.status).toBe(200);
    const body = await file.json() as { content: string };
    expect(decodeBase64Json(body.content)).toMatchObject({ kind: "review", actor_id: "principal-a", actor_kind: "human", candidate_code_commit: rootForgeCode, signature: { algorithm: "fixture" } });
  });

  it("rejects forged public review actor and candidate code bindings before signing", async () => {
    const port = new ApiForkGitPort();
    const signer = vi.fn(async ({ record }: Parameters<NonNullable<Env["GFY_FORGE_SIGN_REVIEW"]>>[0]) => ({ ...record, signature: { algorithm: "fixture" } }));
    const fixture = await makeFixture(["identity.read", "forge.initialize", "forge.commit", "review.write"], { GFY_FORGE_GIT: port, GFY_FORGE_SIGN_REVIEW: signer });
    const basePath = "/api/v2/tenants/tenant-a/repositories/repo-a/forge";
    const post = async (path: string, key: string, body: Record<string, unknown>) => api.default.fetch(request(basePath + path, { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": key }), body: JSON.stringify(body) }), fixture.env);
    const root = await post("/initialize", "review-forge-init", { code_commit: rootForgeCode });
    const rootBody = await root.json() as { version: { version_commit: string } };

    const forgedActor = await post("/commit", "review-forged-actor", { parent_version: rootBody.version.version_commit, changes: [{ tree: "state", path: "reviews/forged-actor.json", content_base64: base64Json({ kind: "review", actor_id: "principal-b" }) }] });
    expect(forgedActor.status).toBe(403);
    const forgedCode = await post("/commit", "review-forged-code", { parent_version: rootBody.version.version_commit, changes: [{ tree: "state", path: "reviews/forged-code.json", content_base64: base64Json({ kind: "review", candidate_code_commit: "b".repeat(40) }) }] });
    expect(forgedCode.status).toBe(403);
    expect(signer).not.toHaveBeenCalled();
  });

  it("requires a fresh private MCP review.write grant before sealing review records", async () => {
    const port = new ApiForkGitPort();
    let revokeOnGit = false;
    const signer = vi.fn(async ({ record }: Parameters<NonNullable<Env["GFY_FORGE_SIGN_REVIEW"]>>[0]) => ({ ...record, signature: { algorithm: "fixture" } }));
    const fixture = await makeFixture(["identity.read", "forge.initialize", "forge.commit", "review.write"], {
      GFY_FORGE_GIT: async () => {
        if (revokeOnGit) fixture.sql.db.prepare("UPDATE roles SET capabilities_json = ? WHERE tenant_id = 'tenant-a' AND id = 'role-a'").run(JSON.stringify(["identity.read", "forge.initialize", "forge.commit"]));
        return port;
      },
      GFY_FORGE_SIGN_REVIEW: signer
    });
    const basePath = "/api/v2/tenants/tenant-a/repositories/repo-a/forge";
    const root = await api.default.fetch(request(basePath + "/initialize", { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": "private-review-init" }), body: JSON.stringify({ code_commit: rootForgeCode }) }), fixture.env);
    const rootBody = await root.json() as { version: { version_commit: string } };
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    revokeOnGit = true;
    const denied = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({
      operation_id: "forge.commit",
      arguments: { route: { tenant_id: "tenant-a", repository_id: "repo-a" }, body: { parent_version: rootBody.version.version_commit, changes: [{ tree: "state", path: "reviews/private.json", content_base64: base64Json({ kind: "review" }) }] } },
      context,
      execution: { idempotency_key: "private-review-revoked" }
    }) }));
    expect(denied.status).toBe(403);
    expect(signer).not.toHaveBeenCalled();
  });

  it("serves label and milestone paging, edits, atomic deletion and operation readback", async () => {
    const fixture = await makeFixture(["identity.read", "repository.read", "operation.read", "issue.read", "issue.write", "issue.admin"]);
    const headers = async (key: string, version?: number) => fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": key, ...(version === undefined ? {} : { "if-match": String(version) }) });
    const labels = [];
    for (const name of ["bug_1", "bug_2"]) {
      const created = await api.default.fetch(request("/api/v1/tenants/tenant-a/labels", { method: "POST", headers: await headers(name), body: JSON.stringify({ repository_id: "repo-a", name, color: "ff0000" }) }), fixture.env);
      expect(created.status).toBe(200);
      labels.push(await created.json() as { id: string; version: number });
    }
    const first = await api.default.fetch(request("/api/v1/tenants/tenant-a/labels?repository_id=repo-a&limit=1&name_prefix=bug_", { headers: await fixture.headers() }), fixture.env);
    expect(first.status).toBe(200);
    const page = await first.json() as { items: Array<{ id: string }>; has_more: boolean; next_cursor: string };
    expect(page.items).toHaveLength(1); expect(page.has_more).toBe(true);
    const next = await api.default.fetch(request("/api/v1/tenants/tenant-a/labels?repository_id=repo-a&limit=1&name_prefix=bug_&cursor=" + encodeURIComponent(page.next_cursor), { headers: await fixture.headers() }), fixture.env);
    const tail = await next.json() as { items: Array<{ id: string }>; has_more: boolean };
    expect(tail.items).toHaveLength(1); expect(tail.items[0]?.id).not.toBe(page.items[0]?.id); expect(tail.has_more).toBe(false);
    const edited = await api.default.fetch(request("/api/v1/tenants/tenant-a/labels/" + labels[0]?.id, { method: "PATCH", headers: await headers("label-edit", 1), body: JSON.stringify({ expected_version: 1, description: "edited" }) }), fixture.env);
    expect(edited.status).toBe(200);
    const mismatch = await api.default.fetch(request("/api/v1/tenants/tenant-a/labels/" + labels[0]?.id, { method: "PATCH", headers: await headers("label-mismatch", 2), body: JSON.stringify({ expected_version: 1, description: "mismatch" }) }), fixture.env);
    expect(mismatch.status).toBe(400);
    const deleted = await api.default.fetch(request("/api/v1/tenants/tenant-a/labels/" + labels[0]?.id, { method: "DELETE", headers: await headers("label-delete", 2), body: JSON.stringify({ expected_version: 2, reason: "cleanup" }) }), fixture.env);
    expect(deleted.status).toBe(200);
    const operation = await deleted.json() as { id: string; status: string };
    expect(operation.status).toBe("succeeded");
    const observed = await api.default.fetch(request("/api/v1/tenants/tenant-a/operations/" + operation.id, { headers: await fixture.headers() }), fixture.env);
    expect(observed.status).toBe(200);
    await expect(observed.json()).resolves.toMatchObject({ id: operation.id, kind: "label.delete", status: "succeeded" });
    const milestone = await api.default.fetch(request("/api/v1/tenants/tenant-a/milestones", { method: "POST", headers: await headers("milestone-create"), body: JSON.stringify({ repository_id: "repo-a", title: "Release" }) }), fixture.env);
    expect(milestone.status).toBe(200);
    const created = await milestone.json() as { id: string };
    const closed = await api.default.fetch(request("/api/v1/tenants/tenant-a/milestones/" + created.id, { method: "PATCH", headers: await headers("milestone-close", 1), body: JSON.stringify({ expected_version: 1, state: "closed" }) }), fixture.env);
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toMatchObject({ state: "closed", version: 2 });
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    const invoked = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "label.list", arguments: { route: { tenant_id: "tenant-a" }, query: { repository_id: "repo-a" } }, context, execution: {} }) }));
    expect(invoked.status).toBe(200);
    await expect(invoked.json()).resolves.toMatchObject({ items: [{ id: labels[1]?.id }] });
  });

  it("fails closed when identity or storage configuration is missing", async () => {
    const response = await api.default.fetch(request("/health"), {});
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "gfy_auth_unconfigured" });
  });

  it("denies public access to private service prefixes", async () => {
    const fixture = await makeFixture();
    const response = await api.default.fetch(request("/identity", { method: "POST", headers: await fixture.headers(), body: JSON.stringify({ requested_tenant_id: "tenant-a" }) }), fixture.env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "gfy_internal_route_forbidden" });
  });




  it("enforces a byte-counted streaming body limit", async () => {
    const fixture = await makeFixture(["repository.read", "repository.write", "identity.read"], { GFY_BODY_LIMIT_BYTES: "20" });
    const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { method: "POST", headers: await fixture.headers(undefined, { "idempotency-key": "bytes", "content-type": "application/json" }), body: JSON.stringify({ namespace_id: "namespace-a", name: "😀😀" }) }), fixture.env);
    expect(response.status).toBe(413);
  });

  it("resolves live grants and denies cross-tenant revoked or missing capability access", async () => {
    const fixture = await makeFixture();
    expect((await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a", { headers: await fixture.headers() }), fixture.env)).status).toBe(200);
    expect((await api.default.fetch(request("/api/v1/tenants/tenant-b/repositories/repo-a", { headers: await fixture.headers() }), fixture.env)).status).toBe(403);
    expect((await api.default.fetch(request("/api/v1/tenants/tenant-a/operations/op-a", { headers: await fixture.headers() }), fixture.env)).status).toBe(403);
    fixture.sql.db.prepare("UPDATE principals SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'").run();
    expect((await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a", { headers: await fixture.headers() }), fixture.env)).status).toBe(403);
  });

  it("partitions idempotency by principal and replays identical semantic inputs", async () => {
    const fixture = await makeFixture();
    const headers = await fixture.headers(undefined, { "idempotency-key": "same-key" });
    const first = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a", { headers }), fixture.env);
    const second = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a", { headers }), fixture.env);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("GitFoundry-Idempotent-Replay")).toBe("true");
  });

  it("provisions native Artifacts from REST and private MCP with one idempotent provider write", async () => {
    const native = nativeArtifactsFixture();
    const fixture = await makeFixture(["repository.read", "repository.write", "identity.read"], {
      GFY_GIT: native.binding, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_GIT_URL_BASE: "https://gitfoundry.test/git"
    });
    const headers = await fixture.headers(undefined, { "idempotency-key": "native-rest", "content-type": "application/json" });
    const body = JSON.stringify({ namespace_id: "namespace-a", name: "native-rest" });
    const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { method: "POST", headers, body }), fixture.env);
    expect(response.status).toBe(200);
    const repository = await response.json() as { id: string; git_url: string };
    expect(repository.git_url).toMatch(/^https:\/\/gitfoundry\.test\/git\/gitfoundry-staging\/gfy\.native-rest\.[0-9a-f]{64}\.git$/);
    expect(JSON.stringify(repository)).not.toContain(native.bootstrapToken);
    const replay = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { method: "POST", headers, body }), fixture.env);
    expect(replay.status).toBe(200);
    expect(native.created).toHaveLength(1);
    expect(native.revoked).toEqual([native.bootstrapToken]);
    const read = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/" + repository.id, { headers: await fixture.headers() }), fixture.env);
    await expect(read.json()).resolves.toMatchObject({ git_url: repository.git_url });

    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    const invoked = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "repo.create", arguments: { route: { tenant_id: "tenant-a" }, query: {}, body: { namespace_id: "namespace-a", name: "native-mcp" } }, context, execution: { idempotency_key: "native-mcp" } }) }));
    expect(invoked.status).toBe(200);
    expect(native.created).toHaveLength(2);
    expect(native.revoked).toHaveLength(2);
  });

  describe("repository delete", () => {
    const admin = ["repository.read", "repository.write", "repository.admin", "identity.read"];
    const options = (native: ReturnType<typeof nativeArtifactsFixture>) => ({ GFY_GIT: native.binding, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_GIT_URL_BASE: "https://gitfoundry.test/git" });
    async function created(fixture: Awaited<ReturnType<typeof makeFixture>>, name: string) {
      const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { method: "POST", headers: await fixture.headers(undefined, { "idempotency-key": "create-" + name, "content-type": "application/json" }), body: JSON.stringify({ namespace_id: "namespace-a", name }) }), fixture.env);
      expect(response.status).toBe(200);
      return await response.json() as { id: string; version: number };
    }
    const remove = async (fixture: Awaited<ReturnType<typeof makeFixture>>, id: string, expectedVersion: number, key: string) =>
      api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/" + id, { method: "DELETE", headers: await fixture.headers(undefined, { "idempotency-key": key, "content-type": "application/json" }), body: JSON.stringify({ expected_version: expectedVersion }) }), fixture.env);
    const listed = async (fixture: Awaited<ReturnType<typeof makeFixture>>) =>
      ((await (await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { headers: await fixture.headers() }), fixture.env)).json()) as { items: { id: string }[] }).items.map((item) => item.id);

    it("AC1 owner deletes a repository and gets a succeeded repo.delete operation", async () => {
      const native = nativeArtifactsFixture();
      const fixture = await makeFixture(admin, options(native));
      const repository = await created(fixture, "doomed");
      const response = await remove(fixture, repository.id, 1, "delete-doomed");
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ kind: "repo.delete", status: "succeeded" });
    });

    it("AC2 a deleted repository leaves the list", async () => {
      const native = nativeArtifactsFixture();
      const fixture = await makeFixture(admin, options(native));
      const repository = await created(fixture, "doomed");
      await remove(fixture, repository.id, 1, "delete-doomed");
      expect(await listed(fixture)).not.toContain(repository.id);
      expect(await listed(fixture)).toContain("repo-a");
    });

    it("AC3 a deleted repository cannot be viewed", async () => {
      const native = nativeArtifactsFixture();
      const fixture = await makeFixture(admin, options(native));
      const repository = await created(fixture, "doomed");
      await remove(fixture, repository.id, 1, "delete-doomed");
      expect((await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/" + repository.id, { headers: await fixture.headers() }), fixture.env)).status).toBe(404);
    });

    it("AC4 a deleted repository's stored Git data is removed from the provider", async () => {
      const native = nativeArtifactsFixture();
      const fixture = await makeFixture(admin, options(native));
      await created(fixture, "doomed");
      const storage = native.created[0]!;
      const repository = (await listed(fixture)).find((id) => id !== "repo-a")!;
      await remove(fixture, repository, 1, "delete-doomed");
      expect(native.deleted).toEqual([storage]);
      await expect(native.binding.get(storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("AC8 a repository with activity events is deleted along with its events", async () => {
      const native = nativeArtifactsFixture();
      const fixture = await makeFixture(admin, options(native));
      const repository = await created(fixture, "busy");
      fixture.sql.db.prepare("INSERT INTO resource_events(tenant_id,source_event_id,occurred_at,repository_id,kind,operation_id,resource_uris_json,authoritative_revision) VALUES(?,?,?,?,?,?,?,?)").run("tenant-a", "event-busy-1", now.toISOString(), repository.id, "forge.publish", "op-busy", "[]", "a".repeat(40));
      expect((await remove(fixture, repository.id, 1, "delete-busy")).status).toBe(202);
      expect(await listed(fixture)).not.toContain(repository.id);
      expect((fixture.sql.db.prepare("SELECT COUNT(*) AS n FROM resource_events WHERE repository_id = ?").get(repository.id) as { n: number }).n).toBe(0);
    });

    it("AC5 a stale expected version is refused and the repository remains", async () => {
      const native = nativeArtifactsFixture();
      const fixture = await makeFixture(admin, options(native));
      const repository = await created(fixture, "kept");
      expect((await remove(fixture, repository.id, 2, "delete-stale")).status).toBe(409);
      expect(await listed(fixture)).toContain(repository.id);
      expect(native.deleted).toEqual([]);
    });

    it("AC6 a repository another repository was forked from is refused and remains", async () => {
      const native = nativeArtifactsFixture();
      const fixture = await makeFixture(admin, options(native));
      const repository = await created(fixture, "parent");
      fixture.sql.db.prepare("UPDATE repositories SET fork_of = ? WHERE tenant_id = 'tenant-a' AND id = 'repo-a'").run(repository.id);
      expect((await remove(fixture, repository.id, 1, "delete-parent")).status).toBe(409);
      expect(await listed(fixture)).toContain(repository.id);
      expect(native.deleted).toEqual([]);
    });

    it("AC7 a caller without repository.admin is refused and the repository remains", async () => {
      const native = nativeArtifactsFixture();
      const fixture = await makeFixture(["repository.read", "repository.write", "identity.read"], options(native));
      const repository = await created(fixture, "guarded");
      expect((await remove(fixture, repository.id, 1, "delete-guarded")).status).toBe(403);
      expect(await listed(fixture)).toContain(repository.id);
      expect(native.deleted).toEqual([]);
    });
  });

  it("denies native Artifacts provisioning for unauthorized callers and incomplete configuration", async () => {
    const native = nativeArtifactsFixture();
    const options = { GFY_GIT: native.binding, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_GIT_URL_BASE: "https://gitfoundry.test/git" };
    const denied = await makeFixture(["repository.read", "identity.read"], options);
    const init = { method: "POST", headers: await denied.headers(undefined, { "content-type": "application/json", "idempotency-key": "denied-native" }), body: JSON.stringify({ namespace_id: "namespace-a", name: "denied-native" }) };
    expect((await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", init), denied.env)).status).toBe(403);
    for (const base of ["", "invalid", "http://gitfoundry.test/git"]) {
      const fixture = await makeFixture(["repository.read", "repository.write", "identity.read"], { ...options, GFY_GIT_URL_BASE: base });
      const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { ...init, headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": "invalid-native" }) }), fixture.env);
      expect(response.status).toBe(503);
    }
    expect(native.created).toEqual([]);
    expect(native.revoked).toEqual([]);
  });

  it("resolves native Artifacts refs for REST and private MCP pull requests", async () => {
    const native = nativeArtifactsFixture();
    const fixture = await makeFixture(["repository.read", "repository.write", "pull_request.read", "pull_request.write", "identity.read"], {
      GFY_GIT: native.binding, GFY_GIT_NAMESPACE: "gitfoundry-staging", GFY_GIT_URL_BASE: "https://gitfoundry.test/git"
    });
    const created = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", {
      method: "POST", headers: await fixture.headers(undefined, { "idempotency-key": "native-pr-repo", "content-type": "application/json" }),
      body: JSON.stringify({ namespace_id: "namespace-a", name: "native-pr-repo" })
    }), fixture.env);
    expect(created.status).toBe(200);
    const repository = await created.json() as { id: string };
    const body = { repository_id: repository.id, source_repository_id: repository.id, source_ref: "feature", target_ref: "main", title: "Native refs PR" };
    const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/pull-requests", {
      method: "POST", headers: await fixture.headers(undefined, { "idempotency-key": "native-pr-rest", "content-type": "application/json" }), body: JSON.stringify(body)
    }), fixture.env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ head_sha: "a".repeat(40), base_sha: "b".repeat(40) });
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    const invoked = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({
      operation_id: "pr.create", arguments: { route: { tenant_id: "tenant-a" }, query: {}, body: { ...body, title: "Native refs MCP PR" } }, context, execution: { idempotency_key: "native-pr-mcp" }
    }) }));
    expect(invoked.status).toBe(200);
    await expect(invoked.json()).resolves.toMatchObject({ head_sha: "a".repeat(40), base_sha: "b".repeat(40) });
    expect(native.logCalls).toEqual([{ ref: "feature", limit: 1 }, { ref: "main", limit: 1 }, { ref: "feature", limit: 1 }, { ref: "main", limit: 1 }]);
    fixture.sql.db.prepare("UPDATE principals SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'").run();
    const denied = await api.default.fetch(request("/api/v1/tenants/tenant-a/pull-requests", {
      method: "POST", headers: await fixture.headers(undefined, { "idempotency-key": "native-pr-denied", "content-type": "application/json" }), body: JSON.stringify(body)
    }), fixture.env);
    expect(denied.status).toBe(403);
    expect(native.logCalls).toHaveLength(4);
  });

  it("creates and reads a repository through the configured Git provisioner", async () => {
    const provision = vi.fn(() => Effect.succeed({ gitUrl: "file:///local/tenant-a/new-repo.git", artifactsNamespace: "tenant-a", artifactsName: "new-repo" }));
    const fixture = await makeFixture(["repository.read", "repository.write", "identity.read"], { GFY_GIT_PROVISIONER: { provisionRepository: provision }, GFY_GIT_URL_BASE: "file:///local" });
    const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { method: "POST", headers: await fixture.headers(undefined, { "idempotency-key": "provisioned-create", "content-type": "application/json" }), body: JSON.stringify({ namespace_id: "namespace-a", name: "new-repo", default_branch: "main", visibility: "private" }) }), fixture.env);
    expect(response.status).toBe(200);
    expect(provision).toHaveBeenCalledExactlyOnceWith({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "new-repo", defaultBranch: "main", visibility: "private" });
    const repository = await response.json() as { id: string };
    const read = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/" + repository.id, { headers: await fixture.headers() }), fixture.env);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ tenant_id: "tenant-a", namespace_id: "namespace-a", name: "new-repo", default_branch: "main", visibility: "private", git_url: "file:///local/tenant-a/new-repo.git" });
  });

  it("authenticates and validates repo.create before returning explicit Git provisioner unavailable", async () => {
    const fixture = await makeFixture(["repository.read", "repository.write", "identity.read"]);
    const invalid = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { method: "POST", headers: await fixture.headers(undefined, { "idempotency-key": "bad-create", "content-type": "application/json" }), body: JSON.stringify({ namespace_id: "namespace-a", name: 12 }) }), fixture.env);
    expect(invalid.status).toBe(400);
    const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { method: "POST", headers: await fixture.headers(undefined, { "idempotency-key": "create-a", "content-type": "application/json" }), body: JSON.stringify({ namespace_id: "namespace-a", name: "new-repo" }) }), fixture.env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "gfy_git_provisioner_unavailable" });
  });

  it("serves live issue CRUD with scoped auth stale CAS and durable idempotency", async () => {
    const fixture = await makeFixture(["repository.read", "issue.read", "issue.write", "identity.read"]);
    const createHeaders = await fixture.headers(undefined, { "idempotency-key": "issue-create", "content-type": "application/json" });
    const first = await api.default.fetch(request("/api/v1/tenants/tenant-a/issues", { method: "POST", headers: createHeaders, body: JSON.stringify({ repository_id: "repo-a", title: "Issue A", body: "body" }) }), fixture.env);
    expect(first.status).toBe(200);
    const issue = await first.json() as { id: string; version: number; title: string };
    expect(issue).toMatchObject({ version: 1, title: "Issue A" });
    const replay = await api.default.fetch(request("/api/v1/tenants/tenant-a/issues", { method: "POST", headers: createHeaders, body: JSON.stringify({ repository_id: "repo-a", title: "Issue A", body: "body" }) }), fixture.env);
    expect(replay.headers.get("GitFoundry-Idempotent-Replay")).toBe("true");
    const conflict = await api.default.fetch(request("/api/v1/tenants/tenant-a/issues", { method: "POST", headers: createHeaders, body: JSON.stringify({ repository_id: "repo-a", title: "Different" }) }), fixture.env);
    expect(conflict.status).toBe(409);
    expect((await api.default.fetch(request(`/api/v1/tenants/tenant-a/issues/${issue.id}`, { headers: await fixture.headers() }), fixture.env)).status).toBe(200);
    const list = await api.default.fetch(request("/api/v1/tenants/tenant-a/issues?repository_id=repo-a", { headers: await fixture.headers() }), fixture.env);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ items: [{ id: issue.id }], has_more: false });
    const edited = await api.default.fetch(request(`/api/v1/tenants/tenant-a/issues/${issue.id}`, { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "1" }), body: JSON.stringify({ title: "Issue A edited" }) }), fixture.env);
    expect(edited.status).toBe(200);
    await expect(edited.json()).resolves.toMatchObject({ version: 2, title: "Issue A edited" });
    const stale = await api.default.fetch(request(`/api/v1/tenants/tenant-a/issues/${issue.id}`, { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "1" }), body: JSON.stringify({ title: "stale" }) }), fixture.env);
    expect(stale.status).toBe(409);
    const crossed = await api.default.fetch(request(`/api/v1/tenants/tenant-b/issues/${issue.id}`, { headers: await fixture.headers() }), fixture.env);
    expect(crossed.status).toBe(403);
  });

  it("keeps PR creation unavailable until refs are resolved by a qualified Git read port", async () => {
    const unavailable = await makeFixture(["repository.read", "pull_request.read", "pull_request.write", "identity.read"]);
    const create = { repository_id: "repo-a", source_repository_id: "repo-a", source_ref: "feature", target_ref: "main", title: "PR A", draft: true };
    const missing = await api.default.fetch(request("/api/v1/tenants/tenant-a/pull-requests", { method: "POST", headers: await unavailable.headers(undefined, { "content-type": "application/json" }), body: JSON.stringify(create) }), unavailable.env);
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({ error: "gfy_git_reference_unavailable" });
    const fixture = await makeFixture(["repository.read", "pull_request.read", "pull_request.write", "identity.read"], { GFY_GIT_READ: { resolveRef: ({ ref }) => Effect.succeed({ sha: ref === "feature" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }) } });
    const response = await api.default.fetch(request("/api/v1/tenants/tenant-a/pull-requests", { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json" }), body: JSON.stringify(create) }), fixture.env);
    expect(response.status).toBe(200);
    const pr = await response.json() as { id: string; head_sha: string; base_sha: string; draft: boolean };
    expect(pr).toMatchObject({ head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", base_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", draft: true });
    const view = await api.default.fetch(request(`/api/v1/tenants/tenant-a/pull-requests/${pr.id}`, { headers: await fixture.headers() }), fixture.env);
    expect(view.status).toBe(200);
  });

  describe("operator repository load check", () => {
    const operator = { GFY_QUALIFIER_CLIENT_ID: "operator-client", GFY_QUALIFIER_CLIENT_SECRET: "operator-secret-0123456789abcdef", GFY_SOURCE_REVISION: "f".repeat(40), GFY_RUNNER_TENANT_ID: "tenant-a", GFY_RUNNER_REPOSITORY_ID: "repo-a" } as Partial<Env>;
    const operatorHeaders = { "x-gitfoundry-operator-client-id": "operator-client", "x-gitfoundry-operator-secret": "operator-secret-0123456789abcdef", "X-GitFoundry-Expected-Revision": "f".repeat(40) };
    const check = (env: Env, headers: Record<string, string> = operatorHeaders) => api.default.fetch(request("/_operator/qualify/repository", { method: "POST", headers }), env);
    const treePage = { items: [{ path: "README.md", path_base64: null, mode: "100644" as const, kind: "blob" as const, sha: "c".repeat(40), size_bytes: 12 }, { path: "src", path_base64: null, mode: "040000" as const, kind: "tree" as const, sha: "d".repeat(40), size_bytes: null }], next_cursor: null, has_more: false, repository_id: "repo-a", resolved_sha: rootForgeCode, tree_sha: "b".repeat(40), truncated: false, truncation_reason: null };
    const sourceWith = (tree: (input: { ref: string }) => unknown) => ({ tree, diff: () => Effect.die("unused"), readFile: () => Effect.die("unused") }) as unknown as NonNullable<Env["GFY_SOURCE_READ"]>;
    const initialized = async (overrides: Partial<Env>) => {
      const fixture = await makeFixture(["identity.read", "repository.read", "forge.initialize", "forge.read"], { GFY_FORGE_GIT: new ApiForkGitPort(), ...operator, ...overrides });
      const root = await api.default.fetch(request("/api/v2/tenants/tenant-a/repositories/repo-a/forge/initialize", { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json", "idempotency-key": "init" }), body: JSON.stringify({ code_commit: rootForgeCode }) }), fixture.env);
      expect(root.status).toBe(200);
      return { fixture, head: ((await root.json()) as { version: { version_commit: string } }).version.version_commit };
    };

    it("reads the canonical repository's head, versions, and source tree", async () => {
      const refs: string[] = [];
      const { fixture, head } = await initialized({ GFY_SOURCE_READ: sourceWith((input) => (refs.push(input.ref), Effect.succeed(treePage))) });
      const response = await check(fixture.env);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ repository_id: "repo-a", head_version_commit: head, code_commit: rootForgeCode, versions: 1, tree_entries: 2 });
      expect(refs).toEqual([rootForgeCode]);
    });

    it("names the head stage and the helper's failure when the forge cannot be read", async () => {
      const { CloudForgeGitError } = await import("./fork-forge/cloud-git.js");
      const failing = new ApiForkGitPort();
      failing.readRef = async () => { throw new CloudForgeGitError("trusted_execution_failed", "trusted forge git helper unavailable", undefined, { helper_status: 500, helper_error: "gfy_linux_container_start_failed" }) };
      const fixture = await makeFixture(["identity.read"], { GFY_FORGE_GIT: failing, ...operator, GFY_SOURCE_READ: sourceWith(() => Effect.succeed(treePage)) });
      const response = await check(fixture.env);
      expect(response.status).toBe(503);
      const body = await response.json() as { stage: string; cause: unknown };
      expect(body.stage).toBe("head");
      expect(JSON.stringify(body.cause)).toContain("500");
      expect(JSON.stringify(body.cause)).toContain("gfy_linux_container_start_failed");
    });

    it("shows the forge head's code when the code view asks for the repository's default branch", async () => {
      const refs: string[] = [];
      const { fixture } = await initialized({ GFY_SOURCE_READ: sourceWith((input) => (refs.push(input.ref), Effect.succeed(treePage))) });
      const headers = await fixture.headers();
      const read = (ref: string) => api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a/tree?ref=" + ref + "&recursive=true&limit=1000", { headers }), fixture.env);
      expect((await read("main")).status).toBe(200);
      expect((await read("feature")).status).toBe(200);
      expect(refs).toEqual([rootForgeCode, "feature"]);
    });

    it("reports a forge with no head version instead of failing on it", async () => {
      const fixture = await makeFixture(["identity.read"], { GFY_FORGE_GIT: new ApiForkGitPort(), ...operator, GFY_SOURCE_READ: sourceWith(() => Effect.succeed(treePage)) });
      const response = await check(fixture.env);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ stage: "head", cause: { code: "no_head_version" } });
    });

    it("names the tree stage and the source read failure when the code cannot be read", async () => {
      const { SourceReadUnavailableError } = await import("./source-read.js");
      const { fixture } = await initialized({ GFY_SOURCE_READ: sourceWith(() => Effect.fail(new SourceReadUnavailableError({ code: "unsupported", reason: "provider tree capability unavailable", repositoryId: "repo-a" }))) });
      const response = await check(fixture.env);
      expect(response.status).toBe(503);
      const body = await response.json() as { stage: string; cause: unknown };
      expect(body.stage).toBe("tree");
      expect(JSON.stringify(body.cause)).toContain("unsupported");
      expect(JSON.stringify(body.cause)).toContain("provider tree capability unavailable");
    });

    it("refuses a request without an operator credential before reading the forge", async () => {
      let reads = 0;
      const port = new ApiForkGitPort();
      const readRef = port.readRef.bind(port);
      port.readRef = async (ref) => { reads += 1; return readRef(ref) };
      const fixture = await makeFixture(["identity.read"], { GFY_FORGE_GIT: port, ...operator, GFY_SOURCE_READ: sourceWith(() => Effect.succeed(treePage)) });
      const response = await check(fixture.env, { "X-GitFoundry-Expected-Revision": "f".repeat(40) });
      expect(response.status).toBe(401);
      expect(reads).toBe(0);
    });
  });

  it("serves authenticated source tree diff and source-file endpoints through REST and private MCP", async () => {
    const calls: unknown[] = [];
    const source = {
      tree: (input: unknown) => Effect.succeed((calls.push({ kind: "tree", input }), { items: [{ path: "README.md", path_base64: null, mode: "100644" as const, kind: "blob" as const, sha: "c".repeat(40), size_bytes: 12 }], next_cursor: null, has_more: false, repository_id: "repo-a", resolved_sha: "a".repeat(40), tree_sha: "b".repeat(40), truncated: false, truncation_reason: null })),
      diff: (input: unknown) => Effect.succeed((calls.push({ kind: "diff", input }), { items: [{ old_path: "README.md", new_path: "README.md", old_sha: "c".repeat(40), new_sha: "d".repeat(40), change: "modified" as const, old_mode: "100644", new_mode: "100644", binary: false, additions: 1, deletions: 0, similarity_percent: null, hunks: [{ old_start: 1, old_count: 1, new_start: 1, new_count: 2, header: "", lines: [{ kind: "context" as const, old_line: 1, new_line: 1, text: "hello", has_newline: true }, { kind: "addition" as const, old_line: null, new_line: 2, text: "world", has_newline: true }] }], truncated: false }], next_cursor: null, has_more: false, repository_id: "repo-a", base_sha: "a".repeat(40), head_sha: "b".repeat(40), merge_base_shas: [], algorithm_version: "test-v1", diff_digest: "e".repeat(64), truncated: false, truncation_reason: null })),
      readFile: (input: unknown) => Effect.succeed((calls.push({ kind: "file", input }), { repository_id: "repo-a", resolved_sha: "a".repeat(40), path: "README.md", sha: "c".repeat(40), size_bytes: 12, encoding: "utf-8" as const, contents: "hello world\n", truncated: false }))
    };
    const fixture = await makeFixture(["repository.read", "identity.read"], { GFY_SOURCE_READ: source });
    const tree = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a/tree?ref=" + "a".repeat(40) + "&path=&recursive=true&limit=1000", { headers: await fixture.headers() }), fixture.env);
    expect(tree.status).toBe(200);
    await expect(tree.json()).resolves.toMatchObject({ repository_id: "repo-a", items: [{ path: "README.md" }], resolved_sha: "a".repeat(40) });
    const file = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a/source-file?ref=" + "a".repeat(40) + "&path=README.md", { headers: await fixture.headers() }), fixture.env);
    expect(file.status).toBe(200);
    await expect(file.json()).resolves.toMatchObject({ repository_id: "repo-a", path: "README.md", encoding: "utf-8", contents: "hello world\n" });
    const invalidFile = await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a/source-file?ref=main&path=../README.md", { headers: await fixture.headers() }), fixture.env);
    expect(invalidFile.status).toBe(400);
    const denied = await makeFixture(["identity.read"], { GFY_SOURCE_READ: source });
    expect((await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories/repo-a/tree?ref=" + "a".repeat(40), { headers: await denied.headers() }), denied.env)).status).toBe(403);
    expect(calls).toHaveLength(2);

    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization: (await fixture.headers()).authorization }) }));
    const context = await identity.json();
    const invoked = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "repo.diff", arguments: { route: { tenant_id: "tenant-a", id: "repo-a" }, query: { base: "a".repeat(40), head: "b".repeat(40), comparison: "two_dot", context_lines: 1 } }, context, execution: {} }) }));
    expect(invoked.status).toBe(200);
    await expect(invoked.json()).resolves.toMatchObject({ repository_id: "repo-a", items: [{ new_path: "README.md", additions: 1 }] });
    expect(calls.at(-1)).toMatchObject({ kind: "diff", input: { tenantId: "tenant-a", repositoryId: "repo-a", comparison: "two_dot", contextLines: 1 } });
  });

  it("R15 refuses a Cloudflare Access user token in place of a sign-in", async () => {
    const fixture = await makeFixture(["repository.read", "identity.read"]);
    const accessShaped = `${encode({ alg: "RS256", kid: "kid-a" })}.${encode({ iss: "https://issuer.example", aud: "public-audience", sub: "cf-access-sub-a", exp: 9999999999 })}.c2lnbmF0dXJl`;
    for (const headers of [{ authorization: `Bearer ${accessShaped}` }, { "cf-access-jwt-assertion": accessShaped }]) {
      expect((await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { headers }), fixture.env)).status).toBe(401);
    }
    expect((await api.default.fetch(request("/api/v1/tenants/tenant-a/repositories", { headers: await fixture.headers() }), fixture.env)).status).toBe(200);
  });

  it("serves public source auth.whoami from a sign-in and keeps private prefixes denied", async () => {
    const fixture = await makeFixture(["identity.read", "repository.read"], { ASSETS: { fetch: async () => new Response("asset-ok") } });
    const whoami = await api.default.fetch(request("/api/v1/tenants/tenant-a/auth/whoami", { headers: await fixture.headers() }), fixture.env);
    expect(whoami.status).toBe(200);
    await expect(whoami.json()).resolves.toEqual({ tenant_id: "tenant-a", principal_id: "principal-a", kind: "human", policy_epoch: 1, scopes: ["identity.read", "repository.read"] });
    const asset = await api.default.fetch(request("/"), fixture.env);
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toBe("asset-ok");
    expect((await api.default.fetch(request("/invoke", { method: "POST", headers: await fixture.headers(), body: "{}" }), fixture.env)).status).toBe(404);
  });

  it("serves the real AgentApi class identity and invoke port with split identity and operation grants", async () => {
    const fixture = await makeFixture(["identity.read"]);
    const timestamp = now.toISOString();
    fixture.sql.db.prepare("INSERT INTO roles VALUES(?,?,?,?,?,?,?)").run("tenant-a", "role-issue", 1, timestamp, timestamp, "issue-writer", JSON.stringify(["issue.write"]));
    fixture.sql.db.prepare("INSERT INTO owner_access_grants(tenant_id,id,principal_id,resource_kind,resource_id,role_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)").run("tenant-a", "grant-issue", "principal-a", "tenant", "tenant-a", "role-issue", "2999-01-01T00:00:00.000Z", timestamp);
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const userAuthorization = (await fixture.headers()).authorization;
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization }) }));
    expect(identity.status).toBe(200);
    const verified = await identity.json() as { tenant_id: string; principal_id: string; grant_ref: string; policy_epoch: number };
    expect(verified.grant_ref).toBe("workspace-grant-a");
    const invoked = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "issue.create", arguments: { route: { tenant_id: "tenant-a" }, query: {}, body: { repository_id: "repo-a", title: "Split grant issue" } }, context: verified, execution: { idempotency_key: "split-issue" } }) }));
    expect(invoked.status).toBe(200);
    const crossTenant = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "issue.create", arguments: { route: { tenant_id: "tenant-b" }, query: {}, body: { repository_id: "repo-a", title: "bad" } }, context: verified, execution: {} }) }));
    expect(crossTenant.status).toBe(403);
    fixture.sql.db.prepare("UPDATE tenants SET policy_epoch = 2 WHERE id = 'tenant-a'").run();
    const stale = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "issue.create", arguments: { route: { tenant_id: "tenant-a" }, query: {}, body: { repository_id: "repo-a", title: "stale" } }, context: verified, execution: {} }) }));
    expect(stale.status).toBe(403);
  });

  it("denies private invoke when identity grant is current but operation grant is missing", async () => {
    const fixture = await makeFixture(["identity.read"]);
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const userAuthorization = (await fixture.headers()).authorization;
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization }) }));
    const verified = await identity.json() as { tenant_id: string; principal_id: string; grant_ref: string; policy_epoch: number };
    const denied = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "issue.create", arguments: { route: { tenant_id: "tenant-a" }, query: {}, body: { repository_id: "repo-a", title: "Denied" } }, context: verified, execution: {} }) }));
    expect(denied.status).toBe(403);
  });

  it("revalidates current directory membership during private invoke", async () => {
    const fixture = await makeFixture(["identity.read", "issue.write"]);
    const entrypoint = new api.AgentApi({} as ExecutionContext, fixture.env);
    const userAuthorization = (await fixture.headers()).authorization;
    const identity = await entrypoint.fetch(request("/identity", { method: "POST", body: JSON.stringify({ requested_tenant_id: "tenant-a", userAuthorization }) }));
    expect(identity.status).toBe(200);
    const verified = await identity.json() as { tenant_id: string; principal_id: string; grant_ref: string; policy_epoch: number };
    fixture.sql.db.prepare("UPDATE principals SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'").run();
    const denied = await entrypoint.fetch(request("/invoke", { method: "POST", body: JSON.stringify({ operation_id: "issue.create", arguments: { route: { tenant_id: "tenant-a" }, query: {}, body: { repository_id: "repo-a", title: "Revoked directory member" } }, context: verified, execution: {} }) }));
    expect(denied.status).toBe(403);
    const row = fixture.sql.db.prepare("SELECT id FROM issues WHERE tenant_id = 'tenant-a' AND title = 'Revoked directory member'").get();
    expect(row).toBeUndefined();
  });


  it("serves live comment and review metadata with source-shaped outputs and CAS", async () => {
    const fixture = await makeFixture(["identity.read", "issue.read", "issue.write", "pull_request.read", "pull_request.write", "comment.read", "comment.write", "review.read", "review.write"], { GFY_GIT_READ: { resolveRef: ({ ref }) => Effect.succeed({ sha: ref === "feature" ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }) } });
    const issueResponse = await api.default.fetch(request("/api/v1/tenants/tenant-a/issues", { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json" }), body: JSON.stringify({ repository_id: "repo-a", title: "Comment target" }) }), fixture.env);
    const issue = await issueResponse.json() as { id: string };
    const commentResponse = await api.default.fetch(request("/api/v1/tenants/tenant-a/comments", { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json" }), body: JSON.stringify({ repository_id: "repo-a", subject_kind: "issue", subject_id: issue.id, body: "first", anchor: { line: 1 } }) }), fixture.env);
    expect(commentResponse.status).toBe(200);
    const comment = await commentResponse.json() as { id: string; version: number; anchor: Record<string, unknown> };
    expect(comment).toMatchObject({ version: 1, anchor: { line: 1 } });
    const editedComment = await api.default.fetch(request(`/api/v1/tenants/tenant-a/comments/${comment.id}`, { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "1" }), body: JSON.stringify({ body: "second" }) }), fixture.env);
    expect(editedComment.status).toBe(200);
    await expect(editedComment.json()).resolves.toMatchObject({ version: 2, body: "second" });
    const staleComment = await api.default.fetch(request(`/api/v1/tenants/tenant-a/comments/${comment.id}`, { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "1" }), body: JSON.stringify({ body: "stale" }) }), fixture.env);
    expect(staleComment.status).toBe(409);
    const prResponse = await api.default.fetch(request("/api/v1/tenants/tenant-a/pull-requests", { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json" }), body: JSON.stringify({ repository_id: "repo-a", source_repository_id: "repo-a", source_ref: "feature", target_ref: "main", title: "Review target" }) }), fixture.env);
    const pr = await prResponse.json() as { id: string };
    const reviewResponse = await api.default.fetch(request("/api/v1/tenants/tenant-a/reviews", { method: "POST", headers: await fixture.headers(undefined, { "content-type": "application/json" }), body: JSON.stringify({ repository_id: "repo-a", pull_request_id: pr.id, body: "review" }) }), fixture.env);
    expect(reviewResponse.status).toBe(200);
    const review = await reviewResponse.json() as { id: string; head_sha: string; state: string };
    expect(review).toMatchObject({ head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", state: "pending" });
    const editedReview = await api.default.fetch(request(`/api/v1/tenants/tenant-a/reviews/${review.id}`, { method: "PATCH", headers: await fixture.headers(undefined, { "content-type": "application/json", "if-match": "1" }), body: JSON.stringify({ body: "updated review" }) }), fixture.env);
    expect(editedReview.status).toBe(200);
    await expect(editedReview.json()).resolves.toMatchObject({ version: 2, body: "updated review" });
  });
});

function eligibilitySnapshot() {
  return { tenant_id: "tenant-a", pull_request_id: "pr-a", pr_version: 1, id: "elig-a", status: "blocked", head_sha: "a".repeat(40), base_sha: "b".repeat(40), candidate_sha: "c".repeat(40), method: "merge", diff_digest: "d".repeat(64), policy_digest: "e".repeat(64), policy_epoch: 1, expires_at: "2026-10-08T00:10:00.000Z", blockers: [{ code: "provider_unqualified", resource_id: null, detail: "Publication evidence is unavailable.", required_action: "pr.eligibility" }], reviews: [], checks: [] };
}

const nativeHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const nativeBaseSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const nativeCandidateSha = "cccccccccccccccccccccccccccccccccccccccc";
const nativeTreeSha = "dddddddddddddddddddddddddddddddddddddddd";
const nativePolicyDigest = nativeSha("policy");
const nativePlanDigest = nativeSha("plan");
const nativeReviewedDiffDigest = nativeSha("reviewed-diff");
const nativeExpiresAt = "2099-10-09T00:10:00.000Z";
const nativeCompletedAt = "2026-10-08T00:02:00.000Z";
const nativeObservedRules = [{ id: "ruleset-a", version: 1, priority: 1, enabled: 1 as const, rules_json: "{}" }];

function installNativeJobSchema(db: DatabaseSync): void {
  db.exec(readFileSync(new URL("../../../infra/migrations/0003_pr_eligibility.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../infra/migrations/0004_pr_eligibility_finalization.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../infra/migrations/0005_candidate_jobs.sql", import.meta.url), "utf8"));
}

async function seedCompletedNativeJob(sql: SqliteD1, options: { readonly producerId?: string } = {}) {
  const lifecycle = await seedScheduledNativeJob(sql, options);
  const inProgressToken = await lifecycle.store.start({ ...lifecycle.input, jobId: lifecycle.scheduled.jobId, attemptId: lifecycle.scheduled.attemptId, attemptGeneration: lifecycle.scheduled.attemptGeneration, fenceToken: lifecycle.scheduled.fenceToken });
  const token = await lifecycle.store.finalize({ ...lifecycle.input, jobId: lifecycle.scheduled.jobId, attemptId: lifecycle.scheduled.attemptId, attemptGeneration: lifecycle.scheduled.attemptGeneration, fenceToken: lifecycle.scheduled.fenceToken, now: nativeCompletedAt, terminalStatus: "completed", exitCode: 0, providerEvidenceRef: "r2://logs/attempt-a", logSha256: nativeSha("log"), logBytes: 123 });
  return { ...lifecycle, inProgressToken, token };
}

async function seedScheduledNativeJob(sql: SqliteD1, options: { readonly producerId?: string } = {}) {
  const { makeD1NativeJobStore } = await import("./native-jobs/store.js");
  const producerId = options.producerId ?? "principal-a";
  if (producerId !== "principal-a") sql.db.prepare("INSERT OR IGNORE INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", producerId, 1, now.toISOString(), now.toISOString(), "service", producerId, 1, 1);
  seedNativeEligibility(sql, producerId);
  const input = nativeScheduleInput(producerId);
  const store = makeD1NativeJobStore(sql, nativeIds());
  const scheduled = await store.schedule(input);
  const row = sql.db.prepare("SELECT token_json FROM native_candidate_check_qualification_tokens WHERE tenant_id = ? AND job_attempt_id = ? AND status = 'queued' LIMIT 1").get("tenant-a", scheduled.attemptId) as { token_json: string } | undefined;
  if (!row) throw new Error("expected queued native candidate check qualification token");
  return { input, store, scheduled, queuedToken: JSON.parse(row.token_json) as { readonly id: string; readonly fenceToken: string; readonly providerEvidenceRef: string; readonly jobAttemptId: string; readonly status: "queued"; readonly conclusion: null } };
}

function seedNativeEligibility(sql: SqliteD1, producerId: string): void {
  const timestamp = now.toISOString();
  sql.db.prepare("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "issue-native-a", 5, timestamp, timestamp, "repo-a", 1, "PR", "Body", "open", "", "principal-a", "pull_request");
  sql.db.prepare("INSERT INTO pull_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-native-a", 3, timestamp, timestamp, "issue-native-a", "repo-a", "repo-a", "refs/heads/topic", "refs/heads/main", nativeHeadSha, nativeBaseSha, 0, null, null, null);
  sql.db.prepare("INSERT INTO rulesets VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "ruleset-a", 1, timestamp, timestamp, "repo-a", 1, "{}", 1);
  sql.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "eligibility-native-a", 1, timestamp, timestamp, "pr.eligibility.prepare", producerId, "complete", "{}", `json:${JSON.stringify(nativeEligibilityOperationResult())}`, null);
  sql.db.prepare("INSERT INTO pr_eligibility_active VALUES(?,?,?,?,?,?,?)").run("tenant-a", "pr-native-a", "eligibility-native-key", "eligibility-native-a", 1, nativeExpiresAt, timestamp);
  sql.db.prepare("INSERT INTO pr_eligibility_generations(tenant_id,pull_request_id,operation_id,logical_key,generation,actor_id,state,created_at,updated_at,expires_at,committed_at,head_sha,base_sha,method,policy_digest,progress_json,snapshot_json,error_json,finalization_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-native-a", "eligibility-native-a", "eligibility-native-key", 1, producerId, "complete", timestamp, timestamp, nativeExpiresAt, timestamp, nativeHeadSha, nativeBaseSha, "merge", nativePolicyDigest, JSON.stringify({ observedRuleRows: nativeObservedRules }), JSON.stringify({ id: "eligibility-native-a", candidate_sha: nativeCandidateSha }), null, "eligibility-native-nonce");
  sql.db.prepare("INSERT INTO eligibility VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "eligibility-native-a", 1, timestamp, timestamp, "repo-a", "pr-native-a", nativeHeadSha, nativeBaseSha, nativeCandidateSha, 1, JSON.stringify({ id: "eligibility-native-a", candidate_sha: nativeCandidateSha }), nativeExpiresAt);
}

function nativeScheduleInput(producerId: string) {
  return { tenantId: "tenant-a", producerId, producerAuthEpoch: 1, tenantPolicyEpoch: 1, now: now.toISOString(), expiresAt: nativeExpiresAt, context: "ci/build", command: ["/bin/sh", "-lc", ".gitfoundry/ci.sh"] as const, imageDigest: `sha256:${nativeSha("native-image")}`, sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", pullRequestId: "pr-native-a", pullRequestVersion: 3, issueVersion: 5, eligibilityOperationId: "eligibility-native-a", eligibilityGeneration: 1, candidateSha: nativeCandidateSha, headSha: nativeHeadSha, baseSha: nativeBaseSha, candidateTreeSha: nativeTreeSha, policyDigest: nativePolicyDigest, planDigest: nativePlanDigest, reviewedDiffDigest: nativeReviewedDiffDigest, candidateArtifacts: nativeArtifacts(), observedRuleRows: nativeObservedRules };
}

function nativeCandidateCheckBody(token: { readonly jobAttemptId: string; readonly status?: "queued" | "in_progress" | "completed"; readonly conclusion: string | null }) {
  return { repository_id: "repo-a", commit_sha: nativeCandidateSha, head_sha: nativeHeadSha, base_sha: nativeBaseSha, execution_sha: nativeCandidateSha, plan_digest: `sha256:${nativePlanDigest}`, policy_digest: `sha256:${nativePolicyDigest}`, job_attempt_id: token.jobAttemptId, evidence_kind: "native_job", candidate_bound: true, provider_evidence_ref: null, name: "ci/build", status: token.status ?? "completed", conclusion: token.conclusion, details_url: "https://checks.example/native/attempt-a", output: { title: "build", summary: token.status === "in_progress" ? "running" : token.status === "queued" ? "queued" : "passed", text: null }, annotations: [] };
}

function nativeCheckPatchBody(token: { readonly status: "queued" | "in_progress" | "completed"; readonly conclusion: string | null }) {
  return { status: token.status, conclusion: token.conclusion, details_url: "https://checks.example/native/attempt-a", output: { title: "build", summary: token.status === "in_progress" ? "running" : token.status === "queued" ? "queued" : token.conclusion === "success" ? "passed" : "failed", text: null }, annotations_append: [] };
}

function nativeArtifacts() {
  const requestSha256 = nativeSha("candidate-request");
  return { manifest: nativeLocator(requestSha256, "candidate_manifest", nativeSha("manifest"), 345), rawCommit: nativeLocator(requestSha256, "candidate_raw_commit", nativeSha("raw"), 456), pack: nativeLocator(requestSha256, "candidate_pack", nativeSha("pack"), 567) };
}

function nativeLocator(requestSha256: string, kind: "candidate_manifest" | "candidate_raw_commit" | "candidate_pack", sha256: string, sizeBytes: number) {
  return { tenantId: "tenant-a", repositoryId: "repo-a", operationId: "eligibility-native-a", requestSha256, kind, sha256, sizeBytes, key: `v1/tenants/tenant-a/repositories/repo-a/merge-operations/eligibility-native-a/${requestSha256}/${kind}`, etag: `etag-${kind}`, version: `version-${kind}`, expiresAt: null };
}

function nativeEligibilityOperationResult() {
  const artifacts = nativeArtifacts();
  return { snapshot: { id: "eligibility-native-a", candidate_sha: nativeCandidateSha }, candidate: { requestSha256: artifacts.manifest.requestSha256, result: { candidateOid: nativeCandidateSha, candidateTree: nativeTreeSha, candidateBytesSha256: artifacts.rawCommit.sha256 }, ...artifacts }, checkPlan: { plan: { tenantId: "tenant-a", sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", pullRequestId: "pr-native-a", pullRequestVersion: 3, headOid: nativeHeadSha, baseOid: nativeBaseSha, candidateOid: nativeCandidateSha, candidateTreeOid: nativeTreeSha, policyDigest: nativePolicyDigest }, planDigest: nativePlanDigest }, reviewedDiff: { patchSha256: nativeReviewedDiffDigest }, source: { tenantId: "tenant-a", sourceRepositoryId: "repo-a", targetRepositoryId: "repo-a", headSha: nativeHeadSha, baseSha: nativeBaseSha }, exposedIssueVersion: 5, internalPrRevision: 3, generation: 1 };
}

function nativeIds() { let token = 0; let nonce = 0; return { newRunId: () => "run-native-a", newJobId: () => "job-native-a", newAttemptId: () => "attempt-native-a", newFenceToken: () => "fence-native-a", newTokenId: () => `token-native-${["a", "b", "c", "d"][token++] ?? token}`, newNonce: () => `nonce-native-${["a", "b", "c", "d"][nonce++] ?? nonce}` }; }
function nativeSha(value: string): string { return createHash("sha256").update(value).digest("hex"); }

async function makeFixture(capabilities = ["repository.read", "identity.read"], overrides: Partial<Env> = {}) {
  const sql = new SqliteD1();
  installSchema(sql.db);
  seed(sql.db, capabilities);
  const env: Env = { GFY_AUTH_ISSUER: "https://issuer.example", GFY_AUTH_AUDIENCE: "public-audience", GFY_MCP_AUTH_AUDIENCE: "mcp-audience", GFY_AUTH_JWKS_URL: "https://issuer.example/cdn-cgi/access/certs", GFY_DB: sql, clock: { now: () => now }, ...overrides };
  // Signs principal-a in the way gfy login does and returns its bearer header.
  const token = async (principalId = "principal-a", tenantId = "tenant-a") => {
    const value = "gfys_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    sql.db.prepare("INSERT INTO auth_browser_sessions(token_hash,email,tenant_id,principal_id,created_at,expires_at) VALUES(?,?,?,?,?,?)").run(createHash("sha256").update(value).digest("hex"), principalId + "@example.com", tenantId, principalId, now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
    return value;
  };
  return { sql, env, token, headers: async (_unused?: unknown, extra?: Record<string, string>) => ({ authorization: `Bearer ${await token()}`, ...extra }) };
}

function cleanClaims(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined)) }
function defaultClaims(env: Env, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> { const audience = overrides.aud ?? env.GFY_AUTH_AUDIENCE; return cleanClaims({ iss: env.GFY_AUTH_ISSUER, aud: audience, sub: "cf-access-sub-a", exp: Math.floor(now.getTime() / 1000) + 3600, cf_account_id: "cf-account-a", gfy_connection_id: audience === env.GFY_MCP_AUTH_AUDIENCE ? "conn-a-mcp" : "conn-a-public", directory_subject: "directory-subject-a", ...overrides }) }
function installSchema(db: DatabaseSync) { for (const file of ["../../../docs/source/handoff/contracts/schema.sql", "../../../infra/migrations/0007_owner_access.sql", "../../../infra/migrations/0008_resource_events.sql", "../../../infra/migrations/0012_email_sign_in.sql"]) db.exec(readFileSync(new URL(file, import.meta.url), "utf8")); }
function seed(db: DatabaseSync, capabilities: string[]) { const timestamp = now.toISOString(); db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 1, "shard-a", "US", "{}"); db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run("tenant-b", "tenant-b", "active", 1, "shard-b", "US", "{}"); db.prepare("INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "conn-a", 1, timestamp, timestamp, "https://issuer.example", "access", "public-audience", qualifiedConnectionClaims("conn-a-public"), 1); db.prepare("INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "conn-mcp", 1, timestamp, timestamp, "https://issuer.example", "mcp-access", "mcp-audience", qualifiedConnectionClaims("conn-a-mcp"), 1); db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-a", 1, timestamp, timestamp, "human", "Principal A", 1, 1); db.prepare("INSERT INTO identity_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "link-a", 1, timestamp, timestamp, "principal-a", "conn-a", "https://issuer.example", "directory-subject-a", "directory", "directory-user-a", 1); db.prepare("INSERT INTO identity_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "link-mcp", 1, timestamp, timestamp, "principal-a", "conn-mcp", "https://issuer.example", "directory-subject-a", "directory", "directory-user-a", 1); db.prepare("INSERT INTO directory_members VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "member-a", 1, timestamp, timestamp, "conn-a", "directory-user-a", "principal-a", 1, "[]"); db.prepare("INSERT INTO directory_members VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "member-mcp", 1, timestamp, timestamp, "conn-mcp", "directory-user-a", "principal-a", 1, "[]"); db.prepare("INSERT INTO roles VALUES(?,?,?,?,?,?,?)").run("tenant-a", "role-a", 1, timestamp, timestamp, "reader", JSON.stringify(capabilities)); db.prepare("INSERT INTO grants VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "grant-a", 1, timestamp, timestamp, "service", "principal-a", "tenant", "tenant-a", "role-a", null); db.prepare("INSERT INTO owner_access_grants(tenant_id,id,principal_id,resource_kind,resource_id,role_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)").run("tenant-a", "workspace-grant-a", "principal-a", "tenant", "tenant-a", "role-a", "2999-01-01T00:00:00.000Z", timestamp); db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run("tenant-a", "namespace-a", 1, timestamp, timestamp, "namespace-a", "Namespace A"); db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 1, timestamp, timestamp, "namespace-a", "demo", "private", "main", 0, "tenant-a", "repo-a", null); db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "op-a", 1, timestamp, timestamp, "repo.import", "principal-a", "running", "{}", null, null) }
function qualifiedConnectionClaims(marker: string): string { return JSON.stringify({ identity_qualified: true, provider_account_claim: "cf_account_id", provider_account_id: "cf-account-a", connection_marker_claim: "gfy_connection_id", connection_marker: marker, immutable_subject_claim: "directory_subject", max_subject_bytes: 256 }) }
async function makeKeys(): Promise<{ privateKey: CryptoKey; publicJwk: Jwk }> { const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]); const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as Jwk; return { privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid: "kid-a", alg: "RS256" } } }
async function signJwt(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> { const header = encode({ alg: "RS256", typ: "JWT", kid }); const payload = encode(claims); const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`)); return `${header}.${payload}.${base64Url(new Uint8Array(signature))}` }
function unsignedToken(): string { return `${encode({ alg: "none" })}.${encode({ iss: "https://issuer.example", aud: "public-audience", sub: "subject-a", exp: 9999999999 })}.` }
function encode(value: unknown): string { return base64Url(new TextEncoder().encode(JSON.stringify(value))) }
function base64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") }

function nativeArtifactsFixture() {
  const bootstrapToken = "native-bootstrap-sentinel";
  const created: string[] = [];
  const revoked: string[] = [];
  const logCalls: Array<{ ref?: string; limit?: number; offset?: number }> = [];
  const deleted: string[] = [];
  const info = new Map<string, import("./git-provider.js").WorkersArtifactsRepoInfo>();
  const binding: import("./git-provider.js").ArtifactsBinding = {
    create: async (name, options) => {
      created.push(name);
      const row = { id: "provider-" + name, name, description: null, defaultBranch: options?.setDefaultBranch ?? "main", createdAt: now.toISOString(), updatedAt: now.toISOString(), lastPushAt: null, source: null, readOnly: false, remote: "https://helper:" + bootstrapToken + "@artifacts.example/" + name + ".git" };
      info.set(name, row);
      return { id: row.id, name, description: null, defaultBranch: row.defaultBranch, remote: row.remote, token: bootstrapToken };
    },
    get: async (name) => {
      const row = info.get(name);
      if (!row) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      return { info: async () => row, log: async (options) => {
        logCalls.push(options ?? {});
        return [{ hash: options?.ref === "feature" ? "a".repeat(40) : "b".repeat(40), treeHash: "c".repeat(40), message: "fixture", author: { name: "Fixture", email: "fixture@example.invalid" }, committer: { name: "Fixture", email: "fixture@example.invalid" }, parents: [], authoredAt: 0, committedAt: 0 }];
      }, createToken: async () => { throw new Error("helper token not needed for provisioning") }, revokeToken: async (token) => { revoked.push(token); return true }, [Symbol.dispose]() {} };
    },
    list: async () => ({ repos: [], total: 0 }),
    delete: async (name) => { deleted.push(name); return info.delete(name) }
  };
  return { binding, created, revoked, bootstrapToken, logCalls, deleted };
}

const rootForgeCode = "a".repeat(40);

function base64Text(value: string): string { return Buffer.from(value, "utf8").toString("base64"); }
function base64Json(value: unknown): string { return base64Text(JSON.stringify(value)); }
function decodeBase64Json(value: string): Record<string, unknown> { return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, unknown>; }

type ApiForkStoredFile = { readonly content_base64: string; readonly mode: string };

function modeForChange(change: ForgeWriteCommitInput["changes"][number] & { readonly mode?: string }, existingMode: string | undefined): string {
  return change.mode ?? existingMode ?? "100644";
}

function sameStoredFile(left: ApiForkStoredFile | undefined, right: ApiForkStoredFile | undefined): boolean {
  return left?.content_base64 === right?.content_base64 && left?.mode === right?.mode;
}

class ApiForkGitPort implements ForgeGitPort {
  readonly refs = new Map<string, string | null>();
  readonly commits = new Map<string, { parents: readonly string[]; files: Map<string, ApiForkStoredFile> }>();
  private counter = 1;

  constructor(options: { readonly seedRoot?: boolean } = {}) {
    if (options.seedRoot !== false) this.commits.set(rootForgeCode, { parents: [], files: new Map([["README.md", { content_base64: base64Text("root"), mode: "100644" }]]) });
  }

  async readRef(ref: string): Promise<string | null> { return this.refs.get(ref) ?? null; }
  async listRefs(prefix: string): Promise<readonly { readonly ref: string; readonly target: string }[]> { return [...this.refs.entries()].filter((entry): entry is [string, string] => Boolean(entry[1]) && entry[0].startsWith(prefix)).sort(([left], [right]) => left.localeCompare(right)).map(([ref, target]) => ({ ref, target })); }
  async readFile(commit: string, path: string): Promise<string | null> { return this.commits.get(commit)?.files.get(path)?.content_base64 ?? null; }
  async listTree(commit: string, prefix = "") { return [...(this.commits.get(commit)?.files.entries() ?? [])].filter(([path]) => path.startsWith(prefix)).map(([path, file]) => ({ path, oid: this.previewSha(path), mode: file.mode, type: "blob" as const, size: file.content_base64.length })); }
  async writeCommit(input: ForgeWriteCommitInput): Promise<string> {
    const files = new Map(input.base ? this.commits.get(input.base)?.files : undefined);
    for (const change of input.changes) {
      if (change.content_base64 === null) files.delete(change.path);
      else files.set(change.path, { content_base64: change.content_base64, mode: modeForChange(change as ForgeWriteCommitInput["changes"][number] & { readonly mode?: string }, files.get(change.path)?.mode) });
    }
    const sha = this.nextSha();
    this.commits.set(sha, { parents: [...input.parents], files });
    return sha;
  }
  async compareCommits(base: string, head: string) {
    const baseFiles = this.commits.get(base)?.files ?? new Map<string, ApiForkStoredFile>();
    const headFiles = this.commits.get(head)?.files ?? new Map<string, ApiForkStoredFile>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    return { files: [...paths].sort().filter((path) => !sameStoredFile(baseFiles.get(path), headFiles.get(path))).map((path) => ({ path, status: !baseFiles.has(path) ? "added" as const : !headFiles.has(path) ? "deleted" as const : "modified" as const, old_oid: baseFiles.has(path) ? this.previewSha(`${path}:old`) : null, new_oid: headFiles.has(path) ? this.previewSha(`${path}:new`) : null })) };
  }
  async mergeCommits(input: ForgeMergeInput): Promise<ForgeMergeResult> { return { status: "merged", commit: await this.writeCommit({ base: input.left, parents: [input.left, input.right], changes: [], message: input.message, author: input.author, timestamp: input.timestamp }) }; }
  async compareAndSwapRef(ref: string, expected: string | null, next: string | null): Promise<boolean> {
    return this.compareAndSwapRefs([{ ref, expected, next }]);
  }
  async compareAndSwapRefs(updates: readonly { readonly ref: string; readonly expected: string | null; readonly next: string | null }[]): Promise<boolean> {
    if (updates.some((update) => (this.refs.get(update.ref) ?? null) !== update.expected)) return false;
    for (const update of updates) {
      if (update.next === null) this.refs.delete(update.ref); else this.refs.set(update.ref, update.next);
    }
    return true;
  }
  async isAncestor(base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    const seen = new Set<string>();
    const stack = [head];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === base) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(this.commits.get(current)?.parents ?? []));
    }
    return false;
  }
  private nextSha(): string { const sha = this.counter.toString(16).padStart(40, "0"); this.counter += 1; return sha; }
  private previewSha(value: string): string { return createHash("sha1").update(value).digest("hex"); }
}
