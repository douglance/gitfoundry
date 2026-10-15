import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureLocalToolchainEnvironment } from './local-toolchain-env.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gfy-toolchain-env-'));
  await mkdir(join(root, '.rustup'));
  await mkdir(join(root, '.cargo'));
  const meta = join(root, '.docker', 'contexts', 'meta', 'selected');
  await mkdir(meta, { recursive: true });
  await writeFile(join(root, '.docker', 'config.json'), JSON.stringify({ currentContext: 'local-engine', auths: { registry: { auth: 'private-canary' } } }));
  await writeFile(join(meta, 'meta.json'), JSON.stringify({ Name: 'local-engine', Endpoints: { docker: { Host: 'unix:///tmp/selected-gfy-engine.sock' } } }));
  return root;
}

test('local startup discovers caches and the selected Docker endpoint without copying credentials', async () => {
  const root = await fixture();
  try {
    const env = await configureLocalToolchainEnvironment({}, root);
    assert.deepEqual(env, { RUSTUP_HOME: join(root, '.rustup'), CARGO_HOME: join(root, '.cargo'), DOCKER_HOST: 'unix:///tmp/selected-gfy-engine.sock' });
    assert.equal(JSON.stringify(env).includes('private-canary'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit toolchain paths and Docker endpoint take precedence', async () => {
  const root = await fixture();
  try {
    const original = { RUSTUP_HOME: '/explicit/rustup', CARGO_HOME: '/explicit/cargo', DOCKER_HOST: 'unix:///explicit/docker.sock' };
    assert.deepEqual(await configureLocalToolchainEnvironment({ ...original }, root), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an explicitly selected local context is normalized for an isolated runner home', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, '.docker', 'config.json'), JSON.stringify({ currentContext: 'unselected' }));
    const env = await configureLocalToolchainEnvironment({ DOCKER_CONTEXT: 'local-engine' }, root);
    assert.equal(env.DOCKER_HOST, 'unix:///tmp/selected-gfy-engine.sock');
    assert.equal(Object.hasOwn(env, 'DOCKER_CONTEXT'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing host configuration does not invent cache paths or a Docker endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gfy-empty-env-'));
  try { assert.deepEqual(await configureLocalToolchainEnvironment({}, root), {}); }
  finally { await rm(root, { recursive: true, force: true }); }
});
