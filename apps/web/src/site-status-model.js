// The newest recorded site check decides what the status says.
export function summarizeSiteChecks(checks) {
  const newest = checks[0];
  if (!newest) return { state: 'none', title: 'No checks yet', checkedAt: null, detail: 'The first scheduled check runs within five minutes of a release.' };
  if (newest.ok) return { state: 'passing', title: 'All checks passing', checkedAt: newest.checked_at, detail: '' };
  return { state: 'failing', title: 'Failing', checkedAt: newest.checked_at, detail: 'The repository check failed at stage ' + newest.stage + (newest.code ? ' (' + newest.code + ')' : '') + '.' };
}

export function formatDuration(ms) {
  return (Math.round(ms / 100) / 10).toFixed(1) + ' s';
}
