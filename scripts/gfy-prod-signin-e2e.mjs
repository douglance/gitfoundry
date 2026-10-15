#!/usr/bin/env node
// Signs in to production through the real sign-in page with a real emailed code, then proves the
// session reaches its workspace and stops working after sign-out. The code arrives at the test
// address, which Email Routing hands to the inbox Worker; this script reads it from that inbox.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = process.env.GFY_E2E_ORIGIN ?? 'https://gitfoundry.dev';
const address = process.env.GFY_E2E_ADDRESS ?? 'e2e@gitfoundry.dev';
const wrangler = process.env.WRANGLER ?? 'wrangler';
const evidence = process.argv[2] ?? join(tmpdir(), 'gfy-prod-signin-e2e');
const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const steps = [];
const step = (name, ok, detail = '') => { steps.push({ name, ok, ...(detail ? { detail } : {}) }); if (!ok) throw new Error(name + (detail ? ': ' + detail : '')); };

// For an address outside the test inbox, the code is typed into this file by a person.
const codeFile = process.env.GFY_E2E_CODE_FILE;
async function codeFromFile() {
  try { const value = (await readFile(codeFile, 'utf8')).trim(); return /^\d{6}$/.test(value) ? value : null; } catch { return null; }
}

function newestCode(after) {
  const out = execFileSync(wrangler, ['d1', 'execute', 'gitfoundry-e2e-inbox', '--remote', '--json', '--command', `SELECT code, received_at FROM inbox WHERE address = '${address}' AND received_at > '${after}' ORDER BY received_at DESC LIMIT 1`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0]?.results?.[0]?.code ?? null;
}

await mkdir(evidence, { recursive: true });
const errors = [];

// Headless Chrome on this host does not live long, so each view gets a fresh browser that
// carries the signed-in session cookie over in memory.
async function openBrowser(cookies = []) {
  const profile = await mkdtemp(join(tmpdir(), 'gfy-e2e-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 80 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(250); } }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description?.slice(0, 200));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(String(msg.params.args?.[0]?.value ?? msg.params.args?.[0]?.description).slice(0, 200));
  });
  ws.addEventListener('close', () => { for (const { reject } of pending.values()) reject(new Error('browser closed')); pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const waitFor = async (expression, timeoutMs = 20_000) => { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (await evaluate(expression)) return true; await sleep(250); } return false; };
  const shoot = async name => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(evidence, name + '.png'), Buffer.from(data, 'base64')); };
  const clickButton = label => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(b)b.click();return !!b})()`);
  const type = async (elementId, text) => { await evaluate(`document.getElementById(${JSON.stringify(elementId)}).focus()`); await send('Input.insertText', { text }); };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  if (cookies.length) await send('Network.setCookies', { cookies });
  const close = async () => { ws.close(); chrome.kill('SIGTERM'); await rm(profile, { recursive: true, force: true }).catch(() => {}); };
  return { send, evaluate, waitFor, shoot, clickButton, type, close, cookies: async () => (await send('Network.getCookies', { urls: [origin] })).cookies };
}

let browser;
try {
  browser = await openBrowser();
  let { send, evaluate, waitFor, shoot, clickButton, type } = browser;
  await send('Page.navigate', { url: origin + '/' });
  step('signed-out visitor sees the sign-in page', await waitFor(`document.body.innerText.includes('Sign in to GitFoundry')`));
  await shoot('1-sign-in');

  const requestedAt = new Date(Date.now() - 1000).toISOString();
  // A code already in hand is submitted directly; requesting another would retire it.
  const givenCode = process.env.GFY_E2E_CODE;
  if (givenCode) {
    const verified = await evaluate(`fetch('/auth/email/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(address)}, code: ${JSON.stringify(givenCode)} }) }).then(r => r.status)`);
    step('given code accepted', verified === 200, 'HTTP ' + verified);
    await send('Page.navigate', { url: origin + '/' });
  } else {
    await type('sign-in-email', address);
    step('email submitted', await clickButton('Email me a code'));
    step('code entry shown', await waitFor(`document.body.innerText.includes('Check your email')`));
    await shoot('2-code-entry');
    await browser.close();
    let code = null;
    for (let i = 0; i < (codeFile ? 150 : 30) && !code; i++) { await sleep(2000); code = codeFile ? await codeFromFile() : newestCode(requestedAt); }
    step('sign-in email arrived with a six-digit code', /^\d{6}$/.test(code ?? ''));
    // The code screen is rebuilt in a fresh browser: submitting the address again would send a new code.
    browser = await openBrowser();
    ({ send, evaluate, waitFor, shoot, clickButton, type } = browser);
    await send('Page.navigate', { url: origin + '/' });
    await waitFor(`!!document.getElementById('sign-in-email')`);
    const verified = await evaluate(`fetch('/auth/email/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(address)}, code: ${JSON.stringify(code)} }) }).then(r => r.status)`);
    step('emailed code accepted', verified === 200, 'HTTP ' + verified);
    await send('Page.navigate', { url: origin + '/' });
  }
  step('page reloads into a rendered workspace', await waitFor(`!!document.querySelector('meta[name="gitfoundry-default-tenant"]')?.content && (document.querySelector('[aria-label="Global navigation"]')?.getBoundingClientRect().height ?? 0) > 0`, 30_000));
  await shoot('3-workspace');

  const tenant = await evaluate(`document.querySelector('meta[name="gitfoundry-default-tenant"]').content`);
  const signedIn = await evaluate(`fetch('/api/v1/tenants/' + encodeURIComponent(${JSON.stringify(tenant)}) + '/repositories').then(r => r.status)`);
  step('signed-in session lists its workspace repositories', signedIn === 200, 'HTTP ' + signedIn);
  const repositories = await evaluate(`fetch('/api/v1/tenants/' + encodeURIComponent(${JSON.stringify(tenant)}) + '/repositories').then(r => r.json()).then(b => (b.items ?? b.repositories ?? b.data ?? []).map(x => x.id))`);
  const session = await browser.cookies();
  await browser.close();

  // Every repository section must load without an error banner.
  for (const repo of (repositories ?? []).slice(0, 1)) {
    for (const section of ['code', 'issues', 'forks', 'reviews', 'checks']) {
      browser = await openBrowser(session);
      ({ send, evaluate, waitFor, shoot } = browser);
      await send('Page.navigate', { url: `${origin}/?tenant=${encodeURIComponent(tenant)}&repo=${encodeURIComponent(repo)}&section=${section}` });
      const settled = await waitFor(`!!document.querySelector('[aria-label="Global navigation"]') && !/Loading/.test(document.querySelector('main')?.innerText ?? document.body.innerText)`, 45_000);
      await shoot('repo-' + section);
      const failure = await evaluate(`(document.body.innerText.match(/(Unable to load[^\\n]*|[A-Za-z ]*unavailable[^\\n]*|HTTP 5\\d\\d[^\\n]*)/) ?? [])[0] ?? ''`);
      await browser.close();
      step(`repository ${section} view loads without errors`, settled && !failure, failure || (settled ? '' : 'still loading after 45s'));
    }
  }

  browser = await openBrowser(session);
  ({ send, evaluate, waitFor, shoot } = browser);
  await send('Page.navigate', { url: origin + '/' });
  await waitFor(`!!document.querySelector('[aria-label="Global navigation"]')`);
  const otherWorkspace = await evaluate(`fetch('/api/v1/tenants/owner/repositories').then(r => r.status)`);
  step('signed-in session cannot read another workspace', tenant === 'owner' || otherWorkspace === 401 || otherWorkspace === 403, 'HTTP ' + otherWorkspace);
  const signOut = await evaluate(`fetch('/auth/sign-out', { method: 'POST' }).then(r => r.status)`);
  step('sign-out accepted', signOut === 204, 'HTTP ' + signOut);
  const afterSignOut = await evaluate(`fetch('/api/v1/tenants/' + encodeURIComponent(${JSON.stringify(tenant)}) + '/repositories').then(r => r.status)`);
  step('requests after sign-out are rejected', afterSignOut === 401, 'HTTP ' + afterSignOut);
  await send('Page.navigate', { url: origin + '/' });
  step('signed-out page shows sign-in again', await waitFor(`document.body.innerText.includes('Sign in to GitFoundry')`));
  await shoot('4-signed-out');
  step('no page errors', errors.length === 0, errors.join(' | '));
  console.log(JSON.stringify({ ok: true, origin, workspace: tenant, steps, evidence }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ ok: false, origin, failed: error.message, steps, evidence }, null, 1));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
