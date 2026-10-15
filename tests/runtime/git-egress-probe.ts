import { WorkerEntrypoint } from "cloudflare:workers";

import { GitFoundryArtifactsEgress, type GitArtifactsEgressCapability } from "../../apps/api-worker/src/git-egress/index";

export { GitFoundryArtifactsEgress };

const namespace = "gitfoundry-staging";
const repository = "gfy.demo.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const providerHost = "artifacts.example";
const proof = "proof.gitfoundry-staging.gfy-demo.0123456789abcdef";

export default class GitEgressProbe extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const helperToken = request.headers.get("x-fixture-helper-token") ?? "";
    const capability = capabilityFor({ allowWrite: true });
    const readOnlyCapability = capabilityFor({ allowWrite: false });
    const entrypointFactory = (this.ctx.exports as Record<string, (options: { props: GitArtifactsEgressCapability }) => Fetcher>).GitFoundryArtifactsEgress;
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

    const allowedInfoRefs = await callEgress(entrypointFactory, capability, helperToken, `https://${providerHost}/git/${namespace}/${repository}.git/info/refs?service=git-upload-pack`, "GET");
    checks.push(statusCheck("ctx.exports fetcher allows upload-pack info refs", allowedInfoRefs, 200));

    const allowedUploadPack = await callEgress(entrypointFactory, capability, helperToken, `https://${providerHost}/git/${namespace}/${repository}.git/git-upload-pack`, "POST", "0032want 0000000000000000000000000000000000000000");
    checks.push(statusCheck("ctx.exports fetcher allows upload-pack rpc", allowedUploadPack, 200));

    const wrongHost = await callEgress(entrypointFactory, capability, helperToken, `https://evil.example/git/${namespace}/${repository}.git/info/refs?service=git-upload-pack`, "GET");
    checks.push(statusCheck("arbitrary host substitution is denied", wrongHost, 403));

    const wrongPath = await callEgress(entrypointFactory, capability, helperToken, `https://${providerHost}/git/${namespace}/other.git/info/refs?service=git-upload-pack`, "GET");
    checks.push(statusCheck("repository path substitution is denied", wrongPath, 404));

    const wrongProof = await callEgress(entrypointFactory, capability, helperToken, `https://${providerHost}/git/${namespace}/${repository}.git/info/refs?service=git-upload-pack`, "GET", undefined, "proof.wrong-scope.0123456789abcdef");
    checks.push(statusCheck("opaque proof mismatch is denied", wrongProof, 403));

    const missingToken = await callEgress(entrypointFactory, capability, "", `https://${providerHost}/git/${namespace}/${repository}.git/info/refs?service=git-upload-pack`, "GET");
    checks.push(statusCheck("missing helper token is denied", missingToken, 401));

    const readOnlyWrite = await callEgress(entrypointFactory, readOnlyCapability, helperToken, `https://${providerHost}/git/${namespace}/${repository}.git/git-receive-pack`, "POST", "0000");
    checks.push(statusCheck("receive-pack is denied without write capability", readOnlyWrite, 403));

    const redirect = await callEgress(entrypointFactory, capability, helperToken, `https://${providerHost}/git/${namespace}/${repository}.git/git-receive-pack`, "POST", "0000");
    checks.push(statusCheck("upstream redirect is denied", redirect, 502));
    checks.push({ name: "upstream redirect location stripped", ok: !redirect.headers.has("location") });

    const responseText = checks.map((check) => `${check.name}:${check.ok}:${check.detail ?? ""}`).join("\n");
    checks.push({ name: "probe response does not contain helper token", ok: helperToken.length > 0 && !responseText.includes(helperToken) });

    return Response.json({ ok: checks.every((check) => check.ok), ctx_exports_fetcher: true, checks });
  }
}

function capabilityFor(options: { readonly allowWrite: boolean }): GitArtifactsEgressCapability {
  return {
    allowedProviderHostname: providerHost,
    namespace,
    repository,
    artifactsRemoteUrl: `https://${providerHost}/${repository}.git`,
    opaqueProof: proof,
    allowWrite: options.allowWrite
  };
}

async function callEgress(entrypointFactory: (options: { props: GitArtifactsEgressCapability }) => Fetcher, capability: GitArtifactsEgressCapability, helperToken: string, url: string, method: "GET" | "POST", body?: string, proofOverride = proof): Promise<Response> {
  const fetcher = entrypointFactory({ props: capability });
  const headers = new Headers({ "x-gitfoundry-egress-proof": proofOverride });
  if (helperToken) headers.set("authorization", `Bearer ${helperToken}`);
  if (method === "POST") headers.set("content-type", "application/x-git-upload-pack-request");
  return fetcher.fetch(new Request(url, { method, headers, body }));
}

function statusCheck(name: string, response: Response, expected: number) {
  return { name, ok: response.status === expected, detail: response.status === expected ? undefined : `status ${response.status}` };
}
