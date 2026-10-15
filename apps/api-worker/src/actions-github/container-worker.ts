import { GitHubActionsBackendDO as ActionsBackend } from "./cloudflare.js";
import type { GitHubActionsCloudflareEnv } from "./cloudflare.js";

interface PrivateActionsEnv extends GitHubActionsCloudflareEnv {
  readonly GFY_SOURCE_REVISION?: string;
  readonly GFY_ACTIONS_BACKEND_IMAGE?: string;
}
export class GitHubActionsBackendDO extends ActionsBackend {
  private readonly qualificationState: DurableObjectState;
  private readonly qualificationEnv: PrivateActionsEnv;
  constructor(ctx: DurableObjectState, env: PrivateActionsEnv) {
    super(ctx, env);
    this.qualificationState = ctx;
    this.qualificationEnv = env;
  }
  async qualifyActionsBackend() {
    const generation = this.qualificationEnv.GFY_ACTIONS_STORAGE_GENERATION ?? "";
    const response = await this.fetch(new Request("http://container/__gitfoundry/health", { signal: AbortSignal.timeout(45_000) }));
    if (response.status !== 200) throw new Error("Actions backend readiness failed");
    const health = await response.json() as { ready?: unknown; generation?: unknown };
    if (health.ready !== true || health.generation !== generation) throw new Error("Actions backend readiness mismatch");
    await this.read(generation);
    const key = "actions-github/qualification/" + crypto.randomUUID();
    const marker = crypto.randomUUID();
    try {
      await this.qualificationState.storage.put(key, marker);
      if (await this.qualificationState.storage.get(key) !== marker) throw new Error("Actions durable storage readback failed");
    } finally { await this.qualificationState.storage.delete(key); }
    return { source_revision: this.qualificationEnv.GFY_SOURCE_REVISION, image: this.qualificationEnv.GFY_ACTIONS_BACKEND_IMAGE,
      generation, backendReady: true, storagePointerReadable: true, durableStorageWriteRead: true };
  }
}
export default { fetch() { return new Response("Not found", { status: 404 }); } };
