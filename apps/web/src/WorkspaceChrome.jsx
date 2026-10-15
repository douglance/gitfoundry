import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, CommandPalette, Dialog, Input, Link, Sidebar, Text } from '@cloudflare/kumo';
import { Form } from '@cloudflare/kumo/primitives/form';
import './workspace-chrome.css';
import { commandSearchText, groupPaletteCommands } from './commands.js';

const systemThemeQuery = '(prefers-color-scheme: dark)';
const footerHeightProperty = '--gitfoundry-footer-height';

export function useSystemTheme() {
  const [mode, setMode] = useState('light');

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined' || !window.matchMedia) return undefined;

    const root = document.documentElement;
    const previousMode = root.getAttribute('data-mode');
    const previousColorScheme = root.style.colorScheme;
    const media = window.matchMedia(systemThemeQuery);
    const applyMode = () => {
      const nextMode = media.matches ? 'dark' : 'light';
      root.setAttribute('data-mode', nextMode);
      root.style.colorScheme = nextMode;
      setMode(nextMode);
    };

    applyMode();
    if (media.addEventListener) media.addEventListener('change', applyMode);
    else media.addListener(applyMode);

    return () => {
      if (media.removeEventListener) media.removeEventListener('change', applyMode);
      else media.removeListener(applyMode);
      if (previousMode === null) root.removeAttribute('data-mode');
      else root.setAttribute('data-mode', previousMode);
      root.style.colorScheme = previousColorScheme;
    };
  }, []);

  return mode;
}

const linkProps = link => link ? { href: link.href, onClick: link.onClick } : {};

function commandLabel(command) {
  return String(command?.label || command?.key || '');
}

function opensInNewTab(event, requested) {
  return Boolean(requested || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.button === 1);
}

async function signOut() {
  await fetch('/auth/sign-out', { method: 'POST' }).catch(() => undefined);
  window.location.assign('/');
}

export default function WorkspaceChrome({ tenant = '', loading = false, error = null, commands = [], onWorkspace, privacy, terms, paletteOpen = false, setPaletteOpen } = {}) {
  const footer = useRef(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [query, setQuery] = useState('');
  const currentYear = new Date().getFullYear();
  const status = loading ? 'Loading workspace' : error ? 'Workspace error: ' + String(error.message || error) : tenant ? 'Workspace: ' + tenant : 'No workspace selected';
  const commandItems = useMemo(() => {
    const baseCommands = Array.isArray(commands) ? commands : [];
    return [{ key: 'change-workspace', label: 'Change workspace', onSelect: () => setWorkspaceOpen(true) }, { key: 'sign-out', label: 'Sign out', onSelect: signOut }, ...baseCommands];
  }, [commands]);
  const visibleCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commandItems;
    return commandItems.filter(command => commandSearchText(command).includes(needle));
  }, [commandItems, query]);
  const visibleGroups = useMemo(() => groupPaletteCommands(visibleCommands), [visibleCommands]);

  useEffect(() => {
    const node = footer.current;
    if (typeof document === 'undefined' || !node) return undefined;

    const root = document.documentElement;
    const updateFooterHeight = () => root.style.setProperty(footerHeightProperty, Math.ceil(node.getBoundingClientRect().height) + 'px');
    updateFooterHeight();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateFooterHeight);
      return () => {
        window.removeEventListener('resize', updateFooterHeight);
        root.style.removeProperty(footerHeightProperty);
      };
    }

    const observer = new ResizeObserver(updateFooterHeight);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty(footerHeightProperty);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuery('');
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function setPalette(open) {
    setQuery('');
    setPaletteOpen(open);
  }

  function runCommand(command, options = {}) {
    const newTab = Boolean(options.newTab);
    if (!command) return;
    if (command.href && newTab) {
      const opened = window.open(command.href, '_blank', 'noopener,noreferrer');
      opened?.focus?.();
    } else if (typeof command.onSelect === 'function') {
      command.onSelect(command, { newTab });
    } else if (command.href) {
      window.location.assign(command.href);
    }
    setPalette(false);
  }

  function submitWorkspace(event) {
    event.preventDefault();
    const nextTenant = String(new FormData(event.currentTarget).get('tenant') || '').trim();
    if (typeof onWorkspace === 'function') onWorkspace(nextTenant);
    setWorkspaceOpen(false);
  }

  return <>
    <footer ref={footer} className="workspace-chrome-footer" aria-label="Workspace status">
      <div className="workspace-chrome-actions">
        <Sidebar.Trigger aria-label="Toggle workspace navigation" />
      </div>
      <div className="workspace-chrome-status" role="status"><Text variant="secondary" size="xs">{status}</Text></div>
      <nav className="workspace-chrome-links" aria-label="Legal">
        <Link className="text-xs" {...linkProps(privacy)}>Privacy policy</Link>
        <Link className="text-xs" {...linkProps(terms)}>Terms</Link>
        <Text variant="secondary" size="xs">Copyright {currentYear} GitFoundry</Text>
      </nav>
    </footer>

    <CommandPalette.Root
      open={paletteOpen}
      onOpenChange={setPalette}
      items={visibleGroups}
      getSelectableItems={groups => groups.flatMap(group => group.items)}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={commandLabel}
      onSelect={(command, options) => runCommand(command, options)}
    >
      <CommandPalette.Input autoFocus aria-label="Search commands" placeholder="Search commands" />
      <CommandPalette.List>
        <CommandPalette.Results>{group => <CommandPalette.Group key={group.category} items={group.items}>
          <CommandPalette.GroupLabel><span data-command-category={group.category}>{group.label}</span></CommandPalette.GroupLabel>
          <CommandPalette.Items>{command => <CommandPalette.Item
            key={command.key || command.label || command.href}
            value={command}
            onClick={event => runCommand(command, { newTab: opensInNewTab(event) })}
          >
            <div className="min-w-0 flex-1 space-y-1 py-1">
              {command.id && command.label !== command.id && <Text as="div" variant="secondary" size="xs">{command.label}</Text>}
              {command.cli ? <code className="block whitespace-normal break-words text-sm font-medium">{command.cli.replace(/^gfy\s+/, '')}</code> : <Text as="div" size="sm">{commandLabel(command)}</Text>}
              {command.description && <Text as="div" variant="secondary" size="xs"><span data-command-description className="block whitespace-normal break-words">{command.description}</span></Text>}
            </div>
          </CommandPalette.Item>}</CommandPalette.Items>
        </CommandPalette.Group>}</CommandPalette.Results>
        <CommandPalette.Empty>No commands found</CommandPalette.Empty>
      </CommandPalette.List>
      <CommandPalette.Footer>Enter to select</CommandPalette.Footer>
    </CommandPalette.Root>

    <Dialog.Root open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
      <Dialog className="workspace-chrome-dialog">
        <Dialog.Title>Change workspace</Dialog.Title>
        <Dialog.Description>Load a GitFoundry tenant workspace.</Dialog.Description>
        <Form id="tenant-form" className="tenant-form" onSubmit={submitWorkspace}>
          <Input id="tenant-input" name="tenant" aria-label="Tenant" defaultValue={tenant} autoComplete="organization" placeholder="Tenant ID" spellCheck={false} />
          <Button type="submit">Load workspace</Button>
        </Form>
      </Dialog>
    </Dialog.Root>
  </>;
}
