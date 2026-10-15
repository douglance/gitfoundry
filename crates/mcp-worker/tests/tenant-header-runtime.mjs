import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dependency = relative => path.join(root, 'node_modules/.pnpm', relative);
const [Effect, Layer, NodeServices, Workerd] = await Promise.all([
  import(pathToFileURL(dependency('effect@4.0.2/node_modules/effect/dist/Effect.js'))),
  import(pathToFileURL(dependency('effect@4.0.2/node_modules/effect/dist/Layer.js'))),
  import(pathToFileURL(dependency('@effect+platform-node@4.0.2_effect@4.0.2_redis@6.3.0/node_modules/@effect/platform-node/dist/NodeServices.js'))),
  import(pathToFileURL(dependency('node_modules/@alchemy.run/cloudflare-runtime/dist/core/node/workerd/Workerd.mjs'))),
]);
const artifacts = path.join(root, 'target/p0-remote-worker-build');
const modules = [];
function collect(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) collect(path.join(directory, entry.name), name + '/');
    else if (/\.(js|mjs|wasm)$/.test(name)) {
      const bytes = fs.readFileSync(path.join(directory, entry.name));
      modules.push(name.endsWith('.wasm') ? { name, wasm: bytes } : { name, esModule: bytes.toString('utf8') });
    }
  }
}
collect(artifacts);
modules.sort((a, b) => (a.name === 'index.js' ? -1 : b.name === 'index.js' ? 1 : a.name.localeCompare(b.name)));
assert.equal(modules[0]?.name, 'index.js', 'compiled MCP entry point required');

const config = {
  sockets: [
    { name: 'mcp', address: '127.0.0.1:0', service: { name: 'mcp' } },
    { name: 'identity', address: '127.0.0.1:0', service: { name: 'identity' } },
  ],
  services: [
    { name: 'identity', worker: { compatibilityDate: '2026-03-10', modules: [{ name: 'index.js', esModule: `
      let calls = 0;
      export default { async fetch(request) {
        if (new URL(request.url).pathname === '/identity') {
          calls++;
          const { userAuthorization } = await request.json();
          const status = { 'Bearer status-401': 401, 'Bearer status-403': 403, 'Bearer status-500': 500 }[userAuthorization];
          if (status) return Response.json({ error: { code: 'OPAQUE', message: 'opaque identity response' } }, { status });
          return Response.json({ tenant_id: 'tenant-a', principal_id: 'agent-a', policy_epoch: 1 });
        }
        return Response.json({ calls });
      } };
    ` }] } },
    { name: 'mcp', worker: {
      compatibilityDate: '2026-03-10', modules,
      bindings: [{ name: 'API', service: { name: 'identity' } }],
    } },
  ],
};
const program = Effect.scoped(Effect.gen(function* () {
  const runtime = yield* Workerd.Workerd;
  const ports = yield* runtime.serve(config);
  return yield* Effect.promise(async () => {
    const getCalls = async () => (await (await fetch(`http://127.0.0.1:${ports.identity}/calls`, { signal: AbortSignal.timeout(5000) })).json()).calls;
    const results = [];
    for (const headers of [{}, { 'x-gitfoundry-tenant-id': '' }]) {
      const response = await fetch(`http://127.0.0.1:${ports.mcp}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.text();
      assert.equal(response.status, 400, `missing/empty tenant must be a client error: ${body.slice(0, 200)}`);
      assert.match(body, /x-gitfoundry-tenant-id header is required/);
      assert.equal(await getCalls(), 0, 'invalid tenant must be rejected before identity lookup');
      results.push(response.status);
    }
    const identityStatuses = [];
    for (const status of [401, 403, 500]) {
      const response = await fetch(`http://127.0.0.1:${ports.mcp}/mcp`, {
        method: 'POST',
        headers: { 'x-gitfoundry-tenant-id': 'tenant-a', authorization: 'Bearer status-' + status },
        body: '{}', signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, status, 'identity HTTP status must survive the MCP transport');
      assert.deepEqual(await response.json(), { error: { code: 'OPAQUE', message: 'opaque identity response' } });
      identityStatuses.push(response.status);
    }
    assert.equal(await getCalls(), 3, 'each identity error must come from the bound API');
    const beforeValid = await getCalls();
    // A valid tenant must still reach identity; absent CODEMODE intentionally stops after that seam.
    await fetch(`http://127.0.0.1:${ports.mcp}/mcp`, {
      method: 'POST', headers: { 'x-gitfoundry-tenant-id': 'tenant-a' },
      body: '{}', signal: AbortSignal.timeout(5000),
    });
    assert.equal(await getCalls() - beforeValid, 1, 'valid tenant must continue through identity');
    return { missing_tenant_status: results[0], empty_tenant_status: results[1], invalid_identity_calls: 0, identity_statuses: identityStatuses, valid_identity_calls: 1 };
  });
}));
const services = Layer.provide(Workerd.WorkerdLive, NodeServices.layer);
console.log(JSON.stringify(await Effect.runPromise(Effect.provide(program, services))));
