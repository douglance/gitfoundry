export interface ForkActor {
  readonly id: string;
  readonly kind: string;
  readonly tenant_id: string;
}

export interface ForkApiContext {
  readonly tenant_id: string;
  readonly repository_id: string;
  readonly version_commit?: string;
}

export type ForkAction = "head" | "list" | "view" | "read" | "compare" | "initialize" | "fork" | "commit" | "merge" | "publish" | "recover";

export interface ForkApiPorts {
  readonly maxBodyBytes?: number;
  readonly authenticate: (request: Request, context: ForkApiContext, capability: string) => Promise<ForkActor | Response>;
  readonly invoke: (context: ForkApiContext, action: ForkAction, payload: Record<string, unknown>, actor: ForkActor) => Promise<unknown>;
}

interface ForkRoute {
  readonly context: ForkApiContext;
  readonly action: ForkAction;
  readonly allowedMethod: "GET" | "POST";
}

const rootPattern = /^\/api\/v2\/tenants\/([^/]+)\/repositories\/([^/]+)\/forge(?:\/(.*))?$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const defaultMaxBodyBytes = 1024 * 1024;
const backendFailureReasons = new Set(["credential_request_failed", "credential_response_invalid", "credential_expiry_invalid"]);
const backendFailureCodes = new Set(["provider_unavailable", "credential_unavailable", "trusted_execution_failed", "trusted_response_invalid", "invalid_input", "unavailable"]);
const failureDetailKeys = new Set(["helper_status", "helper_error", "receipt_status", "exit_code", "stdout_truncated", "stderr_truncated", "cleanup_required", "error_class", "rpc_error", "rpc_phase", "provider_status", "helper_detail"]);
const forbiddenBodyFields = new Set(["actor", "creator_id", "creator_kind", "tenant_id", "repository_id"]);
const fileModes = new Set(["100644", "100755", "120000"]);

export async function handleForkRequest(request: Request, ports: ForkApiPorts): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = matchRoute(url.pathname);
  if (!route) return undefined;
  if (route instanceof Response) return route;
  if (request.method.toUpperCase() !== route.allowedMethod) return json({ error: "method_not_allowed" }, 405);
  if (hasDuplicateQuery(url.searchParams)) return json({ error: "duplicate_query_parameter" }, 400);
  const authenticated = await ports.authenticate(request, route.context, capabilityFor(route.action));
  if (authenticated instanceof Response) return authenticated;
  if (authenticated.tenant_id !== route.context.tenant_id) return json({ error: "tenant_mismatch" }, 403);
  const body = await readPayload(request, ports.maxBodyBytes ?? defaultMaxBodyBytes);
  if (body instanceof Response) return body;
  const operationId = request.headers.get("idempotency-key") ?? undefined;
  const normalized = normalizePayload(route, body, operationId, url.searchParams);
  if (normalized instanceof Response) return normalized;
  try {
    const result = await ports.invoke(route.context, route.action, normalized, authenticated);
    const status = isRecord(result) && result.status === "pending" ? 202 : 200;
    return json(result, status);
  } catch (error) {
    if (isRecord(error) && error.code === "stale_head") return json({ error: "gfy_stale_precondition", expected: error.expected, actual: error.actual }, 409);
    if (isRecord(error) && error.code === "not_found") return json({ error: "not_found" }, 404);
    if (isRecord(error) && error.code === "permission_denied") return json({ error: "permission_denied" }, 403);
    if (isRecord(error) && error.code === "idempotency_conflict") return json({ error: "idempotency_conflict" }, 409);
    const kind = errorKind(error);
    if (kind === "ForkForgeStaleHeadError") return json({ error: "gfy_stale_precondition" }, 409);
    if (kind === "ForgeVersionNotFoundError") return json({ error: "not_found" }, 404);
    if (kind === "ForgeVersionAuthenticationError") return json({ error: "permission_denied" }, 403);
    if (kind === "ForkForgeIdempotencyConflictError") return json({ error: "idempotency_conflict" }, 409);
    // The publication rules refused the evidence. These messages are GitFoundry's own and name what is missing.
    if (error instanceof Error && error.name === "PublicationEvidenceVerificationError" && isRecord(error) && typeof error.code === "string") return json({ error: "publication_refused", code: error.code, reason: error.message }, 409);
    const failure = describeForgeFailure(error);
    // A forge Git error's message is GitFoundry's own fixed text naming the failed step; other messages may carry provider data.
    const step = errorKind(error) === "CloudForgeGitError" && error instanceof Error ? { step: error.message } : {};
    console.error("gitfoundry.forge.backend_unavailable", { action: route.action, ...failure, ...step });
    return json({ error: "fork_backend_unavailable", code: failure.code }, 503);
  }
}

function matchRoute(pathname: string): ForkRoute | Response | undefined {
  const match = rootPattern.exec(pathname);
  if (!match) return undefined;
  const tenantId = decodeURIComponent(match[1] ?? "");
  const repositoryId = decodeURIComponent(match[2] ?? "");
  const tail = match[3] ?? "head";
  const context: ForkApiContext = { tenant_id: tenantId, repository_id: repositoryId };
  if (tail === "head") return { context, action: "head", allowedMethod: "GET" };
  if (tail === "forks") return { context, action: "list", allowedMethod: "GET" };
  if (tail.startsWith("versions/") && tail.split("/").length === 2) return { context: { ...context, version_commit: decodeURIComponent(tail.slice("versions/".length)) }, action: "view", allowedMethod: "GET" };
  if (tail === "files") return { context, action: "read", allowedMethod: "GET" };
  if (tail === "compare") return { context, action: "compare", allowedMethod: "GET" };
  if (tail === "initialize") return { context, action: "initialize", allowedMethod: "POST" };
  if (tail === "fork") return { context, action: "fork", allowedMethod: "POST" };
  if (tail === "commit") return { context, action: "commit", allowedMethod: "POST" };
  if (tail === "merge") return { context, action: "merge", allowedMethod: "POST" };
  if (tail === "publish") return { context, action: "publish", allowedMethod: "POST" };
  if (tail === "recover") return { context, action: "recover", allowedMethod: "POST" };
  return json({ error: "unknown_fork_action" }, 404);
}

async function readPayload(request: Request, maxBodyBytes: number): Promise<Record<string, unknown> | Response> {
  if (request.method.toUpperCase() === "GET") return {};
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        return json({ error: "body_too_large" }, 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return {};
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(parsed) ? parsed : json({ error: "body_invalid" }, 400);
  } catch {
    return json({ error: "body_invalid" }, 400);
  }
}

function normalizePayload(route: ForkRoute, body: Record<string, unknown>, headerOperationId: string | undefined, query: URLSearchParams): Record<string, unknown> | Response {
  if (route.allowedMethod === "POST") {
    for (const field of Object.keys(body)) if (forbiddenBodyFields.has(field)) return json({ error: "forged_identity_field" }, 400);
  }
  if (route.action === "head" || route.action === "list") return {};
  if (route.action === "view") {
    if (!isSha(route.context.version_commit)) return json({ error: "version_invalid" }, 400);
    return { version_commit: route.context.version_commit };
  }
  if (route.action === "read") {
    const version = query.get("version");
    const tree = query.get("tree");
    const path = query.get("path");
    const prefix = query.get("prefix");
    if (!isSha(version) || !isTree(tree)) return json({ error: "query_invalid" }, 400);
    if (path !== null && prefix !== null) return json({ error: "query_invalid" }, 400);
    if (path !== null && !isSafePath(path)) return json({ error: "query_invalid" }, 400);
    if (prefix !== null && !isSafePrefix(prefix)) return json({ error: "query_invalid" }, 400);
    return { version, tree, ...(path !== null ? { path } : {}), ...(prefix !== null ? { prefix } : {}) };
  }
  if (route.action === "compare") {
    const base_version = query.get("base_version");
    const head_version = query.get("head_version");
    if (!isSha(base_version) || !isSha(head_version)) return json({ error: "query_invalid" }, 400);
    return { base_version, head_version };
  }
  if (route.action === "recover" && !Object.prototype.hasOwnProperty.call(body, "operation_id") && !headerOperationId) {
    if (!stringField(body, "publication_operation_id")) return json({ error: "publication_operation_id_required" }, 400);
    return body;
  }
  const bodyOperationId = stringField(body, "operation_id");
  if (headerOperationId && bodyOperationId && headerOperationId !== bodyOperationId) return json({ error: "idempotency_conflict" }, 409);
  const operation_id = bodyOperationId ?? headerOperationId;
  if (!operation_id) return json({ error: "operation_id_required" }, 400);
  const payload: Record<string, unknown> = { ...body, operation_id };
  if (route.action === "initialize") {
    const hasCodeCommit = Object.prototype.hasOwnProperty.call(payload, "code_commit");
    const initialCode = initializeFileChangesField(payload, "initial_code", false);
    if (initialCode instanceof Response) return initialCode;
    const initialState = initializeFileChangesField(payload, "initial_state", true);
    if (initialState instanceof Response) return initialState;
    if (hasCodeCommit && !isSha(stringField(payload, "code_commit"))) return json({ error: "code_commit_invalid" }, 400);
    if (hasCodeCommit === Boolean(initialCode)) return json({ error: "initialize_source_invalid" }, 400);
  } else if (route.action === "fork") {
    if (!isSha(stringField(payload, "parent_version"))) return json({ error: "parent_version_invalid" }, 400);
  } else if (route.action === "commit") {
    if (!isSha(stringField(payload, "parent_version"))) return json({ error: "parent_version_invalid" }, 400);
    const changes = Array.isArray(payload.changes) ? payload.changes : undefined;
    if (!changes) return json({ error: "changes_invalid" }, 400);
    for (const change of changes) {
      if (!isRecord(change) || !isTree(stringField(change, "tree")) || !isSafePath(stringField(change, "path"))) return json({ error: "change_invalid" }, 400);
      const content = change.content_base64;
      const mode = change.mode;
      if (mode !== undefined && !isFileMode(mode)) return json({ error: "change_invalid" }, 400);
      if (content === null && mode !== undefined) return json({ error: "change_invalid" }, 400);
      if (content !== null && !isBase64(typeof content === "string" ? content : undefined)) return json({ error: "change_invalid" }, 400);
    }
  } else if (route.action === "merge") {
    if (!isSha(stringField(payload, "base_version")) || !isSha(stringField(payload, "left_version")) || !isSha(stringField(payload, "right_version"))) return json({ error: "merge_invalid" }, 400);
  } else if (route.action === "publish") {
    if (!isSha(stringField(payload, "expected_head")) || !isSha(stringField(payload, "new_version"))) return json({ error: "publication_invalid" }, 400);
  } else if (route.action === "recover") {
    if (!stringField(payload, "publication_operation_id")) return json({ error: "publication_operation_id_required" }, 400);
  }
  return payload;
}

function capabilityFor(action: ForkAction): string {
  switch (action) {
    case "head": case "list": case "view": case "read": return "forge.read";
    case "compare": return "forge.compare";
    case "initialize": return "forge.initialize";
    case "fork": return "forge.fork";
    case "commit": return "forge.commit";
    case "merge": return "forge.merge";
    case "publish": return "forge.publish";
    case "recover": return "forge.recover";
  }
}

function hasDuplicateQuery(params: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface ForgeFailureDescription {
  readonly code: string;
  readonly reason?: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

// Names a forge backend failure by fixed codes only, so it can be logged and reported without
// carrying provider messages or helper output.
export function describeForgeFailure(error: unknown): ForgeFailureDescription {
  const kind = errorKind(error);
  const code = isRecord(error) && typeof error.code === "string" && backendFailureCodes.has(error.code) ? error.code : kind && /^[A-Z][A-Za-z]{0,63}Error$/u.test(kind) && kind !== "Error" ? kind : "unknown";
  const reason = isRecord(error) && typeof error.reason === "string" && backendFailureReasons.has(error.reason) ? { reason: error.reason } : {};
  const detail = isRecord(error) && isRecord(error.detail) ? failureDetail(error.detail) : undefined;
  return { code, ...reason, ...(detail ? { detail } : {}) };
}

function failureDetail(value: Record<string, unknown>): Record<string, string | number | boolean | null> | undefined {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!failureDetailKeys.has(key)) continue;
    if (typeof field === "number" && Number.isInteger(field) || typeof field === "boolean" || field === null) out[key] = field;
    else if (typeof field === "string" && (key === "error_class" ? /^[A-Z][A-Za-z]{0,63}$/u : key === "rpc_phase" ? /^[A-Za-z][A-Za-z_]{0,63}$/u : key === "helper_detail" ? /^[A-Za-z][A-Za-z0-9 .,:/_-]{0,159}$/u : /^[a-z][a-z0-9_]{0,63}$/u).test(field)) out[key] = field;
  }
  return Object.keys(out).length ? out : undefined;
}

function errorKind(value: unknown): string {
  return value instanceof Error ? value.constructor.name : isRecord(value) && typeof value._tag === "string" ? value._tag : "";
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function isSha(value: string | undefined | null): value is string {
  return Boolean(value && shaPattern.test(value) && value !== "0".repeat(40));
}

function isTree(value: string | undefined | null): value is "code" | "state" {
  return value === "code" || value === "state";
}

function isSafePath(value: string | undefined | null): value is string {
  if (!value || value.includes("\u0000") || value.startsWith("/") || value.includes("//")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git");
}

function isSafePrefix(value: string | undefined | null): value is string {
  if (value === undefined || value === null || value.includes("\u0000") || value.startsWith("/") || value.includes("//")) return false;
  if (value.length === 0) return true;
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  return isSafePath(normalized);
}

function initializeFileChangesField(payload: Record<string, unknown>, key: "initial_code" | "initial_state", allowEmpty: boolean): readonly unknown[] | Response | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return json({ error: `${key}_invalid` }, 400);
  const seen = new Set<string>();
  for (const change of value) {
    if (!isRecord(change) || !isSafePath(stringField(change, "path"))) return json({ error: `${key}_invalid` }, 400);
    const path = stringField(change, "path") as string;
    if (seen.has(path)) return json({ error: `${key}_invalid` }, 400);
    if (key === "initial_state" && path === "README.md") return json({ error: "initial_state_invalid" }, 400);
    seen.add(path);
    const content = change.content_base64;
    const mode = change.mode;
    if (mode !== undefined && !isFileMode(mode)) return json({ error: `${key}_invalid` }, 400);
    if (content === null && mode !== undefined) return json({ error: `${key}_invalid` }, 400);
    if (content !== null && !isBase64(typeof content === "string" ? content : undefined)) return json({ error: `${key}_invalid` }, 400);
  }
  return value;
}

function isFileMode(value: unknown): value is "100644" | "100755" | "120000" {
  return typeof value === "string" && fileModes.has(value);
}

function isBase64(value: string | undefined): value is string {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
