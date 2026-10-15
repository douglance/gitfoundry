const forgeBase = (tenant, repository) => '/api/v2/tenants/' + encodeURIComponent(tenant) + '/repositories/' + encodeURIComponent(repository) + '/forge';

export function forgeUrl(tenant, repository, endpoint = '', query = {}) {
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''));
  return forgeBase(tenant, repository) + endpoint + (params.size ? '?' + params : '');
}

export function shortRevision(value) {
  return typeof value === 'string' && value.length > 12 ? value.slice(0, 12) : value || '';
}

export function normalizeVersion(raw = {}) {
  const source = raw && typeof raw === 'object' && raw.descriptor
    ? { ...raw.descriptor, version_commit: raw.version_commit ?? raw.descriptor.version_commit }
    : raw;
  const parents = Array.isArray(source.parents) ? source.parents : Array.isArray(source.parent_versions) ? source.parent_versions : [];
  return {
    schema_version: source.schema_version ?? 1,
    fork_id: String(source.fork_id || source.id || source.version_commit || ''),
    tenant_id: source.tenant_id || '',
    repository_id: source.repository_id || '',
    parents: parents.filter(Boolean).map(String),
    code_commit: source.code_commit || source.head_sha || source.commit_sha || '',
    state_commit: source.state_commit || '',
    creator_id: source.creator_id || source.author_id || '',
    creator_kind: source.creator_kind || 'authenticated action',
    operation_id: source.operation_id || '',
    request_digest: source.request_digest || '',
    version_commit: source.version_commit || source.id || '',
    record_path: source.record_path || source.path || '',
    status: source.status || source.state || '',
    documents: Array.isArray(source.documents) ? source.documents : []
  };
}

export function normalizeVersions(value) {
  const items = Array.isArray(value) ? value : Array.isArray(value?.versions) ? value.versions : [];
  return items.map(normalizeVersion).filter(version => version.version_commit || version.fork_id);
}

export function findVersion(versions, revision) {
  return versions.find(version => version.version_commit === revision || version.fork_id === revision);
}

export function underlyingRecordPath(version) {
  return version.record_path || 'forge/versions/' + version.fork_id + '.json';
}

export function decodeBase64Content(content) {
  if (!content) return '';
  const binary = atob(content);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeBase64Content(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function reviewDocumentPath(id) {
  return 'reviews/' + id + '.json';
}

export function buildReviewDocument(version, { id, decision, evaluator_digest }) {
  return {
    schema_version: 1,
    kind: 'review',
    id,
    candidate_code_commit: version.code_commit,
    evaluator_digest,
    decision
  };
}

export function documentKind(path = '') {
  const [folder] = String(path).split('/');
  return ['reviews', 'checks', 'checkpoints', 'coordination', 'issues', 'notes'].includes(folder) ? folder.replace(/s$/, '') : '';
}

export function normalizeStateEntries(value) {
  const items = Array.isArray(value) ? value : value?.entries || value?.files || value?.items || [];
  return items.map(item => typeof item === 'string' ? { path: item } : item).map(item => ({
    path: String(item.path || item.name || ''),
    type: item.type || item.kind || 'file',
    size: item.size
  })).filter(item => item.path && documentKind(item.path) && /\.(json|md)$/i.test(item.path));
}

export function layoutLineage(input) {
  const versions = [...new Map(input.filter(v => v.version_commit).map(v => [v.version_commit, v])).values()];
  const byId = new Map(versions.map(v => [v.version_commit, v])), depths = new Map(), slots = new Map();
  function depth(id, visiting = new Set()) {
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) return 0;
    const next = new Set(visiting).add(id), parents = byId.get(id)?.parents.filter(p => byId.has(p)) || [];
    const value = parents.length ? 1 + Math.max(...parents.map(p => depth(p, next))) : 0;
    depths.set(id, value); return value;
  }
  const nodes = versions.map(version => {
    const column = depth(version.version_commit), row = slots.get(column) || 0;
    slots.set(column, row + 1); return { version, x: 24 + column * 232, y: 32 + row * 136 };
  });
  const positions = new Map(nodes.map(n => [n.version.version_commit, n]));
  return { nodes, edges: nodes.flatMap(n => n.version.parents.filter(p => positions.has(p)).map(p => ({ parent: p, child: n.version.version_commit, from: positions.get(p), to: n }))),
    width: Math.max(620, ...nodes.map(n => n.x + 220)), height: Math.max(420, ...nodes.map(n => n.y + 136)) };
}
