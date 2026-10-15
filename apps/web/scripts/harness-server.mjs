import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(fileURLToPath(new URL('../dist/', import.meta.url)));
const port = Number(process.env.PORT || 4177);
const fixtureTenant = 'fixture-tenant';
const emptyTenant = 'empty-tenant';
const slowTenant = 'slow-tenant';
const repos = [
  { tenant_id: fixtureTenant, id: 'core-runtime', version: 7, created_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T02:10:00Z', namespace_id: 'core', name: 'runtime', visibility: 'private', default_branch: 'main', archived: false, git_url: 'https://gitfoundry.invalid/core/runtime.git' },
  { tenant_id: fixtureTenant, id: 'docs-handbook', version: 3, created_at: '2026-10-07T18:00:00Z', updated_at: '2026-10-08T01:04:00Z', namespace_id: 'docs', name: 'handbook', visibility: 'internal', default_branch: 'main', archived: false, git_url: 'https://gitfoundry.invalid/docs/handbook.git' }
];
const issues = [
  { id: 'iss-101', repository_id: 'core-runtime', number: 101, title: 'Reauthorize tool call before dispatch', body: 'The grant must be checked at invocation time.', state: 'open', author_id: 'principal-a' }
];
const pulls = [
  { tenant_id: fixtureTenant, id: 'pr-44', version: 2, created_at: '2026-10-08T00:40:00Z', updated_at: '2026-10-08T02:20:00Z', repository_id: 'core-runtime', number: 44, title: 'Wire private worker invoke path', body: 'Review the private worker invocation path before enabling queue flow.', state: 'open', draft: true, source_repository_id: 'core-runtime', source_ref: 'p1-api', head_sha: '0123456789abcdef0123456789abcdef01234567', target_ref: 'main', base_sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd', author_id: 'principal-author' }
];
const reviews = [
  { tenant_id: fixtureTenant, id: 'rev-9', version: 1, created_at: '2026-10-08T01:30:00Z', updated_at: '2026-10-08T02:22:00Z', repository_id: 'core-runtime', pull_request_id: 'pr-44', reviewer_id: 'principal-reviewer', head_sha: '0123456789abcdef0123456789abcdef01234567', state: 'pending', body: 'Review pending on the current head.' }
];
const checks = [
  { tenant_id: fixtureTenant, id: 'chk-4', repository_id: 'core-runtime', name: 'contract-source', status: 'completed', conclusion: 'success', commit_sha: '0123456789abcdef0123456789abcdef01234567', head_sha: '0123456789abcdef0123456789abcdef01234567' }
];
const events = [];
const subscribers = new Set();
const requestCounts = new Map();

const fixtureVersions = new Map();
const fixtureHeads = new Map();
function fixtureVersion(tenant, repository, records, parent = null, operation = 'fixture-initialize') {
  const state_commit = createHash('sha1').update(JSON.stringify(records)).digest('hex');
  const descriptor = { schema_version: 1, tenant_id: tenant, repository_id: repository, code_commit: '0123456789abcdef0123456789abcdef01234567', state_commit, parents: parent ? [parent] : [], creator_id: 'fixture-owner', creator_kind: 'human', operation_id: operation, request_digest: createHash('sha256').update(operation).digest('hex') };
  const version_commit = createHash('sha1').update(JSON.stringify(descriptor)).digest('hex');
  const version = { version_commit, descriptor };
  fixtureVersions.set(version_commit, { version, records });
  return version;
}
function fixtureHead(tenant, repository) {
  const scope = tenant + '/' + repository;
  if (!fixtureHeads.has(scope)) {
    const records = {};
    if (repository === 'core-runtime') for (const [directory, rows] of [['issues', issues], ['reviews', reviews], ['checks', checks]]) {
      for (const row of rows) records[directory + '/' + row.id + '.json'] = Buffer.from(JSON.stringify(row)).toString('base64');
    }
    fixtureHeads.set(scope, fixtureVersion(tenant, repository, records).version_commit);
  }
  return fixtureVersions.get(fixtureHeads.get(scope)).version;
}
function routeForge(url, method, bodyText, tenant, repository, action) {
  if (!repos.some(repo => repo.id === repository)) return json({ error: 'not_found' }, 404);
  const head = fixtureHead(tenant, repository);
  if (method === 'GET' && action === 'head') return json({ version: head });
  if (method === 'GET' && action === 'forks') return json({ versions: [...fixtureVersions.values()].map(item => item.version).filter(version => version.descriptor.tenant_id === tenant && version.descriptor.repository_id === repository) });
  if (method === 'GET' && action === 'files') {
    const saved = fixtureVersions.get(url.searchParams.get('version'));
    if (!saved || saved.version.descriptor.tenant_id !== tenant || saved.version.descriptor.repository_id !== repository) return json({ error: 'not_found' }, 404);
    const path = url.searchParams.get('path');
    if (path) return saved.records[path] === undefined ? json({ error: 'not_found' }, 404) : json({ version: saved.version, tree: 'state', path, encoding: 'base64', content: saved.records[path] });
    const prefix = url.searchParams.get('prefix') || '';
    return json({ entries: Object.keys(saved.records).filter(path => path.startsWith(prefix)).map(path => ({ path, mode: '100644', kind: 'blob' })) });
  }
  const body = parseBody(bodyText);
  if (method === 'POST' && action === 'commit') {
    const parent = fixtureVersions.get(body.parent_version);
    if (!parent || parent.version.descriptor.tenant_id !== tenant || parent.version.descriptor.repository_id !== repository) return json({ error: 'not_found' }, 404);
    const records = { ...parent.records };
    for (const change of body.changes || []) {
      if (change.tree !== 'state') return json({ error: 'fixture_state_only' }, 400);
      if (change.content_base64 === null) delete records[change.path]; else records[change.path] = change.content_base64;
    }
    const version = fixtureVersion(tenant, repository, records, body.parent_version, body.operation_id);
    events.push({ kind: 'forge.commit', request: body, version });
    return json({ version });
  }
  if (method === 'POST' && action === 'publish') {
    if (body.expected_head !== head.version_commit) return json({ error: 'gfy_stale_precondition' }, 409);
    const candidate = fixtureVersions.get(body.new_version);
    if (!candidate || !candidate.version.descriptor.parents.includes(head.version_commit)) return json({ error: 'gfy_stale_precondition' }, 409);
    fixtureHeads.set(tenant + '/' + repository, body.new_version);
    const event = resourceEvent(tenant, 'forge.publish', { repository_id: repository, id: body.new_version, version: body.new_version });
    event.resource_uris = ['gfy://tenant/' + tenant + '/repositories/' + repository + '/forge'];
    events.push({ kind: 'forge.publish', request: body, event });
    broadcast(event);
    return json({ version: candidate.version });
  }
  return json({ error: 'fixture_operation_unavailable' }, 501);
}

function resourceEvent(tenant, operation, record) {
  const cursor = 'gfy_' + String(events.length + 1);
  return {
    schema_version: 1,
    source_event_id: 'harness-' + cursor,
    cursor,
    tenant_id: tenant,
    repository_id: record.repository_id,
    kind: 'metadata_updated',
    operation_id: operation,
    resource_uris: ['gfy://tenant/' + tenant + '/reviews', 'gfy://tenant/' + tenant + '/reviews/' + record.id, 'gfy://tenant/' + tenant + '/repositories/' + record.repository_id + '/reviews'],
    authoritative_revision: String(record.version || 1),
    occurred_at: new Date().toISOString()
  };
}

function broadcast(event) {
  const message = 'id: ' + event.cursor + '\nevent: change\ndata: ' + JSON.stringify(event) + '\n\n';
  for (const response of subscribers) response.write(message);
}


const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mime = new Map([['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml']]);

function json(response, status = 200) {
  return { status, body: JSON.stringify(response), headers: { 'content-type': 'application/json; charset=utf-8' } };
}

function page(items) {
  return { items, next_cursor: null, has_more: false };
}

function parseBody(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

async function routeApi(url, method, bodyText, headers = {}) {
  const path = url.pathname;
  requestCounts.set(method + ' ' + path, (requestCounts.get(method + ' ' + path) || 0) + 1);
  const match = path.match(/^\/api\/v[12]\/tenants\/([^/]+)/);
  const tenant = match ? decodeURIComponent(match[1]) : '';
  if (tenant === slowTenant) await wait(1200);
  const empty = tenant === emptyTenant;
  const fixture = tenant === fixtureTenant || tenant === slowTenant;
  if (!fixture && !empty) return json({ ok: false, error: 'gfy_permission_denied', status: 403, detail: 'fixture tenant not linked' }, 403);
  const forge = path.match(/^\/api\/v2\/tenants\/[^/]+\/repositories\/([^/]+)\/forge\/(head|forks|files|commit|publish)$/);
  if (forge) return routeForge(url, method, bodyText, tenant, decodeURIComponent(forge[1]), forge[2]);
  if (path === '/api/v1/tenants/' + tenant + '/repositories' && method === 'GET') return json(empty ? [] : repos.map((repo) => ({ ...repo, tenant_id: tenant })));
  if (path === '/api/v1/tenants/' + tenant + '/repositories' && method === 'POST') return json({ ok: false, error: 'gfy_git_provisioner_unavailable', status: 503, detail: 'repository Git provisioner is not configured' }, 503);
  const source = path.match(/^\/api\/v1\/tenants\/[^/]+\/repositories\/([^/]+)\/(tree|source-file|diff)$/);
  if (source && method === 'GET') {
    const id = decodeURIComponent(source[1]);
    if (empty || !repos.some(repo => repo.id === id)) return json({ ok: false, error: 'gfy_not_found' }, 404);
    const baseSha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const headSha = '0123456789abcdef0123456789abcdef01234567';
    const refs = { main: baseSha, 'p1-api': headSha, [baseSha]: baseSha, [headSha]: headSha };
    const ref = refs[url.searchParams.get('ref') || ''];
    const contentsFor = (path, sha) => path === 'README.md' ? '# Browser source fixture\n\nRead-only source test.\n' : "console.log('" + (sha === headSha ? 'after' : 'before') + "');\n";
    if (source[2] === 'tree') {
      if (!ref) return json({ ok: false, error: 'gfy_not_found', detail: 'reference unavailable' }, 404);
      return json({ items: ['README.md', 'hello.mjs'].map((path, index) => ({ path, path_base64: null, mode: '100644', kind: 'blob', sha: String(index + 1).repeat(40), size_bytes: Buffer.byteLength(contentsFor(path, ref)) })), next_cursor: null, has_more: false, repository_id: id, resolved_sha: ref, tree_sha: '4'.repeat(40), truncated: false, truncation_reason: null });
    }
    if (source[2] === 'source-file') {
      const file = url.searchParams.get('path');
      if (!ref || !['README.md', 'hello.mjs'].includes(file)) return json({ ok: false, error: 'gfy_not_found' }, 404);
      const contents = contentsFor(file, ref);
      return json({ repository_id: id, resolved_sha: ref, path: file, sha: (file === 'README.md' ? '1' : '2').repeat(40), size_bytes: Buffer.byteLength(contents), encoding: 'utf-8', contents, truncated: false });
    }
    const base = refs[url.searchParams.get('base') || ''];
    const head = refs[url.searchParams.get('head') || ''];
    if (!base || !head) return json({ ok: false, error: 'gfy_not_found' }, 404);
    const items = base === head ? [] : [{ old_path: 'hello.mjs', new_path: 'hello.mjs', old_sha: '2'.repeat(40), new_sha: '3'.repeat(40), change: 'modified', old_mode: '100644', new_mode: '100644', binary: false, additions: 1, deletions: 1, similarity_percent: null, truncated: false, hunks: [{ old_start: 1, old_count: 1, new_start: 1, new_count: 1, header: '', lines: [{ kind: 'deletion', old_line: 1, new_line: null, text: "console.log('before');", has_newline: true }, { kind: 'addition', old_line: null, new_line: 1, text: "console.log('after');", has_newline: true }] }] }];
    return json({ items, next_cursor: null, has_more: false, repository_id: id, base_sha: base, head_sha: head, merge_base_shas: [], algorithm_version: 'fixture-v1', diff_digest: '5'.repeat(64), truncated: false, truncation_reason: null });
  }
  if (path.startsWith('/api/v1/tenants/' + tenant + '/repositories/') && method === 'GET') {
    const id = decodeURIComponent(path.split('/').pop() || '');
    const repo = repos.find((item) => item.id === id);
    return repo && !empty ? json({ ...repo, tenant_id: tenant }) : json({ ok: false, error: 'gfy_not_found', status: 404 }, 404);
  }
  if (path === '/api/v1/tenants/' + tenant + '/issues' && method === 'GET') return json(empty ? [] : issues);
  if (path.startsWith('/api/v1/tenants/' + tenant + '/issues/') && method === 'GET') return json(empty ? { ok: false, error: 'gfy_not_found', status: 404 } : issues[0], empty ? 404 : 200);
  if (path === '/api/v1/tenants/' + tenant + '/pull-requests' && method === 'GET') return json(empty ? page([]) : page(pulls.map((pr) => ({ ...pr, tenant_id: tenant }))));
  const prAction = path.match(new RegExp('^/api/v1/tenants/' + tenant + '/pull-requests/([^/]+)/(close|reopen|draft|ready)$'));
  if (prAction && method === 'POST') {
    const pr = pulls.find((item) => item.id === decodeURIComponent(prAction[1]));
    if (!pr || empty) return json({ ok: false, error: 'gfy_not_found', status: 404 }, 404);
    const request = parseBody(bodyText);
    if (request.expected_version !== pr.version || headers['if-match'] !== String(pr.version)) return json({ ok: false, error: 'gfy_stale_precondition', status: 409 }, 409);
    const action = prAction[2];
    if (action === 'close') pr.state = 'closed';
    if (action === 'reopen') pr.state = 'open';
    if (action === 'draft') pr.draft = true;
    if (action === 'ready') pr.draft = false;
    pr.version += 1;
    pr.updated_at = new Date().toISOString();
    return json({ ...pr, tenant_id: tenant });
  }
  if (path.startsWith('/api/v1/tenants/' + tenant + '/pull-requests/') && method === 'GET') {
    const id = decodeURIComponent(path.split('/').pop() || '');
    const pr = pulls.find((item) => item.id === id);
    return pr && !empty ? json({ ...pr, tenant_id: tenant }) : json({ ok: false, error: 'gfy_not_found', status: 404 }, 404);
  }
  if (path === '/api/v1/tenants/' + tenant + '/reviews' && method === 'GET') return json(empty ? page([]) : page(reviews.map((review) => ({ ...review, tenant_id: tenant }))));
  if (path === '/api/v1/tenants/' + tenant + '/reviews' && method === 'POST') {
    const request = parseBody(bodyText);
    const review = { tenant_id: tenant, id: 'rev-created-' + String(events.length + 1), version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), repository_id: request.repository_id, pull_request_id: request.pull_request_id, reviewer_id: 'fixture-reviewer', head_sha: pulls[0].head_sha, state: 'pending', body: request.body || '' };
    reviews.push(review);
    const event = resourceEvent(tenant, 'review.create', review);
    events.push({ kind: 'review.create', request, review, event });
    broadcast(event);
    return json(review);
  }
  const reviewAction = path.match(new RegExp('^/api/v1/tenants/' + tenant + '/reviews/([^/]+)/(submit|dismiss)$'));
  if (reviewAction && method === 'POST') {
    const review = reviews.find((item) => item.id === decodeURIComponent(reviewAction[1]));
    if (!review || empty) return json({ ok: false, error: 'gfy_not_found', status: 404 }, 404);
    const request = parseBody(bodyText);
    if (request.expected_version !== review.version || headers['if-match'] !== String(review.version)) return json({ ok: false, error: 'gfy_stale_precondition', status: 409 }, 409);
    if (reviewAction[2] === 'submit') { review.state = request.decision || 'commented'; review.body = request.body || review.body; }
    if (reviewAction[2] === 'dismiss') { review.state = 'dismissed'; review.body = request.reason || review.body; }
    review.version += 1;
    review.updated_at = new Date().toISOString();
    return json({ ...review, tenant_id: tenant });
  }
  if (path.startsWith('/api/v1/tenants/' + tenant + '/reviews/') && method === 'GET') {
    const id = decodeURIComponent(path.split('/').pop() || '');
    const review = reviews.find((item) => item.id === id);
    return review && !empty ? json({ ...review, tenant_id: tenant }) : json({ ok: false, error: 'gfy_not_found', status: 404 }, 404);
  }
  if (path === '/api/v1/tenants/' + tenant + '/checks' && method === 'GET') return json(empty ? [] : checks);
  if (path.startsWith('/api/v1/tenants/' + tenant + '/checks/') && method === 'GET') return json(empty ? { ok: false, error: 'gfy_not_found', status: 404 } : checks[0], empty ? 404 : 200);
  if (path.includes('/comments') || method === 'POST') return json({ ok: false, error: 'gfy_unsupported_operation', status: 501, detail: 'fixture keeps mutations non-persistent' }, 501);
  return json({ ok: false, error: 'gfy_route_not_found', status: 404 }, 404);
}

async function routeStatic(url) {
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const resolved = normalize(join(root, requestPath));
  if (!resolved.startsWith(root)) return { status: 403, body: 'forbidden', headers: { 'content-type': 'text/plain; charset=utf-8' } };
  try {
    const body = await readFile(resolved);
    return { status: 200, body, headers: { 'content-type': mime.get(extname(resolved)) || 'application/octet-stream' } };
  } catch {
    return { status: 404, body: 'not found', headers: { 'content-type': 'text/plain; charset=utf-8' } };
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1:' + port);
  if (/^\/api\/v1\/tenants\/[^/]+\/events$/u.test(url.pathname)) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.write(': live\n\n');
    subscribers.add(response);
    request.on('close', () => subscribers.delete(response));
    return;
  }
  const body = await new Promise((resolve) => {
    let value = '';
    request.on('data', (chunk) => { value += chunk; });
    request.on('end', () => resolve(value));
  });
  const result = url.pathname === '/__harness/events' ? json(events) : url.pathname === '/__harness/counts' ? json(Object.fromEntries(requestCounts)) : (url.pathname.startsWith('/api/') ? await routeApi(url, request.method || 'GET', body, request.headers) : await routeStatic(url));
  response.writeHead(result.status, result.headers);
  response.end(result.body);
});

server.listen(port, '127.0.0.1', () => {
  console.log('gitfoundry web harness listening on http://127.0.0.1:' + port);
});
