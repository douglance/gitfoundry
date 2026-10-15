import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const packageJson = process.env.GFY_WRANGLER_PACKAGE_JSON;
const require = packageJson ? createRequire(packageJson) : createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { build } = require("esbuild");
const source = `
import { makeD1PrEligibilityStore } from "./apps/api-worker/src/pr-eligibility/store.ts";
export default { async fetch(request, env) {
  const { action, input } = await request.json();
  const store = makeD1PrEligibilityStore(env.DB);
  try {
    if (action === "reserve") return Response.json(await store.reserve(input));
    if (action === "complete") { await store.complete(input); return Response.json({ completed: true }); }
    return new Response(null, { status: 400 });
  } catch (error) { return Response.json({ error: String(error) }, { status: 409 }); }
}};
`;
const bundle = await build({ stdin: { contents: source, resolveDir: root, sourcefile: "eligibility-d1-gate.ts", loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:crypto"], logLevel: "error" });
const options = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"] };
const mf = new Miniflare(typeof convertV4MiniflareOptions === "function" ? convertV4MiniflareOptions(options) : options);
const now = "2026-10-09T00:00:00.000Z";
const expiresAt = "2026-10-09T00:10:00.000Z";
const headSha = "a".repeat(40), baseSha = "b".repeat(40), candidateSha = "c".repeat(40);
const reservation = (key) => ({ tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "actor-a", logicalKey: key, operationPrefix: "native-" + key, now, expiresAt, committedAt: now, headSha, baseSha, method: "merge", policyDigest: "d".repeat(64), progress: { committedAt: now } });
const finalization = (key, candidate = null, issueVersion = 5) => ({
  tenantId: "tenant-a", operationId: "native-" + key + "-g1", logicalKey: key, generation: 1, now,
  snapshot: { id: "native-" + key + "-g1", status: "blocked", candidate_sha: candidate },
  result: { outcome: candidate === null ? { ok: false, status: "conflict" } : { ok: true, status: "prepared" } },
  progress: { committedAt: now }, candidateSha: candidate, repositoryId: "repo-a", sourceRepositoryId: "repo-a", pullRequestId: "pr-a",
  prVersion: 3, issueVersion, issueState: "open", draft: false, closedAt: null, mergedAt: null,
  sourceRef: "refs/heads/topic", targetRef: "refs/heads/main", headSha, baseSha, policyEpoch: 7, expiresAt,
  observedRuleRows: [{ id: "ruleset-a", version: 1, priority: 1, enabled: 1, rules_json: "{}" }]
});
const request = (action, input) => mf.dispatchFetch("https://eligibility-store.test/", { method: "POST", body: JSON.stringify({ action, input }), headers: { "content-type": "application/json" } });
async function expectStatus(response, status) { assert.equal(response.status, status, await response.clone().text()); return response; }
try {
  const db = await mf.getD1Database("DB");
  for (const migration of ["0001_handbook.sql", "0003_pr_eligibility.sql", "0004_pr_eligibility_finalization.sql"]) {
    const sql = (await readFile(resolve(root, "infra/migrations", migration), "utf8")).replace(/^\s*--.*$/gm, "");
    await db.exec(sql.replaceAll("\n", " "));
  }
  const seed = [
    "INSERT INTO tenants VALUES('tenant-a','tenant-a','active',7,'shard-a','US','{}')",
    "INSERT INTO principals VALUES('tenant-a','actor-a',1,'" + now + "','" + now + "','human','Actor A',1,1)",
    "INSERT INTO principals VALUES('tenant-a','author-a',1,'" + now + "','" + now + "','human','Author A',1,1)",
    "INSERT INTO organization_namespaces VALUES('tenant-a','ns-a',1,'" + now + "','" + now + "','ns-a','Namespace A')",
    "INSERT INTO repositories VALUES('tenant-a','repo-a',1,'" + now + "','" + now + "','ns-a','repo-a','private','main',0,'tenant-a','repo-a',NULL)",
    "INSERT INTO issues VALUES('tenant-a','issue-a',5,'" + now + "','" + now + "','repo-a',1,'PR','Body','open','','author-a','pull_request')",
    "INSERT INTO pull_requests VALUES('tenant-a','pr-a',3,'" + now + "','" + now + "','issue-a','repo-a','repo-a','refs/heads/topic','refs/heads/main','" + headSha + "','" + baseSha + "',0,NULL,NULL,NULL)",
    "INSERT INTO rulesets VALUES('tenant-a','ruleset-a',1,'" + now + "','" + now + "','repo-a',1,'{}',1)"
  ];
  await db.batch(seed.map((sql) => db.prepare(sql)));
  await expectStatus(await request("reserve", reservation("conflict")), 200);
  const completed = finalization("conflict");
  await expectStatus(await request("complete", completed), 200);
  const initial = await db.prepare("SELECT state,finalization_nonce FROM pr_eligibility_generations WHERE operation_id = ?").bind(completed.operationId).first();
  assert.equal(initial.state, "complete"); assert.match(initial.finalization_nonce, /^[0-9a-f-]{36}$/);
  await expectStatus(await request("complete", { ...completed, candidateSha }), 409);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM eligibility").first()).n, 0);
  assert.deepEqual(await db.prepare("SELECT state,finalization_nonce FROM pr_eligibility_generations WHERE operation_id = ?").bind(completed.operationId).first(), initial);
  assert.equal((await db.prepare("SELECT result_key FROM operations WHERE id = ?").bind(completed.operationId).first()).result_key, "json:" + JSON.stringify(completed.result));

  await expectStatus(await request("reserve", reservation("success")), 200);
  await expectStatus(await request("complete", finalization("success", candidateSha)), 200);
  assert.equal((await db.prepare("SELECT candidate_sha FROM eligibility WHERE id = 'native-success-g1'").first()).candidate_sha, candidateSha);

  await expectStatus(await request("reserve", reservation("stale")), 200);
  await db.prepare("UPDATE issues SET version = 6 WHERE tenant_id = 'tenant-a' AND id = 'issue-a'").run();
  assert.equal((await db.prepare("SELECT version FROM issues WHERE id = 'issue-a'").first()).version, 6);
  await expectStatus(await request("complete", finalization("stale", candidateSha)), 409);
  assert.deepEqual(await db.prepare("SELECT state,finalization_nonce FROM pr_eligibility_generations WHERE operation_id = 'native-stale-g1'").first(), { state: "running", finalization_nonce: null });
  assert.deepEqual(await db.prepare("SELECT state,result_key FROM operations WHERE id = 'native-stale-g1'").first(), { state: "running", result_key: null });
  assert.equal((await db.prepare("SELECT count(*) AS n FROM eligibility").first()).n, 1);

  await expectStatus(await request("reserve", reservation("rollback")), 200);
  await db.prepare("CREATE TRIGGER reject_eligibility BEFORE INSERT ON eligibility BEGIN SELECT RAISE(ABORT, 'injected eligibility failure'); END").run();
  await expectStatus(await request("complete", finalization("rollback", candidateSha, 6)), 409);
  assert.deepEqual(await db.prepare("SELECT state,finalization_nonce FROM pr_eligibility_generations WHERE operation_id = 'native-rollback-g1'").first(), { state: "running", finalization_nonce: null });
  assert.deepEqual(await db.prepare("SELECT state,result_key FROM operations WHERE id = 'native-rollback-g1'").first(), { state: "running", result_key: null });
  assert.equal((await db.prepare("SELECT count(*) AS n FROM eligibility").first()).n, 1);
  await db.prepare("DROP TRIGGER reject_eligibility").run();
  await expectStatus(await request("complete", finalization("rollback", candidateSha, 6)), 200);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM eligibility").first()).n, 2);
  console.log("native D1 eligibility generation, identical-owner guard, stale-context and atomic rollback gates passed");
} finally { await mf.dispose(); }
