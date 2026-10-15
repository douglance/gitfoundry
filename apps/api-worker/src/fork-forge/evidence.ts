import { Schema } from "effect";
import { canonicalJson, type ForgeActor, type ForgeGitPort, type ForgeVersion } from "@gitfoundry/core";
import { publicationPolicyPath, protectedPublicationPaths, type PublicationConfigurationApproval, type PublicationEvidenceVerifierInput, type PublicationEvidenceResult, type PublicationEvidenceRecord } from "./evidence-model.js";
import { readJson, parsePolicy, parseEvidenceRecord, object, sha40, fail } from "./evidence-parsing.js";
import { verifyChecks, verifyReviews, verifyConfiguration, verificationResult } from "./evidence-verification.js";
import { collaborationOnlyState } from "./collaboration-publication.js";

export * from "./evidence-model.js";
export { publicationEvidencePayload, canonicalPublicationEvidencePayload } from "./evidence-payload.js";

export async function publicationConfigurationFiles(git: Pick<ForgeGitPort, "readFile">, stateCommit: string): Promise<Record<string, string | null>> {
  const files: Record<string, string | null> = {};
  for (const path of protectedPublicationPaths) files[path] = await git.readFile(stateCommit, path);
  return files;
}

export async function configurationReviewFor(git: Pick<ForgeGitPort, "readFile"> & Partial<Pick<ForgeGitPort, "readRef">>, context: { readonly actor: ForgeActor; readonly parent: ForgeVersion; readonly record: object }): Promise<{ readonly configuration: PublicationConfigurationApproval; readonly policyStateCommit: string } | undefined> {
  const options = Schema.decodeUnknownSync(Schema.Struct({ configuration: Schema.optionalKey(Schema.Unknown), configuration_review: Schema.optionalKey(Schema.Unknown), reason: Schema.optionalKey(Schema.Unknown) }))(context.record);
  if (options.configuration !== undefined) throw fail("invalid_evidence", "configuration approval must be bound by the authenticated signer");
  if (options.configuration_review !== true) return undefined;
  if (context.actor.kind !== "human" || !git.readRef) throw fail("untrusted_actor", "configuration review requires an authenticated human and canonical ref access");
  let reason: string;
  try { reason = Schema.decodeUnknownSync(Schema.NonEmptyString)(options.reason).trim(); }
  catch { throw fail("invalid_evidence", "configuration reason must be a non-empty string"); }
  if (!reason) throw fail("invalid_evidence", "configuration review requires a reason");
  const expectedVersion = await git.readRef("refs/heads/forge-head");
  if (!expectedVersion) throw fail("policy_missing", "configuration review requires a canonical version");
  const descriptor = object(await readJson(git, expectedVersion, "forge.json", "invalid_evidence"), "canonical descriptor", "invalid_evidence");
  if (descriptor.code_commit !== context.parent.descriptor.code_commit) throw fail("candidate_mismatch", "configuration changes must preserve the accepted code commit");
  const stateCommit = sha40(descriptor.state_commit, "canonical state commit", "invalid_evidence");
  return { policyStateCommit: stateCommit, configuration: { expected_version: expectedVersion, files: await publicationConfigurationFiles(git, context.parent.descriptor.state_commit), reason } };
}


export async function verifyPublicationEvidence(input: PublicationEvidenceVerifierInput): Promise<PublicationEvidenceResult> {
  const expected = input.context.expected;
  if (expected === null) throw fail("policy_missing", "publication policy requires an expected version");
  const policy = parsePolicy(await readJson(input.git, expected.descriptor.state_commit, publicationPolicyPath, "policy_missing"));
  const code = input.context.candidate.descriptor.code_commit;
  const state = input.context.candidate.descriptor.state_commit;
  const context = { input, policy, code };
  if (code === expected.descriptor.code_commit && await collaborationOnlyState(input.git, expected.descriptor.state_commit, state)) return verificationResult(context, new Set(), new Set());
  const checks = await readEvidenceRecords(input.git, state, "checks");
  const reviews = await readEvidenceRecords(input.git, state, "reviews");
  const before = await publicationConfigurationFiles(input.git, expected.descriptor.state_commit);
  const after = await publicationConfigurationFiles(input.git, state);
  if (canonicalJson(before) !== canonicalJson(after)) {
    if (code !== expected.descriptor.code_commit) throw fail("candidate_mismatch", "configuration publication cannot change accepted code");
    parsePolicy(await readJson(input.git, state, publicationPolicyPath, "policy_missing"));
    // A forge whose current rules need no approval may change those rules the same way. Its trusted keys still need a person.
    if (policy.reviews.required_approvals === 0 && before["config/trusted-keys.json"] === after["config/trusted-keys.json"]) return verificationResult(context, new Set(), new Set());
    const approvals = await verifyConfiguration(reviews, context, expected.version_commit, after);
    return verificationResult(context, new Set(), approvals);
  }
  const verifiedChecks = await verifyChecks(checks, context);
  const approvals = await verifyReviews(reviews, context);
  return verificationResult(context, verifiedChecks, approvals);
}
async function readEvidenceRecords(git: Pick<ForgeGitPort, "readFile" | "listTree">, commit: string, directory: "checks" | "reviews"): Promise<readonly PublicationEvidenceRecord[]> {
  const entries = await git.listTree(commit, `${directory}/`);
  const pattern = new RegExp(`^${directory}/[^/]+\\.json$`);
  const paths = entries.map((entry) => entry.path).filter((path) => pattern.test(path)).sort();
  const records: PublicationEvidenceRecord[] = [];
  for (const path of paths) records.push(parseEvidenceRecord(await readJson(git, commit, path, "invalid_evidence")));
  return records;
}

