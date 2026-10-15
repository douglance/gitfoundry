import * as Redacted from "effect/Redacted";

export interface ProviderQualificationRunnerInput {
  readonly apiUrl: string;
  readonly accessClientId: string;
  readonly accessClientSecret: Redacted.Redacted<string> | string | undefined;
  readonly accessAudience?: string;
  readonly providerQualificationServiceTokenId?: string;
  readonly sourceRevision: string;
  readonly trustedGitHelperImage: string;
  readonly untrustedCiImage: string;
  readonly contentRepositoryName: string;
  readonly contentCommitSha: string;
  readonly contentSha256: string;
  readonly contentByteLength: number;
}

export interface ProviderQualificationArtifactsProof {
  readonly provider_id: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly readOnly: boolean;
}

export interface ProviderQualificationContentProof {
  readonly provider_id: string;
  readonly name: string;
  readonly defaultBranch: "main";
  readonly readOnly: true;
  readonly commit_sha: string;
  readonly path: "README";
  readonly byte_length: number;
  readonly content_sha256: string;
}

export interface ProviderQualificationLinuxProof {
  readonly profile: "trusted_git_helper";
  readonly commandId: string;
  readonly image: string;
  readonly status: "succeeded";
  readonly exitCode: 0;
  readonly cleanupRequired: false;
  readonly version: string;
}

export interface ProviderQualificationCiProof {
  readonly profile: "untrusted_ci_job";
  readonly commandId: string;
  readonly image: string;
  readonly status: "succeeded";
  readonly exitCode: 0;
  readonly cleanupRequired: false;
  readonly version: string;
  readonly architecture: "x86_64";
  readonly credentialsAbsent: true;
  readonly publicEgressDenied: true;
  readonly supervisorVersion: string;
}

export interface ProviderQualificationProof {
  readonly artifacts: ProviderQualificationArtifactsProof;
  readonly content: ProviderQualificationContentProof;
  readonly linux: ProviderQualificationLinuxProof;
  readonly ci: ProviderQualificationCiProof;
  readonly images: {
    readonly trustedGitHelper: string;
    readonly untrustedCi: string;
  };
}

export type ProviderQualificationRunnerErrorCode = "invalid_input" | "redirect" | "http_status" | "invalid_response" | "revision_mismatch" | "transport";

export class ProviderQualificationRunnerError extends Error {
  readonly name = "ProviderQualificationRunnerError";

  constructor(readonly code: ProviderQualificationRunnerErrorCode, readonly route: string, message = "provider qualification " + code) {
    super(message);
  }

  toJSON(): { readonly name: string; readonly code: ProviderQualificationRunnerErrorCode; readonly route: string; readonly message: string } {
    return { name: this.name, code: this.code, route: this.route, message: this.message };
  }
}

interface RunnerOptions {
  readonly fetch?: typeof fetch;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}

interface RetryPolicy {
  readonly maxAttempts: number;
  readonly delayMs: number;
}

interface LinuxProofExpectation {
  readonly profile: "trusted_git_helper" | "untrusted_ci_job";
  readonly image: string;
}

interface ContentProofExpectation {
  readonly name: string;
  readonly commitSha: string;
  readonly sha256: string;
  readonly byteLength: number;
}

type ProofExpectation = LinuxProofExpectation | ContentProofExpectation;

const artifactsRoute = "/_operator/qualify/artifacts";
const contentRoute = "/_operator/qualify/artifacts-content";
const linuxRoute = "/_operator/qualify/linux";
const imageDigestPattern = /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;
const sourceRevisionPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const contentRepositoryNamePattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const commandIdPattern = /^linuxq-[0-9a-f]{48}$/u;
const gitVersionPattern = /^git version [0-9][A-Za-z0-9 ._-]{0,100}$/u;
const supervisorVersionPattern = /^gitfoundry-supervisor [0-9][A-Za-z0-9 ._-]{0,100}$/u;

export async function runProviderQualification(input: ProviderQualificationRunnerInput, options: RunnerOptions = {}): Promise<ProviderQualificationProof> {
  const fetcher = options.fetch ?? fetch;
  const apiUrl = normalizeApiUrl(input.apiUrl);
  const clientSecret = accessClientSecret(input.accessClientSecret);
  const sourceRevision = requiredSourceRevision(input.sourceRevision);
  const trustedGitHelperImage = requiredImage(input.trustedGitHelperImage);
  const untrustedCiImage = requiredImage(input.untrustedCiImage);
  const contentRepositoryName = requiredContentRepositoryName(input.contentRepositoryName);
  const contentCommitSha = requiredContentCommitSha(input.contentCommitSha);
  const contentSha256 = requiredContentSha256(input.contentSha256);
  const contentByteLength = requiredContentByteLength(input.contentByteLength);
  if (!input.accessClientId) throw new ProviderQualificationRunnerError("invalid_input", "access", "provider qualification input invalid");

  const retry = retryPolicy(options);
  const trustedLinuxExpectation = { profile: "trusted_git_helper", image: trustedGitHelperImage } as const;
  const ciExpectation = { profile: "untrusted_ci_job", image: untrustedCiImage } as const;
  const contentExpectation = { name: contentRepositoryName, commitSha: contentCommitSha, sha256: contentSha256, byteLength: contentByteLength } as const;
  const artifacts = await postJson(fetcher, apiUrl + artifactsRoute, artifactsRoute, input.accessClientId, clientSecret, sourceRevision, { create: true }, isArtifactsProof, retry);
  const content = await postJson(fetcher, apiUrl + contentRoute, contentRoute, input.accessClientId, clientSecret, sourceRevision, {}, (value): value is ProviderQualificationContentProof => isContentProof(value, contentExpectation), retry, contentExpectation);
  const linux = await postJson(fetcher, apiUrl + linuxRoute, linuxRoute, input.accessClientId, clientSecret, sourceRevision, { profile: "trusted_git_helper" }, (value): value is ProviderQualificationLinuxProof => isTrustedLinuxProof(value, trustedGitHelperImage), retry, trustedLinuxExpectation);
  const ci = await postJson(fetcher, apiUrl + linuxRoute, linuxRoute, input.accessClientId, clientSecret, sourceRevision, { profile: "untrusted_ci_job" }, (value): value is ProviderQualificationCiProof => isCiProof(value, untrustedCiImage), retry, ciExpectation);

  const proof: ProviderQualificationProof = {
    artifacts,
    content,
    linux,
    ci,
    images: { trustedGitHelper: trustedGitHelperImage, untrustedCi: untrustedCiImage }
  };
  assertSecretAbsent(proof, clientSecret, "proof");
  return proof;
}

async function postJson<T>(fetcher: typeof fetch, url: string, route: string, clientId: string, clientSecret: string, sourceRevision: string, body: Record<string, unknown>, accept: (value: unknown) => value is T, retry: RetryPolicy, proofExpectation?: ProofExpectation): Promise<T> {
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "CF-Access-Client-Id": clientId,
          "CF-Access-Client-Secret": clientSecret,
          "X-GitFoundry-Operator-Client-Id": clientId,
          "X-GitFoundry-Operator-Secret": clientSecret,
          "X-GitFoundry-Expected-Revision": sourceRevision
        },
        body: JSON.stringify(body)
      });
    } catch {
      throw new ProviderQualificationRunnerError("transport", route, "provider qualification transport failed");
    }

    if (response.status === 409) {
      await discardResponseBody(response);
      if (attempt < retry.maxAttempts) {
        await sleep(retry.delayMs);
        continue;
      }
      throw new ProviderQualificationRunnerError("revision_mismatch", route, "provider qualification revision_mismatch");
    }
    if (response.status >= 300 && response.status < 400) {
      if (attempt < retry.maxAttempts) {
        await sleep(retry.delayMs);
        continue;
      }
      throw new ProviderQualificationRunnerError("redirect", route, "provider qualification redirected");
    }
    if (response.status !== 200) {
      if (isRetryableHttpStatus(response.status) && attempt < retry.maxAttempts) {
        await sleep(retry.delayMs);
        continue;
      }
      const kind = await failureResponseKind(response, clientSecret);
      throw new ProviderQualificationRunnerError("http_status", route, "provider qualification failed with status " + response.status + " at " + route + " (response=" + kind + ")");
    }

    if (response.headers.get("X-GitFoundry-Source-Revision") !== sourceRevision) {
      await discardResponseBody(response);
      if (attempt < retry.maxAttempts) {
        await sleep(retry.delayMs);
        continue;
      }
      throw new ProviderQualificationRunnerError("revision_mismatch", route, "provider qualification revision_mismatch");
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ProviderQualificationRunnerError("invalid_response", route, "provider qualification response invalid at " + route + " (response=" + (response.headers.get("content-type")?.includes("text/html") ? "html" : response.headers.get("content-type")?.includes("application/json") ? "json" : "other") + ")");
    }
    if (!accept(value)) throw new ProviderQualificationRunnerError("invalid_response", route, "provider qualification response invalid at " + route + " (schema=" + qualificationSchemaDiagnostic(route, value, proofExpectation) + ")");
    assertSecretAbsent(value, clientSecret, route);
    return value;
  }
  throw new ProviderQualificationRunnerError("redirect", route, "provider qualification redirected");
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function retryPolicy(options: RunnerOptions): RetryPolicy {
  return {
    maxAttempts: positiveInteger(options.maxAttempts ?? 1),
    delayMs: Math.max(0, options.retryDelayMs ?? 0)
  };
}

function positiveInteger(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Draining is best-effort; the fixed error intentionally excludes body details.
  }
}

function normalizeApiUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid");
    return url.href.replace(/\/$/u, "");
  } catch {
    throw new ProviderQualificationRunnerError("invalid_input", "api", "provider qualification input invalid");
  }
}

function accessClientSecret(value: ProviderQualificationRunnerInput["accessClientSecret"]): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== undefined && Redacted.isRedacted(value)) {
    const secret = Redacted.value(value);
    if (typeof secret === "string" && secret.length > 0) return secret;
  }
  throw new ProviderQualificationRunnerError("invalid_input", "access", "provider qualification input invalid");
}

function requiredSourceRevision(value: string): string {
  if (sourceRevisionPattern.test(value)) return value;
  throw new ProviderQualificationRunnerError("invalid_input", "source", "provider qualification input invalid");
}

function requiredImage(value: string): string {
  if (imageDigestPattern.test(value)) return value;
  throw new ProviderQualificationRunnerError("invalid_input", "image", "provider qualification input invalid");
}

function requiredContentRepositoryName(value: string): string {
  if (contentRepositoryNamePattern.test(value)) return value;
  throw new ProviderQualificationRunnerError("invalid_input", "content", "provider qualification input invalid");
}

function requiredContentCommitSha(value: string): string {
  if (sourceRevisionPattern.test(value)) return value;
  throw new ProviderQualificationRunnerError("invalid_input", "content", "provider qualification input invalid");
}

function requiredContentSha256(value: string): string {
  if (sha256Pattern.test(value)) return value;
  throw new ProviderQualificationRunnerError("invalid_input", "content", "provider qualification input invalid");
}

function requiredContentByteLength(value: number): number {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new ProviderQualificationRunnerError("invalid_input", "content", "provider qualification input invalid");
}

function isArtifactsProof(value: unknown): value is ProviderQualificationArtifactsProof {
  if (!isRecord(value) || !hasExactKeys(value, ["defaultBranch", "name", "provider_id", "readOnly"])) return false;
  return typeof value.provider_id === "string" && value.provider_id.length > 0 && typeof value.name === "string" && value.name.length > 0 && typeof value.defaultBranch === "string" && value.defaultBranch.length > 0 && typeof value.readOnly === "boolean";
}

function isContentProof(value: unknown, expected: ContentProofExpectation): value is ProviderQualificationContentProof {
  if (!isRecord(value) || !hasExactKeys(value, ["byte_length", "commit_sha", "content_sha256", "defaultBranch", "name", "path", "provider_id", "readOnly"])) return false;
  return typeof value.provider_id === "string" && providerIdPattern.test(value.provider_id) && value.name === expected.name && value.defaultBranch === "main" && value.readOnly === true && value.commit_sha === expected.commitSha && value.path === "README" && value.byte_length === expected.byteLength && value.content_sha256 === expected.sha256;
}

function isTrustedLinuxProof(value: unknown, image: string): value is ProviderQualificationLinuxProof {
  if (!isRecord(value) || !hasExactKeys(value, ["cleanupRequired", "commandId", "exitCode", "image", "profile", "status", "version"])) return false;
  return value.profile === "trusted_git_helper" && typeof value.commandId === "string" && commandIdPattern.test(value.commandId) && value.image === image && value.status === "succeeded" && value.exitCode === 0 && value.cleanupRequired === false && typeof value.version === "string" && gitVersionPattern.test(value.version);
}

function isCiProof(value: unknown, image: string): value is ProviderQualificationCiProof {
  if (!isRecord(value) || !hasExactKeys(value, ["architecture", "cleanupRequired", "commandId", "credentialsAbsent", "exitCode", "image", "profile", "publicEgressDenied", "status", "supervisorVersion", "version"])) return false;
  return value.profile === "untrusted_ci_job" && typeof value.commandId === "string" && commandIdPattern.test(value.commandId) && value.image === image && value.status === "succeeded" && value.exitCode === 0 && value.cleanupRequired === false && typeof value.version === "string" && gitVersionPattern.test(value.version) && value.architecture === "x86_64" && value.credentialsAbsent === true && value.publicEgressDenied === true && typeof value.supervisorVersion === "string" && supervisorVersionPattern.test(value.supervisorVersion);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function assertSecretAbsent(value: unknown, secret: string, route: string): void {
  if (secret && JSON.stringify(value).includes(secret)) throw new ProviderQualificationRunnerError("invalid_response", route, "provider qualification response invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function failureResponseKind(response: Response, secret: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) return "html";
  if (!contentType.includes("application/json")) return "other";
  const reader = response.body?.getReader();
  if (!reader) return "json";
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) { await reader.cancel(); return "json"; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && "error" in body && body.error === "content qualification failed" && "stage" in body && typeof body.stage === "string" && ["readback", "import", "capability", "bootstrap", "identity", "log", "file", "digest"].includes(body.stage)) return "content:" + body.stage;

    if (typeof body === "object" && body !== null && "error" in body && body.error === "linux qualification failed" && "failure_code" in body && typeof body.failure_code === "string" && /^gfy_linux_[a-z_]{1,80}$/.test(body.failure_code) && "diagnostic" in body && typeof body.diagnostic === "string") {
      const detail = (body.failure_code + ": " + body.diagnostic.slice(0, 200)).replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]").replace(/https?:\/\/\S+/g, "[url]").replace(/[\x00-\x1f\x7f]/g, " ");
      return detail.slice(0, 300);
    }

    return typeof body === "object" && body !== null && "error" in body && body.error === "operator unauthorized" ? "operator_auth" : "json";
  } catch {
    return "json";
  } finally {
    reader.releaseLock();
  }
}

function qualificationSchemaDiagnostic(route: string, value: unknown, proofExpectation?: ProofExpectation): string {
  if (!isRecord(value)) return "not_object";
  const valid = route === artifactsRoute ? {
    keys: hasExactKeys(value, ["defaultBranch", "name", "provider_id", "readOnly"]),
    providerId: typeof value.provider_id === "string" && value.provider_id.length > 0,
    name: typeof value.name === "string" && value.name.length > 0,
    defaultBranch: typeof value.defaultBranch === "string" && value.defaultBranch.length > 0,
    readOnly: typeof value.readOnly === "boolean"
  } : isContentExpectation(proofExpectation) ? {
    keys: hasExactKeys(value, ["byte_length", "commit_sha", "content_sha256", "defaultBranch", "name", "path", "provider_id", "readOnly"]),
    providerId: typeof value.provider_id === "string" && providerIdPattern.test(value.provider_id),
    name: value.name === proofExpectation.name,
    defaultBranch: value.defaultBranch === "main",
    readOnly: value.readOnly === true,
    commit: value.commit_sha === proofExpectation.commitSha,
    path: value.path === "README",
    byteLength: value.byte_length === proofExpectation.byteLength,
    sha256: value.content_sha256 === proofExpectation.sha256
  } : proofExpectation?.profile === "untrusted_ci_job" ? {
    keys: hasExactKeys(value, ["architecture", "cleanupRequired", "commandId", "credentialsAbsent", "exitCode", "image", "profile", "publicEgressDenied", "status", "supervisorVersion", "version"]),
    profile: value.profile === "untrusted_ci_job",
    commandId: typeof value.commandId === "string" && commandIdPattern.test(value.commandId),
    image: value.image === proofExpectation.image,
    status: value.status === "succeeded",
    exitCode: value.exitCode === 0,
    cleanup: value.cleanupRequired === false,
    version: typeof value.version === "string" && gitVersionPattern.test(value.version),
    architecture: value.architecture === "x86_64",
    credentialsAbsent: value.credentialsAbsent === true,
    publicEgressDenied: value.publicEgressDenied === true,
    supervisorVersion: typeof value.supervisorVersion === "string" && supervisorVersionPattern.test(value.supervisorVersion)
  } : {
    keys: hasExactKeys(value, ["cleanupRequired", "commandId", "exitCode", "image", "profile", "status", "version"]),
    profile: value.profile === "trusted_git_helper",
    commandId: typeof value.commandId === "string" && commandIdPattern.test(value.commandId),
    image: value.image === proofExpectation?.image,
    status: value.status === "succeeded",
    exitCode: value.exitCode === 0,
    cleanup: value.cleanupRequired === false,
    version: typeof value.version === "string" && gitVersionPattern.test(value.version)
  };
  return Object.entries(valid).filter(([, valid]) => !valid).map(([field]) => field).join(",") || "unknown";
}

function isContentExpectation(value: ProofExpectation | undefined): value is ContentProofExpectation {
  return !!value && "commitSha" in value;
}
