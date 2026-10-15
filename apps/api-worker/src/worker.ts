import { handleHostedActions, type HostedActionsEnv } from "./owner-actions/hosted.js";
import { handleProviderQualification, type ProviderQualificationEnv } from "./auth/provider-qualification.js";
import { handleActionsQualification, type ActionsQualificationEnv } from "./actions-github/provider-qualification.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import api, { fetchAgentApi, runScheduledSiteCheck, authorizeGitTransportRequest, authenticateHostedActionOwner, type Env as ApiEnv } from "./index.js";
import { makeArtifactsForgeGitFactory } from "./fork-forge/cloud-git.js";
import { verifyPublicationEvidence } from "./fork-forge/evidence.js";
import { makeReviewSigningCallback } from "./fork-forge/review-signing.js";
import { handleGitTransportRequest } from "./git-transport/index.js";
import { handleGitHubActions } from "./actions-github/index.js";
import { cloudflareGitHubActionsPorts, type GitHubActionsCloudflareEnv } from "./actions-github/cloudflare.js";
import { handleGitHubWorkflowRequest } from "./actions-github/http.js";
import { makeGitHubWorkflowWorkerPorts, type GitHubWorkflowWorkerEnv } from "./actions-github/worker-ports.js";

export class AgentApi extends WorkerEntrypoint<WorkerEnv> {
  async fetch(request: Request): Promise<Response> { return fetchAgentApi(request, withForgeBackend(this.env)); }
}
export { PrEligibilityDO } from "./pr-eligibility/coordinator.js";
export { GitFoundryArtifactsEgress } from "./git-egress/index.js";
export { TrustedGitHelperDO, UntrustedCiJobDO } from "./linux/execution.js";
export { GitHubActionsBackendDO } from "./actions-github/cloudflare.js";

interface LinuxContainerEnv {
  readonly GFY_QUALIFIER_CLIENT_ID?: string;
  readonly GFY_TRUSTED_GIT_HELPER_IMAGE?: string;
  readonly GFY_UNTRUSTED_CI_IMAGE?: string;
  readonly TRUSTED_GIT_HELPER?: DurableObjectNamespace;
  readonly GFY_FORGE_TRUSTED_KEYS?: string;
  readonly GFY_FORGE_REVIEW_SIGNING_KEY?: string;
  readonly GFY_FORGE_REVIEW_KEY_ID?: string;
}

type WorkerEnv = ApiEnv & ProviderQualificationEnv & ActionsQualificationEnv & LinuxContainerEnv & HostedActionsEnv & GitHubActionsCloudflareEnv & GitHubWorkflowWorkerEnv;

type ApiFetch = (request: Request, env: WorkerEnv, ctx: ExecutionContext) => Response | Promise<Response>;
const apiFetch = api.fetch as ApiFetch;

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const qualification = await handleProviderQualification(request, env);
    if (qualification) return qualification;
    const actionsQualification = await handleActionsQualification(request, env);
    if (actionsQualification) return actionsQualification;
    const workflow = await handleGitHubWorkflowRequest(request, makeGitHubWorkflowWorkerPorts(env, {
      authenticateOwner: (incoming, tenantId, capability) => authenticateHostedActionOwner(incoming, env, tenantId, capability),
      fetchApi: (incoming, forgeEnv) => apiFetch(incoming, forgeEnv as WorkerEnv, ctx),
      forgeEnv: () => withForgeBackend(env)
    })).catch(() => Response.json({ error: "workflow_unavailable" }, { status: 503 }));
    if (workflow) return workflow;
    const actions = await handleGitHubActions(request, env, cloudflareGitHubActionsPorts(env, input =>
      authenticateHostedActionOwner(input.request, env, input.tenant_id, input.capability)
    )).catch(() => Response.json({ error: "actions_unavailable" }, { status: 503 }));
    if (actions) return actions;
    const hosted = await handleHostedActions(request, withForgeBackend(env));
    if (hosted) return hosted;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/git/") && (url.pathname.endsWith("/git-receive-pack") || url.pathname.endsWith("/info/refs") && url.searchParams.get("service") === "git-receive-pack")) return new Response("Canonical forge writes require conditional publication.", { status: 403 });
    const git = await handleGitTransportRequest(request, env, {
      authorize: (incoming, tenantId, capability) => authorizeGitTransportRequest(incoming, env, tenantId, capability),
      waitUntil: (promise) => ctx.waitUntil(promise)
    });
    return git ?? apiFetch(request, withForgeBackend(env), ctx);
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledSiteCheck(withForgeBackend(env), new Date(controller.scheduledTime)));
  }
} satisfies ExportedHandler<WorkerEnv>;

function withForgeBackend(env: WorkerEnv): WorkerEnv {
  const factory = env.GFY_FORGE_GIT ?? makeArtifactsForgeGitFactory({ ...env, ...(env.TRUSTED_GIT_HELPER ? { GFY_TRUSTED_GIT_HELPER: { idFromName: (name: string) => name, get: (name: unknown) => { if (typeof name !== "string") throw new Error("Invalid helper scope"); return env.TRUSTED_GIT_HELPER!.get(env.TRUSTED_GIT_HELPER!.idFromName(name)); } } } : {}) }, { directReads: { fetch: (request) => fetch(request) } });
  const reviewSigner = env.GFY_FORGE_SIGN_REVIEW ?? makeReviewSigningCallback({ gitFactory: factory, ...(env.GFY_FORGE_REVIEW_KEY_ID ? { keyId: env.GFY_FORGE_REVIEW_KEY_ID } : {}), ...(env.GFY_FORGE_REVIEW_SIGNING_KEY ? { signingKeyJwk: env.GFY_FORGE_REVIEW_SIGNING_KEY } : {}) });
  let trustedKeys: Record<string, JsonWebKey> | undefined;
  if (env.GFY_FORGE_TRUSTED_KEYS) {
    try {
      const value: unknown = JSON.parse(env.GFY_FORGE_TRUSTED_KEYS);
      if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) trustedKeys = value as Record<string, JsonWebKey>;
    } catch { /* Unconfigured trust must fail closed before publication. */ }
  }
  return {
    ...env,
    GFY_FORK_ONLY: true,
    GFY_FORGE_GIT: factory,
    ...(reviewSigner ? { GFY_FORGE_SIGN_REVIEW: reviewSigner } : {}),
    ...(env.GFY_FORGE_VERIFY_EVIDENCE ? {} : trustedKeys ? {
      GFY_FORGE_VERIFY_EVIDENCE: async (context) => {
        const git = typeof factory === "function" ? await factory({ tenantId: context.tenant_id, repositoryId: context.repository_id }) : factory;
        if (!git) throw new Error("Trusted forge Git backend unavailable");
        await verifyPublicationEvidence({ git, trustedKeys: trustedKeys!, context, clock: () => env.clock?.now() ?? new Date() });
      }
    } : {})
  };
}
