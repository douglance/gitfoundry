import { generateKeyPairSync, sign } from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerApplications, cfWorkerConfiguration, prepareCfRelease, cfContainerConfiguration, cfCanaryConfiguration, cfPromotedConfiguration, verifyContainerQualification, deployCfRelease, cfActionsConfiguration, cfActionsApiConfiguration, actionsVersionReceipt, verifyActionsApplication, verifyActionsQualification } from './gfy-cf-release.mjs';

const env = { GFY_SOURCE_REVISION: 'a'.repeat(40) };
const remote = { compatibility_date: '2026-10-01', bindings: [{ name: 'API', type: 'service', service: 'gitfoundry-api' }] };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gfy-cf-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, 'target/p0-remote-worker-build');
  await mkdir(join(artifacts, 'worker'), { recursive: true });
  await writeFile(join(artifacts, 'index.js'), 'import wasm from "./index_bg.wasm"; export default wasm;');
  await writeFile(join(artifacts, 'index_bg.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await writeFile(join(artifacts, 'worker/shim.mjs'), 'export const GitFoundryCodeMode = class {};');
  await writeFile(join(artifacts, 'package.json'), '{"type":"module"}');
  await writeFile(join(artifacts, '.gitignore'), '*');
  return { root, artifacts };
}
async function prepare(root) {
  return prepareCfRelease(root, { account_id: 'account', workers: [{ name: 'gitfoundry-mcp', role: 'mcp' }] }, env,
    async (_command, args) => JSON.stringify(args[1] === 'deployments'
      ? { deployments: [{ id: 'deployment', versions: [{ version_id: 'version' }] }] } : remote), () => {});
}
test('MCP release explicitly declares emitted runtime modules including Wasm', async (t) => {
  const { root } = await fixture(t);
  const [worker] = await prepare(root);
  const configuration = JSON.parse(await readFile(join(worker.project, '.cloudflare/output/v0/workers/default/worker.config.json'), 'utf8'));
  assert.deepEqual(configuration.manifest, {
    type: 'complete', mainModule: 'index.js', modules: {
      'index.js': { type: 'esm' }, 'index_bg.wasm': { type: 'wasm' }, 'worker/shim.mjs': { type: 'esm' }
    }
  });
  assert.deepEqual(await readFile(join(worker.project, '.cloudflare/output/v0/workers/default/bundle/index_bg.wasm')), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
});
test('API release replaces a deployed 64 KiB body limit with the protocol 1 MiB budget', () => {
  const ownerEnv = { ...env, ...Object.fromEntries(['GFY_OWNER_ACCESS_SUBJECT', 'GFY_OWNER_EMAIL', 'GFY_AUTH_ISSUER', 'GFY_FORGE_TRUSTED_KEYS', 'GFY_FORGE_REVIEW_KEY_ID', 'GFY_RUNNER_PUBLIC_KEY', 'GFY_RUNNER_REPOSITORY_ID'].map(name => [name, 'configured'])) };
  const deployed = { ...remote, bindings: [...remote.bindings, { name: 'GFY_BODY_LIMIT_BYTES', type: 'plain_text', text: '65536' }] };
  assert.deepEqual(cfWorkerConfiguration({ name: 'api', role: 'api' }, deployed, ownerEnv).env.GFY_BODY_LIMIT_BYTES,
    { type: 'text', value: '1048576' });
});

test('API release routes sign-in to the Worker and binds sign-in email', () => {
  const ownerEnv = { ...env, ...Object.fromEntries(['GFY_OWNER_ACCESS_SUBJECT', 'GFY_OWNER_EMAIL', 'GFY_AUTH_ISSUER', 'GFY_FORGE_TRUSTED_KEYS', 'GFY_FORGE_REVIEW_KEY_ID', 'GFY_RUNNER_PUBLIC_KEY', 'GFY_RUNNER_REPOSITORY_ID'].map(name => [name, 'configured-' + name])) };
  const configuration = cfWorkerConfiguration({ name: 'api', role: 'api' }, remote, ownerEnv);
  assert.ok(configuration.assets.runWorkerFirst.includes('/auth/*'));
  assert.deepEqual(configuration.env.GFY_LOGIN_EMAIL, { type: 'unsafe:send_email' });
  const redeployed = cfWorkerConfiguration({ name: 'api', role: 'api' }, { ...remote, bindings: [...remote.bindings, { name: 'GFY_LOGIN_EMAIL', type: 'send_email' }] }, ownerEnv);
  assert.deepEqual(redeployed.env.GFY_LOGIN_EMAIL, { type: 'unsafe:send_email' });
  assert.equal(cfWorkerConfiguration({ name: 'mcp', role: 'mcp' }, remote, ownerEnv).env.GFY_LOGIN_EMAIL, undefined);
});

test('API configuration keeps its bundled partial manifest', () => {
  const ownerEnv = { ...env, ...Object.fromEntries(['GFY_OWNER_ACCESS_SUBJECT', 'GFY_OWNER_EMAIL', 'GFY_AUTH_ISSUER', 'GFY_FORGE_TRUSTED_KEYS', 'GFY_FORGE_REVIEW_KEY_ID', 'GFY_RUNNER_PUBLIC_KEY', 'GFY_RUNNER_REPOSITORY_ID'].map(name => [name, 'configured'])) };
  assert.deepEqual(cfWorkerConfiguration({ name: 'api', role: 'api' }, remote, ownerEnv).manifest,
    { type: 'partial', mainModule: 'index.js', modules: {} });
});
test('MCP release refuses artifact symlinks', async (t) => {
  const { root, artifacts } = await fixture(t);
  await symlink(join(artifacts, 'index_bg.wasm'), join(artifacts, 'linked.wasm'));
  await assert.rejects(prepare(root), /unsafe MCP artifact/);
});

test('API release migrates legacy container images and honors an explicit immutable helper image', () => {
  const ownerEnv = { ...env, ...Object.fromEntries(['GFY_OWNER_ACCESS_SUBJECT', 'GFY_OWNER_EMAIL', 'GFY_AUTH_ISSUER', 'GFY_FORGE_TRUSTED_KEYS', 'GFY_FORGE_REVIEW_KEY_ID', 'GFY_RUNNER_PUBLIC_KEY', 'GFY_RUNNER_REPOSITORY_ID'].map(name => [name, 'configured'])) };
  const oldHelper = 'registry.cloudflare.com/account/helper@sha256:' + '1'.repeat(64);
  const ci = 'registry.cloudflare.com/account/ci@sha256:' + '2'.repeat(64);
  const replacement = 'registry.cloudflare.com/account/helper@sha256:' + '3'.repeat(64);
  const deployed = { ...remote, bindings: [...remote.bindings, { name: 'TRUSTED_HELPER_IMAGE', type: 'plain_text', text: oldHelper }, { name: 'TRUSTED_CI_IMAGE', type: 'plain_text', text: ci }] };
  const migrated = cfWorkerConfiguration({ name: 'api', role: 'api' }, deployed, ownerEnv).env;
  assert.deepEqual(migrated.GFY_TRUSTED_GIT_HELPER_IMAGE, { type: 'text', value: oldHelper });
  assert.deepEqual(migrated.GFY_UNTRUSTED_CI_IMAGE, { type: 'text', value: ci });
  assert.deepEqual(migrated.TRUSTED_HELPER_IMAGE, { type: 'text', value: oldHelper });
  const selected = cfWorkerConfiguration({ name: 'api', role: 'api' }, deployed, { ...ownerEnv, GFY_TRUSTED_GIT_HELPER_IMAGE: replacement }).env;
  assert.deepEqual(selected.GFY_TRUSTED_GIT_HELPER_IMAGE, { type: 'text', value: replacement });
  const current = { ...deployed, bindings: [...deployed.bindings, { name: 'GFY_TRUSTED_GIT_HELPER_IMAGE', type: 'plain_text', text: replacement }] };
  assert.deepEqual(cfWorkerConfiguration({ name: 'api', role: 'api' }, current, ownerEnv).env.GFY_TRUSTED_GIT_HELPER_IMAGE, { type: 'text', value: replacement });
  assert.throws(() => cfWorkerConfiguration({ name: 'api', role: 'api' }, deployed, { ...ownerEnv, GFY_TRUSTED_GIT_HELPER_IMAGE: 'helper:latest' }), /immutable image digest/);
});

test('deployment environment carries explicitly selected helper and CI digests', async () => {
  const { deploymentEnvironment } = await import('./gfy-cloudflare-deploy.mjs');
  const helper = 'registry.cloudflare.com/account/helper@sha256:' + '4'.repeat(64);
  const ci = 'registry.cloudflare.com/account/ci@sha256:' + '5'.repeat(64);
  const configured = deploymentEnvironment({ trusted_git_helper_image: helper, untrusted_ci_image: ci }, env);
  assert.equal(configured.GFY_TRUSTED_GIT_HELPER_IMAGE, helper);
  assert.equal(configured.GFY_UNTRUSTED_CI_IMAGE, ci);
});

const ownerEnv = { ...env, ...Object.fromEntries(['GFY_OWNER_ACCESS_SUBJECT', 'GFY_OWNER_EMAIL', 'GFY_AUTH_ISSUER', 'GFY_FORGE_TRUSTED_KEYS', 'GFY_FORGE_REVIEW_KEY_ID', 'GFY_RUNNER_PUBLIC_KEY', 'GFY_RUNNER_REPOSITORY_ID'].map(name => [name, 'configured'])) };
const helperImage = 'registry.cloudflare.com/account/helper@sha256:' + '4'.repeat(64);
const ciImage = 'registry.cloudflare.com/account/ci@sha256:' + '5'.repeat(64);
function apiConfiguration() {
  return cfWorkerConfiguration({ name: 'api', role: 'api' }, { ...remote, bindings: [...remote.bindings,
    { name: 'TRUSTED_GIT_HELPER', type: 'durable_object_namespace', class_name: 'TrustedGitHelperDO', namespace_id: '9'.repeat(32) },
    { name: 'UNTRUSTED_CI_JOB', type: 'durable_object_namespace', class_name: 'UntrustedCiJobDO', namespace_id: '8'.repeat(32) }
  ] }, { ...ownerEnv, GFY_TRUSTED_GIT_HELPER_IMAGE: helperImage, GFY_UNTRUSTED_CI_IMAGE: ciImage });
}
test('private container Worker declares independent SQLite namespaces and versioned digest maps', () => {
  const config = cfContainerConfiguration(apiConfiguration(), 'api-linux', 'account');
  assert.equal(config.workersDev, false);
  assert.equal(config.previewUrls, false);
  assert.deepEqual(config.unsafe.metadata.containers, [
    { name: 'api-linux-helper', class_name: 'TrustedGitHelperPinnedDO', images: { gfy: helperImage } },
    { name: 'api-linux-ci', class_name: 'UntrustedCiJobPinnedDO', images: { gfy: ciImage } }
  ]);
  assert.deepEqual(config.unsafe.metadata.exports.TrustedGitHelperPinnedDO, { type: 'durable-object', storage: 'sqlite', container: 'api-linux-helper' });
  assert.deepEqual(config.unsafe.metadata.exports.GitFoundryArtifactsEgress, { type: 'worker' });
  assert.equal(config.env.GFY_OWNER_ACCESS_SUBJECT, undefined);
  assert.equal(config.env.GFY_FORGE_REVIEW_SIGNING_KEY, undefined);
  assert.ok(Object.keys(config.env).every(name => !/^GFY_(?:OWNER|RUNNER|FORGE_REVIEW)/.test(name)));
  assert.equal(config.env.GFY_GIT, undefined);
  assert.throws(() => cfContainerConfiguration(apiConfiguration(), 'api', 'account'), /invalid dedicated/);
  assert.throws(() => cfContainerConfiguration(apiConfiguration(), 'api-linux', 'other-account'), /same-account immutable/);
});
test('canary configuration preserves public bindings until resolved namespaces are promoted', () => {
  const api = apiConfiguration(), privateWorker = { name: 'api-linux' };
  const canary = cfCanaryConfiguration(api, privateWorker);
  assert.deepEqual(canary.env.TRUSTED_GIT_HELPER, api.env.TRUSTED_GIT_HELPER);
  assert.equal(canary.unsafe.metadata.exports, undefined);
  assert.throws(() => cfPromotedConfiguration(canary), /resolved canary namespace/);
  const resolved = cfCanaryConfiguration(api, privateWorker, [
    { profile: 'trusted_git_helper', namespace_id: '1'.repeat(32) },
    { profile: 'untrusted_ci_job', namespace_id: '2'.repeat(32) }
  ]);
  assert.deepEqual(cfPromotedConfiguration(resolved).env.TRUSTED_GIT_HELPER, {
    type: 'unsafe:durable_object_namespace', class_name: 'TrustedGitHelperPinnedDO', script_name: 'api-linux', namespace_id: '1'.repeat(32)
  });
});
test('qualification admission requires both profiles, exact revision and independent image evidence', () => {
  const receipts = [{ profile: 'trusted_git_helper', image: helperImage }, { profile: 'untrusted_ci_job', image: ciImage }];
  const valid = { source_revision: env.GFY_SOURCE_REVISION, profiles: receipts.map(value => ({ ...value, status: 'succeeded' })) };
  verifyContainerQualification(valid, env.GFY_SOURCE_REVISION, receipts);
  for (const invalid of [
    undefined,
    { ...valid, source_revision: 'b'.repeat(40) },
    { ...valid, profiles: [valid.profiles[0], valid.profiles[0]] },
    { ...valid, profiles: valid.profiles.map(value => ({ ...value, image: helperImage })) },
    { ...valid, profiles: valid.profiles.map(value => ({ ...value, status: 'failed' })) }
  ]) assert.throws(() => verifyContainerQualification(invalid, env.GFY_SOURCE_REVISION, receipts), /qualification/);
});
async function releaseFixture(t, { failure, wrongApplication = false, existingLinux = false, existingApplications = 'current', withActions = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gfy-container-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = apiConfiguration(), linux = cfContainerConfiguration(api, 'api-linux', 'account');
  const prepared = [];
  const actions = withActions ? cfActionsConfiguration(api, actionsConfig, 'account', actionsEnv) : null;
  for (const [role, configuration] of [...(actions ? [['actions', actions]] : []), ['linux', linux], ['api', api]]) {
    const project = join(root, role), configuration_file = join(project, 'worker.config.json');
    await mkdir(project);
    await writeFile(configuration_file, JSON.stringify(configuration));
    prepared.push({ name: configuration.name, role, ...(role === 'actions' ? { actions: actionsConfig } : {}), project, configuration_file, configuration, secrets_file: join(project, 'secrets.json'),
      previous_deployment_id: role === 'api' ? 'old-api' : role === 'linux' && existingLinux ? 'old-linux' : null,
      previous_versions: role === 'api' ? [{ version_id: '00000000-0000-4000-8000-000000000000', percentage: 100 }] : role === 'linux' && existingLinux ? [{ version_id: '00000000-0000-4000-8000-000000000099', percentage: 100 }] : [] });
  }
  const versions = new Map(), deployments = new Map([['api', { id: 'old-api', versions: prepared.find(worker => worker.role === 'api').previous_versions }]]), apps = [], events = [];
  let counter = 0, readbackFailed = false;
  if (existingLinux) {
    deployments.set('api-linux', { id: 'old-linux', versions: prepared.find(worker => worker.role === 'linux').previous_versions });
    versions.set('00000000-0000-4000-8000-000000000099', { id: '00000000-0000-4000-8000-000000000099', name: 'api-linux', annotations: { 'workers/tag': 'previous' } });
    const existing = (name, namespace, image, index) => existingApplications === 'legacy'
      ? { name, id: namespace, scheduling_policy: 'durable_object', durable_objects: { namespace_id: namespace }, configuration: {} }
      : { name, id: '20000000-0000-4000-8000-00000000000' + index, scheduling_policy: 'default', durable_objects: { namespace_id: namespace },
        configuration: { image: existingApplications === 'stale' ? image.replace(/[0-9a-f]{64}$/, '9'.repeat(64)) : image } };
    apps.push(existing('api-linux-helper', '1'.repeat(32), helperImage, 1), existing('api-linux-ci', '2'.repeat(32), ciImage, 2));
  }
  async function upload(name, cwd) {
    const config = JSON.parse(await readFile(join(cwd, 'worker.config.json'), 'utf8'));
    const id = '00000000-0000-4000-8000-' + String(++counter).padStart(12, '0');
    const bindings = Object.entries(config.env).map(([name, value]) => value.type === 'text'
      ? { name, type: 'plain_text', text: value.value }
      : { ...value, name, type: value.type.replace('unsafe:', ''), ...(value.class_name === 'GitHubActionsBackendDO' && !value.namespace_id ? { namespace_id: '3'.repeat(32) } : {}), ...(value.class_name?.endsWith('PinnedDO') && !value.namespace_id ? { namespace_id: value.class_name.startsWith('Trusted') ? '1'.repeat(32) : '2'.repeat(32) } : {}) });
    if (failure === 'wrong-namespace' && name === 'api-linux') bindings.find(value => value.class_name === 'TrustedGitHelperPinnedDO').namespace_id = 'wrong-namespace';
    versions.set(id, { id, name, annotations: { 'workers/tag': env.GFY_SOURCE_REVISION }, bindings, containers: config.unsafe.metadata.containers, exports: config.unsafe.metadata.exports });
    events.push({ type: 'upload', name, config });
    return id;
  }
  const execute = async (_command, args, options) => {
    const value = flag => args[args.indexOf(flag) + 1];
    if (args[0] === 'deploy') {
      const name = JSON.parse(await readFile(join(options.cwd, 'worker.config.json'), 'utf8')).name;
      const id = await upload(name, options.cwd);
      deployments.set(name, { id: 'linux-bootstrap', versions: [{ version_id: id, percentage: 100 }] });
      return '{}';
    }
    if (args[0] === 'containers') {
      if (args[2] === 'list') return JSON.stringify(apps);
      if (args[2] === 'get') return JSON.stringify(apps.find(app => app.id === args[3]));
      if (args[2] === 'delete') {
        assert.equal(args[4], '--force');
        events.push({ type: 'application-delete', id: args[3] });
        apps.splice(apps.findIndex(app => app.id === args[3]), 1);
        return '{}';
      }
      const body = JSON.parse(value('--body'));
      if (args[2] === 'rollouts') {
        assert.equal(args[3], 'create');
        events.push({ type: 'rollout', id: args[4], body });
        apps.find(app => app.id === args[4]).configuration = { ...body.target_configuration };
        return '{}';
      }
      assert.equal(body.scheduling_policy, 'default');
      if (body.name.startsWith('api-linux-')) {
        assert.equal(body.configuration.image, body.name.endsWith('-helper') ? helperImage : ciImage);
        assert.equal(body.configuration.instance_type, 'lite');
        assert.ok(body.instances > 0 && body.instances === body.max_instances);
        assert.match(body.durable_objects.namespace_id, /^[a-f0-9]{32}$/);
      } else { assert.equal(body.configuration.image, actionsImage); assert.equal(body.instances, 0); assert.equal(body.max_instances, 1); }
      events.push({ type: 'application', body });
      apps.push({ ...body, id: '10000000-0000-4000-8000-00000000000' + (apps.length + 1), ...(wrongApplication ? { durable_objects: { namespace_id: 'f'.repeat(32) } } : {}) });
      return '{}';
    }
    if (args[0] === 'r2') return JSON.stringify({ buckets: [{ name: actionsConfig.sqlite_bucket }] });
    const name = value(args.includes('--worker') ? '--worker' : '--worker-id');
    if (args[1] === 'deployments') {
      if (args[2] === 'list') {
        if (failure === 'canary-readback' && name === 'api' && !readbackFailed && deployments.get(name).id !== 'old-api') { readbackFailed = true; throw new Error('canary readback rejected'); }
        return JSON.stringify({ deployments: [deployments.get(name)] });
      }
      const selected = JSON.parse(value('--versions'));
      deployments.set(name, { id: 'deployment-' + (++counter), versions: selected });
      events.push({ type: 'deploy', name, versions: selected });
      return '{}';
    }
    if (args[2] === 'list') return JSON.stringify([...versions.values()].filter(version => version.name === name));
    if (args[2] === 'get') return JSON.stringify(versions.get(args[3]));
    if (failure === 'promotion-upload' && events.filter(event => event.type === 'upload' && event.name === 'api').length === 1) throw new Error('promotion upload rejected');
    await upload(JSON.parse(await readFile(join(options.cwd, 'worker.config.json'), 'utf8')).name, options.cwd);
    return '{}';
  };
  const qualify = async request => {
    events.push({ type: 'qualify', target: request.target });
    if (failure === request.target) throw new Error('qualification rejected');
    return { source_revision: env.GFY_SOURCE_REVISION, profiles: request.containers.map(value => ({ profile: value.profile, image: value.image, status: 'succeeded' })) };
  };
  return { prepared, execute, qualify, deployments, events };
}
test('container release qualifies canary before promotion and attests active bindings after promotion', async t => {
  const f = await releaseFixture(t);
  const receipts = await deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}, f.qualify);
  assert.equal(receipts[0].role, 'linux');
  assert.equal(receipts[0].container_receipts.length, 2);
  const apiUploads = f.events.filter(event => event.type === 'upload' && event.name === 'api');
  assert.equal(apiUploads[0].config.env.TRUSTED_GIT_HELPER.class_name, 'TrustedGitHelperDO');
  assert.equal(apiUploads[1].config.env.TRUSTED_GIT_HELPER.script_name, 'api-linux');
  assert.deepEqual(f.events.filter(event => event.type === 'qualify').map(event => event.target), ['canary', 'active']);
  assert.ok(f.events.findIndex(event => event.type === 'qualify') < f.events.indexOf(apiUploads[1]));
});
for (const failure of ['canary', 'promotion-upload', 'active', 'canary-readback']) {
  test('container release restores original API on ' + failure + ' failure', async t => {
    const f = await releaseFixture(t, { failure });
    await assert.rejects(deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}, f.qualify), /rejected/);
    assert.deepEqual(f.deployments.get('api').versions, f.prepared[1].previous_versions);
    assert.ok(f.deployments.has('api-linux'));
  });
}
test('container release refuses unsupported application policy before changing API', async t => {
  const f = await releaseFixture(t, { wrongApplication: true });
  await assert.rejects(deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}, f.qualify), /scheduling policy/);
  assert.equal(f.deployments.get('api').id, 'old-api');
});
test('container release fails closed without a qualification callback', async t => {
  const f = await releaseFixture(t);
  await assert.rejects(deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}), /callback is required/);
  assert.equal(f.events.length, 0);
});

function qualificationFixture(overrides = {}) {
  const request = { source_revision: env.GFY_SOURCE_REVISION, target: 'canary', containers: [
    { profile: 'trusted_git_helper', image: helperImage },
    { profile: 'untrusted_ci_job', image: ciImage }
  ], ...overrides };
  const config = { domain: 'https://gitfoundry.dev', qualifier_client_id: 'existing-operator', qualifier_client_secret: 'private-value' };
  const responseFor = profile => ({
    profile, image: profile === 'trusted_git_helper' ? helperImage : ciImage, status: 'succeeded', exitCode: 0,
    cleanupRequired: false, commandId: 'qualification-' + profile, version: 'git version 2.43.0',
    ...(profile === 'untrusted_ci_job' ? { architecture: 'x86_64', credentialsAbsent: true, publicEgressDenied: true, supervisorVersion: 'gfy-supervisor-v1' } : {})
  });
  return { request, config, responseFor };
}
test('protected qualification callback forwards canary/active targets and exact source/operator credentials', async () => {
  const { qualifyContainerRelease } = await import('./gfy-cloudflare-deploy.mjs');
  for (const target of ['canary', 'active']) {
    const f = qualificationFixture({ target }), calls = [];
    const result = await qualifyContainerRelease(f.config, env, f.request, async (url, options) => {
      const { profile, target: sentTarget } = JSON.parse(options.body);
      calls.push(profile);
      assert.equal(url.toString(), 'https://gitfoundry.dev/_operator/qualify/linux');
      assert.equal(sentTarget, target);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-GitFoundry-Expected-Revision'], 'a'.repeat(40));
      assert.equal(options.headers['x-gitfoundry-operator-client-id'], 'existing-operator');
      assert.equal(options.headers['CF-Access-Client-Id'], 'existing-operator');
      assert.equal(options.headers['x-gitfoundry-operator-secret'], 'private-value');
      assert.equal(options.headers['CF-Access-Client-Secret'], 'private-value');
      return Response.json(f.responseFor(profile));
    });
    assert.deepEqual(calls, ['trusted_git_helper', 'untrusted_ci_job']);
    assert.equal(result.source_revision, 'a'.repeat(40));
    assert.deepEqual(result.profiles.map(value => value.image), [helperImage, ciImage]);
  }
});
test('protected qualification waits out the previous version while a deployment propagates', async () => {
  const { qualifyContainerRelease } = await import('./gfy-cloudflare-deploy.mjs');
  const f = qualificationFixture(), sleeps = [];
  let stale = 2;
  const mismatch = () => Response.json({ error: 'qualification source revision mismatch' }, { status: 409 });
  const result = await qualifyContainerRelease(f.config, env, f.request, async (_url, options) => stale-- > 0 ? mismatch() : Response.json(f.responseFor(JSON.parse(options.body).profile)),
    { timeoutMs: 60_000, delayMs: 5_000, sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [5_000, 5_000]);
  assert.deepEqual(result.profiles.map(value => value.profile), ['trusted_git_helper', 'untrusted_ci_job']);
  const always = qualificationFixture(), waited = [];
  await assert.rejects(qualifyContainerRelease(always.config, env, always.request, async () => mismatch(),
    { timeoutMs: 20_000, delayMs: 5_000, sleep: async ms => { waited.push(ms); } }), /qualification failed for trusted_git_helper \(HTTP 409\)/);
  assert.deepEqual(waited, [5_000, 5_000, 5_000, 5_000]);
  let calls = 0;
  await assert.rejects(qualifyContainerRelease(always.config, env, always.request, async () => { calls++; return Response.json({ error: 'other conflict' }, { status: 409 }); },
    { timeoutMs: 60_000, delayMs: 5_000, sleep: async () => assert.fail('only a revision mismatch is retried') }), /HTTP 409/);
  assert.equal(calls, 1);
});
test('protected qualification fails closed on revision/target or absent credentials before HTTP', async () => {
  const { qualifyContainerRelease } = await import('./gfy-cloudflare-deploy.mjs');
  const f = qualificationFixture();
  const fetcher = () => assert.fail('invalid qualification must not perform HTTP');
  await assert.rejects(qualifyContainerRelease(f.config, env, { ...f.request, source_revision: 'b'.repeat(40) }, fetcher), /source revision/);
  await assert.rejects(qualifyContainerRelease(f.config, env, { ...f.request, target: 'arbitrary' }, fetcher), /target/);
  await assert.rejects(qualifyContainerRelease({ domain: f.config.domain }, env, f.request, fetcher), /credentials are required/);
});
test('protected qualification refuses wrong images, HTTP failures and absent cleanup proof without leaking response secrets', async () => {
  const { qualifyContainerRelease } = await import('./gfy-cloudflare-deploy.mjs');
  for (const mode of ['wrong-image', 'http', 'cleanup', 'exit']) {
    const f = qualificationFixture();
    await assert.rejects(qualifyContainerRelease(f.config, env, f.request, async (_url, options) => {
      const profile = JSON.parse(options.body).profile;
      const receipt = { ...f.responseFor(profile), diagnostic: 'private-value', ...(mode === 'wrong-image' ? { image: ciImage } : mode === 'cleanup' ? { cleanupRequired: true } : mode === 'exit' ? { exitCode: 1 } : {}) };
      return Response.json(receipt, { status: mode === 'http' ? 502 : 200 });
    }), error => /qualification failed/.test(error.message) && !error.message.includes('private-value'));
  }
});
test('protected qualification refuses missing CI isolation and architecture proof', async () => {
  const { qualifyContainerRelease } = await import('./gfy-cloudflare-deploy.mjs');
  for (const [key, value] of [['credentialsAbsent', false], ['publicEgressDenied', false], ['architecture', 'arm64'], ['supervisorVersion', '']]) {
    const f = qualificationFixture();
    await assert.rejects(qualifyContainerRelease(f.config, env, f.request, async (_url, options) => {
      const profile = JSON.parse(options.body).profile;
      return Response.json({ ...f.responseFor(profile), ...(profile === 'untrusted_ci_job' ? { [key]: value } : {}) });
    }), /isolation proof missing/);
  }
});
test('API preparation emits private container bundle and keeps API lifecycle unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gfy-container-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/api-worker/src/linux'), { recursive: true });
  await mkdir(join(root, 'apps/web/dist'), { recursive: true });
  await writeFile(join(root, 'apps/api-worker/src/worker.ts'), 'export default {fetch(){return new Response("ok")}}');
  await writeFile(join(root, 'apps/api-worker/src/linux/container-worker.ts'), 'export class TrustedGitHelperPinnedDO {}; export class UntrustedCiJobPinnedDO {}; export default {fetch(){return new Response("Not found",{status:404})}}');
  await writeFile(join(root, 'apps/web/dist/index.html'), 'GitFoundry');
  const deployed = { ...remote, bindings: [
    ...remote.bindings,
    { name: 'TRUSTED_GIT_HELPER', type: 'durable_object_namespace', class_name: 'TrustedGitHelperDO', namespace_id: '9'.repeat(32) }
  ], containers: [{ class_name: 'TrustedGitHelperDO' }] };
  const commands = [];
  const prepared = await prepareCfRelease(root, { account_id: 'account', workers: [{ name: 'api', role: 'api' }] },
    { ...ownerEnv, GFY_FORGE_REVIEW_SIGNING_KEY: 'private', GFY_TRUSTED_GIT_HELPER_IMAGE: helperImage, GFY_UNTRUSTED_CI_IMAGE: ciImage },
    async (_command, args) => {
      commands.push(args);
      if (args[1] === 'list') return JSON.stringify([{ name: 'api' }]);
      if (args[1] === 'deployments') return JSON.stringify({ deployments: [{ id: 'old-api', versions: [{ version_id: 'old-version', percentage: 100 }] }] });
      return JSON.stringify(deployed);
    }, () => {});
  assert.deepEqual(prepared.map(worker => worker.role), ['linux', 'api']);
  const linux = prepared[0], api = prepared[1];
  assert.equal(linux.previous_deployment_id, null);
  assert.equal(linux.configuration.workersDev, false);
  assert.equal(api.configuration.unsafe.metadata.exports, undefined);
  assert.deepEqual(api.configuration.unsafe.metadata.containers, [{ class_name: 'TrustedGitHelperDO' }]);
  assert.equal(api.configuration.env.TRUSTED_GIT_HELPER.class_name, 'TrustedGitHelperDO');
  assert.equal(api.configuration.env.TRUSTED_GIT_HELPER_CANARY.script_name, 'api-linux');
  assert.ok((await readFile(join(linux.project, '.cloudflare/output/v0/workers/default/bundle/index.js'), 'utf8')).includes('TrustedGitHelperPinnedDO'));
  assert.ok(commands.every(args => !args.includes('create') && args[0] !== 'deploy'));
});

test('container release rejects a forged namespace before API traffic changes', async t => {
  const f = await releaseFixture(t, { failure: 'wrong-namespace' });
  await assert.rejects(deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}, f.qualify), /namespace or named image/);
  assert.equal(f.deployments.get('api').id, 'old-api');
});

test('real private container Worker bundle exports the scoped Artifacts egress broker', async () => {
  const { build } = await import('esbuild');
  const bundle = await build({ entryPoints: [new URL('../apps/api-worker/src/linux/container-worker.ts', import.meta.url).pathname],
    bundle: true, write: false, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'], target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
  const exports = bundle.outputFiles[0].text.match(/export \{([\s\S]*?)\};?\s*$/)?.[1] ?? '';
  assert.match(exports, /\bGitFoundryArtifactsEgress\b/);
  assert.match(exports, /\bTrustedGitHelperPinnedDO\b/);
  assert.match(exports, /\bUntrustedCiJobPinnedDO\b/);
});

test('repeat container release reuses attested applications and publishes a new private Worker version', async t => {
  const f = await releaseFixture(t, { existingLinux: true });
  const receipts = await deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}, f.qualify);
  assert.equal(f.events.filter(event => event.type === 'application').length, 0);
  assert.ok(f.events.some(event => event.type === 'upload' && event.name === 'api-linux'));
  assert.equal(f.deployments.get('api-linux').versions[0].version_id, receipts.find(value => value.role === 'linux').version_id);
});
test('first container release creates scheduler-backed applications that carry the release image', async t => {
  const f = await releaseFixture(t);
  const receipts = await deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}, f.qualify);
  const created = f.events.filter(event => event.type === 'application').map(event => event.body);
  assert.deepEqual(created.map(body => [body.name, body.configuration.image]), [['api-linux-helper', helperImage], ['api-linux-ci', ciImage]]);
  assert.ok(f.events.findIndex(event => event.type === 'application') < f.events.findIndex(event => event.type === 'qualify'));
  assert.deepEqual(receipts[0].container_receipts.map(value => value.application_id), ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']);
});
test('container release replaces unconfigured Durable Object applications before qualification', async t => {
  const f = await releaseFixture(t, { existingLinux: true, existingApplications: 'legacy' });
  await deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}, f.qualify);
  assert.deepEqual(f.events.filter(event => event.type === 'application-delete').map(event => event.id), ['1'.repeat(32), '2'.repeat(32)]);
  assert.deepEqual(f.events.filter(event => event.type === 'application').map(event => [event.body.scheduling_policy, event.body.configuration.image]), [['default', helperImage], ['default', ciImage]]);
  assert.ok(f.events.findLastIndex(event => event.type === 'application') < f.events.findIndex(event => event.type === 'qualify'));
});
test('container release rolls stale application images to the release image before qualification', async t => {
  const f = await releaseFixture(t, { existingLinux: true, existingApplications: 'stale' });
  await deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}, f.qualify);
  const rollouts = f.events.filter(event => event.type === 'rollout');
  assert.deepEqual(rollouts.map(event => event.body.target_configuration.image), [helperImage, ciImage]);
  assert.equal(f.events.filter(event => event.type === 'application' || event.type === 'application-delete').length, 0);
  assert.ok(f.events.findLastIndex(event => event.type === 'rollout') < f.events.findIndex(event => event.type === 'qualify'));
});
test('container application rollout that never applies fails without qualification', async () => {
  const receipt = { profile: 'trusted_git_helper', name: 'api-linux-helper', namespace_id: '1'.repeat(32), image: helperImage };
  const app = { id: '20000000-0000-4000-8000-000000000001', name: receipt.name, scheduling_policy: 'default', durable_objects: { namespace_id: receipt.namespace_id }, configuration: { image: ciImage } };
  let pauses = 0, rollouts = 0;
  const execute = async (_command, args) => {
    if (args[2] === 'list') return JSON.stringify([app]);
    if (args[2] === 'get') return JSON.stringify(app);
    if (args[2] === 'rollouts') { rollouts += 1; return '{}'; }
    throw new Error('unexpected ' + args.join(' '));
  };
  await assert.rejects(containerApplications({ project: '.' }, [receipt], env, execute, async () => {}, () => {}, { pause: async () => { pauses += 1; }, attempts: 3 }), /did not converge/);
  assert.equal(rollouts, 1);
  assert.equal(pauses, 2);
});
test('repeat container release restores both API and existing private Worker after active qualification fails', async t => {
  const f = await releaseFixture(t, { existingLinux: true, failure: 'active' });
  await assert.rejects(deployCfRelease(f.prepared, env, f.execute, async () => {}, () => {}, f.qualify), /qualification rejected/);
  assert.deepEqual(f.deployments.get('api').versions, f.prepared[1].previous_versions);
  assert.deepEqual(f.deployments.get('api-linux').versions, f.prepared[0].previous_versions);
  assert.equal(f.events.filter(event => event.type === 'application').length, 0);
});

test('API assets route GitHub runner protocol paths through the Worker before SPA fallback', () => {
  const config = cfWorkerConfiguration({ name: 'api', role: 'api' }, remote, ownerEnv);
  assert.ok(config.assets.runWorkerFirst.includes('/runner/*'));
  assert.ok(config.assets.runWorkerFirst.includes('/api/*'));
  assert.equal(config.assets.notFoundHandling, 'single-page-application');
});

const actionsImage = 'registry.cloudflare.com/account/gitfoundry-actions-server@sha256:' + 'c'.repeat(64);
const actionsConfig = { enabled: true, image: actionsImage, sqlite_bucket: 'gitfoundry-actions-sqlite', storage_generation: 'production-v1' };
const actionsEnv = { ...env, GFY_ACTIONS_STORAGE_GENERATION: 'production-v1', GFY_ACTIONS_PUBLIC_ORIGIN: 'https://gitfoundry.dev',
  GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_ID: 'storage-client', GFY_ACTIONS_OWNER_TENANT_ID: 'owner',
  GFY_ACTIONS_OWNER_REPOSITORY_ID: 'repo-' + 'f'.repeat(64), GFY_ACTIONS_OWNER_REPOSITORY: 'core/gitfoundry',
  GFY_ACTIONS_UPSTREAM_JWT_PUBLIC_KEY: 'public-key', GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN: 'private-runner',
  GFY_ACTIONS_INTERNAL_STORAGE_SECRET: 'private-storage', GFY_ACTIONS_RSA_PRIVATE_KEY: 'private-rsa',
  GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_SECRET: 'private-access' };
test('Actions Worker isolates secrets and uses an image-specific namespace without changing API lifecycle', () => {
  const api = apiConfiguration(), worker = cfActionsConfiguration(api, actionsConfig, 'account', actionsEnv);
  assert.equal(worker.workersDev, false);
  assert.equal(worker.previewUrls, false);
  assert.match(worker.name, /-actions-cccccccccccc$/);
  assert.deepEqual(worker.unsafe.metadata.containers, [{ class_name: 'GitHubActionsBackendDO' }]);
  assert.deepEqual(worker.unsafe.metadata.exports, { GitHubActionsBackendDO: { type: 'durable-object', storage: 'sqlite' } });
  assert.equal(worker.env.GFY_ACTIONS_RSA_PRIVATE_KEY.type, 'secret');
  assert.equal(worker.env.GFY_RUNNER_CLIENT_SECRET, undefined);
  assert.equal(worker.env.GFY_OWNER_ACCESS_SUBJECT, undefined);
  assert.equal(worker.env.GFY_FORGE_REVIEW_SIGNING_KEY, undefined);
  const configured = cfActionsApiConfiguration(api, worker, { namespace_id: '3'.repeat(32) }, actionsConfig, actionsEnv);
  assert.equal(configured.env.GITHUB_ACTIONS_BACKEND.script_name, worker.name);
  assert.equal(configured.env.GFY_ACTIONS_SQLITE_BUCKET.bucket_name, 'gitfoundry-actions-sqlite');
  assert.deepEqual(configured.unsafe, api.unsafe);
  assert.throws(() => cfActionsConfiguration(api, actionsConfig, 'wrong-account', actionsEnv), /immutable/);
  assert.throws(() => cfActionsConfiguration(api, actionsConfig, 'account', { ...actionsEnv, GFY_ACTIONS_RSA_PRIVATE_KEY: '' }), /missing GFY_ACTIONS_RSA_PRIVATE_KEY/);
});
test('default-policy Actions application UUID is independently associated with its namespace and image', () => {
  const receipt = { name: 'actions-server', namespace_id: '3'.repeat(32), image: actionsImage };
  const application = { id: '10000000-0000-4000-8000-000000000001', name: receipt.name, scheduling_policy: 'default',
    durable_objects: { namespace_id: receipt.namespace_id }, configuration: { image: actionsImage }, max_instances: 1 };
  assert.equal(verifyActionsApplication(application, receipt).application_id, application.id);
  for (const invalid of [
    { ...application, id: '' }, { ...application, name: 'other' }, { ...application, scheduling_policy: 'durable_object' },
    { ...application, durable_objects: { namespace_id: '4'.repeat(32) } }, { ...application, configuration: { image: helperImage } },
    { ...application, max_instances: 2 }
  ]) assert.throws(() => verifyActionsApplication(invalid, receipt), /Actions application/);
});
test('Actions qualification rejects unmeasured health or persistence and keeps runner/recovery acceptance pending', async t => {
  const f = await releaseFixture(t, { withActions: true });
  const valid = request => ({ ...request, backendReady: true, storagePointerReadable: true, durableStorageWriteRead: true, snapshotBucketWriteRead: true });
  const result = await deployCfRelease(f.prepared, actionsEnv, f.execute, async () => {}, () => {}, f.qualify, async request => valid(request));
  const actions = result.find(worker => worker.role === 'actions').actions_receipt;
  assert.notEqual(actions.application_id, actions.namespace_id);
  assert.equal(actions.snapshot_bucket, 'gitfoundry-actions-sqlite');
  assert.equal(actions.access_status, 'unverified');
  assert.equal(actions.restart_restore_status, 'unverified');
  assert.deepEqual(actions.required_path_overrides, ['/runner/*', '/api/v3/actions/runner-registration']);
  for (const key of ['backendReady', 'storagePointerReadable', 'durableStorageWriteRead', 'snapshotBucketWriteRead']) {
    assert.throws(() => verifyActionsQualification({ ...valid(actions), source_revision: env.GFY_SOURCE_REVISION, [key]: false }, env.GFY_SOURCE_REVISION, actions), /qualification/);
  }
  assert.ok(!JSON.stringify(result).includes('private-rsa'));
});
test('Actions qualification failure rolls back API and existing Linux Worker', async t => {
  const f = await releaseFixture(t, { withActions: true, existingLinux: true });
  await assert.rejects(deployCfRelease(f.prepared, actionsEnv, f.execute, async () => {}, () => {}, f.qualify,
    async () => { throw new Error('Actions readiness rejected'); }), /readiness rejected/);
  assert.deepEqual(f.deployments.get('api').versions, [{ version_id: '00000000-0000-4000-8000-000000000000', percentage: 100 }]);
  assert.deepEqual(f.deployments.get('api-linux').versions, [{ version_id: '00000000-0000-4000-8000-000000000099', percentage: 100 }]);
});
test('Actions private config loads only mode-0600 files and matching RSA keys', async t => {
  const { loadActionsConfiguration, actionsDeploymentBindings } = await import('./gfy-cloudflare-deploy.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'gfy-actions-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const input = { ...actionsConfig, public_origin: 'https://gitfoundry.dev', owner_tenant_id: 'owner',
    owner_repository_id: 'repo-' + 'f'.repeat(64), owner_repository: 'core/gitfoundry', storage_cf_access_client_id: 'storage-client' };
  for (const [key, value] of Object.entries({ upstream_runner_token: 'runner-secret', internal_storage_secret: 'storage-secret',
    rsa_private_key: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), upstream_jwt_public_key: pair.publicKey.export({ format: 'pem', type: 'spki' }),
    storage_cf_access_client_secret: 'access-secret' })) {
    input[key + '_file'] = join(directory, key);
    await writeFile(input[key + '_file'], value, { mode: 0o600 });
  }
  const config = await loadActionsConfiguration(input, 'account');
  assert.equal(actionsDeploymentBindings(config).secrets.GFY_ACTIONS_UPSTREAM_RUNNER_TOKEN, 'runner-secret');
  assert.equal(await loadActionsConfiguration(undefined, 'account'), undefined);
  assert.equal(await loadActionsConfiguration({ enabled: false }, 'account'), undefined);
  await assert.rejects(loadActionsConfiguration({ ...input, internal_storage_secret_file: undefined }, 'account'), /missing internal_storage_secret_file/);
  await writeFile(input.upstream_jwt_public_key_file, 'bad-public-key');
  await assert.rejects(loadActionsConfiguration(input, 'account'), /matching RSA/);
});
test('default Actions release callback forwards operator auth and validates measured receipt without leaking secrets', async () => {
  const { qualifyActionsRelease } = await import('./gfy-cloudflare-deploy.mjs');
  const config = { domain: 'https://gitfoundry.dev', qualifier_client_id: 'qualifier', qualifier_client_secret: 'private-qualifier' };
  const request = { source_revision: env.GFY_SOURCE_REVISION, image: actionsImage, generation: 'production-v1' };
  const valid = { ...request, backendReady: true, storagePointerReadable: true, durableStorageWriteRead: true, snapshotBucketWriteRead: true };
  const result = await qualifyActionsRelease(config, env, request, async (url, init) => {
    assert.equal(url.pathname, '/_operator/qualify/actions');
    assert.equal(init.headers['X-GitFoundry-Expected-Revision'], env.GFY_SOURCE_REVISION);
    assert.equal(init.headers['x-gitfoundry-operator-secret'], 'private-qualifier');
    return Response.json(valid);
  });
  assert.deepEqual(result.acceptance, { runner: 'pending', restartRestore: 'pending', accessOverrides: 'pending' });
  for (const bad of [{ ...valid, image: helperImage }, { ...valid, backendReady: false }, { ...valid, snapshotBucketWriteRead: false }]) {
    await assert.rejects(qualifyActionsRelease(config, env, request, async () => Response.json(bad)), error => /qualification failed/.test(error.message) && !error.message.includes('private-qualifier'));
  }
  await assert.rejects(qualifyActionsRelease(config, env, request, async () => Response.json(valid, { status: 503 })), /qualification failed/);
});
test('protected Actions handler authenticates before RPC and rejects revision or storage readback corruption', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gfy-actions-qualifier-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'qualifier.mjs');
  await build({ entryPoints: ['apps/api-worker/src/actions-github/provider-qualification.ts'], outfile: file, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { handleActionsQualification } = await import(pathToFileURL(file));
  let calls = 0, writes = 0, corrupt = false, backendOverrides = {};
  const store = new Map();
  const target = { GFY_SOURCE_REVISION: env.GFY_SOURCE_REVISION, GFY_ACTIONS_BACKEND_IMAGE: actionsImage,
    GFY_ACTIONS_STORAGE_GENERATION: 'production-v1', GFY_AUTH_ISSUER: 'https://access.example', GFY_AUTH_AUDIENCE: 'audience',
    GFY_AUTH_JWKS_URL: 'https://access.example/cdn-cgi/access/certs', GFY_QUALIFIER_CLIENT_ID: 'qualifier', GFY_QUALIFIER_CLIENT_SECRET: 'secret',
    GITHUB_ACTIONS_BACKEND: { idFromName: name => name, get: () => ({ qualifyActionsBackend: async () => {
      calls++; return { source_revision: env.GFY_SOURCE_REVISION, image: actionsImage, generation: 'production-v1', backendReady: true, storagePointerReadable: true, durableStorageWriteRead: true, ...backendOverrides };
    } }) },
    GFY_ACTIONS_SQLITE_BUCKET: { put: async (key,value) => { writes++; store.set(key,value); }, get: async key => ({ text: async () => corrupt ? 'wrong' : store.get(key) }), delete: async key => store.delete(key) } };
  const request = headers => new Request('https://gitfoundry.dev/_operator/qualify/actions', { method: 'POST', headers });
  assert.equal((await handleActionsQualification(request({}), target)).status, 401);
  assert.equal(calls, 0);
  assert.equal(writes, 0);
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const issued = Math.floor(Date.now() / 1000);
  target.jwksFetch = async () => Response.json({ keys: [{ ...jwk, kid: 'operator-test', alg: 'RS256' }] });
  const signedToken = identity => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'operator-test' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ type: 'app', sub: '', iss: 'https://access.example', aud: 'audience',
      common_name: identity, iat: issued, exp: issued + 3600 })).toString('base64url');
    return header + '.' + claims + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + claims), keys.privateKey).toString('base64url');
  };
  const signedHeaders = identity => ({ 'CF-Access-Jwt-Assertion': signedToken(identity), 'X-GitFoundry-Expected-Revision': env.GFY_SOURCE_REVISION });
  assert.equal((await handleActionsQualification(request(signedHeaders('other-service')), target)).status, 401);
  assert.equal(calls, 0);
  assert.equal(writes, 0);
  assert.equal((await handleActionsQualification(request(signedHeaders('qualifier')), target)).status, 200);
  const auth = { 'x-gitfoundry-operator-client-id': 'qualifier', 'x-gitfoundry-operator-secret': 'secret', 'X-GitFoundry-Expected-Revision': env.GFY_SOURCE_REVISION };
  assert.equal((await handleActionsQualification(request({ ...auth, 'X-GitFoundry-Expected-Revision': 'b'.repeat(40) }), target)).status, 409);
  const response = await handleActionsQualification(request(auth), target);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).snapshotBucketWriteRead, true);
  assert.equal(store.size, 0);
  for (const bad of [{ backendReady: false }, { image: helperImage }, { generation: 'wrong-generation' }]) {
    backendOverrides = bad;
    const before = writes;
    assert.equal((await handleActionsQualification(request(auth), target)).status, 503);
    assert.equal(writes, before);
  }
  backendOverrides = {};
  const apiFile = join(directory, 'api.mjs');
  await build({ entryPoints: ['apps/api-worker/src/worker.ts'], outfile: apiFile, alias: { '@gitfoundry/contracts': new URL('../packages/contracts/src/index.ts', import.meta.url).pathname }, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'native-workerd-test-shim', setup(builder) {
      builder.onResolve({ filter: /^cloudflare:/ }, args => ({ path: args.path, namespace: 'workerd-shim' }));
      builder.onLoad({ filter: /.*/, namespace: 'workerd-shim' }, () => ({ contents:
        'export class DurableObject {}; export class WorkerEntrypoint {}; export class RpcTarget {}; export class WorkflowEntrypoint {}; export const env={}; export const exports={}; export const ctx={}; export function connect(){throw new Error("unused native socket")}', loader: 'js' }));
    } }] });
  const api = (await import(pathToFileURL(apiFile))).default;
  const before = calls;
  assert.equal((await api.fetch(request({}), target, { waitUntil() {} })).status, 401);
  assert.equal(calls, before);
  assert.equal((await api.fetch(request(signedHeaders('qualifier')), target, { waitUntil() {} })).status, 200);
  corrupt = true;
  assert.equal((await handleActionsQualification(request(auth), target)).status, 503);
  assert.equal(store.size, 0);
});

test('Actions preparation emits private bundle and private secret files while preserving API rollback lifecycle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gfy-actions-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['apps/api-worker/src/linux', 'apps/api-worker/src/actions-github', 'apps/web/dist']) await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, 'apps/api-worker/src/worker.ts'), 'export default {fetch(){return new Response("ok")}}');
  await writeFile(join(root, 'apps/api-worker/src/linux/container-worker.ts'), 'export class TrustedGitHelperPinnedDO {}; export class UntrustedCiJobPinnedDO {}; export default {}');
  await writeFile(join(root, 'apps/api-worker/src/actions-github/container-worker.ts'), 'export class GitHubActionsBackendDO {}; export default {}');
  await writeFile(join(root, 'apps/web/dist/index.html'), 'GitFoundry');
  const commands = [], deployed = { ...remote, containers: [{ class_name: 'TrustedGitHelperDO' }] };
  const prepared = await prepareCfRelease(root, { account_id: 'account', actions: actionsConfig, workers: [{ name: 'api', role: 'api' }] },
    { ...ownerEnv, ...actionsEnv, GFY_FORGE_REVIEW_SIGNING_KEY: 'private-review', GFY_TRUSTED_GIT_HELPER_IMAGE: helperImage, GFY_UNTRUSTED_CI_IMAGE: ciImage },
    async (_command, args) => {
      commands.push(args);
      if (args[1] === 'list') return JSON.stringify([{ name: 'api' }]);
      if (args[1] === 'deployments') return JSON.stringify({ deployments: [{ id: 'old-api', versions: [{ version_id: 'old-version', percentage: 100 }] }] });
      return JSON.stringify(deployed);
    }, () => {});
  assert.deepEqual(prepared.map(worker => worker.role), ['actions', 'linux', 'api']);
  const worker = prepared[0], api = prepared[2];
  const secrets = JSON.parse(await readFile(worker.secrets_file, 'utf8'));
  assert.equal(secrets.GFY_ACTIONS_RSA_PRIVATE_KEY, 'private-rsa');
  assert.equal(secrets.GFY_FORGE_REVIEW_SIGNING_KEY, undefined);
  assert.deepEqual(api.configuration.unsafe.metadata.containers, [{ class_name: 'TrustedGitHelperDO' }]);
  assert.equal(api.configuration.unsafe.metadata.exports, undefined);
  const bundle = await build({ entryPoints: [new URL('../apps/api-worker/src/actions-github/container-worker.ts', import.meta.url).pathname],
    write: false, bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd','worker','browser'],
    mainFields: ['module','main'], target: 'es2022', external: ['cloudflare:*','node:*'], logLevel: 'silent' });
  assert.match(bundle.outputFiles[0].text, /qualifyActionsBackend/);
  assert.match(bundle.outputFiles[0].text, /GitHubActionsBackendDO/);
  assert.ok(commands.every(args => !args.includes('create') && args[0] !== 'deploy'));
});

test('release passes the repository load check only when the canonical repository loads', async () => {
  const { qualifyRepositoryLoad } = await import('./gfy-cloudflare-deploy.mjs');
  const config = { domain: 'https://gitfoundry.dev', qualifier_client_id: 'existing-operator', qualifier_client_secret: 'private-value' };
  const loaded = { repository_id: 'repo-a', head_version_commit: 'b'.repeat(40), code_commit: 'c'.repeat(40), versions: 3, tree_entries: 12 };
  const sent = [];
  const result = await qualifyRepositoryLoad(config, env, async (url, options) => {
    sent.push({ url: String(url), method: options.method, revision: options.headers['X-GitFoundry-Expected-Revision'], client: options.headers['x-gitfoundry-operator-client-id'], accessClient: options.headers['CF-Access-Client-Id'] });
    return Response.json(loaded);
  });
  assert.deepEqual(result, loaded);
  assert.deepEqual(sent, [{ url: 'https://gitfoundry.dev/_operator/qualify/repository', method: 'POST', revision: 'a'.repeat(40), client: 'existing-operator', accessClient: 'existing-operator' }]);
  await assert.rejects(qualifyRepositoryLoad(config, env, async () => Response.json({ error: 'repository_load_failed', stage: 'head', cause: { code: 'trusted_execution_failed', detail: { helper_status: 500 } } }, { status: 503 })),
    error => /repository load check failed at head/.test(error.message) && /trusted_execution_failed/.test(error.message) && !error.message.includes('private-value'));
  await assert.rejects(qualifyRepositoryLoad(config, env, async () => Response.json({ ...loaded, tree_entries: 0 })), /repository load check failed/);
  await assert.rejects(qualifyRepositoryLoad({ domain: config.domain }, env, async () => Response.json(loaded)), /credentials are required/);
});

test('release sets the API to run the site check every five minutes', async () => {
  const { applyApiSchedule } = await import('./gfy-cloudflare-deploy.mjs');
  const sent = [];
  const accepted = async (url, options) => {
    sent.push({ url: String(url), method: options.method, authorization: options.headers.authorization, body: JSON.parse(options.body) });
    return Response.json({ success: true, result: { schedules: [{ cron: '*/5 * * * *', created_on: '2026-10-12T00:00:00Z' }] } });
  };
  assert.deepEqual(await applyApiSchedule({ account_id: 'account-a' }, { CLOUDFLARE_API_TOKEN: 'provider-token' }, 'gitfoundry-api', accepted), { schedules: ['*/5 * * * *'] });
  assert.deepEqual(sent, [{ url: 'https://api.cloudflare.com/client/v4/accounts/account-a/workers/scripts/gitfoundry-api/schedules', method: 'PUT', authorization: 'Bearer provider-token', body: [{ cron: '*/5 * * * *' }] }]);
  await assert.rejects(applyApiSchedule({ account_id: 'account-a' }, { CLOUDFLARE_API_TOKEN: 'provider-token' }, 'gitfoundry-api', async () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 })), /schedule was not applied \(HTTP 403\)/);
  await assert.rejects(applyApiSchedule({ account_id: 'account-a' }, { CLOUDFLARE_API_TOKEN: 'provider-token' }, 'gitfoundry-api', async () => Response.json({ success: true, result: { schedules: [] } })), /schedule was not applied/);
  await assert.rejects(applyApiSchedule({ account_id: 'account-a' }, {}, 'gitfoundry-api', accepted), /requires the account, provider token/);
});
