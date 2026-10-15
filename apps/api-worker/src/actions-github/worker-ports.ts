import { Effect } from "effect";

import type { D1DatabaseLike } from "../../../../packages/core/src/live/index.js";
import type { ArtifactsBinding } from "../git-provider.js";
import { makeD1ArtifactsSourceRead, type SourceReadPort } from "../source-read.js";
import { ActionsBackendError, type ActionsBackend } from "./backend.js";
import { GitHubWorkflowHttpPortError, type GitHubWorkflowHttpPorts, type GitHubWorkflowVerifiedVersion, type WorkflowRepositoryCapability } from "./http.js";
import { makeUpstreamGitHubWorkflowBackend } from "./upstream-workflows.js";
import { makeD1GitHubWorkflowStore, makeGitHubWorkflowService, makeGitHubWorkflowSourceFromSourceRead } from "./workflows.js";

export interface GitHubWorkflowWorkerEnv {
  readonly GFY_ACTIONS_OWNER_TENANT_ID?: string;
  readonly GFY_ACTIONS_OWNER_REPOSITORY_ID?: string;
  readonly GFY_ACTIONS_OWNER_REPOSITORY?: string;
  readonly GFY_ACTIONS_STORAGE_GENERATION?: string;
  readonly GFY_SOURCE_READ?: SourceReadPort;
  readonly GFY_DB?: D1DatabaseLike;
  readonly DB?: D1DatabaseLike;
  readonly GFY_GIT?: ArtifactsBinding;
  readonly GFY_GIT_NAMESPACE?: string;
  readonly GITHUB_ACTIONS_BACKEND?: Pick<DurableObjectNamespace, "idFromName" | "get">;
}

export type GitHubWorkflowAuthenticateOwner = (
  request: Request,
  tenantId: string,
  capability: WorkflowRepositoryCapability
) => Promise<{ readonly ok: true; readonly actor_id: string } | { readonly ok: false; readonly response: Response }>;

export interface GitHubWorkflowWorkerPortOptions {
  readonly authenticateOwner: GitHubWorkflowAuthenticateOwner;
  readonly fetchApi: (request: Request, env: unknown) => Response | Promise<Response>;
  readonly forgeEnv: unknown | (() => unknown);
}

const shaPattern = /^[0-9a-f]{40}$/u;
const omittedGetHeaders = new Set(["content-length", "content-type"]);

export function makeGitHubWorkflowWorkerPorts(env: GitHubWorkflowWorkerEnv, options: GitHubWorkflowWorkerPortOptions): GitHubWorkflowHttpPorts {
  return {
    owner: {
      tenantId: env.GFY_ACTIONS_OWNER_TENANT_ID ?? "",
      repositoryId: env.GFY_ACTIONS_OWNER_REPOSITORY_ID ?? "",
      repository: env.GFY_ACTIONS_OWNER_REPOSITORY ?? ""
    },
    authenticate: input => Effect.tryPromise({
      try: async () => {
        const result = await options.authenticateOwner(input.request, input.scope.tenantId, input.capability);
        return result.ok
          ? { ok: true as const, actor: { actorId: result.actor_id } }
          : { ok: false as const, denialResponse: result.response };
      },
      catch: cause => portError("workflow authentication unavailable", cause)
    }),
    verifyVersion: input => Effect.tryPromise({
      try: async () => verifyVersion(input.request, input.scope, input.versionCommit, options),
      catch: cause => cause instanceof GitHubWorkflowHttpPortError ? cause : portError("forge version unavailable", cause)
    }),
    workflowService: () => Effect.try({
      try: () => {
        const db = database(env);
        const sourceRead = sourceReadFor(env, db);
        const store = makeD1GitHubWorkflowStore(db);
        const backend = makeUpstreamGitHubWorkflowBackend(actionsBackendFor(env));
        return makeGitHubWorkflowService(makeGitHubWorkflowSourceFromSourceRead(sourceRead), backend, store);
      },
      catch: cause => portError("workflow service unavailable", cause)
    })
  };
}

async function verifyVersion(request: Request, scope: GitHubWorkflowHttpPorts["owner"], versionCommit: string, options: GitHubWorkflowWorkerPortOptions): Promise<GitHubWorkflowVerifiedVersion> {
  const url = new URL(request.url);
  url.pathname = `/api/v2/tenants/${encodeURIComponent(scope.tenantId)}/repositories/${encodeURIComponent(scope.repositoryId)}/forge/versions/${versionCommit}`;
  url.search = "";
  const response = await options.fetchApi(new Request(url.toString(), { method: "GET", headers: readHeaders(request.headers), signal: request.signal }), resolveForgeEnv(options));
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw portError("forge version unavailable");
  }
  const body = await response.json();
  const version = parseVerifiedVersion(body, scope, versionCommit);
  if (!version) throw portError("forge version identity mismatch");
  return version;
}

function parseVerifiedVersion(body: unknown, scope: GitHubWorkflowHttpPorts["owner"], requestedVersionCommit: string): GitHubWorkflowVerifiedVersion | undefined {
  const envelope = record(body);
  const version = record(envelope?.version);
  const descriptor = record(version?.descriptor);
  const versionCommit = stringField(version, "version_commit");
  const codeCommit = stringField(descriptor, "code_commit");
  if (versionCommit !== requestedVersionCommit || !codeCommit || !shaPattern.test(codeCommit)) return undefined;
  if (stringField(descriptor, "tenant_id") !== scope.tenantId || stringField(descriptor, "repository_id") !== scope.repositoryId) return undefined;
  return { tenantId: scope.tenantId, repositoryId: scope.repositoryId, repository: scope.repository, versionCommit, codeCommit };
}

function database(env: GitHubWorkflowWorkerEnv): D1DatabaseLike {
  const db = env.GFY_DB ?? env.DB;
  if (!db) throw new Error("workflow database unavailable");
  return db;
}

function sourceReadFor(env: GitHubWorkflowWorkerEnv, db: D1DatabaseLike): SourceReadPort {
  if (env.GFY_SOURCE_READ) return env.GFY_SOURCE_READ;
  if (!env.GFY_GIT_NAMESPACE) throw new Error("workflow source namespace unavailable");
  if (!env.GFY_GIT) throw new Error("workflow source provider unavailable");
  return makeD1ArtifactsSourceRead(db, env.GFY_GIT, { namespace: env.GFY_GIT_NAMESPACE });
}

function actionsBackendFor(env: GitHubWorkflowWorkerEnv): ActionsBackend {
  const namespace = env.GITHUB_ACTIONS_BACKEND;
  const generation = env.GFY_ACTIONS_STORAGE_GENERATION;
  if (!namespace || !generation) throw new Error("workflow backend unavailable");
  const stub = namespace.get(namespace.idFromName(`actions-github:${generation}`));
  return {
    ready: Effect.void,
    fetch: request => Effect.tryPromise({
      try: signal => stub.fetch(new Request(request, { signal })),
      catch: () => new ActionsBackendError({ operation: "proxy" })
    })
  };
}

function readHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers) {
    if (!omittedGetHeaders.has(key.toLowerCase())) out.set(key, value);
  }
  return out;
}

function resolveForgeEnv(options: GitHubWorkflowWorkerPortOptions): unknown {
  return typeof options.forgeEnv === "function" ? options.forgeEnv() : options.forgeEnv;
}

function portError(message: string, cause?: unknown): GitHubWorkflowHttpPortError {
  return new GitHubWorkflowHttpPortError({ message, ...(cause === undefined ? {} : { cause }) });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}
