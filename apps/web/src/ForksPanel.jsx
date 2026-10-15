import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Badge, Banner, Button, Empty, LayerCard, Loader, Text } from '@cloudflare/kumo';
import { errorLabel, requestJson } from './api.js';
import { buildReviewDocument, layoutLineage, decodeBase64Content, documentKind, encodeBase64Content, findVersion, forgeUrl, normalizeStateEntries, normalizeVersion, normalizeVersions, reviewDocumentPath, shortRevision } from './forge-model.js';

const status = title => <div className="source-status" role="status"><Loader /><Text>{title}</Text></div>;
const hasValue = value => value !== undefined && value !== null && value !== '';
const displayActor = version => [version.creator_kind, version.creator_id].filter(hasValue).join(' / ') || 'authenticated action';

async function forgeRequest(tenant, repository, operation, endpoint, { method = 'GET', body, query, signal } = {}) {
  return requestJson('forge.' + operation, method, forgeUrl(tenant, repository, endpoint, query), body, undefined, signal);
}

function RevisionRows({ version }) {
  const rows = [
    ['Version commit', version.version_commit],
    ['Code commit', version.code_commit],
    ['State commit', version.state_commit],
    ['Operation', version.operation_id],
    ['Request digest', version.request_digest],
    ['Creator', displayActor(version)]
  ];
  return <dl className="fork-revision-rows">{rows.filter(([, value]) => hasValue(value)).map(([label, value]) => <div key={label}>
    <dt><Text variant="secondary" as="span">{label}</Text></dt>
    <dd><Text as="code">{value}</Text></dd>
  </div>)}</dl>;
}



function LineageExplorer({ versions, selected, head, onSelect }) {
  const layout = useMemo(() => layoutLineage(versions), [versions]);
  const marker = 'lineage-' + useId().replace(/:/g, '');
  return <section className="lineage-explorer" aria-labelledby="lineage-title">
    <div className="lineage-toolbar"><div><Text as="h3" variant="heading" id="lineage-title">Complete forge lineage</Text><Text variant="secondary">{layout.nodes.length} retained versions. Select a version to inspect its code and context.</Text></div><span className="lineage-legend"><span className="lineage-head-dot" /> Published head</span></div>
    <div className="lineage-scroll" tabIndex={0} aria-label="Scrollable lineage. Parent versions connect to their child forks.">
      <div className="lineage-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg className="lineage-edges" width={layout.width} height={layout.height} aria-hidden="true">
          <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
          {layout.edges.map(edge => <path key={edge.parent + ':' + edge.child} data-parent={edge.parent} data-child={edge.child} markerEnd={'url(#' + marker + ')'} d={'M ' + (edge.from.x + 196) + ' ' + (edge.from.y + 52) + ' C ' + (edge.from.x + 214) + ' ' + (edge.from.y + 52) + ', ' + (edge.to.x - 18) + ' ' + (edge.to.y + 52) + ', ' + edge.to.x + ' ' + (edge.to.y + 52)} />)}
        </svg>
        {layout.nodes.map(({ version, x, y }) => {
          const active = selected?.version_commit === version.version_commit, accepted = head?.version_commit === version.version_commit;
          return <Button key={version.version_commit} variant="ghost" className={'lineage-node' + (active ? ' is-selected' : '') + (accepted ? ' is-head' : '')} style={{ left: x, top: y }} data-fork-node={version.version_commit} aria-pressed={active} aria-label={'Select forge version ' + version.version_commit + (accepted ? ', published head' : '')} onClick={() => onSelect(version)}>
            <span className="lineage-node-top"><code>{shortRevision(version.version_commit)}</code><span>{accepted ? 'HEAD' : version.parents.length > 1 ? 'MERGE' : version.parents.length ? 'FORK' : 'ROOT'}</span></span>
            <span className="lineage-node-name" title={version.fork_id}>{version.fork_id || 'Complete forge version'}</span>
            <span className="lineage-node-roots"><span>code <code>{shortRevision(version.code_commit)}</code></span><span>state <code>{shortRevision(version.state_commit)}</code></span></span>
          </Button>;
        })}
      </div>
    </div>
    <Text variant="secondary" className="lineage-help">Lines show recorded parents, not publication order. Forking leaves the published head unchanged.</Text>
  </section>;
}

function CompareSummary({ comparison }) {
  if (!comparison) return null;
  const code = Array.isArray(comparison.code_changes) ? comparison.code_changes.length : 0;
  const state = Array.isArray(comparison.state_changes) ? comparison.state_changes.length : 0;
  return <LayerCard className="fork-compare-card" data-fork-compare>
    <Text variant="heading" as="h3">Exact comparison</Text>
    <Text variant="secondary" title={comparison.base_version + ' -> ' + comparison.head_version}>{shortRevision(comparison.base_version)}{' -> '}{shortRevision(comparison.head_version)}</Text>
    <div className="fork-compare-counts">
      <Badge variant="secondary">{code} code changes</Badge>
      <Badge variant="secondary">{state} collaboration changes</Badge>
    </div>
  </LayerCard>;
}

function InspectRecord({ record }) {
  if (!record) return null;
  return <LayerCard className="fork-record-card" data-fork-record>
    <div className="fork-node-header"><Text variant="heading" as="h3">Underlying record</Text><Badge variant="secondary">{record.tree}</Badge></div>
    <Text variant="secondary" title={record.path}>{record.path}</Text>
    {record.commit && <Text variant="secondary">State commit <Text as="code">{record.commit}</Text></Text>}
    {record.error ? <Banner variant="error" title="Record unavailable" description={record.error} /> : <pre className="fork-record-body">{record.text}</pre>}
  </LayerCard>;
}

function StateDocuments({ version, documents, loading, error, onOpen }) {
  return <div className="fork-state-documents" data-state-documents>
    <div className="fork-node-header">
      <div>
        <Text variant="heading" as="h4">Collaboration records in Git</Text>
        <Text variant="secondary">Discovered from the selected fork's forge-state tree at {shortRevision(version.state_commit)}.</Text>
      </div>
      {loading && <Loader />}
    </div>
    {error && <Banner variant="error" title="State document listing unavailable" description={error} />}
    {!loading && !error && !documents.length && <Text variant="secondary">No review, check, checkpoint, coordination, or issue records were listed for this fork version.</Text>}
    {!!documents.length && <div className="fork-documents" aria-label="State tree collaboration records">
      {documents.map(document => <Button key={document.path} variant="secondary" onClick={() => onOpen(document)}>{documentKind(document.path)}: {document.path}</Button>)}
    </div>}
  </div>;
}

function ReviewDecision({ version, busy, onSubmit }) {
  return <div className="fork-review-decision" data-review-decision>
    <div>
      <Text variant="heading" as="h4">Review exact revision</Text>
      <Text variant="secondary">Submit unsigned review evidence for code {shortRevision(version.code_commit)}. The service binds the authenticated actor, key, and signature.</Text>
    </div>
    <div className="fork-actions">
      <Button data-review-approve variant="primary" onClick={() => onSubmit(version, 'approve')} disabled={busy || !version.code_commit}>Approve exact revision</Button>
      <Button data-review-reject variant="secondary" onClick={() => onSubmit(version, 'reject')} disabled={busy || !version.code_commit}>Reject exact revision</Button>
    </div>
  </div>;
}

export default function ForksPanel({ tenant, repository, onOpenSource }) {
  const [head, setHead] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [record, setRecord] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [stateDocuments, setStateDocuments] = useState([]);
  const [stateDocumentsLoading, setStateDocumentsLoading] = useState(false);
  const [stateDocumentsError, setStateDocumentsError] = useState(null);
  const reviewRef = useRef(null);
  const headVersion = useMemo(() => head ? normalizeVersion(head) : null, [head]);

  async function load(signal) {
    if (!tenant || !repository?.id) return;
    setLoading(true); setError(null); setNotice(null); setComparison(null); setRecord(null);
    const [headResult, forksResult] = await Promise.all([
      forgeRequest(tenant, repository.id, 'head', '/head', { signal }),
      forgeRequest(tenant, repository.id, 'forks', '/forks', { signal })
    ]);
    if (signal.aborted) return;
    if (!headResult.ok || !forksResult.ok) {
      setHead(null); setVersions([]); setSelected(null); setError(errorLabel(!headResult.ok ? headResult.error : forksResult.error)); setLoading(false); return;
    }
    const nextHead = headResult.data?.version ? normalizeVersion(headResult.data.version) : null;
    const nextVersions = normalizeVersions(forksResult.data);
    setHead(nextHead);
    setVersions(nextVersions);
    setSelected(current => current && findVersion(nextVersions, current.version_commit) || nextHead || nextVersions[0] || null);
    setLoading(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [tenant, repository?.id]);

  useEffect(() => {
    const versionCommit = (selected || headVersion || versions[0])?.version_commit;
    if (!tenant || !repository?.id || !versionCommit) { setStateDocuments([]); setStateDocumentsError(null); return; }
    const controller = new AbortController();
    setStateDocuments([]); setStateDocumentsLoading(true); setStateDocumentsError(null);
    forgeRequest(tenant, repository.id, 'files', '/files', { query: { version: versionCommit, tree: 'state' }, signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) setStateDocuments(normalizeStateEntries(result.data).slice(0, 40));
      else { setStateDocuments([]); setStateDocumentsError(errorLabel(result.error)); }
      setStateDocumentsLoading(false);
    });
    return () => controller.abort();
  }, [tenant, repository?.id, selected?.version_commit, headVersion?.version_commit, versions[0]?.version_commit]);

  async function runAction(label, action) {
    setBusy(true); setNotice(null); setError(null);
    try {
      const result = await action();
      if (!result.ok) setNotice({ error: true, text: errorLabel(result.error) });
      else setNotice({ error: false, text: label });
      return result;
    } finally { setBusy(false); }
  }

  async function createFork() {
    const parent = selected || headVersion || versions[0];
    if (!parent) return;
    const result = await runAction('Fork created from ' + shortRevision(parent.version_commit) + '.', () => forgeRequest(tenant, repository.id, 'fork', '/fork', { method: 'POST', body: { operation_id: crypto.randomUUID(), parent_version: parent.version_commit } }));
    if (result.ok) load(new AbortController().signal);
  }

  async function publish(version) {
    const result = await runAction('Publish request recorded for ' + shortRevision(version.version_commit) + '.', () => forgeRequest(tenant, repository.id, 'publish', '/publish', { method: 'POST', body: { operation_id: crypto.randomUUID(), expected_head: headVersion?.version_commit || null, new_version: version.version_commit } }));
    if (result.ok) load(new AbortController().signal);
  }

  async function compare(version) {
    const base = version.parents[0] || headVersion?.version_commit;
    if (!base) return;
    const result = await runAction('Comparison loaded for ' + shortRevision(version.version_commit) + '.', () => forgeRequest(tenant, repository.id, 'compare', '/compare', { query: { base_version: base, head_version: version.version_commit } }));
    if (result.ok) setComparison(result.data);
  }

  async function inspect(version) {
    const versionCommit = version.version_commit;
    if (!versionCommit) return;
    const path = '/versions/' + versionCommit;
    const result = await runAction('Underlying record loaded for ' + shortRevision(versionCommit) + '.', () => forgeRequest(tenant, repository.id, 'versions', '/versions/' + encodeURIComponent(versionCommit)));
    setRecord(result.ok
      ? { tree: 'forge-version', path, text: JSON.stringify(normalizeVersion(result.data.version || result.data), null, 2) }
      : { tree: 'forge-version', path, error: errorLabel(result.error) });
  }

  async function openStateDocument(version, document) {
    const result = await runAction('State record loaded from ' + document.path + '.', () => forgeRequest(tenant, repository.id, 'files', '/files', { query: { version: version.version_commit, tree: 'state', path: document.path } }));
    if (!result.ok) { setRecord({ tree: 'forge-state', path: document.path, commit: version.state_commit, error: errorLabel(result.error) }); return; }
    const raw = decodeBase64Content(result.data.content);
    let text = raw;
    if (/\.json$/i.test(document.path)) try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
    setRecord({ tree: 'forge-state', path: document.path, commit: version.state_commit, text });
  }

  async function submitReview(version, decision) {
    const id = 'review-' + crypto.randomUUID();
    const reviewPath = reviewDocumentPath(id);
    let submittedDocument;
    const result = await runAction('Review evidence submitted for exact code ' + shortRevision(version.code_commit) + '.', async () => {
      const config = await forgeRequest(tenant, repository.id, 'files', '/files', { query: { version: version.version_commit, tree: 'state', path: 'config/publication.json' } });
      if (!config.ok) return config;
      let publication;
      try { publication = JSON.parse(decodeBase64Content(config.data.content)); }
      catch { return { ok: false, error: { status: 400, data: { error: 'invalid_publication_config', detail: 'config/publication.json is not valid JSON.' } } }; }
      if (!publication.evaluator_digest) return { ok: false, error: { status: 400, data: { error: 'missing_evaluator_digest', detail: 'config/publication.json does not include evaluator_digest.' } } };
      submittedDocument = buildReviewDocument(version, { id, decision, evaluator_digest: publication.evaluator_digest });
      return forgeRequest(tenant, repository.id, 'commit', '/commit', { method: 'POST', body: {
        operation_id: id,
        parent_version: version.version_commit,
        changes: [{ tree: 'state', path: reviewPath, content_base64: encodeBase64Content(JSON.stringify(submittedDocument, null, 2)) }]
      } });
    });
    if (result.ok) {
      setReviewTarget(null);
      setRecord({ tree: 'unsigned-review-request', path: reviewPath, text: JSON.stringify(submittedDocument, null, 2) });
      load(new AbortController().signal);
    }
  }

  function review(version) {
    setSelected(version);
    setReviewTarget(version.version_commit);
    setRecord(null);
    reviewRef.current?.scrollIntoView({ block: 'start' });
  }

  const selectedVersion = selected || headVersion || versions[0];
  const lineageVersions = useMemo(() => [...(headVersion ? [headVersion] : []), ...versions.filter(version => version.version_commit !== headVersion?.version_commit)], [headVersion, versions]);
  return <section className="fork-workspace" aria-label="Repository forks" data-fork-workspace>
    <div className="work-heading"><div><Text as="h2" variant="heading">Forge</Text><Text variant="secondary">Each published change is a complete forge version with exact code and collaboration roots.</Text></div><div className="heading-actions"><Button onClick={() => load(new AbortController().signal)} disabled={loading || busy}>Refresh</Button><Button variant="primary" onClick={createFork} disabled={loading || busy || !selectedVersion}>Fork this forge</Button></div></div>
    {headVersion && <div className="forge-authority"><span className="lineage-head-dot" /><Text bold>Published head</Text><code title={headVersion.version_commit}>{shortRevision(headVersion.version_commit)}</code><Text variant="secondary">Exploring a fork leaves this head unchanged.</Text></div>}
    {notice && <Banner variant={notice.error ? 'error' : 'default'} title={notice.text} />}
    {error && <Banner variant="error" title="Forge API unavailable" description={error} />}
    {loading ? status('Loading fork lineage') : error ? null : !versions.length && !headVersion && !error ? <Empty title="No published fork versions" description="Initialize the repository forge before comparing, reviewing, or publishing forks." /> : <>
      <div className="forge-workbench">
      <LineageExplorer versions={lineageVersions} selected={selectedVersion} head={headVersion} onSelect={version => { setSelected(version); setReviewTarget(null); setRecord(null); setComparison(null); }} />
      {selectedVersion && <LayerCard ref={reviewRef} className="fork-review-card" data-fork-review>
        <div className="fork-node-header"><div><Text variant="heading" as="h3">Selected fork</Text><Text variant="secondary">Reviews, checks, and checkpoints are documents in the forge-state tree for this exact version.</Text></div><Badge variant="secondary">{shortRevision(selectedVersion.version_commit)}</Badge></div>
        <RevisionRows version={selectedVersion} />
        <div className="fork-actions"><Button onClick={() => onOpenSource?.(selectedVersion)} disabled={!selectedVersion.code_commit}>Browse exact code</Button><Button onClick={() => compare(selectedVersion)} disabled={busy || !selectedVersion.parents.length}>Compare selected fork</Button><Button onClick={() => inspect(selectedVersion)} disabled={busy}>Inspect underlying record</Button><Button onClick={() => review(selectedVersion)} disabled={busy}>Review fork</Button><Button variant="primary" onClick={() => publish(selectedVersion)} disabled={busy || selectedVersion.version_commit === headVersion?.version_commit}>Publish</Button></div>
        {reviewTarget === selectedVersion.version_commit && <ReviewDecision version={selectedVersion} busy={busy} onSubmit={submitReview} />}
        <StateDocuments version={selectedVersion} documents={stateDocuments} loading={stateDocumentsLoading} error={stateDocumentsError} onOpen={document => openStateDocument(selectedVersion, document)} />
      </LayerCard>}
      </div>
      <CompareSummary comparison={comparison} />
      <InspectRecord record={record} />

    </>}
  </section>;
}
