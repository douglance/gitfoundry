import type { ForgeFileMode } from "./model.js";

export interface ForgeTreeEntry {
  readonly path: string;
  readonly oid: string;
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly size?: number;
}

export interface ForgeCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface ForgeWriteCommitChange {
  readonly path: string;
  readonly content_base64: string | null;
  readonly mode?: ForgeFileMode;
}

export interface ForgeWriteCommitInput {
  readonly base: string | null;
  readonly parents: readonly string[];
  readonly changes: readonly ForgeWriteCommitChange[];
  readonly message: string;
  readonly author: ForgeCommitAuthor;
  readonly timestamp: string;
}

export interface ForgeCommitComparison {
  readonly files: readonly {
    readonly path: string;
    readonly status: "added" | "modified" | "deleted" | "renamed" | "unchanged";
    readonly old_oid?: string | null;
    readonly new_oid?: string | null;
  }[];
}

export interface ForgeMergeInput {
  readonly base: string;
  readonly left: string;
  readonly right: string;
  readonly author: ForgeCommitAuthor;
  readonly timestamp: string;
  readonly message: string;
}

export type ForgeMergeResult =
  | { readonly status: "merged"; readonly commit: string }
  | { readonly status: "conflict"; readonly paths: readonly string[] };

export interface ForgeRef {
  readonly ref: string;
  readonly target: string;
}

export interface ForgeRefUpdate {
  readonly ref: string;
  readonly expected: string | null;
  readonly next: string | null;
}

export interface ForgeGitPort {
  readonly readRef: (ref: string) => Promise<string | null>;
  readonly listRefs: (prefix: string) => Promise<readonly ForgeRef[]>;
  readonly readFile: (commit: string, path: string) => Promise<string | null>;
  readonly listTree: (commit: string, prefix?: string) => Promise<readonly ForgeTreeEntry[]>;
  readonly writeCommit: (input: ForgeWriteCommitInput) => Promise<string>;
  readonly compareCommits: (base: string, head: string) => Promise<ForgeCommitComparison>;
  readonly mergeCommits: (input: ForgeMergeInput) => Promise<ForgeMergeResult>;
  readonly compareAndSwapRef: (ref: string, expected: string | null, next: string | null) => Promise<boolean>;
  readonly compareAndSwapRefs: (updates: readonly ForgeRefUpdate[]) => Promise<boolean>;
  readonly isAncestor: (base: string, head: string) => Promise<boolean>;
}
