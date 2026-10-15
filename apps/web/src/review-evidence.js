const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const failedConclusions = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);

export function reviewEvidence(fork, state) {
  const revision = fork?.head_sha || fork?.code_commit;
  if (!fork || !oid(revision) || !fork.id || !fork.repository_id || fork.tenant_id !== state.tenant) {
    return { status: 'unavailable', message: 'The current revision is unavailable. Refresh this fork.' };
  }
  if (state.errors['review.list'] || state.errors['check.list']) {
    return { status: 'unavailable', message: 'Review or check evidence could not be loaded. Refresh to try again.' };
  }
  if (state.loading['review.list'] || state.loading['check.list'] || !Array.isArray(state.records.reviews) || !Array.isArray(state.records.checks)) {
    return { status: 'loading', message: 'Loading review and check evidence.' };
  }
  const sameRepository = record => record.tenant_id === fork.tenant_id && record.repository_id === fork.repository_id;
  const relatedReviews = state.records.reviews.filter(record => sameRepository(record) && (record.pull_request_id === fork.id || record.fork_id === fork.id || Boolean(fork.fork_id && record.fork_id === fork.fork_id) || Boolean(fork.version_commit && record.version_commit === fork.version_commit)));
  const currentReviews = relatedReviews.filter(record => record.head_sha === revision || record.code_commit === revision);
  const relatedChecks = state.records.checks.filter(sameRepository);
  const currentChecks = relatedChecks.filter(record => record.commit_sha === revision && record.head_sha === revision || record.code_commit === revision);
  const approved = currentReviews.filter(record => record.state === 'approved').length;
  const changesRequested = currentReviews.filter(record => record.state === 'changes_requested').length;
  const pendingReviews = currentReviews.filter(record => record.state === 'pending').length;
  const checks = { total: currentChecks.length, passed: 0, failed: 0, pending: 0, other: 0 };
  for (const record of currentChecks) {
    if (record.status === 'queued' || record.status === 'in_progress') checks.pending += 1;
    else if (record.status === 'completed' && record.conclusion === 'success') checks.passed += 1;
    else if (record.status === 'completed' && failedConclusions.has(record.conclusion)) checks.failed += 1;
    else checks.other += 1;
  }
  let nextAction;
  if (fork.state && fork.state !== 'open') nextAction = fork.state === 'merged' ? 'This fork is already published.' : 'This fork is closed.';
  else if (fork.draft) nextAction = 'Finish the draft before requesting review.';
  else if (changesRequested) nextAction = 'Address the requested changes, then request a new review.';
  else if (checks.failed) nextAction = 'Inspect the failed checks before requesting another review.';
  else if (checks.pending) nextAction = 'Wait for the running checks, then review their results.';
  else if (!approved && !checks.total) nextAction = 'Review the current changes and request checks for this revision.';
  else if (!approved) nextAction = 'Review the current changes before publishing.';
  else if (!checks.total) nextAction = 'Request checks for this revision before publishing.';
  else if (checks.other) nextAction = 'Inspect the checks without a passing result before publishing.';
  else nextAction = 'Inspect the server publish policy before publishing.';
  return {
    status: 'loaded', revision: revision.slice(0, 12), approved, changesRequested, pendingReviews,
    otherReviews: relatedReviews.length - currentReviews.length,
    otherChecks: relatedChecks.length - currentChecks.length,
    checks, nextAction
  };
}
