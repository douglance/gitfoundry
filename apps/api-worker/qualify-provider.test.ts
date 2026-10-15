import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";

import { ProviderQualificationRunnerError, runProviderQualification } from "./qualify-provider.js";

const apiUrl = "https://gitgood-api.example.workers.dev";
const clientId = "qualifier-client.access";
const clientSecretPlaintext = "secret-client-value";
const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
const staleRevision = "fedcba9876543210fedcba9876543210fedcba98";
const trustedGitHelperImage = "registry.cloudflare.com/account/gitfoundry-helper@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const untrustedCiImage = "registry.cloudflare.com/account/gitfoundry-ci@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const contentRepositoryName = "gfy.content.readme";
const contentCommitSha = "1111111111111111111111111111111111111111";
const contentSha256 = "2222222222222222222222222222222222222222222222222222222222222222";
const contentByteLength = 13;

const artifactsProof = { provider_id: "provider-123", name: "gfy.repo.abc", defaultBranch: "main", readOnly: false } as const;
const contentProof = { provider_id: "content-provider-123", name: contentRepositoryName, defaultBranch: "main", readOnly: true, commit_sha: contentCommitSha, path: "README", byte_length: contentByteLength, content_sha256: contentSha256 } as const;
const trustedLinuxProof = { profile: "trusted_git_helper", commandId: "linuxq-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", image: trustedGitHelperImage, status: "succeeded", exitCode: 0, cleanupRequired: false, version: "git version 2.50.0" } as const;
const ciProof = { profile: "untrusted_ci_job", commandId: "linuxq-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", image: untrustedCiImage, status: "succeeded", exitCode: 0, cleanupRequired: false, version: "git version 2.50.0", architecture: "x86_64", credentialsAbsent: true, publicEgressDenied: true, supervisorVersion: "gitfoundry-supervisor 0.1.0" } as const;

function input(overrides: Partial<Parameters<typeof runProviderQualification>[0]> = {}) {
  return { apiUrl, accessClientId: clientId, accessClientSecret: Redacted.make(clientSecretPlaintext), sourceRevision, trustedGitHelperImage, untrustedCiImage, contentRepositoryName, contentCommitSha, contentSha256, contentByteLength, ...overrides };
}

function withSourceRevision(body: unknown, revision = sourceRevision, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: {
      ...init.headers,
      "X-GitFoundry-Source-Revision": revision
    }
  });
}

function linuxResponseFor(body: unknown, overrides: Partial<typeof ciProof> = {}): Response {
  const profile = typeof body === "object" && body !== null && "profile" in body ? body.profile : undefined;
  if (profile === "trusted_git_helper") return withSourceRevision(trustedLinuxProof);
  if (profile === "untrusted_ci_job") return withSourceRevision({ ...ciProof, ...overrides });
  return withSourceRevision({ error: "unknown profile" }, sourceRevision, { status: 400 });
}

function qualificationResponseFor(request: RequestInfo | URL, init?: RequestInit, content: unknown = contentProof): Response {
  const url = String(request);
  const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
  if (url.endsWith("/_operator/qualify/artifacts")) return withSourceRevision(artifactsProof);
  if (url.endsWith("/_operator/qualify/artifacts-content")) return withSourceRevision(content);
  if (url.endsWith("/_operator/qualify/linux")) return linuxResponseFor(body);
  return withSourceRevision({ error: "not found" }, sourceRevision, { status: 404 });
}

describe("provider qualification runner", () => {
  it("posts the fixed qualification bodies with service-token and source-revision headers and returns only sanitized proof", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
    const fetcher = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(request), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) as unknown });
      return qualificationResponseFor(request, init);
    };

    const proof = await runProviderQualification(input(), { fetch: fetcher });

    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.url)).toEqual([
      apiUrl + "/_operator/qualify/artifacts",
      apiUrl + "/_operator/qualify/artifacts-content",
      apiUrl + "/_operator/qualify/linux",
      apiUrl + "/_operator/qualify/linux"
    ]);
    expect(calls.map((call) => call.body)).toEqual([{ create: true }, {}, { profile: "trusted_git_helper" }, { profile: "untrusted_ci_job" }]);
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(call.init.method).toBe("POST");
      expect(call.init.redirect).toBe("manual");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("CF-Access-Client-Id")).toBe(clientId);
      expect(headers.get("CF-Access-Client-Secret")).toBe(clientSecretPlaintext);
      expect(headers.get("X-GitFoundry-Operator-Client-Id")).toBe(clientId);
      expect(headers.get("X-GitFoundry-Operator-Secret")).toBe(clientSecretPlaintext);
      expect(headers.get("X-GitFoundry-Expected-Revision")).toBe(sourceRevision);
    }
    expect(proof).toEqual({
      artifacts: artifactsProof,
      content: contentProof,
      linux: trustedLinuxProof,
      ci: ciProof,
      images: { trustedGitHelper: trustedGitHelperImage, untrustedCi: untrustedCiImage }
    });
    expect(JSON.stringify(proof)).not.toContain(clientSecretPlaintext);
  });

  it("rejects invalid source revisions before making any request", async () => {
    for (const invalid of ["", "0123456789abcdef0123456789abcdef0123456", "0123456789abcdef0123456789abcdef012345678", "0123456789abcdef0123456789abcdef0123456A", "0123456789abcdef0123456789abcdef0123456g"]) {
      let calls = 0;
      const error = await runProviderQualification(input({ sourceRevision: invalid }), { fetch: async () => { calls += 1; return withSourceRevision(artifactsProof); } }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderQualificationRunnerError);
      expect(error).toMatchObject({ code: "invalid_input", route: "source" });
      expect(calls).toBe(0);
    }
  });

  it("rejects invalid content expectations before making any request", async () => {
    const invalidInputs = [
      { contentRepositoryName: "" },
      { contentRepositoryName: "https://token.example/repo" },
      { contentCommitSha: "111111111111111111111111111111111111111" },
      { contentCommitSha: "111111111111111111111111111111111111111g" },
      { contentSha256: "222222222222222222222222222222222222222222222222222222222222222" },
      { contentSha256: "222222222222222222222222222222222222222222222222222222222222222G" },
      { contentByteLength: -1 },
      { contentByteLength: 1.5 }
    ];

    for (const invalid of invalidInputs) {
      let calls = 0;
      const error = await runProviderQualification(input(invalid), { fetch: async () => { calls += 1; return withSourceRevision(artifactsProof); } }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderQualificationRunnerError);
      expect(error).toMatchObject({ code: "invalid_input", route: "content" });
      expect(calls).toBe(0);
      expect(String(error)).not.toContain(clientSecretPlaintext);
    }
  });

  it("retries missing or stale response source markers and fails without copying secrets or revisions", async () => {
    for (const response of [Response.json(artifactsProof), withSourceRevision(artifactsProof, staleRevision)]) {
      let calls = 0;
      const error = await runProviderQualification(input(), {
        maxAttempts: 2,
        retryDelayMs: 0,
        fetch: async () => { calls += 1; return response.clone(); }
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderQualificationRunnerError);
      expect(error).toMatchObject({ code: "revision_mismatch", route: "/_operator/qualify/artifacts" });
      expect(calls).toBe(2);
      expect(String(error)).not.toContain(clientSecretPlaintext);
      expect(String(error)).not.toContain(sourceRevision);
      expect(String(error)).not.toContain(staleRevision);
      expect(JSON.stringify(error)).not.toContain(clientSecretPlaintext);
      expect(JSON.stringify(error)).not.toContain(sourceRevision);
      expect(JSON.stringify(error)).not.toContain(staleRevision);
    }
  });

  it("retries source-fence conflicts but reports a fixed revision mismatch after exhaustion", async () => {
    let calls = 0;
    const error = await runProviderQualification(input(), {
      maxAttempts: 2,
      retryDelayMs: 0,
      fetch: async () => { calls += 1; return withSourceRevision({ error: "source mismatch", detail: clientSecretPlaintext, current: staleRevision }, staleRevision, { status: 409 }); }
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderQualificationRunnerError);
    expect(error).toMatchObject({ code: "revision_mismatch", route: "/_operator/qualify/artifacts" });
    expect(calls).toBe(2);
    expect(String(error)).not.toContain(clientSecretPlaintext);
    expect(String(error)).not.toContain(staleRevision);
    expect(JSON.stringify(error)).not.toContain(clientSecretPlaintext);
    expect(JSON.stringify(error)).not.toContain(staleRevision);
  });

  it("rejects Access redirects instead of following or treating them as proof", async () => {
    await expect(runProviderQualification(input(), { fetch: async () => new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } }), maxAttempts: 1 })).rejects.toMatchObject({ code: "redirect" });
  });

  it("retries Access redirects and transient auth statuses without following redirects", async () => {
    let attempts = 0;
    const proof = await runProviderQualification(input(), {
      maxAttempts: 3,
      retryDelayMs: 0,
      fetch: async (request, init) => {
        attempts += 1;
        if (attempts === 1) return new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } });
        if (attempts === 2) return withSourceRevision({ error: "operator unauthorized" }, sourceRevision, { status: 401 });
        return qualificationResponseFor(request, init);
      }
    });

    expect(attempts).toBe(6);
    expect(proof.content.path).toBe("README");
    expect(proof.linux.status).toBe("succeeded");
    expect(proof.ci.status).toBe("succeeded");
  });

  it("retries qualification routes that are not yet visible after upload, but stops at the configured limit", async () => {
    let calls = 0;
    const proof = await runProviderQualification(input(), { maxAttempts: 3, retryDelayMs: 0, fetch: async (url, init) => {
      calls += 1;
      if (calls === 1 || calls === 3 || calls === 5 || calls === 7) return withSourceRevision({ error: "not found" }, sourceRevision, { status: 404 });
      return qualificationResponseFor(url, init);
    } });
    expect(calls).toBe(8);
    expect(proof.content.readOnly).toBe(true);
    expect(proof.linux.cleanupRequired).toBe(false);
    expect(proof.ci.cleanupRequired).toBe(false);
    calls = 0;
    await expect(runProviderQualification(input(), { maxAttempts: 3, retryDelayMs: 0, fetch: async () => {
      calls += 1;
      return withSourceRevision({ error: "not found" }, sourceRevision, { status: 404 });
    } })).rejects.toMatchObject({ code: "http_status", route: "/_operator/qualify/artifacts" });
    expect(calls).toBe(3);
  });

  it("identifies a non-JSON successful response by fixed route and bounded content type", async () => {
    const error = await runProviderQualification(input(), { fetch: async () => new Response("<html>" + clientSecretPlaintext + "</html>", { headers: { "content-type": "text/html; charset=utf-8", "X-GitFoundry-Source-Revision": sourceRevision } }) }).catch((caught: unknown) => caught);
    expect(String(error)).toContain("/_operator/qualify/artifacts");
    expect(String(error)).toContain("response=html");
    expect(String(error)).not.toContain(clientSecretPlaintext);
  });

  it("reports only fixed failed schema fields, never values or unexpected property names", async () => {
    const error = await runProviderQualification(input(), { fetch: async () => withSourceRevision({ provider_id: "provider-123", name: "gfy.repo.abc", defaultBranch: "main", readOnly: false, [clientSecretPlaintext]: clientSecretPlaintext }) }).catch((caught: unknown) => caught);
    expect(String(error)).toContain("/_operator/qualify/artifacts");
    expect(String(error)).toContain("schema=keys");
    expect(String(error)).not.toContain(clientSecretPlaintext);
  });

  it("rejects non-exact response shapes before persisting provider data", async () => {
    const fetcher = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(request).endsWith("/_operator/qualify/artifacts")) {
        return withSourceRevision({ ...artifactsProof, remote: "https://token:" + clientSecretPlaintext + "@example.test/repo.git" });
      }
      return qualificationResponseFor(request, init);
    };

    await expect(runProviderQualification(input(), { fetch: fetcher })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects content proof mismatch, unsafe provider IDs, and extra fields", async () => {
    for (const invalidContentProof of [
      { ...contentProof, name: "gfy.content.other" },
      { ...contentProof, defaultBranch: "master" },
      { ...contentProof, readOnly: false },
      { ...contentProof, commit_sha: "3333333333333333333333333333333333333333" },
      { ...contentProof, byte_length: contentByteLength + 1 },
      { ...contentProof, content_sha256: "4444444444444444444444444444444444444444444444444444444444444444" },
      { ...contentProof, path: "README.md" },
      { ...contentProof, provider_id: "https://provider.example" },
      { ...contentProof, raw_content: "hello world\n!!", [clientSecretPlaintext]: clientSecretPlaintext }
    ]) {
      const error = await runProviderQualification(input(), { fetch: async (request, init) => qualificationResponseFor(request, init, invalidContentProof) }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderQualificationRunnerError);
      expect(error).toMatchObject({ code: "invalid_response", route: "/_operator/qualify/artifacts-content" });
      expect(String(error)).not.toContain(clientSecretPlaintext);
      expect(JSON.stringify(error)).not.toContain(clientSecretPlaintext);
      expect(String(error)).not.toContain("raw_content");
      expect(String(error)).not.toContain("hello world");
    }
  });

  it("rejects CI proof mismatch and false guard fields", async () => {
    for (const invalidCiProof of [
      { ...ciProof, image: trustedGitHelperImage, publicEgressDenied: false },
      { ...ciProof, credentialsAbsent: false },
      { ...ciProof, supervisorVersion: "gitfoundry-supervise 0.1.0" },
      { ...ciProof, architecture: "arm64", [clientSecretPlaintext]: clientSecretPlaintext }
    ]) {
      const error = await runProviderQualification(input(), { fetch: async (request, init) => {
        if (String(request).endsWith("/_operator/qualify/artifacts")) return withSourceRevision(artifactsProof);
        if (String(request).endsWith("/_operator/qualify/artifacts-content")) return withSourceRevision(contentProof);
        const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
        if (typeof body === "object" && body !== null && "profile" in body && body.profile === "trusted_git_helper") return withSourceRevision(trustedLinuxProof);
        return withSourceRevision(invalidCiProof);
      } }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderQualificationRunnerError);
      expect(error).toMatchObject({ code: "invalid_response", route: "/_operator/qualify/linux" });
      expect(String(error)).not.toContain(clientSecretPlaintext);
      expect(JSON.stringify(error)).not.toContain(clientSecretPlaintext);
    }
  });

  it("sanitizes transport failures so secrets cannot escape through errors", async () => {
    const error = await runProviderQualification(input(), { fetch: async () => { throw new Error("transport leaked " + clientSecretPlaintext) } }).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ProviderQualificationRunnerError);
    expect(JSON.stringify(error)).not.toContain(clientSecretPlaintext);
    expect(String(error)).not.toContain(clientSecretPlaintext);
  });

  it("reports a bounded authentication response category without copying secrets", async () => {
    for (const [response, category] of [
      [withSourceRevision({ error: "operator unauthorized", detail: clientSecretPlaintext }, sourceRevision, { status: 401 }), "operator_auth"],
      [new Response(clientSecretPlaintext, { status: 401, headers: { "content-type": "text/html", "X-GitFoundry-Source-Revision": sourceRevision } }), "html"]
    ] as const) {
      const error = await runProviderQualification(input(), { fetch: async () => response.clone() }).catch((caught: unknown) => caught);
      expect(String(error)).toContain("response=" + category);
      expect(String(error)).not.toContain(clientSecretPlaintext);
      expect(JSON.stringify(error)).not.toContain(clientSecretPlaintext);
    }
  });

  it("reports only whitelisted content failure stages", async () => {
    for (const stage of ["readback", "import", "capability", "bootstrap", "identity", "log", "file", "digest", clientSecretPlaintext]) {
      const error = await runProviderQualification(input(), { fetch: async (request, init) => {
        if (String(request).endsWith("/artifacts-content")) return withSourceRevision({ error: "content qualification failed", stage, detail: clientSecretPlaintext }, sourceRevision, { status: 502 });
        return qualificationResponseFor(request, init);
      } }).catch((caught: unknown) => caught);
      expect(String(error)).toContain("response=" + (stage === clientSecretPlaintext ? "json" : "content:" + stage));
      expect(String(error)).not.toContain(clientSecretPlaintext);
      expect(JSON.stringify(error)).not.toContain(clientSecretPlaintext);
    }
  });

  it("reports only sanitized Linux failure detail from the fixed qualification path", async () => {
    const error = await runProviderQualification(input(), { fetch: async (request, init) => {
      if (String(request).endsWith("/artifacts")) return withSourceRevision(artifactsProof);
      if (String(request).endsWith("/artifacts-content")) return withSourceRevision(contentProof);
      const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
      if (typeof body === "object" && body !== null && "profile" in body && body.profile === "trusted_git_helper") return withSourceRevision(trustedLinuxProof);
      return withSourceRevision({ error: "linux qualification failed", failure_code: "gfy_linux_execution_failed", diagnostic: "native exec unavailable " + clientSecretPlaintext }, sourceRevision, { status: 502 });
    } }).catch((caught: unknown) => caught);
    expect(String(error)).toContain("gfy_linux_execution_failed");
    expect(String(error)).toContain("native exec unavailable");
    expect(String(error)).not.toContain(clientSecretPlaintext);
  });
});
