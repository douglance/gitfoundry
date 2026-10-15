import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = process.env.GFY_WEB_GATE_APP_ROOT || resolve(scriptDir, '..');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
const outDir = resolve(process.env.GFY_WEB_GATE_OUT_DIR || join(process.env.TMPDIR || '/tmp', 'gitfoundry-p1-web-browser-gate-' + stamp));
const serverPort = Number(process.env.GFY_WEB_GATE_PORT || process.env.PORT || await freePort());
const debugPort = Number(process.env.GFY_WEB_GATE_DEBUG_PORT || await freePort());
const chromePath = await findChrome();
const profileDir = join(outDir, 'profile');
const baseUrl = 'http://127.0.0.1:' + serverPort;
const screenshots = [];
let server;
let chrome;
let ws;
let seq = 1;
const pending = new Map();
const runtimeErrors = [];
let chromeDiagnostic = "";
const navigationEvents = [];
const networkRequests = new Map();

await mkdir(outDir, { recursive: true });

let forgeFixture = null;
const forgeFixtureRequests = new Set();
const fixtureRevision = digit => digit.repeat(40);
const forgeVersions = [
 {version_commit:fixtureRevision('1'), descriptor:{fork_id:'Accepted baseline', parents:[],code_commit:fixtureRevision('a'),state_commit:fixtureRevision('5'),creator_id:'developer',creator_kind:'human'}},
 {version_commit:fixtureRevision('2'), descriptor:{fork_id:'Explore caching', parents:[fixtureRevision('1')],code_commit:fixtureRevision('b'),state_commit:fixtureRevision('6'),creator_id:'agent-a',creator_kind:'agent'}},
 {version_commit:fixtureRevision('3'), descriptor:{fork_id:'Explore indexing', parents:[fixtureRevision('1')],code_commit:fixtureRevision('c'),state_commit:fixtureRevision('7'),creator_id:'developer',creator_kind:'human'}},
 {version_commit:fixtureRevision('4'), descriptor:{fork_id:'Integration candidate',parents:[fixtureRevision('2'),fixtureRevision('3')],code_commit:fixtureRevision('d'),state_commit:fixtureRevision('8'),creator_id:'developer',creator_kind:'human'}}
];
async function fulfillForgeFixture(params) {
  if (!forgeFixture) return cdp('Fetch.continueRequest',{requestId:params.requestId});
  const url=new URL(params.request.url), action=url.pathname.split('/').pop();
  let body={}, responseCode=200;
  if (forgeFixture.fail) { responseCode=503;body={error:'forge_fixture_unavailable',detail:'Forge fixture temporarily unavailable'}; }
  else if(action==='head') body={version:forgeVersions[0]};
  else if(action==='forks') body={versions:forgeVersions};
  else if(action==='files') {
    const version=url.searchParams.get('version'), second=version===fixtureRevision('3');
    if(second) await wait(250);
    body={entries:[{path:second?'checks/indexing.json':'reviews/baseline.json',type:'file'}]};
  } else body={error:'not_found'};
  return cdp('Fetch.fulfillRequest',{requestId:params.requestId,responseCode,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(body)).toString('base64')});
}
async function openForge() {
  await Promise.all([...forgeFixtureRequests]);
  forgeFixture.fail=false;
  await cdp('Page.navigate',{url:baseUrl+'/?tenant=fixture-tenant&repo=core-runtime&section=forks'});
  await waitFor('document.querySelector("[data-fork-workspace]") && !document.body.innerText.includes("Loading fork lineage")','forge fixture loaded');
}

async function forgeRepositoryEntryTest() {
  await cdp('Page.navigate',{url:baseUrl+'/?tenant=fixture-tenant'});
  await waitFor('document.querySelector("[data-id=core-runtime]")','repository list');
  await click('[data-id=core-runtime]');
  await waitFor('document.querySelector(".repository-navigation [role=tab][aria-selected=true]")?.textContent.trim()==="Forge" && document.querySelector(".lineage-explorer")','repository selected Forge and loaded lineage');
  assert('repository opens lineage',await evalv('Boolean(document.querySelector(".lineage-explorer"))'));
  await captureNamed('forge-repository-entry-1440');
  await Promise.all([...forgeFixtureRequests]);
  await cdp('Page.navigate',{url:baseUrl+'/?tenant=fixture-tenant'});
  await waitFor('document.querySelector("[data-id=core-runtime]")','repository palette entry');
  await click('[data-command-trigger]');
  await waitFor("document.querySelector('input[aria-label=\"Search commands\"]')",'repository command search');
  await fill('input[aria-label="Search commands"]','core / runtime');
  await waitFor('Array.from(document.querySelectorAll("[role=option]")).some(item=>item.textContent.includes("core / runtime"))','repository palette result');
  await evalv('Array.from(document.querySelectorAll("[role=option]")).find(item=>item.textContent.includes("core / runtime")).click()');
  await waitFor('document.querySelector("[data-fork-workspace]") && !document.body.innerText.includes("Loading fork lineage")','repository palette opens Forge');
  assert('palette opens lineage',await evalv('Boolean(document.querySelector(".lineage-explorer"))'));
  await captureNamed('forge-palette-entry-1440');
}

async function forgeRecordedAncestryTest() {
  await openForge();
  assert('four unique complete versions',await evalv('document.querySelectorAll(".lineage-node").length===4'));
  const edges=await evalv('Array.from(document.querySelectorAll(".lineage-edges > path")).map(p=>[p.dataset.parent,p.dataset.child])');
  assert('exact four ancestry relationships',JSON.stringify(edges)===JSON.stringify([['1'.repeat(40),'2'.repeat(40)],['1'.repeat(40),'3'.repeat(40)],['2'.repeat(40),'4'.repeat(40)],['3'.repeat(40),'4'.repeat(40)]]),JSON.stringify(edges));
  await captureNamed('forge-ancestry-1440');
}

async function forgeExactVersionSelectionTest() {
  await openForge();
  assert('version selection available',await evalv('Boolean(document.querySelector(".lineage-node"))'));
  await waitFor('document.querySelector("[data-state-documents]")?.innerText.includes("reviews/baseline.json")','baseline records');
  await click('[data-fork-node="'+ '3'.repeat(40)+'"]');
  await waitFor('document.querySelector("[data-fork-review]")?.innerText.includes("c".repeat(40))','selected code');
  assert('old records cleared during loading',await evalv('!document.querySelector("[data-state-documents]").innerText.includes("reviews/baseline.json")'));
  await waitFor('document.querySelector("[data-state-documents]").innerText.includes("checks/indexing.json")','selected records');
  assert('selected state root visible',await evalv('document.querySelector("[data-fork-review]").innerText.includes("7".repeat(40))'));
  await captureNamed('forge-selection-1440');
}

async function forgeExactCodeNavigationTest() {
  await openForge();
  assert('selected version node available',await evalv('Boolean(document.querySelector(".lineage-node"))'));
  await click('[data-fork-node="'+ '3'.repeat(40)+'"]');
  await waitFor('document.querySelector("[data-fork-review]")?.innerText.includes("c".repeat(40))','exact code target');
  await waitFor('document.querySelector(\"[data-state-documents]\").innerText.includes(\"checks/indexing.json\")','selected records before navigation');
  const buttons=await evalv('Array.from(document.querySelectorAll("[data-fork-review] button")).map((b,i)=>[i,b.textContent])');
  const target=buttons.find(([,label])=>label==='Browse exact code');
  assert('browse exact code action visible',Boolean(target));
  await click('[data-fork-review] button:nth-of-type('+(target[0]+1)+')');
  await waitFor('new URLSearchParams(location.search).get("section")==="code"','code navigation');
  assert('exact selected code ref',await evalv('new URLSearchParams(location.search).get("ref")==="c".repeat(40)'));
  await captureNamed('forge-exact-code-1440');
}

async function forgeRequestFailureTest() {
  await openForge();
  assert('successful lineage before failure',await evalv('Boolean(document.querySelector(".lineage-node"))'));
  await Promise.all([...forgeFixtureRequests]); forgeFixture.fail=true; await cdp('Page.reload');
  await waitFor('document.body.innerText.includes("Forge API unavailable")','forge error');
  assert('retry action retained',await evalv('Array.from(document.querySelectorAll("[data-fork-workspace] button")).some(b=>b.textContent==="Refresh" && !b.disabled)'));
  assert('failed request shows no fabricated versions',await evalv('document.querySelectorAll(".lineage-node").length===0'));
  await waitFor('!document.querySelector("footer")?.innerText.includes("Loading workspace")','workspace lists settle');
  assert('failed forge list shows no fabricated count',await evalv('/—/.test(document.querySelector("[data-workspace-section=\\"forks\\"]")?.innerText ?? "") && !/\\b0\\b/.test(document.querySelector("[data-workspace-section=\\"forks\\"]")?.innerText ?? "")'));
  await captureNamed('forge-error-1440');
}

async function forgeNarrowWorkspaceTest() {
  for(const width of [390,1024,1440]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
    await openForge();
    assert('scrollable lineage available at '+width,await evalv('Boolean(document.querySelector(".lineage-scroll"))'));
    assert('graph scroll remains inside region at '+width,await evalv('getComputedStyle(document.querySelector(".lineage-scroll")).overflowX==="auto" && document.documentElement.scrollWidth<=innerWidth+1'));
    await captureNamed('forge-responsive-'+width);
    if(width>=1024) {
      assert('selected version identities visible at '+width,await evalv('(() => { const panel=document.querySelector("[data-fork-review]"), footer=document.querySelector("footer").getBoundingClientRect().top; return ["Code commit","State commit"].every(label => { const row=Array.from(panel.querySelectorAll(".fork-revision-rows > div")).find(item=>item.querySelector("dt").textContent===label), bounds=row.getBoundingClientRect(); return bounds.top>=0 && bounds.bottom<=footer; }); })()'));
      assert('lineage guidance clear of footer at '+width,await evalv('document.querySelector(".lineage-help").getBoundingClientRect().bottom<=document.querySelector("footer").getBoundingClientRect().top'));
    }
  }
}

async function exerciseForgeWorkspace() {
  forgeFixture={fail:false};
  await cdp('Fetch.enable',{patterns:[{urlPattern:'*/api/v2/*/forge/*',requestStage:'Request'}]});
  const failures=[];
  async function scenario(name,run) {
    try {await run();console.log(JSON.stringify({scenario:name,passed:true}));}
    catch(error){failures.push({name,error:String(error.message)});console.error(JSON.stringify({scenario:name,passed:false,error:String(error.message)}));}
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await scenario('Repository opens in Forge',forgeRepositoryEntryTest);
  await scenario('Recorded ancestry',forgeRecordedAncestryTest);
  await scenario('Exact-version selection',forgeExactVersionSelectionTest);
  await scenario('Exact code navigation',forgeExactCodeNavigationTest);
  await scenario('Forge request failure',forgeRequestFailureTest);
  await scenario('Narrow workspace',forgeNarrowWorkspaceTest);
  await Promise.all([...forgeFixtureRequests]);
  await cdp('Fetch.disable');forgeFixture=null;
  assert('all Forge workspace scenarios pass',failures.length===0,JSON.stringify(failures));
}

try {
  await buildCurrentWeb();
  server = await startHarness();
  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profileDir,
    '--window-size=390,1000',
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', chunk => { chromeDiagnostic = (chromeDiagnostic + chunk.toString()).slice(-4000); });

  ws = await connectChrome();
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Page.bringToFront');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });

  await exerciseForgeWorkspace();
  if (process.env.GFY_WEB_FORGE_ONLY !== '1') {
  await exerciseUrlNavigation();
  await exerciseInteractions();
  await captureResponsiveStates();
  await captureAdditionalStates();
  await exerciseSourceViews();
  await exerciseUnifiedCommands();
  await exerciseLiveUpdates();
  }
  assert('no browser runtime errors', runtimeErrors.length === 0, JSON.stringify(runtimeErrors));

  console.log(JSON.stringify({
    ok: true,
    fixture: true,
    outDir,
    ports: { server: serverPort, debug: debugPort },
    screenshots
  }, null, 2));
} finally {
  if (ws) ws.close();
  if (chrome && !chrome.killed) chrome.kill('SIGTERM'); chrome?.stderr?.destroy();
  if (server && !server.killed) server.kill('SIGTERM');
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}


async function exerciseLiveUpdates() {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1376, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: baseUrl + '/?tenant=fixture-tenant&repo=core-runtime&section=reviews' });
  await waitFor('document.body.innerText.includes("Live") && document.querySelector(' + JSON.stringify('[data-id="core-runtime~rev-9"]') + ')', 'live review workspace');
  const published = await evalv(`(async () => {
    const root = '/api/v2/tenants/fixture-tenant/repositories/core-runtime/forge';
    const request = async (path, body) => {
      const response = await fetch(root + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
      if (!response.ok) throw new Error('forge fixture request failed: ' + response.status);
      return response.json();
    };
    const head = (await request('/head')).version;
    const record = { schema_version: 1, kind: 'review', id: 'rev-live', decision: 'approve', candidate_code_commit: head.descriptor.code_commit, actor_id: 'fixture-reviewer', reason: 'SSE pushed review', body: 'SSE pushed review' };
    const candidate = (await request('/commit', { parent_version: head.version_commit, operation_id: 'fixture-live-review-commit', changes: [{ tree: 'state', path: 'reviews/rev-live.json', content_base64: btoa(JSON.stringify(record)) }] })).version;
    const accepted = (await request('/publish', { expected_head: head.version_commit, new_version: candidate.version_commit, operation_id: 'fixture-live-review-publish' })).version;
    const stored = await request('/files?version=' + encodeURIComponent(accepted.version_commit) + '&tree=state&path=reviews%2Frev-live.json');
    return { beforeCode: head.descriptor.code_commit, afterCode: accepted.descriptor.code_commit, record: JSON.parse(atob(stored.content)), version: stored.version.version_commit, acceptedVersion: accepted.version_commit };
  })()`);
  assert('review publication preserves code revision', published.beforeCode === published.afterCode, JSON.stringify(published));
  assert('live review has an exact durable Git record', published.version === published.acceptedVersion && published.record.id === 'rev-live' && published.record.reason === 'SSE pushed review' && published.record.candidate_code_commit === published.beforeCode, JSON.stringify(published));
  await waitFor('document.querySelector(' + JSON.stringify('[data-id="core-runtime~rev-live"]') + ')', 'published review appears without manual refresh');
  await click('[data-id="core-runtime~rev-live"]');
  await waitFor('document.body.innerText.includes("SSE pushed review")', 'published review explanation visible');
  await captureNamed('live-review-update');
}

async function exerciseUnifiedCommands() {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1376, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: baseUrl + '/?tenant=fixture-tenant&repo=core-runtime&section=code' });
  await waitFor('document.querySelector("[data-source-file]")', 'command workspace loaded');
  await evalv('(() => { window.__commandRequests = []; const original = window.fetch; window.fetch = (...args) => { window.__commandRequests.push({ url: String(args[0]), method: args[1]?.method || "GET" }); return original(...args); }; })()');
  await click('[data-command-trigger]');
  await waitFor('document.querySelectorAll("[data-command-category]").length >= 1', 'catalog categories visible');
  await captureNamed('shared-command-categories');
  await fill('input[aria-label="Search commands"]', 'gfy forge list');
  await waitFor('Array.from(document.querySelectorAll("[role=option]")).some(item => item.textContent.includes("forge list"))', 'CLI spelling finds fork command');
  assert('menu title omits executable prefix', await evalv('Array.from(document.querySelectorAll("[role=option] code")).some(title => title.textContent === "forge list") && Array.from(document.querySelectorAll("[role=option] code")).every(title => !title.textContent.startsWith("gfy "))'));
  assert('fork command category visible', await evalv('document.querySelector("[data-command-category=forge]")?.textContent === "Forks"'));
  await captureNamed('shared-command-search');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  assert('categorized command menu fits mobile', await evalv('(() => { const dialog = document.querySelector("[role=dialog]"); return dialog && dialog.getBoundingClientRect().width <= innerWidth && dialog.scrollWidth <= dialog.clientWidth; })()'));
  assert('mobile descriptions wrap without clipping', await evalv('Array.from(document.querySelectorAll("[data-command-description]")).every(description => description.scrollWidth <= description.clientWidth && description.scrollHeight <= description.clientHeight)'));
  await captureNamed('shared-command-search-mobile');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1376, height: 900, deviceScaleFactor: 1, mobile: false });
  await fill('input[aria-label="Search commands"]', 'gfy_forge_publish');
  await waitFor('Array.from(document.querySelectorAll("[role=option]")).some(item => item.textContent.includes("forge publish"))', 'MCP name finds fork publish command');
  await evalv('Array.from(document.querySelectorAll("[role=option]")).find(item => item.textContent.includes("forge publish")).click()');
  await waitFor('Array.from(document.querySelectorAll("[role=option]")).some(item => item.textContent.includes("forge publish"))', 'publish command search');
  await evalv('Array.from(document.querySelectorAll("[role=option]")).find(item => item.textContent.includes("forge publish")).click()');
  await waitFor('document.querySelector("[data-command-dialog]")?.getAttribute("data-command-dialog") === "forge.publish"', 'publish command inputs');
  assert('publish fields generated from catalog', await evalv('Boolean(document.getElementById("command-expected_head") && document.getElementById("command-new_version") && document.getElementById("command-operation_id"))'));
  assert('opening mutation does not send POST', await evalv('!window.__commandRequests.some(request => request.method === "POST")'));
  await captureNamed('shared-command-publish-desktop');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  assert('command form fits narrow viewport', await evalv('(() => { const dialog = document.querySelector("[data-command-dialog]"); return dialog.getBoundingClientRect().width <= innerWidth && dialog.scrollWidth <= dialog.clientWidth; })()'));
  await captureNamed('shared-command-publish-mobile');
  for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor('!document.querySelector("[data-command-dialog]")', 'publish form closes without executing');
}

async function exerciseSourceViews() {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1376, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: baseUrl + '/?tenant=fixture-tenant&repo=core-runtime&section=code' });
  await waitFor('document.querySelector("[data-source-file]")?.getAttribute("data-source-file") === "README.md"', 'source README');
  assert('source snapshot visible', await evalv('document.body.innerText.includes("Snapshot")'));
  await evalv('(() => { const root = document.querySelector("[data-source-tree]").shadowRoot; const row = Array.from(root.querySelectorAll("[role=treeitem]")).find(row => row.getAttribute("data-item-path") === "hello.mjs"); if (!row) throw new Error("hello file missing"); row.click(); })()');
  await waitFor('document.querySelector("[data-source-file]")?.getAttribute("data-source-file") === "hello.mjs"', 'tree file selection');
  await click('button[data-compare-toggle]');
  await fill('#source-base', 'main');
  await fill('#source-head', 'p1-api');
  await click('.source-toolbar button[type=submit]');
  await waitFor('document.querySelector("[data-source-diff] diffs-container")', 'Pierre comparison');
  const diffText = await evalv('document.querySelector("[data-source-diff] diffs-container").shadowRoot.textContent');
  assert('rendered comparison includes independently expected before and after', diffText.includes('before') && diffText.includes('after'));
  await waitFor('new URLSearchParams(location.search).get("mode") === "compare" && new URLSearchParams(location.search).get("base") === "main" && new URLSearchParams(location.search).get("head") === "p1-api"', 'comparison pair URL');
  await click('button[aria-label="Diff layout"]');
  await evalv('Array.from(document.querySelectorAll("[role=option]")).find(item => item.textContent.trim() === "Split").click()');
  await waitFor('new URLSearchParams(location.search).get("layout") === "split"', 'split layout URL');
  await cdp('Page.reload');
  await waitFor('document.querySelector("[data-source-diff] diffs-container") && document.querySelector("button[aria-label=\\"Diff layout\\"]")?.textContent.includes("Split")', 'comparison reload');
  await captureSource('gitfoundry-source-diff');
  await click('button[data-compare-toggle]');
  await waitFor('document.querySelector("[data-source-file]")?.getAttribute("data-source-file") === "README.md"', 'source after comparison');
  await fill('#source-ref', 'missing-ref');
  await click('.source-toolbar button[type=submit]');
  await waitFor('document.body.innerText.includes("Source unavailable") && !document.querySelector("[data-source-file]")', 'source ref failure clears stale file');
  await fill('#source-ref', 'main');
  await click('.source-toolbar button[type=submit]');
  await waitFor('document.querySelector("[data-source-file]")?.getAttribute("data-source-file") === "README.md"', 'source recovery');
  await captureSource('gitfoundry-source-desktop');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click('.source-mobile-files button');
  await waitFor('document.querySelector("[role=dialog]") && document.getAnimations().every(a => a.effect.getTiming().duration === "auto" || a.playState !== "running")', 'mobile file picker settled');
  await captureSource('gitfoundry-source-files-mobile');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor('!document.querySelector("[role=dialog]")', 'file picker closes with Escape');
  assert('file picker returns focus', await evalv('document.activeElement.textContent.includes("Files")'));
  for (const width of [390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    assert('source page fits mobile ' + width, await evalv('document.documentElement.scrollWidth <= window.innerWidth'));
    await captureSource('gitfoundry-source-mobile' + width);
  }
}

async function captureSource(name) {
  const capture = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(outDir, name + '.png');
  await writeFile(file, Buffer.from(capture.data, 'base64'));
  screenshots.push({ name, file, fixture: true });
}

async function buildCurrentWeb() {
  const child = spawn(process.execPath, ['scripts/build.mjs'], { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-12000); });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
  let code, signal;
  try { [code, signal] = await once(child, 'exit'); } finally { clearTimeout(deadline); }
  if (code !== 0) throw new Error('Current web build failed (' + (signal || code) + '): ' + diagnostic);
}

async function startHarness() {
  const child = spawn(process.execPath, ['scripts/harness-server.mjs'], {
    cwd: appRoot,
    env: { ...process.env, PORT: String(serverPort) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); rejectReady(new Error('fixture server start timeout')); }, 6000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('gitfoundry web harness listening')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectReady(new Error('fixture server exited before ready: ' + code));
    });
  });
  return child;
}

async function connectChrome() {
  const pages = await waitJson('http://127.0.0.1:' + debugPort + '/json/list');
  const page = pages.find((item) => item.type === 'page') || pages[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error('Chrome debug page not found');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await Promise.race([once(socket, 'open'), new Promise((_, reject) => { const timeout = setTimeout(() => { socket.close(); reject(new Error('Chrome WebSocket open timeout')); }, 8000); socket.addEventListener('open', () => clearTimeout(timeout), { once: true }); })]);
  socket.addEventListener('message', handleCdpMessage);
  return socket;
}

function handleCdpMessage(event) {
  const message = JSON.parse(String(event.data));
  if (message.method === 'Fetch.requestPaused') {
    const request=fulfillForgeFixture(message.params); forgeFixtureRequests.add(request);
    request.catch(error => runtimeErrors.push(String(error))).finally(()=>forgeFixtureRequests.delete(request)); return;
  }
  if (message.method === 'Network.requestWillBeSent') networkRequests.set(message.params.requestId, { url: message.params.request.url, type: message.params.type, started: Date.now() });
  if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') networkRequests.delete(message.params.requestId);
  if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  if (message.method === 'Network.requestWillBeSent' || message.method === 'Network.responseReceived' || message.method === 'Network.loadingFailed') {
    navigationEvents.push({ method: message.method, url: message.params.request?.url || message.params.response?.url, status: message.params.response?.status, error: message.params.errorText });
    if (navigationEvents.length > 12) navigationEvents.shift();
  }
  if (!message.id || !pending.has(message.id)) return;
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
}

function cdp(method, params = {}) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Chrome request timed out: " + method + (params.url ? " " + params.url : "")));
      console.error(JSON.stringify({ chromeDiagnostic, navigationEvents }));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

async function evalv(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function waitFor(expression, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evalv('Boolean(' + expression + ')')) return;
    } catch {}
    await wait(80);
  }
  let text = '';
  try { text = await evalv('document.body.innerText.slice(0, 1200)'); } catch {}
  const controls = await evalv('Array.from(document.querySelectorAll("input,textarea,button[role=combobox]")).map(el => ({tag:el.tagName, name:el.name, id:el.id, label:el.getAttribute("aria-label")}))').catch(() => []);
  const animations = await evalv('document.getAnimations().map(a => ({name:a.animationName, state:a.playState, timing:a.effect.getTiming()}))');
  console.log(JSON.stringify({ browserFailure: label, runtimeErrors, controls, text: text?.slice(0, 1000), pendingRequests: [...networkRequests.values()].filter(request => ['Fetch', 'XHR', 'EventSource'].includes(request.type)).slice(-20).map(request => ({ url: request.url, type: request.type, age_ms: Date.now() - request.started })) }));
  throw new Error('timeout waiting for ' + label + '\nurl: ' + await evalv('location.href') + '\nruntime errors: ' + JSON.stringify(runtimeErrors) + '\nanimations: ' + JSON.stringify(animations) + (text ? '\n' + text : '') + '\ncontrols: ' + JSON.stringify(controls));
}

async function fill(selector, value) {
  await evalv(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

async function click(selector) {
  if (selector.includes('[data-section=')) {
    const exists = await evalv('Boolean(document.querySelector(' + JSON.stringify(selector) + '))');
    if (!exists) selector = selector.replace('data-section=', 'data-workspace-section=');
  }
  if (selector.includes('[data-workspace-section=')) {
    const visible = await evalv('Array.from(document.querySelectorAll(' + JSON.stringify(selector) + ')).some(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")');
    if (!visible) {
      await click('.workspace-chrome-footer button[aria-label="Toggle workspace navigation"]');
      await waitFor('document.querySelector("[data-sidebar=sidebar][data-mobile=true]")?.getAttribute("data-state") === "expanded"', 'global navigation open');
    }
  }
  await evalv(`(() => { const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(candidate => candidate.getClientRects().length > 0 && getComputedStyle(candidate).visibility !== 'hidden'); if (!el) throw new Error('missing ${selector}'); el.click(); })()`);
}

function assert(name, condition, detail = '') {
  if (!condition) throw new Error(name + (detail ? ': ' + detail : ''));
}

async function loadWorkspace(tenant) {
  if (!(await evalv('Boolean(document.querySelector("[data-command-trigger]"))'))) {
    await cdp('Page.navigate', { url: baseUrl + '/?tenant=' + encodeURIComponent(tenant) });
    await waitFor('document.querySelector("[data-command-trigger]")', 'workspace opens');
    return;
  }
  await click('[data-command-trigger]');
  await waitFor('document.querySelector("input[aria-label=\\"Search commands\\"]")', 'command palette');
  await fill('input[aria-label="Search commands"]', 'Change workspace');
  await waitFor('Array.from(document.querySelectorAll("[role=option]")).some(item => item.textContent.includes("Change workspace"))', 'workspace command');
  await evalv('Array.from(document.querySelectorAll("[role=option]")).find(item => item.textContent.includes("Change workspace")).click()');
  await waitFor('document.querySelector("#tenant-form")', 'workspace dialog');
  await fill('input[name=tenant]', tenant);
  await click('#tenant-form button[type=submit]');
  await waitFor('!document.querySelector("#tenant-form")', 'workspace dialog closes');
}

async function exerciseUrlNavigation() {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1376, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: baseUrl + '/?tenant=fixture-tenant&repo=core-runtime&section=code&ref=main&file=hello.mjs' });
  await waitFor('document.querySelector("[data-source-file]")?.getAttribute("data-source-file") === "hello.mjs"', 'direct source URL');
  assert('header removed', await evalv('!document.querySelector(".global-header") && !document.querySelector("#tenant-form")'));
  assert('repository context', await evalv('document.querySelector("h1").textContent === "core / runtime" && Boolean(document.querySelector("[aria-label=\\"Repository sections\\"]"))'));
  assert('repository card URLs encoded', await evalv('Array.from(document.querySelectorAll("[data-workspace-section]")).every(item => item.tagName === "A" && item.getAttribute("href"))'));
  await evalv('document.querySelector("[data-source-tree]").shadowRoot.querySelector("[data-item-path=\\"README.md\\"]").click()');
  await waitFor('new URLSearchParams(location.search).get("file") === "README.md" && document.querySelector("[data-source-file]")?.getAttribute("data-source-file") === "README.md"', 'file selection URL');
  await evalv('history.back()');
  await waitFor('document.querySelector("[data-source-file]")?.getAttribute("data-source-file") === "hello.mjs"', 'back restores source file');
  await evalv('history.forward()');
  await waitFor('document.querySelector("[data-source-file]")?.getAttribute("data-source-file") === "README.md"', 'forward restores source file');
  await cdp('Page.reload');
  await waitFor('document.querySelector("[data-source-file]")?.getAttribute("data-source-file") === "README.md"', 'reload restores source');
  await click('.repository-navigation [data-section="issues"]');
  await waitFor('document.querySelector("[data-id=\\"core-runtime~iss-101\\"]")', 'repository issue list');
  await click('[data-id="core-runtime~iss-101"]');
  await waitFor('new URLSearchParams(location.search).get("record") === "core-runtime~iss-101" && document.querySelector("#comment-create-form")', 'record URL');
  await cdp('Page.reload');
  await waitFor('document.querySelector("#comment-create-form")', 'record reload');
  await click('[data-workspace-section="checks"]');
  await waitFor('!new URLSearchParams(location.search).has("repo") && document.querySelector("#panel-title")?.textContent === "Checks"', 'global navigation exits repository');
  assert('global views have no repository tabs', await evalv('!document.querySelector(".repository-navigation")'));
  await evalv('window.__navigationSentinel = true');
  for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await waitFor('document.querySelector("input[aria-label=\\"Search commands\\"]")', 'Ctrl K palette');
  await fill('input[aria-label="Search commands"]', 'core / runtime');
  await waitFor('document.querySelector("[role=option]")?.textContent.includes("core / runtime")', 'repository palette result');
  for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor('new URLSearchParams(location.search).get("repo") === "core-runtime" && document.querySelector("[data-fork-workspace]")', 'keyboard palette opens repository forge');
  assert('palette navigation keeps SPA document', await evalv('window.__navigationSentinel === true'));
  const targetIds = new Set((await cdp('Target.getTargets')).targetInfos.map(target => target.targetId));
  await click('.repository-navigation [data-section="code"]');
  await waitFor('new URLSearchParams(location.search).get("file") === "README.md"', 'source default file URL settles');
  const originalUrl = await evalv('location.href');
  await click('[data-command-trigger]');
  await fill('input[aria-label="Search commands"]', 'docs / handbook');
  await waitFor('document.querySelector("[role=option]")?.textContent.includes("docs / handbook")', 'new tab palette result');
  for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13 });
  const newTab = (await cdp('Target.getTargets')).targetInfos.find(target => !targetIds.has(target.targetId) && target.type === 'page');
  assert('modified palette command opens a tab', Boolean(newTab));
  assert('new tab command leaves current view unchanged', await evalv('location.href') === originalUrl, JSON.stringify({ originalUrl, currentUrl: await evalv('location.href') }));
  await cdp('Target.closeTarget', { targetId: newTab.targetId });
  await cdp('Page.bringToFront');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await waitFor('document.documentElement.getAttribute("data-mode") === "dark"', 'system dark mode');
  await captureNamed('system-dark');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await waitFor('document.documentElement.getAttribute("data-mode") === "light"', 'system light mode');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitFor('document.documentElement.scrollWidth <= window.innerWidth', 'footer mobile width');
  assert('sidebar trigger bottom left', await evalv('(() => { const r=document.querySelector(".workspace-chrome-footer button[aria-label=\\"Toggle workspace navigation\\"]").getBoundingClientRect(); return r.left < 40 && r.top > window.innerHeight - 140; })()'));
  await waitFor('parseFloat(getComputedStyle(document.querySelector(".forge-shell")).paddingBottom) >= document.querySelector(".workspace-chrome-footer").getBoundingClientRect().height', 'footer resize reservation');
  assert('footer does not cover last content', await evalv('parseFloat(getComputedStyle(document.querySelector(".forge-shell")).paddingBottom) >= document.querySelector(".workspace-chrome-footer").getBoundingClientRect().height'));
  await click('.workspace-chrome-footer button[aria-label="Toggle workspace navigation"]');
  await waitFor('document.querySelector("[data-sidebar=sidebar][data-mobile=true]")?.getAttribute("data-state") === "expanded"', 'bottom toggle opens sidebar');
  await click('button[aria-label="Close workspace navigation"]');
  await waitFor('document.querySelector("[data-sidebar=sidebar][data-mobile=true]")?.getAttribute("data-state") === "collapsed"', 'bottom sidebar close');
  await captureNamed('footer-mobile');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1376, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: baseUrl });
  await waitFor('document.querySelector("#sign-in-email") && document.body.innerText.includes("Sign in to GitFoundry")', 'return to sign-in');
}

async function exerciseInteractions() {
  await waitFor('document.querySelector("#sign-in-email") && document.body.innerText.includes("Sign in to GitFoundry")', 'ready');
  assert('header removed', await evalv('!document.querySelector(".global-header") && !document.querySelector("#tenant-form")'));
  await loadWorkspace('fixture-tenant');
  await waitFor('document.querySelectorAll(".record-control[data-id]").length >= 2', 'repo load');
  await fill('input[name=search]', 'runtime');
  await waitFor('document.querySelectorAll(".record-control[data-id]").length === 1 && new URLSearchParams(location.search).get("q") === "runtime"', 'repository search URL');
  await cdp('Page.reload');
  await waitFor('document.querySelectorAll(".record-control[data-id]").length === 1 && document.querySelector("input[name=search]").value === "runtime"', 'search reload');
  await fill('input[name=search]', 'no-matching-repository');
  await waitFor('document.body.innerText.includes("No matching repositories")', 'search empty');
  await fill('input[name=search]', '');
  await waitFor('document.querySelectorAll(".record-control[data-id]").length >= 2', 'search cleared');
  await click('[data-id="core-runtime"]');
  await waitFor('document.querySelector("[data-fork-workspace]")', 'repo enters forge');
  await click('[data-section="issues"]');
  await waitFor('document.body.innerText.includes("Reauthorize tool call")', 'issues');
  await click('#new-record-button');
  await waitFor('new URLSearchParams(location.search).get("create") === "true"', 'create form URL');
  await fill('#issue-create-form input[name=title]', 'Browser gate issue');
  await fill('#issue-create-form textarea[name=body]', 'Created by browser gate.');
  await click('#issue-create-form button[type=submit]');
  await waitFor('document.body.innerText.includes("Browser gate issue") && (document.body.innerText.includes("Workspace updated.") || document.body.innerText.includes("Issue create request finished."))', 'issue document published');
  await click('[data-id="core-runtime~iss-101"]');
  await waitFor('document.querySelector("#comment-create-form")', 'comment form');
  await fill('#comment-create-form textarea[name=body]', 'Browser gate comment');
  await click('#comment-create-form button[type=submit]');
  await waitFor('document.body.innerText.includes("Comment request finished.")', 'comment document published');
  await click('[data-section="forks"]');
  await waitFor('document.querySelector("[data-fork-workspace]") && document.body.innerText.includes("Fork this forge")', 'fork panel');
  await waitFor('document.body.innerText.includes("Forge API unavailable") || document.body.innerText.includes("No published fork versions") || document.body.innerText.includes("Selected fork")', 'fork panel state');
  const forkPanelText = await evalv('document.querySelector("[data-fork-workspace]").innerText');
  assert('fork panel keeps PR language out of the repository surface', forkPanelText.includes('Forge') && !/pull request|\bPR\b/i.test(forkPanelText), forkPanelText);
  assert('fork panel exposes required actions', ['Fork this forge', 'Refresh'].every(label => forkPanelText.includes(label)), forkPanelText);
  await captureNamed('forks-panel');

  await click('[data-section="reviews"]');
  await waitFor('document.body.innerText.includes("rev-9") && document.body.innerText.includes("pending")', 'review list');
  await click('[data-id="core-runtime~rev-9"]');
  await waitFor('document.querySelector(".record-inspection")', 'inspect exact review record');
  assert('historical decisions cannot be overwritten', await evalv('!document.querySelector("#review-submit-form") && !document.querySelector("#review-dismiss-form")'));

  await click('[data-section="issues"]');
  await waitFor('document.body.innerText.includes("Reauthorize tool call")', 'issues after review flow');

  await loadWorkspace('empty-tenant');
  await waitFor('document.body.innerText.includes("No issues yet")', 'empty');
  await loadWorkspace('slow-tenant');
  await waitFor('document.body.innerText.includes("Loading issues")', 'loading', 1200);
  await waitFor('document.body.innerText.includes("Reauthorize tool call")', 'slow loaded');
  await loadWorkspace('slow-tenant');
  await waitFor('document.querySelector(".workspace-chrome-status").textContent.includes("Loading workspace")', 'pending tenant request');
  await loadWorkspace('empty-tenant');
  await waitFor('document.body.innerText.includes("No issues yet")', 'replacement tenant response');
  await wait(1600);
  assert('late tenant responses cannot repopulate another workspace', await evalv('new URLSearchParams(location.search).get("tenant") === "empty-tenant" && document.querySelectorAll(".record-control[data-id]").length === 0'));
}

async function captureResponsiveStates() {
  for (const viewport of [
    { name: 'mobile390', width: 390, height: 844, mobile: true },
    { name: 'mobile320', width: 320, height: 844, mobile: true },
    { name: 'desktop', width: 1440, height: 1000, mobile: false }
  ]) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile
    });
    await cdp('Page.navigate', { url: baseUrl + '/?tenant=fixture-tenant&repo=core-runtime&section=forks' });
    await waitFor('document.querySelector("[data-fork-workspace]")', viewport.name + ' direct forks workspace');

    const measurement = await evalv(`(() => {
      const offenders = [...document.body.querySelectorAll('*')].filter(el => !el.closest('[data-sidebar=sidebar][data-mobile=true][data-state=collapsed]')).map((el) => {
        const rect = el.getBoundingClientRect();
        let left = rect.left, right = rect.right;
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (/hidden|auto|scroll|clip/.test(getComputedStyle(parent).overflowX)) {
            const bounds = parent.getBoundingClientRect();
            left = Math.max(left, bounds.left);
            right = Math.min(right, bounds.right);
          }
        }
        return {
          tag: el.tagName,
          cls: String(el.className || ''),
          text: (el.innerText || '').slice(0, 40),
          left: Math.floor(left),
          right: Math.ceil(right)
        };
      }).filter((item) => item.right > item.left && (item.right > ${viewport.width} + 1 || item.left < -1)).slice(0, 8);
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        offenders
      };
    })()`);
    if (measurement.innerWidth !== viewport.width || measurement.scrollWidth > viewport.width) await captureNamed(viewport.name + '-overflow');
    assert(
      viewport.name + ' no horizontal overflow',
      measurement.innerWidth === viewport.width && measurement.scrollWidth <= measurement.innerWidth && measurement.bodyScrollWidth <= measurement.innerWidth && measurement.offenders.length === 0,
      JSON.stringify(measurement)
    );


    const clippedRecords = await evalv(`Array.from(document.querySelectorAll('.fork-revision-rows, .fork-revision-rows dd, .fork-node-header, .fork-documents')).filter(element => {
      const card = element.closest('.fork-node, .fork-review-card, .fork-compare-card, .fork-record-card');
      if (!card) return false;
      const bounds = element.getBoundingClientRect(), container = card.getBoundingClientRect();
      return bounds.right > container.right - parseFloat(getComputedStyle(card).paddingRight) + 1 || element.scrollWidth > element.clientWidth + 1;
    }).map(element => ({ className: element.className, width: element.clientWidth, contentWidth: element.scrollWidth }))`);
    assert(viewport.name + ' fork record contents fit their cards', clippedRecords.length === 0, JSON.stringify(clippedRecords));

    if (viewport.mobile) {
      const shortTargets = await evalv('Array.from(document.querySelectorAll(".repository-navigation [role=tab], .detail-heading button, .global-header button, .fork-actions button, [data-fork-workspace] button")).filter(el => el.getClientRects().length && !el.disabled && el.getBoundingClientRect().height < 44).map(el => el.textContent || el.getAttribute("aria-label"))');
      assert(viewport.name + ' touch target height', shortTargets.length === 0, JSON.stringify(shortTargets));
    }
    await waitFor('document.getAnimations().every(animation => !(animation.timeline instanceof DocumentTimeline) || animation.effect.getTiming().iterations === Infinity || animation.playState !== "running")', 'responsive layout settled');
    const capture = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const png = join(outDir, 'gitfoundry-' + viewport.name + '.png');
    await writeFile(png, Buffer.from(capture.data, 'base64'));
    screenshots.push(png);
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await waitFor('document.documentElement.getAttribute("data-mode") === "dark"', viewport.name + ' dark fork theme');
    await captureNamed('fork-dark-' + viewport.name);
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await waitFor('document.documentElement.getAttribute("data-mode") === "light"', viewport.name + ' restore fork theme');
  }
}


async function captureNamed(name) {
  await waitFor('document.getAnimations().every(animation => !(animation.timeline instanceof DocumentTimeline) || animation.effect.getTiming().iterations === Infinity || animation.playState !== "running")', name + ' layout settled');
  const capture = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const png = join(outDir, 'gitfoundry-' + name + '.png');
  await writeFile(png, Buffer.from(capture.data, 'base64'));
  screenshots.push(png);
}
async function captureAdditionalStates() {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (const [name, query, expression] of [
    ['sign-in', '', 'document.querySelector("#sign-in-email") && document.body.innerText.includes("Sign in to GitFoundry")'],
    ['repositories', '?tenant=fixture-tenant', 'document.querySelectorAll(".record-control[data-id]").length >= 2'],
    ['issues', '?tenant=fixture-tenant&section=issues&record=core-runtime~iss-101', 'document.querySelector("#comment-create-form")'],
    ['reviews', '?tenant=fixture-tenant&section=reviews&record=core-runtime~rev-9', 'document.querySelector(".record-inspection")'],
    ['checks', '?tenant=fixture-tenant&section=checks&record=core-runtime~chk-4', 'document.querySelector("#detail-title")?.textContent === "contract-source"'],
    ['empty', '?tenant=empty-tenant&section=issues', 'document.body.innerText.includes("No issues yet")'],
    ['error', '?tenant=denied-tenant', 'document.body.innerText.includes("gfy_permission_denied")']
  ]) {
    await cdp('Page.navigate', { url: baseUrl + '/' + query });
    await waitFor(expression, name + ' direct URL');
    await captureNamed(name);
  }
  await cdp('Page.navigate', { url: baseUrl + '/?tenant=slow-tenant&section=issues' });
  await waitFor('document.body.innerText.includes("Loading issues")', 'loading capture');
  await captureNamed('loading');
}

async function waitJson(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response.json();
    } catch {}
    await wait(80);
  }
  throw new Error('timeout ' + url);
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    probe.once('error', rejectListen);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('Chrome executable not found; set CHROME_BIN to run the web browser gate');
}
