#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultUrl = 'http://127.0.0.1:4179';
const terminalStatuses = new Set(['completed', 'finished', 'failed', 'canceled', 'cancelled', 'error', 'interrupted']);
const unsuccessfulStatuses = new Set(['failed', 'canceled', 'cancelled', 'error', 'interrupted']);

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'local') argv.shift();
  const command = argv.shift();
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'serve') return serve(argv);
  if (command === 'deploy') return (await import('./gfy-local-deploy.mjs')).main(argv);

  const parsed = parseArgs(argv);
  if (command === 'import') return importSource(parsed);
  if (command === 'snapshot') return snapshot(parsed);
  if (command === 'run') return runCommand(parsed);
  if (command === 'status') return status(parsed);
  if (command === 'logs') return logs(parsed);
  throw new CliError(`unknown local command: ${command}`);
}

async function serve(argv) {
  const parsed = parseArgs(argv);
  if (parsed.options.port) process.env.PORT = parsed.options.port;
  else if (!process.env.PORT) process.env.PORT = '4179';
  if (parsed.options.data) process.env.GFY_LOCAL_DATA = parsed.options.data;
  if (parsed.options['data-root']) process.env.GFY_LOCAL_DATA = parsed.options['data-root'];
  await import(pathToFileURL(resolve(root, 'scripts/serve-local.mjs')).href);
}

async function importSource(parsed) {
  const body = baseBody(parsed, { operation: 'import' });
  body.source_path = requiredOption(parsed, 'source-path', 'local import requires --source-path');
  body.version_commit = parsed.options['version-commit'] || process.env.GFY_VERSION_COMMIT || null;
  printJson(await requestJson(parsed, 'POST', '/_local/import', body));
}

async function snapshot(parsed) {
  const body = baseBody(parsed, { operation: 'snapshot' });
  body.source_path = requiredOption(parsed, 'source-path', 'local snapshot requires --source-path');
  body.version_commit = requiredVersion(parsed, 'local snapshot requires --version-commit');
  printJson(await requestJson(parsed, 'POST', '/_local/snapshot', body));
}

async function runCommand(parsed) {
  const body = baseBody(parsed, { operation: 'run' });
  body.version_commit = requiredVersion(parsed, 'local run requires --version-commit');
  body.command = commandArray(parsed);
  const started = await requestJson(parsed, 'POST', '/_local/runs', body);
  if (parsed.options.wait === false || parsed.options['no-wait'] === true) {
    printJson(started);
    markRunExitStatus(started);
    return;
  }
  const runId = runIdentifier(started);
  assertRunStatusKnown(started, 'local run');
  if (!runId || isTerminalRun(started)) {
    printJson(started);
    markRunExitStatus(started);
    return;
  }
  const intervalMs = positiveInteger(parsed.options['poll-interval-ms'] || '1000', '--poll-interval-ms');
  const timeoutMs = parsed.options['timeout-ms'] === undefined ? undefined : positiveInteger(parsed.options['timeout-ms'], '--timeout-ms');
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  let current = started;
  while (!isTerminalRun(current)) {
    if (deadline !== undefined && Date.now() > deadline) throw new CliError(`local run timed out while waiting for ${runId}`);
    await delay(intervalMs);
    current = await requestJson(parsed, 'GET', '/_local/runs/' + encodeURIComponent(runId));
    assertRunStatusKnown(current, 'local run status');
  }
  printJson(current);
  markRunExitStatus(current);
}

async function status(parsed) {
  const runId = parsed.positionals[0] || parsed.options['run-id'];
  if (!runId) throw new CliError('local status requires a run id');
  const result = await requestJson(parsed, 'GET', '/_local/runs/' + encodeURIComponent(runId));
  assertRunStatusKnown(result, 'local status');
  printJson(result);
  markRunExitStatus(result);
}

async function logs(parsed) {
  const runId = parsed.positionals[0] || parsed.options['run-id'];
  if (!runId) throw new CliError('local logs requires a run id');
  const result = await requestJson(parsed, 'GET', '/_local/runs/' + encodeURIComponent(runId));
  assertRunStatusKnown(result, 'local logs');
  const stateVersion = stateVersionCommit(result);
  if (!stateVersion) throw new CliError('local logs requires state_version_commit from runner status');
  const paths = logPathEntries(result);
  if (paths.length === 0) throw new CliError('local logs found no persisted log paths');
  const maxBytes = positiveInteger(parsed.options['max-bytes'] || '65536', '--max-bytes');
  const contents = {};
  for (const entry of paths) {
    const value = await readStateText(parsed, stateVersion, entry.path, maxBytes);
    contents[entry.name] = value;
  }
  printJson({
    run_id: runIdentifier(result) || runId,
    status: result.status,
    exit_code: result.exit_code ?? result.exitCode ?? null,
    state_version_commit: stateVersion,
    logs: contents,
  });
  markRunExitStatus(result);
}

function baseBody(parsed, { operation }) {
  return {
    tenant_id: parsed.options['tenant-id'] || process.env.GFY_TENANT_ID || 'local',
    repository_id: parsed.options['repository-id'] || process.env.GFY_REPOSITORY_ID || 'gitfoundry',
    operation_id: parsed.options['operation-id'] || generatedOperationId(operation),
  };
}

function requiredVersion(parsed, message) {
  return parsed.options['version-commit'] || process.env.GFY_VERSION_COMMIT || fail(message);
}

function requiredOption(parsed, name, message) {
  return parsed.options[name] || fail(message);
}

function commandArray(parsed) {
  const encoded = parsed.options['argv-json'] || parsed.options['command-json'];
  if (!encoded) throw new CliError('local run requires --argv-json');
  let command;
  try {
    command = JSON.parse(encoded);
  } catch (error) {
    throw new CliError(`--argv-json must be a JSON array: ${error.message}`);
  }
  if (!Array.isArray(command) || command.length === 0 || command.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new CliError('--argv-json must be a non-empty JSON array of non-empty strings');
  }
  return command;
}

async function requestJson(parsed, method, path, body) {
  const url = new URL(path, baseUrl(parsed));
  const headers = new Headers({ accept: 'application/json' });
  if (body !== undefined) headers.set('content-type', 'application/json');
  const authorization = await authorizationHeader(parsed);
  if (authorization) headers.set('authorization', authorization);
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!response.ok) {
    const message = typeof payload.message === 'string' ? payload.message : typeof payload.detail === 'string' ? payload.detail : `HTTP ${response.status}`;
    throw new CliError(message, { status: response.status, payload });
  }
  return payload;
}

function baseUrl(parsed) {
  const raw = parsed.options.url || process.env.GFY_URL || process.env.GFY_API_BASE_URL || defaultUrl;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CliError('GFY_URL must be http or https');
  return url;
}

async function authorizationHeader(parsed) {
  const tokenFile = parsed.options['token-file'] || process.env.GFY_ACCESS_JWT_FILE;
  if (!tokenFile) return null;
  const path = resolve(tokenFile);
  const metadata = await stat(path);
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw new CliError(`token file must be mode 0600: ${path}`);
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (!token) throw new CliError(`token file is empty: ${path}`);
  return token.startsWith('Bearer ') ? token : 'Bearer ' + token;
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--wait') {
      options.wait = true;
      continue;
    }
    if (arg === '--no-wait') {
      options.wait = false;
      options['no-wait'] = true;
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals > 2) {
      options[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { options, positionals };
}

function generatedOperationId(operation) {
  return `gfy-local-${operation}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function runIdentifier(payload) {
  return payload.run_id || payload.runId || payload.id || null;
}

function assertRunStatusKnown(payload, label) {
  if (!payload || typeof payload.status !== 'string' || payload.status.length === 0) {
    throw new CliError(`${label} returned no status`);
  }
}

function normalizedStatus(payload) {
  return String(payload?.status || '').toLowerCase();
}

function isTerminalRun(payload) {
  return terminalStatuses.has(normalizedStatus(payload));
}

function markRunExitStatus(payload) {
  const status = normalizedStatus(payload);
  const raw = payload?.exit_code ?? payload?.exitCode;
  const exitCode = raw === null || raw === undefined ? null : Number(raw);
  if (Number.isInteger(exitCode) && exitCode !== 0) {
    process.exitCode = exitCode;
    return;
  }
  if (unsuccessfulStatuses.has(status)) process.exitCode = 1;
}

function stateVersionCommit(payload) {
  return payload.state_version_commit || payload.stateVersionCommit || payload.state_version || payload.stateVersion || null;
}

function logPathEntries(payload) {
  const value = payload.log_paths ?? payload.logPaths ?? payload.logpaths ?? payload.logs;
  if (Array.isArray(value)) {
    return value.filter(path => typeof path === 'string' && path.length > 0).map(path => ({ name: path, path }));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([, path]) => typeof path === 'string' && path.length > 0)
      .map(([name, path]) => ({ name, path }));
  }
  return [];
}

async function readStateText(parsed, versionCommit, path, maxBytes) {
  const tenantId = parsed.options['tenant-id'] || process.env.GFY_TENANT_ID || 'local';
  const repositoryId = parsed.options['repository-id'] || process.env.GFY_REPOSITORY_ID || 'gitfoundry';
  const query = new URLSearchParams({ version: versionCommit, tree: 'state', path });
  const payload = await requestJson(parsed, 'GET', `/api/v2/tenants/${encodeURIComponent(tenantId)}/repositories/${encodeURIComponent(repositoryId)}/forge/files?${query}`);
  const encoded = payload.content ?? payload.content_base64;
  if (typeof encoded !== 'string') throw new CliError(`forge.read returned no content for ${path}`);
  const decoded = Buffer.from(encoded, payload.encoding === 'utf8' ? 'utf8' : 'base64').toString('utf8');
  return decoded.length > maxBytes ? decoded.slice(0, maxBytes) : decoded;
}

function positiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new CliError(`${name} must be a positive integer`);
  return value;
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function fail(message) {
  throw new CliError(message);
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function printHelp() {
  process.stdout.write(`gfy local - local GitFoundry self-hosting commands

Usage:
  gfy local serve [--port 4179] [--data PATH]
  gfy local import --source-path PATH [--tenant-id local] [--repository-id gitfoundry]
  gfy local snapshot --source-path PATH --version-commit SHA [--operation-id ID]
  gfy local run --version-commit SHA --argv-json '["cmd","arg"]' [--no-wait]
  gfy local deploy --version-commit SHA --expected-head SHA --source-revision SHA --operation-id ID --deploy-config PATH
  gfy local status RUN_ID
  gfy local logs RUN_ID

Options:
  --url URL              Local API base URL. Defaults to GFY_URL or ${defaultUrl}.
  --token-file PATH      Optional caller JWT file. The file must be mode 0600.
  --tenant-id ID         Defaults to GFY_TENANT_ID or local.
  --repository-id ID     Defaults to GFY_REPOSITORY_ID or gitfoundry.
  --operation-id ID      Optional idempotency key. A unique value is generated when omitted.
  --poll-interval-ms N   Poll interval for local run. Defaults to 1000.
  --timeout-ms N         Positive wait timeout for local run. No timeout by default.
  --no-wait              Return the initial run receipt without waiting.
  --max-bytes N          Maximum bytes per persisted log in local logs. Defaults to 65536.
`);
}

class CliError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'CliError';
    this.details = details;
  }
}

main().catch(error => {
  const message = error instanceof CliError ? error.message : (error && error.stack) || String(error);
  process.stderr.write(message + '\n');
  process.exit(1);
});
