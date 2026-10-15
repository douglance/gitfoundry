import { Effect } from "effect";

import type { D1DatabaseLike } from "../../../packages/core/src/live/index.js";
import { GitReferenceUnavailableError, type QualifiedGitReadPort } from "../../../packages/core/src/live/forge.js";
import type { ArtifactsBinding, ArtifactsRepoHandle } from "./git-provider.js";

export interface D1ArtifactsGitReadOptions {
  readonly namespace: string;
}

interface RepositoryArtifactRow {
  readonly artifacts_namespace: string | null;
  readonly artifacts_name: string | null;
}

interface SelectedArtifactsRepository {
  readonly name: string;
}

const providerRepositoryNamePattern = /^[A-Za-z0-9_.-]{1,255}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const refPattern = /^[^\0\r\n]{1,1024}$/;

export function makeD1ArtifactsGitRead(db: D1DatabaseLike, binding: ArtifactsBinding | undefined, options: D1ArtifactsGitReadOptions): QualifiedGitReadPort {
  return {
    resolveRef: (input) => Effect.tryPromise({
      try: async () => {
        assertResolvableRef(input.repositoryId, input.ref);
        const selected = await selectRepositoryArtifacts(db, input.tenantId, input.repositoryId, input.ref, options.namespace);
        const repo = await getRepositoryCapability(binding, selected.name, input.repositoryId, input.ref);
        try {
          await assertProviderIdentity(repo, selected.name, input.repositoryId, input.ref);
          const history = await readHistory(repo, input.ref, input.repositoryId);
          const head = history[0] as { readonly hash?: unknown } | undefined;
          if (!head || typeof head.hash !== "string" || !shaPattern.test(head.hash)) throw unavailable(input.repositoryId, input.ref, "reference unavailable");
          return { sha: head.hash };
        } catch (error) {
          if (error instanceof GitReferenceUnavailableError) throw error;
          throw unavailable(input.repositoryId, input.ref, "provider unavailable");
        } finally {
          disposeRepo(repo);
        }
      },
      catch: (error) => error instanceof GitReferenceUnavailableError ? error : unavailable(input.repositoryId, input.ref, "provider unavailable")
    })
  };
}

async function selectRepositoryArtifacts(db: D1DatabaseLike, tenantId: string, repositoryId: string, ref: string, configuredNamespace: string): Promise<SelectedArtifactsRepository> {
  const row = await db.prepare("SELECT artifacts_namespace, artifacts_name FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, repositoryId).first<RepositoryArtifactRow>();
  if (!row) throw unavailable(repositoryId, ref, "repository unavailable");
  if (row.artifacts_namespace !== configuredNamespace) throw unavailable(repositoryId, ref, "repository namespace unavailable");
  if (typeof row.artifacts_name !== "string" || !providerRepositoryNamePattern.test(row.artifacts_name)) throw unavailable(repositoryId, ref, "repository identity unavailable");
  return { name: row.artifacts_name };
}

async function getRepositoryCapability(binding: ArtifactsBinding | undefined, name: string, repositoryId: string, ref: string): Promise<ArtifactsRepoHandle> {
  if (!binding) throw unavailable(repositoryId, ref, "provider unavailable");
  try {
    return await binding.get(name);
  } catch {
    throw unavailable(repositoryId, ref, "provider unavailable");
  }
}

async function assertProviderIdentity(repo: ArtifactsRepoHandle, expectedName: string, repositoryId: string, ref: string): Promise<void> {
  const info = await repo.info();
  if (info.name !== expectedName || !providerRepositoryNamePattern.test(info.name)) throw unavailable(repositoryId, ref, "repository identity unavailable");
  if (typeof repo.log !== "function") throw unavailable(repositoryId, ref, "provider capability unavailable");
}

async function readHistory(repo: ArtifactsRepoHandle, ref: string, repositoryId: string): Promise<readonly ArtifactsCommitMetadata[]> {
  if (typeof repo.log !== "function") throw unavailable(repositoryId, ref, "provider capability unavailable");
  const history = await repo.log({ ref, limit: 1 });
  return Array.isArray(history) ? history : [];
}

function assertResolvableRef(repositoryId: string, ref: string): void {
  if (!refPattern.test(ref)) throw unavailable(repositoryId, ref, "reference unavailable");
}

function unavailable(repositoryId: string, ref: string, reason: string): GitReferenceUnavailableError {
  return new GitReferenceUnavailableError({ reason, repositoryId, ref });
}

function disposeRepo(repo: ArtifactsRepoHandle): void {
  const disposable = repo as Partial<Record<typeof Symbol.dispose, () => void>>;
  disposable[Symbol.dispose]?.();
}
