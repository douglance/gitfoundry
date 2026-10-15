import assert from 'node:assert/strict';
import { formatDuration, summarizeSiteChecks } from '../src/site-status-model.js';

// docs/requirements/live-site-checks.md R6: the status names the newest check's outcome, time, and failing stage.
const passed = { checked_at: '2026-10-12T18:00:00.000Z', ok: true, stage: null, code: null, duration_ms: 1400 };
const failed = { checked_at: '2026-10-12T18:05:00.000Z', ok: false, stage: 'tree', code: 'unsupported', duration_ms: 2100 };
assert.deepEqual(summarizeSiteChecks([passed]), { state: 'passing', title: 'All checks passing', checkedAt: '2026-10-12T18:00:00.000Z', detail: '' });
assert.deepEqual(summarizeSiteChecks([failed, passed]), { state: 'failing', title: 'Failing', checkedAt: '2026-10-12T18:05:00.000Z', detail: 'The repository check failed at stage tree (unsupported).' });
assert.deepEqual(summarizeSiteChecks([]), { state: 'none', title: 'No checks yet', checkedAt: null, detail: 'The first scheduled check runs within five minutes of a release.' });
assert.equal(formatDuration(1400), '1.4 s');
assert.equal(formatDuration(250), '0.3 s');
console.log(JSON.stringify({ ok: true, suite: 'site status model' }));
