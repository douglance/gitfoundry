import { describe, expect, it } from 'vitest';

import { commandCatalog, historicalCommandCatalog } from './commands.js';

describe('active command catalog', () => {
  it('keeps the fork primitive plus repository bootstrap operations only', () => {
    const ids = commandCatalog.map(command => command.id).sort();
    const bootstrapIds = ['auth.whoami', 'repo.create', 'repo.list', 'repo.view'];
    const forgeIds = ids.filter(id => id.startsWith('forge.'));
    expect(historicalCommandCatalog).toHaveLength(198);
    expect(bootstrapIds.every(id => ids.includes(id))).toBe(true);
    expect(forgeIds).toHaveLength(11);
    expect(commandCatalog).toHaveLength(bootstrapIds.length + forgeIds.length);
    expect(ids.some(id => id.startsWith('issue.') || id.startsWith('pull.') || id.includes('workflow'))).toBe(false);
  });

  it('builds v1 repository bootstrap requests from the active catalog', () => {
    const create = commandCatalog.find(command => command.id === 'repo.create');
    expect(create.path).toBe('/api/v1/tenants/{tenant_id}/repositories');
    expect(create.request_location).toBe('body');
    expect(create.inputSchema.required).toContain('idempotency_key');

    const list = commandCatalog.find(command => command.id === 'repo.list');
    expect(list.path).toBe('/api/v1/tenants/{tenant_id}/repositories');
    expect(list.request_location).toBe('query');

    const view = commandCatalog.find(command => command.id === 'repo.view');
    expect(view.path).toBe('/api/v1/tenants/{tenant_id}/repositories/{id}');
    expect(view.inputSchema.required).toContain('id');
  });
});
