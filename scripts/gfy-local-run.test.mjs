import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./gfy-local.mjs', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gfy-local-run-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, 'advance-clock.cjs');
  await writeFile(preload, `const now = Date.now;
let elapsed = 0;
Date.now = () => now() + elapsed;
const timer = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) => timer(() => {
  if (milliseconds === 1) elapsed += 700000;
  callback(...args);
}, milliseconds);
`);
  let polls = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && pathname === '/_local/runs') {
      response.end(JSON.stringify({ status: 'running', run_id: 'long-suite' }));
    } else if (request.method === 'GET' && pathname === '/_local/runs/long-suite') {
      polls++;
      response.end(JSON.stringify(polls === 1
        ? { status: 'running', run_id: 'long-suite' }
        : { status: 'finished', run_id: 'long-suite', exit_code: 0 }));
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  async function run(options = []) {
    const child = spawn(process.execPath, ['--require', preload, cli, 'local', 'run',
      '--url', url, '--version-commit', 'a'.repeat(40), '--operation-id', 'clock-test',
      '--poll-interval-ms', '1', '--argv-json', '["node","suite.mjs"]', ...options],
      { env: { ...process.env, GFY_ACCESS_JWT_FILE: '', GFY_ACCESS_JWT: '' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, stderr };
  }
  return { run, polls: () => polls };
}
test('local run waits through more than ten minutes by default until terminal status', async (t) => {
  const { run, polls } = await fixture(t);
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'finished');
  assert.equal(polls(), 2);
});
test('local run preserves an explicit positive timeout deadline', async (t) => {
  const { run, polls } = await fixture(t);
  const result = await run(['--timeout-ms', '600000']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /local run timed out while waiting for long-suite/);
  assert.equal(polls(), 1);
});
test('local run no-wait returns the initial receipt without polling', async (t) => {
  const { run, polls } = await fixture(t);
  const result = await run(['--no-wait']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'running');
  assert.equal(polls(), 0);
});

async function endpointFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gfy-local-endpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'finished', run_id: 'configured-instance', exit_code: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  async function run(entry, options, env) {
    const child = spawn(process.execPath, [entry, 'local', 'status', 'configured-instance', ...options], {
      env: { ...process.env, GFY_URL: '', GFY_API_BASE_URL: '', GFY_ACCESS_JWT_FILE: '', GFY_ACCESS_JWT: '', ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, stderr };
  }
  return { directory, url, requests, run };
}

test('local CLI honors the same API base URL as forge commands', async t => {
  const f = await endpointFixture(t);
  const result = await f.run(cli, [], { GFY_API_BASE_URL: f.url });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).run_id, 'configured-instance');
  assert.equal(f.requests.length, 1);
});

test('gfy local status uses the selected instance locator and its credential', async t => {
  const f = await endpointFixture(t);
  const tokenFile = join(f.directory, 'owner.jwt');
  const locatorFile = join(f.directory, 'instance.json');
  await writeFile(tokenFile, 'fixture-owner-token', { mode: 0o600 });
  await writeFile(locatorFile, JSON.stringify({ url: f.url, tenant: 'local', owner_token_file: tokenFile }));
  const wrapper = fileURLToPath(new URL('../gfy', import.meta.url));
  const result = await f.run(wrapper, [], { GFY_LOCAL_INSTANCE_FILE: locatorFile });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, 'Bearer fixture-owner-token');
});

for (const target of [
  { name: '--url', options: url => ['--url', url], environment: () => ({}) },
  { name: '--url=value', options: url => ['--url=' + url], environment: () => ({}) },
  { name: 'GFY_URL', options: () => [], environment: url => ({ GFY_URL: url }) },
]) {
  test('explicit local target ' + target.name + ' does not inherit another instance credential', async t => {
    const f = await endpointFixture(t);
    const tokenFile = join(f.directory, 'other-owner.jwt');
    const locatorFile = join(f.directory, 'other-instance.json');
    await writeFile(tokenFile, 'other-instance-owner-token', { mode: 0o600 });
    await writeFile(locatorFile, JSON.stringify({ url: 'http://127.0.0.1:1', tenant: 'other', owner_token_file: tokenFile }));
    const wrapper = fileURLToPath(new URL('../gfy', import.meta.url));
    const result = await f.run(wrapper, target.options(f.url), {
      GFY_LOCAL_INSTANCE_FILE: locatorFile,
      ...target.environment(f.url),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].authorization, undefined);
  });
}

test('local flags after -- do not override the selected instance locator', async t => {
  const f = await endpointFixture(t);
  const tokenFile = join(f.directory, 'owner.jwt');
  const locatorFile = join(f.directory, 'instance.json');
  await writeFile(tokenFile, 'fixture-owner-token', { mode: 0o600 });
  await writeFile(locatorFile, JSON.stringify({ url: f.url, tenant: 'local', owner_token_file: tokenFile }));
  const wrapper = fileURLToPath(new URL('../gfy', import.meta.url));
  const result = await f.run(wrapper, ['--', '--url', 'http://127.0.0.1:1'], { GFY_LOCAL_INSTANCE_FILE: locatorFile });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, 'Bearer fixture-owner-token');
});

test('explicit local target preserves an explicitly selected credential', async t => {
  const f = await endpointFixture(t);
  const tokenFile = join(f.directory, 'explicit-owner.jwt');
  const locatorFile = join(f.directory, 'unavailable-instance.json');
  await writeFile(tokenFile, 'explicit-owner-token', { mode: 0o600 });
  await writeFile(locatorFile, JSON.stringify({ url: 'http://127.0.0.1:1', tenant: 'other', owner_token_file: join(f.directory, 'missing.jwt') }));
  const wrapper = fileURLToPath(new URL('../gfy', import.meta.url));
  const result = await f.run(wrapper, ['--url', f.url], { GFY_LOCAL_INSTANCE_FILE: locatorFile, GFY_ACCESS_JWT_FILE: tokenFile });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, 'Bearer explicit-owner-token');
});

test('explicit local URL overrides configured endpoints', async t => {
  const f = await endpointFixture(t);
  const result = await f.run(cli, ['--url', f.url], { GFY_API_BASE_URL: 'http://127.0.0.1:1', GFY_URL: 'http://127.0.0.1:2' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.requests.length, 1);
});

test('local deploy reaches its help and validates publication inputs', async () => {
  const wrapper = fileURLToPath(new URL('../gfy', import.meta.url));
  for (const options of [['--help'], []]) {
    const child = spawn(process.execPath, [wrapper, 'local', 'deploy', ...options], {
      env: { ...process.env, GFY_LOCAL_INSTANCE_FILE: '/unavailable-deploy-fixture', GFY_API_BASE_URL: '', GFY_ACCESS_JWT_FILE: '', GFY_ACCESS_JWT: '' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (options.length) {
      assert.equal(code, 0, stderr);
      assert.match(stdout, /gfy local deploy --version-commit SHA --expected-head SHA/);
    } else {
      assert.equal(code, 1);
      assert.match(stderr, /local deploy requires --expected-head/);
    }
  }
});
