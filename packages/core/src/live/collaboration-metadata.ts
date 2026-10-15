import { Effect } from "effect";

import { DomainContractError, NotFoundError, StalePreconditionError, type Actor } from "../index.js";
import type { Clock, D1DatabaseLike, D1PreparedStatement, D1Result } from "./index.js";
import type { CollaborationMetadataStore, ForgeDeleteInput, ForgeDeletionOperation, ForgeDeletionResult, ForgeLabel, ForgeLabelCreateInput, ForgeLabelListQuery, ForgeLabelPatchInput, ForgeMilestone, ForgeMilestoneCreateInput, ForgeMilestoneListQuery, ForgeMilestonePatchInput, ForgeResourceLocator, Page } from "../collaboration-metadata/index.js";

const systemClock: Clock = { now: () => new Date() };

interface CollaborationMetadataStoreOptions { readonly clock?: Clock; readonly beforeDeleteBatch?: (input: { readonly tenantId: string; readonly id: string; readonly kind: "label" | "milestone"; readonly expectedVersion: number }) => void | Promise<void> }

export function makeD1CollaborationMetadataStore(db: D1DatabaseLike, options: CollaborationMetadataStoreOptions = {}): CollaborationMetadataStore {
  const clock = options.clock ?? systemClock;
  return {
    listLabels: (tenantId, query) => Effect.tryPromise({ try: async () => {
      if (query.repository_id) await requireRepository(db, tenantId, query.repository_id);
      return listLabels(db, tenantId, query);
    }, catch: (error) => preserveListError(error, "label", query.repository_id ?? tenantId) }),
    getLabel: (tenantId, id) => Effect.tryPromise({ try: async () => {
      const label = await readLabel(db, tenantId, id);
      if (!label) throw new NotFoundError({ resource: "label", id });
      await requireRepository(db, tenantId, label.repository_id);
      return label;
    }, catch: (error) => preserveReadError(error, "label", id) }),
    createLabel: (tenantId, _actor, input) => Effect.tryPromise({ try: async () => createLabel(db, clock, tenantId, input), catch: (error) => preserveKnownError(error, "label", input.repository_id) }),
    updateLabel: (tenantId, id, expectedVersion, input) => Effect.tryPromise({ try: async () => updateLabel(db, clock, tenantId, id, expectedVersion, input), catch: (error) => preserveKnownError(error, "label", id) }),
    deleteLabel: (tenantId, id, actor, input) => Effect.tryPromise({ try: async () => deleteLabel(db, clock, options, tenantId, id, actor, input), catch: (error) => preserveKnownError(error, "label", id) }),
    listMilestones: (tenantId, query) => Effect.tryPromise({ try: async () => {
      if (query.repository_id) await requireRepository(db, tenantId, query.repository_id);
      return listMilestones(db, tenantId, query);
    }, catch: (error) => preserveListError(error, "milestone", query.repository_id ?? tenantId) }),
    getMilestone: (tenantId, id) => Effect.tryPromise({ try: async () => {
      const milestone = await readMilestone(db, tenantId, id);
      if (!milestone) throw new NotFoundError({ resource: "milestone", id });
      await requireRepository(db, tenantId, milestone.repository_id);
      return milestone;
    }, catch: (error) => preserveReadError(error, "milestone", id) }),
    createMilestone: (tenantId, _actor, input) => Effect.tryPromise({ try: async () => createMilestone(db, clock, tenantId, input), catch: (error) => preserveKnownError(error, "milestone", input.repository_id) }),
    updateMilestone: (tenantId, id, expectedVersion, input) => Effect.tryPromise({ try: async () => updateMilestone(db, clock, tenantId, id, expectedVersion, input), catch: (error) => preserveKnownError(error, "milestone", id) }),
    deleteMilestone: (tenantId, id, actor, input) => Effect.tryPromise({ try: async () => deleteMilestone(db, clock, options, tenantId, id, actor, input), catch: (error) => preserveKnownError(error, "milestone", id) })
  };
}

async function createLabel(db: D1DatabaseLike, clock: Clock, tenantId: string, input: ForgeLabelCreateInput): Promise<ForgeLabel> {
  await requireRepository(db, tenantId, input.repository_id);
  await requireUniqueLabel(db, tenantId, input.repository_id, input.name);
  const now = clock.now().toISOString();
  const label: ForgeLabel = { tenant_id: tenantId, id: stableResourceId("label", input.repository_id, labelSlug(input.name)), version: 1, created_at: now, updated_at: now, repository_id: input.repository_id, name: normalizeDisplay(input.name, 100, "label name"), color: canonicalColor(input.color), description: input.description ? boundedText(input.description, 1024, "label description") : "", managed_by_policy: false };
  await db.prepare("INSERT INTO labels(tenant_id,id,version,created_at,updated_at,repository_id,name,color,description) VALUES(?,?,?,?,?,?,?,?,?)").bind(label.tenant_id, label.id, label.version, label.created_at, label.updated_at, label.repository_id, label.name, label.color, label.description).run();
  return label;
}

async function updateLabel(db: D1DatabaseLike, clock: Clock, tenantId: string, id: string, expectedVersion: number, input: ForgeLabelPatchInput): Promise<ForgeLabel> {
  const current = await readLabel(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "label", id });
  if (current.version !== expectedVersion) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
  if (input.name === undefined && input.color === undefined && input.description === undefined) throw new DomainContractError({ message: "label patch requires at least one mutable field" });
  if (input.name !== undefined) await requireUniqueLabel(db, tenantId, current.repository_id, input.name, id);
  const name = input.name !== undefined ? normalizeDisplay(input.name, 100, "label name") : current.name;
  const color = input.color !== undefined ? canonicalColor(input.color) : current.color;
  const description = input.description !== undefined ? boundedText(input.description, 1024, "label description") : current.description;
  const now = clock.now().toISOString();
  const result = await db.prepare("UPDATE labels SET version = version + 1, updated_at = ?, name = ?, color = ?, description = ? WHERE tenant_id = ? AND id = ? AND version = ?").bind(now, name, color, description, tenantId, id, expectedVersion).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
  const updated = await readLabel(db, tenantId, id);
  if (!updated) throw new NotFoundError({ resource: "label", id });
  return updated;
}

async function deleteLabel(db: D1DatabaseLike, clock: Clock, options: CollaborationMetadataStoreOptions, tenantId: string, id: string, actor: Actor, input: ForgeDeleteInput): Promise<ForgeDeletionOperation> {
  const batch = requireAtomicBatch(db);
  const current = await readLabel(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "label", id });
  if (current.version !== input.expected_version) throw new StalePreconditionError({ expected: input.expected_version, actual: current.version });
  requireReason(input.reason);
  await options.beforeDeleteBatch?.({ tenantId, id, kind: "label", expectedVersion: input.expected_version });
  const operation = await deletionOperation(db, clock, tenantId, actor.id, "label.delete", { kind: "label", id, repository_id: current.repository_id, version: current.version });
  const results = await runAtomicBatch(batch, [
    operationInsertFromLabel(db, operation, actor.id, tenantId, id, input.expected_version),
    db.prepare("DELETE FROM issue_labels WHERE tenant_id = ? AND label_id = ? AND EXISTS (SELECT 1 FROM labels WHERE tenant_id = ? AND id = ? AND version = ?)").bind(tenantId, id, tenantId, id, input.expected_version),
    db.prepare("DELETE FROM labels WHERE tenant_id = ? AND id = ? AND version = ?").bind(tenantId, id, input.expected_version)
  ], "label delete requires atomic D1 batch");
  if (changed(results[0]) !== 1 || changed(results[2]) !== 1) {
    const actual = await readLabel(db, tenantId, id);
    throw new StalePreconditionError({ expected: input.expected_version, actual: actual?.version ?? current.version });
  }
  return operation;
}

async function createMilestone(db: D1DatabaseLike, clock: Clock, tenantId: string, input: ForgeMilestoneCreateInput): Promise<ForgeMilestone> {
  await requireRepository(db, tenantId, input.repository_id);
  await requireUniqueMilestone(db, tenantId, input.repository_id, input.title);
  const now = clock.now().toISOString();
  const number = await nextMilestoneNumber(db, tenantId, input.repository_id);
  const state = input.state ?? "open";
  const id = stableResourceId("milestone", input.repository_id, String(number));
  const title = normalizeDisplay(input.title, 256, "milestone title");
  const body = input.body !== undefined ? boundedText(input.body, 1048576, "milestone body") : "";
  const dueAt = input.due_at ?? null;
  await db.prepare("INSERT INTO milestones(tenant_id,id,version,created_at,updated_at,repository_id,title,body,due_at,state) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(tenantId, id, 1, now, now, input.repository_id, title, body, dueAt, state).run();
  const milestone = await readMilestone(db, tenantId, id);
  if (!milestone) throw new NotFoundError({ resource: "milestone", id });
  return milestone;
}

async function updateMilestone(db: D1DatabaseLike, clock: Clock, tenantId: string, id: string, expectedVersion: number, input: ForgeMilestonePatchInput): Promise<ForgeMilestone> {
  const current = await readMilestone(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "milestone", id });
  if (current.version !== expectedVersion) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
  if (input.title === undefined && input.body === undefined && input.due_at === undefined && input.state === undefined) throw new DomainContractError({ message: "milestone patch requires at least one mutable field" });
  if (input.title !== undefined) await requireUniqueMilestone(db, tenantId, current.repository_id, input.title, id);
  const title = input.title !== undefined ? normalizeDisplay(input.title, 256, "milestone title") : current.title;
  const body = input.body !== undefined ? boundedText(input.body, 1048576, "milestone body") : current.body;
  const dueAt = input.due_at !== undefined ? input.due_at : current.due_at;
  const state = input.state ?? current.state;
  const now = clock.now().toISOString();
  const result = await db.prepare("UPDATE milestones SET version = version + 1, updated_at = ?, title = ?, body = ?, due_at = ?, state = ? WHERE tenant_id = ? AND id = ? AND version = ?").bind(now, title, body, dueAt, state, tenantId, id, expectedVersion).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
  const updated = await readMilestone(db, tenantId, id);
  if (!updated) throw new NotFoundError({ resource: "milestone", id });
  return updated;
}

async function deleteMilestone(db: D1DatabaseLike, clock: Clock, options: CollaborationMetadataStoreOptions, tenantId: string, id: string, actor: Actor, input: ForgeDeleteInput): Promise<ForgeDeletionOperation> {
  const batch = requireAtomicBatch(db);
  const current = await readMilestone(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "milestone", id });
  if (current.version !== input.expected_version) throw new StalePreconditionError({ expected: input.expected_version, actual: current.version });
  requireReason(input.reason);
  await options.beforeDeleteBatch?.({ tenantId, id, kind: "milestone", expectedVersion: input.expected_version });
  const operation = await deletionOperation(db, clock, tenantId, actor.id, "milestone.delete", { kind: "milestone", id, repository_id: current.repository_id, version: current.version });
  const results = await runAtomicBatch(batch, [
    operationInsertFromMilestone(db, operation, actor.id, tenantId, id, input.expected_version),
    db.prepare("DELETE FROM milestones WHERE tenant_id = ? AND id = ? AND version = ?").bind(tenantId, id, input.expected_version)
  ], "milestone delete requires atomic D1 batch");
  if (changed(results[0]) !== 1 || changed(results[1]) !== 1) {
    const actual = await readMilestone(db, tenantId, id);
    throw new StalePreconditionError({ expected: input.expected_version, actual: actual?.version ?? current.version });
  }
  return operation;
}

async function listLabels(db: D1DatabaseLike, tenantId: string, query: ForgeLabelListQuery): Promise<Page<ForgeLabel>> {
  const limit = readLimit(query.limit);
  const sort = labelSortColumn(query.sort);
  const direction = sortDirection(query.direction);
  const cursor = decodeCursor("label", labelScope(tenantId, query), query.cursor);
  const params: unknown[] = [tenantId];
  const filters = ["tenant_id = ?"];
  if (query.repository_id) { filters.push("repository_id = ?"); params.push(query.repository_id); }
  if (query.name_prefix !== undefined) { filters.push("substr(name, 1, ?) = ?"); params.push(query.name_prefix.length, query.name_prefix); }
  if (cursor) { filters.push(cursorPredicate(labelSortExpression(sort), direction)); params.push(cursor.sort, cursor.sort, cursor.id); }
  const rows = await db.prepare(labelSelectSql() + " WHERE " + filters.join(" AND ") + " ORDER BY " + labelSortExpression(sort) + " " + direction + ", id " + direction + " LIMIT ?").bind(...params, limit + 1).all<LabelRow>();
  const labels = (rows.results ?? []).map(toLabel);
  return pageFromRows("label", labelScope(tenantId, query), query.direction ?? "desc", labels, limit, (label) => labelSortValue(label, query.sort));
}

async function listMilestones(db: D1DatabaseLike, tenantId: string, query: ForgeMilestoneListQuery): Promise<Page<ForgeMilestone>> {
  const limit = readLimit(query.limit);
  const sort = milestoneSortColumn(query.sort);
  const direction = sortDirection(query.direction);
  const cursor = decodeCursor("milestone", milestoneScope(tenantId, query), query.cursor);
  const params: unknown[] = [tenantId];
  const filters = ["tenant_id = ?"];
  if (query.repository_id) { filters.push("repository_id = ?"); params.push(query.repository_id); }
  if (query.state && query.state !== "all") { filters.push("state = ?"); params.push(query.state); }
  if (cursor) { filters.push(cursorPredicate(milestoneSortExpression(sort), direction)); params.push(cursor.sort, cursor.sort, cursor.id); }
  const rows = await db.prepare(milestoneSelectSql() + " WHERE " + filters.join(" AND ") + " ORDER BY " + milestoneSortExpression(sort) + " " + direction + ", id " + direction + " LIMIT ?").bind(...params, limit + 1).all<MilestoneRow>();
  const milestones = await Promise.all((rows.results ?? []).map((row) => toMilestone(db, row)));
  return pageFromRows("milestone", milestoneScope(tenantId, query), query.direction ?? "desc", milestones, limit, (milestone) => milestoneSortValue(milestone, query.sort));
}

async function readLabel(db: D1DatabaseLike, tenantId: string, id: string): Promise<ForgeLabel | undefined> {
  const row = await db.prepare(labelSelectSql() + " WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, id).first<LabelRow>();
  return row ? toLabel(row) : undefined;
}

async function readMilestone(db: D1DatabaseLike, tenantId: string, id: string): Promise<ForgeMilestone | undefined> {
  const row = await db.prepare(milestoneSelectSql() + " WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, id).first<MilestoneRow>();
  return row ? toMilestone(db, row) : undefined;
}

async function requireRepository(db: D1DatabaseLike, tenantId: string, id: string): Promise<void> {
  const row = await db.prepare("SELECT id FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, id).first<{ id: string }>();
  if (!row) throw new NotFoundError({ resource: "repository", id });
}

async function requireUniqueLabel(db: D1DatabaseLike, tenantId: string, repositoryId: string, name: string, exceptId?: string): Promise<void> {
  const row = await db.prepare("SELECT id FROM labels WHERE tenant_id = ? AND repository_id = ? AND lower(name) = lower(?) AND (? IS NULL OR id <> ?) LIMIT 1").bind(tenantId, repositoryId, normalizeDisplay(name, 100, "label name"), exceptId ?? null, exceptId ?? null).first<{ id: string }>();
  if (row) throw new DomainContractError({ message: "label name already exists in repository" });
}

async function requireUniqueMilestone(db: D1DatabaseLike, tenantId: string, repositoryId: string, title: string, exceptId?: string): Promise<void> {
  const row = await db.prepare("SELECT id FROM milestones WHERE tenant_id = ? AND repository_id = ? AND title = ? AND (? IS NULL OR id <> ?) LIMIT 1").bind(tenantId, repositoryId, normalizeDisplay(title, 256, "milestone title"), exceptId ?? null, exceptId ?? null).first<{ id: string }>();
  if (row) throw new DomainContractError({ message: "milestone title already exists in repository" });
}

async function nextMilestoneNumber(db: D1DatabaseLike, tenantId: string, repositoryId: string): Promise<number> {
  const rows = await db.prepare("SELECT id FROM milestones WHERE tenant_id = ? AND repository_id = ?").bind(tenantId, repositoryId).all<{ id: string }>();
  const operationRows = await db.prepare("SELECT result_key FROM operations WHERE tenant_id = ? AND kind = ?").bind(tenantId, "milestone.delete").all<{ result_key: string | null }>();
  const numbers = (rows.results ?? []).map((row) => milestoneNumberFromId(row.id, repositoryId));
  for (const row of operationRows.results ?? []) {
    const result = decodeJsonKey(row.result_key);
    const resource = result.resource as Partial<ForgeResourceLocator> | undefined;
    if (resource?.kind === "milestone" && resource.repository_id === repositoryId && typeof resource.id === "string") numbers.push(milestoneNumberFromId(resource.id, repositoryId));
  }
  return Math.max(0, ...numbers) + 1;
}

async function deletionOperation(db: D1DatabaseLike, clock: Clock, tenantId: string, _actorId: string, kind: ForgeDeletionOperation["kind"], resource: ForgeResourceLocator): Promise<ForgeDeletionOperation> {
  const now = clock.now().toISOString();
  const id = "op-" + kind.replace(".", "-") + "-" + await nextOperationNumber(db, tenantId);
  const result: ForgeDeletionResult = { resource, tombstoned_at: now, restore_until: null, purge_after: null, held: false };
  return { tenant_id: tenantId, id, version: 1, created_at: now, updated_at: now, status: "succeeded", kind, progress: { stage: "completed", completed: 1, total: 1, blocked_reason: null }, result, error: null };
}

function operationInsertFromLabel(db: D1DatabaseLike, operation: ForgeDeletionOperation, actorId: string, tenantId: string, id: string, expectedVersion: number): D1PreparedStatement {
  return operationInsertStatement(db, operation, actorId, "labels", tenantId, id, expectedVersion);
}

function operationInsertFromMilestone(db: D1DatabaseLike, operation: ForgeDeletionOperation, actorId: string, tenantId: string, id: string, expectedVersion: number): D1PreparedStatement {
  return operationInsertStatement(db, operation, actorId, "milestones", tenantId, id, expectedVersion);
}

function operationInsertStatement(db: D1DatabaseLike, operation: ForgeDeletionOperation, actorId: string, table: "labels" | "milestones", tenantId: string, id: string, expectedVersion: number): D1PreparedStatement {
  return db.prepare("INSERT INTO operations(tenant_id,id,version,created_at,updated_at,kind,actor_id,state,progress_json,result_key,error_json) SELECT ?,?,?,?,?,?,?,?,?,?,NULL WHERE EXISTS (SELECT 1 FROM " + table + " WHERE tenant_id = ? AND id = ? AND version = ?)").bind(operation.tenant_id, operation.id, operation.version, operation.created_at, operation.updated_at, operation.kind, actorId, operation.status, JSON.stringify(operation.progress), encodeJsonKey(operation.result), tenantId, id, expectedVersion);
}

function requireAtomicBatch(db: D1DatabaseLike): NonNullable<D1DatabaseLike["batch"]> {
  if (!db.batch) throw new DomainContractError({ message: "D1 atomic batch support is required for metadata deletion" });
  return db.batch.bind(db);
}

async function runAtomicBatch(batch: NonNullable<D1DatabaseLike["batch"]>, statements: readonly D1PreparedStatement[], message: string): Promise<readonly D1Result[]> {
  try { return await batch(statements); } catch (error) { throw new DomainContractError({ message: message + ": " + String(error) }); }
}

async function nextOperationNumber(db: D1DatabaseLike, tenantId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) + 1 AS next_number FROM operations WHERE tenant_id = ?").bind(tenantId).first<{ next_number: number }>();
  return row?.next_number ?? 1;
}

function toLabel(row: LabelRow): ForgeLabel {
  return { tenant_id: row.tenant_id, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, repository_id: row.repository_id, name: row.name, color: row.color, description: row.description, managed_by_policy: false };
}

async function toMilestone(db: D1DatabaseLike, row: MilestoneRow): Promise<ForgeMilestone> {
  const counts = await milestoneCounts(db, row.tenant_id, row.id);
  return { tenant_id: row.tenant_id, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, repository_id: row.repository_id, title: row.title, body: row.body, due_at: row.due_at, state: row.state, number: milestoneNumberFromId(row.id, row.repository_id), open_count: counts.open, closed_count: counts.closed, closed_at: row.state === "closed" ? row.updated_at : null };
}

async function milestoneCounts(_db: D1DatabaseLike, _tenantId: string, _milestoneId: string): Promise<{ readonly open: number; readonly closed: number }> {
  return { open: 0, closed: 0 };
}

function pageFromRows<T extends { readonly id: string }>(kind: string, scope: string, direction: "asc" | "desc", rows: readonly T[], limit: number, sortValue: (item: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items[items.length - 1];
  return { items, has_more: hasMore, next_cursor: hasMore && last ? encodeCursor(kind, scope, direction, sortValue(last), last.id) : null };
}

function labelSelectSql(): string { return "SELECT tenant_id,id,version,created_at,updated_at,repository_id,name,color,description FROM labels"; }
function milestoneSelectSql(): string { return "SELECT tenant_id,id,version,created_at,updated_at,repository_id,title,body,due_at,state FROM milestones"; }
function labelSortColumn(value: string | undefined): "name" | "created_at" | "updated_at" { return value === "name" || value === "updated_at" ? value : "created_at"; }
function milestoneSortColumn(value: string | undefined): "due_at" | "title" | "created_at" | "updated_at" { return value === "due_at" || value === "title" || value === "updated_at" ? value : "created_at"; }
function labelSortExpression(value: "name" | "created_at" | "updated_at"): string { return value; }
function milestoneSortExpression(value: "due_at" | "title" | "created_at" | "updated_at"): string { return value === "due_at" ? "COALESCE(due_at, '')" : value; }
function labelSortValue(label: ForgeLabel, sort: ForgeLabelListQuery["sort"]): string { return sort === "name" ? label.name : sort === "updated_at" ? label.updated_at : label.created_at; }
function milestoneSortValue(milestone: ForgeMilestone, sort: ForgeMilestoneListQuery["sort"]): string { return sort === "due_at" ? milestone.due_at ?? "" : sort === "title" ? milestone.title : sort === "updated_at" ? milestone.updated_at : milestone.created_at; }
function cursorPredicate(expression: string, direction: "ASC" | "DESC"): string { return direction === "ASC" ? "(" + expression + " > ? OR (" + expression + " = ? AND id > ?))" : "(" + expression + " < ? OR (" + expression + " = ? AND id < ?))"; }
function sortDirection(value: string | undefined): "ASC" | "DESC" { return value === "asc" ? "ASC" : "DESC"; }
function readLimit(value: unknown): number { return Number.isInteger(value) ? Math.max(1, Math.min(1000, value as number)) : 100; }
function stableResourceId(prefix: string, repositoryId: string, suffix: string): string { return (repositoryId + "-" + prefix + "-" + suffix).replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128); }
function labelSlug(name: string): string { return name.normalize("NFC").trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "label"; }
function milestoneNumberFromId(id: string, repositoryId: string): number { const prefix = repositoryId + "-milestone-"; const suffix = id.startsWith(prefix) ? id.slice(prefix.length) : ""; const number = Number.parseInt(suffix, 10); return Number.isInteger(number) && number > 0 ? number : 1; }
function encodeJsonKey(value: object): string { return "json:" + JSON.stringify(value); }
function decodeJsonKey(value: string | null): Record<string, unknown> { if (!value?.startsWith("json:")) return {}; const parsed = JSON.parse(value.slice(5)) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
function canonicalColor(value: string): string { const color = value.toLowerCase(); if (!/^[0-9a-f]{6}$/.test(color)) throw new DomainContractError({ message: "invalid label color" }); return color; }
function normalizeDisplay(value: string, maxBytes: number, field: string): string { const normalized = value.normalize("NFC"); if (normalized.length === 0 || utf8ByteLength(normalized) > maxBytes) throw new DomainContractError({ message: field + " is outside source bounds" }); return normalized; }
function boundedText(value: string, maxBytes: number, field: string): string { if (utf8ByteLength(value) > maxBytes) throw new DomainContractError({ message: field + " is outside source bounds" }); return value; }
function requireReason(reason: string): void { if (reason.trim().length === 0 || utf8ByteLength(reason) > 1024) throw new DomainContractError({ message: "delete reason is outside source bounds" }); }
function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function changed(result: D1Result | undefined): number { return result?.meta?.changes ?? 0; }
function preserveReadError(error: unknown, resource: string, id: string): NotFoundError { return error instanceof NotFoundError ? error : new NotFoundError({ resource, id }); }
function preserveListError(error: unknown, resource: string, id: string): NotFoundError | DomainContractError { return error instanceof NotFoundError || error instanceof DomainContractError ? error : new DomainContractError({ message: resource + " list failed for " + id + ": " + String(error) }); }
function preserveKnownError(error: unknown, resource: string, id: string): NotFoundError | StalePreconditionError | DomainContractError { return error instanceof NotFoundError || error instanceof StalePreconditionError || error instanceof DomainContractError ? error : new DomainContractError({ message: resource + " mutation failed for " + id + ": " + String(error) }); }
function labelScope(tenantId: string, query: ForgeLabelListQuery): string { return hashString(JSON.stringify(["label", tenantId, query.repository_id ?? null, query.name_prefix ?? null, query.sort ?? "created_at", query.direction ?? "desc"])); }
function milestoneScope(tenantId: string, query: ForgeMilestoneListQuery): string { return hashString(JSON.stringify(["milestone", tenantId, query.repository_id ?? null, query.state ?? null, query.sort ?? "created_at", query.direction ?? "desc"])); }
interface CursorPayload { readonly v: 1; readonly kind: string; readonly scope: string; readonly direction: "asc" | "desc"; readonly sort: string; readonly id: string }
function encodeCursor(kind: string, scope: string, direction: "asc" | "desc", sort: string, id: string): string { return "cursor:" + encodeURIComponent(JSON.stringify({ v: 1, kind, scope, direction, sort, id } satisfies CursorPayload)); }
function decodeCursor(kind: string, scope: string, cursor: string | undefined): CursorPayload | undefined { if (!cursor) return undefined; try { if (!cursor.startsWith("cursor:")) throw new Error("missing cursor prefix"); const parsed = JSON.parse(decodeURIComponent(cursor.slice("cursor:".length))) as Partial<CursorPayload>; if (parsed.v !== 1 || parsed.kind !== kind || parsed.scope !== scope || (parsed.direction !== "asc" && parsed.direction !== "desc") || typeof parsed.sort !== "string" || typeof parsed.id !== "string") throw new Error("cursor scope mismatch"); return parsed as CursorPayload; } catch { throw new DomainContractError({ message: "invalid or inconsistent pagination cursor" }); } }
function hashString(value: string): string { let hash = 5381; for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index); return (hash >>> 0).toString(16); }

interface LabelRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly name: string; readonly color: string; readonly description: string }
interface MilestoneRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly title: string; readonly body: string; readonly due_at: string | null; readonly state: "open" | "closed" }
