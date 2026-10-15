import type { ForgeCommitComparison, ForgeGitPort, ForgeMergeResult, ForgeRef, ForgeRefUpdate, ForgeTreeEntry, ForgeWriteCommitInput } from "../../../../packages/core/src/fork-forge/port.js";

export interface GitCliRunInput {
  readonly arg: readonly string[];
  readonly stdin?: Uint8Array;
  readonly env?: readonly string[];
}

export interface GitCliRunResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface GitCliForgeOptions {
  readonly gitDir: string;
  readonly indexDir: string;
  readonly run: (input: GitCliRunInput) => Promise<GitCliRunResult>;
  readonly maxTreeEntries?: number;
  readonly maxRefEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxChangeBytes?: number;
}

const oidPattern = /^[0-9a-f]{40}$/u;
const refPattern = /^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,240}$/u;
const zeroOid = "0".repeat(40);
const fileModes = new Set(["100644", "100755", "120000"]);

type GitExtra = { readonly stdin?: Uint8Array; readonly env?: readonly string[] };
type ForgeWriteCommitChangeWithMode = ForgeWriteCommitInput["changes"][number] & { readonly mode?: unknown };

export function makeGitCliForgePort(options: GitCliForgeOptions): ForgeGitPort {
  const maxTreeEntries = options.maxTreeEntries ?? 4096;
  const maxRefEntries = options.maxRefEntries ?? 4096;
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  const maxChangeBytes = options.maxChangeBytes ?? 8 * 1024 * 1024;

  async function git(arg: readonly string[], extra: GitExtra = {}): Promise<GitCliRunResult> {
    const request: GitCliRunInput = { arg: ["--git-dir", options.gitDir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "protocol.file.allow=never", ...arg] };
    if (extra.stdin !== undefined) (request as { stdin?: Uint8Array }).stdin = extra.stdin;
    if (extra.env !== undefined) (request as { env?: readonly string[] }).env = extra.env;
    return options.run(request);
  }

  async function gitOk(arg: readonly string[], extra: GitExtra = {}): Promise<Uint8Array> {
    const result = await git(arg, extra);
    if (result.exitCode !== 0) throw new GitCliForgeError("git_failed", sanitize(stderrText(result)));
    return result.stdout;
  }

  return {
    readRef: async (ref) => {
      assertRef(ref);
      const result = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
      if (result.exitCode !== 0) return null;
      const oid = text(result.stdout).trim();
      assertOid(oid, "resolved ref");
      return oid;
    },
    listRefs: async (prefix) => {
      assertRefPrefix(prefix);
      const refs = parseRefs(await gitOk(["for-each-ref", "--format=%(refname)%00%(objectname)%00", prefix]));
      if (refs.length > maxRefEntries) throw new GitCliForgeError("bound_exceeded", "ref listing exceeds entry bound");
      return refs;
    },
    readFile: async (commit, path) => {
      assertOid(commit, "commit");
      assertPath(path);
      const entry = await locateBlob(commit, path);
      if (!entry) return null;
      const blob = await gitOk(["cat-file", "blob", entry.oid]);
      if (blob.byteLength > maxFileBytes) throw new GitCliForgeError("bound_exceeded", "file exceeds read bound");
      return base64Encode(blob);
    },
    listTree: async (commit, prefix = "") => {
      assertOid(commit, "commit");
      if (prefix) assertPath(prefix);
      const args = prefix ? ["ls-tree", "-lz", "-r", "--long", commit, "--", prefix] : ["ls-tree", "-lz", "-r", "--long", commit];
      const entries = parseTree(await gitOk(args));
      if (entries.length > maxTreeEntries) throw new GitCliForgeError("bound_exceeded", "tree listing exceeds entry bound");
      return entries;
    },
    writeCommit: async (input) => {
      const index = indexPath();
      const env = [`GIT_INDEX_FILE=${index}`, "GIT_CONFIG_NOSYSTEM=1", "GIT_ATTR_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", `GIT_AUTHOR_NAME=${input.author.name}`, `GIT_AUTHOR_EMAIL=${input.author.email}`, `GIT_AUTHOR_DATE=${input.timestamp}`, `GIT_COMMITTER_NAME=${input.author.name}`, `GIT_COMMITTER_EMAIL=${input.author.email}`, `GIT_COMMITTER_DATE=${input.timestamp}`];
      validateCommitInput(input);
      if (input.base) await gitOk(["read-tree", `${input.base}^{tree}`], { env });
      else await gitOk(["read-tree", "--empty"], { env });
      for (const change of input.changes) {
        assertPath(change.path);
        if (change.content_base64 === null) {
          if ((change as ForgeWriteCommitChangeWithMode).mode !== undefined) throw new GitCliForgeError("invalid_input", "delete change cannot declare a file mode");
          await removeFromIndex(change.path, env);
          continue;
        }
        const bytes = base64Decode(change.content_base64);
        if (bytes.byteLength > maxChangeBytes) throw new GitCliForgeError("bound_exceeded", "change exceeds write bound");
        const blob = text(await gitOk(["hash-object", "-w", "--stdin"], { stdin: bytes, env })).trim();
        assertOid(blob, "written blob");
        const mode = fileModeForChange(change as ForgeWriteCommitChangeWithMode, await indexMode(change.path, env));
        await gitOk(["update-index", "--add", "--cacheinfo", mode, blob, change.path], { env });
      }
      const tree = text(await gitOk(["write-tree"], { env })).trim();
      assertOid(tree, "written tree");
      const parents = input.parents.flatMap((parent) => ["-p", parent]);
      const commit = text(await gitOk(["commit-tree", tree, ...parents, "-m", input.message], { env })).trim();
      assertOid(commit, "written commit");
      return commit;
    },
    compareCommits: async (base, head) => {
      assertOid(base, "base");
      assertOid(head, "head");
      return { files: parseNameStatus(await gitOk(["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", base, head])) } satisfies ForgeCommitComparison;
    },
    mergeCommits: async (input) => {
      assertOid(input.base, "base");
      assertOid(input.left, "left");
      assertOid(input.right, "right");
      validateAuthor(input.author);
      assertMessage(input.message);
      assertTimestamp(input.timestamp);
      const leftContainsBase = await isAncestor(input.base, input.left);
      const rightContainsBase = await isAncestor(input.base, input.right);
      if (!leftContainsBase || !rightContainsBase) throw new GitCliForgeError("stale_input", "merge inputs do not retain the declared base");
      const merged = await git(["merge-tree", "--write-tree", input.left, input.right]);
      if (merged.exitCode !== 0) return { status: "conflict", paths: await conflictPaths(input.left, input.right) } satisfies ForgeMergeResult;
      const tree = text(merged.stdout).trim().split(/\s+/u)[0] ?? "";
      assertOid(tree, "merge tree");
      const env = ["GIT_CONFIG_NOSYSTEM=1", "GIT_ATTR_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", `GIT_AUTHOR_NAME=${input.author.name}`, `GIT_AUTHOR_EMAIL=${input.author.email}`, `GIT_AUTHOR_DATE=${input.timestamp}`, `GIT_COMMITTER_NAME=${input.author.name}`, `GIT_COMMITTER_EMAIL=${input.author.email}`, `GIT_COMMITTER_DATE=${input.timestamp}`];
      const commit = text(await gitOk(["commit-tree", tree, "-p", input.left, "-p", input.right, "-m", input.message], { env })).trim();
      assertOid(commit, "merge commit");
      return { status: "merged", commit } satisfies ForgeMergeResult;
    },
    compareAndSwapRef: (ref, expected, next) => compareAndSwapRefs([{ ref, expected, next }]),
    compareAndSwapRefs,
    isAncestor
  };

  async function compareAndSwapRefs(updates: readonly ForgeRefUpdate[]): Promise<boolean> {
    if (updates.length < 1 || updates.length > 16) throw new GitCliForgeError("invalid_input", "ref transaction size is invalid");
    const lines = ["start"];
    for (const update of updates) {
      assertRef(update.ref);
      if (update.expected !== null) assertOid(update.expected, "expected");
      if (update.next !== null) assertOid(update.next, "next");
      const expected = update.expected ?? zeroOid;
      lines.push(update.next === null ? `delete ${update.ref} ${expected}` : `update ${update.ref} ${update.next} ${expected}`);
    }
    lines.push("prepare", "commit", "");
    const result = await git(["update-ref", "--stdin"], { stdin: new TextEncoder().encode(lines.join("\n")) });
    return result.exitCode === 0;
  }

  async function isAncestor(base: string, head: string): Promise<boolean> {
    assertOid(base, "base");
    assertOid(head, "head");
    const result = await git(["merge-base", "--is-ancestor", base, head]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitCliForgeError("git_failed", sanitize(stderrText(result)));
  }

  async function locateBlob(commit: string, path: string): Promise<ForgeTreeEntry | null> {
    const entries = parseTree(await gitOk(["ls-tree", "-z", "--long", commit, "--", path]));
    return entries.find((candidate) => candidate.path === path && candidate.type === "blob") ?? null;
  }

  async function conflictPaths(left: string, right: string): Promise<readonly string[]> {
    const stdout = await gitOk(["diff", "--name-only", "-z", left, right]);
    return text(stdout).split("\u0000").filter((path) => path.length > 0).sort();
  }

  async function removeFromIndex(path: string, env: readonly string[]): Promise<void> {
    const frame = new TextEncoder().encode(`0 ${zeroOid}\t${path}\u0000`);
    await gitOk(["update-index", "-z", "--index-info"], { stdin: frame, env });
  }
  async function indexMode(path: string, env: readonly string[]): Promise<string | undefined> {
    const result = await git(["ls-files", "-s", "-z", "--", path], { env });
    if (result.exitCode !== 0) throw new GitCliForgeError("git_failed", sanitize(stderrText(result)));
    const output = text(result.stdout);
    if (!output) return undefined;
    const separator = output.indexOf(" ");
    const mode = separator > 0 ? output.slice(0, separator) : "";
    if (!isFileMode(mode)) throw new GitCliForgeError("invalid_input", "existing file mode is unsupported");
    return mode;
  }

  function indexPath(): string {
    return `${options.indexDir.replace(/\/+$/u, "")}/gfy-index-${crypto.randomUUID()}`;
  }
}

export class GitCliForgeError extends Error {
  readonly name = "GitCliForgeError";
  constructor(readonly code: "invalid_input" | "bound_exceeded" | "git_failed" | "stale_input", message: string) { super(message) }
}

function parseRefs(stdout: Uint8Array): ForgeRef[] {
  const parts = text(stdout).replaceAll("\u0000\n", "\u0000").split("\u0000").filter((part) => part.length > 0);
  if (parts.length % 2 !== 0) throw new GitCliForgeError("git_failed", "unexpected ref listing output");
  const refs: ForgeRef[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const ref = parts[index] ?? "";
    const target = parts[index + 1] ?? "";
    assertRef(ref);
    assertOid(target, "ref target");
    refs.push({ ref, target });
  }
  return refs;
}

function parseTree(stdout: Uint8Array): ForgeTreeEntry[] {
  const chunks = text(stdout).split("\u0000").filter((chunk) => chunk.length > 0);
  return chunks.map((chunk) => {
    const tab = chunk.indexOf("\t");
    if (tab < 0) throw new GitCliForgeError("git_failed", "unexpected tree output");
    const meta = chunk.slice(0, tab).trim().split(/\s+/u);
    const path = chunk.slice(tab + 1);
    const [mode, type, oid, sizeText] = meta;
    if (!mode || !type || !oid) throw new GitCliForgeError("git_failed", "unexpected tree entry");
    assertOid(oid, "tree entry");
    assertPath(path);
    const entry: ForgeTreeEntry = { path, mode, type: type as ForgeTreeEntry["type"], oid };
    if (sizeText && sizeText !== "-") (entry as { size?: number }).size = Number(sizeText);
    return entry;
  });
}

function parseNameStatus(stdout: Uint8Array): ForgeCommitComparison["files"] {
  const parts = text(stdout).split("\u0000").filter((part) => part.length > 0);
  const files: Array<ForgeCommitComparison["files"][number]> = [];
  for (let index = 0; index < parts.length;) {
    const statusText = parts[index++] ?? "";
    if (statusText.startsWith("R")) {
      const oldPath = parts[index++] ?? "";
      const newPath = parts[index++] ?? "";
      assertPath(oldPath);
      assertPath(newPath);
      files.push({ path: newPath, status: "renamed" });
      continue;
    }
    const path = parts[index++] ?? "";
    assertPath(path);
    files.push({ path, status: normalizeStatus(statusText) });
  }
  return files;
}

function normalizeStatus(status: string): ForgeCommitComparison["files"][number]["status"] {
  switch (status[0]) {
    case "A": return "added";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    default: return "modified";
  }
}

function fileModeForChange(change: ForgeWriteCommitChangeWithMode, existingMode: string | undefined): string {
  if (change.mode === undefined) return existingMode ?? "100644";
  if (!isFileMode(change.mode)) throw new GitCliForgeError("invalid_input", "file mode is invalid");
  return change.mode;
}

function isFileMode(value: unknown): value is string {
  return typeof value === "string" && fileModes.has(value);
}

function validateCommitInput(input: ForgeWriteCommitInput): void {
  if (input.base !== null) assertOid(input.base, "base");
  for (const parent of input.parents) assertOid(parent, "parent");
  if (input.base === null && input.parents.length !== 0) throw new GitCliForgeError("invalid_input", "root commit cannot declare parents without a base tree");
  validateAuthor(input.author);
  assertTimestamp(input.timestamp);
  assertMessage(input.message);
  if (input.changes.length === 0) throw new GitCliForgeError("invalid_input", "commit must contain at least one change");
}

function validateAuthor(author: { readonly name: string; readonly email: string }): void {
  if (!boundedText(author.name, 256) || !boundedText(author.email, 320) || !/^[^@\s\u0000]+@[^@\s\u0000]+$/u.test(author.email)) throw new GitCliForgeError("invalid_input", "author is invalid");
}

function assertTimestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new GitCliForgeError("invalid_input", "timestamp must be exact UTC ISO time");
}

function assertMessage(value: string): void {
  if (!boundedText(value, 8192)) throw new GitCliForgeError("invalid_input", "message is invalid");
}

function boundedText(value: string, maxBytes: number): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000") && new TextEncoder().encode(value).byteLength <= maxBytes;
}

function assertOid(value: string, field: string): void {
  if (!oidPattern.test(value) || value === zeroOid) throw new GitCliForgeError("invalid_input", `${field} must be a lowercase Git object ID`);
}

function assertRef(value: string): void {
  if (!refPattern.test(value) || value.includes("//") || value.endsWith("/") || value.includes("..") || value.includes("@{")) throw new GitCliForgeError("invalid_input", "ref is invalid");
}

function assertRefPrefix(value: string): void {
  if (!value.endsWith("/") || !refPattern.test(value.slice(0, -1)) || value.includes("//") || value.includes("..") || value.includes("@{")) throw new GitCliForgeError("invalid_input", "ref prefix is invalid");
}

function assertPath(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\u0000") || value.startsWith("/") || value === "." || value === ".." || value.startsWith("../") || value.includes("/../") || value.endsWith("/..") || value === ".git" || value.startsWith(".git/")) throw new GitCliForgeError("invalid_input", "path is invalid");
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stderrText(result: GitCliRunResult): string {
  return text(result.stderr.byteLength > 0 ? result.stderr : result.stdout);
}

function sanitize(value: string): string {
  return value.replace(/\b[A-Za-z0-9_=-]{24,}\b/gu, "[redacted]").slice(0, 2048);
}

function base64Decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) throw new GitCliForgeError("invalid_input", "content is not base64");
  const decoded = atob(value);
  const out = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) out[i] = decoded.charCodeAt(i);
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}
