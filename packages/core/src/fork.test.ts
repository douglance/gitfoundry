import { describe, expect, it } from "vitest";

import { canonicalizeForgeDescriptor, forgeDescriptorDigest, retainedDescriptorRef, serializeForgeDescriptor } from "./fork.js";

const descriptor = {
  fork_id: "fork-main",
  parent_fork_ids: ["fork-parent-a", "fork-parent-b"],
  code_sha: "a".repeat(40),
  state_sha: "b".repeat(40),
  creator_id: "principal-a",
  operation_id: "op-123",
  created_at: "2026-10-09T00:00:00Z"
};

describe("forge version descriptors", () => {
  it("serializes the complete code and state roots as a deterministic Git record", async () => {
    const canonical = canonicalizeForgeDescriptor(descriptor);

    expect(canonical).toMatchObject({
      format: "gitfoundry.forge-version.v1",
      fork_id: "fork-main",
      parent_fork_ids: ["fork-parent-a", "fork-parent-b"],
      code_sha: "a".repeat(40),
      state_sha: "b".repeat(40)
    });
    expect(serializeForgeDescriptor(descriptor)).toBe(serializeForgeDescriptor({ ...descriptor, parent_fork_ids: ["fork-parent-a", "fork-parent-b"] }));
    const digest = await forgeDescriptorDigest(descriptor);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(retainedDescriptorRef(digest)).toBe(`refs/gitfoundry/descriptors/${digest.slice("sha256:".length)}`);
  });

  it("rejects ambiguous roots and duplicate parents", () => {
    expect(() => canonicalizeForgeDescriptor({ ...descriptor, code_sha: "branch-name" })).toThrow(/code_sha/);
    expect(() => canonicalizeForgeDescriptor({ ...descriptor, parent_fork_ids: ["fork-parent-a", "fork-parent-a"] })).toThrow(/duplicate parent/);
  });
});
