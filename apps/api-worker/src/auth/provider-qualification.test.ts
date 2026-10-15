import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { artifactsRepositoryIdentity, type ArtifactsBinding, type WorkersArtifactsCreateRepoResult, type WorkersArtifactsCreateTokenResult, type WorkersArtifactsRepoInfo } from "../git-provider.js";
import { handleProviderQualification, providerQualificationRepositoryInput, type ProviderQualificationEnv, providerContentQualificationRepositoryInput } from "./provider-qualification.js";

type Jwk = JsonWebKey & { kid: string; alg: string };

const now = new Date("2026-10-08T00:00:00.000Z");
const issuer = "https://team.cloudflareaccess.com";
const audience = "operator-qualifier-app";
const clientId = "qualifier-client.access";
const sourceRevision = "a".repeat(40);
const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
const providerNamespace = "gitfoundry-staging";
const imageDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const trustedLinuxImage = `registry.example/gitfoundry-helper@sha256:${imageDigest}`;
const untrustedCiImage = `registry.example/gitfoundry-ci@sha256:${imageDigest}`;
const bootstrapSecret = "bootstrap-secret-token";
const helperSecret = "helper-secret-token";
const querySecret = "query-secret";
const fragmentSecret = "fragment-secret";

describe("operator Artifacts provider qualification handler", () => {
  it("rejects missing or stale source revisions before provider or Linux effects", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const artifacts = new FakeArtifacts();
    const linux = new FakeLinuxNamespace();
    const env = envFor(keys.publicJwk, artifacts, linux);
    for (const makeRequest of [() => requestWith(token, { create: true }), () => linuxRequestWith(token, {}), () => contentRequestWith(token, {})]) {
      const request = makeRequest();
      request.headers.delete("X-GitFoundry-Expected-Revision");
      await expectJson(await handleProviderQualification(new Request(request.url, { method: "POST", headers: request.headers, body: "{}" }), env), 409, { error: "qualification source revision mismatch" });
      request.headers.set("X-GitFoundry-Expected-Revision", "b".repeat(40));
      await expectJson(await handleProviderQualification(new Request(request.url, { method: "POST", headers: request.headers, body: "{}" }), env), 409, { error: "qualification source revision mismatch" });
      request.headers.set("X-GitFoundry-Expected-Revision", sourceRevision);
      for (const configured of [undefined, "invalid"]) {
        await expectJson(await handleProviderQualification(new Request(request.url, { method: "POST", headers: request.headers, body: "{}" }), { ...env, GFY_SOURCE_REVISION: configured ?? "" }), 503, { error: "qualification source revision unconfigured" });
      }
    }
    expect(artifacts.createCalls).toEqual([]);
    expect(artifacts.getCalls).toEqual([]);
    expect(linux.stub.fetchCalls).toEqual([]);
  });

  it("imports fixed read-only content, revokes bootstrap token, and reports independently observed bytes", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const artifacts = new FakeContentArtifacts();
    const identity = artifactsRepositoryIdentity(providerContentQualificationRepositoryInput, providerNamespace);
    const response = await handleProviderQualification(contentRequestWith(token, {}), envFor(keys.publicJwk, artifacts));
    const body = await expectJson(response, 200, {
      provider_id: "provider-" + identity.name, name: identity.name, defaultBranch: "main", readOnly: true,
      commit_sha: "a".repeat(40), path: "README", byte_length: 13,
      content_sha256: "03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340"
    });
    expect(Object.keys(body).sort()).toEqual(["byte_length", "commit_sha", "content_sha256", "defaultBranch", "name", "path", "provider_id", "readOnly"]);
    expect(response?.headers.get("X-GitFoundry-Source-Revision")).toBe(sourceRevision);
    expect(artifacts.importCalls).toEqual([{ source: { url: "https://github.com/octocat/Hello-World.git", branch: "master", depth: 1 }, target: { name: identity.name, opts: { readOnly: true } } }]);
    expect(artifacts.contentRepo?.revokedTokens).toEqual([bootstrapSecret]);
    expect(artifacts.contentRepo?.disposed).toBe(true);
    expect(JSON.stringify(body)).not.toContain(bootstrapSecret);
    if (!artifacts.contentRepo) throw new Error("content fixture missing");
    artifacts.contentRepo.hash = "b".repeat(40);
    const replay = await expectJson(await handleProviderQualification(contentRequestWith(token, {}), envFor(keys.publicJwk, artifacts)), 200, { commit_sha: "b".repeat(40) });
    expect(replay.commit_sha).not.toBe("7fd1a60b01f91b314f59955a4e4d4e80d8edf11d");
    expect(artifacts.importCalls).toHaveLength(1);
  });

  it("rejects content caller fields and writable fixture repositories", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const artifacts = new FakeContentArtifacts();
    await expectJson(await handleProviderQualification(contentRequestWith(token, { create: true }), envFor(keys.publicJwk, artifacts)), 400, { error: "invalid qualification request" });
    expect(artifacts.importCalls).toEqual([]);
    await handleProviderQualification(contentRequestWith(token, {}), envFor(keys.publicJwk, artifacts));
    if (!artifacts.contentRepo) throw new Error("content fixture missing");
    artifacts.contentRepo.infoValue.readOnly = false;
    await expectJson(await handleProviderQualification(contentRequestWith(token, {}), envFor(keys.publicJwk, artifacts)), 502, { error: "content qualification failed" });
  });

  it("reports fixed content stages without exposing provider exception text", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const artifacts = new FakeContentArtifacts();
    await handleProviderQualification(contentRequestWith(token, {}), envFor(keys.publicJwk, artifacts));
    const repo = artifacts.contentRepo;
    if (!repo) throw new Error("content fixture missing");
    repo.hash = "invalid-commit-" + bootstrapSecret;
    const unresolved = await expectJson(await handleProviderQualification(contentRequestWith(token, {}), envFor(keys.publicJwk, artifacts)), 502, { error: "content qualification failed", stage: "log" });
    expect(JSON.stringify(unresolved)).not.toContain(bootstrapSecret);
    repo.hash = "a".repeat(40);
    repo.readFile = async () => { throw new Error(bootstrapSecret) };
    const failedRead = await expectJson(await handleProviderQualification(contentRequestWith(token, {}), envFor(keys.publicJwk, artifacts)), 502, { error: "content qualification failed", stage: "file" });
    expect(JSON.stringify(failedRead)).not.toContain(bootstrapSecret);
  });

  it("only reserves the operator qualification route and fails closed without Artifacts configuration", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());

    await expect(handleProviderQualification(new Request("https://gitfoundry.test/other"), envFor(keys.publicJwk))).resolves.toBeUndefined();

    const deniedMethod = await handleProviderQualification(new Request("https://gitfoundry.test/_operator/qualify/artifacts", { method: "GET" }), envFor(keys.publicJwk));
    expect(deniedMethod?.status).toBe(405);

    const missingConfig = await handleProviderQualification(requestWith(token, { create: false }), envFor(keys.publicJwk));
    await expectJson(missingConfig, 503, { error: "provider qualification unconfigured" });

    const r2LikeBinding = { get: async () => null, list: async () => ({ objects: [] }), put: async () => null };
    const wrongBinding = await handleProviderQualification(requestWith(token, { create: true }), { ...envFor(keys.publicJwk), GFY_GIT: r2LikeBinding });
    await expectJson(wrongBinding, 503, { error: "provider qualification unconfigured" });
  });

  it("rejects unknown and oversized request bodies before provider writes", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const artifacts = new FakeArtifacts();
    const env = envFor(keys.publicJwk, artifacts);

    const unknown = await handleProviderQualification(requestWith(token, { create: true, tenant_id: "caller-controlled" }), env);
    await expectJson(unknown, 400, { error: "invalid qualification request" });

    const oversized = await handleProviderQualification(requestWithRaw(token, JSON.stringify({ create: false, padding: "😀".repeat(300) })), env);
    await expectJson(oversized, 413, { error: "request body too large" });

    expect(artifacts.createCalls).toEqual([]);
    expect(artifacts.getCalls).toEqual([]);
  });

  it("creates the fixed qualification repository, validates readback, revokes bootstrap token, and returns only redacted fields", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const artifacts = new FakeArtifacts();
    const env = envFor(keys.publicJwk, artifacts);
    const identity = artifactsRepositoryIdentity(providerQualificationRepositoryInput, providerNamespace);

    const response = await handleProviderQualification(requestWith(token, { create: true }), env);
    const body = await expectJson(response, 200, {
      provider_id: `provider-${identity.name}`,
      name: identity.name,
      defaultBranch: "main",
      readOnly: false
    });

    expect(Object.keys(body).sort()).toEqual(["defaultBranch", "name", "provider_id", "readOnly"]);
    expect(artifacts.createCalls).toEqual([{ name: identity.name, options: { readOnly: false, setDefaultBranch: "main" } }]);
    expect(artifacts.repos.get(identity.name)?.revokedTokens).toEqual([bootstrapSecret]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(bootstrapSecret);
    expect(serialized).not.toContain(helperSecret);
    expect(serialized).not.toContain(querySecret);
    expect(serialized).not.toContain(fragmentSecret);
    expect(serialized).not.toContain("artifacts.example");
  });

  it("replays against an existing fixed repository without another create", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const artifacts = new FakeArtifacts();
    const env = envFor(keys.publicJwk, artifacts);
    const identity = artifactsRepositoryIdentity(providerQualificationRepositoryInput, providerNamespace);
    artifacts.seed(identity.name, { readOnly: true });

    const response = await handleProviderQualification(requestWith(token, { create: true }), env);
    await expectJson(response, 200, {
      provider_id: `provider-${identity.name}`,
      name: identity.name,
      defaultBranch: "main",
      readOnly: true
    });

    expect(artifacts.createCalls).toEqual([]);
    expect(artifacts.repos.get(identity.name)?.revokedTokens).toEqual([]);
  });

  it("denies bad operator tokens before provider writes and sanitizes provider failures", async () => {
    const trusted = await makeKeys("kid-a");
    const attacker = await makeKeys("kid-a");
    const forged = await signJwt(attacker.privateKey, attacker.publicJwk.kid, serviceClaims());
    const artifacts = new FakeArtifacts();
    const denied = await handleProviderQualification(requestWith(forged, { create: true }), envFor(trusted.publicJwk, artifacts));
    await expectJson(denied, 401, { error: "operator unauthorized" });
    expect(artifacts.createCalls).toEqual([]);
    expect(artifacts.getCalls).toEqual([]);

    artifacts.getError = Object.assign(new Error(`upstream leaked ${bootstrapSecret}`), { code: "SECRET_CODE" });
    const valid = await signJwt(trusted.privateKey, trusted.publicJwk.kid, serviceClaims());
    const failed = await handleProviderQualification(requestWith(valid, { create: false }), envFor(trusted.publicJwk, artifacts));
    const body = await expectJson(failed, 502, { error: "provider qualification failed" });
    expect(JSON.stringify(body)).not.toContain("SECRET_CODE");
    expect(JSON.stringify(body)).not.toContain(bootstrapSecret);
  });

  it("qualifies the trusted Linux helper with a fixed command and redacted receipt", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const linux = new FakeLinuxNamespace();
    const response = await handleProviderQualification(linuxRequestWith(token, {}), envFor(keys.publicJwk, undefined, linux));
    const body = await expectJson(response, 200, {
      profile: "trusted_git_helper",
      image: trustedLinuxImage,
      status: "succeeded",
      exitCode: 0,
      cleanupRequired: false,
      version: "git version 2.50.0"
    });

    expect(linux.idNames).toEqual(["gitfoundry-operator-linux-qualification"]);
    expect(linux.stub.fetchCalls).toHaveLength(1);
    expect(linux.stub.fetchCalls[0]?.url).toBe("https://gitfoundry-linux.internal/linux/exec");
    expect(linux.stub.fetchCalls[0]?.body).toMatchObject({
      tenantId: "gitfoundry-platform",
      repositoryId: "operator-linux-qualification",
      operationId: "qualify-trusted-git",
      deadlineMs: 30000,
      cwd: "/work/gitfoundry-platform/operator-linux-qualification/qualify-trusted-git",
      argv: ["/usr/bin/git", "--version"],
      env: { GFY_OPERATION_ID: "qualify-trusted-git" },
      egressProfile: "deny_all"
    });
    expect(String(linux.stub.fetchCalls[0]?.body.commandId)).toMatch(/^linuxq-[0-9a-f]{48}$/);
    expect(linux.stub.fetchCalls[0]?.body.fenceToken).toBe(`fence-${linux.stub.fetchCalls[0]?.body.commandId}`);
    expect(Object.keys(body).sort()).toEqual(["cleanupRequired", "commandId", "exitCode", "image", "profile", "status", "version"]);
    expect(JSON.stringify(body)).not.toContain("stdout");
  });

  it("uses a fresh internal Linux attempt for each qualification request", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const linux = new FakeLinuxNamespace();
    const env = envFor(keys.publicJwk, undefined, linux);
    await handleProviderQualification(linuxRequestWith(token, {}), env);
    await handleProviderQualification(linuxRequestWith(token, {}), env);
    expect(linux.stub.fetchCalls).toHaveLength(2);
    expect(linux.stub.fetchCalls[0]?.body.commandId).not.toBe(linux.stub.fetchCalls[1]?.body.commandId);
  });

  it("returns bounded Linux failure diagnostics without operator secrets", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const secret = "cfast_" + "q".repeat(48);
    const linux = new FakeLinuxNamespace({ body: { ok: false, error: "gfy_linux_execution_failed", receipt: linuxReceipt({ status: "failed", stderr: "native exec error " + secret + " https://credential@example.test/private" }) } });
    const response = await handleProviderQualification(linuxRequestWith(token, {}), { ...envFor(keys.publicJwk, undefined, linux), GFY_QUALIFIER_CLIENT_SECRET: secret });
    const body = await expectJson(response, 502, { error: "linux qualification failed", failure_code: "gfy_linux_execution_failed" });
    expect(String(body.diagnostic)).toContain("native exec error");
    expect(String(body.diagnostic).length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain("credential@example");
  });

  it("rejects caller-controlled Linux command fields and bad Linux config before DO fetch", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const linux = new FakeLinuxNamespace();
    const env = envFor(keys.publicJwk, undefined, linux);

    for (const body of [
      { argv: ["/bin/sh"] },
      { env: { GITHUB_TOKEN: "secret" } },
      { cwd: "/tmp" },
      { tenantId: "tenant-a" },
      { providerCredential: "secret" }
    ]) {
      const denied = await handleProviderQualification(linuxRequestWith(token, body), env);
      await expectJson(denied, 400, { error: "invalid qualification request" });
    }

    const badImage = await handleProviderQualification(linuxRequestWith(token, {}), { ...envFor(keys.publicJwk, undefined, new FakeLinuxNamespace()), GFY_TRUSTED_GIT_HELPER_IMAGE: "registry.example/gitfoundry-helper:latest" });
    await expectJson(badImage, 503, { error: "linux qualification unconfigured" });
    expect(linux.stub.fetchCalls).toEqual([]);
  });

  it("qualifies replacement namespaces without touching active containers", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const active = new FakeLinuxNamespace();
    const helper = new FakeLinuxNamespace();
    const ci = new FakeLinuxNamespace({ body: { ok: true, receipt: linuxReceipt({ image: untrustedCiImage, stdout: "x86_64\ngit version 2.50.0\ngitfoundry-supervisor 0.1.0\ncredentials_absent\npublic_egress_denied\n" }) } });
    const env = { ...envFor(keys.publicJwk, undefined, active), TRUSTED_GIT_HELPER_CANARY: helper as unknown as DurableObjectNamespace, UNTRUSTED_CI_JOB_CANARY: ci as unknown as DurableObjectNamespace };
    await expectJson(await handleProviderQualification(linuxRequestWith(token, { profile: "trusted_git_helper", target: "canary" }), env), 200, { profile: "trusted_git_helper", image: trustedLinuxImage });
    await expectJson(await handleProviderQualification(linuxRequestWith(token, { profile: "untrusted_ci_job", target: "canary" }), env), 200, { profile: "untrusted_ci_job", image: untrustedCiImage });
    expect(helper.stub.fetchCalls).toHaveLength(1);
    expect(ci.stub.fetchCalls).toHaveLength(1);
    expect(active.stub.fetchCalls).toEqual([]);
  });

  it("fails closed for unavailable or invalid canary targets", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const active = new FakeLinuxNamespace();
    const env = envFor(keys.publicJwk, undefined, active);
    await expectJson(await handleProviderQualification(linuxRequestWith(token, { target: "canary" }), env), 503, { error: "linux qualification unconfigured" });
    await expectJson(await handleProviderQualification(linuxRequestWith(token, { target: "other" }), env), 400, { error: "invalid qualification request" });
    expect(active.stub.fetchCalls).toEqual([]);
  });

  it("qualifies only the isolated CI namespace with a fixed wrapper and credential-free probe", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const trusted = new FakeLinuxNamespace();
    const ci = new FakeLinuxNamespace({ body: { ok: true, receipt: linuxReceipt({ image: untrustedCiImage, stdout: "x86_64\ngit version 2.50.0\ngitfoundry-supervisor 0.1.0\ncredentials_absent\npublic_egress_denied\n" }) } });
    const response = await handleProviderQualification(linuxRequestWith(token, { profile: "untrusted_ci_job" }), { ...envFor(keys.publicJwk, undefined, trusted), UNTRUSTED_CI_JOB: ci as unknown as DurableObjectNamespace });
    const body = await expectJson(response, 200, { profile: "untrusted_ci_job", image: untrustedCiImage, status: "succeeded", exitCode: 0, cleanupRequired: false, architecture: "x86_64", version: "git version 2.50.0", supervisorVersion: "gitfoundry-supervisor 0.1.0", credentialsAbsent: true, publicEgressDenied: true });
    expect(ci.idNames).toEqual(["gitfoundry-operator-ci-qualification"]);
    expect(trusted.stub.fetchCalls).toEqual([]);
    const request = ci.stub.fetchCalls[0]?.body;
    expect(request).toMatchObject({ operationId: "qualify-untrusted-ci", cwd: "/work/gitfoundry-platform/operator-linux-qualification/qualify-untrusted-ci", egressProfile: "deny_all", env: { GFY_OPERATION_ID: "qualify-untrusted-ci" } });
    expect(request?.argv).toEqual(["/usr/local/bin/gitfoundry-ci-step", "/usr/bin/sh", "-c", expect.any(String)]);
    const script = String((request?.argv as string[])[3]);
    expect(script).toContain("/usr/bin/uname -m");
    expect(script).toContain("/usr/bin/git --version");
    expect(script).toContain("/usr/local/bin/gitfoundry-supervise --version");
    expect(script).toContain("/usr/bin/env");
    expect(script).toContain("/usr/bin/grep");
    expect(script).toContain("/usr/bin/curl");
    expect(script).not.toContain(token);
    expect(Object.keys(body).sort()).toEqual(["architecture", "cleanupRequired", "commandId", "credentialsAbsent", "exitCode", "image", "profile", "publicEgressDenied", "status", "supervisorVersion", "version"]);
  });

  it("rejects CI receipts that lack independent image, architecture, version, isolation, or cleanup proof", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const stdout = "x86_64\ngit version 2.50.0\ngitfoundry-supervisor 0.1.0\ncredentials_absent\npublic_egress_denied\n";
    for (const overrides of [
      { image: trustedLinuxImage }, { exitCode: 1 }, { cleanupRequired: true },
      { stdout: stdout.replace("x86_64", "aarch64") },
      { stdout: stdout.replace("git version 2.50.0", "not git") },
      { stdout: stdout.replace("gitfoundry-supervisor 0.1.0", "not supervisor") },
      { stdout: stdout.replace("credentials_absent", "credentials_present") },
      { stdout: stdout.replace("public_egress_denied", "public_egress_allowed") }
    ]) {
      const ci = new FakeLinuxNamespace({ body: { ok: true, receipt: linuxReceipt({ image: untrustedCiImage, stdout, ...overrides }) } });
      const response = await handleProviderQualification(linuxRequestWith(token, { profile: "untrusted_ci_job" }), { ...envFor(keys.publicJwk), UNTRUSTED_CI_JOB: ci as unknown as DurableObjectNamespace });
      await expectJson(response, 502, { error: "linux qualification failed" });
    }
  });

  it("rejects Linux receipts that do not prove the configured image, clean success, and version output", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());

    for (const receipt of [
      linuxReceipt({ image: `registry.example/other@sha256:${imageDigest}` }),
      linuxReceipt({ status: "failed" }),
      linuxReceipt({ exitCode: 1 }),
      linuxReceipt({ cleanupRequired: true }),
      linuxReceipt({ stdout: "not git\n" })
    ]) {
      const linux = new FakeLinuxNamespace({ body: { ok: true, receipt } });
      const response = await handleProviderQualification(linuxRequestWith(token, {}), envFor(keys.publicJwk, undefined, linux));
      await expectJson(response, 502, { error: "linux qualification failed" });
    }
  });

  it("runs signed JWT qualification create, replay, and denial inside actual installed workerd", async () => {
    const keys = await makeKeys("kid-a");
    const token = await signJwt(keys.privateKey, keys.publicJwk.kid, serviceClaims());
    const forged = await signJwt((await makeKeys("kid-a")).privateKey, keys.publicJwk.kid, serviceClaims());
    const result = runInWorkerd({ publicJwk: keys.publicJwk, token, forged });

    expect(result).toMatchObject({ ok: true, createSourceRevision: sourceRevision, linuxSourceRevision: sourceRevision, createStatus: 200, replayStatus: 200, linuxStatus: 200, linuxUnknownStatus: 400, unknownStatus: 400, forgedStatus: 401, createCalls: 1, revokedTokens: [bootstrapSecret] });
    expect(result.linuxBody).toMatchObject({ profile: "trusted_git_helper", image: trustedLinuxImage, status: "succeeded", exitCode: 0, cleanupRequired: false, version: "git version 2.50.0" });
    expect(JSON.stringify(result)).not.toContain(helperSecret);
    expect(JSON.stringify(result)).not.toContain(querySecret);
    expect(JSON.stringify(result)).not.toContain(fragmentSecret);
  }, 30_000);
});

class FakeArtifactsError extends Error {
  readonly name = "ArtifactsError";
  constructor(readonly code: string, message: string) { super(message) }
}

class FakeRepo {
  readonly tokenCalls: Array<{ scope?: "read" | "write"; ttl?: number }> = [];
  readonly revokedTokens: string[] = [];
  disposed = false;

  constructor(readonly infoValue: WorkersArtifactsRepoInfo, readonly tokenPlaintext = helperSecret) {}

  async info(): Promise<WorkersArtifactsRepoInfo> { return this.infoValue }

  async createToken(scope?: "read" | "write", ttl?: number): Promise<WorkersArtifactsCreateTokenResult> {
    const call: { scope?: "read" | "write"; ttl?: number } = {};
    if (scope) call.scope = scope;
    if (ttl !== undefined) call.ttl = ttl;
    this.tokenCalls.push(call);
    return { id: "helper-token-id", plaintext: this.tokenPlaintext, scope: scope ?? "write", expiresAt: "2026-10-08T00:05:00.000Z" };
  }

  async revokeToken(tokenOrId: string): Promise<boolean> {
    this.revokedTokens.push(tokenOrId);
    return true;
  }

  [Symbol.dispose](): void { this.disposed = true }
}

class FakeArtifacts implements ArtifactsBinding {
  readonly createCalls: Array<{ name: string; options?: { readOnly?: boolean; setDefaultBranch?: string; description?: string } }> = [];
  readonly getCalls: string[] = [];
  readonly repos = new Map<string, FakeRepo>();
  getError: unknown;

  seed(name: string, overrides: Partial<Pick<WorkersArtifactsRepoInfo, "readOnly" | "defaultBranch">> = {}): FakeRepo {
    const info: WorkersArtifactsRepoInfo = {
      id: `provider-${name}`,
      name,
      description: null,
      defaultBranch: overrides.defaultBranch ?? "main",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
      lastPushAt: null,
      source: null,
      readOnly: overrides.readOnly ?? false,
      remote: `https://helper:${bootstrapSecret}@artifacts.example/${name}.git?token=${querySecret}#${fragmentSecret}`
    };
    const repo = new FakeRepo(info);
    this.repos.set(name, repo);
    return repo;
  }

  async create(name: string, options?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<WorkersArtifactsCreateRepoResult> {
    const call: { name: string; options?: { readOnly?: boolean; setDefaultBranch?: string; description?: string } } = { name };
    if (options) call.options = options;
    this.createCalls.push(call);
    const repo = this.seed(name, { defaultBranch: options?.setDefaultBranch ?? "main", readOnly: options?.readOnly ?? false });
    return { id: repo.infoValue.id, name, description: null, defaultBranch: repo.infoValue.defaultBranch, remote: repo.infoValue.remote, token: bootstrapSecret };
  }

  async get(name: string): Promise<FakeRepo> {
    this.getCalls.push(name);
    if (this.getError) throw this.getError;
    const repo = this.repos.get(name);
    if (!repo) throw new FakeArtifactsError("NOT_FOUND", `missing ${name}`);
    return repo;
  }

  async list(): Promise<{ repos: Array<Omit<WorkersArtifactsRepoInfo, "remote">>; total: number }> {
    return { repos: [], total: 0 };
  }
}

class FakeLinuxStub {
  readonly fetchCalls: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];

  constructor(readonly result: { readonly status?: number; readonly body?: Record<string, unknown> } = {}) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    this.fetchCalls.push({ url, body });
    const configuredReceipt = this.result.body?.receipt as Record<string, unknown> | undefined;
    const receipt = configuredReceipt ? { ...configuredReceipt, commandId: configuredReceipt.commandId ?? String(body.commandId ?? "") } : linuxReceipt({ commandId: String(body.commandId ?? "") });
    return Response.json(this.result.body ? { ...this.result.body, receipt } : { ok: true, receipt }, { status: this.result.status ?? 200 });
  }
}

class FakeLinuxNamespace {
  readonly idNames: string[] = [];
  readonly stub: FakeLinuxStub;

  constructor(result?: { readonly status?: number; readonly body?: Record<string, unknown> }) { this.stub = new FakeLinuxStub(result) }

  idFromName(name: string): DurableObjectId {
    this.idNames.push(name);
    return { name } as unknown as DurableObjectId;
  }

  get(): DurableObjectStub {
    return this.stub as unknown as DurableObjectStub;
  }
}

function linuxReceipt(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    image: trustedLinuxImage,
    status: "succeeded",
    exitCode: 0,
    cleanupRequired: false,
    stdout: "git version 2.50.0\n",
    ...overrides
  };
}

function envFor(publicJwk: Jwk, artifacts?: ArtifactsBinding, linux?: FakeLinuxNamespace): ProviderQualificationEnv {
  const env: ProviderQualificationEnv = {
    GFY_AUTH_ISSUER: issuer,
    GFY_AUTH_AUDIENCE: audience,
    GFY_AUTH_JWKS_URL: jwksUrl,
    GFY_QUALIFIER_CLIENT_ID: clientId,
    GFY_SOURCE_REVISION: sourceRevision,
    GFY_GIT_NAMESPACE: providerNamespace,
    GFY_TRUSTED_GIT_HELPER_IMAGE: trustedLinuxImage,
    GFY_UNTRUSTED_CI_IMAGE: untrustedCiImage,
    clock: { now: () => now },
    jwksFetch: async (url) => {
      expect(url).toBe(jwksUrl);
      return Response.json({ keys: [publicJwk] });
    }
  };
  return {
    ...env,
    ...(artifacts ? { GFY_GIT: artifacts } : {}),
    ...(linux ? { TRUSTED_GIT_HELPER: linux as unknown as DurableObjectNamespace, UNTRUSTED_CI_JOB: linux as unknown as DurableObjectNamespace } : {})
  };
}

function requestWith(token: string, body?: Record<string, unknown>, header: "authorization" | "assertion" = "authorization"): Request {
  return requestWithRaw(token, body === undefined ? undefined : JSON.stringify(body), header);
}

function requestWithRaw(token: string, body?: string, header: "authorization" | "assertion" = "authorization"): Request {
  const headers = new Headers({ "content-type": "application/json", "X-GitFoundry-Expected-Revision": sourceRevision });
  if (header === "authorization") headers.set("authorization", `Bearer ${token}`);
  else headers.set("cf-access-jwt-assertion", token);
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) init.body = body;
  return new Request("https://gitfoundry.test/_operator/qualify/artifacts", init);
}

function linuxRequestWith(token: string, body?: Record<string, unknown>, header: "authorization" | "assertion" = "authorization"): Request {
  const headers = new Headers({ "content-type": "application/json", "X-GitFoundry-Expected-Revision": sourceRevision });
  if (header === "authorization") headers.set("authorization", `Bearer ${token}`);
  else headers.set("cf-access-jwt-assertion", token);
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request("https://gitfoundry.test/_operator/qualify/linux", init);
}

async function expectJson(response: Response | undefined, status: number, expected: Record<string, unknown>): Promise<Record<string, unknown>> {
  expect(response).toBeDefined();
  if (!response) throw new Error("response missing");
  expect(response.status).toBe(status);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject(expected);
  return body;
}

function serviceClaims(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return cleanClaims({
    type: "app",
    iss: issuer,
    aud: [audience],
    exp: seconds(now) + 3600,
    nbf: seconds(now) - 60,
    iat: seconds(now) - 60,
    sub: "",
    common_name: clientId,
    ...overrides
  });
}

function cleanClaims(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined)) }
async function makeKeys(kid: string): Promise<{ privateKey: CryptoKey; publicJwk: Jwk }> { const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]); const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as Jwk; return { privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid, alg: "RS256" } } }
async function signJwt(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>, headerOverrides: Partial<Record<string, unknown>> = {}): Promise<string> { const header = encode({ alg: "RS256", typ: "JWT", kid, ...headerOverrides }); const payload = encode(claims); const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`)); return `${header}.${payload}.${base64Url(new Uint8Array(signature))}` }
function encode(value: unknown): string { return base64Url(new TextEncoder().encode(JSON.stringify(value))) }
function base64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") }
function seconds(date: Date): number { return Math.floor(date.getTime() / 1000) }

function runInWorkerd(input: { publicJwk: Jwk; token: string; forged: string }): Record<string, unknown> {
  const root = path.resolve(__dirname, "../../../..");
  const fixture = JSON.stringify({ ...input, issuer, audience, jwksUrl, clientId, sourceRevision, now: now.toISOString(), providerNamespace, trustedLinuxImage, untrustedCiImage, bootstrapSecret, helperSecret, querySecret, fragmentSecret });
  const script = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = ${JSON.stringify(root)};
const fixture = JSON.parse(process.env.PROVIDER_QUALIFICATION_FIXTURE ?? "{}");
const runtimeRoot = path.join(root, "node_modules/.pnpm/node_modules/@alchemy.run/cloudflare-runtime");
const effectRoot = path.join(root, "node_modules/.pnpm/effect@4.0.2/node_modules/effect/dist");
const platformNode = path.join(root, "node_modules/.pnpm/@effect+platform-node@4.0.2_effect@4.0.2_redis@6.3.0/node_modules/@effect/platform-node/dist/NodeServices.js");
const rolldownPackage = path.join(root, "node_modules/.pnpm/node_modules/rolldown/dist/index.mjs");
const [Effect, Layer, NodeServices, Workerd, _internalModules, _internalWorker, _d1Options, { rolldown }] = await Promise.all([
  import(pathToFileURL(path.join(effectRoot, "Effect.js")).href),
  import(pathToFileURL(path.join(effectRoot, "Layer.js")).href),
  import(pathToFileURL(platformNode).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/workerd/Workerd.mjs")).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/internal/internal-modules.mjs")).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/internal/internal-worker.mjs")).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/bindings/d1/D1Options.shared.mjs")).href),
  import(pathToFileURL(rolldownPackage).href)
]);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitfoundry-provider-qualification-"));
const wrapperPath = path.join(tempDir, "provider-qualification-wrapper.mjs");
fs.writeFileSync(wrapperPath, "import { handleProviderQualification } from " + JSON.stringify(pathToFileURL(path.join(root, "apps/api-worker/src/auth/provider-qualification.ts")).href) + ";\\n" +
  "const fixture = " + JSON.stringify(fixture).replace(/</g, "\\u003c") + ";\\n" +
  "const jwks = { keys: [fixture.publicJwk] };\\n" +
  "class FakeRepo { constructor(info) { this.infoValue = info; this.revokedTokens = []; } async info() { return this.infoValue; } async createToken(scope, ttl) { return { id: 'helper-token-id', plaintext: fixture.helperSecret, scope: scope ?? 'write', expiresAt: '2026-10-08T00:05:00.000Z' }; } async revokeToken(token) { this.revokedTokens.push(token); return true; } [Symbol.dispose]() {} }\\n" +
  "class FakeArtifacts { constructor() { this.createCalls = []; this.repos = new Map(); } async create(name, options) { this.createCalls.push({ name, options }); const info = { id: 'provider-' + name, name, description: null, defaultBranch: options?.setDefaultBranch ?? 'main', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', lastPushAt: null, source: null, readOnly: false, remote: 'https://helper:' + fixture.bootstrapSecret + '@artifacts.example/' + name + '.git?token=' + fixture.querySecret + '#' + fixture.fragmentSecret }; this.repos.set(name, new FakeRepo(info)); return { id: info.id, name, description: null, defaultBranch: info.defaultBranch, remote: info.remote, token: fixture.bootstrapSecret }; } async get(name) { const repo = this.repos.get(name); if (!repo) throw Object.assign(new Error('missing ' + name), { code: 'NOT_FOUND' }); return repo; } async list() { return { repos: [], total: 0 }; } }\\n" +
  "class FakeLinuxStub { constructor() { this.fetchCalls = []; } async fetch(input, init) { const body = JSON.parse(String(init?.body ?? '{}')); this.fetchCalls.push({ url: String(input), body }); return Response.json({ ok: true, receipt: { commandId: body.commandId, image: fixture.trustedLinuxImage, status: 'succeeded', exitCode: 0, cleanupRequired: false, stdout: 'git version 2.50.0' + String.fromCharCode(10) } }); } }\\n" +
  "class FakeLinuxNamespace { constructor() { this.idNames = []; this.stub = new FakeLinuxStub(); } idFromName(name) { this.idNames.push(name); return { name }; } get() { return this.stub; } }\\n" +
  "const artifacts = new FakeArtifacts();\\n" +
  "const linux = new FakeLinuxNamespace();\\n" +
  "function env() { return { GFY_AUTH_ISSUER: fixture.issuer, GFY_AUTH_AUDIENCE: fixture.audience, GFY_AUTH_JWKS_URL: fixture.jwksUrl, GFY_QUALIFIER_CLIENT_ID: fixture.clientId, GFY_SOURCE_REVISION: fixture.sourceRevision, GFY_GIT_NAMESPACE: fixture.providerNamespace, GFY_GIT: artifacts, TRUSTED_GIT_HELPER: linux, UNTRUSTED_CI_JOB: linux, GFY_TRUSTED_GIT_HELPER_IMAGE: fixture.trustedLinuxImage, GFY_UNTRUSTED_CI_IMAGE: fixture.untrustedCiImage, clock: { now: () => new Date(fixture.now) }, jwksFetch: async () => Response.json(jwks) }; }\\n" +
  "async function call(path, token, body) { const headers = new Headers({ authorization: 'Bearer ' + token, 'content-type': 'application/json', 'X-GitFoundry-Expected-Revision': fixture.sourceRevision }); const init = { method: 'POST', headers }; if (body !== undefined) init.body = JSON.stringify(body); const response = await handleProviderQualification(new Request('https://gitfoundry.test' + path, init), env()); return { status: response.status, sourceRevision: response.headers.get('X-GitFoundry-Source-Revision'), body: await response.json() }; }\\n" +
  "export default { async fetch() { const created = await call('/_operator/qualify/artifacts', fixture.token, { create: true }); const replay = await call('/_operator/qualify/artifacts', fixture.token, { create: true }); const linuxResult = await call('/_operator/qualify/linux', fixture.token, {}); const linuxUnknown = await call('/_operator/qualify/linux', fixture.token, { argv: ['/bin/sh'] }); const unknown = await call('/_operator/qualify/artifacts', fixture.token, { create: false, command: 'shell' }); const forged = await call('/_operator/qualify/artifacts', fixture.forged, { create: true }); const firstRepo = Array.from(artifacts.repos.values())[0]; return Response.json({ ok: true, createSourceRevision: created.sourceRevision, linuxSourceRevision: linuxResult.sourceRevision, createStatus: created.status, replayStatus: replay.status, linuxStatus: linuxResult.status, linuxBody: linuxResult.body, linuxUnknownStatus: linuxUnknown.status, unknownStatus: unknown.status, forgedStatus: forged.status, createCalls: artifacts.createCalls.length, revokedTokens: firstRepo?.revokedTokens ?? [], createBody: created.body, replayBody: replay.body }); } };\\n");
const bundle = await rolldown({ input: wrapperPath });
const output = await bundle.generate({ format: "es", codeSplitting: false, sourcemap: false });
const chunk = output.output.find((item) => item.type === "chunk");
if (!chunk) throw new Error("provider qualification bundle missing");
const services = Layer.provide(Workerd.WorkerdLive, NodeServices.layer);
const program = Effect.scoped(Effect.gen(function* () {
  const workerd = yield* Workerd.Workerd;
  const ports = yield* workerd.serve({
    sockets: [{ name: "http", address: "127.0.0.1:0", service: { name: "qualification" } }],
    services: [{ name: "qualification", worker: { compatibilityDate: "2026-03-10", compatibilityFlags: ["nodejs_compat"], modules: [{ name: "index.js", esModule: chunk.code }] } }]
  });
  return yield* Effect.promise(async () => {
    const response = await fetch("http://127.0.0.1:" + ports.http + "/probe", { signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    return JSON.parse(text);
  });
}));
console.log(JSON.stringify(await Effect.runPromise(Effect.provide(program, services))));
`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: { ...process.env, PROVIDER_QUALIFICATION_FIXTURE: fixture }, encoding: "utf8", timeout: 30_000 })) as Record<string, unknown>;
}

class FakeContentRepo extends FakeRepo {
  hash = "a".repeat(40);
  async log(input?: { ref?: string; limit?: number }): Promise<ArtifactsCommitMetadata[]> {
    if (input?.ref === "main") return [];
    expect(input).toEqual({ ref: "master", limit: 1 });
    return [{ hash: this.hash, treeHash: "c".repeat(40), message: "fixture", author: { name: "Fixture", email: "fixture@example.invalid" }, committer: { name: "Fixture", email: "fixture@example.invalid" }, parents: [], authoredAt: 0, committedAt: 0 }];
  }
  async readFile(input: { ref: string; path: string }): Promise<Blob> {
    expect(input).toEqual({ ref: this.hash, path: "README" });
    return new Blob(["Hello World!\n"]);
  }
}
class FakeContentArtifacts extends FakeArtifacts {
  readonly importCalls: Array<Parameters<Artifacts["import"]>[0]> = [];
  contentRepo: FakeContentRepo | undefined;
  async import(input: Parameters<Artifacts["import"]>[0]): Promise<WorkersArtifactsCreateRepoResult> {
    this.importCalls.push(input);
    const seed = this.seed(input.target.name, { readOnly: input.target.opts?.readOnly ?? false, defaultBranch: "main" });
    const repo = new FakeContentRepo(seed.infoValue);
    this.contentRepo = repo;
    this.repos.set(input.target.name, repo);
    return { id: repo.infoValue.id, name: repo.infoValue.name, description: null, defaultBranch: repo.infoValue.defaultBranch, remote: repo.infoValue.remote, token: bootstrapSecret };
  }
}
function contentRequestWith(token: string, body: Record<string, unknown>): Request {
  const base = requestWith(token, body);
  return new Request("https://gitfoundry.test/_operator/qualify/artifacts-content", { method: "POST", headers: base.headers, body: JSON.stringify(body) });
}
