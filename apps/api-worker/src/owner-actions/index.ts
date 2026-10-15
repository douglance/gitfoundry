import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { D1DatabaseLike } from "../../../../packages/core/src/live/index.js";
import { verifyOperatorServiceRequest, type OperatorServiceAuthEnv } from "../auth/operator-service.js";

export type OwnerActionKind = "all-tests" | "deploy-production";
export type OwnerActionStatus = "queued" | "in_progress" | "completed";
export type OwnerActionConclusion = "success" | "failure";

export interface OwnerActionsEnv extends OperatorServiceAuthEnv {
  readonly GFY_DB?: D1DatabaseLike;
  readonly DB?: D1DatabaseLike;
  readonly GFY_RUNNER_CLIENT_ID?: string;
  readonly GFY_RUNNER_CLIENT_SECRET?: string;
  readonly GFY_RUNNER_TENANT_ID?: string;
  readonly GFY_RUNNER_REPOSITORY_ID?: string;
  readonly GFY_RUNNER_ID?: string;
}

export interface ForgeVersionRef { readonly version_commit: string; readonly code_commit: string }
export interface OwnerIdentity { readonly actor_id: string }
export interface RunnerCheckoutGrant {
  readonly remote: string;
  readonly commit: string;
  readonly username: string;
  readonly password: string;
  readonly expires_at: string;
}
export interface OwnerRunReceipt {
  readonly run_id: string;
  readonly kind: OwnerActionKind;
  readonly version_commit: string;
  readonly code_commit: string;
  readonly status: "completed";
  readonly conclusion: OwnerActionConclusion;
  readonly exit_code: number | null;
  readonly started_at: string;
  readonly finished_at: string;
  readonly stdout_sha256: string;
  readonly stderr_sha256: string;
  readonly stdout_tail: string;
  readonly stderr_tail: string;
  readonly publication_check?: Record<string, unknown>;
  readonly deployment?: unknown;
}
export interface OwnerActionRun {
  readonly tenant_id: string;
  readonly repository_id: string;
  readonly id: string;
  readonly kind: OwnerActionKind;
  readonly operation_id: string;
  readonly version_commit: string;
  readonly code_commit: string;
  readonly head_version_commit: string;
  readonly command: { readonly argv: readonly string[] };
  readonly status: OwnerActionStatus;
  readonly conclusion: OwnerActionConclusion | null;
  readonly runner_id: string | null;
  readonly lease_id: string | null;
  readonly lease_generation: number;
  readonly fence_token: string | null;
  readonly lease_expires_at: string | null;
  readonly heartbeat_at: string | null;
  readonly phase: string | null;
  readonly evidence_status: "none" | "pending" | "recorded" | "failed";
  readonly evidence_ref: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface OwnerActionsPorts {
  readonly authenticateOwner: (input: { readonly request: Request; readonly tenant_id: string; readonly capability: string }) => Promise<{ readonly ok: true; readonly actor_id: string } | { readonly ok: false; readonly response: Response }>;
  readonly getForgeHead: (input: { readonly tenant_id: string; readonly repository_id: string }) => Promise<ForgeVersionRef>;
  readonly readVersion: (input: { readonly tenant_id: string; readonly repository_id: string; readonly version_commit: string }) => Promise<ForgeVersionRef | null>;
  readonly verifyDeploymentAdmission: (input: { readonly run: OwnerActionRun }) => Promise<void>;
  readonly checkoutGrant: (input: { readonly run: OwnerActionRun }) => Promise<RunnerCheckoutGrant>;
  readonly checkEvidenceTemplate?: (input: { readonly run: OwnerActionRun }) => Promise<Record<string, unknown>>;
  readonly verifyReceipt?: (input: { readonly run: OwnerActionRun; readonly receipt: OwnerRunReceipt; readonly signature: string }) => Promise<boolean>;
  readonly recordEvidence: (input: { readonly run: OwnerActionRun; readonly receipt: OwnerRunReceipt; readonly signature: string }) => Promise<{ readonly evidence_ref?: string } | void>;
  readonly clock?: { readonly now: () => Date };
  readonly ids?: { readonly run: () => string; readonly lease: () => string; readonly fence: () => string };
}

type JsonRecord = Record<string, unknown>;
type OwnerActionRow = {
  tenant_id: string; repository_id: string; id: string; version: number; created_at: string; updated_at: string; kind: OwnerActionKind; operation_id: string; request_digest: string; actor_id: string; version_commit: string; code_commit: string; head_version_commit: string; command_json: string; status: OwnerActionStatus; conclusion: OwnerActionConclusion | null; runner_id: string | null; lease_id: string | null; lease_generation: number; fence_token: string | null; lease_expires_at: string | null; heartbeat_at: string | null; phase: string | null; receipt_json: string | null; receipt_sha256: string | null; signature: string | null; evidence_status: "none" | "pending" | "recorded" | "failed"; evidence_ref: string | null; evidence_error: string | null; deployment_json: string | null;
};

type RouteMatch =
  | { readonly kind: "ownerCollection"; readonly tenant_id: string; readonly repository_id: string }
  | { readonly kind: "ownerItem"; readonly tenant_id: string; readonly repository_id: string; readonly run_id: string }
  | { readonly kind: "runnerLease" }
  | { readonly kind: "runnerHeartbeat" | "runnerComplete"; readonly run_id: string };

const kindCommands: Record<OwnerActionKind, readonly string[]> = {
  "all-tests": ["node", "scripts/test-all.mjs"],
  "deploy-production": ["node", "scripts/gfy-cloudflare-deploy.mjs"]
};
const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const leaseMs = 15 * 60 * 1000;
const maxReceiptTail = 16 * 1024;

export async function handleOwnerActions(request: Request, env: OwnerActionsEnv, ports: OwnerActionsPorts): Promise<Response | undefined> {
  const route = matchOwnerActionsRoute(request);
  if (!route) return undefined;
  const db = env.GFY_DB ?? env.DB;
  if (!db) return jsonError("owner_actions_unconfigured", 503, "D1 is required");
  try {
    if (route.kind === "ownerCollection" && request.method === "POST") return await createRun(db, request, ports, route.tenant_id, route.repository_id);
    if (route.kind === "ownerCollection" && request.method === "GET") return await listRuns(db, request, ports, route.tenant_id, route.repository_id);
    if (route.kind === "ownerItem" && request.method === "GET") return await readRun(db, request, ports, route.tenant_id, route.repository_id, route.run_id);
    if (route.kind === "runnerLease" && request.method === "POST") return await leaseNext(db, request, env, ports);
    if (route.kind === "runnerHeartbeat" && request.method === "POST") return await heartbeat(db, request, env, ports, route.run_id);
    if (route.kind === "runnerComplete" && request.method === "POST") return await completeRun(db, request, env, ports, route.run_id);
    return jsonError("owner_actions_not_found", 404);
  } catch (error) {
    if (error instanceof OwnerActionHttpError) return jsonError(error.code, error.status, error.detail);
    return jsonError("owner_actions_failed", 500);
  }
}

async function createRun(db: D1DatabaseLike, request: Request, ports: OwnerActionsPorts, tenantId: string, repositoryId: string): Promise<Response> {
  const body = await readJson(request);
  const kind = requireKind(body.kind);
  const capability = kind === "deploy-production" ? "forge.publish" : "forge.commit";
  const owner = await ports.authenticateOwner({ request, tenant_id: tenantId, capability });
  if (!owner.ok) return owner.response;
  const operationId = requireSafeId(readString(body.operation_id) ?? request.headers.get("idempotency-key") ?? undefined, "operation_id");
  const requestDigest = sha256(canonicalJson({ tenant_id: tenantId, repository_id: repositoryId, actor_id: owner.actor_id, kind, operation_id: operationId, version_commit: readString(body.version_commit) ?? null, code_commit: readString(body.code_commit) ?? null, expected_head: readString(body.expected_head) ?? null }));
  const existing = await readByOperation(db, tenantId, repositoryId, operationId);
  if (existing) {
    if (!constantEqual(existing.request_digest, requestDigest)) throw new OwnerActionHttpError(409, "operation_id_conflict");
    return jsonOk({ run: publicRun(existing) });
  }
  const head = await ports.getForgeHead({ tenant_id: tenantId, repository_id: repositoryId });
  const requestedVersion = readString(body.version_commit) ?? head.version_commit;
  if (!shaPattern.test(requestedVersion)) throw new OwnerActionHttpError(400, "version_commit_invalid");
  const version = requestedVersion === head.version_commit ? head : await ports.readVersion({ tenant_id: tenantId, repository_id: repositoryId, version_commit: requestedVersion });
  if (!version) throw new OwnerActionHttpError(404, "version_not_found");
  const expectedHead = readString(body.expected_head);
  if (expectedHead && expectedHead !== head.version_commit) throw new OwnerActionHttpError(409, "head_changed");
  const requestedCode = readString(body.code_commit);
  if (requestedCode && requestedCode !== version.code_commit) throw new OwnerActionHttpError(409, "code_commit_mismatch");
  if (kind === "deploy-production" && version.version_commit !== head.version_commit) throw new OwnerActionHttpError(409, "deploy_requires_current_head");
  const now = nowIso(ports);
  const command = { argv: kindCommands[kind] };
  const runId = ports.ids?.run() ?? operationId;
  await db.prepare(`INSERT INTO owner_action_runs(tenant_id,repository_id,id,version,created_at,updated_at,kind,operation_id,request_digest,actor_id,version_commit,code_commit,head_version_commit,command_json,status,lease_generation,evidence_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(tenantId, repositoryId, runId, 1, now, now, kind, operationId, requestDigest, owner.actor_id, version.version_commit, version.code_commit, head.version_commit, JSON.stringify(command), "queued", 0, "none").run();
  const row = await requireRun(db, tenantId, repositoryId, runId);
  return jsonOk({ run: publicRun(row) }, { status: 201 });
}

async function listRuns(db: D1DatabaseLike, request: Request, ports: OwnerActionsPorts, tenantId: string, repositoryId: string): Promise<Response> {
  const owner = await ports.authenticateOwner({ request, tenant_id: tenantId, capability: "forge.read" });
  if (!owner.ok) return owner.response;
  const rows = await all<OwnerActionRow>(db, `SELECT * FROM owner_action_runs WHERE tenant_id = ? AND repository_id = ? ORDER BY created_at DESC LIMIT 100`, tenantId, repositoryId);
  return jsonOk({ runs: rows.map(publicRun) });
}

async function readRun(db: D1DatabaseLike, request: Request, ports: OwnerActionsPorts, tenantId: string, repositoryId: string, runId: string): Promise<Response> {
  const owner = await ports.authenticateOwner({ request, tenant_id: tenantId, capability: "forge.read" });
  if (!owner.ok) return owner.response;
  return jsonOk({ run: publicRun(await requireRun(db, tenantId, repositoryId, runId)) });
}

async function leaseNext(db: D1DatabaseLike, request: Request, env: OwnerActionsEnv, ports: OwnerActionsPorts): Promise<Response> {
  const runner = await authenticateRunner(request, env);
  if (!runner.ok) return runner.response;
  const body = await readJson(request);
  requireSafeId(readString(body.operation_id), "operation_id");
  const scope = runnerScope(env);
  const now = nowIso(ports);
  const active = await first<{ id: string }>(db, `SELECT id FROM owner_action_runs WHERE tenant_id = ? AND repository_id = ? AND status = 'in_progress' AND lease_expires_at > ? LIMIT 1`, scope.tenant_id, scope.repository_id, now);
  if (active) return new Response(null, { status: 204 });
  const row = await first<OwnerActionRow>(db, `SELECT * FROM owner_action_runs WHERE tenant_id = ? AND repository_id = ? AND (status = 'queued' OR (status = 'in_progress' AND lease_expires_at <= ?)) ORDER BY created_at ASC LIMIT 1`, scope.tenant_id, scope.repository_id, now);
  if (!row) return new Response(null, { status: 204 });
  if (row.kind === "deploy-production") await ports.verifyDeploymentAdmission({ run: publicRun(row) });
  const leaseId = ports.ids?.lease() ?? randomUUID();
  const fenceToken = ports.ids?.fence() ?? randomUUID();
  const expiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
  const result = await db.prepare(`UPDATE owner_action_runs SET version = version + 1, updated_at = ?, status = 'in_progress', runner_id = ?, lease_id = ?, lease_generation = lease_generation + 1, fence_token = ?, lease_expires_at = ?, heartbeat_at = ?, phase = 'leased' WHERE tenant_id = ? AND repository_id = ? AND id = ? AND version = ? AND status = ? AND NOT EXISTS (SELECT 1 FROM owner_action_runs AS active WHERE active.tenant_id = ? AND active.repository_id = ? AND active.status = 'in_progress' AND active.lease_expires_at > ?)`).bind(now, runner.runner_id, leaseId, fenceToken, expiresAt, now, row.tenant_id, row.repository_id, row.id, row.version, row.status, scope.tenant_id, scope.repository_id, now).run();
  if (changes(result) !== 1) throw new OwnerActionHttpError(409, "lease_conflict");
  const leased = publicRun(await requireRun(db, row.tenant_id, row.repository_id, row.id));
  if (leased.kind === "deploy-production") await ports.verifyDeploymentAdmission({ run: leased });
  const checkout = await ports.checkoutGrant({ run: leased });
  return jsonOk({ run_id: leased.id, lease_id: leased.lease_id, lease_generation: leased.lease_generation, fence_token: leased.fence_token, expires_at: leased.lease_expires_at, kind: leased.kind, tenant_id: leased.tenant_id, repository_id: leased.repository_id, version_commit: leased.version_commit, code_commit: leased.code_commit, command: leased.command, checkout, ...(ports.checkEvidenceTemplate ? { check_evidence: await ports.checkEvidenceTemplate({ run: leased }) } : {}) });
}

async function heartbeat(db: D1DatabaseLike, request: Request, env: OwnerActionsEnv, ports: OwnerActionsPorts, runId: string): Promise<Response> {
  const runner = await authenticateRunner(request, env);
  if (!runner.ok) return runner.response;
  const body = await readJson(request);
  const scope = runnerScope(env);
  const now = nowIso(ports);
  const expiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
  const result = await db.prepare(`UPDATE owner_action_runs SET version = version + 1, updated_at = ?, heartbeat_at = ?, lease_expires_at = ?, phase = ? WHERE tenant_id = ? AND repository_id = ? AND id = ? AND runner_id = ? AND lease_id = ? AND lease_generation = ? AND fence_token = ? AND status = 'in_progress' AND lease_expires_at > ?`)
    .bind(now, now, expiresAt, boundedString(body.phase, 128) ?? "running", scope.tenant_id, scope.repository_id, requireSafeId(runId, "run_id"), runner.runner_id, requireSafeId(readString(body.lease_id), "lease_id"), requirePositiveInt(body.lease_generation, "lease_generation"), requireSafeId(readString(body.fence_token), "fence_token"), now).run();
  if (changes(result) !== 1) throw new OwnerActionHttpError(409, "heartbeat_fence_mismatch");
  if (body.phase === "deploying") {
    const row = await requireRun(db, scope.tenant_id, scope.repository_id, runId);
    if (row.kind !== "deploy-production") throw new OwnerActionHttpError(409, "deployment_kind_mismatch");
    await ports.verifyDeploymentAdmission({ run: publicRun(row) });
  }
  return jsonOk({ ok: true, lease_expires_at: expiresAt });
}

async function completeRun(db: D1DatabaseLike, request: Request, env: OwnerActionsEnv, ports: OwnerActionsPorts, runId: string): Promise<Response> {
  const runner = await authenticateRunner(request, env);
  if (!runner.ok) return runner.response;
  const body = await readJson(request);
  const receipt = requireReceipt(body.receipt);
  const signature = requireString(body.signature, "signature");
  const scope = runnerScope(env);
  const row = await requireRun(db, scope.tenant_id, scope.repository_id, requireSafeId(runId, "run_id"));
  const receiptHash = sha256(canonicalJson(receipt));
  if (row.status === "completed") {
    if (!constantEqual(row.receipt_sha256 ?? "", receiptHash) || !constantEqual(row.signature ?? "", signature)) throw new OwnerActionHttpError(409, "completion_conflict");
    if (row.evidence_status !== "recorded") return await recordCompletionEvidence(db, ports, publicRun(row), receipt, signature, receiptHash);
    return jsonOk({ run: publicRun(row), replayed: true });
  }
  assertCompletionFence(row, runner.runner_id, body);
  if (!row.lease_expires_at || row.lease_expires_at <= nowIso(ports)) throw new OwnerActionHttpError(409, "lease_expired");
  assertReceiptMatches(row, receipt);
  if (!ports.verifyReceipt) throw new OwnerActionHttpError(503, "receipt_verifier_unconfigured");
  if (!await ports.verifyReceipt({ run: publicRun(row), receipt, signature })) throw new OwnerActionHttpError(401, "receipt_signature_invalid");
  const now = nowIso(ports);
  const result = await db.prepare(`UPDATE owner_action_runs SET version = version + 1, updated_at = ?, status = 'completed', conclusion = ?, receipt_json = ?, receipt_sha256 = ?, signature = ?, evidence_status = 'pending', deployment_json = ?, phase = 'completed' WHERE tenant_id = ? AND repository_id = ? AND id = ? AND runner_id = ? AND lease_id = ? AND lease_generation = ? AND fence_token = ? AND status = 'in_progress'`)
    .bind(now, receipt.conclusion, JSON.stringify(receipt), receiptHash, signature, receipt.deployment === undefined ? null : JSON.stringify(receipt.deployment), row.tenant_id, row.repository_id, row.id, runner.runner_id, requireSafeId(readString(body.lease_id), "lease_id"), requirePositiveInt(body.lease_generation, "lease_generation"), requireSafeId(readString(body.fence_token), "fence_token")).run();
  if (changes(result) !== 1) throw new OwnerActionHttpError(409, "completion_fence_mismatch");
  return recordCompletionEvidence(db, ports, publicRun(await requireRun(db, row.tenant_id, row.repository_id, row.id)), receipt, signature, receiptHash);
}

async function recordCompletionEvidence(db: D1DatabaseLike, ports: OwnerActionsPorts, run: OwnerActionRun, receipt: OwnerRunReceipt, signature: string, receiptHash: string): Promise<Response> {
  try {
    const recorded = await ports.recordEvidence({ run, receipt, signature });
    const evidenceRef = recorded?.evidence_ref ?? `owner-action:${run.id}:${receiptHash}`;
    await db.prepare(`UPDATE owner_action_runs SET evidence_status = 'recorded', evidence_ref = ?, evidence_error = NULL WHERE tenant_id = ? AND repository_id = ? AND id = ? AND receipt_sha256 = ?`).bind(evidenceRef, run.tenant_id, run.repository_id, run.id, receiptHash).run();
    return jsonOk({ run: publicRun(await requireRun(db, run.tenant_id, run.repository_id, run.id)) });
  } catch (error) {
    await db.prepare(`UPDATE owner_action_runs SET evidence_status = 'failed', evidence_error = ? WHERE tenant_id = ? AND repository_id = ? AND id = ? AND receipt_sha256 = ?`).bind(String(error instanceof Error ? error.message : error).slice(0, 512), run.tenant_id, run.repository_id, run.id, receiptHash).run();
    throw new OwnerActionHttpError(503, "evidence_record_failed");
  }
}

function matchOwnerActionsRoute(request: Request): RouteMatch | undefined {
  const path = new URL(request.url).pathname;
  let match = /^\/api\/v2\/tenants\/([^/]+)\/repositories\/([^/]+)\/actions\/runs\/?$/u.exec(path);
  if (match) return { kind: "ownerCollection", tenant_id: decodeURIComponent(match[1] ?? ""), repository_id: decodeURIComponent(match[2] ?? "") };
  match = /^\/api\/v2\/tenants\/([^/]+)\/repositories\/([^/]+)\/actions\/runs\/([^/]+)\/?$/u.exec(path);
  if (match) return { kind: "ownerItem", tenant_id: decodeURIComponent(match[1] ?? ""), repository_id: decodeURIComponent(match[2] ?? ""), run_id: decodeURIComponent(match[3] ?? "") };
  if (path === "/_runner/leases/next") return { kind: "runnerLease" };
  match = /^\/_runner\/runs\/([^/]+)\/(heartbeat|complete)\/?$/u.exec(path);
  if (match) return { kind: match[2] === "heartbeat" ? "runnerHeartbeat" : "runnerComplete", run_id: decodeURIComponent(match[1] ?? "") };
  return undefined;
}

export async function authenticateRunner(request: Request, env: OwnerActionsEnv): Promise<{ readonly ok: true; readonly runner_id: string } | { readonly ok: false; readonly response: Response }> {
  if (!env.GFY_RUNNER_CLIENT_ID || !env.GFY_RUNNER_CLIENT_SECRET) return { ok: false, response: jsonError("runner_auth_unconfigured", 503) };
  const runnerAuthEnv = {
    ...(env.GFY_AUTH_ISSUER ? { GFY_AUTH_ISSUER: env.GFY_AUTH_ISSUER } : {}),
    ...(env.GFY_AUTH_AUDIENCE ? { GFY_AUTH_AUDIENCE: env.GFY_AUTH_AUDIENCE } : {}),
    ...(env.GFY_AUTH_JWKS_URL ? { GFY_AUTH_JWKS_URL: env.GFY_AUTH_JWKS_URL } : {}),
    ...(env.jwksFetch ? { jwksFetch: env.jwksFetch } : {}),
    ...(env.clock ? { clock: env.clock } : {}),
    GFY_QUALIFIER_CLIENT_ID: env.GFY_RUNNER_CLIENT_ID,
    GFY_QUALIFIER_CLIENT_SECRET: env.GFY_RUNNER_CLIENT_SECRET
  } satisfies OperatorServiceAuthEnv;
  const result = await verifyOperatorServiceRequest(request, runnerAuthEnv);
  if (!result.ok) return { ok: false, response: jsonError("runner_auth_invalid", result.status, result.reason) };
  const expected = requireSafeId(env.GFY_RUNNER_CLIENT_ID, "GFY_RUNNER_CLIENT_ID");
  if (result.identity.client_id !== expected) return { ok: false, response: jsonError("runner_auth_invalid", 401) };
  return { ok: true, runner_id: requireSafeId(env.GFY_RUNNER_ID ?? expected, "GFY_RUNNER_ID") };
}

function publicRun(row: OwnerActionRow): OwnerActionRun {
  return { tenant_id: row.tenant_id, repository_id: row.repository_id, id: row.id, kind: row.kind, operation_id: row.operation_id, version_commit: row.version_commit, code_commit: row.code_commit, head_version_commit: row.head_version_commit, command: JSON.parse(row.command_json) as { argv: readonly string[] }, status: row.status, conclusion: row.conclusion, runner_id: row.runner_id, lease_id: row.lease_id, lease_generation: Number(row.lease_generation), fence_token: row.fence_token, lease_expires_at: row.lease_expires_at, heartbeat_at: row.heartbeat_at, phase: row.phase, evidence_status: row.evidence_status, evidence_ref: row.evidence_ref, created_at: row.created_at, updated_at: row.updated_at };
}

function runnerScope(env: OwnerActionsEnv): { readonly tenant_id: string; readonly repository_id: string } {
  return { tenant_id: requireSafeId(env.GFY_RUNNER_TENANT_ID, "GFY_RUNNER_TENANT_ID"), repository_id: requireSafeId(env.GFY_RUNNER_REPOSITORY_ID, "GFY_RUNNER_REPOSITORY_ID") };
}

async function readByOperation(db: D1DatabaseLike, tenantId: string, repositoryId: string, operationId: string): Promise<OwnerActionRow | null> {
  return first(db, `SELECT * FROM owner_action_runs WHERE tenant_id = ? AND repository_id = ? AND operation_id = ? LIMIT 1`, tenantId, repositoryId, operationId);
}
async function requireRun(db: D1DatabaseLike, tenantId: string, repositoryId: string, runId: string): Promise<OwnerActionRow> {
  const row = await first<OwnerActionRow>(db, `SELECT * FROM owner_action_runs WHERE tenant_id = ? AND repository_id = ? AND id = ? LIMIT 1`, tenantId, repositoryId, requireSafeId(runId, "run_id"));
  if (!row) throw new OwnerActionHttpError(404, "run_not_found");
  return row;
}
async function first<T>(db: D1DatabaseLike, sql: string, ...values: readonly unknown[]): Promise<T | null> { return db.prepare(sql).bind(...values).first<T>() }
async function all<T>(db: D1DatabaseLike, sql: string, ...values: readonly unknown[]): Promise<readonly T[]> { return (await db.prepare(sql).bind(...values).all<T>()).results ?? [] }
function changes(result: unknown): number { return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0) }

export async function readJson(request: Request): Promise<JsonRecord> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) {
        await reader.cancel();
        throw new OwnerActionHttpError(413, "body_too_large");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  if (bytes === 0) return {};
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new OwnerActionHttpError(400, "body_invalid"); }
  if (!isRecord(parsed)) throw new OwnerActionHttpError(400, "body_invalid");
  return parsed;
}
function requireKind(value: unknown): OwnerActionKind {
  if (value === "all-tests" || value === "deploy-production") return value;
  throw new OwnerActionHttpError(400, "kind_invalid");
}
function requireReceipt(value: unknown): OwnerRunReceipt {
  if (!isRecord(value)) throw new OwnerActionHttpError(400, "receipt_invalid");
  const receipt = value as Partial<OwnerRunReceipt>;
  if (receipt.status !== "completed" || (receipt.conclusion !== "success" && receipt.conclusion !== "failure")) throw new OwnerActionHttpError(400, "receipt_invalid");
  if (receipt.exit_code !== null && (!Number.isInteger(receipt.exit_code) || typeof receipt.exit_code !== "number" || receipt.exit_code < 0 || receipt.exit_code > 255)) throw new OwnerActionHttpError(400, "receipt_exit_invalid");
  if (receipt.conclusion === "success" && receipt.exit_code !== 0) throw new OwnerActionHttpError(400, "receipt_exit_invalid");
  for (const key of ["run_id", "kind", "version_commit", "code_commit", "started_at", "finished_at", "stdout_sha256", "stderr_sha256"] as const) requireString(receipt[key], key);
  const stdoutTail = requireStringValue(receipt.stdout_tail, "stdout_tail");
  const stderrTail = requireStringValue(receipt.stderr_tail, "stderr_tail");
  if (stdoutTail.length > maxReceiptTail || stderrTail.length > maxReceiptTail) throw new OwnerActionHttpError(413, "receipt_log_tail_too_large");
  return receipt as OwnerRunReceipt;
}
function assertReceiptMatches(row: OwnerActionRow, receipt: OwnerRunReceipt): void {
  if (receipt.run_id !== row.id || receipt.kind !== row.kind || receipt.version_commit !== row.version_commit || receipt.code_commit !== row.code_commit) throw new OwnerActionHttpError(409, "receipt_binding_mismatch");
}
function assertCompletionFence(row: OwnerActionRow, runnerId: string, body: JsonRecord): void {
  if (row.status !== "in_progress" || row.runner_id !== runnerId || row.lease_id !== readString(body.lease_id) || Number(row.lease_generation) !== requirePositiveInt(body.lease_generation, "lease_generation") || row.fence_token !== readString(body.fence_token)) throw new OwnerActionHttpError(409, "completion_fence_mismatch");
}
function requireString(value: unknown, name: string): string {
  const text = requireStringValue(value, name);
  if (text.length === 0) throw new OwnerActionHttpError(400, `${name}_invalid`);
  return text;
}
function requireStringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new OwnerActionHttpError(400, `${name}_invalid`);
  return value;
}
function readString(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined }
function boundedString(value: unknown, length: number): string | undefined { const text = readString(value); return text ? text.slice(0, length) : undefined }
function requireSafeId(value: unknown, name: string): string { const text = requireString(value, name); if (!idPattern.test(text)) throw new OwnerActionHttpError(400, `${name}_invalid`); return text }
function requirePositiveInt(value: unknown, name: string): number { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new OwnerActionHttpError(400, `${name}_invalid`); return number }
function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value) }
function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!isRecord(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])])); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }
function stableId(prefix: string, ...parts: readonly string[]): string { return `${prefix}-${sha256(parts.join("\0")).slice(0, 24)}` }
function constantEqual(left: string, right: string): boolean { const leftBytes = Buffer.from(left); const rightBytes = Buffer.from(right); return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes) }
function nowIso(ports: Pick<OwnerActionsPorts, "clock">): string { return (ports.clock?.now() ?? new Date()).toISOString() }
function jsonOk(body: unknown, init?: ResponseInit): Response { return Response.json(body, init) }
function jsonError(error: string, status: number, detail?: string): Response { return Response.json({ ok: false, error, status, ...(detail ? { detail } : {}) }, { status }) }
class OwnerActionHttpError extends Error { constructor(readonly status: number, readonly code: string, readonly detail?: string) { super(code) } }
