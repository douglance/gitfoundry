import { describe, expect, it, vi } from "vitest";

import type { MergeCandidatePrepareInput } from "./index.js";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const digest = "a".repeat(64);
const env = { GFY_TRUSTED_GIT_HELPER_IMAGE: `registry.example/gitfoundry-helper@sha256:${digest}` };
const head = "1".repeat(40);
const base = "2".repeat(40);
const candidate = "3".repeat(40);
const tree = "4".repeat(40);
const candidateBytes = "5".repeat(64);

describe("merge candidate helper contract", () => {

  it.each(["headSha", "baseSha"] as const)("rejects the null Git sentinel in request %s", async (field) => {
    const { buildMergeCandidateAdmission, MergeCandidateContractError } = await import("./index.js");
    expect(() => buildMergeCandidateAdmission({ ...baseInput(), [field]: "0".repeat(40) }, env)).toThrow(MergeCandidateContractError);
  });

  it.each(["candidate_oid", "candidate_tree"] as const)("rejects the null Git sentinel in result %s", async (field) => {
    const { parseMergeCandidateResult, MergeCandidateContractError } = await import("./index.js");
    expect(() => parseMergeCandidateResult(JSON.stringify(successFrame(baseInput(), { [field]: "0".repeat(40) })), baseInput())).toThrow(MergeCandidateContractError);
  });

  it("requires the fast-forward candidate to be exactly the source head", async () => {
    const { parseMergeCandidateResult, MergeCandidateContractError } = await import("./index.js");
    const input = baseInput({ method: "fast_forward" });
    expect(() => parseMergeCandidateResult(JSON.stringify(successFrame(input)), input)).toThrow(MergeCandidateContractError);
    expect(parseMergeCandidateResult(JSON.stringify(successFrame(input, { candidate_oid: head })), input)).toMatchObject({ ok: true, candidateOid: head, originalToRebased: [] });
  });

  it.each(["merge", "squash", "fast_forward"] as const)("refuses a rebase map for method %s", async (method) => {
    const { parseMergeCandidateResult, MergeCandidateContractError } = await import("./index.js");
    const input = baseInput({ method });
    const frame = successFrame(input, { candidate_oid: method === "fast_forward" ? head : candidate, original_to_rebased: [{ original: head, rebased: candidate }] });
    expect(() => parseMergeCandidateResult(JSON.stringify(frame), input)).toThrow(MergeCandidateContractError);
  });

  it.each([
    [{ original: head, rebased: "6".repeat(40) }, { original: head, rebased: candidate }],
    [{ original: head, rebased: candidate }, { original: "6".repeat(40), rebased: candidate }],
    [{ original: head, rebased: "6".repeat(40) }],
    [{ original: "0".repeat(40), rebased: candidate }],
    [{ original: head, rebased: "0".repeat(40) }]
  ])("refuses an ambiguous or inconsistent rebase map %j", async (...entries) => {
    const { parseMergeCandidateResult, MergeCandidateContractError } = await import("./index.js");
    const input = baseInput({ method: "rebase" });
    expect(() => parseMergeCandidateResult(JSON.stringify(successFrame(input, { original_to_rebased: entries })), input)).toThrow(MergeCandidateContractError);
  });

  it("accepts a unique rebase map ending at the prepared candidate", async () => {
    const { parseMergeCandidateResult } = await import("./index.js");
    const input = baseInput({ method: "rebase" });
    const map = [{ original: "6".repeat(40), rebased: "7".repeat(40) }, { original: head, rebased: candidate }];
    expect(parseMergeCandidateResult(JSON.stringify(successFrame(input, { original_to_rebased: map })), input)).toMatchObject({ ok: true, candidateOid: candidate, originalToRebased: map });
  });
  it("builds one admitted pinned Linux helper invocation with a bounded versioned request frame", async () => {
    const { buildMergeCandidateAdmission, encodeMergeCandidatePrepareRequest } = await import("./index.js");

    const prepared = buildMergeCandidateAdmission(baseInput(), env);
    const encoded = encodeMergeCandidatePrepareRequest(baseInput());
    const frame = JSON.parse(prepared.stdin) as Record<string, unknown>;

    const expectedWire = { stdin: "{\"frame\":\"gitfoundry.merge-candidate.prepare.v1\",\"tenant_id\":\"tenant-a\",\"repository_id\":\"repo-a\",\"operation_id\":\"op-a\",\"pull_request_id\":\"pr-a\",\"pull_request_version\":7,\"method\":\"merge\",\"head_sha\":\"1111111111111111111111111111111111111111\",\"base_sha\":\"2222222222222222222222222222222222222222\",\"trusted_git_dir\":\"/work/tenant-a/repo-a/op-a/trusted-git\",\"state_dir\":\"/work/tenant-a/repo-a/op-a/merge-candidates\",\"committer\":{\"name\":\"GitFoundry Merge Bot\",\"email\":\"merge-bot@gitfoundry.invalid\",\"committed_at\":\"2026-10-08T00:00:00.000Z\"},\"message\":\"Merge pull request pr-a\",\"options\":{\"preserve_source_commits\":true,\"signing\":\"disabled\",\"external_filters\":\"disabled\",\"hooks\":\"disabled\",\"replace_refs\":\"disabled\"}}\n", stdinBytes: 712, requestSha256: "300386666d0718e38e6c820e1f597562113aab70f2042326c351c30bcc2ed4b7" };
    expect(encoded).toEqual(expectedWire);
    expect(prepared).toMatchObject(expectedWire);
    expect(prepared.admission.profile).toBe("trusted_git_helper");
    expect(prepared.admission.argv).toEqual([
      "/usr/local/bin/gitfoundry-merge-candidate",
      "prepare",
      "--request-format",
      "gitfoundry.merge-candidate.prepare.v1",
      "--request-sha256",
      prepared.requestSha256
    ]);
    expect(prepared.admission.egressProfile).toBe("deny_all");
    expect(prepared.admission.supervisorArgv).toContain("/usr/local/bin/gitfoundry-merge-candidate");
    expect(frame).toMatchObject({
      frame: "gitfoundry.merge-candidate.prepare.v1",
      tenant_id: "tenant-a",
      repository_id: "repo-a",
      operation_id: "op-a",
      pull_request_id: "pr-a",
      pull_request_version: 7,
      method: "merge",
      head_sha: head,
      base_sha: base,
      trusted_git_dir: "/work/tenant-a/repo-a/op-a/trusted-git",
      state_dir: "/work/tenant-a/repo-a/op-a/merge-candidates"
    });
    expect(prepared.stdinBytes).toBeGreaterThan(200);
    expect(prepared.stdinBytes).toBeLessThan(8192);
    expect(JSON.stringify(prepared)).not.toContain("GITHUB_TOKEN");
  });

  it("rejects hostile request fields before admitting the helper command", async () => {
    const { buildMergeCandidateAdmission, MergeCandidateContractError } = await import("./index.js");

    expect(() => buildMergeCandidateAdmission({ ...baseInput(), method: "octopus" as never }, env)).toThrow(MergeCandidateContractError);
    expect(() => buildMergeCandidateAdmission({ ...baseInput(), headSha: "-" + "1".repeat(39) }, env)).toThrow(MergeCandidateContractError);
    expect(() => buildMergeCandidateAdmission({ ...baseInput(), tenantId: "../tenant" }, env)).toThrow(MergeCandidateContractError);
    expect(() => buildMergeCandidateAdmission({ ...baseInput(), message: "x".repeat(9000) }, env)).toThrow(MergeCandidateContractError);
    expect(() => buildMergeCandidateAdmission({ ...baseInput(), committerEmail: "bad@example.invalid\u0000oops" }, env)).toThrow(MergeCandidateContractError);
  });

  it("parses one exact success frame and rejects mismatched stale or ambiguous stdout", async () => {
    const { parseMergeCandidateResult, MergeCandidateContractError } = await import("./index.js");
    const expected = baseInput();
    const ok = JSON.stringify({
      frame: "gitfoundry.merge-candidate.result.v1",
      ok: true,
      status: "prepared",
      tenant_id: expected.tenantId,
      repository_id: expected.repositoryId,
      operation_id: expected.operationId,
      pull_request_id: expected.pullRequestId,
      pull_request_version: expected.pullRequestVersion,
      method: expected.method,
      head_sha: head,
      base_sha: base,
      candidate_oid: candidate,
      candidate_tree: tree,
      candidate_bytes_sha256: candidateBytes,
      git_version: "2.39.5",
      state_ref: "merge-candidates/op-a/merge.json",
      original_to_rebased: []
    });

    expect(parseMergeCandidateResult(ok + "\n", expected)).toMatchObject({ ok: true, status: "prepared", candidateOid: candidate, candidateTree: tree, gitVersion: "2.39.5" });
    expect(() => parseMergeCandidateResult(ok + "\n" + ok + "\n", expected)).toThrow(MergeCandidateContractError);
    expect(() => parseMergeCandidateResult(ok.replace(head, "6".repeat(40)), expected)).toThrow(MergeCandidateContractError);
    expect(() => parseMergeCandidateResult(ok.replace("prepared", "ready"), expected)).toThrow(MergeCandidateContractError);
    expect(() => parseMergeCandidateResult(ok.replace(`,\"original_to_rebased\":[]`, `,\"original_to_rebased\":[],\"extra\":true`), expected)).toThrow(MergeCandidateContractError);
  });

  it("parses typed conflict and non-fast-forward failures without candidate identity", async () => {
    const { parseMergeCandidateResult } = await import("./index.js");
    const expected = baseInput({ method: "fast_forward" });
    const result = parseMergeCandidateResult(JSON.stringify({
      frame: "gitfoundry.merge-candidate.result.v1",
      ok: false,
      status: "non_fast_forward",
      tenant_id: expected.tenantId,
      repository_id: expected.repositoryId,
      operation_id: expected.operationId,
      pull_request_id: expected.pullRequestId,
      pull_request_version: expected.pullRequestVersion,
      method: expected.method,
      head_sha: head,
      base_sha: base,
      git_version: "2.39.5",
      state_ref: "merge-candidates/op-a/non-ff.json",
      diagnostics: [{ code: "target_not_ancestor", path: null }]
    }) + "\n", expected);

    expect(result).toEqual({ ok: false, status: "non_fast_forward", gitVersion: "2.39.5", stateRef: "merge-candidates/op-a/non-ff.json", diagnostics: [{ code: "target_not_ancestor", path: null }] });
  });
});

function successFrame(input: MergeCandidatePrepareInput, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    frame: "gitfoundry.merge-candidate.result.v1", ok: true, status: "prepared",
    tenant_id: input.tenantId, repository_id: input.repositoryId, operation_id: input.operationId,
    pull_request_id: input.pullRequestId, pull_request_version: input.pullRequestVersion,
    method: input.method, head_sha: input.headSha, base_sha: input.baseSha,
    candidate_oid: candidate, candidate_tree: tree, candidate_bytes_sha256: candidateBytes,
    git_version: "2.39.5", state_ref: "merge-candidates/op-a/merge.json", original_to_rebased: [],
    ...overrides
  };
}

function baseInput(overrides: Partial<MergeCandidatePrepareInput> = {}): MergeCandidatePrepareInput {
  return {
    commandId: "cmd-a",
    tenantId: "tenant-a",
    repositoryId: "repo-a",
    operationId: "op-a",
    fenceToken: "fence-a",
    pullRequestId: "pr-a",
    pullRequestVersion: 7,
    headSha: head,
    baseSha: base,
    method: "merge",
    committerName: "GitFoundry Merge Bot",
    committerEmail: "merge-bot@gitfoundry.invalid",
    committedAt: "2026-10-08T00:00:00.000Z",
    message: "Merge pull request pr-a",
    ...overrides
  };
}
