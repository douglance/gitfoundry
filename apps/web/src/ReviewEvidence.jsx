import React from 'react';
import { Banner, Button, LayerCard, Text } from '@cloudflare/kumo';
import { reviewEvidence } from './review-evidence.js';

export default function ReviewEvidence({ fork, state, onRefresh }) {
  const evidence = reviewEvidence(fork, state);
  if (evidence.status === 'loading') return <LayerCard className="p-4"><div role="status"><Text>{evidence.message}</Text></div></LayerCard>;
  if (evidence.status === 'unavailable') return <LayerCard className="p-4 space-y-3">
    <Banner variant="warning" title="Review evidence unavailable" description={evidence.message} />
    <Button onClick={onRefresh} disabled={state.busy}>Refresh evidence</Button>
  </LayerCard>;
  const rows = [
    ['Current revision', evidence.revision],
    ['Reviews', evidence.approved + ' approving, ' + evidence.changesRequested + ' requesting changes, ' + evidence.pendingReviews + ' pending'],
    ['Head checks', evidence.checks.total ? evidence.checks.passed + ' passed, ' + evidence.checks.failed + ' failed, ' + evidence.checks.pending + ' running, ' + evidence.checks.other + ' other' : 'No checks loaded for this revision']
  ];
  return <LayerCard className="p-4 space-y-4" data-review-evidence>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Text variant="heading" as="h3">Fork evidence</Text>
      <Button onClick={onRefresh} disabled={state.busy}>Refresh evidence</Button>
    </div>
    <dl className="space-y-2">{rows.map(([label, value]) => <div key={label}>
      <dt><Text variant="secondary" as="span">{label}</Text></dt><dd><Text as="span">{value}</Text></dd>
    </div>)}</dl>
    {(evidence.otherReviews > 0 || evidence.otherChecks > 0) && <Text variant="secondary">
      {evidence.otherReviews} reviews for other revisions and {evidence.otherChecks} other checks are excluded from this summary.
    </Text>}
    <Text>{evidence.nextAction}</Text>
    <Text variant="secondary">Summary of loaded records for this exact fork revision. Server policy determines publish eligibility.</Text>
  </LayerCard>;
}
