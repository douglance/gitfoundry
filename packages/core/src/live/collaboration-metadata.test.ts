import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { DomainContractError, NotFoundError, StalePreconditionError } from "../index.js";
import { makeD1OperationStore } from "./index.js";
import { makeD1CollaborationMetadataStore } from "./collaboration-metadata.js";

type SqliteValue = string | number | bigint | null | Uint8Array;

class SqliteD1Statement {
  constructor(readonly database: DatabaseSync, readonly sql: string, readonly values: readonly unknown[] = []) {}
  bind(...values: unknown[]) { return new SqliteD1Statement(this.database, this.sql, values); }
  async first<T>() { return this.database.prepare(this.sql).get(...this.values as SqliteValue[]) as T | null; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.values as SqliteValue[]) as T[] }; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values as SqliteValue[]); return { success: true, meta: { changes: Number(result.changes) } }; }
}

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:"), readonly options: { readonly failBatchAt?: number } = {}) {}
  prepare(sql: string) { return new SqliteD1Statement(this.db, sql); }
  async batch(statements: readonly unknown[]) {
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (this.options.failBatchAt === index) throw new Error("forced batch failure at statement " + index);
        const statement = statements[index];
        if (!(statement instanceof SqliteD1Statement)) throw new Error("unsupported sqlite D1 statement");
        results.push(await statement.run());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const now = new Date("2026-10-08T00:00:00.000Z");
const clock = { now: () => now };
const actor = { id: "principal-a", tenantId: "tenant-a", revoked: false, capabilities: [] };

describe("D1-backed collaboration metadata store", () => {
  it("persists labels with source-shaped defaults, filters, CAS, references, deletion operations, and tenant isolation", async () => {
    const sql = fixture();
    const store = makeD1CollaborationMetadataStore(sql, { clock });
    const operations = makeD1OperationStore(sql);
    const labelA = await Effect.runPromise(store.createLabel("tenant-a", actor, { repository_id: "repo-a", name: "Bug", color: "FF0000" }));
    const labelB = await Effect.runPromise(store.createLabel("tenant-b", { ...actor, tenantId: "tenant-b" }, { repository_id: "repo-a", name: "Bug", color: "00ff00", description: "Tenant B" }));
    expectSchema("ForgeLabel", labelA);
    expect(labelA).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", name: "Bug", color: "ff0000", description: "", managed_by_policy: false });
    expect(labelB.id).toBe(labelA.id);
    sql.db.prepare("INSERT INTO issues(tenant_id,id,version,created_at,updated_at,repository_id,number,title,body,state,state_reason,author_id,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "issue-a", 1, now.toISOString(), now.toISOString(), "repo-a", 1, "Issue", "Body", "open", "reopened", "principal-a", "issue");
    sql.db.prepare("INSERT INTO issue_labels(tenant_id,issue_id,label_id) VALUES(?,?,?)").run("tenant-a", "issue-a", labelA.id);
    await expect(Effect.runPromise(store.getLabel("tenant-b", labelA.id))).resolves.toMatchObject({ tenant_id: "tenant-b", description: "Tenant B" });
    await expect(Effect.runPromise(store.listLabels("tenant-a", { repository_id: "repo-b" }))).resolves.toMatchObject({ items: [] });
    const updated = await Effect.runPromise(store.updateLabel("tenant-a", labelA.id, 1, { name: "Defect", description: "Needs triage" }));
    expectSchema("ForgeLabel", updated);
    expect(updated).toMatchObject({ id: labelA.id, version: 2, name: "Defect", description: "Needs triage" });
    await expect(Effect.runPromise(store.updateLabel("tenant-a", labelA.id, 1, { color: "00ff00" }))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(store.createLabel("tenant-a", actor, { repository_id: "repo-a", name: "defect", color: "00ff00" }))).rejects.toBeInstanceOf(DomainContractError);
    const deletion = await Effect.runPromise(store.deleteLabel("tenant-a", labelA.id, actor, { expected_version: 2, reason: "taxonomy cleanup" }));
    expectSchema("ForgeDeletionOperation", deletion);
    expect(deletion).toMatchObject({ status: "succeeded", kind: "label.delete", result: { resource: { kind: "label", id: labelA.id, repository_id: "repo-a", version: 2 }, tombstoned_at: now.toISOString(), held: false } });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM issue_labels WHERE tenant_id = ? AND label_id = ?").get("tenant-a", labelA.id)).toMatchObject({ count: 0 });
    await expect(Effect.runPromise(operations.get("tenant-a", deletion.id))).resolves.toMatchObject({ id: deletion.id, status: "succeeded", kind: "label.delete", result: deletion.result });
    await expect(Effect.runPromise(store.getLabel("tenant-a", labelA.id))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("persists milestones with defaults, numbering, state transitions, repo filters, operations, and missing item failures", async () => {
    const sql = fixture();
    const store = makeD1CollaborationMetadataStore(sql, { clock });
    const operations = makeD1OperationStore(sql);
    const first = await Effect.runPromise(store.createMilestone("tenant-a", actor, { repository_id: "repo-a", title: "M1" }));
    const second = await Effect.runPromise(store.createMilestone("tenant-a", actor, { repository_id: "repo-a", title: "M2", body: "body", due_at: "2026-12-01T00:00:00.000Z", state: "closed" }));
    expectSchema("ForgeMilestone", first);
    expectSchema("ForgeMilestone", second);
    expect(first).toMatchObject({ number: 1, body: "", due_at: null, state: "open", open_count: 0, closed_count: 0, closed_at: null });
    expect(second).toMatchObject({ number: 2, state: "closed", closed_at: now.toISOString() });
    await expect(Effect.runPromise(store.listMilestones("tenant-a", { repository_id: "repo-a", state: "open" }))).resolves.toMatchObject({ items: [{ id: first.id }], has_more: false, next_cursor: null });
    const reopened = await Effect.runPromise(store.updateMilestone("tenant-a", second.id, 1, { state: "open", due_at: null }));
    expect(reopened).toMatchObject({ version: 2, state: "open", due_at: null, closed_at: null });
    await expect(Effect.runPromise(store.updateMilestone("tenant-a", second.id, 1, { title: "stale" }))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(store.getMilestone("tenant-b", second.id))).rejects.toBeInstanceOf(NotFoundError);
    const deletion = await Effect.runPromise(store.deleteMilestone("tenant-a", second.id, actor, { expected_version: 2, reason: "release replaced" }));
    expectSchema("ForgeDeletionOperation", deletion);
    expect(deletion).toMatchObject({ status: "succeeded", kind: "milestone.delete", result: { resource: { kind: "milestone", id: second.id, repository_id: "repo-a", version: 2 } } });
    await expect(Effect.runPromise(operations.get("tenant-a", deletion.id))).resolves.toMatchObject({ id: deletion.id, result: deletion.result });
    await expect(Effect.runPromise(store.deleteMilestone("tenant-a", second.id, actor, { expected_version: 2, reason: "again" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("paginates labels and milestones with scoped cursors and literal label prefixes", async () => {
    const sql = fixture();
    const store = makeD1CollaborationMetadataStore(sql, { clock });
    for (const name of ["bug_1", "bugA", "bug%2", "bug_0", "bug_3", "other"]) await Effect.runPromise(store.createLabel("tenant-a", actor, { repository_id: "repo-a", name, color: "00ff00" }));
    const firstLabels = await Effect.runPromise(store.listLabels("tenant-a", { repository_id: "repo-a", name_prefix: "bug_", sort: "name", direction: "asc", limit: 2 }));
    expect(firstLabels).toMatchObject({ has_more: true });
    expect(firstLabels.items.map((label) => label.name)).toEqual(["bug_0", "bug_1"]);
    const secondLabels = await Effect.runPromise(store.listLabels("tenant-a", { repository_id: "repo-a", name_prefix: "bug_", sort: "name", direction: "asc", limit: 2, cursor: firstLabels.next_cursor! }));
    expect(secondLabels).toMatchObject({ has_more: false, next_cursor: null });
    expect(secondLabels.items.map((label) => label.name)).toEqual(["bug_3"]);
    await expect(Effect.runPromise(store.listLabels("tenant-b", { repository_id: "repo-a", name_prefix: "bug_", sort: "name", direction: "asc", limit: 2, cursor: firstLabels.next_cursor! }))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(store.listLabels("tenant-a", { repository_id: "repo-a", name_prefix: "bug%", sort: "name", direction: "asc", limit: 2, cursor: firstLabels.next_cursor! }))).rejects.toBeInstanceOf(DomainContractError);

    const m1 = await Effect.runPromise(store.createMilestone("tenant-a", actor, { repository_id: "repo-a", title: "M1" }));
    const m2 = await Effect.runPromise(store.createMilestone("tenant-a", actor, { repository_id: "repo-a", title: "M2", due_at: "2026-12-01T00:00:00.000Z" }));
    const m3 = await Effect.runPromise(store.createMilestone("tenant-a", actor, { repository_id: "repo-a", title: "M3" }));
    const firstMilestones = await Effect.runPromise(store.listMilestones("tenant-a", { repository_id: "repo-a", state: "all", sort: "due_at", direction: "asc", limit: 2 }));
    expect(firstMilestones.items.map((milestone) => milestone.id)).toEqual([m1.id, m3.id]);
    expect(firstMilestones.has_more).toBe(true);
    const secondMilestones = await Effect.runPromise(store.listMilestones("tenant-a", { repository_id: "repo-a", state: "all", sort: "due_at", direction: "asc", limit: 2, cursor: firstMilestones.next_cursor! }));
    expect(secondMilestones.items.map((milestone) => milestone.id)).toEqual([m2.id]);
    const descMilestones = await Effect.runPromise(store.listMilestones("tenant-a", { repository_id: "repo-a", state: "all", sort: "due_at", direction: "desc", limit: 3 }));
    expect(descMilestones.items.map((milestone) => milestone.id)).toEqual([m2.id, m3.id, m1.id]);
  });

  it("fails label deletion closed without an atomic batch", async () => {
    const sql = fixture();
    const store = makeD1CollaborationMetadataStore(sql, { clock });
    const label = await Effect.runPromise(store.createLabel("tenant-a", actor, { repository_id: "repo-a", name: "atomic", color: "00ff00" }));
    seedIssueLabel(sql, label.id);
    const noBatch = { prepare: sql.prepare.bind(sql) };
    const noBatchStore = makeD1CollaborationMetadataStore(noBatch, { clock });
    await expect(Effect.runPromise(noBatchStore.deleteLabel("tenant-a", label.id, actor, { expected_version: 1, reason: "requires batch" }))).rejects.toBeInstanceOf(DomainContractError);
    expect(count(sql, "labels", "id", label.id)).toBe(1);
    expect(count(sql, "issue_labels", "label_id", label.id)).toBe(1);
    expect(count(sql, "operations", "kind", "label.delete")).toBe(0);
  });

  it("keeps parent associations and operations intact on delete CAS race and batch rollback", async () => {
    const sql = fixture();
    const racingStore = makeD1CollaborationMetadataStore(sql, { clock, beforeDeleteBatch: async () => { sql.db.prepare("UPDATE labels SET version = version + 1 WHERE tenant_id = ? AND id = ?").run("tenant-a", "repo-a-label-race"); } } as never);
    const racingLabel = await Effect.runPromise(racingStore.createLabel("tenant-a", actor, { repository_id: "repo-a", name: "race", color: "00ff00" }));
    seedIssueLabel(sql, racingLabel.id);
    await expect(Effect.runPromise(racingStore.deleteLabel("tenant-a", racingLabel.id, actor, { expected_version: 1, reason: "raced" }))).rejects.toBeInstanceOf(StalePreconditionError);
    expect(count(sql, "labels", "id", racingLabel.id)).toBe(1);
    expect(count(sql, "issue_labels", "label_id", racingLabel.id)).toBe(1);
    expect(count(sql, "operations", "kind", "label.delete")).toBe(0);

    const rollbackSql = fixture({ failBatchAt: 2 });
    const rollbackStore = makeD1CollaborationMetadataStore(rollbackSql, { clock });
    const rollbackLabel = await Effect.runPromise(rollbackStore.createLabel("tenant-a", actor, { repository_id: "repo-a", name: "rollback", color: "00ff00" }));
    seedIssueLabel(rollbackSql, rollbackLabel.id);
    await expect(Effect.runPromise(rollbackStore.deleteLabel("tenant-a", rollbackLabel.id, actor, { expected_version: 1, reason: "forced failure" }))).rejects.toBeInstanceOf(DomainContractError);
    expect(count(rollbackSql, "labels", "id", rollbackLabel.id)).toBe(1);
    expect(count(rollbackSql, "issue_labels", "label_id", rollbackLabel.id)).toBe(1);
    expect(count(rollbackSql, "operations", "kind", "label.delete")).toBe(0);
  });
});

function fixture(options: { readonly failBatchAt?: number } = {}): SqliteD1 {
  const sql = new SqliteD1(new DatabaseSync(":memory:"), options);
  sql.db.exec(readFileSync(new URL("../../../../docs/source/handoff/contracts/schema.sql", import.meta.url), "utf8"));
  seed(sql.db);
  return sql;
}

function seed(db: DatabaseSync) {
  const timestamp = now.toISOString();
  for (const tenant of ["tenant-a", "tenant-b"]) {
    db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run(tenant, tenant, "active", 1, tenant + "-shard", "US", "{}");
    db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run(tenant, "principal-a", 1, timestamp, timestamp, "human", "Principal A", 1, 1);
    db.prepare("INSERT INTO organization_namespaces(tenant_id,id,version,created_at,updated_at,name,description) VALUES(?,?,?,?,?,?,?)").run(tenant, "namespace-a", 1, timestamp, timestamp, "namespace-a", "Namespace A");
    db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(tenant, "repo-a", 1, timestamp, timestamp, "namespace-a", "demo", "private", "main", 0, tenant, "repo-a", null);
  }
  db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-b", 1, timestamp, timestamp, "namespace-a", "other", "private", "main", 0, "tenant-a", "repo-b", null);
}

function seedIssueLabel(sql: SqliteD1, labelId: string): void {
  sql.db.prepare("INSERT INTO issues(tenant_id,id,version,created_at,updated_at,repository_id,number,title,body,state,state_reason,author_id,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "issue-" + labelId, 1, now.toISOString(), now.toISOString(), "repo-a", 100 + count(sql, "issues", "repository_id", "repo-a"), "Issue", "Body", "open", "reopened", "principal-a", "issue");
  sql.db.prepare("INSERT INTO issue_labels(tenant_id,issue_id,label_id) VALUES(?,?,?)").run("tenant-a", "issue-" + labelId, labelId);
}

function count(sql: SqliteD1, table: string, field: string, value: string): number {
  return Number((sql.db.prepare("SELECT COUNT(*) AS count FROM " + table + " WHERE tenant_id = ? AND " + field + " = ?").get("tenant-a", value) as { count: number }).count);
}

function expectSchema(name: string, value: unknown): void {
  const root = JSON.parse(readFileSync(new URL("../../../../docs/source/handoff/contracts/domain.schema.json", import.meta.url), "utf8")) as { $defs: Record<string, JsonSchema> };
  const schema = root.$defs[name];
  if (!schema) throw new Error("missing source schema " + name);
  validateSchema(schema, value, root.$defs, name);
}

type JsonSchema = { readonly type?: string; readonly properties?: Record<string, JsonSchema>; readonly required?: readonly string[]; readonly additionalProperties?: boolean; readonly enum?: readonly unknown[]; readonly pattern?: string; readonly minimum?: number; readonly maximum?: number; readonly minLength?: number; readonly maxLength?: number; readonly items?: JsonSchema; readonly oneOf?: readonly JsonSchema[]; readonly anyOf?: readonly JsonSchema[]; readonly $ref?: string };

function validateSchema(schema: JsonSchema, value: unknown, defs: Record<string, JsonSchema>, path: string): void {
  if (schema.$ref) return validateSchema(resolveRef(schema.$ref, defs), value, defs, path);
  if (schema.anyOf) { expect(schema.anyOf.some((option) => isValid(option, value, defs))).toBe(true); return; }
  if (schema.oneOf) { expect(schema.oneOf.filter((option) => isValid(option, value, defs))).toHaveLength(1); return; }
  if (schema.enum) expect(schema.enum).toContain(value);
  if (schema.type === "object") {
    expect(value && typeof value === "object" && !Array.isArray(value)).toBe(true);
    const record = value as Record<string, unknown>;
    if (schema.additionalProperties === false) expect(Object.keys(record).sort()).toEqual(Object.keys(schema.properties ?? {}).sort());
    for (const required of schema.required ?? []) expect(record).toHaveProperty(required);
    for (const [key, child] of Object.entries(schema.properties ?? {})) validateSchema(child, record[key], defs, path + "." + key);
  } else if (schema.type === "array") {
    expect(Array.isArray(value)).toBe(true);
    const itemSchema = schema.items;
    if (!itemSchema) throw new Error("array schema missing items at " + path);
    for (const item of value as readonly unknown[]) validateSchema(itemSchema, item, defs, path + "[]");
  } else if (schema.type === "string") {
    expect(typeof value).toBe("string");
    if (schema.pattern) expect(value as string).toMatch(new RegExp(schema.pattern));
    if (schema.minLength !== undefined) expect((value as string).length).toBeGreaterThanOrEqual(schema.minLength);
    if (schema.maxLength !== undefined) expect((value as string).length).toBeLessThanOrEqual(schema.maxLength);
  } else if (schema.type === "integer") {
    expect(Number.isInteger(value)).toBe(true);
    if (schema.minimum !== undefined) expect(value as number).toBeGreaterThanOrEqual(schema.minimum);
    if (schema.maximum !== undefined) expect(value as number).toBeLessThanOrEqual(schema.maximum);
  } else if (schema.type === "boolean") {
    expect(typeof value).toBe("boolean");
  } else if (schema.type === "null") {
    expect(value).toBeNull();
  }
}

function isValid(schema: JsonSchema, value: unknown, defs: Record<string, JsonSchema>): boolean {
  try { validateSchema(schema, value, defs, "candidate"); return true; } catch { return false; }
}

function resolveRef(ref: string, defs: Record<string, JsonSchema>): JsonSchema {
  const name = ref.replace("#/$defs/", "");
  const schema = defs[name];
  if (!schema) throw new Error("unknown schema ref " + ref);
  return schema;
}
