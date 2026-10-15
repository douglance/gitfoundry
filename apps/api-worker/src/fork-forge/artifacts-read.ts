import type { ForgeGitPort, ForgeRef, ForgeTreeEntry } from "@gitfoundry/core";

import { CloudForgeGitError } from "./cloud-git.js";

// Forge reads answered by Artifacts itself: refs from the Git ref advertisement, objects
// through the repository's read methods. Writes still go through the trusted helper, which
// starts a container and fetches the whole repository for every call.
export interface ArtifactsReadRepo {
  readonly info: () => Promise<{ readonly name: string; readonly remote?: string | null }>;
  readonly createToken: (scope: "read", ttl?: number) => Promise<{ readonly plaintext?: string }>;
  readonly revokeToken?: (token: string) => Promise<boolean>;
  readonly readCommit: (hash: string) => Promise<{ readonly hash: string; readonly treeHash: string } | null>;
  readonly readTree: (hash: string) => Promise<readonly { readonly name: string; readonly mode: string; readonly hash: string; readonly type: string }[] | null>;
  readonly readBlob: (hash: string) => Promise<Blob | null>;
}

export type ArtifactsForgeReads = Pick<ForgeGitPort, "readRef" | "listRefs" | "readFile" | "listTree"> & { readonly invalidate: () => void };

const oidPattern = /^[0-9a-f]{40}$/u;
const maxFileBytes = 8 * 1024 * 1024;
const maxEntries = 4096;
const tokenTtlSeconds = 120;

export function makeArtifactsForgeReads(options: { readonly repo: () => Promise<ArtifactsReadRepo>; readonly fetch: (request: Request) => Promise<Response> }): ArtifactsForgeReads {
  // One request reads refs from a single advertisement; any write by this port drops it, so the
  // next read sees the write and anything a concurrent writer did.
  let cached: Promise<readonly ForgeRef[]> | undefined;
  const advertisedRefs = (): Promise<readonly ForgeRef[]> => {
    cached ??= fetchAdvertisedRefs().catch((error) => { cached = undefined; throw error });
    return cached;
  };
  async function fetchAdvertisedRefs(): Promise<readonly ForgeRef[]> {
    const repo = await options.repo();
    const remote = (await repo.info()).remote;
    if (!remote) throw unavailable("repository remote unavailable");
    const token = (await repo.createToken("read", tokenTtlSeconds)).plaintext;
    if (!token) throw unavailable("repository read credential unavailable");
    try {
      const response = await options.fetch(new Request(remote.replace(/\/$/u, "") + "/info/refs?service=git-upload-pack", { headers: { authorization: "Basic " + btoa("x-access-token:" + token), "user-agent": "git/gitfoundry" } }));
      if (!response.ok) throw new CloudForgeGitError("provider_unavailable", "repository refs unavailable", undefined, { provider_status: response.status });
      return parseAdvertisement(await response.text());
    } finally {
      await repo.revokeToken?.(token).catch(() => false);
    }
  }

  async function rootTree(commit: string): Promise<{ readonly repo: ArtifactsReadRepo; readonly tree: string } | null> {
    if (!oidPattern.test(commit)) throw new CloudForgeGitError("invalid_input", "commit is invalid");
    const repo = await options.repo();
    const read = await repo.readCommit(commit);
    return read ? { repo, tree: read.treeHash } : null;
  }

  async function treeAt(repo: ArtifactsReadRepo, tree: string, path: string): Promise<string | null> {
    let current = tree;
    for (const segment of path ? path.split("/") : []) {
      const entry = (await repo.readTree(current))?.find((item) => item.name === segment);
      if (!entry || entry.type !== "tree") return null;
      current = entry.hash;
    }
    return current;
  }

  return {
    invalidate: () => { cached = undefined },
    readRef: async (ref) => (await advertisedRefs()).find((entry) => entry.ref === ref)?.target ?? null,
    listRefs: async (prefix) => {
      const refs = (await advertisedRefs()).filter((entry) => entry.ref.startsWith(prefix));
      if (refs.length > maxEntries) throw new CloudForgeGitError("trusted_response_invalid", "ref listing exceeds entry bound");
      return refs;
    },
    readFile: async (commit, path) => {
      const root = await rootTree(commit);
      if (!root) return null;
      const slash = path.lastIndexOf("/");
      const parent = await treeAt(root.repo, root.tree, slash < 0 ? "" : path.slice(0, slash));
      const entry = parent ? (await root.repo.readTree(parent))?.find((item) => item.name === path.slice(slash + 1)) : undefined;
      if (!entry || entry.type === "tree" || entry.type === "gitlink") return null;
      const blob = await root.repo.readBlob(entry.hash);
      if (!blob) return null;
      if (blob.size > maxFileBytes) throw new CloudForgeGitError("trusted_response_invalid", "file exceeds read bound");
      return base64(new Uint8Array(await blob.arrayBuffer()));
    },
    listTree: async (commit, rawPrefix = "") => {
      // Git lists a folder's contents whether or not its name ends in "/".
      const prefix = rawPrefix.replace(/\/+$/u, "");
      const root = await rootTree(commit);
      if (!root) throw new CloudForgeGitError("invalid_input", "commit unavailable");
      const files: ForgeTreeEntry[] = [];
      const walk = async (tree: string, base: string): Promise<void> => {
        for (const entry of (await root.repo.readTree(tree)) ?? []) {
          const path = base ? `${base}/${entry.name}` : entry.name;
          if (entry.type === "tree") await walk(entry.hash, path);
          else files.push({ path, oid: entry.hash, mode: entry.mode, type: entry.type === "gitlink" ? "commit" : "blob" });
          if (files.length > maxEntries) throw new CloudForgeGitError("trusted_response_invalid", "tree listing exceeds entry bound");
        }
      };
      const start = prefix ? await treeAt(root.repo, root.tree, prefix) : root.tree;
      if (start) await walk(start, prefix);
      else if (prefix) {
        // A prefix naming a file lists that file, as a Git pathspec does.
        const slash = prefix.lastIndexOf("/");
        const parent = await treeAt(root.repo, root.tree, slash < 0 ? "" : prefix.slice(0, slash));
        const entry = parent ? (await root.repo.readTree(parent))?.find((item) => item.name === prefix.slice(slash + 1)) : undefined;
        if (entry && entry.type !== "tree") files.push({ path: prefix, oid: entry.hash, mode: entry.mode, type: entry.type === "gitlink" ? "commit" : "blob" });
      }
      return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }
  };
}

function parseAdvertisement(body: string): readonly ForgeRef[] {
  const refs: ForgeRef[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.slice(offset, offset + 4), 16);
    if (!Number.isInteger(length)) throw unavailable("repository refs unreadable");
    if (length === 0) { offset += 4; continue; }
    const line = body.slice(offset + 4, offset + length).replace(/\n$/u, "");
    offset += length;
    if (line.startsWith("#")) continue;
    const [oid, rest = ""] = line.split(" ", 2);
    const ref = rest.split("\0")[0] ?? "";
    if (oidPattern.test(oid ?? "") && ref.startsWith("refs/") && !ref.endsWith("^{}") && !/^0{40}$/u.test(oid!)) refs.push({ ref, target: oid! });
  }
  return refs;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function unavailable(message: string): CloudForgeGitError { return new CloudForgeGitError("provider_unavailable", message) }
