#!/usr/bin/env node
// An agent changes GitFoundry inside GitFoundry: it forks the published version, edits its own
// instructions and the forge's code, has the runner test that exact version, and publishes when the
// signed result passes. No person approves.
//
//   node scripts/self-improve.mjs --change AGENTS.md=/path/to/new-AGENTS.md [--change path=file ...] --why "what and why"
//   node scripts/self-improve.mjs --full-auto --why "let passing tests publish"
//   node scripts/self-improve.mjs --resume RUN_ID   (wait for a test run already requested, then publish it)
//
// --full-auto changes the publishing rules so a passing signed test run is enough. While the rules
// still require an approval, that one change carries the signed-in owner's approval of its exact contents.
// Settings come from GFY_URL, GFY_TOKEN, GFY_WORKSPACE and GFY_REPOSITORY, or from .gfy-self.json.
import { readFileSync } from 'node:fs';

let saved = {};
try { saved = JSON.parse(readFileSync('.gfy-self.json', 'utf8')); } catch { /* environment only */ }
const origin = (process.env.GFY_URL ?? saved.url ?? 'https://gitfoundry.dev').replace(/\/$/u, '');
const token = process.env.GFY_TOKEN ?? saved.token;
const workspace = process.env.GFY_WORKSPACE ?? saved.workspace;
const repository = process.env.GFY_REPOSITORY ?? saved.repository;
if (!token || !workspace || !repository) throw new Error('Set GFY_TOKEN, GFY_WORKSPACE, and GFY_REPOSITORY, or write .gfy-self.json.');

const args = process.argv.slice(2);
const option = name => args.flatMap((arg, index) => arg === name ? [args[index + 1]] : []);
const why = option('--why')[0] ?? 'self-improvement';
const fullAuto = args.includes('--full-auto');
const resume = option('--resume')[0];
const changes = option('--change').map(spec => {
  const at = spec.indexOf('=');
  if (at < 1) throw new Error(`--change needs path=file, got ${spec}`);
  return { tree: 'code', path: spec.slice(0, at), content_base64: readFileSync(spec.slice(at + 1)).toString('base64') };
});
if (!fullAuto && !resume && !changes.length) throw new Error('Give at least one --change path=file, or --full-auto.');

const run = Date.now().toString(36);
const started = Date.now();
const repo = `${origin}/api/v2/tenants/${encodeURIComponent(workspace)}/repositories/${encodeURIComponent(repository)}`;
const b64 = text => Buffer.from(text).toString('base64');
const short = sha => sha.slice(0, 7);
const say = text => console.log(`\x1b[90m${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s\x1b[0m ${text}`);

async function call(method, path, body) {
  const response = await fetch(repo + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(body?.operation_id ? { 'Idempotency-Key': body.operation_id } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(`${method} ${path.split('?')[0]} -> ${response.status} ${data.error ?? ''}${data.reason ? ': ' + data.reason : ''}`); error.data = data; throw error; }
  return data;
}
const head = async () => (await call('GET', '/forge/head')).version;
const fork = async (parent, id) => (await call('POST', '/forge/fork', { operation_id: id, parent_version: parent })).version;
const commit = async (parent, id, list) => (await call('POST', '/forge/commit', { operation_id: id, parent_version: parent, changes: list })).version;
const publish = async (expected, next, id) => (await call('POST', '/forge/publish', { operation_id: id, expected_head: expected, new_version: next })).version;
const readState = async (version, path) => JSON.parse(Buffer.from((await call('GET', `/forge/files?version=${version}&tree=state&path=${encodeURIComponent(path)}`)).content, 'base64').toString('utf8'));

let base, testRun;
if (resume) {
  // A run that was already requested keeps its exact version and the head it was forked from.
  testRun = (await call('GET', `/actions/runs/${encodeURIComponent(resume)}`)).run;
  base = { version_commit: testRun.head_version_commit };
  say(`resuming run ${testRun.id} on ${short(testRun.version_commit)}, forked from ${short(base.version_commit)}`);
} else {
  base = await head();
  say(`published version is ${short(base.version_commit)}; the agent forks it`);
}

if (fullAuto) {
  const rules = await readState(base.version_commit, 'config/publication.json');
  if (rules.reviews.required_approvals === 0) { say('the rules already let a passing test run publish'); process.exit(0); }
  const own = await fork(base.version_commit, `rules-${run}`);
  let next = await commit(own.version_commit, `rules-${run}-edit`, [{ tree: 'state', path: 'config/publication.json', content_base64: b64(JSON.stringify({ ...rules, reviews: { ...rules.reviews, required_approvals: 0 } })) }]);
  say(`rules changed in ${short(next.version_commit)}: a passing signed test run is enough to publish`);
  next = await commit(next.version_commit, `rules-${run}-review`, [{ tree: 'state', path: `reviews/rules-${run}.json`, content_base64: b64(JSON.stringify({ schema_version: 1, kind: 'review', id: `rules-${run}`, decision: 'approve', configuration_review: true, reason: why })) }]);
  say(`the current rules still need an approval for this change; owner approval signed into ${short(next.version_commit)}`);
  const published = await publish(base.version_commit, next.version_commit, `rules-${run}-publish`);
  say(`published ${short(published.version_commit)}; from now on, passing tests publish without a person`);
  process.exit(0);
}

if (!testRun) {
  const own = await fork(base.version_commit, `self-${run}`);
  const changed = await commit(own.version_commit, `self-${run}-edit`, changes);
  say(`changed ${changes.map(change => change.path).join(', ')} in ${short(changed.version_commit)}: ${why}`);
  testRun = (await call('POST', '/actions/runs', { kind: 'all-tests', operation_id: `self-${run}-tests`, version_commit: changed.version_commit })).run;
  say(`runner asked to test ${short(changed.version_commit)} (run ${testRun.id})`);
}
while (testRun.status !== 'completed' || testRun.evidence_status === 'pending') {
  await new Promise(resolve => setTimeout(resolve, 10000));
  // A dropped connection while waiting is not a result; ask again on the next poll.
  testRun = (await call('GET', `/actions/runs/${encodeURIComponent(testRun.id)}`).catch(error => { if (error.data) throw error; return { run: testRun }; })).run;
}
if (testRun.conclusion !== 'success' || !testRun.evidence_ref) { say(`tests ${testRun.conclusion}; nothing is published`); process.exit(1); }
say(`all tests passed; the signed result is recorded in ${short(testRun.evidence_ref)}`);

try {
  const published = await publish(base.version_commit, testRun.evidence_ref, `${testRun.id}-publish`);
  say(`published ${short(published.version_commit)}; GitFoundry now runs with the agent's change`);
} catch (error) {
  if (error.data?.error === 'gfy_stale_precondition') say('someone published first; the agent forks the new version and tries again');
  else say(`refused: ${error.data?.reason ?? error.message}`);
  process.exit(1);
}
