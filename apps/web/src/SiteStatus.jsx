import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Banner, Button, Empty, LayerCard, Loader, Text } from '@cloudflare/kumo';
import { ArrowClockwiseIcon, CheckCircleIcon, PulseIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { errorLabel, requestJson } from './api.js';
import { formatDuration, summarizeSiteChecks } from './site-status-model.js';

const refreshMs = 30_000;
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const formatTime = value => timeFormat.format(new Date(value));

// Site checks are visible only to the owner workspace. Anyone else, or a server without site checks, gets 401, 403, or 404 and sees no status entry.
export function useSiteChecks(open) {
  const [result, setResult] = useState({ status: 'loading', checks: [], error: null });
  const load = useCallback(async () => {
    const response = await requestJson('site.checks', 'GET', '/api/v1/site-checks');
    if (response.ok) setResult({ status: 'ready', checks: response.data?.checks ?? [], error: null });
    else if ([401, 403, 404].includes(response.error.status)) setResult({ status: 'hidden', checks: [], error: null });
    else setResult(previous => ({ status: previous.checks.length ? 'ready' : 'error', checks: previous.checks, error: response.error }));
  }, []);
  useEffect(() => {
    load();
    if (!open) return undefined;
    const timer = setInterval(load, refreshMs);
    return () => clearInterval(timer);
  }, [open, load]);
  return { ...result, reload: load };
}

export function siteStatusBadge(siteChecks) {
  if (siteChecks.status !== 'ready') return null;
  const { state } = summarizeSiteChecks(siteChecks.checks);
  return state === 'none' ? null : <Badge variant={state === 'passing' ? 'success' : 'error'}>{state === 'passing' ? 'Passing' : 'Failing'}</Badge>;
}

export default function SiteStatus({ siteChecks }) {
  const { status, checks, error, reload } = siteChecks;
  if (status === 'loading') return <div className="source-status" role="status"><Loader /><Text>Loading status</Text></div>;
  if (status === 'hidden') return <Empty icon={<PulseIcon size={32} aria-hidden="true" />} title="Status unavailable" description="Production status is shown only to the GitFoundry owner workspace." />;
  if (status === 'error') return <Empty icon={<PulseIcon size={32} aria-hidden="true" />} title="Status unavailable" description={errorLabel(error)} contents={<Button icon={ArrowClockwiseIcon} onClick={reload}>Retry</Button>} />;
  const summary = summarizeSiteChecks(checks);
  const SummaryIcon = summary.state === 'failing' ? WarningCircleIcon : summary.state === 'passing' ? CheckCircleIcon : PulseIcon;
  return <section className="site-status" aria-labelledby="site-status-title">
    <div className="site-status-heading">
      <Text as="h1" variant="heading" size="lg" id="site-status-title">Status</Text>
      <Text variant="secondary">Production loads the canonical repository every 5 minutes. This page refreshes every 30 seconds.</Text>
    </div>
    {error && <Banner variant="warning" title="Could not refresh status" description={errorLabel(error)} />}
    <LayerCard className={'site-status-summary is-' + summary.state} data-site-status={summary.state}>
      <SummaryIcon size={32} weight={summary.state === "none" ? "regular" : "fill"} aria-hidden="true" className="site-status-icon" />
      <div className="site-status-summary-text">
        <Text as="h2" variant="heading" role="status">{summary.title}</Text>
        {summary.checkedAt && <Text variant="secondary">Last checked <time dateTime={summary.checkedAt}>{formatTime(summary.checkedAt)}</time></Text>}
        {summary.detail && <Text>{summary.detail}</Text>}
      </div>
    </LayerCard>
    {checks.length > 0 && <LayerCard className="list-card">
      <div className="list-heading"><Text bold>Recent checks</Text><Text variant="secondary">{checks.length} shown</Text></div>
      <ol className="site-check-list">{checks.map(check => <li key={check.checked_at} className="site-check-entry" data-site-check={check.ok ? 'passed' : 'failed'}>
        <span className={'site-check-dot ' + (check.ok ? 'is-passed' : 'is-failed')} aria-hidden="true" />
        <Text as="span" className="site-check-time"><time dateTime={check.checked_at}>{formatTime(check.checked_at)}</time></Text>
        <Text as="span">{check.ok ? 'Passed' : 'Failed at ' + check.stage + (check.code ? ' · ' + check.code : '')}</Text>
        <Text as="span" variant="secondary" className="site-check-duration">{formatDuration(check.duration_ms)}</Text>
      </li>)}</ol>
    </LayerCard>}
  </section>;
}
