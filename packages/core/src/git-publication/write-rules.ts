import type { GitPublicationIntent, SourceRefChange } from "./index.js";

export type ForgeRuleState = "active" | "evaluate" | "disabled";
export type ForgeRuleTarget = "branch" | "tag";
export type ForgeMergeMethod = "merge" | "squash" | "rebase" | "fast-forward";
export type ForgeBypassSubjectKind = "group" | "service" | "installation";
export type ForgeCheckConclusion = "success" | "neutral" | "skipped";
export type GitObjectType = "commit" | "tag" | "tree" | "blob" | "none";
export type CommitSignatureStatus = "none" | "unsupported" | "valid" | "invalid" | "untrusted";

export interface ForgeTrustedCheckRequirement { readonly context: string; readonly producer_id: string; readonly accepted_conclusions: readonly ForgeCheckConclusion[]; readonly max_age_seconds: number | null }
export interface ForgeBypass { readonly subject_kind: ForgeBypassSubjectKind; readonly subject_id: string; readonly mode: "always" | "pull_request_only"; readonly expires_at: string | null }
export interface ForgeRuleSet {
  readonly id: string;
  readonly name: string;
  readonly state: ForgeRuleState;
  readonly target: ForgeRuleTarget;
  readonly include_patterns: readonly string[];
  readonly exclude_patterns: readonly string[];
  readonly require_pull_request: boolean;
  readonly required_approvals: number;
  readonly require_human_approval: boolean;
  readonly dismiss_stale_reviews: boolean;
  readonly require_latest_push_approval: boolean;
  readonly require_code_owners: boolean;
  readonly require_resolved_threads: boolean;
  readonly require_linear_history: boolean;
  readonly require_signed_commits: boolean;
  readonly require_merge_queue: boolean;
  readonly allow_force_push: boolean;
  readonly allow_deletion: boolean;
  readonly allowed_writer_group_ids: readonly string[];
  readonly required_checks: readonly ForgeTrustedCheckRequirement[];
  readonly required_environment_ids: readonly string[];
  readonly allowed_merge_methods: readonly ForgeMergeMethod[];
  readonly bypass: readonly ForgeBypass[];
  readonly max_blob_size_bytes: number | null;
  readonly forbidden_path_patterns: readonly string[];
  readonly mandatory: boolean;
}

export interface WriteRulePrincipalFacts { readonly groupIds: readonly string[]; readonly serviceIds?: readonly string[]; readonly installationIds?: readonly string[] }
export interface PreparedRefFacts { readonly ref: string; readonly oldSha: string | null; readonly newSha: string | null; readonly objectType: GitObjectType; readonly fastForward: boolean | null; readonly changedPaths: readonly string[] | null; readonly maxBlobSizeBytes: number | null; readonly signatures: readonly CommitSignatureStatus[] | null; readonly hasMergeCommit: boolean | null }
export interface TrustedCheckFact { readonly context: string; readonly producerId: string; readonly conclusion: ForgeCheckConclusion | "failure" | "cancelled" | "timed_out" | "action_required"; readonly observedAt: string; readonly candidateSha: string; readonly repositoryId: string }
export interface PullRequestRuleFacts { readonly id: string; readonly candidateSha: string; readonly method: ForgeMergeMethod; readonly approvals: number; readonly humanApprovals: number; readonly latestPushApproved: boolean | null; readonly codeOwnersApproved: boolean | null; readonly threadsResolved: boolean | null; readonly mergeQueueEntry: boolean; readonly environmentIds: readonly string[]; readonly checks: readonly TrustedCheckFact[]; readonly fresh: boolean }
export interface WriteRuleFacts { readonly refs: readonly PreparedRefFacts[]; readonly principal: WriteRulePrincipalFacts; readonly pullRequest: PullRequestRuleFacts | null }
export interface WriteRuleEvaluationInput { readonly intent: GitPublicationIntent; readonly rulesets: readonly unknown[]; readonly facts: WriteRuleFacts; readonly now: Date }
export interface WriteRuleBlocker { readonly code: string; readonly detail: string; readonly ruleId?: string; readonly ref?: string }
export interface WriteRuleObservation { readonly code: string; readonly detail: string; readonly ruleId?: string; readonly ref?: string }
export interface WriteRuleDecision { readonly allowed: boolean; readonly blockers: readonly WriteRuleBlocker[]; readonly observations: readonly WriteRuleObservation[]; readonly matchedRuleIds: readonly string[]; readonly evaluatedRuleIds: readonly string[] }

export interface SelectedWriteRule { readonly index: number; readonly rule: ForgeRuleSet }
export interface InvalidWriteRule { readonly index: number; readonly reason: string; readonly ruleId?: string }
export interface WriteRuleMatchIssue { readonly index: number; readonly code: "rule_match_work_exhausted" | "rule_match_input_malformed"; readonly detail: string; readonly ruleId: string; readonly ref: string }
export interface WriteRuleSelectionInput { readonly ref: string; readonly rulesets: readonly unknown[]; readonly matchableIndexes?: readonly number[] }
export interface WriteRuleSelectionResult { readonly validRules: readonly SelectedWriteRule[]; readonly invalidRules: readonly InvalidWriteRule[]; readonly matchIssues: readonly WriteRuleMatchIssue[]; readonly activeRules: readonly SelectedWriteRule[]; readonly evaluateRules: readonly SelectedWriteRule[]; readonly disabledRules: readonly SelectedWriteRule[] }

const canonicalFields = new Set(["id", "name", "state", "target", "include_patterns", "exclude_patterns", "require_pull_request", "required_approvals", "require_human_approval", "dismiss_stale_reviews", "require_latest_push_approval", "require_code_owners", "require_resolved_threads", "require_linear_history", "require_signed_commits", "require_merge_queue", "allow_force_push", "allow_deletion", "allowed_writer_group_ids", "required_checks", "required_environment_ids", "allowed_merge_methods", "bypass", "max_blob_size_bytes", "forbidden_path_patterns", "mandatory"]);
const mergeMethods: readonly ForgeMergeMethod[] = ["merge", "squash", "rebase", "fast-forward"];
const checkConclusions: readonly ForgeCheckConclusion[] = ["success", "neutral", "skipped"];
const signatureFailures = new Set<CommitSignatureStatus>(["none", "unsupported", "invalid", "untrusted"]);
const maxDiagnosticFragmentLength = 64;
const maxRefMatchCodePoints = 4096;
const maxPathMatchCodePoints = 65535;
const matchWorkLimit = 2_000_000;

type GlobToken = { readonly kind: "literal"; readonly value: string } | { readonly kind: "star" | "doubleStar" | "question" };
type GlobMatchResult = "match" | "no_match" | "exhausted" | "invalid";

interface MatchBudget { remaining: number }

export function selectWriteRulesForRef(input: WriteRuleSelectionInput): WriteRuleSelectionResult {
  const budget: MatchBudget = { remaining: matchWorkLimit };
  const validRules: SelectedWriteRule[] = [];
  const invalidRules: InvalidWriteRule[] = [];
  const matchIssues: WriteRuleMatchIssue[] = [];
  const activeRules: SelectedWriteRule[] = [];
  const evaluateRules: SelectedWriteRule[] = [];
  const disabledRules: SelectedWriteRule[] = [];

  input.rulesets.forEach((candidate, index) => {
    const parsed = parseRuleSet(candidate, index);
    if (parsed.kind === "invalid") {
      invalidRules.push({ index, reason: parsed.reason, ...(parsed.ruleId ? { ruleId: parsed.ruleId } : {}) });
      return;
    }
    const selected = { index, rule: parsed.rule };
    validRules.push(selected);
    if (parsed.rule.state === "disabled") { disabledRules.push(selected); return; }
    if (input.matchableIndexes && !input.matchableIndexes.includes(index)) return;
    if (!ruleTargetsRef(parsed.rule, input.ref)) return;
    const refMatch = matchesRef(parsed.rule, input.ref, budget);
    if (refMatch === "exhausted") {
      matchIssues.push({ index, code: "rule_match_work_exhausted", detail: "write rule matching exceeded bounded work", ruleId: parsed.rule.id, ref: input.ref });
      return;
    }
    if (refMatch === "invalid") {
      matchIssues.push({ index, code: "rule_match_input_malformed", detail: "write rule matching input is malformed or too large", ruleId: parsed.rule.id, ref: input.ref });
      return;
    }
    if (refMatch === "no_match") return;
    if (parsed.rule.state === "active") activeRules.push(selected);
    else if (parsed.rule.state === "evaluate") evaluateRules.push(selected);
    else disabledRules.push(selected);
  });

  return { validRules, invalidRules, matchIssues, activeRules, evaluateRules, disabledRules };
}

export function evaluateWriteRules(input: WriteRuleEvaluationInput): WriteRuleDecision {
  const blockers: WriteRuleBlocker[] = [];
  const observations: WriteRuleObservation[] = [];
  const budget: MatchBudget = { remaining: matchWorkLimit };
  const parsed = input.rulesets.map((candidate, index) => parseRuleSet(candidate, index));
  for (const result of parsed) if (result.kind === "invalid") blockers.push({ code: "ruleset_malformed", detail: result.reason, ...(result.ruleId ? { ruleId: result.ruleId } : {}) });
  const rules = parsed.flatMap((result) => result.kind === "valid" ? [result.rule] : []);
  const matchedRuleIds: string[] = [];
  const evaluatedRuleIds: string[] = [];

  for (const change of input.intent.changes) {
    const refFact = input.facts.refs.find((fact) => fact.ref === change.ref);
    if (!refFact) { blockers.push({ code: "prepared_ref_facts_missing", detail: `missing prepared facts for ${change.ref}`, ref: change.ref }); continue; }
    if (refFact.oldSha !== change.old_sha || refFact.newSha !== change.new_sha) blockers.push({ code: "prepared_ref_facts_mismatch", detail: "prepared facts do not match publication intent", ref: change.ref });
    for (const rule of rules) {
      if (rule.state === "disabled" || !ruleTargetsRef(rule, change.ref)) continue;
      const refMatch = matchesRef(rule, change.ref, budget);
      if (refMatch === "exhausted") { blockers.push({ code: "rule_match_work_exhausted", detail: "write rule matching exceeded bounded work", ruleId: rule.id, ref: change.ref }); continue; }
      if (refMatch === "invalid") { blockers.push({ code: "rule_match_input_malformed", detail: "write rule matching input is malformed or too large", ruleId: rule.id, ref: change.ref }); continue; }
      if (refMatch === "no_match") continue;
      const bypassed = false;
      if (rule.state === "active") matchedRuleIds.push(rule.id); else evaluatedRuleIds.push(rule.id);
      const target = rule.state === "evaluate" || bypassed ? observations : blockers;
      evaluateRule(rule, change, refFact, input, target, rule.state === "evaluate" ? "evaluate" : bypassed ? "bypass" : "active", budget);
    }
  }

  return { allowed: blockers.length === 0, blockers, observations, matchedRuleIds: unique(matchedRuleIds), evaluatedRuleIds: unique(evaluatedRuleIds) };
}

function evaluateRule(rule: ForgeRuleSet, change: SourceRefChange, refFact: PreparedRefFacts, input: WriteRuleEvaluationInput, out: Array<WriteRuleBlocker | WriteRuleObservation>, mode: "active" | "evaluate" | "bypass", budget: MatchBudget) {
  const add = (code: string, detail: string) => out.push({ code: mode === "evaluate" ? `evaluate:${code}` : mode === "bypass" ? `bypassed:${code}` : code, detail, ruleId: rule.id, ref: change.ref });
  const pr = input.facts.pullRequest;
  const isDeletion = change.new_sha === null;
  const isUpdate = change.old_sha !== null && change.new_sha !== null;
  const isForce = change.force || (isUpdate && refFact.fastForward === false);

  if (rule.allowed_writer_group_ids.length > 0 && !intersects(input.facts.principal.groupIds, rule.allowed_writer_group_ids)) add("writer_group_denied", "principal is not in an allowed writer group");
  if (isDeletion && !rule.allow_deletion) add("deletion_denied", "matched rule prohibits ref deletion");
  if (isUpdate && refFact.fastForward === null && !rule.allow_force_push) add("force_proof_unavailable", "matched rule requires current ancestry proof");
  if (isForce && !rule.allow_force_push) add("force_push_denied", "matched rule prohibits non-fast-forward updates");

  if (rule.require_linear_history) {
    if (refFact.hasMergeCommit === null) add("linear_history_unavailable", "prepared facts do not include merge commit evidence");
    else if (refFact.hasMergeCommit) add("linear_history_denied", "matched rule requires linear history");
  }
  if (rule.require_signed_commits) {
    if (refFact.signatures === null) add("signature_evidence_unavailable", "prepared facts do not include commit signature evidence");
    else if (change.new_sha !== null && refFact.signatures.length === 0) add("signature_evidence_unavailable", "prepared facts do not include commit signature evidence");
    else if (refFact.signatures.some((status) => signatureFailures.has(status))) add("signed_commit_denied", "matched rule requires trusted signatures on every new commit");
  }
  if (rule.max_blob_size_bytes !== null) {
    if (refFact.maxBlobSizeBytes === null) add("blob_size_unavailable", "prepared facts do not include maximum blob size");
    else if (refFact.maxBlobSizeBytes > rule.max_blob_size_bytes) add("blob_size_denied", "new blob exceeds matched rule maximum");
  }
  if (rule.forbidden_path_patterns.length > 0) {
    if (refFact.changedPaths === null) add("path_evidence_unavailable", "prepared facts do not include changed paths");
    else for (const path of refFact.changedPaths) {
      if (!validMatchValue(path, maxPathMatchCodePoints)) { add("path_evidence_malformed", "prepared changed path is malformed or too large"); continue; }
      for (const pattern of rule.forbidden_path_patterns) {
        const pathMatch = globMatches(pattern, path, budget, maxPathMatchCodePoints);
        if (pathMatch === "exhausted") { add("rule_match_work_exhausted", "write rule matching exceeded bounded work"); break; }
        if (pathMatch === "invalid") { add("path_rule_malformed", "matched rule contains a malformed path pattern"); break; }
        if (pathMatch === "match") { add("forbidden_path_denied", `changed path ${path} is forbidden`); break; }
      }
    }
  }

  const needsPr = rule.require_pull_request || rule.required_approvals > 0 || rule.require_human_approval || rule.dismiss_stale_reviews || rule.require_latest_push_approval || rule.require_code_owners || rule.require_resolved_threads || rule.require_merge_queue || rule.required_checks.length > 0 || rule.required_environment_ids.length > 0;
  if (needsPr && pr === null) { add("pull_request_required", "matched rule requires current pull request eligibility evidence"); return; }
  if (pr === null) return;
  if (change.new_sha !== null && pr.candidateSha !== change.new_sha) add("pull_request_candidate_mismatch", "pull request eligibility is not bound to the pushed candidate");
  if (!pr.fresh) add("pull_request_stale", "pull request eligibility snapshot is stale");
  if (!rule.allowed_merge_methods.includes(pr.method)) add("merge_method_denied", "pull request merge method is not allowed by matched rule");
  if (pr.approvals < rule.required_approvals) add("approval_count_denied", "not enough current approvals for matched rule");
  if (rule.require_human_approval && pr.humanApprovals < 1) add("human_approval_denied", "matched rule requires at least one human approval");
  if (rule.dismiss_stale_reviews && !pr.fresh) add("stale_reviews_denied", "matched rule dismisses stale reviews");
  if (rule.require_latest_push_approval && pr.latestPushApproved === null) add("latest_push_evidence_unavailable", "current latest push approval evidence is unavailable");
  else if (rule.require_latest_push_approval && !pr.latestPushApproved) add("latest_push_approval_denied", "matched rule requires latest push approval");
  if (rule.require_code_owners && pr.codeOwnersApproved === null) add("code_owner_evidence_unavailable", "current code owner approval evidence is unavailable");
  else if (rule.require_code_owners && !pr.codeOwnersApproved) add("code_owner_denied", "matched rule requires current code owner approval");
  if (rule.require_resolved_threads && pr.threadsResolved === null) add("thread_evidence_unavailable", "current thread resolution evidence is unavailable");
  else if (rule.require_resolved_threads && !pr.threadsResolved) add("threads_unresolved", "matched rule requires resolved threads");
  if (rule.require_merge_queue && !pr.mergeQueueEntry) add("merge_queue_required", "matched rule requires merge queue admission");
  for (const envId of rule.required_environment_ids) if (!pr.environmentIds.includes(envId)) add("environment_required", `required environment ${envId} is not satisfied`);
  for (const requirement of rule.required_checks) if (!hasTrustedCheck(requirement, pr, input.intent.repositoryId, input.now)) add("required_check_missing", `required check ${requirement.producer_id}/${requirement.context} is not satisfied`);
}

function hasTrustedCheck(requirement: ForgeTrustedCheckRequirement, pr: PullRequestRuleFacts, repositoryId: string, now: Date): boolean {
  return pr.checks.some((check) => check.context === requirement.context && check.producerId === requirement.producer_id && check.repositoryId === repositoryId && check.candidateSha === pr.candidateSha && requirement.accepted_conclusions.includes(check.conclusion as ForgeCheckConclusion) && withinMaxAge(check.observedAt, requirement.max_age_seconds, now));
}

function withinMaxAge(observedAt: string, maxAgeSeconds: number | null, now: Date): boolean {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || observed > now.getTime()) return false;
  return maxAgeSeconds === null || now.getTime() - observed <= maxAgeSeconds * 1000;
}

function parseRuleSet(value: unknown, index: number): { readonly kind: "valid"; readonly rule: ForgeRuleSet } | { readonly kind: "invalid"; readonly reason: string; readonly ruleId?: string } {
  if (!record(value)) return { kind: "invalid", reason: `ruleset at index ${index} is not an object` };
  const id = diagnosticRuleId(value.id);
  const label = diagnosticRuleLabel(id, index);
  try {
    for (const key of Object.keys(value)) if (!canonicalFields.has(key)) return { kind: "invalid", reason: `${label} has unknown field ${diagnosticFragment(key)}`, ...(id ? { ruleId: id } : {}) };
    const missing = [...canonicalFields].filter((key) => !(key in value));
    if (missing.length > 0) return { kind: "invalid", reason: `${label} is missing ${missing[0]}`, ...(id ? { ruleId: id } : {}) };
    const checks = parseChecks(value.required_checks);
    const bypass = parseBypass(value.bypass);
    const rule = {
      id: boundedString(value.id, 1, 128), name: boundedString(value.name, 1, 256), state: enumValue(value.state, ["active", "evaluate", "disabled"]), target: enumValue(value.target, ["branch", "tag"]),
      include_patterns: patternArray(value.include_patterns, 1, 1000), exclude_patterns: patternArray(value.exclude_patterns, 0, 1000),
      require_pull_request: booleanValue(value.require_pull_request), required_approvals: integerRange(value.required_approvals, 0, 20), require_human_approval: booleanValue(value.require_human_approval), dismiss_stale_reviews: booleanValue(value.dismiss_stale_reviews), require_latest_push_approval: booleanValue(value.require_latest_push_approval), require_code_owners: booleanValue(value.require_code_owners), require_resolved_threads: booleanValue(value.require_resolved_threads), require_linear_history: booleanValue(value.require_linear_history), require_signed_commits: booleanValue(value.require_signed_commits), require_merge_queue: booleanValue(value.require_merge_queue), allow_force_push: booleanValue(value.allow_force_push), allow_deletion: booleanValue(value.allow_deletion),
      allowed_writer_group_ids: uniqueArray(stringArray(value.allowed_writer_group_ids, 0, 1000, 128)), required_checks: checks, required_environment_ids: uniqueArray(stringArray(value.required_environment_ids, 0, 1000, 128)), allowed_merge_methods: uniqueArray(arrayOfEnums(value.allowed_merge_methods, mergeMethods, 1, 4)), bypass, max_blob_size_bytes: nullableIntegerRange(value.max_blob_size_bytes, 1, 1099511627776), forbidden_path_patterns: patternArray(value.forbidden_path_patterns, 0, 1000), mandatory: booleanValue(value.mandatory)
    } satisfies ForgeRuleSet;
    const invalid = validateRule(rule);
    return invalid ? { kind: "invalid", reason: `${label} ${invalid}`, ...(id ? { ruleId: id } : {}) } : { kind: "valid", rule };
  } catch {
    return { kind: "invalid", reason: `${label} is malformed`, ...(id ? { ruleId: id } : {}) };
  }
}

function validateRule(rule: ForgeRuleSet): string | null {
  if (rule.include_patterns.some((pattern) => !validPattern(pattern)) || rule.exclude_patterns.some((pattern) => !validPattern(pattern)) || rule.forbidden_path_patterns.some((pattern) => !validPattern(pattern))) return "has an invalid pattern";
  if (rule.allowed_writer_group_ids.length !== new Set(rule.allowed_writer_group_ids).size) return "has duplicate allowed writer groups";
  if (rule.required_environment_ids.length !== new Set(rule.required_environment_ids).size) return "has duplicate required environments";
  return null;
}

function parseChecks(value: unknown): readonly ForgeTrustedCheckRequirement[] {
  if (!Array.isArray(value) || value.length > 100) throwParse();
  return value.map((item) => {
    if (!record(item)) throwParse();
    if (Object.keys(item).some((key) => !["context", "producer_id", "accepted_conclusions", "max_age_seconds"].includes(key))) throwParse();
    return { context: boundedString(item.context, 1, 256), producer_id: boundedString(item.producer_id, 1, 128), accepted_conclusions: uniqueArray(arrayOfEnums(item.accepted_conclusions, checkConclusions, 1, 3)), max_age_seconds: nullableIntegerRange(item.max_age_seconds, 1, 86400) };
  });
}

function parseBypass(value: unknown): readonly ForgeBypass[] {
  if (!Array.isArray(value) || value.length > 100) throwParse();
  return value.map((item) => {
    if (!record(item)) throwParse();
    if (Object.keys(item).some((key) => !["subject_kind", "subject_id", "mode", "expires_at"].includes(key))) throwParse();
    return { subject_kind: enumValue(item.subject_kind, ["group", "service", "installation"]), subject_id: boundedString(item.subject_id, 1, 128), mode: enumValue(item.mode, ["always", "pull_request_only"]), expires_at: item.expires_at === null ? null : boundedString(item.expires_at, 1, 64) };
  });
}

function ruleTargetsRef(rule: ForgeRuleSet, ref: string): boolean { return rule.target === "branch" ? ref.startsWith("refs/heads/") : ref.startsWith("refs/tags/"); }
function matchesRef(rule: ForgeRuleSet, ref: string, budget: MatchBudget): GlobMatchResult {
  if (!validMatchValue(ref, maxRefMatchCodePoints)) return "invalid";
  let included = false;
  for (const pattern of rule.include_patterns) {
    const result = globMatches(pattern, ref, budget, maxRefMatchCodePoints);
    if (result === "exhausted" || result === "invalid") return result;
    if (result === "match") { included = true; break; }
  }
  if (!included) return "no_match";
  for (const pattern of rule.exclude_patterns) {
    const result = globMatches(pattern, ref, budget, maxRefMatchCodePoints);
    if (result === "exhausted" || result === "invalid") return result;
    if (result === "match") return "no_match";
  }
  return "match";
}
function globMatches(pattern: string, value: string, budget: MatchBudget, maxValueCodePoints: number): GlobMatchResult {
  if (!validPattern(pattern) || !validMatchValue(value, maxValueCodePoints)) return "invalid";
  const tokens = tokenizeGlob(pattern);
  const chars = Array.from(value);
  let previous = new Array<boolean>(chars.length + 1).fill(false);
  previous[0] = true;
  for (const token of tokens) {
    const current = new Array<boolean>(chars.length + 1).fill(false);
    if (token.kind === "star" || token.kind === "doubleStar") {
      for (let index = 0; index <= chars.length; index += 1) {
        if (!consumeMatchWork(budget)) return "exhausted";
        if (previous[index]) current[index] = true;
        if (index < chars.length && current[index] && (token.kind === "doubleStar" || chars[index] !== "/")) current[index + 1] = true;
      }
    } else {
      for (let index = 0; index < chars.length; index += 1) {
        if (!consumeMatchWork(budget)) return "exhausted";
        if (previous[index] && tokenMatches(token, chars[index]!)) current[index + 1] = true;
      }
    }
    previous = current;
    if (!previous.some(Boolean)) return "no_match";
  }
  return previous[chars.length] ? "match" : "no_match";
}
function tokenizeGlob(pattern: string): readonly GlobToken[] {
  const chars = Array.from(pattern);
  const tokens: GlobToken[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === "*" && chars[index + 1] === "*") { tokens.push({ kind: "doubleStar" }); index += 1; }
    else if (char === "*") tokens.push({ kind: "star" });
    else if (char === "?") tokens.push({ kind: "question" });
    else tokens.push({ kind: "literal", value: char });
  }
  return tokens;
}
function tokenMatches(token: GlobToken, char: string): boolean {
  if (token.kind === "literal") return token.value === char;
  if (token.kind === "question") return char !== "/";
  return false;
}
function consumeMatchWork(budget: MatchBudget): boolean { budget.remaining -= 1; return budget.remaining >= 0; }
function validPattern(pattern: string): boolean { return pattern.length > 0 && pattern.length <= 1024 && validMatchValue(pattern, 1024) && !/\r/u.test(pattern); }
function validMatchValue(value: string, maxCodePoints: number): boolean { return value.length > 0 && Array.from(value).length <= maxCodePoints && !/[\u0000\r]/u.test(value) && !hasUnpairedSurrogate(value); }
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
function diagnosticRuleId(value: unknown): string | undefined { return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000\r\n]/u.test(value) && !hasUnpairedSurrogate(value) ? value : undefined; }
function diagnosticRuleLabel(id: string | undefined, index: number): string { return id ? `ruleset ${diagnosticFragment(id)}` : `ruleset ${index}`; }
function diagnosticFragment(value: string): string { return validMatchValue(value, maxDiagnosticFragmentLength) ? value : "<redacted>"; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedString(value: unknown, min: number, max: number): string { if (typeof value !== "string" || value.length < min || value.length > max || /\u0000/u.test(value) || hasUnpairedSurrogate(value)) throwParse(); return value; }
function booleanValue(value: unknown): boolean { if (typeof value !== "boolean") throwParse(); return value; }
function integerRange(value: unknown, min: number, max: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throwParse(); return value; }
function nullableIntegerRange(value: unknown, min: number, max: number): number | null { return value === null ? null : integerRange(value, min, max); }
function stringArray(value: unknown, minItems: number, maxItems: number, maxLength: number): readonly string[] { if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) throwParse(); return value.map((item) => boundedString(item, 1, maxLength)); }
function patternArray(value: unknown, minItems: number, maxItems: number): readonly string[] { if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) throwParse(); return value.map((item) => typeof item === "string" && item.length >= 1 && item.length <= 1024 && !/\u0000/u.test(item) ? item : throwParse()); }
function arrayOfEnums<T extends string>(value: unknown, allowed: readonly T[], minItems: number, maxItems: number): readonly T[] { if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) throwParse(); return value.map((item) => enumValue(item, allowed)); }
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== "string" || !allowed.includes(value as T)) throwParse(); return value as T; }
function unique<T>(values: readonly T[]): readonly T[] { return Array.from(new Set(values)); }
function uniqueArray<T>(values: readonly T[]): readonly T[] { if (values.length !== new Set(values).size) throwParse(); return values; }
function intersects(a: readonly string[], b: readonly string[]): boolean { return a.some((value) => b.includes(value)); }
function throwParse(): never { throw new Error("invalid ruleset"); }
