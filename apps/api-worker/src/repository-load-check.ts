import { describeForgeFailure, type ForgeFailureDescription } from "./fork-forge/http.js";
import { SourceReadUnavailableError } from "./source-read.js";
import { verifyOperatorServiceRequest, type OperatorServiceAuthEnv } from "./auth/operator-service.js";

export interface RepositoryLoadCheckEnv extends OperatorServiceAuthEnv {
  readonly GFY_SOURCE_REVISION?: string;
  readonly GFY_RUNNER_TENANT_ID?: string;
  readonly GFY_RUNNER_REPOSITORY_ID?: string;
}

// Each stage reads the canonical repository the way its repository page does.
export interface RepositoryLoadPorts {
  readonly head: (tenantId: string, repositoryId: string) => Promise<{ readonly version_commit: string; readonly code_commit: string } | null>;
  readonly list: (tenantId: string, repositoryId: string) => Promise<readonly unknown[]>;
  readonly tree: (tenantId: string, repositoryId: string, ref: string) => Promise<{ readonly items: readonly unknown[] }>;
}

type Stage = "head" | "list" | "tree";

export const repositoryLoadCheckPath = "/_operator/qualify/repository";

export async function handleRepositoryLoadCheck(request: Request, env: RepositoryLoadCheckEnv, ports: RepositoryLoadPorts): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== repositoryLoadCheckPath) return undefined;
  if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  const auth = await verifyOperatorServiceRequest(request, env);
  if (!auth.ok) return Response.json({ error: auth.status === 503 ? "operator auth unconfigured" : "operator unauthorized" }, { status: auth.status });
  const revision = env.GFY_SOURCE_REVISION;
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision)) return Response.json({ error: "qualification source revision unconfigured" }, { status: 503 });
  if (request.headers.get("X-GitFoundry-Expected-Revision") !== revision) return Response.json({ error: "qualification source revision mismatch" }, { status: 409 });
  const tenantId = env.GFY_RUNNER_TENANT_ID;
  const repositoryId = env.GFY_RUNNER_REPOSITORY_ID;
  if (!tenantId || !repositoryId) return Response.json({ error: "repository load check unconfigured" }, { status: 503 });

  const result = await loadRepository(ports, tenantId, repositoryId);
  if (!result.ok) {
    console.error("gitfoundry.repository_load_check.failed", { stage: result.stage, cause: result.cause });
    return Response.json({ error: "repository_load_failed", stage: result.stage, cause: result.cause }, { status: 503 });
  }
  return Response.json({ repository_id: repositoryId, head_version_commit: result.head_version_commit, code_commit: result.code_commit, versions: result.versions, tree_entries: result.tree_entries }, { headers: { "X-GitFoundry-Source-Revision": revision } });
}

export type RepositoryLoadResult =
  | { readonly ok: true; readonly head_version_commit: string; readonly code_commit: string; readonly versions: number; readonly tree_entries: number }
  | { readonly ok: false; readonly stage: Stage; readonly cause: ForgeFailureDescription | { readonly code: "no_head_version" } };

// Reads the head, the version list, and the head's source tree, stopping at the first stage that fails.
export async function loadRepository(ports: RepositoryLoadPorts, tenantId: string, repositoryId: string): Promise<RepositoryLoadResult> {
  let stage: Stage = "head";
  try {
    const head = await ports.head(tenantId, repositoryId);
    if (!head) return { ok: false, stage, cause: { code: "no_head_version" } };
    stage = "list";
    const versions = await ports.list(tenantId, repositoryId);
    stage = "tree";
    const tree = await ports.tree(tenantId, repositoryId, head.code_commit);
    return { ok: true, head_version_commit: head.version_commit, code_commit: head.code_commit, versions: versions.length, tree_entries: tree.items.length };
  } catch (error) {
    return { ok: false, stage, cause: describeLoadFailure(error) };
  }
}

function describeLoadFailure(error: unknown): ForgeFailureDescription {
  return error instanceof SourceReadUnavailableError ? { code: error.code, reason: error.reason } : describeForgeFailure(error);
}
