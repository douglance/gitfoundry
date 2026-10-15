import { createHash } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
import type { GitArtifactsEgressCapability } from "../git-egress/index.js";
import { CandidateArtifactStore } from "../merge-candidate/artifact-store.js";
import { buildMergeCandidateAdmission, type MergeCandidatePrepareInput, type MergeCandidateResult } from "../merge-candidate/index.js";
import { prepareStoredMergeCandidate, type CandidateSources, type StoredMergeCandidate, type ReviewedDiffEvidence } from "../merge-candidate/pipeline.js";
import { buildSourcePackRequest, canonicalJson, captureSourcePackArtifacts, parseSourcePackResult, type SourcePackFrame, type StoredSourcePack } from "../merge-candidate/source-packs.js";
import { buildCandidateCiAdmission, runCandidateCi, type CandidateCiBinding } from "../candidate-ci/index.js";

export type LinuxExecutionProfile = "trusted_git_helper" | "untrusted_ci_job";
export type LinuxEgressProfile = "deny_all" | "gfy_internal_only";
export type LinuxExecutionStatus = "succeeded" | "failed" | "canceled" | "timed_out" | "unsupported" | "rejected";

export interface LinuxExecutionEnv {
  readonly GFY_TRUSTED_GIT_HELPER_IMAGE?: string;
  readonly GFY_UNTRUSTED_CI_IMAGE?: string;
  readonly GFY_LINUX_MAX_OUTPUT_BYTES?: string;
  readonly GFY_INTERNAL_ARTIFACTS?: Fetcher;
  readonly GFY_INTERNAL_LOGS?: Fetcher;
  readonly GFY_ARTIFACTS?: R2Bucket;
  readonly GFY_DB?: D1Database;
}

export interface LinuxExecAdmissionRequest {
  readonly commandId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly operationId: string;
  readonly fenceToken: string;
  readonly deadlineMs: number;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env?: Record<string, string>;
  readonly stdinRef?: string;
  readonly stdoutRef?: string;
  readonly stderrRef?: string;
  readonly journalRef?: string;
  readonly egressProfile?: LinuxEgressProfile;
  readonly leaseId?: string;
  readonly leaseGeneration?: number;
  readonly refName?: string;
  readonly expectedOldOid?: string;
  readonly candidateNewOid?: string;
  readonly quarantinePrefix?: string;
  readonly policyEpoch?: number;
  readonly artifactRepoId?: string;
}

export type TrustedGitOperation =
  | { readonly kind: "ls_remote"; readonly remoteUrl: string; readonly ref?: string }
  | { readonly kind: "fetch_ref"; readonly remoteUrl: string; readonly ref: string; readonly targetRef: string }
  | { readonly kind: "produce_source_pack"; readonly remoteUrl: string; readonly ref: string; readonly expectedOid: string; readonly role: "source_target_pack" | "source_head_pack" };

export interface TrustedGitRepositoryCredential {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly providerId: string;
  readonly providerRepositoryId: string;
  readonly username: string;
  readonly password: string;
  readonly expiresAtMs: number;
}

export interface TrustedGitHelperRequest {
  readonly commandId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly operationId: string;
  readonly fenceToken: string;
  readonly deadlineMs: number;
  readonly cwd: string;
  readonly providerId: string;
  readonly providerRepositoryId: string;
  readonly operation: TrustedGitOperation;
  readonly credential: TrustedGitRepositoryCredential;
  readonly artifactsEgress?: GitArtifactsEgressCapability;
  readonly egressProfile?: LinuxEgressProfile;
  readonly leaseId?: string;
  readonly leaseGeneration?: number;
}

export interface LinuxExecAdmission {
  readonly profile: LinuxExecutionProfile;
  readonly commandId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly operationId: string;
  readonly fenceToken: string;
  readonly deadlineMs: number;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly egressProfile: LinuxEgressProfile;
  readonly containerIdentity: string;
  readonly image: string;
  readonly supervisorArgv: readonly string[];
  readonly startup: ContainerStartupOptions & { readonly image: string };
  readonly receiptBase: LinuxReceiptBase;
}

export interface LinuxReceiptBase {
  readonly commandId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly operationId: string;
  readonly fenceToken: string;
  readonly profile: LinuxExecutionProfile;
  readonly containerIdentity: string;
  readonly leaseId?: string;
  readonly leaseGeneration?: number;
  readonly journalRef?: string;
}

export interface LinuxExecReceipt extends LinuxReceiptBase {
  readonly status: LinuxExecutionStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly image: string;
  readonly egressProfile: LinuxEgressProfile;
  readonly attemptGeneration: number;
  readonly cleanupRequired: boolean;
  readonly cleanupError?: string;
  readonly unsupportedReason?: string;
  readonly sourcePack?: StoredSourcePack;
  readonly mergeCandidate?: StoredMergeCandidate;
  readonly reviewedDiff?: ReviewedDiffEvidence;
  readonly candidateRequestSha256?: string;
  readonly candidateCiRequestSha256?: string;
  readonly candidateCi?: CandidateCiBinding;
}

export interface LinuxActiveAttempt extends LinuxReceiptBase {
  readonly attemptGeneration: number;
  readonly deadlineAtMs: number;
  readonly alarmAtMs: number;
  readonly startedAt: string;
  readonly admission: LinuxExecAdmission;
  readonly candidateRequestSha256?: string;
  readonly candidateCiRequestSha256?: string;
}

export class LinuxExecutionAdmissionError extends Error {
  readonly name = "LinuxExecutionAdmissionError";
  constructor(readonly code: "unsupported_profile" | "invalid_request" | "unsupported_command" | "credential_env_denied" | "credential_request_denied" | "invalid_cwd" | "image_unconfigured" | "unsupported_io_ref", message: string) { super(message) }
}

const activeAttemptKey = "linux.activeAttempt";
const destroyWaitMs = 30_000;
const destroyPollMs = 250;
const attemptGenerationKey = "linux.attemptGeneration";
const receiptKeyPrefix = "linux.receipt.";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const oidPattern = /^[0-9a-f]{40}$/;
const imageDigestPattern = /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;
const maxDeadlineMs = 15 * 60 * 1000;
const killAfterMs = 5000;
const defaultMaxOutputBytes = 256 * 1024;
const maxPrivateCredentialBytes = 8 * 1024;
const maxCredentialLifetimeMs = 15 * 60 * 1000;
const proofPattern = /^[A-Za-z0-9._~:-]{16,512}$/;
const containerWorkRoot = "/work";
const safePath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const internalHosts = ["gitfoundry-artifacts.internal", "gitfoundry-logs.internal"] as const;
const trustedCommands = new Set(["/usr/local/bin/gitfoundry-hydrate-source", "/usr/bin/git", "/usr/lib/git-core/git-upload-pack", "/usr/lib/git-core/git-receive-pack", "/usr/local/bin/gitfoundry-git-helper", "/usr/local/bin/gitfoundry-forge-rpc", "/usr/local/bin/gitfoundry-merge-candidate", "/usr/local/bin/gitfoundry-source-pack"]);
const ciCommands = new Set(["/usr/local/bin/gitfoundry-ci-step"]);
const commonEnvAllowlist = new Set(["GFY_TRACE_ID", "GFY_OPERATION_ID", "GFY_COMMAND_ID"]);
const trustedEnvAllowlist = new Set([...commonEnvAllowlist, "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GFY_FORGE_RPC_CA_FILE"]);
// Intercepted HTTPS reaches the container under a certificate authority the platform writes
// at start-up; Git rejects the Artifacts connection unless it trusts that authority.
const interceptedHttpsCaFile = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const ciEnvAllowlist = new Set([...commonEnvAllowlist, "CI", "GFY_STEP_ID"]);
const deniedEnvPattern = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|KEY|COOKIE|SESSION|ARTIFACTS|CLOUDFLARE|CF|AWS|GITHUB|GITLAB|SSH|DEPLOY)(?:_|$)/i;

export class TrustedGitHelperDO extends DurableObject<LinuxExecutionEnv> {
  async fetch(request: Request): Promise<Response> { return linuxDurableObjectFetch("trusted_git_helper", this.ctx, this.env, request) }
  async alarm(): Promise<void> { await linuxExecutionAlarm(this.ctx) }
}

export class UntrustedCiJobDO extends DurableObject<LinuxExecutionEnv> {
  async fetch(request: Request): Promise<Response> { return linuxDurableObjectFetch("untrusted_ci_job", this.ctx, this.env, request) }
  async alarm(): Promise<void> { await linuxExecutionAlarm(this.ctx) }
}

export async function linuxDurableObjectFetch(profile: LinuxExecutionProfile, ctx: DurableObjectState, env: LinuxExecutionEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (profile === "trusted_git_helper" && request.method === "POST" && url.pathname === "/linux/forge-git") return executeForgeGitOperation(ctx, env, await request.json());
  if (profile === "trusted_git_helper" && request.method === "POST" && url.pathname === "/linux/trusted-git-helper") return executeTrustedGitHelperOperation(ctx, env, await request.json());
  if (profile === "trusted_git_helper" && request.method === "POST" && url.pathname === "/linux/merge-candidate") return executeStoredMergeCandidate(ctx, env, await request.json());
  if (profile === "untrusted_ci_job" && request.method === "POST" && url.pathname === "/linux/candidate-ci") return executeStoredCandidateCi(ctx, env, await request.json());
  if (request.method === "POST" && url.pathname === "/linux/exec") return executeLinuxCommand(profile, ctx, env, await request.json());
  if (request.method === "POST" && url.pathname === "/linux/cancel") return cancelLinuxCommand(ctx, await request.json());
  return Response.json({ ok: false, error: "gfy_linux_route_not_found" }, { status: 404 });
}

export function admitLinuxExecution(profile: LinuxExecutionProfile, input: unknown, env: LinuxExecutionEnv): LinuxExecAdmission {
  const request = parseAdmissionRequest(input);
  assertId("commandId", request.commandId);
  assertId("tenantId", request.tenantId);
  assertId("repositoryId", request.repositoryId);
  assertId("operationId", request.operationId);
  assertId("fenceToken", request.fenceToken);
  if (!Number.isInteger(request.deadlineMs) || request.deadlineMs < 1 || request.deadlineMs > maxDeadlineMs) throw new LinuxExecutionAdmissionError("invalid_request", "deadlineMs is outside the supported P0 range");
  const argv = normalizeArgv(profile, request.argv);
  validateUnsupportedIoRefs(request);
  const cwd = normalizeCwd(request);
  const admittedEnv = normalizeEnv(profile, request.env ?? {});
  const image = imageForProfile(profile, env);
  const egressProfile = request.egressProfile ?? "deny_all";
  if (egressProfile !== "deny_all" && egressProfile !== "gfy_internal_only") throw new LinuxExecutionAdmissionError("invalid_request", "egressProfile is not supported");
  validateGitFields(request);
  const containerIdentity = stableContainerIdentity(profile, request);
  const supervisorArgv = ["/usr/local/bin/gitfoundry-supervise", "--command-id", request.commandId, "--deadline-ms", String(request.deadlineMs), "--kill-after-ms", String(killAfterMs), "--cwd", cwd, "--", ...argv];
  const startup = { image, enableInternet: false, env: {}, labels: { "gfy.profile": profile, "gfy.command_id": containerLabelFingerprint(request.commandId), "gfy.operation_id": containerLabelFingerprint(request.operationId), "gfy.fence_token": containerLabelFingerprint(request.fenceToken) } } satisfies ContainerStartupOptions;
  const receiptBase = makeReceiptBase(request, profile, containerIdentity);
  return { profile, commandId: request.commandId, tenantId: request.tenantId, repositoryId: request.repositoryId, operationId: request.operationId, fenceToken: request.fenceToken, deadlineMs: request.deadlineMs, cwd, argv, env: admittedEnv, egressProfile, containerIdentity, image, supervisorArgv, startup, receiptBase };
}

export async function executeLinuxCommand(profile: LinuxExecutionProfile, ctx: DurableObjectState, env: LinuxExecutionEnv, input: unknown): Promise<Response> {
  let admission: LinuxExecAdmission;
  try { admission = admitLinuxExecution(profile, input, env) } catch (error) { return admissionErrorResponse(error) }
  return executeAdmittedLinuxCommand(ctx, env, admission);
}

export async function executeTrustedGitHelperOperation(ctx: DurableObjectState, env: LinuxExecutionEnv, input: unknown): Promise<Response> {
  let parsed: { readonly request: LinuxExecAdmissionRequest; readonly stdin: string; readonly redactions: readonly string[]; readonly artifactsEgress?: GitArtifactsEgressCapability; readonly sourcePack?: SourcePackFrame };
  let admission: LinuxExecAdmission;
  try {
    parsed = parseTrustedGitHelperRequest(input);
    admission = admitLinuxExecution("trusted_git_helper", parsed.request, env);
  } catch (error) { return admissionErrorResponse(error) }
  if (parsed.sourcePack && (!env.GFY_ARTIFACTS || !env.GFY_DB)) return Response.json({ ok: false, error: "gfy_source_artifact_store_unavailable" }, { status: 503 });
  const privateInput = { stdin: parsed.stdin, redactions: parsed.redactions, ...(parsed.artifactsEgress === undefined ? {} : { artifactsEgress: parsed.artifactsEgress }), ...(parsed.sourcePack === undefined ? {} : { sourcePack: parsed.sourcePack }) };
  return executeAdmittedLinuxCommand(ctx, env, admission, privateInput);
}


export async function executeForgeGitOperation(ctx: DurableObjectState, env: LinuxExecutionEnv, input: unknown): Promise<Response> {
  try {
    if (!isRecord(input) || "argv" in input || "env" in input) throw new LinuxExecutionAdmissionError("invalid_request", "forge RPC body invalid");
    const base = readTrustedGitBase(input);
    if (base.providerId !== "cloudflare-artifacts" || !isRecord(input.operation) || input.operation.kind !== "forge_rpc") throw new LinuxExecutionAdmissionError("invalid_request", "forge RPC provider invalid");
    const remoteUrl = normalizeGitRemoteUrl(readRequiredString(input.operation, "remoteUrl"));
    const method = readRequiredString(input.operation, "method");
    const allowed = new Set(["readRef", "listRefs", "readFile", "listTree", "writeCommit", "compareCommits", "mergeCommits", "compareAndSwapRef", "compareAndSwapRefs", "isAncestor"]);
    if (!allowed.has(method) || !Array.isArray(input.operation.args)) throw new LinuxExecutionAdmissionError("unsupported_command", "forge RPC method invalid");
    const credential = readTrustedGitCredential(input.credential);
    assertExactCredentialIdentity(base, credential);
    const artifactsEgress = readArtifactsEgressCapability(input.artifactsEgress, base, { kind: "ls_remote", remoteUrl });
    if (!artifactsEgress) throw new LinuxExecutionAdmissionError("credential_request_denied", "forge RPC requires scoped Artifacts egress");
    const mutates = method === "writeCommit" || method === "mergeCommits" || method === "compareAndSwapRef" || method === "compareAndSwapRefs";
    if (mutates && !artifactsEgress.allowWrite) throw new LinuxExecutionAdmissionError("credential_request_denied", "forge RPC mutation requires write egress");
    const stdin = JSON.stringify({ method, args: input.operation.args, remote: remoteUrl, allowed_hostname: artifactsEgress.allowedProviderHostname, username: credential.username, password: credential.password, proof: artifactsEgress.opaqueProof, expires_at_ms: credential.expiresAtMs });
    if (new TextEncoder().encode(stdin).byteLength > 1024 * 1024) throw new LinuxExecutionAdmissionError("invalid_request", "forge RPC frame exceeds bound");
    const admission = admitLinuxExecution("trusted_git_helper", { commandId: base.commandId, tenantId: base.tenantId, repositoryId: base.repositoryId, operationId: base.operationId, fenceToken: base.fenceToken, deadlineMs: base.deadlineMs, cwd: base.cwd, argv: ["/usr/local/bin/gitfoundry-forge-rpc"], env: { GFY_FORGE_RPC_CA_FILE: interceptedHttpsCaFile }, egressProfile: "gfy_internal_only" }, env);
    const redactions = [credential.username, credential.password, artifactsEgress.opaqueProof, base64Encode(credential.username), base64Encode(credential.password), base64Encode(credential.username + ":" + credential.password)];
    return await executeAdmittedLinuxCommand(ctx, env, admission, { stdin, redactions, artifactsEgress });
  } catch (error) { return admissionErrorResponse(error); }
}

export interface StoredMergeCandidateRequest { readonly candidate: MergeCandidatePrepareInput; readonly sources: CandidateSources }
export async function executeStoredCandidateCi(ctx: DurableObjectState, env: LinuxExecutionEnv, input: unknown): Promise<Response> {
  let parts: ReturnType<typeof buildCandidateCiAdmission>;
  let admission: LinuxExecAdmission;
  try {
    parts = buildCandidateCiAdmission(input);
    admission = admitLinuxExecution("untrusted_ci_job", parts.linuxRequest, env);
  } catch (error) {
    return Response.json({ok:false,error:"gfy_candidate_ci_invalid_request",message:error instanceof Error ? error.message : String(error)}, {status:400});
  }
  if (!env.GFY_ARTIFACTS || !env.GFY_DB) return Response.json({ok:false,error:"gfy_candidate_artifact_store_unavailable"}, {status:503});
  return executeAdmittedLinuxCommand(ctx,env,admission,{stdin:"",redactions:[],candidateCi:parts,candidateCiRequestSha256:parts.requestSha256});
}

export async function executeStoredMergeCandidate(ctx: DurableObjectState, env: LinuxExecutionEnv, input: unknown): Promise<Response> {
  let admission: LinuxExecAdmission;
  let request: StoredMergeCandidateRequest;
  let candidateRequestSha256: string;
  try {
    if (!isRecord(input) || Object.keys(input).sort().join(",") !== "candidate,sources" || !isRecord(input.candidate) || !isRecord(input.sources)) throw new LinuxExecutionAdmissionError("invalid_request", "stored candidate request fields invalid");
    const fields = ["commandId","tenantId","repositoryId","operationId","fenceToken","pullRequestId","pullRequestVersion","headSha","baseSha","method","committerName","committerEmail","committedAt","message"];
    if (Object.keys(input.candidate).sort().join(",") !== fields.sort().join(",") || Object.keys(input.sources).sort().join(",") !== "head,sourceRepositoryId,target") throw new LinuxExecutionAdmissionError("invalid_request", "stored candidate input fields invalid");
    request = input as unknown as StoredMergeCandidateRequest;
    const frame = buildMergeCandidateAdmission(request.candidate, env);
    admission = frame.admission;
    const sources = canonicalJson(request.sources);
    if (new TextEncoder().encode(sources).length > 65536) throw new LinuxExecutionAdmissionError("invalid_request","candidate source descriptor bound exceeded");
    candidateRequestSha256 = createHash("sha256").update(frame.requestSha256+"\n"+sources).digest("hex");
  } catch (error) {
    return Response.json({ok:false,error:"gfy_candidate_invalid_request",message:error instanceof Error ? error.message : String(error)}, {status:400});
  }
  if (!env.GFY_ARTIFACTS || !env.GFY_DB) return Response.json({ok:false,error:"gfy_candidate_artifact_store_unavailable"}, {status:503});
  return executeAdmittedLinuxCommand(ctx,env,admission,{stdin:"",redactions:[],mergeCandidate:request,candidateRequestSha256});
}

function mergeCandidateResultStdout(result: MergeCandidateResult, input: MergeCandidatePrepareInput): string {
  const common = { frame: "gitfoundry.merge-candidate.result.v1", tenant_id: input.tenantId, repository_id: input.repositoryId, operation_id: input.operationId, pull_request_id: input.pullRequestId, pull_request_version: input.pullRequestVersion, method: input.method, head_sha: input.headSha, base_sha: input.baseSha, ok: result.ok, status: result.status, git_version: result.gitVersion, state_ref: result.stateRef };
  return JSON.stringify(result.ok ? { ...common, candidate_oid: result.candidateOid, candidate_tree: result.candidateTree, candidate_bytes_sha256: result.candidateBytesSha256, original_to_rebased: result.originalToRebased } : { ...common, diagnostics: result.diagnostics }) + "\n";
}

async function executeAdmittedLinuxCommand(ctx: DurableObjectState, env: LinuxExecutionEnv, admission: LinuxExecAdmission, privateInput?: { readonly stdin: string; readonly redactions: readonly string[]; readonly artifactsEgress?: GitArtifactsEgressCapability; readonly sourcePack?: SourcePackFrame; readonly mergeCandidate?: StoredMergeCandidateRequest; readonly candidateRequestSha256?: string; readonly candidateCi?: ReturnType<typeof buildCandidateCiAdmission>; readonly candidateCiRequestSha256?: string }): Promise<Response> {
  const container = ctx.container;
  if (!container) return Response.json({ ok: false, error: "gfy_linux_container_unavailable" }, { status: 503 });

  const replayed = await readReceipt(ctx, admission.containerIdentity);
  if (replayed && privateInput?.mergeCandidate && replayed.candidateRequestSha256 !== privateInput.candidateRequestSha256) return Response.json({ok:false,error:"gfy_candidate_replay_request_conflict"},{status:409});
  if (replayed && privateInput?.candidateCi && replayed.candidateCiRequestSha256 !== privateInput.candidateCiRequestSha256) return Response.json({ok:false,error:"gfy_candidate_ci_replay_request_conflict"},{status:409});
  if (replayed) return Response.json({ ok: !replayed.cleanupRequired, replayed: true, receipt: replayed }, { status: replayed.cleanupRequired ? 409 : 200 });

  const active = await readActiveAttempt(ctx);
  if (active) return Response.json({ ok: false, error: "gfy_linux_active_attempt_exists", active: publicActiveAttempt(active) }, { status: 409 });

  const attemptGeneration = await nextAttemptGeneration(ctx);
  const current = {...makeActiveAttempt(admission, attemptGeneration, Date.now()),...(privateInput?.candidateRequestSha256===undefined?{}:{candidateRequestSha256:privateInput.candidateRequestSha256}),...(privateInput?.candidateCiRequestSha256===undefined?{}:{candidateCiRequestSha256:privateInput.candidateCiRequestSha256})};
  await persistActiveAttempt(ctx, current);

  try {
    await startDedicatedContainer(ctx, container, admission, env, privateInput?.artifactsEgress);
    await verifyStartedContainerImage(container, admission);
    if (privateInput && !privateInput.candidateCi) await preparePrivateWorkspace(container, admission, env);
    if (privateInput?.candidateCi) {
      const run = await runCandidateCi(container,privateInput.candidateCi,new CandidateArtifactStore(env.GFY_ARTIFACTS!,env.GFY_DB!),{env:admission.env,supervisorArgv:admission.supervisorArgv,cwd:admission.cwd},maxOutputBytes(env));
      const racedTerminal = await readReceipt(ctx,admission.containerIdentity);
      if (racedTerminal) return Response.json({ok:!racedTerminal.cleanupRequired,replayed:true,receipt:racedTerminal},{status:racedTerminal.cleanupRequired?409:200});
      const receipt = {...makeReceipt(current,run.status,run.exitCode,run.stdout,run.stderr,new Date().toISOString()),candidateCi:run.binding};
      const finalized = await finalizeAttemptWithContainerDestroy(ctx,current,receipt,container,"candidate CI completed "+admission.commandId);
      return Response.json({ok:!finalized.cleanupRequired,receipt:finalized},{status:finalized.cleanupRequired?409:200});
    }
    if (privateInput?.mergeCandidate) {
      const request = privateInput.mergeCandidate;
      const prepared = await prepareStoredMergeCandidate(container,request.candidate,request.sources,new CandidateArtifactStore(env.GFY_ARTIFACTS!,env.GFY_DB!),env);
      const racedTerminal = await readReceipt(ctx,admission.containerIdentity);
      if (racedTerminal) return Response.json({ok:!racedTerminal.cleanupRequired,replayed:true,receipt:racedTerminal},{status:racedTerminal.cleanupRequired?409:200});
      const stdout = {text:mergeCandidateResultStdout(prepared.result,request.candidate),truncated:false};
      const receipt = {...makeReceipt(current,prepared.result.ok?"succeeded":"failed",0,stdout,emptyCollectedStream(),new Date().toISOString()),...(prepared.candidate===undefined?{}:{mergeCandidate:prepared.candidate}),...(prepared.reviewedDiff===undefined?{}:{reviewedDiff:prepared.reviewedDiff})};
      const finalized = await finalizeAttemptWithContainerDestroy(ctx,current,receipt,container,"candidate completed "+admission.commandId);
      return Response.json({ok:!finalized.cleanupRequired,receipt:finalized},{status:finalized.cleanupRequired?409:200});
    }
    const execArgv = privateInput ? admission.argv : admission.supervisorArgv;
    const execCwd = privateInput ? admission.cwd : containerWorkRoot;
    const proc = await container.exec([...execArgv], { cwd: execCwd, env: admission.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await writeStdin(proc.stdin, privateInput?.stdin ?? "");
    const maxBytes = maxOutputBytes(env);
    const [rawStdout, rawStderr, exitCode] = await Promise.all([collectStream(proc.stdout, maxBytes), collectStream(proc.stderr, maxBytes), proc.exitCode]);
    const stdout = redactCollectedStream(rawStdout, privateInput?.redactions ?? []);
    const stderr = redactCollectedStream(rawStderr, privateInput?.redactions ?? []);
    const racedTerminal = await readReceipt(ctx, admission.containerIdentity);
    if (racedTerminal) return Response.json({ ok: !racedTerminal.cleanupRequired, replayed: true, receipt: racedTerminal }, { status: racedTerminal.cleanupRequired ? 409 : 200 });
    const status: LinuxExecutionStatus = exitCode === 0 ? "succeeded" : "failed";
    const sourcePack = privateInput?.sourcePack && exitCode === 0
      ? await captureSourcePackArtifacts(container, admission.cwd, admission.env, privateInput.sourcePack, parseSourcePackResult(rawStdout.text, privateInput.sourcePack), new CandidateArtifactStore(env.GFY_ARTIFACTS!, env.GFY_DB!))
      : undefined;
    const captureTerminal = await readReceipt(ctx, admission.containerIdentity);
    if (captureTerminal) return Response.json({ ok: !captureTerminal.cleanupRequired, replayed: true, receipt: captureTerminal }, { status: captureTerminal.cleanupRequired ? 409 : 200 });
    const receipt = { ...makeReceipt(current, status, exitCode, stdout, stderr, new Date().toISOString()), ...(sourcePack === undefined ? {} : { sourcePack }) };
    const finalized = await finalizeAttemptWithContainerDestroy(ctx, current, receipt, container, `completed ${admission.commandId}`);
    return Response.json(finalized.cleanupRequired ? { ok: false, error: "gfy_linux_cleanup_required", receipt: finalized } : { ok: true, receipt: finalized }, { status: finalized.cleanupRequired ? 409 : 200 });
  } catch (error) {
    const racedTerminal = await readReceipt(ctx, admission.containerIdentity);
    if (racedTerminal) return Response.json({ ok: !racedTerminal.cleanupRequired, replayed: true, receipt: racedTerminal }, { status: racedTerminal.cleanupRequired ? 409 : 200 });
    const diagnostic = error instanceof Error ? error.message : String(error);
    const receipt = makeReceipt(current, "failed", null, emptyCollectedStream(), { text: redactText(diagnostic, privateInput?.redactions ?? []), truncated: false }, new Date().toISOString());
    const finalized = await finalizeAttemptWithContainerDestroy(ctx, current, receipt, container, `execution error ${admission.commandId}`);
    return Response.json({ ok: false, error: finalized.cleanupRequired ? "gfy_linux_cleanup_required" : "gfy_linux_execution_failed", receipt: finalized }, { status: 500 });
  }
}

async function verifyStartedContainerImage(container: Container, admission: LinuxExecAdmission): Promise<void> {
  let info = await container.inspect();
  if (!info || info.image === "") {
    const boot = await container.exec(["/usr/bin/true"], { cwd: containerWorkRoot, env: admission.env, stdout: "ignore", stderr: "ignore" });
    if (await boot.exitCode !== 0) throw new Error("native container boot probe failed");
    info = await container.inspect();
  }
  if (info?.image !== admission.image) throw new Error("native container image does not match admitted digest");
}

async function preparePrivateWorkspace(container: Container, admission: LinuxExecAdmission, env: LinuxExecutionEnv): Promise<void> {
  const setupArgv = ["/usr/local/bin/gitfoundry-supervise", "--command-id", "private-cwd", "--deadline-ms", String(admission.deadlineMs), "--kill-after-ms", String(killAfterMs), "--cwd", admission.cwd, "--", "/usr/local/bin/gitfoundry-git-helper", "version"];
  const proc = await container.exec(setupArgv, { cwd: containerWorkRoot, env: admission.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await writeStdin(proc.stdin, "");
  const maxBytes = maxOutputBytes(env);
  const [stdout, stderr, exitCode] = await Promise.all([collectStream(proc.stdout, maxBytes), collectStream(proc.stderr, maxBytes), proc.exitCode]);
  if (exitCode !== 0) throw new Error(`private workspace preparation failed: ${stdout.text}${stderr.text}`);
}

function parseTrustedGitHelperRequest(input: unknown): { readonly request: LinuxExecAdmissionRequest; readonly stdin: string; readonly redactions: readonly string[]; readonly artifactsEgress?: GitArtifactsEgressCapability; readonly sourcePack?: SourcePackFrame } {
  if (!isRecord(input)) throw new LinuxExecutionAdmissionError("invalid_request", "trusted Git helper body must be an object");
  if ("argv" in input || "env" in input || "stdinRef" in input || "stdoutRef" in input || "stderrRef" in input || "journalRef" in input) throw new LinuxExecutionAdmissionError("invalid_request", "trusted Git helper does not accept argv, env, or external I/O refs");
  const base = readTrustedGitBase(input);
  const operation = readTrustedGitOperation(input.operation);
  const artifactsEgress = readArtifactsEgressCapability(input.artifactsEgress, base, operation);
  const credential = readTrustedGitCredential(input.credential);
  assertExactCredentialIdentity(base, credential);
  if (operation.kind === "produce_source_pack" && (artifactsEgress?.allowWrite || base.providerId !== "cloudflare-artifacts" || (base.egressProfile !== undefined && base.egressProfile !== "gfy_internal_only"))) throw new LinuxExecutionAdmissionError("credential_request_denied", "source pack requires read-only Artifacts egress");
  const sourcePack = operation.kind === "produce_source_pack" ? buildSourcePackRequest({ tenantId: base.tenantId, repositoryId: base.repositoryId, operationId: base.operationId, fenceToken: base.fenceToken, providerRepositoryId: base.providerRepositoryId, ref: operation.ref, expectedOid: operation.expectedOid, role: operation.role, remoteUrl: operation.remoteUrl, username: credential.username, password: credential.password, allowWrite: false, ...(artifactsEgress === undefined ? {} : { opaqueProof: artifactsEgress.opaqueProof }) }) : undefined;
  const argv = sourcePack?.argv ?? trustedGitArgv(operation);
  const request: Record<string, unknown> = { commandId: base.commandId, tenantId: base.tenantId, repositoryId: base.repositoryId, operationId: base.operationId, fenceToken: base.fenceToken, deadlineMs: base.deadlineMs, cwd: base.cwd, argv };
  if (sourcePack) request.egressProfile = "gfy_internal_only";
  else if (base.egressProfile !== undefined) request.egressProfile = base.egressProfile;
  if (base.leaseId !== undefined) request.leaseId = base.leaseId;
  if (base.leaseGeneration !== undefined) request.leaseGeneration = base.leaseGeneration;
  const stdin = sourcePack?.stdin ?? credentialStdin(base, credential, artifactsEgress);
  const redactions = [credential.username, credential.password, base64Encode(credential.username), base64Encode(credential.password)];
  return { request: request as unknown as LinuxExecAdmissionRequest, stdin, redactions: artifactsEgress === undefined ? redactions : [...redactions, artifactsEgress.opaqueProof, base64Encode(artifactsEgress.opaqueProof)], ...(artifactsEgress === undefined ? {} : { artifactsEgress }), ...(sourcePack === undefined ? {} : { sourcePack }) };
}

function readTrustedGitBase(input: Record<string, unknown>): Omit<TrustedGitHelperRequest, "operation" | "credential"> {
  const base: Record<string, unknown> = { commandId: readRequiredString(input, "commandId"), tenantId: readRequiredString(input, "tenantId"), repositoryId: readRequiredString(input, "repositoryId"), operationId: readRequiredString(input, "operationId"), fenceToken: readRequiredString(input, "fenceToken"), deadlineMs: readRequiredNumber(input, "deadlineMs"), cwd: readRequiredString(input, "cwd"), providerId: readRequiredString(input, "providerId"), providerRepositoryId: readRequiredString(input, "providerRepositoryId") };
  for (const key of ["commandId", "tenantId", "repositoryId", "operationId", "fenceToken", "providerId"] as const) assertId(key, String(base[key]));
  assertProviderRepositoryId(String(base.providerRepositoryId));
  const egressProfile = input.egressProfile;
  if (typeof egressProfile === "string") base.egressProfile = egressProfile;
  const leaseId = input.leaseId;
  if (typeof leaseId === "string") base.leaseId = leaseId;
  const leaseGeneration = input.leaseGeneration;
  if (typeof leaseGeneration === "number") base.leaseGeneration = leaseGeneration;
  return base as Omit<TrustedGitHelperRequest, "operation" | "credential">;
}

function readTrustedGitOperation(input: unknown): TrustedGitOperation {
  if (!isRecord(input)) throw new LinuxExecutionAdmissionError("invalid_request", "operation must be an object");
  const kind = readRequiredString(input, "kind");
  const remoteUrl = normalizeGitRemoteUrl(readRequiredString(input, "remoteUrl"));
  if (kind === "ls_remote") {
    const ref = input.ref;
    return typeof ref === "string" ? { kind, remoteUrl, ref: normalizeGitRef(ref) } : { kind, remoteUrl };
  }
  if (kind === "fetch_ref") return { kind, remoteUrl, ref: normalizeGitRef(readRequiredString(input, "ref")), targetRef: normalizeGitTargetRef(readRequiredString(input, "targetRef")) };
  if (kind === "produce_source_pack") {
    const expectedOid = readRequiredString(input, "expectedOid");
    const role = readRequiredString(input, "role");
    if (!oidPattern.test(expectedOid) || expectedOid === "0".repeat(40) || (role !== "source_target_pack" && role !== "source_head_pack")) throw new LinuxExecutionAdmissionError("invalid_request", "source pack tip or role invalid");
    return { kind, remoteUrl, ref: normalizeGitRef(readRequiredString(input, "ref")), expectedOid, role };
  }
  throw new LinuxExecutionAdmissionError("unsupported_command", `trusted Git operation ${kind} is not supported`);
}

function readTrustedGitCredential(input: unknown): TrustedGitRepositoryCredential {
  if (!isRecord(input)) throw new LinuxExecutionAdmissionError("credential_request_denied", "credential must be an object");
  const credential = { tenantId: readRequiredString(input, "tenantId"), repositoryId: readRequiredString(input, "repositoryId"), providerId: readRequiredString(input, "providerId"), providerRepositoryId: readRequiredString(input, "providerRepositoryId"), username: readRequiredString(input, "username"), password: readRequiredString(input, "password"), expiresAtMs: readRequiredNumber(input, "expiresAtMs") };
  for (const key of ["tenantId", "repositoryId", "providerId"] as const) assertId(key, credential[key]);
  assertProviderRepositoryId(credential.providerRepositoryId);
  const now = Date.now();
  if (!Number.isInteger(credential.expiresAtMs) || credential.expiresAtMs <= now || credential.expiresAtMs > now + maxCredentialLifetimeMs) throw new LinuxExecutionAdmissionError("credential_request_denied", "credential must be short-lived and unexpired");
  validateCredentialValue("username", credential.username, 256);
  validateCredentialValue("password", credential.password, 4096);
  return credential;
}

function assertExactCredentialIdentity(base: Omit<TrustedGitHelperRequest, "operation" | "credential">, credential: TrustedGitRepositoryCredential): void {
  if (credential.tenantId !== base.tenantId || credential.repositoryId !== base.repositoryId || credential.providerId !== base.providerId || credential.providerRepositoryId !== base.providerRepositoryId) throw new LinuxExecutionAdmissionError("credential_request_denied", "credential identity does not match the requested repository/provider");
}

function trustedGitArgv(operation: TrustedGitOperation): readonly string[] {
  if (operation.kind === "ls_remote") return operation.ref === undefined ? ["/usr/local/bin/gitfoundry-git-helper", "ls-remote", operation.remoteUrl] : ["/usr/local/bin/gitfoundry-git-helper", "ls-remote", operation.remoteUrl, operation.ref];
  if (operation.kind === "fetch_ref") return ["/usr/local/bin/gitfoundry-git-helper", "fetch-ref", operation.remoteUrl, operation.ref, operation.targetRef];
  throw new LinuxExecutionAdmissionError("unsupported_command", "source pack argv requires its private frame");
}

function credentialStdin(base: Omit<TrustedGitHelperRequest, "operation" | "credential">, credential: TrustedGitRepositoryCredential, artifactsEgress: GitArtifactsEgressCapability | undefined): string {
  const lines = [`version=1`, `tenantId=${base.tenantId}`, `repositoryId=${base.repositoryId}`, `providerId=${base.providerId}`, `providerRepositoryId=${base.providerRepositoryId}`, `username_b64=${base64Encode(credential.username)}`, `password_b64=${base64Encode(credential.password)}`];
  if (artifactsEgress) lines.push(`proof_b64=${base64Encode(artifactsEgress.opaqueProof)}`);
  const stdin = [...lines, ""].join("\n");
  if (new TextEncoder().encode(stdin).byteLength > maxPrivateCredentialBytes) throw new LinuxExecutionAdmissionError("credential_request_denied", "credential payload exceeds the private stdin bound");
  return stdin;
}

function readArtifactsEgressCapability(input: unknown, base: Omit<TrustedGitHelperRequest, "operation" | "credential">, operation: TrustedGitOperation): GitArtifactsEgressCapability | undefined {
  if (input === undefined) {
    if (new URL(operation.remoteUrl).protocol === "https:") throw new LinuxExecutionAdmissionError("credential_request_denied", "artifactsEgress is required for HTTPS trusted Git helper remotes");
    return undefined;
  }
  if (!isRecord(input)) throw new LinuxExecutionAdmissionError("credential_request_denied", "artifactsEgress must be an object");
  const capability = { allowedProviderHostname: readRequiredString(input, "allowedProviderHostname"), namespace: readRequiredString(input, "namespace"), repository: readRequiredString(input, "repository"), artifactsRemoteUrl: readRequiredString(input, "artifactsRemoteUrl"), opaqueProof: readRequiredString(input, "opaqueProof"), allowWrite: input.allowWrite === true };
  assertId("namespace", capability.namespace);
  assertProviderRepositoryId(capability.repository);
  if (!proofPattern.test(capability.opaqueProof)) throw new LinuxExecutionAdmissionError("credential_request_denied", "artifactsEgress proof is invalid");
  const remote = new URL(operation.remoteUrl);
  if (remote.protocol !== "https:" || remote.hostname !== capability.allowedProviderHostname) throw new LinuxExecutionAdmissionError("credential_request_denied", "artifactsEgress host must match the trusted Git remote");
  if (base.providerRepositoryId !== `${capability.namespace}/${capability.repository}`) throw new LinuxExecutionAdmissionError("credential_request_denied", "artifactsEgress scope must match providerRepositoryId");
  const expectedEncodedPath = `/git/${encodeURIComponent(capability.namespace)}/${encodeURIComponent(capability.repository)}.git`;
  const expectedPlainPath = `/git/${capability.namespace}/${capability.repository}.git`;
  if (remote.pathname !== expectedEncodedPath && remote.pathname !== expectedPlainPath) throw new LinuxExecutionAdmissionError("credential_request_denied", "trusted Git remote path must match the scoped artifacts gateway repository");
  const upstream = new URL(capability.artifactsRemoteUrl);
  if (upstream.protocol !== "https:" || upstream.hostname !== capability.allowedProviderHostname || upstream.username || upstream.password) throw new LinuxExecutionAdmissionError("credential_request_denied", "artifactsRemoteUrl is invalid");
  return capability;
}

function normalizeGitRemoteUrl(value: string): string {
  if (value.length > 2048 || value.includes("\u0000")) throw new LinuxExecutionAdmissionError("invalid_request", "remoteUrl is invalid");
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new LinuxExecutionAdmissionError("credential_request_denied", "remoteUrl must not contain credentials");
  if (parsed.protocol !== "https:" && parsed.protocol !== "file:") throw new LinuxExecutionAdmissionError("unsupported_command", "trusted Git helper supports https and local file remotes only in P0");
  return parsed.toString();
}

function normalizeGitRef(value: string): string {
  if (value.length === 0 || value.length > 256 || value.startsWith("-") || value.includes("\u0000") || /[\s~^:?*[\\]/.test(value)) throw new LinuxExecutionAdmissionError("invalid_request", "Git ref is invalid");
  return value;
}

function normalizeGitTargetRef(value: string): string {
  const ref = normalizeGitRef(value);
  if (!ref.startsWith("refs/")) throw new LinuxExecutionAdmissionError("invalid_request", "targetRef must be a full refs/ name");
  return ref;
}

function assertProviderRepositoryId(value: string): void {
  if (value.length === 0 || value.length > 256 || value.includes("\u0000") || /\s/.test(value)) throw new LinuxExecutionAdmissionError("invalid_request", "providerRepositoryId is invalid");
}

function validateCredentialValue(name: string, value: string, maxBytes: number): void {
  const size = new TextEncoder().encode(value).byteLength;
  if (size === 0 || size > maxBytes || value.includes("\u0000")) throw new LinuxExecutionAdmissionError("credential_request_denied", `${name} is outside the supported private credential bound`);
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function cancelLinuxCommand(ctx: DurableObjectState, input: unknown): Promise<Response> {
  let cancel: Pick<LinuxActiveAttempt, "commandId" | "tenantId" | "repositoryId" | "operationId" | "fenceToken"> & { readonly containerIdentity?: string };
  try { cancel = parseCancelRequest(input) } catch (error) { return admissionErrorResponse(error) }
  const active = await readActiveAttempt(ctx);
  if (!active) return Response.json({ ok: false, error: "gfy_linux_no_active_attempt" }, { status: 409 });
  if (!cancelMatchesActive(cancel, active)) return Response.json({ ok: false, error: "gfy_linux_stale_cancel_rejected", active: publicActiveAttempt(active) }, { status: 409 });
  if (!ctx.container) return Response.json({ ok: false, error: "gfy_linux_container_unavailable" }, { status: 503 });
  const receipt = makeReceipt(active, "canceled", null, emptyCollectedStream(), emptyCollectedStream(), new Date().toISOString());
  await ctx.storage.put(receiptKey(active.containerIdentity), receipt);
  const finalized = await finalizeAttemptWithContainerDestroy(ctx, active, receipt, ctx.container, `cancel ${active.commandId}`);
  return Response.json(finalized.cleanupRequired ? { ok: false, error: "gfy_linux_cleanup_required", receipt: finalized } : { ok: true, status: "canceled", commandId: active.commandId, fenceToken: active.fenceToken, containerIdentity: active.containerIdentity, containerDestroyed: true, receipt: finalized }, { status: finalized.cleanupRequired ? 500 : 200 });
}

export async function linuxExecutionAlarm(ctx: DurableObjectState): Promise<void> {
  const active = await readActiveAttempt(ctx);
  if (!active) return;
  const now = Date.now();
  if (now < active.alarmAtMs) {
    await ctx.storage.setAlarm(active.alarmAtMs);
    return;
  }
  const receipt = makeReceipt(active, "timed_out", null, emptyCollectedStream(), { text: "deadline alarm expired", truncated: false }, new Date(now).toISOString());
  await ctx.storage.put(receiptKey(active.containerIdentity), receipt);
  if (!ctx.container) {
    await markCleanupRequired(ctx, active, receipt, new Error("container unavailable during alarm cleanup"));
    return;
  }
  await finalizeAttemptWithContainerDestroy(ctx, active, receipt, ctx.container, `deadline alarm ${active.commandId}`);
}

export async function startDedicatedContainer(ctx: DurableObjectState, container: Container, admission: LinuxExecAdmission, env: LinuxExecutionEnv, artifactsEgress?: GitArtifactsEgressCapability): Promise<void> {
  const image = container.images?.gfy;
  if (!image || image !== admission.image) throw new Error("native container image map does not match admitted digest");
  const current = await container.inspect().catch(() => null);
  if (container.running && isRecord(current) && isRecord(current.labels) && current.labels["gfy.identity"] !== containerLabelFingerprint(admission.containerIdentity)) await destroyContainerAndVerify(container, "new fenced command");
  await interceptInternalEgress(ctx, container, admission.egressProfile, env, artifactsEgress);
  container.start({ ...admission.startup, image, labels: { ...admission.startup.labels, "gfy.identity": containerLabelFingerprint(admission.containerIdentity) } });
}

export async function destroyContainer(container: Container | undefined, reason: string): Promise<void> {
  if (!container) return;
  await destroyContainerAndVerify(container, reason);
}

export async function collectStream(stream: ReadableStream | null, maxBytes: number): Promise<{ readonly text: string; readonly bytes: number; readonly truncated: boolean }> {
  if (!stream) return emptyCollectedStream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = bytesFromChunk(next.value);
      if (keptBytes + chunk.byteLength <= maxBytes) {
        chunks.push(chunk);
        keptBytes += chunk.byteLength;
      } else {
        const remaining = Math.max(0, maxBytes - keptBytes);
        if (remaining > 0) {
          chunks.push(chunk.slice(0, remaining));
          keptBytes += remaining;
        }
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(concat(chunks, keptBytes)), bytes: keptBytes, truncated };
}

function parseAdmissionRequest(input: unknown): LinuxExecAdmissionRequest {
  if (!isRecord(input)) throw new LinuxExecutionAdmissionError("invalid_request", "request body must be an object");
  const envValue = input.env;
  const base: LinuxExecAdmissionRequest = {
    commandId: readRequiredString(input, "commandId"),
    tenantId: readRequiredString(input, "tenantId"),
    repositoryId: readRequiredString(input, "repositoryId"),
    operationId: readRequiredString(input, "operationId"),
    fenceToken: readRequiredString(input, "fenceToken"),
    deadlineMs: readRequiredNumber(input, "deadlineMs"),
    cwd: readRequiredString(input, "cwd"),
    argv: readArgv(input.argv)
  };
  return optionalAdmission(base, input, isRecord(envValue) ? Object.fromEntries(Object.entries(envValue).map(([key, value]) => [key, String(value)])) : undefined);
}

function optionalAdmission(base: LinuxExecAdmissionRequest, input: Record<string, unknown>, env: Record<string, string> | undefined): LinuxExecAdmissionRequest {
  const out: Record<string, unknown> = { ...base };
  if (env) out.env = env;
  for (const key of ["stdinRef", "stdoutRef", "stderrRef", "journalRef", "egressProfile", "leaseId", "refName", "expectedOldOid", "candidateNewOid", "quarantinePrefix", "artifactRepoId"] as const) {
    const value = input[key];
    if (typeof value === "string") out[key] = value;
  }
  for (const key of ["leaseGeneration", "policyEpoch"] as const) {
    const value = input[key];
    if (typeof value === "number") out[key] = value;
  }
  return out as unknown as LinuxExecAdmissionRequest;
}

function normalizeArgv(profile: LinuxExecutionProfile, argv: readonly string[]): readonly string[] {
  if (argv.length === 0) throw new LinuxExecutionAdmissionError("invalid_request", "argv must not be empty");
  if (argv.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.includes("\u0000"))) throw new LinuxExecutionAdmissionError("invalid_request", "argv entries must be non-empty strings");
  const command = argv[0] ?? "";
  const allowlist = profile === "trusted_git_helper" ? trustedCommands : profile === "untrusted_ci_job" ? ciCommands : undefined;
  if (!allowlist) throw new LinuxExecutionAdmissionError("unsupported_profile", `profile ${String(profile)} is not supported`);
  if (!allowlist.has(command)) throw new LinuxExecutionAdmissionError("unsupported_command", `${command} is not allowed for ${profile}`);
  return argv;
}

function normalizeCwd(input: LinuxExecAdmissionRequest): string {
  const prefix = `/work/${input.tenantId}/${input.repositoryId}/${input.operationId}`;
  const normalized = normalizeAbsolutePath(input.cwd);
  if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) throw new LinuxExecutionAdmissionError("invalid_cwd", "cwd must stay under the command work root");
  return normalized;
}

function normalizeEnv(profile: LinuxExecutionProfile, input: Record<string, string>): Record<string, string> {
  const allowlist = profile === "trusted_git_helper" ? trustedEnvAllowlist : ciEnvAllowlist;
  const out: Record<string, string> = { HOME: "/tmp/gitfoundry-home", PATH: safePath, TMPDIR: "/tmp" };
  if (profile === "trusted_git_helper") {
    out.GIT_CONFIG_NOSYSTEM = "1";
    out.GIT_CONFIG_GLOBAL = "/dev/null";
  }
  for (const [key, value] of Object.entries(input)) {
    if (!allowlist.has(key) || deniedEnvPattern.test(key)) throw new LinuxExecutionAdmissionError("credential_env_denied", `env ${key} is not allowed`);
    out[key] = value;
  }
  return out;
}

function imageForProfile(profile: LinuxExecutionProfile, env: LinuxExecutionEnv): string {
  const image = profile === "trusted_git_helper" ? env.GFY_TRUSTED_GIT_HELPER_IMAGE : env.GFY_UNTRUSTED_CI_IMAGE;
  if (!image) throw new LinuxExecutionAdmissionError("image_unconfigured", `${profile} image is not configured`);
  if (!imageDigestPattern.test(image)) throw new LinuxExecutionAdmissionError("image_unconfigured", `${profile} image must be a complete sha256 digest reference`);
  return image;
}

function validateGitFields(input: LinuxExecAdmissionRequest): void {
  for (const key of ["expectedOldOid", "candidateNewOid"] as const) {
    const value = input[key];
    if (value !== undefined && !oidPattern.test(value)) throw new LinuxExecutionAdmissionError("invalid_request", `${key} must be a lowercase Git SHA-1`);
  }
  if (input.leaseGeneration !== undefined && (!Number.isInteger(input.leaseGeneration) || input.leaseGeneration < 0)) throw new LinuxExecutionAdmissionError("invalid_request", "leaseGeneration must be a non-negative integer");
  if (input.policyEpoch !== undefined && (!Number.isInteger(input.policyEpoch) || input.policyEpoch < 0)) throw new LinuxExecutionAdmissionError("invalid_request", "policyEpoch must be a non-negative integer");
}

function validateUnsupportedIoRefs(input: LinuxExecAdmissionRequest): void {
  for (const key of ["stdinRef", "stdoutRef", "stderrRef", "journalRef"] as const) {
    if (input[key] !== undefined) throw new LinuxExecutionAdmissionError("unsupported_io_ref", `${key} is not supported until artifact/log ports are implemented`);
  }
}

function stableContainerIdentity(profile: LinuxExecutionProfile, input: LinuxExecAdmissionRequest): string {
  return ["gitfoundry-linux-v2", profile, input.tenantId, input.repositoryId, input.operationId, input.commandId, input.fenceToken].map(frameIdentityPart).join("");
}

function frameIdentityPart(value: string): string {
  return `${value.length}:${value}`;
}

async function interceptInternalEgress(ctx: DurableObjectState, container: Container, profile: LinuxEgressProfile, env: LinuxExecutionEnv, artifactsEgress?: GitArtifactsEgressCapability): Promise<void> {
  if (artifactsEgress) {
    await container.interceptOutboundHttps(artifactsEgress.allowedProviderHostname, scopedArtifactsEgressFetcher(ctx, artifactsEgress));
    return;
  }
  if (profile === "deny_all") return;
  for (const host of internalHosts) {
    const binding = host === "gitfoundry-artifacts.internal" ? env.GFY_INTERNAL_ARTIFACTS : env.GFY_INTERNAL_LOGS;
    if (binding) {
      await container.interceptOutboundHttp(host, binding);
      await container.interceptOutboundHttps(host, binding);
    }
  }
}

function scopedArtifactsEgressFetcher(ctx: DurableObjectState, capability: GitArtifactsEgressCapability): Fetcher {
  const exports = (ctx as unknown as { readonly exports?: { readonly GitFoundryArtifactsEgress?: (init: { readonly props: GitArtifactsEgressCapability }) => Fetcher } }).exports;
  const factory = exports?.GitFoundryArtifactsEgress;
  if (!factory) throw new LinuxExecutionAdmissionError("credential_request_denied", "GitFoundryArtifactsEgress export is unavailable");
  return factory({ props: capability });
}

async function nextAttemptGeneration(ctx: DurableObjectState): Promise<number> {
  const previous = await ctx.storage.get<number>(attemptGenerationKey) ?? 0;
  const next = previous + 1;
  await ctx.storage.put(attemptGenerationKey, next);
  return next;
}

function makeActiveAttempt(admission: LinuxExecAdmission, attemptGeneration: number, startedAtMs: number): LinuxActiveAttempt {
  const deadlineAtMs = startedAtMs + admission.deadlineMs;
  return { ...admission.receiptBase, attemptGeneration, deadlineAtMs, alarmAtMs: deadlineAtMs + killAfterMs + 1000, startedAt: new Date(startedAtMs).toISOString(), admission };
}

async function persistActiveAttempt(ctx: DurableObjectState, active: LinuxActiveAttempt): Promise<void> {
  await ctx.storage.put(activeAttemptKey, active);
  await ctx.storage.setAlarm(active.alarmAtMs);
}

async function readActiveAttempt(ctx: DurableObjectState): Promise<LinuxActiveAttempt | undefined> {
  return await ctx.storage.get<LinuxActiveAttempt>(activeAttemptKey);
}

async function readReceipt(ctx: DurableObjectState, containerIdentity: string): Promise<LinuxExecReceipt | undefined> {
  return await ctx.storage.get<LinuxExecReceipt>(receiptKey(containerIdentity));
}

async function completeCurrentAttempt(ctx: DurableObjectState, active: LinuxActiveAttempt, receipt: LinuxExecReceipt): Promise<void> {
  await ctx.storage.put(receiptKey(active.containerIdentity), receipt);
  const current = await readActiveAttempt(ctx);
  if (current && current.containerIdentity === active.containerIdentity && current.attemptGeneration === active.attemptGeneration) {
    await ctx.storage.delete(activeAttemptKey);
    await ctx.storage.deleteAlarm();
  }
}

async function finalizeAttemptWithContainerDestroy(ctx: DurableObjectState, active: LinuxActiveAttempt, receipt: LinuxExecReceipt, container: Container, reason: string): Promise<LinuxExecReceipt> {
  await ctx.storage.put(receiptKey(active.containerIdentity), receipt);
  try {
    await destroyContainerAndVerify(container, reason);
  } catch (error) {
    return await markCleanupRequired(ctx, active, receipt, error);
  }
  await completeCurrentAttempt(ctx, active, receipt);
  return receipt;
}

async function markCleanupRequired(ctx: DurableObjectState, active: LinuxActiveAttempt, receipt: LinuxExecReceipt, error: unknown): Promise<LinuxExecReceipt> {
  const cleanupReceipt = withCleanupRequired(receipt, error);
  await ctx.storage.put(receiptKey(active.containerIdentity), cleanupReceipt);
  await ctx.storage.setAlarm(Date.now() + killAfterMs + 1000);
  return cleanupReceipt;
}

// A destroyed container keeps reporting for a moment while it stops; wait for it to go.
async function destroyContainerAndVerify(container: Container, reason: string): Promise<void> {
  await container.destroy(new Error(reason));
  for (let waited = 0; waited <= destroyWaitMs; waited += destroyPollMs) {
    if (await container.inspect() === null) return;
    await new Promise((resolve) => setTimeout(resolve, destroyPollMs));
  }
  throw new Error(`container still running after destroy: ${reason}`);
}

function receiptKey(containerIdentity: string): string {
  return `${receiptKeyPrefix}${containerIdentity}`;
}

function makeReceipt(active: LinuxActiveAttempt, status: LinuxExecutionStatus, exitCode: number | null, stdout: { readonly text: string; readonly truncated: boolean }, stderr: { readonly text: string; readonly truncated: boolean }, finishedAt: string): LinuxExecReceipt {
  return { ...active.admission.receiptBase, ...(active.candidateRequestSha256===undefined?{}:{candidateRequestSha256:active.candidateRequestSha256}), ...(active.candidateCiRequestSha256===undefined?{}:{candidateCiRequestSha256:active.candidateCiRequestSha256}), status, exitCode, stdout: stdout.text, stderr: stderr.text, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, startedAt: active.startedAt, finishedAt, image: active.admission.image, egressProfile: active.admission.egressProfile, attemptGeneration: active.attemptGeneration, cleanupRequired: false };
}

function withCleanupRequired(receipt: LinuxExecReceipt, error: unknown): LinuxExecReceipt {
  return { ...receipt, cleanupRequired: true, cleanupError: error instanceof Error ? error.message : String(error) };
}

function publicActiveAttempt(active: LinuxActiveAttempt): Pick<LinuxActiveAttempt, "commandId" | "tenantId" | "repositoryId" | "operationId" | "fenceToken" | "profile" | "containerIdentity" | "attemptGeneration" | "deadlineAtMs" | "alarmAtMs"> {
  return { commandId: active.commandId, tenantId: active.tenantId, repositoryId: active.repositoryId, operationId: active.operationId, fenceToken: active.fenceToken, profile: active.profile, containerIdentity: active.containerIdentity, attemptGeneration: active.attemptGeneration, deadlineAtMs: active.deadlineAtMs, alarmAtMs: active.alarmAtMs };
}

function parseCancelRequest(input: unknown): Pick<LinuxActiveAttempt, "commandId" | "tenantId" | "repositoryId" | "operationId" | "fenceToken"> & { readonly containerIdentity?: string } {
  if (!isRecord(input)) throw new LinuxExecutionAdmissionError("invalid_request", "cancel body must be an object");
  const out: Record<string, string> = {
    commandId: readRequiredString(input, "commandId"),
    tenantId: readRequiredString(input, "tenantId"),
    repositoryId: readRequiredString(input, "repositoryId"),
    operationId: readRequiredString(input, "operationId"),
    fenceToken: readRequiredString(input, "fenceToken")
  };
  for (const key of ["commandId", "tenantId", "repositoryId", "operationId", "fenceToken"] as const) {
    const value = out[key];
    if (value === undefined) throw new LinuxExecutionAdmissionError("invalid_request", `${key} is required`);
    assertId(key, value);
  }
  const containerIdentity = input.containerIdentity;
  if (typeof containerIdentity === "string" && containerIdentity.length > 0) out.containerIdentity = containerIdentity;
  return out as Pick<LinuxActiveAttempt, "commandId" | "tenantId" | "repositoryId" | "operationId" | "fenceToken"> & { readonly containerIdentity?: string };
}

function cancelMatchesActive(cancel: Pick<LinuxActiveAttempt, "commandId" | "tenantId" | "repositoryId" | "operationId" | "fenceToken"> & { readonly containerIdentity?: string }, active: LinuxActiveAttempt): boolean {
  return cancel.commandId === active.commandId && cancel.tenantId === active.tenantId && cancel.repositoryId === active.repositoryId && cancel.operationId === active.operationId && cancel.fenceToken === active.fenceToken && (cancel.containerIdentity === undefined || cancel.containerIdentity === active.containerIdentity);
}

function maxOutputBytes(env: LinuxExecutionEnv): number {
  const parsed = Number(env.GFY_LINUX_MAX_OUTPUT_BYTES ?? defaultMaxOutputBytes);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2 * 1024 * 1024 ? parsed : defaultMaxOutputBytes;
}

function admissionErrorResponse(error: unknown): Response {
  if (error instanceof LinuxExecutionAdmissionError) return Response.json({ ok: false, error: error.code, detail: error.message }, { status: error.code === "unsupported_profile" || error.code === "unsupported_command" || error.code === "unsupported_io_ref" ? 501 : 400 });
  // Name an unexpected failure by its kind only; its message can carry request content.
  const kind = error instanceof Error && /^[A-Z][A-Za-z]{0,63}$/u.test(error.name) ? { detail: error.name } : {};
  return Response.json({ ok: false, error: "invalid_request", ...kind }, { status: 400 });
}

async function writeStdin(stdin: WritableStream | null, input: string): Promise<void> {
  if (!stdin) {
    if (input.length > 0) throw new Error("container stdin is unavailable for private credential transport");
    return;
  }
  const writer = stdin.getWriter();
  try {
    if (input.length > 0) await writer.write(new TextEncoder().encode(input));
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

function redactCollectedStream(stream: { readonly text: string; readonly bytes: number; readonly truncated: boolean }, redactions: readonly string[]): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  const text = redactText(stream.text, redactions);
  return { ...stream, text, bytes: new TextEncoder().encode(text).byteLength };
}

function redactText(text: string, redactions: readonly string[]): string {
  let out = text;
  for (const redaction of redactions) {
    if (redaction.length > 0) out = out.split(redaction).join("[redacted]");
  }
  return out;
}

function assertId(name: string, value: string): void {
  if (!idPattern.test(value)) throw new LinuxExecutionAdmissionError("invalid_request", `${name} is not a valid GitFoundry id`);
}

function readRequiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new LinuxExecutionAdmissionError("invalid_request", `${key} is required`);
  return value;
}

function readRequiredNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number") throw new LinuxExecutionAdmissionError("invalid_request", `${key} is required`);
  return value;
}

function readArgv(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new LinuxExecutionAdmissionError("invalid_request", "argv must be an array");
  return value.map((entry) => String(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAbsolutePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\u0000")) throw new LinuxExecutionAdmissionError("invalid_cwd", "cwd must be an absolute path");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { parts.pop(); continue; }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function makeReceiptBase(input: LinuxExecAdmissionRequest, profile: LinuxExecutionProfile, containerIdentity: string): LinuxReceiptBase {
  const out: Record<string, unknown> = { commandId: input.commandId, tenantId: input.tenantId, repositoryId: input.repositoryId, operationId: input.operationId, fenceToken: input.fenceToken, profile, containerIdentity };
  if (input.leaseId !== undefined) out.leaseId = input.leaseId;
  if (input.leaseGeneration !== undefined) out.leaseGeneration = input.leaseGeneration;
  if (input.journalRef !== undefined) out.journalRef = input.journalRef;
  return out as unknown as LinuxReceiptBase;
}

function bytesFromChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new TextEncoder().encode(String(value));
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function emptyCollectedStream(): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  return { text: "", bytes: 0, truncated: false };
}

function containerLabelFingerprint(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex") }
