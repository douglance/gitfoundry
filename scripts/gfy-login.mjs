// gfy login: emails a sign-in code, exchanges it for a sign-in token, and saves the token where
// the gfy CLI reads it. gfy logout signs that token out and removes it.
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';

export const sessionPath = home => join(home, '.config/gitfoundry/session');
export const workspacePath = home => join(home, '.config/gitfoundry/workspace');

export async function login({ origin, email, readCode, fetch = globalThis.fetch, home = process.env.HOME }) {
  const address = String(email ?? '').trim().toLowerCase();
  const started = await fetch(new URL('/auth/email/start', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: address }) });
  if (started.status !== 202) throw new Error('GitFoundry could not send a sign-in code to ' + address + ' (HTTP ' + started.status + ')');
  const code = String(await readCode(address)).replace(/\D/g, '');
  const verified = await fetch(new URL('/auth/email/verify', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: address, code, client: 'cli' }) });
  const body = await verified.json().catch(() => ({}));
  if (verified.status !== 200 || !/^gfys_/.test(body.session_token ?? '')) throw new Error('That code did not work. Run gfy login again to get a new one.');
  const file = sessionPath(home);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, body.session_token + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
  await writeFile(workspacePath(home), body.tenant_id + '\n', { mode: 0o600 });
  return { email: address, workspace: body.tenant_id, file };
}

export async function logout({ origin, fetch = globalThis.fetch, home = process.env.HOME }) {
  const file = sessionPath(home);
  const token = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (token) await fetch(new URL('/auth/sign-out', origin), { method: 'POST', headers: { authorization: 'Bearer ' + token } }).catch(() => undefined);
  await rm(file, { force: true });
  await rm(workspacePath(home), { force: true });
}

export async function main(args, env = process.env) {
  const origin = env.GFY_API_BASE_URL || 'https://gitfoundry.dev';
  if (args[0] === 'logout') { await logout({ origin }); console.log('Signed out.'); return; }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const flag = args.indexOf('--email');
    const email = flag >= 0 ? args[flag + 1] : await prompt.question('Email: ');
    const result = await login({ origin, email, readCode: address => prompt.question('Code sent to ' + address + ': ') });
    console.log('Signed in to workspace ' + result.workspace + ' as ' + result.email + '.');
  } finally { prompt.close(); }
}
