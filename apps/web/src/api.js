import { invokeDocumentCommand, isDocumentCommand } from './document-api.js';
import { commandCatalog, commandPath, commandRequest } from '../../../packages/contracts/src/commands.js';

export const OPERATIONS = {
  repositories: { label: 'Repositories', plural: 'repositories', list: 'repo.list', detail: 'repo.view' },
  issues: { label: 'Issues', plural: 'issues', list: 'issue.list', detail: 'issue.view', create: 'issue.create', comment: 'comment.create' },
  forks: { label: 'Forge', plural: 'forge versions', list: 'forge.list', detail: 'forge.view', review: 'review.create' },
  reviews: { label: 'Reviews', plural: 'reviews', list: 'review.list', detail: 'review.view' },
  checks: { label: 'Checks', plural: 'checks', list: 'check.list', detail: 'check.view' }
};

const enc = encodeURIComponent;
const legacyRoutes = {
  'repo.list': { method: 'GET', path: tenant => '/api/v1/tenants/' + enc(tenant) + '/repositories' },
  'repo.view': { method: 'GET', path: (tenant, id) => '/api/v1/tenants/' + enc(tenant) + '/repositories/' + enc(id) },
  'repo.create': { method: 'POST', path: tenant => '/api/v1/tenants/' + enc(tenant) + '/repositories' },
  'issue.list': { method: 'GET', path: tenant => '/api/v1/tenants/' + enc(tenant) + '/issues' },
  'issue.view': { method: 'GET', path: (tenant, id) => '/api/v1/tenants/' + enc(tenant) + '/issues/' + enc(id) },
  'issue.create': { method: 'POST', path: tenant => '/api/v1/tenants/' + enc(tenant) + '/issues' },
  'comment.create': { method: 'POST', path: tenant => '/api/v1/tenants/' + enc(tenant) + '/comments' },
  'pr.list': { method: 'GET', path: tenant => '/api/v1/tenants/' + enc(tenant) + '/pull-requests' },
  'pr.view': { method: 'GET', path: (tenant, id) => '/api/v1/tenants/' + enc(tenant) + '/pull-requests/' + enc(id) },
  'review.list': { method: 'GET', path: tenant => '/api/v1/tenants/' + enc(tenant) + '/reviews' },
  'review.view': { method: 'GET', path: (tenant, id) => '/api/v1/tenants/' + enc(tenant) + '/reviews/' + enc(id) },
  'review.create': { method: 'POST', path: tenant => '/api/v1/tenants/' + enc(tenant) + '/reviews' },
  'review.submit': { method: 'POST', path: (tenant, id) => '/api/v1/tenants/' + enc(tenant) + '/reviews/' + enc(id) + '/submit' },
  'review.dismiss': { method: 'POST', path: (tenant, id) => '/api/v1/tenants/' + enc(tenant) + '/reviews/' + enc(id) + '/dismiss' },
  'check.list': { method: 'GET', path: tenant => '/api/v1/tenants/' + enc(tenant) + '/checks' },
  'check.view': { method: 'GET', path: (tenant, id) => '/api/v1/tenants/' + enc(tenant) + '/checks/' + enc(id) }
};

export const ROUTES = Object.freeze({
  ...Object.fromEntries(commandCatalog.map(command => [command.id, {
    method: command.method,
    path: (tenant, repositoryId, recordId) => commandPath(command.id, { tenant_id: tenant, repository_id: repositoryId, id: recordId, version_commit: recordId })
  }])),
  ...legacyRoutes
});

function legacyRequest(id, args) {
  const route = legacyRoutes[id];
  if (!route) throw new Error('Unknown command ' + id);
  if (!args?.tenant_id) throw new Error('tenant_id is required');
  if (id.endsWith('.view') && !args.id || ['review.submit', 'review.dismiss'].includes(id) && !args.id) throw new Error('id is required');
  if (id.endsWith('.list') && args.input === undefined) throw new Error('input is required');
  if (!id.endsWith('.list') && route.method !== 'GET' && !args.idempotency_key) throw new Error('idempotency_key is required');
  const url = route.path(args.tenant_id, args.id);
  const input = args.input || {};
  const headers = {};
  if (args.idempotency_key) headers['Idempotency-Key'] = args.idempotency_key;
  const expected = input.expected_version ?? args.expected_version;
  if (expected !== undefined) headers['If-Match'] = String(expected);
  const body = route.method === 'GET' ? undefined : input;
  const query = route.method === 'GET' && input && Object.keys(input).length ? '?' + new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined && value !== null)) : '';
  return { operationId: id, method: route.method, url: url + query, body, headers };
}

export function invokeCommand(id, args, signal) {
  if (isDocumentCommand(id)) return invokeDocumentCommand(id, args, signal, requestJson);
  let request;
  try { request = commandRequest(id, args); }
  catch (error) {
    if (!legacyRoutes[id]) return Promise.resolve({ ok: false, error: { status: 503, data: { error: 'Forge API unavailable', detail: error.message } } });
    request = legacyRequest(id, args);
  }
  return requestJson(id, request.method, request.url, request.body, request.headers, signal);
}

export function normalizeList(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['items', 'repositories', 'issues', 'forks', 'pull_requests', 'versions', 'reviews', 'checks']) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}
export function subscribeWorkspaceEvents(tenant, { cursor, onOpen, onEvent, onReset, onError } = {}) {
  if (!tenant || typeof EventSource === 'undefined') return () => {};
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  const url = '/api/v1/tenants/' + enc(tenant) + '/events' + (query.size ? '?' + query.toString() : '');
  let source = null;
  let disposed = false;
  const connect = () => {
    if (disposed || source) return;
    source = new EventSource(url, { withCredentials: true });
    source.onopen = () => onOpen?.();
    source.addEventListener('change', event => {
      try { onEvent?.(JSON.parse(event.data)); }
      catch (error) { onError?.(error); }
    });
    source.addEventListener('reset', event => {
      try { onReset?.(event.data ? JSON.parse(event.data) : {}); }
      catch { onReset?.({}); }
    });
    source.onerror = error => onError?.(error);
  };
  const suspend = () => { source?.close(); source = null; };
  const resume = event => { connect(); if (event.persisted) onReset?.({ reason: 'page_restored' }); };
  globalThis.addEventListener?.('pagehide', suspend);
  globalThis.addEventListener?.('pageshow', resume);
  connect();
  return () => {
    disposed = true;
    suspend();
    globalThis.removeEventListener?.('pagehide', suspend);
    globalThis.removeEventListener?.('pageshow', resume);
  };
}

export async function requestJson(operationId, method, url, body, extraHeaders, signal) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  const init = { method, headers, credentials: 'include', signal };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok || data?.ok === false) return { ok: false, error: { operationId, status: response.status, data } };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: { operationId, status: 0, data: { error: 'gfy_network_error', detail: String(error) } } };
  }
}
export function errorLabel(error) {
  const data = error.data || {};
  return (error.status ? 'HTTP ' + error.status + ' ' : '') + (data.error || 'unknown_error') + (data.detail || data.reason ? ': ' + (data.detail || data.reason) : '');
}
