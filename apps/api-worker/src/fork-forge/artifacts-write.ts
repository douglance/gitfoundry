import type { ForgeCommitComparison, ForgeGitPort, ForgeMergeInput, ForgeMergeResult, ForgeRefUpdate, ForgeWriteCommitInput } from "@gitfoundry/core";

import { CloudForgeGitError } from "./cloud-git.js";

// Forge writes answered by the Worker itself: objects are built in memory and pushed to Artifacts
// over Git's smart HTTP receive-pack, whose atomic ref update is the compare-and-swap. Nothing here
// starts a container, so concurrent agents write in parallel and a stale writer learns it at once.
export interface ArtifactsWriteRepo {
  readonly info: () => Promise<{ readonly name: string; readonly remote?: string | null }>;
  readonly createToken: (scope: "read" | "write", ttl?: number) => Promise<{ readonly plaintext?: string }>;
  readonly revokeToken?: (token: string) => Promise<boolean>;
  readonly readCommit: (hash: string) => Promise<{ readonly hash: string; readonly treeHash: string; readonly parents: readonly string[] } | null>;
  readonly readTree: (hash: string) => Promise<readonly { readonly name: string; readonly mode: string; readonly hash: string; readonly type: string }[] | null>;
  readonly readBlob: (hash: string) => Promise<Blob | null>;
}

export type ArtifactsForgeWrites = Pick<ForgeGitPort, "writeCommit" | "compareAndSwapRef" | "compareAndSwapRefs" | "isAncestor" | "compareCommits" | "mergeCommits">;

const oidPattern = /^[0-9a-f]{40}$/u;
const refPattern = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const zeroOid = "0".repeat(40);
const fileModes = new Set(["100644", "100755", "120000"]);
const maxChangeBytes = 8 * 1024 * 1024;
const maxAncestorWalk = 20_000;
const tokenTtlSeconds = 300;
const pushAttempts = 5;
const pushRetryMs = 100;
const encoder = new TextEncoder();
const typeCodes = { commit: 1, tree: 2, blob: 3 } as const;

type ObjectType = keyof typeof typeCodes;
interface GitObject { readonly type: ObjectType; readonly body: Uint8Array; readonly oid: string }
interface TreeEntry { readonly name: string; readonly mode: string; readonly oid: string }

export function makeArtifactsForgeWrites(options: {
  readonly repo: () => Promise<ArtifactsWriteRepo>;
  readonly fetch: (request: Request) => Promise<Response>;
  // Merges whose files changed on both sides need a line-level merge, which the trusted helper does.
  readonly mergeFallback?: (input: ForgeMergeInput) => Promise<ForgeMergeResult>;
  // Called after every push, accepted or not, so cached reads never hide a ref change.
  readonly afterWrite?: () => void;
}): ArtifactsForgeWrites {
  async function receivePack(commands: readonly { readonly ref: string; readonly expected: string | null; readonly next: string | null }[], objects: readonly GitObject[]): Promise<Map<string, string | null>> {
    const repo = await options.repo();
    const remote = (await repo.info()).remote;
    if (!remote) throw unavailable("repository remote unavailable");
    const token = (await repo.createToken("write", tokenTtlSeconds)).plaintext;
    if (!token) throw unavailable("repository write credential unavailable");
    try {
      const lines = commands.map((command, index) => pkt(`${command.expected ?? zeroOid} ${command.next ?? zeroOid} ${command.ref}${index === 0 ? "\0report-status atomic" : ""}\n`));
      const body = concat([...lines, encoder.encode("0000"), ...(commands.every((command) => command.next === null) ? [] : [await packObjects(objects)])]);
      for (let attempt = 1; ; attempt++) {
        const response = await options.fetch(new Request(remote.replace(/\/$/u, "") + "/git-receive-pack", {
          method: "POST",
          headers: { authorization: "Basic " + btoa("x-access-token:" + token), "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result", "user-agent": "git/gitfoundry" },
          body: body as BodyInit
        }));
        if (!response.ok) throw new CloudForgeGitError("provider_unavailable", "repository push unavailable", undefined, { provider_status: response.status });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const report = parseReportStatus(bytes);
        if (report) return report;
        // When pushes to one repository overlap, the provider sometimes answers without running the push:
        // there is no unpack result, so no ref moved. Send it again after a short, jittered wait.
        if (attempt === pushAttempts) throw new CloudForgeGitError("provider_unavailable", "push unpack failed", undefined, { helper_detail: "unpack missing: " + printable(bytes) });
        await new Promise((resolve) => setTimeout(resolve, pushRetryMs * 2 ** (attempt - 1) * (1 + Math.random())));
      }
    } finally {
      options.afterWrite?.();
      await repo.revokeToken?.(token).catch(() => false);
    }
  }

  async function treeEntries(oid: string): Promise<TreeEntry[]> {
    const entries = await (await options.repo()).readTree(oid);
    if (!entries) throw new CloudForgeGitError("invalid_input", "tree unavailable");
    return entries.map((entry) => ({ name: entry.name, mode: entry.mode === "040000" ? "40000" : entry.mode, oid: entry.hash }));
  }

  async function commitTree(commit: string): Promise<string> {
    const read = await (await options.repo()).readCommit(commit);
    if (!read) throw new CloudForgeGitError("invalid_input", "commit unavailable");
    return read.treeHash;
  }

  // Applies file changes below one tree, returning the new tree's object ID and every new object.
  async function applyChanges(treeOid: string | null, changes: readonly { readonly segments: readonly string[]; readonly content: Uint8Array | null; readonly mode?: string }[], written: GitObject[]): Promise<string | null> {
    const entries = new Map((treeOid ? await treeEntries(treeOid) : []).map((entry) => [entry.name, entry]));
    const nested = new Map<string, typeof changes[number][]>();
    for (const change of changes) {
      const [head, ...rest] = change.segments;
      if (!head) throw new CloudForgeGitError("invalid_input", "change path is invalid");
      if (rest.length) {
        nested.set(head, [...(nested.get(head) ?? []), { ...change, segments: rest }]);
        continue;
      }
      if (change.content === null) {
        if (entries.get(head)?.mode !== "40000") entries.delete(head);
        continue;
      }
      const existing = entries.get(head);
      const mode = change.mode ?? (existing && fileModes.has(existing.mode) ? existing.mode : "100644");
      const blob = await gitObject("blob", change.content);
      written.push(blob);
      entries.set(head, { name: head, mode, oid: blob.oid });
    }
    for (const [name, children] of nested) {
      const existing = entries.get(name);
      if (existing && existing.mode !== "40000") entries.delete(name);
      const child = await applyChanges(existing?.mode === "40000" ? existing.oid : null, children, written);
      if (child) entries.set(name, { name, mode: "40000", oid: child });
      else entries.delete(name);
    }
    if (entries.size === 0) return null;
    const tree = await gitObject("tree", encodeTree([...entries.values()]));
    written.push(tree);
    return tree.oid;
  }

  async function isAncestor(base: string, head: string): Promise<boolean> {
    assertOid(base, "base");
    assertOid(head, "head");
    const repo = await options.repo();
    const seen = new Set<string>();
    const queue = [head];
    while (queue.length) {
      const next = queue.shift()!;
      if (next === base) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      if (seen.size > maxAncestorWalk) throw new CloudForgeGitError("trusted_response_invalid", "ancestry walk exceeds bound");
      const commit = await repo.readCommit(next);
      if (!commit) throw new CloudForgeGitError("invalid_input", "commit unavailable");
      queue.push(...commit.parents);
    }
    return false;
  }

  async function flatten(treeOid: string | null, base = ""): Promise<Map<string, { readonly oid: string; readonly mode: string }>> {
    const files = new Map<string, { readonly oid: string; readonly mode: string }>();
    if (!treeOid) return files;
    for (const entry of await treeEntries(treeOid)) {
      const path = base ? `${base}/${entry.name}` : entry.name;
      if (entry.mode === "40000") for (const [child, value] of await flatten(entry.oid, path)) files.set(child, value);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return files;
  }

  async function compareAndSwapRefs(updates: readonly ForgeRefUpdate[]): Promise<boolean> {
    if (updates.length < 1 || updates.length > 16) throw new CloudForgeGitError("invalid_input", "ref transaction size is invalid");
    for (const update of updates) {
      if (!refPattern.test(update.ref)) throw new CloudForgeGitError("invalid_input", "ref is invalid");
      if (update.expected !== null) assertOid(update.expected, "expected");
      if (update.next !== null) assertOid(update.next, "next");
    }
    const report = await receivePack(updates, []);
    return updates.every((update) => report.get(update.ref) === null);
  }

  return {
    writeCommit: async (input: ForgeWriteCommitInput) => {
      if (input.base !== null) assertOid(input.base, "base");
      for (const parent of input.parents) assertOid(parent, "parent");
      const changes = input.changes.map((change) => {
        if (!isSafePath(change.path)) throw new CloudForgeGitError("invalid_input", "change path is invalid");
        if (change.content_base64 === null) {
          if (change.mode !== undefined) throw new CloudForgeGitError("invalid_input", "delete change cannot declare a file mode");
          return { segments: change.path.split("/"), content: null };
        }
        if (change.mode !== undefined && !fileModes.has(change.mode)) throw new CloudForgeGitError("invalid_input", "file mode is invalid");
        const content = base64Decode(change.content_base64);
        if (content.byteLength > maxChangeBytes) throw new CloudForgeGitError("invalid_input", "change exceeds write bound");
        return { segments: change.path.split("/"), content, ...(change.mode ? { mode: change.mode } : {}) };
      });
      const written: GitObject[] = [];
      const tree = (await applyChanges(input.base ? await commitTree(input.base) : null, changes, written)) ?? (written.push(await gitObject("tree", new Uint8Array())), written.at(-1)!.oid);
      const when = gitTime(input.timestamp);
      const person = `${input.author.name} <${input.author.email}> ${when}`;
      const commit = await gitObject("commit", encoder.encode(`tree ${tree}\n${input.parents.map((parent) => `parent ${parent}\n`).join("")}author ${person}\ncommitter ${person}\n\n${input.message.endsWith("\n") ? input.message : input.message + "\n"}`));
      written.push(commit);
      // The retained object ref keeps the new commit reachable until a forge ref takes it.
      const ref = "refs/heads/retained/objects/" + commit.oid;
      const report = await receivePack([{ ref, expected: null, next: commit.oid }], dedupe(written));
      const status = report.get(ref);
      if (status !== null && status !== "stale ref") throw new CloudForgeGitError("provider_unavailable", "commit push rejected", undefined, { helper_detail: status ?? "missing" });
      return commit.oid;
    },
    compareAndSwapRef: (ref, expected, next) => compareAndSwapRefs([{ ref, expected, next }]),
    compareAndSwapRefs,
    isAncestor,
    compareCommits: async (base, head): Promise<ForgeCommitComparison> => {
      assertOid(base, "base");
      assertOid(head, "head");
      const [left, right] = await Promise.all([flatten(await commitTree(base)), flatten(await commitTree(head))]);
      const files: { path: string; status: "added" | "modified" | "deleted"; old_oid: string | null; new_oid: string | null }[] = [];
      for (const path of new Set([...left.keys(), ...right.keys()])) {
        const before = left.get(path), after = right.get(path);
        if (before && after && before.oid === after.oid && before.mode === after.mode) continue;
        files.push({ path, status: !before ? "added" : !after ? "deleted" : "modified", old_oid: before?.oid ?? null, new_oid: after?.oid ?? null });
      }
      return { files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
    },
    mergeCommits: async (input: ForgeMergeInput): Promise<ForgeMergeResult> => {
      assertOid(input.base, "base");
      assertOid(input.left, "left");
      assertOid(input.right, "right");
      if (!(await isAncestor(input.base, input.left)) || !(await isAncestor(input.base, input.right))) throw new CloudForgeGitError("invalid_input", "merge inputs do not retain the declared base");
      const [base, left, right] = await Promise.all([input.base, input.left, input.right].map(async (commit) => flatten(await commitTree(commit))));
      const changes: { path: string; content_base64: string | null; mode?: "100644" | "100755" | "120000" }[] = [];
      const conflicts: string[] = [];
      for (const path of new Set([...base!.keys(), ...left!.keys(), ...right!.keys()])) {
        const was = base!.get(path), ours = left!.get(path), theirs = right!.get(path);
        const same = (a?: { oid: string; mode: string }, b?: { oid: string; mode: string }) => a?.oid === b?.oid && a?.mode === b?.mode;
        if (same(ours, theirs) || same(theirs, was)) continue;
        if (!same(ours, was)) { conflicts.push(path); continue; }
        if (!theirs) { changes.push({ path, content_base64: null }); continue; }
        const blob = await (await options.repo()).readBlob(theirs.oid);
        if (!blob) throw new CloudForgeGitError("invalid_input", "blob unavailable");
        changes.push({ path, content_base64: base64Encode(new Uint8Array(await blob.arrayBuffer())), mode: theirs.mode as "100644" });
      }
      if (conflicts.length) {
        if (options.mergeFallback) {
          // The helper merges same-file edits line by line; when it cannot, report only files both sides changed.
          const fallback = await options.mergeFallback(input);
          if (fallback.status === "merged") return fallback;
        }
        return { status: "conflict", paths: conflicts.sort() };
      }
      const writes = makeArtifactsForgeWrites(options);
      const commit = await writes.writeCommit({ base: input.left, parents: [input.left, input.right], changes, message: input.message, author: input.author, timestamp: input.timestamp });
      return { status: "merged", commit };
    }
  };
}

// The ref statuses of a push, or null when the response carries no unpack result because the push did not run.
function parseReportStatus(bytes: Uint8Array): Map<string, string | null> | null {
  const text = new TextDecoder().decode(bytes);
  const statuses = new Map<string, string | null>();
  let offset = 0;
  let unpack: string | null = null;
  while (offset + 4 <= text.length) {
    const length = Number.parseInt(text.slice(offset, offset + 4), 16);
    if (!Number.isInteger(length)) throw unavailable("push report unreadable");
    if (length === 0) { offset += 4; continue; }
    const line = text.slice(offset + 4, offset + length).replace(/\n$/u, "");
    offset += length;
    if (line.startsWith("unpack ")) { unpack = line.slice(7); continue; }
    if (line.startsWith("ok ")) statuses.set(line.slice(3), null);
    else if (line.startsWith("ng ")) { const rest = line.slice(3); const space = rest.indexOf(" "); statuses.set(rest.slice(0, space), rest.slice(space + 1)); }
  }
  if (unpack === null) return null;
  if (unpack !== "ok") throw new CloudForgeGitError("provider_unavailable", "push unpack failed", undefined, { helper_detail: "unpack " + printable(encoder.encode(unpack)) });
  return statuses;
}

function printable(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.subarray(0, 400)).replace(/[^A-Za-z0-9 .,:/_-]+/gu, " ").trim().slice(0, 120) || "empty";
}

async function gitObject(type: ObjectType, body: Uint8Array): Promise<GitObject> {
  return { type, body, oid: hex(await sha1(concat([encoder.encode(`${type} ${body.length}\0`), body]))) };
}

function encodeTree(entries: readonly TreeEntry[]): Uint8Array {
  const key = (entry: TreeEntry) => entry.mode === "40000" ? entry.name + "/" : entry.name;
  const sorted = [...entries].sort((a, b) => compareBytes(encoder.encode(key(a)), encoder.encode(key(b))));
  return concat(sorted.flatMap((entry) => [encoder.encode(`${entry.mode} ${entry.name}\0`), unhex(entry.oid)]));
}

async function packObjects(objects: readonly GitObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const object of objects) {
    let size = object.body.length;
    const bytes: number[] = [];
    let byte = (typeCodes[object.type] << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size > 0) { bytes.push(byte | 0x80); byte = size & 0x7f; size = Math.floor(size / 128); }
    bytes.push(byte);
    parts.push(Uint8Array.from(bytes), await deflate(object.body));
  }
  const body = concat(parts);
  return concat([body, await sha1(body)]);
}

function dedupe(objects: readonly GitObject[]): GitObject[] {
  const seen = new Set<string>();
  return objects.filter((object) => !seen.has(object.oid) && Boolean(seen.add(object.oid)));
}

function gitTime(timestamp: string): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) throw new CloudForgeGitError("invalid_input", "timestamp is invalid");
  return `${Math.floor(millis / 1000)} +0000`;
}

function isSafePath(path: string): boolean {
  if (!path || path.length > 4096 || path.startsWith("/") || path.endsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

function assertOid(value: string, name: string): void { if (!oidPattern.test(value)) throw new CloudForgeGitError("invalid_input", `${name} is invalid`) }
function unavailable(message: string): CloudForgeGitError { return new CloudForgeGitError("provider_unavailable", message) }
function pkt(line: string): Uint8Array { const bytes = encoder.encode(line); return concat([encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes]) }
async function sha1(bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>)) }
async function deflate(bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer()) }
function hex(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") }
function unhex(value: string): Uint8Array { return Uint8Array.from(value.match(/../gu)!, (pair) => Number.parseInt(pair, 16)) }
function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out }
function compareBytes(a: Uint8Array, b: Uint8Array): number { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return a.length - b.length }
function base64Decode(value: string): Uint8Array { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)) }
function base64Encode(bytes: Uint8Array): string { let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary) }
