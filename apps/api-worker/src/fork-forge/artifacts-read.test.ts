import { describe, expect, it } from "vitest";

import { makeArtifactsForgeReads } from "./artifacts-read.js";

const commit = "c".repeat(40), root = "1".repeat(40), configTree = "2".repeat(40), nested = "3".repeat(40);
const head = "a".repeat(40), retainedOne = "b".repeat(40), retainedTwo = "d".repeat(40);
const remote = "https://artifacts.example/git/gitfoundry-production/stored.git";
const trees: Record<string, { name: string; mode: string; hash: string; type: string }[]> = {
  [root]: [{ name: ".forge", mode: "40000", hash: configTree, type: "tree" }, { name: "README.md", mode: "100644", hash: "e".repeat(40), type: "blob" }],
  [configTree]: [{ name: "evaluator.json", mode: "100644", hash: "f".repeat(40), type: "blob" }, { name: "nested", mode: "40000", hash: nested, type: "tree" }],
  [nested]: [{ name: "run.sh", mode: "100755", hash: "9".repeat(40), type: "exec" }]
};
const blobs: Record<string, string> = { ["e".repeat(40)]: "hello\n", ["f".repeat(40)]: "{\"schema_version\":1}", ["9".repeat(40)]: "#!/bin/sh\n" };

function pkt(line: string): string { return (line.length + 4).toString(16).padStart(4, "0") + line }
function advertisement(refs: readonly [string, string][]): string {
  const lines = refs.map(([ref, oid], index) => pkt(`${oid} ${ref}${index === 0 ? "\0multi_ack side-band-64k" : ""}\n`));
  return pkt("# service=git-upload-pack\n") + "0000" + lines.join("") + "0000";
}

function fixture(options: { readonly status?: number } = {}) {
  const tokens: string[] = [], revoked: string[] = [], requests: Request[] = [];
  const repo = {
    info: async () => ({ name: "stored", remote }),
    createToken: async (scope: string) => { const plaintext = "read-token-" + tokens.length + "-" + scope; tokens.push(plaintext); return { plaintext, expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    revokeToken: async (token: string) => { revoked.push(token); return true },
    readCommit: async (hash: string) => hash === commit ? { hash, treeHash: root } : null,
    readTree: async (hash: string) => trees[hash] ?? null,
    // Like Git, the store returns bytes for any object ID, trees included.
    readBlob: async (hash: string) => new Blob([blobs[hash] ?? "raw object " + hash])
  };
  const fetcher = async (request: Request) => { requests.push(request); return new Response(advertisement([["refs/heads/forge-head", head], ["refs/heads/retained/forks/one/version", retainedOne], ["refs/heads/retained/forks/two/version", retainedTwo], ["refs/heads/source-imports/x", commit], ["refs/tags/v1", "7".repeat(40)], ["refs/tags/v1^{}", commit]]), { status: options.status ?? 200 }) };
  const reads = makeArtifactsForgeReads({ repo: async () => repo, fetch: fetcher });
  return { reads, tokens, revoked, requests };
}

describe("forge reads served directly by Artifacts", () => {
  it("reads one ref and lists refs under a prefix from the Git ref advertisement", async () => {
    const { reads, tokens, revoked, requests } = fixture();
    await expect(reads.readRef("refs/heads/forge-head")).resolves.toBe(head);
    await expect(reads.readRef("refs/heads/missing")).resolves.toBeNull();
    await expect(reads.listRefs("refs/heads/retained/")).resolves.toEqual([{ ref: "refs/heads/retained/forks/one/version", target: retainedOne }, { ref: "refs/heads/retained/forks/two/version", target: retainedTwo }]);
    await expect(reads.listRefs("refs/tags/")).resolves.toEqual([{ ref: "refs/tags/v1", target: "7".repeat(40) }]);
    expect(requests[0]!.url).toBe(remote + "/info/refs?service=git-upload-pack");
    expect(requests[0]!.headers.get("authorization")).toBe("Basic " + btoa("x-access-token:" + tokens[0]));
    expect(tokens.every((token) => token.endsWith("-read"))).toBe(true);
    expect(revoked).toEqual(tokens);
  });

  it("fetches the ref advertisement once per request until a write invalidates it", async () => {
    // October 13, 2026: listing 18 forge versions fetched the advertisement dozens of times and took 24 s.
    const { reads, requests } = fixture();
    await reads.readRef("refs/heads/forge-head");
    await reads.readRef("refs/heads/missing");
    await reads.listRefs("refs/heads/retained/");
    expect(requests).toHaveLength(1);
    reads.invalidate();
    await reads.readRef("refs/heads/forge-head");
    expect(requests).toHaveLength(2);
  });

  it("reads a file at a commit as base64 and returns null for missing paths and directories", async () => {
    const { reads } = fixture();
    await expect(reads.readFile(commit, ".forge/evaluator.json")).resolves.toBe(btoa("{\"schema_version\":1}"));
    await expect(reads.readFile(commit, ".forge/missing.json")).resolves.toBeNull();
    await expect(reads.readFile(commit, ".forge")).resolves.toBeNull();
  });

  it("lists every file under a commit, or under a path prefix, with full paths", async () => {
    const { reads } = fixture();
    await expect(reads.listTree(commit)).resolves.toEqual([
      { path: ".forge/evaluator.json", oid: "f".repeat(40), mode: "100644", type: "blob" },
      { path: ".forge/nested/run.sh", oid: "9".repeat(40), mode: "100755", type: "blob" },
      { path: "README.md", oid: "e".repeat(40), mode: "100644", type: "blob" }
    ]);
    await expect(reads.listTree(commit, ".forge/nested")).resolves.toEqual([{ path: ".forge/nested/run.sh", oid: "9".repeat(40), mode: "100755", type: "blob" }]);
    // October 13, 2026: a folder prefix ending in "/" listed nothing, so publication found no reviews.
    await expect(reads.listTree(commit, ".forge/nested/")).resolves.toEqual([{ path: ".forge/nested/run.sh", oid: "9".repeat(40), mode: "100755", type: "blob" }]);
  });

  it("names a refused ref advertisement as the provider being unavailable", async () => {
    const { reads, tokens, revoked } = fixture({ status: 403 });
    await expect(reads.readRef("refs/heads/forge-head")).rejects.toMatchObject({ code: "provider_unavailable", detail: { provider_status: 403 } });
    expect(revoked).toEqual(tokens);
  });
});
