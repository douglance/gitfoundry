import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROUTES, requestJson, normalizeList } from '../src/api.js';

await import('./commands.test.mjs');
await import('./source-model.test.mjs');
await import('./review-evidence.test.mjs');
await import('./forge-model.test.mjs');
await import('./site-status-model.test.mjs');
const sourceApp = await readFile(new URL('../src/SourceBrowser.jsx', import.meta.url), 'utf8');
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const text = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [html, css, app, main, api] = await Promise.all(['index.html', 'src/app.css', 'src/App.jsx', 'src/app.js', 'src/api.js'].map(text));
check('every visible control uses Kumo', !/<(?:button|select|textarea|label|a)\b/.test(app + sourceApp) && !/<input\b(?![^>]*type="hidden")/.test(app + sourceApp));
check('no legacy HTML rendering', !/innerHTML|dangerouslySetInnerHTML/.test(app + main + sourceApp));
check('Kumo supplies compiled component styles', css.includes('@cloudflare/kumo/styles/standalone'));
check('product styles use semantic color tokens', !/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|dark:/.test(css));
check('production default tenant is blank', html.includes('name="gitfoundry-default-tenant" content=""') && !/fixture-tenant/.test(app + main));
check('no token entry or browser credential storage', !/Bearer|localStorage|sessionStorage/.test(app + main));
check('reduced motion', css.includes('prefers-reduced-motion'));
check('same origin route contract', ROUTES['repo.create'].path('tenant / A') === '/api/v1/tenants/tenant%20%2F%20A/repositories');
assert.deepEqual(normalizeList({ items: [{ id: 'one' }] }), [{ id: 'one' }]);
assert.deepEqual(normalizeList({ repositories: [{ id: 'two' }] }), [{ id: 'two' }]);
assert.deepEqual(normalizeList(null), []);

const originalFetch = globalThis.fetch;
try {
  let captured;
  globalThis.fetch = async (url, init) => { captured = { url, init }; return Response.json({ id: 'saved' }); };
  const saved = await requestJson('issue.create', 'POST', '/api/v1/tenants/test/issues', { title: 'Example' }, { 'Idempotency-Key': 'test-key' });
  assert.equal(saved.ok, true);
  assert.equal(captured.init.credentials, 'include');
  assert.equal(captured.init.headers['Idempotency-Key'], 'test-key');
  assert.deepEqual(JSON.parse(captured.init.body), { title: 'Example' });
  globalThis.fetch = async () => Response.json({ error: 'gfy_permission_denied', ok: false }, { status: 403 });
  const rejected = await requestJson('repo.list', 'GET', '/api/v1/tenants/test/repositories');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.status, 403);
  checks.push('API success, denial, and credentialed mutation payloads');
} finally { globalThis.fetch = originalFetch; }

const server = await createServer({ root: new URL('..', import.meta.url).pathname, server: { middlewareMode: true }, appType: 'custom' });
const originalDocument = globalThis.document;
try {
  globalThis.document = { querySelector: () => null };
  const { default: App } = await server.ssrLoadModule('/src/App.jsx');
  const signedOut = renderToStaticMarkup(React.createElement(App));
  check('signed-out visitors see GitFoundry sign-in', signedOut.includes('Sign in to GitFoundry') && signedOut.includes('Work email') && signedOut.includes('Email me a code') && !signedOut.includes('data-ui-system="kumo"'));
  globalThis.document = { querySelector: selector => selector === 'meta[name="gitfoundry-default-tenant"]' ? { content: 'test' } : null };
  const rendered = renderToStaticMarkup(React.createElement(App));
  check('rendered Kumo app shell', rendered.includes('data-ui-system="kumo"'));
  check('rendered keyboard skip target', rendered.includes('href="#workspace"') && rendered.includes('id="workspace"'));
  check('rendered initial state', rendered.includes('Workspace: test') && rendered.includes('Open command palette') && !rendered.includes('Sign in to GitFoundry'));
  check('five rendered workspace sections', ['Repositories', 'Issues', 'Forge', 'Reviews', 'Checks'].every(name => rendered.includes(name)) && !rendered.includes('Pull requests'));
  check('initial controls have accessible labels', rendered.includes('Open command palette') && rendered.includes('Toggle workspace navigation'));
} finally {
  globalThis.document = originalDocument;
  await server.close();
}
console.log(JSON.stringify({ ok: true, checks: checks.length }));
