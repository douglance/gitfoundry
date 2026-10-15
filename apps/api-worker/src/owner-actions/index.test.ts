import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleOwnerActions, type OwnerActionsEnv, type OwnerActionsPorts, type OwnerActionRun, type OwnerRunReceipt } from "./index.js";

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  async batch(statements: readonly { run(): Promise<any> }[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  prepare(sql: string) {
    const database = this.db;
    return { values: [] as unknown[], bind(...values: unknown[]) { return { ...this, values } }, async first<T>() { return database.prepare(sql).get(...(this.values as SQLInputValue[])) as T | null }, async all<T>() { return { results: database.prepare(sql).all(...(this.values as SQLInputValue[])) as T[] } }, async run() { const result = database.prepare(sql).run(...(this.values as SQLInputValue[])); return { success: true, meta: { changes: Number(result.changes) } } } };
  }
}

const now = new Date("2026-10-09T14:00:00.000Z");
const tenant = "owner";
const repo = "gitfoundry";
const head = { version_commit: "a".repeat(40), code_commit: "b".repeat(40) };
const prior = { version_commit: "c".repeat(40), code_commit: "d".repeat(40) };
const runnerHeaders = { "X-GitFoundry-Operator-Client-Id": "runner-client", "X-GitFoundry-Operator-Secret": "runner-secret" };

let sql: SqliteD1;
let env: OwnerActionsEnv;
let ports: OwnerActionsPorts;
let deployAdmissions: number;
let recorded: Array<{ run: OwnerActionRun; receipt: OwnerRunReceipt; signature: string }>;

beforeEach(() => {
  sql = new SqliteD1();
  sql.db.exec(readFileSync(new URL("../../../../infra/migrations/0006_owner_actions.sql", import.meta.url), "utf8"));
  deployAdmissions = 0;
  recorded = [];
  env = { GFY_DB: sql, GFY_AUTH_ISSUER: "issuer", GFY_AUTH_AUDIENCE: "aud", GFY_AUTH_JWKS_URL: "https://issuer/certs", GFY_RUNNER_CLIENT_ID: "runner-client", GFY_RUNNER_CLIENT_SECRET: "runner-secret", GFY_RUNNER_TENANT_ID: tenant, GFY_RUNNER_REPOSITORY_ID: repo, GFY_RUNNER_ID: "runner-a", clock: { now: () => now } };
  ports = {
    authenticateOwner: vi.fn<OwnerActionsPorts["authenticateOwner"]>(async ({ request }) => request.headers.get("authorization") === "Bearer owner" ? { ok: true, actor_id: "owner" } : { ok: false, response: Response.json({ error: "denied" }, { status: 403 }) }),
    getForgeHead: vi.fn(async () => head),
    readVersion: vi.fn(async ({ version_commit }) => version_commit === prior.version_commit ? prior : null),
    verifyDeploymentAdmission: vi.fn(async () => { deployAdmissions += 1 }),
    checkoutGrant: vi.fn(async ({ run }) => ({ remote: "https://gitfoundry.dev/git/owner/gitfoundry.git", commit: run.code_commit, username: "runner", password: "ephemeral", expires_at: "2026-10-09T14:15:00.000Z" })),
    verifyReceipt: vi.fn(async ({ signature }) => signature === "valid-signature"),
    recordEvidence: vi.fn(async (input) => { recorded.push(input); return { evidence_ref: `evidence:${input.run.id}` } }),
    clock: { now: () => now },
    ids: { run: () => "run-a", lease: () => "lease-a", fence: () => "fence-a" }
  };
});

describe("owner actions runner API", () => {
  it("requires owner auth and makes operation ids semantic idempotency fences", async () => {
    const denied = await postRun({ kind: "all-tests", operation_id: "op-a" }, {});
    expect(denied.status).toBe(403);

    const first = await postRun({ kind: "all-tests", operation_id: "op-a", expected_head: head.version_commit });
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ run: { id: "run-a", kind: "all-tests", version_commit: head.version_commit, code_commit: head.code_commit, status: "queued", command: { argv: ["node", "scripts/test-all.mjs"] } } });

    vi.mocked(ports.getForgeHead).mockResolvedValue({ version_commit: "e".repeat(40), code_commit: "f".repeat(40) });
    const replay = await postRun({ kind: "all-tests", operation_id: "op-a", expected_head: head.version_commit });
    expect(replay.status).toBe(200);
    const conflict = await postRun({ kind: "deploy-production", operation_id: "op-a", expected_head: head.version_commit });
    expect(conflict.status).toBe(409);
  });

  it("leases only with runner credentials, fences stale completions, and records signed evidence", async () => {
    expect((await postRun({ kind: "all-tests", operation_id: "op-a" })).status).toBe(201);
    expect((await runnerPost("/_runner/leases/next", { operation_id: "lease-op" }, {})).status).toBe(401);

    const lease = await runnerPost("/_runner/leases/next", { operation_id: "lease-op" });
    expect(lease.status).toBe(200);
    const leased = await lease.json() as any;
    expect(leased).toMatchObject({ run_id: "run-a", lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", checkout: { password: "ephemeral" } });

    const stale = await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 2, fence_token: "fence-a", receipt: receipt("run-a"), signature: "valid-signature" });
    expect(stale.status).toBe(409);

    const forged = await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: receipt("run-a"), signature: "forged" });
    expect(forged.status).toBe(401);

    const completed = await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: receipt("run-a"), signature: "valid-signature" });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ run: { status: "completed", conclusion: "success", evidence_status: "recorded", evidence_ref: "evidence:run-a" } });
    expect(recorded).toHaveLength(1);

    const replay = await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: receipt("run-a"), signature: "valid-signature" });
    expect(replay.status).toBe(200);
    const conflict = await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: { ...receipt("run-a"), conclusion: "failure" }, signature: "valid-signature" });
    expect(conflict.status).toBe(409);
  });

  it("rechecks deploy admission before leasing and binds deploys to current head", async () => {
    const oldDeploy = await postRun({ kind: "deploy-production", operation_id: "deploy-old", version_commit: prior.version_commit, code_commit: prior.code_commit, expected_head: head.version_commit });
    expect(oldDeploy.status).toBe(409);

    const created = await postRun({ kind: "deploy-production", operation_id: "deploy-a", version_commit: head.version_commit, code_commit: head.code_commit, expected_head: head.version_commit });
    expect(created.status).toBe(201);
    const lease = await runnerPost("/_runner/leases/next", { operation_id: "lease-deploy" });
    expect(lease.status).toBe(200);
    expect(deployAdmissions).toBe(2);
    await expect(lease.json()).resolves.toMatchObject({ kind: "deploy-production", command: { argv: ["node", "scripts/gfy-cloudflare-deploy.mjs"] } });
  });

  it("recovers evidence recording on identical completion replay", async () => {
    let fail = true;
    ports = { ...ports, recordEvidence: vi.fn(async (input) => { recorded.push(input); if (fail) { fail = false; throw new Error("temporary evidence outage") } return { evidence_ref: "evidence:recovered" } }) };
    expect((await postRun({ kind: "all-tests", operation_id: "op-a" })).status).toBe(201);
    expect((await runnerPost("/_runner/leases/next", { operation_id: "lease-op" })).status).toBe(200);
    const first = await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: receipt("run-a"), signature: "valid-signature" });
    expect(first.status).toBe(503);
    const replay = await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: receipt("run-a"), signature: "valid-signature" });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ run: { evidence_status: "recorded", evidence_ref: "evidence:recovered" } });
  });
  it("admits at most one live job when two polls race", async () => {
    let id = 0;
    ports = { ...ports, ids: { run: () => "run-" + (++id), lease: () => "lease-a", fence: () => "fence-a" } };
    expect((await postRun({ kind: "all-tests", operation_id: "op-a" })).status).toBe(201);
    expect((await postRun({ kind: "all-tests", operation_id: "op-b" })).status).toBe(201);
    const replies = await Promise.all([
      runnerPost("/_runner/leases/next", { operation_id: "poll-a" }),
      runnerPost("/_runner/leases/next", { operation_id: "poll-b" })
    ]);
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM owner_action_runs WHERE status = 'in_progress'").get()?.count).toBe(1);
    expect((await runnerPost("/_runner/leases/next", { operation_id: "poll-c" })).status).toBe(204);
  });

  it("renews a live lease so a long test can finish after the original deadline", async () => {
    await postRun({ kind: "all-tests", operation_id: "op-a" });
    const original = await (await runnerPost("/_runner/leases/next", { operation_id: "poll-a" })).json() as any;
    ports = { ...ports, clock: { now: () => new Date("2026-10-09T14:14:00.000Z") } };
    const renewed = await runnerPost("/_runner/runs/run-a/heartbeat", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", phase: "running" });
    expect(renewed.status).toBe(200);
    const heartbeat = await renewed.json() as any;
    expect(Date.parse(heartbeat.lease_expires_at)).toBeGreaterThan(Date.parse(original.expires_at));
    ports = { ...ports, clock: { now: () => new Date("2026-10-09T14:16:00.000Z") } };
    expect((await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: receipt("run-a"), signature: "valid-signature" })).status).toBe(200);
  });

  it("rejects an expired lease before another runner reclaims it", async () => {
    await postRun({ kind: "all-tests", operation_id: "op-a" });
    await runnerPost("/_runner/leases/next", { operation_id: "poll-a" });
    ports = { ...ports, clock: { now: () => new Date("2026-10-09T14:16:00.000Z") } };
    expect((await runnerPost("/_runner/runs/run-a/heartbeat", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a" })).status).toBe(409);
    expect((await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: receipt("run-a"), signature: "valid-signature" })).status).toBe(409);
    expect(recorded).toHaveLength(0);
  });

  it("does not replace a stored signature while retrying a failed evidence write", async () => {
    ports = { ...ports, recordEvidence: vi.fn(async (input) => { recorded.push(input); throw new Error("sink unavailable"); }) };
    await postRun({ kind: "all-tests", operation_id: "op-a" });
    await runnerPost("/_runner/leases/next", { operation_id: "poll-a" });
    const body = { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: receipt("run-a"), signature: "valid-signature" };
    expect((await runnerPost("/_runner/runs/run-a/complete", body)).status).toBe(503);
    expect((await runnerPost("/_runner/runs/run-a/complete", { ...body, signature: "forged" })).status).toBe(409);
    expect(recorded).toHaveLength(1);
  });

  it("rejects malformed or oversized request bodies", async () => {
    const path = `https://gitfoundry.dev/api/v2/tenants/${tenant}/repositories/${repo}/actions/runs`;
    const malformed = await handleOwnerActions(new Request(path, { method: "POST", headers: { authorization: "Bearer owner" }, body: "{" }), env, ports);
    expect(malformed?.status).toBe(400);
    const oversized = await handleOwnerActions(new Request(path, { method: "POST", headers: { authorization: "Bearer owner" }, body: JSON.stringify({ padding: "x".repeat(65536) }) }), env, ports);
    expect(oversized?.status).toBe(413);
  });

  it("cannot report a passing result with a failed process exit", async () => {
    await postRun({ kind: "all-tests", operation_id: "op-a" });
    await runnerPost("/_runner/leases/next", { operation_id: "poll-a" });
    const response = await runnerPost("/_runner/runs/run-a/complete", { lease_id: "lease-a", lease_generation: 1, fence_token: "fence-a", receipt: { ...receipt("run-a"), exit_code: 1 }, signature: "valid-signature" });
    expect(response.status).toBe(400);
    expect(recorded).toHaveLength(0);
  });

});

async function postRun(body: Record<string, unknown>, headers: Record<string, string> = { authorization: "Bearer owner" }) {
  return handleOwnerActions(new Request(`https://gitfoundry.dev/api/v2/tenants/${tenant}/repositories/${repo}/actions/runs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env, ports) as Promise<Response>;
}
async function runnerPost(path: string, body: Record<string, unknown>, headers: Record<string, string> = runnerHeaders) {
  return handleOwnerActions(new Request(`https://gitfoundry.dev${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env, ports) as Promise<Response>;
}
function receipt(runId: string): OwnerRunReceipt {
  return { run_id: runId, kind: "all-tests", version_commit: head.version_commit, code_commit: head.code_commit, status: "completed", conclusion: "success", exit_code: 0, started_at: now.toISOString(), finished_at: now.toISOString(), stdout_sha256: digest("stdout"), stderr_sha256: digest(""), stdout_tail: "ok", stderr_tail: "" };
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex") }
