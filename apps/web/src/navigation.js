import { parseAsBoolean, parseAsString, parseAsStringLiteral } from 'nuqs';

export const viewDefaults = { tenant: '', repo: '', section: 'repositories', record: '', q: '', create: false, mode: 'source', ref: '', file: '', base: '', head: '', layout: 'unified', returnFork: '', page: 'workspace' };
export const resetDetail = { record: null, q: null, create: null, mode: null, ref: null, file: null, base: null, head: null, layout: null, returnFork: null };
export function viewParsers(defaultTenant) {
  return {
    tenant: parseAsString.withDefault(defaultTenant),
    repo: parseAsString.withDefault(''),
    section: parseAsStringLiteral(['repositories', 'code', 'issues', 'forks', 'reviews', 'checks']).withDefault('repositories'),
    record: parseAsString.withDefault(''),
    q: parseAsString.withDefault(''),
    create: parseAsBoolean.withDefault(false),
    mode: parseAsStringLiteral(['source', 'compare']).withDefault('source'),
    ref: parseAsString.withDefault(''),
    file: parseAsString.withDefault(''),
    base: parseAsString.withDefault(''),
    head: parseAsString.withDefault(''),
    layout: parseAsStringLiteral(['unified', 'split']).withDefault('unified'),
    returnFork: parseAsString.withDefault(''),
    page: parseAsStringLiteral(['workspace', 'privacy', 'terms', 'status']).withDefault('workspace')
  };
}
export function viewHref(view, patch = {}) {
  const values = { ...view, ...patch };
  const params = new URLSearchParams();
  for (const [key, fallback] of Object.entries(viewDefaults)) {
    const value = values[key];
    if (value !== null && value !== undefined && value !== fallback) params.set(key, String(value));
  }
  return '/' + (params.size ? '?' + params.toString() : '');
}
export function followView(event, action) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  action();
}
