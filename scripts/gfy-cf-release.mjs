import { build } from 'esbuild';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const sha = /^[0-9a-f]{40}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cfWorkerConfiguration(worker, version, env) {
  version = normalizedVersion(version);
  if (!sha.test(env.GFY_SOURCE_REVISION ?? '')) throw new Error('cf release requires an exact source revision');
  if (!Array.isArray(version.bindings) || !version.bindings.length) throw new Error('deployed Worker bindings are required');
  const bindings = {};
  for (const { name, type, ...fields } of version.bindings) {
    if (!name || !type || Object.hasOwn(bindings, name)) throw new Error('invalid or duplicate deployed binding');
    bindings[name] = type === 'plain_text' ? { type: 'text', value: fields.text }
      : type === 'json' ? { type: 'json', value: fields.json ?? fields.value }
      : type === 'secret_text' ? { type: 'secret' }
      : type === 'assets' ? { type: 'assets' }
      : type === 'd1' ? { type: 'd1', id: fields.id ?? fields.database_id }
      : { ...fields, type: 'unsafe:' + type };
  }
  bindings.GFY_SOURCE_REVISION = { type: 'text', value: env.GFY_SOURCE_REVISION };
  if (worker.role === 'api') {
    for (const name of ['GFY_OWNER_ACCESS_SUBJECT', 'GFY_OWNER_EMAIL', 'GFY_AUTH_ISSUER', 'GFY_FORGE_TRUSTED_KEYS', 'GFY_FORGE_REVIEW_KEY_ID', 'GFY_RUNNER_PUBLIC_KEY', 'GFY_RUNNER_REPOSITORY_ID']) {
      if (typeof env[name] !== 'string' || !env[name]) throw new Error('cf release configuration missing ' + name);
    }
    for (const [name, legacy] of [['GFY_TRUSTED_GIT_HELPER_IMAGE', 'TRUSTED_HELPER_IMAGE'], ['GFY_UNTRUSTED_CI_IMAGE', 'TRUSTED_CI_IMAGE']]) {
      const image = env[name] ?? bindings[name]?.value ?? bindings[legacy]?.value;
      if (image === undefined) continue;
      if (typeof image !== 'string' || !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error('cf release requires an immutable image digest for ' + name);
      bindings[name] = { type: 'text', value: image };
    }
    const text = {
      GFY_BODY_LIMIT_BYTES: '1048576',
      GFY_OWNER_ACCESS_SUBJECT: env.GFY_OWNER_ACCESS_SUBJECT, GFY_OWNER_ACCESS_EMAIL: env.GFY_OWNER_EMAIL,
      GFY_OWNER_TENANT_ID: 'owner', GFY_OWNER_NAMESPACE_ID: 'core', GFY_AUTH_ISSUER: env.GFY_AUTH_ISSUER,
      GFY_FORGE_TRUSTED_KEYS: env.GFY_FORGE_TRUSTED_KEYS, GFY_FORGE_REVIEW_KEY_ID: env.GFY_FORGE_REVIEW_KEY_ID,
      GFY_RUNNER_ID: 'owner-runner-production', GFY_RUNNER_TENANT_ID: 'owner',
      GFY_RUNNER_REPOSITORY_ID: env.GFY_RUNNER_REPOSITORY_ID, GFY_RUNNER_PUBLIC_KEY: env.GFY_RUNNER_PUBLIC_KEY,
      ...(env.GFY_RUNNER_CLIENT_ID ? { GFY_RUNNER_CLIENT_ID: env.GFY_RUNNER_CLIENT_ID } : {})
    };
    for (const [name, value] of Object.entries(text)) bindings[name] = { type: 'text', value };
    bindings.GFY_FORGE_REVIEW_SIGNING_KEY = { type: 'secret' };
    bindings.GFY_LOGIN_EMAIL = { type: 'unsafe:send_email' };
    if (env.GFY_RUNNER_CLIENT_SECRET) bindings.GFY_RUNNER_CLIENT_SECRET = { type: 'secret' };
  }
  return {
    name: worker.name, compatibilityDate: version.compatibility_date, compatibilityFlags: version.compatibility_flags ?? [],
    workersDev: true, previewUrls: false, env: bindings,
    unsafe: { metadata: { keep_bindings: ['secret_text', 'secret_key'], ...(version.containers?.length ? { containers: version.containers } : {}) } },
    ...(worker.role === 'api' ? { assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/', '/index.html', '/auth/*', '/api/*', '/git/*', '/runner/*', '/_*', '/health', '/internal*', '/identity*', '/invoke*', '/mcp*'] } } : {}),
    manifest: { type: 'partial', mainModule: 'index.js', modules: {} }
  };
}

async function mcpModuleManifest(directory) {
  const modules = {};
  async function visit(prefix = '') {
    const entries = await readdir(join(directory, prefix), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? prefix + '/' + entry.name : entry.name;
      if (!/^[A-Za-z0-9_.-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) throw new Error('unsafe MCP artifact: ' + path);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        if (!prefix && ['package.json', '.gitignore'].includes(entry.name)) continue;
        const type = /\.(?:js|mjs)$/.test(path) ? 'esm' : /\.wasm$/.test(path) ? 'wasm' : undefined;
        if (!type) throw new Error('unsupported MCP artifact: ' + path);
        modules[path] = { type };
      } else {
        throw new Error('unsafe MCP artifact: ' + path);
      }
    }
  }
  await visit();
  if (modules['index.js']?.type !== 'esm') throw new Error('MCP artifact main module index.js is required');
  return { type: 'complete', mainModule: 'index.js', modules };
}

function parsed(output) { const value = JSON.parse(output); return value.result ?? value; }


const containerProfiles = [
  { profile: 'trusted_git_helper', binding: 'TRUSTED_GIT_HELPER', class_name: 'TrustedGitHelperPinnedDO', image_binding: 'GFY_TRUSTED_GIT_HELPER_IMAGE', suffix: 'helper' },
  { profile: 'untrusted_ci_job', binding: 'UNTRUSTED_CI_JOB', class_name: 'UntrustedCiJobPinnedDO', image_binding: 'GFY_UNTRUSTED_CI_IMAGE', suffix: 'ci' }
];
function normalizedVersion(version) {
  const runtime = version.resources?.script_runtime ?? {};
  return { ...runtime, ...version, bindings: version.bindings ?? version.resources?.bindings, containers: version.containers ?? runtime.containers };
}
export function cfContainerConfiguration(api, name, accountId) {
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(name) || name === api.name) throw new Error('invalid dedicated container Worker name');
  const env = {};
  for (const key of ['GFY_DB', 'GFY_ARTIFACTS', 'GFY_INTERNAL_ARTIFACTS', 'GFY_INTERNAL_LOGS', 'GFY_LINUX_MAX_OUTPUT_BYTES', 'GFY_SOURCE_REVISION']) {
    if (api.env[key]) env[key] = api.env[key];
  }
  const containers = containerProfiles.map(profile => {
    const image = api.env[profile.image_binding]?.value;
    if (typeof image !== 'string' || !image.startsWith('registry.cloudflare.com/' + accountId + '/') || !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error('dedicated container Worker requires a same-account immutable image for ' + profile.profile);
    env[profile.image_binding] = { type: 'text', value: image };
    env[profile.binding] = { type: 'unsafe:durable_object_namespace', class_name: profile.class_name };
    return { name: name + '-' + profile.suffix, class_name: profile.class_name, images: { gfy: image } };
  });
  return {
    name, compatibilityDate: api.compatibilityDate, compatibilityFlags: api.compatibilityFlags,
    workersDev: false, previewUrls: false, env,
    unsafe: { metadata: { exports: { ...Object.fromEntries(containers.map(container => [container.class_name, { type: 'durable-object', storage: 'sqlite', container: container.name }])), GitFoundryArtifactsEgress: { type: 'worker' } }, containers } },
    manifest: { type: 'partial', mainModule: 'index.js', modules: {} }
  };
}
export function cfCanaryConfiguration(api, containerWorker, receipts = []) {
  const env = { ...api.env };
  for (const profile of containerProfiles) {
    const receipt = receipts.find(value => value.profile === profile.profile);
    env[profile.binding + '_CANARY'] = {
      type: 'unsafe:durable_object_namespace', class_name: profile.class_name, script_name: containerWorker.name,
      ...(receipt ? { namespace_id: receipt.namespace_id } : {})
    };
  }
  return { ...api, env };
}
export function cfPromotedConfiguration(api) {
  const env = { ...api.env };
  for (const profile of containerProfiles) {
    const canary = env[profile.binding + '_CANARY'];
    if (!canary?.namespace_id || canary.class_name !== profile.class_name || !canary.script_name) throw new Error('resolved canary namespace receipt required');
    env[profile.binding] = { ...canary };
  }
  return { ...api, env };
}
export function verifyContainerQualification(result, revision, receipts) {
  if (result?.source_revision !== revision || !Array.isArray(result.profiles) || result.profiles.length !== containerProfiles.length) throw new Error('container qualification receipt missing or revision mismatch');
  for (const expected of receipts) {
    const matches = result.profiles.filter(value => value.profile === expected.profile);
    if (matches.length !== 1 || matches[0].status !== 'succeeded' || matches[0].image !== expected.image) throw new Error('container qualification profile or image mismatch');
  }
}
function containerVersionReceipts(worker, version, revision) {
  version = normalizedVersion(version);
  if (version.exports?.GitFoundryArtifactsEgress?.type !== 'worker') throw new Error('container Worker scoped egress export receipt missing');
  if (!version.bindings?.some(binding => binding.name === 'GFY_SOURCE_REVISION' && binding.text === revision)) throw new Error('container Worker source revision mismatch');
  return containerProfiles.map(profile => {
    const container = version.containers?.find(value => value.class_name === profile.class_name);
    const expected = worker.configuration.unsafe.metadata.containers.find(value => value.class_name === profile.class_name);
    const declaration = version.exports?.[profile.class_name];
    const imageBinding = version.bindings.find(value => value.name === profile.image_binding);
    if (declaration?.type !== 'durable-object' || declaration.storage !== 'sqlite' || declaration.container !== expected.name || imageBinding?.text !== expected.images.gfy) throw new Error('container Worker export or image binding receipt mismatch');
    const bindings = version.bindings.filter(value => value.name === profile.binding && value.type === 'durable_object_namespace' && value.class_name === profile.class_name && (!value.script_name || value.script_name === worker.name));
    if (!container || container.name !== expected.name || JSON.stringify(container.images) !== JSON.stringify(expected.images) || bindings.length !== 1 || !/^[a-f0-9]{32}$/.test(bindings[0].namespace_id ?? '')) throw new Error('container Worker namespace or named image receipt mismatch');
    return { ...profile, script_name: worker.name, name: container.name, namespace_id: bindings[0].namespace_id, image: expected.images.gfy };
  });
}
async function existingWorkers(root, env, execute, log) {
  const names = new Set();
  for (let page = 1; ; page++) {
    const result = parsed(await execute('cf', ['workers', 'list', '--page', String(page), '--per-page', '100'], { cwd: root, env, log }));
    const workers = Array.isArray(result) ? result : result.workers;
    if (!Array.isArray(workers)) throw new Error('cf Worker list receipt malformed');
    for (const worker of workers) {
      if (typeof worker.name !== 'string') throw new Error('cf Worker name receipt malformed');
      names.add(worker.name);
    }
    if (workers.length < 100) return names;
  }
}
// Cloudflare only starts containers for a scheduler-backed application that carries an image and
// instance shape. Its configured image is what runs, so it must equal the release image.
const containerInstances = 5;
const containerInstanceType = 'lite';
export async function containerApplications(worker, receipts, env, execute, admit, log, { pause = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 60, intervalMs = 5000 } = {}) {
  const run = args => execute('cf', ['containers', 'applications', ...args], { cwd: worker.project, env, log });
  async function list() {
    const result = parsed(await run(['list']));
    const values = Array.isArray(result) ? result : result.applications;
    if (!Array.isArray(values)) throw new Error('container application list receipt malformed');
    return values;
  }
  const find = async receipt => (await list()).filter(value => value.name === receipt.name || value.durable_objects?.namespace_id === receipt.namespace_id);
  const resolved = [];
  for (const receipt of receipts) {
    let matches = await find(receipt);
    if (matches.length === 1 && matches[0].scheduling_policy === 'durable_object' && !matches[0].configuration?.image) {
      await admit();
      await run(['delete', matches[0].id, '--force']);
      matches = await find(receipt);
    }
    if (matches.length === 0) {
      await admit();
      await run(['create', '--body', JSON.stringify({
        name: receipt.name, scheduling_policy: 'default', durable_objects: { namespace_id: receipt.namespace_id },
        instances: containerInstances, max_instances: containerInstances,
        configuration: { image: receipt.image, instance_type: containerInstanceType }
      })]);
      matches = await find(receipt);
    }
    let [application] = matches;
    if (matches.length !== 1 || application.name !== receipt.name || application.scheduling_policy !== 'default' || application.durable_objects?.namespace_id !== receipt.namespace_id || typeof application.id !== 'string' || !application.id) throw new Error('container application identity or scheduling policy mismatch');
    if (application.configuration?.image !== receipt.image) {
      await admit();
      await run(['rollouts', 'create', application.id, '--body', JSON.stringify({
        description: 'GitFoundry ' + env.GFY_SOURCE_REVISION + ' ' + receipt.profile, strategy: 'rolling', kind: 'full_auto', step_percentage: 100,
        target_configuration: { image: receipt.image, instance_type: containerInstanceType }
      })]);
      for (let attempt = 1; ; attempt += 1) {
        application = parsed(await run(['get', application.id]));
        if (application.configuration?.image === receipt.image) break;
        if (attempt >= attempts) throw new Error('container application image rollout did not converge for ' + receipt.profile);
        await pause(intervalMs);
      }
    }
    resolved.push({ ...receipt, application_id: application.id });
  }
  return resolved;
}


const actionsClass = 'GitHubActionsBackendDO';
const actionsBackendText = ['GFY_ACTIONS_STORAGE_GENERATION', 'GFY_ACTIONS_PUBLIC_ORIGIN', 'GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_ID'];
const actionsSecrets = ['GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN', 'GFY_ACTIONS_INTERNAL_STORAGE_SECRET', 'GFY_ACTIONS_RSA_PRIVATE_KEY', 'GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_SECRET'];
const actionsApiText = [...actionsBackendText, 'GFY_ACTIONS_OWNER_TENANT_ID', 'GFY_ACTIONS_OWNER_REPOSITORY_ID', 'GFY_ACTIONS_OWNER_REPOSITORY', 'GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY'];
export function cfActionsConfiguration(api, actions, accountId, env) {
  if (!actions?.enabled) throw new Error('Actions must be explicitly enabled');
  const image = actions.image;
  if (typeof image !== 'string' || !image.startsWith('registry.cloudflare.com/' + accountId + '/') || !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Actions requires a same-account immutable image');
  const name = actions.worker_name ?? api.name.slice(0, 40) + '-actions-' + image.slice(-64, -52);
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(name) || name === api.name) throw new Error('invalid private Actions Worker name');
  const bindings = { GFY_SOURCE_REVISION: api.env.GFY_SOURCE_REVISION, GFY_ACTIONS_BACKEND_IMAGE: { type: 'text', value: image } };
  for (const key of [...actionsApiText, ...actionsSecrets]) if (typeof env[key] !== 'string' || !env[key]) throw new Error('Actions release configuration missing ' + key);
  for (const key of actionsBackendText) bindings[key] = { type: 'text', value: env[key] };
  for (const key of actionsSecrets) bindings[key] = { type: 'secret' };
  bindings.GITHUB_ACTIONS_BACKEND = { type: 'unsafe:durable_object_namespace', class_name: actionsClass };
  return { name, compatibilityDate: api.compatibilityDate, compatibilityFlags: api.compatibilityFlags,
    workersDev: false, previewUrls: false, env: bindings,
    unsafe: { metadata: { exports: { [actionsClass]: { type: 'durable-object', storage: 'sqlite' } }, containers: [{ class_name: actionsClass }] } },
    manifest: { type: 'partial', mainModule: 'index.js', modules: {} } };
}
export function cfActionsApiConfiguration(api, actionsWorker, receipt, actions, env) {
  const bindings = { ...api.env };
  for (const key of actionsApiText) bindings[key] = { type: 'text', value: env[key] };
  for (const key of ['GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN', 'GFY_ACTIONS_INTERNAL_STORAGE_SECRET']) bindings[key] = { type: 'secret' };
  bindings.GFY_ACTIONS_BACKEND_IMAGE = { type: 'text', value: actions.image };
  bindings.GFY_ACTIONS_SQLITE_BUCKET = { type: 'unsafe:r2_bucket', bucket_name: actions.sqlite_bucket };
  bindings.GITHUB_ACTIONS_BACKEND = { type: 'unsafe:durable_object_namespace', class_name: actionsClass, script_name: actionsWorker.name,
    ...(receipt ? { namespace_id: receipt.namespace_id } : {}) };
  return { ...api, env: bindings };
}
export function actionsVersionReceipt(worker, version, revision) {
  version = normalizedVersion(version);
  const binding = version.bindings?.filter(value => value.name === 'GITHUB_ACTIONS_BACKEND' && value.type === 'durable_object_namespace' && value.class_name === actionsClass && (!value.script_name || value.script_name === worker.name));
  const declaration = version.exports?.[actionsClass];
  const containers = version.containers?.filter(value => value.class_name === actionsClass);
  if (!version.bindings?.some(value => value.name === 'GFY_SOURCE_REVISION' && value.text === revision) ||
      !version.bindings?.some(value => value.name === 'GFY_ACTIONS_BACKEND_IMAGE' && value.text === worker.actions.image) ||
      declaration?.type !== 'durable-object' || declaration.storage !== 'sqlite' ||
      containers?.length !== 1 || binding?.length !== 1 || !/^[a-f0-9]{32}$/.test(binding[0].namespace_id ?? '')) throw new Error('Actions Worker namespace, source or image receipt mismatch');
  return { name: worker.name + '-server', script_name: worker.name, class_name: actionsClass,
    namespace_id: binding[0].namespace_id, image: worker.actions.image, generation: worker.actions.storage_generation };
}
export function verifyActionsApplication(application, receipt) {
  if (!uuid.test(application?.id ?? '') || application.name !== receipt.name || application.scheduling_policy !== 'default' ||
      application.durable_objects?.namespace_id !== receipt.namespace_id || application.configuration?.image !== receipt.image ||
      application.max_instances !== 1) throw new Error('Actions application identity, namespace, image or scheduling policy mismatch');
  return { ...receipt, application_id: application.id };
}
export function verifyActionsQualification(result, revision, receipt) {
  if (result?.source_revision !== revision || result.image !== receipt.image || result.generation !== receipt.generation ||
      result.backendReady !== true || result.storagePointerReadable !== true || result.durableStorageWriteRead !== true ||
      result.snapshotBucketWriteRead !== true) throw new Error('Actions readiness qualification receipt mismatch');
}
async function provisionActionsResources(worker, receipt, env, execute, admit, log) {
  async function applications() {
    const value = parsed(await execute('cf', ['containers', 'applications', 'list'], { cwd: worker.project, env, log }));
    const apps = Array.isArray(value) ? value : value.applications;
    if (!Array.isArray(apps)) throw new Error('Actions application list receipt malformed');
    return apps;
  }
  let matches = (await applications()).filter(value => value.name === receipt.name || value.durable_objects?.namespace_id === receipt.namespace_id);
  if (!matches.length) {
    await admit();
    await execute('cf', ['containers', 'applications', 'create', '--body', JSON.stringify({
      name: receipt.name, scheduling_policy: 'default', instances: 0, max_instances: 1,
      configuration: { image: receipt.image }, durable_objects: { namespace_id: receipt.namespace_id }
    })], { cwd: worker.project, env, log });
    matches = (await applications()).filter(value => value.name === receipt.name || value.durable_objects?.namespace_id === receipt.namespace_id);
  }
  if (matches.length !== 1) throw new Error('Actions application receipt missing or ambiguous');
  const resolved = verifyActionsApplication(matches[0], receipt);
  async function buckets() {
    const value = parsed(await execute('cf', ['r2', 'buckets', 'list'], { cwd: worker.project, env, log }));
    const list = Array.isArray(value) ? value : value.buckets;
    if (!Array.isArray(list)) throw new Error('Actions snapshot bucket list receipt malformed');
    return list.filter(bucket => bucket.name === worker.actions.sqlite_bucket);
  }
  let found = await buckets();
  if (!found.length) {
    await admit();
    await execute('cf', ['r2', 'buckets', 'create', '--name', worker.actions.sqlite_bucket], { cwd: worker.project, env, log });
    found = await buckets();
  }
  if (found.length !== 1) throw new Error('Actions snapshot bucket receipt missing or ambiguous');
  return { ...resolved, snapshot_bucket: worker.actions.sqlite_bucket };
}
async function prepareActionsWorker(root, releaseRoot, api, actions, accountId, names, env, execute, log) {
  const configuration = cfActionsConfiguration(api, actions, accountId, env), name = configuration.name;
  if (names.has(name) && name === api.name) throw new Error('Actions Worker overlaps API');
  const project = join(releaseRoot, 'actions'), output = join(project, '.cloudflare/output/v0'), directory = join(output, 'workers/default');
  await mkdir(join(directory, 'bundle'), { recursive: true, mode: 0o700 });
  await build({ absWorkingDir: root, entryPoints: ['apps/api-worker/src/actions-github/container-worker.ts'], outfile: join(directory, 'bundle/index.js'),
    bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'],
    target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
  await writeFile(join(output, 'config.json'), JSON.stringify({ accountId, buildContext: { isPreview: false } }), { mode: 0o600 });
  const configuration_file = join(directory, 'worker.config.json'), secrets_file = join(project, 'secrets.json');
  await writeFile(configuration_file, JSON.stringify(configuration), { mode: 0o600 });
  await writeFile(secrets_file, JSON.stringify(Object.fromEntries(actionsSecrets.map(key => [key, env[key]]))), { mode: 0o600 });
  let previous = null;
  if (names.has(name)) {
    const value = parsed(await execute('cf', ['workers', 'deployments', 'list', '--worker', name], { cwd: root, env, log }));
    previous = (value.deployments ?? value)[0];
    if (!previous?.id || !previous.versions?.length) throw new Error('Actions Worker previous deployment receipt missing');
  }
  return { name, role: 'actions', actions, project, configuration, configuration_file, secrets_file,
    previous_deployment_id: previous?.id ?? null, previous_versions: previous?.versions ?? [] };
}

export async function prepareCfRelease(root, config, env, execute, log) {
  const releaseRoot = resolve(root, '.gfy-cf-release');
  await rm(releaseRoot, { recursive: true, force: true });
  const prepared = [];
  const containerNames = config.workers.some(worker => worker.role === 'api') ? await existingWorkers(root, env, execute, log) : null;
  for (const worker of config.workers) {
    const deployments = parsed(await execute('cf', ['workers', 'deployments', 'list', '--worker', worker.name], { cwd: root, env, log }));
    const active = (deployments.deployments ?? deployments)[0];
    if (!active?.id || !active.versions?.length) throw new Error('cf active deployment receipt missing');
    const remote = normalizedVersion(parsed(await execute('cf', ['workers', 'versions', 'get', active.versions[0].version_id, '--worker-id', worker.name], { cwd: root, env, log })));
    const configuration = cfWorkerConfiguration(worker, remote, env);
    const project = join(releaseRoot, worker.role);
    const output = join(project, '.cloudflare/output/v0');
    const directory = join(output, 'workers/default');
    const bundle = join(directory, 'bundle');
    await mkdir(bundle, { recursive: true, mode: 0o700 });
    if (worker.role === 'api') {
      if (config.actions?.enabled) {
        const actionsWorker = await prepareActionsWorker(root, releaseRoot, configuration, config.actions, config.account_id, containerNames, env, execute, log);
        prepared.push(actionsWorker);
        Object.assign(configuration, cfActionsApiConfiguration(configuration, actionsWorker, null, config.actions, env));
      }
      if (containerNames) {
        const name = config.container_worker_name ?? worker.name + '-linux';
        const containerConfiguration = cfContainerConfiguration(configuration, name, config.account_id);
        const containerProject = join(releaseRoot, 'linux');
        const containerOutput = join(containerProject, '.cloudflare/output/v0');
        const containerDirectory = join(containerOutput, 'workers/default');
        const containerBundle = join(containerDirectory, 'bundle');
        await mkdir(containerBundle, { recursive: true, mode: 0o700 });
        await build({ absWorkingDir: root, entryPoints: ['apps/api-worker/src/linux/container-worker.ts'], outfile: join(containerBundle, 'index.js'), bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
        await writeFile(join(containerOutput, 'config.json'), JSON.stringify({ accountId: config.account_id, buildContext: { isPreview: false } }), { mode: 0o600 });
        const configuration_file = join(containerDirectory, 'worker.config.json');
        await writeFile(configuration_file, JSON.stringify(containerConfiguration), { mode: 0o600 });
        const secrets_file = join(containerProject, 'secrets.json');
        await writeFile(secrets_file, '{}', { mode: 0o600 });
        let previous = null;
        if (containerNames.has(name)) {
          const result = parsed(await execute('cf', ['workers', 'deployments', 'list', '--worker', name], { cwd: root, env, log }));
          previous = (result.deployments ?? result)[0];
          if (!previous?.id || !previous.versions?.length) throw new Error('container Worker previous deployment receipt missing');
        }
        prepared.push({ name, role: 'linux', project: containerProject, configuration_file, configuration: containerConfiguration, secrets_file, previous_deployment_id: previous?.id ?? null, previous_versions: previous?.versions ?? [] });
        Object.assign(configuration, cfCanaryConfiguration(configuration, { name }));
      }

      await build({ absWorkingDir: root, entryPoints: ['apps/api-worker/src/worker.ts'], outfile: join(bundle, 'index.js'), bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
      await cp(join(root, 'apps/web/dist'), join(directory, 'assets'), { recursive: true });
    } else {
      const artifacts = join(root, 'target/p0-remote-worker-build');
      configuration.manifest = await mcpModuleManifest(artifacts);
      await cp(artifacts, bundle, { recursive: true });
    }
    await writeFile(join(output, 'config.json'), JSON.stringify({ accountId: config.account_id, buildContext: { isPreview: false } }), { mode: 0o600 });
    await writeFile(join(directory, 'worker.config.json'), JSON.stringify(configuration), { mode: 0o600 });
    const secrets = worker.role === 'api' ? { GFY_FORGE_REVIEW_SIGNING_KEY: env.GFY_FORGE_REVIEW_SIGNING_KEY, ...(env.GFY_RUNNER_CLIENT_SECRET ? { GFY_RUNNER_CLIENT_SECRET: env.GFY_RUNNER_CLIENT_SECRET } : {}) } : {};
    if (worker.role === 'api' && config.actions?.enabled) for (const key of ['GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN', 'GFY_ACTIONS_INTERNAL_STORAGE_SECRET']) secrets[key] = env[key];
    if (worker.role === 'api' && !secrets.GFY_FORGE_REVIEW_SIGNING_KEY) throw new Error('cf review signing secret is required');
    const secretsFile = join(project, 'secrets.json');
    await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    prepared.push({ ...worker, project, configuration_file: join(directory, 'worker.config.json'), configuration, secrets_file: secretsFile, previous_deployment_id: active.id, previous_versions: active.versions });
  }
  return prepared;
}

export async function deployCfRelease(prepared, env, execute, admit, log, qualifyContainers, qualifyActions) {
  const staged = [], changed = [];
  const linux = prepared.find(worker => worker.role === 'linux');
  const actions = prepared.find(worker => worker.role === 'actions');
  if (actions && typeof qualifyActions !== 'function') throw new Error('Actions qualification callback is required');
  if (linux && typeof qualifyContainers !== 'function') throw new Error('container qualification callback is required');
  async function versionsFor(worker) {
    const versions = parsed(await execute('cf', ['workers', 'versions', 'list', '--worker-id', worker.name, '--per-page', '100'], { cwd: worker.project, env, log }));
    if (!Array.isArray(versions) || versions.some(version => !version || !uuid.test(version.id ?? ''))) throw new Error('cf version list receipt malformed');
    return versions;
  }
  async function activeFor(worker) {
    const result = parsed(await execute('cf', ['workers', 'deployments', 'list', '--worker', worker.name], { cwd: worker.project, env, log }));
    const active = (result.deployments ?? result)[0];
    if (!active?.id || !active.versions?.length) throw new Error('cf active deployment receipt missing');
    return active;
  }
  async function versionFor(worker, id) {
    return normalizedVersion(parsed(await execute('cf', ['workers', 'versions', 'get', id, '--worker-id', worker.name], { cwd: worker.project, env, log })));
  }
  async function upload(worker) {
    await admit();
    const before = new Set((await versionsFor(worker)).map(version => version.id));
    await execute('cf', ['workers', 'versions', 'create', '--prebuilt', '--secrets-file', worker.secrets_file, '--tag', env.GFY_SOURCE_REVISION], { cwd: worker.project, env, log });
    const receipts = (await versionsFor(worker)).filter(version => !before.has(version.id) && version.annotations?.['workers/tag'] === env.GFY_SOURCE_REVISION);
    if (receipts.length !== 1) throw new Error('cf uploaded version receipt missing or ambiguous');
    const id = receipts[0].id, version = await versionFor(worker, id);
    if (!version.bindings?.some(binding => binding.name === 'GFY_SOURCE_REVISION' && binding.text === env.GFY_SOURCE_REVISION)) throw new Error('cf uploaded version source revision mismatch');
    return { ...worker, version_id: id, uploaded_version: version };
  }
  async function deploy(worker, expected) {
    await admit();
    if ((await activeFor(worker)).id !== expected) throw new Error('cf deployment changed during release');
    let previous = changed.find(value => value.name === worker.name);
    if (!previous) { previous = { ...worker, current_deployment_id: expected }; changed.push(previous); }
    previous.expected_version_id = worker.version_id;
    await execute('cf', ['workers', 'deployments', 'create', '--worker', worker.name, '--strategy', 'percentage', '--versions', JSON.stringify([{ version_id: worker.version_id, percentage: 100 }])], { cwd: worker.project, env, log });
    const active = await activeFor(worker);
    if (active.versions.length !== 1 || active.versions[0].version_id !== worker.version_id || active.versions[0].percentage !== 100) throw new Error('cf deployment version receipt mismatch');
    previous.current_deployment_id = active.id;
    return active.id;
  }
  try {
    let actionsReceipt;
    if (actions) {
      let stagedActions;
      if (actions.previous_deployment_id) {
        stagedActions = await upload(actions);
        await deploy(stagedActions, actions.previous_deployment_id);
      } else {
        await admit();
        await execute('cf', ['deploy', '--prebuilt', '--secrets-file', actions.secrets_file], { cwd: actions.project, env, log });
        const active = await activeFor(actions);
        if (active.versions.length !== 1 || active.versions[0].percentage !== 100) throw new Error('Actions Worker bootstrap deployment receipt mismatch');
        stagedActions = { ...actions, version_id: active.versions[0].version_id, uploaded_version: await versionFor(actions, active.versions[0].version_id) };
      }
      actionsReceipt = await provisionActionsResources(actions, actionsVersionReceipt(actions, stagedActions.uploaded_version, env.GFY_SOURCE_REVISION), env, execute, admit, log);
      staged.push({ ...stagedActions, actions_receipt: actionsReceipt });
    }
    let containerReceipts = [];
    if (linux) {
      let stagedLinux;
      if (linux.previous_deployment_id) {
        stagedLinux = await upload(linux);
        await deploy(stagedLinux, linux.previous_deployment_id);
      } else {
        await admit();
        await execute('cf', ['deploy', '--prebuilt'], { cwd: linux.project, env, log });
        const active = await activeFor(linux);
        if (active.versions.length !== 1 || active.versions[0].percentage !== 100) throw new Error('container Worker bootstrap deployment receipt mismatch');
        stagedLinux = { ...linux, version_id: active.versions[0].version_id, uploaded_version: await versionFor(linux, active.versions[0].version_id) };
      }
      containerReceipts = await containerApplications(linux, containerVersionReceipts(linux, stagedLinux.uploaded_version, env.GFY_SOURCE_REVISION), env, execute, admit, log);
      staged.push({ ...stagedLinux, container_receipts: containerReceipts });
    }
    for (const worker of prepared.filter(worker => worker.role !== 'linux' && worker.role !== 'actions')) {
      if (actions && worker.role === 'api') {
        worker.configuration = cfActionsApiConfiguration(worker.configuration, actions, actionsReceipt, actions.actions, env);
        await writeFile(worker.configuration_file, JSON.stringify(worker.configuration), { mode: 0o600 });
      }
      if (linux && worker.role === 'api') {
        worker.configuration = cfCanaryConfiguration(worker.configuration, linux, containerReceipts);
        await writeFile(worker.configuration_file, JSON.stringify(worker.configuration), { mode: 0o600 });
      }
      staged.push(await upload(worker));
    }
    for (const worker of staged.filter(worker => worker.role !== 'linux' && worker.role !== 'actions')) {
      const canaryDeployment = await deploy(worker, worker.previous_deployment_id);
      if (linux && worker.role === 'api') {
        for (const receipt of containerReceipts) {
          const binding = worker.uploaded_version.bindings.find(value => value.name === receipt.binding + '_CANARY');
          if (!binding || binding.namespace_id !== receipt.namespace_id || binding.class_name !== receipt.class_name || binding.script_name !== linux.name) throw new Error('API canary binding receipt mismatch');
        }
        const qualification = await qualifyContainers({ worker, container_worker: linux, containers: containerReceipts, source_revision: env.GFY_SOURCE_REVISION, target: 'canary' });
        verifyContainerQualification(qualification, env.GFY_SOURCE_REVISION, containerReceipts);
        worker.configuration = cfPromotedConfiguration(worker.configuration);
        await writeFile(worker.configuration_file, JSON.stringify(worker.configuration), { mode: 0o600 });
        const promoted = await upload(worker);
        for (const receipt of containerReceipts) {
          const binding = promoted.uploaded_version.bindings.find(value => value.name === receipt.binding);
          if (!binding || binding.namespace_id !== receipt.namespace_id || binding.class_name !== receipt.class_name || binding.script_name !== linux.name) throw new Error('API promoted binding receipt mismatch');
        }
        await deploy(promoted, canaryDeployment);
        Object.assign(worker, promoted);
        verifyContainerQualification(await qualifyContainers({ worker, container_worker: linux, containers: containerReceipts, source_revision: env.GFY_SOURCE_REVISION, target: 'active' }), env.GFY_SOURCE_REVISION, containerReceipts);
      }
    }
    if (actions) {
      const api = staged.find(worker => worker.role === 'api');
      const binding = api?.uploaded_version.bindings?.find(value => value.name === 'GITHUB_ACTIONS_BACKEND');
      const bucket = api?.uploaded_version.bindings?.find(value => value.name === 'GFY_ACTIONS_SQLITE_BUCKET');
      if (!binding || binding.namespace_id !== actionsReceipt.namespace_id || binding.class_name !== actionsClass || binding.script_name !== actions.name || bucket?.bucket_name !== actionsReceipt.snapshot_bucket) throw new Error('API Actions resource binding receipt mismatch');
      const qualification = await qualifyActions({ ...actionsReceipt, source_revision: env.GFY_SOURCE_REVISION });
      verifyActionsQualification(qualification, env.GFY_SOURCE_REVISION, actionsReceipt);
      staged.find(worker => worker.role === 'actions').actions_receipt = { ...actionsReceipt, qualification,
        required_path_overrides: ['/runner/*', '/api/v3/actions/runner-registration'], access_status: 'unverified', runner_status: 'unverified', restart_restore_status: 'unverified' };
    }
    return staged.map(({ name, role, version_id, container_receipts, actions_receipt }) => ({ name, role, version_id, ...(container_receipts ? { container_receipts } : {}), ...(actions_receipt ? { actions_receipt } : {}) }));
  } catch (error) {
    const rollbackErrors = [];
    for (const worker of changed.reverse()) {
      try {
        await admit();
        const current = await activeFor(worker);
        if (JSON.stringify(current.versions) === JSON.stringify(worker.previous_versions)) continue;
        if (current.id !== worker.current_deployment_id && !(current.versions.length === 1 && current.versions[0].version_id === worker.expected_version_id && current.versions[0].percentage === 100)) throw new Error('deployment changed before rollback');
        await execute('cf', ['workers', 'deployments', 'create', '--worker', worker.name, '--strategy', 'percentage', '--versions', JSON.stringify(worker.previous_versions)], { cwd: worker.project, env, log });
        const restored = await activeFor(worker);
        if (JSON.stringify(restored.versions) !== JSON.stringify(worker.previous_versions)) throw new Error('rollback version receipt mismatch');
      } catch (failure) { rollbackErrors.push(worker.name + ': ' + failure.message); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors.map(message => new Error(message))], 'container release failed and rollback requires attention');
    throw error;
  }
}
