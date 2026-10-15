#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareDockerPlugin } from './local-forge-runner.mjs';

const shaPattern = /^[0-9a-f]{40}$/;
const safeIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const sourceImportRefPattern = /^refs\/heads\/source-imports\/[a-z0-9][a-z0-9._-]{0,127}$/;
const defaultConfigPath = join(homedir(), '.local/share/gitfoundry/runner-production/config.json');
const fixedCommands = new Map([
  ['all-tests', ['node', 'scripts/test-all.mjs']],
  ['deploy-production', ['node', 'scripts/gfy-cloudflare-deploy.mjs']],
]);

export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  throw new Error('unsupported JSON value for canonical signing payload');
}

export function signCanonical(privateKeyJwk, payload, encoding = 'base64url') {
  const privateKey = createPrivateKey({ key: privateKeyJwk, format: 'jwk' });
  return sign(null, Buffer.from(canonical(payload)), privateKey).toString(encoding);
}

export function validateLease(lease) {
  if (!lease || !safeIdPattern.test(lease.run_id) || !shaPattern.test(lease.code_commit) || !shaPattern.test(lease.version_commit)) throw new Error('runner received an invalid source revision');
  if (!safeIdPattern.test(String(lease.tenant_id ?? 'local')) || !safeIdPattern.test(String(lease.repository_id ?? 'gitfoundry'))) throw new Error('runner received an invalid repository scope');
  const expected = fixedCommands.get(lease.kind);
  if (!expected || canonical(lease.command?.argv) !== canonical(expected)) throw new Error('runner received an unsupported command');
  if (!Number.isInteger(lease.lease_generation) || lease.lease_generation < 1 || typeof lease.fence_token !== 'string' || lease.fence_token.length === 0 || typeof lease.lease_id !== 'string' || lease.lease_id.length === 0) throw new Error('runner received an invalid lease');
  if (!(Date.parse(lease.expires_at) > Date.now())) throw new Error('runner received an expired lease');
  if (!lease.checkout || lease.checkout.commit !== lease.code_commit || !shaPattern.test(lease.checkout.commit)) throw new Error('runner received an invalid checkout grant');
  validateGitGrant(lease.checkout, { allowRef: false });
  return expected;
}

async function requireMode0600(path, label) {
  const metadata = await stat(path);
  if ((metadata.mode & 0o777) !== 0o600) throw new Error(label + ' must be mode 0600');
  return metadata;
}

async function readSecretFile(path, label) {
  if (!path) return null;
  await requireMode0600(path, label);
  return (await readFile(path, 'utf8')).trim();
}

export async function loadConfig(path) {
  const configPath = resolve(path ?? defaultConfigPath);
  await requireMode0600(configPath, 'runner config');
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const apiUrl = raw.url ?? raw.api_url;
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'gitfoundry.dev' || url.username || url.password || url.search || url.hash) throw new Error('runner API must be https://gitfoundry.dev');
  const clientSecret = raw.client_secret ?? await readSecretFile(raw.client_secret_file, 'runner client secret file');
  const signingKeyPath = raw.signing_key_file ? resolve(raw.signing_key_file) : null;
  const signingKey = raw.signing_key ?? (signingKeyPath ? JSON.parse(await readSecretFile(signingKeyPath, 'runner signing key file')) : null);
  if (!raw.runner_id || !safeIdPattern.test(raw.runner_id) || !raw.client_id || !clientSecret || !signingKey?.d || signingKey.crv !== 'Ed25519' || !raw.work_root && !raw.state_root) throw new Error('runner configuration incomplete');
  const tenantId = raw.tenant_id ?? 'local';
  const repositoryId = raw.repository_id ?? 'gitfoundry';
  if (!safeIdPattern.test(tenantId) || !safeIdPattern.test(repositoryId)) throw new Error('runner repository scope invalid');
  return {
    ...raw,
    url: url.toString(),
    api_url: url.toString(),
    tenant_id: tenantId,
    repository_id: repositoryId,
    client_secret: clientSecret,
    signing_key: signingKey,
    signing_key_file: signingKeyPath,
    state_root: resolve(raw.work_root ?? raw.state_root),
    work_root: resolve(raw.work_root ?? raw.state_root),
    deploy_config_file: raw.deploy_config_file ? resolve(raw.deploy_config_file) : undefined,
    config_path: configPath,
  };
}

export async function request(config, path, body, options = {}) {
  const response = await (config.fetch ?? fetch)(new URL(path, config.url ?? config.api_url), {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      'CF-Access-Client-Id': config.client_id,
      'CF-Access-Client-Secret': config.client_secret,
      'x-gitfoundry-operator-client-id': config.client_id,
      'x-gitfoundry-operator-secret': config.client_secret,
    },
    body: JSON.stringify(body),
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let value = {};
  if (text.trim()) {
    try { value = JSON.parse(text); } catch { value = { message: text }; }
  }
  if (!response.ok) throw new Error('hosted runner request failed: ' + response.status + ' ' + String(value.error ?? value.message ?? 'unknown'));
  return value;
}

async function requestWithRetry(config, path, body, options = {}) {
  let last;
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await request(config, path, body, options); }
    catch (error) {
      last = error;
      if (attempt === attempts || options.retry === false) break;
      await new Promise(done => setTimeout(done, 250 * attempt));
    }
  }
  throw last;
}

function childEnv(config, deploying = false) {
  const result = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TMPDIR: '/tmp', CI: 'true', ...config.tool_env };
  if (deploying && config.deploy_env) Object.assign(result, config.deploy_env);
  return result;
}

async function command(executable, args, options = {}) {
  if (options.commandFn) return await options.commandFn(executable, args, options);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject);
    child.on('close', (code, signal) => { if (code !== 0 || signal) reject(new Error('runner adapter command failed: ' + executable)); else resolvePromise({ stdout, stderr }); });
  });
}

function validateGitGrant(grant, { allowRef }) {
  const remote = new URL(grant.remote);
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash || !grant.username || !grant.password || !(Date.parse(grant.expires_at) > Date.now())) throw new Error('invalid repository grant');
  if (allowRef && !sourceImportRefPattern.test(grant.ref ?? '')) throw new Error('invalid source import ref');
}

async function withGitGrant(config, grant, callback) {
  validateGitGrant(grant, { allowRef: Boolean(grant.ref) });
  const temp = await mkdtemp('/tmp/gfy-git-auth-');
  const file = join(temp, 'config');
  const auth = Buffer.from(grant.username + ':' + grant.password).toString('base64');
  await writeFile(file, '[http]\n\textraHeader = Authorization: Basic ' + auth + '\n[credential]\n\thelper =\n', { mode: 0o600 });
  await chmod(file, 0o600);
  const env = { ...childEnv(config), GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  try { return await callback(env); } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function importSource(config, { gitDir, commit, operationId, expectedHead, commandFn } = {}) {
  if (!shaPattern.test(commit ?? '') || !safeIdPattern.test(operationId ?? '')) throw new Error('invalid source import identity');
  if (expectedHead !== undefined && expectedHead !== null && expectedHead !== '' && !shaPattern.test(expectedHead)) throw new Error('invalid expected source head');
  const grant = await request(config, '/_runner/source/grant', { operation_id: operationId, runner_id: config.runner_id });
  const expectedRef = 'refs/heads/source-imports/' + operationId;
  if (grant.ref !== expectedRef) throw new Error('source import grant ref mismatch');
  const directory = await realpath(gitDir);
  await withGitGrant(config, grant, async env => {
    const verified = await command('git', ['--git-dir=' + directory, 'rev-parse', commit + '^{commit}'], { env, commandFn });
    if (verified.stdout.trim() !== commit) throw new Error('source commit mismatch');
    const remote = await command('git', ['--git-dir=' + directory, 'ls-remote', '--', grant.remote, grant.ref], { env, commandFn });
    const existingRef = remote.stdout.trim();
    if (existingRef) {
      if (existingRef !== commit + '\t' + grant.ref) throw new Error('source import ref conflicts with this operation');
    } else {
      await command('git', ['--git-dir=' + directory, 'push', '--porcelain', '--force-with-lease=' + grant.ref + ':', '--', grant.remote, commit + ':' + grant.ref], { env, commandFn });
    }
  });
  // Adoption writes through the forge helper container, which takes about a minute in production.
  return await requestWithRetry(config, '/_runner/source/adopt', { operation_id: operationId, runner_id: config.runner_id, code_commit: commit, expected_head: expectedHead ?? null }, { timeoutMs: 600000 });
}

async function checkout(config, lease, work) {
  const env = childEnv(config);
  await command('git', ['init', '--initial-branch=code', work], { env });
  await withGitGrant(config, lease.checkout, async gitEnv => {
    await command('git', ['-C', work, '-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--', lease.checkout.remote, lease.code_commit], { env: gitEnv });
  });
  const checked = await command('git', ['-C', work, 'rev-parse', 'FETCH_HEAD^{commit}'], { env });
  if (checked.stdout.trim() !== lease.code_commit || lease.checkout.commit !== lease.code_commit) throw new Error('checkout source mismatch');
  await command('git', ['-C', work, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', lease.code_commit], { env });
}

function fence(lease) {
  return { lease_id: lease.lease_id, lease_generation: lease.lease_generation, fence_token: lease.fence_token };
}

export function tailAppend(existing, text) {
  const bytes = Buffer.from(existing + text);
  let start = Math.max(0, bytes.length - 8192);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

export async function executeLease(config, lease, options = {}) {
  const argv = validateLease(lease);
  const directory = join(resolve(config.state_root), 'runs', lease.run_id, String(lease.lease_generation));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const work = join(directory, 'work');
  await (options.checkout ?? checkout)(config, lease, work);
  const home = await mkdtemp('/tmp/gfy-owner-run-');
  await prepareDockerPlugin(home);
  const deploying = lease.kind === 'deploy-production';
  const env = { ...childEnv(config, deploying), HOME: home, GFY_SOURCE_REVISION: lease.code_commit, GFY_ACTION_RUN_ID: lease.run_id };
  if (deploying) {
    if (!config.deploy_config_file) throw new Error('deployment config file missing');
    env.GFY_DEPLOY_CONFIG_FILE = config.deploy_config_file;
    env.GFY_RUNNER_CONFIG_FILE = config.config_path;
    env.GFY_RUNNER_FENCE = JSON.stringify(fence(lease));
    if (config.alchemy_state_dir) {
      const state = await realpath(config.alchemy_state_dir);
      await symlink(state, join(work, 'apps/api-worker/.alchemy'), 'dir');
    }
  }
  const startedAt = new Date().toISOString();
  const stdoutHash = createHash('sha256'), stderrHash = createHash('sha256');
  let stdoutTail = '', stderrTail = '', heartbeatFailure;
  const secrets = [config.client_secret, config.signing_key?.d, ...Object.values(config.deploy_env ?? {})].filter(v => typeof v === 'string' && v.length > 8);
  const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  const stdoutFile = join(directory, 'stdout.log'), stderrFile = join(directory, 'stderr.log');
  await writeFile(stdoutFile, '', { mode: 0o600 });
  await writeFile(stderrFile, '', { mode: 0o600 });
  let writes = Promise.resolve();
  let completed = false;
  try {
    const child = spawn(argv[0], argv.slice(1), { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    let expiresAt = Date.parse(lease.expires_at);
    child.stdout.on('data', part => { stdoutHash.update(part); const text = redact(part.toString()); stdoutTail = tailAppend(stdoutTail, text); writes = writes.then(() => appendFile(stdoutFile, text, { mode: 0o600 })); });
    child.stderr.on('data', part => { stderrHash.update(part); const text = redact(part.toString()); stderrTail = tailAppend(stderrTail, text); writes = writes.then(() => appendFile(stderrFile, text, { mode: 0o600 })); });
    let heartbeatInFlight = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatInFlight || completed) return;
      heartbeatInFlight = true;
      try {
        if (Date.now() > expiresAt) throw new Error('runner lease expired while command was running');
        const response = await request(config, '/_runner/runs/' + encodeURIComponent(lease.run_id) + '/heartbeat', { ...fence(lease), phase: deploying ? 'deploying' : 'running' });
        if (response?.cancel_requested === true || response?.deploy_allowed === false) throw new Error('runner lease was canceled by server');
        const renewedDeadline = Date.parse(response?.lease_expires_at);
        if (!Number.isFinite(renewedDeadline) || renewedDeadline <= Date.now()) throw new Error('runner heartbeat did not renew the lease');
        expiresAt = renewedDeadline;
      } catch (error) { heartbeatFailure = error; child.kill('SIGTERM'); }
      finally { heartbeatInFlight = false; }
    }, options.heartbeatIntervalMs ?? 30000);
    const exitCode = await new Promise((done, reject) => {
      let settled = false, drainTimer;
      const finish = code => { if (settled) return; settled = true; clearTimeout(drainTimer); done(code ?? 1); };
      child.on('error', error => { settled = true; clearTimeout(drainTimer); reject(error); });
      child.on('exit', code => { drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); }, 250); });
      child.on('close', finish);
    }).finally(() => { completed = true; clearInterval(heartbeat); });
    await writes;
    if (heartbeatFailure) throw heartbeatFailure;
    const receipt = { run_id: lease.run_id, kind: lease.kind, version_commit: lease.version_commit, code_commit: lease.code_commit, status: 'completed', conclusion: exitCode === 0 ? 'success' : 'failure', exit_code: exitCode, started_at: startedAt, finished_at: new Date().toISOString(), stdout_sha256: stdoutHash.digest('hex'), stderr_sha256: stderrHash.digest('hex'), stdout_tail: stdoutTail, stderr_tail: stderrTail };
    if (!deploying) {
      const check = { ...lease.check_evidence, outcome: exitCode === 0 ? 'passed' : 'failed' };
      receipt.publication_check = { ...check, signature: signCanonical(config.signing_key, check, 'base64') };
    } else if (exitCode === 0) {
      receipt.deployment = JSON.parse(await readFile(join(work, '.gfy-deployment.json'), 'utf8'));
    }
    const completion = { ...fence(lease), receipt, signature: signCanonical(config.signing_key, receipt, 'base64url') };
    await writeFile(join(directory, 'completion.json'), JSON.stringify(completion), { mode: 0o600 });
    return await requestWithRetry(config, '/_runner/runs/' + encodeURIComponent(lease.run_id) + '/complete', completion, { attempts: 5 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function run(config, once = false) {
  do {
    let lease;
    try {
      lease = await request(config, '/_runner/leases/next', { operation_id: 'lease-' + randomUUID(), runner_id: config.runner_id });
    } catch (error) {
      // A long-running runner outlives brief network failures; it asks again on the next poll.
      if (once) throw error;
      console.error('Runner could not ask for work: ' + error.message);
    }
    if (lease) {
      try {
        const result = await executeLease(config, lease);
        console.log(JSON.stringify({ run_id: lease.run_id, status: result?.run?.status, conclusion: result?.run?.conclusion, evidence_ref: result?.run?.evidence_ref }));
      } catch (error) {
        console.error('Runner job failed: ' + error.message);
        if (once) throw error;
      }
    } else if (once) return;
    if (!once) await new Promise(done => setTimeout(done, 5000));
  } while (!once);
}

async function main() {
  const args = process.argv.slice(2), action = args.shift(), options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--once') options.once = true;
    else {
      if (!key.startsWith('--') || !args[i + 1]) throw new Error('runner option requires a value');
      options[key.slice(2)] = args[++i];
    }
  }
  const config = await loadConfig(options.config ?? defaultConfigPath);
  if (action === 'run') return run(config, options.once);
  if (action === 'import') return console.log(JSON.stringify(await importSource(config, { gitDir: options['git-dir'], commit: options.commit, operationId: options['operation-id'], expectedHead: options['expected-head'] })));
  if (action === 'enqueue') return console.log(JSON.stringify(await request(config, '/_runner/runs', { operation_id: options['operation-id'], kind: options.kind ?? 'all-tests', version_commit: options.version, expected_head: options['expected-head'] ?? null, runner_id: config.runner_id })));
  throw new Error('usage: gfy runner run|import|enqueue --config <private-file>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
