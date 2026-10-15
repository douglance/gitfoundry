#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';


const shaPattern = /^[0-9a-f]{40}$/;
const repositoryIdPattern = /^repo-[0-9a-f]{64}$/;

async function requireMode0600(path, label) {
  const metadata = await stat(path);
  if ((metadata.mode & 0o777) !== 0o600) throw new Error(label + ' must be mode 0600');
}

async function readSecret(path, label) {
  await requireMode0600(path, label);
  return (await readFile(path, 'utf8')).trim();
}

function validateRunnerPublicKey(value) {
  const key = typeof value === 'string' ? JSON.parse(value) : value;
  if (!key || typeof key !== 'object' || Array.isArray(key) || key.kty !== 'OKP' || key.crv !== 'Ed25519' || typeof key.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || 'd' in key) throw new Error('deployment runner public key must be a public Ed25519 JWK');
  return JSON.stringify(key);
}

async function loadProviderCredential(config) {
  if (config.api_token_file) return await readSecret(resolve(config.api_token_file), 'Cloudflare API token file');
  if (!config.provider_auth_file) throw new Error('deployment provider identity and credential are required');
  await requireMode0600(resolve(config.provider_auth_file), 'Wrangler provider auth file');
  const auth = JSON.parse(await readFile(resolve(config.provider_auth_file), 'utf8'));
  if (auth.type !== 'oauth' || typeof auth.token !== 'string' || auth.token.length === 0) throw new Error('Wrangler provider auth file must contain an oauth token');
  return auth.token;
}

async function refreshWranglerOAuth(config, env, executeFn) {
  if (!config.provider_auth_file) return;
  const output = await executeFn('wrangler', ['auth', 'token', '--json'], { cwd: resolve(dirname(new URL(import.meta.url).pathname), '..'), env, log: null });
  const parsed = JSON.parse(output);
  if (parsed.type !== 'oauth' || typeof parsed.token !== 'string' || parsed.token.length === 0) throw new Error('Wrangler OAuth refresh did not return an oauth token');
  await writeFile(resolve(config.provider_auth_file), JSON.stringify(parsed), { mode: 0o600 });
  config.api_token = parsed.token;
}


const actionsTextBindings = {
  GFY_ACTIONS_STORAGE_GENERATION: 'storage_generation', GFY_ACTIONS_PUBLIC_ORIGIN: 'public_origin',
  GFY_ACTIONS_OWNER_TENANT_ID: 'owner_tenant_id', GFY_ACTIONS_OWNER_REPOSITORY_ID: 'owner_repository_id',
  GFY_ACTIONS_OWNER_REPOSITORY: 'owner_repository', GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY: 'upstream_jwt_public_key',
  GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_ID: 'storage_cf_access_client_id'
};
const actionsSecretBindings = {
  GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN: 'upstream_runner_token', GFY_ACTIONS_INTERNAL_STORAGE_SECRET: 'internal_storage_secret',
  GFY_ACTIONS_RSA_PRIVATE_KEY: 'rsa_private_key', GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_SECRET: 'storage_cf_access_client_secret'
};
export async function loadActionsConfiguration(input, accountId) {
  if (input === undefined || input.enabled === false) return undefined;
  if (input.enabled !== true) throw new Error('Actions configuration requires enabled true or false');
  const actions = { ...input };
  if (!/^registry\.cloudflare\.com\//.test(actions.image ?? '') || !actions.image.startsWith('registry.cloudflare.com/' + accountId + '/') || !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(actions.image)) throw new Error('Actions requires a same-account immutable image');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(actions.sqlite_bucket ?? '')) throw new Error('Actions snapshot bucket name is required');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(actions.storage_generation ?? '')) throw new Error('Actions storage generation is required');
  let origin; try { origin = new URL(actions.public_origin); } catch { throw new Error('Actions public origin must be HTTPS'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Actions public origin must be HTTPS');
  actions.public_origin = origin.origin;
  for (const key of ['owner_tenant_id', 'owner_repository_id']) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actions[key] ?? '')) throw new Error('Actions owner scope is required');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(actions.owner_repository ?? '')) throw new Error('Actions owner repository is required');
  if (typeof actions.storage_cf_access_client_id !== 'string' || !actions.storage_cf_access_client_id) throw new Error('Actions storage Access client is required');
  for (const key of [...Object.values(actionsSecretBindings), 'upstream_jwt_public_key']) {
    if (typeof actions[key + '_file'] !== 'string' || !actions[key + '_file']) throw new Error('Actions configuration missing ' + key + '_file');
    actions[key] = await readSecret(resolve(actions[key + '_file']), 'Actions ' + key + ' file');
    if (!actions[key] || Buffer.byteLength(actions[key]) > 16384) throw new Error('Actions ' + key + ' must be nonempty and bounded');
  }
  try {
    const privateKey = createPrivateKey(actions.rsa_private_key);
    const publicKey = createPublicKey(actions.upstream_jwt_public_key);
    if (privateKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048 ||
        createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !== publicKey.export({ type: 'spki', format: 'pem' })) throw new Error();
  } catch { throw new Error('Actions requires a matching RSA key pair of at least 2048 bits'); }
  return actions;
}
export function actionsDeploymentBindings(actions) {
  if (!actions?.enabled) return { text: {}, secrets: {} };
  return {
    text: Object.fromEntries(Object.entries(actionsTextBindings).map(([binding,key]) => [binding, actions[key]])),
    secrets: Object.fromEntries(Object.entries(actionsSecretBindings).map(([binding,key]) => [binding, actions[key]]))
  };
}

export async function loadDeploymentConfig(path) {
  if (!path) throw new Error('deployment config file is required');
  const configPath = resolve(path);
  await requireMode0600(configPath, 'deployment config');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.account_id || !config.api_worker_name || !config.runner_repository_id) throw new Error('deployment provider identity and credential are required');
  if (!repositoryIdPattern.test(config.runner_repository_id)) throw new Error('deployment runner repository id must be repo-<sha256>');
  const apiToken = await loadProviderCredential(config);
  if (!apiToken) throw new Error('deployment provider credential is required');
  const runnerPublicKey = validateRunnerPublicKey(config.runner_public_key);
  const hasRunnerClient = typeof config.runner_client_id === 'string' && config.runner_client_id.length > 0;
  const hasRunnerSecretFile = typeof config.runner_client_secret_file === 'string' && config.runner_client_secret_file.length > 0;
  if (hasRunnerClient !== hasRunnerSecretFile) throw new Error('deployment runner credentials must be paired');
  const hasQualifierClient = typeof config.qualifier_client_id === 'string' && config.qualifier_client_id.length > 0;
  const hasQualifierSecretFile = typeof config.qualifier_client_secret_file === 'string' && config.qualifier_client_secret_file.length > 0;
  if (hasQualifierClient !== hasQualifierSecretFile) throw new Error('deployment qualifier credentials must be paired');
  const qualifierClientSecret = hasQualifierSecretFile ? await readSecret(resolve(config.qualifier_client_secret_file), 'qualifier client secret file') : undefined;
  if (hasQualifierSecretFile && (!qualifierClientSecret || Buffer.byteLength(qualifierClientSecret) > 4096)) throw new Error('deployment qualifier client secret must be nonempty and at most 4096 bytes');
  const runnerClientSecret = hasRunnerSecretFile ? await readSecret(resolve(config.runner_client_secret_file), 'runner client secret file') : undefined;
  if (hasRunnerSecretFile && (!runnerClientSecret || Buffer.byteLength(runnerClientSecret) > 4096)) throw new Error('deployment runner client secret must be nonempty and at most 4096 bytes');
  return {
    ...config,
    actions: await loadActionsConfiguration(config.actions, config.account_id),
    config_path: configPath,
    api_token: apiToken,
    runner_public_key: runnerPublicKey,
    ...(runnerClientSecret ? { runner_client_secret: runnerClientSecret } : {}),
    ...(qualifierClientSecret ? { qualifier_client_secret: qualifierClientSecret } : {}),
    domain: config.domain ?? 'https://gitfoundry.dev',
    git_url_base: config.git_url_base ?? 'https://gitfoundry.dev/git',
    workers: [
      { name: config.api_worker_name, role: 'api', domain: config.domain ?? 'https://gitfoundry.dev' },
      ...(config.mcp_worker_name ? [{ name: config.mcp_worker_name, role: 'mcp', domain: config.mcp_domain ?? 'https://mcp.gitfoundry.dev' }] : []),
    ],
  };
}

export function validateDeploymentIdentity(config, env) {
  if (!shaPattern.test(env.GFY_SOURCE_REVISION ?? '')) throw new Error('deployment requires an exact source commit');
  if (!config.account_id || !config.api_token || !config.runner_public_key || !repositoryIdPattern.test(config.runner_repository_id ?? '') || !Array.isArray(config.workers) || config.workers.length === 0) throw new Error('deployment provider identity and credential are required');
  return env.GFY_SOURCE_REVISION;
}

async function execute(executable, argv, { cwd, log, env = process.env }) {
  return await new Promise((done, reject) => {
    const child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', part => { stdout += part; log?.write(part); });
    child.stderr.on('data', part => log?.write(part));
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 && !signal ? done(stdout) : reject(new Error('Deployment command failed; inspect the private runner deployment log')));
  });
}

function bindingText(version, name) {
  const bindings = version?.resources?.bindings ?? version?.bindings ?? [];
  return bindings.find(binding => binding.name === name)?.text;
}

export async function verifyDeployment(config, env = process.env, fetcher = fetch) {
  const revision = validateDeploymentIdentity(config, env);
  const results = [];
  for (const worker of config.workers) {
    const base = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(config.account_id) + '/workers/scripts/' + encodeURIComponent(worker.name);
    const get = async path => {
      const response = await fetcher(base + path, { headers: { authorization: 'Bearer ' + config.api_token } });
      const payload = await response.json();
      if (!response.ok || payload.success !== true) throw new Error('Cloudflare deployment readback failed');
      return payload.result;
    };
    const deployments = await get('/deployments');
    const active = deployments.deployments?.[0];
    if (!active?.id || !Array.isArray(active.versions) || active.versions.length === 0) throw new Error('active deployment receipt missing');
    const total = active.versions.reduce((sum, version) => sum + Number(version.percentage ?? 0), 0);
    if (total !== 100) throw new Error('active deployment receipt missing');
    const versions = [];
    for (const activeVersion of active.versions) {
      if (!activeVersion.version_id || Number(activeVersion.percentage) <= 0) throw new Error('active deployment receipt missing');
      const version = await get('/versions/' + encodeURIComponent(activeVersion.version_id));
      if (bindingText(version, 'GFY_SOURCE_REVISION') !== revision) throw new Error('active deployment version source revision mismatch');
      versions.push({ version_id: activeVersion.version_id, percentage: Number(activeVersion.percentage) });
    }
    results.push({ role: worker.role, worker_name: worker.name, domain: worker.domain, deployment_id: active.id, versions });
  }
  return { domain: config.domain, source_revision: revision, workers: results, verified_at: new Date().toISOString() };
}

export function deploymentEnvironment(config, env) {
  const actions = actionsDeploymentBindings(config.actions);
  return {
    ...actions.text, ...actions.secrets,
    ...env,
    CI: 'true',
    CLOUDFLARE_ACCOUNT_ID: config.account_id,
    CLOUDFLARE_API_TOKEN: config.api_token,
    GFY_OWNER_EMAIL: config.owner_email,
    GFY_OWNER_ACCESS_SUBJECT: config.owner_subject,
    GFY_AUTH_ISSUER: config.auth_issuer,
    GFY_SOURCE_REVISION: env.GFY_SOURCE_REVISION,
    GFY_FORGE_TRUSTED_KEYS: typeof config.forge_trusted_keys === 'string' ? config.forge_trusted_keys : JSON.stringify(config.forge_trusted_keys ?? {}),
    GFY_FORGE_REVIEW_SIGNING_KEY: config.review_signing_key_file ? undefined : config.review_signing_key,
    GFY_FORGE_REVIEW_KEY_ID: config.review_key_id,
    GFY_GIT_URL_BASE: config.git_url_base,
    ...(config.trusted_git_helper_image ? { GFY_TRUSTED_GIT_HELPER_IMAGE: config.trusted_git_helper_image } : {}),
    ...(config.untrusted_ci_image ? { GFY_UNTRUSTED_CI_IMAGE: config.untrusted_ci_image } : {}),
    GFY_RUNNER_PUBLIC_KEY: config.runner_public_key,
    GFY_RUNNER_REPOSITORY_ID: config.runner_repository_id,
    ...(config.runner_client_id && config.runner_client_secret ? { GFY_RUNNER_CLIENT_ID: config.runner_client_id, GFY_RUNNER_CLIENT_SECRET: config.runner_client_secret } : {}),
  };
}

export function rollbackPlanForPrepared(prepared, env = process.env, clock = () => new Date().toISOString()) {
  return {
    schema_version: 1,
    source_revision: env.GFY_SOURCE_REVISION ?? null,
    created_at: clock(),
    workers: prepared.map(worker => ({
      role: worker.role,
      worker_name: worker.name,
      previous_deployment_id: worker.previous_deployment_id,
      previous_versions: worker.previous_versions ?? [],
    })),
  };
}

export async function persistRollbackPlan(logDirectory, prepared, env = process.env, clock) {
  const plan = rollbackPlanForPrepared(prepared, env, clock);
  await writeFile(join(logDirectory, 'rollback-plan.json'), JSON.stringify(plan), { mode: 0o600 });
  return plan;
}

export async function finalDeployAdmission(env = process.env) {
  if (!env.GFY_ACTION_RUN_ID) throw new Error('deployment requires a hosted lease');
  if (!env.GFY_RUNNER_CONFIG_FILE || !env.GFY_RUNNER_FENCE) throw new Error('deployment admission metadata missing');
  const { loadConfig, request } = await import('./gfy-runner.mjs');
  const runnerConfig = await loadConfig(env.GFY_RUNNER_CONFIG_FILE);
  const fence = JSON.parse(env.GFY_RUNNER_FENCE);
  const response = await request(runnerConfig, '/_runner/runs/' + encodeURIComponent(env.GFY_ACTION_RUN_ID) + '/heartbeat', { ...fence, phase: 'deploying' });
  if (response?.cancel_requested === true || response?.deploy_allowed === false) throw new Error('deployment admission denied by GitFoundry');
  return response;
}

const propagation = { timeoutMs: 90_000, delayMs: 5_000, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

// A new deployment reaches every Cloudflare location within seconds, not at once; until then
// the previous version answers and reports its own revision.
async function fetchAfterPropagation(fetcher, url, init, wait, timeoutMs = 60_000) {
  for (let waited = 0; ; waited += wait.delayMs) {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 409 || waited >= wait.timeoutMs) return response;
    const body = await response.clone().json().catch(() => undefined);
    if (body?.error !== 'qualification source revision mismatch') return response;
    await wait.sleep(wait.delayMs);
  }
}

export async function qualifyContainerRelease(config, env, request, fetcher = fetch, wait = propagation) {
  if (!config.qualifier_client_id || !config.qualifier_client_secret) throw new Error('deployment container qualifier credentials are required');
  if (!shaPattern.test(env.GFY_SOURCE_REVISION ?? '') || request.source_revision !== env.GFY_SOURCE_REVISION) throw new Error('container qualification source revision mismatch');
  if (request.target !== 'canary' && request.target !== 'active') throw new Error('invalid container qualification target');
  const profiles = [];
  for (const profile of ['trusted_git_helper', 'untrusted_ci_job']) {
    const containers = request.containers.filter(container => container.profile === profile);
    if (containers.length !== 1 || !/^registry\.cloudflare\.com\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(containers[0].image)) throw new Error('container qualification image manifest is invalid');
    const response = await fetchAfterPropagation(fetcher, new URL('/_operator/qualify/linux', config.domain), {
      method: 'POST', redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'X-GitFoundry-Expected-Revision': env.GFY_SOURCE_REVISION,
        'x-gitfoundry-operator-client-id': config.qualifier_client_id,
        'x-gitfoundry-operator-secret': config.qualifier_client_secret,
        'CF-Access-Client-Id': config.qualifier_client_id,
        'CF-Access-Client-Secret': config.qualifier_client_secret,
      },
      body: JSON.stringify({ profile, target: request.target }),
    }, wait);
    const receipt = await response.json().catch(() => undefined);
    if (response.status !== 200 || receipt?.profile !== profile || receipt.image !== containers[0].image || receipt.status !== 'succeeded' || receipt.exitCode !== 0 || receipt.cleanupRequired !== false || typeof receipt.commandId !== 'string' || !receipt.commandId || !/^git version \S/.test(receipt.version ?? '')) throw new Error('container qualification failed for ' + profile + ' (HTTP ' + response.status + ')');
    if (profile === 'untrusted_ci_job' && (receipt.architecture !== 'x86_64' || receipt.credentialsAbsent !== true || receipt.publicEgressDenied !== true || typeof receipt.supervisorVersion !== 'string' || !receipt.supervisorVersion)) throw new Error('container qualification isolation proof missing');
    profiles.push({ profile, status: receipt.status, image: receipt.image });
  }
  return { source_revision: env.GFY_SOURCE_REVISION, profiles };
}


// Each forge read starts a fresh helper container, so the first reads after a deploy are slow.
const repositoryLoadTimeoutMs = 240_000;

// Loads the canonical repository through production the way its repository page does.
export async function qualifyRepositoryLoad(config, env, fetcher = fetch, wait = propagation) {
  if (!config.qualifier_client_id || !config.qualifier_client_secret) throw new Error('repository load check credentials are required');
  const response = await fetchAfterPropagation(fetcher, new URL('/_operator/qualify/repository', config.domain), {
    method: 'POST', redirect: 'error',
    headers: {
      'X-GitFoundry-Expected-Revision': env.GFY_SOURCE_REVISION,
      'x-gitfoundry-operator-client-id': config.qualifier_client_id,
      'x-gitfoundry-operator-secret': config.qualifier_client_secret,
      'CF-Access-Client-Id': config.qualifier_client_id,
      'CF-Access-Client-Secret': config.qualifier_client_secret,
    },
  }, wait, repositoryLoadTimeoutMs);
  const body = await response.json().catch(() => undefined);
  if (response.status !== 200) throw new Error('repository load check failed at ' + (typeof body?.stage === 'string' ? body.stage : 'HTTP ' + response.status) + (body?.cause ? ': ' + JSON.stringify(body.cause) : ''));
  if (!shaPattern.test(body?.head_version_commit ?? '') || !shaPattern.test(body?.code_commit ?? '') || !(body.versions > 0) || !(body.tree_entries > 0)) throw new Error('repository load check failed: incomplete repository readback');
  return body;
}

// The API runs the repository load check on this schedule and records each result. Uploading a
// version never changes a Worker's schedule, so a release sets it once every release check passes.
export const apiSchedule = [{ cron: '*/5 * * * *' }];

export async function applyApiSchedule(config, env, workerName, fetcher = fetch) {
  if (!config.account_id || !env.CLOUDFLARE_API_TOKEN || !workerName) throw new Error('API schedule requires the account, provider token, and API Worker');
  const response = await fetcher('https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(config.account_id) + '/workers/scripts/' + encodeURIComponent(workerName) + '/schedules', {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(apiSchedule)
  });
  const body = await response.json().catch(() => undefined);
  const crons = (body?.result?.schedules ?? []).map(schedule => schedule.cron);
  if (!response.ok || body?.success !== true || JSON.stringify(crons) !== JSON.stringify(apiSchedule.map(schedule => schedule.cron))) throw new Error('API schedule was not applied (HTTP ' + response.status + ')');
  return { schedules: crons };
}

export async function qualifyActionsRelease(config, env, request, fetcher = fetch) {
  if (!config.qualifier_client_id || !config.qualifier_client_secret) throw new Error('Actions qualifier credentials are required');
  if (request.source_revision !== env.GFY_SOURCE_REVISION || !shaPattern.test(request.source_revision ?? '')) throw new Error('Actions qualifier source revision mismatch');
  const response = await fetcher(new URL('/_operator/qualify/actions', config.domain), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: {
      'content-type': 'application/json', 'X-GitFoundry-Expected-Revision': request.source_revision,
      'x-gitfoundry-operator-client-id': config.qualifier_client_id, 'x-gitfoundry-operator-secret': config.qualifier_client_secret,
      'CF-Access-Client-Id': config.qualifier_client_id, 'CF-Access-Client-Secret': config.qualifier_client_secret
    }, body: '{}'
  });
  const receipt = await response.json().catch(() => undefined);
  if (response.status !== 200 || receipt?.source_revision !== request.source_revision || receipt.image !== request.image ||
      receipt.generation !== request.generation || receipt.backendReady !== true || receipt.storagePointerReadable !== true ||
      receipt.durableStorageWriteRead !== true || receipt.snapshotBucketWriteRead !== true) throw new Error('Actions readiness qualification failed');
  return { source_revision: receipt.source_revision, image: receipt.image, generation: receipt.generation,
    backendReady: true, storagePointerReadable: true, durableStorageWriteRead: true, snapshotBucketWriteRead: true,
    acceptance: { runner: 'pending', restartRestore: 'pending', accessOverrides: 'pending' } };
}

export async function deploy(env = process.env, options = {}) {
  const config = await loadDeploymentConfig(env.GFY_DEPLOY_CONFIG_FILE);
  const revision = validateDeploymentIdentity(config, env);
  if (!config.qualifier_client_id || !config.qualifier_client_secret) throw new Error('deployment container qualifier credentials are required');
  const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
  const logDirectory = resolve(config.log_root ?? join(root, '.gfy-deploy-logs'), env.GFY_ACTION_RUN_ID ?? 'bootstrap-' + revision);
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const log = await open(join(logDirectory, 'cloudflare.log'), 'a', 0o600);
  const runAdmission = options.finalDeployAdmission ?? finalDeployAdmission;
  const runExecute = options.execute ?? execute;
  try {
    let deployEnv = deploymentEnvironment(config, env);
    await refreshWranglerOAuth(config, deployEnv, runExecute);
    deployEnv = deploymentEnvironment(config, env);
    if (config.review_signing_key_file) deployEnv.GFY_FORGE_REVIEW_SIGNING_KEY = await readSecret(resolve(config.review_signing_key_file), 'review signing key file');
    const actual = (await runExecute('git', ['rev-parse', 'HEAD^{commit}'], { cwd: root, log, env: deployEnv })).trim();
    if (actual !== revision) throw new Error('deployment checkout does not match leased source');
    await runExecute('pnpm', ['install', '--frozen-lockfile', ...(deployEnv.PNPM_STORE_DIR ? ['--store-dir', deployEnv.PNPM_STORE_DIR] : [])], { cwd: root, log, env: deployEnv });
    await runExecute('pnpm', ['-r', 'build'], { cwd: root, log, env: deployEnv });
    await runExecute('worker-build', ['--release', '--no-opt', '--out-dir', '../../target/p0-remote-worker-build', 'crates/mcp-worker', '--locked'], { cwd: root, log, env: deployEnv });
    await runAdmission(env);
    const { prepareCfRelease, deployCfRelease } = await import('./gfy-cf-release.mjs');
    const prepared = await prepareCfRelease(root, config, deployEnv, runExecute, log);
    await persistRollbackPlan(logDirectory, prepared, deployEnv);
    const resourceReceipts = await deployCfRelease(prepared, deployEnv, runExecute, () => runAdmission(env), log,
      request => qualifyContainerRelease(config, deployEnv, request, options.fetcher ?? fetch),
      options.qualifyActionsRelease ?? (request => qualifyActionsRelease(config, deployEnv, request, options.fetcher ?? fetch)));
    const verified = await verifyDeployment(config, deployEnv, options.fetcher ?? fetch);
    const repository = await qualifyRepositoryLoad(config, deployEnv, options.fetcher ?? fetch);
    const schedule = await applyApiSchedule(config, deployEnv, prepared.find(worker => worker.role === 'api')?.name, options.fetcher ?? fetch);
    const receipt = { ...verified, resources: resourceReceipts, repository, schedule };
    await writeFile(join(root, '.gfy-deployment.json'), JSON.stringify(receipt), { mode: 0o600 });
    console.log(JSON.stringify(receipt));
    return receipt;
  } finally {
    await log.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) deploy().catch(error => { console.error(error.message); process.exitCode = 1; });
