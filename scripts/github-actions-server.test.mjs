import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

function rsaPem() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
}

function randomPort() {
  return 36000 + Math.floor(Math.random() * 20000);
}

function waitLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index >= 0) resolve(JSON.parse(buffer.slice(0, index)));
    });
    child.on('exit', code => reject(new Error(`child exited before ready: ${code}`)));
  });
}

function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.race([waitExit(child), new Promise(resolve => setTimeout(resolve, 2000))]);
}

async function waitHealth(port, expectReady = true, { timeoutMs = 5000, child, output } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__gitfoundry/health`);
      last = await response.json();
      if ((response.status === 200) === expectReady) return { response, body: last };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`health did not reach expected state: ${JSON.stringify(last)}; child exit=${child?.exitCode ?? 'pending'} signal=${child?.signalCode ?? 'none'}; output=${output?.() ?? ''}`);
}

async function startFixture(t, dir, generation = 'test-generation', extraEnv = {}) {
  const child = spawn(process.execPath, ['scripts/github-actions-server-storage-fixture.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: '0', GFY_ACTIONS_STORAGE_TOKEN: 'fixture-token', GFY_ACTIONS_GENERATION: generation, GFY_ACTIONS_FIXTURE_SNAPSHOT: join(dir, 'snapshot.db'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));
  const ready = await waitLine(child);
  return { child, url: `http://127.0.0.1:${ready.port}/`, snapshotPath: ready.snapshotPath, generation };
}

async function startWrapperProcess(t, dir, fixture, backendScript, extra = {}) {
  const port = 33000 + Math.floor(Math.random() * 10000);
  const state = join(dir, 'state-' + port);
  await mkdir(state, { recursive: true });
  const env = {
    ...process.env,
    PORT: String(port),
    GFY_ACTIONS_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    RUNNER_TOKEN: 'runner-token',
    GFY_ACTIONS_STORAGE_URL: fixture.url,
    GFY_ACTIONS_STORAGE_TOKEN: 'fixture-token',
    GFY_ACTIONS_GENERATION: fixture.generation,
    GFY_ACTIONS_STATE_ROOT: state,
    GFY_ACTIONS_SQLITE_PATH: join(state, 'Agents.db'),
    GFY_RUNNER_SERVER_COMMAND: process.execPath,
    GFY_RUNNER_SERVER_ARGS: JSON.stringify([backendScript]),
    GFY_ACTIONS_BACKEND_PORT: extra.backendPort || '5000',
    ...extra.env,
  };
  if (!extra.omitRsa) env.GFY_ACTIONS_RSA_PRIVATE_KEY = rsaPem();
  const child = spawn(process.execPath, ['images/github-actions-server/entrypoint.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const retainOutput = chunk => { output = (output + chunk.toString('utf8')).slice(-4000); };
  child.stdout.on('data', retainOutput);
  child.stderr.on('data', retainOutput);
  t.after(() => stopChild(child));
  return { child, port, state, output: () => output };
}

async function startWrapper(t, dir, fixture, backendScript, extra = {}) {
  const wrapper = await startWrapperProcess(t, dir, fixture, backendScript, extra);
  const health = await waitHealth(wrapper.port, true, { timeoutMs: 30000, child: wrapper.child, output: wrapper.output });
  return { ...wrapper, health };
}

async function writeBackend(dir, port, options = {}) {
  const script = join(dir, `backend-${port}.mjs`);
  await writeFile(script, `
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const sqlite = process.env.GFY_ACTIONS_SQLITE_PATH;
let db = null;
if (${options.createDb === false ? 'false' : 'true'}) {
  db = new DatabaseSync(sqlite);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL)');
  db.prepare('INSERT INTO events(path) VALUES (?)').run('boot');
}
http.createServer(async (req, res) => {
  if (req.url === '/runner/server') { res.writeHead(200); return res.end('runner server'); }
  if (${options.streamEvent === true ? 'true' : 'false'} && req.url === '/runner/server/_apis/v1/Message') {
    if (db) db.prepare('INSERT INTO events(path) VALUES (?)').run(req.method + ' ' + req.url + ' start');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\\n\\n');
    setTimeout(() => {
      if (db) db.prepare('INSERT INTO events(path) VALUES (?)').run(req.method + ' ' + req.url + ' end');
      res.end('data: done\\n\\n');
    }, 1500);
    return;
  }
  if (db) db.prepare('INSERT INTO events(path) VALUES (?)').run(req.method + ' ' + req.url);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, url: req.url }));
}).listen(${port}, '127.0.0.1');
`);
  return script;
}

function readEvents(snapshotPath) {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    return db.prepare('SELECT path FROM events ORDER BY id').all().map(row => row.path);
  } finally {
    db.close();
  }
}

function createSnapshot(path) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL)');
  db.prepare('INSERT INTO events(path) VALUES (?)').run('seed');
  db.close();
}

test('actions server wrapper restores sqlite, proxies only after ready, and commits before responding', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-actions-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await startFixture(t, dir);
  const backendPort = randomPort();
  const backend = await writeBackend(dir, backendPort);
  const wrapper = await startWrapper(t, dir, fixture, backend, { backendPort: String(backendPort) });

  const first = await fetch(`http://127.0.0.1:${wrapper.port}/runner/server/_apis/v1/Message`, { method: 'POST', body: '{}' });
  assert.equal(first.status, 200);
  const second = await fetch(`http://127.0.0.1:${wrapper.port}/runner/server/_apis/v1/AgentSession`, { method: 'POST', body: '{}' });
  assert.equal(second.status, 200);
  const events = readEvents(fixture.snapshotPath);
  assert.ok(events.includes('POST /runner/server/_apis/v1/Message'));
  assert.ok(events.includes('POST /runner/server/_apis/v1/AgentSession'));
  const health = await waitHealth(wrapper.port);
  assert.equal(health.body.ready, true);
  assert.equal(health.body.generation, fixture.generation);
  assert.equal(health.body.lastBackup.status, 'committed');
  assert.match(health.body.pointer_version, /^[0-9a-f-]{36}$/);
});

test('actions server wrapper streams event responses before backup completes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-actions-server-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await startFixture(t, dir, 'stream-generation');
  const backendPort = randomPort();
  const backend = await writeBackend(dir, backendPort, { streamEvent: true });
  const wrapper = await startWrapper(t, dir, fixture, backend, { backendPort: String(backendPort) });

  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${wrapper.port}/runner/server/_apis/v1/Message`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 900, 'event stream response headers were buffered');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
  let tail = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    tail += new TextDecoder().decode(next.value);
  }
  assert.match(tail, /data: done/);
  assert.ok(readEvents(fixture.snapshotPath).includes('POST /runner/server/_apis/v1/Message end'));
  const health = await waitHealth(wrapper.port);
  assert.equal(health.body.lastBackup.status, 'committed');
});

test('actions server wrapper fails closed when storage acknowledgements fail', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-actions-server-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await startFixture(t, dir, 'fail-generation');
  const backendPort = randomPort();
  const backend = await writeBackend(dir, backendPort);
  const wrapper = await startWrapper(t, dir, fixture, backend, { backendPort: String(backendPort) });

  const failureToggle = new URL('/fixture/fail-writes', fixture.url);
  failureToggle.searchParams.set('generation', fixture.generation);
  await fetch(failureToggle, { method: 'POST', headers: { authorization: 'Bearer fixture-token' }, body: JSON.stringify({ fail: true }) });
  const response = await fetch(`http://127.0.0.1:${wrapper.port}/runner/server/_apis/v1/Message`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
});

test('actions server wrapper fails closed when storage omits backup checksum acknowledgement', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-actions-server-omit-ack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await startFixture(t, dir, 'omit-ack-generation');
  const backendPort = randomPort();
  const backend = await writeBackend(dir, backendPort);
  const wrapper = await startWrapper(t, dir, fixture, backend, { backendPort: String(backendPort) });

  const failureToggle = new URL('/fixture/fail-writes', fixture.url);
  failureToggle.searchParams.set('generation', fixture.generation);
  await fetch(failureToggle, { method: 'POST', headers: { authorization: 'Bearer fixture-token' }, body: JSON.stringify({ omitAckSha: true }) });
  const response = await fetch(`http://127.0.0.1:${wrapper.port}/runner/server/_apis/v1/Message`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
});

test('actions server wrapper fails closed when a mutating response has no sqlite database', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-actions-server-missing-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await startFixture(t, dir, 'missing-db-generation');
  const backendPort = randomPort();
  const backend = await writeBackend(dir, backendPort, { createDb: false });
  const wrapper = await startWrapper(t, dir, fixture, backend, { backendPort: String(backendPort) });

  const response = await fetch(`http://127.0.0.1:${wrapper.port}/runner/server/_apis/v1/Message`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
});

test('actions server wrapper rejects corrupt restore snapshots', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-actions-server-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshotPath = join(dir, 'snapshot.db');
  createSnapshot(snapshotPath);
  const fixture = await startFixture(t, dir, 'corrupt-generation', { GFY_ACTIONS_FIXTURE_CORRUPT_LATEST_SHA: '1' });
  const backendPort = randomPort();
  const backend = await writeBackend(dir, backendPort);
  const wrapper = await startWrapperProcess(t, dir, fixture, backend, { backendPort: String(backendPort) });

  const exit = await waitExit(wrapper.child);
  assert.equal(exit.code, 1);
});

test('actions server wrapper requires a persistent RSA private key', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-actions-server-rsa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = await startFixture(t, dir, 'rsa-generation');
  const backendPort = randomPort();
  const backend = await writeBackend(dir, backendPort);
  const wrapper = await startWrapperProcess(t, dir, fixture, backend, { backendPort: String(backendPort), omitRsa: true });

  const exit = await waitExit(wrapper.child);
  assert.equal(exit.code, 1);
});

test('actions server wrapper runtime is owned by Effect services and scoped resources', async () => {
  const entrypoint = await readFile(new URL('../images/github-actions-server/entrypoint.mjs', import.meta.url), 'utf8');
  assert.match(entrypoint, /from 'effect'/);
  assert.match(entrypoint, /Context\.Service\('gitfoundry\/actions\/RuntimeConfig'\)/);
  assert.match(entrypoint, /Layer\.succeedContext/);
  assert.match(entrypoint, /Effect\.acquireRelease/);
  assert.match(entrypoint, /Effect\.scoped/);
  assert.match(entrypoint, /Semaphore\.makeUnsafe\(1\)/);
  assert.match(entrypoint, /backupSemaphore\.withPermit/);
  assert.doesNotMatch(entrypoint, /Effect\.runPromise\(backup/);
  assert.doesNotMatch(entrypoint, /backupQueue/);
});

test('official runner.server image records pinned upstream provenance', async () => {
  const dockerfile = await readFile(new URL('../images/github-actions-server/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /ChristopherHX\/runner\.server/);
  assert.match(dockerfile, /992ccbbbf9afcde477c38c316e053b1af457ad40/);
  assert.match(dockerfile, /mcr\.microsoft\.com\/dotnet\/aspnet:8\.0-bookworm-slim@sha256:/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends ca-certificates curl nodejs npm python3 sqlite3/);
  assert.match(dockerfile, /npm install --prefix \/opt\/gitfoundry --omit=dev effect@4\.0\.2/);
  assert.match(dockerfile, /org\.opencontainers\.image\.licenses="MIT"/);
});
