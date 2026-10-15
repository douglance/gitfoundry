import assert from 'node:assert/strict';
import { sourceUrl, sourceText, diffPatch } from '../src/source-model.js';

const commit = '0123456789abcdef0123456789abcdef01234567';
const blob = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
assert.equal(sourceUrl('tenant / A', 'repo & B', 'source-file', { ref: commit, path: 'src/a b.js' }),
  '/api/v1/tenants/tenant%20%2F%20A/repositories/repo%20%26%20B/source-file?ref=' + commit + '&path=src%2Fa+b.js');
assert.throws(() => sourceUrl('t', 'r', 'internal', {}), /Unsupported source endpoint/);
const content = { repository_id: 'r', resolved_sha: commit, path: 'README.md', sha: blob,
  size_bytes: 24, encoding: 'utf-8', contents: '<script>bad()</script>\n', truncated: false };
assert.equal(sourceText(content, 'r', commit, 'README.md'), '<script>bad()</script>\n');
for (const patch of [{ resolved_sha: blob }, { repository_id: 'other' }, { path: 'different.md' }]) {
  assert.throws(() => sourceText({ ...content, ...patch }, 'r', commit, 'README.md'), /snapshot/);
}
assert.equal(sourceText({ ...content, encoding: 'binary', contents: null }, 'r', commit, 'README.md'), null);
assert.equal(sourceText({ ...content, truncated: true }, 'r', commit, 'README.md'), null);
assert.equal(sourceText({ ...content, encoding: 'unsupported', contents: null }, 'r', commit, 'README.md'), null);
const file = { old_path: 'hello.mjs', new_path: 'hello.mjs', old_sha: blob, new_sha: commit,
  old_mode: '100644', new_mode: '100644', binary: false, truncated: false,
  hunks: [{ old_start: 1, old_count: 1, new_start: 1, new_count: 1, header: '',
    lines: [{ kind: 'deletion', text: 'old', has_newline: true }, { kind: 'addition', text: 'new', has_newline: false }] }] };
assert.equal(diffPatch(file), 'diff --git "a/hello.mjs" "b/hello.mjs"\n--- "a/hello.mjs"\n+++ "b/hello.mjs"\n@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file\n');
assert.equal(diffPatch({ ...file, binary: true }), null);
assert.equal(diffPatch({ ...file, truncated: true }), null);
assert.throws(() => diffPatch({ ...file, hunks: [{ ...file.hunks[0], lines: [{ kind: 'invented', text: 'bad', has_newline: true }] }] }), /Invalid diff line/);
console.log(JSON.stringify({ ok: true }));
