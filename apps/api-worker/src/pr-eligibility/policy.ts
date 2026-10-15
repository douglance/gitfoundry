import { selectWriteRulesForRef, type ForgeCheckConclusion, type ForgeMergeMethod, type ForgeRuleSet, type ForgeTrustedCheckRequirement, type SelectedWriteRule } from "../../../../packages/core/src/git-publication/write-rules.js";

export const ELIGIBILITY_POLICY_FRAME = "gitfoundry.pr-eligibility.policy.v1";
export const CANDIDATE_CHECK_PLAN_FRAME = "gitfoundry.pr-eligibility.candidate-check-plan.v1";

const defaultMergeMethods: readonly ForgeMergeMethod[] = ["merge", "squash", "rebase", "fast-forward"];
const checkConclusions: readonly ForgeCheckConclusion[] = ["success", "neutral", "skipped"];
const mergeMethods: readonly ForgeMergeMethod[] = ["merge", "squash", "rebase", "fast-forward"];
const rowFields = new Set(["id", "version", "priority", "enabled", "rules"]);
const checkFields = new Set(["context", "producer_id", "accepted_conclusions", "max_age_seconds"]);
const reviewedDiffFields = new Set(["headOid", "baseOid", "diffPatchSha256", "diffPatchLength", "pathsDigest", "mergeBaseOids", "algorithm", "comparison", "contextLines"]);
const maxInt32 = 2147483647;
const maxReviewedDiffPatchLength = 1024 * 1024;
const maxCanonicalDepth = 32;
const maxCanonicalNodes = 10_000;
const maxCanonicalBytes = 1024 * 1024;

export class EligibilityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EligibilityPolicyError";
  }
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface AuthoritativeEligibilityRuleRow { readonly id: string; readonly version: number; readonly priority: number; readonly enabled: boolean; readonly rules: unknown }
export interface DeriveEligibilityPolicyInput { readonly tenantId: string; readonly repositoryId: string; readonly targetRef: string; readonly policyEpoch: number; readonly rows: readonly AuthoritativeEligibilityRuleRow[] }
export interface EligibilityRuleIdentity { readonly rowId: string; readonly rowVersion: number; readonly rowPriority: number; readonly rowEnabled: boolean; readonly rule: ForgeRuleSet }
export interface EligibilityEnforcementPolicy {
  readonly allowDeletion: boolean;
  readonly allowForcePush: boolean;
  readonly allowedMergeMethods: readonly ForgeMergeMethod[];
  readonly allowedWriterGroupClauses: readonly (readonly string[])[];
  readonly dismissStaleReviews: boolean;
  readonly forbiddenPathPatterns: readonly string[];
  readonly maxBlobSizeBytes: number | null;
  readonly requireCodeOwners: boolean;
  readonly requireHumanApproval: boolean;
  readonly requireLatestPushApproval: boolean;
  readonly requireLinearHistory: boolean;
  readonly requireMergeQueue: boolean;
  readonly requirePullRequest: boolean;
  readonly requireResolvedThreads: boolean;
  readonly requireSignedCommits: boolean;
  readonly requiredApprovals: number;
  readonly requiredChecks: readonly ForgeTrustedCheckRequirement[];
  readonly requiredEnvironmentIds: readonly string[];
}
export interface EligibilityPolicy {
  readonly activeRuleIds: readonly string[];
  readonly disabledRuleIds: readonly string[];
  readonly enforcement: EligibilityEnforcementPolicy;
  readonly evaluateRuleIds: readonly string[];
  readonly identityRules: readonly EligibilityRuleIdentity[];
  readonly policyEpoch: number;
  readonly repositoryId: string;
  readonly targetRef: string;
  readonly tenantId: string;
}
export interface DerivedEligibilityPolicy { readonly policy: EligibilityPolicy; readonly canonicalBytes: Uint8Array; readonly policyDigest: string }

export interface CandidateReviewedDiffIdentity {
  readonly headOid: string;
  readonly baseOid: string;
  readonly diffPatchSha256: string;
  readonly diffPatchLength: number;
  readonly pathsDigest: string;
  readonly mergeBaseOids: readonly string[];
  readonly algorithm: "git-cli-unified-v1";
  readonly comparison: "three_dot";
  readonly contextLines: 3;
}
export interface CandidateCheckPlanInput {
  readonly tenantId: string;
  readonly sourceRepositoryId: string;
  readonly targetRepositoryId: string;
  readonly pullRequestId: string;
  readonly pullRequestVersion: number;
  readonly headOid: string;
  readonly baseOid: string;
  readonly candidateOid: string;
  readonly candidateTreeOid: string;
  readonly mergeMethod: ForgeMergeMethod;
  readonly reviewedDiff: CandidateReviewedDiffIdentity;
  readonly mergeOptions: JsonValue;
  readonly policyDigest: string;
  readonly requiredChecks: readonly ForgeTrustedCheckRequirement[];
}
export interface CandidateCheckPlan {
  readonly baseOid: string;
  readonly candidateOid: string;
  readonly candidateTreeOid: string;
  readonly headOid: string;
  readonly reviewedDiff: CandidateReviewedDiffIdentity;
  readonly mergeMethod: ForgeMergeMethod;
  readonly mergeOptions: JsonValue;
  readonly policyDigest: string;
  readonly pullRequestId: string;
  readonly pullRequestVersion: number;
  readonly requiredChecks: readonly ForgeTrustedCheckRequirement[];
  readonly sourceRepositoryId: string;
  readonly targetRepositoryId: string;
  readonly tenantId: string;
}
export interface BuiltCandidateCheckPlan { readonly plan: CandidateCheckPlan; readonly canonicalBytes: Uint8Array; readonly planDigest: string }

export async function deriveEligibilityPolicy(input: DeriveEligibilityPolicyInput): Promise<DerivedEligibilityPolicy> {
  const tenantId = boundedString(input.tenantId, "tenantId", 1, 128);
  const repositoryId = boundedString(input.repositoryId, "repositoryId", 1, 128);
  const targetRef = boundedString(input.targetRef, "targetRef", 1, 4096);
  const policyEpoch = integerRange(input.policyEpoch, "policyEpoch", 0, maxInt32);
  if (!Array.isArray(input.rows) || input.rows.length > 1000) throw new EligibilityPolicyError("rows must be an array with at most 1000 entries");

  const rows = input.rows.map(validateRow).sort(compareRows);
  rejectDuplicateRows(rows);
  const selection = selectWriteRulesForRef({ ref: targetRef, rulesets: rows.map((row) => row.rules), matchableIndexes: rows.flatMap((row, index) => row.enabled ? [index] : []) });
  if (selection.invalidRules.length > 0) throw new EligibilityPolicyError(`malformed rule: ${selection.invalidRules[0]!.reason}`);
  if (selection.matchIssues.length > 0) throw new EligibilityPolicyError(selection.matchIssues[0]!.detail);

  const identityRules = selection.validRules.map((selected) => identityFor(rows[selected.index]!, selected.rule));
  const activeRules = enabledSelectedRules(selection.activeRules, rows);
  const evaluateRules = enabledSelectedRules(selection.evaluateRules, rows);
  const disabledRules = [
    ...enabledSelectedRules(selection.disabledRules, rows),
    ...selection.activeRules.filter((selected) => !rows[selected.index]!.enabled),
    ...selection.evaluateRules.filter((selected) => !rows[selected.index]!.enabled)
  ];
  const policy: EligibilityPolicy = {
    activeRuleIds: unique(activeRules.map((selected) => selected.rule.id)),
    disabledRuleIds: unique(identityRules.filter((identity) => !identity.rowEnabled || identity.rule.state === "disabled").map((identity) => identity.rule.id)),
    enforcement: buildEnforcement(activeRules),
    evaluateRuleIds: unique(evaluateRules.map((selected) => selected.rule.id)),
    identityRules,
    policyEpoch,
    repositoryId,
    targetRef,
    tenantId
  };
  const canonicalBytes = encodeFramedCanonicalBytes(ELIGIBILITY_POLICY_FRAME, policy);
  return { policy, canonicalBytes, policyDigest: await sha256Hex(canonicalBytes) };
}

export function writerSatisfiesEligibilityPolicy(policy: EligibilityPolicy, groupIds: readonly string[]): boolean {
  return policy.enforcement.allowedWriterGroupClauses.every((clause) => clause.some((groupId) => groupIds.includes(groupId)));
}

export async function buildCandidateCheckPlan(input: CandidateCheckPlanInput): Promise<BuiltCandidateCheckPlan> {
  const plan: CandidateCheckPlan = {
    baseOid: oid(input.baseOid, "baseOid"),
    candidateOid: oid(input.candidateOid, "candidateOid"),
    candidateTreeOid: oid(input.candidateTreeOid, "candidateTreeOid"),
    headOid: oid(input.headOid, "headOid"),
    mergeMethod: enumValue(input.mergeMethod, mergeMethods, "mergeMethod"),
    mergeOptions: jsonValue(input.mergeOptions, "mergeOptions"),
    policyDigest: digest(input.policyDigest, "policyDigest"),
    reviewedDiff: reviewedDiffIdentity(input.reviewedDiff, input.headOid, input.baseOid),
    pullRequestId: boundedString(input.pullRequestId, "pullRequestId", 1, 128),
    pullRequestVersion: integerRange(input.pullRequestVersion, "pullRequestVersion", 1, maxInt32),
    requiredChecks: input.requiredChecks.map(validateCheck),
    sourceRepositoryId: boundedString(input.sourceRepositoryId, "sourceRepositoryId", 1, 128),
    targetRepositoryId: boundedString(input.targetRepositoryId, "targetRepositoryId", 1, 128),
    tenantId: boundedString(input.tenantId, "tenantId", 1, 128)
  };
  const canonicalBytes = encodeFramedCanonicalBytes(CANDIDATE_CHECK_PLAN_FRAME, plan);
  return { plan, canonicalBytes, planDigest: await sha256Hex(canonicalBytes) };
}

export function encodeFramedCanonicalBytes(frame: string, payload: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalStringify({ frame, payload }));
}

function validateRow(value: unknown, index: number): AuthoritativeEligibilityRuleRow {
  if (!record(value)) throw new EligibilityPolicyError(`row ${index} is not an object`);
  for (const key of Object.keys(value)) if (!rowFields.has(key)) throw new EligibilityPolicyError(`row ${index} has unknown field ${key}`);
  for (const key of rowFields) if (!(key in value)) throw new EligibilityPolicyError(`row ${index} is missing ${key}`);
  return {
    id: boundedString(value.id, "row.id", 1, 128),
    version: integerRange(value.version, "row.version", 1, Number.MAX_SAFE_INTEGER),
    priority: integerRange(value.priority, "row.priority", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    enabled: booleanValue(value.enabled, "row.enabled"),
    rules: value.rules
  };
}

function compareRows(a: AuthoritativeEligibilityRuleRow, b: AuthoritativeEligibilityRuleRow): number {
  return compareNumber(a.priority, b.priority) || compareUtf8Bytes(a.id, b.id) || compareNumber(a.version, b.version);
}

function compareNumber(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareUtf8Bytes(a: string, b: string): number {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = left[index]!;
    const rightByte = right[index]!;
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return left.length - right.length;
}

function rejectDuplicateRows(rows: readonly AuthoritativeEligibilityRuleRow[]): void {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new EligibilityPolicyError(`duplicate authoritative row ${row.id}`);
    ids.add(row.id);
  }
}

function identityFor(row: AuthoritativeEligibilityRuleRow, rule: ForgeRuleSet): EligibilityRuleIdentity {
  return { rowId: row.id, rowVersion: row.version, rowPriority: row.priority, rowEnabled: row.enabled, rule };
}

function enabledSelectedRules(rules: readonly SelectedWriteRule[], rows: readonly AuthoritativeEligibilityRuleRow[]): readonly SelectedWriteRule[] {
  return rules.filter((selected) => rows[selected.index]!.enabled);
}

function buildEnforcement(activeRules: readonly SelectedWriteRule[]): EligibilityEnforcementPolicy {
  let allowedMergeMethods: readonly ForgeMergeMethod[] = defaultMergeMethods;
  let maxBlobSizeBytes: number | null = null;
  const allowedWriterGroupClauses: string[][] = [];
  const requiredChecks: ForgeTrustedCheckRequirement[] = [];
  const requiredEnvironmentIds: string[] = [];
  const forbiddenPathPatterns: string[] = [];
  const enforcement = {
    allowDeletion: true,
    allowForcePush: true,
    dismissStaleReviews: false,
    requireCodeOwners: false,
    requireHumanApproval: false,
    requireLatestPushApproval: false,
    requireLinearHistory: false,
    requireMergeQueue: false,
    requirePullRequest: false,
    requireResolvedThreads: false,
    requireSignedCommits: false,
    requiredApprovals: 0
  };

  for (const { rule } of activeRules) {
    if (rule.allowed_writer_group_ids.length > 0) allowedWriterGroupClauses.push([...rule.allowed_writer_group_ids]);
    allowedMergeMethods = allowedMergeMethods.filter((method) => rule.allowed_merge_methods.includes(method));
    if (allowedMergeMethods.length === 0) throw new EligibilityPolicyError("active rules have contradictory allowed merge methods");
    enforcement.requiredApprovals = Math.max(enforcement.requiredApprovals, rule.required_approvals);
    enforcement.requirePullRequest ||= rule.require_pull_request;
    enforcement.requireHumanApproval ||= rule.require_human_approval;
    enforcement.dismissStaleReviews ||= rule.dismiss_stale_reviews;
    enforcement.requireLatestPushApproval ||= rule.require_latest_push_approval;
    enforcement.requireCodeOwners ||= rule.require_code_owners;
    enforcement.requireResolvedThreads ||= rule.require_resolved_threads;
    enforcement.requireLinearHistory ||= rule.require_linear_history;
    enforcement.requireSignedCommits ||= rule.require_signed_commits;
    enforcement.requireMergeQueue ||= rule.require_merge_queue;
    enforcement.allowForcePush &&= rule.allow_force_push;
    enforcement.allowDeletion &&= rule.allow_deletion;
    if (rule.max_blob_size_bytes !== null) maxBlobSizeBytes = maxBlobSizeBytes === null ? rule.max_blob_size_bytes : Math.min(maxBlobSizeBytes, rule.max_blob_size_bytes);
    appendUnique(requiredEnvironmentIds, rule.required_environment_ids);
    appendUnique(forbiddenPathPatterns, rule.forbidden_path_patterns);
    mergeRequiredChecks(requiredChecks, rule.required_checks);
  }

  return {
    allowDeletion: enforcement.allowDeletion,
    allowForcePush: enforcement.allowForcePush,
    allowedMergeMethods,
    allowedWriterGroupClauses,
    dismissStaleReviews: enforcement.dismissStaleReviews,
    forbiddenPathPatterns,
    maxBlobSizeBytes,
    requireCodeOwners: enforcement.requireCodeOwners,
    requireHumanApproval: enforcement.requireHumanApproval,
    requireLatestPushApproval: enforcement.requireLatestPushApproval,
    requireLinearHistory: enforcement.requireLinearHistory,
    requireMergeQueue: enforcement.requireMergeQueue,
    requirePullRequest: enforcement.requirePullRequest,
    requireResolvedThreads: enforcement.requireResolvedThreads,
    requireSignedCommits: enforcement.requireSignedCommits,
    requiredApprovals: enforcement.requiredApprovals,
    requiredChecks,
    requiredEnvironmentIds
  };
}

function mergeRequiredChecks(out: ForgeTrustedCheckRequirement[], requirements: readonly ForgeTrustedCheckRequirement[]): void {
  for (const requirement of requirements) {
    const index = out.findIndex((existing) => existing.context === requirement.context && existing.producer_id === requirement.producer_id);
    if (index === -1) {
      out.push({ context: requirement.context, producer_id: requirement.producer_id, accepted_conclusions: [...requirement.accepted_conclusions], max_age_seconds: requirement.max_age_seconds });
      continue;
    }
    const existing = out[index]!;
    const accepted = existing.accepted_conclusions.filter((conclusion) => requirement.accepted_conclusions.includes(conclusion));
    if (accepted.length === 0) throw new EligibilityPolicyError(`required check ${requirement.context}/${requirement.producer_id} has contradictory accepted conclusions`);
    out[index] = { context: existing.context, producer_id: existing.producer_id, accepted_conclusions: accepted, max_age_seconds: minMaxAge(existing.max_age_seconds, requirement.max_age_seconds) };
  }
}

function minMaxAge(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function validateCheck(value: unknown): ForgeTrustedCheckRequirement {
  if (!record(value)) throw new EligibilityPolicyError("required check is not an object");
  for (const key of Object.keys(value)) if (!checkFields.has(key)) throw new EligibilityPolicyError(`required check has unknown field ${key}`);
  for (const key of checkFields) if (!(key in value)) throw new EligibilityPolicyError(`required check is missing ${key}`);
  return {
    context: boundedString(value.context, "check.context", 1, 256),
    producer_id: boundedString(value.producer_id, "check.producer_id", 1, 128),
    accepted_conclusions: uniqueArray(arrayOfEnums(value.accepted_conclusions, checkConclusions, "check.accepted_conclusions", 1, 3), "check.accepted_conclusions"),
    max_age_seconds: value.max_age_seconds === null ? null : integerRange(value.max_age_seconds, "check.max_age_seconds", 1, 86400)
  };
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function canonicalStringify(value: unknown): string {
  const text = canonicalStringifyValue(value, { nodes: 0, seen: new WeakSet<object>() }, 0);
  if (new TextEncoder().encode(text).length > maxCanonicalBytes) throw new EligibilityPolicyError("canonical JSON exceeds bounded byte size");
  return text;
}

function canonicalStringifyValue(value: unknown, state: { nodes: number; readonly seen: WeakSet<object> }, depth: number): string {
  state.nodes += 1;
  if (state.nodes > maxCanonicalNodes) throw new EligibilityPolicyError("canonical JSON exceeds bounded node count");
  if (depth > maxCanonicalDepth) throw new EligibilityPolicyError("canonical JSON exceeds bounded depth");
  if (value === null) return "null";
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) throw new EligibilityPolicyError("canonical JSON string is malformed");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new EligibilityPolicyError("canonical JSON numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) throw new EligibilityPolicyError("canonical JSON cannot encode cyclic values");
    state.seen.add(value);
    const text = `[${value.map((item) => canonicalStringifyValue(item, state, depth + 1)).join(",")}]`;
    state.seen.delete(value);
    return text;
  }
  if (plainRecord(value)) {
    if (state.seen.has(value)) throw new EligibilityPolicyError("canonical JSON cannot encode cyclic values");
    state.seen.add(value);
    const keys = Object.keys(value).sort();
    const text = `{${keys.map((key) => {
      if (hasUnpairedSurrogate(key)) throw new EligibilityPolicyError("canonical JSON key is malformed");
      return `${JSON.stringify(key)}:${canonicalStringifyValue(value[key], state, depth + 1)}`;
    }).join(",")}}`;
    state.seen.delete(value);
    return text;
  }
  throw new EligibilityPolicyError("canonical JSON can only encode plain JSON values");
}

function jsonValue(value: unknown, label: string): JsonValue {
  try {
    canonicalStringify(value);
    return value as JsonValue;
  } catch (error) {
    if (error instanceof EligibilityPolicyError) throw new EligibilityPolicyError(`${label} ${error.message}`);
    throw error;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digestBytes = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer));
  return Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boundedString(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000\r]/u.test(value) || hasUnpairedSurrogate(value)) throw new EligibilityPolicyError(`${label} is malformed`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new EligibilityPolicyError(`${label} is malformed`);
  return value;
}

function integerRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new EligibilityPolicyError(`${label} is out of range`);
  return value;
}

function arrayOfEnums<T extends string>(value: unknown, allowed: readonly T[], label: string, minItems: number, maxItems: number): readonly T[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) throw new EligibilityPolicyError(`${label} is malformed`);
  return value.map((item) => enumValue(item, allowed, label));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new EligibilityPolicyError(`${label} is malformed`);
  return value as T;
}

function uniqueArray<T>(values: readonly T[], label: string): readonly T[] {
  if (values.length !== new Set(values).size) throw new EligibilityPolicyError(`${label} contains duplicates`);
  return values;
}

function reviewedDiffIdentity(value: unknown, headOid: string, baseOid: string): CandidateReviewedDiffIdentity {
  if (!record(value)) throw new EligibilityPolicyError("reviewedDiff is not an object");
  for (const key of Object.keys(value)) if (!reviewedDiffFields.has(key)) throw new EligibilityPolicyError(`reviewedDiff has unknown field ${key}`);
  for (const key of reviewedDiffFields) if (!(key in value)) throw new EligibilityPolicyError(`reviewedDiff is missing ${key}`);
  const reviewedHeadOid = oid(value.headOid, "reviewedDiff.headOid");
  const reviewedBaseOid = oid(value.baseOid, "reviewedDiff.baseOid");
  if (reviewedHeadOid !== headOid || reviewedBaseOid !== baseOid) throw new EligibilityPolicyError("reviewedDiff head/base identity does not match candidate plan");
  const mergeBaseOids = arrayOfOid(value.mergeBaseOids, "reviewedDiff.mergeBaseOids", 1, 64);
  return {
    headOid: reviewedHeadOid,
    baseOid: reviewedBaseOid,
    diffPatchSha256: digest(value.diffPatchSha256, "reviewedDiff.diffPatchSha256"),
    diffPatchLength: integerRange(value.diffPatchLength, "reviewedDiff.diffPatchLength", 0, maxReviewedDiffPatchLength),
    pathsDigest: digest(value.pathsDigest, "reviewedDiff.pathsDigest"),
    mergeBaseOids,
    algorithm: enumValue(value.algorithm, ["git-cli-unified-v1"], "reviewedDiff.algorithm"),
    comparison: enumValue(value.comparison, ["three_dot"], "reviewedDiff.comparison"),
    contextLines: integerRange(value.contextLines, "reviewedDiff.contextLines", 3, 3) as 3
  };
}

function arrayOfOid(value: unknown, label: string, minItems: number, maxItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) throw new EligibilityPolicyError(`${label} is malformed`);
  const oids = value.map((item, index) => oid(item, `${label}[${index}]`));
  return uniqueArray(oids, label);
}

function oid(value: unknown, label: string): string {
  const text = boundedString(value, label, 40, 40);
  if (!/^[0-9a-f]{40}$/u.test(text)) throw new EligibilityPolicyError(`${label} is malformed`);
  return text;
}

function digest(value: unknown, label: string): string {
  const text = boundedString(value, label, 64, 64);
  if (!/^[0-9a-f]{64}$/u.test(text)) throw new EligibilityPolicyError(`${label} is malformed`);
  return text;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return record(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function unique<T>(values: readonly T[]): readonly T[] {
  return Array.from(new Set(values));
}
