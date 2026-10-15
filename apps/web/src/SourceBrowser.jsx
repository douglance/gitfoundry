import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Banner, Button, Dialog, Empty, Input, LayerCard, Loader, Select, Text } from '@cloudflare/kumo';
import { Form } from '@cloudflare/kumo/primitives/form';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { themeToTreeStyles } from '@pierre/trees';
import { File, FileDiff } from '@pierre/diffs/react';
import { parsePatchFiles } from '@pierre/diffs';
import { createThemeController, createThemeResolver } from '@pierre/theming';
import pierreLight from '@pierre/theme/pierre-light';
import pierreDark from '@pierre/theme/pierre-dark';
import { errorLabel, requestJson } from './api.js';
import { diffPatch, sourceText, sourceUrl } from './source-model.js';

const maxEntries = 10000;
const shaPattern = /^[0-9a-f]{40}$/;
const shortSha = sha => sha?.slice(0, 12);
const status = title => <div className="source-status" role="status"><Loader /><Text>{title}</Text></div>;

function useCodeTheme() {
  const [theme, setTheme] = useState(pierreLight);
  useEffect(() => {
    const resolver = createThemeResolver();
    resolver.registerTheme('pierre-light', async () => pierreLight);
    resolver.registerTheme('pierre-dark', async () => pierreDark);
    resolver.seedResolvedThemes([['pierre-light', pierreLight], ['pierre-dark', pierreDark]]);
    const controller = createThemeController({ resolver, defaultMode: 'light', defaultLightThemeName: 'pierre-light', defaultDarkThemeName: 'pierre-dark', persistence: { load: () => null, save: () => {} } });
    const sync = () => controller.setColorMode(document.documentElement.getAttribute('data-mode') === 'dark' || document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    const unsubscribe = controller.subscribe(() => setTheme(controller.getState().resolvedTheme || pierreLight));
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'class'] });
    sync();
    setTheme(controller.getState().resolvedTheme || pierreLight);
    return () => { observer.disconnect(); unsubscribe(); controller.destroy(); };
  }, []);
  return theme;
}

function SourceTree({ entries, selected, onSelect, theme }) {
  const callback = useRef(onSelect);
  const syncing = useRef(false);
  callback.current = onSelect;
  const selectable = useRef(new Set());
  selectable.current = new Set(entries.filter(entry => entry.kind !== 'tree').map(entry => entry.path));
  const paths = useMemo(() => entries.filter(entry => !entry.path_base64).map(entry => entry.kind === 'tree' ? entry.path.replace(/\/$/, '') + '/' : entry.path), [entries]);
  const { model } = useFileTree({ paths, search: true, initialSelectedPaths: selected ? [selected] : [], onSelectionChange: paths => {
    if (syncing.current) return;
    const path = paths[0];
    if (path && selectable.current.has(path)) callback.current(path);
  } });
  useEffect(() => {
    syncing.current = true;
    try {
      model.resetPaths(paths);
      for (const path of model.getSelectedPaths()) if (path !== selected) model.getItem(path)?.deselect();
      if (selected) model.getItem(selected)?.select();
    } finally { syncing.current = false; }
  }, [model, paths, selected]);
  return <FileTree data-source-tree aria-label="Repository files" model={model} style={{ ...themeToTreeStyles(theme), height: 'min(65vh, ' + Math.min(600, Math.max(180, paths.length * 32 + 56)) + 'px)' }} />;
}

function FileNavigation({ entries, selected, onSelect, theme, footer }) {
  const [open, setOpen] = useState(false);
  return <>
    <aside className="source-tree-pane" aria-label="Files"><SourceTree entries={entries} selected={selected} onSelect={onSelect} theme={theme} />{footer}</aside>
    <div className="source-mobile-files">
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger render={<Button />}>Files</Dialog.Trigger>
        <Dialog className="p-4 space-y-4">
          <div className="source-file-heading"><Dialog.Title>Files</Dialog.Title><Dialog.Close render={<Button variant="ghost" />}>Close files</Dialog.Close></div>
          <Dialog.Description>Select a file in this repository snapshot.</Dialog.Description>
          <SourceTree entries={entries} selected={selected} onSelect={path => { onSelect(path); setOpen(false); }} theme={theme} />{footer}
        </Dialog>
      </Dialog.Root>
    </div>
  </>;
}

async function readSource(tenant, repository, endpoint, query, signal) {
  const result = await requestJson('repo.' + endpoint, 'GET', sourceUrl(tenant, repository, endpoint, query), undefined, undefined, signal);
  if (!result.ok) throw new Error(errorLabel(result.error));
  return result.data;
}

function SourceFiles({ tenant, repository, theme, view, updateView }) {
  const ref = view.ref || repository.default_branch || 'main';
  const [draftRef, setDraftRef] = useState(ref);
  useEffect(() => { setDraftRef(ref); }, [ref]);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(null);
  const selected = view.file;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const setSelected = path => { if (path !== selected) updateView({ file: path }); };
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [fileError, setFileError] = useState('');
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [paging, setPaging] = useState(false);
  const treeController = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    treeController.current = controller;
    setPage(null); setFile(null); setError(''); setLoading(true); setPaging(false);
    readSource(tenant, repository.id, 'tree', { ref, recursive: true, limit: 1000 }, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (data.repository_id !== repository.id || !shaPattern.test(data.resolved_sha) || !Array.isArray(data.items)) throw new Error('Tree response does not match the selected repository snapshot.');
      setPage(data);
      if (!selectedRef.current) updateView({ file: data.items.find(entry => entry.kind === 'blob' && /(^|\/)README\.md$/i.test(entry.path))?.path || data.items.find(entry => entry.kind !== 'tree' && !entry.path_base64)?.path || null }, { history: 'replace' });
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tenant, repository.id, ref, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setFile(null); setFileError('');
    if (!page || !selected) return () => controller.abort();
    setFileLoading(true);
    readSource(tenant, repository.id, 'source-file', { ref: page.resolved_sha, path: selected }, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      const contents = sourceText(data, repository.id, page.resolved_sha, selected);
      setFile({ data, contents, source: contents === null ? null : { name: selected, contents, cacheKey: page.resolved_sha + ':' + selected + ':' + data.sha } });
    }).catch(error => { if (!controller.signal.aborted) setFileError(error.message); }).finally(() => { if (!controller.signal.aborted) setFileLoading(false); });
    return () => controller.abort();
  }, [tenant, repository.id, page?.resolved_sha, selected]);
  async function more() {
    const controller = treeController.current;
    if (!page?.next_cursor || !controller || paging) return;
    setPaging(true); setError('');
    try {
      const next = await readSource(tenant, repository.id, 'tree', { ref, recursive: true, limit: 1000, cursor: page.next_cursor }, controller.signal);
      if (controller.signal.aborted) return;
      if (next.repository_id !== repository.id || next.resolved_sha !== page.resolved_sha) throw new Error('Tree continuation changed the selected snapshot.');
      setPage(previous => ({ ...next, items: [...previous.items, ...next.items].slice(0, maxEntries) }));
    } catch (error) { if (!controller.signal.aborted) setError(error.message); }
    finally { if (!controller.signal.aborted) setPaging(false); }
  }
  const visibleFile = file?.data.path === selected && file?.data.resolved_sha === page?.resolved_sha ? file : null;
  const footer = page?.has_more && <Button disabled={paging || page.items.length >= maxEntries} onClick={more}>{paging ? 'Loading files…' : page.items.length >= maxEntries ? 'File view limit reached' : 'Load more files'}</Button>;
  return <section className="source-section" aria-label="Repository source">
    <Form className="source-toolbar" onSubmit={event => { event.preventDefault(); if (draftRef.trim() === ref) setRefresh(value => value + 1); else updateView({ ref: draftRef.trim(), file: null }); }}>
      <Input id="source-ref" label="Branch, tag or commit" value={draftRef} onChange={event => setDraftRef(event.target.value)} required spellCheck={false} />
      <Button type="submit" disabled={loading}>Load ref</Button>
      {page && <Text variant="secondary" title={page.resolved_sha}>Snapshot {shortSha(page.resolved_sha)}</Text>}
    </Form>
    {error && <Banner variant="error" title="Source unavailable" description={error} />}
    {loading ? status('Loading repository files') : page && !page.items.length ? <Empty title="No files in this snapshot" description="Choose a different branch, tag or commit." /> : page && <div className="source-body">
      <FileNavigation entries={page.items} selected={selected} onSelect={setSelected} theme={theme} footer={footer} />
      <LayerCard className="source-content">
        {selected && !visibleFile?.source && <div className="source-file-heading"><Text bold>{selected}</Text>{visibleFile && <Badge variant="secondary">{visibleFile.data.size_bytes} bytes</Badge>}</div>}
        {fileLoading || selected && !visibleFile && !fileError ? status('Loading source') : fileError ? <Banner variant="error" title="File unavailable" description={fileError} /> : visibleFile?.source ? <div data-source-file={selected} data-source-sha={page.resolved_sha}><File file={visibleFile.source} renderHeaderMetadata={() => <Badge variant="secondary">{visibleFile.data.size_bytes} bytes</Badge>} options={{ theme: theme.name, themeType: theme.type, enableLineSelection: true }} /></div> : visibleFile ? <Empty title={visibleFile.data.truncated ? 'File exceeds the source view limit' : visibleFile.data.encoding === 'binary' ? 'Binary file' : 'Unsupported source content'} description="This content is not displayed as text." /> : <Empty title="Select a file" description="Choose a file from the repository tree." />}
      </LayerCard>
    </div>}
  </section>;
}

function Comparison({ tenant, repository, theme, view, updateView }) {
  const [base, setBase] = useState(view.base || repository.default_branch || 'main');
  const [head, setHead] = useState(view.head || repository.default_branch || 'main');
  useEffect(() => { setBase(view.base || repository.default_branch || 'main'); setHead(view.head || repository.default_branch || 'main'); }, [view.base, view.head, repository.default_branch]);
  const query = useMemo(() => view.base && view.head ? { base: view.base, head: view.head } : null, [view.base, view.head]);
  const [page, setPage] = useState(null);
  const selected = view.file;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const setSelected = path => { if (path !== selected) updateView({ file: path }); };
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const layout = view.layout;
  const setLayout = value => updateView({ layout: value });
  const [mobile, setMobile] = useState(false);
  useEffect(() => { const media = window.matchMedia('(max-width: 767px)'); const update = () => setMobile(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPage(null); setError('');
    if (!query) return () => controller.abort();
    setLoading(true);
    readSource(tenant, repository.id, 'diff', { ...query, comparison: 'two_dot', limit: 100 }, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (data.repository_id !== repository.id || !shaPattern.test(data.base_sha) || !shaPattern.test(data.head_sha)) throw new Error('Comparison response does not match the selected repository.');
      if (shaPattern.test(query.base) && data.base_sha !== query.base || shaPattern.test(query.head) && data.head_sha !== query.head) throw new Error('Comparison changed the selected commit pair.');
      setPage(data); if (!selectedRef.current) updateView({ file: data.items[0]?.new_path || data.items[0]?.old_path || null }, { history: 'replace' });
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tenant, repository.id, query]);
  const file = page?.items.find(item => (item.new_path || item.old_path) === selected);
  const parsed = useMemo(() => {
    if (!file) return [];
    const patch = diffPatch(file);
    return patch ? parsePatchFiles(patch).flatMap(patch => patch.files) : [];
  }, [file]);
  const entries = useMemo(() => (page?.items || []).map(item => ({ path: item.new_path || item.old_path, kind: 'blob' })), [page]);
  return <section className="source-section" aria-label="Repository comparison">
    <Form className="source-toolbar" onSubmit={event => { event.preventDefault(); updateView({ base: base.trim(), head: head.trim(), file: null }); }}>
      <Input id="source-base" label="Base ref or commit" value={base} onChange={event => setBase(event.target.value)} required spellCheck={false} />
      <Input id="source-head" label="Head ref or commit" value={head} onChange={event => setHead(event.target.value)} required spellCheck={false} />
      <Button type="submit" disabled={loading}>Compare</Button>
      <Select aria-label="Diff layout" value={mobile ? 'unified' : layout} onValueChange={setLayout} disabled={mobile} items={{ unified: 'Unified', split: 'Split' }} />
    </Form>
    {error && <Banner variant="error" title="Comparison unavailable" description={error} />}
    {page && <Text variant="secondary" title={page.base_sha + ' → ' + page.head_sha}>{shortSha(page.base_sha)} → {shortSha(page.head_sha)} · {page.items.length} changed files</Text>}
    {page?.truncated && <Banner variant="warning" title="Comparison is truncated" description={page.truncation_reason || 'The comparison exceeds the display limit.'} />}
    {page?.has_more && <Banner variant="warning" title="More changed files exist" description="Narrow the comparison to inspect additional files. This view shows the first page." />}
    {loading ? status('Loading comparison') : !query ? <Empty title="Compare repository snapshots" description="Choose a base and head branch, tag or commit." /> : page && !page.items.length ? <Empty title="No changes between these snapshots" description="The selected comparison returned no changed files." /> : page && <div className="source-body">
      <FileNavigation entries={entries} selected={selected} onSelect={setSelected} theme={theme} />
      <LayerCard className="source-content" data-source-diff data-base-sha={page.base_sha} data-head-sha={page.head_sha}>
        <div className="source-file-heading"><Text bold>{selected}</Text>{file && <Badge variant="secondary">{file.change}</Badge>}</div>
        {file?.binary || file?.truncated ? <Empty title={file.binary ? 'Binary change' : 'File diff is truncated'} description="This change is not displayed as a text diff." /> : parsed.map((metadata, index) => <FileDiff key={index} fileDiff={metadata} options={{ theme: theme.name, themeType: theme.type, diffStyle: mobile ? 'unified' : layout, enableLineSelection: true }} />)}
      </LayerCard>
    </div>}
  </section>;
}

export default function SourceBrowser({ tenant, repository, view, updateView, onBack }) {
  const compare = view.mode === 'compare';
  const theme = useCodeTheme();
  return <div className="source-workspace">
    <div className="work-heading"><Text as="h2" variant="heading">Code</Text><div className="heading-actions">{onBack && <Button onClick={onBack}>Back to fork</Button>}<Button data-compare-toggle onClick={() => updateView({ mode: compare ? null : 'compare', file: null, base: null, head: null, returnFork: null })}>{compare ? 'Browse files' : 'Compare changes'}</Button></div></div>
    {compare ? <Comparison tenant={tenant} repository={repository} theme={theme} view={view} updateView={updateView} /> : <SourceFiles tenant={tenant} repository={repository} theme={theme} view={view} updateView={updateView} />}
  </div>;
}
