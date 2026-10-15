import {
  ForgeVersionAuthenticationError,
  ForgeVersionNotFoundError,
  ForkForgeIdempotencyConflictError,
  ForkForgeInputError,
  ForkForgeMergeConflictError,
  ForkForgeStaleHeadError,
  ForkForgeUnavailableError,
  assertBase64,
  assertForgeFileMode,
  assertForgePath,
  assertSafeId,
  assertSha40,
  canonicalJson,
  decodeBase64Utf8,
  encodeBase64Utf8,
  forgeDescriptorSchemaVersion,
  parseForgeDescriptorJson,
  safeRefPart,
  semanticDigest,
  type ForgeActor,
  type ForgeFileMode,
  type ForgeTreeKind,
  type ForgeVersion,
  type ForgeVersionDescriptor,
  type ForkForgeChange,
  type ForkForgeConflict
} from "./model.js";
import type { ForgeCommitComparison, ForgeGitPort, ForgeMergeResult, ForgeTreeEntry } from "./port.js";

export interface ForkForgeAuthorizationContext {
  readonly capability: "forge.initialize" | "forge.read" | "forge.fork" | "forge.commit" | "forge.compare" | "forge.merge" | "forge.publish" | "forge.recover";
  readonly actor: ForgeActor;
  readonly version?: ForgeVersion;
}

export interface ForkForgeEvidenceContext {
  readonly actor: ForgeActor;
  readonly expected: ForgeVersion | null;
  readonly candidate: ForgeVersion;
}

export interface ForkForgeServiceInput {
  readonly git: ForgeGitPort;
  readonly tenant_id: string;
  readonly repository_id: string;
  readonly clock: () => string;
  readonly authorize: (context: ForkForgeAuthorizationContext) => Promise<void>;
  readonly verifyEvidence: (context: ForkForgeEvidenceContext) => Promise<void>;
  readonly isPublisherStopped?: (operationId: string) => Promise<boolean>;
}

export interface InitializeFileChange {
  readonly path: string;
  readonly content_base64: string | null;
  readonly mode?: ForgeFileMode;
}

export interface InitializeInput {
  readonly operation_id: string;
  readonly code_commit?: string;
  readonly initial_code?: readonly InitializeFileChange[];
  readonly actor: ForgeActor;
  readonly initial_state?: readonly InitializeFileChange[];
}

export interface ForkInput {
  readonly operation_id: string;
  readonly parent_version: string;
  readonly actor: ForgeActor;
}

export interface CommitInput {
  readonly operation_id: string;
  readonly parent_version: string;
  readonly changes: readonly ForkForgeChange[];
  readonly actor: ForgeActor;
}

export interface AdoptCodeCommitInput {
  readonly operation_id: string;
  readonly parent_version: string;
  readonly expected_parent_code_commit: string;
  readonly code_commit: string;
  readonly changes: readonly ForkForgeChange[];
  readonly actor: ForgeActor;
}

export interface CompareInput {
  readonly base_version: string;
  readonly head_version: string;
  readonly actor?: ForgeActor;
}

export interface MergeInput {
  readonly operation_id: string;
  readonly base_version: string;
  readonly left_version: string;
  readonly right_version: string;
  readonly actor: ForgeActor;
}

export interface PublishInput {
  readonly operation_id: string;
  readonly expected_version: string | null;
  readonly new_version: string;
  readonly actor: ForgeActor;
}

export interface RecoverInput {
  readonly operation_id: string;
  readonly actor: ForgeActor;
}

export type ForkForgeOperationResult =
  | { readonly status: "version"; readonly version: ForgeVersion }
  | { readonly status: "published"; readonly version: ForgeVersion }
  | { readonly status: "conflict"; readonly conflicts: readonly ForkForgeConflict[] }
  | { readonly status: "pending"; readonly operation_id: string; readonly reason: string };

export interface ForkForgeComparison {
  readonly base: ForgeVersion;
  readonly head: ForgeVersion;
  readonly code: ForgeCommitComparison;
  readonly state: ForgeCommitComparison;
}

export interface ReadInput {
  readonly version: string;
  readonly actor?: ForgeActor;
  readonly tree: ForgeTreeKind;
  readonly path?: string;
  readonly prefix?: string;
}

export type ForkForgeReadResult =
  | { readonly status: "file"; readonly version: ForgeVersion; readonly tree: ForgeTreeKind; readonly path: string; readonly content_base64: string | null }
  | { readonly status: "tree"; readonly version: ForgeVersion; readonly tree: ForgeTreeKind; readonly prefix: string; readonly entries: readonly ForgeTreeEntry[] };

export interface ForkForgeRead {
  (versionCommit: string, actor?: ForgeActor): Promise<ForgeVersion>;
  (input: ReadInput): Promise<ForkForgeReadResult>;
}

export interface ForkForgeService {
  readonly initialize: (input: InitializeInput) => Promise<ForgeVersion>;
  readonly head: (actor?: ForgeActor) => Promise<ForgeVersion | null>;
  readonly read: ForkForgeRead;
  readonly list: (actor?: ForgeActor) => Promise<readonly ForgeVersion[]>;
  readonly operationVersion?: (operationId: string, actor?: ForgeActor) => Promise<ForgeVersion | null>;
  readonly fork: (input: ForkInput) => Promise<ForgeVersion>;
  readonly commit: (input: CommitInput) => Promise<ForgeVersion>;
  readonly adoptCodeCommit: (input: AdoptCodeCommitInput) => Promise<ForgeVersion>;
  readonly compare: (input: CompareInput) => Promise<ForkForgeComparison>;
  readonly merge: (input: MergeInput) => Promise<ForkForgeOperationResult>;
  readonly publish: (input: PublishInput) => Promise<ForgeVersion>;
  readonly recover: (input: RecoverInput) => Promise<ForkForgeOperationResult>;
}

const descriptorPath = "forge.json";
const operationPath = "operation.json";
const headRef = "refs/heads/forge-head";
const retainedRootRef = "refs/heads/retained/";
const codeAliasRef = "refs/heads/code";
const stateAliasRef = "refs/heads/forge-state";

interface OperationRecord {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly request_digest: string;
  readonly kind: "initialize" | "fork" | "commit" | "adopt_code_commit" | "merge" | "publish";
  readonly input: unknown;
  readonly status: "intent" | "result";
  readonly timestamp: string;
  readonly result?: ForkForgeOperationResult;
}

interface ReservedOperation {
  readonly requestDigest: string;
  readonly replay?: ForkForgeOperationResult | undefined;
  readonly pending: boolean;
  readonly timestamp: string;
}

interface NormalizedFileChange {
  readonly path: string;
  readonly content_base64: string | null;
  readonly mode?: ForgeFileMode;
}


function operationChanges(record: OperationRecord): readonly NormalizedFileChange[] {
  const files: NormalizedFileChange[] = [];
  const input = { ...(record.input as Record<string, unknown>) };
  for (const field of ["initial_code", "initial_state", "changes"]) {
    const changes = input[field];
    if (!Array.isArray(changes)) continue;
    input[field] = changes.map((change: Record<string, unknown>) => {
      if (typeof change.content_base64 !== "string") return change;
      const { content_base64, ...metadata } = change;
      const content_path = `operation-input/${files.length}.blob`;
      files.push({ path: content_path, content_base64 });
      return { ...metadata, content_path };
    });
  }
  return [{ path: operationPath, content_base64: encodeBase64Utf8(canonicalJson({ ...record, input })) }, ...files];
}

export function makeForgeService(input: ForkForgeServiceInput): ForkForgeService {
  const tenantId = assertSafeId(input.tenant_id, "tenant_id");
  const repositoryId = assertSafeId(input.repository_id, "repository_id");
  const git = input.git;

  async function authorize(capability: ForkForgeAuthorizationContext["capability"], actor: ForgeActor | undefined, version?: ForgeVersion): Promise<void> {
    if (actor) await input.authorize(version ? { capability, actor: normalizeActor(actor), version } : { capability, actor: normalizeActor(actor) });
  }

  async function reserveOperation(kind: OperationRecord["kind"], operationId: string, semanticInput: unknown): Promise<ReservedOperation> {
    const id = assertSafeId(operationId, "operation_id");
    const requestDigest = semanticDigest({ kind, input: semanticInput });
    const result = await readOperation(resultRef(id));
    if (result) {
      if (result.request_digest !== requestDigest) throw new ForkForgeIdempotencyConflictError(`operation ${id} was already used with different input`);
      return { requestDigest, replay: result.result, pending: false, timestamp: result.timestamp };
    }
    const intent = await readOperation(intentRef(id));
    if (intent) {
      if (intent.request_digest !== requestDigest) throw new ForkForgeIdempotencyConflictError(`operation ${id} was already used with different input`);
      return { requestDigest, pending: true, timestamp: intent.timestamp };
    }
    const timestamp = input.clock();
    const record: OperationRecord = { schema_version: 1, operation_id: id, request_digest: requestDigest, kind, input: semanticInput, status: "intent", timestamp };
    const commit = await git.writeCommit({ base: null, parents: [], changes: operationChanges(record), message: `record ${kind} intent ${id}`, author: systemAuthor(), timestamp });
    const stored = await git.compareAndSwapRef(intentRef(id), null, commit);
    if (!stored) return reserveOperation(kind, operationId, semanticInput);
    return { requestDigest, pending: false, timestamp };
  }

  async function writeOperationResultCommit(operationId: string, requestDigest: string, kind: OperationRecord["kind"], semanticInput: unknown, result: ForkForgeOperationResult): Promise<string> {
    const id = assertSafeId(operationId, "operation_id");
    const record: OperationRecord = { schema_version: 1, operation_id: id, request_digest: requestDigest, kind, input: semanticInput, status: "result", timestamp: input.clock(), result };
    return git.writeCommit({ base: null, parents: [], changes: operationChanges(record), message: `record ${kind} result ${id}`, author: systemAuthor(), timestamp: input.clock() });
  }

  async function completeOperation(operationId: string, requestDigest: string, kind: OperationRecord["kind"], semanticInput: unknown, result: ForkForgeOperationResult): Promise<void> {
    const id = assertSafeId(operationId, "operation_id");
    const commit = await writeOperationResultCommit(id, requestDigest, kind, semanticInput, result);
    const stored = await git.compareAndSwapRef(resultRef(id), null, commit);
    if (!stored) {
      const existing = await readOperation(resultRef(id));
      if (!existing || existing.request_digest !== requestDigest) throw new ForkForgeIdempotencyConflictError(`operation ${id} result changed`);
    }
  }

  async function readOperation(ref: string): Promise<OperationRecord | null> {
    const commit = await git.readRef(ref);
    if (!commit) return null;
    const content = await git.readFile(commit, operationPath);
    if (!content) return null;
    return JSON.parse(decodeBase64Utf8(content)) as OperationRecord;
  }

  async function createVersion(params: { operationId: string; requestDigest: string; timestamp: string; actor: ForgeActor; parents: readonly ForgeVersion[]; codeCommit: string; stateCommit: string; message: string }): Promise<ForgeVersion> {
    const actor = normalizeActor(params.actor);
    const forkId = safeRefPart(params.operationId);
    await finishInterruptedRetention(forkId);
    const existing = await readRetainedVersionByForkId(forkId);
    if (existing) {
      if (existing.descriptor.operation_id !== params.operationId || existing.descriptor.request_digest !== params.requestDigest) throw new ForkForgeIdempotencyConflictError(`fork ${forkId} already exists for a different operation`);
      return existing;
    }
    const descriptor: ForgeVersionDescriptor = {
      schema_version: forgeDescriptorSchemaVersion,
      fork_id: forkId,
      tenant_id: tenantId,
      repository_id: repositoryId,
      parents: params.parents.map((parent) => parent.version_commit),
      code_commit: assertSha40(params.codeCommit, "code_commit"),
      state_commit: assertSha40(params.stateCommit, "state_commit"),
      creator_id: actor.id,
      creator_kind: actor.kind,
      operation_id: assertSafeId(params.operationId, "operation_id"),
      request_digest: params.requestDigest
    };
    const versionCommit = await git.writeCommit({ base: descriptor.parents[0] ?? null, parents: descriptor.parents, changes: [{ path: descriptorPath, content_base64: encodeBase64Utf8(canonicalJson(descriptor)) }], message: params.message, author: authorFor(actor), timestamp: params.timestamp });
    const version = { version_commit: assertSha40(versionCommit, "version_commit"), descriptor } satisfies ForgeVersion;
    try {
      await retainVersion(version);
      return version;
    } catch (error) {
      const retained = await readRetainedVersionByForkId(forkId).catch(() => null);
      if (retained && retained.descriptor.operation_id === params.operationId && retained.descriptor.request_digest === params.requestDigest && retained.descriptor.code_commit === descriptor.code_commit && retained.descriptor.state_commit === descriptor.state_commit && sameParents(retained.descriptor.parents, descriptor.parents)) return retained;
      throw error;
    }
  }

  async function readRetainedVersionByForkId(forkId: string): Promise<ForgeVersion | null> {
    const commit = await git.readRef(retainedRef(forkId, "version"));
    return commit ? readVersion(commit) : null;
  }

  // Retained refs are written one at a time. When a write stops after the version ref, the retry of
  // the same operation (its reservation has already rejected different input) finishes the missing
  // code and state refs; a ref that points elsewhere stays fatal.
  async function finishInterruptedRetention(forkId: string): Promise<void> {
    const versionCommit = await git.readRef(retainedRef(forkId, "version"));
    if (!versionCommit) return;
    const content = await git.readFile(versionCommit, descriptorPath);
    if (!content) return;
    const descriptor = parseForgeDescriptorJson(decodeBase64Utf8(content));
    if (descriptor.fork_id !== forkId || descriptor.tenant_id !== tenantId || descriptor.repository_id !== repositoryId) return;
    await retainVersion({ version_commit: versionCommit, descriptor });
  }

  // A version whose code or state ref was never written is still being retained, so a listing leaves it out.
  async function isPartlyRetained(forkId: string): Promise<boolean> {
    const [code, state] = await Promise.all([git.readRef(retainedRef(forkId, "code")), git.readRef(retainedRef(forkId, "state"))]);
    return code === null || state === null;
  }

  async function retainVersion(version: ForgeVersion): Promise<void> {
    await retainSha(retainedRef(version.descriptor.fork_id, "version"), version.version_commit);
    await retainSha(retainedRef(version.descriptor.fork_id, "code"), version.descriptor.code_commit);
    await retainSha(retainedRef(version.descriptor.fork_id, "state"), version.descriptor.state_commit);
  }

  async function retainSha(ref: string, sha: string): Promise<void> {
    const stored = await git.compareAndSwapRef(ref, null, sha);
    if (!stored) {
      const current = await git.readRef(ref);
      if (current !== sha) throw new ForgeVersionAuthenticationError(`retained ref ${ref} points at ${current ?? "null"}`);
    }
  }

  async function readVersion(versionCommit: string): Promise<ForgeVersion> {
    const commit = assertSha40(versionCommit, "version_commit");
    const content = await git.readFile(commit, descriptorPath);
    if (!content) throw new ForgeVersionNotFoundError(`forge descriptor not found at ${commit}`);
    const descriptor = parseForgeDescriptorJson(decodeBase64Utf8(content));
    if (descriptor.tenant_id !== tenantId || descriptor.repository_id !== repositoryId) throw new ForgeVersionAuthenticationError("descriptor belongs to a different repository scope");
    const version: ForgeVersion = { version_commit: commit, descriptor };
    await assertRetained(version);
    return version;
  }

  async function assertRetained(version: ForgeVersion): Promise<void> {
    const versionRef = await git.readRef(retainedRef(version.descriptor.fork_id, "version"));
    const codeRef = await git.readRef(retainedRef(version.descriptor.fork_id, "code"));
    const stateRef = await git.readRef(retainedRef(version.descriptor.fork_id, "state"));
    if (versionRef !== version.version_commit || codeRef !== version.descriptor.code_commit || stateRef !== version.descriptor.state_commit) {
      throw new ForgeVersionAuthenticationError("forge version is not authenticated by retained refs");
    }
  }

  async function repairAlias(ref: string, target: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await git.readRef(ref);
      if (current === target) return;
      if (await git.compareAndSwapRef(ref, current, target)) return;
    }
    throw new ForkForgeUnavailableError(`could not repair derived ref ${ref}`);
  }

  async function repairAliases(version: ForgeVersion): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = await git.readRef(headRef);
      const current = head && head !== version.version_commit ? await readVersion(head) : version;
      await repairAlias(codeAliasRef, current.descriptor.code_commit);
      await repairAlias(stateAliasRef, current.descriptor.state_commit);
      if (await git.readRef(headRef) === current.version_commit) return;
    }
    throw new ForkForgeUnavailableError("authoritative head moved during alias repair");
  }

  async function initialize(params: InitializeInput): Promise<ForgeVersion> {
    const actor = normalizeActor(params.actor);
    await authorize("forge.initialize", actor);
    const initialState = normalizeInitialState(params.initial_state ?? []);
    const hasExistingCode = params.code_commit !== undefined;
    const hasInitialCode = params.initial_code !== undefined;
    if (hasExistingCode === hasInitialCode) throw new ForkForgeInputError("initialize requires exactly one of code_commit or initial_code");
    const codeCommitInput = hasExistingCode ? assertSha40(params.code_commit as string, "code_commit") : null;
    const initialCode = hasInitialCode ? normalizeInitialCode(params.initial_code ?? []) : null;
    const semanticInput = codeCommitInput ? { operation_id: params.operation_id, code_commit: codeCommitInput, initial_state: initialState, actor } : { operation_id: params.operation_id, initial_code: initialCode, initial_state: initialState, actor };
    const operation = await reserveOperation("initialize", params.operation_id, semanticInput);
    if (operation.replay?.status === "version") return operation.replay.version;
    if (codeCommitInput) await git.listTree(codeCommitInput, "");
    const codeCommit = codeCommitInput ?? await git.writeCommit({ base: null, parents: [], changes: initialCode ?? [], message: "initialize code", author: authorFor(actor), timestamp: operation.timestamp });
    const stateCommit = await git.writeCommit({ base: null, parents: [], changes: [{ path: "README.md", content_base64: encodeBase64Utf8("# Forge state\n") }, ...initialState], message: "initialize forge-state", author: authorFor(actor), timestamp: operation.timestamp });
    const version = await createVersion({ operationId: params.operation_id, requestDigest: operation.requestDigest, timestamp: operation.timestamp, actor, parents: [], codeCommit, stateCommit, message: "initialize complete forge" });
    const currentHead = await git.readRef(headRef);
    if (currentHead === null) {
      const advanced = await git.compareAndSwapRef(headRef, null, version.version_commit);
      if (advanced) {
        await repairAliases(version);
        await completeOperation(params.operation_id, operation.requestDigest, "initialize", semanticInput, { status: "version", version });
        return version;
      }
    }
    const actualHead = await git.readRef(headRef);
    if (!actualHead) throw new ForkForgeUnavailableError("forge-head was not initialized after compare-and-swap");
    const actual = await readVersion(actualHead);
    await repairAliases(actual);
    await completeOperation(params.operation_id, operation.requestDigest, "initialize", semanticInput, { status: "version", version: actual });
    return actual;
  }

  async function read(inputOrVersion: string | ReadInput, actor?: ForgeActor): Promise<ForgeVersion | ForkForgeReadResult> {
    if (typeof inputOrVersion === "string") {
      const version = await readVersion(inputOrVersion);
      await authorize("forge.read", actor, version);
      return version;
    }
    const version = await readVersion(inputOrVersion.version);
    await authorize("forge.read", inputOrVersion.actor, version);
    const commit = treeCommit(version, inputOrVersion.tree);
    if (inputOrVersion.path !== undefined) {
      if (inputOrVersion.prefix !== undefined) throw new ForkForgeInputError("read path and prefix are mutually exclusive");
      const path = assertForgePath(inputOrVersion.path);
      return { status: "file", version, tree: inputOrVersion.tree, path, content_base64: await git.readFile(commit, path) };
    }
    const prefix = inputOrVersion.prefix === undefined || inputOrVersion.prefix === "" ? "" : assertForgePath(inputOrVersion.prefix);
    return { status: "tree", version, tree: inputOrVersion.tree, prefix, entries: await git.listTree(commit, prefix) };
  }

  function treeCommit(version: ForgeVersion, tree: ForgeTreeKind): string {
    if (tree === "code") return version.descriptor.code_commit;
    if (tree === "state") return version.descriptor.state_commit;
    throw new ForkForgeInputError("read tree must be code or state");
  }

  async function operationVersion(operationId: string, actor?: ForgeActor): Promise<ForgeVersion | null> {
    const id = assertSafeId(operationId, "operation_id");
    await authorize("forge.read", actor);
    const operation = await readOperation(resultRef(id));
    if (!operation) return null;
    if (operation.operation_id !== id || operation.status !== "result" || operation.result?.status !== "version") {
      throw new ForgeVersionAuthenticationError("operation result is not an authenticated version");
    }
    const version = await readVersion(operation.result.version.version_commit);
    if (version.descriptor.operation_id !== id) throw new ForgeVersionAuthenticationError("operation result belongs to a different operation");
    await authorize("forge.read", actor, version);
    return version;
  }

  async function head(actor?: ForgeActor): Promise<ForgeVersion | null> {
    await authorize("forge.read", actor);
    const commit = await git.readRef(headRef);
    return commit ? readVersion(commit) : null;
  }

  async function list(actor?: ForgeActor): Promise<readonly ForgeVersion[]> {
    await authorize("forge.read", actor);
    const refs = await git.listRefs(retainedRootRef);
    const versionRefs = refs.filter((entry) => entry.ref.endsWith("/version")).sort((left, right) => left.ref.localeCompare(right.ref));
    const versions: ForgeVersion[] = [];
    for (let start = 0; start < versionRefs.length; start += 8) {
      const batch = await Promise.all(versionRefs.slice(start, start + 8).map(async entry => await isPartlyRetained(entry.ref.slice(retainedRootRef.length, -"/version".length)) ? null : readVersion(entry.target)));
      versions.push(...batch.filter((version): version is ForgeVersion => version !== null));
    }
    return versions;
  }

  async function fork(params: ForkInput): Promise<ForgeVersion> {
    const actor = normalizeActor(params.actor);
    const parent = await readVersion(params.parent_version);
    await authorize("forge.fork", actor, parent);
    const semanticInput = { operation_id: params.operation_id, parent_version: parent.version_commit, actor };
    const operation = await reserveOperation("fork", params.operation_id, semanticInput);
    if (operation.replay?.status === "version") return operation.replay.version;
    const version = await createVersion({ operationId: params.operation_id, requestDigest: operation.requestDigest, timestamp: operation.timestamp, actor, parents: [parent], codeCommit: parent.descriptor.code_commit, stateCommit: parent.descriptor.state_commit, message: "fork complete forge" });
    await completeOperation(params.operation_id, operation.requestDigest, "fork", semanticInput, { status: "version", version });
    return version;
  }

  async function commit(params: CommitInput): Promise<ForgeVersion> {
    const actor = normalizeActor(params.actor);
    const parent = await readVersion(params.parent_version);
    await authorize("forge.commit", actor, parent);
    const changes = params.changes.map((change) => normalizeChange(change));
    const semanticInput = { operation_id: params.operation_id, parent_version: parent.version_commit, changes, actor };
    const operation = await reserveOperation("commit", params.operation_id, semanticInput);
    if (operation.replay?.status === "version") return operation.replay.version;
    const codeChanges = changes.filter((change) => change.tree === "code");
    const stateChanges = changes.filter((change) => change.tree === "state");
    const codeCommit = codeChanges.length === 0 ? parent.descriptor.code_commit : await writeTreeCommit("code", parent.descriptor.code_commit, codeChanges, actor);
    const stateCommit = stateChanges.length === 0 ? parent.descriptor.state_commit : await writeTreeCommit("state", parent.descriptor.state_commit, stateChanges, actor);
    const version = await createVersion({ operationId: params.operation_id, requestDigest: operation.requestDigest, timestamp: operation.timestamp, actor, parents: [parent], codeCommit, stateCommit, message: "commit complete forge fork" });
    await completeOperation(params.operation_id, operation.requestDigest, "commit", semanticInput, { status: "version", version });
    return version;
  }

  async function adoptCodeCommit(params: AdoptCodeCommitInput): Promise<ForgeVersion> {
    const actor = normalizeActor(params.actor);
    const parent = await readVersion(params.parent_version);
    await authorize("forge.commit", actor, parent);
    const expectedCode = assertSha40(params.expected_parent_code_commit, "expected_parent_code_commit");
    if (parent.descriptor.code_commit !== expectedCode) throw new ForkForgeInputError("parent code commit does not match expected_parent_code_commit");
    const codeCommit = assertSha40(params.code_commit, "code_commit");
    const changes = params.changes.map((change) => normalizeChange(change));
    if (changes.some((change) => change.tree !== "state")) throw new ForkForgeInputError("adoptCodeCommit accepts state changes only");
    await git.listTree(codeCommit, "");
    const semanticInput = { operation_id: params.operation_id, parent_version: parent.version_commit, expected_parent_code_commit: expectedCode, code_commit: codeCommit, changes, actor };
    const operation = await reserveOperation("adopt_code_commit", params.operation_id, semanticInput);
    if (operation.replay?.status === "version") return operation.replay.version;
    const stateCommit = changes.length === 0 ? parent.descriptor.state_commit : await writeTreeCommit("state", parent.descriptor.state_commit, changes, actor);
    const version = await createVersion({ operationId: params.operation_id, requestDigest: operation.requestDigest, timestamp: operation.timestamp, actor, parents: [parent], codeCommit, stateCommit, message: "adopt imported source commit" });
    await completeOperation(params.operation_id, operation.requestDigest, "adopt_code_commit", semanticInput, { status: "version", version });
    return version;
  }

  async function writeTreeCommit(tree: ForgeTreeKind, base: string, changes: readonly ForkForgeChange[], actor: ForgeActor): Promise<string> {
    return git.writeCommit({ base, parents: [base], changes: changes.map((change) => withOptionalMode({ path: change.path, content_base64: change.content_base64 }, change.mode)), message: `update ${tree} tree`, author: authorFor(actor), timestamp: input.clock() });
  }

  async function compare(params: CompareInput): Promise<ForkForgeComparison> {
    const base = await readVersion(params.base_version);
    const headVersion = await readVersion(params.head_version);
    await authorize("forge.compare", params.actor, headVersion);
    return {
      base,
      head: headVersion,
      code: await git.compareCommits(base.descriptor.code_commit, headVersion.descriptor.code_commit),
      state: await git.compareCommits(base.descriptor.state_commit, headVersion.descriptor.state_commit)
    };
  }

  async function merge(params: MergeInput): Promise<ForkForgeOperationResult> {
    const actor = normalizeActor(params.actor);
    const base = await readVersion(params.base_version);
    const left = await readVersion(params.left_version);
    const right = await readVersion(params.right_version);
    await authorize("forge.merge", actor, left);
    if (!(await git.isAncestor(base.version_commit, left.version_commit)) || !(await git.isAncestor(base.version_commit, right.version_commit))) throw new ForkForgeInputError("merge inputs must descend from base version");
    const semanticInput = { operation_id: params.operation_id, base_version: base.version_commit, left_version: left.version_commit, right_version: right.version_commit, actor };
    const operation = await reserveOperation("merge", params.operation_id, semanticInput);
    if (operation.replay) return operation.replay;
    const code = await mergeTree("code", base.descriptor.code_commit, left.descriptor.code_commit, right.descriptor.code_commit, actor);
    const state = await mergeTree("state", base.descriptor.state_commit, left.descriptor.state_commit, right.descriptor.state_commit, actor);
    const conflicts = [...conflictsFor("code", code), ...conflictsFor("state", state)];
    if (conflicts.length > 0) {
      const result = { status: "conflict", conflicts } satisfies ForkForgeOperationResult;
      await completeOperation(params.operation_id, operation.requestDigest, "merge", semanticInput, result);
      return result;
    }
    const version = await createVersion({ operationId: params.operation_id, requestDigest: operation.requestDigest, timestamp: operation.timestamp, actor, parents: [left, right], codeCommit: mergedCommit(code), stateCommit: mergedCommit(state), message: "merge complete forge forks" });
    const result = { status: "version", version } satisfies ForkForgeOperationResult;
    await completeOperation(params.operation_id, operation.requestDigest, "merge", semanticInput, result);
    return result;
  }

  async function mergeTree(tree: ForgeTreeKind, base: string, left: string, right: string, actor: ForgeActor): Promise<ForgeMergeResult> {
    if (left === right) return { status: "merged", commit: left };
    if (base === left) return { status: "merged", commit: right };
    if (base === right) return { status: "merged", commit: left };
    return git.mergeCommits({ base, left, right, author: authorFor(actor), timestamp: input.clock(), message: `merge ${tree} tree` });
  }

  function conflictsFor(tree: ForgeTreeKind, result: ForgeMergeResult): readonly ForkForgeConflict[] {
    return result.status === "conflict" ? result.paths.map((path) => ({ tree, path })) : [];
  }

  function mergedCommit(result: ForgeMergeResult): string {
    if (result.status === "conflict") throw new ForkForgeMergeConflictError(result.paths.map((path) => ({ tree: "code", path })));
    return result.commit;
  }

  async function publish(params: PublishInput): Promise<ForgeVersion> {
    const actor = normalizeActor(params.actor);
    const expected = params.expected_version ? await readVersion(params.expected_version) : null;
    const candidate = await readVersion(params.new_version);
    if (expected?.version_commit === candidate.version_commit) throw new ForkForgeInputError("publish candidate must differ from expected forge head");
    await authorize("forge.publish", actor, candidate);
    await input.verifyEvidence({ actor, expected, candidate });
    const semanticInput = { operation_id: params.operation_id, expected_version: expected?.version_commit ?? null, new_version: candidate.version_commit, actor };
    const operation = await reserveOperation("publish", params.operation_id, semanticInput);
    if (operation.replay?.status === "published") {
      await repairAliases(operation.replay.version);
      return operation.replay.version;
    }
    const current = await git.readRef(headRef);
    if (current !== (expected?.version_commit ?? null)) {
      const completed = await readOperation(resultRef(params.operation_id));
      const intent = await readOperation(publicationIntentRef(candidate.version_commit));
      if (completed?.request_digest === operation.requestDigest && completed.result?.status === "published" && completed.result.version.version_commit === candidate.version_commit) {
        await repairAliases(candidate);
        return candidate;
      }
      if (current === candidate.version_commit && intent?.operation_id === params.operation_id && intent.request_digest === operation.requestDigest) {
        await completeOperation(params.operation_id, operation.requestDigest, "publish", semanticInput, { status: "published", version: candidate });
        await repairAliases(candidate);
        return candidate;
      }
      throw new ForkForgeStaleHeadError(`forge-head is ${current ?? "null"}, expected ${expected?.version_commit ?? "null"}`);
    }
    if (expected && !(await git.isAncestor(expected.version_commit, candidate.version_commit))) throw new ForkForgeStaleHeadError("candidate does not descend from expected forge head");
    await retainVersion(candidate);
    await authorize("forge.publish", actor, candidate);
    await input.verifyEvidence({ actor, expected, candidate });
    const published = await completePublishOperation(params.operation_id, operation.requestDigest, semanticInput, expected?.version_commit ?? null, candidate);
    if (!published) {
      const existing = await readOperation(resultRef(params.operation_id));
      if (existing?.result?.status === "published" && existing.result.version.version_commit === candidate.version_commit) {
        await repairAliases(existing.result.version);
        return existing.result.version;
      }
      throw new ForkForgeStaleHeadError("forge-head changed during publish");
    }
    const actual = await git.readRef(headRef);
    if (actual !== candidate.version_commit) {
      const completed = await readOperation(resultRef(params.operation_id));
      if (completed?.request_digest !== operation.requestDigest || completed.result?.status !== "published" || completed.result.version.version_commit !== candidate.version_commit) throw new ForkForgeUnavailableError("forge-head readback did not match published version");
    }
    await repairAliases(candidate);
    return candidate;
  }

  async function completePublishOperation(operationId: string, requestDigest: string, semanticInput: unknown, expectedHead: string | null, candidate: ForgeVersion): Promise<boolean> {
    const id = assertSafeId(operationId, "operation_id");
    await reservePublication(candidate.version_commit, id, requestDigest);
    if (expectedHead) await reconcilePublicationReceipt(expectedHead);
    const advanced = await git.compareAndSwapRef(headRef, expectedHead, candidate.version_commit);
    const current = await git.readRef(headRef);
    if (!advanced && current !== candidate.version_commit) return false;
    if (current !== candidate.version_commit) {
      const completed = await readOperation(resultRef(id));
      if (completed?.request_digest !== requestDigest || completed.result?.status !== "published" || completed.result.version.version_commit !== candidate.version_commit) throw new ForkForgeUnavailableError("publication head readback missing its receipt");
    }
    await completeOperation(id, requestDigest, "publish", semanticInput, { status: "published", version: candidate });
    return true;
  }

  async function reservePublication(versionCommit: string, operationId: string, requestDigest: string): Promise<void> {
    const intentCommit = await git.readRef(intentRef(operationId));
    if (!intentCommit) throw new ForkForgeUnavailableError("publication intent missing");
    if (await git.compareAndSwapRef(publicationIntentRef(versionCommit), null, intentCommit)) return;
    const intent = await readOperation(publicationIntentRef(versionCommit));
    if (intent?.kind !== "publish" || intent.operation_id !== operationId || intent.request_digest !== requestDigest) throw new ForkForgeIdempotencyConflictError("candidate already belongs to another publication operation");
  }

  async function reconcilePublicationReceipt(versionCommit: string): Promise<void> {
    const intent = await readOperation(publicationIntentRef(versionCommit));
    if (!intent) return;
    if (intent.kind !== "publish") throw new ForkForgeUnavailableError("publication intent is invalid");
    const publishedInput = intent.input as { expected_version: string | null; new_version: string; actor: ForgeActor };
    if (publishedInput.new_version !== versionCommit) throw new ForkForgeUnavailableError("publication intent candidate mismatch");
    const completed = await readOperation(resultRef(intent.operation_id));
    if (completed) {
      if (completed.request_digest !== intent.request_digest || completed.result?.status !== "published" || completed.result.version.version_commit !== versionCommit) throw new ForkForgeUnavailableError("publication receipt mismatch");
      return;
    }
    const expected = publishedInput.expected_version ? await readVersion(publishedInput.expected_version) : null;
    const candidate = await readVersion(versionCommit);
    await input.verifyEvidence({ actor: normalizeActor(publishedInput.actor), expected, candidate });
    await completeOperation(intent.operation_id, intent.request_digest, "publish", intent.input, { status: "published", version: candidate });
  }

  async function recover(params: RecoverInput): Promise<ForkForgeOperationResult> {
    const actor = normalizeActor(params.actor);
    await authorize("forge.recover", actor);
    const id = assertSafeId(params.operation_id, "operation_id");
    const result = await readOperation(resultRef(id));
    if (result?.result) return result.result;
    const intent = await readOperation(intentRef(id));
    if (!intent) throw new ForgeVersionNotFoundError(`operation ${id} was not found`);
    if (intent.kind !== "publish") return { status: "pending", operation_id: id, reason: "operation has intent without result" };
    const publishInput = intent.input as { expected_version: string | null; new_version: string; actor: ForgeActor };
    const expected = publishInput.expected_version ? await readVersion(publishInput.expected_version) : null;
    const candidate = await readVersion(publishInput.new_version);
    if (expected?.version_commit === candidate.version_commit) throw new ForkForgeInputError("publish candidate must differ from expected forge head");
    const current = await git.readRef(headRef);
    if (current === candidate.version_commit) {
      await reservePublication(candidate.version_commit, id, intent.request_digest);
      await input.verifyEvidence({ actor: normalizeActor(publishInput.actor), expected, candidate });
      await completeOperation(id, intent.request_digest, "publish", intent.input, { status: "published", version: candidate });
      await repairAliases(candidate);
      return { status: "published", version: candidate };
    }
    if (current === (expected?.version_commit ?? null)) {
      await input.verifyEvidence({ actor: normalizeActor(publishInput.actor), expected, candidate });
      if (expected && !(await git.isAncestor(expected.version_commit, candidate.version_commit))) throw new ForkForgeStaleHeadError("candidate does not descend from expected forge head");
      await retainVersion(candidate);
      if (await completePublishOperation(id, intent.request_digest, intent.input, expected?.version_commit ?? null, candidate)) {
        await repairAliases(candidate);
        return { status: "published", version: candidate };
      }
      const completed = await readOperation(resultRef(id));
      if (completed?.result) return completed.result;
      return { status: "pending", operation_id: id, reason: "publish recovery lost the atomic compare-and-swap race" };
    }
    throw new ForkForgeStaleHeadError(`forge-head is ${current ?? "null"}`);
  }

  function normalizeInitialCode(changes: readonly InitializeFileChange[]): readonly NormalizedFileChange[] {
    return normalizeInitializeFiles("initial_code", changes);
  }

  function normalizeInitialState(changes: readonly InitializeFileChange[]): readonly NormalizedFileChange[] {
    return normalizeInitializeFiles("initial_state", changes, { reserveReadme: true });
  }

  function normalizeInitializeFiles(label: "initial_code" | "initial_state", changes: readonly InitializeFileChange[], options: { readonly reserveReadme?: boolean } = {}): readonly NormalizedFileChange[] {
    const seen = new Set<string>();
    return changes.map((change) => {
      const path = assertForgePath(change.path);
      if (options.reserveReadme && path === "README.md") throw new ForkForgeInputError("initial_state cannot override README.md");
      if (seen.has(path)) throw new ForkForgeInputError(`${label} contains duplicate path ${path}`);
      seen.add(path);
      const content_base64 = change.content_base64 === null ? null : assertBase64(change.content_base64, "content_base64");
      return withOptionalMode({ path, content_base64 }, normalizeFileMode(change.content_base64, change.mode));
    });
  }

  function normalizeChange(change: ForkForgeChange): ForkForgeChange {
    const tree = change.tree;
    if (tree !== "code" && tree !== "state") throw new ForkForgeInputError("change tree must be code or state");
    const content_base64 = change.content_base64 === null ? null : assertBase64(change.content_base64, "content_base64");
    return withOptionalMode({ tree, path: assertForgePath(change.path), content_base64 }, normalizeFileMode(change.content_base64, change.mode));
  }

  function withOptionalMode<T extends { readonly path: string; readonly content_base64: string | null }>(change: T, mode: ForgeFileMode | undefined): T & { readonly mode?: ForgeFileMode } {
    return mode === undefined ? change : { ...change, mode };
  }

  function normalizeFileMode(contentBase64: string | null, mode: ForgeFileMode | undefined): ForgeFileMode | undefined {
    if (contentBase64 === null && mode !== undefined) throw new ForkForgeInputError("deleted files cannot specify mode");
    return mode === undefined ? undefined : assertForgeFileMode(mode, "mode");
  }

  return { initialize, head, read: read as ForkForgeRead, list, operationVersion, fork, commit, adoptCodeCommit, compare, merge, publish, recover };
}

function normalizeActor(actor: ForgeActor): ForgeActor {
  return { id: assertSafeId(actor.id, "actor.id"), kind: actor.kind };
}

function authorFor(actor: ForgeActor): { readonly name: string; readonly email: string } {
  return { name: `${actor.kind}:${actor.id}`, email: `${actor.id}@actors.gitfoundry.local` };
}

function systemAuthor(): { readonly name: string; readonly email: string } {
  return { name: "gitfoundry-forge", email: "forge@gitfoundry.local" };
}

function sameParents(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((parent, index) => parent === right[index]);
}

function retainedRef(forkId: string, kind: "version" | "code" | "state"): string {
  return `refs/heads/retained/${safeRefPart(forkId)}/${kind}`;
}

function publicationIntentRef(versionCommit: string): string {
  return `refs/heads/publications/${assertSha40(versionCommit, "publication version")}/intent`;
}

function intentRef(operationId: string): string {
  return `refs/heads/operations/${safeRefPart(operationId)}/intent`;
}

function resultRef(operationId: string): string {
  return `refs/heads/operations/${safeRefPart(operationId)}/result`;
}
