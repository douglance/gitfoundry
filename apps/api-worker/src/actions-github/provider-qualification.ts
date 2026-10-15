import { verifyOperatorServiceRequest, type OperatorServiceAuthEnv } from "../auth/operator-service.js";
import type { GitHubActionsBackendDO } from "./container-worker.js";

export interface ActionsQualificationEnv extends OperatorServiceAuthEnv {
  readonly GFY_SOURCE_REVISION?: string;
  readonly GFY_ACTIONS_BACKEND_IMAGE?: string;
  readonly GFY_ACTIONS_STORAGE_GENERATION?: string;
  readonly GITHUB_ACTIONS_BACKEND?: DurableObjectNamespace<GitHubActionsBackendDO>;
  readonly GFY_ACTIONS_SQLITE_BUCKET?: R2Bucket;
}
export async function handleActionsQualification(request: Request, env: ActionsQualificationEnv): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== "/_operator/qualify/actions") return undefined;
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const auth = await verifyOperatorServiceRequest(request, env);
  if (!auth.ok) return Response.json({ error: "operator_auth_required" }, { status: auth.status });
  const revision = env.GFY_SOURCE_REVISION;
  if (!/^[0-9a-f]{40}$/.test(revision ?? "") || request.headers.get("X-GitFoundry-Expected-Revision") !== revision) {
    return Response.json({ error: "source_revision_mismatch" }, { status: 409 });
  }
  const namespace = env.GITHUB_ACTIONS_BACKEND, bucket = env.GFY_ACTIONS_SQLITE_BUCKET;
  const generation = env.GFY_ACTIONS_STORAGE_GENERATION ?? "";
  if (!namespace || !bucket || !generation) return Response.json({ error: "actions_unconfigured" }, { status: 503 });
  try {
    const stub = namespace.get(namespace.idFromName("actions-github:" + generation));
    const receipt = await stub.qualifyActionsBackend();
    if (receipt.source_revision !== revision || receipt.image !== env.GFY_ACTIONS_BACKEND_IMAGE ||
        receipt.generation !== generation || receipt.backendReady !== true || receipt.storagePointerReadable !== true ||
        receipt.durableStorageWriteRead !== true) throw new Error("Actions backend receipt mismatch");
    const key = "actions-github/qualification/" + crypto.randomUUID(), marker = crypto.randomUUID();
    try {
      await bucket.put(key, marker);
      const object = await bucket.get(key);
      if (!object || await object.text() !== marker) throw new Error("Actions snapshot bucket readback failed");
    } finally { await bucket.delete(key); }
    return Response.json({ source_revision: revision, image: receipt.image, generation,
      backendReady: true, storagePointerReadable: true, durableStorageWriteRead: true, snapshotBucketWriteRead: true,
      acceptance: { runner: "pending", restartRestore: "pending", accessOverrides: "pending" } });
  } catch { return Response.json({ error: "actions_qualification_failed" }, { status: 503 }); }
}
