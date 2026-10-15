import { createHash } from "node:crypto";
import { Effect } from "effect";

import { buildCandidateCiAdmission, type StoredCandidateCiRequest } from "../candidate-ci/index.js";
import type { LinuxExecReceipt, LinuxExecutionEnv } from "../linux/execution.js";
import type { StoredMergeCandidate, ReviewedDiffEvidence } from "../merge-candidate/pipeline.js";
import type { D1DatabaseLike } from "../../../../packages/core/src/live/index.js";
import type { Check, CheckOutput, CheckStore } from "../../../../packages/core/src/checks/index.js";
import type { Actor } from "../../../../packages/core/src/index.js";
import { makeNativeCandidateCheckStore, readNativeJobCheckToken } from "./check-reporting.js";
import type { NativeCandidateJobReceiptInput, NativeCandidateJobScheduleInput, NativeCandidateJobScheduleResult, NativeCandidateJobStartInput, NativeCandidateCheckQualificationToken } from "./store.js";

export const nativeCandidateCiScriptPath = ".gitfoundry/ci.sh";
export const nativeCandidateCiCommand = ["/bin/sh", "-lc", nativeCandidateCiScriptPath] as const;

export class NativeCandidateJobControllerError extends Error { readonly name = "NativeCandidateJobControllerError"; }

export interface NativeCandidateCiDispatcher { readonly execute: (request: StoredCandidateCiRequest) => Promise<NativeCandidateCiDispatchResult> }
export type NativeCandidateCiDispatchResult = Response | { readonly ok?: boolean; readonly receipt?: LinuxExecReceipt } | LinuxExecReceipt;
export interface NativeCandidateJobControllerOptions { readonly clock?: { readonly now: () => Date }; readonly deadlineMs?: number; readonly planId?: string; readonly checkStore?: CheckStore }
export interface NativeCandidateJobStorePort {
  readonly schedule: (input: NativeCandidateJobScheduleInput) => Promise<NativeCandidateJobScheduleResult>;
  readonly start: (input: NativeCandidateJobStartInput) => Promise<NativeCandidateCheckQualificationToken>;
  readonly finalize: (input: NativeCandidateJobReceiptInput) => Promise<NativeCandidateCheckQualificationToken>;
}

export function makeStoredCandidateCiPrivateDispatcher(ctx: DurableObjectState, env: LinuxExecutionEnv): NativeCandidateCiDispatcher {
  return { execute: async (request) => {
    const { executeStoredCandidateCi } = await import("../linux/execution.js");
    return executeStoredCandidateCi(ctx, env, request);
  } };
}

export function makeNativeCandidateJobController(db: D1DatabaseLike, store: NativeCandidateJobStorePort, dispatcher: NativeCandidateCiDispatcher, options: NativeCandidateJobControllerOptions = {}) {
  const clock = options.clock ?? { now: () => new Date() };
  const deadlineMs = options.deadlineMs ?? 120_000;
  const planId = options.planId ?? "native-ci";
  const checkStore = options.checkStore ?? makeNativeCandidateCheckStore(db, { clock });
  return { run: (input: NativeCandidateJobScheduleInput) => runNativeCandidateJob(db, store, dispatcher, input, { clock, deadlineMs, planId, checkStore }) };
}

export async function buildStoredCandidateCiRequestFromEligibility(db: D1DatabaseLike, input: NativeCandidateJobScheduleInput, scheduled: NativeCandidateJobScheduleResult, options: { readonly deadlineMs?: number; readonly planId?: string } = {}): Promise<StoredCandidateCiRequest> {
  assertNativeCiCommand(input);
  const operation = await db.prepare("SELECT result_key FROM operations WHERE tenant_id = ? AND id = ? AND kind = 'pr.eligibility.prepare' AND state = 'complete' LIMIT 1").bind(input.tenantId, input.eligibilityOperationId).first<{ result_key: string | null }>();
  if (!operation?.result_key?.startsWith("json:")) throw new NativeCandidateJobControllerError("completed eligibility result is unavailable");
  const result = parseJson(operation.result_key.slice(5), "eligibility result");
  const candidate = readCandidate(result, input);
  const plan = readCheckPlan(result, input, options.planId ?? "native-ci");
  const request: StoredCandidateCiRequest = {
    commandId: scheduled.attemptId,
    tenantId: input.tenantId,
    repositoryId: input.targetRepositoryId,
    sourceRepositoryId: input.sourceRepositoryId,
    operationId: input.eligibilityOperationId,
    eligibilityOperationId: input.eligibilityOperationId,
    eligibilityGeneration: input.eligibilityGeneration,
    pullRequestId: input.pullRequestId,
    pullRequestVersion: input.pullRequestVersion,
    issueVersion: input.issueVersion,
    producerId: input.producerId,
    producerAuthEpoch: input.producerAuthEpoch,
    tenantPolicyEpoch: input.tenantPolicyEpoch,
    jobId: scheduled.jobId,
    attemptId: scheduled.attemptId,
    attemptGeneration: scheduled.attemptGeneration,
    fenceToken: scheduled.fenceToken,
    context: input.context,
    imageDigest: input.imageDigest,
    deadlineMs: options.deadlineMs ?? 120_000,
    headSha: input.headSha,
    baseSha: input.baseSha,
    candidateSha: input.candidateSha,
    candidate,
    plan
  };
  buildCandidateCiAdmission(request);
  return request;
}

async function runNativeCandidateJob(db: D1DatabaseLike, store: NativeCandidateJobStorePort, dispatcher: NativeCandidateCiDispatcher, input: NativeCandidateJobScheduleInput, options: Required<Omit<NativeCandidateJobControllerOptions, "checkStore">> & { readonly checkStore: CheckStore }): Promise<NativeCandidateCheckQualificationToken> {
  const scheduled = await store.schedule(input);
  const queuedToken = await readRequiredNativeCheckToken(db, input.tenantId, scheduled.attemptId, "queued", null);
  let check = await createNativeCheck(options.checkStore, queuedToken, nativeCheckOutput(queuedToken));
  const request = await buildStoredCandidateCiRequestFromEligibility(db, input, scheduled, { deadlineMs: options.deadlineMs, planId: options.planId });
  const expected = buildCandidateCiAdmission(request);
  const startedToken = await store.start({ ...input, now: options.clock.now().toISOString(), jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken });
  check = await updateNativeCheck(options.checkStore, check, startedToken, nativeCheckOutput(startedToken));
  const receipt = await readDispatchReceipt(await dispatcher.execute(request));
  validateHelperReceipt(receipt, request, expected.requestSha256, expected.binding);
  const token = await store.finalize({ ...input, now: options.clock.now().toISOString(), jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken, terminalStatus: terminalStatus(receipt), exitCode: receipt.exitCode, providerEvidenceRef: providerEvidenceRef(receipt, expected.requestSha256), logSha256: logDigest(receipt), logBytes: logBytes(receipt) });
  await updateNativeCheck(options.checkStore, check, token, nativeCheckOutput(token, receipt));
  return token;
}

async function readRequiredNativeCheckToken(db: D1DatabaseLike, tenantId: string, jobAttemptId: string, status: NativeCandidateCheckQualificationToken["status"], conclusion: NativeCandidateCheckQualificationToken["conclusion"]): Promise<NativeCandidateCheckQualificationToken> {
  const token = await readNativeJobCheckToken(db, { tenantId, jobAttemptId, status, conclusion });
  if (!token) throw new NativeCandidateJobControllerError(`native ${status} check token is unavailable`);
  return token;
}

async function createNativeCheck(checkStore: CheckStore, token: NativeCandidateCheckQualificationToken, output: CheckOutput): Promise<Check> {
  const actor: Actor = { id: token.producerId, tenantId: token.tenantId, revoked: false, capabilities: ["check.write"] };
  return Effect.runPromise(checkStore.create(token.tenantId, actor, {
    repository_id: token.targetRepositoryId,
    commit_sha: token.candidateSha,
    head_sha: token.headSha,
    base_sha: token.baseSha,
    execution_sha: token.executionSha,
    plan_digest: token.planDigest,
    policy_digest: token.policyDigest,
    job_attempt_id: token.jobAttemptId,
    evidence_kind: token.evidenceKind,
    candidate_bound: true,
    provider_evidence_ref: null,
    name: token.context,
    status: token.status,
    conclusion: token.conclusion,
    details_url: null,
    output,
    annotations: []
  }));
}

async function updateNativeCheck(checkStore: CheckStore, current: Check, token: NativeCandidateCheckQualificationToken, output: CheckOutput): Promise<Check> {
  const actor: Actor = { id: token.producerId, tenantId: token.tenantId, revoked: false, capabilities: ["check.write"] };
  return Effect.runPromise(checkStore.update(token.tenantId, current.id, actor, current.version, { status: token.status, conclusion: token.conclusion, details_url: null, output, annotations_append: [] }));
}

function nativeCheckOutput(token: NativeCandidateCheckQualificationToken, receipt?: LinuxExecReceipt): CheckOutput {
  const candidate = token.candidateSha.slice(0, 12);
  if (token.status === "queued") return { title: "Native CI queued", summary: `.gitfoundry/ci.sh is queued for candidate ${candidate}.`, text: null };
  if (token.status === "in_progress") return { title: "Native CI running", summary: `.gitfoundry/ci.sh is running for candidate ${candidate}.`, text: null };
  const exit = receipt?.exitCode ?? token.receipt?.exitCode ?? null;
  const result = receipt?.status ?? token.conclusion ?? "completed";
  const summary = exit === null ? `.gitfoundry/ci.sh ${result} for candidate ${candidate}.` : `.gitfoundry/ci.sh ${result} and exited ${exit} for candidate ${candidate}.`;
  return { title: `Native CI ${token.conclusion ?? "completed"}`, summary, text: receipt ? receiptOutput(receipt) : null };
}

function receiptOutput(receipt: LinuxExecReceipt): string | null {
  const sections: string[] = [];
  if (receipt.stdout) sections.push(`stdout:\n${receipt.stdout}`);
  if (receipt.stderr) sections.push(`stderr:\n${receipt.stderr}`);
  return sections.length > 0 ? sections.join("\n\n") : null;
}

async function readDispatchReceipt(result: NativeCandidateCiDispatchResult): Promise<LinuxExecReceipt> {
  if (isResponseLike(result)) {
    const value = await result.json() as unknown;
    if (!result.ok || !record(value) || value.ok !== true || !record(value.receipt)) throw new NativeCandidateJobControllerError("candidate CI helper failed");
    return value.receipt as unknown as LinuxExecReceipt;
  }
  const value: unknown = result;
  if (record(value) && "ok" in value && value.ok !== true) throw new NativeCandidateJobControllerError("candidate CI helper failed");
  if (record(value) && record(value.receipt)) return value.receipt as unknown as LinuxExecReceipt;
  if (record(value) && typeof value.status === "string") return value as unknown as LinuxExecReceipt;
  throw new NativeCandidateJobControllerError("candidate CI helper returned no receipt");
}

function validateHelperReceipt(receipt: LinuxExecReceipt, request: StoredCandidateCiRequest, requestSha256: string, binding: unknown): void {
  if (!record(receipt)) throw new NativeCandidateJobControllerError("candidate CI receipt malformed");
  if (receipt.profile !== "untrusted_ci_job" || receipt.commandId !== request.commandId || receipt.tenantId !== request.tenantId || receipt.repositoryId !== request.repositoryId || receipt.operationId !== request.operationId || receipt.fenceToken !== request.fenceToken || receipt.attemptGeneration !== request.attemptGeneration) throw new NativeCandidateJobControllerError("candidate CI receipt execution identity mismatch");
  if (imageDigest(receipt.image) !== request.imageDigest || receipt.egressProfile !== "deny_all") throw new NativeCandidateJobControllerError("candidate CI receipt runtime identity mismatch");
  if (receipt.candidateCiRequestSha256 !== requestSha256 || canonical(receipt.candidateCi) !== canonical(binding)) throw new NativeCandidateJobControllerError("candidate CI receipt candidate identity mismatch");
  if (receipt.cleanupRequired) throw new NativeCandidateJobControllerError("candidate CI cleanup is unresolved");
  if (receipt.status === "succeeded" && receipt.exitCode !== 0) throw new NativeCandidateJobControllerError("candidate CI success must have zero exit code");
  if (receipt.status === "failed" && (!Number.isSafeInteger(receipt.exitCode) || receipt.exitCode === 0)) throw new NativeCandidateJobControllerError("candidate CI failure must have non-zero exit code");
  if ((receipt.status === "canceled" || receipt.status === "timed_out") && receipt.exitCode !== null) throw new NativeCandidateJobControllerError("candidate CI cancelled or timed out receipt must not carry an exit code");
  if (!["succeeded", "failed", "canceled", "timed_out"].includes(receipt.status)) throw new NativeCandidateJobControllerError("candidate CI receipt status is not finalizable");
  if (!isIso(receipt.finishedAt) || !isIso(receipt.startedAt) || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) throw new NativeCandidateJobControllerError("candidate CI receipt timestamps malformed");
}

function terminalStatus(receipt: LinuxExecReceipt): "completed" | "cancelled" | "timed_out" {
  if (receipt.status === "canceled") return "cancelled";
  if (receipt.status === "timed_out") return "timed_out";
  return "completed";
}

function readCandidate(result: Record<string, unknown>, input: NativeCandidateJobScheduleInput): StoredMergeCandidate {
  const candidate = requireRecord(result.candidate, "eligibility candidate") as unknown as StoredMergeCandidate;
  validateReviewedDiff(candidate.reviewedDiff, input);
  if (candidate.requestSha256 !== input.candidateArtifacts.manifest.requestSha256 || candidate.result.candidateOid !== input.candidateSha || candidate.result.candidateTree !== input.candidateTreeSha || candidate.result.candidateBytesSha256 !== input.candidateArtifacts.rawCommit.sha256) throw new NativeCandidateJobControllerError("eligibility candidate identity mismatch");
  if (canonical(candidate.manifest) !== canonical(input.candidateArtifacts.manifest) || canonical(candidate.rawCommit) !== canonical(input.candidateArtifacts.rawCommit) || canonical(candidate.pack) !== canonical(input.candidateArtifacts.pack)) throw new NativeCandidateJobControllerError("eligibility candidate locator mismatch");
  return candidate;
}

function readCheckPlan(result: Record<string, unknown>, input: NativeCandidateJobScheduleInput, planId: string) {
  const checkPlan = requireRecord(result.checkPlan, "eligibility check plan");
  const plan = requireRecord(checkPlan.plan, "eligibility plan");
  if (checkPlan.planDigest !== input.planDigest || plan.policyDigest !== input.policyDigest || plan.candidateOid !== input.candidateSha || plan.candidateTreeOid !== input.candidateTreeSha) throw new NativeCandidateJobControllerError("eligibility check plan identity mismatch");
  return { planId, policySha256: input.policyDigest, planDigest: input.planDigest, scriptPath: nativeCandidateCiScriptPath };
}

function validateReviewedDiff(value: ReviewedDiffEvidence, input: NativeCandidateJobScheduleInput): void {
  if (!record(value) || Object.keys(value).sort().join("\0") !== ["algorithmVersion", "baseSha", "changedPathsSha256", "comparison", "contextLines", "headSha", "mergeBaseShas", "patchSha256", "patchSizeBytes"].sort().join("\0")) throw new NativeCandidateJobControllerError("reviewed diff fields malformed");
  if (value.algorithmVersion !== "git-cli-unified-v1" || value.comparison !== "three_dot" || value.contextLines !== 3 || value.headSha !== input.headSha || value.baseSha !== input.baseSha || value.patchSha256 !== input.reviewedDiffDigest) throw new NativeCandidateJobControllerError("reviewed diff identity mismatch");
  if (!Array.isArray(value.mergeBaseShas) || value.mergeBaseShas.length < 1 || value.mergeBaseShas.length > 64 || new Set(value.mergeBaseShas).size !== value.mergeBaseShas.length || value.mergeBaseShas.some((oid) => typeof oid !== "string" || !/^[0-9a-f]{40}$/u.test(oid))) throw new NativeCandidateJobControllerError("reviewed diff merge bases malformed");
  if (!/^[0-9a-f]{64}$/u.test(value.changedPathsSha256) || !Number.isSafeInteger(value.patchSizeBytes) || value.patchSizeBytes < 0 || value.patchSizeBytes > 1024 * 1024) throw new NativeCandidateJobControllerError("reviewed diff bounds malformed");
}

function assertNativeCiCommand(input: NativeCandidateJobScheduleInput): void {
  if (canonical(input.command) !== canonical(nativeCandidateCiCommand)) throw new NativeCandidateJobControllerError("native candidate job command must run .gitfoundry/ci.sh");
}

function logDigest(receipt: LinuxExecReceipt): string { return sha(canonical({ candidateCiRequestSha256: receipt.candidateCiRequestSha256, containerIdentity: receipt.containerIdentity, exitCode: receipt.exitCode, finishedAt: receipt.finishedAt, image: receipt.image, journalRef: receipt.journalRef ?? null, startedAt: receipt.startedAt, status: receipt.status, stderr: receipt.stderr, stderrTruncated: receipt.stderrTruncated, stdout: receipt.stdout, stdoutTruncated: receipt.stdoutTruncated })); }
function logBytes(receipt: LinuxExecReceipt): number { return new TextEncoder().encode(`${receipt.stdout}${receipt.stderr}`).byteLength; }
function providerEvidenceRef(receipt: LinuxExecReceipt, requestSha256: string): string { return `native-ci:${requestSha256}:${sha(canonical({ candidateRequest: requestSha256, containerIdentity: receipt.containerIdentity, finishedAt: receipt.finishedAt, journalRef: receipt.journalRef ?? null, startedAt: receipt.startedAt }))}`; }
function imageDigest(value: unknown): string | null { if (typeof value !== "string") return null; if (/^sha256:[0-9a-f]{64}$/u.test(value)) return value; const match = value.match(/^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:([0-9a-f]{64})$/u); return match ? `sha256:${match[1]}` : null; }
function parseJson(value: string, label: string): Record<string, unknown> { const parsed = JSON.parse(value) as unknown; return requireRecord(parsed, label); }
function requireRecord(value: unknown, label: string): Record<string, unknown> { if (!record(value)) throw new NativeCandidateJobControllerError(`${label} malformed`); return value; }
function isResponseLike(value: unknown): value is Response { return record(value) && typeof value.json === "function"; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isIso(value: unknown): value is string { return typeof value === "string" && new Date(Date.parse(value)).toISOString() === value; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
