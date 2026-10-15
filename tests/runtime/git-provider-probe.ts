import { Effect } from "../../apps/api-worker/node_modules/effect/dist/index.js";

import { artifactsRepositoryIdentity, makeArtifactsGitProvider } from "../../apps/api-worker/src/git-provider.js";

const expectedNames = {
  left: "gfy.repo.9bce11ca8b9cac0821f19892877e4e178ae5cd8398ac649ad14a22bd8f0f1f60",
  right: "gfy.repo.9aaded22936ec52b4569061f8670e0f31249e991f38f4b37692a2a3c41237192"
};

const bootstrapSecret = "runtime-bootstrap-token";
const helperSecret = "runtime-helper-token";
const querySecret = "runtime-query-token";
const fragmentSecret = "runtime-fragment-token";
const checks: Array<{ readonly name: string; readonly ok: true; readonly detail?: unknown }> = [];

class FakeRepo {
  readonly tokenCalls: Array<{ readonly scope?: "read" | "write"; readonly ttl?: number }> = [];
  readonly revokedTokens: string[] = [];
  disposed = false;

  constructor(readonly infoValue: Record<string, unknown>) {}

  async info(): Promise<Record<string, unknown>> {
    return this.infoValue;
  }

  async createToken(scope?: "read" | "write", ttl?: number): Promise<Record<string, unknown>> {
    this.tokenCalls.push({ scope, ttl });
    return { id: "runtime-helper-token-id", plaintext: helperSecret, scope: scope ?? "write", expiresAt: "2026-10-08T00:05:00.000Z" };
  }

  async revokeToken(tokenOrId: string): Promise<boolean> {
    this.revokedTokens.push(tokenOrId);
    return true;
  }

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}

class FakeArtifacts {
  readonly createCalls: Array<{ readonly name: string; readonly options: unknown }> = [];
  readonly repos = new Map<string, FakeRepo>();

  async create(name: string, options?: { readonly readOnly?: boolean; readonly setDefaultBranch?: string }): Promise<Record<string, unknown>> {
    this.createCalls.push({ name, options });
    const info = {
      id: `runtime-provider-${name}`,
      name,
      description: null,
      defaultBranch: options?.setDefaultBranch ?? "main",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
      lastPushAt: null,
      source: null,
      readOnly: false,
      remote: `https://helper:${bootstrapSecret}@artifacts.example/${name}.git?token=${querySecret}#${fragmentSecret}`
    };
    this.repos.set(name, new FakeRepo(info));
    return { id: info.id, name, description: null, defaultBranch: info.defaultBranch, remote: info.remote, token: bootstrapSecret };
  }

  async get(name: string): Promise<FakeRepo> {
    const repo = this.repos.get(name);
    if (!repo) throw Object.assign(new Error(`missing ${name}`), { code: "NOT_FOUND" });
    return repo;
  }

  async list(): Promise<{ readonly repos: readonly Record<string, unknown>[]; readonly total: number }> {
    const repos = Array.from(this.repos.values()).map((repo) => {
      const { remote: _remote, ...listed } = repo.infoValue;
      return listed;
    });
    return { repos, total: repos.length };
  }
}

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) throw new Error(`${name}: ${JSON.stringify(detail)}`);
  checks.push(detail === undefined ? { name, ok: true } : { name, ok: true, detail });
}

async function runProbe(): Promise<Response> {
  checks.length = 0;
  const left = artifactsRepositoryIdentity({ tenantId: "tenant.a", namespaceId: "b", name: "repo" }, "gitfoundry-staging");
  const right = artifactsRepositoryIdentity({ tenantId: "tenant", namespaceId: "a.b", name: "repo" }, "gitfoundry-staging");
  check("left tuple hash matches independent fixture", left.name === expectedNames.left, { actual: left.name, expected: expectedNames.left });
  check("right tuple hash matches independent fixture", right.name === expectedNames.right, { actual: right.name, expected: expectedNames.right });
  check("collision-prone tuples stay distinct", left.name !== right.name, { left: left.name, right: right.name });

  const artifacts = new FakeArtifacts();
  const provider = makeArtifactsGitProvider(artifacts, { namespace: "gitfoundry-staging", publicGitUrlBase: "https://git.gitfoundry.example/repos" });
  const identity = artifactsRepositoryIdentity({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }, "gitfoundry-staging");
  const provisioned = await Effect.runPromise(provider.provisionRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", defaultBranch: "main", visibility: "private" }));
  const repo = artifacts.repos.get(identity.name);
  check("adapter returns GitFoundry gateway URL", provisioned.gitUrl === `https://git.gitfoundry.example/repos/gitfoundry-staging/${identity.name}.git`, { gitUrl: provisioned.gitUrl });
  check("adapter revokes provider bootstrap token", repo?.revokedTokens.length === 1 && repo.revokedTokens[0] === bootstrapSecret, { revokedCount: repo?.revokedTokens.length ?? 0 });
  check("adapter creates provider repository by physical identity", artifacts.createCalls.length === 1 && artifacts.createCalls[0]?.name === identity.name, { name: artifacts.createCalls[0]?.name });

  const readback = await Effect.runPromise(provider.readRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }));
  const lifecycleText = JSON.stringify({ provisioned, readback });
  check("lifecycle output strips provider credentials", !lifecycleText.includes(bootstrapSecret) && !lifecycleText.includes(querySecret) && !lifecycleText.includes(fragmentSecret) && !lifecycleText.includes("helper@"), { lifecycleText });
  check("readback verifies provider repository identity", readback.name === identity.name && readback.namespace === "gitfoundry-staging", { readbackName: readback.name });

  const token = await Effect.runPromise(provider.createHelperToken({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo", scope: "write", ttlSeconds: 120 }));
  check("helper token is helper scoped and short lived", token.intended_for === "trusted_git_helper" && token.scope === "write" && token.plaintext === helperSecret && repo?.tokenCalls[0]?.ttl === 120, { tokenId: token.token_id, ttl: repo?.tokenCalls[0]?.ttl });
  const postTokenReadback = await Effect.runPromise(provider.readRepository({ tenantId: "tenant-a", namespaceId: "namespace-a", name: "demo" }));
  check("helper token does not leak through lifecycle readback", !JSON.stringify(postTokenReadback).includes(helperSecret));

  return Response.json({ ok: true, provider: "fake-artifacts-binding-not-cloud-proof", identities: { left: left.name, right: right.name, repository: identity.name }, checks });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/probe") return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    try {
      return await runProbe();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const scrubbed = message.replaceAll(bootstrapSecret, "[bootstrap-secret]").replaceAll(helperSecret, "[helper-secret]").replaceAll(querySecret, "[query-secret]").replaceAll(fragmentSecret, "[fragment-secret]");
      return Response.json({ ok: false, error: scrubbed, checks }, { status: 500 });
    }
  }
};
