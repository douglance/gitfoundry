import { createHash, randomUUID } from "node:crypto";

import type { ForgeGitPort } from "../../../../packages/core/src/fork-forge/port.js";
import type { D1DatabaseLike } from "../../../../packages/core/src/live/index.js";
import { makeArtifactsForgeWrites, type ArtifactsWriteRepo } from "./artifacts-write.js";
import { makeArtifactsForgeReads, type ArtifactsReadRepo } from "./artifacts-read.js";
import type { ArtifactsBinding } from "../git-provider.js";

export type CloudForgeGitMethod = keyof ForgeGitPort;

export interface CloudForgeGitRpcInvokeInput {
  readonly method: CloudForgeGitMethod;
  readonly args: readonly unknown[];
}

export interface CloudForgeGitRpcInvokeResult {
  readonly receipt: CloudForgeGitLinuxReceipt;
}

export interface CloudForgeGitLinuxReceipt {
  readonly status: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly cleanupRequired?: boolean;
  readonly cleanupError?: string;
}

export interface CloudForgeGitPortOptions {
  readonly invoke: (input: CloudForgeGitRpcInvokeInput) => Promise<CloudForgeGitRpcInvokeResult>;
}

export interface CloudForgeGitFactoryEnv {
  readonly GFY_DB?: D1DatabaseLike;
  readonly GFY_GIT?: ArtifactsBinding;
  readonly GFY_GIT_NAMESPACE?: string;
  readonly GFY_TRUSTED_GIT_HELPER?: DurableObjectNamespaceLike;
  readonly GFY_SERVICE_ID?: string;
  readonly clock?: { readonly now: () => Date };
  readonly randomUUID?: () => string;
}

export interface DurableObjectNamespaceLike {
  readonly idFromName: (name: string) => DurableObjectIdLike;
  readonly get: (id: DurableObjectIdLike) => FetcherLike;
}

export interface DurableObjectIdLike {}
export interface FetcherLike { readonly fetch: (request: Request) => Promise<Response> | Response }

interface RepositoryArtifactRow {
  readonly artifacts_namespace: string | null;
  readonly artifacts_name: string | null;
}

interface ArtifactsRepoInfoLike {
  readonly name: string;
  readonly remote?: string | null;
}

interface ArtifactsRepoHandleLike {
  readonly info: () => Promise<ArtifactsRepoInfoLike>;
  readonly createToken: (scope?: "read" | "write", ttl?: number) => Promise<ArtifactsTokenLike>;
  readonly revokeToken?: (token?: string) => Promise<boolean>;
  readonly [Symbol.dispose]?: () => void;
}

interface ArtifactsTokenLike {
  readonly id?: string;
  readonly plaintext?: string;
  readonly scope?: "read" | "write" | string;
  readonly expiresAt?: string;
}

export interface ArtifactsForgeGitFactoryOptions {
  readonly namespace?: string;
  readonly tokenTtlSeconds?: number;
  readonly serviceId?: string;
  readonly deadlineMs?: number;
  readonly busyRetryDelayMs?: number;
  // Answer reads from Artifacts directly; the helper then runs only writes and comparisons.
  readonly directReads?: { readonly fetch: (request: Request) => Promise<Response> };
}

export interface NormalizedArtifactsToken {
  readonly username: "x-access-token";
  readonly plaintext: string;
  readonly expiresAtMs: number;
  readonly revokeId: string;
  readonly opaqueProof: string;
}

export interface TrustedForgeGitHelperRequest {
  readonly commandId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly operationId: string;
  readonly fenceToken: string;
  readonly deadlineMs: number;
  readonly cwd: string;
  readonly providerId: "cloudflare-artifacts";
  readonly providerRepositoryId: string;
  readonly operation: {
    readonly kind: "forge_rpc";
    readonly remoteUrl: string;
    readonly method: CloudForgeGitMethod;
    readonly args: readonly unknown[];
  };
  readonly credential: {
    readonly tenantId: string;
    readonly repositoryId: string;
    readonly providerId: "cloudflare-artifacts";
    readonly providerRepositoryId: string;
    readonly username: "x-access-token";
    readonly password: string;
    readonly expiresAtMs: number;
  };
  readonly artifactsEgress: {
    readonly allowedProviderHostname: string;
    readonly namespace: string;
    readonly repository: string;
    readonly artifactsRemoteUrl: string;
    readonly opaqueProof: string;
    readonly allowWrite: true;
  };
  readonly egressProfile: "gfy_internal_only";
}

// Why the trusted helper failed, as statuses and codes only: its output can carry credentials.
export type CloudForgeGitFailureDetail = Readonly<Partial<{ helper_status: number; helper_error: string; receipt_status: string; exit_code: number | null; stdout_truncated: boolean; stderr_truncated: boolean; cleanup_required: boolean; error_class: string; rpc_error: string; rpc_phase: string; provider_status: number; helper_detail: string }>>;

export class CloudForgeGitError extends Error {
  readonly name = "CloudForgeGitError";
  constructor(readonly code: "invalid_input" | "provider_unavailable" | "credential_unavailable" | "trusted_execution_failed" | "trusted_response_invalid", message: string, readonly reason?: "credential_request_failed" | "credential_response_invalid" | "credential_expiry_invalid", readonly detail?: CloudForgeGitFailureDetail) { super(message) }
}

const providerRepositoryNamePattern = /^[A-Za-z0-9_.-]{1,255}$/u;
const failureCodePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const failureClassPattern = /^[A-Z][A-Za-z]{0,63}$/u;
const failurePhasePattern = /^[A-Za-z][A-Za-z_]{0,63}$/u;
// The helper explains a rejected request with a fixed sentence; anything else is dropped.
const helperDetailPattern = /^[A-Za-z][A-Za-z0-9 .,:/_-]{0,159}$/u;
const opaqueProofPattern = /^[A-Za-z0-9._~:-]{16,512}$/u;
const methodNames = new Set<CloudForgeGitMethod>(["readRef", "listRefs", "readFile", "listTree", "writeCommit", "compareCommits", "mergeCommits", "compareAndSwapRef", "compareAndSwapRefs", "isAncestor"]);
const readOnlyMethods = new Set<CloudForgeGitMethod>(["readRef", "listRefs", "readFile", "listTree", "compareCommits", "isAncestor"]);
const maxStdoutBytes = 1024 * 1024;
const defaultTokenTtlSeconds = 900;
const maxTokenTtlSeconds = 900;
// The provider stamps expiry on its own clock, after the Worker read its clock.
const tokenClockSkewMs = 60 * 1000;
const defaultDeadlineMs = 15 * 60 * 1000;
const defaultBusyRetryDelayMs = 250;
const busyRetryLimit = 40;
const providerId = "cloudflare-artifacts" as const;
const gitUsername = "x-access-token" as const;

export function makeCloudForgeGitPort(options: CloudForgeGitPortOptions): ForgeGitPort {
  return {
    readRef: (ref) => invoke(options, "readRef", [ref]) as Promise<string | null>,
    listRefs: (prefix) => invoke(options, "listRefs", [prefix]) as ReturnType<ForgeGitPort["listRefs"]>,
    readFile: (commit, path) => invoke(options, "readFile", [commit, path]) as Promise<string | null>,
    listTree: (commit, prefix) => invoke(options, "listTree", prefix === undefined ? [commit] : [commit, prefix]) as ReturnType<ForgeGitPort["listTree"]>,
    writeCommit: (input) => invoke(options, "writeCommit", [input]) as Promise<string>,
    compareCommits: (base, head) => invoke(options, "compareCommits", [base, head]) as ReturnType<ForgeGitPort["compareCommits"]>,
    mergeCommits: (input) => invoke(options, "mergeCommits", [input]) as ReturnType<ForgeGitPort["mergeCommits"]>,
    compareAndSwapRef: (ref, expected, next) => invoke(options, "compareAndSwapRef", [ref, expected, next]) as Promise<boolean>,
    compareAndSwapRefs: (updates) => invoke(options, "compareAndSwapRefs", [updates]) as Promise<boolean>,
    isAncestor: (base, head) => invoke(options, "isAncestor", [base, head]) as Promise<boolean>
  };
}

export function makeArtifactsForgeGitFactory(env: CloudForgeGitFactoryEnv, options: ArtifactsForgeGitFactoryOptions = {}): (input: { readonly tenantId: string; readonly repositoryId: string }) => Promise<ForgeGitPort | undefined> {
  return async ({ tenantId, repositoryId }) => {
    if (!env.GFY_DB || !env.GFY_GIT || !env.GFY_TRUSTED_GIT_HELPER) return undefined;
    const namespace = options.namespace ?? env.GFY_GIT_NAMESPACE;
    if (!namespace) return undefined;
    const selected = await selectRepositoryArtifacts(env.GFY_DB, tenantId, repositoryId, namespace);
    await verifyRepository(env.GFY_GIT, namespace, selected.name);
    const serviceId = options.serviceId ?? env.GFY_SERVICE_ID ?? "gitfoundry-worker";
    const commandScope = stableCommandScope(tenantId, repositoryId, selected.name, serviceId);
    const stub = env.GFY_TRUSTED_GIT_HELPER.get(env.GFY_TRUSTED_GIT_HELPER.idFromName(commandScope));
    const helper = makeCloudForgeGitPort({
      invoke: async ({ method, args }) => invokeTrustedHelper({
        binding: env.GFY_GIT!,
        stub,
        namespace,
        tenantId,
        repositoryId,
        artifactsName: selected.name,
        serviceId,
        method,
        args,
        now: env.clock?.now() ?? new Date(),
        randomUUID: env.randomUUID ?? randomUUID,
        tokenTtlSeconds: options.tokenTtlSeconds ?? defaultTokenTtlSeconds,
        deadlineMs: options.deadlineMs ?? defaultDeadlineMs,
        busyRetryDelayMs: options.busyRetryDelayMs ?? defaultBusyRetryDelayMs
      })
    });
    if (!options.directReads) return helper;
    const binding = env.GFY_GIT;
    const repo = async () => await binding.get(selected.name) as unknown as ArtifactsWriteRepo;
    // Reads and writes go straight to Artifacts; the helper container is kept only for line-level merges.
    const reads = makeArtifactsForgeReads({ repo, fetch: options.directReads.fetch });
    return {
      ...helper,
      ...reads,
      ...makeArtifactsForgeWrites({ repo, fetch: options.directReads.fetch, mergeFallback: helper.mergeCommits, afterWrite: reads.invalidate })
    };
  };
}

async function invoke(options: CloudForgeGitPortOptions, method: CloudForgeGitMethod, args: readonly unknown[]): Promise<unknown> {
  if (!methodNames.has(method)) throw unavailable("invalid_input", "unsupported forge git method");
  const response = await options.invoke({ method, args });
  return parseTrustedReceipt(response.receipt);
}

function parseTrustedReceipt(receipt: CloudForgeGitLinuxReceipt): unknown {
  if (receipt.status !== "succeeded" || receipt.exitCode !== 0 || receipt.stdoutTruncated || receipt.stderrTruncated || receipt.cleanupRequired) {
    throw unavailable("trusted_execution_failed", "trusted forge git helper failed", undefined, {
      ...(failureCodePattern.test(receipt.status) ? { receipt_status: receipt.status } : {}),
      exit_code: Number.isInteger(receipt.exitCode) ? receipt.exitCode : null,
      stdout_truncated: receipt.stdoutTruncated === true,
      stderr_truncated: receipt.stderrTruncated === true,
      cleanup_required: receipt.cleanupRequired === true,
      ...failedRpcStep(receipt.stdout)
    });
  }
  if (new TextEncoder().encode(receipt.stdout).byteLength > maxStdoutBytes) throw unavailable("trusted_response_invalid", "trusted forge git response exceeds bound");
  const lines = receipt.stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== 1) throw unavailable("trusted_response_invalid", "trusted forge git response is ambiguous");
  let parsed: unknown;
  try { parsed = JSON.parse(lines[0] ?? "") } catch { throw unavailable("trusted_response_invalid", "trusted forge git response is not JSON") }
  if (!isRecord(parsed) || parsed.ok !== true || !("result" in parsed)) throw unavailable("trusted_response_invalid", "trusted forge git response is invalid");
  return parsed.result;
}

// The helper reports a failure as one line naming its error and the step that failed.
function failedRpcStep(stdout: string): { rpc_error?: string; rpc_phase?: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "") } catch { return {} }
  if (!isRecord(parsed)) return {};
  return {
    ...(typeof parsed.error === "string" && failureCodePattern.test(parsed.error) ? { rpc_error: parsed.error } : {}),
    ...(typeof parsed.phase === "string" && failurePhasePattern.test(parsed.phase) ? { rpc_phase: parsed.phase } : {})
  };
}

async function invokeTrustedHelper(input: { readonly binding: ArtifactsBinding; readonly stub: FetcherLike; readonly namespace: string; readonly tenantId: string; readonly repositoryId: string; readonly artifactsName: string; readonly serviceId: string; readonly method: CloudForgeGitMethod; readonly args: readonly unknown[]; readonly now: Date; readonly randomUUID: () => string; readonly tokenTtlSeconds: number; readonly deadlineMs: number; readonly busyRetryDelayMs?: number }): Promise<CloudForgeGitRpcInvokeResult> {
  const scope = methodTokenScope(input.method);
  const repo = await getRepositoryCapability(input.binding, input.artifactsName);
  let token: NormalizedArtifactsToken | undefined;
  try {
    const provider = providerInfoFromReadback(input.namespace, input.artifactsName, await repo.info());
    const requestId = input.randomUUID();
    token = await mintServiceToken(repo, scope, input.tokenTtlSeconds, input.now, input.randomUUID);
    const frame = buildTrustedHelperFrame({ ...input, requestId, provider, token, deadlineMs: normalizeDeadline(input.deadlineMs) });
    const response = await fetchWhenHelperIdle(input.stub, JSON.stringify(frame), input.busyRetryDelayMs ?? defaultBusyRetryDelayMs);
    if (!response.ok) {
      const failure = await response.json().catch(() => undefined) as unknown;
      const helperError = isRecord(failure) && typeof failure.error === "string" && failureCodePattern.test(failure.error) ? { helper_error: failure.error } : {};
      const helperDetail = isRecord(failure) && typeof failure.detail === "string" && helperDetailPattern.test(failure.detail) ? { helper_detail: failure.detail } : {};
      throw unavailable("trusted_execution_failed", "trusted forge git helper unavailable", undefined, { helper_status: response.status, ...helperError, ...helperDetail });
    }
    const body = await response.json() as unknown;
    if (!isRecord(body) || body.ok !== true || !isRecord(body.receipt)) throw unavailable("trusted_response_invalid", "trusted forge git helper response invalid");
    return { receipt: body.receipt as unknown as CloudForgeGitLinuxReceipt };
  } catch (error) {
    if (error instanceof CloudForgeGitError) throw error;
    const errorClass = error instanceof Error && failureClassPattern.test(error.name) ? { error_class: error.name } : {};
    throw unavailable("trusted_execution_failed", "trusted forge git helper unavailable", undefined, errorClass);
  } finally {
    if (token) await revokeTokenQuietly(repo, token.revokeId);
    repo[Symbol.dispose]?.();
  }
}

// One helper serves each repository and runs one command at a time; a request that
// arrives while it is busy waits for it instead of failing.
async function fetchWhenHelperIdle(stub: FetcherLike, body: string, delayMs: number): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await stub.fetch(new Request("https://gitfoundry.internal/linux/forge-git", { method: "POST", headers: { "content-type": "application/json" }, body }));
    if (response.status !== 409 || attempt >= busyRetryLimit) return response;
    const detail = await response.clone().json().catch(() => undefined) as unknown;
    if (!isRecord(detail) || detail.error !== "gfy_linux_active_attempt_exists") return response;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export function buildTrustedHelperFrame(input: { readonly tenantId: string; readonly repositoryId: string; readonly namespace: string; readonly artifactsName: string; readonly provider: ValidatedProviderInfo; readonly token: NormalizedArtifactsToken; readonly serviceId: string; readonly method: CloudForgeGitMethod; readonly args: readonly unknown[]; readonly requestId: string; readonly deadlineMs?: number }): TrustedForgeGitHelperRequest {
  if (!methodNames.has(input.method)) throw unavailable("invalid_input", "unsupported forge git method");
  assertId("requestId", input.requestId);
  if (!opaqueProofPattern.test(input.token.opaqueProof)) throw unavailable("credential_unavailable", "repository egress proof unavailable");
  const providerRepositoryId = `${input.namespace}/${input.artifactsName}`;
  const operationId = `forge-rpc-${input.method}-${input.requestId}`;
  return {
    commandId: `forge-git-${input.method}-${input.requestId}`,
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    operationId,
    fenceToken: `fence-${input.requestId}`,
    deadlineMs: normalizeDeadline(input.deadlineMs ?? defaultDeadlineMs),
    cwd: `/work/${input.tenantId}/${input.repositoryId}/${operationId}/trusted-git`,
    providerId,
    providerRepositoryId,
    operation: { kind: "forge_rpc", remoteUrl: input.provider.operationRemoteUrl, method: input.method, args: input.args },
    credential: { tenantId: input.tenantId, repositoryId: input.repositoryId, providerId, providerRepositoryId, username: input.token.username, password: input.token.plaintext, expiresAtMs: input.token.expiresAtMs },
    artifactsEgress: { allowedProviderHostname: input.provider.hostname, namespace: input.namespace, repository: input.artifactsName, artifactsRemoteUrl: input.provider.artifactsRemoteUrl, opaqueProof: input.token.opaqueProof, allowWrite: true },
    egressProfile: "gfy_internal_only"
  };
}

async function selectRepositoryArtifacts(db: D1DatabaseLike, tenantId: string, repositoryId: string, namespace: string): Promise<{ readonly name: string }> {
  const row = await db.prepare("SELECT artifacts_namespace, artifacts_name FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, repositoryId).first<RepositoryArtifactRow>();
  if (!row) throw unavailable("provider_unavailable", "repository unavailable");
  if (row.artifacts_namespace !== namespace) throw unavailable("provider_unavailable", "repository namespace unavailable");
  if (typeof row.artifacts_name !== "string" || !providerRepositoryNamePattern.test(row.artifacts_name)) throw unavailable("provider_unavailable", "repository identity unavailable");
  return { name: row.artifacts_name };
}

async function verifyRepository(binding: ArtifactsBinding, namespace: string, name: string): Promise<ValidatedProviderInfo> {
  const repo = await getRepositoryCapability(binding, name);
  try {
    return providerInfoFromReadback(namespace, name, await repo.info());
  } finally {
    repo[Symbol.dispose]?.();
  }
}

async function getRepositoryCapability(binding: ArtifactsBinding, name: string): Promise<ArtifactsRepoHandleLike> {
  try { return await binding.get(name) as unknown as ArtifactsRepoHandleLike } catch (error) { throw new CloudForgeGitError("provider_unavailable", "repository provider unavailable", undefined, { error_class: error instanceof Error ? error.constructor.name : "Unknown" }) }
}

interface ValidatedProviderInfo {
  readonly hostname: string;
  readonly operationRemoteUrl: string;
  readonly artifactsRemoteUrl: string;
}

function providerInfoFromReadback(namespace: string, name: string, info: ArtifactsRepoInfoLike): ValidatedProviderInfo {
  if (info.name !== name || !providerRepositoryNamePattern.test(info.name)) throw unavailable("provider_unavailable", "repository identity unavailable");
  if (typeof info.remote !== "string" || info.remote.length === 0) throw unavailable("provider_unavailable", "repository remote unavailable");
  let remote: URL;
  try { remote = new URL(info.remote) } catch { throw unavailable("provider_unavailable", "repository remote unavailable") }
  if (remote.protocol !== "https:" || remote.username || remote.password || remote.search || remote.hash) throw unavailable("provider_unavailable", "repository remote unavailable");
  const operationRemoteUrl = `https://${remote.hostname}/git/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}.git`;
  return { hostname: remote.hostname, operationRemoteUrl, artifactsRemoteUrl: remote.toString() };
}

async function mintServiceToken(repo: ArtifactsRepoHandleLike, scope: "read" | "write", ttlSeconds: number, now: Date, newOpaqueProof: () => string): Promise<NormalizedArtifactsToken> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maxTokenTtlSeconds) throw unavailable("invalid_input", "token ttl is invalid");
  let token: ArtifactsTokenLike;
  try { token = await repo.createToken(scope, ttlSeconds) } catch { throw unavailable("credential_unavailable", "repository credential unavailable", "credential_request_failed") }
  if ((token.scope !== undefined && token.scope !== scope) || typeof token.plaintext !== "string" || token.plaintext.length < 8 || typeof token.expiresAt !== "string") throw unavailable("credential_unavailable", "repository credential unavailable", "credential_response_invalid");
  const expiresAtMs = Date.parse(token.expiresAt);
  const nowMs = now.getTime();
  if (!Number.isInteger(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs > nowMs + ttlSeconds * 1000 + tokenClockSkewMs) throw unavailable("credential_unavailable", "repository credential unavailable", "credential_expiry_invalid");
  const revokeId = typeof token.id === "string" && token.id.length > 0 ? token.id : token.plaintext;
  const opaqueProof = newOpaqueProof();
  if (!opaqueProofPattern.test(opaqueProof)) throw unavailable("credential_unavailable", "repository egress proof unavailable");
  return { username: gitUsername, plaintext: token.plaintext, expiresAtMs, revokeId, opaqueProof };
}

async function revokeTokenQuietly(repo: ArtifactsRepoHandleLike, token: string): Promise<void> {
  try { await repo.revokeToken?.(token) } catch {}
}

function methodTokenScope(method: CloudForgeGitMethod): "read" | "write" {
  return readOnlyMethods.has(method) ? "read" : "write";
}

function normalizeDeadline(deadlineMs: number): number {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > defaultDeadlineMs) throw unavailable("invalid_input", "deadline is invalid");
  return deadlineMs;
}

function stableCommandScope(tenantId: string, repositoryId: string, artifactsName: string, serviceId: string): string {
  return `forge-git:${sha256Hex(`${tenantId}\n${repositoryId}\n${artifactsName}\n${serviceId}`).slice(0, 40)}`;
}

function assertId(field: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)) throw unavailable("invalid_input", `${field} is invalid`);
}

function unavailable(code: CloudForgeGitError["code"], message: string, reason?: CloudForgeGitError["reason"], detail?: CloudForgeGitFailureDetail): CloudForgeGitError {
  return new CloudForgeGitError(code, message, reason, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
