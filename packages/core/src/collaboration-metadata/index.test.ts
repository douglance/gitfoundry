import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { DomainContractError, NotFoundError, StalePreconditionError } from "../index.js";
import { collaborationMetadataImplementedOperationIds, makeFakeCollaborationMetadataStore } from "./index.js";

const now = "2026-10-08T00:00:00.000Z";
const actor = { id: "principal-a", tenantId: "tenant-a", revoked: false, capabilities: [] };
const repositories = [
  { tenant_id: "tenant-a", id: "repo-a", version: 1, created_at: now, updated_at: now, namespace_id: "ns-a", name: "demo", visibility: "private" as const, default_branch: "main", archived: false, fork_of: null, git_url: "https://git.example/a.git" },
  { tenant_id: "tenant-b", id: "repo-a", version: 1, created_at: now, updated_at: now, namespace_id: "ns-b", name: "demo", visibility: "private" as const, default_branch: "main", archived: false, fork_of: null, git_url: "https://git.example/b.git" }
];

describe("collaboration metadata domain store", () => {
  it("declares the accepted label and milestone operation family", () => {
    expect(collaborationMetadataImplementedOperationIds).toEqual([
      "label.list",
      "label.view",
      "label.create",
      "label.edit",
      "label.delete",
      "milestone.list",
      "milestone.view",
      "milestone.create",
      "milestone.edit",
      "milestone.delete"
    ]);
  });

  it("keeps labels tenant-scoped, versioned, rename-stable, and deletable", async () => {
    const store = makeFakeCollaborationMetadataStore({ repositories, now });
    const created = await Effect.runPromise(store.createLabel("tenant-a", actor, { repository_id: "repo-a", name: "Bug", color: "FF0000" }));
    expect(created).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", name: "Bug", color: "ff0000", description: "", managed_by_policy: false, version: 1 });
    await expect(Effect.runPromise(store.getLabel("tenant-b", created.id))).rejects.toBeInstanceOf(NotFoundError);
    const renamed = await Effect.runPromise(store.updateLabel("tenant-a", created.id, 1, { name: "Defect", description: "Needs triage" }));
    expect(renamed).toMatchObject({ id: created.id, version: 2, name: "Defect", description: "Needs triage" });
    await expect(Effect.runPromise(store.updateLabel("tenant-a", created.id, 1, { color: "00ff00" }))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(store.listLabels("tenant-a", { repository_id: "repo-a", name_prefix: "Def" }))).resolves.toMatchObject({ items: [{ id: created.id }], has_more: false, next_cursor: null });
    const deleted = await Effect.runPromise(store.deleteLabel("tenant-a", created.id, actor, { expected_version: 2, reason: "taxonomy cleanup" }));
    expect(deleted).toMatchObject({ tenant_id: "tenant-a", status: "succeeded", kind: "label.delete", result: { resource: { kind: "label", id: created.id, repository_id: "repo-a", version: 2 }, held: false } });
    await expect(Effect.runPromise(store.getLabel("tenant-a", created.id))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps milestones repository-scoped, numbered, stateful, and versioned", async () => {
    const store = makeFakeCollaborationMetadataStore({ repositories, now });
    const first = await Effect.runPromise(store.createMilestone("tenant-a", actor, { repository_id: "repo-a", title: "M1" }));
    const second = await Effect.runPromise(store.createMilestone("tenant-a", actor, { repository_id: "repo-a", title: "M2", body: "scope", due_at: "2026-12-01T00:00:00.000Z", state: "closed" }));
    expect(first).toMatchObject({ number: 1, body: "", due_at: null, state: "open", open_count: 0, closed_count: 0, closed_at: null });
    expect(second).toMatchObject({ number: 2, state: "closed", closed_at: now });
    const reopened = await Effect.runPromise(store.updateMilestone("tenant-a", second.id, 1, { state: "open", due_at: null }));
    expect(reopened).toMatchObject({ version: 2, state: "open", due_at: null, closed_at: null });
    await expect(Effect.runPromise(store.listMilestones("tenant-a", { repository_id: "repo-a", state: "open", sort: "title", direction: "asc" }))).resolves.toMatchObject({ items: [{ id: first.id }, { id: second.id }] });
    await expect(Effect.runPromise(store.deleteMilestone("tenant-b", second.id, actor, { expected_version: 2, reason: "wrong tenant" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("pages fake labels with stable scoped cursors", async () => {
    const store = makeFakeCollaborationMetadataStore({ repositories, now });
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) await Effect.runPromise(store.createLabel("tenant-a", actor, { repository_id: "repo-a", name, color: "00ff00" }));
    const first = await Effect.runPromise(store.listLabels("tenant-a", { repository_id: "repo-a", sort: "created_at", direction: "asc", limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await Effect.runPromise(store.listLabels("tenant-a", { repository_id: "repo-a", sort: "created_at", direction: "asc", limit: 2, cursor: first.next_cursor! }));
    expect(second.items.map((label) => label.id)).not.toContain(first.items[0]!.id);
    expect(new Set([...first.items, ...second.items].map((label) => label.id)).size).toBe(4);
    await expect(Effect.runPromise(store.listLabels("tenant-b", { repository_id: "repo-a", sort: "created_at", direction: "asc", limit: 2, cursor: first.next_cursor! }))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(store.listLabels("tenant-a", { repository_id: "repo-a", name_prefix: "A", sort: "created_at", direction: "asc", limit: 2, cursor: first.next_cursor! }))).rejects.toBeInstanceOf(DomainContractError);
  });
});
