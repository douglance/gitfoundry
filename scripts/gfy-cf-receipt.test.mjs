import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployCfRelease } from './gfy-cf-release.mjs';
const source = 'a'.repeat(40), previous = { id: '00000000-0000-0000-0000-000000000001', annotations: { 'workers/tag': 'b'.repeat(40) } }, uploaded = { id: '00000000-0000-0000-0000-000000000002', annotations: { 'workers/tag': source } };
const prepared = [{ name: 'api', role: 'api', project: '/fixture', secrets_file: '/fixture/secrets.json', previous_deployment_id: 'before' }];
function provider(after, active = 'before', deployedVersions = [{ version_id: uploaded.id, percentage: 100 }]) {
  const calls = []; let lists = 0;
  let deployment = { id: active, versions: [{ version_id: previous.id, percentage: 100 }] };
  return { calls, execute: async (_command, args) => {
    calls.push(args);
    if (args[1] === 'versions' && args[2] === 'list') return JSON.stringify(++lists === 1 ? [previous] : after);
    if (args[1] === 'versions' && args[2] === 'create') return '├  Upload\n└  Upload complete\n';
    if (args[1] === 'versions' && args[2] === 'get') return JSON.stringify({ bindings: [{ name: 'GFY_SOURCE_REVISION', text: source }] });
    if (args[1] === 'deployments' && args[2] === 'list') return JSON.stringify([deployment]);
    if (args[1] === 'deployments' && args[2] === 'create') {
      deployment = { id: 'after', versions: deployedVersions };
      return 'Deployment complete';
    }
    throw new Error('Unexpected provider command: ' + args.join(' '));
  } };
}
test('upload text is followed by one new source-tagged provider receipt', async () => {
  const p = provider([uploaded, previous]);
  assert.deepEqual(await deployCfRelease(prepared, { GFY_SOURCE_REVISION: source }, p.execute, async () => {}, () => {}), [{ name: 'api', role: 'api', version_id: uploaded.id }]);
  assert.equal(p.calls.filter(a => a[1] === 'versions' && a[2] === 'list').length, 2);
  assert.equal(p.calls.filter(a => a[1] === 'deployments' && a[2] === 'create').length, 1);
});
test('ambiguous new tagged versions never advance production traffic', async () => {
  const p = provider([uploaded, { ...uploaded, id: '00000000-0000-0000-0000-000000000003' }, previous]);
  await assert.rejects(deployCfRelease(prepared, { GFY_SOURCE_REVISION: source }, p.execute, async () => {}, () => {}), /ambiguous|receipt/i);
  assert.equal(p.calls.filter(a => a[1] === 'deployments' && a[2] === 'create').length, 0);
});
test('existing versions cannot be mistaken for the new upload', async () => {
  const p = provider([previous]);
  await assert.rejects(deployCfRelease(prepared, { GFY_SOURCE_REVISION: source }, p.execute, async () => {}, () => {}), /receipt/i);
  assert.equal(p.calls.filter(a => a[1] === 'deployments' && a[2] === 'create').length, 0);
});
test('an active deployment change still refuses traffic advancement', async () => {
  const p = provider([uploaded, previous], 'concurrent-release');
  await assert.rejects(deployCfRelease(prepared, { GFY_SOURCE_REVISION: source }, p.execute, async () => {}, () => {}), /deployment changed/);
  assert.equal(p.calls.filter(a => a[1] === 'deployments' && a[2] === 'create').length, 0);
});

test('deployment readback rejects a different version or partial traffic', async () => {
  for (const versions of [
    [{ version_id: previous.id, percentage: 100 }],
    [{ version_id: uploaded.id, percentage: 50 }],
  ]) {
    const p = provider([uploaded, previous], 'before', versions);
    await assert.rejects(
      deployCfRelease(prepared, { GFY_SOURCE_REVISION: source }, p.execute, async () => {}, () => {}),
      error => /deployment version receipt mismatch/.test(
        error instanceof AggregateError ? error.errors[0]?.message ?? '' : error.message,
      ),
    );
    assert.equal(p.calls.filter(a => a[1] === 'deployments' && a[2] === 'create').length, 1);
  }
});
