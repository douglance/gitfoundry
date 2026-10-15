import type { D1DatabaseLike } from "../../../../packages/core/src/live/index.js";
import type { ArtifactsBinding, ArtifactsRepoHandle, WorkersArtifactsCreateTokenResult, WorkersArtifactsRepoInfo } from "../git-provider.js";

export interface GitTransportEnv {
  readonly GFY_DB?: D1DatabaseLike;
  readonly DB?: D1DatabaseLike;
  readonly GFY_GIT?: ArtifactsBinding;
  readonly GFY_GIT_NAMESPACE?: string;
  readonly GFY_GIT_MAX_REQUEST_BYTES?: string;
  readonly GFY_GIT_MAX_RESPONSE_BYTES?: string;
  readonly GFY_GIT_SESSION_TIMEOUT_MS?: string;
}

export interface GitTransportDeps {
  readonly authorize: (request: Request, tenantId: string, capability: "repository.read" | "repository.write") => Promise<Response | undefined>;
  readonly originFetch?: typeof fetch;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

interface RepositoryArtifactRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly artifacts_namespace: string | null;
  readonly artifacts_name: string | null;
}

interface GitRoute {
  readonly namespace: string;
  readonly name: string;
  readonly operation: "info_refs" | "upload_pack" | "receive_pack";
  readonly service: "git-upload-pack" | "git-receive-pack";
}

interface SelectedRepository {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly namespace: string;
  readonly name: string;
}

interface GitTransportBounds {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly sessionTimeoutMs: number;
}

interface ProviderSession {
  readonly signal: AbortSignal;
  abort: (reason: string) => void;
  close: () => void;
  errorMessage: () => string;
  run: <T>(start: () => Promise<T>, onLate?: (value: T) => Promise<void> | void, onPending?: (late: Promise<unknown>) => void) => Promise<T>;
}

type Token = WorkersArtifactsCreateTokenResult & { readonly plaintext: string; readonly id: string; readonly scope: "read" | "write"; readonly expiresAt: string };

interface RevocableTokenIdentifier {
  readonly id?: string;
  readonly plaintext?: string;
}

const namespacePattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const repositoryNamePattern = /^[A-Za-z0-9_.-]{1,255}$/;
const publicRequestHeaders = ["accept", "content-type", "git-protocol", "user-agent"];
const publicResponseHeaders = ["cache-control", "content-type", "expires", "pragma"];
const readTokenTtlSeconds = 60;
const maxReadTokenTtlMs = 90_000;
const maxSessionTimeoutMs = 55_000;
const cleanupOperationTimeoutMs = 1_000;
const defaultGitTransportBounds: GitTransportBounds = {
  maxRequestBytes: 8 * 1024 * 1024,
  maxResponseBytes: 1024 * 1024 * 1024,
  sessionTimeoutMs: maxSessionTimeoutMs
};

export async function handleGitTransportRequest(request: Request, env: GitTransportEnv, deps: GitTransportDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const route = parseRoute(request.method, url);
  if (route === undefined) return undefined;
  if (route instanceof Response) return route;

  const bounds = gitTransportBounds(env);
  if (bounds instanceof Response) return bounds;
  const declaredLength = validateDeclaredUploadPackLength(request, route, bounds.maxRequestBytes);
  if (declaredLength instanceof Response) return declaredLength;

  if (route.service === "git-receive-pack" || route.operation === "receive_pack") return textResponse("git receive-pack is not implemented", 501);
  if (route.namespace !== env.GFY_GIT_NAMESPACE) return textResponse("repository unavailable", 404);

  const db = env.GFY_DB ?? env.DB;
  if (!db || !env.GFY_GIT || !env.GFY_GIT_NAMESPACE) return textResponse("git transport unavailable", 503);

  let selected: SelectedRepository | Response;
  try {
    selected = await selectRepository(db, route.namespace, route.name);
  } catch {
    return textResponse("git transport unavailable", 503);
  }
  if (selected instanceof Response) return selected;

  let authorization: Response | undefined;
  try {
    authorization = await deps.authorize(request, selected.tenantId, "repository.read");
  } catch {
    return textResponse("git transport unavailable", 503);
  }
  if (authorization) return authorization;

  return await proxyUploadPack(request, route, selected, env.GFY_GIT, deps, bounds);
}

function parseRoute(method: string, url: URL): GitRoute | Response | undefined {
  const pathname = url.pathname;
  if (!pathname.startsWith("/git/")) return undefined;
  if (pathname.includes("%") || /%2f|%5c/i.test(pathname) || pathname.includes("\\") || pathname.includes("//")) return textResponse("invalid git route", 400);
  const match = /^\/git\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!match) return textResponse("invalid git route", 400);
  const [, namespace, name, suffix] = match as unknown as [string, string, string, string];
  if (!validNamespace(namespace) || !validRepositoryName(name)) return textResponse("invalid git route", 400);

  if (suffix === "info/refs") {
    if (method !== "GET") return textResponse("invalid git method", 405);
    const services = url.searchParams.getAll("service");
    if (services.length !== 1 || Array.from(url.searchParams.keys()).some((key) => key !== "service")) return textResponse("invalid git service", 400);
    const service = services[0];
    if (service === "git-upload-pack" || service === "git-receive-pack") return { namespace, name, operation: "info_refs", service };
    return textResponse("invalid git service", 400);
  }

  if (url.search.length > 0) return textResponse("invalid git query", 400);
  if (suffix === "git-upload-pack") {
    if (method !== "POST") return textResponse("invalid git method", 405);
    return { namespace, name, operation: "upload_pack", service: "git-upload-pack" };
  }
  if (method !== "POST") return textResponse("invalid git method", 405);
  return { namespace, name, operation: "receive_pack", service: "git-receive-pack" };
}

async function selectRepository(db: D1DatabaseLike, namespace: string, name: string): Promise<SelectedRepository | Response> {
  const result = await db.prepare("SELECT tenant_id,id,artifacts_namespace,artifacts_name FROM repositories WHERE artifacts_namespace = ? AND artifacts_name = ? LIMIT 2").bind(namespace, name).all<RepositoryArtifactRow>();
  const rows = result.results ?? [];
  if (rows.length !== 1) return textResponse(rows.length > 1 ? "repository identity ambiguous" : "repository unavailable", rows.length > 1 ? 409 : 404);
  const row = rows[0];
  if (!row || row.artifacts_namespace !== namespace || row.artifacts_name !== name || typeof row.tenant_id !== "string" || row.tenant_id.length < 1 || typeof row.id !== "string" || row.id.length < 1) return textResponse("repository unavailable", 404);
  return { tenantId: row.tenant_id, repositoryId: row.id, namespace, name };
}

async function proxyUploadPack(request: Request, route: GitRoute, selected: SelectedRepository, artifacts: ArtifactsBinding, deps: GitTransportDeps, bounds: GitTransportBounds): Promise<Response> {
  const session = createProviderSession(bounds.sessionTimeoutMs, request.signal);
  if (session.signal.aborted) {
    session.close();
    return textResponse("git upstream unavailable", 502);
  }

  let repo: ArtifactsRepoHandle | undefined;
  let token: Token | undefined;
  let tokenForCleanup: RevocableTokenIdentifier | undefined;
  let cleanupStarted = false;
  let cleanupChain: Promise<void> = Promise.resolve();
  let disposed = false;
  let pendingTokenSettled = true;
  let pendingTokenPromise: Promise<WorkersArtifactsCreateTokenResult> | undefined;
  const cleanupWaitMs = Math.max(1, Math.min(bounds.sessionTimeoutMs, cleanupOperationTimeoutMs));
  const revokedTokens = new Set<string>();
  const revokeAttempts = new Map<string, Promise<void>>();

  const trackLateCleanup = (promise: Promise<unknown>) => {
    const bounded = promise.catch(() => undefined);
    if (deps.waitUntil) deps.waitUntil(bounded);
    else void bounded;
  };
  const disposeCurrent = () => {
    if (!repo || disposed) return;
    disposed = true;
    disposeRepo(repo);
  };
  const scheduleDisposeAfterRevoke = (revokePromise: Promise<void>) => {
    trackLateCleanup(revokePromise.then(() => undefined, () => undefined).then(() => { disposeCurrent(); }));
  };
  const revokeTokenOnce = (tokenOrId: string): Promise<void> => {
    const existing = revokeAttempts.get(tokenOrId);
    if (existing) return existing;
    const attempt = repo!.revokeToken(tokenOrId).then((revoked) => {
      if (revoked === false) throw new Error("git token cleanup failed");
      revokedTokens.add(tokenOrId);
    });
    revokeAttempts.set(tokenOrId, attempt);
    return attempt;
  };
  const cleanupCurrent = async (): Promise<void> => {
    cleanupStarted = true;
    cleanupChain = cleanupChain.catch(() => undefined).then(async () => {
      let cleanupFailed = false;
      if (pendingTokenPromise && !pendingTokenSettled && !tokenForCleanup) {
        const tokenResult = await settleWithin(pendingTokenPromise, cleanupWaitMs);
        if (tokenResult.status === "resolved") tokenForCleanup = tokenResult.value;
        else if (tokenResult.status === "timed_out") {
          throw new Error("git transport cleanup failed");
        } else {
          cleanupFailed = true;
        }
      }
      if (repo && tokenForCleanup) {
        const tokenOrId = revocableTokenValue(tokenForCleanup);
        if (!tokenOrId) {
          cleanupFailed = true;
        } else if (!revokedTokens.has(tokenOrId)) {
          const revokePromise = revokeTokenOnce(tokenOrId);
          const revokeResult = await settleWithin(revokePromise, cleanupWaitMs);
          if (revokeResult.status === "timed_out") {
            scheduleDisposeAfterRevoke(revokePromise);
            throw new Error("git transport cleanup failed");
          }
          if (revokeResult.status === "rejected") cleanupFailed = true;
        }
      }
      if (repo && !disposed) {
        try { disposeCurrent(); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw new Error("git transport cleanup failed");
    });
    return cleanupChain;
  };

  try {
    repo = await session.run(
      () => artifacts.get(selected.name),
      async (lateRepo) => {
        repo = lateRepo;
        await cleanupCurrent();
      },
      trackLateCleanup
    );
    const info = await session.run(
      () => repo!.info(),
      async () => { await cleanupCurrent(); },
      trackLateCleanup
    );
    const upstreamBase = providerRemote(info, selected);
    const createdToken = await session.run(
      () => {
        pendingTokenSettled = false;
        pendingTokenPromise = repo!.createToken("read", readTokenTtlSeconds);
        void pendingTokenPromise.then((lateToken) => {
          pendingTokenSettled = true;
          tokenForCleanup ??= lateToken;
        }, () => { pendingTokenSettled = true; });
        return pendingTokenPromise;
      },
      async (lateToken) => {
        pendingTokenSettled = true;
        tokenForCleanup = lateToken;
        await cleanupCurrent();
      },
      trackLateCleanup
    );
    pendingTokenSettled = true;
    tokenForCleanup = createdToken;
    token = validateReadToken(createdToken);
    const upstream = upstreamUrl(upstreamBase, route);
    const init = upstreamRequestInit(request, token.plaintext, bounds, session);
    const upstreamResponse = await session.run(
      () => (deps.originFetch ?? fetch)(upstream, init),
      async (lateResponse) => { await cancelBody(lateResponse.body); },
      trackLateCleanup
    );
    if (session.signal.aborted || isRedirect(upstreamResponse.status) || !upstreamResponse.ok || !upstreamResponse.body) {
      await cancelBody(upstreamResponse.body);
      await cleanupCurrent();
      session.close();
      return textResponse("git upstream unavailable", 502);
    }
    const body = streamWithCleanup(upstreamResponse.body, {
      maxBytes: bounds.maxResponseBytes,
      cleanup: async () => { try { await cleanupCurrent(); } finally { session.close(); } },
      signal: session.signal,
      errorMessage: () => session.errorMessage(),
      waitUntil: deps.waitUntil
    });
    return new Response(body, { status: upstreamResponse.status, headers: responseHeaders(upstreamResponse.headers) });
  } catch {
    try { await cleanupCurrent(); } catch { /* the returned response is already a bounded failure */ }
    session.close();
    return textResponse("git upstream unavailable", 502);
  }
}

function upstreamRequestInit(request: Request, plaintext: string, bounds: GitTransportBounds, session: ProviderSession): RequestInit & { duplex?: "half" } {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${plaintext}`);
  for (const name of publicRequestHeaders) copyPublicHeader(request.headers, headers, name);
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, redirect: "manual", signal: session.signal };
  if (request.method === "POST") {
    init.body = limitedRequestBody(request.body, bounds.maxRequestBytes, session);
    init.duplex = "half";
  }
  return init;
}

function upstreamUrl(base: URL, route: GitRoute): string {
  const url = new URL(base.toString());
  url.pathname = `${base.pathname.replace(/\/+$/u, "")}/${route.operation === "info_refs" ? "info/refs" : "git-upload-pack"}`;
  if (route.operation === "info_refs") url.searchParams.set("service", "git-upload-pack");
  return url.toString();
}

function providerRemote(info: WorkersArtifactsRepoInfo, selected: SelectedRepository): URL {
  if (info.name !== selected.name || !validRepositoryName(info.name)) throw new Error("provider identity mismatch");
  const remote = new URL(info.remote);
  if (remote.protocol !== "https:" || remote.hostname.length < 1) throw new Error("invalid remote");
  remote.username = "";
  remote.password = "";
  remote.search = "";
  remote.hash = "";
  const segments = remote.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "git" || segments[1] !== selected.namespace || segments[2] !== `${selected.name}.git`) throw new Error("provider remote identity mismatch");
  return remote;
}

function validateReadToken(value: WorkersArtifactsCreateTokenResult): Token {
  if (typeof value !== "object" || value === null) throw new Error("invalid token");
  const token = value as Partial<Token>;
  if (typeof token.id !== "string" || token.id.length < 1 || typeof token.plaintext !== "string" || token.plaintext.length < 1) throw new Error("invalid token");
  if (token.scope !== "read") throw new Error("invalid token scope");
  const expiresAt = typeof token.expiresAt === "string" ? Date.parse(token.expiresAt) : NaN;
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > maxReadTokenTtlMs) throw new Error("invalid token ttl");
  return token as Token;
}

function gitTransportBounds(env: GitTransportEnv): GitTransportBounds | Response {
  const maxRequestBytes = parseOptionalPositiveSafeInteger(env.GFY_GIT_MAX_REQUEST_BYTES, defaultGitTransportBounds.maxRequestBytes);
  const maxResponseBytes = parseOptionalPositiveSafeInteger(env.GFY_GIT_MAX_RESPONSE_BYTES, defaultGitTransportBounds.maxResponseBytes);
  const sessionTimeoutMs = parseOptionalPositiveSafeInteger(env.GFY_GIT_SESSION_TIMEOUT_MS, defaultGitTransportBounds.sessionTimeoutMs, maxSessionTimeoutMs);
  if (maxRequestBytes === undefined || maxResponseBytes === undefined || sessionTimeoutMs === undefined) return textResponse("git transport unavailable", 503);
  return { maxRequestBytes, maxResponseBytes, sessionTimeoutMs };
}

function parseOptionalPositiveSafeInteger(value: unknown, fallback: number, max?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  if (max !== undefined && parsed > max) return undefined;
  return parsed;
}

function validateDeclaredUploadPackLength(request: Request, route: GitRoute, maxRequestBytes: number): Response | undefined {
  if (route.operation !== "upload_pack") return undefined;
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(header)) return textResponse("invalid git request size", 400);
  const declared = Number(header);
  if (!Number.isSafeInteger(declared)) return textResponse("invalid git request size", 400);
  if (declared > maxRequestBytes) return textResponse("git request too large", 413);
  return undefined;
}

function createProviderSession(timeoutMs: number, callerSignal: AbortSignal): ProviderSession {
  const controller = new AbortController();
  let closed = false;
  let abortMessage = "git session deadline";
  const abort = (reason: string) => {
    if (controller.signal.aborted) return;
    abortMessage = reason;
    controller.abort(reason);
  };
  const abortPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error(abortMessage)), { once: true });
  });
  void abortPromise.catch(() => undefined);
  const timer = setTimeout(() => abort("git session deadline"), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  const callerAbort = () => abort("git request aborted");
  if (callerSignal.aborted) callerAbort();
  else callerSignal.addEventListener("abort", callerAbort, { once: true });
  return {
    signal: controller.signal,
    abort,
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", callerAbort);
    },
    errorMessage: () => abortMessage,
    run: async <T>(start: () => Promise<T>, onLate?: (value: T) => Promise<void> | void, onPending?: (late: Promise<unknown>) => void): Promise<T> => {
      if (controller.signal.aborted) throw new Error(abortMessage);
      let settled = false;
      const tracked = start().then((value) => {
        settled = true;
        return value;
      }, (error) => {
        settled = true;
        throw error;
      });
      try {
        return await Promise.race([tracked, abortPromise]);
      } catch (error) {
        if (controller.signal.aborted && !settled) {
          const late = onLate ? tracked.then(onLate) : tracked.then(() => undefined);
          if (onPending) onPending(late);
          else void late.catch(() => undefined);
        }
        throw error;
      }
    }
  };
}

function limitedRequestBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, session: ProviderSession): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let total = 0;
  let abortHandler: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abortHandler = () => {
        removeAbortListener(session.signal, abortHandler);
        void reader.cancel(session.errorMessage()).catch(() => undefined).finally(() => releaseReader(reader));
        controller.error(new Error(session.errorMessage()));
      };
      if (session.signal.aborted) abortHandler();
      else session.signal.addEventListener("abort", abortHandler, { once: true });
    },
    async pull(controller) {
      if (session.signal.aborted) throw new Error(session.errorMessage());
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        removeAbortListener(session.signal, abortHandler);
        releaseReader(reader);
        throw new Error("git request stream failed");
      }
      if (session.signal.aborted) {
        releaseReader(reader);
        throw new Error(session.errorMessage());
      }
      if (chunk.done) {
        removeAbortListener(session.signal, abortHandler);
        releaseReader(reader);
        controller.close();
        return;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        removeAbortListener(session.signal, abortHandler);
        session.abort("git request too large");
        try { await reader.cancel("git request too large"); } catch { /* bounded by stream error below */ }
        releaseReader(reader);
        throw new Error("git request too large");
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      removeAbortListener(session.signal, abortHandler);
      try { await reader.cancel(reason); } finally { releaseReader(reader); }
    }
  });
}

function streamWithCleanup(body: ReadableStream<Uint8Array>, options: { readonly maxBytes: number; readonly cleanup: () => Promise<void>; readonly signal: AbortSignal; readonly errorMessage: () => string; readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined }): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  let cleaned = false;
  let abortHandler: (() => void) | undefined;
  const cleanupOnce = async () => {
    if (cleaned) return;
    cleaned = true;
    removeAbortListener(options.signal, abortHandler);
    await options.cleanup();
  };
  const scheduleCleanup = () => {
    const promise = cleanupOnce().catch(() => { throw new Error("git transport cleanup failed"); });
    if (options.waitUntil) options.waitUntil(promise.catch(() => undefined));
    return promise;
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abortHandler = () => {
        void reader.cancel(options.errorMessage()).catch(() => undefined).finally(() => releaseReader(reader));
        const cleanup = scheduleCleanup();
        if (options.waitUntil) options.waitUntil(cleanup.catch(() => undefined));
        else void cleanup.catch(() => undefined);
        controller.error(new Error(options.errorMessage()));
      };
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener("abort", abortHandler, { once: true });
    },
    async pull(controller) {
      if (options.signal.aborted) {
        releaseReader(reader);
        try { await scheduleCleanup(); } catch { /* stream error stays bounded below */ }
        throw new Error(options.errorMessage());
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        releaseReader(reader);
        try { await scheduleCleanup(); } catch { /* stream errors must stay bounded below */ }
        throw new Error("git upstream stream failed");
      }
      if (options.signal.aborted) {
        releaseReader(reader);
        try { await scheduleCleanup(); } catch { /* stream error stays bounded below */ }
        throw new Error(options.errorMessage());
      }
      if (chunk.done) {
        releaseReader(reader);
        await scheduleCleanup();
        controller.close();
        return;
      }
      total += chunk.value.byteLength;
      if (total > options.maxBytes) {
        try { await reader.cancel("git response too large"); } catch { /* bounded by stream error below */ }
        releaseReader(reader);
        try { await scheduleCleanup(); } catch { /* size errors take precedence over cleanup details */ }
        throw new Error("git response too large");
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader(reader);
        await scheduleCleanup();
      }
    }
  });
}

function removeAbortListener(signal: AbortSignal, listener: (() => void) | undefined): void {
  if (listener) signal.removeEventListener("abort", listener);
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { reader.releaseLock(); } catch { /* a pending read still owns the lock */ }
}

function responseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of publicResponseHeaders) {
    if (name !== "cache-control") copyPublicHeader(source, headers, name);
  }
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function copyPublicHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);
  if (!value || /[\r\n]/.test(value) || value.length > 1024) return;
  target.set(name, value);
}

type SettledWithin<T> = { readonly status: "resolved"; readonly value: T } | { readonly status: "rejected" } | { readonly status: "timed_out" };

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<SettledWithin<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: "timed_out" });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: "resolved", value });
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: "rejected" });
    });
  });
}

function disposeRepo(repo: ArtifactsRepoHandle): void {
  const disposable = repo as Partial<Record<typeof Symbol.dispose, () => void>>;
  try { disposable[Symbol.dispose]?.(); } catch { throw new Error("git repo cleanup failed"); }
}

function revocableTokenValue(token: RevocableTokenIdentifier): string | undefined {
  if (typeof token.id === "string" && token.id.length > 0) return token.id;
  if (typeof token.plaintext === "string" && token.plaintext.length > 0) return token.plaintext;
  return undefined;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try { await body.cancel("git upstream response rejected"); } catch { /* rejection body cleanup is best effort before bounded failure */ }
}

function validNamespace(value: string): boolean {
  return namespacePattern.test(value) && value !== "." && value !== "..";
}

function validRepositoryName(value: string): boolean {
  return repositoryNamePattern.test(value) && value !== "." && value !== "..";
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
