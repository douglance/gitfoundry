#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const ciImage = process.env.GITFOUNDRY_CANDIDATE_CI_IMAGE || "gitfoundry-candidate-ci-test:local";
const helperImage = process.env.GITFOUNDRY_CANDIDATE_CI_HELPER_IMAGE || "gitfoundry-candidate-ci-helper-test:local";
const tenant = "tenant-a";
const repository = "repo-a";
const imageDigest = "sha256:" + "a".repeat(64);
const configuredCiImage = `example.invalid/gitfoundry-ci@${imageDigest}`;
const helperDigestRef = "registry.example.com/gitfoundry/helper@sha256:" + "b".repeat(64);

async function main() {
  await run("docker", ["build", "--platform", "linux/amd64", "-f", resolve(repoRoot, "images/git-helper/Dockerfile"), "-t", helperImage, resolve(repoRoot, "images")], { expectExit: 0 });
  await run("docker", ["build", "--platform", "linux/amd64", "-f", resolve(repoRoot, "images/ci-runner/Dockerfile"), "-t", ciImage, resolve(repoRoot, "images")], { expectExit: 0 });
  const root = await mkdtemp(join(tmpdir(), "gitfoundry-candidate-ci-"));
  try {
    await mkdir(join(root, "work"), { recursive: true });
    const execution = await loadExecutionModule(root);
    const candidateCi = await loadCandidateCiModule(root);
    const pipeline = await loadPipelineModule(root);
    const nativeController = await loadNativeControllerModule(root);
    const nativeStore = await loadNativeStoreModule(root);
    const store = new FixtureArtifactStore();
    const pass = await prepareStoredCandidate(root, pipeline, store, "pass", "echo PASS-FROM-CANDIDATE; test -f head.txt; test -f target.txt; test \"${GFY_SECRET_TOKEN:-}\" = \"\"\n");
    const fail = await prepareStoredCandidate(root, pipeline, store, "fail", "echo FAIL-FROM-CANDIDATE; exit 42\n");
    await assertCanonicalRequestDigest(candidateCi, pass);
    await assertCandidateCi(execution, root, store, pass, { name: "pass", expectStatus: "succeeded", expectExit: 0, stdout: "PASS-FROM-CANDIDATE" });
    await assertCandidateCi(execution, root, store, fail, { name: "fail", expectStatus: "failed", expectExit: 42, stdout: "FAIL-FROM-CANDIDATE" });
    await assertNativeControllerCandidateCi(nativeController, nativeStore, root, store, pass, { name: "controller-pass", conclusion: "success", exitCode: 0, stdout: "PASS-FROM-CANDIDATE" });
    await assertNativeControllerCandidateCi(nativeController, nativeStore, root, store, fail, { name: "controller-fail", conclusion: "failure", exitCode: 42, stdout: "FAIL-FROM-CANDIDATE" });
    await assertManifestRequired(execution, root, store, pass);
    await assertResultRawDigestBound(execution, root, store, pass);
    await assertRawCommitDenied(execution, root, store, pass);
    await assertReplayConflict(execution, root, store, pass);
    console.log(JSON.stringify({ ok: true, ci_image: ciImage, helper_image: helperImage, helper: "/usr/local/bin/gitfoundry-ci-step", artifact_root: root }));
  } finally {
    if (!process.env.GITFOUNDRY_KEEP_CANDIDATE_CI_TMP) await rm(root, { recursive: true, force: true });
  }
}

async function loadExecutionModule(root) { return loadBundled(root, "apps/api-worker/src/linux/execution.ts", "candidate-ci-execution.bundle.mjs"); }
async function loadCandidateCiModule(root) { return loadBundled(root, "apps/api-worker/src/candidate-ci/index.ts", "candidate-ci.bundle.mjs"); }
async function loadPipelineModule(root) { return loadBundled(root, "apps/api-worker/src/merge-candidate/pipeline.ts", "merge-candidate-pipeline.bundle.mjs"); }
async function loadNativeControllerModule(root) { return loadBundled(root, "apps/api-worker/src/native-jobs/controller.ts", "native-jobs-controller.bundle.mjs"); }
async function loadNativeStoreModule(root) { return loadBundled(root, "apps/api-worker/src/native-jobs/store.ts", "native-jobs-store.bundle.mjs"); }
async function loadBundled(root, entry, outName) {
  const shim = join(root, `${outName}.cloudflare-workers-shim.js`);
  const bundle = join(root, outName);
  await writeFile(shim, "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\nexport class WorkerEntrypoint {}\n", "utf8");
  await run("pnpm", ["exec", "esbuild", entry, "--bundle", "--platform=node", "--format=esm", "--alias:cloudflare:workers=" + shim, "--outfile=" + bundle], { cwd: repoRoot, expectExit: 0 });
  return import("file://" + bundle + "?t=" + Date.now() + Math.random());
}

async function prepareStoredCandidate(root, pipeline, store, name, scriptBody) {
  const fixture = await createPipelineFixture(root, name, scriptBody);
  const sources = await seedSourceArtifacts(store, fixture, name, repository, "fixture/source.git");
  const operationId = `ci-op-${name}`;
  await mkdir(join(root, "work", tenant, repository, operationId, "trusted-git"), { recursive: true });
  const input = { commandId: `prepare-${name}`, tenantId: tenant, repositoryId: repository, operationId, fenceToken: `fence-prepare-${name}`, pullRequestId: "pr-a", pullRequestVersion: 7, headSha: fixture.head, baseSha: fixture.base, method: "merge", committerName: "GitFoundry Merge Bot", committerEmail: "merge-bot@gitfoundry.invalid", committedAt: "2026-10-08T00:00:00.000Z", message: `${name} merge candidate` };
  const outcome = await pipeline.prepareStoredMergeCandidate(new DockerContainer(root, helperImage, helperDigestRef), input, sources, store, { GFY_TRUSTED_GIT_HELPER_IMAGE: helperDigestRef });
  if (outcome.result.ok !== true || !outcome.candidate) throw new Error(`pipeline ${name} did not prepare candidate: ${JSON.stringify(outcome.result)}`);
  if (outcome.result.candidateOid === fixture.head || outcome.result.candidateOid === fixture.base) throw new Error("fixture did not produce distinct H/B/C candidate");
  await assertStoredCandidateMatchesGit(store, outcome.candidate, fixture);
  return { ...fixture, operationId, input, stored: outcome.candidate, candidate: outcome.result.candidateOid };
}

async function createPipelineFixture(root, name, scriptBody) {
  const work = join(root, `pipeline-${name}-source`);
  await mkdir(join(work, ".gitfoundry"), { recursive: true });
  await git(["-C", work, "init", "-q", "-b", "main"]);
  await git(["-C", work, "config", "user.name", "Source Author"]);
  await git(["-C", work, "config", "user.email", "source@example.invalid"]);
  await writeFile(join(work, "base.txt"), "base\n", "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "base"]);
  const rootBase = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "checkout", "-q", "-b", "head", rootBase]);
  await writeFile(join(work, "head.txt"), `${name} head\n`, "utf8");
  await writeFile(join(work, ".gitfoundry", "ci.sh"), "#!/bin/sh\nset -eu\n" + scriptBody, "utf8");
  await chmod(join(work, ".gitfoundry", "ci.sh"), 0o755);
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", `${name} head`]);
  const head = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "checkout", "-q", "-b", "target", rootBase]);
  await writeFile(join(work, "target.txt"), `${name} target\n`, "utf8");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", `${name} target`]);
  const base = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  return { work, base, head, targetPack: await makePack(work, base), headPack: await makePack(work, head) };
}

async function seedSourceArtifacts(store, fixture, name, sourceRepositoryId, providerRepository) {
  const target = await seedSourceArtifact(store, name, "source_target_pack", repository, "fixture/target.git", fixture.base, fixture.targetPack);
  const head = await seedSourceArtifact(store, name, "source_head_pack", sourceRepositoryId, providerRepository, fixture.head, fixture.headPack);
  return { target, head, sourceRepositoryId };
}
async function seedSourceArtifact(store, name, role, sourceRepoId, providerRepository, oid, pack) {
  const sourceOp = `fixture-${name}-${role}`;
  const publicInput = { tenant_id: tenant, repository_id: sourceRepoId, operation_id: sourceOp, fence_token: `fence-${name}`, provider_repository: providerRepository, ref: role === "source_target_pack" ? "refs/heads/target" : "refs/heads/head", expected_oid: oid, role, output_dir: `/work/${tenant}/${sourceRepoId}/${sourceOp}/source-pack` };
  const requestSha256 = sha256(Buffer.from(canonicalJson(publicInput)));
  const packSha = sha256(pack);
  const manifest = JSON.stringify({ frame: "gitfoundry.source-pack.manifest.v1", public: publicInput, request_sha256: requestSha256, pack: { filename: "source.pack", sha256: packSha, size_bytes: pack.length }, git_version: "2.39.5" }) + "\n";
  const manifestBytes = Buffer.from(manifest, "utf8");
  const manifestLocator = await store.putAppendOnly({ tenantId: tenant, repositoryId: sourceRepoId, operationId: sourceOp, requestSha256, kind: "source_manifest", body: bytesToStream(manifestBytes), expectedSha256: sha256(manifestBytes), expectedSizeBytes: manifestBytes.length, contentType: "application/json", expiresAt: null });
  const packLocator = await store.putAppendOnly({ tenantId: tenant, repositoryId: sourceRepoId, operationId: sourceOp, requestSha256, kind: role, body: bytesToStream(pack), expectedSha256: packSha, expectedSizeBytes: pack.length, contentType: "application/octet-stream", expiresAt: null });
  return { public: publicInput, manifest: manifestLocator, pack: packLocator };
}

async function assertCanonicalRequestDigest(candidateCi, fixture) { const request = ciRequest(fixture, "golden"); const actual = candidateCi.buildCandidateCiAdmission(request).requestSha256; const expectedCanonical = goldenCanonicalRequest(request); const expected = sha256(Buffer.from(expectedCanonical)); if (actual !== expected) throw new Error(`candidate CI request digest mismatch: ${actual} !== ${expected} for ${expectedCanonical}`); }

async function assertCandidateCi(mod, root, store, fixture, expectation) {
  const ctx = fakeCtx(new DockerContainer(root, ciImage, configuredCiImage));
  const response = await mod.executeStoredCandidateCi(ctx, fakeEnv(store), ciRequest(fixture, expectation.name));
  const body = await response.json();
  if (response.status !== 200 || body.receipt.status !== expectation.expectStatus || body.receipt.exitCode !== expectation.expectExit) throw new Error(`candidate CI ${expectation.name} wrong result: ${response.status} ${JSON.stringify(body)}`);
  if (!body.receipt.stdout.includes(expectation.stdout)) throw new Error("candidate CI did not execute repository script from candidate");
  if (body.receipt.stdout.includes("SECRET")) throw new Error("candidate CI leaked a secret-like env value");
  if (body.receipt.candidateCi.candidateSha !== fixture.candidate || body.receipt.candidateCi.headSha !== fixture.head || body.receipt.candidateCi.baseSha !== fixture.base) throw new Error("candidate CI receipt does not bind H/B/C");
  if (body.receipt.candidateCi.candidateSha === fixture.head || body.receipt.candidateCi.candidateSha === fixture.base) throw new Error("candidate CI accepted a degenerate H/B/C fixture");
  if (body.receipt.candidateCi.manifestSha256 !== fixture.stored.manifest.sha256 || body.receipt.candidateCi.rawCommitSha256 !== fixture.stored.rawCommit.sha256 || body.receipt.candidateCi.packSha256 !== fixture.stored.pack.sha256) throw new Error("candidate CI receipt does not bind persisted artifacts");
  if (body.receipt.candidateCi.jobId !== `job-${expectation.name}` || body.receipt.candidateCi.context !== "ci/build" || body.receipt.image !== configuredCiImage) throw new Error("candidate CI receipt does not bind scheduler identity");
}

async function assertNativeControllerCandidateCi(controllerMod, storeMod, root, artifactStore, fixture, expectation) {
  const sql = new SqliteD1();
  installNativeSchema(sql);
  seedNativeEligibility(sql, fixture, expectation.name);
  sql.db.exec("CREATE TABLE check_transitions(old_status TEXT NOT NULL, new_status TEXT NOT NULL); CREATE TRIGGER check_transition_audit BEFORE UPDATE ON checks BEGIN INSERT INTO check_transitions VALUES(OLD.status, NEW.status); END");
  const ctx = fakeCtx(new DockerContainer(root, ciImage, configuredCiImage));
  const privateDispatcher = controllerMod.makeStoredCandidateCiPrivateDispatcher(ctx, fakeEnv(artifactStore));
  const dispatcher = { execute: async (request) => {
    const transitions = sql.db.prepare("SELECT old_status, new_status FROM check_transitions ORDER BY rowid").all();
    if (JSON.stringify(transitions) !== JSON.stringify([{ old_status: "queued", new_status: "in_progress" }])) throw new Error(`native controller did not publish queued->running before dispatch: ${JSON.stringify(transitions)}`);
    const running = sql.db.prepare("SELECT version, status, conclusion, commit_sha, head_sha, base_sha, execution_sha, candidate_bound, job_attempt_id, provider_evidence_ref FROM checks WHERE job_attempt_id = ?").get(`native-attempt-${expectation.name}`);
    if (!running || running.version !== 2 || running.status !== "in_progress" || running.conclusion !== null || running.commit_sha !== fixture.candidate || running.head_sha !== fixture.head || running.base_sha !== fixture.base || running.execution_sha !== fixture.candidate || running.candidate_bound !== 1 || running.provider_evidence_ref !== null) throw new Error(`native controller did not publish the running check row before dispatch: ${JSON.stringify(running)}`);
    return privateDispatcher.execute(request);
  } };
  const controller = controllerMod.makeNativeCandidateJobController(sql, storeMod.makeD1NativeJobStore(sql, nativeIds(expectation.name)), dispatcher, { deadlineMs: 120000, planId: `plan-${expectation.name}` });

  let token;
  try {
    token = await controller.run(nativeScheduleInput(fixture, expectation.name));
  } catch (error) {
    error.message += `; lastBatch=${JSON.stringify(sql.lastBatch ?? null)}`;
    throw error;
  }
  const receipt = latestCandidateCiReceipt(ctx);
  if (Date.parse(token.receipt.completedAt) < Date.parse(receipt.finishedAt)) throw new Error("native controller completed before its helper receipt");

  if (token.status !== "completed" || token.conclusion !== expectation.conclusion || token.candidateSha !== fixture.candidate || token.headSha !== fixture.head || token.baseSha !== fixture.base) throw new Error(`native controller token identity mismatch: ${JSON.stringify(token)}`);
  if (!new RegExp(`^native-ci:${receipt.candidateCiRequestSha256}:[0-9a-f]{64}$`).test(token.providerEvidenceRef)) throw new Error(`native controller provider evidence ref does not bind the private CI request: actual=${token.providerEvidenceRef} request=${receipt.candidateCiRequestSha256}`);
  if (receipt.status !== (expectation.exitCode === 0 ? "succeeded" : "failed") || receipt.exitCode !== expectation.exitCode || !receipt.stdout.includes(expectation.stdout)) throw new Error(`native controller did not run the expected repository script: ${JSON.stringify(receipt)}`);
  if (receipt.candidateCi.candidateSha !== fixture.candidate || receipt.candidateCi.headSha !== fixture.head || receipt.candidateCi.baseSha !== fixture.base) throw new Error("native controller private receipt does not bind H/B/C");
  if (receipt.image !== configuredCiImage) throw new Error("native controller private receipt does not retain the configured pinned image reference");
  const row = sql.db.prepare("SELECT state, exit_code FROM job_attempts WHERE id = ?").get(`native-attempt-${expectation.name}`);
  if (row.state !== "completed" || row.exit_code !== expectation.exitCode) throw new Error(`native controller did not finalize the production store: ${JSON.stringify(row)}`);
  const count = sql.db.prepare("SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE job_attempt_id = ? AND status = 'completed'").get(`native-attempt-${expectation.name}`);
  if (count.count !== 1) throw new Error("native controller did not store exactly one completed qualification token");
  const check = sql.db.prepare("SELECT version, commit_sha, head_sha, base_sha, execution_sha, status, conclusion, candidate_bound, job_attempt_id, provider_evidence_ref, name, details_key FROM checks WHERE job_attempt_id = ?").get(`native-attempt-${expectation.name}`);
  if (!check || check.version !== 3 || check.commit_sha !== fixture.candidate || check.head_sha !== fixture.head || check.base_sha !== fixture.base || check.execution_sha !== fixture.candidate || check.status !== "completed" || check.conclusion !== expectation.conclusion || check.candidate_bound !== 1 || check.job_attempt_id !== `native-attempt-${expectation.name}` || check.provider_evidence_ref !== null || check.name !== "ci/build") throw new Error(`native controller did not persist the candidate-bound check row: ${JSON.stringify(check)}`);
  const details = JSON.parse(check.details_key);
  if (!details.output?.summary?.includes(`exited ${expectation.exitCode}`) || details.output.summary.includes("native-ci:")) throw new Error(`native controller check output was not human-facing CI evidence: ${check.details_key}`);
}

function latestCandidateCiReceipt(ctx) {
  const receipts = [...ctx.storage.values.values()].filter((value) => value && value.profile === "untrusted_ci_job" && value.candidateCiRequestSha256);
  if (receipts.length !== 1) throw new Error(`expected one retained private CI receipt, got ${receipts.length}`);
  return receipts[0];
}

function nativeScheduleInput(fixture, name) {
  const policyDigest = nativePolicyDigest(name);
  const planDigest = nativePlanDigest(name);
  return { tenantId: tenant, producerId: "producer-a", producerAuthEpoch: 2, tenantPolicyEpoch: 4, now: "2026-10-09T00:00:00.000Z", expiresAt: "2099-10-09T00:10:00.000Z", context: "ci/build", command: ["/bin/sh", "-lc", ".gitfoundry/ci.sh"], imageDigest, sourceRepositoryId: repository, targetRepositoryId: repository, pullRequestId: `native-pr-${name}`, pullRequestVersion: 7, issueVersion: 3, eligibilityOperationId: fixture.operationId, eligibilityGeneration: 1, candidateSha: fixture.candidate, headSha: fixture.head, baseSha: fixture.base, candidateTreeSha: fixture.stored.result.candidateTree, policyDigest, planDigest, reviewedDiffDigest: fixture.stored.reviewedDiff.patchSha256, candidateArtifacts: nativeCandidateArtifacts(fixture), observedRuleRows: nativeObservedRules() };
}

function nativeCandidateArtifacts(fixture) { return { manifest: fixture.stored.manifest, rawCommit: fixture.stored.rawCommit, pack: fixture.stored.pack }; }
function nativeObservedRules() { return [{ id: "native-ruleset", version: 1, priority: 1, enabled: 1, rules_json: "{}" }]; }
function nativePolicyDigest(name) { return sha256(`native-policy-${name}`); }
function nativePlanDigest(name) { return sha256(`native-plan-${name}`); }
function nativeIds(name) { let token = 0; let nonce = 0; return { newRunId: () => `native-run-${name}`, newJobId: () => `native-job-${name}`, newAttemptId: () => `native-attempt-${name}`, newFenceToken: () => `native-fence-${name}`, newTokenId: () => `native-token-${name}-${++token}`, newNonce: () => `native-nonce-${name}-${++nonce}` }; }

function installNativeSchema(sql) {
  for (const migration of ["0001_handbook.sql", "0003_pr_eligibility.sql", "0004_pr_eligibility_finalization.sql", "0005_candidate_jobs.sql"]) sql.db.exec(readFileSync(resolve(repoRoot, "infra/migrations", migration), "utf8"));
}

function seedNativeEligibility(sql, fixture, name) {
  const input = nativeScheduleInput(fixture, name);
  const result = nativeEligibilityResult(fixture, name);
  sql.db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)").run(tenant, tenant, "active", input.tenantPolicyEpoch, "shard-a", "US", "{}");
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run(tenant, input.producerId, 1, input.now, input.now, "human", "Producer", 1, input.producerAuthEpoch);
  sql.db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run(tenant, "author-a", 1, input.now, input.now, "human", "Author", 1, 1);
  sql.db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run(tenant, "native-ns", 1, input.now, input.now, "native-ns", "Native Namespace");
  sql.db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(tenant, repository, 1, input.now, input.now, "native-ns", "target", "private", "main", 0, tenant, repository, null);
  sql.db.prepare("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(tenant, `native-issue-${name}`, input.issueVersion, input.now, input.now, repository, 1, "PR", "Body", "open", "", "author-a", "pull_request");
  sql.db.prepare("INSERT INTO pull_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(tenant, input.pullRequestId, input.pullRequestVersion, input.now, input.now, `native-issue-${name}`, repository, repository, "refs/heads/topic", "refs/heads/main", fixture.head, fixture.base, 0, null, null, null);
  sql.db.prepare("INSERT INTO rulesets VALUES(?,?,?,?,?,?,?,?,?)").run(tenant, "native-ruleset", 1, input.now, input.now, repository, 1, "{}", 1);
  sql.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(tenant, fixture.operationId, 1, input.now, input.now, "pr.eligibility.prepare", input.producerId, "complete", "{}", `json:${JSON.stringify(result)}`, null);
  sql.db.prepare("INSERT INTO pr_eligibility_active VALUES(?,?,?,?,?,?,?)").run(tenant, input.pullRequestId, `native-key-${name}`, fixture.operationId, input.eligibilityGeneration, input.expiresAt, input.now);
  sql.db.prepare("INSERT INTO pr_eligibility_generations(tenant_id,pull_request_id,operation_id,logical_key,generation,actor_id,state,created_at,updated_at,expires_at,committed_at,head_sha,base_sha,method,policy_digest,progress_json,snapshot_json,error_json,finalization_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(tenant, input.pullRequestId, fixture.operationId, `native-key-${name}`, input.eligibilityGeneration, input.producerId, "complete", input.now, input.now, input.expiresAt, input.now, fixture.head, fixture.base, "merge", input.policyDigest, JSON.stringify({ observedRuleRows: input.observedRuleRows }), JSON.stringify({ id: fixture.operationId, candidate_sha: fixture.candidate }), null, `native-eligibility-nonce-${name}`);
  sql.db.prepare("INSERT INTO eligibility VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(tenant, fixture.operationId, 1, input.now, input.now, repository, input.pullRequestId, fixture.head, fixture.base, fixture.candidate, input.tenantPolicyEpoch, JSON.stringify({ id: fixture.operationId, candidate_sha: fixture.candidate }), input.expiresAt);
  assertNativeSeed(sql, input);
}
function assertNativeSeed(sql, input) {
  const row = sql.db.prepare("SELECT e.state, e.expires_at, e.head_sha, e.base_sha, e.policy_digest, pr.repository_id, pr.source_repository_id, pr.version AS pr_version, pr.head_sha AS pr_head, pr.base_sha AS pr_base, i.version AS issue_version, i.state AS issue_state, t.policy_epoch, p.auth_epoch, substr(o.result_key,1,5) AS prefix, json_valid(substr(o.result_key,6)) AS result_valid, json_extract(substr(o.result_key,6),'$.candidate.requestSha256') AS candidate_request, json_extract(substr(o.result_key,6),'$.candidate.result.candidateOid') AS candidate_oid, json_extract(substr(o.result_key,6),'$.candidate.result.candidateTree') AS candidate_tree, json_extract(substr(o.result_key,6),'$.candidate.result.candidateBytesSha256') AS raw_sha, json_extract(substr(o.result_key,6),'$.checkPlan.planDigest') AS plan_digest, json_extract(substr(o.result_key,6),'$.reviewedDiff.patchSha256') AS diff_sha FROM pr_eligibility_generations e JOIN pr_eligibility_active a ON a.tenant_id = e.tenant_id AND a.operation_id = e.operation_id AND a.generation = e.generation JOIN operations o ON o.tenant_id = e.tenant_id AND o.id = e.operation_id JOIN tenants t ON t.id = e.tenant_id JOIN principals p ON p.tenant_id = e.tenant_id AND p.id = ? JOIN pull_requests pr ON pr.tenant_id = e.tenant_id AND pr.id = e.pull_request_id JOIN issues i ON i.tenant_id = pr.tenant_id AND i.id = pr.issue_id WHERE e.tenant_id = ? AND e.operation_id = ? AND e.generation = ?").get(input.producerId, input.tenantId, input.eligibilityOperationId, input.eligibilityGeneration);
  const expected = { state: "complete", head_sha: input.headSha, base_sha: input.baseSha, policy_digest: input.policyDigest, repository_id: input.targetRepositoryId, source_repository_id: input.sourceRepositoryId, pr_version: input.pullRequestVersion, pr_head: input.headSha, pr_base: input.baseSha, issue_version: input.issueVersion, issue_state: "open", policy_epoch: input.tenantPolicyEpoch, auth_epoch: input.producerAuthEpoch, prefix: "json:", result_valid: 1, candidate_request: input.candidateArtifacts.manifest.requestSha256, candidate_oid: input.candidateSha, candidate_tree: input.candidateTreeSha, raw_sha: input.candidateArtifacts.rawCommit.sha256, plan_digest: input.planDigest, diff_sha: input.reviewedDiffDigest };
  for (const [key, value] of Object.entries(expected)) if (row?.[key] !== value) throw new Error(`native eligibility seed mismatch ${key}: ${JSON.stringify(row)} expected ${JSON.stringify(expected)}`);
}


function nativeEligibilityResult(fixture, name) {
  const input = nativeScheduleInput(fixture, name);
  return { snapshot: { id: fixture.operationId, candidate_sha: fixture.candidate }, candidate: fixture.stored, checkPlan: { plan: { tenantId: tenant, sourceRepositoryId: repository, targetRepositoryId: repository, pullRequestId: input.pullRequestId, pullRequestVersion: input.pullRequestVersion, headOid: fixture.head, baseOid: fixture.base, candidateOid: fixture.candidate, candidateTreeOid: fixture.stored.result.candidateTree, policyDigest: input.policyDigest }, planDigest: input.planDigest }, reviewedDiff: { patchSha256: fixture.stored.reviewedDiff.patchSha256 }, source: { tenantId: tenant, sourceRepositoryId: repository, targetRepositoryId: repository, headSha: fixture.head, baseSha: fixture.base }, exposedIssueVersion: input.issueVersion, internalPrRevision: input.pullRequestVersion, generation: input.eligibilityGeneration };
}

async function assertManifestRequired(mod, root, store, fixture) { const request = ciRequest(fixture, "badmanifest"); request.candidate = { ...request.candidate, manifest: { ...request.candidate.manifest, sha256: "0".repeat(64) } }; const body = await expectDenied(mod, root, store, request, /manifest|artifact|digest/i); if (String(body.receipt?.stdout || "").includes("PASS-FROM-CANDIDATE")) throw new Error("candidate CI ran script after manifest corruption"); }
async function assertResultRawDigestBound(mod, root, store, fixture) { const request = ciRequest(fixture, "badresult"); request.candidate = { ...request.candidate, result: { ...request.candidate.result, candidateBytesSha256: "b".repeat(64) } }; const body = await expectDenied(mod, root, store, request, /candidate.*digest|manifest.*result|raw/i); if (String(body.receipt?.stdout || "").includes("PASS-FROM-CANDIDATE")) throw new Error("candidate CI ran script after result raw digest corruption"); }
async function assertRawCommitDenied(mod, root, store, fixture) { const request = ciRequest(fixture, "badraw"); request.candidate = { ...request.candidate, rawCommit: { ...request.candidate.rawCommit, sha256: "0".repeat(64) } }; const body = await expectDenied(mod, root, store, request, /digest|raw|candidate/i); if (String(body.receipt?.stdout || "").includes("PASS-FROM-CANDIDATE")) throw new Error("candidate CI ran script after raw corruption"); }
async function assertReplayConflict(mod, root, store, fixture) { const ctx = fakeCtx(new DockerContainer(root, ciImage, configuredCiImage)); const request = ciRequest(fixture, "replay"); const first = await mod.executeStoredCandidateCi(ctx, fakeEnv(store), request); if (first.status !== 200) throw new Error("initial replay fixture did not complete"); const changed = await mod.executeStoredCandidateCi(ctx, fakeEnv(store), { ...request, plan: { ...request.plan, policySha256: "b".repeat(64) } }); if (changed.status !== 409) throw new Error("changed candidate CI replay was not rejected"); }
async function expectDenied(mod, root, store, request, pattern) { const response = await mod.executeStoredCandidateCi(fakeCtx(new DockerContainer(root, ciImage, configuredCiImage)), fakeEnv(store), request); const body = await response.json(); if (response.status === 200) throw new Error("candidate CI invalid input was not denied before script execution: " + JSON.stringify(body)); void pattern; return body; }

function ciRequest(fixture, suffix) { return { commandId: `ci-${suffix}`, tenantId: tenant, repositoryId: repository, sourceRepositoryId: repository, operationId: fixture.operationId, eligibilityOperationId: fixture.operationId, eligibilityGeneration: 1, pullRequestId: fixture.input.pullRequestId, pullRequestVersion: fixture.input.pullRequestVersion, issueVersion: 3, producerId: "producer-a", producerAuthEpoch: 2, tenantPolicyEpoch: 4, jobId: `job-${suffix}`, attemptId: `attempt-${suffix}`, attemptGeneration: 1, fenceToken: `fence-${suffix}`, context: "ci/build", imageDigest, deadlineMs: 120000, headSha: fixture.head, baseSha: fixture.base, candidateSha: fixture.candidate, candidate: fixture.stored, plan: { planId: `plan-${suffix}`, policySha256: "a".repeat(64), planDigest: "c".repeat(64), scriptPath: ".gitfoundry/ci.sh" } }; }
function goldenCanonicalRequest(request) { const artifacts = { manifest: locatorIdentity(request.candidate.manifest), pack: locatorIdentity(request.candidate.pack), rawCommit: locatorIdentity(request.candidate.rawCommit) }; return canonicalJson({ attemptGeneration: request.attemptGeneration, attemptId: request.attemptId, baseSha: request.baseSha, candidateRequestSha256: request.candidate.requestSha256, candidateSha: request.candidateSha, commandId: request.commandId, context: request.context, deadlineMs: request.deadlineMs, eligibilityGeneration: request.eligibilityGeneration, eligibilityOperationId: request.eligibilityOperationId, fenceToken: request.fenceToken, headSha: request.headSha, imageDigest: request.imageDigest, issueVersion: request.issueVersion, jobId: request.jobId, operationId: request.operationId, plan: request.plan, producerAuthEpoch: request.producerAuthEpoch, producerId: request.producerId, pullRequestId: request.pullRequestId, pullRequestVersion: request.pullRequestVersion, repositoryId: request.repositoryId, sourceRepositoryId: request.sourceRepositoryId, tenantId: request.tenantId, tenantPolicyEpoch: request.tenantPolicyEpoch, artifacts }); }
function locatorIdentity(locator) { return { etag: locator.etag, expiresAt: locator.expiresAt, key: locator.key, kind: locator.kind, operationId: locator.operationId, repositoryId: locator.repositoryId, requestSha256: locator.requestSha256, sha256: locator.sha256, sizeBytes: locator.sizeBytes, tenantId: locator.tenantId, version: locator.version }; }

async function assertStoredCandidateMatchesGit(store, candidate, fixture) { const raw = await streamToBuffer(await store.getVerified(candidate.rawCommit)); if (sha256(raw) !== candidate.result.candidateBytesSha256 || sha256(raw) !== candidate.rawCommit.sha256) throw new Error("stored raw commit digest mismatch"); if (gitObjectId("commit", raw) !== candidate.result.candidateOid) throw new Error("stored raw commit OID mismatch"); const parsed = parseRawCommit(raw); const expectedTree = (await git(["-C", fixture.work, "merge-tree", "--write-tree", fixture.base, fixture.head])).stdout.trim(); if (parsed.tree !== expectedTree || candidate.result.candidateTree !== expectedTree) throw new Error("stored candidate tree mismatch"); if (JSON.stringify(parsed.parents) !== JSON.stringify([fixture.base, fixture.head])) throw new Error("stored candidate parents mismatch"); const manifest = await streamToBuffer(await store.getVerified(candidate.manifest)); if (sha256(manifest) !== candidate.manifest.sha256 || !manifest.toString("utf8").includes(candidate.result.candidateOid)) throw new Error("stored candidate manifest is not the real helper manifest"); }

function fakeEnv(store) { return { GFY_UNTRUSTED_CI_IMAGE: configuredCiImage, GFY_ARTIFACTS: new FakeBucket(store), GFY_DB: {} }; }
function fakeCtx(container) { return { container, storage: new MemoryStorage() }; }
class SqliteStatement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new SqliteStatement(this.db, this.sql, values); }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.values) }; }
  async run() { const result = this.db.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
}
class SqliteD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new SqliteStatement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.lastBatch = results.map((result) => result.meta?.changes ?? null);
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
class MemoryStorage { constructor() { this.values = new Map(); } async get(k) { return this.values.get(k); } async put(k, v) { this.values.set(k, v); } async delete(k) { return this.values.delete(k); } async setAlarm(v) { this.alarm = v; } async deleteAlarm() { this.alarm = undefined; } }
class FakeBucket { constructor(store) { this.store = store; } async get(key, options = {}) { const entry = this.store.objects.get(key); if (!entry) return null; if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== entry.locator.etag) return null; const loc = entry.locator; return { key, size: entry.bytes.length, etag: loc.etag, version: loc.version, customMetadata: { tenantId: loc.tenantId, repositoryId: loc.repositoryId, operationId: loc.operationId, requestSha256: loc.requestSha256, kind: loc.kind, sha256: loc.sha256, sizeBytes: String(loc.sizeBytes), expiresAt: loc.expiresAt ?? "" }, checksums: { sha256: Buffer.from(loc.sha256, "hex") }, body: bytesToStream(entry.bytes) }; } }
class DockerContainer { constructor(root, image, inspectedImage) { this.root = root; this.image = image; this.inspectedImage = inspectedImage; this.images = Object.freeze({ gfy: inspectedImage }); this.running = false; } start(options) { if (options.image !== this.images.gfy) throw new Error("candidate CI startup did not select the pinned native image"); if (options.enableInternet !== false) throw new Error("candidate CI must deny internet"); this.running = true; this.labels = options.labels || {}; } async inspect() { return this.running ? { image: this.inspectedImage, labels: this.labels } : null; } async destroy() { this.running = false; } async interceptOutboundHttp() { throw new Error("candidate CI unexpectedly installed egress"); } async interceptOutboundHttps() { throw new Error("candidate CI unexpectedly installed egress"); } async exec(argv, options) { if (!this.user) { const owner = await run("docker", ["run", "--rm", "--platform", "linux/amd64", "--network", "none", "--mount", `type=bind,source=${this.root}/work,target=/work`, "--entrypoint", "stat", this.image, "-c", "%u:%g", "/work"], { expectExit: 0 }); this.user = owner.stdout.trim(); if (!/^[0-9]+:[0-9]+$/.test(this.user)) throw new Error("candidate fixture mount ownership invalid"); } const envArgs = Object.entries(options.env || {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]); const child = spawn("docker", ["run", "--rm", "--user", this.user, "-i", "--platform", "linux/amd64", "--network", "none", ...envArgs, "--mount", `type=bind,source=${this.root}/work,target=/work`, "--workdir", options.cwd, "--entrypoint", argv[0], this.image, ...argv.slice(1)], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }); return { stdin: nodeWritableToWeb(child.stdin), stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr), exitCode: waitFor(child), kill: () => child.kill("SIGKILL") }; } }
class FixtureArtifactStore { constructor() { this.objects = new Map(); } async putAppendOnly(input) { const bytes = await streamToBuffer(input.body); if (sha256(bytes) !== input.expectedSha256 || bytes.length !== input.expectedSizeBytes) throw new Error("fixture artifact digest or size mismatch"); const key = artifactKey(input); const prior = this.objects.get(key); if (prior && prior.locator.sha256 !== input.expectedSha256) throw new Error("fixture artifact append-only collision"); const locator = { tenantId: input.tenantId, repositoryId: input.repositoryId, operationId: input.operationId, requestSha256: input.requestSha256, kind: input.kind, key, sha256: input.expectedSha256, sizeBytes: bytes.length, etag: sha256(Buffer.concat([Buffer.from("etag"), bytes])), version: "v1", expiresAt: input.expiresAt ?? null }; this.objects.set(key, { locator, bytes }); return locator; } async getVerified(locator) { const entry = this.objects.get(locator.key); if (!entry || JSON.stringify(entry.locator) !== JSON.stringify(locator) || entry.bytes.length !== locator.sizeBytes || sha256(entry.bytes) !== locator.sha256) throw new Error("fixture artifact verification failed"); return bytesToStream(entry.bytes); } }
function artifactKey(scope) { return `v1/tenants/${scope.tenantId}/repositories/${scope.repositoryId}/merge-operations/${scope.operationId}/${scope.requestSha256}/${scope.kind}`; }
function nodeWritableToWeb(writable) { return new WritableStream({ write(chunk) { return new Promise((resolve, reject) => writable.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve())); }, close() { return new Promise((resolve, reject) => writable.end((error) => error ? reject(error) : resolve())); }, abort() { writable.destroy(); } }); }
function bytesToStream(bytes) { return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }); }
async function streamToBuffer(stream) { const reader = stream.getReader(); const chunks = []; let length = 0; try { for (;;) { const next = await reader.read(); if (next.done) break; const chunk = Buffer.from(next.value); chunks.push(chunk); length += chunk.length; } } finally { reader.releaseLock(); } return Buffer.concat(chunks, length); }
async function makePack(repo, tip) { return (await run("git", ["-C", repo, "pack-objects", "--revs", "--stdout"], { input: `${tip}\n`, expectExit: 0, encoding: "buffer" })).stdout; }
async function git(args) { return run("git", args, { expectExit: 0, env: { GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "tester@example.invalid", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "tester@example.invalid" } }); }
async function run(command, args, options = {}) { const child = spawn(command, args, { cwd: options.cwd || repoRoot, env: { ...process.env, ...(options.env || {}) }, stdio: ["pipe", "pipe", "pipe"] }); const stdout = []; const stderr = []; child.stdout.on("data", (c) => stdout.push(c)); child.stderr.on("data", (c) => stderr.push(c)); if (options.input) child.stdin.end(options.input); else child.stdin.end(); const code = await waitFor(child); const out = Buffer.concat(stdout); const err = Buffer.concat(stderr); if (code !== options.expectExit) throw new Error(`${command} ${args.join(" ")} exited ${code}\nstdout=${out.toString("utf8")}\nstderr=${err.toString("utf8")}`); if (options.encoding === "buffer") return { stdout: out, stderr: err, code }; return { stdout: out.toString("utf8"), stderr: err.toString("utf8"), code }; }
function waitFor(child) { return new Promise((resolve) => child.once("exit", (code) => resolve(code))); }
function parseRawCommit(raw) { const text = raw.toString("utf8"); const header = text.slice(0, text.indexOf("\n\n")); const tree = header.match(/^tree ([0-9a-f]{40})$/m)?.[1]; const parents = [...header.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]); if (!tree) throw new Error("raw commit tree missing"); return { tree, parents }; }
function gitObjectId(type, body) { return createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex"); }
function sha256(input) { return createHash("sha256").update(input).digest("hex"); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
