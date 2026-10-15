import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const adapterBundle = await build({ entryPoints: [new URL('../../apps/api-worker/src/fork-forge/git-cli.ts', import.meta.url).pathname], platform: 'node', bundle: true, write: false, format: 'esm' });
const adapterSource = adapterBundle.outputFiles[0].text;
const { makeGitCliForgePort } = await import('data:text/javascript;base64,' + Buffer.from(adapterSource).toString('base64'));

const methods = ['readRef', 'listRefs', 'readFile', 'listTree', 'writeCommit', 'compareCommits', 'mergeCommits', 'compareAndSwapRef', 'compareAndSwapRefs', 'isAncestor'];
export const activeForgeToolNames = [
  'gfy_auth_whoami', 'gfy_repo_create', 'gfy_repo_list', 'gfy_repo_view',
  'gfy_forge_initialize', 'gfy_forge_head', 'gfy_forge_read', 'gfy_forge_list',
  'gfy_forge_fork', 'gfy_forge_commit', 'gfy_forge_compare', 'gfy_forge_merge',
  'gfy_forge_publish', 'gfy_forge_recover', 'gfy_forge_view'
].sort();

export async function createNativeForgeFixture(root) {
  const directory = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'gfy-runtime-git-'));
  const secret = randomBytes(32).toString('hex');
  const repositories = new Map();
  let requests = 0;
  function run(arg, input = {}) {
    return new Promise((resolveRun, rejectRun) => {
      const env = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
      for (const entry of input.env || []) { const at = entry.indexOf('='); env[entry.slice(0, at)] = entry.slice(at + 1); }
      const child = spawn('git', arg, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const stdout = [], stderr = [];
      let size = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) child.kill('SIGKILL');
        else chunks.push(Buffer.from(chunk));
      });
      child.on('error', error => { clearTimeout(timer); rejectRun(error); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (signal || size > 8 * 1024 * 1024) return rejectRun(new Error('Native fixture Git command exceeded bounds'));
        if (code !== 0 && arg.includes("update-ref")) console.error(JSON.stringify({ native_fixture_ref_rejection: true, error: Buffer.concat(stderr).toString().slice(0, 1500) }));
        resolveRun({ exitCode: code ?? 1, stdout: new Uint8Array(Buffer.concat(stdout)), stderr: new Uint8Array(Buffer.concat(stderr)) });
      });
      child.stdin.end(input.stdin ? Buffer.from(input.stdin) : undefined);
    });
  }
  async function repository(tenantId, repositoryId) {
    if (!['tenant-a', 'tenant-b'].includes(tenantId) || (repositoryId !== 'repo-' + tenantId && !repositories.has(tenantId + '/' + repositoryId))) throw new Error('Native fixture scope rejected');
    const key = tenantId + '/' + repositoryId;
    if (!repositories.has(key)) repositories.set(key, (async () => {
      const gitDir = join(directory, tenantId + '.git');
      const indexDir = join(directory, tenantId + '-indexes');
      await mkdir(indexDir);
      const initialized = await run(['init', '--bare', '--template=', gitDir]);
      if (initialized.exitCode !== 0) throw new Error('Native fixture initialization failed');
      return { gitDir, port: makeGitCliForgePort({ gitDir, indexDir, run: input => run(input.arg, input) }) };
    })());
    return repositories.get(key);
  }

  async function provisionRepository(input) {
    if (!input || !['tenant-a', 'tenant-b'].includes(input.tenantId)) throw new Error('Native provisioner tenant rejected');
    for (const field of ['namespaceId', 'name', 'defaultBranch']) {
      if (typeof input[field] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(input[field])) throw new Error('Native provisioner input rejected');
    }
    const repositoryId = 'repo-' + createHash('sha256').update(JSON.stringify(['gitfoundry.repository.v1', input.tenantId, input.namespaceId, input.name])).digest('hex');
    const key = input.tenantId + '/' + repositoryId;
    if (!repositories.has(key)) repositories.set(key, (async () => {
      const gitDir = join(directory, repositoryId + '.git');
      const indexDir = join(directory, repositoryId + '-indexes');
      await mkdir(indexDir);
      const initialized = await run(['init', '--bare', '--template=', '--initial-branch=' + input.defaultBranch, gitDir]);
      if (initialized.exitCode !== 0) throw new Error('Native repository provisioning failed');
      return { gitDir, port: makeGitCliForgePort({ gitDir, indexDir, run: request => run(request.arg, request) }) };
    })());
    const { gitDir } = await repositories.get(key);
    return { gitUrl: pathToFileURL(gitDir).href, artifactsNamespace: input.tenantId, artifactsName: repositoryId };
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/rpc' || request.headers.authorization !== 'Bearer ' + secret) {
        response.writeHead(403); response.end(); return;
      }
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Native fixture frame too large'); chunks.push(chunk); }
      const frame = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(frame.args)) throw new Error('Native fixture arguments rejected');
      if (frame.method === 'provisionRepository') {
        const result = await provisionRepository(frame.args[0]);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ result }));
        return;
      }
      if (!methods.includes(frame.method)) throw new Error('Native fixture method rejected');
      const { port } = await repository(frame.tenantId, frame.repositoryId);
      requests++;
      const result = await port[frame.method](...frame.args);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ result }));
    } catch (error) {
      console.error(JSON.stringify({ native_fixture_git_rejection: true, error: String(error.message).slice(0, 1500) }));
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error.message).slice(0, 300) }));
    }
  });
  await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  return {
    directory,
    service: { name: 'native-forge-git', external: { address: '127.0.0.1:' + address.port, http: {} } },
    binding: { name: 'FORGE_TEST_GIT', service: { name: 'native-forge-git' } },
    apiModuleSource() {
      const apiPath = resolve(root, 'apps/api-worker/src/worker.ts');
      const evidencePath = resolve(root, 'apps/api-worker/src/fork-forge/evidence.ts');
      const effectPath = resolve(root, 'apps/api-worker/node_modules/effect/dist/Effect.js');
      return [
        'import api, { AgentApi as ActualAgentApi } from ' + JSON.stringify(apiPath) + ';',
        'export * from ' + JSON.stringify(apiPath) + ';',
        'import { verifyPublicationEvidence } from ' + JSON.stringify(evidencePath) + ';',
        'import * as Effect from ' + JSON.stringify(effectPath) + ';',
        'const methods = ' + JSON.stringify(methods) + ';',
        'const secret = ' + JSON.stringify(secret) + ';',
        `function fixtureEnv(env) {
          const factory = scope => Object.fromEntries(methods.map(method => [method, async (...args) => {
            const response = await env.FORGE_TEST_GIT.fetch('http://native-forge-git/rpc', {
              method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
              body: JSON.stringify({ ...scope, method, args })
            });
            const payload = await response.json();
            if (!response.ok || payload.error) throw new Error(payload.error || 'Native fixture RPC failed');
            return payload.result;
          }]));
          return { ...env, GFY_GIT_PROVISIONER: { provisionRepository: input => Effect.promise(async () => {
            const response = await env.FORGE_TEST_GIT.fetch('http://native-forge-git/rpc', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'provisionRepository', args: [input] }) });
            const payload = await response.json();
            if (!response.ok || payload.error) throw new Error(payload.error || 'Native provisioning RPC failed');
            return payload.result;
          }) }, GFY_FORGE_GIT: factory, GFY_FORGE_VERIFY_EVIDENCE: async context => {
            try { return await verifyPublicationEvidence({ git: factory({ tenantId: context.tenant_id, repositoryId: context.repository_id }), trustedKeys: {}, context }); }
            catch (error) { console.error(JSON.stringify({ native_fixture_publication_rejection: true, error: String(error.message).slice(0, 1500) })); throw error; }
          } };
        }
        async function inspectResponse(request, response) {
          if (request.headers.get("x-gfy-test-cancel-event-response") === "1" && response.status === 200 && response.headers.get("content-type")?.startsWith("text/event-stream")) {
            await response.body.cancel();
            return Response.json({ cancelled_actual_response_body: true });
          }
          if (response.status >= 400) console.error(JSON.stringify({ native_fixture_api_rejection: true, path: new URL(request.url).pathname, status: response.status, payload: (await response.clone().text()).slice(0, 2000) }));
          return response;
        }
        export class AgentApi extends ActualAgentApi {
          constructor(ctx, env) { super(ctx, fixtureEnv(env)); }
          async fetch(request) { return inspectResponse(request, await super.fetch(request)); }
        }
        export default { async fetch(request, env, ctx) { return inspectResponse(request, await api.fetch(request, fixtureEnv(env), ctx)); } };`
      ].join('\n');
    },
    async readStateRecord(versionCommit, path, tenantId = 'tenant-a', repositoryId = 'repo-' + tenantId) {
      if (!/^[0-9a-f]{40}$/.test(versionCommit) || !/^[a-z0-9][a-z0-9/._-]*$/.test(path) || path.split('/').includes('..')) throw new Error('Native readback fixture input invalid');
      const { gitDir } = await repository(tenantId, repositoryId);
      const descriptorResult = await run(['--git-dir', gitDir, 'show', versionCommit + ':forge.json']);
      if (descriptorResult.exitCode !== 0) throw new Error('Version descriptor absent from actual Git');
      const descriptor = JSON.parse(Buffer.from(descriptorResult.stdout).toString('utf8'));
      const record = await run(['--git-dir', gitDir, 'show', descriptor.state_commit + ':' + path]);
      if (record.exitCode !== 0) throw new Error('State record absent from actual Git');
      return JSON.parse(Buffer.from(record.stdout).toString('utf8'));
    },

    async inspectRepository(tenantId, repositoryId) {
      const { gitDir } = await repository(tenantId, repositoryId);
      const bare = await run(['--git-dir', gitDir, 'rev-parse', '--is-bare-repository']);
      const head = await run(['--git-dir', gitDir, 'symbolic-ref', 'HEAD']);
      const refs = await run(['--git-dir', gitDir, 'for-each-ref', '--format=%(refname) %(objectname)']);
      if (bare.exitCode !== 0 || head.exitCode !== 0 || refs.exitCode !== 0) throw new Error('Native repository inspection failed');
      return { bare: Buffer.from(bare.stdout).toString().trim() === 'true', head: Buffer.from(head.stdout).toString().trim(), refs: Buffer.from(refs.stdout).toString().trim().split('\n').filter(Boolean).sort() };
    },
    async readCodeFile(versionCommit, path, tenantId, repositoryId) {
      if (!/^[0-9a-f]{40}$/.test(versionCommit) || !/^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(path) || path.split('/').includes('..')) throw new Error('Native code readback input invalid');
      const { gitDir } = await repository(tenantId, repositoryId);
      const descriptorResult = await run(['--git-dir', gitDir, 'show', versionCommit + ':forge.json']);
      if (descriptorResult.exitCode !== 0) throw new Error('Native code version absent');
      const descriptor = JSON.parse(Buffer.from(descriptorResult.stdout).toString());
      const file = await run(['--git-dir', gitDir, 'show', descriptor.code_commit + ':' + path]);
      if (file.exitCode !== 0) throw new Error('Native code file absent');
      return Buffer.from(file.stdout).toString();
    },
    get requestCount() { return requests; },
    async close() {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
      await rm(directory, { recursive: true, force: true });
    }
  };
}
