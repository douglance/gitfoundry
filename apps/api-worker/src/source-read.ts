import { Data, Effect } from "effect";

import type { D1DatabaseLike } from "../../../packages/core/src/live/index.js";
import type { ArtifactsBinding, ArtifactsRepoHandle } from "./git-provider.js";

export type SourceEncoding = "utf-8" | "binary" | "unsupported";
export type SourceReadFailureCode = "invalid_input" | "not_found" | "unavailable" | "unsupported";

export class SourceReadUnavailableError extends Data.TaggedError("SourceReadUnavailableError")<{
  readonly code: SourceReadFailureCode;
  readonly reason: string;
  readonly repositoryId: string;
  readonly ref?: string;
  readonly path?: string;
}> {}

export interface ForgeTreeEntry {
  readonly path: string;
  readonly path_base64: string | null;
  readonly mode: "040000" | "100644" | "100755" | "120000" | "160000";
  readonly kind: "tree" | "blob" | "symlink" | "submodule";
  readonly sha: string;
  readonly size_bytes: number | null;
}

export interface ForgeTreePage {
  readonly items: readonly ForgeTreeEntry[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  readonly repository_id: string;
  readonly resolved_sha: string;
  readonly tree_sha: string;
  readonly truncated: boolean;
  readonly truncation_reason: "entry_limit" | "byte_limit" | "deadline" | null;
}

export interface ForgeDiffLine { readonly kind: "context" | "addition" | "deletion"; readonly old_line: number | null; readonly new_line: number | null; readonly text: string; readonly has_newline: boolean }
export interface ForgeDiffHunk { readonly old_start: number; readonly old_count: number; readonly new_start: number; readonly new_count: number; readonly header: string; readonly lines: readonly ForgeDiffLine[] }
export interface ForgeDiffFile {
  readonly old_path: string | null;
  readonly new_path: string | null;
  readonly old_sha: string | null;
  readonly new_sha: string | null;
  readonly change: "added" | "deleted" | "modified" | "renamed" | "copied" | "type_changed";
  readonly old_mode: string | null;
  readonly new_mode: string | null;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly similarity_percent: number | null;
  readonly hunks: readonly ForgeDiffHunk[];
  readonly truncated: boolean;
}

export interface ForgeDiffPage {
  readonly items: readonly ForgeDiffFile[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  readonly repository_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly merge_base_shas: readonly string[];
  readonly algorithm_version: string;
  readonly diff_digest: string;
  readonly truncated: boolean;
  readonly truncation_reason: "file_limit" | "line_limit" | "byte_limit" | "deadline" | null;
}

export interface SourceFileResponse {
  readonly repository_id: string;
  readonly resolved_sha: string;
  readonly path: string;
  readonly sha: string;
  readonly size_bytes: number;
  readonly encoding: SourceEncoding;
  readonly contents: string | null;
  readonly truncated: boolean;
}

export interface SourceTreeInput { readonly tenantId: string; readonly repositoryId: string; readonly ref: string; readonly path?: string | undefined; readonly recursive?: boolean | undefined; readonly limit?: number | undefined; readonly cursor?: string | undefined; readonly direction?: string | undefined }
export interface SourceDiffInput { readonly tenantId: string; readonly repositoryId: string; readonly base: string; readonly head: string; readonly comparison?: string | undefined; readonly pathPrefix?: string | undefined; readonly contextLines?: number | undefined; readonly limit?: number | undefined; readonly cursor?: string | undefined; readonly direction?: string | undefined }
export interface SourceFileInput { readonly tenantId: string; readonly repositoryId: string; readonly ref: string; readonly path: string; readonly maxBytes?: number | undefined }

export interface SourceReadPort {
  readonly tree: (input: SourceTreeInput) => Effect.Effect<ForgeTreePage, SourceReadUnavailableError>;
  readonly diff: (input: SourceDiffInput) => Effect.Effect<ForgeDiffPage, SourceReadUnavailableError>;
  readonly readFile: (input: SourceFileInput) => Effect.Effect<SourceFileResponse, SourceReadUnavailableError>;
}

export interface GitCliRepository { readonly gitDir: string }
export interface GitCliRunner { readonly run: (gitDir: string, args: readonly string[], options?: { readonly maxBuffer?: number }) => Promise<{ readonly stdout: Uint8Array; readonly truncated?: boolean }> }
export interface GitCliSourceReadOptions { readonly resolveRepository: (input: { readonly tenantId: string; readonly repositoryId: string }) => Promise<GitCliRepository>; readonly git: GitCliRunner; readonly cursorSecret: string; readonly maxFileBytes?: number; readonly maxDiffBytes?: number }

const shaPattern = /^[0-9a-f]{40}$/;
const refPattern = /^[^\0\r\n]{1,1024}$/;
const providerRepositoryNamePattern = /^[A-Za-z0-9_.-]{1,255}$/;
const defaultFileBytes = 256 * 1024;
const defaultDiffBytes = 1024 * 1024;
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

interface RepositoryArtifactRow { readonly artifacts_namespace: string | null; readonly artifacts_name: string | null }

export function isGitSha(value: string): boolean { return shaPattern.test(value) }

export function validateSourcePath(path: string): boolean {
  return path.length <= 4096 && !path.startsWith("/") && !path.includes("\0") && path.split("/").every((part) => part !== "..") && !path.includes("//");
}

export function makeD1ArtifactsSourceRead(db: D1DatabaseLike, binding: ArtifactsBinding | undefined, options: { readonly namespace: string }): SourceReadPort {
  const withRepo = async <T>(input: { readonly tenantId: string; readonly repositoryId: string; readonly ref?: string | undefined; readonly path?: string | undefined }, action: (repo: ArtifactsSourceRepoHandle) => Promise<T>): Promise<T> => {
    const selected = await selectRepositoryArtifacts(db, input.tenantId, input.repositoryId, input.ref ?? "", options.namespace);
    if (!binding) throw unavailable(input.repositoryId, input.ref, input.path, "unavailable", "provider unavailable");
    let repo: ArtifactsSourceRepoHandle;
    try { repo = await binding.get(selected.name) as ArtifactsSourceRepoHandle } catch { throw unavailable(input.repositoryId, input.ref, input.path, "unavailable", "provider unavailable") }
    try {
      const info = await repo.info();
      if (info.name !== selected.name || !providerRepositoryNamePattern.test(info.name)) throw unavailable(input.repositoryId, input.ref, input.path, "unavailable", "repository identity unavailable");
      return await action(repo);
    } finally { disposeRepo(repo) }
  };
  return {
    tree: (input) => Effect.tryPromise({ try: () => withRepo(input, (repo) => callTree(repo, input)), catch: (error) => mapSourceError(input.repositoryId, input.ref, input.path, error) }),
    diff: (input) => Effect.tryPromise({ try: async (): Promise<ForgeDiffPage> => withRepo({ tenantId: input.tenantId, repositoryId: input.repositoryId, ref: input.head, path: input.pathPrefix }, (repo) => callDiff(repo, input)), catch: (error) => mapSourceError(input.repositoryId, input.head, input.pathPrefix, error) }),
    readFile: (input) => Effect.tryPromise({ try: () => withRepo(input, (repo) => callReadFile(repo, input)), catch: (error) => mapSourceError(input.repositoryId, input.ref, input.path, error) })
  };
}

export function makeGitCliSourceRead(options: GitCliSourceReadOptions): SourceReadPort {
  const maxFileBytes = options.maxFileBytes ?? defaultFileBytes;
  const maxDiffBytes = options.maxDiffBytes ?? defaultDiffBytes;
  return {
    tree: (input) => Effect.tryPromise({ try: async () => {
      assertRef(input.repositoryId, input.ref); assertPath(input.repositoryId, input.ref, input.path ?? "");
      const basePath = input.path ?? "";
      const limit = normalizeLimit(input.limit);
      const direction = normalizeDirection(input.direction);
      const cursor = input.cursor ? await openCursor<TreeCursor>(input.cursor, options.cursorSecret, "tree", input.tenantId, input.repositoryId) : undefined;
      if (cursor && (cursor.ref !== input.ref || cursor.path !== basePath || cursor.recursive !== Boolean(input.recursive) || cursor.limit !== limit || cursor.direction !== direction)) throw unavailable(input.repositoryId, input.ref, basePath, "invalid_input", "cursor scope mismatch");
      const repo = await options.resolveRepository(input);
      const resolved = cursor?.resolved_sha ?? await resolveCommit(options.git, repo.gitDir, input.repositoryId, input.ref);
      const treeSha = cursor?.tree_sha ?? trimText(await options.git.run(repo.gitDir, ["rev-parse", "--verify", basePath ? `${resolved}:${basePath}` : `${resolved}^{tree}`]));
      if (!shaPattern.test(treeSha)) throw unavailable(input.repositoryId, input.ref, basePath, "not_found", "tree unavailable");
      const type = trimText(await options.git.run(repo.gitDir, ["cat-file", "-t", treeSha]));
      if (type !== "tree") throw unavailable(input.repositoryId, input.ref, basePath, "not_found", "tree unavailable");
      const args = ["ls-tree", "-z", "-l", ...(input.recursive ? ["-r"] : []), treeSha];
      const treeRun = await options.git.run(repo.gitDir, args);
      if (treeRun.truncated) throw unavailable(input.repositoryId, input.ref, basePath, "unsupported", "tree metadata exceeds the read limit");
      const listed = parseTree(trimText(treeRun), basePath);
      const sorted = direction === "desc" ? [...listed].sort((a, b) => b.path.localeCompare(a.path)) : [...listed].sort((a, b) => a.path.localeCompare(b.path));
      const offset = cursor?.offset ?? 0;
      const items = sorted.slice(offset, offset + limit);
      const hasMore = offset + limit < sorted.length;
      return { items, next_cursor: hasMore ? await sealCursor({ kind: "tree", tenant_id: input.tenantId, repository_id: input.repositoryId, ref: input.ref, resolved_sha: resolved, tree_sha: treeSha, path: basePath, recursive: Boolean(input.recursive), limit, direction, offset: offset + limit }, options.cursorSecret) : null, has_more: hasMore, repository_id: input.repositoryId, resolved_sha: resolved, tree_sha: treeSha, truncated: false, truncation_reason: null } satisfies ForgeTreePage;
    }, catch: (error) => mapSourceError(input.repositoryId, input.ref, input.path, error) }),
    diff: (input) => Effect.tryPromise({ try: async () => {
      assertRef(input.repositoryId, input.base); assertRef(input.repositoryId, input.head); assertPath(input.repositoryId, input.head, input.pathPrefix ?? "");
      const comparison = normalizeComparison(input.comparison);
      const context = normalizeContext(input.contextLines);
      const pathPrefix = input.pathPrefix ?? "";
      const limit = normalizeLimit(input.limit);
      const direction = normalizeDirection(input.direction);
      const cursor = input.cursor ? await openCursor<DiffCursor>(input.cursor, options.cursorSecret, "diff", input.tenantId, input.repositoryId) : undefined;
      if (cursor && (cursor.base !== input.base || cursor.head !== input.head || cursor.comparison !== comparison || cursor.path_prefix !== pathPrefix || cursor.context_lines !== context || cursor.limit !== limit || cursor.direction !== direction)) throw unavailable(input.repositoryId, input.head, input.pathPrefix, "invalid_input", "cursor scope mismatch");
      const repo = await options.resolveRepository(input);
      const baseSha = cursor?.base_sha ?? await resolveCommit(options.git, repo.gitDir, input.repositoryId, input.base);
      const headSha = cursor?.head_sha ?? await resolveCommit(options.git, repo.gitDir, input.repositoryId, input.head);
      const mergeBaseShas = cursor?.merge_base_shas ?? (comparison === "three_dot" ? parseLines(trimText(await options.git.run(repo.gitDir, ["merge-base", "--all", baseSha, headSha]))).filter(isGitSha) : []);
      const range = comparison === "two_dot" ? `${baseSha}..${headSha}` : `${baseSha}...${headSha}`;
      const pathArgs = pathPrefix ? ["--", pathPrefix] : [];
      const diffRun = await options.git.run(repo.gitDir, ["diff", "--patch", "--full-index", "--find-renames", "--find-copies", `--unified=${context}`, range, ...pathArgs], { maxBuffer: maxDiffBytes + 1 });
      const patch = decodeDiffPatch(diffRun.stdout, input.repositoryId, input.head, input.pathPrefix);
      const files = diffRun.truncated ? markDiffFilesTruncated(parsePatch(patch)) : parsePatch(patch);
      const digest = await sha256Hex(patch);
      if (cursor && cursor.digest !== digest) throw unavailable(input.repositoryId, input.head, input.pathPrefix, "invalid_input", "cursor scope mismatch");
      const sorted = direction === "desc" ? [...files].reverse() : files;
      const offset = cursor?.offset ?? 0;
      const items = sorted.slice(offset, offset + limit);
      const hasMore = offset + limit < sorted.length;
      return { items, next_cursor: hasMore ? await sealCursor({ kind: "diff", tenant_id: input.tenantId, repository_id: input.repositoryId, base: input.base, head: input.head, base_sha: baseSha, head_sha: headSha, merge_base_shas: mergeBaseShas, comparison, path_prefix: pathPrefix, context_lines: context, digest, limit, direction, offset: offset + limit }, options.cursorSecret) : null, has_more: hasMore, repository_id: input.repositoryId, base_sha: baseSha, head_sha: headSha, merge_base_shas: mergeBaseShas, algorithm_version: "git-cli-unified-v1", diff_digest: digest, truncated: Boolean(diffRun.truncated), truncation_reason: diffRun.truncated ? "byte_limit" : null } satisfies ForgeDiffPage;
    }, catch: (error) => mapSourceError(input.repositoryId, input.head, input.pathPrefix, error) }),
    readFile: (input) => Effect.tryPromise({ try: async () => {
      assertRef(input.repositoryId, input.ref); assertPath(input.repositoryId, input.ref, input.path);
      const repo = await options.resolveRepository(input);
      const resolved = await resolveCommit(options.git, repo.gitDir, input.repositoryId, input.ref);
      const treeEntry = firstTreeEntry(trimText(await options.git.run(repo.gitDir, ["ls-tree", "-z", "-l", resolved, "--", input.path])), input.path, input.repositoryId, input.ref);
      if (treeEntry.kind !== "blob" && treeEntry.kind !== "symlink") return { repository_id: input.repositoryId, resolved_sha: resolved, path: input.path, sha: treeEntry.sha, size_bytes: treeEntry.size_bytes ?? 0, encoding: "unsupported", contents: null, truncated: false } satisfies SourceFileResponse;
      const size = treeEntry.size_bytes ?? Number(trimText(await options.git.run(repo.gitDir, ["cat-file", "-s", treeEntry.sha])));
      const byteLimit = input.maxBytes ?? maxFileBytes;
      const blob = await readBlobPrefix(options.git, repo.gitDir, treeEntry.sha, byteLimit);
      const detected = detectText(blob.stdout, size > blob.stdout.byteLength || blob.truncated === true);
      return { repository_id: input.repositoryId, resolved_sha: resolved, path: input.path, sha: treeEntry.sha, size_bytes: size, encoding: detected.encoding, contents: detected.contents, truncated: detected.truncated } satisfies SourceFileResponse;
    }, catch: (error) => mapSourceError(input.repositoryId, input.ref, input.path, error) })
  };
}

async function selectRepositoryArtifacts(db: D1DatabaseLike, tenantId: string, repositoryId: string, ref: string, configuredNamespace: string): Promise<{ readonly name: string }> {
  const row = await db.prepare("SELECT artifacts_namespace, artifacts_name FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, repositoryId).first<RepositoryArtifactRow>();
  if (!row) throw unavailable(repositoryId, ref, undefined, "not_found", "repository unavailable");
  if (row.artifacts_namespace !== configuredNamespace) throw unavailable(repositoryId, ref, undefined, "unavailable", "repository namespace unavailable");
  if (typeof row.artifacts_name !== "string" || !providerRepositoryNamePattern.test(row.artifacts_name)) throw unavailable(repositoryId, ref, undefined, "unavailable", "repository identity unavailable");
  return { name: row.artifacts_name };
}

// The documented Artifacts repository reads. Over Workers RPC every property looks callable,
// so only these names may be called.
type ArtifactsSourceTreeEntry = { readonly name: string; readonly mode: string; readonly hash: string; readonly type: string };
type ArtifactsSourceRepoHandle = ArtifactsRepoHandle & {
  readonly readCommit: (hash: string) => Promise<{ readonly hash: string; readonly treeHash: string } | null>;
  readonly readTree: (hash: string) => Promise<readonly ArtifactsSourceTreeEntry[] | null>;
  readonly readBlob: (hash: string) => Promise<Blob | null>;
  readonly log: (options?: { readonly ref?: string; readonly limit?: number }) => Promise<readonly { readonly hash: string; readonly treeHash: string }[]>;
};
type ArtifactsTreeCursor = { readonly kind: "artifacts_tree"; readonly resolved_sha: string; readonly path: string; readonly recursive: boolean; readonly limit: number; readonly direction: "asc" | "desc"; readonly offset: number };

const maxArtifactsTreeEntries = 20_000;

async function resolveArtifactsCommit(repo: ArtifactsSourceRepoHandle, repositoryId: string, ref: string): Promise<{ readonly hash: string; readonly treeHash: string }> {
  assertRef(repositoryId, ref);
  const commit = isGitSha(ref) ? await repo.readCommit(ref) : (await repo.log({ ref, limit: 1 }))[0] ?? null;
  if (!commit || !isGitSha(commit.hash) || !isGitSha(commit.treeHash)) throw unavailable(repositoryId, ref, undefined, "not_found", "reference unavailable");
  return commit;
}

async function artifactsTreeAt(repo: ArtifactsSourceRepoHandle, repositoryId: string, ref: string, rootTree: string, path: string): Promise<string> {
  let tree = rootTree;
  for (const segment of path ? path.split("/") : []) {
    const entry = (await repo.readTree(tree))?.find((item) => item.name === segment);
    if (!entry || entry.type !== "tree") throw unavailable(repositoryId, ref, path, "not_found", "tree unavailable");
    tree = entry.hash;
  }
  return tree;
}

function artifactsTreeEntry(entry: ArtifactsSourceTreeEntry, prefix: string): ForgeTreeEntry {
  const mode = (entry.mode === "40000" ? "040000" : entry.mode) as ForgeTreeEntry["mode"];
  const kind = entry.type === "tree" ? "tree" : entry.type === "symlink" ? "symlink" : entry.type === "gitlink" ? "submodule" : "blob";
  return { path: prefix ? `${prefix}/${entry.name}` : entry.name, path_base64: null, mode, kind, sha: entry.hash, size_bytes: null };
}

async function callTree(repo: ArtifactsSourceRepoHandle, input: SourceTreeInput): Promise<ForgeTreePage> {
  const basePath = input.path ?? "";
  assertPath(input.repositoryId, input.ref, basePath);
  const limit = normalizeLimit(input.limit);
  const direction = normalizeDirection(input.direction);
  const recursive = Boolean(input.recursive);
  const cursor = input.cursor ? openArtifactsTreeCursor(input.cursor, input.repositoryId, input.ref) : undefined;
  if (cursor && (cursor.path !== basePath || cursor.recursive !== recursive || cursor.limit !== limit || cursor.direction !== direction)) throw unavailable(input.repositoryId, input.ref, basePath, "invalid_input", "cursor scope mismatch");
  const commit = cursor ? await resolveArtifactsCommit(repo, input.repositoryId, cursor.resolved_sha) : await resolveArtifactsCommit(repo, input.repositoryId, input.ref);
  const treeSha = await artifactsTreeAt(repo, input.repositoryId, input.ref, commit.treeHash, basePath);
  const listed: ForgeTreeEntry[] = [];
  let level: { readonly hash: string; readonly prefix: string }[] = [{ hash: treeSha, prefix: basePath }];
  while (level.length > 0) {
    const read = await Promise.all(level.map(async (tree) => ({ tree, entries: await repo.readTree(tree.hash) })));
    const next: { readonly hash: string; readonly prefix: string }[] = [];
    for (const { tree, entries } of read) {
      if (!entries) throw unavailable(input.repositoryId, input.ref, tree.prefix, "not_found", "tree unavailable");
      for (const entry of entries) {
        const item = artifactsTreeEntry(entry, tree.prefix);
        listed.push(item);
        if (recursive && item.kind === "tree") next.push({ hash: item.sha, prefix: item.path });
      }
    }
    if (listed.length > maxArtifactsTreeEntries) throw unavailable(input.repositoryId, input.ref, basePath, "unsupported", "tree metadata exceeds the read limit");
    level = next;
  }
  const sorted = [...listed].sort((a, b) => direction === "desc" ? b.path.localeCompare(a.path) : a.path.localeCompare(b.path));
  const offset = cursor?.offset ?? 0;
  const hasMore = offset + limit < sorted.length;
  const nextCursor: ArtifactsTreeCursor = { kind: "artifacts_tree", resolved_sha: commit.hash, path: basePath, recursive, limit, direction, offset: offset + limit };
  return { items: sorted.slice(offset, offset + limit), next_cursor: hasMore ? base64UrlEncode(encoder.encode(JSON.stringify(nextCursor))) : null, has_more: hasMore, repository_id: input.repositoryId, resolved_sha: commit.hash, tree_sha: treeSha, truncated: false, truncation_reason: null };
}

// The cursor only selects a page of a commit the caller was already authorized to read.
function openArtifactsTreeCursor(cursor: string, repositoryId: string, ref: string): ArtifactsTreeCursor {
  let value: unknown;
  try { value = JSON.parse(decoder.decode(base64UrlDecode(cursor))) } catch { throw unavailable(repositoryId, ref, undefined, "invalid_input", "cursor invalid") }
  const parsed = value as Partial<ArtifactsTreeCursor>;
  if (!value || typeof value !== "object" || parsed.kind !== "artifacts_tree" || !isGitSha(parsed.resolved_sha ?? "") || typeof parsed.path !== "string" || typeof parsed.recursive !== "boolean" || !Number.isInteger(parsed.limit) || (parsed.direction !== "asc" && parsed.direction !== "desc") || !Number.isInteger(parsed.offset) || (parsed.offset ?? -1) < 0) throw unavailable(repositoryId, ref, undefined, "invalid_input", "cursor invalid");
  return parsed as ArtifactsTreeCursor;
}

async function callDiff(_repo: ArtifactsSourceRepoHandle, input: SourceDiffInput): Promise<ForgeDiffPage> {
  throw unavailable(input.repositoryId, input.head, input.pathPrefix, "unsupported", "provider diff capability unavailable");
}

async function callReadFile(repo: ArtifactsSourceRepoHandle, input: SourceFileInput): Promise<SourceFileResponse> {
  assertPath(input.repositoryId, input.ref, input.path);
  const commit = await resolveArtifactsCommit(repo, input.repositoryId, input.ref);
  const slash = input.path.lastIndexOf("/");
  const parent = await artifactsTreeAt(repo, input.repositoryId, input.ref, commit.treeHash, slash < 0 ? "" : input.path.slice(0, slash));
  const entry = (await repo.readTree(parent))?.find((item) => item.name === input.path.slice(slash + 1));
  if (!entry) throw unavailable(input.repositoryId, input.ref, input.path, "not_found", "path unavailable");
  if (entry.type === "tree" || entry.type === "gitlink") return { repository_id: input.repositoryId, resolved_sha: commit.hash, path: input.path, sha: entry.hash, size_bytes: 0, encoding: "unsupported", contents: null, truncated: false };
  const blob = await repo.readBlob(entry.hash);
  if (!blob) throw unavailable(input.repositoryId, input.ref, input.path, "not_found", "path unavailable");
  const byteLimit = input.maxBytes ?? defaultFileBytes;
  const bytes = new Uint8Array(await blob.slice(0, byteLimit).arrayBuffer());
  const detected = detectText(bytes, blob.size > bytes.byteLength);
  return { repository_id: input.repositoryId, resolved_sha: commit.hash, path: input.path, sha: entry.hash, size_bytes: blob.size, encoding: detected.encoding, contents: detected.contents, truncated: detected.truncated };
}

async function resolveCommit(git: GitCliRunner, gitDir: string, repositoryId: string, ref: string): Promise<string> {
  const resolved = trimText(await git.run(gitDir, ["rev-parse", "--verify", `${ref}^{commit}`]));
  if (!shaPattern.test(resolved)) throw unavailable(repositoryId, ref, undefined, "not_found", "reference unavailable");
  return resolved;
}

async function readBlobPrefix(git: GitCliRunner, gitDir: string, sha: string, limit: number): Promise<{ stdout: Uint8Array; truncated: boolean }> {
  try {
    const result = await git.run(gitDir, ["cat-file", "blob", sha], { maxBuffer: limit + 1 });
    const truncated = result.stdout.byteLength > limit || result.truncated === true;
    return { stdout: result.stdout.slice(0, limit), truncated };
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error && error.stdout instanceof Uint8Array ? error.stdout : new Uint8Array();
    return { stdout: stdout.slice(0, limit), truncated: true };
  }
}

function parseTree(output: string, prefix: string): readonly ForgeTreeEntry[] {
  return output.split("\0").filter(Boolean).map((entry) => treeEntryFromLine(entry, prefix));
}

function firstTreeEntry(output: string, expectedPath: string, repositoryId: string, ref: string): ForgeTreeEntry {
  const entry = output.split("\0").filter(Boolean).map((line) => treeEntryFromLine(line, "")).find((item) => item.path === expectedPath);
  if (!entry) throw unavailable(repositoryId, ref, expectedPath, "not_found", "path unavailable");
  return entry;
}

function treeEntryFromLine(entry: string, prefix: string): ForgeTreeEntry {
  const tab = entry.indexOf("\t");
  const meta = entry.slice(0, tab).trim().split(/ +/);
  const [mode, type, sha, sizeRaw] = meta as [ForgeTreeEntry["mode"], string, string, string | undefined];
  const path = prefix ? `${prefix.replace(/\/$/, "")}/${entry.slice(tab + 1)}` : entry.slice(tab + 1);
  const kind = mode === "040000" || type === "tree" ? "tree" : mode === "120000" ? "symlink" : mode === "160000" || type === "commit" ? "submodule" : "blob";
  const size = sizeRaw && /^\d+$/.test(sizeRaw) ? Number(sizeRaw) : null;
  return { path, path_base64: null, mode, kind, sha, size_bytes: size };
}

function parsePatch(patch: string): readonly ForgeDiffFile[] {
  const files: ForgeDiffFile[] = [];
  let current: MutableDiffFile | undefined;
  let hunk: MutableHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  const finish = () => { if (current) files.push({ ...current, hunks: current.hunks.map((item) => ({ ...item, lines: item.lines })) }); current = undefined; hunk = undefined };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { finish(); current = blankDiffFile(line); continue }
    if (!current) continue;
    if (line.startsWith("index ")) { const match = /^index ([0-9a-f]{40})\.\.([0-9a-f]{40})(?: ([0-7]{6}))?$/.exec(line); if (match) { current.old_sha = zeroToNull(match[1]); current.new_sha = zeroToNull(match[2]); if (match[3]) { current.old_mode ??= match[3]; current.new_mode ??= match[3]; } } continue }
    if (line.startsWith("new file mode ")) { current.change = "added"; current.new_mode = line.slice(14); continue }
    if (line.startsWith("deleted file mode ")) { current.change = "deleted"; current.old_mode = line.slice(18); continue }
    if (line.startsWith("old mode ")) { current.old_mode = line.slice(9); current.change = "type_changed"; continue }
    if (line.startsWith("new mode ")) { current.new_mode = line.slice(9); current.change = "type_changed"; continue }
    if (line.startsWith("similarity index ")) { current.similarity_percent = Number(line.match(/\d+/)?.[0] ?? 0); continue }
    if (line.startsWith("rename from ")) { current.old_path = line.slice(12); current.change = "renamed"; continue }
    if (line.startsWith("rename to ")) { current.new_path = line.slice(10); current.change = "renamed"; continue }
    if (line.startsWith("copy from ")) { current.old_path = line.slice(10); current.change = "copied"; continue }
    if (line.startsWith("copy to ")) { current.new_path = line.slice(8); current.change = "copied"; continue }
    if (line.startsWith("Binary files ")) { current.binary = true; continue }
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]); newLine = Number(hunkMatch[3]);
      hunk = { old_start: oldLine, old_count: Number(hunkMatch[2] ?? 1), new_start: newLine, new_count: Number(hunkMatch[4] ?? 1), header: hunkMatch[5] ?? "", lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line === "\\ No newline at end of file") { const last = hunk.lines[hunk.lines.length - 1]; if (last) last.has_newline = false; continue }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === " ") { hunk.lines.push({ kind: "context", old_line: oldLine++, new_line: newLine++, text, has_newline: true }); continue }
    if (marker === "+") { hunk.lines.push({ kind: "addition", old_line: null, new_line: newLine++, text, has_newline: true }); current.additions += 1; continue }
    if (marker === "-") { hunk.lines.push({ kind: "deletion", old_line: oldLine++, new_line: null, text, has_newline: true }); current.deletions += 1 }
  }
  finish();
  return files;
}

interface MutableHunk { old_start: number; old_count: number; new_start: number; new_count: number; header: string; lines: Array<{ kind: "context" | "addition" | "deletion"; old_line: number | null; new_line: number | null; text: string; has_newline: boolean }> }
interface MutableDiffFile { old_path: string | null; new_path: string | null; old_sha: string | null; new_sha: string | null; change: ForgeDiffFile["change"]; old_mode: string | null; new_mode: string | null; binary: boolean; additions: number; deletions: number; similarity_percent: number | null; hunks: MutableHunk[]; truncated: boolean }

function blankDiffFile(line: string): MutableDiffFile {
  const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  return { old_path: match?.[1] ?? null, new_path: match?.[2] ?? null, old_sha: null, new_sha: null, change: "modified", old_mode: null, new_mode: null, binary: false, additions: 0, deletions: 0, similarity_percent: null, hunks: [], truncated: false };
}

function decodeDiffPatch(bytes: Uint8Array, repositoryId: string, ref: string, path: string | undefined): string {
  try { return strictDecoder.decode(bytes) } catch { throw unavailable(repositoryId, ref, path, "unsupported", "diff encoding unsupported") }
}

function markDiffFilesTruncated(files: readonly ForgeDiffFile[]): readonly ForgeDiffFile[] {
  return files.map((file) => ({ ...file, truncated: true }));
}

function detectText(bytes: Uint8Array, truncated: boolean): { encoding: SourceEncoding; contents: string | null; truncated: boolean } {
  if (bytes.includes(0)) return { encoding: "binary", contents: null, truncated };
  try { return { encoding: "utf-8", contents: truncated ? decodeValidPrefix(bytes) : strictDecoder.decode(bytes), truncated } } catch { return { encoding: "unsupported", contents: null, truncated } }
}

function decodeValidPrefix(bytes: Uint8Array): string {
  for (let trim = 0; trim <= 3; trim += 1) {
    try { return strictDecoder.decode(trim === 0 ? bytes : bytes.slice(0, bytes.length - trim)) } catch { /* retry for truncated multibyte tails */ }
  }
  throw new Error("invalid utf-8");
}

function trimText(result: { readonly stdout: Uint8Array }): string { return decoder.decode(result.stdout).trim() }
function parseLines(value: string): readonly string[] { return value ? value.split(/\r?\n/).filter(Boolean) : [] }
function zeroToNull(value: string | undefined): string | null { return value && !/^0{40}$/.test(value) ? value : null }
function normalizeLimit(limit: number | undefined): number { return Number.isInteger(limit) ? Math.max(1, Math.min(1000, limit ?? 100)) : 100 }
function normalizeDirection(direction: string | undefined): "asc" | "desc" { return direction === "asc" ? "asc" : "desc" }
function normalizeComparison(comparison: string | undefined): "two_dot" | "three_dot" { return comparison === "two_dot" ? "two_dot" : "three_dot" }
function normalizeContext(contextLines: number | undefined): number { return Number.isInteger(contextLines) ? Math.max(0, Math.min(100, contextLines ?? 3)) : 3 }
function assertRef(repositoryId: string, ref: string): void { if (!refPattern.test(ref)) throw unavailable(repositoryId, ref, undefined, "invalid_input", "invalid ref") }
function assertPath(repositoryId: string, ref: string, path: string): void { if (!validateSourcePath(path)) throw unavailable(repositoryId, ref, path, "invalid_input", "invalid path") }
function unavailable(repositoryId: string, ref: string | undefined, path: string | undefined, code: SourceReadFailureCode, reason: string): SourceReadUnavailableError { return new SourceReadUnavailableError({ code, reason, repositoryId, ...(ref ? { ref } : {}), ...(path ? { path } : {}) }) }
// Provider messages can carry credentials, so an unexpected failure is named only by its kind.
function mapSourceError(repositoryId: string, ref: string | undefined, path: string | undefined, error: unknown): SourceReadUnavailableError {
  if (error instanceof SourceReadUnavailableError) return error;
  const kind = error instanceof Error && /^[A-Z][A-Za-z]{0,63}$/u.test(error.name) ? ` (${error.name})` : "";
  return unavailable(repositoryId, ref, path, "unavailable", "source provider unavailable" + kind);
}
function disposeRepo(repo: ArtifactsRepoHandle): void { (repo as Partial<Record<typeof Symbol.dispose, () => void>>)[Symbol.dispose]?.() }

type TreeCursor = { kind: "tree"; tenant_id: string; repository_id: string; ref: string; resolved_sha: string; tree_sha: string; path: string; recursive: boolean; limit: number; direction: "asc" | "desc"; offset: number };
type DiffCursor = { kind: "diff"; tenant_id: string; repository_id: string; base: string; head: string; base_sha: string; head_sha: string; merge_base_shas: readonly string[]; comparison: "two_dot" | "three_dot"; path_prefix: string; context_lines: number; digest: string; limit: number; direction: "asc" | "desc"; offset: number };

async function sealCursor(value: TreeCursor | DiffCursor, secret: string): Promise<string> {
  const payload = stableJson(value);
  const signature = await hmacHex(secret, payload);
  return base64UrlEncode(encoder.encode(JSON.stringify({ payload, signature })));
}

async function openCursor<T extends TreeCursor | DiffCursor>(cursor: string, secret: string, kind: T["kind"], tenantId: string, repositoryId: string): Promise<T> {
  try {
    const envelope = JSON.parse(decoder.decode(base64UrlDecode(cursor))) as { payload?: unknown; signature?: unknown };
    if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("cursor shape");
    if (await hmacHex(secret, envelope.payload) !== envelope.signature) throw new Error("cursor signature");
    const parsed = JSON.parse(envelope.payload) as Record<string, unknown>;
    if (parsed.kind !== kind || parsed.tenant_id !== tenantId || parsed.repository_id !== repositoryId || typeof parsed.offset !== "number" || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error("cursor scope");
    if (kind === "tree" && !isTreeCursor(parsed)) throw new Error("cursor shape");
    if (kind === "diff" && !isDiffCursor(parsed)) throw new Error("cursor shape");
    return parsed as T;
  } catch { throw unavailable(repositoryId, undefined, undefined, "invalid_input", "invalid cursor") }
}

function isTreeCursor(value: Record<string, unknown>): value is TreeCursor {
  return typeof value.ref === "string" && typeof value.resolved_sha === "string" && shaPattern.test(value.resolved_sha) && typeof value.tree_sha === "string" && shaPattern.test(value.tree_sha) && typeof value.path === "string" && typeof value.recursive === "boolean" && typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit > 0 && (value.direction === "asc" || value.direction === "desc");
}

function isDiffCursor(value: Record<string, unknown>): value is DiffCursor {
  return typeof value.base === "string" && typeof value.head === "string" && typeof value.base_sha === "string" && shaPattern.test(value.base_sha) && typeof value.head_sha === "string" && shaPattern.test(value.head_sha) && Array.isArray(value.merge_base_shas) && value.merge_base_shas.every((item) => typeof item === "string" && shaPattern.test(item)) && (value.comparison === "two_dot" || value.comparison === "three_dot") && typeof value.path_prefix === "string" && typeof value.context_lines === "number" && Number.isInteger(value.context_lines) && value.context_lines >= 0 && typeof value.digest === "string" && typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit > 0 && (value.direction === "asc" || value.direction === "desc");
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return hex(new Uint8Array(digest));
}

async function sha256Hex(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value)); return hex(new Uint8Array(digest)) }
function hex(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`; return JSON.stringify(value) }
function base64UrlEncode(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") }
function base64UrlDecode(value: string): Uint8Array { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); const padded = normalized + "===".slice((normalized.length + 3) % 4); const binary = atob(padded); return Uint8Array.from(binary, (char) => char.charCodeAt(0)) }
