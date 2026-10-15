import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile, chmod, rename, symlink } from 'node:fs/promises';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultTenantId = 'local';
const defaultRepositoryId = 'gitfoundry';
const localOwnerActor = { id: 'local-owner', kind: 'human' };
const localRunnerActor = { id: 'local-check-runner', kind: 'service' };
const maxBodyBytes = 1024 * 1024;
const maxFiles = 4096;
const maxFileBytes = 8 * 1024 * 1024;
const maxLogBytes = 256 * 1024;
const maxMaterializedFileBytes = 256 * 1024 * 1024;
const maxMaterializedWorkspaceBytes = 512 * 1024 * 1024;
const defaultTimeoutMs = 30 * 60 * 1000;
const safeIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const excludedDirectoryNames = new Set(['.git', '.local', 'node_modules', 'target', 'dist', '.alchemy', '.tmp', '.cache', 'cache', 'generated-cache', 'generatedcache', 'artifacts', 'output', 'scratch', 'credentials', 'keyfiles', 'logs', 'browser-profiles', 'browserprofiles', '.browser-profiles', '.playwright', 'playwright-report']);
const excludedFileNames = new Set(['.env', '.env.local', '.env.production', 'credentials.json', 'credentials.yml', 'credentials.yaml']);
const excludedFileSuffixes = ['.log', '.tsbuildinfo', '.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.jks'];
const unsupportedPortFeatures = [];
const forwardedRuntimeEnvironmentNames = ['RUSTUP_HOME', 'CARGO_HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'PNPM_STORE_DIR', 'CHROME_BIN'];

export function makeLocalForgeRunner(options) {
  const root = resolve(String(options?.root ?? process.cwd()));
  const dataRoot = resolve(String(options?.dataRoot ?? join(root, '.gitfoundry-local')));
  if (!options?.gitForRepository) throw new Error('gitForRepository is required');
  if (!options?.forgeForRepository) throw new Error('forgeForRepository is required');
  const activeRuns = new Map();

  async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/_local/import') return await importSource(request);
      if (request.method === 'POST' && url.pathname === '/_local/snapshot') return await snapshotSource(request);
      if (request.method === 'POST' && url.pathname === '/_local/runs') return await createRun(request);
      const runMatch = /^\/_local\/runs\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && runMatch) return await getRun(request, decodeURIComponent(runMatch[1] ?? ''));
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      console.error('GitFoundry local operation failed: ' + String(error?.name || 'Error') + ': ' + String(error?.message || error));
      return errorResponse(error);
    }
  }

  async function importSource(request) {
    const body = await readJsonBody(request);
    const scope = readScope(body);
    const operationId = requireSafeId(body.operation_id, 'operation_id');
    const sourcePath = resolveSourcePath(body.source_path);
    if (scope.repository_id === defaultRepositoryId && sourcePath !== root) throw httpError(400, 'source_path_must_be_repository_root', { real_path: sourcePath, expected_path: root });
    const [forge, git] = await Promise.all([resolveRepository(options.forgeForRepository, scope), resolveRepository(options.gitForRepository, scope)]);
    const initialBase = await initialCodeForRepository(options, scope);
    const baseEntries = initialBase ? await codeEntries(git, initialBase) : undefined;
    const inventory = await inventorySource(sourcePath, { baseEntries });
    const requestDigest = importRequestDigest(sourcePath, inventory, initialBase);
    const existing = await findImportRecord(forge, operationId);
    if (existing) {
      if (existing.record.request_digest !== requestDigest) return json({ error: 'idempotency_conflict' }, 409);
      return json({ status: 'imported', tenant_id: scope.tenant_id, repository_id: scope.repository_id, version_commit: existing.version.version_commit, version: existing.version, file_count: existing.record.files?.length ?? inventory.files.length, change_count: inventory.changes.length, duplicate: true, unsupported: existing.record.unsupported ?? unsupportedPortFeatures });
    }
    let version;
    if (initialBase) {
      const changes = await sourceChangesAgainstBase(git, initialBase, inventory);
      const codeCommit = changes.length === 0 ? initialBase : await git.writeCommit({ base: initialBase, parents: [initialBase], changes, message: 'local import source snapshot', author: { name: 'local-owner', email: 'local-owner@gitfoundry.local' }, timestamp: nowIso() });
      const initialState = [
        ...(await initialStateForRepository(options, { scope, code_commit: codeCommit, git, source_path: sourcePath, inventory })),
        ...importStateChanges(operationId, sourcePath, inventory, initialBase, requestDigest)
      ];
      version = await forge.initialize({ operation_id: operationId, code_commit: codeCommit, initial_state: initialState, actor: localOwnerActor });
    } else {
      const initialCode = inventory.changes.length > 0 ? inventory.changes : [{ path: '.gitfoundry/source-empty.txt', content_base64: base64Text('empty source import\n') }];
      const initialState = [
        ...(await initialStateForRepository(options, { scope, code_commit: null, git, source_path: sourcePath, inventory })),
        ...importStateChanges(operationId, sourcePath, inventory, initialBase, requestDigest)
      ];
      version = await forge.initialize({ operation_id: operationId, initial_code: initialCode, initial_state: initialState, actor: localOwnerActor });
    }
    return json({ status: 'imported', tenant_id: scope.tenant_id, repository_id: scope.repository_id, version_commit: version.version_commit, version, file_count: inventory.files.length, change_count: inventory.changes.length, unsupported: unsupportedPortFeatures });
  }

  async function snapshotSource(request) {
    const body = await readJsonBody(request);
    const scope = readScope(body);
    const operationId = requireSafeId(body.operation_id, 'operation_id');
    if (body.parent_version !== undefined && body.version_commit !== undefined && body.parent_version !== body.version_commit) throw httpError(400, 'parent_version_ambiguous');
    const parentVersion = requireSha(body.parent_version ?? body.version_commit, 'version_commit');
    const sourcePath = resolveSourcePath(body.source_path);
    if (scope.repository_id === defaultRepositoryId && sourcePath !== root) throw httpError(400, 'source_path_must_be_repository_root', { real_path: sourcePath, expected_path: root });
    const [forge, git] = await Promise.all([resolveRepository(options.forgeForRepository, scope), resolveRepository(options.gitForRepository, scope)]);
    const parent = await forge.read(parentVersion, localOwnerActor);
    const baseEntries = await codeEntries(git, parent.descriptor.code_commit);
    const inventory = await inventorySource(sourcePath, { baseEntries });
    const current = new Map(inventory.changes.map((change) => [change.path, change]));
    const present = inventory.presentPaths;
    const changes = [];
    const codeChanges = await sourceChangesAgainstBase(git, parent.descriptor.code_commit, inventory);
    for (const change of codeChanges) changes.push({ tree: 'code', ...change });
    changes.push(...snapshotStateChanges(operationId, parentVersion, sourcePath, inventory));
    const version = await forge.commit({ operation_id: operationId, parent_version: parentVersion, changes, actor: localOwnerActor });
    return json({ status: 'snapshot', tenant_id: scope.tenant_id, repository_id: scope.repository_id, version_commit: version.version_commit, version, file_count: inventory.files.length, change_count: inventory.changes.length, unsupported: unsupportedPortFeatures });
  }

  async function createRun(request) {
    const body = await readJsonBody(request);
    const scope = readScope(body);
    const operationId = requireSafeId(body.operation_id, 'operation_id');
    const versionCommit = requireSha(body.version_commit, 'version_commit');
    const command = requireCommand(body.command);
    const timeoutMs = readTimeout(body.timeout_ms);
    const requestDigest = digest({ scope, operation_id: operationId, version_commit: versionCommit, command, timeout_ms: timeoutMs });
    const forge = await resolveRepository(options.forgeForRepository, scope);
    const existing = await findRunRecord(forge, operationId);
    if (existing) {
      if (existing.record.request_digest !== requestDigest) return json({ error: 'idempotency_conflict' }, 409);
      return json(runSummary(existing.record, activeRuns.has(operationId)), 202);
    }
    const parent = await forge.read(versionCommit, localRunnerActor);
    const pendingRecord = {
      schema_version: 1,
      kind: 'local_command_run',
      status: 'pending',
      run_id: operationId,
      operation_id: operationId,
      request_digest: requestDigest,
      tenant_id: scope.tenant_id,
      repository_id: scope.repository_id,
      version_commit: versionCommit,
      code_commit: parent.descriptor.code_commit,
      command,
      timeout_ms: timeoutMs,
      created_at: nowIso(),
      updated_at: nowIso(),
      log_paths: runLogPaths(operationId),
      forwarded_env_names: forwardedRuntimeEnvNames(),
      unsupported: unsupportedPortFeatures,
      result_note: 'local runner records command output only; it does not publish the candidate or claim a signed check'
    };
    const pendingVersion = await forge.commit({ operation_id: derivedOperationId(operationId, 'pending'), parent_version: versionCommit, changes: [{ tree: 'state', path: runRecordPath(operationId), content_base64: base64Json(pendingRecord) }], actor: localRunnerActor });
    const runState = { phase: 'queued', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), updated_at: nowIso() };
    activeRuns.set(operationId, runState);
    const runPromise = executeRun({ scope, forge, gitProvider: options.gitForRepository, gitDirProvider: options.gitDirForRepository, signRunEvidence: options.signRunEvidence, runId: operationId, pendingVersion, pendingRecord, runState }).catch(error => {
      updateRunPhase(runState, 'interrupted');
      console.error(JSON.stringify({ event: 'gitfoundry.local.run.finalization_failed', run_id: operationId, error: String(error?.message ?? error) }));
    }).finally(() => activeRuns.delete(operationId));
    runState.promise = runPromise;
    return json(runSummary({ ...pendingRecord, state_version_commit: pendingVersion.version_commit }, true), 202);
  }

  async function getRun(request, runId) {
    const url = new URL(request.url);
    const body = { tenant_id: url.searchParams.get('tenant_id') ?? defaultTenantId, repository_id: url.searchParams.get('repository_id') ?? defaultRepositoryId };
    const scope = readScope(body);
    const forge = await resolveRepository(options.forgeForRepository, scope);
    const activeBefore = activeRuns.get(runId);
    let found = await findRunRecord(forge, requireSafeId(runId, 'run_id'));
    if (!found) return json({ error: 'not_found' }, 404);
    const active = activeRuns.get(runId);
    if (found.record.status === 'pending' && activeBefore && !active) found = await findRunRecord(forge, runId) ?? found;
    return json(runSummary(found.record, Boolean(active), active));
  }

  async function executeRun(input) {
    const workRoot = join(dataRoot, 'runs', input.runId);
    const workDir = join(workRoot, 'work');
    const homeRoot = process.env.GFY_LOCAL_TEMP_ROOT || (process.platform === 'darwin' ? join(homedir(), '.cache', 'gfy') : join(dataRoot, 'temporary-homes'));
    await mkdir(homeRoot, { recursive: true });
    const homeDir = await mkdtemp(join(homeRoot, 'gfy-run-'));
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let status = 'finished';
    let exitCode = null;
    let signal = null;
    let timedOut = false;
    let git = null;
    try {
      updateRunPhase(input.runState, 'preparing_workspace');
      await rm(workRoot, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await prepareDockerPlugin(homeDir);
      git = await resolveRepository(input.gitProvider, input.scope);
      const gitDir = await resolveOptionalGitDir(input.gitDirProvider, input.scope);
      updateRunPhase(input.runState, gitDir ? 'materializing_from_gitdir' : 'materializing_from_port');
      await materializeCodeTree({ git, gitDir, codeCommit: input.pendingRecord.code_commit, workDir });
      updateRunPhase(input.runState, 'running_command');
      const result = await runCommand({ command: input.pendingRecord.command, cwd: workDir, home: homeDir, timeoutMs: input.pendingRecord.timeout_ms, runState: input.runState });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
      signal = result.signal;
      timedOut = result.timedOut;
      status = result.timedOut || result.signal ? 'interrupted' : 'finished';
      updateRunPhase(input.runState, status);
    } catch (error) {
      status = 'interrupted';
      stderr = limitBuffer(Buffer.from(String(error?.message ?? error), 'utf8'), maxLogBytes);
      updateRunPhase(input.runState, status);
      appendRunStderr(input.runState, stderr);
    }
    const finishedRecord = {
      ...input.pendingRecord,
      status,
      exit_code: exitCode,
      signal,
      timed_out: timedOut,
      updated_at: nowIso(),
      log_paths: runLogPaths(input.runId),
      stdout_bytes: stdout.byteLength,
      stderr_bytes: stderr.byteLength,
      state_version_commit: input.pendingVersion.version_commit,
      result_note: 'local runner result is evidence only; publication and signed checks require a separate verifier'
    };
    const parent = await input.forge.read(input.pendingVersion.version_commit, localRunnerActor);
    const evidenceChanges = await signedRunEvidenceChanges(input.signRunEvidence, { record: finishedRecord, parent, git });
    const finalVersion = await input.forge.commit({
      operation_id: derivedOperationId(input.runId, status),
      parent_version: input.pendingVersion.version_commit,
      changes: [
        { tree: 'state', path: runRecordPath(input.runId), content_base64: base64Json(finishedRecord) },
        { tree: 'state', path: runLogPaths(input.runId).stdout, content_base64: stdout.toString('base64') },
        { tree: 'state', path: runLogPaths(input.runId).stderr, content_base64: stderr.toString('base64') },
        ...evidenceChanges
      ],
      actor: localRunnerActor
    });
    return { ...finishedRecord, state_version_commit: finalVersion.version_commit };
  }
  function resolveSourcePath(value) {
    const requested = value === undefined || value === null || value === '' ? root : value;
    if (typeof requested !== 'string' || requested.includes('\0')) throw httpError(400, 'source_path_invalid');
    const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (candidate !== root && !candidate.startsWith(prefix)) throw httpError(400, 'source_path_outside_root');
    return candidate;
  }

  return { handle };
}

async function readJsonBody(request) {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBodyBytes) throw httpError(413, 'body_too_large');
    chunks.push(next.value);
  }
  if (size === 0) return {};
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(parsed)) throw new Error('body must be object');
    return parsed;
  } catch {
    throw httpError(400, 'body_invalid');
  }
}

function readScope(body) {
  return {
    tenant_id: requireSafeId(body.tenant_id ?? defaultTenantId, 'tenant_id'),
    repository_id: requireSafeId(body.repository_id ?? defaultRepositoryId, 'repository_id')
  };
}

async function inventorySource(sourcePath, options = {}) {
  const rootStat = await stat(sourcePath).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) throw httpError(400, 'source_path_invalid', { real_path: sourcePath });
  const baseEntries = options.baseEntries instanceof Map ? options.baseEntries : new Map();
  const changes = [];
  const files = [];
  const presentPaths = new Set();
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = toForgePath(relative(sourcePath, absolute));
      if (isExcludedDirectory(entry.name, rel)) continue;
      if (entry.isDirectory()) {
        if (isExcludedDirectory(entry.name, rel)) continue;
        await walk(absolute);
        continue;
      }
      if (isExcludedDirectory(entry.name, rel) || isExcludedFile(entry.name, rel)) continue;
      if (!isForgePath(rel)) continue;
      if (files.length >= maxFiles) throw httpError(413, 'source_file_count_exceeded', { real_path: absolute, path: rel, limit: maxFiles });
      presentPaths.add(rel);
      if (entry.isSymbolicLink()) {
        const linkTarget = await readlink(absolute);
        if (linkTarget.includes('\0')) throw httpError(400, 'source_symlink_invalid', { real_path: absolute, path: rel });
        const bytes = Buffer.from(linkTarget, 'utf8');
        const metadata = { path: rel, size: bytes.byteLength, executable: false, mode: '120000', sha256: digestBytes(bytes) };
        changes.push({ path: rel, content_base64: bytes.toString('base64'), mode: '120000' });
        files.push(metadata);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolute);
      const executable = Boolean(info.mode & fsConstants.S_IXUSR);
      const mode = executable ? '100755' : '100644';
      const metadata = { path: rel, size: info.size, executable, mode };
      if (info.size > maxFileBytes) {
        const hashes = await sourceHashes(absolute, info.size);
        const baseEntry = baseEntries.get(rel);
        if (baseEntry?.oid === hashes.oid && baseEntry?.mode === mode) {
          files.push({ ...metadata, ...hashes, reused_from_base: true });
          continue;
        }
        throw httpError(413, 'source_file_too_large', { real_path: absolute, path: rel, size: info.size, limit: maxFileBytes });
      }
      const bytes = await readFile(absolute);
      const hashes = sourceHashesFromBytes(bytes);
      changes.push({ path: rel, content_base64: bytes.toString('base64'), mode, oid: hashes.oid });
      files.push({ ...metadata, ...hashes });
    }
  }
  await walk(sourcePath);
  return { changes, files, presentPaths, excluded: exclusionSummary(), unsupported: unsupportedPortFeatures };
}

function sourceHashes(path, size) {
  return new Promise((resolveHash, rejectHash) => {
    const objectHash = createHash('sha1');
    const contentHash = createHash('sha256');
    objectHash.update(`blob ${size}\0`);
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      objectHash.update(chunk);
      contentHash.update(chunk);
    });
    stream.on('error', rejectHash);
    stream.on('end', () => resolveHash({ oid: objectHash.digest('hex'), sha256: 'sha256:' + contentHash.digest('hex') }));
  });
}

function importRequestDigest(sourcePath, inventory, initialBase) {
  return digest({
    source_path: sourcePath,
    mirrored_base_code_commit: initialBase ?? null,
    files: inventory.files.map((file) => ({ path: file.path, size: file.size, executable: file.executable, mode: file.mode, sha256: file.sha256 }))
  });
}

function importStateChanges(operationId, sourcePath, inventory, initialBase, requestDigest) {
  return [
    { path: 'local/config.json', content_base64: base64Json({ schema_version: 1, local_runner: true, workflows: [], note: 'Commands are supplied per run; no workflow is hardcoded here' }) },
    { path: 'local/checks.json', content_base64: base64Json({ schema_version: 1, checks: [], note: 'Local runner results are not signed checks' }) },
    { path: importRecordPath(operationId), content_base64: base64Json({ schema_version: 1, operation_id: operationId, request_digest: requestDigest, source_path: sourcePath, mirrored_base_code_commit: initialBase ?? null, files: inventory.files, excluded: inventory.excluded, unsupported: inventory.unsupported }) }
  ];
}

function snapshotStateChanges(operationId, parentVersion, sourcePath, inventory) {
  return [{ tree: 'state', path: `local/snapshots/${operationId}.json`, content_base64: base64Json({ schema_version: 1, operation_id: operationId, parent_version: parentVersion, source_path: sourcePath, files: inventory.files, excluded: inventory.excluded, unsupported: inventory.unsupported }) }];
}

async function codeEntries(git, codeCommit) {
  const entries = await git.listTree(codeCommit, '');
  return new Map(entries.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry]));
}

async function sourceChangesAgainstBase(git, baseCommit, inventory) {
  const current = new Map(inventory.changes.map((change) => [change.path, change]));
  const present = inventory.presentPaths ?? new Set(current.keys());
  const existing = await codeEntries(git, baseCommit);
  const changes = [];
  for (const change of current.values()) {
    const baseEntry = existing.get(change.path);
    if (baseEntry?.oid === change.oid && baseEntry?.mode === change.mode) continue;
    changes.push(change);
  }
  for (const path of existing.keys()) if (!present.has(path)) changes.push({ path, content_base64: null });
  return changes;
}

async function initialCodeForRepository(options, scope) {
  if (typeof options.initialCodeForRepository !== 'function') return null;
  const value = await options.initialCodeForRepository({ tenantId: scope.tenant_id, repositoryId: scope.repository_id });
  if (value === null || value === undefined || value === '') return null;
  return requireSha(value, 'initial_code_commit');
}

async function initialStateForRepository(options, context) {
  if (typeof options.initialStateForRepository !== 'function') return [];
  const changes = await options.initialStateForRepository({
    tenantId: context.scope.tenant_id,
    repositoryId: context.scope.repository_id,
    code_commit: context.code_commit,
    git: context.git,
    source_path: context.source_path,
    inventory: context.inventory
  });
  if (changes === null || changes === undefined) return [];
  if (!Array.isArray(changes)) throw httpError(500, 'initial_state_callback_invalid');
  return changes.map((change) => normalizeStateChange(change));
}

async function signedRunEvidenceChanges(signer, context) {
  if (typeof signer !== 'function') return [];
  const document = await signer(context);
  if (document === null || document === undefined) return [];
  if (!isRecord(document)) throw httpError(500, 'signed_check_invalid');
  const policyCheckId = requireSafeId(document.policy_check_id ?? document.check_id ?? document.id, 'policy_check_id');
  return [{ tree: 'state', path: `checks/${policyCheckId}.json`, content_base64: base64Json(document) }];
}

function normalizeStateChange(change) {
  if (!isRecord(change)) throw httpError(500, 'state_change_invalid');
  return { path: requireForgePath(change.path, 'state_change_path'), content_base64: requireBase64OrNull(change.content_base64, 'state_change_content') };
}

export async function materializeCodeTree(input) {
  const entries = await input.git.listTree(input.codeCommit, '');
  if (input.gitDir) {
    await materializeCodeTreeFromGitDir({ ...input, entries });
    await materializeGitIdentity(input);
    return;
  }
  return materializeCodeTreeFromPort({ ...input, entries });
}


async function materializeGitIdentity({ workDir, gitDir, codeCommit }) {
  const revision = requireSha(codeCommit, 'code_commit');
  const env = { PATH: process.env.PATH, HOME: workDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const arg of [
    ['init', '--quiet', '--initial-branch=code', workDir],
    ['-C', workDir, '-c', 'core.hooksPath=/dev/null', 'fetch', '--quiet', '--no-tags', '--depth=1', '--', gitDir, revision],
    ['-C', workDir, '-c', 'core.hooksPath=/dev/null', 'reset', '--quiet', '--mixed', revision],
  ]) {
    await new Promise((done, reject) => {
      const child = spawn('git', arg, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code, signal) => code === 0 && !signal ? done() : reject(new Error(stderr.trim() || 'Git revision materialization failed')));
    });
  }
}

async function materializeCodeTreeFromPort(input) {
  for (const entry of input.entries) {
    if (entry.type !== 'blob') throw materializeError('unsupported_tree_entry', entry.path);
    if (entry.mode !== '100644' && entry.mode !== '100755') throw materializeError('unsupported_file_mode', entry.path, { mode: entry.mode });
    const rel = safeTreePath(entry.path);
    const content = await input.git.readFile(input.codeCommit, rel);
    if (content === null) continue;
    const target = resolveInside(input.workDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(content, 'base64'));
    if (entry.mode === '100755') await chmod(target, 0o755).catch(() => undefined);
  }
}

async function materializeCodeTreeFromGitDir(input) {
  const symlinks = [];
  let totalBytes = 0;
  for (const entry of input.entries) {
    if (entry.type !== 'blob') throw materializeError('unsupported_tree_entry', entry.path);
    const rel = safeTreePath(entry.path);
    const target = resolveInside(input.workDir, rel);
    if (entry.mode === '120000') {
      symlinks.push({ entry, rel, target });
      continue;
    }
    if (entry.mode !== '100644' && entry.mode !== '100755') throw materializeError('unsupported_file_mode', rel, { mode: entry.mode });
    totalBytes = assertMaterializedSize(entry, totalBytes, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeGitBlobToFile({ gitDir: input.gitDir, oid: requireOid(entry.oid, rel), target, path: rel, maxBytes: maxMaterializedFileBytes });
    if (entry.mode === '100755') await chmod(target, 0o755).catch(() => undefined);
  }
  for (const item of symlinks) {
    totalBytes = assertMaterializedSize(item.entry, totalBytes, item.rel);
    const linkTarget = (await readGitBlobToBuffer({ gitDir: input.gitDir, oid: requireOid(item.entry.oid, item.rel), path: item.rel, maxBytes: 4096 })).toString('utf8');
    if (linkTarget.includes('\0')) throw materializeError('unsupported_symlink_target', item.rel);
    await mkdir(dirname(item.target), { recursive: true });
    await symlink(linkTarget, item.target);
  }
}

export function runCommand(input) {
  return new Promise((resolveRun) => {
    const child = spawn(input.command[0], input.command.slice(1), {
      cwd: input.cwd,
      shell: false,
      env: minimalEnv(input.home),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let drainTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      resolveRun(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    }, input.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk, maxLogBytes);
      appendRunStdout(input.runState, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk, maxLogBytes);
      appendRunStderr(input.runState, chunk);
    });
    child.on('error', (error) => finish({ stdout, stderr: appendLimited(stderr, Buffer.from(String(error.message), 'utf8'), maxLogBytes), exitCode: null, signal: 'error', timedOut }));
    child.on('exit', (exitCode, signal) => {
      // Descendants can retain inherited pipes after the tracked process exits.
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ stdout, stderr, exitCode, signal, timedOut });
      }, 250);
    });
    child.on('close', (exitCode, signal) => finish({ stdout, stderr, exitCode, signal, timedOut }));
  });
}

async function findImportRecord(forge, operationId) {
  const path = importRecordPath(operationId);
  if (typeof forge.operationVersion === 'function') {
    const version = await forge.operationVersion(operationId, localOwnerActor);
    if (!version) return null;
    const file = await forge.read({ version: version.version_commit, tree: 'state', path, actor: localOwnerActor });
    if (file?.status !== 'file' || typeof file.content_base64 !== 'string') throw new Error('Import operation has no retained record');
    const record = JSON.parse(Buffer.from(file.content_base64, 'base64').toString('utf8'));
    if (record?.operation_id !== operationId) throw new Error('Import operation record does not match its identity');
    return { version, record: { ...record, state_version_commit: version.version_commit } };
  }
  const versions = await forge.list(localOwnerActor);
  for (const version of versions) {
    const file = await forge.read({ version: version.version_commit, tree: 'state', path, actor: localOwnerActor }).catch(() => null);
    if (file?.status === 'file' && typeof file.content_base64 === 'string') {
      const record = JSON.parse(Buffer.from(file.content_base64, 'base64').toString('utf8'));
      if (record?.operation_id === operationId) return { version, record: { ...record, state_version_commit: version.version_commit } };
    }
  }
  return null;
}

async function findRunRecord(forge, runId) {
  const path = runRecordPath(runId);
  if (typeof forge.operationVersion === 'function') {
    for (const status of ['finished', 'interrupted', 'pending']) {
      const version = await forge.operationVersion(derivedOperationId(runId, status), localRunnerActor);
      if (!version) continue;
      const file = await forge.read({ version: version.version_commit, tree: 'state', path, actor: localRunnerActor });
      if (file?.status !== 'file' || typeof file.content_base64 !== 'string') throw new Error('Run operation has no retained record');
      const record = JSON.parse(Buffer.from(file.content_base64, 'base64').toString('utf8'));
      if (record?.run_id !== runId || record.status !== status) throw new Error('Run operation record does not match its identity');
      return { version, record: { ...record, state_version_commit: version.version_commit } };
    }
    return null;
  }
  const versions = await forge.list(localRunnerActor);
  const matches = [];
  for (const version of versions) {
    const file = await forge.read({ version: version.version_commit, tree: 'state', path, actor: localRunnerActor }).catch(() => null);
    if (file?.status === 'file' && typeof file.content_base64 === 'string') {
      const record = JSON.parse(Buffer.from(file.content_base64, 'base64').toString('utf8'));
      if (record?.run_id === runId) matches.push({ version, record: { ...record, state_version_commit: version.version_commit } });
    }
  }
  if (matches.length === 0) return null;
  matches.sort((left, right) => statusRank(right.record.status) - statusRank(left.record.status) || String(right.record.updated_at ?? '').localeCompare(String(left.record.updated_at ?? '')));
  return matches[0];
}

function runSummary(record, active = false, runState = null) {
  const status = record.status === 'pending' && !active ? 'interrupted' : record.status;
  const summary = {
    status,
    run_id: record.run_id,
    operation_id: record.operation_id,
    version_commit: record.version_commit,
    code_commit: record.code_commit,
    state_version_commit: record.state_version_commit,
    exit_code: status === 'finished' ? record.exit_code : null,
    signal: record.signal ?? null,
    timed_out: Boolean(record.timed_out),
    command: record.command,
    log_paths: record.log_paths,
    created_at: record.created_at,
    updated_at: record.updated_at,
    unsupported: record.unsupported ?? unsupportedPortFeatures,
    active
  };
  if (runState) {
    summary.phase = runState.phase;
    summary.live_stdout_tail_base64 = runState.stdout.toString('base64');
    summary.live_stderr_tail_base64 = runState.stderr.toString('base64');
    summary.live_updated_at = runState.updated_at;
  }
  return summary;
}


function statusRank(status) {
  if (status === 'finished') return 3;
  if (status === 'interrupted') return 2;
  if (status === 'pending') return 1;
  return 0;
}

function runRecordPath(runId) {
  return `local/runs/${runId}/run.json`;
}

function runLogPaths(runId) {
  return { stdout: `local/runs/${runId}/stdout.log`, stderr: `local/runs/${runId}/stderr.log` };
}

function importRecordPath(operationId) {
  return `local/imports/${operationId}.json`;
}

async function resolveRepository(accessor, scope) {
  if (typeof accessor === 'function') return accessor({ tenantId: scope.tenant_id, repositoryId: scope.repository_id });
  return accessor;
}

async function resolveOptionalGitDir(accessor, scope) {
  if (typeof accessor !== 'function') return null;
  const value = await accessor({ tenantId: scope.tenant_id, repositoryId: scope.repository_id });
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.includes('\0')) throw httpError(500, 'git_dir_invalid');
  return value;
}



function requireSafeId(value, field) {
  if (typeof value !== 'string' || !safeIdPattern.test(value)) throw httpError(400, `${field}_invalid`);
  return value;
}

function requireSha(value, field) {
  if (typeof value !== 'string' || !shaPattern.test(value) || value === '0'.repeat(40)) throw httpError(400, `${field}_invalid`);
  return value;
}

function requireOid(value, path) {
  if (typeof value !== 'string' || !shaPattern.test(value) || value === '0'.repeat(40)) throw materializeError('object_oid_invalid', path);
  return value;
}



function requireForgePath(value, field) {
  if (!isForgePath(value)) throw httpError(400, `${field}_invalid`);
  return value;
}

function requireBase64OrNull(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string') throw httpError(400, `${field}_invalid`);
  return value;
}

function requireCommand(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw httpError(400, 'command_invalid');
  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 4096 || item.includes('\0')) throw httpError(400, 'command_invalid');
    return item;
  });
}

function readTimeout(value) {
  if (value === undefined) return defaultTimeoutMs;
  if (!Number.isInteger(value) || value < 1 || value > defaultTimeoutMs) throw httpError(400, 'timeout_invalid');
  return value;
}

export async function prepareDockerPlugin(home) {
  const source = process.env.GFY_DOCKER_BUILDX || (process.env.HOME ? join(process.env.HOME, '.docker', 'cli-plugins', 'docker-buildx') : null);
  if (!source) return;
  const metadata = await stat(source).catch(() => null);
  if (!metadata?.isFile()) return;
  const destination = join(home, '.docker', 'cli-plugins');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await symlink(source, join(destination, 'docker-buildx'));
}

function minimalEnv(home) {
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: home, GFY_LOCAL_TEMP_ROOT: dirname(home), CI: '1', GITFOUNDRY_LOCAL_RUNNER: '1' };
  for (const name of forwardedRuntimeEnvironmentNames) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  return env;
}

function forwardedRuntimeEnvNames() {
  return forwardedRuntimeEnvironmentNames.filter((name) => typeof process.env[name] === 'string' && process.env[name].length > 0);
}

function safeTreePath(path) {
  const rel = toForgePath(path);
  if (!isForgePath(rel)) throw materializeError('unsafe_materialized_path', path);
  return rel;
}

function assertMaterializedSize(entry, totalBytes, path) {
  const size = Number.isInteger(entry.size) ? entry.size : 0;
  if (size > maxMaterializedFileBytes) throw materializeError('materialized_file_too_large', path, { size, limit: maxMaterializedFileBytes });
  const next = totalBytes + size;
  if (next > maxMaterializedWorkspaceBytes) throw materializeError('materialized_workspace_too_large', path, { size: next, limit: maxMaterializedWorkspaceBytes });
  return next;
}

function materializeError(code, path, detail = {}) {
  return httpError(500, code, { path, ...detail });
}

function updateRunPhase(runState, phase) {
  if (!runState) return;
  runState.phase = phase;
  runState.updated_at = nowIso();
}

function appendRunStdout(runState, chunk) {
  if (!runState) return;
  runState.stdout = appendLimited(runState.stdout, chunk, maxLogBytes);
  runState.updated_at = nowIso();
}

function appendRunStderr(runState, chunk) {
  if (!runState) return;
  runState.stderr = appendLimited(runState.stderr, chunk, maxLogBytes);
  runState.updated_at = nowIso();
}

function resolveInside(root, rel) {
  const target = resolve(root, rel);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(prefix)) throw new Error(`path escaped root: ${rel}`);
  return target;
}

function toForgePath(value) {
  return value.split(sep).join('/');
}

function isForgePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

function isExcludedDirectory(name, rel) {
  return excludedDirectoryNames.has(name) || excludedDirectoryNames.has(rel);
}

function isExcludedFile(name, rel) {
  const lower = name.toLowerCase();
  if (excludedFileNames.has(name) || excludedFileNames.has(lower)) return true;
  if (excludedFileSuffixes.some((suffix) => lower.endsWith(suffix))) return true;
  return rel.includes('/credentials/') || rel.includes('/keyfiles/') || rel.includes('/logs/');
}

function exclusionSummary() {
  return { directories: [...excludedDirectoryNames].sort(), file_names: [...excludedFileNames].sort(), file_suffixes: excludedFileSuffixes };
}

function appendLimited(existing, chunk, maxBytes) {
  const next = Buffer.concat([existing, Buffer.from(chunk)]);
  return limitBuffer(next, maxBytes);
}

function limitBuffer(buffer, maxBytes) {
  if (buffer.byteLength <= maxBytes) return buffer;
  return buffer.subarray(buffer.byteLength - maxBytes);
}

function base64Text(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function base64Json(value) {
  return base64Text(canonicalJson(value));
}

function digest(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'));
}

function digestBytes(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function sourceHashesFromBytes(bytes) {
  return {
    oid: createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'),
    sha256: digestBytes(bytes)
  };
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    return out;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

function derivedOperationId(base, suffix) {
  const candidate = `${base}.${suffix}`;
  if (candidate.length <= 128 && safeIdPattern.test(candidate)) return candidate;
  return `${base.slice(0, 80)}.${suffix}.${createHash('sha256').update(candidate).digest('hex').slice(0, 24)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function writeGitBlobToFile(input) {
  return new Promise((resolveWrite, rejectWrite) => {
    const temp = `${input.target}.gitfoundry-${process.pid}-${Date.now()}.tmp`;
    const child = spawn('git', ['--git-dir', input.gitDir, 'cat-file', 'blob', input.oid], { shell: false, env: internalGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const file = createWriteStream(temp, { mode: 0o644 });
    let bytes = 0;
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        child.kill('SIGKILL');
        file.destroy();
        await rm(temp, { force: true }).catch(() => undefined);
        rejectWrite(error);
        return;
      }
      try {
        await rename(temp, input.target);
        resolveWrite(bytes);
      } catch (renameError) {
        rejectWrite(renameError);
      }
    };
    child.stdout.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > input.maxBytes) {
        finish(materializeError('materialized_file_too_large', input.path, { size: bytes, limit: input.maxBytes }));
        return;
      }
      if (!file.write(chunk)) child.stdout.pause();
    });
    file.on('drain', () => child.stdout.resume());
    file.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk, maxLogBytes); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      file.end(() => {
        if (code === 0) finish(null);
        else finish(materializeError('git_cat_file_failed', input.path, { exit_code: code, stderr: stderr.toString('utf8') }));
      });
    });
  });
}

function readGitBlobToBuffer(input) {
  return new Promise((resolveRead, rejectRead) => {
    const child = spawn('git', ['--git-dir', input.gitDir, 'cat-file', 'blob', input.oid], { shell: false, env: internalGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) child.kill('SIGKILL');
      error ? rejectRead(error) : resolveRead(value);
    };
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.byteLength > input.maxBytes) finish(materializeError('materialized_file_too_large', input.path, { size: stdout.byteLength, limit: input.maxBytes }));
    });
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk, maxLogBytes); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish(null, stdout);
      else finish(materializeError('git_cat_file_failed', input.path, { exit_code: code, stderr: stderr.toString('utf8') }));
    });
  });
}

function internalGitEnv() {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1' };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value) + '\n', { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function httpError(status, code, detail = {}) {
  const error = new Error(detail.real_path ? `${code}: ${detail.real_path}` : code);
  error.status = status;
  error.code = code;
  error.detail = detail;
  return error;
}

function errorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = typeof error?.code === 'string' ? error.code : status === 500 ? 'local_runner_error' : 'request_invalid';
  const detail = isRecord(error?.detail) ? error.detail : {};
  const body = detail.real_path ? { real_path: detail.real_path, error: code, ...detail } : { error: code, ...detail };
  body.message = status === 500 ? undefined : error.message;
  return json(body, status);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('local-forge-runner exports makeLocalForgeRunner; it is loaded by the GitFoundry local server');
}
