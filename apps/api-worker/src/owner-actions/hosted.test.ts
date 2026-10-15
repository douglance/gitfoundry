import { createHash, generateKeyPairSync, sign as signEd25519, type KeyObject } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalJson, decodeBase64Utf8, encodeBase64Utf8, makeForgeService, type ForgeActor, type ForgeGitPort, type ForgeMergeInput, type ForgeMergeResult, type ForgeWriteCommitInput } from "@gitfoundry/core";

import { canonicalPublicationEvidencePayload, type PublicationCheckEvidenceRecord } from "../fork-forge/evidence.js";
import type { HostedActionsEnv } from "./hosted.js";
import type { OwnerActionRun, OwnerRunReceipt } from "./index.js";

const timestamp = "2026-10-09T16:00:00.000Z";
const tenantId = "tenant-a";
const repositoryId = "repo-a";
const runnerId = "runner-a";
const runnerKeyId = "owner-runner-production";
const reviewKeyId = "review-key";
const artifactNamespace = "gitfoundry-artifacts";
const artifactName = "tenant-a-repo-a";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class<Env = unknown> {
    readonly env: Env;
    constructor(_ctx?: unknown, env?: Env) { this.env = env as Env }
  }
}));

let handleHostedActions: typeof import("./hosted.js")["handleHostedActions"];
let makeHostedActionsPorts: typeof import("./hosted.js")["makeHostedActionsPorts"];

beforeAll(async () => { ({ handleHostedActions, makeHostedActionsPorts } = await import("./hosted.js")) });

const runnerHeaders = { "content-type": "application/json", "x-gitfoundry-operator-client-id": "runner-client", "x-gitfoundry-operator-secret": "runner-secret" };
const runnerActor: ForgeActor = { id: runnerId, kind: "service" };

const evaluator = { schema_version: 1, command: ["node", "scripts/test-all.mjs"], runtime: "local-native-owner", files: ["src/app.ts"] };
const sourceText = "export const value = 1;\n";

describe("hosted owner actions ports", () => {
  it("verifies real Ed25519 runner receipts, rejects wrong keys and tampering, and writes signed evidence", async () => {
    const fixture = await initializedFixture();
    const ports = makeHostedActionsPorts(fixture.env);
    const template = await ports.checkEvidenceTemplate!({ run: fixture.run });
    const check = signCheck(fixture.runnerKeys.privateKey, { ...template, outcome: "passed", signature: "" } as PublicationCheckEvidenceRecord);
    const receipt = receiptFor(fixture.run, check);
    const signature = signReceipt(fixture.runnerKeys.privateKey, receipt);

    await expect(ports.verifyReceipt!({ run: fixture.run, receipt, signature })).resolves.toBe(true);
    await expect(ports.verifyReceipt!({ run: fixture.run, receipt, signature: signReceipt(makeKeys().privateKey, receipt) })).resolves.toBe(false);
    await expect(ports.verifyReceipt!({ run: fixture.run, receipt: { ...receipt, stdout_sha256: "1".repeat(64) }, signature })).resolves.toBe(false);

    const result = await ports.recordEvidence({ run: fixture.run, receipt, signature });
    expect(result?.evidence_ref).toMatch(/^[0-9a-f]{40}$/);

    const evidenceVersion = await serviceFor(fixture.git, fixture.env).read(result!.evidence_ref!, runnerActor);
    const storedCheck = JSON.parse(decodeBase64Utf8((await fixture.git.readFile(evidenceVersion.descriptor.state_commit, "checks/all-tests.json"))!)) as PublicationCheckEvidenceRecord;
    const storedRun = JSON.parse(decodeBase64Utf8((await fixture.git.readFile(evidenceVersion.descriptor.state_commit, `actions/runs/${fixture.run.id}.json`))!)) as { signature: string; receipt: OwnerRunReceipt };
    expect(storedCheck).toEqual(check);
    expect(storedRun.signature).toBe(signature);
    expect(storedRun.receipt.publication_check).toEqual(check);
  });

  it("records evidence for maximum length run ids without overflowing forge operation ids", async () => {
    const fixture = await initializedFixture();
    const ports = makeHostedActionsPorts(fixture.env);
    const longRun = { ...fixture.run, id: "r".repeat(128) };
    const template = await ports.checkEvidenceTemplate!({ run: longRun });
    const check = signCheck(fixture.runnerKeys.privateKey, { ...template, outcome: "passed", signature: "" } as PublicationCheckEvidenceRecord);
    const receipt = receiptFor(longRun, check);
    const signature = signReceipt(fixture.runnerKeys.privateKey, receipt);

    const result = await ports.recordEvidence({ run: longRun, receipt, signature });

    expect(result?.evidence_ref).toMatch(/^[0-9a-f]{40}$/);
    const evidenceVersion = await serviceFor(fixture.git, fixture.env).read(result!.evidence_ref!, runnerActor);
    const storedRun = JSON.parse(decodeBase64Utf8((await fixture.git.readFile(evidenceVersion.descriptor.state_commit, `actions/runs/${longRun.id}.json`))!)) as { receipt: OwnerRunReceipt };
    expect(storedRun.receipt.run_id).toBe(longRun.id);
  });

  it("rejects source and evaluator drift against the accepted publication policy", async () => {
    const fixture = await initializedFixture();
    const ports = makeHostedActionsPorts(fixture.env);
    const changedSource = await fixture.git.writeCommit({ base: fixture.codeCommit, parents: [fixture.codeCommit], changes: [{ path: "src/app.ts", content_base64: b64("export const value = 2;\n") }], message: "source drift", author: author(), timestamp });

    await expect(ports.checkEvidenceTemplate!({ run: { ...fixture.run, code_commit: changedSource } })).rejects.toThrow("evaluator configuration requires owner approval");

    const runnerKeys = makeKeys();
    const reviewKeys = makeKeys();
    const invalidEvaluatorGit = new FakeGitPort();
    const invalidEvaluatorCode = await invalidEvaluatorGit.writeCommit({ base: null, parents: [], changes: [{ path: ".forge/evaluator.json", content_base64: b64(JSON.stringify({ ...evaluator, command: ["node", "scripts/other.mjs"] })) }, { path: "src/app.ts", content_base64: b64(sourceText) }], message: "invalid evaluator", author: author(), timestamp });
    const { env } = makeEnv({ git: invalidEvaluatorGit, runnerKeys, reviewKeys });
    invalidEvaluatorGit.refs.set("refs/heads/source-imports/source-invalid-evaluator", invalidEvaluatorCode);
    const response = await handleHostedActions(hostedRequest("/_runner/source/adopt", { operation_id: "source-invalid-evaluator", code_commit: invalidEvaluatorCode }), env);
    expect(response?.status).toBe(503);
    await expect(response!.json()).resolves.toMatchObject({ error: "hosted_actions_unavailable", cause: { code: "unknown", message: "evaluator invalid" } });

    const failingGit = new FakeGitPort();
    failingGit.readRef = async () => { throw new Error("fetch failed for https://x-access-token:private-provider-token@artifacts.example") };
    const failing = await handleHostedActions(hostedRequest("/_runner/source/adopt", { operation_id: "source-provider-down", code_commit: invalidEvaluatorCode }), makeEnv({ git: failingGit, runnerKeys, reviewKeys }).env);
    expect(failing?.status).toBe(503);
    const body = await failing!.text();
    expect(body).toContain("hosted_actions_unavailable");
    expect(body).not.toContain("private-provider-token");
  });

  it("replays a completed source adoption after the forge head advances", async () => {
    const fixture = await initializedFixture();
    const service = serviceFor(fixture.git, fixture.env);
    const nextCode = await fixture.git.writeCommit({ base: fixture.codeCommit, parents: [fixture.codeCommit], changes: [{ path: "src/app.ts", content_base64: b64("export const value = 3;\n") }], message: "source replay", author: author(), timestamp });
    fixture.git.refs.set("refs/heads/source-imports/source-replay", nextCode);

    const firstResponse = await handleHostedActions(hostedRequest("/_runner/source/adopt", { operation_id: "source-replay", code_commit: nextCode, expected_head: fixture.run.version_commit }), fixture.env);
    expect(firstResponse?.status).toBe(200);
    const first = await firstResponse!.json() as { version_commit: string; code_commit: string; head_version_commit: string };
    await service.publish({ operation_id: "publish-source-replay", expected_version: fixture.run.version_commit, new_version: first.version_commit, actor: runnerActor });
    const advanced = await service.commit({ operation_id: "advance-after-source-replay", parent_version: first.version_commit, actor: runnerActor, changes: [{ tree: "state", path: "issues/advanced.json", content_base64: b64("{}") }] });
    await service.publish({ operation_id: "publish-after-source-replay", expected_version: first.version_commit, new_version: advanced.version_commit, actor: runnerActor });

    const replayResponse = await handleHostedActions(hostedRequest("/_runner/source/adopt", { operation_id: "source-replay", code_commit: nextCode, expected_head: fixture.run.version_commit }), fixture.env);

    expect(replayResponse?.status).toBe(200);
    const replay = await replayResponse!.json() as { version_commit: string; code_commit: string; head_version_commit: string };
    expect(replay.version_commit).toBe(first.version_commit);
    expect(replay.head_version_commit).toBe(advanced.version_commit);
  });

  it("rejects tenant or repository scopes outside the configured runner scope", async () => {
    const fixture = await initializedFixture();
    const ports = makeHostedActionsPorts(fixture.env);
    await expect(ports.getForgeHead({ tenant_id: "tenant-b", repository_id: repositoryId })).rejects.toThrow("runner scope mismatch");
    await expect(ports.checkoutGrant({ run: { ...fixture.run, repository_id: "repo-b" } })).rejects.toThrow("runner scope mismatch");
  });

  it("mints only a read Artifacts grant for runner checkout", async () => {
    const fixture = await initializedFixture();
    const grant = await makeHostedActionsPorts(fixture.env).checkoutGrant({ run: fixture.run });

    expect(grant).toEqual({ remote: "https://gitfoundry.dev/tenant-a/repo-a.git", username: "x-access-token", password: "read-token", expires_at: "2026-10-09T16:15:00.000Z", commit: fixture.codeCommit });
    expect(fixture.artifactsRepo.createTokenCalls).toEqual([{ access: "read", ttl: 900 }]);
    expect(fixture.artifactsRepo.disposed).toBe(true);
  });

  it("refuses source adoption when the imported source ref does not match the claimed code commit", async () => {
    const runnerKeys = makeKeys();
    const reviewKeys = makeKeys();
    const git = new FakeGitPort();
    const codeCommit = await writeCodeCommit(git);
    const { env } = makeEnv({ git, runnerKeys, reviewKeys });
    git.refs.set("refs/heads/source-imports/source-a", "f".repeat(40));

    const response = await handleHostedActions(hostedRequest("/_runner/source/adopt", { operation_id: "source-a", code_commit: codeCommit }), env);

    expect(response?.status).toBe(409);
    await expect(response!.json()).resolves.toMatchObject({ error: "source_import_ref_mismatch" });
  });

  it("rejects deployment admission once the forge head has moved past the leased run", async () => {
    const fixture = await initializedFixture();
    const service = serviceFor(fixture.git, fixture.env);
    const advanced = await service.commit({ operation_id: "advance-head", parent_version: fixture.run.version_commit, actor: runnerActor, changes: [{ tree: "state", path: "issues/advanced.json", content_base64: b64("{}") }] });
    await service.publish({ operation_id: "publish-advance", expected_version: fixture.run.version_commit, new_version: advanced.version_commit, actor: runnerActor });

    await expect(makeHostedActionsPorts(fixture.env).verifyDeploymentAdmission({ run: { ...fixture.run, kind: "deploy-production" } })).rejects.toThrow("deployment source is stale");
  });
});

async function initializedFixture() {
  const runnerKeys = makeKeys();
  const reviewKeys = makeKeys();
  const git = new FakeGitPort();
  const codeCommit = await writeCodeCommit(git);
  const { env, artifactsRepo } = makeEnv({ git, runnerKeys, reviewKeys });
  git.refs.set("refs/heads/source-imports/source-init", codeCommit);
  const response = await handleHostedActions(hostedRequest("/_runner/source/adopt", { operation_id: "source-init", code_commit: codeCommit }), env);
  expect(response?.status).toBe(200);
  const adopted = await response!.json() as { version_commit: string; code_commit: string; head_version_commit: string };
  const run: OwnerActionRun = {
    tenant_id: tenantId,
    repository_id: repositoryId,
    id: "run-a",
    kind: "all-tests",
    operation_id: "run-op",
    version_commit: adopted.version_commit,
    code_commit: adopted.code_commit,
    head_version_commit: adopted.head_version_commit,
    command: { argv: ["node", "scripts/test-all.mjs"] },
    status: "in_progress",
    conclusion: null,
    runner_id: runnerId,
    lease_id: "lease-a",
    lease_generation: 1,
    fence_token: "fence-a",
    lease_expires_at: "2026-10-09T16:15:00.000Z",
    heartbeat_at: null,
    phase: null,
    evidence_status: "none",
    evidence_ref: null,
    created_at: timestamp,
    updated_at: timestamp
  };
  return { env, git, codeCommit, run, runnerKeys, reviewKeys, artifactsRepo };
}

function makeEnv(input: { readonly git: FakeGitPort; readonly runnerKeys: Ed25519Keys; readonly reviewKeys: Ed25519Keys }) {
  const artifactsRepo = new FakeArtifactsRepo();
  const env = {
    GFY_AUTH_ISSUER: "issuer",
    GFY_AUTH_AUDIENCE: "audience",
    GFY_AUTH_JWKS_URL: "https://issuer.example.invalid/certs",
    GFY_RUNNER_CLIENT_ID: "runner-client",
    GFY_RUNNER_CLIENT_SECRET: "runner-secret",
    GFY_RUNNER_TENANT_ID: tenantId,
    GFY_RUNNER_REPOSITORY_ID: repositoryId,
    GFY_RUNNER_ID: runnerId,
    GFY_RUNNER_PUBLIC_KEY: JSON.stringify(input.runnerKeys.publicJwk),
    GFY_FORGE_REVIEW_KEY_ID: reviewKeyId,
    GFY_FORGE_TRUSTED_KEYS: JSON.stringify({ [runnerKeyId]: input.runnerKeys.publicJwk, [reviewKeyId]: input.reviewKeys.publicJwk }),
    GFY_FORGE_GIT: input.git,
    GFY_FORGE_VERIFY_EVIDENCE: async () => {},
    GFY_DB: new RepositoryLookupD1(),
    GFY_GIT_NAMESPACE: artifactNamespace,
    GFY_GIT: { get: async (name: string) => { if (name !== artifactName) throw new Error("unexpected artifacts repo"); return artifactsRepo; } },
    clock: { now: () => new Date(timestamp) }
  } as unknown as HostedActionsEnv;
  return { env, artifactsRepo };
}

function serviceFor(git: ForgeGitPort, env: HostedActionsEnv) {
  return makeForgeService({ git, tenant_id: tenantId, repository_id: repositoryId, clock: () => timestamp, authorize: async ({ actor }) => { if (actor.id !== runnerId || actor.kind !== "service") throw new Error("unexpected actor") }, verifyEvidence: async (context) => { await env.GFY_FORGE_VERIFY_EVIDENCE!({ ...context, tenant_id: tenantId, repository_id: repositoryId }); } });
}

async function writeCodeCommit(git: FakeGitPort): Promise<string> {
  return await git.writeCommit({
    base: null,
    parents: [],
    changes: [
      { path: ".forge/evaluator.json", content_base64: b64(JSON.stringify(evaluator)) },
      { path: "src/app.ts", content_base64: b64(sourceText) }
    ],
    message: "source import",
    author: author(),
    timestamp
  });
}

function receiptFor(run: OwnerActionRun, publicationCheck: PublicationCheckEvidenceRecord): OwnerRunReceipt {
  return {
    run_id: run.id,
    kind: run.kind,
    version_commit: run.version_commit,
    code_commit: run.code_commit,
    status: "completed",
    conclusion: "success",
    exit_code: 0,
    started_at: timestamp,
    finished_at: timestamp,
    stdout_sha256: "a".repeat(64),
    stderr_sha256: "b".repeat(64),
    stdout_tail: "ok",
    stderr_tail: "",
    publication_check: { ...publicationCheck }
  };
}

function signCheck(privateKey: KeyObject, record: PublicationCheckEvidenceRecord): PublicationCheckEvidenceRecord {
  return { ...record, signature: Buffer.from(signEd25519(null, Buffer.from(canonicalPublicationEvidencePayload(record)), privateKey)).toString("base64") };
}

function signReceipt(privateKey: KeyObject, receipt: OwnerRunReceipt): string {
  return Buffer.from(signEd25519(null, Buffer.from(canonicalJson(receipt)), privateKey)).toString("base64url");
}

type Ed25519Keys = { readonly privateKey: KeyObject; readonly publicJwk: JsonWebKey };
function makeKeys(): Ed25519Keys {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicJwk: pair.publicKey.export({ format: "jwk" }) as JsonWebKey };
}

function hostedRequest(path: string, body: Record<string, unknown>): Request {
  return new Request("https://gitfoundry.dev" + path, { method: "POST", headers: runnerHeaders, body: JSON.stringify(body) });
}

function author() { return { name: "GitFoundry", email: "runner@gitfoundry.dev" }; }
function b64(value: string) { return encodeBase64Utf8(value); }

class RepositoryLookupD1 {
  prepare() {
    return {
      bind: (queriedTenantId: unknown, queriedRepositoryId: unknown) => ({
        first: async <T>() => queriedTenantId === tenantId && queriedRepositoryId === repositoryId ? { artifacts_namespace: artifactNamespace, artifacts_name: artifactName } as T : null
      })
    };
  }
}

class FakeArtifactsRepo {
  readonly createTokenCalls: Array<{ access: "read" | "write"; ttl: number }> = [];
  disposed = false;

  async info() { return { name: artifactName, remote: "https://gitfoundry.dev/tenant-a/repo-a.git" }; }
  async createToken(access: "read" | "write", ttl: number) {
    this.createTokenCalls.push({ access, ttl });
    return { id: `${access}-token-id`, plaintext: `${access}-token`, scope: access, expiresAt: "2026-10-09T16:15:00.000Z" };
  }
  [Symbol.dispose]() { this.disposed = true; }
}

type FakeFileEntry = { readonly content_base64: string; readonly mode: string };
class FakeGitPort implements ForgeGitPort {
  readonly refs = new Map<string, string | null>();
  readonly commits = new Map<string, { parents: readonly string[]; files: Map<string, FakeFileEntry> }>();
  private counter = 1;

  async readRef(ref: string): Promise<string | null> { return this.refs.get(ref) ?? null; }
  async listRefs(prefix: string) { return [...this.refs.entries()].filter((entry): entry is [string, string] => entry[0].startsWith(prefix) && entry[1] !== null).map(([ref, target]) => ({ ref, target })).sort((left, right) => left.ref.localeCompare(right.ref)); }
  async readFile(commit: string, path: string): Promise<string | null> { return this.commits.get(commit)?.files.get(path)?.content_base64 ?? null; }
  async listTree(commit: string, prefix = "") { const stored = this.commits.get(commit); if (!stored) throw new Error("commit not found"); return [...stored.files.entries()].filter(([path]) => path.startsWith(prefix)).map(([path, entry]) => ({ path, oid: createHash("sha1").update(path).update(entry.content_base64).digest("hex"), mode: entry.mode, type: "blob" as const, size: entry.content_base64.length })); }
  async writeCommit(input: ForgeWriteCommitInput): Promise<string> {
    const baseFiles = input.base === null ? new Map<string, FakeFileEntry>() : this.commits.get(input.base)?.files;
    if (!baseFiles) throw new Error("commit not found");
    const files = new Map(baseFiles);
    for (const change of input.changes) {
      if (change.content_base64 === null) files.delete(change.path);
      else files.set(change.path, { content_base64: change.content_base64, mode: change.mode ?? files.get(change.path)?.mode ?? "100644" });
    }
    const sha = this.nextSha();
    this.commits.set(sha, { parents: [...input.parents], files });
    return sha;
  }
  async compareCommits(): Promise<{ files: [] }> { return { files: [] }; }
  async mergeCommits(input: ForgeMergeInput): Promise<ForgeMergeResult> { return { status: "merged", commit: await this.writeCommit({ base: input.left, parents: [input.left, input.right], changes: [], message: input.message, author: input.author, timestamp: input.timestamp }) }; }
  async compareAndSwapRef(ref: string, expected: string | null, next: string | null): Promise<boolean> { return this.compareAndSwapRefs([{ ref, expected, next }]); }
  async compareAndSwapRefs(updates: readonly { readonly ref: string; readonly expected: string | null; readonly next: string | null }[]): Promise<boolean> {
    if (updates.some((update) => (this.refs.get(update.ref) ?? null) !== update.expected)) return false;
    for (const update of updates) update.next === null ? this.refs.delete(update.ref) : this.refs.set(update.ref, update.next);
    return true;
  }
  async isAncestor(base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    const seen = new Set<string>();
    const stack = [head];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === base) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(this.commits.get(current)?.parents ?? []));
    }
    return false;
  }
  private nextSha(): string { const sha = this.counter.toString(16).padStart(40, "0"); this.counter += 1; return sha; }
}
