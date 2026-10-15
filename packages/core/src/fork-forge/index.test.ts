import { describe, expect, it } from "vitest";

import { ForkForgeIdempotencyConflictError, ForkForgeInputError, ForkForgeStaleHeadError, ForkForgeUnavailableError, ForgeVersionAuthenticationError, decodeBase64Utf8, encodeBase64Utf8, makeForgeService, semanticDigest, type ForgeActor, type ForgeFileMode, type ForgeGitPort, type ForgeMergeInput, type ForgeMergeResult, type ForgeWriteCommitInput } from "./index.js";

const actor: ForgeActor = { id: "agent-a", kind: "agent" };
const otherActor: ForgeActor = { id: "agent-b", kind: "agent" };
const rootCode = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeService(port = new FakeGitPort()) {
  return {
    port,
    service: makeForgeService({
      git: port,
      tenant_id: "tenant-a",
      repository_id: "repo-a",
      clock: () => "2026-10-09T00:00:00.000Z",
      authorize: async () => {},
      verifyEvidence: async () => {}
    })
  };
}

describe("fork-first forge service", () => {
  it("retains large operation payloads as separate blobs and replays without decoding an oversized record", async () => {
    const { port, service } = makeService();
    const root = await service.initialize({ operation_id: "large-input-init", code_commit: rootCode, actor });
    const payload = "YWJj".repeat(1024 * 1024);
    const changes = Array.from({ length: 40 }, (_, index) => ({ tree: "code" as const, path: `payload/${index}.bin`, content_base64: payload }));
    const request = { operation_id: "large-input", parent_version: root.version_commit, actor, changes };
    const candidate = await service.commit(request);
    for (const status of ["intent", "result"]) {
      const commit = await port.readRef(`refs/heads/operations/large-input/${status}`);
      expect(commit).not.toBeNull();
      const manifest = Buffer.from((await port.readFile(commit!, "operation.json"))!, "base64").toString("utf8");
      expect(Buffer.byteLength(manifest)).toBeLessThan(65536);
      const record = JSON.parse(manifest);
      expect(record.input.changes).toHaveLength(40);
      for (const [index, change] of record.input.changes.entries()) {
        expect(change).toEqual({ tree: "code", path: `payload/${index}.bin`, content_path: `operation-input/${index}.blob` });
        const retained = await port.readFile(commit!, change.content_path);
        expect(retained).toBe(payload);
        expect(Buffer.from(retained!, "base64").byteLength).toBe(3 * 1024 * 1024);
      }
    }
    expect((await service.commit(request)).version_commit).toBe(candidate.version_commit);
    await expect(service.commit({ ...request, changes: [{ ...changes[0]!, content_base64: "ZGVm" }, ...changes.slice(1)] })).rejects.toBeInstanceOf(ForkForgeIdempotencyConflictError);
    expect((await service.head(actor))?.version_commit).toBe(root.version_commit);
  }, 30000);

  it("resumes an interrupted operation from its payload-bearing intent", async () => {
    const { port, service } = makeService();
    const root = await service.initialize({ operation_id: "payload-recovery-init", code_commit: rootCode, actor });
    const payload = Buffer.from("retained input").toString("base64");
    const request = { operation_id: "payload-recovery", parent_version: root.version_commit, actor, changes: [{ tree: "code" as const, path: "input.txt", content_base64: payload, mode: "100755" as const }, { tree: "state" as const, path: "deleted.txt", content_base64: null }, { tree: "state" as const, path: "empty.txt", content_base64: "" }] };
    port.afterWriteCommit = async (_sha, input) => {
      if (input.message === "update code tree") throw new Error("interrupted after intent");
    };
    await expect(service.commit(request)).rejects.toThrow("interrupted after intent");
    const intent = await port.readRef("refs/heads/operations/payload-recovery/intent");
    expect(intent).not.toBeNull();
    expect(await port.readFile(intent!, "operation-input/0.blob")).toBe(payload);
    expect(await port.readFile(intent!, "operation-input/1.blob")).toBe("");
    port.afterWriteCommit = undefined;
    const candidate = await service.commit(request);
    expect(await port.readFile(candidate.descriptor.code_commit, "input.txt")).toBe(payload);
    expect((await service.commit(request)).version_commit).toBe(candidate.version_commit);
  });

  it("reads one authenticated operation without enumerating forge history", async () => {
    const { port, service } = makeService();
    const root = await service.initialize({ operation_id: "indexed-init", code_commit: rootCode, actor });
    const next = await service.commit({ operation_id: "indexed-run.finished", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "runs/indexed.json", content_base64: encodeBase64Utf8("{}") }] });
    port.listRefs = async () => { throw new Error("history enumeration is forbidden for operation lookup"); };
    expect(await service.operationVersion!("indexed-run.finished", actor)).toEqual(next);
    expect(await service.operationVersion!("missing-run.finished", actor)).toBeNull();
    await port.compareAndSwapRef("refs/heads/retained/indexed-run.finished/state", next.descriptor.state_commit, "d".repeat(40));
    await expect(service.operationVersion!("indexed-run.finished", actor)).rejects.toBeInstanceOf(ForgeVersionAuthenticationError);
  });

  it("authorizes operation lookup before returning retained run state", async () => {
    const port = new FakeGitPort();
    let revoked = false;
    const service = makeForgeService({
      git: port, tenant_id: "tenant-a", repository_id: "repo-a",
      clock: () => "2026-10-09T00:00:00.000Z",
      authorize: async () => { if (revoked) throw new ForkForgeUnavailableError("reader revoked"); },
      verifyEvidence: async () => {}
    });
    await service.initialize({ operation_id: "authorized-index", code_commit: rootCode, actor });
    revoked = true;
    await expect(service.operationVersion!("authorized-index", actor)).rejects.toThrow("reader revoked");
  });

  it("adopts imported code without moving authoritative head and replays identical input", async () => {
    const { port, service } = makeService();
    const root = await service.initialize({ operation_id: "adopt-init", code_commit: rootCode, actor });
    const imported = await port.writeCommit({ base: rootCode, parents: [rootCode], changes: [{ path: "src/new.ts", content_base64: encodeBase64Utf8("export const imported = true;") }], message: "upload", author: { name: "owner", email: "owner@example.com" }, timestamp: "2026-10-09T00:00:00.000Z" });
    const input = { operation_id: "adopt-source", parent_version: root.version_commit, expected_parent_code_commit: rootCode, code_commit: imported, actor, changes: [{ tree: "state" as const, path: "runs/source.json", content_base64: encodeBase64Utf8("{}") }] };
    const candidate = await service.adoptCodeCommit(input);
    expect(candidate.descriptor.code_commit).toBe(imported);
    expect(candidate.descriptor.parents).toEqual([root.version_commit]);
    expect(await port.readFile(candidate.descriptor.state_commit, "runs/source.json")).toBe(encodeBase64Utf8("{}"));
    expect((await service.adoptCodeCommit(input)).version_commit).toBe(candidate.version_commit);
    expect((await service.head(actor))?.version_commit).toBe(root.version_commit);
    await expect(service.adoptCodeCommit({ ...input, code_commit: rootCode })).rejects.toBeInstanceOf(ForkForgeIdempotencyConflictError);
  });

  it("finishes a version whose retained refs were interrupted, and lists the rest meanwhile", async () => {
    // October 12, 2026: an adoption timed out after retaining only its version ref; every retry and the version list then failed authentication.
    const { port, service } = makeService();
    const root = await service.initialize({ operation_id: "partial-init", code_commit: rootCode, actor });
    const imported = await port.writeCommit({ base: rootCode, parents: [rootCode], changes: [{ path: "src/new.ts", content_base64: encodeBase64Utf8("export const imported = true;") }], message: "upload", author: { name: "owner", email: "owner@example.com" }, timestamp: "2026-10-09T00:00:00.000Z" });
    const input = { operation_id: "partial-adopt", parent_version: root.version_commit, expected_parent_code_commit: rootCode, code_commit: imported, actor, changes: [] };
    const nativeCas = port.compareAndSwapRef.bind(port);
    port.compareAndSwapRef = async (ref, expected, next) => {
      if (ref === "refs/heads/retained/partial-adopt/code") throw new Error("interrupted after version ref");
      return nativeCas(ref, expected, next);
    };
    await expect(service.adoptCodeCommit(input)).rejects.toThrow("interrupted after version ref");
    expect(await port.readRef("refs/heads/retained/partial-adopt/version")).not.toBeNull();
    expect((await service.list(actor)).map(version => version.version_commit)).toEqual([root.version_commit]);
    port.compareAndSwapRef = nativeCas;
    await expect(service.adoptCodeCommit({ ...input, changes: [{ tree: "state" as const, path: "runs/other.json", content_base64: encodeBase64Utf8("{}") }] })).rejects.toBeInstanceOf(ForkForgeIdempotencyConflictError);
    expect(await port.readRef("refs/heads/retained/partial-adopt/code")).toBeNull();
    const candidate = await service.adoptCodeCommit(input);
    expect(candidate.descriptor.code_commit).toBe(imported);
    expect((await service.list(actor)).map(version => version.version_commit).sort()).toEqual([root.version_commit, candidate.version_commit].sort());
  });

  it("still rejects a retained version whose code ref points elsewhere", async () => {
    const { port, service } = makeService();
    const root = await service.initialize({ operation_id: "forged-init", code_commit: rootCode, actor });
    expect(await port.compareAndSwapRef("refs/heads/retained/forged-init/code", rootCode, "b".repeat(40))).toBe(true);
    await expect(service.list(actor)).rejects.toBeInstanceOf(ForgeVersionAuthenticationError);
    await expect(service.read(root.version_commit, actor)).rejects.toBeInstanceOf(ForgeVersionAuthenticationError);
  });

  it("rejects absent imported commits, wrong parent code, and code changes during adoption", async () => {
    const { service } = makeService();
    const root = await service.initialize({ operation_id: "reject-adopt-init", code_commit: rootCode, actor });
    const input = { operation_id: "reject-adopt", parent_version: root.version_commit, expected_parent_code_commit: rootCode, code_commit: rootCode, actor, changes: [] };
    await expect(service.adoptCodeCommit({ ...input, code_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).rejects.toThrow("commit not found");
    await expect(service.adoptCodeCommit({ ...input, expected_parent_code_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).rejects.toBeInstanceOf(ForkForgeInputError);
    await expect(service.adoptCodeCommit({ ...input, changes: [{ tree: "code", path: "README.md", content_base64: null }] })).rejects.toBeInstanceOf(ForkForgeInputError);
    await expect(service.initialize({ operation_id: "missing-init", code_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", actor })).rejects.toThrow("commit not found");
    expect((await service.head(actor))?.version_commit).toBe(root.version_commit);
  });

  it("uses stable canonical SHA-256 request digests", () => {
    expect(semanticDigest({ b: 2, a: 1 })).toBe("sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  });

  it("lets one competing fork publish and rejects the stale writer", async () => {
    const { service } = makeService();
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const left = await service.commit({ operation_id: "left", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "issues/one.json", content_base64: encodeBase64Utf8("{}") }] });
    const right = await service.commit({ operation_id: "right", parent_version: root.version_commit, actor: otherActor, changes: [{ tree: "state", path: "issues/two.json", content_base64: encodeBase64Utf8("{}") }] });

    await expect(service.publish({ operation_id: "publish-left", expected_version: root.version_commit, new_version: left.version_commit, actor })).resolves.toMatchObject({ version_commit: left.version_commit });
    await expect(service.publish({ operation_id: "publish-right", expected_version: root.version_commit, new_version: right.version_commit, actor: otherActor })).rejects.toBeInstanceOf(ForkForgeStaleHeadError);
  });

  it("reauthorizes immediately before advancing forge head", async () => {
    const port = new FakeGitPort();
    let publishAuthorizations = 0;
    const service = makeForgeService({
      git: port,
      tenant_id: "tenant-a",
      repository_id: "repo-a",
      clock: () => "2026-10-09T00:00:00.000Z",
      authorize: async (context) => {
        if (context.capability === "forge.publish") {
          publishAuthorizations += 1;
          if (publishAuthorizations === 2) throw new ForkForgeUnavailableError("publisher was revoked");
        }
      },
      verifyEvidence: async () => {}
    });
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const next = await service.commit({ operation_id: "next", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checks/final-auth.json", content_base64: encodeBase64Utf8("{}") }] });

    await expect(service.publish({ operation_id: "publish-next", expected_version: root.version_commit, new_version: next.version_commit, actor })).rejects.toBeInstanceOf(ForkForgeUnavailableError);
    expect(publishAuthorizations).toBe(2);
    await expect(service.head(actor)).resolves.toMatchObject({ version_commit: root.version_commit });
    expect(await port.readRef("refs/heads/operations/publish-next/result")).toBeNull();
  });

  it("treats idempotent replay as the same semantic request and rejects key reuse with different input", async () => {
    const { service } = makeService();
    const first = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const replay = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });

    expect(replay.version_commit).toBe(first.version_commit);
    await expect(service.initialize({ operation_id: "init", code_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", actor })).rejects.toBeInstanceOf(ForkForgeIdempotencyConflictError);
  });

  it("bootstraps an initial code commit from ordinary file changes", async () => {
    const { port, service } = makeService();
    const source = encodeBase64Utf8("export const answer = 42;\n");
    const root = await service.initialize({ operation_id: "init-with-code", initial_code: [{ path: "src/index.ts", content_base64: source }], actor, initial_state: [{ path: "config/policy.json", content_base64: encodeBase64Utf8("{}") }] });

    expect(root.descriptor.code_commit).not.toBe(rootCode);
    expect(await port.readFile(root.descriptor.code_commit, "src/index.ts")).toBe(source);
    expect(await port.readFile(root.descriptor.state_commit, "config/policy.json")).toBe(encodeBase64Utf8("{}"));
  });

  it("preserves explicit file modes through initial code and state commits", async () => {
    const { port, service } = makeService();
    const executable = encodeBase64Utf8("#!/bin/sh\necho gfy\n");
    const symlinkTarget = encodeBase64Utf8("../bin/gfy");
    const root = await service.initialize({ operation_id: "init-modes", initial_code: [{ path: "bin/gfy", content_base64: executable, mode: "100755" }], actor, initial_state: [{ path: "links/gfy", content_base64: symlinkTarget, mode: "120000" }] });

    await expect(service.read({ version: root.version_commit, tree: "code", prefix: "bin", actor })).resolves.toMatchObject({ status: "tree", entries: [{ path: "bin/gfy", mode: "100755" }] });
    await expect(service.read({ version: root.version_commit, tree: "state", prefix: "links", actor })).resolves.toMatchObject({ status: "tree", entries: [{ path: "links/gfy", mode: "120000" }] });
    expect(await port.readFile(root.descriptor.state_commit, "links/gfy")).toBe(symlinkTarget);
  });

  it("includes file mode in commit idempotency semantics", async () => {
    const { service } = makeService();
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const script = encodeBase64Utf8("#!/bin/sh\necho gfy\n");
    const first = await service.commit({ operation_id: "mode-digest", parent_version: root.version_commit, actor, changes: [{ tree: "code", path: "bin/gfy", content_base64: script, mode: "100644" }] });

    await expect(service.commit({ operation_id: "mode-digest", parent_version: root.version_commit, actor, changes: [{ tree: "code", path: "bin/gfy", content_base64: script, mode: "100755" }] })).rejects.toBeInstanceOf(ForkForgeIdempotencyConflictError);
    await expect(service.read({ version: first.version_commit, tree: "code", prefix: "bin", actor })).resolves.toMatchObject({ status: "tree", entries: [{ path: "bin/gfy", mode: "100644" }] });
  });

  it("rejects unsupported file modes and modes on deletions", async () => {
    const { service } = makeService();
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });

    await expect(service.initialize({ operation_id: "bad-mode", initial_code: [{ path: "bin/gfy", content_base64: encodeBase64Utf8("x"), mode: "040000" as ForgeFileMode }], actor })).rejects.toBeInstanceOf(ForkForgeInputError);
    await expect(service.commit({ operation_id: "delete-mode", parent_version: root.version_commit, actor, changes: [{ tree: "code", path: "bin/gfy", content_base64: null, mode: "100755" }] })).rejects.toBeInstanceOf(ForkForgeInputError);
  });

  it("requires exactly one initialize code source", async () => {
    const { service } = makeService();

    await expect(service.initialize({ operation_id: "init-neither", actor })).rejects.toBeInstanceOf(ForkForgeInputError);
    await expect(service.initialize({ operation_id: "init-both", code_commit: rootCode, initial_code: [{ path: "src/index.ts", content_base64: encodeBase64Utf8("x") }], actor })).rejects.toBeInstanceOf(ForkForgeInputError);
  });

  it("replays identical initial code and rejects changed initial code for the same operation", async () => {
    const { service } = makeService();
    const firstSource = encodeBase64Utf8("export const answer = 42;\n");
    const secondSource = encodeBase64Utf8("export const answer = 43;\n");
    const first = await service.initialize({ operation_id: "init-code-replay", initial_code: [{ path: "src/index.ts", content_base64: firstSource }], actor });
    const replay = await service.initialize({ operation_id: "init-code-replay", initial_code: [{ path: "src/index.ts", content_base64: firstSource }], actor });

    expect(replay.version_commit).toBe(first.version_commit);
    await expect(service.initialize({ operation_id: "init-code-replay", initial_code: [{ path: "src/index.ts", content_base64: secondSource }], actor })).rejects.toBeInstanceOf(ForkForgeIdempotencyConflictError);
  });

  it("rejects duplicate initial code paths", async () => {
    const { service } = makeService();

    await expect(service.initialize({ operation_id: "init-code-dup", initial_code: [{ path: "src/index.ts", content_base64: encodeBase64Utf8("a") }, { path: "src/index.ts", content_base64: encodeBase64Utf8("b") }], actor })).rejects.toBeInstanceOf(ForkForgeInputError);
  });

  it("lists and reads files from an exact forge state revision", async () => {
    const { service } = makeService();
    const policy = encodeBase64Utf8("{\"requiredChecks\":[\"unit\"]}");
    const root = await service.initialize({ operation_id: "init-read-tree", code_commit: rootCode, actor, initial_state: [{ path: "config/policy.json", content_base64: policy }] });

    await expect(service.read({ version: root.version_commit, tree: "state", prefix: "config", actor })).resolves.toMatchObject({ status: "tree", prefix: "config", entries: [{ path: "config/policy.json" }] });
    await expect(service.read({ version: root.version_commit, tree: "state", path: "config/policy.json", actor })).resolves.toMatchObject({ status: "file", path: "config/policy.json", content_base64: policy });
    await expect(service.read({ version: root.version_commit, tree: "state", path: "config/policy.json", prefix: "config", actor })).rejects.toBeInstanceOf(ForkForgeInputError);
  });

  it("bootstraps exact initial state files beside the default README", async () => {
    const { port, service } = makeService();
    const policy = encodeBase64Utf8("{\"requiredChecks\":[\"unit\"]}");
    const root = await service.initialize({ operation_id: "init-with-policy", code_commit: rootCode, actor, initial_state: [{ path: "config/policy.json", content_base64: policy }] });

    expect(await port.readFile(root.descriptor.state_commit, "README.md")).toBe(encodeBase64Utf8("# Forge state\n"));
    expect(await port.readFile(root.descriptor.state_commit, "config/policy.json")).toBe(policy);
  });

  it("replays identical initial state and rejects changed initial state for the same operation", async () => {
    const { service } = makeService();
    const firstPolicy = encodeBase64Utf8("{\"requiredChecks\":[\"unit\"]}");
    const secondPolicy = encodeBase64Utf8("{\"requiredChecks\":[\"integration\"]}");
    const first = await service.initialize({ operation_id: "init-replay-policy", code_commit: rootCode, actor, initial_state: [{ path: "config/policy.json", content_base64: firstPolicy }] });
    const replay = await service.initialize({ operation_id: "init-replay-policy", code_commit: rootCode, actor, initial_state: [{ path: "config/policy.json", content_base64: firstPolicy }] });

    expect(replay.version_commit).toBe(first.version_commit);
    await expect(service.initialize({ operation_id: "init-replay-policy", code_commit: rootCode, actor, initial_state: [{ path: "config/policy.json", content_base64: secondPolicy }] })).rejects.toBeInstanceOf(ForkForgeIdempotencyConflictError);
  });

  it("rejects duplicate initial state paths and README override attempts", async () => {
    const { service } = makeService();

    await expect(service.initialize({ operation_id: "init-dup", code_commit: rootCode, actor, initial_state: [{ path: "config/policy.json", content_base64: encodeBase64Utf8("{}") }, { path: "config/policy.json", content_base64: encodeBase64Utf8("{}") }] })).rejects.toBeInstanceOf(ForkForgeInputError);
    await expect(service.initialize({ operation_id: "init-readme", code_commit: rootCode, actor, initial_state: [{ path: "README.md", content_base64: encodeBase64Utf8("custom") }] })).rejects.toBeInstanceOf(ForkForgeInputError);
  });

  it("keeps the code commit stable for metadata-only forks", async () => {
    const { service } = makeService();
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const stateOnly = await service.commit({ operation_id: "state-only", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "reviews/r1.json", content_base64: encodeBase64Utf8("{\"decision\":\"approved\"}") }] });

    expect(stateOnly.descriptor.code_commit).toBe(root.descriptor.code_commit);
    expect(stateOnly.descriptor.state_commit).not.toBe(root.descriptor.state_commit);
  });

  it("does not trust a descriptor commit unless retained refs authenticate it", async () => {
    const port = new FakeGitPort();
    const { service } = makeService(port);
    const fakeDescriptorCommit = await port.writeCommit({ base: null, parents: [], changes: [{ path: "forge.json", content_base64: encodeBase64Utf8(JSON.stringify({ schema_version: 1, fork_id: "fake", tenant_id: "tenant-a", repository_id: "repo-a", parents: [], code_commit: rootCode, state_commit: rootCode, creator_id: "agent-a", creator_kind: "agent", operation_id: "fake", request_digest: "fake" })) }], message: "fake descriptor", author: { name: "attacker", email: "attacker@example.com" }, timestamp: "2026-10-09T00:00:00.000Z" });

    await expect(service.read(fakeDescriptorCommit, actor)).rejects.toBeInstanceOf(ForgeVersionAuthenticationError);
  });

  it("preserves explicit merge conflicts instead of publishing a silent merge", async () => {
    const port = new FakeGitPort({ conflictPaths: ["src/api.ts"] });
    const { service } = makeService(port);
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const left = await service.commit({ operation_id: "left", parent_version: root.version_commit, actor, changes: [{ tree: "code", path: "src/api.ts", content_base64: encodeBase64Utf8("left") }] });
    const right = await service.commit({ operation_id: "right", parent_version: root.version_commit, actor: otherActor, changes: [{ tree: "code", path: "src/api.ts", content_base64: encodeBase64Utf8("right") }] });

    await expect(service.merge({ operation_id: "merge", base_version: root.version_commit, left_version: left.version_commit, right_version: right.version_commit, actor })).resolves.toEqual({ status: "conflict", conflicts: [{ tree: "code", path: "src/api.ts" }] });
  });

  it("lists retained unpublished forks instead of only the authoritative head", async () => {
    const { service } = makeService();
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const unpublished = await service.commit({ operation_id: "unpublished", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checkpoints/cp.json", content_base64: encodeBase64Utf8("{}") }] });

    await expect(service.list(actor)).resolves.toEqual([root, unpublished]);
  });

  it("returns and repairs the actual authoritative head when concurrent initialize loses CAS", async () => {
    const port = new FakeGitPort();
    const winner = await makeService(port).service.initialize({ operation_id: "winner", code_commit: rootCode, actor });
    port.refs.delete("refs/heads/forge-head");
    port.refs.delete("refs/heads/code");
    port.refs.delete("refs/heads/forge-state");
    let raced = false;
    port.beforeCas = (ref, expected) => {
      if (!raced && ref === "refs/heads/forge-head" && expected === null) {
        raced = true;
        port.refs.set("refs/heads/forge-head", winner.version_commit);
      }
    };
    const loser = await makeService(port).service.initialize({ operation_id: "loser", code_commit: rootCode, actor: otherActor });

    expect(loser.version_commit).toBe(winner.version_commit);
    expect(await port.readRef("refs/heads/code")).toBe(winner.descriptor.code_commit);
    expect(await port.readRef("refs/heads/forge-state")).toBe(winner.descriptor.state_commit);
  });

  it("replays a pending operation from retained refs instead of creating a second fork", async () => {
    const { port, service } = makeService();
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const first = await service.commit({ operation_id: "pending-replay", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "handoffs/h1.json", content_base64: encodeBase64Utf8("{}") }] });
    port.refs.delete("refs/heads/operations/pending-replay/result");
    const replay = await service.commit({ operation_id: "pending-replay", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "handoffs/h1.json", content_base64: encodeBase64Utf8("{}") }] });

    expect(replay.version_commit).toBe(first.version_commit);
    const retainedVersions = await port.listRefs("refs/heads/retained/pending-replay/");
    expect(retainedVersions.filter((entry) => entry.ref.endsWith("/version"))).toHaveLength(1);
  });

  it("converges on an already-retained descriptor when the same operation races before result", async () => {
    const port = new FakeGitPort();
    const { service } = makeService(port);
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    let injected = false;
    let retainedCommit = "";
    port.afterWriteCommit = async (sha, input, files) => {
      if (injected || input.message !== "commit complete forge fork") return;
      injected = true;
      const descriptorBase64 = files.get("forge.json")?.content_base64;
      if (!descriptorBase64) return;
      const descriptor = JSON.parse(decodeBase64Utf8(descriptorBase64)) as { fork_id: string; code_commit: string; state_commit: string };
      retainedCommit = await port.writeCommit({ base: input.parents[0] ?? null, parents: input.parents, changes: [{ path: "forge.json", content_base64: descriptorBase64 }], message: "racing descriptor", author: input.author, timestamp: "2026-10-09T00:00:01.000Z" });
      port.refs.set(`refs/heads/retained/${descriptor.fork_id}/version`, retainedCommit);
      port.refs.set(`refs/heads/retained/${descriptor.fork_id}/code`, descriptor.code_commit);
      port.refs.set(`refs/heads/retained/${descriptor.fork_id}/state`, descriptor.state_commit);
      expect(sha).not.toBe(retainedCommit);
    };

    const replayed = await service.commit({ operation_id: "racy", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "handoffs/racy.json", content_base64: encodeBase64Utf8("{}") }] });

    expect(replayed.version_commit).toBe(retainedCommit);
  });

  it("rejects no-op publish attempts before recording acceptance", async () => {
    const { service } = makeService();
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });

    await expect(service.publish({ operation_id: "noop-publish", expected_version: root.version_commit, new_version: root.version_commit, actor })).rejects.toBeInstanceOf(ForkForgeInputError);
  });

  it("retries an unfinished publish through conditional head and result refs", async () => {
    const port = new FakeGitPort();
    const service = makeForgeService({ git: port, tenant_id: "tenant-a", repository_id: "repo-a", clock: () => "2026-10-09T00:00:00.000Z", authorize: async () => {}, verifyEvidence: async () => {} });
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const next = await service.commit({ operation_id: "next", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checks/c2.json", content_base64: encodeBase64Utf8("{}") }] });
    await port.writePublishIntent("publish-next", root.version_commit, next.version_commit, actor);

    await expect(service.publish({ operation_id: "publish-next", expected_version: root.version_commit, new_version: next.version_commit, actor })).resolves.toMatchObject({ version_commit: next.version_commit });
    expect(await port.readRef("refs/heads/forge-head")).toBe(next.version_commit);
    expect(await port.readRef("refs/heads/operations/publish-next/result")).toBeTruthy();
  });

  it("verifies evidence before completing recovered publish intent", async () => {
    const port = new FakeGitPort();
    const service = makeForgeService({ git: port, tenant_id: "tenant-a", repository_id: "repo-a", clock: () => "2026-10-09T00:00:00.000Z", authorize: async () => {}, verifyEvidence: async () => { throw new ForkForgeUnavailableError("evidence unavailable"); } });
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const next = await service.commit({ operation_id: "next", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checks/c3.json", content_base64: encodeBase64Utf8("{}") }] });
    await port.writePublishIntent("publish-next", root.version_commit, next.version_commit, actor);
    port.refs.set("refs/heads/forge-head", next.version_commit);

    await expect(service.recover({ operation_id: "publish-next", actor: otherActor })).rejects.toBeInstanceOf(ForkForgeUnavailableError);
    expect(await port.readRef("refs/heads/operations/publish-next/result")).toBeNull();
  });

  it("completes crash-after-CAS publish recovery by recording the missing result", async () => {
    const port = new FakeGitPort();
    const service = makeForgeService({ git: port, tenant_id: "tenant-a", repository_id: "repo-a", clock: () => "2026-10-09T00:00:00.000Z", authorize: async () => {}, verifyEvidence: async () => {} });
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const next = await service.commit({ operation_id: "next", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checks/c1.json", content_base64: encodeBase64Utf8("{}") }] });
    await port.writePublishIntent("publish-next", root.version_commit, next.version_commit, actor);
    port.refs.set("refs/heads/forge-head", next.version_commit);

    await expect(service.recover({ operation_id: "publish-next", actor })).resolves.toMatchObject({ status: "published", version: { version_commit: next.version_commit } });
    const completedResult = await port.readRef("refs/heads/operations/publish-next/result");
    expect(completedResult).toBeTruthy();
    const staleResult = await port.writeCommit({ base: null, parents: [], changes: [{ path: "operation.json", content_base64: encodeBase64Utf8("{\"stale\":true}\n") }], message: "late stale publisher result", author: { name: "test", email: "test@example.com" }, timestamp: "2026-10-09T00:00:01.000Z" });
    expect(await port.compareAndSwapRefs([
      { ref: "refs/heads/forge-head", expected: root.version_commit, next: next.version_commit },
      { ref: "refs/heads/operations/publish-next/result", expected: null, next: staleResult }
    ])).toBe(false);
    expect(await port.readRef("refs/heads/forge-head")).toBe(next.version_commit);
    expect(await port.readRef("refs/heads/operations/publish-next/result")).toBe(completedResult);
  });

  it("recovers an incomplete publication by recording intent, accepting head, and completing its receipt", async () => {
    const port = new FakeGitPort();
    const service = makeForgeService({ git: port, tenant_id: "tenant-a", repository_id: "repo-a", clock: () => "2026-10-09T00:00:00.000Z", authorize: async () => {}, verifyEvidence: async () => {} });
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const next = await service.commit({ operation_id: "next", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checks/c4.json", content_base64: encodeBase64Utf8("{}") }] });
    await port.writePublishIntent("publish-next", root.version_commit, next.version_commit, actor);

    await expect(service.recover({ operation_id: "publish-next", actor })).resolves.toMatchObject({ status: "published", version: { version_commit: next.version_commit } });
    expect(await port.readRef("refs/heads/forge-head")).toBe(next.version_commit);
    expect(await port.readRef("refs/heads/operations/publish-next/result")).toBeTruthy();
    expect(await port.listRefs(`refs/heads/retained/${next.descriptor.fork_id}/`)).toEqual([
      { ref: `refs/heads/retained/${next.descriptor.fork_id}/code`, target: next.descriptor.code_commit },
      { ref: `refs/heads/retained/${next.descriptor.fork_id}/state`, target: next.descriptor.state_commit },
      { ref: `refs/heads/retained/${next.descriptor.fork_id}/version`, target: next.version_commit }
    ]);
  });

  it("denies recovery when another active publisher moved forge-head", async () => {
    const port = new FakeGitPort();
    const service = makeForgeService({ git: port, tenant_id: "tenant-a", repository_id: "repo-a", clock: () => "2026-10-09T00:00:00.000Z", authorize: async () => {}, verifyEvidence: async () => {} });
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const next = await service.commit({ operation_id: "next", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checks/c5.json", content_base64: encodeBase64Utf8("{}") }] });
    const other = await service.commit({ operation_id: "other", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checks/other.json", content_base64: encodeBase64Utf8("{}") }] });
    await port.writePublishIntent("publish-next", root.version_commit, next.version_commit, actor);
    port.refs.set("refs/heads/forge-head", other.version_commit);

    await expect(service.recover({ operation_id: "publish-next", actor })).rejects.toBeInstanceOf(ForkForgeStaleHeadError);
    expect(await port.readRef("refs/heads/operations/publish-next/result")).toBeNull();
  });

  it("converges concurrent recovery attempts on one publication result", async () => {
    const port = new FakeGitPort();
    const service = makeForgeService({ git: port, tenant_id: "tenant-a", repository_id: "repo-a", clock: () => "2026-10-09T00:00:00.000Z", authorize: async () => {}, verifyEvidence: async () => {} });
    const root = await service.initialize({ operation_id: "init", code_commit: rootCode, actor });
    const next = await service.commit({ operation_id: "next", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checks/c6.json", content_base64: encodeBase64Utf8("{}") }] });
    await port.writePublishIntent("publish-next", root.version_commit, next.version_commit, actor);

    const [left, right] = await Promise.all([
      service.recover({ operation_id: "publish-next", actor }),
      service.recover({ operation_id: "publish-next", actor: otherActor })
    ]);

    expect(left).toMatchObject({ status: "published", version: { version_commit: next.version_commit } });
    expect(right).toMatchObject({ status: "published", version: { version_commit: next.version_commit } });
    expect(await port.readRef("refs/heads/forge-head")).toBe(next.version_commit);
    expect(await port.listRefs("refs/heads/operations/publish-next/result")).toHaveLength(1);
  });
  it("publishes without multi-ref atomic support and repairs a receipt before the next acceptance", async () => {
    const { port, service } = makeService();
    const nativeCas = port.compareAndSwapRefs.bind(port);
    port.compareAndSwapRefs = async updates => {
      if (updates.length !== 1) throw new Error("remote does not support atomic push");
      return nativeCas(updates);
    };
    const root = await service.initialize({ operation_id: "single-init", code_commit: rootCode, actor });
    const first = await service.commit({ operation_id: "single-first", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checkpoints/first.json", content_base64: encodeBase64Utf8("{}") }] });
    let crash = true;
    port.beforeCas = ref => {
      if (crash && ref === "refs/heads/operations/single-publish-first/result") {
        crash = false;
        throw new Error("crash after head acceptance");
      }
    };
    await expect(service.publish({ operation_id: "single-publish-first", expected_version: root.version_commit, new_version: first.version_commit, actor })).rejects.toThrow("crash after head acceptance");
    expect(await port.readRef("refs/heads/forge-head")).toBe(first.version_commit);
    expect(await port.readRef("refs/heads/operations/single-publish-first/result")).toBeNull();
    await port.writePublishIntent("single-publish-impostor", root.version_commit, first.version_commit, otherActor);
    await expect(service.recover({ operation_id: "single-publish-impostor", actor: otherActor })).rejects.toBeInstanceOf(ForkForgeIdempotencyConflictError);
    expect(await port.readRef("refs/heads/operations/single-publish-impostor/result")).toBeNull();
    const second = await service.commit({ operation_id: "single-second", parent_version: first.version_commit, actor, changes: [{ tree: "state", path: "checkpoints/second.json", content_base64: encodeBase64Utf8("{}") }] });
    port.beforeCas = (ref, expected) => {
      if (ref === "refs/heads/forge-head" && expected === first.version_commit) {
        expect(port.refs.get("refs/heads/operations/single-publish-first/result")).toBeTruthy();
      }
    };
    await expect(service.publish({ operation_id: "single-publish-second", expected_version: first.version_commit, new_version: second.version_commit, actor })).resolves.toMatchObject({ version_commit: second.version_commit });
    await expect(service.recover({ operation_id: "single-publish-first", actor })).resolves.toMatchObject({ status: "published", version: { version_commit: first.version_commit } });
    expect(await port.readRef("refs/heads/forge-head")).toBe(second.version_commit);
    expect(await port.readRef("refs/heads/code")).toBe(second.descriptor.code_commit);
    expect(await port.readRef("refs/heads/forge-state")).toBe(second.descriptor.state_commit);
  });

  it("reserves a candidate for one operation while duplicate requests share one acceptance", async () => {
    const { port, service } = makeService();
    const root = await service.initialize({ operation_id: "candidate-init", code_commit: rootCode, actor });
    const next = await service.commit({ operation_id: "candidate-next", parent_version: root.version_commit, actor, changes: [{ tree: "state", path: "checkpoints/next.json", content_base64: encodeBase64Utf8("{}") }] });
    let advances = 0;
    port.beforeCas = (ref, expected) => { if (ref === "refs/heads/forge-head" && expected === root.version_commit && port.refs.get(ref) === expected) advances += 1; };
    const request = { operation_id: "candidate-publish", expected_version: root.version_commit, new_version: next.version_commit, actor };
    const results = await Promise.all([service.publish(request), service.publish(request)]);
    expect(results.map(result => result.version_commit)).toEqual([next.version_commit, next.version_commit]);
    expect(advances).toBe(1);
    await expect(service.publish({ ...request, operation_id: "candidate-different-request" })).rejects.toBeInstanceOf(ForkForgeStaleHeadError);
    expect(await port.readRef("refs/heads/operations/candidate-different-request/result")).toBeNull();
  });

});

class FakeGitPort implements ForgeGitPort {
  readonly refs = new Map<string, string | null>();
  readonly commits = new Map<string, { parents: readonly string[]; files: Map<string, FakeFileEntry> }>();
  private counter = 1;
  private readonly conflictPaths: readonly string[];
  afterWriteCommit: ((sha: string, input: ForgeWriteCommitInput, files: Map<string, FakeFileEntry>) => void | Promise<void>) | undefined;
  beforeCas: ((ref: string, expected: string | null, next: string | null) => void) | undefined;

  constructor(input: { conflictPaths?: readonly string[] } = {}) {
    this.conflictPaths = input.conflictPaths ?? [];
    this.commits.set(rootCode, { parents: [], files: new Map([["README.md", { content_base64: encodeBase64Utf8("root"), mode: "100644" }]]) });
  }

  async readRef(ref: string): Promise<string | null> {
    return this.refs.get(ref) ?? null;
  }

  async listRefs(prefix: string): Promise<readonly { ref: string; target: string }[]> {
    return [...this.refs.entries()].filter((entry): entry is [string, string] => entry[0].startsWith(prefix) && entry[1] !== null).map(([ref, target]) => ({ ref, target })).sort((left, right) => left.ref.localeCompare(right.ref));
  }

  async readFile(commit: string, path: string): Promise<string | null> {
    return this.commits.get(commit)?.files.get(path)?.content_base64 ?? null;
  }

  async listTree(commit: string, prefix = ""): Promise<readonly { path: string; oid: string; mode: string; type: "blob"; size: number }[]> {
    const stored = this.commits.get(commit);
    if (!stored) throw new Error("commit not found");
    const files = stored.files;
    return [...files.entries()].filter(([path]) => path.startsWith(prefix)).map(([path, entry]) => ({ path, oid: this.previewSha(path), mode: entry.mode, type: "blob" as const, size: entry.content_base64.length }));
  }

  async writeCommit(input: ForgeWriteCommitInput): Promise<string> {
    if (input.base === null && input.parents.length > 0) throw new Error("root commit cannot declare parents without a base tree");
    const files = new Map(input.base ? this.commits.get(input.base)?.files : undefined);
    for (const change of input.changes) {
      if (change.content_base64 === null) files.delete(change.path);
      else files.set(change.path, { content_base64: change.content_base64, mode: change.mode ?? files.get(change.path)?.mode ?? "100644" });
    }
    const sha = this.nextSha();
    this.commits.set(sha, { parents: [...input.parents], files });
    await this.afterWriteCommit?.(sha, input, files);
    return sha;
  }

  async compareCommits() {
    return { files: [] };
  }

  async mergeCommits(input: ForgeMergeInput): Promise<ForgeMergeResult> {
    if (this.conflictPaths.length > 0) return { status: "conflict", paths: this.conflictPaths };
    const commit = await this.writeCommit({ base: input.left, parents: [input.left, input.right], changes: [], message: input.message, author: input.author, timestamp: input.timestamp });
    return { status: "merged", commit };
  }

  async compareAndSwapRef(ref: string, expected: string | null, next: string | null): Promise<boolean> {
    return this.compareAndSwapRefs([{ ref, expected, next }]);
  }

  async compareAndSwapRefs(updates: readonly { readonly ref: string; readonly expected: string | null; readonly next: string | null }[]): Promise<boolean> {
    for (const update of updates) this.beforeCas?.(update.ref, update.expected, update.next);
    if (updates.some((update) => (this.refs.get(update.ref) ?? null) !== update.expected)) return false;
    for (const update of updates) {
      if (update.next === null) this.refs.delete(update.ref);
      else this.refs.set(update.ref, update.next);
    }
    return true;
  }

  async isAncestor(base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    const seen = new Set<string>();
    const stack = [head];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === base) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(this.commits.get(current)?.parents ?? []));
    }
    return false;
  }

  async writePublishIntent(operationId: string, expected: string, next: string, publishActor: ForgeActor): Promise<void> {
    const input = { operation_id: operationId, expected_version: expected, new_version: next, actor: publishActor };
    const record = { schema_version: 1, operation_id: operationId, request_digest: semanticDigest({ kind: "publish", input }), kind: "publish", input, status: "intent", timestamp: "2026-10-09T00:00:00.000Z" };
    const commit = await this.writeCommit({ base: null, parents: [], changes: [{ path: "operation.json", content_base64: encodeBase64Utf8(JSON.stringify(record)) }], message: "intent", author: { name: "test", email: "test@example.com" }, timestamp: "2026-10-09T00:00:00.000Z" });
    this.refs.set(`refs/heads/operations/${operationId}/intent`, commit);
  }

  private nextSha(): string {
    const sha = this.counter.toString(16).padStart(40, "0");
    this.counter += 1;
    return sha;
  }

  private previewSha(path: string): string {
    return path.length.toString(16).padStart(40, "0");
  }
}

interface FakeFileEntry {
  readonly content_base64: string;
  readonly mode: ForgeFileMode;
}
