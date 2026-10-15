import { WorkerEntrypoint } from "cloudflare:workers";

export interface GitArtifactsEgressCapability {
  readonly allowedProviderHostname: string;
  readonly namespace: string;
  readonly repository: string;
  readonly artifactsRemoteUrl: string;
  readonly opaqueProof: string;
  readonly allowWrite: boolean;
}

interface ValidCapability {
  readonly allowedProviderHostname: string;
  readonly namespace: string;
  readonly repository: string;
  readonly remote: URL;
  readonly remoteRepositoryPath: string;
  readonly opaqueProof: string;
  readonly allowWrite: boolean;
}

type RuntimeFetch = (input: Request | string, init?: RequestInit) => Promise<Response>;

const namespacePattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,255}$/;
const proofPattern = /^[A-Za-z0-9._~:-]{16,512}$/;
const proofHeader = "x-gitfoundry-egress-proof";
const hopByHopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
// Git gzips large fetch negotiations, so the body is unreadable upstream without its content encoding.
const forwardedRequestHeaders = ["authorization", "accept", "content-type", "content-encoding", "git-protocol", "user-agent"];
const forwardedResponseHeaders = ["content-type", "cache-control", "expires", "pragma"];

export class GitFoundryArtifactsEgress extends WorkerEntrypoint<Record<string, never>, GitArtifactsEgressCapability> {
  async fetch(request: Request): Promise<Response> {
    return handleGitArtifactsEgressRequest(request, this.ctx.props, fetch);
  }
}

export async function handleGitArtifactsEgressRequest(request: Request, rawCapability: unknown, originFetch: RuntimeFetch = fetch): Promise<Response> {
  const capability = validateCapability(rawCapability);
  if (!capability.ok) return deny(503, "egress capability invalid");

  const incoming = new URL(request.url);
  if (incoming.hostname !== capability.value.allowedProviderHostname) return deny(403, "egress host denied");
  if (request.headers.get(proofHeader) !== capability.value.opaqueProof) return deny(403, "egress proof denied");
  const authorization = request.headers.get("authorization");
  if (!authorization) return deny(401, "helper token missing");

  const route = gitSmartHttpRoute(request.method, incoming, capability.value);
  if (!route.ok) return deny(route.status, route.reason);

  const upstreamUrl = new URL(capability.value.remote.href);
  upstreamUrl.pathname = `${capability.value.remoteRepositoryPath}${route.suffix}`;
  upstreamUrl.search = route.search;
  upstreamUrl.hash = "";
  upstreamUrl.username = "";
  upstreamUrl.password = "";

  const headers = new Headers();
  for (const name of forwardedRequestHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("authorization", authorization);

  const upstreamInit: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (request.method === "POST") Object.assign(upstreamInit, { body: request.body ?? null, duplex: "half" });
  const upstreamResponse = await originFetch(new Request(upstreamUrl, upstreamInit));

  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) return deny(502, "artifacts redirect denied");

  const responseHeaders = new Headers();
  for (const [name, value] of upstreamResponse.headers) {
    const lower = name.toLowerCase();
    if (forwardedResponseHeaders.includes(lower) && !hopByHopHeaders.has(lower)) responseHeaders.set(name, value);
  }
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers: responseHeaders });
}

function validateCapability(rawCapability: unknown): { readonly ok: true; readonly value: ValidCapability } | { readonly ok: false } {
  if (!isRecord(rawCapability)) return { ok: false };
  const allowedProviderHostname = stringField(rawCapability.allowedProviderHostname);
  const namespace = stringField(rawCapability.namespace);
  const repository = stringField(rawCapability.repository);
  const artifactsRemoteUrl = stringField(rawCapability.artifactsRemoteUrl);
  const opaqueProof = stringField(rawCapability.opaqueProof);
  if (!allowedProviderHostname || !namespace || !repository || !artifactsRemoteUrl || !opaqueProof) return { ok: false };
  if (!namespacePattern.test(namespace) || !repositoryPattern.test(repository) || !proofPattern.test(opaqueProof)) return { ok: false };

  let remote: URL;
  try {
    remote = new URL(artifactsRemoteUrl);
  } catch {
    return { ok: false };
  }
  if (remote.protocol !== "https:" || remote.hostname !== allowedProviderHostname || remote.username || remote.password || remote.search || remote.hash) return { ok: false };
  const remoteRepositoryPath = remote.pathname.replace(/\/+$/u, "");
  if (!remoteRepositoryPath.endsWith(`/${encodeURIComponent(repository)}.git`) && !remoteRepositoryPath.endsWith(`/${repository}.git`)) return { ok: false };
  return { ok: true, value: { allowedProviderHostname, namespace, repository, remote, remoteRepositoryPath, opaqueProof, allowWrite: rawCapability.allowWrite === true } };
}

function gitSmartHttpRoute(method: string, incoming: URL, capability: ValidCapability): { readonly ok: true; readonly suffix: string; readonly search: string } | { readonly ok: false; readonly status: number; readonly reason: string } {
  const gatewayRepositoryPath = `/git/${encodeURIComponent(capability.namespace)}/${encodeURIComponent(capability.repository)}.git`;
  if (method === "GET" && incoming.pathname === `${gatewayRepositoryPath}/info/refs`) {
    const service = singleSearchParam(incoming, "service");
    if (service === "git-upload-pack") return { ok: true, suffix: "/info/refs", search: "?service=git-upload-pack" };
    if (service === "git-receive-pack") return capability.allowWrite ? { ok: true, suffix: "/info/refs", search: "?service=git-receive-pack" } : { ok: false, status: 403, reason: "git receive-pack denied" };
    return { ok: false, status: 404, reason: "git service denied" };
  }
  if (method === "POST" && incoming.search === "" && incoming.pathname === `${gatewayRepositoryPath}/git-upload-pack`) return { ok: true, suffix: "/git-upload-pack", search: "" };
  if (method === "POST" && incoming.search === "" && incoming.pathname === `${gatewayRepositoryPath}/git-receive-pack`) {
    return capability.allowWrite ? { ok: true, suffix: "/git-receive-pack", search: "" } : { ok: false, status: 403, reason: "git receive-pack denied" };
  }
  return { ok: false, status: 404, reason: "git path denied" };
}

function singleSearchParam(url: URL, key: string): string | null {
  const entries = Array.from(url.searchParams.entries());
  return entries.length === 1 && entries[0]?.[0] === key ? entries[0][1] : null;
}

function deny(status: number, code: string): Response {
  return Response.json({ ok: false, code }, { status, headers: { "cache-control": "no-store" } });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
