#!/usr/bin/env node
// Prepares a GitFoundry workspace for scripts/agents-demo.mjs: signs in with an emailed code,
// creates a small "checkout" repository with tests, and starts its forge fully automatic: no person approves.
//
//   node scripts/agents-demo-setup.mjs you@example.com
//   GFY_TOKEN=gfys_... GFY_WORKSPACE=ws-... node scripts/agents-demo-setup.mjs   (reuse a session)
//
// The session token is saved to .gfy-demo.json (mode 0600), which the demo reads.
import { createInterface } from 'node:readline/promises';
import { writeFile } from 'node:fs/promises';

const origin = (process.env.GFY_URL ?? 'https://gitfoundry.dev').replace(/\/$/u, '');
const email = process.argv[2];
const b64 = text => Buffer.from(text).toString('base64');

async function json(method, url, body, token) {
  const response = await fetch(origin + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${data.error ?? ''}`);
  return { data, response };
}

async function signIn() {
  // An existing session skips the emailed code, so an agent can set the demo up on its own.
  if (process.env.GFY_TOKEN && process.env.GFY_WORKSPACE) return { token: process.env.GFY_TOKEN, workspace: process.env.GFY_WORKSPACE };
  if (!email) throw new Error('Usage: node scripts/agents-demo-setup.mjs you@example.com, or set GFY_TOKEN and GFY_WORKSPACE');
  await json('POST', '/auth/email/start', { email });
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await prompt.question(`Enter the six-digit code sent to ${email}: `)).trim();
  prompt.close();
  const verified = await json('POST', '/auth/email/verify', { email, code });
  return { token: /gfy_session=(gfys_[^;]+)/u.exec(verified.response.headers.get('set-cookie') ?? '')?.[1], workspace: verified.data.tenant_id };
}
const { token, workspace } = await signIn();
if (!token || !workspace) throw new Error('Sign-in did not return a session.');
console.log(`Signed in to workspace ${workspace}.`);

const name = 'checkout-' + Date.now().toString(36);
const created = await json('POST', `/api/v1/tenants/${workspace}/repositories`, { namespace_id: 'core', name, visibility: 'private', description: 'A tiny shop checkout that several agents change at once' }, token);
const repository = created.data.id;
console.log(`Created repository ${name}. Starting its forge (about a minute)...`);

const code_files = {
  'README.md': '# Checkout\n\nA tiny shop checkout. Several agents change it at once on GitFoundry.\n',
  'src/cart.js': 'export function subtotal(items) {\n  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n}\n\nexport function total(items) {\n  return subtotal(items);\n}\n',
  'src/format.js': "export function money(cents) {\n  return '$' + (cents / 100).toFixed(2);\n}\n",
  'package.json': '{\n  "name": "checkout",\n  "type": "module"\n}\n',
  'test/checkout.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { subtotal, total } from '../src/cart.js';\nimport { money } from '../src/format.js';\n\nconst items = [{ price: 1000, quantity: 2 }, { price: 500, quantity: 1 }];\n\ntest('subtotal adds every line', () => assert.equal(subtotal(items), 2500));\ntest('total never charges less than the subtotal without a discount', () => assert.ok(total(items) >= subtotal(items)));\ntest('total never goes below zero', () => assert.ok(total(items, 1e9) >= 0));\ntest('money shows dollars and cents', () => assert.equal(money(1234), '$12.34'));\n"
};
// Fully automatic: publishing needs no approving review. The agents run the tests and publish when they pass.
const policy = { schema_version: 1, evaluator_digest: 'sha256:none', checks: [], reviews: { required_approvals: 0, trusted_reviewer_ids: ['owner'], actor_kinds: ['human'], key_ids: ['owner-review-production'] } };
const keys = { 'owner-review-production': { crv: 'Ed25519', x: 'ft3aN-38heVPk-V9r5n0562pQuM_QXw1GDUIpK5t1aQ', kty: 'OKP' } };
await json('POST', `/api/v2/tenants/${workspace}/repositories/${repository}/forge/initialize`, {
  operation_id: `${name}-init`,
  initial_code: Object.entries(code_files).map(([path, content]) => ({ path, content_base64: b64(content) })),
  initial_state: [
    { path: 'config/publication.json', content_base64: b64(JSON.stringify(policy)) },
    { path: 'config/trusted-keys.json', content_base64: b64(JSON.stringify(keys)) }
  ]
}, token);

await writeFile('.gfy-demo.json', JSON.stringify({ url: origin, token, workspace, repository }, null, 2), { mode: 0o600 });
console.log(`Ready. Run: node scripts/agents-demo.mjs\nOpen ${origin}/?tenant=${workspace}&repo=${repository}&section=forks to watch.`);
