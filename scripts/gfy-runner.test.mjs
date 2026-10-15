import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, executeLease, importSource, loadConfig, signCanonical, tailAppend, validateLease } from './gfy-runner.mjs';
import { deploy, deploymentEnvironment, loadDeploymentConfig, validateDeploymentIdentity, verifyDeployment } from './gfy-cloudflare-deploy.mjs';
import { cfWorkerConfiguration, deployCfRelease } from './gfy-cf-release.mjs';

const revision = '1234567890abcdef1234567890abcdef12345678';
const version = 'fedcba0987654321fedcba0987654321fedcba09';
const repositoryId = 'repo-' + 'a'.repeat(64);
const keyPair = generateKeyPairSync('ed25519');
const privateJwk = keyPair.privateKey.export({ format: 'jwk' });
const publicJwk = keyPair.publicKey.export({ format: 'jwk' });

function lease() {
  return {
    run_id: 'tests-1',
    kind: 'all-tests',
    tenant_id: 'local',
    repository_id: 'gitfoundry',
    code_commit: revision,
    version_commit: version,
    command: { argv: ['node', 'scripts/test-all.mjs'] },
    lease_generation: 1,
    fence_token: 'fence-1',
    lease_id: 'lease-1',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    checkout: { remote: 'https://gitfoundry.dev/git/gitfoundry', commit: revision, username: 'runner', password: 'checkout-secret', expires_at: new Date(Date.now() + 60000).toISOString() },
  };
}

test('runner accepts only fixed commands and exact source identities', () => {
  assert.deepEqual(validateLease(lease()), ['node', 'scripts/test-all.mjs']);
  assert.throws(() => validateLease({ ...lease(), command: { argv: ['sh', '-c', 'arbitrary'] } }), /unsupported command/);
  assert.throws(() => validateLease({ ...lease(), run_id: '../../private' }), /invalid source/);
  assert.throws(() => validateLease({ ...lease(), code_commit: 'HEAD' }), /invalid source/);
  assert.throws(() => validateLease({ ...lease(), lease_generation: 0 }), /invalid lease/);
  assert.throws(() => validateLease({ ...lease(), expires_at: '2000-01-01T00:00:00Z' }), /expired lease/);
  assert.throws(() => validateLease({ ...lease(), checkout: { ...lease().checkout, remote: 'https://user:pass@gitfoundry.dev/git/gitfoundry' } }), /invalid repository grant/);
});

test('runner completes a real child after renewing its original lease deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-runner-renewal-'));
  let heartbeats = 0, completedReceipt;
  const original = lease();
  original.expires_at = new Date(Date.now() + 1500).toISOString();
  const config = {
    url: 'https://gitfoundry.dev', client_id: 'runner-client', client_secret: 'runner-secret',
    signing_key: privateJwk, state_root: dir, tool_env: { PATH: process.env.PATH },
    fetch: async (url, options) => {
      if (String(url).endsWith('/heartbeat')) {
        heartbeats++;
        return Response.json({ ok: true, lease_expires_at: new Date(Date.now() + 5000).toISOString() });
      }
      assert.ok(String(url).endsWith('/complete'));
      completedReceipt = JSON.parse(options.body).receipt;
      return Response.json({ run: { status: 'completed', conclusion: 'success' } });
    },
  };
  try {
    const result = await executeLease(config, original, {
      heartbeatIntervalMs: 100,
      checkout: async (_config, _lease, work) => {
        await mkdir(join(work, 'scripts'), { recursive: true });
        await writeFile(join(work, 'scripts/test-all.mjs'), "setTimeout(() => console.log('long test completed'), 2300);\n");
      },
    });
    assert.equal(result.run.status, 'completed');
    assert.equal(completedReceipt.exit_code, 0);
    assert.equal(completedReceipt.conclusion, 'success');
    assert.ok(heartbeats >= 10);
    assert.ok(Date.parse(completedReceipt.finished_at) > Date.parse(original.expires_at));
    assert.match(completedReceipt.stdout_tail, /long test completed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runner receipt tails fit the hosted API body limit with multibyte output', () => {
  const text = 'START' + '🔥'.repeat(20000) + 'END';
  const tail = tailAppend('', text);
  assert.ok(Buffer.byteLength(tail, 'utf8') <= 8192);
  assert.ok(tail.endsWith('END'));
  assert.equal(tail.includes('START'), false);
  assert.equal(tail.includes('�'), false);
  const body = JSON.stringify({ receipt: { stdout_tail: tail, stderr_tail: tail }, signature: 'x'.repeat(88), fence_token: 'x'.repeat(128) });
  assert.ok(Buffer.byteLength(body, 'utf8') < 65536);
});

test('runner canonical signatures match the shared sorted JSON payload shape', () => {
  const payload = { z: undefined, b: [{ z: 2, a: 1 }], a: true };
  assert.equal(canonical(payload), '{"a":true,"b":[{"a":1,"z":2}]}');
  const signature = signCanonical(privateJwk, payload, 'base64url');
  assert.equal(verify(null, Buffer.from(canonical(payload)), { key: privateJwk, format: 'jwk' }, Buffer.from(signature, 'base64url')), true);
  assert.throws(() => canonical({ bad: Symbol('nope') }), /unsupported JSON/);
});

test('runner loads private config from 0600 files without embedding signing keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-runner-test-'));
  try {
    const secretFile = join(dir, 'client-secret');
    const keyFile = join(dir, 'signing-key.json');
    const configFile = join(dir, 'config.json');
    await writeFile(secretFile, 'client-private-secret\n', { mode: 0o600 });
    await writeFile(keyFile, JSON.stringify(privateJwk), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ url: 'https://gitfoundry.dev', runner_id: 'runner-1', tenant_id: 'local', repository_id: 'gitfoundry', client_id: 'client-1', client_secret_file: secretFile, signing_key_file: keyFile, work_root: join(dir, 'work') }), { mode: 0o600 });
    const config = await loadConfig(configFile);
    assert.equal(config.client_secret, 'client-private-secret');
    assert.equal(config.signing_key.d, privateJwk.d);
    assert.equal(config.state_root, join(dir, 'work'));
    await writeFile(join(dir, 'bad.json'), JSON.stringify({}), { mode: 0o644 });
    await assert.rejects(loadConfig(join(dir, 'bad.json')), /mode 0600/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('source import uses exact refs, private git auth, and idempotent adopt payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-import-test-'));
  try {
    await mkdir(join(dir, 'repo.git'));
    const calls = [];
    const fetcher = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
      if (String(url).endsWith('/_runner/source/grant')) return Response.json({ remote: 'https://gitfoundry.dev/git/gitfoundry', username: 'runner', password: 'push-secret', ref: 'refs/heads/source-imports/import-1', expires_at: new Date(Date.now() + 60000).toISOString() });
      return Response.json({ version_commit: version, code_commit: revision });
    };
    const commands = [];
    const commandFn = async (executable, args, options) => {
      commands.push({ executable, args, env: options.env });
      assert.equal(args.join(' ').includes('push-secret'), false);
      if (args.includes('rev-parse')) return { stdout: revision + '\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const result = await importSource({ url: 'https://gitfoundry.dev', runner_id: 'runner-1', client_id: 'client-1', client_secret: 'private-client-secret', fetch: fetcher }, { gitDir: join(dir, 'repo.git'), commit: revision, operationId: 'import-1', expectedHead: version, commandFn });
    assert.equal(result.code_commit, revision);
    assert.deepEqual(calls.map(call => call.body.operation_id), ['import-1', 'import-1']);
    assert.equal(calls[1].body.expected_head, version);
    const push = commands.find(call => call.args.includes('push'));
    assert.ok(push.args.includes('--force-with-lease=refs/heads/source-imports/import-1:'));
    assert.ok(commands.some(call => call.args.includes('ls-remote')));
    assert.equal(push.args.at(-1), revision + ':refs/heads/source-imports/import-1');
    assert.equal(String(push.env.GIT_CONFIG_GLOBAL).includes('push-secret'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('source imports use a new Git ref while preserving the separate forge head fence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-source-import-git-'));
  const source = join(dir, 'source.git'), remote = join(dir, 'remote.git');
  const remoteUrl = 'https://gitfoundry.dev/git/source-fixture';
  const ref = 'refs/heads/source-imports/update-1';
  const git = (args, env) => {
    const result = spawnSync('git', args, { encoding: 'utf8', input: '', env: env ?? process.env });
    assert.equal(result.status, 0, result.stderr);
    return { stdout: result.stdout, stderr: result.stderr };
  };
  try {
    git(['init', '--bare', '--template=', source]);
    git(['init', '--bare', '--template=', remote]);
    const tree = git(['--git-dir=' + source, 'mktree']).stdout.trim();
    const commit = message => git(['--git-dir=' + source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@gitfoundry.dev', 'commit-tree', tree, '-m', message]).stdout.trim();
    const firstCommit = commit('first source');
    const adoptions = [], commands = [];
    const config = {
      url: 'https://gitfoundry.dev', runner_id: 'runner-1', client_id: 'client-1', client_secret: 'fixture-secret',
      fetch: async (url, options) => {
        if (String(url).endsWith('/grant')) return Response.json({ remote: remoteUrl, username: 'runner', password: 'fixture-push-secret', ref, expires_at: new Date(Date.now() + 60000).toISOString() });
        adoptions.push(JSON.parse(options.body));
        return Response.json({ version_commit: version, code_commit: firstCommit });
      },
    };
    const commandFn = async (_executable, args, options) => {
      commands.push(args);
      return git(args.map(arg => arg === remoteUrl ? remote : arg), options.env);
    };
    const input = { gitDir: source, commit: firstCommit, operationId: 'update-1', expectedHead: version, commandFn };
    await importSource(config, input);
    assert.equal(git(['--git-dir=' + remote, 'rev-parse', ref]).stdout.trim(), firstCommit);
    assert.equal(adoptions[0].expected_head, version);
    assert.notEqual(firstCommit, version);
    await importSource(config, input);
    assert.equal(commands.filter(args => args.includes('push')).length, 1);
    await assert.rejects(importSource(config, { ...input, commit: commit('different source') }), /ref conflicts/);
    assert.equal(git(['--git-dir=' + remote, 'rev-parse', ref]).stdout.trim(), firstCommit);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deployment refuses missing exact revisions or private provider config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-deploy-config-'));
  try {
    const tokenFile = join(dir, 'cf-token');
    const configFile = join(dir, 'deploy.json');
    await writeFile(tokenFile, 'cf-private-token\n', { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ account_id: 'account-1', api_token_file: tokenFile, api_worker_name: 'api-worker', mcp_worker_name: 'mcp-worker', runner_repository_id: repositoryId, owner_email: 'owner@example.com', owner_subject: 'subject', auth_issuer: 'https://access.example.com', forge_trusted_keys: {}, review_key_id: 'review-1', runner_public_key: publicJwk }), { mode: 0o600 });
    const config = await loadDeploymentConfig(configFile);
    assert.equal(validateDeploymentIdentity(config, { GFY_SOURCE_REVISION: revision }), revision);
    const deployEnv = deploymentEnvironment(config, { GFY_SOURCE_REVISION: revision });
    assert.equal(deployEnv.GFY_RUNNER_PUBLIC_KEY, JSON.stringify(publicJwk));
    assert.equal(deployEnv.GFY_RUNNER_REPOSITORY_ID, repositoryId);
    assert.throws(() => validateDeploymentIdentity(config, { GFY_SOURCE_REVISION: 'HEAD' }), /exact source/);
    await writeFile(join(dir, 'bad-key.json'), JSON.stringify({ account_id: 'account-1', api_token_file: tokenFile, api_worker_name: 'api-worker', runner_repository_id: repositoryId, runner_public_key: { ...publicJwk, d: 'private-part' } }), { mode: 0o600 });
    await assert.rejects(loadDeploymentConfig(join(dir, 'bad-key.json')), /public Ed25519 JWK/);
    await writeFile(join(dir, 'bad-repo.json'), JSON.stringify({ account_id: 'account-1', api_token_file: tokenFile, api_worker_name: 'api-worker', runner_repository_id: 'gitfoundry', runner_public_key: publicJwk }), { mode: 0o600 });
    await assert.rejects(loadDeploymentConfig(join(dir, 'bad-repo.json')), /repo-<sha256>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deployment accepts private Wrangler OAuth auth file and refreshes before mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-wrangler-oauth-'));
  try {
    const authFile = join(dir, 'wrangler-auth.json');
    const configFile = join(dir, 'deploy.json');
    const qualifierFile = join(dir, 'qualifier-secret');
    await writeFile(qualifierFile, 'qualifier-fixture-secret', { mode: 0o600 });
    await writeFile(authFile, JSON.stringify({ type: 'oauth', token: 'old-oauth-token' }), { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ account_id: 'account-1', provider_auth_file: authFile, api_worker_name: 'api-worker', runner_repository_id: repositoryId, log_root: join(dir, 'logs'), runner_public_key: publicJwk, qualifier_client_id: 'qualifier-fixture-client', qualifier_client_secret_file: qualifierFile }), { mode: 0o600 });
    const config = await loadDeploymentConfig(configFile);
    assert.equal(config.api_token, 'old-oauth-token');
    const executed = [];
    const execute = async (executable, args) => {
      executed.push([executable, ...args]);
      if (executable === 'wrangler') return JSON.stringify({ type: 'oauth', token: 'new-oauth-token' });
      if (args.includes('rev-parse')) return revision + '\n';
      return '';
    };
    await assert.rejects(deploy({ GFY_DEPLOY_CONFIG_FILE: configFile, GFY_SOURCE_REVISION: revision, GFY_ACTION_RUN_ID: 'deploy-1' }, { execute, finalDeployAdmission: async () => { throw new Error('deployment admission denied by GitFoundry'); } }), /admission denied/);
    assert.deepEqual(executed.map(command => command.join(' ')), [
      'wrangler auth token --json',
      'git rev-parse HEAD^{commit}',
      'pnpm install --frozen-lockfile',
      'pnpm -r build',
      'worker-build --release --no-opt --out-dir ../../target/p0-remote-worker-build crates/mcp-worker --locked',
    ]);
    assert.deepEqual(JSON.parse(await readFile(authFile, 'utf8')), { type: 'oauth', token: 'new-oauth-token' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deployment readback verifies every active version binding, not settings', async () => {
  const config = { account_id: 'example-account', api_token: 'private-fixture-token', domain: 'https://gitfoundry.dev', runner_public_key: JSON.stringify(publicJwk), runner_repository_id: repositoryId, workers: [{ name: 'api-worker', role: 'api', domain: 'https://gitfoundry.dev' }, { name: 'mcp-worker', role: 'mcp', domain: 'https://mcp.gitfoundry.dev' }] };
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push([String(url), options.headers.authorization]);
    if (String(url).endsWith('/deployments')) return Response.json({ success: true, result: { deployments: [{ id: 'deployment-1', versions: [{ version_id: 'worker-version-1', percentage: 60 }, { version_id: 'worker-version-2', percentage: 40 }] }] } });
    return Response.json({ success: true, result: { resources: { bindings: [{ name: 'GFY_SOURCE_REVISION', text: revision }] } } });
  };
  const receipt = await verifyDeployment(config, { GFY_SOURCE_REVISION: revision }, fetcher);
  assert.equal(receipt.source_revision, revision);
  assert.equal(receipt.workers.length, 2);
  assert.equal(receipt.workers[0].deployment_id, 'deployment-1');
  assert.equal(requests.length, 6);
  assert.ok(requests.every(([url, auth]) => url.startsWith('https://api.cloudflare.com/client/v4/accounts/example-account/workers/scripts/') && auth === 'Bearer private-fixture-token'));
  assert.ok(requests.some(([url]) => url.endsWith('/versions/worker-version-1')));
  await assert.rejects(verifyDeployment(config, { GFY_SOURCE_REVISION: revision }, async url => Response.json({ success: true, result: String(url).endsWith('/deployments') ? { deployments: [{ id: 'bad', versions: [{ version_id: 'v1', percentage: 100 }] }] } : { resources: { bindings: [{ name: 'GFY_SOURCE_REVISION', text: version }] } } })), /version source revision mismatch/);
  await assert.rejects(verifyDeployment(config, { GFY_SOURCE_REVISION: revision }, async url => Response.json({ success: true, result: String(url).endsWith('/deployments') ? { deployments: [{ id: 'bad', versions: [{ version_id: 'v1', percentage: 20 }] }] } : { resources: { bindings: [{ name: 'GFY_SOURCE_REVISION', text: revision }] } } })), /receipt missing/);
});

test('deployment final admission denial prevents Cloudflare mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-final-admission-'));
  try {
    const tokenFile = join(dir, 'cf-token');
    const configFile = join(dir, 'deploy.json');
    const qualifierFile = join(dir, 'qualifier-secret');
    await writeFile(qualifierFile, 'qualifier-fixture-secret', { mode: 0o600 });
    await writeFile(tokenFile, 'cf-private-token\n', { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ account_id: 'account-1', api_token_file: tokenFile, api_worker_name: 'api-worker', runner_repository_id: repositoryId, log_root: join(dir, 'logs'), runner_public_key: publicJwk, qualifier_client_id: 'qualifier-fixture-client', qualifier_client_secret_file: qualifierFile }), { mode: 0o600 });
    const executed = [];
    const execute = async (executable, args) => {
      executed.push([executable, ...args]);
      if (args.includes('rev-parse')) return revision + '\n';
      return '';
    };
    await assert.rejects(deploy({ GFY_DEPLOY_CONFIG_FILE: configFile, GFY_SOURCE_REVISION: revision, GFY_ACTION_RUN_ID: 'deploy-1' }, { execute, finalDeployAdmission: async () => { throw new Error('deployment admission denied by GitFoundry'); } }), /admission denied/);
    assert.deepEqual(executed.map(command => command.join(' ')), [
      'git rev-parse HEAD^{commit}',
      'pnpm install --frozen-lockfile',
      'pnpm -r build',
      'worker-build --release --no-opt --out-dir ../../target/p0-remote-worker-build crates/mcp-worker --locked',
    ]);
    assert.equal(executed.some(command => command[0] === 'cf'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cf release preserves native resource identities without exposing signing secrets', () => {
  const configuration = cfWorkerConfiguration({ name: 'api-worker', role: 'api' }, {
    compatibility_date: '2026-10-07', compatibility_flags: ['nodejs_compat'],
    bindings: [
      { name: 'GFY_SOURCE_REVISION', type: 'plain_text', text: 'old' },
      { name: 'GFY_GIT', type: 'artifacts', namespace: 'retained-git' },
      { name: 'TRUSTED_GIT_HELPER', type: 'durable_object_namespace', namespace_id: 'retained-namespace', class_name: 'TrustedGitHelperDO' },
      { name: 'GFY_DB', type: 'd1', id: 'retained-database', database_id: 'retained-database' },
      { name: 'GFY_QUALIFIER_CLIENT_SECRET', type: 'secret_text' }, { name: 'ASSETS', type: 'assets' }
    ], containers: [{ class_name: 'TrustedGitHelperDO' }]
  }, {
    GFY_SOURCE_REVISION: revision, GFY_OWNER_ACCESS_SUBJECT: 'observed-owner', GFY_OWNER_EMAIL: 'owner@example.com',
    GFY_AUTH_ISSUER: 'https://owner.cloudflareaccess.com', GFY_FORGE_TRUSTED_KEYS: '{}', GFY_FORGE_REVIEW_KEY_ID: 'reviewer',
    GFY_RUNNER_PUBLIC_KEY: JSON.stringify(publicJwk), GFY_RUNNER_REPOSITORY_ID: repositoryId, GFY_FORGE_REVIEW_SIGNING_KEY: 'private-signing-key'
  });
  assert.deepEqual(configuration.env.GFY_GIT, { type: 'unsafe:artifacts', namespace: 'retained-git' });
  assert.deepEqual(configuration.env.TRUSTED_GIT_HELPER, { type: 'unsafe:durable_object_namespace', namespace_id: 'retained-namespace', class_name: 'TrustedGitHelperDO' });
  assert.deepEqual(configuration.env.GFY_DB, { type: 'd1', id: 'retained-database' });
  assert.deepEqual(configuration.env.GFY_FORGE_REVIEW_SIGNING_KEY, { type: 'secret' });
  assert.equal(JSON.stringify(configuration).includes('private-signing-key'), false);
  assert.deepEqual(configuration.unsafe.metadata.keep_bindings, ['secret_text', 'secret_key']);
  assert.equal(configuration.env.GFY_SOURCE_REVISION.value, revision);
});

test('cf release verifies staged source and renewed admission before switching traffic', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const prepared = [{ name: 'api-worker', role: 'api', project: '/private/api', secrets_file: '/private/api/secrets.json', previous_deployment_id: 'before' }];
  const calls = [];
  const uploaded = [];
  const execute = async (_command, args) => {
    calls.push(args);
    if (args[1] === 'versions' && args[2] === 'list') return JSON.stringify(uploaded);
    if (args[1] === 'versions' && args[2] === 'create') {
      uploaded.push({ id: id.replace(/.$/, String(uploaded.length + 1)), annotations: { 'workers/tag': args[args.indexOf('--tag') + 1] } });
      return 'Upload complete';
    }
    if (args[1] === 'versions' && args[2] === 'get') return JSON.stringify({ bindings: [{ name: 'GFY_SOURCE_REVISION', text: revision }] });
    if (args[1] === 'deployments' && args[2] === 'list') return JSON.stringify({ deployments: [{ id: 'before' }] });
    return '{}';
  };
  let admissions = 0;
  await assert.rejects(deployCfRelease(prepared, { GFY_SOURCE_REVISION: revision }, execute, async () => {
    if (++admissions === 2) throw new Error('lease cancelled');
  }, null), /lease cancelled/);
  assert.equal(calls.some(args => args[1] === 'deployments' && args[2] === 'create'), false);
  calls.length = 0;
  await assert.rejects(deployCfRelease(prepared, { GFY_SOURCE_REVISION: version }, execute, async () => {}, null), /source revision mismatch/);
  assert.equal(calls.some(args => args[1] === 'deployments' && args[2] === 'create'), false);
});

test('deployment runner credentials are paired, private, and forwarded to Worker bindings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-deploy-runner-auth-'));
  try {
    const tokenFile = join(dir, 'provider-token');
    const secretFile = join(dir, 'runner-secret');
    const configFile = join(dir, 'deployment.json');
    await writeFile(tokenFile, 'provider-fixture', { mode: 0o600 });
    await writeFile(secretFile, 'runner-fixture-secret', { mode: 0o600 });
    const base = { account_id: 'account-1', api_token_file: tokenFile, api_worker_name: 'api-worker', runner_repository_id: repositoryId, runner_public_key: publicJwk };
    const writeConfig = async (extra) => writeFile(configFile, JSON.stringify({ ...base, ...extra }), { mode: 0o600 });
    await writeConfig({ runner_client_id: 'runner-client', runner_client_secret_file: secretFile });
    const config = await loadDeploymentConfig(configFile);
    const env = deploymentEnvironment(config, { GFY_SOURCE_REVISION: revision });
    assert.equal(env.GFY_RUNNER_CLIENT_ID, 'runner-client');
    assert.equal(env.GFY_RUNNER_CLIENT_SECRET, 'runner-fixture-secret');
    await writeConfig({ runner_client_id: 'runner-client' });
    await assert.rejects(loadDeploymentConfig(configFile), /runner credentials must be paired/);
    await writeConfig({ runner_client_secret_file: secretFile });
    await assert.rejects(loadDeploymentConfig(configFile), /runner credentials must be paired/);
    await writeConfig({ runner_client_id: 'runner-client', runner_client_secret_file: secretFile });
    await chmod(secretFile, 0o644);
    await assert.rejects(loadDeploymentConfig(configFile), /runner client secret file must be mode 0600/);
    await chmod(secretFile, 0o600);
    await writeFile(secretFile, '');
    await assert.rejects(loadDeploymentConfig(configFile), /runner client secret must be nonempty/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
