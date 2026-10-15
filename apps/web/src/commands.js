import { commandCatalog, getCommand as catalogGetCommand } from '../../../packages/contracts/src/commands.js';

const fallbackCommands = new Map([
  ['repo.list', { id: 'repo.list', category: 'repo', label: 'List repositories', cli: 'gfy repo list', description: 'Open repositories in this workspace', inputSchema: { properties: { tenant_id: {}, input: { properties: {} } } } }],
  ['repo.view', { id: 'repo.view', category: 'repo', label: 'View repository', cli: 'gfy repo view', description: 'Open the selected repository', inputSchema: { properties: { tenant_id: {}, id: {}, input: { properties: {} } } } }],
  ['repo.tree', { id: 'repo.tree', category: 'repo', label: 'Browse code', cli: 'gfy repo tree', description: 'Browse files at an exact ref', inputSchema: { properties: { tenant_id: {}, id: {}, input: { properties: {} } } } }],
  ['repo.diff', { id: 'repo.diff', category: 'repo', label: 'Compare code', cli: 'gfy repo diff', description: 'Compare two code revisions', inputSchema: { properties: { tenant_id: {}, id: {}, input: { properties: {} } } } }],
  ['repo.create', { id: 'repo.create', category: 'repo', label: 'Create repository', cli: 'gfy repo create', description: 'Create a repository', inputSchema: { properties: { tenant_id: {}, idempotency_key: {}, input: { properties: {} } } } }],
  ['issue.list', { id: 'issue.list', category: 'issue', label: 'List issues', cli: 'gfy issue list', description: 'Open issue documents', inputSchema: { properties: { tenant_id: {}, input: { properties: {} } } } }],
  ['issue.view', { id: 'issue.view', category: 'issue', label: 'View issue', cli: 'gfy issue view', description: 'Open an issue document', inputSchema: { properties: { tenant_id: {}, id: {}, input: { properties: {} } } } }],
  ['issue.create', { id: 'issue.create', category: 'issue', label: 'Create issue', cli: 'gfy issue create', description: 'Create an issue document', inputSchema: { properties: { tenant_id: {}, idempotency_key: {}, input: { properties: { repository_id: {}, title: {} }, required: ['repository_id', 'title'] } } } }],
  ['comment.create', { id: 'comment.create', category: 'issue', label: 'Create comment', cli: 'gfy comment create', description: 'Create a comment document', inputSchema: { properties: { tenant_id: {}, idempotency_key: {}, input: { properties: {} } } } }],
  ['pr.list', { id: 'pr.list', category: 'forge', label: 'List forks', cli: 'gfy forge list', description: 'Open retained forks', inputSchema: { properties: { tenant_id: {}, input: { properties: {} } } } }],
  ['pr.view', { id: 'pr.view', category: 'forge', label: 'View fork', cli: 'gfy forge view', description: 'Open a retained fork', inputSchema: { properties: { tenant_id: {}, id: {}, input: { properties: {} } } } }],
  ['review.list', { id: 'review.list', category: 'review', label: 'List reviews', cli: 'gfy review list', description: 'Open review documents', inputSchema: { properties: { tenant_id: {}, input: { properties: {} } } } }],
  ['review.view', { id: 'review.view', category: 'review', label: 'View review', cli: 'gfy review view', description: 'Open a review document', inputSchema: { properties: { tenant_id: {}, id: {}, input: { properties: {} } } } }],
  ['review.create', { id: 'review.create', category: 'review', label: 'Create review', cli: 'gfy review create', description: 'Create a review document', inputSchema: { properties: { tenant_id: {}, idempotency_key: {}, input: { properties: { repository_id: {}, pull_request_id: {} } } } } }],
  ['review.submit', { id: 'review.submit', category: 'review', label: 'Submit review', cli: 'gfy review submit', description: 'Submit a review decision', inputSchema: { properties: { tenant_id: {}, id: {}, idempotency_key: {}, input: { properties: { expected_version: {} } } } } }],
  ['review.dismiss', { id: 'review.dismiss', category: 'review', label: 'Dismiss review', cli: 'gfy review dismiss', description: 'Dismiss a review document', inputSchema: { properties: { tenant_id: {}, id: {}, idempotency_key: {}, input: { properties: { expected_version: {} } } } } }],
  ['check.list', { id: 'check.list', category: 'check', label: 'List checks', cli: 'gfy check list', description: 'Open check documents', inputSchema: { properties: { tenant_id: {}, input: { properties: {} } } } }],
  ['check.view', { id: 'check.view', category: 'check', label: 'View check', cli: 'gfy check view', description: 'Open a check document', inputSchema: { properties: { tenant_id: {}, id: {}, input: { properties: {} } } } }]
]);

export { commandCatalog };

export function getCommand(id) {
  const listed = commandCatalog.find(command => command.id === id);
  if (listed) return listed;
  try { return catalogGetCommand(id); }
  catch (error) {
    if (fallbackCommands.has(id)) return fallbackCommands.get(id);
    throw error;
  }
}

export function commandSearchText(command) {
  return [command.id, command.label, command.description, command.cli, command.mcp_tool].filter(Boolean).join(' ').toLowerCase();
}

export function createPaletteCommands(destinations, onCommand) {
  return commandCatalog.map(command => ({
    ...command,
    key: command.id,
    ...(destinations[command.id] || { onSelect: () => onCommand(command.id) })
  }));
}

export function commandDefaults(id, view, record) {
  const command = getCommand(id);
  const family = id.split('.')[0];
  const currentFamily = { repositories: 'repo', code: 'repo', issues: 'issue', forks: 'forge', reviews: 'review', checks: 'check' }[view.section];
  const values = { tenant_id: view.tenant };
  if (family === 'repo') values.id = view.repo || '';
  else if (family === currentFamily) values.id = view.record || '';
  if (command.inputSchema.properties.repository_id) values.repository_id = view.repo || '';
  if (command.inputSchema.properties.version_commit) values.version_commit = view.record || record?.version_commit || '';
  if (family === currentFamily && record?.version !== undefined) values.expected_version = String(record.version);
  if (command.inputSchema.properties.input?.properties?.repository_id) values['input.repository_id'] = view.repo || '';
  if (values.expected_version !== undefined && command.inputSchema.properties.input?.properties?.expected_version) values['input.expected_version'] = values.expected_version;
  return values;
}

export function groupPaletteCommands(commands) {
  const labels = { repo: 'Repositories', issue: 'Issues', forge: 'Forks', pr: 'Forks', review: 'Reviews', check: 'Checks', workspace: 'Workspace' };
  const groups = new Map();
  for (const command of commands) {
    const category = command.category || 'workspace';
    if (!groups.has(category)) groups.set(category, { category, label: labels[category] || category.replaceAll('-', ' ').replace(/^./, char => char.toUpperCase()), items: [] });
    groups.get(category).items.push(command);
  }
  return Array.from(groups.values());
}
