#!/usr/bin/env node
// Three agents change one GitFoundry repository at the same time, then integrate, resolve a
// conflict, run the tests, and publish with a compare-and-swap on the forge head. No person approves.
//
//   GFY_URL=https://gitfoundry.dev GFY_TOKEN=gfys_... GFY_WORKSPACE=ws-... GFY_REPOSITORY=repo-... \
//     node scripts/agents-demo.mjs
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Settings come from the environment, or from .gfy-demo.json written by scripts/agents-demo-setup.mjs.
let saved = {};
try { saved = JSON.parse(readFileSync('.gfy-demo.json', 'utf8')); } catch { /* environment only */ }
const origin = (process.env.GFY_URL ?? saved.url ?? 'https://gitfoundry.dev').replace(/\/$/u, '');
const token = process.env.GFY_TOKEN ?? saved.token;
const workspace = process.env.GFY_WORKSPACE ?? saved.workspace;
const repository = process.env.GFY_REPOSITORY ?? saved.repository;
if (!token || !workspace || !repository) throw new Error('Run node scripts/agents-demo-setup.mjs first, or set GFY_TOKEN, GFY_WORKSPACE, and GFY_REPOSITORY.');

const run = Date.now().toString(36);
const started = Date.now();
const forge = `${origin}/api/v2/tenants/${encodeURIComponent(workspace)}/repositories/${encodeURIComponent(repository)}/forge`;
const b64 = text => Buffer.from(text).toString('base64');
const unb64 = text => Buffer.from(text, 'base64').toString('utf8');
const short = sha => sha.slice(0, 7);
const colors = { ada: 35, grace: 36, linus: 33, integrator: 34, tests: 32, forge: 90 };
const say = (who, text) => console.log(`\x1b[90m${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s\x1b[0m \x1b[${colors[who] ?? 37}m${who.padEnd(10)}\x1b[0m ${text}`);

async function call(method, path, body) {
  // Every write carries an operation ID, so repeating one after a dropped connection is safe.
  let response;
  for (let attempt = 1; ; attempt++) {
    try { response = await send(method, path, body); break; }
    catch (error) { if (attempt === 3) throw error; await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(`${method} ${path} -> ${response.status} ${data.error ?? ''}`); error.status = response.status; error.data = data; throw error; }
  return data;
}
function send(method, path, body) {
  return fetch(forge + path, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(body?.operation_id ? { 'Idempotency-Key': body.operation_id } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}
const head = async () => (await call('GET', '/head')).version;
const readCode = async (version, path) => unb64((await call('GET', `/files?version=${version}&tree=code&path=${encodeURIComponent(path)}`)).content);
const fork = async (parent, id) => (await call('POST', '/fork', { operation_id: id, parent_version: parent })).version;
const commit = async (parent, id, changes) => (await call('POST', '/commit', { operation_id: id, parent_version: parent, changes })).version;
const merge = async (base, left, right, id) => call('POST', '/merge', { operation_id: id, base_version: base, left_version: left, right_version: right });
const publish = async (expected, next, id) => (await call('POST', '/publish', { operation_id: id, expected_head: expected, new_version: next })).version;

// Each agent edits the same small checkout. Ada and Linus both rewrite total(), so they conflict.
const agents = [
  { name: 'ada', goal: 'add 8% sales tax', path: 'src/cart.js', edit: source => source
      .replace('export function total(items) {\n  return subtotal(items);\n}', 'export const TAX_RATE = 0.08;\n\nexport function total(items) {\n  return Math.round(subtotal(items) * (1 + TAX_RATE));\n}') },
  { name: 'grace', goal: 'format money for any currency', path: 'src/format.js', edit: () =>
      "export function money(cents, currency = 'USD', locale = 'en-US') {\n  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);\n}\n" },
  { name: 'linus', goal: 'support discount codes', path: 'src/cart.js', edit: source => source
      .replace('export function total(items) {\n  return subtotal(items);\n}', 'export function total(items, discount = 0) {\n  return Math.max(0, subtotal(items) - discount);\n}') }
];

const base = await head();
say('forge', `head is ${short(base.version_commit)} (${base.descriptor.fork_id}); ${agents.length} agents start at once`);

// 1. Every agent forks the same head and commits its change plus a handoff note, concurrently.
const forks = await Promise.all(agents.map(async agent => {
  const t0 = Date.now();
  const own = await fork(base.version_commit, `${agent.name}-${run}`);
  const before = await readCode(own.version_commit, agent.path);
  const note = `# ${agent.name}\n\nGoal: ${agent.goal}.\nChanged: ${agent.path}.\nForked from: ${base.version_commit}.\n`;
  const done = await commit(own.version_commit, `${agent.name}-${run}-work`, [
    { tree: 'code', path: agent.path, content_base64: b64(agent.edit(before)) },
    { tree: 'state', path: `notes/${agent.name}.md`, content_base64: b64(note) }
  ]);
  say(agent.name, `forked and committed "${agent.goal}" as ${short(done.version_commit)} in ${Date.now() - t0} ms`);
  return { agent, version: done };
}));

// 2. The integrator merges each fork into one integration line; a conflict goes back to its author.
let integrated = base.version_commit;
for (const { agent, version } of forks) {
  const result = await merge(base.version_commit, integrated, version.version_commit, `integrate-${agent.name}-${run}`);
  if (result.status === 'conflict') {
    const paths = result.conflicts.map(conflict => `${conflict.tree}:${conflict.path}`).join(', ');
    say('integrator', `conflict merging ${agent.name}: ${paths}; handing it back with both versions`);
    const ours = await readCode(integrated, agent.path);
    const resolved = ours.replace(/export function total\(items\) \{\n  return Math\.round\(subtotal\(items\) \* \(1 \+ TAX_RATE\)\);\n\}/u,
      'export function total(items, discount = 0) {\n  return Math.round(Math.max(0, subtotal(items) - discount) * (1 + TAX_RATE));\n}');
    const fixed = await commit(integrated, `${agent.name}-${run}-resolve`, [
      { tree: 'code', path: agent.path, content_base64: b64(resolved) },
      { tree: 'state', path: `notes/${agent.name}.md`, content_base64: b64(`# ${agent.name}\n\nGoal: ${agent.goal}.\nResolved a conflict with ada in ${agent.path}: discount applies before tax.\n`) }
    ]);
    say(agent.name, `resolved the conflict on top of the integration line as ${short(fixed.version_commit)}`);
    integrated = fixed.version_commit;
  } else {
    integrated = result.version.version_commit;
    say('integrator', `merged ${agent.name} cleanly -> ${short(integrated)}`);
  }
}

// 3. The integrator runs the tests on the exact integrated code. Passing tests are the approval.
const candidate = integrated;
const workdir = await mkdtemp(join(tmpdir(), 'checkout-'));
try {
  const entries = (await call('GET', `/files?version=${candidate}&tree=code`)).entries ?? [];
  for (const entry of entries.filter(item => item.type === 'blob')) {
    await mkdir(join(workdir, dirname(entry.path)), { recursive: true });
    await writeFile(join(workdir, entry.path), await readCode(candidate, entry.path));
  }
  const tests = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: workdir, encoding: 'utf8' });
  const passed = /^# pass (\d+)/mu.exec(tests.stdout)?.[1] ?? '0';
  if (tests.status !== 0) { say('tests', `failed on ${short(candidate)}; nothing is published`); console.log(tests.stdout); process.exit(1); }
  say('tests', `${passed} tests passed on ${short(candidate)}; passing tests are enough to publish`);
} finally { await rm(workdir, { recursive: true, force: true }); }

// 4. Publishing is a compare-and-swap on the forge head. Grace, late, tries to publish her lone fork
// against the head she started from, after the integrated version has moved it, and is refused.
const racer = forks.find(item => item.agent.name === 'grace');
const [mine] = await Promise.allSettled([publish(base.version_commit, candidate, `publish-${run}`)]);
const [theirs] = await Promise.allSettled([publish(base.version_commit, racer.version.version_commit, `publish-grace-alone-${run}`)]);
if (mine.status === 'fulfilled') say('forge', `published ${short(candidate)}; forge head moved ${short(base.version_commit)} -> ${short(mine.value.version_commit)}`);
else say('forge', `integrated publish refused: ${mine.reason.message}`);
const why = theirs.status === 'rejected' ? (theirs.reason.data?.error === 'gfy_stale_precondition' ? 'the head already moved' : theirs.reason.data?.reason ?? theirs.reason.data?.error ?? theirs.reason.message) : '';
say('grace', theirs.status === 'rejected' ? `publish of her lone fork refused (${theirs.reason.status}): ${why}; nothing was lost` : 'lone fork published (unexpected)');
const final = await head();
const [cart, format] = await Promise.all([readCode(final.version_commit, 'src/cart.js'), readCode(final.version_commit, 'src/format.js')]);
const carried = [cart.includes('TAX_RATE') && 'tax', format.includes('Intl.NumberFormat') && 'currency formatting', cart.includes('discount') && 'discounts'].filter(Boolean);
say('forge', `head ${short(final.version_commit)} carries ${carried.join(', ') || 'none of the changes'}; ${((Date.now() - started) / 1000).toFixed(1)} s total`);
if (mine.status !== 'fulfilled' || theirs.status !== 'rejected' || carried.length !== 3) process.exit(1);
