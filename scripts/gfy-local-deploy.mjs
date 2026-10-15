#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultUrl = 'http://127.0.0.1:4179';
const shaPattern = /^[0-9a-f]{40}$/;
const safeIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const deployEntrypoint = `
(async () => {
  process.env.GFY_SOURCE_REVISION = process.argv[1];
  process.env.GFY_DEPLOY_CONFIG_FILE = process.argv[2];
  const { createNativeForgeClient, deployPublishedLocalCandidate } = await import('./scripts/gfy-local-deploy.mjs');
  const input = JSON.parse(process.argv[3]);
  const forge = createNativeForgeClient(input);
  await deployPublishedLocalCandidate({ ...input, forge, env: process.env });
})().catch(error => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
`.trim();

export async function main(argv = process.argv.slice(2), ports = {}) {
  const parsed = parseArgs(argv);
  if (parsed.options.help || parsed.options.h) {
    printHelp();
    return;
  }
  const result = await localDeploy(parsed, ports);
  if (ports.print !== false) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

export async function localDeploy(parsed, ports = {}) {
  const tenantId = parsed.options['tenant-id'] || process.env.GFY_TENANT_ID || 'local';
  const repositoryId = parsed.options['repository-id'] || process.env.GFY_REPOSITORY_ID || 'gitfoundry';
  const expectedHead = requiredSha(parsed, 'expected-head', 'local deploy requires --expected-head');
  const versionCommit = requiredSha(parsed, 'version-commit', 'local deploy requires --version-commit');
  const sourceRevision = requiredSha(parsed, 'source-revision', 'local deploy requires --source-revision');
  const operationId = requiredSafeId(parsed, 'operation-id', 'local deploy requires --operation-id');
  const deployConfigFile = requiredOption(parsed, 'deploy-config', 'local deploy requires --deploy-config');
  await requireMode0600(resolve(deployConfigFile), 'deployment config');

  const forge = ports.forge ?? createNativeForgeClient({
    gfyBin: parsed.options['gfy-bin'] || process.env.GFY_NATIVE_GFY || process.env.GFY_BIN || 'gfy',
    url: parsed.options.url || process.env.GFY_URL || defaultUrl,
    tokenFile: parsed.options['token-file'] || process.env.GFY_ACCESS_JWT_FILE,
    tenantId,
    run: ports.runNative,
  });

  const candidate = await verifyCandidateForPublication({ forge, tenantId, repositoryId, expectedHead, versionCommit, sourceRevision });
  const publish = ports.publish ?? (() => forge.publish({ tenantId, repositoryId, expectedHead, versionCommit, operationId: derivedOperationId(operationId, 'publish') }));
  const published = await publish();
  const admission = createPublishedHeadAdmission({ forge, tenantId, repositoryId, expectedVersionCommit: versionCommit, expectedCodeCommit: sourceRevision });
  const admitted = await admission();

  const run = ports.startDeployRun ?? ((input) => startDeployRun({
    ...input,
    gfyBin: parsed.options['gfy-bin'] || process.env.GFY_NATIVE_GFY || process.env.GFY_BIN || 'gfy',
    localGfy: parsed.options['local-gfy'] || process.env.GFY_LOCAL_GFY || resolve(root, 'scripts/gfy-local.mjs'),
    url: parsed.options.url || process.env.GFY_URL || defaultUrl,
    tokenFile: parsed.options['token-file'] || process.env.GFY_ACCESS_JWT_FILE,
    pollIntervalMs: parsed.options['poll-interval-ms'],
    timeoutMs: parsed.options['timeout-ms'],
    noWait: parsed.options.wait === false || parsed.options['no-wait'] === true,
    runCommand: ports.runCommand,
  }));

  const runner = await run({ tenantId, repositoryId, versionCommit, sourceRevision, deployConfigFile: resolve(deployConfigFile), operationId: derivedOperationId(operationId, 'deploy') });
  return { status: 'submitted', tenant_id: tenantId, repository_id: repositoryId, expected_head: expectedHead, version_commit: versionCommit, source_revision: sourceRevision, candidate, publish: normalizeForgeVersion(published), admission: admitted, runner };
}

export async function verifyCandidateForPublication({ forge, tenantId, repositoryId, expectedHead, versionCommit, sourceRevision }) {
  const head = normalizeForgeVersion(await forge.head({ tenantId, repositoryId }));
  if (head.version_commit !== expectedHead) throw new CliError(`forge head moved: expected ${expectedHead}, got ${head.version_commit || 'none'}`);
  const candidate = normalizeForgeVersion(await forge.view({ tenantId, repositoryId, versionCommit }));
  if (candidate.version_commit !== versionCommit) throw new CliError('candidate version readback mismatch');
  if (candidate.code_commit !== sourceRevision) throw new CliError(`candidate source mismatch: expected ${sourceRevision}, got ${candidate.code_commit || 'none'}`);
  return candidate;
}

export function createPublishedHeadAdmission({ forge, tenantId, repositoryId, expectedVersionCommit, expectedCodeCommit }) {
  return async function publishedHeadAdmission() {
    const head = normalizeForgeVersion(await forge.head({ tenantId, repositoryId }));
    if (head.version_commit !== expectedVersionCommit) throw new CliError(`published forge head changed: expected ${expectedVersionCommit}, got ${head.version_commit || 'none'}`);
    if (head.code_commit !== expectedCodeCommit) throw new CliError(`published source changed: expected ${expectedCodeCommit}, got ${head.code_commit || 'none'}`);
    return { version_commit: head.version_commit, code_commit: head.code_commit };
  };
}

export async function deployPublishedLocalCandidate({ forge, tenantId, repositoryId, expectedVersionCommit, expectedCodeCommit, env }, ports = {}) {
  const admission = createPublishedHeadAdmission({ forge, tenantId, repositoryId, expectedVersionCommit, expectedCodeCommit });
  await admission();
  const deploy = ports.deploy ?? (await import('./gfy-cloudflare-deploy.mjs')).deploy;
  return await deploy(env, { finalDeployAdmission: admission });
}

export function createNativeForgeClient({ gfyBin, url, tokenFile, tenantId, run = runNativeCommand }) {
  if (!tokenFile) throw new CliError('local deploy requires --token-file or GFY_ACCESS_JWT_FILE');
  const env = { ...process.env, GFY_API_BASE_URL: url, GFY_TENANT_ID: tenantId, GFY_ACCESS_JWT_FILE: tokenFile };
  const call = async (args) => parseJson(await run(gfyBin, [...args, '--format', 'json'], { cwd: root, env }));
  return {
    head: ({ repositoryId }) => call(['forge', 'head', '--repository-id', repositoryId]),
    view: ({ repositoryId, versionCommit }) => call(['forge', 'view', '--repository-id', repositoryId, '--version-commit', versionCommit]),
    publish: ({ repositoryId, expectedHead, versionCommit, operationId }) => call(['forge', 'publish', '--repository-id', repositoryId, '--expected-head', expectedHead, '--new-version', versionCommit, '--idempotency-key', operationId]),
  };
}

export async function startDeployRun({ gfyBin = 'gfy', localGfy, url, tokenFile, tenantId, repositoryId, versionCommit, sourceRevision, deployConfigFile, operationId, pollIntervalMs, timeoutMs, noWait, runCommand = runNativeCommand }) {
  const env = { ...process.env };
  if (!tokenFile) throw new CliError('local deploy requires a local owner token file');
  const admission = { gfyBin, url, tokenFile, tenantId, repositoryId, expectedVersionCommit: versionCommit, expectedCodeCommit: sourceRevision };
  const command = ['node', '-e', deployEntrypoint, sourceRevision, deployConfigFile, JSON.stringify(admission)];
  const args = ['local', 'run', '--url', url, '--tenant-id', tenantId, '--repository-id', repositoryId, '--version-commit', versionCommit, '--operation-id', operationId, '--argv-json', JSON.stringify(command)];
  if (tokenFile) args.push('--token-file', tokenFile);
  if (pollIntervalMs) args.push('--poll-interval-ms', String(pollIntervalMs));
  if (timeoutMs) args.push('--timeout-ms', String(timeoutMs));
  if (noWait) args.push('--no-wait');
  const output = await runCommand(process.execPath, [localGfy, ...args], { cwd: root, env });
  return parseJson(output);
}

export function normalizeForgeVersion(payload) {
  const value = payload?.version ?? payload;
  const descriptor = value?.descriptor ?? value;
  return {
    version_commit: value?.version_commit ?? value?.versionCommit ?? descriptor?.version_commit ?? descriptor?.versionCommit ?? null,
    code_commit: descriptor?.code_commit ?? descriptor?.codeCommit ?? value?.code_commit ?? value?.codeCommit ?? null,
  };
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--no-wait') { options.wait = false; options['no-wait'] = true; continue; }
    const equals = arg.indexOf('=');
    if (equals > 2) { options[arg.slice(2, equals)] = arg.slice(equals + 1); continue; }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(`${arg} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { options, positionals };
}

function requiredOption(parsed, name, message) {
  return parsed.options[name] || fail(message);
}

function requiredSha(parsed, name, message) {
  const value = requiredOption(parsed, name, message);
  if (!shaPattern.test(value)) throw new CliError(`--${name} must be a 40 character lowercase hex commit`);
  return value;
}

function requiredSafeId(parsed, name, message) {
  const value = requiredOption(parsed, name, message);
  if (!safeIdPattern.test(value)) throw new CliError(`--${name} must match ${safeIdPattern}`);
  return value;
}

function derivedOperationId(base, suffix) {
  const value = `${base}.${suffix}`;
  if (!safeIdPattern.test(value)) throw new CliError(`derived operation id is invalid or too long: ${value}`);
  return value;
}

async function requireMode0600(path, label) {
  const metadata = await stat(path);
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) throw new CliError(`${label} must be mode 0600: ${path}`);
}

async function runNativeCommand(executable, args, { cwd, env }) {
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.on('error', rejectCommand);
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) resolveCommand(stdout);
      else rejectCommand(new CliError(stderr.trim() || `command failed: ${executable} ${args.join(' ')}`));
    });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch (error) { throw new CliError(`command returned invalid JSON: ${error.message}`); }
}

function fail(message) {
  throw new CliError(message);
}

function printHelp() {
  process.stdout.write(`gfy local deploy - publish a verified local candidate and submit the deploy runner command

Usage:
  gfy local deploy --version-commit SHA --expected-head SHA --source-revision SHA --operation-id ID --deploy-config PATH

Options:
  --url URL              Local API base URL. Defaults to GFY_URL or ${defaultUrl}.
  --token-file PATH      Local owner JWT file. The file must be mode 0600.
  --tenant-id ID         Defaults to GFY_TENANT_ID or local.
  --repository-id ID     Defaults to GFY_REPOSITORY_ID or gitfoundry.
  --gfy-bin PATH         Native gfy binary used for forge read and publish.
  --deploy-config PATH   Private deployment config file. The file must be mode 0600.
  --operation-id ID      Idempotency base for publish and deploy run records.
  --no-wait              Submit the local runner deploy command without waiting.
`);
}

export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(((error && error.stack) || String(error)) + '\n');
    process.exit(1);
  });
}
