import { createHash } from "node:crypto";
import { Data, Effect } from "effect";
import { GitProvisionerUnavailableError, type GitProvisioner } from "../../../packages/core/src/live/index.js";
import type { Repository } from "@gitfoundry/core";

export type ArtifactsGitProviderFailureCode =
  | "invalid_repository_identity"
  | "not_found"
  | "already_exists"
  | "in_progress"
  | "upstream_unavailable"
  | "unsupported_protection"
  | "unsupported_cas"
  | "provider_error";

type KnownProviderCode =
  | "ALREADY_EXISTS"
  | "CREATE_IN_PROGRESS"
  | "FORK_IN_PROGRESS"
  | "IMPORT_IN_PROGRESS"
  | "INTERNAL_ERROR"
  | "INVALID_INPUT"
  | "INVALID_REMOTE_URL"
  | "INVALID_REPO_NAME"
  | "INVALID_TTL"
  | "INVALID_URL"
  | "MEMORY_LIMIT"
  | "NOT_FOUND"
  | "PROVIDER_IDENTITY_MISMATCH"
  | "REMOTE_AUTH_REQUIRED"
  | "UNSUPPORTED_CAS"
  | "UNSUPPORTED_PROTECTION"
  | "UPSTREAM_UNAVAILABLE";

export class ArtifactsGitProviderError extends Data.TaggedError("ArtifactsGitProviderError")<{
  readonly code: ArtifactsGitProviderFailureCode;
  readonly reason: string;
  readonly providerCode?: KnownProviderCode;
}> {}

export interface ArtifactsRepositoryIdentity {
  readonly namespace: string;
  readonly name: string;
}

export interface ArtifactsRepositoryInput {
  readonly tenantId: string;
  readonly namespaceId: string;
  readonly name: string;
}

export interface ArtifactsRepositoryReadback extends ArtifactsRepositoryIdentity {
  readonly provider_id: string;
  readonly default_branch: string;
  readonly remote: string;
  readonly read_only: boolean;
  readonly last_push_at: string | null;
  readonly source: string | null;
}

export interface ArtifactsHelperToken extends ArtifactsRepositoryIdentity {
  readonly intended_for: "trusted_git_helper";
  readonly token_id: string;
  readonly plaintext: string;
  readonly scope: "read" | "write";
  readonly expires_at: string;
}

export interface ArtifactsGitProvider {
  readonly provisionRepository: GitProvisioner["provisionRepository"];
  readonly deleteRepository: NonNullable<GitProvisioner["deleteRepository"]>;
  readonly readRepository: (input: ArtifactsRepositoryInput) => Effect.Effect<ArtifactsRepositoryReadback, ArtifactsGitProviderError | GitProvisionerUnavailableError>;
  readonly listRepositories: (options?: { readonly limit?: number; readonly cursor?: string }) => Effect.Effect<{ readonly repositories: readonly Omit<ArtifactsRepositoryReadback, "remote">[]; readonly total: number; readonly cursor?: string }, ArtifactsGitProviderError | GitProvisionerUnavailableError>;
  readonly createHelperToken: (input: ArtifactsRepositoryInput & { readonly scope?: "read" | "write"; readonly ttlSeconds?: number }) => Effect.Effect<ArtifactsHelperToken, ArtifactsGitProviderError | GitProvisionerUnavailableError>;
  readonly configureBranchProtection: () => Effect.Effect<never, ArtifactsGitProviderError>;
  readonly compareAndSwapRef: () => Effect.Effect<never, ArtifactsGitProviderError>;
}

export interface ArtifactsGitProviderOptions {
  readonly namespace: string;
  readonly defaultHelperTokenTtlSeconds?: number;
  readonly publicGitUrlBase?: string;
}

export type ArtifactsRepoHandle = Pick<ArtifactsRepo, "info" | "createToken" | "revokeToken"> & Partial<Pick<ArtifactsRepo, "log">> & Partial<Disposable>;
export interface ArtifactsBinding {
  readonly create: (name: string, options?: { readonly readOnly?: boolean; readonly description?: string; readonly setDefaultBranch?: string }) => ReturnType<Artifacts["create"]>;
  readonly get: (name: string) => Promise<ArtifactsRepoHandle>;
  readonly list: (options?: { readonly limit?: number; readonly cursor?: string }) => ReturnType<Artifacts["list"]>;
  readonly delete?: (name: string) => ReturnType<Artifacts["delete"]>;
}
export type WorkersArtifactsCreateRepoResult = ArtifactsCreateRepoResult;
export type WorkersArtifactsCreateTokenResult = ArtifactsCreateTokenResult;
export type WorkersArtifactsRepoInfo = ArtifactsRepoInfo;

const providerNamespacePattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const providerRepositoryNamePattern = /^[A-Za-z0-9_.-]{1,255}$/;
const defaultHelperTokenTtlSeconds = 300;
const maxHelperTokenTtlSeconds = 900;
const defaultPublicGitUrlBase = "https://gitfoundry.invalid/git";
const knownProviderCodes = new Set<KnownProviderCode>([
  "ALREADY_EXISTS",
  "CREATE_IN_PROGRESS",
  "FORK_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "INTERNAL_ERROR",
  "INVALID_INPUT",
  "INVALID_REMOTE_URL",
  "INVALID_REPO_NAME",
  "INVALID_TTL",
  "INVALID_URL",
  "MEMORY_LIMIT",
  "NOT_FOUND",
  "PROVIDER_IDENTITY_MISMATCH",
  "REMOTE_AUTH_REQUIRED",
  "UNSUPPORTED_CAS",
  "UNSUPPORTED_PROTECTION",
  "UPSTREAM_UNAVAILABLE"
]);

export function makeArtifactsGitProvider(binding: ArtifactsBinding | undefined, options: ArtifactsGitProviderOptions): ArtifactsGitProvider {
  const requireBinding = () => {
    if (!binding) throw new GitProvisionerUnavailableError({ reason: "Cloudflare Artifacts binding is not configured" });
    return binding;
  };

  const provider: ArtifactsGitProvider = {
    provisionRepository: ((input) => Effect.tryPromise({
      try: async () => {
        const artifacts = requireBinding();
        const identity = artifactsRepositoryIdentity(input, options.namespace);
        const createOptions: { readOnly?: boolean; description?: string; setDefaultBranch?: string } = { readOnly: false };
        if (input.defaultBranch) createOptions.setDefaultBranch = input.defaultBranch;
        const created = await artifacts.create(identity.name, createOptions);
        assertCreateResult(identity, created);
        await readRepositoryInfo(artifacts, identity);
        await revokeBootstrapToken(artifacts, identity, created.token);
        return { gitUrl: publicGatewayRemoteUrl(identity, options.publicGitUrlBase), artifactsNamespace: identity.namespace, artifactsName: identity.name };
      },
      catch: (error) => mapProvisionError(error)
    })) as GitProvisioner["provisionRepository"],
    deleteRepository: ((input) => Effect.tryPromise({
      try: async () => {
        const artifacts = requireBinding();
        // Only storage in this deployment's namespace is ours to delete.
        if (input.artifactsNamespace !== assertProviderNamespace(options.namespace) || !providerRepositoryNamePattern.test(input.artifactsName)) throw providerError("invalid_repository_identity", "INVALID_REPO_NAME");
        if (!artifacts.delete) throw new GitProvisionerUnavailableError({ reason: "Cloudflare Artifacts binding cannot delete repositories" });
        await artifacts.delete(input.artifactsName);
      },
      catch: (error) => mapProvisionError(error)
    })) as NonNullable<GitProvisioner["deleteRepository"]>,
    readRepository: (input) => Effect.tryPromise({
      try: async () => {
        const artifacts = requireBinding();
        const identity = artifactsRepositoryIdentity(input, options.namespace);
        return await readRepositoryInfo(artifacts, identity);
      },
      catch: (error) => mapProviderError(error)
    }),
    listRepositories: (listOptions) => Effect.tryPromise({
      try: async () => {
        const artifacts = requireBinding();
        const namespace = assertProviderNamespace(options.namespace);
        const listed = await artifacts.list(listOptions);
        const repositories = listed.repos.map((repo: Omit<ArtifactsRepoInfo, "remote">) => {
          if (!providerRepositoryNamePattern.test(repo.name)) throw providerError("provider_error", "PROVIDER_IDENTITY_MISMATCH");
          return {
            namespace,
            name: repo.name,
            provider_id: repo.id,
            default_branch: repo.defaultBranch,
            read_only: repo.readOnly,
            last_push_at: repo.lastPushAt,
            source: repo.source
          };
        });
        const result: { repositories: readonly Omit<ArtifactsRepositoryReadback, "remote">[]; total: number; cursor?: string } = { repositories, total: listed.total };
        if (listed.cursor) result.cursor = listed.cursor;
        return result;
      },
      catch: (error) => mapProviderError(error)
    }),
    createHelperToken: (input) => Effect.tryPromise({
      try: async () => {
        const artifacts = requireBinding();
        const identity = artifactsRepositoryIdentity(input, options.namespace);
        const requestedScope = input.scope ?? "write";
        const ttlSeconds = normalizeHelperTtl(input.ttlSeconds ?? options.defaultHelperTokenTtlSeconds ?? defaultHelperTokenTtlSeconds);
        const repo = await artifacts.get(identity.name) as ArtifactsRepoHandle;
        try {
          const info = await repo.info();
          assertReadbackIdentity(identity, info);
          const token = await repo.createToken(requestedScope, ttlSeconds);
          return helperToken(identity, token, requestedScope);
        } finally {
          disposeRepo(repo);
        }
      },
      catch: (error) => mapProviderError(error)
    }),
    configureBranchProtection: () => Effect.fail(providerError("unsupported_protection", "UNSUPPORTED_PROTECTION")),
    compareAndSwapRef: () => Effect.fail(providerError("unsupported_cas", "UNSUPPORTED_CAS"))
  };

  return provider;
}

export function makeArtifactsGitProvisioner(binding: ArtifactsBinding | undefined, options: ArtifactsGitProviderOptions): GitProvisioner {
  const provider = makeArtifactsGitProvider(binding, options);
  return { provisionRepository: provider.provisionRepository, deleteRepository: provider.deleteRepository };
}

export function artifactsRepositoryIdentity(input: ArtifactsRepositoryInput, namespace: string): ArtifactsRepositoryIdentity {
  assertSourceId(input.tenantId, 128);
  assertSourceId(input.namespaceId, 128);
  assertSourceId(input.name, 100);
  const qualifiedNamespace = assertProviderNamespace(namespace);
  const tuple = canonicalRepositoryTuple(input);
  const readable = readableProviderNamePart(input.name);
  const name = `gfy.${readable}.${sha256Hex(tuple)}`;
  if (!providerRepositoryNamePattern.test(name)) throw providerError("invalid_repository_identity", "INVALID_REPO_NAME");
  return { namespace: qualifiedNamespace, name };
}

function canonicalRepositoryTuple(input: ArtifactsRepositoryInput): string {
  return JSON.stringify(["gitfoundry.artifacts.repository.v1", input.tenantId, input.namespaceId, input.name]);
}

function assertSourceId(value: string, maxLength: number): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) throw providerError("invalid_repository_identity", "INVALID_REPO_NAME");
}

function assertProviderNamespace(namespace: string): string {
  if (typeof namespace !== "string" || !providerNamespacePattern.test(namespace)) throw providerError("invalid_repository_identity", "INVALID_REPO_NAME");
  return namespace;
}

function readableProviderNamePart(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return readable.length > 0 ? readable : "repo";
}

async function readRepositoryInfo(artifacts: ArtifactsBinding, identity: ArtifactsRepositoryIdentity): Promise<ArtifactsRepositoryReadback> {
  const repo = await artifacts.get(identity.name) as ArtifactsRepoHandle;
  try {
    const info = await repo.info();
    assertReadbackIdentity(identity, info);
    return repositoryReadback(identity, info);
  } finally {
    disposeRepo(repo);
  }
}

async function revokeBootstrapToken(artifacts: ArtifactsBinding, identity: ArtifactsRepositoryIdentity, token: string): Promise<void> {
  const repo = await artifacts.get(identity.name) as ArtifactsRepoHandle;
  try {
    const info = await repo.info();
    assertReadbackIdentity(identity, info);
    const revoked = await repo.revokeToken(token);
    if (revoked !== true) throw providerError("provider_error");
  } finally {
    disposeRepo(repo);
  }
}

function assertCreateResult(identity: ArtifactsRepositoryIdentity, created: ArtifactsCreateRepoResult): void {
  if (created.name !== identity.name || !providerRepositoryNamePattern.test(created.name)) {
    throw providerError("provider_error", "PROVIDER_IDENTITY_MISMATCH");
  }
  if (typeof created.token !== "string" || created.token.length < 1) throw providerError("provider_error");
  publicRemoteUrl(created.remote);
}

function assertReadbackIdentity(identity: ArtifactsRepositoryIdentity, info: ArtifactsRepoInfo): void {
  if (info.name !== identity.name || !providerRepositoryNamePattern.test(info.name)) {
    throw providerError("provider_error", "PROVIDER_IDENTITY_MISMATCH");
  }
}

function repositoryReadback(identity: ArtifactsRepositoryIdentity, info: ArtifactsRepoInfo): ArtifactsRepositoryReadback {
  return {
    namespace: identity.namespace,
    name: identity.name,
    provider_id: info.id,
    default_branch: info.defaultBranch,
    remote: publicRemoteUrl(info.remote),
    read_only: info.readOnly,
    last_push_at: info.lastPushAt,
    source: info.source
  };
}

function helperToken(identity: ArtifactsRepositoryIdentity, token: ArtifactsCreateTokenResult, expectedScope: "read" | "write"): ArtifactsHelperToken {
  if (typeof token.id !== "string" || token.id.length < 1 || typeof token.plaintext !== "string" || token.plaintext.length < 1) throw providerError("provider_error");
  if (token.scope !== expectedScope) throw providerError("provider_error");
  if (typeof token.expiresAt !== "string" || !Number.isFinite(Date.parse(token.expiresAt))) throw providerError("provider_error", "INVALID_TTL");
  return {
    namespace: identity.namespace,
    name: identity.name,
    intended_for: "trusted_git_helper",
    token_id: token.id,
    plaintext: token.plaintext,
    scope: token.scope,
    expires_at: token.expiresAt
  };
}

function normalizeHelperTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > maxHelperTokenTtlSeconds) {
    throw providerError("provider_error", "INVALID_TTL");
  }
  return ttlSeconds;
}

function publicRemoteUrl(remote: string): string {
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw providerError("provider_error", "INVALID_REMOTE_URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length < 1) throw providerError("provider_error", "INVALID_REMOTE_URL");
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function publicGatewayRemoteUrl(identity: ArtifactsRepositoryIdentity, publicGitUrlBase = defaultPublicGitUrlBase): string {
  let parsed: URL;
  try {
    parsed = new URL(publicGitUrlBase);
  } catch {
    throw providerError("provider_error", "INVALID_REMOTE_URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length < 1) throw providerError("provider_error", "INVALID_REMOTE_URL");
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const basePath = parsed.pathname.replace(/\/+$/g, "");
  parsed.pathname = `${basePath}/${encodeURIComponent(identity.namespace)}/${encodeURIComponent(identity.name)}.git`;
  return parsed.toString();
}

function disposeRepo(repo: ArtifactsRepoHandle): void {
  const disposable = repo as Partial<Record<typeof Symbol.dispose, () => void>>;
  disposable[Symbol.dispose]?.();
}

function mapProvisionError(error: unknown): ArtifactsGitProviderError | GitProvisionerUnavailableError {
  if (error instanceof GitProvisionerUnavailableError) return error;
  return mapProviderError(error);
}

function mapProviderError(error: unknown): ArtifactsGitProviderError | GitProvisionerUnavailableError {
  if (error instanceof GitProvisionerUnavailableError) return error;
  if (error instanceof ArtifactsGitProviderError) return error;
  const providerCode = knownProviderErrorCode(error);
  switch (providerCode) {
    case "INVALID_REPO_NAME": return providerError("invalid_repository_identity", providerCode);
    case "NOT_FOUND": return providerError("not_found", providerCode);
    case "ALREADY_EXISTS": return providerError("already_exists", providerCode);
    case "CREATE_IN_PROGRESS":
    case "IMPORT_IN_PROGRESS":
    case "FORK_IN_PROGRESS": return providerError("in_progress", providerCode);
    case "REMOTE_AUTH_REQUIRED":
    case "UPSTREAM_UNAVAILABLE":
    case "INVALID_URL": return providerError("upstream_unavailable", providerCode);
    default: return providerCode ? providerError("provider_error", providerCode) : providerError("provider_error");
  }
}

function providerError(code: ArtifactsGitProviderFailureCode, providerCode?: KnownProviderCode): ArtifactsGitProviderError {
  const reason = providerCode ? `Cloudflare Artifacts ${providerCode}` : "Cloudflare Artifacts provider error";
  return providerCode ? new ArtifactsGitProviderError({ code, providerCode, reason }) : new ArtifactsGitProviderError({ code, reason });
}

function knownProviderErrorCode(error: unknown): KnownProviderCode | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && knownProviderCodes.has(code as KnownProviderCode) ? code as KnownProviderCode : undefined;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
