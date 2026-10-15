import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeLocalForgeRunner, materializeCodeTree, runCommand } from './local-forge-runner.mjs';

test('runner finishes when the tracked process exits despite inherited descendant pipes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'gfy-drain-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const program = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',\"setTimeout(()=>console.log('late descendant'),1500)\"],{stdio:['ignore','inherit','inherit']}).unref(); console.log('tracked process exited');";
  const result = await runCommand({ command: [process.execPath, '-e', program], cwd: home, home, timeoutMs: 3000, runState: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.toString().trim(), 'tracked process exited');
});

test('source imports exclude cache symlinks while preserving source symlinks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gfy-source-'));
  const cache = await mkdtemp(join(tmpdir(), 'gfy-cache-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });
  await writeFile(join(root, 'README.md'), 'source\n');
  await writeFile(join(root, 'tsconfig.tsbuildinfo'), 'stale compiler output');
  await symlink(cache, join(root, 'target'));
  await symlink(cache, join(root, 'node_modules'));
  await symlink(cache, join(root, 'credentials'));
  await symlink('README.md', join(root, 'alias.md'));
  let imported;
  const forge = {
    list: async () => [],
    initialize: async (input) => {
      imported = input.initial_code;
      return { version_commit: 'a'.repeat(40), descriptor: { code_commit: 'b'.repeat(40), state_commit: 'c'.repeat(40) } };
    }
  };
  const runner = makeLocalForgeRunner({ root, gitForRepository: async () => ({}), forgeForRepository: async () => forge });
  const response = await runner.handle(new Request('http://local/_local/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id: 'local', repository_id: 'gitfoundry', operation_id: 'source-cache-test', source_path: root })
  }));
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(imported.map(file => file.path).sort(), ['README.md', 'alias.md']);
  const alias = imported.find(file => file.path === 'alias.md');
  assert.equal(alias.mode, '120000');
  assert.equal(Buffer.from(alias.content_base64, 'base64').toString(), 'README.md');
});

test('run status reads the exact retained operation without scanning every forge version', async () => {
  const version = { version_commit: 'e'.repeat(40), descriptor: { code_commit: 'b'.repeat(40), state_commit: 'c'.repeat(40) } };
  const record = { run_id: 'indexed-status', operation_id: 'indexed-status', status: 'finished', version_commit: 'a'.repeat(40), code_commit: 'b'.repeat(40), exit_code: 0, command: ['true'], created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:01.000Z' };
  const lookedUp = [];
  const forge = {
    list: async () => { throw new Error('must not scan historical forks'); },
    operationVersion: async (operationId) => { lookedUp.push(operationId); return operationId === 'indexed-status.finished' ? version : null; },
    read: async (input) => {
      assert.equal(input.version, 'e'.repeat(40));
      assert.equal(input.path, 'local/runs/indexed-status/run.json');
      return { status: 'file', version, content_base64: Buffer.from(JSON.stringify(record)).toString('base64') };
    }
  };
  const runner = makeLocalForgeRunner({ root: process.cwd(), gitForRepository: async () => ({}), forgeForRepository: async () => forge });
  const response = await runner.handle(new Request('http://local/_local/runs/indexed-status'));
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.status, 'finished');
  assert.equal(body.exit_code, 0);
  assert.equal(body.state_version_commit, 'e'.repeat(40));
  assert.deepEqual(lookedUp, ['indexed-status.finished']);
});
test('a failed terminal record write preserves the pending run and does not reject in the background', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gfy-finalize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = { version_commit: 'e'.repeat(40), descriptor: { code_commit: 'b'.repeat(40), state_commit: 'c'.repeat(40) } };
  let record;
  let attempted;
  const finalization = new Promise(resolve => { attempted = resolve; });
  const forge = {
    operationVersion: async operationId => operationId === 'failed-finalize.pending' && record ? version : null,
    read: async input => typeof input === 'string' ? version : { status: 'file', version, content_base64: Buffer.from(JSON.stringify(record)).toString('base64') },
    commit: async input => {
      if (input.operation_id === 'failed-finalize.pending') {
        record = JSON.parse(Buffer.from(input.changes[0].content_base64, 'base64').toString());
        return version;
      }
      attempted();
      throw new Error('ENOSPC: terminal record storage unavailable');
    }
  };
  const runner = makeLocalForgeRunner({
    root, dataRoot: join(root, 'data'),
    forgeForRepository: async () => forge,
    gitForRepository: async () => ({ listTree: async () => { throw new Error('workspace unavailable'); } })
  });
  const created = await runner.handle(new Request('http://local/_local/runs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation_id: 'failed-finalize', version_commit: 'a'.repeat(40), command: ['true'] })
  }));
  assert.equal(created.status, 202);
  await finalization;
  await new Promise(resolve => setImmediate(resolve));
  const status = await runner.handle(new Request('http://local/_local/runs/failed-finalize'));
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.status, 'interrupted');
  assert.equal(body.active, false);
  assert.notEqual(body.exit_code, 0);
  assert.equal(record.status, 'pending');
});



test('materialization exposes the requested commit rather than the source repository head', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gfy-revision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), work = join(root, 'work');
  await mkdir(source);
  await mkdir(work);
  const git = args => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git(['init', '--quiet', '--initial-branch=main', source]);
  await writeFile(join(source, 'README.md'), 'requested source\\n');
  git(['-C', source, 'add', 'README.md']);
  git(['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'requested']);
  const requested = git(['-C', source, 'rev-parse', 'HEAD']);
  const oid = git(['-C', source, 'rev-parse', requested + ':README.md']);
  await writeFile(join(source, 'README.md'), 'newer source\\n');
  git(['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-am', 'newer']);
  const newer = git(['-C', source, 'rev-parse', 'HEAD']);
  await materializeCodeTree({
    workDir: work, gitDir: join(source, '.git'), codeCommit: requested,
    git: { listTree: async () => [{ path: 'README.md', type: 'blob', mode: '100644', oid, size: Buffer.byteLength('requested source\\n') }] },
  });
  assert.notEqual(requested, newer);
  assert.equal(git(['-C', work, 'rev-parse', 'HEAD^{commit}']), requested);
  assert.equal(await readFile(join(work, 'README.md'), 'utf8'), 'requested source\\n');
  assert.equal(git(['-C', work, 'status', '--porcelain']), '');
  assert.equal(git(['-C', source, 'rev-parse', 'HEAD']), newer);
});

test('run homes are Docker-visible and support Unix socket paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gfy-home-placement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data');
  const version = { version_commit: 'e'.repeat(40), descriptor: { code_commit: 'b'.repeat(40), state_commit: 'c'.repeat(40) } };
  let finished;
  const completion = new Promise(resolve => { finished = resolve; });
  const forge = {
    operationVersion: async () => null,
    read: async () => version,
    commit: async input => {
      if (input.operation_id === 'home-placement.finished') finished(input.changes);
      return version;
    },
  };
  const runner = makeLocalForgeRunner({ root, dataRoot, forgeForRepository: async () => forge,
    gitForRepository: async () => ({ listTree: async () => [] }) });
  const response = await runner.handle(new Request('http://local/_local/runs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation_id: 'home-placement', version_commit: 'a'.repeat(40),
      command: [process.execPath, '-e', "const fs=require('node:fs'),net=require('node:net'),path=require('node:path'); const d=path.join(process.env.TMPDIR,'mbx-session-XXXXXX'); fs.mkdirSync(d); const s=net.createServer(); s.listen(path.join(d,'cache-agent.sock'),()=>s.close(()=>console.log(JSON.stringify({home:process.env.HOME,temp:process.env.TMPDIR}))));"] }),
  }));
  assert.equal(response.status, 202, await response.text());
  const changes = await completion;
  const record = JSON.parse(Buffer.from(changes[0].content_base64, 'base64'));
  assert.equal(record.exit_code, 0);
  const environment = JSON.parse(Buffer.from(changes[1].content_base64, 'base64'));
  assert.equal(environment.temp, environment.home);
  const expectedRoot = process.env.GFY_LOCAL_TEMP_ROOT || (process.platform === 'darwin' ? join(homedir(), '.cache', 'gfy') : join(dataRoot, 'temporary-homes'));
  assert.ok(environment.home.startsWith(expectedRoot + '/'), environment.home);
  t.after(() => rm(environment.home, { recursive: true, force: true }));
});
