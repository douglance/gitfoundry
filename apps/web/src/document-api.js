const kinds = { issue: 'issues', review: 'reviews', check: 'checks', comment: 'comments' };
const enc = encodeURIComponent;
const safeId = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function isDocumentCommand(id) { return /^(issue|review|check|comment)\./.test(id) || id === 'forge.list'; }

// Reads started while the same read is still in flight share its answer, so sections that load
// together ask each repository for its head once.
const inFlight = new WeakMap();
function shared(request, key, read) {
  if (!inFlight.has(request)) inFlight.set(request, new Map());
  const reads = inFlight.get(request);
  if (!reads.has(key)) reads.set(key, read().finally(() => reads.delete(key)));
  return reads.get(key);
}

export async function invokeDocumentCommand(id, args, signal, request) {
  const fail = (status, error, detail) => ({ ok: false, error: { operationId: id, status, data: { error, detail } } });
  const tenant = args?.tenant_id;
  if (!tenant) return fail(400, 'tenant_required', 'Choose a workspace.');
  const [kind, action] = id.split('.');
  const directory = kinds[kind];
  if (!directory && id !== 'forge.list') return fail(400, 'record_kind_invalid', kind);
  const input = args.input || {};
  const scope = args.repository_id || input.repository_id;
  const key = String(args.id || '');
  const separator = key.lastIndexOf('~');
  const recordId = separator < 0 ? key : key.slice(separator + 1);
  const keyRepository = separator < 0 ? null : key.slice(0, separator);
  const call = (method, url, body) => request(id, method, url, body, body?.operation_id ? { 'Idempotency-Key': body.operation_id } : {}, signal);
  const base = repository => '/api/v2/tenants/' + enc(tenant) + '/repositories/' + enc(repository) + '/forge';
  const freshHead = async repository => {
    const result = await call('GET', base(repository) + '/head');
    return result.ok ? { ok: true, data: result.data?.version ?? null } : result;
  };
  const head = repository => shared(request, tenant + '/' + repository + '/head', () => freshHead(repository));
  const file = (repository, version, path) => call('GET', base(repository) + '/files?' + new URLSearchParams({ version, tree: 'state', path }));
  const decode = data => {
    if (data?.encoding !== 'base64' || typeof data.content !== 'string') throw new Error('Expected an exact Git file response.');
    const bytes = Uint8Array.from(atob(data.content), char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  const projection = (document, repository, version, path, content) => ({
    ...document,
    id: document.id || path.slice(path.lastIndexOf('/') + 1, -5),
    _view_id: repository + '~' + (document.id || path.slice(path.lastIndexOf('/') + 1, -5)),
    repository_id: repository,
    ...(kind === 'check' ? { name: document.name || document.id, status: document.status || 'completed', conclusion: document.conclusion || (document.outcome === 'passed' ? 'success' : document.outcome === 'failed' ? 'failure' : undefined), head_sha: document.candidate_code_commit, producer_id: document.actor_id } : {}),
    ...(kind === 'review' ? { state: document.decision === 'approve' ? 'approved' : document.decision === 'reject' ? 'changes_requested' : document.state, head_sha: document.candidate_code_commit } : {}),
    _forge: { path, version_commit: version.version_commit, state_commit: version.descriptor.state_commit, code_commit: version.descriptor.code_commit, content_base64: content, document, stale: Boolean(document.candidate_code_commit && document.candidate_code_commit !== version.descriptor.code_commit) }
  });
  async function repositories() {
    if (scope && scope !== 'all') return { ok: true, data: [scope] };
    if (keyRepository) return { ok: true, data: [keyRepository] };
    const result = await shared(request, tenant + '/repositories', () => call('GET', '/api/v1/tenants/' + enc(tenant) + '/repositories'));
    if (!result.ok) return result;
    const rows = Array.isArray(result.data) ? result.data : result.data?.items || result.data?.repositories || [];
    return { ok: true, data: rows.map(row => row.id || row.repository_id) };
  }
  try {
    if (id === 'forge.list') {
      const repos = await repositories();
      if (!repos.ok) return repos;
      const groups = await Promise.all(repos.data.map(async repository => {
        const result = await call('GET', base(repository) + '/forks');
        if (!result.ok) return result;
        return { ok: true, data: (result.data?.versions || []).map(version => ({ ...version.descriptor, version_commit: version.version_commit, id: version.version_commit, _view_id: repository + '~' + version.version_commit, repository_id: repository, title: version.descriptor?.fork_id || version.version_commit })) };
      }));
      const failed = groups.find(result => !result.ok);
      return failed || { ok: true, data: { items: groups.flatMap(result => result.data), has_more: false } };
    }
    if (action === 'list' || action === 'view') {
      if (action === 'view' && !safeId.test(recordId)) return fail(400, 'record_id_invalid', recordId);
      const repos = await repositories();
      if (!repos.ok) return repos;
      const groups = await Promise.all(repos.data.map(async repository => {
        const current = await head(repository);
        if (!current.ok) return current;
        if (!current.data) return { ok: true, data: [] };
        const version = current.data;
        if (action === 'view') {
          const path = directory + '/' + recordId + '.json';
          const result = await file(repository, version.version_commit, path);
          if (!result.ok) return result.error.status === 404 ? { ok: true, data: [] } : result;
          return { ok: true, data: [projection(decode(result.data), repository, version, path, result.data.content)] };
        }
        const listing = await call('GET', base(repository) + '/files?' + new URLSearchParams({ version: version.version_commit, tree: 'state', prefix: directory + '/' }));
        if (!listing.ok) return listing;
        const files = await Promise.all((listing.data?.entries || []).filter(entry => entry.path.endsWith('.json')).map(async entry => {
          const result = await file(repository, version.version_commit, entry.path);
          return result.ok ? { ok: true, data: projection(decode(result.data), repository, version, entry.path, result.data.content) } : result;
        }));
        const failed = files.find(result => !result.ok);
        return failed || { ok: true, data: files.map(result => result.data) };
      }));
      const failed = groups.find(result => !result.ok);
      if (failed) return failed;
      const records = groups.flatMap(result => result.data);
      return action === 'list' ? { ok: true, data: { items: records, has_more: false } } : records.length ? { ok: true, data: records[0] } : fail(404, 'record_not_found', recordId);
    }
    if (kind === 'review') return fail(409, 'review_exact_candidate', 'Review the exact candidate in Forks. Signed decisions remain in Git history.');
    if (action !== 'create' || !['issue', 'comment'].includes(kind)) return fail(400, 'record_operation_unavailable', id);
    if (!scope || scope === 'all') return fail(400, 'repository_required', 'Choose a repository.');
    if (!args.idempotency_key) return fail(400, 'idempotency_key_required', 'A stable request identifier is required.');
    if (kind === 'issue' && !String(input.title || '').trim()) return fail(400, 'issue_title_required', 'Enter an issue title.');
    if (kind === 'comment' && (!String(input.body || '').trim() || !input.subject_id)) return fail(400, 'comment_required', 'Enter a comment and its subject.');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(kind + ':' + args.idempotency_key))), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
    const documentId = kind + '-' + digest;
    const path = directory + '/' + documentId + '.json';
    const document = { ...input, id: documentId, kind, repository_id: scope, operation_id: args.idempotency_key, version: 1, ...(kind === 'issue' ? { state: 'open' } : {}) };
    if (document.subject_id?.includes('~')) document.subject_id = document.subject_id.slice(document.subject_id.lastIndexOf('~') + 1);
    delete document.expected_version;
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    const content = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    let current = await freshHead(scope);
    if (!current.ok) return current;
    if (!current.data) return fail(409, 'forge_not_initialized', 'Start a forge in this repository before adding records.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = current.data;
      const existing = await file(scope, version.version_commit, path);
      if (existing.ok) return existing.data.content === content ? { ok: true, data: projection(decode(existing.data), scope, version, path, content) } : fail(409, 'gfy_idempotency_conflict', path);
      if (existing.error.status !== 404) return existing;
      const operation = 'doc-' + digest + '-' + attempt;
      const committed = await call('POST', base(scope) + '/commit', { operation_id: operation + '-commit', parent_version: version.version_commit, changes: [{ tree: 'state', path, content_base64: content }] });
      if (!committed.ok) return committed;
      const candidate = committed.data.version;
      const published = await call('POST', base(scope) + '/publish', { operation_id: operation + '-publish', expected_head: version.version_commit, new_version: candidate.version_commit });
      if (published.ok) return { ok: true, data: projection(document, scope, candidate, path, content) };
      if (published.error.status !== 409) return published;
      current = await freshHead(scope);
      if (!current.ok) return current;
      const competing = await file(scope, current.data.version_commit, path);
      if (competing.ok) return competing.data.content === content ? { ok: true, data: projection(document, scope, current.data, path, content) } : fail(409, 'gfy_stale_precondition', 'The affected record changed.');
      if (competing.error.status !== 404) return competing;
    }
    return fail(409, 'gfy_stale_precondition', 'The workspace changed repeatedly. Retry the same request.');
  } catch (error) {
    return fail(502, 'forge_record_unavailable', String(error.message || error));
  }
}
