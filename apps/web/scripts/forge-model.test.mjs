import assert from 'node:assert/strict';
import { buildReviewDocument, layoutLineage, documentKind, findVersion, forgeUrl, normalizeStateEntries, normalizeVersion, normalizeVersions, reviewDocumentPath, shortRevision, underlyingRecordPath } from '../src/forge-model.js';

const version = normalizeVersion({
  fork_id: 'fork-a',
  parents: ['base-version'],
  code_commit: '0123456789abcdef0123456789abcdef01234567',
  state_commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  version_commit: 'fedcbafedcbafedcbafedcbafedcbafedcbafedc',
  creator_id: 'agent-a',
  documents: [{ kind: 'review', id: 'rev-1' }]
});

assert.equal(forgeUrl('tenant / A', 'repo?#', '/compare', { base_version: 'b', head_version: 'h' }), '/api/v2/tenants/tenant%20%2F%20A/repositories/repo%3F%23/forge/compare?base_version=b&head_version=h');
assert.equal(shortRevision(version.code_commit), '0123456789ab');
assert.equal(version.parents[0], 'base-version');
assert.equal(version.documents.length, 1);
assert.equal(underlyingRecordPath(version), 'forge/versions/fork-a.json');
assert.equal(findVersion(normalizeVersions({ versions: [version] }), 'fedcbafedcbafedcbafedcbafedcbafedcbafedc').fork_id, 'fork-a');
assert.equal(normalizeVersions({ versions: [{ id: 'legacy', head_sha: version.code_commit }] })[0].code_commit, version.code_commit);
assert.equal(reviewDocumentPath('review-1'), 'reviews/review-1.json');
assert.deepEqual(buildReviewDocument(version, { id: 'review-1', decision: 'approve', evaluator_digest: 'sha256:evaluator' }), {
  schema_version: 1,
  kind: 'review',
  id: 'review-1',
  candidate_code_commit: version.code_commit,
  evaluator_digest: 'sha256:evaluator',
  decision: 'approve'
});
assert.equal(documentKind('checks/behavior.json'), 'check');
assert.deepEqual(normalizeStateEntries({ entries: ['checks/behavior.json', 'reviews/baseline-review.json', 'config/publication.json', 'notes.txt', 'notes/linus.md'] }).map(entry => entry.path), ['checks/behavior.json', 'reviews/baseline-review.json', 'notes/linus.md']);
assert.equal(documentKind('notes/linus.md'), 'note');


const lineage = layoutLineage([
  { version_commit:'root', parents:[] }, { version_commit:'a', parents:['root'] },
  { version_commit:'b', parents:['root'] }, { version_commit:'merge', parents:['a','b'] },
  { version_commit:'a', parents:['root'] }, { version_commit:'boundary', parents:['not-loaded'] }
]);
assert.equal(lineage.nodes.length, 5);
assert.deepEqual(lineage.edges.map(e=>[e.parent,e.child]), [['root','a'],['root','b'],['a','merge'],['b','merge']]);
const positions = Object.fromEntries(lineage.nodes.map(n=>[n.version.version_commit,[n.x,n.y]]));
assert.equal(positions.root[0],24); assert.equal(positions.a[0],256); assert.equal(positions.b[0],256); assert.equal(positions.merge[0],488);
assert.notEqual(positions.a[1],positions.b[1]); assert.equal(positions.boundary[0],24);
assert.ok(lineage.width>=positions.merge[0]+196); assert.ok(layoutLineage([]).height>=420);
assert.doesNotThrow(()=>layoutLineage([{version_commit:'cycle-a',parents:['cycle-b']},{version_commit:'cycle-b',parents:['cycle-a']}]));

console.log(JSON.stringify({ ok: true, suite: 'forge model helpers' }));
