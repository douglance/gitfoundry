import { Effect } from "effect";

import { ArtifactsGitProviderError, artifactsRepositoryIdentity, makeArtifactsGitProvider, type ArtifactsBinding, type ArtifactsRepositoryInput, type ArtifactsRepositoryReadback } from "../git-provider.js";
import { GitProvisionerUnavailableError } from "../../../../packages/core/src/live/index.js";
import { verifyOperatorServiceRequest, type OperatorServiceAuthEnv } from "./operator-service.js";

export interface ProviderQualificationEnv extends OperatorServiceAuthEnv {
  readonly GFY_SOURCE_REVISION?: string;
  readonly GFY_GIT?: unknown;
  readonly GFY_GIT_NAMESPACE?: string;
  readonly GFY_PUBLIC_GIT_URL_BASE?: string;
  readonly TRUSTED_GIT_HELPER?: DurableObjectNamespace;
  readonly UNTRUSTED_CI_JOB?: DurableObjectNamespace;
  readonly TRUSTED_GIT_HELPER_CANARY?: DurableObjectNamespace;
  readonly UNTRUSTED_CI_JOB_CANARY?: DurableObjectNamespace;
  readonly GFY_TRUSTED_GIT_HELPER_IMAGE?: string;
  readonly GFY_UNTRUSTED_CI_IMAGE?: string;
}

export const providerContentQualificationRepositoryInput: ArtifactsRepositoryInput = {
  tenantId: "gitfoundry-platform",
  namespaceId: "operator-qualification",
  name: "content-qualification-7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"
};

export const providerQualificationRepositoryInput: ArtifactsRepositoryInput = {
  tenantId: "gitfoundry-platform",
  namespaceId: "operator-qualification",
  name: "artifacts-qualification"
};

const artifactsRoutePath = "/_operator/qualify/artifacts";
const linuxRoutePath = "/_operator/qualify/linux";
const contentRoutePath = "/_operator/qualify/artifacts-content";
const maxQualificationBodyBytes = 1024;
const trustedLinuxProfile = "trusted_git_helper";
const untrustedCiProfile = "untrusted_ci_job";
const linuxQualificationTenantId = "gitfoundry-platform";
const linuxQualificationRepositoryId = "operator-linux-qualification";
const linuxQualificationDeadlineMs = 30_000;
const ciQualificationScript = [
  "set -eu",
  "architecture=$(/usr/bin/uname -m)",
  "test \"$architecture\" = x86_64",
  "version=$(/usr/bin/git --version)",
  "supervisor_version=$(/usr/local/bin/gitfoundry-supervise --version)",
  "if /usr/bin/env | /usr/bin/grep -Eqi '^[^=]*(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)[^=]*='; then exit 70; fi",
  "if /usr/bin/curl --connect-timeout 2 --max-time 3 --silent --output /dev/null https://example.com; then exit 71; fi",
  "/usr/bin/printf \"%s\\n\" \"$architecture\" \"$version\" \"$supervisor_version\" credentials_absent public_egress_denied"
].join("\n");
const imageDigestPattern = /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;

interface QualificationRequestBody {
  readonly create: boolean;
}

interface ProviderQualificationConfig {
  readonly artifacts: ArtifactsBinding;
  readonly namespace: string;
  readonly publicGitUrlBase?: string;
}

type LinuxQualificationProfile = typeof trustedLinuxProfile | typeof untrustedCiProfile;

interface LinuxQualificationRequestBody {
  readonly profile: LinuxQualificationProfile;
  readonly target?: "active" | "canary";
}

interface LinuxQualificationConfig {
  readonly namespace: DurableObjectNamespace;
  readonly image: string;
}

interface LinuxExecQualificationRequest extends Record<string, unknown> {
  readonly commandId: string;
}

export async function handleProviderQualification(request: Request, env: ProviderQualificationEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== artifactsRoutePath && url.pathname !== linuxRoutePath && url.pathname !== contentRoutePath) return undefined;
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });

  const auth = await verifyOperatorServiceRequest(request, env);
  if (!auth.ok) return json({ error: auth.status === 503 ? "operator auth unconfigured" : "operator unauthorized" }, auth.status);

  const sourceRevision = env.GFY_SOURCE_REVISION;
  if (typeof sourceRevision !== "string" || !/^[0-9a-f]{40}$/u.test(sourceRevision)) return json({ error: "qualification source revision unconfigured" }, 503);
  if (request.headers.get("X-GitFoundry-Expected-Revision") !== sourceRevision) return json({ error: "qualification source revision mismatch" }, 409);

  if (url.pathname === linuxRoutePath) {
    const response = await handleLinuxQualification(request, env);
    if (response.status === 200) response.headers.set("X-GitFoundry-Source-Revision", sourceRevision);
    return response;
  }

  if (url.pathname === contentRoutePath) {
    const response = await handleContentQualification(request, env);
    if (response.status === 200) response.headers.set("X-GitFoundry-Source-Revision", sourceRevision);
    return response;
  }

  const parsedBody = await readQualificationBody(request);
  if (!parsedBody.ok) return json({ error: parsedBody.error }, parsedBody.status);

  const config = providerQualificationConfig(env);
  if (!config) return json({ error: "provider qualification unconfigured" }, 503);

  const provider = makeArtifactsGitProvider(config.artifacts, {
    namespace: config.namespace,
    ...(config.publicGitUrlBase ? { publicGitUrlBase: config.publicGitUrlBase } : {})
  });

  try {
    let readback = await runProviderRead(provider.readRepository(providerQualificationRepositoryInput));
    if (!readback && parsedBody.body.create) {
      await runProviderWrite(provider.provisionRepository({ ...providerQualificationRepositoryInput, defaultBranch: "main", visibility: "private" }));
      readback = await runProviderRead(provider.readRepository(providerQualificationRepositoryInput));
    }
    if (!readback) return json({ error: "qualification repository not found" }, 404);
    return json(redactedReadback(readback), 200, { "X-GitFoundry-Source-Revision": sourceRevision });
  } catch (error) {
    return qualificationFailureResponse(error);
  }
}


async function handleContentQualification(request: Request, env: ProviderQualificationEnv): Promise<Response> {
  const bytes = await readBoundedBody(request, maxQualificationBodyBytes);
  if (!bytes.ok) return json({ error: bytes.error }, bytes.status);
  if (bytes.bytes.byteLength > 0) {
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes.bytes)) } catch { return json({ error: "invalid qualification request" }, 400) }
    if (!isRecord(body) || Object.keys(body).length !== 0) return json({ error: "invalid qualification request" }, 400);
  }
  const config = providerQualificationConfig(env);
  if (!config) return json({ error: "provider qualification unconfigured" }, 503);
  const identity = artifactsRepositoryIdentity(providerContentQualificationRepositoryInput, config.namespace);
  const provider = makeArtifactsGitProvider(config.artifacts, { namespace: config.namespace });
  let stage: "readback" | "import" | "capability" | "bootstrap" | "identity" | "log" | "file" | "digest" = "readback";
  try {
    const readback = await runProviderRead(provider.readRepository(providerContentQualificationRepositoryInput));
    let bootstrapToken: string | undefined;
    if (!readback) {
      const importer = config.artifacts as ArtifactsBinding & Partial<Pick<Artifacts, "import">>;
      if (typeof importer.import !== "function") return json({ error: "content qualification unconfigured" }, 503);
      stage = "import";
      const imported = await importer.import({
        source: { url: "https://github.com/octocat/Hello-World.git", branch: "master", depth: 1 },
        target: { name: identity.name, opts: { readOnly: true } }
      });
      if (imported.name !== identity.name || typeof imported.token !== "string" || imported.token.length === 0) throw new Error("content import invalid");
      bootstrapToken = imported.token;
    }
    stage = "capability";
    const repo = await config.artifacts.get(identity.name) as Awaited<ReturnType<ArtifactsBinding["get"]>> & Partial<Pick<ArtifactsRepo, "readFile">>;
    try {
      stage = "bootstrap";
      if (bootstrapToken !== undefined && await repo.revokeToken(bootstrapToken) !== true) throw new Error("bootstrap revocation failed");
      stage = "identity";
      const info = await repo.info();
      if (info.name !== identity.name || info.readOnly !== true || info.defaultBranch !== "main" || typeof info.id !== "string" || info.id.length === 0) throw new Error("content repository identity invalid");
      if (typeof repo.log !== "function" || typeof repo.readFile !== "function") return json({ error: "content qualification unconfigured" }, 503);
      stage = "log";
      const history = await repo.log({ ref: "master", limit: 1 });
      const commitSha = history[0]?.hash;
      if (typeof commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("content commit invalid");
      stage = "file";
      const blob = await repo.readFile({ ref: commitSha, path: "README" });
      if (blob === null || blob.size > 65536) throw new Error("content file unavailable");
      stage = "digest";
      const content = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", content);
      return json({ provider_id: info.id, name: info.name, defaultBranch: info.defaultBranch, readOnly: info.readOnly, commit_sha: commitSha, path: "README", byte_length: content.byteLength, content_sha256: hex(new Uint8Array(digest)) }, 200);
    } finally {
      repo[Symbol.dispose]?.();
    }
  } catch {
    return json({ error: "content qualification failed", stage }, 502);
  }
}

async function handleLinuxQualification(request: Request, env: ProviderQualificationEnv): Promise<Response> {
  const parsedBody = await readLinuxQualificationBody(request);
  if (!parsedBody.ok) return json({ error: parsedBody.error }, parsedBody.status);
  const profile = parsedBody.body.profile;
  const config = linuxQualificationConfig(env, profile, parsedBody.body.target);
  if (!config) return json({ error: "linux qualification unconfigured" }, 503);

  try {
    const executionRequest = await linuxQualificationRequest(profile, config.image);
    const id = config.namespace.idFromName(profile === trustedLinuxProfile ? "gitfoundry-operator-linux-qualification" : "gitfoundry-operator-ci-qualification");
    const stub = config.namespace.get(id);
    const response = await stub.fetch("https://gitfoundry-linux.internal/linux/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(executionRequest)
    });
    const result = await response.json().catch(() => undefined);
    if (response.status !== 200 || !isRecord(result) || result.ok !== true || !isRecord(result.receipt)) return linuxQualificationFailure(result, env);
    return json(redactedLinuxReceipt(result.receipt, executionRequest.commandId, config.image, profile), 200);
  } catch (error) {
    return linuxQualificationFailure({ error: "gfy_linux_qualification_exception", receipt: { stderr: error instanceof Error ? error.message : "qualification exception" } }, env);
  }
}

function providerQualificationConfig(env: ProviderQualificationEnv): ProviderQualificationConfig | undefined {
  const artifacts = env.GFY_GIT;
  const namespace = env.GFY_GIT_NAMESPACE;
  if (!isArtifactsGitBinding(artifacts) || !namespace) return undefined;
  const config: ProviderQualificationConfig = { artifacts, namespace };
  return env.GFY_PUBLIC_GIT_URL_BASE ? { ...config, publicGitUrlBase: env.GFY_PUBLIC_GIT_URL_BASE } : config;
}

function isArtifactsGitBinding(value: unknown): value is ArtifactsBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly create?: unknown; readonly get?: unknown; readonly list?: unknown };
  return typeof candidate.create === "function" && typeof candidate.get === "function" && typeof candidate.list === "function";
}

function linuxQualificationConfig(env: ProviderQualificationEnv, profile: LinuxQualificationProfile, target: "active" | "canary" = "active"): LinuxQualificationConfig | undefined {
  const namespace = target === "canary"
    ? (profile === trustedLinuxProfile ? env.TRUSTED_GIT_HELPER_CANARY : env.UNTRUSTED_CI_JOB_CANARY)
    : (profile === trustedLinuxProfile ? env.TRUSTED_GIT_HELPER : env.UNTRUSTED_CI_JOB);
  const image = profile === trustedLinuxProfile ? env.GFY_TRUSTED_GIT_HELPER_IMAGE : env.GFY_UNTRUSTED_CI_IMAGE;
  if (!isDurableObjectNamespace(namespace) || typeof image !== "string" || !imageDigestPattern.test(image)) return undefined;
  return { namespace, image };
}

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly idFromName?: unknown; readonly get?: unknown };
  return typeof candidate.idFromName === "function" && typeof candidate.get === "function";
}

async function runProviderRead(effect: ReturnType<ReturnType<typeof makeArtifactsGitProvider>["readRepository"]>): Promise<ArtifactsRepositoryReadback | undefined> {
  try {
    return await Effect.runPromise(effect);
  } catch (error) {
    if (error instanceof ArtifactsGitProviderError && error.code === "not_found") return undefined;
    throw error;
  }
}

async function runProviderWrite(effect: ReturnType<ReturnType<typeof makeArtifactsGitProvider>["provisionRepository"]>): Promise<void> {
  await Effect.runPromise(effect);
}

async function readQualificationBody(request: Request): Promise<{ ok: true; body: QualificationRequestBody } | { ok: false; status: 400 | 413; error: string }> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0) return { ok: false, status: 400, error: "invalid qualification request" };
    if (length > maxQualificationBodyBytes) return { ok: false, status: 413, error: "request body too large" };
  }

  const bodyBytes = await readBoundedBody(request, maxQualificationBodyBytes);
  if (!bodyBytes.ok) return bodyBytes;
  if (bodyBytes.bytes.byteLength === 0) return { ok: true, body: { create: false } };

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bodyBytes.bytes));
  } catch {
    return { ok: false, status: 400, error: "invalid qualification request" };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, status: 400, error: "invalid qualification request" };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "create")) return { ok: false, status: 400, error: "invalid qualification request" };
  const create = record.create ?? false;
  if (typeof create !== "boolean") return { ok: false, status: 400, error: "invalid qualification request" };
  return { ok: true, body: { create } };
}

async function readLinuxQualificationBody(request: Request): Promise<{ ok: true; body: LinuxQualificationRequestBody } | { ok: false; status: 400 | 413; error: string }> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0) return { ok: false, status: 400, error: "invalid qualification request" };
    if (length > maxQualificationBodyBytes) return { ok: false, status: 413, error: "request body too large" };
  }

  const bodyBytes = await readBoundedBody(request, maxQualificationBodyBytes);
  if (!bodyBytes.ok) return bodyBytes;
  if (bodyBytes.bytes.byteLength === 0) return { ok: true, body: { profile: trustedLinuxProfile } };

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bodyBytes.bytes));
  } catch {
    return { ok: false, status: 400, error: "invalid qualification request" };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, status: 400, error: "invalid qualification request" };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "profile" && key !== "target")) return { ok: false, status: 400, error: "invalid qualification request" };
  const profile = record.profile ?? trustedLinuxProfile;
  const target = record.target ?? "active";
  if (profile !== trustedLinuxProfile && profile !== untrustedCiProfile) return { ok: false, status: 400, error: "invalid qualification request" };
  if (target !== "active" && target !== "canary") return { ok: false, status: 400, error: "invalid qualification request" };
  return { ok: true, body: { profile, target } };
}

async function linuxQualificationRequest(profile: LinuxQualificationProfile, image: string): Promise<LinuxExecQualificationRequest> {
  const operationId = profile === trustedLinuxProfile ? "qualify-trusted-git" : "qualify-untrusted-ci";
  const commandId = await linuxQualificationCommandId(profile, image);
  return {
    commandId,
    tenantId: linuxQualificationTenantId,
    repositoryId: linuxQualificationRepositoryId,
    operationId,
    fenceToken: `fence-${commandId}`,
    deadlineMs: linuxQualificationDeadlineMs,
    cwd: `/work/${linuxQualificationTenantId}/${linuxQualificationRepositoryId}/${operationId}`,
    argv: profile === trustedLinuxProfile ? ["/usr/bin/git", "--version"] : ["/usr/local/bin/gitfoundry-ci-step", "/usr/bin/sh", "-c", ciQualificationScript],
    env: { GFY_COMMAND_ID: commandId, GFY_OPERATION_ID: operationId },
    egressProfile: "deny_all"
  };
}

async function linuxQualificationCommandId(profile: LinuxQualificationProfile, image: string): Promise<string> {
  const input = JSON.stringify(["gitfoundry.linux.qualification.v2", profile, image, crypto.randomUUID()]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return `linuxq-${hex(new Uint8Array(digest)).slice(0, 48)}`;
}

async function readBoundedBody(request: Request, limitBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 413; error: string }> {
  if (!request.body) return { ok: true, bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: "request body too large" };
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function redactedReadback(readback: ArtifactsRepositoryReadback): { readonly provider_id: string; readonly name: string; readonly defaultBranch: string; readonly readOnly: boolean } {
  return {
    provider_id: readback.provider_id,
    name: readback.name,
    defaultBranch: readback.default_branch,
    readOnly: readback.read_only
  };
}

function redactedLinuxReceipt(receipt: Record<string, unknown>, commandId: string, image: string, profile: LinuxQualificationProfile): Record<string, unknown> {
  const status = receipt.status;
  const exitCode = receipt.exitCode;
  const cleanupRequired = receipt.cleanupRequired;
  const receiptImage = receipt.image;
  const stdout = receipt.stdout;
  if (receipt.commandId !== commandId || status !== "succeeded" || exitCode !== 0 || cleanupRequired !== false || receiptImage !== image || typeof stdout !== "string") throw new Error("linux qualification receipt invalid");
  if (profile === untrustedCiProfile) {
    const lines = stdout.replace(/\r?\n$/u, "").split(/\r?\n/u);
    const [architecture, version, supervisorVersion, credentials, egress] = lines;
    if (lines.length !== 5 || architecture !== "x86_64" || typeof version !== "string" || !/^git version [0-9][A-Za-z0-9 ._-]{0,100}$/u.test(version) || typeof supervisorVersion !== "string" || !/^gitfoundry-supervisor [0-9][A-Za-z0-9 ._-]{0,100}$/u.test(supervisorVersion) || credentials !== "credentials_absent" || egress !== "public_egress_denied") throw new Error("CI qualification evidence invalid");
    return { profile, commandId, image, status, exitCode, cleanupRequired, architecture, version, supervisorVersion, credentialsAbsent: true, publicEgressDenied: true };
  }
  const version = stdout.split(/\r?\n/u).find((line) => line.length > 0)?.trim() ?? "";
  if (!/^git version [0-9][A-Za-z0-9 ._-]{0,100}$/u.test(version)) throw new Error("linux qualification version missing");
  return { profile: trustedLinuxProfile, commandId, image, status, exitCode, cleanupRequired, version };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function qualificationFailureResponse(error: unknown): Response {
  if (error instanceof GitProvisionerUnavailableError) return json({ error: "provider qualification unconfigured" }, 503);
  if (error instanceof ArtifactsGitProviderError) {
    switch (error.code) {
      case "invalid_repository_identity":
        return json({ error: "provider qualification unconfigured" }, 503);
      case "not_found":
        return json({ error: "qualification repository not found" }, 404);
      case "already_exists":
      case "in_progress":
        return json({ error: "provider qualification pending" }, 409);
      case "upstream_unavailable":
      case "unsupported_protection":
      case "unsupported_cas":
      case "provider_error":
        return json({ error: "provider qualification failed" }, 502);
    }
  }
  return json({ error: "provider qualification failed" }, 502);
}

function json(body: Record<string, unknown>, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(headers ?? {})
    }
  });
}

function linuxQualificationFailure(result: unknown, env: ProviderQualificationEnv): Response {
  const record = isRecord(result) ? result : {};
  const code = typeof record.error === "string" && /^gfy_linux_[a-z_]{1,80}$/.test(record.error) ? record.error : "gfy_linux_invalid_response";
  const receipt = isRecord(record.receipt) ? record.receipt : {};
  let diagnostic = typeof receipt.stderr === "string" ? receipt.stderr.slice(0, 4096) : "";
  const secret = env.GFY_QUALIFIER_CLIENT_SECRET;
  if (secret) {
    diagnostic = diagnostic.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  diagnostic = diagnostic.replace(/https?:\/\/\S+/g, "[url]").replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
  return json({ error: "linux qualification failed", failure_code: code, diagnostic }, 502);
}
