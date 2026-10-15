import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeDocumentCommand } from '../src/document-api.js';

const code = 'a'.repeat(40);
const version = number => ({ version_commit: String(number).repeat(40), descriptor: { code_commit: code, state_commit: String(number + 3).repeat(40) } });
const encoded = value => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));

function fixture({ contention = false } = {}) {
  let current = version(1), next = 2, contested = false;
  const trees = new Map([[current.version_commit, new Map()]]);
  const calls = [];
  const request = async (operation, method, url, body) => {
    calls.push({ method, url, body });
    const parsed = new URL(url, 'https://forge.test');
    if (parsed.pathname.endsWith('/repositories')) return { ok: true, data: { items: [{ id: 'repo-a' }] } };
    if (parsed.pathname.endsWith('/head')) return { ok: true, data: { version: current } };
    if (parsed.pathname.endsWith('/files')) {
      const tree = trees.get(parsed.searchParams.get('version'));
      const path = parsed.searchParams.get('path');
      if (path) return tree.has(path) ? { ok: true, data: { encoding: 'base64', content: tree.get(path) } } : { ok: false, error: { status: 404, data: { error: 'gfy_not_found' } } };
      return { ok: true, data: { entries: [...tree.keys()].filter(path => path.startsWith(parsed.searchParams.get('prefix'))).map(path => ({ path })) } };
    }
    if (parsed.pathname.endsWith('/commit')) {
      const candidate = version(next++);
      const tree = new Map(trees.get(body.parent_version));
      for (const change of body.changes) tree.set(change.path, change.content_base64);
      trees.set(candidate.version_commit, tree);
      return { ok: true, data: { version: candidate } };
    }
    if (parsed.pathname.endsWith('/publish')) {
      if (contention && !contested) {
        contested = true;
        const replacement = version(next++);
        const tree = new Map(trees.get(current.version_commit));
        tree.set('issues/unrelated.json', encoded({ id: 'unrelated', title: 'Another writer' }));
        trees.set(replacement.version_commit, tree);
        current = replacement;
      }
      if (body.expected_head !== current.version_commit) return { ok: false, error: { status: 409, data: { error: 'gfy_stale_precondition' } } };
      current = { ...version(Number(body.new_version[0])), version_commit: body.new_version };
      return { ok: true, data: { version: current } };
    }
    throw new Error('Unexpected endpoint: ' + url);
  };
  return { request, calls, seed(path, document) { trees.get(current.version_commit).set(path, encoded(document)); } };
}

test('record views read exact Git revisions and expose the underlying file and state commit', async () => {
  const git = fixture();
  git.seed('issues/one.json', { id: 'one', title: 'Résumé 🎯' });
  const result = await invokeDocumentCommand('issue.list', { tenant_id: 'tenant-a', input: {} }, undefined, git.request);
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].title, 'Résumé 🎯');
  assert.equal(result.data.items[0]._forge.path, 'issues/one.json');
  assert.equal(result.data.items[0]._forge.state_commit, '4'.repeat(40));
  assert.equal(result.data.items[0]._view_id, 'repo-a~one');
  assert.equal(git.calls.filter(call => call.url.includes('/files')).every(call => new URL(call.url, 'https://forge.test').searchParams.get('version') === '1'.repeat(40)), true);
  assert.equal(git.calls.some(call => /\/api\/v1\/.*\/issues/.test(call.url)), false);
});

test('issue creation uses a state-only commit and conditional publication; a duplicate does not publish twice', async () => {
  const git = fixture();
  const args = { tenant_id: 'tenant-a', idempotency_key: 'stable-request', input: { repository_id: 'repo-a', title: 'One issue', body: 'Intent survives a session' } };
  const first = await invokeDocumentCommand('issue.create', args, undefined, git.request);
  const duplicate = await invokeDocumentCommand('issue.create', args, undefined, git.request);
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(first.data.id, duplicate.data.id);
  const commits = git.calls.filter(call => call.url.endsWith('/commit'));
  assert.equal(commits.length, 1);
  assert.equal(commits[0].body.changes[0].tree, 'state');
  assert.equal(commits[0].body.changes[0].path.startsWith('issues/'), true);
  assert.equal(git.calls.filter(call => call.url.endsWith('/publish')).length, 1);
  assert.equal(first.data._forge.code_commit, code);
});

test('an unrelated state update causes a reload and bounded retry against the new head', async () => {
  const git = fixture({ contention: true });
  const result = await invokeDocumentCommand('issue.create', { tenant_id: 'tenant-a', idempotency_key: 'retry-request', input: { repository_id: 'repo-a', title: 'Retained intent' } }, undefined, git.request);
  assert.equal(result.ok, true);
  const publications = git.calls.filter(call => call.url.endsWith('/publish'));
  assert.equal(publications.length, 2);
  assert.notEqual(publications[0].body.expected_head, publications[1].body.expected_head);
  const list = await invokeDocumentCommand('issue.list', { tenant_id: 'tenant-a', input: { repository_id: 'repo-a' } }, undefined, git.request);
  assert.deepEqual(list.data.items.map(item => item.title).sort(), ['Another writer', 'Retained intent']);
});

test('reviews are read from Git and cannot be rewritten through retired submit or dismiss actions', async () => {
  const git = fixture();
  git.seed('reviews/one.json', { id: 'one', kind: 'review', decision: 'approve', candidate_code_commit: 'b'.repeat(40), reason: 'Exact candidate reviewed' });
  const read = await invokeDocumentCommand('review.view', { tenant_id: 'tenant-a', id: 'repo-a~one', input: {} }, undefined, git.request);
  assert.equal(read.ok, true);
  assert.equal(read.data._forge.stale, true);
  assert.equal(read.data.head_sha, 'b'.repeat(40));
  const dismiss = await invokeDocumentCommand('review.dismiss', { tenant_id: 'tenant-a', id: 'repo-a~one', input: {} }, undefined, git.request);
  assert.equal(dismiss.ok, false);
  assert.equal(dismiss.error.data.error, 'review_exact_candidate');
  assert.equal(git.calls.some(call => call.method === 'POST'), false);
});

test('independent repositories and files load concurrently while each read stays pinned to its own revision', async () => {
  const heads = [], files = [];
  function barrier(waiters, count, data) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Independent reads were serialized')), 500);
      waiters.push(() => { clearTimeout(timeout); resolve({ ok: true, data }); });
      if (waiters.length === count) waiters.forEach(release => release());
    });
  }
  const request = async (_, method, url) => {
    assert.equal(method, 'GET');
    const parsed = new URL(url, 'https://forge.test');
    if (parsed.pathname.endsWith('/repositories')) return { ok: true, data: [{ id: 'repo-a' }, { id: 'repo-b' }] };
    const repo = parsed.pathname.includes('/repo-a/') ? 'repo-a' : 'repo-b';
    if (parsed.pathname.endsWith('/head')) return barrier(heads, 2, { version: version(repo === 'repo-a' ? 1 : 2) });
    assert.equal(parsed.searchParams.get('version'), repo === 'repo-a' ? '1'.repeat(40) : '2'.repeat(40));
    const path = parsed.searchParams.get('path');
    if (!path) return { ok: true, data: { entries: [{ path: 'issues/one.json' }, { path: 'issues/two.json' }] } };
    return barrier(files, 4, { encoding: 'base64', content: encoded({ id: path.includes('one') ? 'one' : 'two', title: repo + ' ' + path }) });
  };
  const result = await invokeDocumentCommand('issue.list', { tenant_id: 'tenant-a', input: {} }, undefined, request);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items.map(item => item._view_id), ['repo-a~one', 'repo-a~two', 'repo-b~one', 'repo-b~two']);
  assert.deepEqual(result.data.items.map(item => item._forge.version_commit), ['1'.repeat(40), '1'.repeat(40), '2'.repeat(40), '2'.repeat(40)]);
});

test('issues, reviews, and checks loaded together read each repository head once', async () => {
  const git = fixture();
  const results = await Promise.all(['issue.list', 'review.list', 'check.list'].map(id => invokeDocumentCommand(id, { tenant_id: 'tenant-a', input: {} }, undefined, git.request)));
  assert.deepEqual(results.map(result => result.ok), [true, true, true]);
  assert.equal(git.calls.filter(call => call.url.endsWith('/head')).length, 1);
});

function forkFixture(status = {}) {
  const calls = [];
  const request = async (operation, method, url) => {
    calls.push(url);
    const parsed = new URL(url, 'https://forge.test');
    if (parsed.pathname.endsWith('/repositories')) return { ok: true, data: { items: [{ id: 'repo-a' }, { id: 'repo-b' }] } };
    const repo = parsed.pathname.split('/')[6];
    if (parsed.pathname.endsWith('/forks')) return status[repo] ? { ok: false, error: { status: status[repo], data: { error: 'fork_backend_unavailable' } } } : { ok: true, data: { versions: [{ version_commit: (repo === 'repo-a' ? 'a' : 'b').repeat(40), descriptor: { fork_id: 'fork-of-' + repo, repository_id: repo, parents: [], code_commit: 'c'.repeat(40), state_commit: 'd'.repeat(40) } }] } };
    throw new Error('Unexpected endpoint: ' + url);
  };
  return { request, calls };
}

test('the workspace forge list holds every version of every repository, named by repository and fork', async () => {
  const forge = forkFixture();
  const result = await invokeDocumentCommand('forge.list', { tenant_id: 'tenant-a', input: {} }, undefined, forge.request);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items.map(item => [item.repository_id, item.title]), [['repo-a', 'fork-of-repo-a'], ['repo-b', 'fork-of-repo-b']]);
});

test('the workspace forge list fails with the repository error when versions cannot be read', async () => {
  const forge = forkFixture({ 'repo-b': 503 });
  const result = await invokeDocumentCommand('forge.list', { tenant_id: 'tenant-a', input: {} }, undefined, forge.request);
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 503);
});
