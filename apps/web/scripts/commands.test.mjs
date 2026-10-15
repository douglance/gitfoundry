import assert from 'node:assert/strict';
import { activeCatalogVersion, buildCommandCatalog, commandCatalog, commandFields, commandPath, commandRequest, commandSearchText, getCommand as catalogGetCommand, historicalCommandCatalog, parseCommandFields } from '../../../packages/contracts/src/commands.js';
import { commandDefaults, createPaletteCommands, getCommand, groupPaletteCommands } from '../src/commands.js';
import { invokeCommand, normalizeList, OPERATIONS, ROUTES } from '../src/api.js';

assert.equal(activeCatalogVersion.current, 2);
assert.equal(activeCatalogVersion.historical, 1);
assert.equal(historicalCommandCatalog.length, 198);
assert.deepEqual(commandCatalog.map(command => command.id).sort(), [
  'auth.whoami', 'repo.create', 'repo.list', 'repo.view',
  'forge.head', 'forge.list', 'forge.view', 'forge.read', 'forge.compare',
  'forge.initialize', 'forge.fork', 'forge.commit', 'forge.merge', 'forge.publish', 'forge.recover'
].sort());
assert.equal(new Set(commandCatalog.map(command => command.id)).size, commandCatalog.length);
assert.equal(catalogGetCommand('forge.head').category, 'forge');
assert.equal(catalogGetCommand('forge.head').description, 'Read the authoritative fork descriptor currently published for a repository.');
assert.equal(catalogGetCommand('forge.head').mcp_tool, 'gfy_forge_head');
assert.equal(catalogGetCommand('forge.publish').cli, 'gfy forge publish');
assert.ok(commandSearchText(catalogGetCommand('forge.compare')).includes('gfy forge compare'));
assert.throws(() => catalogGetCommand('missing.command'), /Unknown command/);
assert.throws(() => catalogGetCommand('pr.merge'), /Unknown command/);
assert.throws(() => commandPath('forge.view', { tenant_id: 'a' }), /repository_id is required/);
assert.equal(commandPath('forge.head', { tenant_id: 'tenant / A', repository_id: 'repo?#' }), '/api/v2/tenants/tenant%20%2F%20A/repositories/repo%3F%23/forge/head');
assert.equal(getCommand('repo.view').label, 'Repo view');
assert.equal(ROUTES['repo.view'].path('tenant / A', 'repo?#'), '/api/v1/tenants/tenant%20%2F%20A/repositories/repo%3F%23');
assert.equal(ROUTES['repo.view'].method, 'GET');
assert.equal(ROUTES['forge.publish'].method, 'POST');
assert.equal(ROUTES['forge.head'].path('tenant / A', 'repo?#'), '/api/v2/tenants/tenant%20%2F%20A/repositories/repo%3F%23/forge/head');
assert.equal(OPERATIONS.forks.list, 'forge.list');
assert.equal(OPERATIONS.forks.detail, 'forge.view');
assert.deepEqual(normalizeList({ forks: [{ id: 'f1' }] }), [{ id: 'f1' }]);

assert.equal(ROUTES['issue.create'].path('tenant-a'), '/api/v1/tenants/tenant-a/issues');
assert.equal(ROUTES['check.list'].path('tenant-a'), '/api/v1/tenants/tenant-a/checks');

const sha = '1'.repeat(40);
const nextSha = '2'.repeat(40);
assert.deepEqual(commandRequest('forge.head', { tenant_id: 'tenant / A', repository_id: 'repo?#' }), {
  operationId: 'forge.head', method: 'GET', url: '/api/v2/tenants/tenant%20%2F%20A/repositories/repo%3F%23/forge/head', body: undefined, headers: {}
});
assert.deepEqual(commandRequest('forge.fork', { tenant_id: 'tenant-a', repository_id: 'repo-a', parent_version: sha, idempotency_key: 'fork-1' }), {
  operationId: 'forge.fork', method: 'POST', url: '/api/v2/tenants/tenant-a/repositories/repo-a/forge/fork', body: { parent_version: sha }, headers: { 'Idempotency-Key': 'fork-1' }
});
assert.deepEqual(commandRequest('forge.publish', { tenant_id: 'tenant-a', repository_id: 'repo-a', expected_head: sha, new_version: nextSha, operation_id: 'op-a', idempotency_key: 'pub-1' }), {
  operationId: 'forge.publish', method: 'POST', url: '/api/v2/tenants/tenant-a/repositories/repo-a/forge/publish', body: { expected_head: sha, new_version: nextSha, operation_id: 'op-a' }, headers: { 'Idempotency-Key': 'pub-1' }
});
assert.equal(commandRequest('forge.read', { tenant_id: 'tenant-a', repository_id: 'repo-a', version: sha, tree: 'state', path: 'issues/a.json' }).url,
  '/api/v2/tenants/tenant-a/repositories/repo-a/forge/files?path=issues%2Fa.json&tree=state&version=' + sha);
assert.deepEqual(commandFields('forge.fork').filter(field => field.required).map(field => field.name), ['tenant_id', 'repository_id', 'parent_version']);
assert.deepEqual(parseCommandFields('forge.commit', { tenant_id: 'a', repository_id: 'r', parent_version: sha, changes: '[{"path":"README.md","content":"hi"}]' }), {
  tenant_id: 'a', repository_id: 'r', parent_version: sha, changes: [{ path: 'README.md', content: 'hi' }]
});

assert.deepEqual(commandDefaults('repo.view', { tenant: 'a', repo: 'r', section: 'issues', record: 'issue-7' }, { version: 3 }), { tenant_id: 'a', id: 'r' });
assert.deepEqual(commandDefaults('issue.create', { tenant: 'a', repo: 'r', section: 'issues', record: '' }, {}), { tenant_id: 'a', id: '', 'input.repository_id': 'r' });
assert.deepEqual(commandDefaults('forge.head', { tenant: 'a', repo: 'r', section: 'forks', record: sha }, {}), { tenant_id: 'a', id: sha, repository_id: 'r' });
assert.deepEqual(commandDefaults('forge.view', { tenant: 'a', repo: 'r', section: 'forks', record: sha }, {}), { tenant_id: 'a', id: sha, repository_id: 'r', version_commit: sha });

let selected;
const palette = createPaletteCommands({ 'forge.list': { href: '/?section=forks' } }, id => { selected = id; });
assert.equal(palette.length, commandCatalog.length);
const groups = groupPaletteCommands(palette);
assert.equal(groups.find(group => group.category === 'forge').label, 'Forks');
assert.equal(groups.find(group => group.category === 'pr'), undefined);
assert.equal(palette.find(command => command.id === 'forge.list').href, '/?section=forks');
palette.find(command => command.id === 'forge.publish').onSelect();
assert.equal(selected, 'forge.publish');

const originalFetch = globalThis.fetch;
try {
  let captured;
  globalThis.fetch = async (url, init) => { captured = { url, init }; return Response.json({ id: 'created' }); };
  const result = await invokeCommand('forge.fork', { tenant_id: 'a', repository_id: 'r', parent_version: sha, idempotency_key: 'key-1' });
  assert.equal(result.ok, true);
  assert.equal(captured.url, '/api/v2/tenants/a/repositories/r/forge/fork');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.credentials, 'include');
  assert.equal(captured.init.headers['Idempotency-Key'], 'key-1');
  assert.deepEqual(JSON.parse(captured.init.body), { parent_version: sha });
  globalThis.fetch = async () => Response.json({ error: 'gfy_unsupported_operation', ok: false }, { status: 501 });
  const unsupported = await invokeCommand('repo.list', { tenant_id: 'a', input: {} });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.status, 501);
} finally { globalThis.fetch = originalFetch; }

const operation = { id: 'example.list', cli: 'gfy example list', mcp_tool: 'gfy_example_list' };
const tool = { 'x-operation': 'example.list', name: 'gfy_example_list', inputSchema: { properties: {} } };
assert.throws(() => buildCommandCatalog([operation], []), /Missing command tool/);
assert.throws(() => buildCommandCatalog([operation, operation], [tool]), /Duplicate command/);
assert.throws(() => buildCommandCatalog([operation], [tool, tool]), /Duplicate command tool/);
console.log(JSON.stringify({ ok: true, suite: 'shared command catalog', commands: commandCatalog.length }));
