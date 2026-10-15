import { createHash } from "node:crypto";

import { admitLinuxExecution, type LinuxExecAdmission, type LinuxExecutionEnv } from "../linux/execution.js";

export type MergeCandidateMethod = "merge" | "squash" | "rebase" | "fast_forward";
export type MergeCandidateFailureStatus = "conflict" | "non_fast_forward" | "stale_input" | "invalid_objects" | "rejected";

export interface MergeCandidatePrepareInput {
  readonly commandId: string;
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly operationId: string;
  readonly fenceToken: string;
  readonly pullRequestId: string;
  readonly pullRequestVersion: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly method: MergeCandidateMethod;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committedAt: string;
  readonly message: string;
}

export interface MergeCandidateAdmission {
  readonly admission: LinuxExecAdmission;
  readonly stdin: string;
  readonly stdinBytes: number;
  readonly requestSha256: string;
}

export interface EncodedMergeCandidatePrepareRequest {
  readonly stdin: string;
  readonly stdinBytes: number;
  readonly requestSha256: string;
}

export type MergeCandidateResult =
  | {
      readonly ok: true;
      readonly status: "prepared";
      readonly candidateOid: string;
      readonly candidateTree: string;
      readonly candidateBytesSha256: string;
      readonly gitVersion: string;
      readonly stateRef: string;
      readonly originalToRebased: readonly { readonly original: string; readonly rebased: string }[];
    }
  | {
      readonly ok: false;
      readonly status: MergeCandidateFailureStatus;
      readonly gitVersion: string;
      readonly stateRef: string;
      readonly diagnostics: readonly { readonly code: string; readonly path: string | null }[];
    };

export class MergeCandidateContractError extends Error {
  readonly name = "MergeCandidateContractError";
  constructor(readonly code: "invalid_request" | "invalid_stdout" | "mismatched_result", message: string) { super(message) }
}

const prepareFrame = "gitfoundry.merge-candidate.prepare.v1";
const resultFrame = "gitfoundry.merge-candidate.result.v1";
const helperCommand = "/usr/local/bin/gitfoundry-merge-candidate";
const maxStdinBytes = 8192;
const maxStdoutBytes = 32768;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const oidPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const emailPattern = /^[^@\s\u0000]+@[^@\s\u0000]+$/u;
const methods = new Set<MergeCandidateMethod>(["merge", "squash", "rebase", "fast_forward"]);
const successKeys = ["base_sha", "candidate_bytes_sha256", "candidate_oid", "candidate_tree", "frame", "git_version", "head_sha", "method", "ok", "operation_id", "original_to_rebased", "pull_request_id", "pull_request_version", "repository_id", "state_ref", "status", "tenant_id"] as const;
const failureKeys = ["base_sha", "diagnostics", "frame", "git_version", "head_sha", "method", "ok", "operation_id", "pull_request_id", "pull_request_version", "repository_id", "state_ref", "status", "tenant_id"] as const;

export function buildMergeCandidateAdmission(input: MergeCandidatePrepareInput, env: LinuxExecutionEnv): MergeCandidateAdmission {
  const normalized = normalizePrepareInput(input);
  const request = encodeNormalizedPrepareRequest(normalized);
  const admission = admitLinuxExecution("trusted_git_helper", {
    commandId: normalized.commandId,
    tenantId: normalized.tenantId,
    repositoryId: normalized.repositoryId,
    operationId: normalized.operationId,
    fenceToken: normalized.fenceToken,
    deadlineMs: 120000,
    cwd: workPath(normalized, "trusted-git"),
    argv: [helperCommand, "prepare", "--request-format", prepareFrame, "--request-sha256", request.requestSha256],
    egressProfile: "deny_all",
    expectedOldOid: normalized.baseSha,
    candidateNewOid: normalized.headSha
  }, env);
  return { admission, stdin: request.stdin, stdinBytes: request.stdinBytes, requestSha256: request.requestSha256 };
}

export function encodeMergeCandidatePrepareRequest(input: MergeCandidatePrepareInput): EncodedMergeCandidatePrepareRequest {
  return encodeNormalizedPrepareRequest(normalizePrepareInput(input));
}

export function parseMergeCandidateResult(stdout: string, expectedInput: MergeCandidatePrepareInput): MergeCandidateResult {
  const expected = normalizePrepareInput(expectedInput);
  if (byteLength(stdout) > maxStdoutBytes) throw new MergeCandidateContractError("invalid_stdout", "merge candidate stdout exceeds the parser bound");
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== 1) throw new MergeCandidateContractError("invalid_stdout", "merge candidate helper must write exactly one JSON result line");
  let value: unknown;
  try { value = JSON.parse(lines[0] ?? "") } catch (error) { throw new MergeCandidateContractError("invalid_stdout", `merge candidate result is not JSON: ${String(error)}`) }
  if (!isRecord(value)) throw new MergeCandidateContractError("invalid_stdout", "merge candidate result must be an object");
  const ok = value.ok;
  if (ok === true) {
    assertExactKeys(value, successKeys);
    assertCommonResult(value, expected);
    requireLiteral(value.status, "prepared", "status");
    const candidateOid = requireOid(value.candidate_oid, "candidate_oid");
    const candidateTree = requireOid(value.candidate_tree, "candidate_tree");
    const candidateBytesSha256 = requireSha256(value.candidate_bytes_sha256, "candidate_bytes_sha256");
    const originalToRebased = readRebaseMap(value.original_to_rebased);
    if (expected.method === "fast_forward" && candidateOid !== expected.headSha) throw new MergeCandidateContractError("mismatched_result", "fast-forward candidate must equal the source head");
    if (expected.method !== "rebase" && originalToRebased.length !== 0) throw new MergeCandidateContractError("invalid_stdout", "only rebase results may contain a rebase map");
    if (expected.method === "rebase" && originalToRebased.length > 0 && originalToRebased[originalToRebased.length - 1]?.rebased !== candidateOid) throw new MergeCandidateContractError("mismatched_result", "rebase map must end at the prepared candidate");
    return {
      ok: true,
      status: "prepared",
      candidateOid,
      candidateTree,
      candidateBytesSha256,
      gitVersion: requireGitVersion(value.git_version),
      stateRef: requireStateRef(value.state_ref),
      originalToRebased
    };
  }
  if (ok === false) {
    assertExactKeys(value, failureKeys);
    assertCommonResult(value, expected);
    const status = readFailureStatus(value.status);
    return { ok: false, status, gitVersion: requireGitVersion(value.git_version), stateRef: requireStateRef(value.state_ref), diagnostics: readDiagnostics(value.diagnostics) };
  }
  throw new MergeCandidateContractError("invalid_stdout", "merge candidate result ok must be a boolean");
}

function normalizePrepareInput(input: MergeCandidatePrepareInput): MergeCandidatePrepareInput {
  for (const [name, value] of Object.entries({ commandId: input.commandId, tenantId: input.tenantId, repositoryId: input.repositoryId, operationId: input.operationId, fenceToken: input.fenceToken, pullRequestId: input.pullRequestId })) assertId(name, value);
  if (!Number.isInteger(input.pullRequestVersion) || input.pullRequestVersion < 1) throw new MergeCandidateContractError("invalid_request", "pullRequestVersion must be a positive integer");
  if (!methods.has(input.method)) throw new MergeCandidateContractError("invalid_request", "merge candidate method is not supported");
  requireOid(input.headSha, "headSha");
  requireOid(input.baseSha, "baseSha");
  assertBoundedText("committerName", input.committerName, 256);
  assertBoundedText("committerEmail", input.committerEmail, 320);
  if (!emailPattern.test(input.committerEmail)) throw new MergeCandidateContractError("invalid_request", "committerEmail is invalid");
  if (!isExactIsoTimestamp(input.committedAt)) throw new MergeCandidateContractError("invalid_request", "committedAt must be an exact ISO timestamp");
  assertBoundedText("message", input.message, 8192);
  return input;
}

function encodeNormalizedPrepareRequest(normalized: MergeCandidatePrepareInput): EncodedMergeCandidatePrepareRequest {
  const frame = {
    frame: prepareFrame,
    tenant_id: normalized.tenantId,
    repository_id: normalized.repositoryId,
    operation_id: normalized.operationId,
    pull_request_id: normalized.pullRequestId,
    pull_request_version: normalized.pullRequestVersion,
    method: normalized.method,
    head_sha: normalized.headSha,
    base_sha: normalized.baseSha,
    trusted_git_dir: workPath(normalized, "trusted-git"),
    state_dir: workPath(normalized, "merge-candidates"),
    committer: {
      name: normalized.committerName,
      email: normalized.committerEmail,
      committed_at: normalized.committedAt
    },
    message: normalized.message,
    options: mergeCandidatePrepareOptions()
  };
  const stdin = JSON.stringify(frame) + "\n";
  const stdinBytes = byteLength(stdin);
  if (stdinBytes > maxStdinBytes) throw new MergeCandidateContractError("invalid_request", "merge candidate request frame exceeds the stdin bound");
  return { stdin, stdinBytes, requestSha256: sha256(stdin) };
}

export function mergeCandidatePrepareOptions(): Record<string, string | boolean> {
  return { preserve_source_commits: true, signing: "disabled", external_filters: "disabled", hooks: "disabled", replace_refs: "disabled" };
}

function assertCommonResult(value: Record<string, unknown>, expected: MergeCandidatePrepareInput): void {
  requireLiteral(value.frame, resultFrame, "frame");
  for (const [field, expectedValue] of Object.entries({ tenant_id: expected.tenantId, repository_id: expected.repositoryId, operation_id: expected.operationId, pull_request_id: expected.pullRequestId, method: expected.method, head_sha: expected.headSha, base_sha: expected.baseSha })) {
    requireLiteral(value[field], expectedValue, field);
  }
  if (value.pull_request_version !== expected.pullRequestVersion) throw new MergeCandidateContractError("mismatched_result", "merge candidate result pull_request_version does not match the request");
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new MergeCandidateContractError("invalid_stdout", "merge candidate result contains unexpected fields");
}

function assertId(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new MergeCandidateContractError("invalid_request", `${name} is invalid`);
}

function assertBoundedText(name: string, value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || byteLength(value) > maxBytes) throw new MergeCandidateContractError("invalid_request", `${name} is outside the supported bound`);
}

function requireLiteral(value: unknown, expected: string, field: string): void {
  if (value !== expected) throw new MergeCandidateContractError("mismatched_result", `merge candidate result ${field} does not match the request`);
}

function requireOid(value: unknown, field: string): string {
  if (typeof value !== "string" || !oidPattern.test(value) || value === "0".repeat(40)) throw new MergeCandidateContractError("invalid_request", `${field} must be a lowercase Git SHA-1`);
  return value;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new MergeCandidateContractError("invalid_stdout", `${field} must be a lowercase SHA-256`);
  return value;
}

function requireGitVersion(value: unknown): string {
  if (typeof value !== "string" || !/^2\.39\.5(?:\b|$)/u.test(value) || value.includes("\u0000") || value.length > 32) throw new MergeCandidateContractError("invalid_stdout", "git_version must identify pinned Git 2.39.5");
  return value;
}

function requireStateRef(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.startsWith("/") || value.includes("..") || value.includes("\u0000") || /\s/u.test(value)) throw new MergeCandidateContractError("invalid_stdout", "state_ref is invalid");
  return value;
}

function readFailureStatus(value: unknown): MergeCandidateFailureStatus {
  if (value === "conflict" || value === "non_fast_forward" || value === "stale_input" || value === "invalid_objects" || value === "rejected") return value;
  throw new MergeCandidateContractError("invalid_stdout", "merge candidate failure status is invalid");
}

function readRebaseMap(value: unknown): readonly { readonly original: string; readonly rebased: string }[] {
  if (!Array.isArray(value) || value.length > 512) throw new MergeCandidateContractError("invalid_stdout", "original_to_rebased must be a bounded array");
  const originals = new Set<string>();
  const rebasedOids = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry)) throw new MergeCandidateContractError("invalid_stdout", "rebase map entries must be objects");
    assertExactKeys(entry, ["original", "rebased"]);
    const original = requireOid(entry.original, "original");
    const rebased = requireOid(entry.rebased, "rebased");
    if (originals.has(original) || rebasedOids.has(rebased)) throw new MergeCandidateContractError("invalid_stdout", "rebase map contains duplicate commit identities");
    originals.add(original);
    rebasedOids.add(rebased);
    return { original, rebased };
  });
}

function readDiagnostics(value: unknown): readonly { readonly code: string; readonly path: string | null }[] {
  if (!Array.isArray(value) || value.length > 64) throw new MergeCandidateContractError("invalid_stdout", "diagnostics must be a bounded array");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new MergeCandidateContractError("invalid_stdout", "diagnostics entries must be objects");
    assertExactKeys(entry, ["code", "path"]);
    if (typeof entry.code !== "string" || !/^[a-z][a-z0-9_:-]{0,63}$/u.test(entry.code)) throw new MergeCandidateContractError("invalid_stdout", "diagnostic code is invalid");
    if (entry.path !== null && (typeof entry.path !== "string" || entry.path.length > 512 || entry.path.includes("\u0000") || entry.path.startsWith("/"))) throw new MergeCandidateContractError("invalid_stdout", "diagnostic path is invalid");
    return { code: entry.code, path: entry.path };
  });
}

function workPath(input: Pick<MergeCandidatePrepareInput, "tenantId" | "repositoryId" | "operationId">, leaf: string): string {
  return `/work/${input.tenantId}/${input.repositoryId}/${input.operationId}/${leaf}`;
}

function isExactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
