#!/usr/bin/env node
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { makeLocalForgeRunner } from './local-forge-runner.mjs';
import { configureLocalToolchainEnvironment } from './local-toolchain-env.mjs';

await configureLocalToolchainEnvironment();
import { chmod, readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, randomBytes, createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.GFY_LOCAL_SOURCE_ROOT || root);
const webRoot = resolve(root, 'apps/web/dist');
const dataRoot = resolve(process.env.GFY_LOCAL_DATA || resolve(root, '.local/gitfoundry'));
const gitRoot = resolve(dataRoot, 'repositories');
const port = Number(process.env.PORT || 4177);
const origin = 'http://127.0.0.1:' + port;
const tenant = 'local';
const issuer = 'https://gitfoundry.local';
const audience = 'gitfoundry-local';
const localDemoAgents = ['local-demo-agent-a', 'local-demo-agent-b'];
const run = promisify(execFile);
await mkdir(gitRoot, { recursive: true });
const sqlite = new DatabaseSync(resolve(process.env.GFY_LOCAL_DATABASE || resolve(dataRoot, 'gitfoundry.sqlite')));
sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'tenants'").get()) {
  sqlite.exec(await readFile(resolve(root, 'docs/source/handoff/contracts/schema.sql'), 'utf8'));
}
sqlite.exec(await readFile(resolve(root, 'infra/migrations/0008_resource_events.sql'), 'utf8'));
// Sign-in uses workspace grants and email-code sessions, the same as production.
for (const [table, migration] of [['owner_access_grants', '0007_owner_access.sql'], ['auth_browser_sessions', '0012_email_sign_in.sql']]) {
  if (!sqlite.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(table)) sqlite.exec(await readFile(resolve(root, 'infra/migrations', migration), 'utf8'));
}
const now = new Date().toISOString();
const insert = (sql, ...args) => sqlite.prepare(sql).run(...args);
sqlite.exec('BEGIN');
try {
  insert('INSERT OR IGNORE INTO tenants VALUES(?,?,?,?,?,?,?)', tenant, tenant, 'active', 1, 'local', 'US', '{}');
  insert('INSERT OR IGNORE INTO principals VALUES(?,?,?,?,?,?,?,?,?)', tenant, 'local-owner', 1, now, now, 'human', 'Local developer', 1, 1);
  const capabilities = ['forge.read', 'forge.compare', 'forge.initialize', 'forge.fork', 'forge.commit', 'forge.merge', 'forge.publish', 'forge.recover', 'identity.read', 'repository.read', 'repository.write', 'issue.read', 'issue.write', 'pull_request.read', 'pull_request.write', 'comment.read', 'comment.write', 'review.read', 'review.write', 'check.read', 'check.write', 'operation.read'];
  insert('INSERT OR IGNORE INTO roles VALUES(?,?,?,?,?,?,?)', tenant, 'local-owner', 1, now, now, 'Local owner', JSON.stringify(capabilities));
  insert('UPDATE roles SET capabilities_json = ? WHERE tenant_id = ? AND id = ?', JSON.stringify(capabilities), tenant, 'local-owner');
  const workspaceGrant = principal => insert('INSERT OR IGNORE INTO owner_access_grants(tenant_id,id,principal_id,resource_kind,resource_id,role_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)', tenant, 'workspace-' + principal, principal, 'tenant', tenant, 'local-owner', '2999-01-01T00:00:00.000Z', now);
  workspaceGrant('local-owner');
  for (const agent of localDemoAgents) {
    insert('INSERT OR IGNORE INTO principals VALUES(?,?,?,?,?,?,?,?,?)', tenant, agent, 1, now, now, 'job', agent.replaceAll('-', ' '), 1, 1);
    insert('UPDATE principals SET kind = ?, display_name = ?, active = ?, auth_epoch = ? WHERE tenant_id = ? AND id = ?', 'job', agent.replaceAll('-', ' '), 1, 1, tenant, agent);
    workspaceGrant(agent);
  }
  insert('INSERT OR IGNORE INTO organization_namespaces VALUES(?,?,?,?,?,?,?)', tenant, 'core', 1, now, now, 'core', 'Local examples');
  insert('INSERT OR IGNORE INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', tenant, 'example', 1, now, now, 'core', 'example', 'private', 'code', 0, tenant, 'core--example', null);
  insert("UPDATE repositories SET default_branch = ? WHERE tenant_id = ? AND id = ? AND default_branch = 'main'", 'code', tenant, 'example');
  insert('INSERT OR IGNORE INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', tenant, 'gitfoundry', 1, now, now, 'core', 'gitfoundry', 'private', 'code', 0, tenant, 'core--gitfoundry', null);
  sqlite.exec('COMMIT');
} catch (error) {
  sqlite.exec('ROLLBACK');
  throw error;
}

function prepared(sql, values = []) {
  const statement = sqlite.prepare(sql);
  return {
    bind: (...args) => prepared(sql, args),
    first: async () => statement.get(...values) || null,
    all: async () => ({ results: statement.all(...values), success: true }),
    run: async () => {
      const result = statement.run(...values);
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    }
  };
}

// Bundle the production API in memory with local base-class adapters; private Cloudflare DO bindings are unavailable here.
console.error('GitFoundry startup: bundling API');
const { rolldown } = await import(pathToFileURL(resolve(root, 'node_modules/.pnpm/node_modules/rolldown/dist/index.mjs')));
const apiPath = resolve(root, 'apps/api-worker/src/index.ts');
const bundle = await rolldown({
  input: 'gitfoundry-local-entry',
  platform: 'node',
  plugins: [{
    name: 'local-worker-entry',
    resolveId(id) {
      if (id === 'gitfoundry-local-entry' || id === 'cloudflare:workers') return '\0' + id;
    },
    load(id) {
      if (id === '\0cloudflare:workers') return 'export class WorkerEntrypoint {} export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
      if (id === '\0gitfoundry-local-entry') return 'export { default as api } from ' + JSON.stringify(apiPath) + '; export { makeGitCliSourceRead } from ' + JSON.stringify(resolve(root, 'apps/api-worker/src/source-read.ts')) + '; export { makeGitCliForgePort } from ' + JSON.stringify(resolve(root, 'apps/api-worker/src/fork-forge/git-cli.ts')) + '; export { makeForgeService, canonicalJson } from ' + JSON.stringify(resolve(root, 'packages/core/src/fork-forge/index.ts')) + '; export { verifyPublicationEvidence, canonicalPublicationEvidencePayload, configurationReviewFor } from ' + JSON.stringify(resolve(root, 'apps/api-worker/src/fork-forge/evidence.ts')) + '; export * as Effect from ' + JSON.stringify(resolve(root, 'apps/api-worker/node_modules/effect/dist/Effect.js')) + ';';
    }
  }]
});
const output = await bundle.generate({ format: 'es', codeSplitting: false });
await bundle.close();
const chunk = output.output.find(item => item.type === 'chunk');
if (!chunk) throw new Error('API bundle missing');
const { api, Effect, makeGitCliSourceRead, makeGitCliForgePort, makeForgeService, canonicalJson, verifyPublicationEvidence, canonicalPublicationEvidencePayload, configurationReviewFor } = await import('data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64')).catch(error => { console.error('LOCAL_BUNDLE_ERROR: ' + error.message); process.exit(1); });

// Local principals sign in with the same sessions gfy login creates, valid for thirty days.
function token(subject = 'local-owner') {
  const value = 'gfys_' + randomBytes(32).toString('base64url');
  insert('INSERT INTO auth_browser_sessions(token_hash,email,tenant_id,principal_id,created_at,expires_at) VALUES(?,?,?,?,?,?)', createHash('sha256').update(value).digest('hex'), subject + '@gitfoundry.local', tenant, subject, new Date().toISOString(), new Date(Date.now() + 30 * 86_400_000).toISOString());
  return value;
}
const credentialRoot = resolve(dataRoot, 'credentials');
await mkdir(credentialRoot, { recursive: true, mode: 0o700 });
const localCredentialFiles = Object.fromEntries(await Promise.all(localDemoAgents.map(async agent => {
  const path = resolve(credentialRoot, agent + '.jwt');
  await writeFile(path, token(agent), { mode: 0o600 });
  await chmod(path, 0o600);
  return [agent, path];
})));

const ownerTokenFile = resolve(credentialRoot, 'local-owner.jwt');
const ownerSession = token();
await writeFile(ownerTokenFile, ownerSession, { mode: 0o600 });
await chmod(ownerTokenFile, 0o600);
const locatorFile = resolve(process.env.GFY_LOCAL_INSTANCE_FILE || resolve(homedir(), '.local/share/gitfoundry/local-instance.json'));
await mkdir(dirname(locatorFile), { recursive: true, mode: 0o700 });
await writeFile(locatorFile, JSON.stringify({ url: origin, data_root: dataRoot, source_root: sourceRoot, tenant, owner_token_file: ownerTokenFile }), { mode: 0o600 });

const gitUrlBase = pathToFileURL(gitRoot).href;
const localSourceRead = makeGitCliSourceRead({
  cursorSecret: randomBytes(32).toString('hex'),
  resolveRepository: async ({ tenantId, repositoryId }) => {
    const row = sqlite.prepare('SELECT artifacts_namespace, artifacts_name FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1').get(tenantId, repositoryId);
    if (!row || row.artifacts_namespace !== tenantId || typeof row.artifacts_name !== 'string' || !/^[A-Za-z0-9_.-]{1,255}$/.test(row.artifacts_name)) throw new Error('Local repository unavailable');
    const gitDir = resolve(gitRoot, tenantId, row.artifacts_name + '.git');
    if (!gitDir.startsWith(resolve(gitRoot, tenantId) + sep) || !existsSync(gitDir)) throw new Error('Local repository unavailable');
    return { gitDir };
  },
  git: { run: async (gitDir, args, options) => {
    try {
      const result = await run('git', ['--git-dir=' + gitDir, ...args], { encoding: 'buffer', maxBuffer: options?.maxBuffer || 1024 * 1024 });
      return { stdout: new Uint8Array(result.stdout) };
    } catch (error) {
      if (error && error.stdout instanceof Buffer) return { stdout: new Uint8Array(error.stdout), truncated: true };
      throw error;
    }
  } }
});

async function nativeForgeGit({ arg, stdin, env: overrides = [] }) {
  const childEnv = { PATH: process.env.PATH, HOME: dataRoot, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const entry of overrides) { const at = entry.indexOf('='); if (at < 1) throw new Error('Invalid Git environment'); childEnv[entry.slice(0, at)] = entry.slice(at + 1); }
  return new Promise((finish, reject) => {
    const child = spawn('git', arg, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let size = 0;
    child.on('error', reject);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => { size += chunk.length; if (size > 128 * 1024 * 1024) { child.kill('SIGKILL'); reject(new Error('Git output bound exceeded')); } else chunks.push(chunk); });
    child.on('close', exitCode => finish({ exitCode: exitCode ?? 1, stdout: new Uint8Array(Buffer.concat(stdout)), stderr: new Uint8Array(Buffer.concat(stderr)) }));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(stdin);
  });
}
console.error('GitFoundry startup: preserving source history');
const selfGitDir = resolve(gitRoot, tenant, 'core--gitfoundry.git');
await mkdir(dirname(selfGitDir), { recursive: true });
if (!existsSync(selfGitDir)) await run('git', ['clone', '--mirror', sourceRoot, selfGitDir], { env: { PATH: process.env.PATH, HOME: dataRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
const localForgePorts = new Map();
const localForgeDirectories = new Map();
function localForgePort({ tenantId, repositoryId }) {
  const key = JSON.stringify([tenantId, repositoryId]);
  if (localForgePorts.has(key)) return localForgePorts.get(key);
  const row = sqlite.prepare('SELECT artifacts_namespace, artifacts_name FROM repositories WHERE tenant_id = ? AND id = ? AND archived = 0 LIMIT 1').get(tenantId, repositoryId);
  if (!row || row.artifacts_namespace !== tenantId || !/^[A-Za-z0-9_.-]{1,255}$/.test(row.artifacts_name)) return undefined;
  const gitDir = resolve(gitRoot, tenantId, row.artifacts_name + '.git');
  if (!gitDir.startsWith(resolve(gitRoot, tenantId) + sep) || !existsSync(gitDir)) return undefined;
  const gitPort = makeGitCliForgePort({ gitDir, indexDir: dataRoot, run: nativeForgeGit, ...(repositoryId === 'gitfoundry' ? { maxFileBytes: 64 * 1024 * 1024, maxChangeBytes: 64 * 1024 * 1024 } : {}) });
  localForgePorts.set(key, gitPort);
  localForgeDirectories.set(key, gitDir);
  return gitPort;
}


console.error('GitFoundry startup: configuring local signing');
const signingRoot = resolve(dataRoot, 'signing');
await mkdir(signingRoot, { recursive: true, mode: 0o700 });
async function localSigningKey(name) {
  const path = resolve(signingRoot, name + '.jwk.json');
  if (!existsSync(path)) {
    const pair = generateKeyPairSync('ed25519');
    await writeFile(path, JSON.stringify(pair.privateKey.export({ format: 'jwk' })), { mode: 0o600, flag: 'wx' });
  }
  const privateJwk = JSON.parse(await readFile(path, 'utf8'));
  const privateKey = createPrivateKey({ key: privateJwk, format: 'jwk' });
  return { privateKey, publicJwk: createPublicKey(privateKey).export({ format: 'jwk' }) };
}
const checkSigningKey = await localSigningKey('check-runner');
const reviewSigningKey = await localSigningKey('reviewer');
const localTrustedKeys = { 'local-check-runner': checkSigningKey.publicJwk, 'local-reviewer': reviewSigningKey.publicJwk };

const env = {
  GFY_FORK_ONLY: true,
  GFY_FORGE_GIT: localForgePort,

  GFY_FORGE_VERIFY_EVIDENCE: async context => {
    const git = localForgePort({ tenantId: context.tenant_id, repositoryId: context.repository_id });
    if (!git) throw new Error('Local forge unavailable');
    await verifyPublicationEvidence({ git, trustedKeys: localTrustedKeys, context });
  },
  GFY_FORGE_SIGN_REVIEW: async context => {
    const git = localForgePort({ tenantId: context.tenant_id, repositoryId: context.repository_id });
    const configuration = await configurationReviewFor(git, context);
    const bytes = await git.readFile(configuration?.policyStateCommit ?? context.parent.descriptor.state_commit, 'config/publication.json');
    if (!bytes) throw new Error('Review policy unavailable');
    const policy = JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'));
    const record = {
      schema_version: 1, kind: 'review', id: context.record.id,
      candidate_code_commit: context.parent.descriptor.code_commit,
      evaluator_digest: policy.evaluator_digest,
      decision: context.record.decision, actor_id: context.actor.id,
      actor_kind: context.actor.kind, key_id: 'local-reviewer',
      ...(configuration ? { configuration: configuration.configuration } : {})
    };
    if (record.decision !== 'approve' && record.decision !== 'reject') throw new Error('Review decision invalid');
    return { ...record, signature: sign(null, Buffer.from(canonicalPublicationEvidencePayload(record)), reviewSigningKey.privateKey).toString('base64') };
  },

  GFY_AUTH_ISSUER: issuer,
  GFY_AUTH_AUDIENCE: audience,
  GFY_AUTH_JWKS_URL: issuer + '/jwks',
  GFY_DB: { prepare: prepared },
  GFY_GIT_URL_BASE: gitUrlBase,
  GFY_SOURCE_READ: localSourceRead,
  GFY_GIT_PROVISIONER: {
    provisionRepository: input => Effect.promise(async () => {
      for (const value of [input.tenantId, input.namespaceId, input.name]) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value)) throw new Error('Invalid local Git path');
      }
      const name = input.namespaceId + '--' + input.name;
      const parent = resolve(gitRoot, input.tenantId);
      const repository = resolve(parent, name + '.git');
      await mkdir(parent, { recursive: true });
      if (!existsSync(repository)) await run('git', ['init', '--bare', '--initial-branch=' + input.defaultBranch, repository]);
      const result = await run('git', ['--git-dir=' + repository, 'rev-parse', '--is-bare-repository']);
      if (result.stdout.trim() !== 'true') throw new Error('Local repository is not bare');
      return { gitUrl: pathToFileURL(repository).href, artifactsNamespace: input.tenantId, artifactsName: name };
    })
  }
};
console.error('GitFoundry startup: initializing sample forge');
const exampleGitDir = resolve(gitRoot, tenant, 'core--example.git');
await mkdir(dirname(exampleGitDir), { recursive: true });
if (!existsSync(exampleGitDir)) await run('git', ['init', '--bare', '--initial-branch=code', exampleGitDir]);


await run('git', ['--git-dir=' + exampleGitDir, 'symbolic-ref', 'HEAD', 'refs/heads/code']);
const exampleForgePort = localForgePort({ tenantId: tenant, repositoryId: 'example' });
if (!(await exampleForgePort.readRef('refs/heads/forge-head'))) {
  const actor = { id: 'local-owner', kind: 'human' };
  const files = {
    'README.md': '# Sample project\n\nThe forge lives in the repository.\n',
    'api.mjs': 'export const response = () => ({ message: "hello" });\n',
    'client.mjs': 'import { response } from "./api.mjs";\nexport const greeting = () => response().message;\n',
    'behavior.test.mjs': 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greeting } from "./client.mjs";\ntest("client understands API response", () => assert.equal(greeting(), "hello"));\n'
  };

  const evaluator = {
    schema_version: 1,
    command: ['node', '--test', 'behavior.test.mjs'],
    files: ['behavior.test.mjs'],
    runtime: 'local-native-owner',
    check_id: 'behavior'
  };
  const evaluatorDigest = 'sha256:' + createHash('sha256').update(canonicalJson({ command: evaluator.command, runtime: evaluator.runtime, files: { 'behavior.test.mjs': Buffer.from(files['behavior.test.mjs']).toString('base64') } })).digest('hex');
  const publicationPolicy = {
    schema_version: 1, evaluator_digest: evaluatorDigest,
    checks: [{ id: 'behavior', actor_ids: ['local-check-runner'], actor_kinds: ['service'], key_ids: ['local-check-runner'] }],
    reviews: { required_approvals: 1, trusted_reviewer_ids: ['local-owner'], actor_kinds: ['human'], key_ids: ['local-reviewer'] }
  };
  const initialState = [
    ['config/evaluator.json', evaluator], ['config/publication.json', publicationPolicy], ['config/trusted-keys.json', localTrustedKeys]
  ].map(([path, value]) => ({ path, content_base64: Buffer.from(JSON.stringify(value)).toString('base64') }));

  const code = await exampleForgePort.writeCommit({ base: null, parents: [], author: { name: 'Local developer', email: 'local-owner@gitfoundry.local' }, timestamp: now, message: 'Start sample forkable forge', changes: Object.entries(files).map(([path, text]) => ({ path, content_base64: Buffer.from(text).toString('base64') })) });
  const service = makeForgeService({ git: exampleForgePort, tenant_id: tenant, repository_id: 'example', clock: () => now, authorize: async () => {}, verifyEvidence: async () => { throw new Error('Trusted verifier unavailable'); } });
  await service.initialize({ operation_id: 'local-sample-initialize', code_commit: code, actor, initial_state: initialState });
}


async function configuredEvaluator(git, codeCommit, stateCommit = null) {
  const encoded = await git.readFile(stateCommit || codeCommit, stateCommit ? 'config/evaluator.json' : '.forge/evaluator.json');
  if (!encoded) return null;
  const evaluator = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (evaluator.schema_version !== 1 || !Array.isArray(evaluator.command) || !evaluator.command.length || !Array.isArray(evaluator.files) || !evaluator.files.length || evaluator.runtime !== 'local-native-owner') throw new Error('Local evaluator configuration invalid');
  const files = {};
  for (const path of evaluator.files) {
    if (typeof path !== 'string') throw new Error('Local evaluator file invalid');
    const content = await git.readFile(codeCommit, path);
    if (content === null) throw new Error('Local evaluator file missing: ' + path);
    files[path] = content;
  }
  const evaluatorDigest = 'sha256:' + createHash('sha256').update(canonicalJson({ command: evaluator.command, runtime: evaluator.runtime, files })).digest('hex');
  return { evaluator, evaluatorDigest };
}

async function initialLocalState({ code_commit, git }) {
  const configured = code_commit && await configuredEvaluator(git, code_commit);
  if (!configured) return [];
  const encodedPolicy = await git.readFile(code_commit, '.forge/publication.json');
  if (!encodedPolicy) throw new Error('Repository publication configuration missing');
  const policy = { ...JSON.parse(Buffer.from(encodedPolicy, 'base64').toString('utf8')), evaluator_digest: configured.evaluatorDigest };
  return [['config/evaluator.json', configured.evaluator], ['config/publication.json', policy], ['config/trusted-keys.json', localTrustedKeys]].map(([path, value]) => ({ path, content_base64: Buffer.from(JSON.stringify(value)).toString('base64') }));
}

async function signLocalRun({ record, parent, git }) {
  if (record.status !== 'finished' || !Number.isInteger(record.exit_code)) return null;
  const authorityCommit = await git.readRef('refs/heads/forge-head');
  if (!authorityCommit) return null;
  const authorityFile = await git.readFile(authorityCommit, 'forge.json');
  if (!authorityFile) return null;
  const authority = JSON.parse(Buffer.from(authorityFile, 'base64').toString('utf8'));
  const configured = await configuredEvaluator(git, record.code_commit, authority.state_commit);
  if (!configured || canonicalJson(record.command) !== canonicalJson(configured.evaluator.command)) return null;
  const policyBytes = await git.readFile(authority.state_commit, 'config/publication.json');
  if (!policyBytes) return null;
  const policy = JSON.parse(Buffer.from(policyBytes, 'base64').toString('utf8'));
  const id = configured.evaluator.check_id;
  const required = policy.checks?.find(check => check.id === id);
  if (!required?.actor_ids?.includes('local-check-runner') || !required?.key_ids?.includes('local-check-runner')) throw new Error('Local evaluator is not trusted by publication policy');
  const recordToSign = { schema_version: 1, kind: 'check', id, candidate_code_commit: record.code_commit, evaluator_digest: policy.evaluator_digest, actor_id: 'local-check-runner', actor_kind: 'service', key_id: 'local-check-runner', outcome: record.exit_code === 0 && configured.evaluatorDigest === policy.evaluator_digest ? 'passed' : 'failed', run_id: record.run_id, runner_runtime: { kind: 'local-native-owner', node: process.version, platform: process.platform, arch: process.arch }, ...(configured.evaluatorDigest !== policy.evaluator_digest ? { reason: 'evaluator_changed' } : {}) };
  return { ...recordToSign, signature: sign(null, Buffer.from(canonicalPublicationEvidencePayload(recordToSign)), checkSigningKey.privateKey).toString('base64') };
}

console.error('GitFoundry startup: attaching local runner');
const localRunner = makeLocalForgeRunner({
  root: sourceRoot, dataRoot, gitForRepository: localForgePort, initialStateForRepository: initialLocalState, signRunEvidence: signLocalRun,
  gitDirForRepository: identity => {
    if (!localForgePort(identity)) throw new Error('Local repository unavailable');
    return localForgeDirectories.get(JSON.stringify([identity.tenantId, identity.repositoryId]));
  },
  initialCodeForRepository: async ({ repositoryId }) => repositoryId === 'gitfoundry' ? (await run('git', ['--git-dir=' + selfGitDir, 'rev-parse', 'HEAD'])).stdout.trim() : null,
  forgeForRepository: ({ tenantId, repositoryId }) => {
    const git = localForgePort({ tenantId, repositoryId });
    if (!git) throw new Error('Local repository unavailable');
    return makeForgeService({ git, tenant_id: tenantId, repository_id: repositoryId, clock: () => new Date().toISOString(),
      authorize: async ({ actor }) => { if (!['local-owner', 'local-check-runner'].includes(actor.id)) throw new Error('Local runner actor denied'); },
      verifyEvidence: context => verifyPublicationEvidence({ git, trustedKeys: localTrustedKeys, context }) });
  }
});

async function snapshotWebAssets(directory, assets = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await snapshotWebAssets(path, assets);
    else if (entry.isFile()) assets.set(path, await readFile(path));
  }
  return assets;
}
const webAssets = await snapshotWebAssets(webRoot);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    // Development identity is available only on loopback and same-origin requests.
    if (request.headers.host !== '127.0.0.1:' + port && request.headers.host !== 'localhost:' + port) {
      response.writeHead(403).end('Invalid local host');
      return;
    }
    if (request.headers.origin && request.headers.origin !== origin && request.headers.origin !== 'http://localhost:' + port) {
      response.writeHead(403).end('Invalid local origin');
      return;
    }
    const url = new URL(request.url || '/', origin);
    if (url.pathname.startsWith('/_local/') || url.pathname.startsWith('/api/') || url.pathname === '/health') {
      const chunks = [];
      let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > 1024 * 1024) { response.writeHead(413).end('Request too large'); return; }
        chunks.push(part);
      }
      const headers = new Headers(request.headers);
      if (!headers.has('authorization')) headers.set('authorization', 'Bearer ' + ownerSession);
      const method = request.method || 'GET';
      const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
      let result;
      if (url.pathname.startsWith('/_local/')) {
        const authenticated = await api.fetch(new Request(origin + '/api/v1/tenants/local/auth/whoami', { headers }), env);
        if (!authenticated.ok) result = authenticated;
        else {
          // Only the local owner may drive the local runner; the sign-in says who is calling.
          const caller = await authenticated.clone().json().catch(() => ({}));
          result = caller.principal_id === 'local-owner'
            ? await localRunner.handle(new Request(url, { method, headers, body }))
            : Response.json({ error: 'local_runner_owner_required' }, { status: 403 });
        }
      } else result = await api.fetch(new Request(url, { method, headers, body }), env);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    const path = resolve(webRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(webRoot + sep)) { response.writeHead(403).end('Forbidden'); return; }
    let content = webAssets.get(path);
    if (!content) { response.writeHead(404).end('Not found'); return; }
    if (path.endsWith('index.html')) {
      content = Buffer.from(content.toString().replace('name="gitfoundry-default-tenant" content=""', 'name="gitfoundry-default-tenant" content="local"'));
    }
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    response.end(content);
  } catch (error) {
    console.error(error);
    response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'gfy_local_error', detail: String(error.message) }));
  }
});
console.error('GitFoundry startup: opening local listener');
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'gitfoundry.local.ready', url: origin, tenant, database: resolve(dataRoot, 'gitfoundry.sqlite'), gitRoot, localDemoTokens: localCredentialFiles })));
