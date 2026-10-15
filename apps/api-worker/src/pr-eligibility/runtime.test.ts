import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { makeArtifactsCandidateRuntime, CandidateRuntimeUnavailableError, type CandidatePreparationRuntimeEnv } from "./runtime.js";
import { buildMergeCandidateAdmission, type MergeCandidatePrepareInput } from "../merge-candidate/index.js";

const image = `registry.example/gitfoundry-helper@sha256:${"a".repeat(64)}`;
const token = "tok_read_secret";
const proof = "proof_1234567890abcdef";
const headSha = "1".repeat(40);
const baseSha = "2".repeat(40);
const candidateOid = "3".repeat(40);
const treeSha = "4".repeat(40);
const bytesSha = "5".repeat(64);

describe("Artifacts candidate preparation runtime", () => {
  it("captures same-repo sources through private Artifacts egress before preparing the candidate offline", async () => {
    const fixture = makeFixture();
    const outcome = await fixture.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" });

    expect(outcome.result).toMatchObject({ ok: true, status: "prepared", candidateOid, candidateTree: treeSha });
    expect(outcome.candidate?.pack.kind).toBe("candidate_pack");
    const frameRequestSha256 = buildMergeCandidateAdmission(candidateInput(), { GFY_TRUSTED_GIT_HELPER_IMAGE: image }).requestSha256;
    expect(outcome.candidate?.requestSha256).toBe(frameRequestSha256);
    expect(fixture.linux.lastCandidateReplaySha256).not.toBe(frameRequestSha256);
    expect(outcome.candidate?.manifest.requestSha256).toBe(frameRequestSha256);
    expect(outcome.reviewedDiff).toMatchObject({ algorithmVersion: "git-cli-unified-v1", headSha, baseSha });
    expect(outcome.candidate?.reviewedDiff).toMatchObject({ algorithmVersion: "git-cli-unified-v1", headSha, baseSha });
    expect(fixture.linux.sourceBodies).toHaveLength(2);
    expect(fixture.linux.candidateBodies).toHaveLength(1);
    expect(fixture.artifacts.repos.get("repo-a")?.tokens.map((entry) => ({ scope: entry.scope, ttl: entry.ttl }))).toEqual([{ scope: "read", ttl: 60 }, { scope: "read", ttl: 60 }]);
    expect(fixture.artifacts.repos.get("repo-a")?.revoked).toEqual(["repo-a-token-1", "repo-a-token-2"]);
    expect(fixture.artifacts.repos.get("repo-a")?.disposed).toBe(5);
    for (const body of fixture.linux.sourceBodies) {
      expect(body.deadlineMs).toBeLessThanOrEqual(55_000);
      expect(body.credential.expiresAtMs - Date.parse("2026-10-09T00:00:00.000Z")).toBeGreaterThan(body.deadlineMs);
      expect(body.credential.password).toBe(token);
      expect(body.artifactsEgress).toMatchObject({ allowWrite: false, opaqueProof: proof });
      expect(body.operation.kind).toBe("produce_source_pack");
    }
    const candidateBody = JSON.stringify(fixture.linux.candidateBodies[0]);
    expect(candidateBody).not.toContain(token);
    expect(candidateBody).not.toContain(proof);
    expect(JSON.stringify(outcome)).not.toContain(token);
    expect(JSON.stringify(outcome)).not.toContain(proof);
  });

  it("uses the fork source repository identity for the head source and target identity for the base", async () => {
    const fixture = makeFixture({ sourceRepositoryId: "repo-fork" });
    const outcome = await fixture.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-fork", sourceRef: "refs/heads/fork-feature", targetRef: "refs/heads/main" });

    expect(outcome.result.ok).toBe(true);
    expect(fixture.linux.sourceBodies.map((body) => [body.repositoryId, body.providerRepositoryId, body.operation.role])).toEqual([
      ["repo-a", "gfy-ns/repo-a", "source_target_pack"],
      ["repo-fork", "gfy-ns/repo-fork", "source_head_pack"]
    ]);
    expect(fixture.linux.candidateBodies[0].sources.sourceRepositoryId).toBe("repo-fork");
    expect(fixture.linux.candidateBodies[0].sources.head.public.repository_id).toBe("repo-fork");
  });

  it("rejects tenant and provider identity drift before minting tokens", async () => {
    const missing = makeFixture({ omitSource: true });
    await expect(missing.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-missing", sourceRef: "refs/heads/x", targetRef: "refs/heads/main" })).rejects.toThrow(CandidateRuntimeUnavailableError);
    expect(missing.artifacts.totalTokens()).toBe(0);
    expect(missing.linux.sourceBodies).toEqual([]);

    const wrongProvider = makeFixture({ sourceInfo: { name: "wrong-name" } });
    await expect(wrongProvider.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/provider identity/);
    expect(wrongProvider.artifacts.totalTokens()).toBe(0);
    expect(wrongProvider.linux.sourceBodies).toEqual([]);
  });

  it("revokes and disposes all issued tokens on helper failure, token mismatch, and cleanup failure without preparing a candidate", async () => {
    const helperFailure = makeFixture({ sourceStatus: 500 });
    await expect(helperFailure.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/source helper/);
    expect(helperFailure.artifacts.repos.get("repo-a")?.revoked).toEqual(["repo-a-token-1"]);
    expect(helperFailure.linux.candidateBodies).toEqual([]);

    const invalidToken = makeFixture({ tokenScope: "write" });
    await expect(invalidToken.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/token/);
    expect(invalidToken.artifacts.repos.get("repo-a")?.revoked).toEqual(["repo-a-token-1"]);
    expect(invalidToken.linux.candidateBodies).toEqual([]);

    const cleanupFailure = makeFixture({ revokeFails: true });
    await expect(cleanupFailure.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/cleanup/);
    expect(cleanupFailure.linux.candidateBodies).toEqual([]);

    const invalidTokenWithoutId = makeFixture({ tokenIdMissing: true, tokenScope: "write" });
    await expect(invalidTokenWithoutId.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/token|cleanup/);
    expect(invalidTokenWithoutId.artifacts.repos.get("repo-a")?.revoked).toEqual([token]);

    const revokeThrows = makeFixture({ revokeThrows: true });
    await expect(revokeThrows.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/cleanup/);
    expect(revokeThrows.artifacts.repos.get("repo-a")?.revoked).toEqual(["repo-a-token-1"]);
  });

  it("retains cleanup for a token that is issued after the provider call times out", async () => {
    const fixture = makeFixture({ operationTimeoutMs: 5, deferCreateToken: true });
    await expect(fixture.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/timed out|unavailable/);
    expect(fixture.linux.candidateBodies).toEqual([]);

    const repo = fixture.artifacts.repos.get("repo-a")!;
    expect(repo.deferredCreates).toHaveLength(1);
    repo.deferredCreates[0]!.resolve(repo.deferredTokens[0]!);
    await Promise.allSettled(fixture.waitUntilPromises);
    await sleep(0);

    expect(repo.revoked).toEqual(["repo-a-token-1"]);
    expect(repo.disposed).toBeGreaterThanOrEqual(1);
  });

  it("disposes a provider handle that arrives after repository acquisition times out", async () => {
    const fixture = makeFixture({ operationTimeoutMs: 5, deferGet: true });
    await expect(fixture.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/timed out|unavailable/);
    expect(fixture.linux.candidateBodies).toEqual([]);

    const repo = fixture.artifacts.repos.get("repo-a")!;
    expect(fixture.artifacts.deferredGets).toHaveLength(1);
    fixture.artifacts.deferredGets[0]!.resolve(repo);
    await Promise.allSettled(fixture.waitUntilPromises);
    await sleep(0);

    expect(repo.disposed).toBe(1);
  });

  it("rejects source receipt, candidate receipt, and replay identity drift", async () => {
    const sourceDrift = makeFixture({ sourcePackRepositoryId: "other-repo" });
    await expect(sourceDrift.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/source.*scope|source.*identity/i);
    expect(sourceDrift.linux.candidateBodies).toEqual([]);

    const candidateDrift = makeFixture({ candidateRequestSha256: "0".repeat(64) });
    await expect(candidateDrift.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/candidate request/i);

    const forkDrift = makeFixture({ sourceRepositoryId: "repo-fork", candidateSourceRepositoryId: "repo-a" });
    await expect(forkDrift.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-fork", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/fork|source repository/i);

    const candidateFrameDrift = makeFixture({ candidateFrameRequestSha256: "0".repeat(64) });
    await expect(candidateFrameDrift.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/candidate request|locator/i);

    const reviewedDiffDrift = makeFixture({ reviewedDiff: { headSha: baseSha } });
    await expect(reviewedDiffDrift.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/reviewed diff/i);

    const locatorDrift = makeFixture({ candidateLocatorExtraField: true });
    await expect(locatorDrift.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/locator/i);
  });

  it("bounds provider/helper operations and rejects invalid local identities before provider side effects", async () => {
    const badImage = makeFixture({ imageOverride: "helper:latest" });
    await expect(badImage.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/image/);
    expect(badImage.artifacts.totalTokens()).toBe(0);

    const badId = makeFixture();
    await expect(badId.runtime.prepare({ candidate: candidateInput({ repositoryId: "repo..bad" }), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/repositoryId invalid/);
    expect(badId.artifacts.totalTokens()).toBe(0);

    const badAdmission = makeFixture();
    await expect(badAdmission.runtime.prepare({ candidate: candidateInput({ headSha: "not-a-sha" }), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/invalid|unavailable/);
    expect(badAdmission.artifacts.totalTokens()).toBe(0);
    expect(badAdmission.linux.sourceBodies).toEqual([]);

    const badRef = makeFixture();
    await expect(badRef.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/../feature", targetRef: "refs/heads/main" })).rejects.toThrow(/sourceRef invalid/);
    expect(badRef.artifacts.totalTokens()).toBe(0);

    const timeout = makeFixture({ operationTimeoutMs: 1, infoDelayMs: 10 });
    await expect(timeout.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/timed out|unavailable/);
    expect(timeout.artifacts.totalTokens()).toBe(0);
  });

  it("cancels helper response bodies on absolute timeout and oversize", async () => {
    const slowBody = makeFixture({ operationTimeoutMs: 5, sourceNeverCompletes: true });
    await expect(slowBody.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/timed out|unavailable/);
    expect(slowBody.linux.cancelledBodies).toBe(1);
    expect(slowBody.artifacts.repos.get("repo-a")?.revoked).toEqual(["repo-a-token-1"]);

    const oversizeBody = makeFixture({ sourceOversizeResponse: true });
    await expect(oversizeBody.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(/bound exceeded|unavailable/);
    expect(oversizeBody.linux.cancelledBodies).toBe(1);
    expect(oversizeBody.artifacts.repos.get("repo-a")?.revoked).toEqual(["repo-a-token-1"]);
  });

  it("returns business conflicts as results and maps operational failures to unavailable", async () => {
    const conflict = makeFixture({ candidateResult: conflictResult() });
    const outcome = await conflict.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" });
    expect(outcome.result).toMatchObject({ ok: false, status: "conflict" });
    expect(outcome.reviewedDiff).toMatchObject({ algorithmVersion: "git-cli-unified-v1", headSha, baseSha });
    expect(outcome.candidate).toBeUndefined();

    const failed = makeFixture({ candidateStatus: 503 });
    await expect(failed.runtime.prepare({ candidate: candidateInput(), sourceRepositoryId: "repo-a", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" })).rejects.toThrow(CandidateRuntimeUnavailableError);
  });
});

function candidateInput(overrides: Partial<MergeCandidatePrepareInput> = {}): MergeCandidatePrepareInput {
  return {
    commandId: "cmd-candidate", tenantId: "tenant-a", repositoryId: "repo-a", operationId: "op-a", fenceToken: "fence-a",
    pullRequestId: "pr-a", pullRequestVersion: 7, headSha, baseSha, method: "merge", committerName: "Merge Bot",
    committerEmail: "merge@example.invalid", committedAt: "2026-10-09T00:00:00.000Z", message: "Merge PR", ...overrides
  };
}

type FixtureOptions = {
  readonly sourceRepositoryId?: string; readonly omitSource?: boolean; readonly sourceInfo?: Partial<RepoInfo>;
  readonly sourceStatus?: number; readonly candidateStatus?: number; readonly tokenScope?: "read" | "write"; readonly revokeFails?: boolean;
  readonly sourcePackRepositoryId?: string; readonly candidateRequestSha256?: string; readonly candidateSourceRepositoryId?: string;
  readonly candidateFrameRequestSha256?: string; readonly candidateLocatorExtraField?: boolean; readonly reviewedDiff?: Partial<ReturnType<typeof reviewedDiff>>;
  readonly candidateResult?: Record<string, unknown>; readonly tokenIdMissing?: boolean; readonly revokeThrows?: boolean;
  readonly imageOverride?: string; readonly operationTimeoutMs?: number; readonly infoDelayMs?: number;
  readonly deferCreateToken?: boolean; readonly deferGet?: boolean;
  readonly sourceNeverCompletes?: boolean; readonly sourceOversizeResponse?: boolean;
};
function makeFixture(options: FixtureOptions = {}) {
  const sourceRepositoryId = options.sourceRepositoryId ?? "repo-a";
  const db = new FakeD1([
    repoRow("repo-a", "repo-a"),
    ...(options.omitSource ? [] : [repoRow(sourceRepositoryId, sourceRepositoryId)])
  ]);
  const artifacts = new FakeArtifacts(options);
  artifacts.seed("repo-a", options.sourceInfo);
  if (!options.omitSource) artifacts.seed(sourceRepositoryId, options.sourceInfo);
  const linux = new FakeLinuxNamespace(options);
  const waitUntilPromises: Promise<unknown>[] = [];
  const env: CandidatePreparationRuntimeEnv = { GFY_GIT: artifacts as never, GFY_GIT_NAMESPACE: "gfy-ns", TRUSTED_GIT_HELPER: linux as never, GFY_TRUSTED_GIT_HELPER_IMAGE: options.imageOverride ?? image, clock: { now: () => new Date("2026-10-09T00:00:00.000Z") }, proofFactory: () => proof, waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise), operationTimeoutMs: options.operationTimeoutMs } as CandidatePreparationRuntimeEnv;
  return { db, artifacts, linux, waitUntilPromises, runtime: makeArtifactsCandidateRuntime(db as never, env) };
}

function repoRow(id: string, artifactsName: string) { return { tenant_id: "tenant-a", id, namespace_id: "namespace-a", name: id, archived: 0, artifacts_namespace: "gfy-ns", artifacts_name: artifactsName }; }

class FakeD1 {
  constructor(private readonly rows: readonly ReturnType<typeof repoRow>[]) {}
  prepare() { return { bind: (tenant: string, id: string) => ({ first: async () => this.rows.find((row) => row.tenant_id === tenant && row.id === id) ?? null }) }; }
}

interface RepoInfo { readonly id:string; readonly name:string; readonly defaultBranch:string; readonly readOnly:boolean; readonly remote:string; readonly lastPushAt:null; readonly source:null }
class FakeArtifacts {
  readonly repos = new Map<string, FakeRepo>();
  readonly deferredGets: Array<Deferred<FakeRepo>> = [];
  constructor(private readonly options: FixtureOptions) {}
  seed(name: string, info: Partial<RepoInfo> = {}) { this.repos.set(name, new FakeRepo(name, this.options, info)); }
  async get(name: string) { const repo = this.repos.get(name); if (!repo) throw new Error("missing repo " + name); if (this.options.deferGet) { const late = deferred<FakeRepo>(); this.deferredGets.push(late); return late.promise; } return repo; }
  totalTokens() { return Array.from(this.repos.values()).reduce((sum, repo) => sum + repo.tokens.length, 0); }
}
class FakeRepo {
  readonly tokens: Array<{ readonly id:string; readonly scope:string; readonly ttl:number }> = [];
  readonly deferredCreates: Array<Deferred<FakeTokenResult>> = [];
  readonly deferredTokens: FakeTokenResult[] = [];
  readonly revoked: string[] = [];
  disposed = 0;
  constructor(readonly name: string, private readonly options: FixtureOptions, private readonly infoOverrides: Partial<RepoInfo>) {}
  async info(): Promise<RepoInfo> { if (this.options.infoDelayMs) await sleep(this.options.infoDelayMs); return { id: "provider-" + this.name, name: this.name, defaultBranch: "main", readOnly: false, remote: `https://artifacts.example/git/gfy-ns/${this.name}.git`, lastPushAt: null, source: null, ...this.infoOverrides }; }
  async createToken(scope: "read" | "write", ttl: number) { const id = `${this.name}-token-${this.tokens.length + 1}`; this.tokens.push({ id, scope, ttl }); const expiresAt = new Date(Date.parse("2026-10-09T00:00:00.000Z") + ttl * 1000).toISOString(); const issued: FakeTokenResult = this.options.tokenIdMissing ? { plaintext: token, scope: this.options.tokenScope ?? scope, expiresAt } : { id, plaintext: token, scope: this.options.tokenScope ?? scope, expiresAt }; if (this.options.deferCreateToken) { const late = deferred<FakeTokenResult>(); this.deferredCreates.push(late); this.deferredTokens.push(issued); return late.promise; } return issued; }
  async revokeToken(id: string) { this.revoked.push(id); if (this.options.revokeThrows) throw new Error(`secret ${token}`); if (this.options.revokeFails) return false; return true; }
  [Symbol.dispose]() { this.disposed += 1; }
}

class FakeLinuxNamespace {
  readonly names: string[] = [];
  readonly sourceBodies: any[] = [];
  readonly candidateBodies: any[] = [];
  cancelledBodies = 0;
  lastCandidateReplaySha256 = "";
  constructor(private readonly options: FixtureOptions) {}
  idFromName(name: string) { this.names.push(name); return { name }; }
  get() { return { fetch: async (_url: string, init?: RequestInit) => this.fetch(init) }; }
  private async fetch(init?: RequestInit): Promise<Response> {
    const body = JSON.parse(String(init?.body));
    if (body.operation?.kind === "produce_source_pack") {
      this.sourceBodies.push(body);
      if (this.options.sourceStatus) return Response.json({ ok: false, error: "source failed" }, { status: this.options.sourceStatus });
      if (this.options.sourceNeverCompletes) return new Response(new ReadableStream({ cancel: () => { this.cancelledBodies += 1; } }));
      if (this.options.sourceOversizeResponse) return new Response(new ReadableStream({ start: (controller) => { controller.enqueue(new Uint8Array(65_537)); }, cancel: () => { this.cancelledBodies += 1; } }));
      const pack = sourcePack(body, this.options.sourcePackRepositoryId ?? body.repositoryId);
      return Response.json({ ok: true, receipt: { status: "succeeded", exitCode: 0, stdout: JSON.stringify(sourcePackResult(body)) + "\n", stdoutTruncated: false, stderrTruncated: false, cleanupRequired: false, profile: "trusted_git_helper", image, egressProfile: "gfy_internal_only", commandId: body.commandId, tenantId: body.tenantId, repositoryId: body.repositoryId, operationId: body.operationId, fenceToken: body.fenceToken, sourcePack: pack } });
    }
    this.candidateBodies.push(body);
    if (this.options.candidateStatus) return Response.json({ ok: false, error: "candidate unavailable" }, { status: this.options.candidateStatus });
    if (this.options.candidateSourceRepositoryId) body.sources.sourceRepositoryId = this.options.candidateSourceRepositoryId;
    const result = this.options.candidateResult ?? preparedResult();
    const candidateRequestSha256 = this.options.candidateRequestSha256 ?? candidateRequestSha(body);
    this.lastCandidateReplaySha256 = candidateRequestSha256;
    return Response.json({ ok: true, receipt: { status: result.ok ? "succeeded" : "failed", exitCode: 0, stdout: JSON.stringify(result) + "\n", stdoutTruncated: false, stderrTruncated: false, cleanupRequired: false, profile: "trusted_git_helper", image, egressProfile: "deny_all", commandId: body.candidate.commandId, tenantId: body.candidate.tenantId, repositoryId: body.candidate.repositoryId, operationId: body.candidate.operationId, fenceToken: body.candidate.fenceToken, candidateRequestSha256, reviewedDiff: reviewedDiff(this.options.reviewedDiff), ...(result.ok ? { mergeCandidate: storedCandidate(body, result, this.options) } : {}) } });
  }
}

function sourcePack(body: any, repositoryId: string) { const publicInput = { tenant_id: body.tenantId, repository_id: repositoryId, operation_id: body.operationId, fence_token: body.fenceToken, provider_repository: body.providerRepositoryId, ref: body.operation.ref, expected_oid: body.operation.expectedOid, role: body.operation.role, output_dir: `/work/${body.tenantId}/${repositoryId}/${body.operationId}/source-pack` }; const requestSha256 = sha(canonicalJson(publicInput)); return { public: publicInput, manifest: locator(body, repositoryId, body.operationId, requestSha256, "source_manifest", sha("manifest"), 64), pack: locator(body, repositoryId, body.operationId, requestSha256, body.operation.role, "6".repeat(64), 128) }; }
function sourcePackResult(body: any) { return { frame: "gitfoundry.source-pack.result.v1", ok: true, status: "packed", tenant_id: body.tenantId, repository_id: body.repositoryId, operation_id: body.operationId, fence_token: body.fenceToken, provider_repository: body.providerRepositoryId, ref: body.operation.ref, expected_oid: body.operation.expectedOid, tip: body.operation.expectedOid, role: body.operation.role, request_sha256: sha(canonicalJson(sourcePack(body, body.repositoryId).public)), pack_sha256: "6".repeat(64), pack_size_bytes: 128, pack_filename: "source.pack", manifest_sha256: sha("manifest"), git_version: "2.39.5", state_ref: "source-pack/manifest.json" }; }
function preparedResult() { return { frame: "gitfoundry.merge-candidate.result.v1", ok: true, status: "prepared", tenant_id: "tenant-a", repository_id: "repo-a", operation_id: "op-a", pull_request_id: "pr-a", pull_request_version: 7, method: "merge", head_sha: headSha, base_sha: baseSha, candidate_oid: candidateOid, candidate_tree: treeSha, candidate_bytes_sha256: bytesSha, git_version: "2.39.5", state_ref: "merge-candidates/requests/request/manifest.json", original_to_rebased: [] }; }
function conflictResult() { return { frame: "gitfoundry.merge-candidate.result.v1", ok: false, status: "conflict", tenant_id: "tenant-a", repository_id: "repo-a", operation_id: "op-a", pull_request_id: "pr-a", pull_request_version: 7, method: "merge", head_sha: headSha, base_sha: baseSha, git_version: "2.39.5", state_ref: "merge-candidates/requests/request/manifest.json", diagnostics: [{ code: "conflict", path: "file.txt" }] }; }
function storedCandidate(body: any, result: any, options: FixtureOptions) { const frameRequestSha256 = options.candidateFrameRequestSha256 ?? buildMergeCandidateAdmission(body.candidate, { GFY_TRUSTED_GIT_HELPER_IMAGE: image }).requestSha256; return { requestSha256: frameRequestSha256, result: { candidateOid, candidateTree: treeSha, candidateBytesSha256: bytesSha, gitVersion: "2.39.5", originalToRebased: [], ok: true, stateRef: result.state_ref, status: "prepared" }, manifest: locator(body.candidate, "repo-a", "op-a", frameRequestSha256, "candidate_manifest", "7".repeat(64), 512, options.candidateLocatorExtraField), rawCommit: locator(body.candidate, "repo-a", "op-a", frameRequestSha256, "candidate_raw_commit", bytesSha, 100), pack: locator(body.candidate, "repo-a", "op-a", frameRequestSha256, "candidate_pack", "8".repeat(64), 256), reviewedDiff: reviewedDiff(options.reviewedDiff) }; }
function locator(input: any, repositoryId: string, operationId: string, requestSha256: string, kind: string, sha256: string, sizeBytes: number, extra = false) { const locator = { tenantId: input.tenantId ?? input.candidate?.tenantId, repositoryId, operationId, requestSha256, kind, key: `v1/tenants/${input.tenantId ?? input.candidate?.tenantId}/repositories/${repositoryId}/merge-operations/${operationId}/${requestSha256}/${kind}`, sha256, sizeBytes, etag: `etag-${kind}`, version: `version-${kind}`, expiresAt: null }; return extra ? { ...locator, contentType: "application/octet-stream" } : locator; }
function candidateRequestSha(body: any) { const frame = buildMergeCandidateAdmission(body.candidate, { GFY_TRUSTED_GIT_HELPER_IMAGE: image }); return sha(frame.requestSha256 + "\n" + canonicalJson(body.sources)); }
function reviewedDiff(overrides: Partial<{ algorithmVersion:"git-cli-unified-v1"; comparison:"three_dot"; contextLines:3; headSha:string; baseSha:string; mergeBaseShas:string[]; patchSha256:string; patchSizeBytes:number; changedPathsSha256:string }> = {}) { return { algorithmVersion: "git-cli-unified-v1" as const, comparison: "three_dot" as const, contextLines: 3 as const, headSha, baseSha, mergeBaseShas: [baseSha], patchSha256: "9".repeat(64), patchSizeBytes: 128, changedPathsSha256: "a".repeat(64), ...overrides }; }
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: any): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason?: unknown) => void };
type FakeTokenResult = { readonly id?: string; readonly plaintext:string; readonly scope:"read" | "write"; readonly expiresAt:string };
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
