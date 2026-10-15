import { Context, Effect } from "effect";

import { DomainContractError, NotFoundError, StalePreconditionError, type Actor, type Repository } from "../index.js";

export const collaborationMetadataImplementedOperationIds = [
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
] as const;

export type CollaborationMetadataOperationId = typeof collaborationMetadataImplementedOperationIds[number];

export interface Page<T> { readonly items: readonly T[]; readonly next_cursor: string | null; readonly has_more: boolean }
export interface ForgeLabel { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly name: string; readonly color: string; readonly description: string; readonly managed_by_policy: boolean }
export interface ForgeLabelListQuery { readonly limit?: number; readonly cursor?: string; readonly direction?: "asc" | "desc"; readonly repository_id?: string; readonly name_prefix?: string; readonly sort?: "name" | "created_at" | "updated_at" }
export interface ForgeLabelCreateInput { readonly repository_id: string; readonly name: string; readonly color: string; readonly description?: string }
export interface ForgeLabelPatchInput { readonly name?: string; readonly color?: string; readonly description?: string }
export interface ForgeMilestone { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly title: string; readonly body: string; readonly due_at: string | null; readonly state: "open" | "closed"; readonly number: number; readonly open_count: number; readonly closed_count: number; readonly closed_at: string | null }
export interface ForgeMilestoneListQuery { readonly limit?: number; readonly cursor?: string; readonly direction?: "asc" | "desc"; readonly repository_id?: string; readonly state?: "open" | "closed" | "all"; readonly sort?: "due_at" | "title" | "created_at" | "updated_at" }
export interface ForgeMilestoneCreateInput { readonly repository_id: string; readonly title: string; readonly body?: string; readonly due_at?: string | null; readonly state?: "open" | "closed" }
export interface ForgeMilestonePatchInput { readonly title?: string; readonly body?: string; readonly due_at?: string | null; readonly state?: "open" | "closed" }
export interface ForgeDeleteInput { readonly expected_version: number; readonly reason: string }
export interface ForgeResourceLocator { readonly kind: "label" | "milestone"; readonly id: string; readonly repository_id: string | null; readonly version: number }
export interface ForgeDeletionResult { readonly resource: ForgeResourceLocator; readonly tombstoned_at: string; readonly restore_until: string | null; readonly purge_after: string | null; readonly held: boolean }
export interface ForgeOperationProgress { readonly stage: "completed"; readonly completed: number; readonly total: number | null; readonly blocked_reason: string | null }
export interface ForgeProblem { readonly code: string; readonly detail: string; readonly retryable: boolean; readonly request_id: string; readonly current_version: number | null; readonly field_errors: readonly { readonly path: string; readonly code: string; readonly message: string }[] }
export interface ForgeDeletionOperation { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled"; readonly kind: "label.delete" | "milestone.delete"; readonly progress: ForgeOperationProgress; readonly result: ForgeDeletionResult; readonly error: ForgeProblem | null }

export type CollaborationMetadataStoreError = NotFoundError | StalePreconditionError | DomainContractError;
export type CollaborationMetadataListError = NotFoundError | DomainContractError;

export interface CollaborationMetadataStore {
  readonly listLabels: (tenantId: string, query: ForgeLabelListQuery) => Effect.Effect<Page<ForgeLabel>, CollaborationMetadataListError>;
  readonly getLabel: (tenantId: string, id: string) => Effect.Effect<ForgeLabel, NotFoundError>;
  readonly createLabel: (tenantId: string, actor: Actor, input: ForgeLabelCreateInput) => Effect.Effect<ForgeLabel, CollaborationMetadataStoreError>;
  readonly updateLabel: (tenantId: string, id: string, expectedVersion: number, input: ForgeLabelPatchInput) => Effect.Effect<ForgeLabel, CollaborationMetadataStoreError>;
  readonly deleteLabel: (tenantId: string, id: string, actor: Actor, input: ForgeDeleteInput) => Effect.Effect<ForgeDeletionOperation, CollaborationMetadataStoreError>;
  readonly listMilestones: (tenantId: string, query: ForgeMilestoneListQuery) => Effect.Effect<Page<ForgeMilestone>, CollaborationMetadataListError>;
  readonly getMilestone: (tenantId: string, id: string) => Effect.Effect<ForgeMilestone, NotFoundError>;
  readonly createMilestone: (tenantId: string, actor: Actor, input: ForgeMilestoneCreateInput) => Effect.Effect<ForgeMilestone, CollaborationMetadataStoreError>;
  readonly updateMilestone: (tenantId: string, id: string, expectedVersion: number, input: ForgeMilestonePatchInput) => Effect.Effect<ForgeMilestone, CollaborationMetadataStoreError>;
  readonly deleteMilestone: (tenantId: string, id: string, actor: Actor, input: ForgeDeleteInput) => Effect.Effect<ForgeDeletionOperation, CollaborationMetadataStoreError>;
}

export const CollaborationMetadataStore = Context.Service<CollaborationMetadataStore>("gitfoundry/CollaborationMetadataStore");

export function makeFakeCollaborationMetadataStore(input: { readonly repositories: readonly Repository[]; readonly labels?: readonly ForgeLabel[]; readonly milestones?: readonly ForgeMilestone[]; readonly now?: string }): CollaborationMetadataStore {
  const now = input.now ?? "2026-10-08T00:00:00.000Z";
  const repositories = new Map(input.repositories.map((repository) => [key(repository.tenant_id, repository.id), { ...repository }]));
  const labels = new Map((input.labels ?? []).map((label) => [key(label.tenant_id, label.id), copyLabel(label)]));
  const milestones = new Map((input.milestones ?? []).map((milestone) => [key(milestone.tenant_id, milestone.id), copyMilestone(milestone)]));
  let operationNumber = 0;

  return {
    listLabels: (tenantId, query) => Effect.gen(function* () {
      yield* assertOptionalRepository(repositories, tenantId, query.repository_id);
      const items = sortLabels(Array.from(labels.values()).filter((label) => label.tenant_id === tenantId && (!query.repository_id || label.repository_id === query.repository_id) && (!query.name_prefix || label.name.startsWith(query.name_prefix))), query);
      return yield* pageItems("label", labelScope(tenantId, query), query.direction ?? "desc", items, query.limit, query.cursor, (label) => labelSortValue(label, query.sort), copyLabel);
    }),
    getLabel: (tenantId, id) => getFromMap(labels, tenantId, id, "label", copyLabel),
    createLabel: (tenantId, _actor, input) => Effect.gen(function* () {
      yield* requireRepository(repositories, tenantId, input.repository_id);
      yield* requireUniqueLabel(labels, tenantId, input.repository_id, input.name);
      const label: ForgeLabel = { tenant_id: tenantId, id: makeId("label", input.repository_id, labelSlug(input.name)), version: 1, created_at: now, updated_at: now, repository_id: input.repository_id, name: input.name.normalize("NFC"), color: canonicalColor(input.color), description: input.description ?? "", managed_by_policy: false };
      labels.set(key(tenantId, label.id), copyLabel(label));
      return copyLabel(label);
    }),
    updateLabel: (tenantId, id, expectedVersion, patch) => Effect.gen(function* () {
      const label = yield* getFromMap(labels, tenantId, id, "label", copyLabel);
      yield* requireVersion(expectedVersion, label.version);
      if (patch.name !== undefined) yield* requireUniqueLabel(labels, tenantId, label.repository_id, patch.name, id);
      const updated: ForgeLabel = { ...label, name: patch.name?.normalize("NFC") ?? label.name, color: patch.color !== undefined ? canonicalColor(patch.color) : label.color, description: patch.description ?? label.description, version: label.version + 1, updated_at: now };
      labels.set(key(tenantId, id), copyLabel(updated));
      return copyLabel(updated);
    }),
    deleteLabel: (tenantId, id, _actor, input) => Effect.gen(function* () {
      const label = yield* getFromMap(labels, tenantId, id, "label", copyLabel);
      yield* requireVersion(input.expected_version, label.version);
      requireReason(input.reason);
      labels.delete(key(tenantId, id));
      return deletionOperation(tenantId, "label.delete", ++operationNumber, now, { kind: "label", id, repository_id: label.repository_id, version: label.version });
    }),
    listMilestones: (tenantId, query) => Effect.gen(function* () {
      yield* assertOptionalRepository(repositories, tenantId, query.repository_id);
      const items = sortMilestones(Array.from(milestones.values()).filter((milestone) => milestone.tenant_id === tenantId && (!query.repository_id || milestone.repository_id === query.repository_id) && (!query.state || query.state === "all" || milestone.state === query.state)), query);
      return yield* pageItems("milestone", milestoneScope(tenantId, query), query.direction ?? "desc", items, query.limit, query.cursor, (milestone) => milestoneSortValue(milestone, query.sort), copyMilestone);
    }),
    getMilestone: (tenantId, id) => getFromMap(milestones, tenantId, id, "milestone", copyMilestone),
    createMilestone: (tenantId, _actor, input) => Effect.gen(function* () {
      yield* requireRepository(repositories, tenantId, input.repository_id);
      yield* requireUniqueMilestone(milestones, tenantId, input.repository_id, input.title);
      const number = nextNumber(milestones, tenantId, input.repository_id);
      const state = input.state ?? "open";
      const milestone: ForgeMilestone = { tenant_id: tenantId, id: makeId("milestone", input.repository_id, String(number)), version: 1, created_at: now, updated_at: now, repository_id: input.repository_id, title: input.title, body: input.body ?? "", due_at: input.due_at ?? null, state, number, open_count: 0, closed_count: 0, closed_at: state === "closed" ? now : null };
      milestones.set(key(tenantId, milestone.id), copyMilestone(milestone));
      return copyMilestone(milestone);
    }),
    updateMilestone: (tenantId, id, expectedVersion, patch) => Effect.gen(function* () {
      const milestone = yield* getFromMap(milestones, tenantId, id, "milestone", copyMilestone);
      yield* requireVersion(expectedVersion, milestone.version);
      if (patch.title !== undefined) yield* requireUniqueMilestone(milestones, tenantId, milestone.repository_id, patch.title, id);
      const state = patch.state ?? milestone.state;
      const updated: ForgeMilestone = { ...milestone, title: patch.title ?? milestone.title, body: patch.body ?? milestone.body, due_at: patch.due_at !== undefined ? patch.due_at : milestone.due_at, state, closed_at: state === "closed" ? milestone.closed_at ?? now : null, version: milestone.version + 1, updated_at: now };
      milestones.set(key(tenantId, id), copyMilestone(updated));
      return copyMilestone(updated);
    }),
    deleteMilestone: (tenantId, id, _actor, input) => Effect.gen(function* () {
      const milestone = yield* getFromMap(milestones, tenantId, id, "milestone", copyMilestone);
      yield* requireVersion(input.expected_version, milestone.version);
      requireReason(input.reason);
      milestones.delete(key(tenantId, id));
      return deletionOperation(tenantId, "milestone.delete", ++operationNumber, now, { kind: "milestone", id, repository_id: milestone.repository_id, version: milestone.version });
    })
  };
}

function key(tenantId: string, id: string): string { return tenantId + ":" + id; }
function makeId(kind: string, repositoryId: string, suffix: string): string { return (repositoryId + "-" + kind + "-" + suffix).replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128); }
function labelSlug(name: string): string { return name.normalize("NFC").trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "label"; }
function readLimit(value: number | undefined): number { return Number.isInteger(value) ? Math.max(1, Math.min(1000, value as number)) : 100; }
function canonicalColor(value: string): string { const color = value.toLowerCase(); if (!/^[0-9a-f]{6}$/.test(color)) throw new DomainContractError({ message: "invalid label color" }); return color; }
function requireReason(reason: string): void { if (reason.trim().length === 0) throw new DomainContractError({ message: "delete reason is required" }); }
function copyLabel(label: ForgeLabel): ForgeLabel { return { ...label }; }
function copyMilestone(milestone: ForgeMilestone): ForgeMilestone { return { ...milestone }; }

function getFromMap<T>(items: Map<string, T>, tenantId: string, id: string, resource: string, copy: (value: T) => T): Effect.Effect<T, NotFoundError> {
  const item = items.get(key(tenantId, id));
  return item ? Effect.succeed(copy(item)) : Effect.fail(new NotFoundError({ resource, id }));
}

function requireRepository(repositories: Map<string, Repository>, tenantId: string, id: string): Effect.Effect<Repository, NotFoundError> {
  const repository = repositories.get(key(tenantId, id));
  return repository ? Effect.succeed({ ...repository }) : Effect.fail(new NotFoundError({ resource: "repository", id }));
}

function assertOptionalRepository(repositories: Map<string, Repository>, tenantId: string, id: string | undefined): Effect.Effect<void, NotFoundError> {
  return id ? Effect.asVoid(requireRepository(repositories, tenantId, id)) : Effect.void;
}

function requireVersion(expected: number, actual: number): Effect.Effect<void, StalePreconditionError> {
  return expected === actual ? Effect.void : Effect.fail(new StalePreconditionError({ expected, actual }));
}

function requireUniqueLabel(labels: Map<string, ForgeLabel>, tenantId: string, repositoryId: string, name: string, exceptId?: string): Effect.Effect<void, DomainContractError> {
  const folded = name.normalize("NFC").toLowerCase();
  const duplicate = Array.from(labels.values()).some((label) => label.tenant_id === tenantId && label.repository_id === repositoryId && label.id !== exceptId && label.name.normalize("NFC").toLowerCase() === folded);
  return duplicate ? Effect.fail(new DomainContractError({ message: "label name already exists in repository" })) : Effect.void;
}

function requireUniqueMilestone(milestones: Map<string, ForgeMilestone>, tenantId: string, repositoryId: string, title: string, exceptId?: string): Effect.Effect<void, DomainContractError> {
  const duplicate = Array.from(milestones.values()).some((milestone) => milestone.tenant_id === tenantId && milestone.repository_id === repositoryId && milestone.id !== exceptId && milestone.title === title);
  return duplicate ? Effect.fail(new DomainContractError({ message: "milestone title already exists in repository" })) : Effect.void;
}

function nextNumber(items: Map<string, ForgeMilestone>, tenantId: string, repositoryId: string): number {
  return Math.max(0, ...Array.from(items.values()).filter((item) => item.tenant_id === tenantId && item.repository_id === repositoryId).map((item) => item.number)) + 1;
}

function sortLabels(items: readonly ForgeLabel[], query: ForgeLabelListQuery): readonly ForgeLabel[] {
  return sortBy(items, (label) => labelSortValue(label, query.sort), query.direction);
}

function sortMilestones(items: readonly ForgeMilestone[], query: ForgeMilestoneListQuery): readonly ForgeMilestone[] {
  return sortBy(items, (milestone) => milestoneSortValue(milestone, query.sort), query.direction);
}

function sortBy<T extends { readonly id: string }>(items: readonly T[], value: (item: T) => string, direction: "asc" | "desc" | undefined): readonly T[] {
  return [...items].sort((left, right) => compareCursorParts(value(left), left.id, value(right), right.id, direction));
}

function labelSortValue(label: ForgeLabel, sort: ForgeLabelListQuery["sort"]): string { return sort === "name" ? label.name : sort === "updated_at" ? label.updated_at : label.created_at; }
function milestoneSortValue(milestone: ForgeMilestone, sort: ForgeMilestoneListQuery["sort"]): string { return sort === "due_at" ? milestone.due_at ?? "" : sort === "title" ? milestone.title : sort === "updated_at" ? milestone.updated_at : milestone.created_at; }
function labelScope(tenantId: string, query: ForgeLabelListQuery): string { return hashString(JSON.stringify(["label", tenantId, query.repository_id ?? null, query.name_prefix ?? null, query.sort ?? "created_at", query.direction ?? "desc"])); }
function milestoneScope(tenantId: string, query: ForgeMilestoneListQuery): string { return hashString(JSON.stringify(["milestone", tenantId, query.repository_id ?? null, query.state ?? null, query.sort ?? "created_at", query.direction ?? "desc"])); }

function pageItems<T extends { readonly id: string }>(kind: string, scope: string, direction: "asc" | "desc", items: readonly T[], limitInput: number | undefined, cursorInput: string | undefined, sortValue: (item: T) => string, copy: (item: T) => T): Effect.Effect<Page<T>, DomainContractError> {
  return Effect.try({ try: () => {
    const limit = readLimit(limitInput);
    const cursor = decodeCursor(kind, scope, cursorInput);
    const afterCursor = cursor ? items.filter((item) => compareCursorParts(sortValue(item), item.id, cursor.sort, cursor.id, direction) > 0) : items;
    const page = afterCursor.slice(0, limit);
    const hasMore = afterCursor.length > limit;
    const last = page[page.length - 1];
    return { items: page.map(copy), has_more: hasMore, next_cursor: hasMore && last ? encodeCursor(kind, scope, direction, sortValue(last), last.id) : null };
  }, catch: (error) => error instanceof DomainContractError ? error : new DomainContractError({ message: String(error) }) });
}

function compareCursorParts(leftSort: string, leftId: string, rightSort: string, rightId: string, direction: "asc" | "desc" | undefined): number {
  const primary = leftSort.localeCompare(rightSort);
  const secondary = primary === 0 ? leftId.localeCompare(rightId) : primary;
  return direction === "asc" ? secondary : -secondary;
}

interface CursorPayload { readonly v: 1; readonly kind: string; readonly scope: string; readonly direction: "asc" | "desc"; readonly sort: string; readonly id: string }
function encodeCursor(kind: string, scope: string, direction: "asc" | "desc", sort: string, id: string): string { return "cursor:" + encodeURIComponent(JSON.stringify({ v: 1, kind, scope, direction, sort, id } satisfies CursorPayload)); }
function decodeCursor(kind: string, scope: string, cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    if (!cursor.startsWith("cursor:")) throw new Error("missing cursor prefix");
    const parsed = JSON.parse(decodeURIComponent(cursor.slice("cursor:".length))) as Partial<CursorPayload>;
    if (parsed.v !== 1 || parsed.kind !== kind || parsed.scope !== scope || (parsed.direction !== "asc" && parsed.direction !== "desc") || typeof parsed.sort !== "string" || typeof parsed.id !== "string") throw new Error("cursor scope mismatch");
    return parsed as CursorPayload;
  } catch {
    throw new DomainContractError({ message: "invalid or inconsistent pagination cursor" });
  }
}

function deletionOperation(tenantId: string, kind: ForgeDeletionOperation["kind"], ordinal: number, now: string, resource: ForgeResourceLocator): ForgeDeletionOperation {
  return { tenant_id: tenantId, id: "op-" + kind.replace(".", "-") + "-" + ordinal, version: 1, created_at: now, updated_at: now, status: "succeeded", kind, progress: { stage: "completed", completed: 1, total: 1, blocked_reason: null }, result: { resource, tombstoned_at: now, restore_until: null, purge_after: null, held: false }, error: null };
}

function hashString(value: string): string { let hash = 5381; for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index); return (hash >>> 0).toString(16); }
