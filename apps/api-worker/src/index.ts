import { WorkerEntrypoint } from "cloudflare:workers";
import { Cause, Effect, Layer, Option } from "effect";

import { decodeRequestEnvelope, decodeSourceSchema, expectedContractCounts, type NativeOperation, type RequestEnvelope } from "@gitfoundry/contracts";
import { CollaborationMetadataStore, implementedOperationIds, CheckStore, ContractSchemas, CurrentIdentity, ForgeStore, IdempotencyStore, NamespaceStore, NativeDispatcher, OperationStore, RepositoryStore, TenantAuthorizer, UnauthorizedError, dispatchOperation, makeForgeService, makeNativeDispatcher, decodeBase64Utf8, encodeBase64Utf8, ForkForgeInputError, ForkForgeUnavailableError, ForgeVersionAuthenticationError, type Actor, type ForgeActor, type ForgeGitPort, type ForgeVersion, type ForkForgeChange, type ForkForgeEvidenceContext, type InitializeFileChange, type OperationReceipt, type OperationRecord } from "@gitfoundry/core";
import { makeD1IdempotencyStore, makeD1IdentityPort, makeD1NamespaceStore, makeD1OperationStore, makeD1RepositoryStore, makeD1TenantAuthorizer, type D1DatabaseLike, type GitProvisioner, type SourceActorIdentity, type VerifiedIdentity } from "../../../packages/core/src/live/index.js";
import { makeD1CheckStore } from "../../../packages/core/src/live/checks.js";
import { makeD1ForgeIssueStore, makeD1ForgePullRequestStore, makeD1ForgeStore, type QualifiedGitReadPort } from "../../../packages/core/src/live/forge.js";

import { makeD1CollaborationMetadataStore } from "../../../packages/core/src/live/collaboration-metadata.js";

import { nativeOperationCount, nativeOperations, sourceDomain } from "./source-catalog.generated.js";
import { makeArtifactsGitProvisioner, type ArtifactsBinding } from "./git-provider.js";
import { makeD1ArtifactsGitRead } from "./git-read.js";
import { SourceReadUnavailableError, isGitSha, makeD1ArtifactsSourceRead, validateSourcePath, type SourceFileResponse, type SourceReadPort } from "./source-read.js";
import { makeTrustedNativeJobCandidateCheckQualifier } from "./native-jobs/check-reporting.js";
import { handleForkRequest, type ForkAction, type ForkActor, type ForkApiContext, type ForkApiPorts } from "./fork-forge/http.js";
import { handleRepositoryLoadCheck, type RepositoryLoadCheckEnv, type RepositoryLoadPorts } from "./repository-load-check.js";
import { handleSiteChecks, recordSiteCheck } from "./site-checks.js";
import { authenticateSession, handleEmailSignInRequest, sessionTenantId, workspaceGrant, type EmailSignInEnv, type WorkspaceSession } from "./email-sign-in/index.js";

export interface Env extends EmailSignInEnv, RepositoryLoadCheckEnv {
  GFY_OWNER_TENANT_ID?: string;
  GFY_OWNER_NAMESPACE_ID?: string;
  GFY_FORK_ONLY?: boolean;
  GFY_AUTH_ISSUER?: string;
  GFY_AUTH_AUDIENCE?: string;
  GFY_MCP_AUTH_AUDIENCE?: string;
  GFY_AUTH_JWKS_URL?: string;
  GFY_BODY_LIMIT_BYTES?: string;
  GFY_GIT_URL_BASE?: string;
  GFY_GIT_PROVISIONER?: GitProvisioner;
  GFY_GIT?: ArtifactsBinding;
  GFY_GIT_NAMESPACE?: string;
  GFY_DB?: D1DatabaseLike;
  DB?: D1DatabaseLike;
  jwksFetch?: typeof fetch;
  clock?: { readonly now: () => Date };
  GFY_GIT_READ?: QualifiedGitReadPort;
  GFY_SOURCE_READ?: SourceReadPort;
  GFY_FORGE_GIT?: ForgeGitPort | ((input: { readonly tenantId: string; readonly repositoryId: string }) => ForgeGitPort | undefined | Promise<ForgeGitPort | undefined>);
  GFY_FORGE_VERIFY_EVIDENCE?: (context: ForkForgeEvidenceContext & { readonly tenant_id: string; readonly repository_id: string }) => Promise<void>;
  GFY_FORGE_IS_PUBLISHER_STOPPED?: (context: { readonly tenant_id: string; readonly repository_id: string; readonly operation_id: string }) => Promise<boolean>;
  GFY_FORGE_SIGN_REVIEW?: (context: { readonly tenant_id: string; readonly repository_id: string; readonly actor: ForgeActor; readonly parent: ForgeVersion; readonly record: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  GFY_PR_ELIGIBILITY_DO?: Pick<DurableObjectNamespace, "idFromName" | "get">;
  ASSETS?: { readonly fetch: (request: Request) => Promise<Response> | Response };
}

interface JwtClaims extends Readonly<Record<string, unknown>> { readonly iss: string; readonly sub: string; readonly aud: string | readonly string[]; readonly exp: number; readonly nbf?: number }
interface OperationRoute { readonly operation: NativeOperation; readonly regex: RegExp; readonly keys: readonly string[] }
type ForkForgeAction = "head" | "list" | "view" | "read" | "compare" | "initialize" | "fork" | "commit" | "merge" | "publish" | "recover";
type ResourceChangeKind = "version_created" | "head_updated" | "metadata_updated" | "recovered";
interface ResourceChangeEnvelope { readonly schema_version: 1; readonly source_event_id: string; readonly cursor: string; readonly tenant_id: string; readonly repository_id?: string; readonly kind: ResourceChangeKind; readonly operation_id: string; readonly resource_uris: readonly string[]; readonly authoritative_revision: string; readonly occurred_at: string }
interface ResourceEventRow { readonly id: number; readonly cursor: string; readonly source_event_id: string; readonly tenant_id: string; readonly repository_id: string | null; readonly kind: ResourceChangeKind; readonly operation_id: string; readonly resource_uris_json: string; readonly authoritative_revision: string; readonly occurred_at: string }
type ErrorCode = "gfy_auth_unconfigured" | "gfy_auth_invalid" | "gfy_body_too_large" | "gfy_body_invalid" | "gfy_body_limit_invalid" | "gfy_internal_route_forbidden" | "gfy_route_not_found" | "gfy_unsupported_operation" | "gfy_permission_denied" | "gfy_not_found" | "gfy_idempotency_conflict" | "gfy_stale_precondition" | "gfy_git_provisioner_unavailable" | "gfy_git_reference_unavailable" | "gfy_forge_unavailable" | "gfy_domain_contract_invalid" | "gfy_repository_name_conflict" | "gfy_repository_has_forks" | "gfy_repository_store_unavailable" | "gfy_candidate_preparation_unavailable";
type ForkForgeReauthorize = (capability: string, actor: ForkActor) => Promise<boolean>;

const routes: readonly OperationRoute[] = nativeOperations.map((operation) => compileRoute(operation));
const sourceOperationIds = ["repo.tree", "repo.diff"] as const;
const forkForgeOperationIds = ["forge.head", "forge.list", "forge.view", "forge.read", "forge.compare", "forge.initialize", "forge.fork", "forge.commit", "forge.merge", "forge.publish", "forge.recover"] as const;
const activeOperationIds = ["auth.whoami", "repo.create", "repo.list", "repo.view", "repo.delete", ...forkForgeOperationIds] as const;
const activeOperations = new Set<string>(activeOperationIds);
const implemented = new Set<string>(["auth.whoami", ...implementedOperationIds, ...sourceOperationIds, ...forkForgeOperationIds, "pr.eligibility"]);
const forgeOperations = new Set(["issue.list", "issue.view", "issue.create", "issue.edit", "pr.list", "pr.view", "pr.create", "pr.edit", "comment.list", "comment.view", "comment.create", "comment.edit", "review.list", "review.view", "review.create", "review.edit"]);
const sourceOperations = new Set<string>(sourceOperationIds);
const internalPrefixes = ["/__", "/internal", "/identity", "/invoke", "/mcp/internal"];
const maxBodyLimitBytes = 1024 * 1024;
const resourceEventRetentionMs = 7 * 24 * 60 * 60 * 1000;
const resourceEventRetentionCount = 100000;
const resourceEventReplayLimit = 256;
const resourceEventReplayBytes = 1024 * 1024;
const resourceEventSchemaStatements = [
  "CREATE TABLE IF NOT EXISTS resource_events (tenant_id TEXT NOT NULL, id INTEGER PRIMARY KEY AUTOINCREMENT, cursor TEXT NOT NULL DEFAULT '', source_event_id TEXT NOT NULL, occurred_at TEXT NOT NULL, repository_id TEXT, kind TEXT NOT NULL, operation_id TEXT NOT NULL, resource_uris_json TEXT NOT NULL CHECK(json_valid(resource_uris_json)), authoritative_revision TEXT NOT NULL, UNIQUE(tenant_id,source_event_id))",
  "CREATE INDEX IF NOT EXISTS idx_resource_events_tenant_id ON resource_events(tenant_id,id)",
  "CREATE INDEX IF NOT EXISTS idx_resource_events_repo_id ON resource_events(tenant_id,repository_id,id)"
] as const;

const jsonError = (error: ErrorCode, status: number, detail?: string): Response => Response.json({ ok: false, error, status, ...(detail ? { detail } : {}) }, { status });
const jsonOk = (body: unknown, init?: ResponseInit): Response => Response.json(body, init);
const jsonHealth = (env: Env): Response => env.GFY_FORK_ONLY
  ? jsonOk({ ok: true, product: "gitfoundry", operations: activeOperations.size, mcpTools: activeOperations.size, nativeRoutes: activeOperations.size, implementedOperations: [...activeOperations].filter(id => implemented.has(id)).sort() })
  : jsonOk({ ok: true, scaffold: "p1-api", operations: expectedContractCounts.operations, mcpTools: expectedContractCounts.mcpTools, nativeRoutes: nativeOperationCount, implementedOperations: Array.from(implemented).sort() });

export default { async fetch(request: Request, env: Env): Promise<Response> { return fetchPublic(request, env) } };
export class AgentApi extends WorkerEntrypoint<Env> { async fetch(request: Request): Promise<Response> { return fetchAgentApi(request, this.env) } }


export async function authenticateHostedActionOwner(request: Request, env: Env, tenantId: string, capability: string): Promise<{ ok: true; actor_id: string } | { ok: false; response: Response }> {
  if (!hasAuthConfig(env)) return { ok: false, response: jsonError("gfy_auth_unconfigured", 503) };
  const result = await authenticateRequest(request.headers, env, tenantId, env.GFY_AUTH_AUDIENCE ?? "", capability);
  return result.ok ? { ok: true, actor_id: result.actor.id } : result;
}

export async function authorizeGitTransportRequest(request: Request, env: Env, tenantId: string, capability: "repository.read" | "repository.write"): Promise<Response | undefined> {
  if (!hasAuthConfig(env)) return jsonError("gfy_auth_unconfigured", 503);
  const authorization = await authenticateRequest(request.headers, env, tenantId, env.GFY_AUTH_AUDIENCE ?? "", capability);
  return authorization.ok ? undefined : authorization.response;
}

export async function fetchPublic(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!hasAuthConfig(env)) return jsonError("gfy_auth_unconfigured", 503);
  if (url.pathname === "/health") return jsonHealth(env);
  const signIn = await handleEmailSignInRequest(request, env, activeOwnerCapabilities());
  if (signIn) return signIn;
  const repositoryLoad = await handleRepositoryLoadCheck(request, env, repositoryLoadPorts(env, request));
  if (repositoryLoad) return repositoryLoad;
  const siteChecks = await handleSiteChecks(request, env);
  if (siteChecks) return siteChecks;
  const resourceEvents = matchResourceEventsRoute(url.pathname);
  if (resourceEvents && request.method === "GET") return handleResourceEvents(request, env, resourceEvents.tenant_id);
  if (resourceEvents) return jsonError("gfy_route_not_found", 404);
  // The page itself is public; it opens the visitor's workspace when they are signed in and shows sign-in otherwise.
  if ((url.pathname === "/" || url.pathname === "/index.html") && env.ASSETS) {
    const tenantId = await sessionTenantId(request.headers, env) ?? "";
    return withDefaultTenant(await env.ASSETS.fetch(request), tenantId);
  }
  if (isAssetPath(url.pathname) && env.ASSETS) return env.ASSETS.fetch(request);
  if (url.pathname === "/") return jsonHealth(env);
  if (internalPrefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return jsonError("gfy_internal_route_forbidden", 404);
  if (isPublicForkForgePath(url.pathname)) return handleProductionForkForgeRequest(request, env);
  const sourceFile = matchSourceFileRoute(request.method, url.pathname);
  if (sourceFile) return handleSourceFile(request, env, url, sourceFile);
  const match = matchRoute(request.method, url.pathname);
  if (!match) return jsonError("gfy_route_not_found", 404);
  if (env.GFY_FORK_ONLY && !activeOperations.has(match.operation.id) && !sourceOperations.has(match.operation.id)) return jsonError("gfy_unsupported_operation", 501, match.operation.id);
  if (!implemented.has(match.operation.id)) return jsonError("gfy_unsupported_operation", 501, match.operation.id);
  const bodyResult = await readBody(request, env);
  if (!bodyResult.ok) return bodyResult.response;
  const tenantId = match.route.tenant_id;
  if (!tenantId) return jsonError("gfy_domain_contract_invalid", 400, "tenant route is required");
  const auth = await authenticateRequest(request.headers, env, tenantId, env.GFY_AUTH_AUDIENCE ?? "", match.operation.capability);
  if (!auth.ok) return auth.response;
  if (match.operation.id === "auth.whoami") return actorResponse(match.operation, auth.sourceActor);
  return invokeOperation(match.operation, buildEnvelope(match.operation, match.route, url.searchParams, request.headers, bodyResult.body), auth.actor, env);
}

export async function fetchAgentApi(request: Request, env: Env): Promise<Response> {
  if (!hasAuthConfig(env)) return jsonError("gfy_auth_unconfigured", 503);
  const db = database(env);
  if (!db) return jsonError("gfy_auth_unconfigured", 503);
  const url = new URL(request.url);
  if (request.method !== "POST") return jsonError("gfy_route_not_found", 404);
  const bodyResult = await readBody(request, env);
  if (!bodyResult.ok) return bodyResult.response;
  if (url.pathname === "/identity") {
    const tenantId = readString(bodyResult.body, "requested_tenant_id");
    const userAuthorization = readString(bodyResult.body, "userAuthorization");
    if (!tenantId || !userAuthorization) return jsonError("gfy_body_invalid", 400, "requested_tenant_id and userAuthorization are required");
    const auth = await authenticateAuthorization(userAuthorization, env, tenantId, env.GFY_MCP_AUTH_AUDIENCE ?? env.GFY_AUTH_AUDIENCE ?? "", "identity.read");
    return auth.ok ? jsonOk(auth.verified) : auth.response;
  }
  if (url.pathname === "/invoke") {
    const operationId = readString(bodyResult.body, "operation_id");
    if (isForkForgeOperationId(operationId)) return invokePrivateForkForge(request, env, bodyResult.body, operationId);
    const operation = nativeOperations.find((candidate) => candidate.id === operationId);
    if (env.GFY_FORK_ONLY && operation && !activeOperations.has(operation.id) && !sourceOperations.has(operation.id)) return jsonError("gfy_unsupported_operation", 501, operation.id);
    if (!operation || !implemented.has(operation.id)) return jsonError("gfy_unsupported_operation", 501, operationId ?? "missing operation_id");
    const context = readRecord(bodyResult.body, "context");
    const tenantId = readString(context, "tenant_id");
    const principalId = readString(context, "principal_id");
    const grantRef = readString(context, "grant_ref");
    const policyEpoch = readNumber(context, "policy_epoch");
    if (!tenantId || !principalId || !grantRef || policyEpoch === undefined) return jsonError("gfy_body_invalid", 400, "verified invoke context is required");
    const args = readRecord(bodyResult.body, "arguments");
    const route = normalizeStringRecord(readRecord(args, "route"));
    if (route.tenant_id !== tenantId) return jsonError("gfy_permission_denied", 403);
    const identityGrant = await currentGrant(env, tenantId, principalId, "identity.read", policyEpoch);
    const operationGrant = await currentGrant(env, tenantId, principalId, operation.capability, policyEpoch);
    if (!identityGrant || identityGrant.grantRef !== grantRef || !operationGrant) return jsonError("gfy_permission_denied", 403);
    const sourceActor = signedIn(operationGrant).sourceActor;
    if (operation.id === "auth.whoami") return actorResponse(operation, sourceActor);
    const execution = readRecord(bodyResult.body, "execution");
    const envelope = { operation_id: operation.id, route, query: readRecord(args, "query"), headers: {}, body: Object.prototype.hasOwnProperty.call(args, "body") ? args.body : null, cookies: {}, idempotency_key: readString(execution, "idempotency_key"), expected_version: readNumber(execution, "expected_version"), api_version: "v1" };
    return invokeOperation(operation, envelope, { id: principalId, tenantId, revoked: false, capabilities: sourceActor.scopes }, env);
  }
  return jsonError("gfy_route_not_found", 404);
}

async function invokeOperation(operation: NativeOperation, envelope: unknown, actor: Actor, env: Env): Promise<Response> {
  const db = database(env);
  if (!db) return jsonError("gfy_auth_unconfigured", 503);
  if (operation.id === "pr.eligibility") return invokePrEligibilityOperation(operation, envelope, actor, env);
  if (isSourceOperation(operation.id)) return invokeSourceOperation(operation, envelope, env, db);
  if (isForgeOperation(operation.id)) return invokeForgeOperation(operation, envelope, actor, env, db);
  const gitProvisioner = env.GFY_GIT_PROVISIONER ?? configuredArtifactsProvisioner(env);
  const repositoryOptions = {
    ...(env.GFY_GIT_URL_BASE ? { gitUrlBase: env.GFY_GIT_URL_BASE } : {}),
    ...(gitProvisioner ? { gitProvisioner } : {})
  };
  const layer = Layer.mergeAll(
    Layer.succeed(CurrentIdentity, { currentActor: () => Effect.succeed(actor) }),
    Layer.succeed(TenantAuthorizer, {
      authorize: (candidate, tenantId, capability) => Effect.flatMap(
        Effect.tryPromise(() => currentGrant(env, tenantId, candidate.id, capability)).pipe(Effect.orElseSucceed(() => undefined)),
        (grant) => grant && !candidate.revoked && candidate.tenantId === tenantId ? Effect.void : Effect.fail(new UnauthorizedError({ reason: "no grant for capability", actorId: candidate.id, tenantId, capability }))
      ),
    }),
    Layer.succeed(ContractSchemas, { domain: sourceDomain }),
    Layer.succeed(NamespaceStore, makeD1NamespaceStore(db)),
    Layer.succeed(RepositoryStore, makeD1RepositoryStore(db, repositoryOptions)),
    Layer.succeed(OperationStore, makeD1OperationStore(db)),
    Layer.succeed(IdempotencyStore, makeD1IdempotencyStore(db, env.clock)),
    Layer.succeed(ForgeStore, makeD1ForgeStore(db, { clock: env.clock, gitRead: configuredGitRead(env, db) })),
    Layer.succeed(CheckStore, makeD1CheckStore(db, { clock: env.clock, gitRead: configuredGitRead(env, db), candidateChecks: makeTrustedNativeJobCandidateCheckQualifier(db, env.clock ? { clock: env.clock } : {}) })),
    Layer.succeed(CollaborationMetadataStore, makeD1CollaborationMetadataStore(db, env.clock ? { clock: env.clock } : {})),
    Layer.succeed(NativeDispatcher, makeNativeDispatcher(nativeOperations))
  );
  const result = await Effect.runPromiseExit(Effect.provide(dispatchOperation(operation, envelope), layer));
  // The contract answers an asynchronous operation that returns an operation record with 202.
  if (result._tag === "Success") return receiptResponse(result.value, operation.asynchronous && operation.output_schema === "Operation" ? 202 : 200);
  return errorResponse(result.cause);
}

async function invokeForgeOperation(operation: NativeOperation, envelopeInput: unknown, actor: Actor, env: Env, db: D1DatabaseLike): Promise<Response> {
  let envelope: RequestEnvelope;
  try {
    envelope = decodeRequestEnvelope(envelopeInput);
    if (envelope.operation_id !== operation.id) throw new Error(`envelope operation ${envelope.operation_id} does not match ${operation.id}`);
    validateOperationRoute(operation, envelope);
    validateRequestPayload(operation, envelope);
  } catch (error) {
    return jsonError("gfy_domain_contract_invalid", 400, String(error));
  }
  const tenantId = envelope.route.tenant_id;
  if (!tenantId) return jsonError("gfy_domain_contract_invalid", 400, "tenant route is required");
  const idempotency = makeD1IdempotencyStore(db, env.clock);
  const scope = envelope.idempotency_key ? stableJson([tenantId, actor.id, operation.id, envelope.idempotency_key]) : undefined;
  const fingerprint = stableJson({ operation_id: operation.id, route: envelope.route, query: envelope.query, body: envelope.body, expected_version: envelope.expected_version ?? null, api_version: envelope.api_version });
  const reservationId = scope ? `forge-${crypto.randomUUID()}` : "";
  if (scope) {
    const replay = await Effect.runPromiseExit(idempotency.replayOrReserve(scope, fingerprint, makePendingOperation(tenantId, reservationId, operation.id)));
    if (replay._tag === "Failure") return errorResponse(replay.cause);
    if (replay.value) return receiptResponse(replay.value);
  }
  const result = await Effect.runPromiseExit(runForgeOperation(operation, envelope, actor, env, db));
  if (result._tag === "Failure") return errorResponse(result.cause);
  const receipt = { status: "succeeded", operationId: operation.id, response: result.value, replayed: false } satisfies OperationReceipt;
  if (scope) {
    const committed = await Effect.runPromiseExit(idempotency.commit(scope, fingerprint, receipt, reservationId));
    if (committed._tag === "Failure") return errorResponse(committed.cause);
  }
  return receiptResponse(receipt);
}

async function invokePrEligibilityOperation(operation: NativeOperation, envelopeInput: unknown, actor: Actor, env: Env): Promise<Response> {
  let envelope: RequestEnvelope;
  try {
    envelope = decodeRequestEnvelope(envelopeInput);
    if (envelope.operation_id !== operation.id) throw new Error("operation mismatch");
    validateOperationRoute(operation, envelope);
    validateRequestPayload(operation, envelope);
  } catch {
    return jsonError("gfy_domain_contract_invalid", 400);
  }
  const tenantId = envelope.route.tenant_id;
  const pullRequestId = envelope.route.id;
  if (!tenantId || !pullRequestId || actor.tenantId !== tenantId) return jsonError("gfy_permission_denied", 403);
  const namespace = env.GFY_PR_ELIGIBILITY_DO;
  if (!namespace) return jsonError("gfy_candidate_preparation_unavailable", 503);
  const query = envelope.query;
  const input = { tenantId, pullRequestId, actorId: actor.id,
    method: typeof query.method === "string" ? query.method : "merge",
    ...(typeof query.head_sha === "string" ? { headSha: query.head_sha } : {}),
    ...(typeof query.base_sha === "string" ? { baseSha: query.base_sha } : {}) };
  try {
    const coordinator = namespace.get(namespace.idFromName(JSON.stringify([tenantId, pullRequestId])));
    const response = await coordinator.fetch(new Request("https://eligibility.internal/get", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
    }));
    if (response.status === 403) return jsonError("gfy_permission_denied", 403);
    if (response.status === 404) return jsonError("gfy_not_found", 404);
    if (response.status === 409) return jsonError("gfy_stale_precondition", 409);
    const text = await readBoundedEligibilityResponse(response);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new InvalidEligibilityResponseError("coordinator JSON invalid"); }
    if (response.status !== 200) {
      const operationId = body && typeof body === "object" && "operation_id" in body && typeof body.operation_id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(body.operation_id) ? body.operation_id : undefined;
      return Response.json({ ok: false, error: "gfy_candidate_preparation_unavailable", status: 503, ...(operationId ? { operation_id: operationId } : {}) }, { status: 503 });
    }
    try { decodeSourceSchema(sourceDomain, operation.output_schema, body); } catch { throw new InvalidEligibilityResponseError("coordinator schema invalid"); }
    if (!body || typeof body !== "object" || !("tenant_id" in body) || body.tenant_id !== tenantId || !("pull_request_id" in body) || body.pull_request_id !== pullRequestId || !("method" in body) || body.method !== input.method) return jsonError("gfy_domain_contract_invalid", 400);
    return jsonOk(body);
  } catch (error) {
    if (error instanceof InvalidEligibilityResponseError) return jsonError("gfy_domain_contract_invalid", 400);
    return jsonError("gfy_candidate_preparation_unavailable", 503);
  }
}

class InvalidEligibilityResponseError extends Error {}

async function readBoundedEligibilityResponse(response: Response): Promise<string> {
  if (!response.body) throw new InvalidEligibilityResponseError("missing coordinator response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      bytes += read.value.byteLength;
      if (bytes > maxBodyLimitBytes) {
        await reader.cancel().catch(() => undefined);
        throw new InvalidEligibilityResponseError("coordinator response exceeds bound");
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(all); } catch { throw new InvalidEligibilityResponseError("coordinator response encoding invalid"); }
}

function isPublicForkForgePath(pathname: string): boolean {
  return /^\/api\/v2\/tenants\/[^/]+\/repositories\/[^/]+\/forge(?:\/.*)?$/u.test(pathname);
}

async function handleProductionForkForgeRequest(request: Request, env: Env): Promise<Response> {
  const limit = bodyLimitBytes(env);
  if (!limit.ok) return jsonError("gfy_body_limit_invalid", 503);
  const response = await handleForkRequest(request, productionForkForgePorts(env, request, limit.value));
  return response ?? jsonError("gfy_route_not_found", 404);
}

// The operator reads exactly what a repository page reads, with read access only.
// The scheduled site check reads the canonical repository the way the release check does.
export function runScheduledSiteCheck(env: Env, scheduledTime: Date): Promise<void> {
  return recordSiteCheck(env, repositoryLoadPorts(env, new Request("https://gitfoundry.dev/_scheduled/site-check")), scheduledTime);
}

function repositoryLoadPorts(env: Env, request: Request): RepositoryLoadPorts {
  const forge = async (tenantId: string, repositoryId: string, action: "head" | "list") => invokeProductionForkForge(env, request, { tenant_id: tenantId, repository_id: repositoryId }, action, {}, { id: "gitfoundry-operator", kind: "service", tenant_id: tenantId }, async (capability) => capability === "forge.read");
  return {
    head: async (tenantId, repositoryId) => {
      const { version } = (await forge(tenantId, repositoryId, "head")) as { version: { version_commit: string; descriptor: { code_commit: string } } | null };
      return version ? { version_commit: version.version_commit, code_commit: version.descriptor.code_commit } : null;
    },
    list: async (tenantId, repositoryId) => ((await forge(tenantId, repositoryId, "list")) as { versions: readonly unknown[] }).versions,
    tree: async (tenantId, repositoryId, ref) => {
      const db = database(env);
      const source = db ? configuredSourceRead(env, db) : undefined;
      if (!source) throw new SourceReadUnavailableError({ code: "unavailable", reason: "source provider unconfigured", repositoryId });
      const result = await Effect.runPromiseExit(source.tree({ tenantId, repositoryId, ref }));
      if (result._tag === "Success") return result.value;
      const failure = Cause.findErrorOption(result.cause);
      throw Option.isSome(failure) ? failure.value : new SourceReadUnavailableError({ code: "unavailable", reason: "source read defect", repositoryId });
    }
  };
}

function productionForkForgePorts(env: Env, request: Request, maxBodyBytes: number): ForkApiPorts {
  return {
    maxBodyBytes,
    authenticate: async (_request, context, capability) => {
      const auth = await authenticateRequest(request.headers, env, context.tenant_id, env.GFY_AUTH_AUDIENCE ?? "", capability);
      return auth.ok ? forkActorFromSource(auth.sourceActor) : auth.response;
    },
    invoke: async (context, action, payload, actor) => invokeProductionForkForge(env, request, context, action, payload, actor)
  };
}

async function invokeProductionForkForge(env: Env, request: Request, context: ForkApiContext, action: ForkAction, payload: Record<string, unknown>, actor: ForkActor, reauthorize?: ForkForgeReauthorize): Promise<unknown> {
  const db = database(env);
  if (!db) throw { code: "unavailable" };
  if (!(await repositoryExists(db, context.tenant_id, context.repository_id))) throw { code: "not_found" };
  const authorizeForkCapability = async (capability: string, expectedActor: ForkActor): Promise<boolean> => reauthorize ? reauthorize(capability, expectedActor) : publicForkAuthorization(request, env, context.tenant_id, expectedActor, capability);
  if (action === "publish") {
    if (!env.GFY_FORGE_VERIFY_EVIDENCE) throw new ForkForgeUnavailableError("forge evidence verifier is not configured");
    const authorized = await authorizeForkCapability("forge.publish", actor);
    if (!authorized) throw { code: "permission_denied" };
  }
  const git = await configuredForkForgeGit(env, context.tenant_id, context.repository_id);
  if (!git) throw { code: "unavailable" };
  const forgeActor = forgeActorFromForkActor(actor);
  const service = makeForgeService({
    git,
    tenant_id: context.tenant_id,
    repository_id: context.repository_id,
    clock: () => (env.clock?.now() ?? new Date()).toISOString(),
    authorize: async (authorization) => {
      if (authorization.actor.id !== forgeActor.id || authorization.actor.kind !== forgeActor.kind) throw new ForgeVersionAuthenticationError("actor mismatch");
      if (!(await repositoryExists(db, context.tenant_id, context.repository_id))) throw new ForgeVersionAuthenticationError("repository unavailable");
      if (!(await authorizeForkCapability(authorization.capability, actor))) throw new ForgeVersionAuthenticationError("permission denied");
    },
    verifyEvidence: async (evidence) => {
      if (!env.GFY_FORGE_VERIFY_EVIDENCE) throw new ForkForgeUnavailableError("forge evidence verifier is not configured");
      await env.GFY_FORGE_VERIFY_EVIDENCE({ ...evidence, tenant_id: context.tenant_id, repository_id: context.repository_id });
    },
    ...(env.GFY_FORGE_IS_PUBLISHER_STOPPED ? { isPublisherStopped: (operationId: string) => env.GFY_FORGE_IS_PUBLISHER_STOPPED?.({ tenant_id: context.tenant_id, repository_id: context.repository_id, operation_id: operationId }) ?? Promise.resolve(false) } : {})
  });
  let response: unknown;
  switch (action) {
    case "head": response = { version: await service.head(forgeActor) }; break;
    case "list": response = { versions: await service.list(forgeActor) }; break;
    case "view": response = { version: await service.read(requiredPayloadString(payload, "version_commit"), forgeActor) }; break;
    case "read": response = await readForkForgePayload(service, git, forgeActor, payload); break;
    case "compare": response = await compareForkForgePayload(service, forgeActor, payload); break;
    case "initialize": {
      const codeCommit = optionalPayloadString(payload, "code_commit");
      const initialCode = optionalPayloadArray(payload, "initial_code") as readonly InitializeFileChange[] | undefined;
      const initialState = optionalPayloadArray(payload, "initial_state") as readonly InitializeFileChange[] | undefined;
      response = { version: await service.initialize({ operation_id: requiredPayloadString(payload, "operation_id"), actor: forgeActor, ...(codeCommit !== undefined ? { code_commit: codeCommit } : { initial_code: initialCode ?? [] }), ...(initialState !== undefined ? { initial_state: initialState } : {}) }) };
      break;
    }
    case "fork": response = { version: await service.fork({ operation_id: requiredPayloadString(payload, "operation_id"), parent_version: requiredPayloadString(payload, "parent_version"), actor: forgeActor }) }; break;
    case "commit": {
      const parentVersion = requiredPayloadString(payload, "parent_version");
      const changes = requiredPayloadArray(payload, "changes") as readonly ForkForgeChange[];
      const signedChanges = await sealUnsignedReviewChanges(env, context, service, authorizeForkCapability, actor, forgeActor, parentVersion, changes);
      response = { version: await service.commit({ operation_id: requiredPayloadString(payload, "operation_id"), parent_version: parentVersion, changes: signedChanges, actor: forgeActor }) };
      break;
    }
    case "merge": response = await service.merge({ operation_id: requiredPayloadString(payload, "operation_id"), base_version: requiredPayloadString(payload, "base_version"), left_version: requiredPayloadString(payload, "left_version"), right_version: requiredPayloadString(payload, "right_version"), actor: forgeActor }); break;
    case "publish": response = { version: await service.publish({ operation_id: requiredPayloadString(payload, "operation_id"), expected_version: requiredPayloadString(payload, "expected_head"), new_version: requiredPayloadString(payload, "new_version"), actor: forgeActor }) }; break;
    case "recover": response = await service.recover({ operation_id: requiredPayloadString(payload, "publication_operation_id"), actor: forgeActor }); break;
  }
  await appendForkResourceChange(env, db, context, action, payload, response).catch(() => undefined);
  return response;
}

function matchResourceEventsRoute(pathname: string): { readonly tenant_id: string } | undefined {
  const match = /^\/api\/v1\/tenants\/([^/]+)\/events$/u.exec(pathname);
  return match ? { tenant_id: decodeURIComponent(match[1]!) } : undefined;
}

async function handleResourceEvents(request: Request, env: Env, tenantId: string): Promise<Response> {
  const db = database(env);
  if (!db) return jsonError("gfy_auth_unconfigured", 503);
  const auth = await authenticateRequest(request.headers, env, tenantId, env.GFY_AUTH_AUDIENCE ?? "", "repository.read");
  if (!auth.ok) return auth.response;
  await ensureResourceEvents(db);
  const url = new URL(request.url);
  const repositoryId = url.searchParams.get("repository_id") || undefined;
  const cursor = request.headers.get("last-event-id") || url.searchParams.get("cursor") || undefined;
  const encoder = new TextEncoder();
  let cancelStream: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let polling = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let lastCursor = "gfy_0";
      let heartbeatAt = Date.now() + 15000;
      const write = (text: string) => { if (!closed) controller.enqueue(encoder.encode(text)) };
      const close = () => {
        if (closed) return;
        closed = true;
        if (pollTimer !== undefined) clearInterval(pollTimer);
        try { controller.close() } catch {}
      };
      cancelStream = close;
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) { close(); return; }
      const deliver = (replay: Awaited<ReturnType<typeof replayResourceEvents>>, highWater: number) => {
        if (replay.reset) write(formatSse("reset", { reason: replay.reason }));
        for (const row of replay.rows) write(formatSse("change", rowToResourceEvent(row), row.cursor || resourceCursor(row.id)));
        lastCursor = resourceCursor(Math.max(highWater, replay.rows.at(-1)?.id ?? 0));
      };
      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const heartbeatDue = Date.now() >= heartbeatAt;
          const fresh = await authenticateRequest(request.headers, env, tenantId, env.GFY_AUTH_AUDIENCE ?? "", "repository.read");
          if (!fresh.ok) { write(formatSse("reset", { reason: "authorization_revoked" })); close(); return; }
          const highWater = await latestResourceEventId(db, tenantId);
          const replay = await replayResourceEvents(db, tenantId, repositoryId, lastCursor);
          if (closed) return;
          deliver(replay, highWater);
          if (heartbeatDue) { write(": heartbeat\n\n"); heartbeatAt = Date.now() + 15000; }
        } catch { close(); }
        finally { polling = false; }
      };
      try {
        const highWater = await latestResourceEventId(db, tenantId);
        const replay = await replayResourceEvents(db, tenantId, repositoryId, cursor);
        if (closed) return;
        deliver(replay, highWater);
        write(": live\n\n");
        pollTimer = setInterval(() => { void poll(); }, 1000);
      } catch { close(); }
    },
    cancel() { cancelStream?.() }
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

async function latestResourceEventId(db: D1DatabaseLike, tenantId: string): Promise<number> {
  const row = await db.prepare("SELECT MAX(id) AS id FROM resource_events WHERE tenant_id = ?").bind(tenantId).first<{ readonly id: number | null }>();
  return Number(row?.id ?? 0);
}

async function ensureResourceEvents(db: D1DatabaseLike): Promise<void> {
  for (const sql of resourceEventSchemaStatements) await db.prepare(sql).run();
}

async function replayResourceEvents(db: D1DatabaseLike, tenantId: string, repositoryId: string | undefined, cursor: string | undefined): Promise<{ readonly reset: boolean; readonly reason?: string; readonly rows: readonly ResourceEventRow[] }> {
  const afterId = parseResourceCursor(cursor);
  if (cursor && afterId === undefined) return { reset: true, reason: "invalid_cursor", rows: [] };
  const sql = repositoryId
    ? "SELECT id,cursor,source_event_id,tenant_id,repository_id,kind,operation_id,resource_uris_json,authoritative_revision,occurred_at FROM resource_events WHERE tenant_id = ? AND id > ? AND (repository_id = ? OR repository_id IS NULL) ORDER BY id LIMIT ?"
    : "SELECT id,cursor,source_event_id,tenant_id,repository_id,kind,operation_id,resource_uris_json,authoritative_revision,occurred_at FROM resource_events WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?";
  const statement = repositoryId ? db.prepare(sql).bind(tenantId, afterId ?? 0, repositoryId, resourceEventReplayLimit + 1) : db.prepare(sql).bind(tenantId, afterId ?? 0, resourceEventReplayLimit + 1);
  const rows = ((await statement.all<ResourceEventRow>()).results ?? []) as ResourceEventRow[];
  let bytes = 0;
  for (const row of rows) bytes += row.resource_uris_json.length + row.source_event_id.length + row.operation_id.length + row.authoritative_revision.length;
  if (rows.length > resourceEventReplayLimit || bytes > resourceEventReplayBytes) return { reset: true, reason: "replay_window_exceeded", rows: [] };
  return { reset: false, rows };
}

async function appendForkResourceChange(env: Env, db: D1DatabaseLike, context: ForkApiContext, action: ForkAction, payload: Record<string, unknown>, response: unknown): Promise<void> {
  const envelope = await forkResourceChangeEnvelope(env, context, action, payload, response);
  if (!envelope) return;
  await ensureResourceEvents(db);
  await db.prepare("INSERT OR IGNORE INTO resource_events (tenant_id,cursor,source_event_id,occurred_at,repository_id,kind,operation_id,resource_uris_json,authoritative_revision) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(envelope.tenant_id, "", envelope.source_event_id, envelope.occurred_at, envelope.repository_id ?? null, envelope.kind, envelope.operation_id, JSON.stringify(envelope.resource_uris), envelope.authoritative_revision).run();
  const row = await db.prepare("SELECT id,cursor,source_event_id,tenant_id,repository_id,kind,operation_id,resource_uris_json,authoritative_revision,occurred_at FROM resource_events WHERE tenant_id = ? AND source_event_id = ?").bind(envelope.tenant_id, envelope.source_event_id).first<ResourceEventRow>();
  if (!row || row.cursor) return;
  const cursor = resourceCursor(row.id);
  await db.prepare("UPDATE resource_events SET cursor = ? WHERE tenant_id = ? AND id = ? AND cursor = ''").bind(cursor, envelope.tenant_id, row.id).run();
  await pruneResourceEvents(db, envelope.tenant_id, env.clock?.now() ?? new Date());
}

async function forkResourceChangeEnvelope(env: Env, context: ForkApiContext, action: ForkAction, payload: Record<string, unknown>, response: unknown): Promise<ResourceChangeEnvelope | undefined> {
  const version = responseForgeVersion(response);
  if (!version) return undefined;
  const kind = resourceChangeKind(action);
  if (!kind) return undefined;
  const operationId = `forge.${action}`;
  const sourceOperationId = optionalPayloadString(payload, "operation_id") ?? optionalPayloadString(payload, "publication_operation_id") ?? operationId;
  const occurredAt = (env.clock?.now() ?? new Date()).toISOString();
  const resource_uris = resourceUrisFor(context.tenant_id, context.repository_id, version.version_commit);
  const source_event_id = await sha256Hex(stableJson({ tenant_id: context.tenant_id, repository_id: context.repository_id, operation_id: operationId, source_operation_id: sourceOperationId, revision: version.version_commit }));
  return { schema_version: 1, source_event_id, cursor: "", tenant_id: context.tenant_id, repository_id: context.repository_id, kind, operation_id: operationId, resource_uris, authoritative_revision: version.version_commit, occurred_at: occurredAt };
}

function responseForgeVersion(response: unknown): ForgeVersion | undefined {
  if (!response || typeof response !== "object" || !("version" in response)) return undefined;
  const version = (response as { readonly version?: unknown }).version;
  return version && typeof version === "object" && "version_commit" in version && typeof (version as { readonly version_commit?: unknown }).version_commit === "string" ? version as ForgeVersion : undefined;
}

function resourceChangeKind(action: ForkAction): ResourceChangeKind | undefined {
  if (action === "publish") return "head_updated";
  if (action === "recover") return "recovered";
  return ["initialize", "fork", "commit", "merge"].includes(action) ? "version_created" : undefined;
}

function resourceUrisFor(tenantId: string, repositoryId: string, versionCommit: string): readonly string[] {
  return [`gfy://tenant/${tenantId}/repositories`, `gfy://tenant/${tenantId}/repositories/${repositoryId}`, `gfy://tenant/${tenantId}/repositories/${repositoryId}/forge/head`, `gfy://tenant/${tenantId}/repositories/${repositoryId}/forge/versions/${versionCommit}`];
}

async function pruneResourceEvents(db: D1DatabaseLike, tenantId: string, now: Date): Promise<void> {
  await db.prepare("DELETE FROM resource_events WHERE tenant_id = ? AND occurred_at < ?").bind(tenantId, new Date(now.getTime() - resourceEventRetentionMs).toISOString()).run();
  await db.prepare("DELETE FROM resource_events WHERE tenant_id = ? AND id NOT IN (SELECT id FROM resource_events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?)").bind(tenantId, tenantId, resourceEventRetentionCount).run();
}

function rowToResourceEvent(row: ResourceEventRow): ResourceChangeEnvelope {
  return { schema_version: 1, source_event_id: row.source_event_id, cursor: row.cursor || resourceCursor(row.id), tenant_id: row.tenant_id, ...(row.repository_id ? { repository_id: row.repository_id } : {}), kind: row.kind, operation_id: row.operation_id, resource_uris: JSON.parse(row.resource_uris_json) as readonly string[], authoritative_revision: row.authoritative_revision, occurred_at: row.occurred_at };
}

function parseResourceCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return 0;
  const match = /^gfy_(\d+)$/u.exec(cursor);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resourceCursor(id: number): string { return `gfy_${id}` }
function formatSse(event: string, payload: unknown, id?: string): string { return `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${stableJson(payload)}\n\n` }

async function publicForkAuthorization(request: Request, env: Env, tenantId: string, actor: ForkActor, capability: string): Promise<boolean> {
  const fresh = await authenticateRequest(request.headers, env, tenantId, env.GFY_AUTH_AUDIENCE ?? "", capability);
  return fresh.ok && fresh.sourceActor.principal_id === actor.id && fresh.sourceActor.kind === actor.kind && fresh.sourceActor.tenant_id === actor.tenant_id;
}

async function sealUnsignedReviewChanges(env: Env, context: ForkApiContext, service: ReturnType<typeof makeForgeService>, authorizeForkCapability: (capability: string, actor: ForkActor) => Promise<boolean>, forkActor: ForkActor, forgeActor: ForgeActor, parentVersionCommit: string, changes: readonly ForkForgeChange[]): Promise<readonly ForkForgeChange[]> {
  if (!env.GFY_FORGE_SIGN_REVIEW) return changes;
  const unsigned = changes.map((change, index) => ({ change, index, record: unsignedReviewRecord(change) })).filter((entry): entry is { change: ForkForgeChange; index: number; record: Record<string, unknown> } => Boolean(entry.record));
  if (unsigned.length === 0) return changes;
  if (!(await authorizeForkCapability("review.write", forkActor))) throw new ForgeVersionAuthenticationError("review.write is required");
  const parent = await service.read(parentVersionCommit, forgeActor);
  const next = [...changes];
  for (const entry of unsigned) {
    const bound = bindReviewRecord(entry.record, forgeActor, parent.descriptor.code_commit);
    const sealed = await env.GFY_FORGE_SIGN_REVIEW({ tenant_id: context.tenant_id, repository_id: context.repository_id, actor: forgeActor, parent, record: bound });
    validateReviewBinding(sealed, forgeActor, parent.descriptor.code_commit);
    next[entry.index] = { ...entry.change, content_base64: encodeBase64Utf8(stableJson(sealed)) };
  }
  return next;
}

function unsignedReviewRecord(change: ForkForgeChange): Record<string, unknown> | undefined {
  if (change.tree !== "state" || change.content_base64 === null || !/^reviews\/[a-z0-9][a-z0-9._-]{0,127}\.json$/u.test(change.path)) return undefined;
  let record: unknown;
  try { record = JSON.parse(decodeBase64Utf8(change.content_base64)) } catch { return undefined }
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;
  return value.kind === "review" && value.signature === undefined ? value : undefined;
}

function bindReviewRecord(record: Record<string, unknown>, actor: ForgeActor, candidateCodeCommit: string): Record<string, unknown> {
  if ((record.actor_id !== undefined && record.actor_id !== actor.id) || (record.actor_kind !== undefined && record.actor_kind !== actor.kind) || (record.candidate_code_commit !== undefined && record.candidate_code_commit !== candidateCodeCommit)) throw new ForgeVersionAuthenticationError("forged review binding");
  return { ...record, actor_id: actor.id, actor_kind: actor.kind, candidate_code_commit: candidateCodeCommit };
}

function validateReviewBinding(record: Record<string, unknown>, actor: ForgeActor, candidateCodeCommit: string): void {
  if (record.kind !== "review" || record.actor_id !== actor.id || record.actor_kind !== actor.kind || record.candidate_code_commit !== candidateCodeCommit) throw new ForgeVersionAuthenticationError("invalid review binding");
}

async function invokePrivateForkForge(_request: Request, env: Env, body: unknown, operationId: string): Promise<Response> {
  const action = forkActionFromOperationId(operationId);
  if (!action) return jsonError("gfy_unsupported_operation", 501, operationId);
  const db = database(env);
  if (!db) return jsonError("gfy_auth_unconfigured", 503);
  const contextRecord = readRecord(body, "context");
  const tenantId = readString(contextRecord, "tenant_id");
  const principalId = readString(contextRecord, "principal_id");
  const grantRef = readString(contextRecord, "grant_ref");
  const policyEpoch = readNumber(contextRecord, "policy_epoch");
  if (!tenantId || !principalId || !grantRef || policyEpoch === undefined) return jsonError("gfy_body_invalid", 400, "verified invoke context is required");
  const args = readRecord(body, "arguments");
  const route = normalizeStringRecord(readRecord(args, "route"));
  const repositoryId = route.repository_id ?? route.id;
  if (route.tenant_id !== tenantId || !repositoryId) return jsonError("gfy_permission_denied", 403);
  const execution = readRecord(body, "execution");
  const query = normalizeStringRecord(readRecord(args, "query"));
  const payload = privateForkBody(args, action);
  if (payload instanceof Response) return payload;
  const privateRequest = privateForkRequest(action, tenantId, repositoryId, route, query, payload, readString(execution, "idempotency_key"));
  if (privateRequest instanceof Response) return privateRequest;
  const limit = bodyLimitBytes(env);
  if (!limit.ok) return jsonError("gfy_body_limit_invalid", 503);
  const identityGrant = await currentGrant(env, tenantId, principalId, "identity.read", policyEpoch);
  if (!identityGrant || identityGrant.grantRef !== grantRef) return jsonError("gfy_permission_denied", 403);
  const ports: ForkApiPorts = {
    maxBodyBytes: limit.value,
    authenticate: async (_incoming, routeContext, capability) => {
      if (routeContext.tenant_id !== tenantId || routeContext.repository_id !== repositoryId) return jsonError("gfy_permission_denied", 403);
      const capabilityGrant = await currentGrant(env, tenantId, principalId, capability, policyEpoch);
      return capabilityGrant ? forkActorFromSource(signedIn(capabilityGrant).sourceActor) : jsonError("gfy_permission_denied", 403);
    },
    invoke: async (routeContext, routeAction, normalized, actor) => invokeProductionForkForge(env, privateRequest, routeContext, routeAction, normalized, actor, async (capability, expectedActor) => {
      if (routeContext.tenant_id !== tenantId || routeContext.repository_id !== repositoryId) return false;
      const capabilityGrant = await currentGrant(env, tenantId, principalId, capability, policyEpoch);
      return Boolean(capabilityGrant) && expectedActor.id === principalId && expectedActor.kind === capabilityGrant!.kind && expectedActor.tenant_id === tenantId;
    })
  };
  return await handleForkRequest(privateRequest, ports) ?? jsonError("gfy_route_not_found", 404);
}

function isForkForgeOperationId(operationId: string | undefined): operationId is string {
  return Boolean(operationId && (forkForgeOperationIds as readonly string[]).includes(operationId));
}

function forkActionFromOperationId(operationId: string): ForkAction | undefined {
  switch (operationId) {
    case "forge.head": return "head";
    case "forge.list": return "list";
    case "forge.view": return "view";
    case "forge.read": return "read";
    case "forge.compare": return "compare";
    case "forge.initialize": return "initialize";
    case "forge.fork": return "fork";
    case "forge.commit": return "commit";
    case "forge.merge": return "merge";
    case "forge.publish": return "publish";
    case "forge.recover": return "recover";
    default: return undefined;
  }
}

function privateForkBody(args: Record<string, unknown>, action: ForkAction): Record<string, unknown> | Response {
  if (!Object.prototype.hasOwnProperty.call(args, "body") || args.body === null) return {};
  const body = args.body;
  if (body === null && ["head", "list", "view", "read", "compare"].includes(action)) return {};
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : jsonError("gfy_body_invalid", 400, "fork body must be an object");
}

function privateForkRequest(action: ForkAction, tenantId: string, repositoryId: string, route: Record<string, string>, query: Record<string, string>, body: Record<string, unknown>, idempotencyKey: string | undefined): Request | Response {
  const root = `/api/v2/tenants/${encodeURIComponent(tenantId)}/repositories/${encodeURIComponent(repositoryId)}/forge`;
  let path = root;
  const search = new URLSearchParams();
  if (action === "head") path += "/head";
  else if (action === "list") path += "/forks";
  else if (action === "view") {
    const version = route.version_commit ?? route.version ?? route.id;
    if (!version) return jsonError("gfy_body_invalid", 400, "version route is required");
    path += `/versions/${encodeURIComponent(version)}`;
  } else if (action === "read") {
    path += "/files";
    for (const key of ["version", "tree", "path", "prefix"]) if (query[key]) search.set(key, query[key]);
  } else if (action === "compare") {
    path += "/compare";
    for (const key of ["base_version", "head_version"]) if (query[key]) search.set(key, query[key]);
  } else path += `/${action}`;
  const headers = new Headers();
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  if (action === "head" || action === "list" || action === "view" || action === "read" || action === "compare") return new Request(`https://gitfoundry.private${path}${search.size ? `?${search}` : ""}`, { method: "GET", headers });
  headers.set("content-type", "application/json");
  return new Request(`https://gitfoundry.private${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function readForkForgePayload(service: ReturnType<typeof makeForgeService>, git: ForgeGitPort, actor: ForgeActor, payload: Record<string, unknown>): Promise<unknown> {
  const versionCommit = requiredPayloadString(payload, "version");
  const tree = requiredPayloadString(payload, "tree");
  const path = optionalPayloadString(payload, "path");
  const prefix = optionalPayloadString(payload, "prefix") ?? "";
  const version = await service.read(versionCommit, actor);
  const root = tree === "code" ? version.descriptor.code_commit : version.descriptor.state_commit;
  if (!path) return { version: version.version_commit, tree, prefix, entries: await git.listTree(root, prefix) };
  const content = await git.readFile(root, path);
  if (content === null) throw { code: "not_found" };
  return { version: version.version_commit, tree, path, encoding: "base64", content };
}

async function compareForkForgePayload(service: ReturnType<typeof makeForgeService>, actor: ForgeActor, payload: Record<string, unknown>): Promise<unknown> {
  const comparison = await service.compare({ base_version: requiredPayloadString(payload, "base_version"), head_version: requiredPayloadString(payload, "head_version"), actor });
  return { base_version: comparison.base.version_commit, head_version: comparison.head.version_commit, code_changes: comparison.code.files, state_changes: comparison.state.files };
}

async function repositoryExists(db: D1DatabaseLike, tenantId: string, repositoryId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS ok FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, repositoryId).first<{ ok: number }>();
  return Boolean(row);
}

function forkActorFromSource(source: SourceActorIdentity): ForkActor {
  return { id: source.principal_id, tenant_id: source.tenant_id, kind: source.kind };
}

function forgeActorFromForkActor(actor: ForkActor): ForgeActor {
  return { id: actor.id, kind: actor.kind === "human" || actor.kind === "service" ? actor.kind : "agent" };
}

function requiredPayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new ForkForgeInputError(`${key} is required`);
  return value;
}

function requiredPayloadArray(payload: Record<string, unknown>, key: string): readonly unknown[] {
  const value = payload[key];
  if (!Array.isArray(value)) throw new ForkForgeInputError(`${key} is required`);
  return value;
}

function optionalPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new ForkForgeInputError(`${key} is invalid`);
  return value;
}

function optionalPayloadArray(payload: Record<string, unknown>, key: string): readonly unknown[] | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ForkForgeInputError(`${key} is invalid`);
  return value;
}

async function invokeSourceOperation(operation: NativeOperation, envelopeInput: unknown, env: Env, db: D1DatabaseLike): Promise<Response> {
  let envelope: RequestEnvelope;
  try {
    envelope = decodeRequestEnvelope(envelopeInput);
    if (envelope.operation_id !== operation.id) throw new Error(`envelope operation ${envelope.operation_id} does not match ${operation.id}`);
    validateOperationRoute(operation, envelope);
    validateRequestPayload(operation, envelope);
  } catch (error) {
    return jsonError("gfy_domain_contract_invalid", 400, String(error));
  }
  const tenantId = envelope.route.tenant_id;
  const repositoryId = envelope.route.id;
  if (!tenantId || !repositoryId) return jsonError("gfy_domain_contract_invalid", 400, "tenant and repository route are required");
  const source = configuredSourceRead(env, db);
  if (!source) return jsonError("gfy_git_reference_unavailable", 503, "source provider unavailable");
  const treeRef = operation.id === "repo.tree" ? await defaultBranchCode(env, db, tenantId, repositoryId, String(envelope.query.ref)) : "";
  const result = operation.id === "repo.tree"
    ? await Effect.runPromiseExit(source.tree({ tenantId, repositoryId, ref: treeRef, path: typeof envelope.query.path === "string" ? envelope.query.path : undefined, recursive: envelope.query.recursive === true, limit: typeof envelope.query.limit === "number" ? envelope.query.limit : undefined, cursor: typeof envelope.query.cursor === "string" ? envelope.query.cursor : undefined, direction: typeof envelope.query.direction === "string" ? envelope.query.direction : undefined }))
    : await Effect.runPromiseExit(source.diff({ tenantId, repositoryId, base: String(envelope.query.base), head: String(envelope.query.head), comparison: typeof envelope.query.comparison === "string" ? envelope.query.comparison : undefined, pathPrefix: typeof envelope.query.path_prefix === "string" ? envelope.query.path_prefix : undefined, contextLines: typeof envelope.query.context_lines === "number" ? envelope.query.context_lines : undefined, limit: typeof envelope.query.limit === "number" ? envelope.query.limit : undefined, cursor: typeof envelope.query.cursor === "string" ? envelope.query.cursor : undefined, direction: typeof envelope.query.direction === "string" ? envelope.query.direction : undefined }));
  if (result._tag === "Failure") return sourceReadErrorResponse(result.cause);
  try { decodeSourceSchema(sourceDomain, operation.output_schema, result.value); return jsonOk(result.value) } catch (error) { return jsonError("gfy_domain_contract_invalid", 400, String(error)) }
}

// A repository's default branch names its accepted code, which the forge head records; production
// keeps no separate branch for it.
async function defaultBranchCode(env: Env, db: D1DatabaseLike, tenantId: string, repositoryId: string, ref: string): Promise<string> {
  if (isGitSha(ref)) return ref;
  const row = await db.prepare("SELECT default_branch FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, repositoryId).first<{ default_branch: string }>();
  if (row?.default_branch !== ref) return ref;
  try {
    const head = await invokeProductionForkForge(env, new Request("https://gitfoundry.internal/source-default-branch"), { tenant_id: tenantId, repository_id: repositoryId }, "head", {}, { id: "gitfoundry-source-reader", kind: "service", tenant_id: tenantId }, async (capability) => capability === "forge.read") as { version: { descriptor: { code_commit: string } } | null };
    return head.version?.descriptor.code_commit ?? ref;
  } catch {
    return ref;
  }
}

async function handleSourceFile(request: Request, env: Env, url: URL, route: { tenant_id: string; id: string }): Promise<Response> {
  const db = database(env);
  if (!db) return jsonError("gfy_auth_unconfigured", 503);
  const tenantId = route.tenant_id;
  const repositoryId = route.id;
  const auth = await authenticateRequest(request.headers, env, tenantId, env.GFY_AUTH_AUDIENCE ?? "", "repository.read");
  if (!auth.ok) return auth.response;
  const ref = url.searchParams.get("ref") ?? "";
  const path = url.searchParams.get("path") ?? "";
  if (!isGitSha(ref) || !validateSourcePath(path) || path.length === 0) return jsonError("gfy_domain_contract_invalid", 400, "immutable ref and valid path are required");
  const source = configuredSourceRead(env, db);
  if (!source) return jsonError("gfy_git_reference_unavailable", 503, "source provider unavailable");
  const result = await Effect.runPromiseExit(source.readFile({ tenantId, repositoryId, ref, path }));
  if (result._tag === "Failure") return sourceReadErrorResponse(result.cause);
  return sourceFileResponse(result.value);
}

function runForgeOperation(operation: NativeOperation, envelope: RequestEnvelope, actor: Actor, env: Env, db: D1DatabaseLike): Effect.Effect<unknown, unknown> {
  const issues = makeD1ForgeIssueStore(db, env.clock);
  const pullRequests = makeD1ForgePullRequestStore(db, { clock: env.clock, gitRead: configuredGitRead(env, db) });
  const forge = makeD1ForgeStore(db, { clock: env.clock, gitRead: configuredGitRead(env, db) });
  return Effect.gen(function* () {
    const tenantId = envelope.route.tenant_id ?? "";
    const id = envelope.route.id ?? "";
    let response: unknown;
    switch (operation.id) {
      case "issue.list": response = yield* issues.list(tenantId, envelope.query); break;
      case "issue.view": response = yield* issues.get(tenantId, id); break;
      case "issue.create": response = yield* issues.create(tenantId, actor.id, envelope.body as never); break;
      case "issue.edit": response = yield* issues.update(tenantId, id, actor.id, envelope.body as never, envelope.expected_version); break;
      case "pr.list": response = yield* pullRequests.list(tenantId, envelope.query); break;
      case "pr.view": response = yield* pullRequests.get(tenantId, id); break;
      case "pr.create": response = yield* pullRequests.create(tenantId, actor.id, envelope.body as never); break;
      case "pr.edit": response = yield* pullRequests.update(tenantId, id, actor.id, envelope.body as never, envelope.expected_version); break;
      case "comment.list": response = yield* forge.listComments(tenantId, envelope.query); break;
      case "comment.view": response = yield* forge.getComment(tenantId, id); break;
      case "comment.create": response = yield* forge.createComment(tenantId, actor, envelope.body as never); break;
      case "comment.edit": response = yield* forge.updateComment(tenantId, id, envelope.expected_version ?? -1, envelope.body as never); break;
      case "review.list": response = yield* forge.listReviews(tenantId, envelope.query); break;
      case "review.view": response = yield* forge.getReview(tenantId, id); break;
      case "review.create": response = yield* forge.createReview(tenantId, actor, envelope.body as never); break;
      case "review.edit": response = yield* forge.updateReview(tenantId, id, envelope.expected_version ?? -1, envelope.body as never); break;
      default: throw new Error(`unsupported forge operation ${operation.id}`);
    }
    decodeSourceSchema(sourceDomain, operation.output_schema, response);
    return response;
  });
}

function receiptResponse(receipt: OperationReceipt, status = 200): Response {
  if (receipt.status === "succeeded") return jsonOk(receipt.response, { status, ...(receipt.replayed ? { headers: { "GitFoundry-Idempotent-Replay": "true" } } : {}) });
  return jsonOk({ status: receipt.status, operation_id: receipt.operationId, reason: receipt.reason, receipt_id: receipt.receiptId }, { status: 202 });
}

function errorResponse(cause: unknown): Response {
  const failure = Cause.isCause(cause) ? Cause.findErrorOption(cause) : Option.none();
  const error = Option.isSome(failure) ? failure.value : cause;
  const text = error && typeof error === "object" && "_tag" in error && typeof error._tag === "string" ? error._tag : "";
  if (text.includes("UnauthorizedError")) return jsonError("gfy_permission_denied", 403);
  if (text.includes("NotFoundError")) return jsonError("gfy_not_found", 404);
  if (text.includes("IdempotencyConflictError")) return jsonError("gfy_idempotency_conflict", 409);
  if (text.includes("RepositoryNameConflictError")) return jsonError("gfy_repository_name_conflict", 409);
  if (text.includes("RepositoryHasForksError")) return jsonError("gfy_repository_has_forks", 409);
  if (text.includes("RepositoryStoreUnavailableError")) return jsonError("gfy_repository_store_unavailable", 503);
  if (text.includes("StalePreconditionError")) return jsonError("gfy_stale_precondition", 409);
  if (text.includes("UnsupportedOperationError")) return jsonError("gfy_unsupported_operation", 501);
  if (text.includes("GitProvisionerUnavailableError")) return jsonError("gfy_git_provisioner_unavailable", 503);
  if (text.includes("GitReferenceUnavailableError")) return jsonError("gfy_git_reference_unavailable", 503);
  return jsonError("gfy_domain_contract_invalid", 400);
}

// The one way in: a GitFoundry sign-in, sent as the browser cookie or as a bearer token.
async function authenticateRequest(headers: Headers, env: Env, requestedTenantId: string, _audience: string, capability: string): Promise<{ ok: true; actor: Actor; sourceActor: SourceActorIdentity; verified: VerifiedIdentity } | { ok: false; response: Response }> {
  const session = await authenticateSession(headers, env, requestedTenantId, capability);
  if (!session) return { ok: false, response: jsonError("gfy_auth_invalid", 401) };
  if (!session.ok) return { ok: false, response: jsonError(session.error, session.status) };
  return signedIn(session.session);
}

function signedIn(grant: WorkspaceSession): { ok: true; actor: Actor; sourceActor: SourceActorIdentity; verified: VerifiedIdentity } {
  const { tenantId, principalId, policyEpoch, scopes, grantRef, kind } = grant;
  return { ok: true, actor: { id: principalId, tenantId, revoked: false, capabilities: [...scopes] }, sourceActor: { tenant_id: tenantId, principal_id: principalId, kind, policy_epoch: policyEpoch, scopes: [...scopes] }, verified: { tenant_id: tenantId, principal_id: principalId, grant_ref: grantRef, policy_epoch: policyEpoch } };
}

// Re-checks a principal an earlier sign-in identified, against its current grants.
async function currentGrant(env: Env, tenantId: string, principalId: string, capability: string, policyEpoch?: number): Promise<WorkspaceSession | undefined> {
  const db = database(env);
  if (!db) return undefined;
  const grant = await workspaceGrant(db, tenantId, principalId, capability, (env.clock?.now() ?? new Date()).getTime());
  return grant && (policyEpoch === undefined || grant.policyEpoch === policyEpoch) ? grant : undefined;
}

async function authenticateAuthorization(authorization: string | null | undefined, env: Env, requestedTenantId: string, audience: string, capability: string): Promise<{ ok: true; actor: Actor; sourceActor: SourceActorIdentity; verified: VerifiedIdentity } | { ok: false; response: Response }> {
  // MCP clients send the same sign-in a browser or the CLI holds.
  return authenticateRequest(new Headers(authorization ? { authorization } : {}), env, requestedTenantId, audience, capability);
}







function activeOwnerCapabilities(): readonly string[] {
  const capabilities = new Set(
    nativeOperations.filter((operation) => implemented.has(operation.id)).map((operation) => operation.capability),
  );
  for (const capability of [
    "forge.initialize",
    "forge.read",
    "forge.fork",
    "forge.commit",
    "forge.compare",
    "forge.merge",
    "forge.publish",
    "forge.recover",
    "actions:runner-registration",
  ]) {
    capabilities.add(capability);
  }
  return Array.from(capabilities).sort();
}

function actorResponse(operation: NativeOperation, actor: SourceActorIdentity): Response {
  try { decodeSourceSchema(sourceDomain, operation.output_schema, actor); return jsonOk(actor) } catch (error) { return jsonError("gfy_domain_contract_invalid", 400, String(error)) }
}




function parseJwtHeader(value: unknown): { ok: true; alg: "RS256"; kid: string } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "jwt header must be an object" };
  const header = value as Record<string, unknown>;
  return header.alg === "RS256" && typeof header.kid === "string" && header.kid.length > 0 ? { ok: true, alg: "RS256", kid: header.kid } : { ok: false, reason: "unsupported jwt algorithm" };
}

function parseJwtClaims(value: unknown, issuer: string, audience: string, nowSeconds: number): { ok: true; claims: JwtClaims } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "jwt claims must be an object" };
  const claims = value as Record<string, unknown>;
  const iss = claims.iss;
  const sub = claims.sub;
  const exp = claims.exp;
  const nbf = claims.nbf;
  if (iss !== issuer || typeof iss !== "string" || iss.length === 0) return { ok: false, reason: "issuer mismatch" };
  if (typeof sub !== "string" || sub.length === 0) return { ok: false, reason: "subject missing" };
  if (typeof exp !== "number" || !Number.isInteger(exp) || !Number.isFinite(exp)) return { ok: false, reason: "exp missing" };
  if (exp <= nowSeconds) return { ok: false, reason: "token expired" };
  if (nbf !== undefined && (typeof nbf !== "number" || !Number.isInteger(nbf) || !Number.isFinite(nbf))) return { ok: false, reason: "nbf invalid" };
  if (typeof nbf === "number" && nbf > nowSeconds) return { ok: false, reason: "token not yet valid" };
  const audiences = normalizeAudience(claims.aud);
  if (!audiences || !audiences.includes(audience)) return { ok: false, reason: "audience mismatch" };
  return { ok: true, claims: { ...claims, iss, sub, aud: Array.isArray(claims.aud) ? [...audiences] : audiences[0] ?? audience, exp, ...(typeof nbf === "number" ? { nbf } : {}) } as JwtClaims };
}

function normalizeAudience(value: unknown): readonly string[] | undefined {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)) return value;
  return undefined;
}

function validateOperationRoute(operation: NativeOperation, envelope: RequestEnvelope): void {
  const expected = Array.from(operation.path.matchAll(/\{([^}]+)\}/g)).map((match) => match[1]).filter((key): key is string => typeof key === "string").sort();
  const actual = Object.keys(envelope.route).sort();
  if (actual.join("\u0000") !== expected.join("\u0000")) throw new Error(`route keys expected ${expected.join(",")}, got ${actual.join(",")}`);
}

function validateRequestPayload(operation: NativeOperation, envelope: RequestEnvelope): void {
  if (operation.request_schema) decodeSourceSchema(sourceDomain, operation.request_schema, operation.request_location === "query" ? envelope.query : operation.request_location === "body" ? envelope.body : envelope.route);
  else if ((operation.request_location === "query" && Object.keys(envelope.query).length > 0) || (operation.request_location === "body" && envelope.body !== null && envelope.body !== undefined)) throw new Error(`${operation.id} payload must be empty`);
}

function makePendingOperation(tenantId: string, id: string, kind: string): OperationRecord {
  const now = "2026-10-08T00:00:00.000Z";
  return { tenant_id: tenantId, id, version: 1, created_at: now, updated_at: now, status: "running", kind, progress: {}, result: {}, error: null };
}

function buildEnvelope(operation: NativeOperation, route: Record<string, string>, search: URLSearchParams, headers: Headers, body: unknown): Record<string, unknown> { return { operation_id: operation.id, route, query: queryRecord(search), headers: {}, body: operation.request_location === "body" ? body : null, cookies: {}, idempotency_key: headers.get("idempotency-key") ?? undefined, expected_version: expectedVersion(headers.get("if-match")), api_version: "v1" } }
function compileRoute(operation: NativeOperation): OperationRoute { const keys: string[] = []; const source = operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => { keys.push(key); return "([^/]+)" }); return { operation, keys, regex: new RegExp(`^${source}$`) } }
function matchRoute(method: string, pathname: string): { operation: NativeOperation; route: Record<string, string> } | undefined { for (const route of routes) { if (route.operation.method !== method.toUpperCase()) continue; const match = route.regex.exec(pathname); if (!match) continue; const values: Record<string, string> = {}; route.keys.forEach((key, index) => { values[key] = decodeURIComponent(match[index + 1] ?? "") }); return { operation: route.operation, route: values } } return undefined }
function matchSourceFileRoute(method: string, pathname: string): { tenant_id: string; id: string } | undefined { if (method.toUpperCase() !== "GET") return undefined; const match = /^\/api\/v1\/tenants\/([^/]+)\/repositories\/([^/]+)\/source-file$/.exec(pathname); return match ? { tenant_id: decodeURIComponent(match[1] ?? ""), id: decodeURIComponent(match[2] ?? "") } : undefined }

async function readBody(request: Request, env: Env): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (request.method === "GET" || request.method === "HEAD") return { ok: true, body: null };
  const limit = bodyLimitBytes(env);
  if (!limit.ok) return { ok: false, response: jsonError("gfy_body_limit_invalid", 503) };
  if (!request.body) return { ok: true, body: null };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit.value) {
      await reader.cancel();
      return { ok: false, response: jsonError("gfy_body_too_large", 413) };
    }
    chunks.push(next.value);
  }
  if (size === 0) return { ok: true, body: null };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) } } catch { return { ok: false, response: jsonError("gfy_body_invalid", 400) } }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceFileResponse(body: SourceFileResponse): Response { return jsonOk(body) }
function sourceReadErrorResponse(cause: unknown): Response {
  const failure = Cause.isCause(cause) ? Cause.findErrorOption(cause) : Option.none();
  const error = Option.isSome(failure) ? failure.value : cause;
  if (error instanceof SourceReadUnavailableError) {
    if (error.code === "invalid_input") return jsonError("gfy_domain_contract_invalid", 400, error.reason);
    if (error.code === "not_found") return jsonError("gfy_not_found", 404, error.reason);
    if (error.code === "unsupported") return jsonError("gfy_unsupported_operation", 501, error.reason);
  }
  return jsonError("gfy_git_reference_unavailable", 503);
}
function isForgeOperation(operationId: string): boolean { return forgeOperations.has(operationId) }
function isSourceOperation(operationId: string): boolean { return sourceOperations.has(operationId) }
function bodyLimitBytes(env: Env): { ok: true; value: number } | { ok: false } { const raw = env.GFY_BODY_LIMIT_BYTES ?? String(maxBodyLimitBytes); const value = Number(raw); return Number.isInteger(value) && value > 0 && value <= maxBodyLimitBytes ? { ok: true, value } : { ok: false } }
function queryRecord(search: URLSearchParams): Record<string, unknown> { const query: Record<string, unknown> = {}; for (const [key, value] of search) query[key] = value === "true" ? true : value === "false" ? false : /^-?[0-9]+$/.test(value) ? Number(value) : value; return query }
function expectedVersion(value: string | null): number | undefined { if (!value) return undefined; const normalized = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value; const number = Number(normalized); return Number.isInteger(number) && number >= 0 ? number : undefined }
function hasAuthConfig(env: Env): boolean { return Boolean(env.GFY_AUTH_ISSUER && env.GFY_AUTH_AUDIENCE && env.GFY_AUTH_JWKS_URL) }
function database(env: Env): D1DatabaseLike | undefined { return env.GFY_DB ?? env.DB }
// The signed-in owner lands in their own workspace; the page reads its starting tenant from this tag.
async function withDefaultTenant(page: Response, tenantId: string): Promise<Response> {
  const html = (await page.text()).replace('name="gitfoundry-default-tenant" content=""', `name="gitfoundry-default-tenant" content="${tenantId}"`);
  const headers = new Headers(page.headers);
  headers.delete("content-length");
  return new Response(html, { status: page.status, headers });
}
function isAssetPath(pathname: string): boolean { return pathname === "/" || pathname === "/index.html" || pathname === "/src" || pathname.startsWith("/src/") }
function decodeBase64Url(value: string): string { return new TextDecoder().decode(base64UrlBytes(value)) }
function base64UrlBytes(value: string): Uint8Array { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); const padded = normalized + "===".slice((normalized.length + 3) % 4); const binary = atob(padded); return Uint8Array.from(binary, (char) => char.charCodeAt(0)) }
function normalizeStringRecord(value: Record<string, unknown>): Record<string, string> { return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }
function readRecord(value: unknown, key: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return {}; const item = (value as Record<string, unknown>)[key]; return item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {} }
function readString(value: unknown, key: string): string | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const item = (value as Record<string, unknown>)[key]; return typeof item === "string" ? item : undefined }
function readNumber(value: unknown, key: string): number | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const item = (value as Record<string, unknown>)[key]; return typeof item === "number" ? item : undefined }

function configuredArtifactsProvisioner(env: Env): GitProvisioner | undefined {
  if (!env.GFY_GIT || !env.GFY_GIT_NAMESPACE || !env.GFY_GIT_URL_BASE) return undefined;
  let publicUrl: URL;
  try { publicUrl = new URL(env.GFY_GIT_URL_BASE) } catch { return undefined }
  if (publicUrl.protocol !== "https:" || !publicUrl.hostname || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) return undefined;
  return makeArtifactsGitProvisioner(env.GFY_GIT, {
    namespace: env.GFY_GIT_NAMESPACE,
    publicGitUrlBase: env.GFY_GIT_URL_BASE
  });
}

function configuredGitRead(env: Env, db: D1DatabaseLike): QualifiedGitReadPort | undefined {
  if (env.GFY_GIT_READ) return env.GFY_GIT_READ;
  if (!env.GFY_GIT || !env.GFY_GIT_NAMESPACE) return undefined;
  return makeD1ArtifactsGitRead(db, env.GFY_GIT, { namespace: env.GFY_GIT_NAMESPACE });
}

function configuredSourceRead(env: Env, db: D1DatabaseLike): SourceReadPort | undefined {
  if (env.GFY_SOURCE_READ) return env.GFY_SOURCE_READ;
  if (!env.GFY_GIT || !env.GFY_GIT_NAMESPACE) return undefined;
  return makeD1ArtifactsSourceRead(db, env.GFY_GIT, { namespace: env.GFY_GIT_NAMESPACE });
}

async function configuredForkForgeGit(env: Env, tenantId: string, repositoryId: string): Promise<ForgeGitPort | undefined> {
  const configured = env.GFY_FORGE_GIT;
  if (!configured) return undefined;
  return typeof configured === "function" ? await configured({ tenantId, repositoryId }) : configured;
}
