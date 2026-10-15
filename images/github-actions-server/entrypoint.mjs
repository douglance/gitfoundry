#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context, Effect, Layer, Semaphore } from 'effect';

const RuntimeConfig = Context.Service('gitfoundry/actions/RuntimeConfig');
const RuntimeState = Context.Service('gitfoundry/actions/RuntimeState');
const StorageClient = Context.Service('gitfoundry/actions/StorageClient');
const BackendManager = Context.Service('gitfoundry/actions/BackendManager');
const HttpServerManager = Context.Service('gitfoundry/actions/HttpServerManager');

class RuntimeFailure extends Error {
  constructor(operation, cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${operation}: ${message}`);
    this.name = 'RuntimeFailure';
    this.operation = operation;
    this.cause = cause;
    this.statusCode = cause?.statusCode || 503;
  }
}

function effectify(operation, evaluate) {
  return Effect.tryPromise({
    try: evaluate,
    catch: error => error instanceof RuntimeFailure ? error : new RuntimeFailure(operation, error),
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readConfig() {
  const stateRoot = resolve(process.env.GFY_ACTIONS_STATE_ROOT || '/var/lib/gitfoundry/actions-server');
  const sqlitePath = resolve(process.env.GFY_ACTIONS_SQLITE_PATH || join(stateRoot, 'Agents.db'));
  const config = {
    publicOrigin: requireEnv('GFY_ACTIONS_PUBLIC_ORIGIN'),
    runnerToken: requireEnv('RUNNER_TOKEN'),
    storageUrl: requireEnv('GFY_ACTIONS_STORAGE_URL'),
    storageToken: requireEnv('GFY_ACTIONS_STORAGE_TOKEN'),
    storageCfAccessClientId: process.env.GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_ID || '',
    storageCfAccessClientSecret: process.env.GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_SECRET || '',
    generation: requireEnv('GFY_ACTIONS_GENERATION'),
    stateRoot,
    sqlitePath,
    backendHost: '127.0.0.1',
    backendPort: Number.parseInt(process.env.GFY_ACTIONS_BACKEND_PORT || '5000', 10),
    listenPort: Number.parseInt(process.env.PORT || '80', 10),
    maxProxyBodyBytes: 8 * 1024 * 1024,
    maxHealthBytes: 8 * 1024,
    backendStartupMs: Number.parseInt(process.env.GFY_ACTIONS_BACKEND_STARTUP_MS || '30000', 10),
    python: process.env.GFY_ACTIONS_PYTHON || 'python3',
  };
  new URL(config.publicOrigin);
  new URL(config.storageUrl);
  return config;
}

function createRuntimeState() {
  return {
    ready: false,
    backend: null,
    backupSemaphore: Semaphore.makeUnsafe(1),
    lastBackup: null,
    lastRestore: null,
    lastFailure: null,
    pointerVersion: null,
    subscribers: new Set(),
  };
}

function storageEndpoint(config, pathname) {
  const url = new URL(pathname, config.storageUrl.endsWith('/') ? config.storageUrl : config.storageUrl + '/');
  url.searchParams.set('generation', config.generation);
  return url;
}

function storageHeaders(config, extra = {}) {
  const headers = {
    authorization: `Bearer ${config.storageToken}`,
    'x-gfy-actions-generation': config.generation,
    ...extra,
  };
  if (config.storageCfAccessClientId) headers['cf-access-client-id'] = config.storageCfAccessClientId;
  if (config.storageCfAccessClientSecret) headers['cf-access-client-secret'] = config.storageCfAccessClientSecret;
  return headers;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function pathExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function fileSha256(path) {
  return await new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function readBoundedRequest(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function publish(state, event) {
  const line = `event: ${event.type || 'message'}\ndata: ${JSON.stringify({ at: new Date().toISOString(), ...event })}\n\n`;
  for (const subscriber of state.subscribers) subscriber.write(line);
}

function setFailure(state, error) {
  state.lastFailure = error instanceof Error ? error.message : String(error);
  publish(state, { type: 'error', message: state.lastFailure });
}

function sendJson(response, statusCode, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': bytes.length });
  response.end(bytes);
}

function requireStorageGeneration(config, response, operation) {
  const actual = response.headers.get('x-gfy-actions-generation');
  if (actual !== config.generation) throw new Error(`${operation} generation mismatch`);
}

function makeStorageClient(config, state) {
  const runSqliteBackup = (sourcePath, backupPath) => effectify('sqlite backup', async () => {
    const script = [
      'import sqlite3, sys',
      'source, target = sys.argv[1], sys.argv[2]',
      'src = sqlite3.connect(source, timeout=30)',
      'dst = sqlite3.connect(target, timeout=30)',
      'src.backup(dst)',
      'dst.close()',
      'src.close()',
    ].join('\n');
    await new Promise((resolvePromise, reject) => {
      const child = spawn(config.python, ['-c', script, sourcePath, backupPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      const stderr = [];
      let stderrBytes = 0;
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes <= config.maxHealthBytes) stderr.push(chunk);
      });
      child.on('error', reject);
      child.on('exit', code => {
        if (code === 0) resolvePromise();
        else reject(new Error(`sqlite backup failed with ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
      });
    });
  });

  const backup = (reason, options = {}) => Effect.gen(function*() {
    const exists = yield* effectify('stat sqlite database', () => pathExists(config.sqlitePath));
    if (!exists) {
      if (options.allowMissing) {
        state.lastBackup = { status: 'verified-empty', generation: config.generation, reason, pointer_version: state.pointerVersion };
        publish(state, { type: 'backup', ...state.lastBackup });
        return state.lastBackup;
      }
      throw Object.assign(new Error('sqlite database missing before mutating response acknowledgement'), { statusCode: 503 });
    }
    const backupPath = config.sqlitePath + '.backup';
    yield* effectify('remove stale sqlite backup', () => unlink(backupPath).catch(() => {}));
    yield* runSqliteBackup(config.sqlitePath, backupPath);
    const bytes = yield* effectify('read sqlite backup', () => readFile(backupPath));
    yield* effectify('remove sqlite backup', () => unlink(backupPath).catch(() => {}));
    const digest = sha256(bytes);
    const headers = storageHeaders(config, { 'content-type': 'application/octet-stream', 'x-gfy-actions-sha256': digest });
    if (state.pointerVersion) headers['x-gfy-actions-pointer-version'] = state.pointerVersion;
    const response = yield* effectify('storage backup upload', () => fetch(storageEndpoint(config, 'sqlite/backups'), { method: 'POST', headers, body: bytes }));
    if (!response.ok) throw new Error(`storage backup failed with ${response.status}`);
    requireStorageGeneration(config, response, 'storage backup');
    const committed = response.headers.get('x-gfy-actions-sha256');
    if (!committed) throw new Error('storage backup acknowledgement missing checksum');
    if (committed !== digest) throw new Error('storage backup acknowledgement checksum mismatch');
    const nextPointerVersion = response.headers.get('x-gfy-actions-pointer-version');
    if (!nextPointerVersion) throw new Error('storage backup acknowledgement missing pointer version');
    state.pointerVersion = nextPointerVersion;
    state.lastBackup = { status: 'committed', generation: config.generation, sha256: digest, bytes: bytes.length, reason, pointer_version: nextPointerVersion };
    publish(state, { type: 'backup', ...state.lastBackup });
    return state.lastBackup;
  });

  return {
    restore: Effect.gen(function*() {
      yield* effectify('create sqlite directory', () => mkdir(dirname(config.sqlitePath), { recursive: true }));
      const response = yield* effectify('storage restore fetch', () => fetch(storageEndpoint(config, 'sqlite/latest'), { headers: storageHeaders(config) }));
      requireStorageGeneration(config, response, 'storage restore');
      if (response.status === 204) {
        state.pointerVersion = response.headers.get('x-gfy-actions-pointer-version') || null;
        state.lastRestore = { status: 'empty', generation: config.generation, pointer_version: state.pointerVersion };
        return state.lastRestore;
      }
      if (response.status !== 200) throw new Error(`storage restore failed with ${response.status}`);
      const bytes = Buffer.from(yield* effectify('read restore snapshot', () => response.arrayBuffer()));
      const expected = response.headers.get('x-gfy-actions-sha256');
      if (!expected) throw new Error('storage restore missing checksum');
      const pointerVersion = response.headers.get('x-gfy-actions-pointer-version');
      if (!pointerVersion) throw new Error('storage restore missing pointer version');
      const actual = sha256(bytes);
      if (expected !== actual) throw new Error('storage restore checksum mismatch');
      const temporary = config.sqlitePath + '.restore-tmp';
      yield* effectify('write restore snapshot', () => writeFile(temporary, bytes, { mode: 0o600 }));
      yield* effectify('install restore snapshot', () => rename(temporary, config.sqlitePath));
      state.pointerVersion = pointerVersion;
      state.lastRestore = { status: 'restored', generation: config.generation, sha256: actual, bytes: bytes.length, pointer_version: pointerVersion };
      return state.lastRestore;
    }),
    backup,
    enqueueBackup: (reason, options) => state.backupSemaphore.withPermit(
      backup(reason, options).pipe(
        Effect.tapError(error => Effect.sync(() => setFailure(state, error))),
      ),
    ),
  };
}

function stopChildProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolvePromise => {
    const timer = setTimeout(resolvePromise, 2000);
    child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    child.kill(signal);
  });
}

function makeBackendManager(config, state) {
  return {
    start: rsaPath => Effect.acquireRelease(
      effectify('start runner.server backend', async () => {
        const configPath = join(config.stateRoot, 'runner-server.appsettings.json');
        const appSettings = {
          'Runner.Server': {
            ServerUrl: config.publicOrigin,
            RUNNER_TOKEN: config.runnerToken,
            GitServerUrl: process.env.GFY_ACTIONS_GIT_SERVER_URL || config.publicOrigin,
            GitApiServerUrl: process.env.GFY_ACTIONS_GIT_API_URL || `${config.publicOrigin.replace(/\/$/, '')}/api/v3`,
            GitGraphQlServerUrl: process.env.GFY_ACTIONS_GIT_GRAPHQL_URL || '',
            RSASignatureKeyPath: rsaPath,
          },
          ConnectionStrings: { sqlite: `Data Source=${config.sqlitePath};` },
        };
        await writeFile(configPath, JSON.stringify(appSettings), { mode: 0o600 });
        await chmod(configPath, 0o600);
        const executable = process.env.GFY_RUNNER_SERVER_COMMAND || 'dotnet';
        const args = process.env.GFY_RUNNER_SERVER_COMMAND
          ? JSON.parse(process.env.GFY_RUNNER_SERVER_ARGS || '[]')
          : ['/opt/runner/server/Runner.Server.dll', '--urls', `http://${config.backendHost}:${config.backendPort}`];
        const env = {
          ...process.env,
          RUNNER_SERVER_APP_JSON_SETTINGS_FILE: configPath,
          RUNNER_SERVER_ConnectionStrings__sqlite: `Data Source=${config.sqlitePath};`,
        };
        const child = spawn(executable, args, { env, cwd: config.stateRoot, stdio: ['ignore', 'inherit', 'inherit'] });
        state.backend = child;
        child.on('exit', (code, signal) => {
          state.ready = false;
          state.lastFailure = `backend exited code=${code} signal=${signal}`;
          publish(state, { type: 'backend-exit', code, signal });
        });
        return child;
      }),
      child => effectify('stop runner.server backend', () => stopChildProcess(child, 'SIGTERM')),
    ),
    waitForReady: backend => {
      const deadline = Date.now() + config.backendStartupMs;
      const loop = Effect.gen(function*() {
        const reachable = yield* effectify('probe runner.server backend', async () => {
          try {
            const response = await fetch(`http://${config.backendHost}:${config.backendPort}/runner/server`, { redirect: 'manual' });
            return response.status < 500;
          } catch {
            return false;
          }
        });
        if (reachable) return;
        if (backend.exitCode !== null) throw new Error('backend exited during startup');
        if (Date.now() >= deadline) throw new Error('backend did not become reachable');
        yield* Effect.sleep(250);
        return yield* loop;
      });
      return loop;
    },
  };
}

function makeHttpServerManager(config, state) {
  return {
    listen: layer => Effect.acquireRelease(
      effectify('start public http server', async () => {
        const server = http.createServer((request, response) => {
          Effect.runPromise(handleRequest(request, response).pipe(Effect.provide(layer))).catch(error => {
            setFailure(state, error);
            console.error(`proxy failed ${request.method} ${request.url}: ${error?.stack || error}`);
            sendJson(response, error.statusCode || 503, { error: 'gitfoundry_actions_server_unavailable' });
          });
        });
        await new Promise((resolvePromise, reject) => {
          server.once('error', reject);
          server.listen(config.listenPort, '0.0.0.0', resolvePromise);
        });
        return server;
      }),
      server => effectify('stop public http server', () => new Promise(resolvePromise => server.close(() => resolvePromise()))),
    ),
  };
}

function makeRuntimeLayer(config, state) {
  const context = Context.make(RuntimeConfig, config).pipe(
    Context.add(RuntimeState, state),
    Context.add(StorageClient, makeStorageClient(config, state)),
    Context.add(BackendManager, makeBackendManager(config, state)),
    Context.add(HttpServerManager, makeHttpServerManager(config, state)),
  );
  return Layer.succeedContext(context);
}

function installStableRsa() {
  return Effect.gen(function*() {
    const config = yield* RuntimeConfig;
    const target = join(config.stateRoot, 'gitfoundry-rsa-private.pem');
    let pem = process.env.GFY_ACTIONS_RSA_PRIVATE_KEY || '';
    if (!pem && process.env.GFY_ACTIONS_RSA_PRIVATE_KEY_FILE) {
      pem = yield* effectify('read rsa private key', () => readFile(process.env.GFY_ACTIONS_RSA_PRIVATE_KEY_FILE, 'utf8'));
    }
    if (!pem) throw new Error('GFY_ACTIONS_RSA_PRIVATE_KEY or GFY_ACTIONS_RSA_PRIVATE_KEY_FILE is required');
    if (!pem.includes('PRIVATE KEY')) throw new Error('GFY_ACTIONS_RSA_PRIVATE_KEY must be a PEM private key');
    yield* effectify('write rsa private key', () => writeFile(target, pem, { mode: 0o600 }));
    yield* effectify('chmod rsa private key', () => chmod(target, 0o600));
    return target;
  });
}

function handleHealth(request, response) {
  return Effect.gen(function*() {
    const config = yield* RuntimeConfig;
    const state = yield* RuntimeState;
    if (request.url === '/__gitfoundry/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      state.subscribers.add(response);
      response.write(`event: ready\ndata: ${JSON.stringify({ ready: state.ready, generation: config.generation, lastRestore: state.lastRestore, lastBackup: state.lastBackup, lastFailure: state.lastFailure, pointer_version: state.pointerVersion })}\n\n`);
      request.on('close', () => state.subscribers.delete(response));
      return true;
    }
    if (request.url !== '/__gitfoundry/health') return false;
    const exists = yield* effectify('stat sqlite database for health', () => pathExists(config.sqlitePath));
    const sqliteSha256 = exists ? yield* effectify('hash sqlite database for health', () => fileSha256(config.sqlitePath)) : null;
    const payload = {
      ready: state.ready,
      generation: config.generation,
      backend_port: config.backendPort,
      sqlite_sha256: sqliteSha256,
      lastRestore: state.lastRestore,
      lastBackup: state.lastBackup,
      lastFailure: state.lastFailure,
      pointer_version: state.pointerVersion,
    };
    sendJson(response, state.ready ? 200 : 503, payload);
    return true;
  });
}

function proxy(request, response) {
  return Effect.gen(function*() {
    const config = yield* RuntimeConfig;
    const state = yield* RuntimeState;
    const storage = yield* StorageClient;
    if (!state.ready) return sendJson(response, 503, { error: 'backend_not_ready' });
    const body = yield* effectify('read proxy request', () => readBoundedRequest(request, config.maxProxyBodyBytes));
    const backendResponse = yield* effectify('proxy backend request', () => new Promise((resolvePromise, reject) => {
      const backendRequest = http.request({
        hostname: config.backendHost,
        port: config.backendPort,
        method: request.method,
        path: request.url,
        headers: {
          ...request.headers,
          host: request.headers.host || new URL(config.publicOrigin).host,
          'content-length': body.length,
        },
      });
      backendRequest.on('response', resolvePromise);
      backendRequest.on('error', reject);
      backendRequest.end(body);
    }));
    const headers = { ...backendResponse.headers };
    delete headers['transfer-encoding'];
    delete headers.connection;
    delete headers['keep-alive'];
    const isEventStream = String(headers['content-type'] || '').toLowerCase().includes('text/event-stream');
    if (isEventStream) {
      response.writeHead(backendResponse.statusCode || 502, backendResponse.statusMessage, headers);
      yield* effectify('stream backend response', async () => {
        for await (const chunk of backendResponse) response.write(chunk);
      });
      yield* storage.enqueueBackup(`${request.method} ${request.url}`);
      response.end();
      return;
    }
    const responseBody = yield* effectify('read backend response', async () => {
      const chunks = [];
      for await (const chunk of backendResponse) chunks.push(chunk);
      return Buffer.concat(chunks);
    });
    yield* storage.enqueueBackup(`${request.method} ${request.url}`);
    headers['content-length'] = String(responseBody.length);
    response.writeHead(backendResponse.statusCode || 502, backendResponse.statusMessage, headers);
    response.end(responseBody);
  });
}

function handleRequest(request, response) {
  return Effect.gen(function*() {
    const handled = yield* handleHealth(request, response);
    if (!handled) yield* proxy(request, response);
  });
}

function waitForShutdownSignal(state) {
  return effectify('wait for shutdown signal', () => new Promise(resolvePromise => {
    const finish = signal => {
      state.ready = false;
      resolvePromise(signal);
    };
    process.once('SIGTERM', () => finish('SIGTERM'));
    process.once('SIGINT', () => finish('SIGINT'));
  }));
}

function runRuntime(layer) {
  return Effect.gen(function*() {
    const config = yield* RuntimeConfig;
    const state = yield* RuntimeState;
    const storage = yield* StorageClient;
    const backendManager = yield* BackendManager;
    const httpServerManager = yield* HttpServerManager;
    yield* effectify('create state root', () => mkdir(config.stateRoot, { recursive: true, mode: 0o700 }));
    const rsaPath = yield* installStableRsa();
    yield* storage.restore;
    const backend = yield* backendManager.start(rsaPath);
    yield* backendManager.waitForReady(backend);
    yield* storage.enqueueBackup('startup', { allowMissing: true });
    state.ready = true;
    publish(state, { type: 'ready', generation: config.generation, pointer_version: state.pointerVersion });
    yield* httpServerManager.listen(layer);
    yield* waitForShutdownSignal(state);
  });
}

const config = readConfig();
const state = createRuntimeState();
const layer = makeRuntimeLayer(config, state);

Effect.runPromise(Effect.scoped(runRuntime(layer).pipe(Effect.provide(layer)))).catch(error => {
  setFailure(state, error);
  const clipped = String(error?.stack || error).slice(0, config.maxHealthBytes);
  console.error(clipped);
  process.exit(1);
});
