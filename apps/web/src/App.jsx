import logo from './logo.svg';
import React, { useEffect, useRef, useState } from 'react';
import { Badge, Banner, Button, Empty, Input, LayerCard, Link, LinkButton, Loader, Select, Sidebar, Tabs, Text, Textarea, useSidebar } from '@cloudflare/kumo';
import { Form } from '@cloudflare/kumo/primitives/form';
import { MagnifyingGlassIcon, ArrowClockwiseIcon, CheckCircleIcon, GitBranchIcon, GitForkIcon, FolderIcon, ChatCircleIcon, ClipboardTextIcon, PulseIcon, XIcon } from '@phosphor-icons/react';
import { OPERATIONS, errorLabel, invokeCommand, normalizeList, subscribeWorkspaceEvents } from './api.js';
import SourceBrowser from './SourceBrowser.jsx';
import ReviewEvidence from './ReviewEvidence.jsx';
import ForksPanel from './ForksPanel.jsx';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { useQueryStates } from 'nuqs';
import { followView, resetDetail, viewHref, viewParsers } from './navigation.js';
import WorkspaceChrome, { useSystemTheme } from './WorkspaceChrome.jsx';
import { commandDefaults, createPaletteCommands, getCommand } from './commands.js';
import CommandDialog from './CommandDialog.jsx';
import SignIn from './SignIn.jsx';
import SiteStatus, { siteStatusBadge, useSiteChecks } from './SiteStatus.jsx';

const icons = { code: GitBranchIcon, repositories: FolderIcon, issues: ChatCircleIcon, forks: GitForkIcon, reviews: ClipboardTextIcon, checks: CheckCircleIcon };
const recordId = record => String(record._view_id || record.id || record.repository_id || record.number || '');
const titleFor = record => record.name || record.title || record.id || 'Untitled';
const emptyState = tenant => ({ tenant, records: {}, details: {}, errors: {}, loading: {}, selected: {}, notice: null, busy: false, drafts: {}, live: { status: tenant ? 'connecting' : 'idle', cursor: null } });
const fieldData = event => { event.preventDefault(); return Object.fromEntries(new FormData(event.currentTarget)); };
const heading = (text, as = 'h3') => <Text variant="heading" as={as}>{text}</Text>;
const hasValue = value => value !== undefined && value !== null && value !== '';

function useWorkspace(initialTenant) {
  const [state, setState] = useState(() => emptyState(initialTenant));
  const currentTenant = useRef(initialTenant);
  const generation = useRef(0);
  const controller = useRef(new AbortController());
  const detailRequests = useRef({});
  const listRequests = useRef(new Map());
  const mutationRequests = useRef(new Map());
  const eventCursors = useRef(new Map());
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const patch = update => setState(previous => ({ ...previous, ...update(previous) }));
  async function loadList(section, tenant = currentTenant.current, epoch = generation.current) {
    const operation = OPERATIONS[section].list;
    const requestKey = tenant + ':' + section + ':' + epoch;
    const existing = listRequests.current.get(requestKey);
    if (existing) return existing;
    const promise = (async () => {
      patch(s => ({ loading: { ...s.loading, [operation]: true }, errors: { ...s.errors, [operation]: null } }));
      const result = await invokeCommand(operation, { tenant_id: tenant, input: {} }, controller.current.signal);
      if (epoch !== generation.current) return;
      patch(s => ({ records: { ...s.records, [section]: result.ok ? normalizeList(result.data) : s.records[section] }, loading: { ...s.loading, [operation]: false }, errors: { ...s.errors, [operation]: result.ok ? null : result.error } }));
    })().finally(() => { if (listRequests.current.get(requestKey) === promise) listRequests.current.delete(requestKey); });
    listRequests.current.set(requestKey, promise);
    return promise;
  }
  async function loadAll() {
    if (!currentTenant.current) return;
    await Promise.all(Object.keys(OPERATIONS).map(section => loadList(section)));
  }
  async function loadTenant(tenant) {
    controller.current.abort();
    controller.current = new AbortController();
    generation.current += 1;
    currentTenant.current = tenant;
    setState(emptyState(tenant));
    if (tenant) await loadAll();
  }
  async function loadDetail(section, id) {
    const key = section + ':' + id;
    const request = (detailRequests.current[key] || 0) + 1;
    detailRequests.current[key] = request;
    const epoch = generation.current;
    const operation = OPERATIONS[section].detail;
    patch(s => ({ selected: { ...s.selected, [section]: id }, loading: { ...s.loading, [key]: true }, errors: { ...s.errors, [key]: null } }));
    const result = await invokeCommand(operation, { tenant_id: currentTenant.current, id, input: {} }, controller.current.signal);
    if (epoch !== generation.current || detailRequests.current[key] !== request) return;
    patch(s => ({ details: result.ok ? { ...s.details, [key]: result.data } : s.details, loading: { ...s.loading, [key]: false }, errors: { ...s.errors, [key]: result.ok ? null : result.error } }));
    return result.ok;
  }
  async function recoverDetail(section, id) {
    const epoch = generation.current;
    const refreshed = await loadDetail(section, id);
    if (refreshed && epoch === generation.current) patch(() => ({ notice: { text: 'Details refreshed. Review the current record before trying again.', error: false } }));
    return refreshed;
  }
  async function mutate(operation, id, body, message, refreshSection, detailSection) {
    const epoch = generation.current;
    patch(() => ({ busy: true, notice: { text: 'Sending request.', error: false } }));
    const requestKey = JSON.stringify([currentTenant.current, operation, id, body]);
    if (!mutationRequests.current.has(requestKey)) mutationRequests.current.set(requestKey, crypto.randomUUID());
    const args = { tenant_id: currentTenant.current, input: body, idempotency_key: mutationRequests.current.get(requestKey), ...(id !== undefined ? { id } : {}), ...(body.expected_version !== undefined ? { expected_version: body.expected_version } : {}) };
    const result = await invokeCommand(operation, args, controller.current.signal);
    if (epoch !== generation.current) return false;
    if (result.ok) mutationRequests.current.delete(requestKey);
    const stale = !result.ok && result.error.status === 409 && result.error.data?.error === 'gfy_stale_precondition';
    const reload = stale && id && (detailSection || refreshSection) ? { section: detailSection || refreshSection, id } : null;
    patch(() => ({ busy: false, notice: { text: result.ok ? message : reload ? 'This record changed. Refresh its details before trying again.' : errorLabel(result.error), error: !result.ok, reload } }));
    if (result.ok) applyCommandResult({ commandId: operation, response: result });
    return result.ok;
  }
  function sectionsForCommand(commandId) {
    if (commandId.startsWith('repo.')) return ['repositories'];
    if (commandId.startsWith('issue.') || commandId.startsWith('comment.')) return ['issues'];
    if (commandId.startsWith('review.')) return ['reviews'];
    if (commandId.startsWith('check.')) return ['checks'];
    if (commandId.startsWith('forge.')) return ['forks', 'issues', 'reviews', 'checks'];
    return [];
  }
  function applyCommandResult(result) {
    if (!result?.response?.ok) return;
    const sections = sectionsForCommand(result.commandId);
    const epoch = generation.current;
    const tenant = currentTenant.current;
    const selected = stateRef.current.selected;
    void Promise.all(sections.map(async section => {
      await loadList(section, tenant, epoch);
      if (epoch === generation.current && selected[section]) await loadDetail(section, selected[section]);
    }));
  }
  async function applyResourceEvent(event) {
    if (!event || event.tenant_id !== currentTenant.current) return;
    if (event.cursor) eventCursors.current.set(event.tenant_id, event.cursor);
    patch(s => ({ live: { status: 'live', cursor: event.cursor || s.live.cursor } }));
    const epoch = generation.current;
    const sections = sectionsForCommand(event.operation_id);
    await Promise.all(sections.map(section => loadList(section, currentTenant.current, epoch)));
    const selected = stateRef.current.selected;
    await Promise.all(sections.map(section => selected[section] ? loadDetail(section, selected[section]) : undefined));
  }
  useEffect(() => {
    if (initialTenant) loadAll();
    return () => controller.current.abort();
  }, []);
  useEffect(() => {
    if (!state.tenant) return undefined;
    patch(s => ({ live: { ...s.live, status: 'connecting' } }));
    return subscribeWorkspaceEvents(state.tenant, {
      cursor: eventCursors.current.get(state.tenant),
      onOpen: () => patch(s => ({ live: { ...s.live, status: 'live' } })),
      onEvent: applyResourceEvent,
      onReset: () => loadAll(),
      onError: () => patch(s => ({ live: { ...s.live, status: s.live.status === 'live' ? 'reconnecting' : 'unavailable' } }))
    });
  }, [state.tenant]);
  return { state, loadTenant, loadAll, loadDetail, recoverDetail, mutate, applyCommandResult, setDraft: (key, value) => patch(s => ({ drafts: { ...s.drafts, [key]: value } })), clearSelection: section => patch(s => ({ selected: { ...s.selected, [section]: null } })) };
}

function Loading({ title }) {
  return <div className="flex items-center gap-2" role="status"><Loader /><Text>{title}</Text></div>;
}

function FormCard({ id, title, onSubmit, children, actions }) {
  return <LayerCard className="p-4 space-y-4" render={<Form id={id} onSubmit={onSubmit} />}>
    {heading(title)}<div className="space-y-4">{children}</div><div className="flex flex-wrap gap-2">{actions}</div>
  </LayerCard>;
}

function CreateRepository({ workspace }) {
  const { state, mutate } = workspace;
  return <FormCard id="repo-create-form" title="Create repository" onSubmit={event => {
    const body = fieldData(event);
    mutate('repo.create', undefined, body, 'Repository create request finished.', 'repositories');
  }} actions={<Button type="submit" variant="primary" disabled={state.busy}>Create</Button>}>
    <Input id="repo-namespace" label="Namespace" name="namespace_id" defaultValue="core" required />
    <Input id="repo-name" label="Name" name="name" placeholder="runtime" required />
    <Select  label="Visibility" id="repo-visibility" name="visibility" defaultValue="private" items={{ private: 'Private', internal: 'Internal', public: 'Public' }} />
    <Input id="repo-branch" label="Default branch" name="default_branch" defaultValue="main" required />
  </FormCard>;
}

function CreateIssue({ workspace, repositoryId }) {
  const { state, mutate } = workspace;
  const repos = state.records.repositories || [];
  return <FormCard id="issue-create-form" title="Create issue" onSubmit={event => {
    mutate('issue.create', undefined, fieldData(event), 'Issue create request finished.', 'issues');
  }} actions={<Button type="submit" variant="primary" disabled={state.busy || !repos.length}>Create issue</Button>}>
    <Select  label="Repository" id="issue-repo" name="repository_id" defaultValue={repositoryId !== 'all' ? repositoryId : state.selected.repositories || repos[0]?.id} required items={repos.map(repo => ({ value: repo.id, label: (repo.namespace_id ? repo.namespace_id + ' / ' : '') + repo.name }))} placeholder="Choose a repository" />
    <Input id="issue-title" label="Title" name="title" required placeholder="Describe the defect" />
    <Textarea id="issue-body" label="Body" name="body" rows={4} placeholder="Observed behavior and expected behavior" />
  </FormCard>;
}

function Summary({ section, record, state }) {
  const repository = id => {
    const repo = (state.records.repositories || []).find(item => item.id === id);
    return repo ? (repo.namespace_id ? repo.namespace_id + ' / ' : '') + repo.name : id;
  };
  const fork = (state.records.forks || []).find(item => item.id === record.pull_request_id);
  let title = titleFor(record), kicker = OPERATIONS[section].label, badges = [], rows = [];
  if (section === 'repositories') {
    title = repository(record.id);
    kicker = 'Repository';
    badges = [record.visibility, record.archived ? 'Archived' : 'Active'];
    rows = [['Default branch', record.default_branch], ['Description', record.description]];
  } else if (section === 'forks') {
    kicker = 'Fork #' + (record.number || record.fork_id || record.id);
    badges = [record.draft ? 'Draft' : 'Ready', record.state || record.status || 'open'];
    rows = [['Repository', repository(record.repository_id)], ['Fork line', (record.source_ref || record.fork_id || 'source') + ' -> ' + (record.target_ref || 'target')], ['Code revision', record.head_sha || record.code_commit], ['State revision', record.state_commit]];
  } else if (section === 'issues') {
    kicker = 'Issue #' + (record.number || record.id);
    badges = [record.state || 'open'];
    rows = [['Repository', repository(record.repository_id)]];
  } else if (section === 'reviews') {
    kicker = 'Review';
    title = 'Review for fork ' + (fork?.number || record.pull_request_id || record.fork_id || 'candidate');
    badges = [record.state || 'pending'];
    rows = [['Repository', repository(record.repository_id)], ['Candidate', record.candidate_code_commit], ['Reason', record.reason || record.body]];
    if (record._forge?.stale) badges.push('Stale');
  } else {
    kicker = 'Check';
    badges = [record.status, record.conclusion];
    rows = [['Repository', repository(record.repository_id)]];
  }
  return <LayerCard className="p-4 space-y-4">
    <Text variant="secondary">{kicker}</Text>{heading(title)}
    <div className="flex flex-wrap gap-2">{badges.filter(hasValue).map(value => <Badge key={value} variant={['failure', 'closed', 'Archived', 'changes_requested'].includes(value) ? 'error' : ['pending', 'Draft', 'queued'].includes(value) ? 'warning' : 'secondary'}>{value}</Badge>)}</div>
    {hasValue(record.body) && <div ><Text>{record.body}</Text></div>}
    <dl className="space-y-2">{rows.filter(([, value]) => hasValue(value)).map(([label, value]) => <div  key={label}><dt><Text variant="secondary" as="span">{label}</Text></dt><dd><Text as="span">{String(value)}</Text></dd></div>)}</dl>
    {record._forge && <details className="record-inspection"><summary>Inspect underlying record</summary><Text as="p">File: {record._forge.path}</Text><Text as="p">State commit: {record._forge.state_commit}</Text><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(record._forge.document, null, 2)}</pre></details>}
  </LayerCard>;
}

function DetailActions({ section, record, workspace, onViewSource }) {
  const { state, mutate, loadDetail } = workspace;
  const id = recordId(record), version = Number(record.version || 1);
  if (section === 'repositories') return <Button data-browse-code variant="primary" onClick={() => onViewSource(record)}>Browse code</Button>;
  if (section === 'issues') {
    return <FormCard id="comment-create-form" title="Add comment" onSubmit={event => {
      const body = fieldData(event);
      mutate('comment.create', undefined, { ...body, subject_kind: 'issue', subject_id: record.id, repository_id: record.repository_id }, 'Comment request finished.');
    }} actions={<Button type="submit" variant="primary" disabled={state.busy}>Comment on issue</Button>}>
      <Textarea id="comment-body" label="Comment" name="body" required rows={4} placeholder="Write a focused update" />
    </FormCard>;
  }
  if (section === 'forks') {
    return <>
      <FormCard id="review-create-form" title="Review fork" onSubmit={event => {
        mutate('review.create', undefined, { ...fieldData(event), pull_request_id: id, repository_id: record.repository_id }, 'Review create request finished.', 'reviews');
      }} actions={<Button type="submit" variant="primary" disabled={state.busy}>Create review</Button>}>
        <Textarea id="review-body" label="Review body" name="body" rows={4} placeholder="Decision notes for the selected fork revision" />
      </FormCard>
    </>;
  }
  if (section === 'reviews') return <div className="space-y-3"><Text>Review an exact candidate in Forks. Signed decisions remain in Git history.</Text><Button onClick={() => loadDetail(section, id)} icon={ArrowClockwiseIcon}>Reload review</Button></div>;
  return <div className="flex flex-wrap gap-2"><Button onClick={() => loadDetail(section, id)} icon={ArrowClockwiseIcon}>Reload detail</Button></div>;
}

function WorkspaceMenu({ state, section, hrefFor, onNavigate }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return <Sidebar.Menu>{Object.entries(OPERATIONS).map(([value, area]) => <Sidebar.MenuButton key={value} href={hrefFor(value)} data-workspace-section={value} icon={icons[value]} active={section === value} tooltip={area.label} aria-label={area.label} aria-current={section === value ? 'page' : undefined} onClick={event => followView(event, () => {
    onNavigate(value);
    if (isMobile) setOpenMobile(false);
  })}>{area.label}<Badge variant="secondary">{state.records[value]?.length ?? '—'}</Badge></Sidebar.MenuButton>)}</Sidebar.Menu>;
}

function RecordList({ section, workspace, records, filtered, onOpen, hrefFor }) {
  const { state, loadDetail } = workspace;
  const config = OPERATIONS[section];
  if (state.loading[config.list] && !state.records[section]) return <Loading title={'Loading ' + config.plural} />;
  if (state.errors[config.list] && !records.length) return <Empty title={config.label + ' unavailable'} description="Retry to fetch this workspace." />;
  if (!records.length) return <Empty icon={React.createElement(icons[section], { size: 32, 'aria-hidden': true })} title={filtered ? 'No matching ' + config.plural : 'No ' + config.plural + ' yet'} description={filtered ? 'Try a different search or repository.' : 'When ' + config.plural + ' are available for this workspace, they will appear here.'} />;
  return <div className="record-list">{records.map(record => {
    const id = recordId(record);
    const repo = (state.records.repositories || []).find(item => item.id === record.repository_id);
    const metadata = [section === 'repositories' ? record.namespace_id + ' / ' + record.name : repo && repo.namespace_id + ' / ' + repo.name, record.number && '#' + record.number, record.source_ref && record.target_ref ? record.source_ref + ' -> ' + record.target_ref : record.default_branch].filter(hasValue).join(' · ');
    return <div className="record-entry" key={id}>
      <LinkButton className="record-control" href={hrefFor(record)} variant="ghost" data-id={id} onClick={event => followView(event, () => onOpen(record))}>
        {React.createElement(icons[section], { size: 20, 'aria-hidden': true })}
        <span className="record-main"><Text as="span" bold>{titleFor(record)}</Text><Text as="span" variant="secondary">{metadata}</Text></span>
        <Badge variant={record.conclusion === 'failure' || record.state === 'closed' ? 'error' : record.state === 'pending' || record.status === 'queued' || record.draft ? 'warning' : 'secondary'}>{record.draft ? 'Draft' : record.state || record.visibility || record.conclusion || record.status || 'open'}</Badge>
      </LinkButton>
    </div>;
  })}</div>;
}

export default function App() {
  useSystemTheme();
  return <NuqsAdapter><WorkspaceView /></NuqsAdapter>;
}

function WorkspaceView() {
  const defaultTenant = document.querySelector('meta[name="gitfoundry-default-tenant"]')?.content || '';
  const [view, setView] = useQueryStates(viewParsers(defaultTenant), { history: 'push' });
  if (!view.tenant && view.page === 'workspace') return <SignIn />;
  return <WorkspaceViewContent key={view.tenant} view={view} setView={setView} />;
}

function WorkspaceViewContent({ view, setView }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commandId, setCommandId] = useState(null);
  const workspace = useWorkspace(view.tenant);
  const siteChecks = useSiteChecks(view.page === 'status');
  const { state, loadAll, loadDetail } = workspace;
  const repositoryId = view.repo || 'all';
  const section = !view.repo && view.section === 'code' ? 'repositories' : view.section;
  const query = view.q, showCreate = view.create;
  const detailPane = useRef(null);
  const repositories = state.records.repositories || [];
  const repository = repositories.find(repo => repo.id === view.repo);
  const config = OPERATIONS[section] || { label: 'Code', plural: 'files' };
  const id = view.record || (repository && section === 'repositories' ? repository.id : '');
  const key = section + ':' + id;
  const detail = state.details[key] || (state.records[section] || []).find(record => recordId(record) === id);
  const listError = repository && section === 'forks' ? null : state.errors[config.list];
  const scopedRecords = (state.records[section] || []).filter(record => !view.repo || (section === 'repositories' ? record.id : record.repository_id) === view.repo);
  const records = scopedRecords.filter(record => [titleFor(record), record.namespace_id, record.number, record.state, record.source_ref, record.target_ref].filter(hasValue).join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const updateView = (patch, options) => setView(patch, options);
  const sectionPatch = value => ({ ...resetDetail, section: value, page: null });
  const globalPatch = value => ({ ...sectionPatch(value), repo: null });
  const repoPatch = value => value === 'all' ? globalPatch('repositories') : ({ ...sectionPatch('forks'), repo: value });
  const navigate = value => updateView(sectionPatch(value));
  const changeRepository = value => updateView(repoPatch(value));
  const openRecord = (area, record) => updateView(area === 'repositories' ? repoPatch(record.id) : area === 'forks' ? repoPatch(record.repository_id) : { record: recordId(record), create: null });
  const closeDetail = () => updateView({ record: null });
  const viewChanges = fork => updateView({ ...repoPatch(fork.repository_id), mode: 'compare', base: fork.base_sha || fork.parents?.[0], head: fork.head_sha || fork.code_commit, returnFork: fork.id || fork.fork_id });
  const href = patch => viewHref(view, patch);
  useEffect(() => {
    if (id && section !== 'code') loadDetail(section, id);
  }, [id, section]);
  useEffect(() => {
    if (id && window.matchMedia('(max-width: 900px)').matches) detailPane.current?.scrollIntoView({ block: 'start' });
  }, [id, section]);
  const destinations = Object.fromEntries(Object.entries(OPERATIONS).map(([area, item]) => [item.list, { label: 'Global ' + item.label, href: href(globalPatch(area)), onSelect: () => updateView(globalPatch(area)) }]));
  destinations['repo.create'] = { href: href({ ...globalPatch('repositories'), create: true }), onSelect: () => updateView({ ...globalPatch('repositories'), create: true }) };
  destinations['issue.create'] = { href: href({ ...sectionPatch('issues'), create: true }), onSelect: () => updateView({ ...sectionPatch('issues'), create: true }) };
  if (repository) {
    destinations['repo.tree'] = { href: href(sectionPatch('code')), onSelect: () => navigate('code') };
    destinations['repo.diff'] = { href: href({ ...sectionPatch('code'), mode: 'compare' }), onSelect: () => updateView({ ...sectionPatch('code'), mode: 'compare' }) };
  }
  const commands = [
    ...createPaletteCommands(destinations, setCommandId),
    ...repositories.map(repo => ({ ...getCommand('repo.view'), key: 'repo-' + repo.id, label: repo.namespace_id + ' / ' + repo.name, href: href(repoPatch(repo.id)), onSelect: () => changeRepository(repo.id) })),
    ...(repository ? [['code', { label: 'Code' }], ...Object.entries(OPERATIONS).filter(([value]) => value !== 'repositories'), ['repositories', { label: 'Settings' }]].map(([area, item]) => ({ ...getCommand(area === 'code' ? 'repo.tree' : OPERATIONS[area].list), key: 'repo-section-' + area, label: repository.name + ' / ' + item.label, href: href(sectionPatch(area)), onSelect: () => navigate(area) })) : []),
    ...['issues', 'forks', 'reviews', 'checks'].flatMap(area => (state.records[area] || []).map(record => {
      const patch = { ...sectionPatch(area), repo: record.repository_id || null, record: recordId(record) };
      return { ...getCommand(OPERATIONS[area].detail), key: area + '-' + recordId(record), label: OPERATIONS[area].label + ' / ' + titleFor(record), href: href(patch), onSelect: () => updateView(patch) };
    }))
  ];
  const onWorkspace = tenant => {
    if (tenant === view.tenant) loadAll();
    else updateView({ ...globalPatch(section === 'code' ? 'repositories' : section), tenant });
  };
  const legalLink = page => ({ href: href({ page }), onClick: event => followView(event, () => updateView({ page })) });
  const unknownRepository = view.repo && state.records.repositories && !repository && !state.loading['repo.list'];
  return <Sidebar.Provider>
    <div className="forge-shell isolate" data-app-shell data-ui-system="kumo">
      <Link href="#workspace" className="skip-link">Skip to workspace</Link>
      <Sidebar aria-label="Global navigation">
        <Sidebar.Header className="sidebar-header"><div className="sidebar-heading"><div className="sidebar-brand"><img src={logo} width={28} height={28} className="shrink-0" alt="" /><Text variant="heading" className="group-data-[state=collapsed]/sidebar:hidden">GitFoundry</Text></div></div></Sidebar.Header>
        <Sidebar.Content>
          <div className="px-3 pt-3 group-data-[state=collapsed]/sidebar:px-0"><Button data-command-trigger aria-label="Open command palette" aria-keyshortcuts="Meta+K Control+K" variant="secondary" size="sm" className="w-full justify-start group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0" onClick={() => setPaletteOpen(true)}><MagnifyingGlassIcon size={16} className="shrink-0" aria-hidden="true" /><span className="group-data-[state=collapsed]/sidebar:hidden">Quick search…</span><span className="ml-auto text-kumo-subtle group-data-[state=collapsed]/sidebar:hidden">⌘K</span></Button></div><Sidebar.Group>
          <WorkspaceMenu state={state} section={!view.repo && view.page === 'workspace' ? section : null} hrefFor={value => href(globalPatch(value))} onNavigate={value => updateView(globalPatch(value))} />
        </Sidebar.Group>{siteChecks.status !== 'hidden' && siteChecks.status !== 'loading' && <Sidebar.Group><Sidebar.Menu>
          <Sidebar.MenuButton href={href({ ...globalPatch('repositories'), page: 'status' })} data-workspace-section="status" icon={PulseIcon} active={view.page === 'status'} tooltip="Status" aria-label="Status" aria-current={view.page === 'status' ? 'page' : undefined} onClick={event => followView(event, () => updateView({ ...globalPatch('repositories'), page: 'status' }))}>Status{siteStatusBadge(siteChecks)}</Sidebar.MenuButton>
        </Sidebar.Menu></Sidebar.Group>}</Sidebar.Content>
        <Sidebar.Footer className="mobile-only"><Sidebar.Close aria-label="Close workspace navigation" /></Sidebar.Footer>
      </Sidebar>
      <div className="workspace-main">
        <div className="page-container">
          {view.page === 'status' ? <main id="workspace" tabIndex={-1}><SiteStatus siteChecks={siteChecks} /></main> : view.page !== 'workspace' ? <main id="workspace" tabIndex={-1}><Empty title={view.page === 'privacy' ? 'Privacy policy' : 'Terms of use'} description="This document has not been published yet." /><Link href={href({ page: null })} onClick={event => followView(event, () => updateView({ page: null }))}>Back to workspace</Link></main> : <>
          {view.repo && <div className="repository-header">
            <div className="repository-identity">
              <div className="repository-path"><FolderIcon size={24} aria-hidden="true" /><Text as="h1" variant="heading" size="lg">{repository ? repository.namespace_id + ' / ' + repository.name : view.repo}</Text>{repository && <Badge variant="secondary">{repository.visibility}</Badge>}</div>
            </div>
          </div>}
          {repository && <nav className="repository-navigation" aria-label="Repository sections">
            <Tabs variant="underline" value={section} onValueChange={navigate} tabs={[['forks', { label: 'Forge' }], ['code', { label: 'Code' }], ...Object.entries(OPERATIONS).filter(([value]) => !['repositories', 'forks'].includes(value)), ['repositories', { label: 'Settings' }]].map(([value, area]) => ({
              value, label: <span data-section={value} className="tab-label">{React.createElement(icons[value], { size: 16, 'aria-hidden': true })}{area.label}</span>
            }))} />
          </nav>}
          <div id="alert-region" className="alert-region" aria-live="polite">
            {state.notice && <Banner variant={state.notice.error ? 'error' : 'default'} title={state.notice.text} action={state.notice.reload ? <Banner.Action data-stale-reload onClick={() => workspace.recoverDetail(state.notice.reload.section, state.notice.reload.id)}>Refresh details</Banner.Action> : undefined} />}
            {listError && <Banner variant="error" title={'Unable to load ' + config.plural} description={errorLabel(listError)} action={<Banner.Action variant="secondary" onClick={loadAll}>Retry</Banner.Action>} />}
          </div>
          <main id="workspace" tabIndex={-1} className={'work-area' + (id && section !== 'repositories' ? ' has-detail' : '')}>
            {unknownRepository ? <Empty title="Repository unavailable" description="This repository was not found in the selected workspace." /> : view.repo && !repository && !state.errors['repo.list'] ? <Loading title="Loading repository" /> : section === 'code' && repository ? <SourceBrowser key={state.tenant + ':' + repository.id} tenant={state.tenant} repository={repository} view={view} updateView={updateView} onBack={view.returnFork ? () => updateView({ ...sectionPatch('forks'), record: view.returnFork }) : undefined} /> : repository && section === 'forks' ? <ForksPanel tenant={state.tenant} repository={repository} onOpenSource={fork => updateView({ ...sectionPatch('code'), ref: fork.code_commit, file: null, returnFork: fork.fork_id || fork.version_commit })} /> : repository && section === 'repositories' ? <section className="primary-pane" aria-label="Repository settings">
              <Text as="h2" variant="heading">Settings</Text>
              {state.loading[key] ? <Loading title="Loading repository settings" /> : state.errors[key] ? <Banner variant="error" title="Repository settings unavailable" description={errorLabel(state.errors[key])} /> : detail && <><Summary section="repositories" record={detail} state={state} /><DetailActions section="repositories" record={detail} workspace={workspace} onViewSource={() => navigate('code')} /></>}
            </section> : <>
            <section className="primary-pane" aria-labelledby="panel-title">
              <div className="work-heading"><div><Text id="panel-title" as={repository ? 'h2' : 'h1'} variant="heading">{config.label}</Text><Text variant="secondary">{repository ? repository.namespace_id + ' / ' + repository.name : 'Across your workspace'}</Text></div>
                <div className="heading-actions"><Badge variant={state.live.status === 'unavailable' ? 'error' : 'secondary'}>{state.live.status === 'live' ? 'Live' : state.live.status === 'reconnecting' ? 'Reconnecting' : state.live.status === 'unavailable' ? 'Offline' : 'Connecting'}</Badge>
                  {state.tenant && ['repositories', 'issues'].includes(section) && <Button id="new-record-button" variant="primary" aria-expanded={showCreate} aria-controls="create-panel" onClick={() => updateView({ create: !showCreate, record: null })}>{showCreate ? 'Cancel' : section === 'repositories' ? 'New repository' : 'New issue'}</Button>}
                </div>
              </div>
              {!state.tenant ? <Empty title="Choose a tenant" description="Use the command palette to choose a workspace." icon={<GitBranchIcon size={32} aria-hidden="true" />} /> : <>
                <div className="work-toolbar"><Input className="search-field" name="search" aria-label={'Search ' + config.plural} value={query} placeholder={'Search ' + config.plural + '…'} onChange={event => updateView({ q: event.target.value || null, record: null }, { history: 'replace' })} /></div>
                {showCreate && <div id="create-panel">{section === 'repositories' ? <CreateRepository workspace={workspace} /> : <CreateIssue key={state.tenant + ':' + repositoryId} workspace={workspace} repositoryId={repositoryId} />}</div>}
                <LayerCard className="list-card"><div className="list-heading"><Text bold>{listError ? 'Count unavailable' : state.loading[config.list] && !state.records[section] ? 'Loading...' : <>{records.length} {records.length === 1 ? ({ repositories: 'repository', issues: 'issue', forks: 'fork', reviews: 'review', checks: 'check' })[section] : config.plural}</>}</Text><Text variant="secondary">{query.trim() ? 'Matching your search' : repository ? 'This repository' : 'All repositories'}</Text></div><div id="panel-content"><RecordList section={section} workspace={workspace} records={records} filtered={Boolean(query.trim()) || repositoryId !== 'all'} onOpen={record => openRecord(section, record)} hrefFor={record => href(section === 'repositories' ? repoPatch(record.id) : section === 'forks' ? repoPatch(record.repository_id) : { record: recordId(record), create: null })} /></div></LayerCard>
              </>}
            </section>
            <aside ref={detailPane} id="detail-pane" className="detail-pane" hidden={!id} aria-labelledby="detail-title">
              <div className="detail-heading"><Text id="detail-title" as="h2" variant="heading">{detail ? titleFor(detail) : 'Details'}</Text><Button aria-label="Close details" shape="square" variant="ghost" icon={XIcon} onClick={closeDetail} /></div>
              {id && state.loading[key] ? <Loading title="Loading details" /> : id && <>
                {state.errors[key] && <Banner variant="error" title="Unable to load details" description={errorLabel(state.errors[key])} action={<Banner.Action onClick={() => loadDetail(section, id)}>Retry</Banner.Action>} />}
                {detail && section === 'forks' && !state.errors[key] && <div className="flex flex-wrap gap-2" data-review-actions>
                  {detail.base_sha && detail.head_sha && <Button variant="primary" onClick={() => viewChanges(detail)}>View changed files</Button>}
                  <Button data-review-start onClick={() => { const field = document.getElementById('review-body'); field?.focus(); field?.scrollIntoView({ block: 'center' }); }}>Start review</Button>
                </div>}
                {detail && <Summary section={section} record={detail} state={state} />}
                {detail && section === 'forks' && !state.errors[key] && <ReviewEvidence fork={detail} state={state} onRefresh={loadAll} />}
                {detail && !state.errors[key] && <DetailActions key={key} section={section} record={detail} workspace={workspace} onViewSource={repo => changeRepository(repo.id)} />}
              </>}
            </aside>
            </>}
          </main>
          </>}
        </div>
      </div>
      {commandId && <CommandDialog key={commandId} commandId={commandId} defaults={commandDefaults(commandId, view, detail)} onClose={() => setCommandId(null)} onExecuted={workspace.applyCommandResult} />}
      <WorkspaceChrome tenant={state.tenant} loading={Object.values(state.loading).some(Boolean)} error={Boolean(state.errors['repo.list'])} commands={commands} onWorkspace={onWorkspace} privacy={legalLink('privacy')} terms={legalLink('terms')} paletteOpen={paletteOpen} setPaletteOpen={setPaletteOpen} />
    </div>
  </Sidebar.Provider>;
}
