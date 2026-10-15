import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login, logout } from './gfy-login.mjs';

function server() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined, authorization: init.headers?.authorization });
    if (String(url).endsWith('/auth/email/start')) return Response.json({ status: 'code_sent' }, { status: 202 });
    if (String(url).endsWith('/auth/email/verify')) return init.body.includes('"123456"') ? Response.json({ tenant_id: 'ws-1', email: 'me@example.com', session_token: 'gfys_' + 'a'.repeat(43) }) : Response.json({ error: 'invalid_code' }, { status: 401 });
    if (String(url).endsWith('/auth/sign-out')) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  return { calls, fetch };
}

test('login emails a code, saves the sign-in token privately, and logout revokes and removes it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gfy-login-'));
  const { calls, fetch } = server();
  const result = await login({ origin: 'https://gitfoundry.dev', email: 'Me@Example.com', readCode: async () => ' 123456 ', fetch, home });
  assert.equal(result.workspace, 'ws-1');
  const file = join(home, '.config/gitfoundry/session');
  assert.equal(await readFile(file, 'utf8'), 'gfys_' + 'a'.repeat(43) + '\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(join(home, '.config/gitfoundry/workspace'), 'utf8'), 'ws-1\n');
  assert.deepEqual(calls.map(call => call.url), ['https://gitfoundry.dev/auth/email/start', 'https://gitfoundry.dev/auth/email/verify']);
  assert.deepEqual(calls[1].body, { email: 'me@example.com', code: '123456', client: 'cli' });

  await logout({ origin: 'https://gitfoundry.dev', fetch, home });
  assert.equal(calls[2].url, 'https://gitfoundry.dev/auth/sign-out');
  assert.equal(calls[2].authorization, 'Bearer gfys_' + 'a'.repeat(43));
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(join(home, '.config/gitfoundry/workspace')), false);
});

test('login saves nothing when the code is wrong', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gfy-login-'));
  const { fetch } = server();
  await assert.rejects(login({ origin: 'https://gitfoundry.dev', email: 'me@example.com', readCode: async () => '000000', fetch, home }), /code did not work/);
  assert.equal(existsSync(join(home, '.config/gitfoundry/session')), false);
});
