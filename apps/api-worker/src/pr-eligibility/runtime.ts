import { createHash, randomBytes } from "node:crypto";

import type { D1DatabaseLike } from "../../../../packages/core/src/live/index.js";
import type { ArtifactsBinding, ArtifactsRepoHandle, WorkersArtifactsRepoInfo } from "../git-provider.js";
import { buildMergeCandidateAdmission, parseMergeCandidateResult, type MergeCandidatePrepareInput, type MergeCandidateResult } from "../merge-candidate/index.js";
import type { CandidateSources, PreparedCandidateOutcome, ReviewedDiffEvidence, StoredMergeCandidate } from "../merge-candidate/pipeline.js";
import { buildSourcePackRequest, canonicalJson, parseSourcePackResult, type SourcePackFrame, type SourcePackResult, type SourcePackRole, type StoredSourcePack } from "../merge-candidate/source-packs.js";

export interface CandidatePreparationRuntime {
  prepare(input: { readonly candidate: MergeCandidatePrepareInput; readonly sourceRepositoryId: string; readonly sourceRef: string; readonly targetRef: string }): Promise<PreparedCandidateOutcome>;
}

export interface CandidatePreparationRuntimeEnv {
  readonly GFY_GIT?: ArtifactsBinding;
  readonly GFY_GIT_NAMESPACE: string;
  readonly TRUSTED_GIT_HELPER: Pick<DurableObjectNamespace, "idFromName" | "get">;
  readonly GFY_TRUSTED_GIT_HELPER_IMAGE?: string;
  readonly clock?: { readonly now: () => Date };
  readonly proofFactory?: () => string;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export class CandidateRuntimeUnavailableError extends Error {
  readonly name = "CandidateRuntimeUnavailableError";
}

type RepositoryRow = {
  readonly tenant_id: string;
  readonly id: string;
  readonly namespace_id: string | null;
  readonly name: string | null;
  readonly archived: number | boolean | null;
  readonly artifacts_namespace: string | null;
  readonly artifacts_name: string | null;
};

type RepositorySource = {
  readonly role: SourcePackRole;
  readonly repositoryId: string;
  readonly ref: string;
  readonly expectedOid: string;
  readonly fenceToken: string;
  readonly row: RepositoryRow;
  readonly info: ValidatedProviderInfo;
  readonly operationId: string;
  readonly commandId: string;
};

type ValidatedProviderInfo = {
  readonly namespace: string;
  readonly repository: string;
  readonly providerRepositoryId: string;
  readonly remoteUrl: string;
  readonly hostname: string;
};

type IssuedToken = {
  readonly artifactsName: string;
  readonly revokeId: string;
  readonly plaintext: string;
};

type CandidateRequestDigests = { readonly frameRequestSha256: string; readonly replayRequestSha256: string };

type TrustedSourceHelperRequest = {
  readonly commandId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly operationId: string;
  readonly fenceToken: string;
  readonly deadlineMs: number;
  readonly cwd: string;
  readonly providerId: string;
  readonly providerRepositoryId: string;
  readonly operation: { readonly kind: "produce_source_pack"; readonly remoteUrl: string; readonly ref: string; readonly expectedOid: string; readonly role: SourcePackRole };
  readonly credential: { readonly tenantId: string; readonly repositoryId: string; readonly providerId: string; readonly providerRepositoryId: string; readonly username: string; readonly password: string; readonly expiresAtMs: number };
  readonly artifactsEgress: { readonly allowedProviderHostname: string; readonly namespace: string; readonly repository: string; readonly artifactsRemoteUrl: string; readonly opaqueProof: string; readonly allowWrite: false };
  readonly egressProfile: "gfy_internal_only";
};

type TrustedGitReceipt = {
  readonly status: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly image: string;
  readonly egressProfile: string;
  readonly cleanupRequired: boolean;
  readonly profile: string;
  readonly commandId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly operationId: string;
  readonly fenceToken: string;
  readonly sourcePack?: StoredSourcePack;
  readonly mergeCandidate?: StoredMergeCandidate;
  readonly reviewedDiff?: ReviewedDiffEvidence;
  readonly candidateRequestSha256?: string;
};

const tokenTtlSeconds = 60;
const sourceDeadlineMs = 55_000;
const candidateDeadlineMs = 120_000;
const helperDeadlineAllowanceMs = 5_000;
const providerOperationTimeoutMs = 5_000;
const providerId = "cloudflare-artifacts";
const sourceEgressProfile = "gfy_internal_only";
const candidateEgressProfile = "deny_all";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const imageDigestPattern = /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const providerRepositoryNamePattern = /^[A-Za-z0-9_.-]{1,255}$/u;
const proofPattern = /^[A-Za-z0-9._~:-]{16,512}$/u;
const maxArtifactBytes = 128 * 1024 * 1024;

export function makeArtifactsCandidateRuntime(db: D1DatabaseLike, env: CandidatePreparationRuntimeEnv): CandidatePreparationRuntime {
  return {
    prepare: async (input) => {
      try {
        return await prepareWithArtifacts(db, env, input);
      } catch (error) {
        if (error instanceof CandidateRuntimeUnavailableError) throw error;
        throw unavailable("candidate runtime unavailable");
      }
    }
  };
}

async function prepareWithArtifacts(db: D1DatabaseLike, env: CandidatePreparationRuntimeEnv, input: { readonly candidate: MergeCandidatePrepareInput; readonly sourceRepositoryId: string; readonly sourceRef: string; readonly targetRef: string }): Promise<PreparedCandidateOutcome> {
  trustedImage(env);
  assertId("providerNamespace", env.GFY_GIT_NAMESPACE);
  assertId("sourceRepositoryId", input.sourceRepositoryId);
  assertGitRef("sourceRef", input.sourceRef);
  assertGitRef("targetRef", input.targetRef);
  const admission = buildMergeCandidateAdmission(input.candidate, env);
  const targetRow = await selectRepository(db, input.candidate.tenantId, input.candidate.repositoryId, env.GFY_GIT_NAMESPACE);
  const sourceRow = await selectRepository(db, input.candidate.tenantId, input.sourceRepositoryId, env.GFY_GIT_NAMESPACE);
  const targetInfo = await validateProviderInfo(env, targetRow);
  const sourceInfo = targetRow.artifacts_name === sourceRow.artifacts_name ? targetInfo : await validateProviderInfo(env, sourceRow);
  const target = sourceDescriptor(input.candidate, targetRow, targetInfo, "source_target_pack", input.targetRef, input.candidate.baseSha);
  const head = sourceDescriptor(input.candidate, sourceRow, sourceInfo, "source_head_pack", input.sourceRef, input.candidate.headSha);
  const targetPack = await captureSourcePack(env, target);
  const headPack = await captureSourcePack(env, head);
  const sources: CandidateSources = { target: targetPack, head: headPack, sourceRepositoryId: input.sourceRepositoryId };
  return await prepareCandidate(env, input.candidate, sources, admission.requestSha256);
}

async function selectRepository(db: D1DatabaseLike, tenantId: string, repositoryId: string, namespace: string): Promise<RepositoryRow> {
  assertId("tenantId", tenantId);
  assertId("repositoryId", repositoryId);
  const row = await db.prepare("SELECT tenant_id, id, namespace_id, name, archived, artifacts_namespace, artifacts_name FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, repositoryId).first<RepositoryRow>();
  if (!row) throw unavailable("repository unavailable");
  if (row.tenant_id !== tenantId || row.id !== repositoryId) throw unavailable("repository unavailable");
  if (row.archived !== 0 && row.archived !== 1) throw unavailable("repository archive state invalid");
  if (row.archived === 1) throw unavailable("repository unavailable");
  if (row.artifacts_namespace !== namespace) throw unavailable("repository namespace unavailable");
  if (typeof row.artifacts_name !== "string" || !providerRepositoryNamePattern.test(row.artifacts_name)) throw unavailable("repository provider identity unavailable");
  return row;
}

async function validateProviderInfo(env: CandidatePreparationRuntimeEnv, row: RepositoryRow): Promise<ValidatedProviderInfo> {
  const repo = await getRepo(env, row.artifacts_name ?? "", row.id);
  try {
    const info = await withTimeout(env, "provider info", repo.info());
    return providerInfoFromReadback(env, row, info);
  } finally {
    disposeRepo(repo);
  }
}

function providerInfoFromReadback(env: CandidatePreparationRuntimeEnv, row: RepositoryRow, info: WorkersArtifactsRepoInfo): ValidatedProviderInfo {
  const artifactsName = row.artifacts_name;
  if (typeof artifactsName !== "string" || info.name !== artifactsName || !providerRepositoryNamePattern.test(info.name)) throw unavailable("provider identity mismatch");
  assertId("providerNamespace", env.GFY_GIT_NAMESPACE);
  const remote = new URL(info.remote);
  if (remote.protocol !== "https:" || remote.username || remote.password || remote.search || remote.hash) throw unavailable("provider remote must be a secure scoped URL");
  const encodedPath = `/git/${encodeURIComponent(env.GFY_GIT_NAMESPACE)}/${encodeURIComponent(info.name)}.git`;
  const plainPath = `/git/${env.GFY_GIT_NAMESPACE}/${info.name}.git`;
  if (remote.pathname !== encodedPath && remote.pathname !== plainPath) throw unavailable("provider remote path mismatch");
  return { namespace: env.GFY_GIT_NAMESPACE, repository: info.name, providerRepositoryId: `${env.GFY_GIT_NAMESPACE}/${info.name}`, remoteUrl: remote.toString(), hostname: remote.hostname };
}

function sourceDescriptor(candidate: MergeCandidatePrepareInput, row: RepositoryRow, info: ValidatedProviderInfo, role: SourcePackRole, ref: string, expectedOid: string): RepositorySource {
  const discriminator = role === "source_target_pack" ? "target" : "head";
  const digest = sha256(canonicalJson([candidate.tenantId, candidate.repositoryId, candidate.operationId, row.id, role, ref, expectedOid])).slice(0, 32);
  return { role, repositoryId: row.id, ref, expectedOid, fenceToken: candidate.fenceToken, row, info, operationId: `src-${discriminator}-${digest}`, commandId: `src-${discriminator}-${digest}` };
}

async function captureSourcePack(env: CandidatePreparationRuntimeEnv, source: RepositorySource): Promise<StoredSourcePack> {
  const token = await issueReadToken(env, source);
  let failure: unknown;
  let pack: StoredSourcePack | undefined;
  try {
    const proof = makeProof(env);
    const remainingLifetimeMs = token.expiresAtMs - nowMs(env);
    if (remainingLifetimeMs <= sourceDeadlineMs + 1_000) throw unavailable("source token lifetime insufficient");
    const frame = buildSourcePackRequest({ tenantId: source.row.tenant_id, repositoryId: source.repositoryId, operationId: source.operationId, fenceToken: source.fenceToken, providerRepositoryId: source.info.providerRepositoryId, ref: source.ref, expectedOid: source.expectedOid, role: source.role, remoteUrl: source.info.remoteUrl, username: "gitfoundry-trusted-helper", password: token.plaintext, opaqueProof: proof, allowWrite: false });
    const body: TrustedSourceHelperRequest = {
      commandId: source.commandId,
      tenantId: source.row.tenant_id,
      repositoryId: source.repositoryId,
      operationId: source.operationId,
      fenceToken: source.fenceToken,
      deadlineMs: sourceDeadlineMs,
      cwd: `/work/${source.row.tenant_id}/${source.repositoryId}/${source.operationId}/trusted-git`,
      providerId,
      providerRepositoryId: source.info.providerRepositoryId,
      operation: { kind: "produce_source_pack", remoteUrl: source.info.remoteUrl, ref: source.ref, expectedOid: source.expectedOid, role: source.role },
      credential: { tenantId: source.row.tenant_id, repositoryId: source.repositoryId, providerId, providerRepositoryId: source.info.providerRepositoryId, username: "gitfoundry-trusted-helper", password: token.plaintext, expiresAtMs: token.expiresAtMs },
      artifactsEgress: { allowedProviderHostname: source.info.hostname, namespace: source.info.namespace, repository: source.info.repository, artifactsRemoteUrl: source.info.remoteUrl, opaqueProof: proof, allowWrite: false },
      egressProfile: sourceEgressProfile
    };
    const receipt = await postTrustedHelper(env, stableDoName("source", source.row.tenant_id, source.repositoryId, source.operationId), "/linux/trusted-git-helper", body, "source helper", helperTimeoutMs(env, sourceDeadlineMs));
    validateSourceReceipt(env, receipt, body);
    const result = parseSourcePackResult(receipt.stdout, frame);
    validateStoredSourcePack(env, receipt.sourcePack, frame, result);
    pack = receipt.sourcePack;
  } catch (error) { failure = error; }
  const cleanupError = await cleanupIssuedTokens(env, [{ artifactsName: source.row.artifacts_name ?? "", revokeId: token.revokeId, plaintext: token.plaintext }]);
  if (cleanupError) throw cleanupError;
  if (failure) throw failure;
  if (!pack) throw unavailable("source artifact missing");
  return pack;
}

async function prepareCandidate(env: CandidatePreparationRuntimeEnv, candidate: MergeCandidatePrepareInput, sources: CandidateSources, frameRequestSha256: string): Promise<PreparedCandidateOutcome> {
  const digests = candidateRequestDigests(sources, frameRequestSha256);
  const receipt = await postTrustedHelper(env, stableDoName("candidate", candidate.tenantId, candidate.repositoryId, candidate.operationId), "/linux/merge-candidate", { candidate, sources }, "candidate helper", helperTimeoutMs(env, candidateDeadlineMs));
  validateCandidateReceiptBase(env, receipt, candidate, digests.replayRequestSha256);
  const result = parseMergeCandidateResult(receipt.stdout, candidate);
  validateCandidateReceiptStatus(receipt, result);
  const reviewedDiff = validateReviewedDiffEvidence(receipt.reviewedDiff, candidate);
  if (!result.ok) return { result, reviewedDiff };
  validateStoredCandidate(env, receipt.mergeCandidate, candidate, result, digests.frameRequestSha256);
  if (canonicalJson(receipt.mergeCandidate.reviewedDiff) !== canonicalJson(reviewedDiff)) throw unavailable("candidate reviewed diff receipt mismatch");
  return { result, reviewedDiff, candidate: receipt.mergeCandidate };
}

async function postTrustedHelper(env: CandidatePreparationRuntimeEnv, identity: string, path: string, body: unknown, label: string, timeoutMs: number): Promise<TrustedGitReceipt> {
  const stub = env.TRUSTED_GIT_HELPER.get(env.TRUSTED_GIT_HELPER.idFromName(identity));
  const response = await withTimeout(env, label, stub.fetch(`https://trusted-git-helper.internal${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { timeoutMs });
  if (!response.ok) throw unavailable(`${label} unavailable`);
  const payload: unknown = JSON.parse(await collectResponseText(response, label, 65_536, timeoutMs));
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.receipt)) throw unavailable(`${label} response invalid`);
  return payload.receipt as unknown as TrustedGitReceipt;
}

function validateSourceReceipt(env: CandidatePreparationRuntimeEnv, receipt: TrustedGitReceipt, request: TrustedSourceHelperRequest): void {
  validateReceiptCommon(env, receipt, { commandId: request.commandId, tenantId: request.tenantId, repositoryId: request.repositoryId, operationId: request.operationId, fenceToken: request.fenceToken, egress: sourceEgressProfile, status: "succeeded" });
  if (receipt.exitCode !== 0) throw unavailable("source helper failed");
  if (!receipt.sourcePack) throw unavailable("source helper did not store source artifacts");
}

function validateStoredSourcePack(env: CandidatePreparationRuntimeEnv, source: StoredSourcePack | undefined, frame: SourcePackFrame, result: SourcePackResult): asserts source is StoredSourcePack {
  if (!source) throw unavailable("source artifact missing");
  if (canonicalJson(source.public) !== canonicalJson(frame.public)) throw unavailable("source public identity mismatch");
  validateLocator(env, source.manifest, frame.public.tenant_id, frame.public.repository_id, frame.public.operation_id, frame.requestSha256, "source_manifest", result.manifestSha256);
  validateLocator(env, source.pack, frame.public.tenant_id, frame.public.repository_id, frame.public.operation_id, frame.requestSha256, frame.public.role, result.packSha256, result.packSizeBytes);
}

function validateCandidateReceiptBase(env: CandidatePreparationRuntimeEnv, receipt: TrustedGitReceipt, input: MergeCandidatePrepareInput, expectedCandidateRequestSha256: string): void {
  validateReceiptCommon(env, receipt, { commandId: input.commandId, tenantId: input.tenantId, repositoryId: input.repositoryId, operationId: input.operationId, fenceToken: input.fenceToken, egress: candidateEgressProfile });
  if (receipt.exitCode !== 0) throw unavailable("candidate helper failed");
  if (receipt.candidateRequestSha256 !== expectedCandidateRequestSha256) throw unavailable("candidate request source repository identity mismatch");
}

function validateCandidateReceiptStatus(receipt: TrustedGitReceipt, result: MergeCandidateResult): void {
  const expectedStatus = result.ok ? "succeeded" : "failed";
  if (receipt.status !== expectedStatus) throw unavailable("candidate receipt status mismatch");
}

function validateStoredCandidate(env: CandidatePreparationRuntimeEnv, candidate: StoredMergeCandidate | undefined, input: MergeCandidatePrepareInput, result: Extract<MergeCandidateResult, { ok: true }>, requestSha256: string): asserts candidate is StoredMergeCandidate {
  if (!candidate) throw unavailable("candidate artifacts missing");
  if (candidate.requestSha256 !== requestSha256) throw unavailable("candidate request identity mismatch");
  if (canonicalJson(candidate.result) !== canonicalJson(result)) throw unavailable("candidate result identity mismatch");
  validateLocator(env, candidate.manifest, input.tenantId, input.repositoryId, input.operationId, requestSha256, "candidate_manifest");
  validateLocator(env, candidate.rawCommit, input.tenantId, input.repositoryId, input.operationId, requestSha256, "candidate_raw_commit", result.candidateBytesSha256);
  validateLocator(env, candidate.pack, input.tenantId, input.repositoryId, input.operationId, requestSha256, "candidate_pack");
  validateReviewedDiffEvidence(candidate.reviewedDiff, input);
}

function validateReviewedDiffEvidence(value: unknown, input: Pick<MergeCandidatePrepareInput, "headSha" | "baseSha">): ReviewedDiffEvidence {
  if (!isRecord(value)) throw unavailable("reviewed diff evidence missing");
  exactKeys(value, ["algorithmVersion", "comparison", "contextLines", "headSha", "baseSha", "mergeBaseShas", "patchSha256", "patchSizeBytes", "changedPathsSha256"], "reviewed diff");
  if (value.algorithmVersion !== "git-cli-unified-v1" || value.comparison !== "three_dot" || value.contextLines !== 3 || value.headSha !== input.headSha || value.baseSha !== input.baseSha) throw unavailable("reviewed diff evidence identity mismatch");
  if (!Array.isArray(value.mergeBaseShas) || value.mergeBaseShas.length < 1 || value.mergeBaseShas.length > 64 || new Set(value.mergeBaseShas).size !== value.mergeBaseShas.length || value.mergeBaseShas.some((oid) => typeof oid !== "string" || !/^[0-9a-f]{40}$/u.test(oid))) throw unavailable("reviewed diff merge bases invalid");
  return { algorithmVersion: "git-cli-unified-v1", comparison: "three_dot", contextLines: 3, headSha: input.headSha, baseSha: input.baseSha, mergeBaseShas: [...value.mergeBaseShas], patchSha256: digest(value.patchSha256), patchSizeBytes: boundedInteger(value.patchSizeBytes, 0, 1024 * 1024, "reviewed diff patch size"), changedPathsSha256: digest(value.changedPathsSha256) };
}

function validateReceiptCommon(env: CandidatePreparationRuntimeEnv, receipt: TrustedGitReceipt, expected: { readonly commandId: string; readonly tenantId: string; readonly repositoryId: string; readonly operationId: string; readonly fenceToken: string; readonly egress: string; readonly status?: string }): void {
  if (receipt.profile !== "trusted_git_helper" || receipt.image !== trustedImage(env) || receipt.stdoutTruncated !== false || receipt.stderrTruncated !== false || receipt.cleanupRequired !== false) throw unavailable("helper receipt boundary invalid");
  if (expected.status && receipt.status !== expected.status) throw unavailable("helper receipt status mismatch");
  for (const [field, value] of Object.entries({ commandId: expected.commandId, tenantId: expected.tenantId, repositoryId: expected.repositoryId, operationId: expected.operationId, fenceToken: expected.fenceToken, egressProfile: expected.egress })) {
    if ((receipt as unknown as Record<string, unknown>)[field] !== value) throw unavailable("helper receipt identity mismatch");
  }
}

function validateLocator(env: CandidatePreparationRuntimeEnv, locator: unknown, tenantId: string, repositoryId: string, operationId: string, requestSha256: string, kind: string, sha?: string, size?: number): void {
  if (!isRecord(locator)) throw unavailable("artifact locator missing");
  exactKeys(locator, ["tenantId", "repositoryId", "operationId", "requestSha256", "kind", "key", "sha256", "sizeBytes", "etag", "version", "expiresAt"], "artifact locator");
  if (locator.tenantId !== tenantId || locator.repositoryId !== repositoryId || locator.operationId !== operationId || locator.requestSha256 !== requestSha256 || locator.kind !== kind) throw unavailable("artifact locator scope mismatch");
  if (locator.key !== `v1/tenants/${tenantId}/repositories/${repositoryId}/merge-operations/${operationId}/${requestSha256}/${kind}`) throw unavailable("artifact locator key mismatch");
  const actualSha = digest(locator.sha256);
  if (sha !== undefined && actualSha !== sha) throw unavailable("artifact locator digest mismatch");
  const actualSize = boundedInteger(locator.sizeBytes, 0, maxArtifactBytes, "artifact locator size");
  if (size !== undefined && actualSize !== size) throw unavailable("artifact locator size mismatch");
  if (typeof locator.etag !== "string" || locator.etag.length === 0 || locator.etag.length > 256 || locator.etag.includes("\u0000")) throw unavailable("artifact locator etag invalid");
  if (typeof locator.version !== "string" || locator.version.length === 0 || locator.version.length > 256 || locator.version.includes("\u0000")) throw unavailable("artifact locator version invalid");
  if (locator.expiresAt !== null && (typeof locator.expiresAt !== "string" || !Number.isFinite(Date.parse(locator.expiresAt)) || new Date(locator.expiresAt).toISOString() !== locator.expiresAt || Date.parse(locator.expiresAt) <= nowMs(env))) throw unavailable("artifact locator expiry invalid");
}

async function issueReadToken(env: CandidatePreparationRuntimeEnv, source: RepositorySource): Promise<{ readonly revokeId: string; readonly plaintext: string; readonly expiresAtMs: number }> {
  const repo = await getRepo(env, source.row.artifacts_name ?? "", source.repositoryId);
  let created: unknown;
  let issued: IssuedToken | undefined;
  let disposeFailure: unknown;
  let disposeAfterToken = true;
  try {
    created = await withTimeout(env, "provider token", repo.createToken("read", tokenTtlSeconds), { timeoutMs: providerTimeoutMs(env), onTimeout: () => { disposeAfterToken = false; }, onLate: async (lateCreated) => { try { const lateIssued = issuedTokenForCleanup(source, lateCreated); if (lateIssued) await cleanupIssuedTokens(env, [lateIssued]); } finally { disposeRepo(repo); } }, onLateReject: async () => { disposeRepo(repo); } });
    const parsed = readTokenFields(created);
    issued = issuedTokenForCleanup(source, created);
    const expiresAtMs = parsed.expiresAtMs;
    const now = nowMs(env);
    if (!parsed.id || !parsed.plaintext || parsed.scope !== "read" || !Number.isFinite(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + tokenTtlSeconds * 1000) {
      if (issued) {
        const cleanupError = await cleanupIssuedTokens(env, [issued]);
        if (cleanupError) throw cleanupError;
      }
      throw unavailable("token validation failed");
    }
    return { revokeId: parsed.id, plaintext: parsed.plaintext, expiresAtMs };
  } finally {
    if (disposeAfterToken) {
      try { disposeRepo(repo); } catch (error) { disposeFailure = error; }
      if (disposeFailure && issued) await cleanupIssuedTokens(env, [issued]);
      if (disposeFailure) throw unavailable("provider handle cleanup failed");
    }
  }
}

async function cleanupIssuedTokens(env: CandidatePreparationRuntimeEnv, issued: readonly IssuedToken[]): Promise<CandidateRuntimeUnavailableError | undefined> {
  let cleanupError: CandidateRuntimeUnavailableError | undefined;
  for (const token of issued) {
    let repo: ArtifactsRepoHandle | undefined;
    try {
      repo = await getRepo(env, token.artifactsName, token.artifactsName);
      const revoked = await withTimeout(env, "provider token revoke", repo.revokeToken(token.revokeId));
      if (revoked !== true) cleanupError ??= unavailable("cleanup failed to revoke source token");
    } catch {
      cleanupError ??= unavailable("cleanup failed to revoke source token");
    } finally {
      if (repo) { try { disposeRepo(repo); } catch { cleanupError ??= unavailable("cleanup failed to dispose provider handle"); } }
    }
  }
  return cleanupError;
}

async function getRepo(env: CandidatePreparationRuntimeEnv, artifactsName: string, repositoryId: string): Promise<ArtifactsRepoHandle> {
  if (!env.GFY_GIT) throw unavailable("Artifacts binding unavailable");
  try {
    return await withTimeout(env, "provider repository", env.GFY_GIT.get(artifactsName), { timeoutMs: providerTimeoutMs(env), onLate: async (repo) => { disposeRepo(repo); } });
  } catch {
    throw unavailable(`Artifacts repository unavailable: ${repositoryId}`);
  }
}

function candidateRequestDigests(sources: CandidateSources, frameRequestSha256: string): CandidateRequestDigests {
  const sourcesJson = canonicalJson(sources);
  if (new TextEncoder().encode(sourcesJson).length > 65_536) throw unavailable("candidate source descriptor bound exceeded");
  return { frameRequestSha256, replayRequestSha256: sha256(frameRequestSha256 + "\n" + sourcesJson) };
}

function makeProof(env: CandidatePreparationRuntimeEnv): string {
  const proof = env.proofFactory?.() ?? createHash("sha256").update(randomBytes(32)).digest("hex");
  if (!proofPattern.test(proof)) throw unavailable("Artifacts egress proof invalid");
  return proof;
}

function stableDoName(kind: string, tenantId: string, repositoryId: string, operationId: string): string {
  const digest = sha256(canonicalJson([kind, tenantId, repositoryId, operationId]));
  return `trusted-git-${kind}-${digest.slice(0, 48)}`;
}

function trustedImage(env: CandidatePreparationRuntimeEnv): string {
  if (typeof env.GFY_TRUSTED_GIT_HELPER_IMAGE !== "string" || !imageDigestPattern.test(env.GFY_TRUSTED_GIT_HELPER_IMAGE)) throw unavailable("trusted helper image unavailable");
  return env.GFY_TRUSTED_GIT_HELPER_IMAGE;
}

function assertId(name: string, value: string): void {
  if (!idPattern.test(value) || value.includes("..")) throw unavailable(`${name} invalid`);
}

function assertGitRef(name: string, value: string): void {
  if (typeof value !== "string" || value.length > 256 || !/^refs\/(heads|tags)\/[A-Za-z0-9._\/-]+$/u.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".lock")) throw unavailable(`${name} invalid`);
}

function disposeRepo(repo: ArtifactsRepoHandle): void {
  const disposable = repo as Partial<Record<typeof Symbol.dispose, () => void>>;
  disposable[Symbol.dispose]?.();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw unavailable(`${label} fields invalid`);
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw unavailable(`${label} outside bound`);
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw unavailable("digest invalid");
  return value;
}

type TimeoutOptions<T> = { readonly timeoutMs?: number; readonly onTimeout?: () => void; readonly onLate?: (value: T) => Promise<void> | void; readonly onLateReject?: () => Promise<void> | void };

async function withTimeout<T>(env: CandidatePreparationRuntimeEnv, label: string, promise: Promise<T>, options: TimeoutOptions<T> = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? providerTimeoutMs(env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let retained = false;
  const retainLate = () => {
    if (retained) return;
    retained = true;
    retainWaitUntil(env, promise.then(async (value) => { await options.onLate?.(value); }, async () => { await options.onLateReject?.(); }));
  };
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => { timedOut = true; options.onTimeout?.(); retainLate(); reject(unavailable(`${label} timed out`)); }, timeoutMs);
      promise.then((value) => { if (timer) clearTimeout(timer); if (!timedOut) resolve(value); }, (error) => { if (timer) clearTimeout(timer); if (!timedOut) reject(error); });
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function configuredTimeoutMs(env: CandidatePreparationRuntimeEnv): number | undefined {
  const value = (env as { readonly operationTimeoutMs?: unknown }).operationTimeoutMs;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function providerTimeoutMs(env: CandidatePreparationRuntimeEnv): number {
  return configuredTimeoutMs(env) ?? providerOperationTimeoutMs;
}

function helperTimeoutMs(env: CandidatePreparationRuntimeEnv, deadlineMs: number): number {
  return configuredTimeoutMs(env) ?? deadlineMs + helperDeadlineAllowanceMs;
}

function nowMs(env: CandidatePreparationRuntimeEnv): number {
  return (env.clock?.now() ?? new Date()).getTime();
}

function retainWaitUntil(env: CandidatePreparationRuntimeEnv, promise: Promise<unknown>): void {
  const retained = promise.catch(() => undefined);
  try { env.waitUntil?.(retained); } catch { /* best-effort late cleanup retention */ }
}

function readTokenFields(created: unknown): { readonly id: string; readonly plaintext: string; readonly scope: string; readonly expiresAtMs: number } {
  const raw = isRecord(created) ? created : {};
  const id = typeof raw.id === "string" ? raw.id : typeof raw.token_id === "string" ? raw.token_id : "";
  const plaintext = typeof raw.plaintext === "string" ? raw.plaintext : "";
  const scope = typeof raw.scope === "string" ? raw.scope : "";
  const expiresAt = typeof raw.expiresAt === "string" ? raw.expiresAt : typeof raw.expires_at === "string" ? raw.expires_at : "";
  return { id, plaintext, scope, expiresAtMs: Date.parse(expiresAt) };
}

function issuedTokenForCleanup(source: RepositorySource, created: unknown): IssuedToken | undefined {
  const fields = readTokenFields(created);
  return fields.id || fields.plaintext ? { artifactsName: source.row.artifacts_name ?? "", revokeId: fields.id || fields.plaintext, plaintext: fields.plaintext } : undefined;
}

async function collectResponseText(response: Response, label: string, maxBytes: number, timeoutMs: number): Promise<string> {
  if (!response.body) throw unavailable(`${label} response body missing`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const next = await readWithDeadline(reader, deadline, label).catch(async (error) => { timedOut = true; await reader.cancel(error).catch(() => undefined); throw error; });
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(unavailable(`${label} response bound exceeded`)).catch(() => undefined); throw unavailable(`${label} response bound exceeded`); }
      chunks.push(next.value);
    }
  } finally {
    if (!timedOut) reader.releaseLock();
  }
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(out);
}

async function readWithDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, deadline: number, label: string): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw unavailable(`${label} response timed out`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = reader.read();
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable(`${label} response timed out`)), remainingMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unavailable(message: string): CandidateRuntimeUnavailableError {
  return new CandidateRuntimeUnavailableError(message);
}
