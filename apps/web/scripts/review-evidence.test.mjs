import assert from 'node:assert/strict';
import { reviewEvidence } from '../src/review-evidence.js';

const head = '1'.repeat(40), oldHead = '2'.repeat(40);
const pr = { id: 'pr-a', tenant_id: 'tenant-a', repository_id: 'repo-a', head_sha: head, state: 'open', draft: false };
const review = patch => ({ id: 'review-a', tenant_id: 'tenant-a', repository_id: 'repo-a', pull_request_id: 'pr-a', head_sha: head, state: 'approved', ...patch });
const check = patch => ({ id: 'check-a', tenant_id: 'tenant-a', repository_id: 'repo-a', commit_sha: head, head_sha: head, status: 'completed', conclusion: 'success', ...patch });
const state = patch => ({ tenant: 'tenant-a', records: { reviews: [], checks: [] }, loading: {}, errors: {}, ...patch });
const summarize = (reviews = [], checks = [], patch = {}, pull = pr) => reviewEvidence(pull, state({ ...patch, records: { reviews, checks } }));

{
  const result = summarize([review({}), review({ id: 'old', head_sha: oldHead })], [check({}), check({ id: 'old', commit_sha: oldHead, head_sha: oldHead })]);
  assert.equal(result.approved, 1, 'an approval on another revision must not count for this revision');
  assert.equal(result.otherReviews, 1);
  assert.equal(result.checks.passed, 1, 'a successful check on another revision must not count for this revision');
  assert.equal(result.otherChecks, 1);
  assert.equal(result.revision, '111111111111');
}
{
  const reviews = [review({ tenant_id: 'tenant-b' }), review({ repository_id: 'repo-b' }), review({ pull_request_id: 'pr-b' })];
  const checks = [check({ tenant_id: 'tenant-b' }), check({ repository_id: 'repo-b' })];
  const result = summarize(reviews, checks);
  assert.equal(result.approved, 0, 'unrelated approvals must not count');
  assert.equal(result.checks.total, 0, 'unrelated checks must not count');
}
{
  const result = summarize([review({ state: 'dismissed' }), review({ id: 'draft', state: 'pending' }), review({ id: 'change', state: 'changes_requested' })], [check({})]);
  assert.equal(result.approved, 0, 'dismissed and pending reviews are not approvals');
  assert.equal(result.pendingReviews, 1);
  assert.equal(result.changesRequested, 1);
  assert.equal(result.nextAction, 'Address the requested changes, then request a new review.');
}
{
  const result = summarize([review({})], [check({ conclusion: 'failure' }), check({ id: 'running', status: 'in_progress', conclusion: 'success' }), check({ id: 'neutral', conclusion: 'neutral' }), check({ id: 'unknown', conclusion: null })]);
  assert.equal(result.checks.failed, 1);
  assert.equal(result.checks.pending, 1, 'an in-progress check cannot count as passed');
  assert.equal(result.checks.passed, 0);
  assert.equal(result.checks.other, 2, 'neutral or missing conclusions cannot count as passed');
  assert.equal(result.nextAction, 'Inspect the failed checks before requesting another review.');
}
{
  const result = summarize([review({})], [check({ head_sha: oldHead }), check({ id: 'malformed', head_sha: undefined })]);
  assert.equal(result.checks.passed, 0, 'the checked commit and declared head must both match');
}
{
  const stale = state({ records: { reviews: [review({})], checks: [check({})] }, loading: { 'check.list': true } });
  assert.equal(reviewEvidence(pr, stale).status, 'loading', 'do not show old success while refreshing');
  const denied = { ...stale, loading: {}, errors: { 'review.list': { status: 403 } } };
  assert.equal(reviewEvidence(pr, denied).status, 'unavailable', 'do not show cached approvals after a read fails');
}
{
  assert.equal(reviewEvidence({ ...pr, head_sha: undefined }, state()).status, 'unavailable');
  assert.equal(reviewEvidence(pr, state({ tenant: 'tenant-b' })).status, 'unavailable');
  assert.equal(summarize().nextAction, 'Review the current changes and request checks for this revision.');
  assert.equal(summarize([], [], {}, { ...pr, draft: true }).nextAction, 'Finish the draft before requesting review.');
  assert.equal(summarize([], [], {}, { ...pr, state: 'closed' }).nextAction, 'This fork is closed.');
}
{
  const result = summarize([review({})], [check({})]);
  assert.equal(result.nextAction, 'Inspect the server publish policy before publishing.');
  assert.equal(Object.hasOwn(result, 'mergeable'), false, 'loaded evidence is not server publish eligibility');
}
console.log(JSON.stringify({ ok: true, suite: 'review-evidence', scenarios: 8 }));
