import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { handleGitArtifactsEgressRequest } = await import("./index.js");

const capability = {
  allowedProviderHostname: "account.artifacts.cloudflare.net",
  namespace: "gitfoundry-production",
  repository: "repo-a",
  artifactsRemoteUrl: "https://account.artifacts.cloudflare.net/git/gitfoundry-production/repo-a.git",
  opaqueProof: "proof-0123456789abcdef",
  allowWrite: true
};

describe("Artifacts egress broker", () => {
  // October 12, 2026: Git gzips fetch negotiations over 1 KB; the broker dropped Content-Encoding and Artifacts answered 500.
  it("forwards a compressed fetch negotiation with its content encoding", async () => {
    const sent: Request[] = [];
    const body = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const response = await handleGitArtifactsEgressRequest(new Request("https://account.artifacts.cloudflare.net/git/gitfoundry-production/repo-a.git/git-upload-pack", {
      method: "POST",
      headers: { authorization: "Basic dG9rZW4=", "content-type": "application/x-git-upload-pack-request", "content-encoding": "gzip", "x-gitfoundry-egress-proof": capability.opaqueProof },
      body
    }), capability, async (input) => { sent.push(input as Request); return new Response("ok") });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(await sent[0]!.arrayBuffer())).toEqual(body);
  });
});
