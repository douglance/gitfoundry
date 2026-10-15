import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const fixture = await mkdtemp(join(tmpdir(), 'gitfoundry-rpc-http-'));
const sockets = new Set();
const events = [];
let server;
let synchronizeConditionalPushes = false;
let synchronizedPushCount = 0;
const pendingConditionalPushes = [];
const image = process.env.GFY_FORGE_RPC_TEST_IMAGE || 'gitfoundry-helper:fork-rpc';
const username = 'x-access-token', password = 'rpc-fixture-token', proof = 'rpc-fixture-proof-123456789';
const repositoryRoot = join(fixture, 'repositories');
const gitDir = join(repositoryRoot, 'rpc-tests', 'canonical.git');
const rpcTimeoutMs = Number(process.env.GFY_FORGE_RPC_TIMEOUT_MS || 45000);
const backendTimeoutMs = 15000;

try {
  await mkdir(join(repositoryRoot, 'rpc-tests'), { recursive: true });
  await run('git', ['init', '--bare', '--initial-branch=main', gitDir]);
  await run('git', ['--git-dir', gitDir, 'config', 'http.receivepack', 'true']);
  const certificate = join(fixture, 'certificate.pem'), key = join(fixture, 'key.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=host.docker.internal', '-addext', 'subjectAltName=DNS:host.docker.internal,IP:127.0.0.1', '-keyout', key, '-out', certificate]);
  const expectedAuthorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    response.setHeader('connection', 'close');
    events.push(request.method + ' ' + request.url);
    if (events.length > 20) events.shift();
    if (request.headers.authorization !== expectedAuthorization || request.headers['x-gitfoundry-egress-proof'] !== proof) { response.writeHead(403).end(); return; }
    const url = new URL(request.url, 'https://localhost');
    if (!url.pathname.startsWith('/git/rpc-tests/canonical.git/')) { response.writeHead(404).end(); return; }
    const startBackend = (completed = () => {}) => {
    const child = spawn('git', ['http-backend'], {
      env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: repositoryRoot, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'rpc-fixture', REQUEST_METHOD: request.method, PATH_INFO: url.pathname.slice(4), QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] || '', CONTENT_LENGTH: request.headers['content-length'] || '' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const chunks = [], errChunks = [];
    const timer = setTimeout(() => { events.push('backend-timeout ' + request.method + ' ' + request.url); child.kill('SIGKILL'); }, backendTimeoutMs);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => errChunks.push(chunk));
    child.on('error', () => { clearTimeout(timer); if (!response.headersSent) response.writeHead(500); response.end(); });
    child.on('close', code => {
      clearTimeout(timer);
      completed();
      if (response.destroyed) return;
      if (code !== 0) { events.push('backend-exit ' + code + ' ' + Buffer.concat(errChunks).toString('utf8').slice(-160)); response.writeHead(500).end(); return; }
      const data = Buffer.concat(chunks);
      let end = data.indexOf('\r\n\r\n'), separator = 4;
      if (end < 0) { end = data.indexOf('\n\n'); separator = 2; }
      if (end < 0) { events.push('backend-no-headers ' + data.toString('utf8').slice(0, 160)); response.writeHead(500).end(); return; }
      const headers = {}; let status = 200;
      for (const line of data.subarray(0, end).toString().split(/\r?\n/)) {
        const at = line.indexOf(':'); if (at < 1) continue;
        const name = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim();
        if (name === 'status') status = Number(value.slice(0, 3)); else headers[name] = value;
      }
      response.writeHead(status, headers).end(data.subarray(end + separator));
    });
    request.pipe(child.stdin);
    request.on('aborted', () => child.kill('SIGKILL'));
    child.stdin.on('error', () => {});
    };
    if (synchronizeConditionalPushes && request.method === 'POST' && url.pathname.endsWith('/git-receive-pack')) {
      pendingConditionalPushes.push(startBackend);
      if (pendingConditionalPushes.length === 2) {
        synchronizeConditionalPushes = false;
        synchronizedPushCount = pendingConditionalPushes.length;
        const [first, second] = pendingConditionalPushes.splice(0);
        first(() => second());
      }
    } else startBackend();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.setTimeout(rpcTimeoutMs + 5000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(done => server.listen(0, '0.0.0.0', done));
  const port = server.address().port;
  let rpcSerial = 0;
  async function rpc(method, args) {
    const frame = { method, args, remote: 'https://host.docker.internal:' + port + '/git/rpc-tests/canonical.git', allowed_hostname: 'host.docker.internal', username, password, proof, expires_at_ms: Date.now() + 300000 };
    const containerName = 'gfy-forge-rpc-' + process.pid + '-' + (++rpcSerial);
    const child = spawn('docker', ['run', '--rm', '--name', containerName, '--platform', 'linux/amd64', '-i', '--env', 'GFY_FORGE_RPC_DIAGNOSTICS=1', '--env', 'GFY_FORGE_RPC_CA_FILE=/fixture/ca.pem', '--mount', 'type=bind,source=' + certificate + ',target=/fixture/ca.pem,readonly', '--entrypoint', '/usr/local/bin/node', image, '/usr/local/bin/gitfoundry-forge-rpc'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    const status = await new Promise((done, reject) => {
      let settled = false;
      let timer;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        execFile('docker', ['rm', '-f', containerName], () => {});
        finish(reject, new Error('RPC ' + method + ' timed out after ' + rpcTimeoutMs + 'ms; server events: ' + events.join(' | ')));
      }, rpcTimeoutMs);
      child.on('error', error => finish(reject, error));
      child.on('close', code => finish(done, code));
      child.stdin.end(JSON.stringify(frame));
    });
    const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8');
    assert.equal(out.includes(password) || err.includes(password) || out.includes(proof) || err.includes(proof), false, 'credential leaked');
    assert.equal(status, 0, 'RPC ' + method + ' failed: ' + out.trim() + ' ' + err.slice(-300));
    const parsed = JSON.parse(out); assert.equal(parsed.ok, true);
    return parsed.result;
  }
  const author = { name: 'RPC fixture', email: 'fixture@example.invalid' }, timestamp = '2026-10-09T12:00:00.000Z';
  const initial = await rpc('writeCommit', [{ base: null, parents: [], changes: [{ path: 'message.txt', content_base64: Buffer.from('hello\n').toString('base64') }], author, timestamp, message: 'Initial code' }]);
  assert.match(initial, /^[0-9a-f]{40}$/);
  assert.equal(await rpc('compareAndSwapRef', ['refs/heads/forge-head', null, initial]), true);
  const change = text => ({ base: initial, parents: [initial], changes: [{ path: 'message.txt', content_base64: Buffer.from(text).toString('base64') }], author, timestamp, message: text });
  const left = await rpc('writeCommit', [change('left\n')]);
  const right = await rpc('writeCommit', [change('right\n')]);
  const merged = await rpc('mergeCommits', [{ base: initial, left, right, author, timestamp, message: 'Conflicting alternatives' }]);
  assert.equal(merged.status, 'conflict'); assert.deepEqual(merged.paths, ['message.txt']);
  synchronizeConditionalPushes = true;
  const results = await Promise.all([rpc('compareAndSwapRef', ['refs/heads/forge-head', initial, left]), rpc('compareAndSwapRef', ['refs/heads/forge-head', initial, right])]);
  assert.equal(synchronizedPushCount, 2, 'both conditional requests must reach the backend before either completes');
  assert.deepEqual([...results].sort(), [false, true], 'one conditional writer must win');
  const actual = await rpc('readRef', ['refs/heads/forge-head']);
  assert.equal([left, right].includes(actual), true);
  assert.equal(await rpc('compareAndSwapRef', ['refs/heads/forge-head', initial, actual]), false, 'stale up-to-date publication must not succeed');
  const resultRef = 'refs/heads/operations/publish-left/result';
  assert.equal(await rpc('compareAndSwapRefs', [[{ ref: 'refs/heads/forge-head', expected: actual, next: right }, { ref: resultRef, expected: null, next: left }]]), true, 'head and result must publish atomically');
  assert.equal(await rpc('readRef', ['refs/heads/forge-head']), right);
  assert.equal(await rpc('readRef', [resultRef]), left);
  for (const sha of [initial, left, right]) assert.equal(await rpc('readRef', ['refs/heads/retained/objects/' + sha]), sha);
  const mirror = join(fixture, 'mirror.git');
  await run('git', ['clone', '--mirror', gitDir, mirror]);
  await run('git', ['--git-dir', mirror, 'fsck', '--full']);
  assert.equal((await run('git', ['--git-dir', mirror, 'rev-parse', 'refs/heads/forge-head'])).stdout.trim(), right);
  console.log(JSON.stringify({ git_http: 'https', conditional_winners: results.filter(Boolean).length, synchronized_conditional_requests: synchronizedPushCount, stale_write_rejected: true, atomic_publish_result: true, textual_conflict: merged.paths, retained_alternatives: 3, mirror_fsck: 'passed', credentials_leaked: false }));
} catch (error) { console.error(JSON.stringify({ error: error.message, server_events: events })); process.exitCode = 1; }
finally {
  for (const socket of sockets) socket.destroy();
  if (server) await Promise.race([new Promise(done => server.close(done)), new Promise(done => setTimeout(done, 2000))]);
  await rm(fixture, { recursive: true, force: true });
}
