import operationSource from '../../../docs/source/handoff/contracts/operations.json' with { type: 'json' };
import toolSource from '../../../docs/source/handoff/contracts/mcp-tools.json' with { type: 'json' };
import { forkCatalogVersion, forkMcpTools, forkOperations } from './fork-catalog.js';

export function buildCommandCatalog(operations, tools) {
  const toolsByOperation = new Map();
  for (const tool of tools) {
    if (toolsByOperation.has(tool['x-operation'])) throw new Error('Duplicate command tool: ' + tool['x-operation']);
    toolsByOperation.set(tool['x-operation'], tool);
  }
  const ids = new Set(), cliNames = new Set();
  return Object.freeze(operations.map(operation => {
    const tool = toolsByOperation.get(operation.id);
    if (!tool || tool.name !== operation.mcp_tool) throw new Error('Missing command tool: ' + operation.id);
    if (ids.has(operation.id) || cliNames.has(operation.cli)) throw new Error('Duplicate command: ' + operation.id);
    ids.add(operation.id);
    cliNames.add(operation.cli);
    const words = operation.cli.replace(/^gfy /, '').replaceAll('-', ' ');
    return Object.freeze({
      ...operation,
      label: words.charAt(0).toUpperCase() + words.slice(1),
      category: operation.cli.split(' ')[1],
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations
    });
  }));
}

export const historicalCommandCatalog = buildCommandCatalog(operationSource.operations, toolSource.tools);
export const activeCatalogVersion = forkCatalogVersion;
export const commandCatalog = buildCommandCatalog(forkOperations, forkMcpTools);
const commandsById = new Map(commandCatalog.map(command => [command.id, command]));

export function getCommand(id) {
  const command = commandsById.get(id);
  if (!command) throw new Error('Unknown command: ' + id);
  return command;
}

export function commandSearchText(command) {
  return [command.label, command.id, command.cli, command.mcp_tool, command.description, command.category].filter(Boolean).join(' ').toLowerCase();
}

export function commandPath(id, argumentsByName) {
  return getCommand(id).path.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = argumentsByName[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(key + ' is required');
    return encodeURIComponent(value);
  });
}

export function commandRequest(id, args) {
  const command = getCommand(id);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Command arguments must be an object');
  const input = args.input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object');
  for (const key of command.inputSchema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') throw new Error(key + ' is required');
  }
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(command.inputSchema.properties, key)) throw new Error('Unknown argument: ' + key);
  }
  let url = commandPath(id, args);
  const values = { ...input };
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'input' && value !== null && value !== undefined && !Object.hasOwn(values, key)) values[key] = value;
  }
  for (const key of ['tenant_id', 'idempotency_key', 'expected_version', ...Array.from(command.path.matchAll(/\{([^}]+)\}/g), match => match[1])]) delete values[key];
  const headers = {};
  if (args.idempotency_key !== undefined) headers['Idempotency-Key'] = String(args.idempotency_key);
  const acceptsBodyVersion = command.request_location === 'body' && Object.hasOwn(command.inputSchema.properties.input?.properties || {}, 'expected_version');
  const bodyVersion = acceptsBodyVersion ? input.expected_version : undefined;
  if (args.expected_version !== undefined && bodyVersion !== undefined && args.expected_version !== bodyVersion) throw new Error('expected_version must agree with input.expected_version');
  const expectedVersion = args.expected_version ?? bodyVersion;
  if (expectedVersion !== undefined) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('expected_version must be a nonnegative integer');
    headers['If-Match'] = String(expectedVersion);
    if (acceptsBodyVersion) values.expected_version = expectedVersion;
  }
  let body;
  if (command.request_location === 'query') {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== null && item !== undefined) query.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
      }
    }
    if (query.size) url += '?' + query.toString();
  } else if (command.request_location === 'body') body = values;
  else if (command.request_location === 'none' || command.request_location === 'route') body = undefined;
  else throw new Error('Unsupported request location: ' + command.request_location);
  return { operationId: id, method: command.method, url, body, headers };
}

export function commandFields(id) {
  const schema = getCommand(id).inputSchema;
  const fields = [];
  for (const [key, definition] of Object.entries(schema.properties)) {
    if (key === 'expected_version' && schema.properties.input?.properties?.expected_version) continue;
    if (key === 'input' && definition.properties) {
      for (const [name, inputDefinition] of Object.entries(definition.properties)) fields.push({ name: 'input.' + name, schema: inputDefinition, required: (definition.required || []).includes(name) });
    } else fields.push({ name: key, schema: definition, required: (schema.required || []).includes(key) });
  }
  return fields;
}

export function parseCommandFields(id, values) {
  const args = {};
  for (const field of commandFields(id)) {
    const raw = values[field.name];
    if (raw === undefined || raw === '') continue;
    let value = raw;
    if (field.schema.type === 'integer' || field.schema.type === 'number') {
      value = Number(raw);
      if (!Number.isFinite(value) || (field.schema.type === 'integer' && !Number.isInteger(value))) throw new Error(field.name + ' must be a ' + field.schema.type);
    } else if (field.schema.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') throw new Error(field.name + ' must be true or false');
      value = raw === 'true';
    } else if (field.schema.type === 'object' || field.schema.type === 'array' || field.schema.anyOf || field.schema.$ref) value = JSON.parse(raw);
    if (field.name.startsWith('input.')) (args.input ||= {})[field.name.slice(6)] = value;
    else args[field.name] = value;
  }
  if (getCommand(id).inputSchema.required?.includes('input')) args.input ||= {};
  return args;
}
