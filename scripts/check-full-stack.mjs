#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { browserCoverageSession } from './e2e-coverage.mjs';
import { createBrowserControls } from './full-stack-browser-controls.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'gfy-full-stack-'));
const dataRoot = join(directory, 'data');
const locator = join(directory, 'instance.json');
const outDir = process.env.GFY_FULL_STACK_OUT_DIR || resolve(root, 'artifacts/full-stack-browser');
await mkdir(outDir, { recursive: true });
const coverage = await browserCoverageSession(root, outDir);
const port = await freePort();
const debugPort = await freePort();
const url = 'http://127.0.0.1:' + port;
const forgePath = '/api/v2/tenants/local/repositories/example/forge';
const gitDir = join(dataRoot, 'repositories/local/core--example.git');
const issueTitle = 'Persistent browser issue \u2014 caf\u00e9';
const issueBody = 'Created through the rendered form, stored in Git.';
const commentBody = 'Persistent browser comment \u2014 \u2713';
const cases = [];
const runtimeErrors = [];
const pending = new Map();
let sequence = 0;
let server;
let chrome;
let socket;
let serverDiagnostic = '';
let chromeDiagnostic = '';
let transportFailure;
let succeeded = false;
const { click, clickButton, fill, selectFork } = createBrowserControls(evaluate, waitFor);

try {
  await startServer();
  const initialHead = (await json(forgePath + '/head')).version;
  assert.ok(initialHead?.version_commit, 'persistent sample forge is initialized');
  const chromePath = await findChrome();
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--use-mock-keychain', '--password-store=basic',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + join(directory, 'chrome'),
    '--window-size=1440,1000', 'about:blank',
  ], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', chunk => { chromeDiagnostic = (chromeDiagnostic + chunk).slice(-6000); });
  chrome.on('exit', (code, signal) => { chromeDiagnostic += '\nChrome exited: code=' + code + ' signal=' + signal; });
  const pages = await eventually(async () => {
    const response = await fetch('http://127.0.0.1:' + debugPort + '/json/list', { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error('Chrome not ready');
    return response.json();
  }, 'Chrome debug endpoint');
  const page = pages.find(item => item.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome connection timeout')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome connection error')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  const disconnect = event => {
    transportFailure = new Error('Chrome CDP disconnected: ' + event.type + (event.code ? ' code=' + event.code : '') + (event.reason ? ' reason=' + event.reason : ''));
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(transportFailure); }
    pending.clear();
  };
  socket.addEventListener('close', disconnect);
  socket.addEventListener('error', disconnect);
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await navigate('code');
  await waitFor('document.querySelector("[data-source-file]")', 'persistent source browser');
  const sourceFile = await evaluate('({ path: document.querySelector("[data-source-file]").dataset.sourceFile, revision: document.querySelector("[data-source-file]").dataset.sourceSha })');
  assert.equal(sourceFile.path, 'README.md');
  assert.equal(sourceFile.revision, initialHead.descriptor.code_commit);
  const storedSource = (await run('git', ['--git-dir', gitDir, 'show', initialHead.descriptor.code_commit + ':README.md'])).stdout;
  await eventually(async () => {
    const rendered = await evaluate('(() => { const parts = []; const walk = node => { if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent); if (node.shadowRoot) walk(node.shadowRoot); for (const child of node.childNodes) walk(child); }; walk(document.querySelector("[data-source-file]")); return parts.join(""); })()');
    for (const line of storedSource.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) assert.ok(rendered.includes(line), 'rendered source contains exact Git line: ' + line);
    return true;
  }, 'browser source text matches actual Git bytes');
  cases.push('browser source renders independently read Git contents at the exact code revision');

  const uncheckedFork = (await json(forgePath + '/fork', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation_id: 'full-stack-unchecked-fork', parent_version: initialHead.version_commit }) })).version;
  assert.deepEqual(await gitDocuments(uncheckedFork.descriptor.state_commit, 'checks'), []);
  assert.deepEqual(await gitDocuments(uncheckedFork.descriptor.state_commit, 'reviews'), []);
  await navigate('forks');
  const uncheckedNode = '[data-fork-node="' + uncheckedFork.version_commit + '"]';
  await waitFor('document.querySelector(' + JSON.stringify(uncheckedNode) + ')', 'unchecked candidate in browser');
  const beforeUncheckedReview = (await json(forgePath + '/forks')).versions;
  await selectFork(uncheckedFork.version_commit);
  await clickButton('Review fork', '[data-fork-review]');
  await waitFor('document.querySelector("[data-review-approve]")', 'unchecked candidate review');
  await click('[data-review-approve]');
  const reviewOnly = await eventually(async () => {
    const added = (await json(forgePath + '/forks')).versions.filter(item => !beforeUncheckedReview.some(old => old.version_commit === item.version_commit));
    assert.equal(added.length, 1);
    return added[0];
  }, 'signed review without evaluation');
  const reviewOnlyRecords = await gitDocuments(reviewOnly.descriptor.state_commit, 'reviews');
  assert.equal(reviewOnlyRecords.length, 1);
  assert.equal(reviewOnlyRecords[0].decision, 'approve');
  assert.equal(reviewOnlyRecords[0].candidate_code_commit, initialHead.descriptor.code_commit);
  assert.ok(reviewOnlyRecords[0].signature);
  assert.deepEqual(await gitDocuments(reviewOnly.descriptor.state_commit, 'checks'), []);
  await expectPublicationDenied(reviewOnly, initialHead, 'missing-check');
  cases.push('publication without required check evidence is rejected without changing Git head');

  const evaluationResponse = await fetch(url + '/_local/runs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id: 'local', repository_id: 'example', operation_id: 'full-stack-behavior', version_commit: initialHead.version_commit, command: ['node', '--test', 'behavior.test.mjs'] }),
  });
  assert.equal(evaluationResponse.status, 202);
  const evaluationStart = await evaluationResponse.json();
  const evaluation = await eventually(async () => {
    const value = await json('/_local/runs/' + evaluationStart.run_id + '?tenant_id=local&repository_id=example');
    assert.equal(value.status, 'finished');
    assert.equal(value.exit_code, 0);
    assert.equal(value.active, false);
    return value;
  }, 'configured evaluator completes', 60000);
  const evaluated = (await json(forgePath + '/versions/' + evaluation.state_version_commit)).version;
  const checks = await gitDocuments(evaluated.descriptor.state_commit, 'checks');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, 'behavior');
  assert.equal(checks[0].outcome, 'passed');
  assert.equal(checks[0].candidate_code_commit, initialHead.descriptor.code_commit);
  assert.equal(checks[0].runner_runtime.kind, 'local-native-owner');
  assert.ok(checks[0].signature);
  assert.deepEqual(await gitDocuments(evaluated.descriptor.state_commit, 'reviews'), []);
  await expectPublicationDenied(evaluated, initialHead, 'missing-review');
  cases.push('passed evaluation without human approval is rejected without changing Git head');
  await navigate('forks');
  const evaluationNode = '[data-fork-node="' + evaluated.version_commit + '"]';
  await waitFor('document.querySelector(' + JSON.stringify(evaluationNode) + ')', 'executed candidate in browser');
  const beforeReview = (await json(forgePath + '/forks')).versions;
  await selectFork(evaluated.version_commit);
  await clickButton('Review fork', '[data-fork-review]');
  await waitFor('document.querySelector("[data-review-approve]")', 'exact candidate review');
  await click('[data-review-approve]');
  const reviewed = await eventually(async () => {
    const versions = (await json(forgePath + '/forks')).versions;
    const added = versions.filter(item => !beforeReview.some(old => old.version_commit === item.version_commit));
    assert.equal(added.length, 1);
    return added[0];
  }, 'signed browser review');
  const reviews = await gitDocuments(reviewed.descriptor.state_commit, 'reviews');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].decision, 'approve');
  assert.equal(reviews[0].actor_id, 'local-owner');
  assert.equal(reviews[0].candidate_code_commit, initialHead.descriptor.code_commit);
  assert.ok(reviews[0].signature);
  const reviewedNode = '[data-fork-node="' + reviewed.version_commit + '"]';
  await waitFor('document.querySelector(' + JSON.stringify(reviewedNode) + ')', 'reviewed candidate in browser');
  await selectFork(reviewed.version_commit);
  await clickButton('Publish', '[data-fork-review]');
  await eventually(async () => {
    assert.equal((await json(forgePath + '/head')).version.version_commit, reviewed.version_commit);
    return true;
  }, 'checked and reviewed candidate published');
  cases.push('real evaluator and browser review satisfy signed publication policy');


  await navigate('issues');
  await waitFor('document.querySelector("#new-record-button")', 'issue controls');
  await click('#new-record-button');
  await waitFor('document.querySelector("#issue-create-form")', 'issue form');
  await fill('#issue-create-form input[name=title]', issueTitle);
  await fill('#issue-create-form textarea[name=body]', issueBody);
  await click('#issue-create-form button[type=submit]');
  await waitFor('Array.from(document.querySelectorAll("[data-id]")).some(record => record.textContent.includes(' + JSON.stringify(issueTitle) + '))', 'published browser issue');
  const issueHead = (await json(forgePath + '/head')).version;
  assert.notEqual(issueHead.version_commit, initialHead.version_commit);
  assert.equal(issueHead.descriptor.code_commit, initialHead.descriptor.code_commit);
  const issueRecords = await gitDocuments(issueHead.descriptor.state_commit, 'issues');
  assert.equal(issueRecords.length, 1, 'one issue persisted');
  const issue = issueRecords[0];
  assert.equal(issue.kind, 'issue');
  assert.equal(issue.title, issueTitle);
  assert.equal(issue.body, issueBody);
  assert.equal(issue.state, 'open');
  assert.equal(issue.repository_id, 'example');
  const issueId = 'example~' + issue.id;
  await click('[data-id="' + issueId + '"]');
  await waitFor('document.querySelector("#comment-create-form")', 'persisted issue detail');
  await fill('#comment-create-form textarea[name=body]', commentBody);
  await click('#comment-create-form button[type=submit]');
  await waitFor('document.body.innerText.includes("Comment request finished.")', 'published browser comment');
  const commentHead = (await json(forgePath + '/head')).version;
  const comments = await gitDocuments(commentHead.descriptor.state_commit, 'comments');
  assert.equal(comments.length, 1, 'one comment persisted');
  assert.equal(comments[0].body, commentBody);
  assert.equal(comments[0].subject_id, issue.id);
  assert.equal(commentHead.descriptor.code_commit, initialHead.descriptor.code_commit);
  assert.deepEqual(await gitDocuments(initialHead.descriptor.state_commit, 'issues'), [], 'historical state stays immutable');
  cases.push('browser issue and comment persist exact Unicode content in Git');

  await navigate('forks');
  await waitFor('document.querySelector("[data-fork-node]")', 'persistent fork lineage');
  const beforeForks = (await json(forgePath + '/forks')).versions;
  assert.ok(Array.isArray(beforeForks), 'fork list contract');
  await clickButton('Fork this forge', '[data-fork-workspace]');
  const fork = await eventually(async () => {
    const versions = (await json(forgePath + '/forks')).versions;
    const added = versions.filter(item => !beforeForks.some(old => old.version_commit === item.version_commit));
    assert.equal(added.length, 1);
    return added[0];
  }, 'persistent fork creation');
  assert.deepEqual(fork.descriptor.parents, [commentHead.version_commit]);
  assert.equal(fork.descriptor.code_commit, commentHead.descriptor.code_commit);
  assert.equal(fork.descriptor.state_commit, commentHead.descriptor.state_commit);
  await waitFor('document.querySelector(' + JSON.stringify('[data-fork-node="' + fork.version_commit + '"]') + ')', 'created fork visible');
  cases.push('browser fork preserves exact parent, code, and collaboration roots');

  await selectFork(commentHead.version_commit);
  await clickButton('Compare selected fork', '[data-fork-review]');
  const pair = issueHead.version_commit + ' -> ' + commentHead.version_commit;
  await waitFor('document.querySelector("[data-fork-compare]")?.textContent.includes("1 collaboration changes")', 'browser collaboration comparison');
  assert.equal(await evaluate('document.querySelector("[data-fork-compare] [title]").title'), pair);
  assert.ok(await evaluate('document.querySelector("[data-fork-compare]").textContent.includes("0 code changes")'));
  await selectFork(fork.version_commit);
  await clickButton('Inspect underlying record', '[data-fork-review]');
  await waitFor('document.querySelector("[data-fork-record] pre")', 'browser underlying descriptor');
  const inspected = await evaluate('JSON.parse(document.querySelector("[data-fork-record] pre").textContent)');
  const storedDescriptor = JSON.parse((await run('git', ['--git-dir', gitDir, 'show', fork.version_commit + ':forge.json'])).stdout);
  assert.equal(inspected.version_commit, fork.version_commit);
  assert.equal(inspected.code_commit, storedDescriptor.code_commit);
  assert.equal(inspected.state_commit, storedDescriptor.state_commit);
  assert.deepEqual(inspected.parents, storedDescriptor.parents);
  cases.push('browser comparison and underlying fork inspection match exact persisted revisions');


  await selectFork(fork.version_commit);
  const issuePath = 'issues/' + issue.id + '.json';
  await waitFor('Array.from(document.querySelectorAll("[data-state-documents] button")).some(button => button.textContent.includes(' + JSON.stringify(issuePath) + '))', 'selected fork state documents');
  await evaluate('Array.from(document.querySelectorAll("[data-state-documents] button")).find(button => button.textContent.includes(' + JSON.stringify(issuePath) + ')).click()');
  await waitFor('document.querySelector("[data-fork-record] pre")?.textContent.includes(' + JSON.stringify(issueTitle) + ')', 'selected fork issue record');
  const rawIssue = JSON.parse((await run('git', ['--git-dir', gitDir, 'show', fork.descriptor.state_commit + ':' + issuePath])).stdout);
  assert.deepEqual(await evaluate('JSON.parse(document.querySelector("[data-fork-record] pre").textContent)'), rawIssue);
  assert.ok(await evaluate('document.querySelector("[data-fork-record]").textContent.includes(' + JSON.stringify(fork.descriptor.state_commit) + ')'));
  cases.push('selected fork state inspection displays the exact independently persisted Git record');

  await clickButton('Browse exact code', '[data-fork-workspace]');
  await waitFor('document.querySelector("[data-source-file]")?.dataset.sourceSha === ' + JSON.stringify(fork.descriptor.code_commit), 'exact fork source revision');
  assert.equal(await evaluate('document.querySelector("[data-source-file]").dataset.sourceFile'), 'README.md');
  assert.equal(new URL(await evaluate('location.href')).searchParams.get('ref'), fork.descriptor.code_commit);
  await fill('#source-ref', 'missing-full-stack-ref');
  await clickButton('Load ref', '.source-toolbar');
  await waitFor('document.body.innerText.includes("Source unavailable") && !document.querySelector("[data-source-file]")', 'missing source ref clears prior contents');
  await fill('#source-ref', fork.descriptor.code_commit);
  await clickButton('Load ref', '.source-toolbar');
  await waitFor('document.querySelector("[data-source-file]")?.dataset.sourceSha === ' + JSON.stringify(fork.descriptor.code_commit), 'source recovery pins the original exact code revision');
  cases.push('browser exact fork source preserves revision identity and recovers after an invalid ref');

  await navigate('forks');
  const beforeReject = (await json(forgePath + '/forks')).versions;
  const rejectedNode = '[data-fork-node="' + fork.version_commit + '"]';
  await waitFor('document.querySelector(' + JSON.stringify(rejectedNode) + ')', 'fork available for browser rejection');
  await selectFork(fork.version_commit);
  await clickButton('Review fork', '[data-fork-review]');
  await waitFor('document.querySelector("[data-review-reject]")', 'browser rejection control');
  await click('[data-review-reject]');
  const rejected = await eventually(async () => {
    const versions = (await json(forgePath + '/forks')).versions;
    const added = versions.filter(item => !beforeReject.some(old => old.version_commit === item.version_commit));
    assert.equal(added.length, 1);
    return added[0];
  }, 'signed rejection candidate');
  const rejectedReviews = (await gitDocuments(rejected.descriptor.state_commit, 'reviews')).filter(record => record.decision === 'reject');
  assert.equal(rejectedReviews.length, 1);
  assert.equal(rejectedReviews[0].actor_id, 'local-owner');
  assert.equal(rejectedReviews[0].candidate_code_commit, fork.descriptor.code_commit);
  assert.ok(rejectedReviews[0].signature);
  assert.equal((await json(forgePath + '/head')).version.version_commit, commentHead.version_commit);
  await waitFor('document.querySelector(' + JSON.stringify('[data-fork-node="' + rejected.version_commit + '"]') + ')', 'signed rejection fork visible');
  cases.push('browser rejection persists signed evidence for exact code without publishing the candidate');

  for (const [section, expected] of [['reviews', reviews[0]], ['checks', checks[0]]]) {
    await navigate(section);
    const selector = '[data-id="example~' + expected.id + '"]';
    await waitFor('document.querySelector(' + JSON.stringify(selector) + ')', 'persisted ' + section + ' list');
    await click(selector);
    await waitFor('document.querySelector("details.record-inspection summary")', section + ' record detail');
    await click('details.record-inspection summary');
    await waitFor('document.querySelector("details.record-inspection").open && document.querySelector("details.record-inspection pre")', section + ' raw record visible');
    assert.deepEqual(await evaluate('JSON.parse(document.querySelector("details.record-inspection pre").textContent)'), expected);
  }
  cases.push('browser check and review details match independently persisted signed Git documents');

  const browserRepoName = 'browser-created';
  assert.deepEqual(storedRepositories(browserRepoName), []);
  await navigate('repositories', '', '');
  await waitFor('document.querySelector("#new-record-button")', 'repository creation control');
  await click('#new-record-button');
  await waitFor('document.querySelector("#repo-create-form")', 'repository form');
  assert.equal(await evaluate('document.querySelector("#repo-create-form").checkValidity()'), false, 'empty repository name is invalid');
  await fill('#repo-create-form input[name=name]', browserRepoName);
  await fill('#repo-create-form input[name=default_branch]', 'code');
  await click('#repo-create-form button[type=submit]');
  await waitFor('Array.from(document.querySelectorAll("[data-id]")).some(record => record.textContent.includes("browser-created"))', 'created repository visible');
  const storedRepos = storedRepositories(browserRepoName);
  assert.equal(storedRepos.length, 1);
  assert.equal(storedRepos[0].tenant_id, 'local');
  assert.equal(storedRepos[0].namespace_id, 'core');
  assert.equal(storedRepos[0].default_branch, 'code');
  assert.equal(storedRepos[0].visibility, 'private');
  const newGitDir = join(dataRoot, 'repositories/local/core--' + browserRepoName + '.git');
  assert.equal((await run('git', ['--git-dir', newGitDir, 'rev-parse', '--is-bare-repository'])).stdout.trim(), 'true');
  assert.equal((await run('git', ['--git-dir', newGitDir, 'symbolic-ref', 'HEAD'])).stdout.trim(), 'refs/heads/code');
  assert.equal((await json(forgePath + '/head')).version.version_commit, commentHead.version_commit);
  cases.push('browser repository creation persists exact SQLite metadata and provisions real bare Git');

  const nativeBinary = process.env.GFY_FULL_STACK_BINARY || process.env.GFY_NATIVE_BINARY || resolve(root, 'target/release/gfy');
  const nativeEnv = { ...process.env, GFY_API_BASE_URL: url, GFY_URL: url, GFY_TENANT_ID: 'local', GFY_ACCESS_JWT: '', GFY_ACCESS_JWT_FILE: join(dataRoot, 'credentials/local-owner.jwt'), GFY_LOCAL_INSTANCE_FILE: locator };
  const nativeHead = JSON.parse((await run(nativeBinary, ['forge', 'head', '--repository-id', 'example', '--format', 'json'], { cwd: root, env: nativeEnv, timeout: 30000 })).stdout);
  assert.equal(nativeHead.version.version_commit, commentHead.version_commit);
  cases.push('native CLI reads the same published version as the browser and Git');

  const denied = await fetch(url + forgePath + '/head', { headers: { authorization: 'Bearer invalid' } });
  assert.equal(denied.status, 401);
  const foreign = await fetch(url + '/api/v2/tenants/foreign/repositories/example/forge/head');
  assert.ok([403, 404].includes(foreign.status), 'foreign tenant is denied');
  assert.equal((await json(forgePath + '/head')).version.version_commit, commentHead.version_commit);
  cases.push('invalid credentials and an unknown tenant route are rejected');

  await screenshot('before-restart');
  await stop(server);
  server = undefined;
  await eventually(async () => {
    try { await fetch(url + '/health', { signal: AbortSignal.timeout(1000) }); } catch { return true; }
    throw new Error('old persistent server is still listening');
  }, 'server shutdown');
  await startServer();
  assert.equal((await json(forgePath + '/head')).version.version_commit, commentHead.version_commit);
  assert.deepEqual(await gitDocuments(commentHead.descriptor.state_commit, 'issues'), issueRecords);
  assert.deepEqual(await gitDocuments(commentHead.descriptor.state_commit, 'comments'), comments);
  await navigate('issues', '&record=' + encodeURIComponent(issueId));
  await waitFor('document.body.innerText.includes(' + JSON.stringify(issueTitle) + ') && document.querySelector("#comment-create-form")', 'issue restored after server restart');
  await navigate('forks');
  await waitFor('document.querySelector(' + JSON.stringify('[data-fork-node="' + fork.version_commit + '"]') + ')', 'fork restored after server restart');
  assert.deepEqual(storedRepositories(browserRepoName), storedRepos, 'created repository metadata survives restart');
  await navigate('repositories', '', '');
  await waitFor('Array.from(document.querySelectorAll("[data-id]")).some(record => record.textContent.includes("browser-created"))', 'created repository restored after restart');
  await screenshot('after-restart');
  assert.deepEqual(runtimeErrors, [], 'no browser runtime exceptions');
  cases.push('server restart restores Git records and browser fork lineage');
  await coverage.capture(evaluate);
  const measuredCoverage = await coverage.report();
  succeeded = true;
  console.log(JSON.stringify({ ok: true, scope: 'local persistent browser/API/native CLI/Git', cases, outDir, coverage: measuredCoverage }));
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) await screenshot('failure').catch(() => {});
  console.error(JSON.stringify({ ok: false, completedCases: cases, error: String(error.stack || error), serverDiagnostic, chromeDiagnostic, outDir }));
  process.exitCode = 1;
} finally {
  socket?.close();
  await Promise.all([stop(chrome), stop(server)]);
  if (succeeded && !process.env.GFY_FULL_STACK_OUT_DIR) await rm(directory, { recursive: true, force: true });
}

async function expectPublicationDenied(candidate, expected, label) {
  const response = await fetch(url + forgePath + '/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation_id: 'full-stack-denied-' + label, expected_head: expected.version_commit, new_version: candidate.version_commit }) });
  assert.equal(response.status, 409, label + ' publication is denied');
  const refusal = await response.json();
  assert.equal(refusal.error, 'publication_refused');
  assert.ok(typeof refusal.reason === 'string' && refusal.reason.length > 0, label + ' refusal names its reason');
  assert.equal((await json(forgePath + '/head')).version.version_commit, expected.version_commit);
  const storedHead = (await run('git', ['--git-dir', gitDir, 'rev-parse', 'refs/heads/forge-head'])).stdout.trim();
  assert.equal(storedHead, expected.version_commit, 'denied publication leaves independent Git head unchanged');
  assert.equal((await json(forgePath + '/versions/' + candidate.version_commit)).version.version_commit, candidate.version_commit, 'denied candidate remains readable');
}

async function startServer() {
  serverDiagnostic = '';
  server = spawn(process.execPath, [resolve(root, 'gfy'), 'local', 'serve', '--port', String(port), '--data-root', dataRoot], {
    cwd: root, env: { ...process.env, GFY_LOCAL_INSTANCE_FILE: locator, GFY_LOCAL_DATA: dataRoot, NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --import=data:text/javascript,' + encodeURIComponent("process.on('uncaughtException', error => { console.error('SERVER_STARTUP_ERROR: ' + error.message); process.exit(1); });") },
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', chunk => { serverDiagnostic = (serverDiagnostic + chunk).slice(-6000); });
  await eventually(async () => {
    if (server.exitCode !== null) throw new Error('persistent server exited: ' + serverDiagnostic);
    const result = await json('/health');
    assert.ok(result);
    return result;
  }, 'persistent server health', 60000);
}

async function json(path, options = {}) {
  const response = await fetch(url + path, { ...options, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, path + ': ' + await response.clone().text());
  return response.json();
}

function storedRepositories(name) {
  const database = new DatabaseSync(join(dataRoot, 'gitfoundry.sqlite'), { readOnly: true });
  try { return database.prepare('SELECT id,tenant_id,namespace_id,name,default_branch,visibility FROM repositories WHERE tenant_id = ? AND name = ? ORDER BY id').all('local', name); } finally { database.close(); }
}

async function gitDocuments(commit, prefix) {
  const listed = await run('git', ['--git-dir=' + gitDir, 'ls-tree', '-r', '--name-only', commit, '--', prefix], { timeout: 10000 });
  const paths = listed.stdout.trim().split('\n').filter(Boolean);
  return Promise.all(paths.map(async path => JSON.parse((await run('git', ['--git-dir=' + gitDir, 'show', commit + ':' + path], { timeout: 10000 })).stdout)));
}

async function eventually(action, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { return await action(); } catch (error) { last = error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(label + ': ' + last);
}

async function cdp(method, params = {}) {
  if (method === 'Page.navigate') await coverage.capture(evaluate);
  if (transportFailure) return Promise.reject(transportFailure);
  const id = ++sequence;
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function waitFor(expression, label) {
  await eventually(async () => {
    assert.ok(await evaluate('Boolean(' + expression + ')'), label + ': ' + await evaluate('document.body.innerText.slice(0, 1200)'));
    return true;
  }, label);
}

async function navigate(section, extra = '', repository = 'example') {
  await cdp('Page.navigate', { url: url + '/?tenant=local&repo=' + encodeURIComponent(repository) + '&section=' + section + extra });
}

async function screenshot(name) {
  const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(outDir, name + '.png'), Buffer.from(image.data, 'base64'));
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const signal = name => {
    try { process.platform === 'win32' ? child.kill(name) : process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolveListen); });
  const selected = probe.address().port;
  await new Promise(resolveClose => probe.close(resolveClose));
  return selected;
}

async function findChrome() {
  for (const candidate of [process.env.CHROME_BIN, process.env.GOOGLE_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Chrome executable not found; set CHROME_BIN');
}
