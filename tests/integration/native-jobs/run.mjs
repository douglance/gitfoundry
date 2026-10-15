#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const now = "2026-10-09T00:00:00.000Z";
const completedAt = "2026-10-09T00:02:00.000Z";
const expiresAt = "2099-10-09T00:10:00.000Z";
const tenantId = "tenant-a";
const actorId = "actor-a";
const sourceRepositoryId = "repo-a";
const targetRepositoryId = "repo-a";
const pullRequestId = "pr-a";
const eligibilityOperationId = "eligibility-a";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const candidateSha = "c".repeat(40);
const candidateTreeSha = "d".repeat(40);
const policyDigest = sha("policy");
const planDigest = sha("plan");
const reviewedDiffDigest = sha("reviewed-diff");
const imageDigest = `sha256:${sha("native-image")}`;
const observedRuleRows = [{ id: "ruleset-a", version: 1, priority: 1, enabled: 1, rules_json: "{}" }];

const workerSource = `
import { Effect } from "effect";
import { buildNativeJobQualificationGuard, makeD1NativeJobStore, makeNativeJobCandidateCheckQualifier, readNativeJobQualificationToken } from ${JSON.stringify(pathToFileURL(path.join(root, "apps/api-worker/src/native-jobs/store.ts")).href)};
import { makeD1CheckStore } from ${JSON.stringify(pathToFileURL(path.join(root, "packages/core/src/live/checks.ts")).href)};
import { makeNativeCandidateJobController } from ${JSON.stringify(pathToFileURL(path.join(root, "apps/api-worker/src/native-jobs/controller.ts")).href)};
import { buildCandidateCiAdmission } from ${JSON.stringify(pathToFileURL(path.join(root, "apps/api-worker/src/candidate-ci/index.ts")).href)};
import { makeD1PrMergeAdmission } from ${JSON.stringify(pathToFileURL(path.join(root, "apps/api-worker/src/pr-merge-publication/admission.ts")).href)};
function ids(prefix, phase) {
  let token = Number(phase === "start" ? 1 : phase === "finalize" || phase === "cancel" ? 2 : phase === "retry" ? 3 : 0);
  let nonce = Number(phase === "start" ? 1 : phase === "finalize" || phase === "cancel" ? 2 : phase === "retry" ? 3 : 0);
  return { newRunId: () => prefix + "-run", newJobId: () => prefix + "-job", newAttemptId: () => prefix + "-attempt", newFenceToken: () => prefix + "-fence", newTokenId: () => prefix + "-token-" + (++token), newNonce: () => prefix + "-nonce-" + (++nonce) };
}
function json(value, status = 200) { return Response.json(value, { status }); }
const checkInsertBarriers = new Map();
async function rendezvousCheckInsert(key) {
  let barrier = checkInsertBarriers.get(key);
  if (!barrier) { barrier = { arrived: 0, releases: [] }; checkInsertBarriers.set(key, barrier); }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { checkInsertBarriers.delete(key); reject(new Error("check insert barrier timed out")); }, 5000);
    barrier.releases.push(() => { clearTimeout(timer); resolve(); });
    if (++barrier.arrived === 2) { checkInsertBarriers.delete(key); for (const release of barrier.releases) release(); }
  });
}
function checkCommitBarrierDb(db, key) {
  if (!key) return db;
  const wrap = statement => ({
    bind(...values) { return wrap(statement.bind(...values)); },
    first(...args) { return statement.first(...args); },
    all(...args) { return statement.all(...args); },
    async run(...args) { await rendezvousCheckInsert(key); return statement.run(...args); }
  });
  return { prepare(sql) { const statement = db.prepare(sql); return sql.startsWith("INSERT INTO checks(") ? wrap(statement) : statement; }, exec(sql) { return db.exec(sql); }, batch(statements) { return db.batch(statements); } };
}
export default { async fetch(request, env) {
  const { action, input, idPrefix = "case", phase = "schedule", guard, qualify } = await request.json();
  const store = makeD1NativeJobStore(env.DB, ids(idPrefix, phase));
  try {
    if (action === "migrate") { for (const sql of input.sql) await env.DB.exec(sql); return json({ ok: true }); }
    if (action === "batch") { await env.DB.batch(input.statements.map((statement) => env.DB.prepare(statement.sql).bind(...(statement.bindings ?? [])))); return json({ ok: true }); }
    if (action === "exec") return json(await env.DB.exec(input.sql));
    if (action === "first") return json(await env.DB.prepare(input.sql).bind(...(input.bindings ?? [])).first());
    if (action === "controller-run") {
      let beforeDispatch;
      const controller = makeNativeCandidateJobController(env.DB, store, { execute: async (ci) => {
        beforeDispatch = await env.DB.prepare("SELECT version,status,conclusion FROM checks WHERE tenant_id = ? AND job_attempt_id = ?").bind(ci.tenantId, ci.attemptId).first();
        const admitted = buildCandidateCiAdmission(ci);
        return Response.json({ ok: true, receipt: { commandId: ci.commandId, tenantId: ci.tenantId, repositoryId: ci.repositoryId, operationId: ci.operationId, fenceToken: ci.fenceToken, profile: "untrusted_ci_job", containerIdentity: "fixture-container-" + ci.attemptId, status: input.exitCode === 0 ? "succeeded" : "failed", exitCode: input.exitCode, stdout: input.exitCode === 0 ? "fixture success" : "", stderr: input.exitCode === 0 ? "" : "fixture failure", stdoutTruncated: false, stderrTruncated: false, startedAt: input.now, finishedAt: input.now, image: ci.imageDigest, egressProfile: "deny_all", attemptGeneration: ci.attemptGeneration, cleanupRequired: false, candidateCiRequestSha256: admitted.requestSha256, candidateCi: admitted.binding } });
      } }, { clock: { now: () => new Date(input.now) } });
      const token = await controller.run(input.schedule);
      return json({ token, beforeDispatch });
    }
    if (action === "merge-admission") { const { now, ...request } = input; return json(await makeD1PrMergeAdmission(env.DB, { clock: { now: () => new Date(now) } }).admit(request)); }
    if (action === "schedule") return json(await store.schedule(input));
    if (action === "start") return json(await store.start(input));
    if (action === "finalize") return json(await store.finalize(input));
    if (action === "cancel") return json(await store.cancel(input));
    if (action === "read-token") return json(await readNativeJobQualificationToken(env.DB, input));
    if (action === "guard") return json(await env.DB.prepare("SELECT 1 AS ok WHERE " + guard.sql).bind(...guard.bindings).first());
    if (action === "build-guard") return json(buildNativeJobQualificationGuard(input));
    if (action === "qualify") return json(await Effect.runPromise(makeNativeJobCandidateCheckQualifier(env.DB, { clock: { now: () => new Date(input.now) } }).qualifyCandidateCheck(qualify)));
    if (action === "create-check") return json(await Effect.runPromise(checkStore(checkCommitBarrierDb(env.DB, input.commitBarrier), input.now, input.driftSql).create(input.tenantId, input.actor, input.check)));
    if (action === "update-check") return json(await Effect.runPromise(checkStore(env.DB, input.now, input.driftSql).update(input.tenantId, input.id, input.actor, input.expectedVersion, input.patch)));
    return new Response("unknown action", { status: 400 });
  } catch (error) {
    return json({ error: String(error), name: error?.name ?? "Error", message: error?.message ?? String(error) }, 409);
  }
}};
function checkStore(db, now, driftSql) {
  const real = makeNativeJobCandidateCheckQualifier(db, { clock: { now: () => new Date(now) } });
  const candidateChecks = driftSql ? { qualifyCandidateCheck: (request) => Effect.gen(function* () { const proof = yield* real.qualifyCandidateCheck(request); yield* Effect.promise(() => db.exec(driftSql)); return proof; }) } : real;
  return makeD1CheckStore(db, { clock: { now: () => new Date(now) }, candidateChecks });
}
`;

async function main() {
  const bundle = await buildWorker();
  await withWorkerd(bundle, async (baseUrl) => {
    const call = (body) => request(baseUrl, body);
    await expectOk(call, "migrate", { sql: await migrations() }, "bootstrap", "migrate");
    await expectOk(call, "batch", { statements: seedStatements() }, "bootstrap", "seed");
    await scenarioDefaultControllerD1(call);
    await scenarioCheckedMergeAdmissionD1(call);
    await scenarioConcurrentCoreCheckCreates(call);
    await scenarioScheduleStartFinalize(call);
    await scenarioQueuedCancel(call);
    await scenarioQueuedCancelRollback(call);
    await scenarioCoreCheckStoreIntegration(call);
    await scenarioCoreCheckStorePostProofDrift(call);
    await scenarioCoreCheckStorePreCallDrift(call);
    await scenarioAlteredReceiptGuards(call);
    await scenarioCancelBeforeFinalization(call);
    await scenarioWrongFenceAndGeneration(call);
    await scenarioRollbackAndRetry(call);
  });
  console.log("native D1 native-job schedule/start/finalize qualification guards passed");
}

async function buildWorker() {
  const tempDir = await mkdtemp(path.join(root, ".tmp-native-jobs-bundle-"));
  try {
    const wrapper = path.join(tempDir, "native-jobs-d1-gate.mjs");
    await writeFile(wrapper, workerSource, "utf8");
    const rolldownPackage = path.join(root, "node_modules/.pnpm/node_modules/rolldown/dist/index.mjs");
    const { rolldown } = await import(pathToFileURL(rolldownPackage).href);
    const effectPackage = path.join(root, "node_modules/.pnpm/effect@4.0.2/node_modules/effect/dist/index.js");
    const cryptoShim = "\0native-jobs-node-crypto-shim";
    const cryptoShimSource = `
function sha256(ascii){function R(n,x){return(x>>>n)|(x<<(32-n));}var K=[],H=[],p=2,n=0;while(n<64){var ok=true;for(var f=2;f*f<=p;f++)if(p%f===0){ok=false;break;}if(ok){if(n<8)H[n]=(Math.pow(p,.5)*4294967296)|0;K[n++]=(Math.pow(p,1/3)*4294967296)|0;}p++;}var words=[],i,j;var bitLen=ascii.length*8;ascii+='\\x80';while(ascii.length%64-56)ascii+='\\x00';for(i=0;i<ascii.length;i++){j=ascii.charCodeAt(i);words[i>>2]|=j<<((3-i)%4)*8;}words[words.length]=((bitLen/4294967296)|0);words[words.length]=bitLen;for(j=0;j<words.length;){var w=words.slice(j,j+=16),a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];for(i=0;i<64;i++){var s0=R(7,w[i-15]||0)^R(18,w[i-15]||0)^((w[i-15]||0)>>>3);var s1=R(17,w[i-2]||0)^R(19,w[i-2]||0)^((w[i-2]||0)>>>10);if(i>=16)w[i]=(w[i-16]+s0+w[i-7]+s1)|0;var S1=R(6,e)^R(11,e)^R(25,e);var ch=(e&f)^((~e)&g);var t1=(h+S1+ch+K[i]+w[i])|0;var S0=R(2,a)^R(13,a)^R(22,a);var maj=(a&b)^(a&c)^(b&c);var t2=(S0+maj)|0;h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;}H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;}return H.map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');}
export function createHash(algorithm){if(algorithm!=="sha256")throw new Error("unsupported hash");let data="";return{update(value){data+=String(value);return this;},digest(encoding){if(encoding!=="hex")throw new Error("unsupported digest");return sha256(data);}}}
`;
    const bundle = await rolldown({ input: wrapper, plugins: [{ name: "native-jobs-resolve", resolveId(source) { if (source === "effect") return effectPackage; if (source === "node:crypto") return { id: source, external: true }; return null; }, load(id) { if (id === cryptoShim) return cryptoShimSource; return null; } }] });
    const output = await bundle.generate({ format: "es", codeSplitting: false, sourcemap: false });
    const chunk = output.output.find((item) => item.type === "chunk");
    if (!chunk) throw new Error("native-jobs workerd bundle missing");
    return chunk.code;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function withWorkerd(bundle, fn) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "gitfoundry-native-jobs-d1-"));
  await mkdir(path.join(tempDir, "d1"), { recursive: true });
  try {
    const runtimeRoot = path.join(root, "node_modules/.pnpm/node_modules/@alchemy.run/cloudflare-runtime");
    const effectRoot = path.join(root, "node_modules/.pnpm/effect@4.0.2/node_modules/effect/dist");
    const platformNode = path.join(root, "node_modules/.pnpm/@effect+platform-node@4.0.2_effect@4.0.2_redis@6.3.0/node_modules/@effect/platform-node/dist/NodeServices.js");
    const [Effect, Layer, NodeServices, Workerd, internalModules, internalWorker] = await Promise.all([
      import(pathToFileURL(path.join(effectRoot, "Effect.js")).href),
      import(pathToFileURL(path.join(effectRoot, "Layer.js")).href),
      import(pathToFileURL(platformNode).href),
      import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/workerd/Workerd.mjs")).href),
      import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/internal/internal-modules.mjs")).href),
      import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/internal/internal-worker.mjs")).href)
    ]);
    const d1Worker = await internalWorker.loadInternalWorker("#cloudflare-runtime-core-worker/bindings/d1/D1.worker");
    const services = Layer.provide(Workerd.WorkerdLive, NodeServices.layer);
    const program = Effect.scoped(Effect.gen(function* () {
      const workerd = yield* Workerd.Workerd;
      const ports = yield* workerd.serve({
        sockets: [{ name: "http", address: "127.0.0.1:0", service: { name: "native-jobs" } }],
        services: [
          { name: "d1:storage", disk: { path: path.join(tempDir, "d1"), writable: true } },
          { name: "d1", worker: { compatibilityDate: "2026-10-09", modules: internalModules.formatInternalWorkerModules(d1Worker), durableObjectNamespaces: [{ className: "D1DatabaseObject", enableSql: true, uniqueKey: "gitfoundry-native-jobs-d1", preventEviction: true }], durableObjectStorage: { localDisk: "d1:storage" }, bindings: [{ name: "OBJECT", durableObjectNamespace: { className: "D1DatabaseObject" } }] } },
          { name: "native-jobs", worker: { compatibilityDate: "2026-10-09", compatibilityFlags: ["nodejs_compat"], modules: [{ name: "index.js", esModule: bundle }], bindings: [{ name: "DB", wrapped: { moduleName: "cloudflare-internal:d1-api", innerBindings: [{ name: "fetcher", service: { name: "d1", props: { json: JSON.stringify({ databaseId: "native-jobs-test" }) } } }] } }] } }
        ]
      });
      return yield* Effect.promise(async () => fn(`http://127.0.0.1:${ports.http}/`));
    }));
    try {
      await Effect.runPromise(Effect.provide(program, services));
    } catch (error) {
      console.error(JSON.stringify({ message: error?.message, name: error?.name, tag: error?._tag, subtag: error?.subtag, detail: error?.detail }, null, 2));
      throw error;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function migrations() {
  const sql = [];
  for (const migration of ["0001_handbook.sql", "0003_pr_eligibility.sql", "0004_pr_eligibility_finalization.sql", "0005_candidate_jobs.sql"]) {
    sql.push((await readFile(resolve(root, "infra/migrations", migration), "utf8")).replace(/^\s*--.*$/gm, "").replaceAll("\n", " "));
  }
  return sql;
}

async function scenarioCheckedMergeAdmissionD1(call) {
  const input = { tenantId, repositoryId: targetRepositoryId, pullRequestId, principalId: actorId, eligibilityOperationId, eligibilityGeneration: 1, userIdempotencyKey: "real-d1-admission", now };
  const admitted = await expectOk(call, "merge-admission", input, "merge-admission", "read");
  assert.equal(admitted.admissionKind, "read_only_prepublication_evidence");
  assert.deepEqual(admitted.intent.changes, [{ ref: "refs/heads/main", old_sha: baseSha, new_sha: candidateSha, force: false }]);
  assert.equal(admitted.evidence.requiredChecks.length, 1);
  await expectOk(call, "exec", { sql: "UPDATE principals SET auth_epoch = 2 WHERE id = 'actor-a'" }, "merge-admission", "drift");
  const denied = await expectConflict(call, "merge-admission", input, "merge-admission", "drift");
  assert.match(denied.message, /authoritative fence is not satisfied/, "actual D1 merge admission accepted stale producer authority");
  await expectOk(call, "exec", { sql: "UPDATE principals SET auth_epoch = 1 WHERE id = 'actor-a'" }, "merge-admission", "restore");
  const retry = await expectOk(call, "merge-admission", input, "merge-admission", "retry");
  assert.deepEqual(retry.intent.changes, admitted.intent.changes);
}

async function scenarioDefaultControllerD1(call) {
  for (const [caseId, exitCode, conclusion] of [["controller-d1-success", 0, "success"], ["controller-d1-failure", 42, "failure"]]) {
    const result = await expectOk(call, "controller-run", { schedule: scheduleInput(caseId, { command: ["/bin/sh", "-lc", ".gitfoundry/ci.sh"] }), now, exitCode }, caseId, "schedule");
    assert.deepEqual(result.beforeDispatch, { version: 2, status: "in_progress", conclusion: null }, "default D1 controller did not report running before dispatch");
    assert.equal(result.token.conclusion, conclusion);
    assert.deepEqual(await first(call, "SELECT version,status,conclusion,commit_sha,head_sha,base_sha,execution_sha,provider_evidence_ref FROM checks WHERE tenant_id = ? AND job_attempt_id = ?", [tenantId, result.token.jobAttemptId]), { version: 3, status: "completed", conclusion, commit_sha: candidateSha, head_sha: headSha, base_sha: baseSha, execution_sha: candidateSha, provider_evidence_ref: null }, "default D1 controller did not persist the exact terminal candidate check");
  }
}

async function scenarioConcurrentCoreCheckCreates(call) {
  const tokens = [];
  for (const caseId of ["concurrent-check-a", "concurrent-check-b"]) {
    const scheduled = await expectOk(call, "schedule", scheduleInput(caseId), caseId, "schedule");
    await expectOk(call, "start", startInput(caseId, scheduled), caseId, "start");
    tokens.push(await expectOk(call, "finalize", receiptInput(caseId, scheduled), caseId, "finalize"));
  }
  const before = (await first(call, "SELECT COUNT(*) AS count FROM checks")).count;
  const responses = await Promise.all(tokens.map(token => call({ action: "create-check", input: { tenantId, actor: actor(), now: completedAt, check: checkCreateInput(token), commitBarrier: "concurrent-core-check-insert" } })));
  assert.deepEqual(responses.map(response => response.status), [200, 200], "concurrent candidate check inserts lost a write");
  const checkIds = responses.map(response => response.body.id);
  assert.equal(new Set(checkIds).size, 2, "concurrent candidate checks must have distinct identifiers");
  assert.equal((await first(call, "SELECT COUNT(*) AS count FROM checks")).count, before + 2);
  for (let index = 0; index < checkIds.length; index++) {
    assert.deepEqual(await first(call, "SELECT id,version,job_attempt_id,commit_sha,status,conclusion FROM checks WHERE tenant_id = ? AND id = ?", [tenantId, checkIds[index]]), { id: checkIds[index], version: 1, job_attempt_id: tokens[index].jobAttemptId, commit_sha: candidateSha, status: "completed", conclusion: "success" });
  }
}

async function scenarioScheduleStartFinalize(call) {
  const scheduled = await expectOk(call, "schedule", scheduleInput("valid"), "valid", "schedule");
  assert.deepEqual(await first(call, "SELECT status, commit_sha, repository_id FROM runs WHERE id = ?", [scheduled.runId]), { status: "queued", commit_sha: candidateSha, repository_id: targetRepositoryId });
  assert.deepEqual(await first(call, "SELECT status, logical_key FROM jobs WHERE id = ?", [scheduled.jobId]), { status: "queued", logical_key: "ci/build" });
  assert.deepEqual(await first(call, "SELECT state, lease_generation, fencing_token FROM job_attempts WHERE id = ?", [scheduled.attemptId]), { state: "queued", lease_generation: 1, fencing_token: scheduled.fenceToken });
  assert.equal(scheduled.request.candidateRequestSha256, artifacts().manifest.requestSha256);
  assert.equal(scheduled.request.candidateArtifacts.pack.key, artifacts().pack.key);

  const started = await expectOk(call, "start", startInput("valid", scheduled), "valid", "start");
  assert.equal(started.status, "in_progress");
  assert.equal(started.conclusion, null);
  assert.equal(await countTokens(call, scheduled.attemptId, "in_progress"), 1);
  assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 0);
  assert.deepEqual(await first(call, "SELECT state, version, started_at FROM job_attempts WHERE id = ?", [scheduled.attemptId]), { state: "in_progress", version: 2, started_at: now });

  const completed = await expectOk(call, "finalize", receiptInput("valid", scheduled), "valid", "finalize");
  assert.equal(completed.status, "completed");
  assert.equal(completed.conclusion, "success");
  assert.equal(completed.candidateSha, candidateSha);
  assert.equal(completed.jobAttemptVersion, 3);
  assert.equal(await countTokens(call, scheduled.attemptId, "in_progress"), 1);
  assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 1);
  assert.deepEqual(await first(call, "SELECT state, exit_code FROM job_attempts WHERE id = ?", [scheduled.attemptId]), { state: "completed", exit_code: 0 });

  const trusted = await expectOk(call, "read-token", { tenantId, tokenId: completed.id, now: completedAt }, "valid", "read-token");
  assert.equal(trusted.writeFence.sql.includes("native_candidate_check_qualification_tokens"), true);
  assert.deepEqual(await call({ action: "guard", guard: trusted.writeFence }), { status: 200, body: { ok: 1 } });

  const proof = await expectOk(call, "qualify", { now: completedAt }, "valid", "qualify", qualificationRequest(completed));
  assert.equal(proof.evidenceKind, "native_job");
  assert.equal(proof.jobAttemptId, scheduled.attemptId);
  assert.deepEqual(proof.writeFence, trusted.writeFence);
}

async function scenarioQueuedCancel(call) {
  const caseId = "queued-cancel";
  const scheduled = await expectOk(call, "schedule", scheduleInput(caseId), caseId, "schedule");
  const queuedToken = await expectOk(call, "read-token", { tenantId, tokenId: `${caseId}-token-1`, now }, caseId, "read-queued-token");
  const check = await expectOk(call, "create-check", { tenantId, actor: actor(), now, check: checkCreateInput(queuedToken), driftSql: null }, caseId, "create-queued-check");
  const cancelled = await expectOk(call, "cancel", startInput(caseId, scheduled, { now: completedAt }), caseId, "cancel");
  assert.equal(cancelled.status, "completed");
  assert.equal(cancelled.conclusion, "cancelled");
  assert.equal(cancelled.jobAttemptVersion, 2);
  assert.equal(cancelled.jobAttemptId, scheduled.attemptId);
  const cancelledCheck = await expectOk(call, "update-check", { tenantId, actor: actor(), now: completedAt, id: check.id, expectedVersion: 1, patch: checkPatchInput(cancelled), driftSql: null }, caseId, "update-cancelled-check");
  assert.deepEqual(pickCheck(cancelledCheck), { version: 2, status: "completed", conclusion: "cancelled", provider_evidence_ref: null, job_attempt_id: scheduled.attemptId });
  assert.deepEqual(await first(call, "SELECT status FROM runs WHERE id = ?", [scheduled.runId]), { status: "completed" });
  assert.deepEqual(await first(call, "SELECT status FROM jobs WHERE id = ?", [scheduled.jobId]), { status: "completed" });
  assert.deepEqual(await first(call, "SELECT state, version, started_at, finished_at, exit_code FROM job_attempts WHERE id = ?", [scheduled.attemptId]), { state: "cancelled", version: 2, started_at: null, finished_at: completedAt, exit_code: null });
  assert.deepEqual(await first(call, "SELECT state, job_attempt_version, receipt_sha256 FROM native_candidate_job_attempts WHERE attempt_id = ?", [scheduled.attemptId]), { state: "cancelled", job_attempt_version: 2, receipt_sha256: cancelled.receiptSha256 });
  assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 1);
  const trustedCancel = await expectOk(call, "read-token", { tenantId, tokenId: cancelled.id, now: completedAt }, caseId, "read-cancel-token");
  assert.deepEqual(await call({ action: "guard", guard: trustedCancel.writeFence }), { status: 200, body: { ok: 1 } });
  await expectConflict(call, "start", startInput(caseId, scheduled), caseId, "start-after-cancel");
  await expectConflict(call, "finalize", receiptInput(caseId, scheduled), caseId, "finalize-after-cancel");
  assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 1);
}

async function scenarioQueuedCancelRollback(call) {
  const caseId = "queued-cancel-rollback";
  const scheduled = await expectOk(call, "schedule", scheduleInput(caseId), caseId, "schedule");
  const before = await first(call, "SELECT status FROM runs WHERE id = ?", [scheduled.runId]);
  await expectOk(call, "exec", { sql: "CREATE TRIGGER reject_cancel_token BEFORE INSERT ON native_candidate_check_qualification_tokens WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'reject queued cancel token'); END" }, caseId, "trigger");
  await expectConflict(call, "cancel", startInput(caseId, scheduled, { now: completedAt }), caseId, "cancel");
  assert.deepEqual(await first(call, "SELECT status FROM runs WHERE id = ?", [scheduled.runId]), before);
  assert.deepEqual(await first(call, "SELECT status FROM jobs WHERE id = ?", [scheduled.jobId]), { status: "queued" });
  assert.deepEqual(await first(call, "SELECT state, version, finished_at FROM job_attempts WHERE id = ?", [scheduled.attemptId]), { state: "queued", version: 1, finished_at: null });
  assert.deepEqual(await first(call, "SELECT state, job_attempt_version, receipt_sha256 FROM native_candidate_job_attempts WHERE attempt_id = ?", [scheduled.attemptId]), { state: "queued", job_attempt_version: 1, receipt_sha256: null });
  assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 0);
  await expectOk(call, "exec", { sql: "DROP TRIGGER reject_cancel_token" }, caseId, "drop-trigger");
  const cancelled = await expectOk(call, "cancel", startInput(caseId, scheduled, { now: completedAt }), caseId, "cancel");
  assert.equal(cancelled.conclusion, "cancelled");
}

async function scenarioCoreCheckStoreIntegration(call) {
  const caseId = "core-check";
  const scheduled = await expectOk(call, "schedule", scheduleInput(caseId), caseId, "schedule");
  const queuedToken = await expectOk(call, "read-token", { tenantId, tokenId: `${caseId}-token-1`, now }, caseId, "read-queued-token");
  assert.equal(queuedToken.status, "queued");
  assert.equal(queuedToken.conclusion, null);
  assert.equal(queuedToken.writeFence.bindings.length <= 75, true);
  assert.equal(queuedToken.writeFence.sql.length <= 65536, true);

  const created = await expectOk(call, "create-check", { tenantId, actor: actor(), now, check: checkCreateInput(queuedToken) }, caseId, "create-queued-check");
  assert.deepEqual(pickCheck(created), { version: 1, status: "queued", conclusion: null, provider_evidence_ref: null, job_attempt_id: scheduled.attemptId });

  const started = await expectOk(call, "start", startInput(caseId, scheduled), caseId, "start");
  const inProgress = await expectOk(call, "update-check", { tenantId, actor: actor(), now, id: created.id, expectedVersion: 1, patch: checkPatchInput(started) }, caseId, "update-in-progress-check");
  assert.deepEqual(pickCheck(inProgress), { version: 2, status: "in_progress", conclusion: null, provider_evidence_ref: null, job_attempt_id: scheduled.attemptId });

  const completed = await expectOk(call, "finalize", receiptInput(caseId, scheduled), caseId, "finalize");
  const final = await expectOk(call, "update-check", { tenantId, actor: actor(), now: completedAt, id: created.id, expectedVersion: 2, patch: checkPatchInput(completed) }, caseId, "update-completed-check");
  assert.deepEqual(pickCheck(final), { version: 3, status: "completed", conclusion: "success", provider_evidence_ref: null, job_attempt_id: scheduled.attemptId });
  assert.deepEqual(await first(call, "SELECT version,status,conclusion,commit_sha,head_sha,base_sha,execution_sha,plan_digest,policy_digest,job_attempt_id,provider_evidence_ref,name,producer_id,candidate_bound,details_key FROM checks WHERE id = ?", [created.id]), { version: 3, status: "completed", conclusion: "success", commit_sha: candidateSha, head_sha: headSha, base_sha: baseSha, execution_sha: candidateSha, plan_digest: planDigest, policy_digest: policyDigest, job_attempt_id: scheduled.attemptId, provider_evidence_ref: null, name: "ci/build", producer_id: actorId, candidate_bound: 1, details_key: JSON.stringify({ details_url: null, output: checkOutput(completed), annotations: [] }) });
}

async function scenarioCoreCheckStorePreCallDrift(call) {
  const cases = [
    ["revoked-producer", "UPDATE principals SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'actor-a'", "UPDATE principals SET active = 1 WHERE tenant_id = 'tenant-a' AND id = 'actor-a'"],
    ["producer-epoch", "UPDATE principals SET auth_epoch = 2 WHERE tenant_id = 'tenant-a' AND id = 'actor-a'", "UPDATE principals SET auth_epoch = 1 WHERE tenant_id = 'tenant-a' AND id = 'actor-a'"],
    ["native-candidate", `UPDATE native_candidate_job_attempts SET candidate_sha = '${"f".repeat(40)}' WHERE tenant_id = 'tenant-a' AND attempt_id = ?`, `UPDATE native_candidate_job_attempts SET candidate_sha = '${candidateSha}' WHERE tenant_id = 'tenant-a' AND attempt_id = ?`],
    ["ruleset-version", "UPDATE rulesets SET version = 2 WHERE tenant_id = 'tenant-a' AND id = 'ruleset-a'", "UPDATE rulesets SET version = 1 WHERE tenant_id = 'tenant-a' AND id = 'ruleset-a'"]
  ];
  for (const [label, driftSql, restoreSql] of cases) {
    const scheduled = await expectOk(call, "schedule", scheduleInput(label), label, "schedule");
    await expectOk(call, "start", startInput(label, scheduled), label, "start");
    const token = await expectOk(call, "finalize", receiptInput(label, scheduled), label, "finalize");
    const before = await first(call, "SELECT COUNT(*) AS count FROM checks", []);
    await expectOk(call, "exec", { sql: bindAttemptSql(driftSql, scheduled.attemptId) }, label, "drift");
    await expectConflict(call, "create-check", { tenantId, actor: actor(), now: completedAt, check: checkCreateInput(token) }, label, "create-after-drift");
    assert.deepEqual(await first(call, "SELECT COUNT(*) AS count FROM checks", []), before, label);
    await expectOk(call, "exec", { sql: bindAttemptSql(restoreSql, scheduled.attemptId) }, label, "restore");
  }
}

async function scenarioCoreCheckStorePostProofDrift(call) {
  const control = await completeNativeJob(call, "post-proof-control");
  const controlCheck = await expectOk(call, "create-check", { tenantId, actor: actor(), now: completedAt, check: checkCreateInput(control.token), driftSql: null }, "post-proof-control", "create-with-wrapper-no-drift");
  assert.equal(controlCheck.status, "completed");

  const createCases = [
    ["post-proof-revoked-producer", "UPDATE principals SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'actor-a'", "UPDATE principals SET active = 1 WHERE tenant_id = 'tenant-a' AND id = 'actor-a'"],
    ["post-proof-producer-epoch", "UPDATE principals SET auth_epoch = 2 WHERE tenant_id = 'tenant-a' AND id = 'actor-a'", "UPDATE principals SET auth_epoch = 1 WHERE tenant_id = 'tenant-a' AND id = 'actor-a'"],
    ["post-proof-native-candidate", `UPDATE native_candidate_job_attempts SET candidate_sha = '${"f".repeat(40)}' WHERE tenant_id = 'tenant-a' AND attempt_id = ?`, `UPDATE native_candidate_job_attempts SET candidate_sha = '${candidateSha}' WHERE tenant_id = 'tenant-a' AND attempt_id = ?`],
    ["post-proof-ruleset-create", "UPDATE rulesets SET version = 2 WHERE tenant_id = 'tenant-a' AND id = 'ruleset-a'", "UPDATE rulesets SET version = 1 WHERE tenant_id = 'tenant-a' AND id = 'ruleset-a'"]
  ];
  for (const [label, driftSql, restoreSql] of createCases) {
    const { scheduled, token } = await completeNativeJob(call, label);
    const before = await first(call, "SELECT COUNT(*) AS count FROM checks", []);
    await expectConflict(call, "create-check", { tenantId, actor: actor(), now: completedAt, check: checkCreateInput(token), driftSql: bindAttemptSql(driftSql, scheduled.attemptId) }, label, "create-post-proof-drift");
    assert.deepEqual(await first(call, "SELECT COUNT(*) AS count FROM checks", []), before, label);
    await expectOk(call, "exec", { sql: bindAttemptSql(restoreSql, scheduled.attemptId) }, label, "restore-post-proof-create-drift");
  }

  const updateCases = [
    ["post-proof-update-candidate", `UPDATE native_candidate_job_attempts SET candidate_sha = '${"e".repeat(40)}' WHERE tenant_id = 'tenant-a' AND attempt_id = ?`, `UPDATE native_candidate_job_attempts SET candidate_sha = '${candidateSha}' WHERE tenant_id = 'tenant-a' AND attempt_id = ?`],
    ["post-proof-update-attempt-fence", "UPDATE job_attempts SET fencing_token = 'not-the-fence' WHERE tenant_id = 'tenant-a' AND id = ?", null],
    ["post-proof-update-ruleset", "UPDATE rulesets SET rules_json = '{\"changed\":true}' WHERE tenant_id = 'tenant-a' AND id = 'ruleset-a'", "UPDATE rulesets SET rules_json = '{}' WHERE tenant_id = 'tenant-a' AND id = 'ruleset-a'"]
  ];
  for (const [label, driftSql, restoreSql] of updateCases) {
    const scheduled = await expectOk(call, "schedule", scheduleInput(label), label, "schedule");
    const queuedToken = await expectOk(call, "read-token", { tenantId, tokenId: `${label}-token-1`, now }, label, "read-queued-token");
    const check = await expectOk(call, "create-check", { tenantId, actor: actor(), now, check: checkCreateInput(queuedToken), driftSql: null }, label, "create-queued-check");
    const started = await expectOk(call, "start", startInput(label, scheduled), label, "start");
    const running = await expectOk(call, "update-check", { tenantId, actor: actor(), now, id: check.id, expectedVersion: 1, patch: checkPatchInput(started), driftSql: null }, label, "update-running-check");
    const token = await expectOk(call, "finalize", receiptInput(label, scheduled), label, "finalize");
    const before = await first(call, "SELECT version,status,conclusion,details_key FROM checks WHERE id = ?", [running.id]);
    await expectConflict(call, "update-check", { tenantId, actor: actor(), now: completedAt, id: running.id, expectedVersion: 2, patch: checkPatchInput(token), driftSql: bindAttemptSql(driftSql, scheduled.attemptId) }, label, "update-post-proof-drift");
    assert.deepEqual(await first(call, "SELECT version,status,conclusion,details_key FROM checks WHERE id = ?", [running.id]), before, label);
    if (restoreSql) await expectOk(call, "exec", { sql: bindAttemptSql(restoreSql, scheduled.attemptId) }, label, "restore-post-proof-update-drift");
  }
}

async function scenarioAlteredReceiptGuards(call) {
  const mutations = [
    ["candidate", { candidateSha: "f".repeat(40) }],
    ["plan", { planDigest: sha("different-plan") }],
    ["context", { context: "ci/other" }],
    ["producer", { producerId: "author-a" }],
    ["command", { command: ["/bin/sh", "-lc", "printf forged-success"] }],
    ["artifacts", { candidateArtifacts: { ...artifacts(), pack: { ...artifacts().pack, sha256: sha("different-pack") } } }]
  ];
  for (const [label, changed] of mutations) {
    const scheduled = await expectOk(call, "schedule", scheduleInput(label), label, "schedule");
    await expectOk(call, "start", startInput(label, scheduled), label, "start");
    const failed = await expectConflict(call, "finalize", receiptInput(label, scheduled, changed), label, "finalize");
    assert.match(failed.error, /NativeJobStoreConflictError|native job finalization/);
    assert.deepEqual(await first(call, "SELECT state, receipt_json FROM native_candidate_job_attempts WHERE attempt_id = ?", [scheduled.attemptId]), { state: "in_progress", receipt_json: null }, label);
    assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 0, label);
    assert.equal(await countTokens(call, scheduled.attemptId, "in_progress"), 1, label);
  }
}

async function scenarioCancelBeforeFinalization(call) {
  const scheduled = await expectOk(call, "schedule", scheduleInput("cancel"), "cancel", "schedule");
  await expectOk(call, "start", startInput("cancel", scheduled), "cancel", "start");
  const cancelled = await expectOk(call, "cancel", startInput("cancel", scheduled), "cancel", "cancel");
  assert.equal(cancelled.status, "completed");
  assert.equal(cancelled.conclusion, "cancelled");
  assert.deepEqual(await first(call, "SELECT state, exit_code FROM job_attempts WHERE id = ?", [scheduled.attemptId]), { state: "cancelled", exit_code: null });
  assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 1);
  await expectConflict(call, "finalize", receiptInput("cancel", scheduled), "cancel", "finalize-after-cancel");
  assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 1);
}

async function scenarioWrongFenceAndGeneration(call) {
  for (const [label, changed] of [["wrong-generation", { attemptGeneration: 2 }], ["wrong-fence", { fenceToken: "not-the-fence" }]]) {
    const scheduled = await expectOk(call, "schedule", scheduleInput(label), label, "schedule");
    await expectOk(call, "start", startInput(label, scheduled), label, "start");
    await expectConflict(call, "finalize", receiptInput(label, scheduled, changed), label, "finalize");
    assert.deepEqual(await first(call, "SELECT state, receipt_json FROM native_candidate_job_attempts WHERE attempt_id = ?", [scheduled.attemptId]), { state: "in_progress", receipt_json: null });
    assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 0);
  }
}

async function scenarioRollbackAndRetry(call) {
  const scheduled = await expectOk(call, "schedule", scheduleInput("rollback"), "rollback", "schedule");
  await expectOk(call, "start", startInput("rollback", scheduled), "rollback", "start");
  const before = await first(call, "SELECT state, job_attempt_version, receipt_json, finalization_nonce FROM native_candidate_job_attempts WHERE attempt_id = ?", [scheduled.attemptId]);
  await expectOk(call, "exec", { sql: "CREATE TRIGGER reject_native_token BEFORE INSERT ON native_candidate_check_qualification_tokens BEGIN SELECT RAISE(ABORT, 'injected native token failure'); END" }, "rollback", "trigger");
  await expectConflict(call, "finalize", receiptInput("rollback", scheduled), "rollback", "finalize");
  assert.deepEqual(await first(call, "SELECT state, job_attempt_version, receipt_json, finalization_nonce FROM native_candidate_job_attempts WHERE attempt_id = ?", [scheduled.attemptId]), before);
  assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 0);
  assert.deepEqual(await first(call, "SELECT state, version, finished_at FROM job_attempts WHERE id = ?", [scheduled.attemptId]), { state: "in_progress", version: 2, finished_at: null });
  await expectOk(call, "exec", { sql: "DROP TRIGGER reject_native_token" }, "rollback", "drop-trigger");
  const token = await expectOk(call, "finalize", receiptInput("rollback", scheduled), "rollback", "retry");
  assert.equal(token.id, "rollback-token-4");
  assert.equal(await countTokens(call, scheduled.attemptId, "completed"), 1);
  assert.notEqual((await first(call, "SELECT finalization_nonce FROM native_candidate_job_attempts WHERE attempt_id = ?", [scheduled.attemptId])).finalization_nonce, before.finalization_nonce);

  const trusted = await expectOk(call, "read-token", { tenantId, tokenId: token.id, now: completedAt }, "rollback", "read-token");
  assert.deepEqual(await call({ action: "guard", guard: trusted.writeFence }), { status: 200, body: { ok: 1 } });
  await expectOk(call, "exec", { sql: "UPDATE principals SET auth_epoch = 2 WHERE tenant_id = 'tenant-a' AND id = 'actor-a'" }, "rollback", "drift-principal");
  assert.deepEqual(await call({ action: "guard", guard: trusted.writeFence }), { status: 200, body: null });
}

async function request(baseUrl, body) {
  const response = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function expectOk(call, action, input, idPrefix, phase, qualify = undefined) {
  const { status, body } = await call({ action, input, idPrefix, phase, qualify });
  assert.equal(status, 200, `${action} unexpectedly failed: ${JSON.stringify(body)}`);
  return body;
}

async function expectConflict(call, action, input, idPrefix, phase) {
  const { status, body } = await call({ action, input, idPrefix, phase });
  assert.equal(status, 409, `${action} unexpectedly succeeded: ${JSON.stringify(body)}`);
  return body;
}

async function first(call, sql, bindings = []) {
  return expectOk(call, "first", { sql, bindings }, "query", "first");
}

async function countTokens(call, attemptId, status) {
  return (await first(call, "SELECT COUNT(*) AS count FROM native_candidate_check_qualification_tokens WHERE job_attempt_id = ? AND status = ?", [attemptId, status])).count;
}

function seedStatements() {
  return [
    stmt("INSERT INTO tenants VALUES(?,?,?,?,?,?,?)", [tenantId, tenantId, "active", 7, "shard-a", "US", "{}"]),
    stmt("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)", [tenantId, actorId, 1, now, now, "human", "Actor A", 1, 1]),
    stmt("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)", [tenantId, "author-a", 1, now, now, "human", "Author A", 1, 1]),
    stmt("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)", [tenantId, "ns-a", 1, now, now, "ns-a", "Namespace A"]),
    stmt("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [tenantId, targetRepositoryId, 1, now, now, "ns-a", "target", "private", "main", 0, tenantId, targetRepositoryId, null]),
    stmt("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [tenantId, "issue-a", 5, now, now, targetRepositoryId, 1, "PR", "Body", "open", "", "author-a", "pull_request"]),
    stmt("INSERT INTO pull_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [tenantId, pullRequestId, 3, now, now, "issue-a", targetRepositoryId, sourceRepositoryId, "refs/heads/topic", "refs/heads/main", headSha, baseSha, 0, null, null, null]),
    stmt("INSERT INTO rulesets VALUES(?,?,?,?,?,?,?,?,?)", [tenantId, "ruleset-a", 1, now, now, targetRepositoryId, 1, "{}", 1]),
    stmt("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)", [tenantId, eligibilityOperationId, 1, now, now, "pr.eligibility.prepare", actorId, "complete", "{}", `json:${JSON.stringify(eligibilityOperationResult())}`, null]),
    stmt("INSERT INTO pr_eligibility_active VALUES(?,?,?,?,?,?,?)", [tenantId, pullRequestId, "eligibility-key", eligibilityOperationId, 1, expiresAt, now]),
    stmt("INSERT INTO pr_eligibility_generations(tenant_id,pull_request_id,operation_id,logical_key,generation,actor_id,state,created_at,updated_at,expires_at,committed_at,head_sha,base_sha,method,policy_digest,progress_json,snapshot_json,error_json,finalization_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [tenantId, pullRequestId, eligibilityOperationId, "eligibility-key", 1, actorId, "complete", now, now, expiresAt, now, headSha, baseSha, "merge", policyDigest, JSON.stringify({ observedRuleRows }), JSON.stringify({ id: eligibilityOperationId, candidate_sha: candidateSha }), null, "eligibility-nonce"]),
    stmt("INSERT INTO eligibility VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [tenantId, eligibilityOperationId, 1, now, now, targetRepositoryId, pullRequestId, headSha, baseSha, candidateSha, 7, JSON.stringify({ id: eligibilityOperationId, candidate_sha: candidateSha }), expiresAt])
  ];
}

function stmt(sql, bindings) { return { sql, bindings }; }

function scheduleInput(caseId, overrides = {}) {
  return { tenantId, producerId: actorId, producerAuthEpoch: 1, tenantPolicyEpoch: 7, now, expiresAt, context: "ci/build", command: ["/bin/sh", "-lc", `printf ${JSON.stringify(caseId)}`], imageDigest, sourceRepositoryId, targetRepositoryId, pullRequestId, pullRequestVersion: 3, issueVersion: 5, eligibilityOperationId, eligibilityGeneration: 1, candidateSha, headSha, baseSha, candidateTreeSha, policyDigest, planDigest, reviewedDiffDigest, candidateArtifacts: artifacts(), observedRuleRows, ...overrides };
}

function startInput(caseId, scheduled, overrides = {}) {
  return { ...scheduleInput(caseId), jobId: scheduled.jobId, attemptId: scheduled.attemptId, attemptGeneration: scheduled.attemptGeneration, fenceToken: scheduled.fenceToken, ...overrides };
}

function receiptInput(caseId, scheduled, overrides = {}) {
  return { ...startInput(caseId, scheduled), now: completedAt, terminalStatus: "completed", exitCode: 0, providerEvidenceRef: `r2://native-job-logs/${caseId}`, logSha256: sha(`log:${caseId}`), logBytes: 128, ...overrides };
}

function qualificationRequest(token) {
  return { tenantId, targetRepositoryId, producerId: actorId, context: "ci/build", commitSha: candidateSha, headSha, baseSha, executionSha: candidateSha, policyDigest, planDigest, input: { evidence_kind: "native_job", job_attempt_id: token.jobAttemptId, provider_evidence_ref: token.providerEvidenceRef, status: token.status, conclusion: token.conclusion } };
}

async function completeNativeJob(call, caseId) {
  const scheduled = await expectOk(call, "schedule", scheduleInput(caseId), caseId, "schedule");
  await expectOk(call, "start", startInput(caseId, scheduled), caseId, "start");
  const token = await expectOk(call, "finalize", receiptInput(caseId, scheduled), caseId, "finalize");
  return { scheduled, token };
}

function checkCreateInput(token) {
  return { repository_id: targetRepositoryId, commit_sha: candidateSha, head_sha: headSha, base_sha: baseSha, execution_sha: candidateSha, plan_digest: planDigest, policy_digest: policyDigest, job_attempt_id: token.jobAttemptId, evidence_kind: "native_job", candidate_bound: true, provider_evidence_ref: null, name: "ci/build", status: token.status, conclusion: token.conclusion, details_url: null, output: checkOutput(token), annotations: [] };
}

function checkPatchInput(token) {
  return { status: token.status, conclusion: token.conclusion, output: checkOutput(token), annotations_append: [] };
}

function checkOutput(token) {
  return { title: `native job ${token.status}`, summary: `${token.jobAttemptId} ${token.providerEvidenceRef}`, text: token.receiptSha256 };
}

function pickCheck(check) {
  return { version: check.version, status: check.status, conclusion: check.conclusion, provider_evidence_ref: check.provider_evidence_ref, job_attempt_id: check.job_attempt_id };
}

function actor() {
  return { id: actorId, tenantId, revoked: false, capabilities: ["check.write"] };
}

function bindAttemptSql(sql, attemptId) {
  return sql.replace("?", `'${attemptId}'`);
}

function artifacts() {
  const requestSha256 = sha("candidate-request");
  return { manifest: locator(requestSha256, "candidate_manifest", sha("manifest"), 345), rawCommit: locator(requestSha256, "candidate_raw_commit", sha("raw"), 456), pack: locator(requestSha256, "candidate_pack", sha("pack"), 567) };
}

function locator(requestSha256, kind, digest, sizeBytes) {
  return { tenantId, repositoryId: targetRepositoryId, operationId: eligibilityOperationId, requestSha256, kind, sha256: digest, sizeBytes, key: `v1/tenants/${tenantId}/repositories/${targetRepositoryId}/merge-operations/${eligibilityOperationId}/${requestSha256}/${kind}`, etag: `etag-${kind}`, version: `version-${kind}`, expiresAt: null };
}

function eligibilityOperationResult() {
  const reviewedDiff = { algorithmVersion: "git-cli-unified-v1", comparison: "three_dot", contextLines: 3, headSha, baseSha, mergeBaseShas: [baseSha], patchSha256: reviewedDiffDigest, patchSizeBytes: 12, changedPathsSha256: sha("changed-paths") };
  const result = { ok: true, status: "prepared", candidateOid: candidateSha, candidateTree: candidateTreeSha, candidateBytesSha256: sha("raw"), stateRef: `merge-candidates/requests/${sha("candidate-request")}/manifest.json` };
  const requiredChecks = [{ context: "ci/build", producer_id: actorId, accepted_conclusions: ["success"], max_age_seconds: null }];
  const enforcement = { allowDeletion: true, allowForcePush: false, allowedMergeMethods: ["merge"], allowedWriterGroupClauses: [], dismissStaleReviews: false, forbiddenPathPatterns: [], maxBlobSizeBytes: null, requireCodeOwners: false, requireHumanApproval: false, requireLatestPushApproval: false, requireLinearHistory: false, requireMergeQueue: false, requirePullRequest: true, requireResolvedThreads: false, requireSignedCommits: false, requiredApprovals: 0, requiredChecks, requiredEnvironmentIds: [] };
  return { snapshot: { tenant_id: tenantId, pull_request_id: pullRequestId, pr_version: 5, id: eligibilityOperationId, status: "eligible", head_sha: headSha, base_sha: baseSha, candidate_sha: candidateSha, method: "merge", diff_digest: reviewedDiffDigest, policy_digest: policyDigest, policy_epoch: 7, expires_at: expiresAt, blockers: [], reviews: [], checks: [] }, candidate: { requestSha256: sha("candidate-request"), result, reviewedDiff, ...artifacts() }, outcome: result, preparationRequestSha256: sha("candidate-request"), policy: { identityRules: [{ rowId: "ruleset-a", rowVersion: 1, rowPriority: 1, rowEnabled: true, rule: {} }], enforcement }, checkPlan: { plan: { tenantId, sourceRepositoryId, targetRepositoryId, pullRequestId, pullRequestVersion: 3, headOid: headSha, baseOid: baseSha, candidateOid: candidateSha, candidateTreeOid: candidateTreeSha, policyDigest, requiredChecks }, planDigest }, reviewedDiff, source: { tenantId, sourceRepositoryId, targetRepositoryId, sourceRef: "refs/heads/topic", targetRef: "refs/heads/main", headSha, baseSha }, exposedIssueVersion: 5, internalPrRevision: 3, generation: 1 };
}

function sha(value) { return createHash("sha256").update(value).digest("hex"); }

await main();

