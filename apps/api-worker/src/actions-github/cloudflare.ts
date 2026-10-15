import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { makeActionsBackend, type ActionsBackend } from "./backend.js";
import { makeActionsSnapshotCoordinator, type SnapshotCommit } from "./coordinator.js";
import type { GitHubActionsEnv, GitHubActionsPorts } from "./index.js";

export interface GitHubActionsCloudflareEnv extends GitHubActionsEnv {
  readonly GITHUB_ACTIONS_BACKEND?: DurableObjectNamespace<GitHubActionsBackendDO>;
  readonly GFY_ACTIONS_RSA_PRIVATE_KEY?: string;
  readonly GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_ID?: string;
  readonly GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_SECRET?: string;
}

export class GitHubActionsBackendDO extends DurableObject<GitHubActionsCloudflareEnv> {
  private readonly snapshots;
  private readonly backend: ActionsBackend | undefined;

  constructor(ctx: DurableObjectState, env: GitHubActionsCloudflareEnv) {
    super(ctx, env);
    const generation = env.GFY_ACTIONS_STORAGE_GENERATION ?? "";
    this.snapshots = makeActionsSnapshotCoordinator(ctx.storage, generation);
    const container = ctx.container;
    this.backend = container ? makeActionsBackend({
      get running() { return container.running; },
      start: options => container.start(options),
      fetch: request => container.getTcpPort(80).fetch(request)
    }, {
      generation,
      publicOrigin: env.GFY_ACTIONS_PUBLIC_ORIGIN ?? "",
      runnerToken: env.GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN ?? "",
      storageToken: env.GFY_ACTIONS_INTERNAL_STORAGE_SECRET ?? env.GFY_ACTIONS_STORAGE_TOKEN ?? "",
      rsaPrivateKey: env.GFY_ACTIONS_RSA_PRIVATE_KEY ?? "",
      ...(env.GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_ID ? { storageAccessClientId: env.GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_ID } : {}),
      ...(env.GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_SECRET ? { storageAccessClientSecret: env.GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_SECRET } : {})
    }) : undefined;
  }

  read(generation: string) {
    return Effect.runPromise(this.snapshots.read(generation));
  }

  commit(input: SnapshotCommit) {
    return Effect.runPromise(this.snapshots.commit(input));
  }

  fetch(request: Request): Promise<Response> {
    if (!this.backend) return Promise.resolve(Response.json({ error: "actions_container_unavailable" }, { status: 503 }));
    // Startup may call this object's snapshot RPCs through the Worker. It must
    // not hold blockConcurrencyWhile or a request-wide lock while restoring.
    return Effect.runPromise(this.backend.fetch(request).pipe(Effect.match({
      onFailure: failure => Response.json({ error: "actions_backend_unavailable", operation: failure.operation }, { status: 503 }),
      onSuccess: response => response
    })), { signal: request.signal });
  }
}

export function cloudflareGitHubActionsPorts(
  env: GitHubActionsCloudflareEnv,
  authenticateOwner: GitHubActionsPorts["authenticateOwner"]
): GitHubActionsPorts {
  const namespace = env.GITHUB_ACTIONS_BACKEND;
  if (!namespace) return { authenticateOwner };
  const stub = namespace.get(namespace.idFromName(`actions-github:${env.GFY_ACTIONS_STORAGE_GENERATION ?? ""}`));
  return {
    authenticateOwner,
    proxyUpstream: request => stub.fetch(request),
    storagePointer: {
      read: generation => stub.read(generation),
      commit: input => stub.commit(input)
    }
  };
}
