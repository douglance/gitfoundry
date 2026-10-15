import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { IdempotencyConflictError, InvalidStateTransitionError, NotFoundError, StalePreconditionError } from "../index.js";
import { makeD1IdempotencyStore } from "./index.js";
import { GitReferenceUnavailableError, assertQualifiedSha, makeD1ForgeIssueStore, makeD1ForgePullRequestStore, makeD1ForgeStore } from "./forge.js";

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  prepare(sql: string) {
    const database = this.db;
    type SqliteValue = string | number | bigint | null | Uint8Array;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) { return { ...this, values } },
      async first<T>() { return database.prepare(sql).get(...this.values as SqliteValue[]) as T | null },
      async all<T>() { return { results: database.prepare(sql).all(...this.values as SqliteValue[]) as T[] } },
      async run() { const result = database.prepare(sql).run(...this.values as SqliteValue[]); return { success: true, meta: { changes: Number(result.changes) } } }
    };
  }
}

const now = new Date("2026-10-08T00:00:00.000Z");
const clock = { now: () => now };
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const baseSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const nextBaseSha = "cccccccccccccccccccccccccccccccccccccccc";

describe("D1-backed forge live adapters", () => {
  it("persists source-shaped issue list view create and update with version CAS", async () => {
    const sql = fixture();
    const issues = makeD1ForgeIssueStore(sql, clock);
    const created = await Effect.runPromise(issues.create("tenant-a", "principal-a", { repository_id: "repo-a", title: "First issue", body: "body", labels: ["label-a"], assignees: ["principal-b"] }));
    expect(created).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", number: 1, state: "open", labels: ["label-a"], assignees: ["principal-b"] });
    await expect(Effect.runPromise(issues.get("tenant-b", created.id))).rejects.toThrow();
    const updated = await Effect.runPromise(issues.update("tenant-a", created.id, "principal-a", { title: "Renamed", assignees: [] }, 1));
    expect(updated).toMatchObject({ version: 2, title: "Renamed", assignees: [] });
    await expect(Effect.runPromise(issues.update("tenant-a", created.id, "principal-a", { body: "stale" }, 1))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(issues.list("tenant-a", { repository_id: "repo-a", state: "open", label_ids: ["label-a"] }))).resolves.toMatchObject({ items: [{ id: created.id }], has_more: false });
  });

  it("requires a qualified Git read port for PR creation and stores only resolved ref metadata", async () => {
    const sql = fixture();
    const unavailable = makeD1ForgePullRequestStore(sql, { clock });
    await expect(Effect.runPromise(unavailable.create("tenant-a", "principal-a", { repository_id: "repo-a", source_repository_id: "repo-a", source_ref: "feature", target_ref: "main", title: "PR" }))).rejects.toBeInstanceOf(GitReferenceUnavailableError);
    const prs = makeD1ForgePullRequestStore(sql, { clock, gitRead: { resolveRef: ({ repositoryId, ref }) => Effect.succeed(assertQualifiedSha(ref === "feature" ? headSha : baseSha, repositoryId, ref)) } });
    const created = await Effect.runPromise(prs.create("tenant-a", "principal-a", { repository_id: "repo-a", source_repository_id: "repo-a", source_ref: "feature", target_ref: "main", title: "PR", draft: true }));
    expect(created).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", source_ref: "feature", target_ref: "main", head_sha: headSha, base_sha: baseSha, draft: true, state: "open" });
    const updated = await Effect.runPromise(makeD1ForgePullRequestStore(sql, { clock, gitRead: { resolveRef: ({ repositoryId, ref }) => Effect.succeed(assertQualifiedSha(nextBaseSha, repositoryId, ref)) } }).update("tenant-a", created.id, "principal-a", { title: "PR renamed", target_ref: "release" }, 1));
    expect(updated).toMatchObject({ version: 2, title: "PR renamed", target_ref: "release", base_sha: nextBaseSha });
    await expect(Effect.runPromise(prs.update("tenant-a", created.id, "principal-a", { body: "stale" }, 1))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(prs.list("tenant-a", { repository_id: "repo-a", draft: true }))).resolves.toMatchObject({ items: [{ id: created.id }], has_more: false });
  });

  it("persists issue close and reopen transitions with CAS and tenant isolation", async () => {
    const sql = fixture();
    const store = makeD1ForgeStore(sql, { clock });
    const actor = { id: "principal-a", tenantId: "tenant-a", revoked: false, capabilities: [] };
    const created = await Effect.runPromise(store.createIssue("tenant-a", actor, { repository_id: "repo-a", title: "Closable", body: "body" }));

    const closed = await Effect.runPromise(store.closeIssue!("tenant-a", created.id, { expected_version: 1, reason: "completed" }));
    expect(closed).toMatchObject({ id: created.id, version: 2, state: "closed", state_reason: "completed" });
    await expect(Effect.runPromise(store.getIssue("tenant-a", created.id))).resolves.toMatchObject({ version: 2, state: "closed", state_reason: "completed" });
    await expect(Effect.runPromise(store.closeIssue!("tenant-a", created.id, { expected_version: 2, reason: "not_planned" }))).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const reopened = await Effect.runPromise(store.reopenIssue!("tenant-a", created.id, { expected_version: 2 }));
    expect(reopened).toMatchObject({ id: created.id, version: 3, state: "open", state_reason: "reopened" });
    await expect(Effect.runPromise(store.reopenIssue!("tenant-a", created.id, { expected_version: 2 }))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(store.closeIssue!("tenant-b", created.id, { expected_version: 3, reason: "completed" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("persists PR and review transitions with state, CAS, tenant, repo, and principal guards", async () => {
    const sql = fixture();
    const store = makeD1ForgeStore(sql, { clock, gitRead: { resolveRef: ({ repositoryId, ref }) => Effect.succeed(assertQualifiedSha(ref === "feature" ? headSha : baseSha, repositoryId, ref)) } });
    const actor = { id: "principal-a", tenantId: "tenant-a", revoked: false, capabilities: [] };
    const created = await Effect.runPromise(store.createPullRequest("tenant-a", actor, { repository_id: "repo-a", source_repository_id: "repo-a", source_ref: "feature", target_ref: "main", title: "PR", draft: true }));

    const ready = await Effect.runPromise(store.markPullRequestReady!("tenant-a", created.id, { expected_version: 1 }));
    expect(ready).toMatchObject({ version: 2, state: "open", draft: false });
    await expect(Effect.runPromise(store.markPullRequestReady!("tenant-a", created.id, { expected_version: 2 }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
    const draft = await Effect.runPromise(store.markPullRequestDraft!("tenant-a", created.id, { expected_version: 2 }));
    expect(draft).toMatchObject({ version: 3, state: "open", draft: true });
    const closed = await Effect.runPromise(store.closePullRequest!("tenant-a", created.id, { expected_version: 3 }));
    expect(closed).toMatchObject({ version: 4, state: "closed", draft: true });
    await expect(Effect.runPromise(store.markPullRequestDraft!("tenant-a", created.id, { expected_version: 4 }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
    const reopened = await Effect.runPromise(store.reopenPullRequest!("tenant-a", created.id, { expected_version: 4 }));
    expect(reopened).toMatchObject({ version: 5, state: "open", draft: true });
    await expect(Effect.runPromise(store.closePullRequest!("tenant-b", created.id, { expected_version: 5 }))).rejects.toBeInstanceOf(NotFoundError);

    const review = await Effect.runPromise(store.createReview("tenant-a", actor, { repository_id: "repo-a", pull_request_id: created.id, body: "please review" }));
    await expect(Effect.runPromise(store.submitReview!("tenant-a", review.id, { expected_version: 1, head_sha: "dddddddddddddddddddddddddddddddddddddddd", decision: "approved" }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
    const submitted = await Effect.runPromise(store.submitReview!("tenant-a", review.id, { expected_version: 1, head_sha: headSha, decision: "approved", body: "approved" }));
    expect(submitted).toMatchObject({ version: 2, state: "approved", body: "approved" });
    await expect(Effect.runPromise(store.submitReview!("tenant-a", review.id, { expected_version: 2, head_sha: headSha, decision: "approved" }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
    const dismissed = await Effect.runPromise(store.dismissReview!("tenant-a", review.id, { expected_version: 2, reason: "stale" }));
    expect(dismissed).toMatchObject({ version: 3, state: "dismissed" });
    await expect(Effect.runPromise(store.dismissReview!("tenant-a", review.id, { expected_version: 2, reason: "stale" }))).rejects.toBeInstanceOf(StalePreconditionError);

    const inactive = await Effect.runPromise(store.createReview("tenant-a", actor, { repository_id: "repo-a", pull_request_id: created.id, body: "inactive reviewer" }));
    sql.db.prepare("UPDATE principals SET active = 0 WHERE tenant_id = 'tenant-a' AND id = 'principal-a'").run();
    await expect(Effect.runPromise(store.submitReview!("tenant-a", inactive.id, { expected_version: 1, head_sha: headSha, decision: "commented" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("uses atomic idempotency reserve with principal partition conflict and expiry", async () => {
    const sql = fixture();
    const store = makeD1IdempotencyStore(sql, clock);
    const pending = { tenant_id: "tenant-a", id: "op-issue-a", version: 1, created_at: now.toISOString(), updated_at: now.toISOString(), status: "running" as const, kind: "issue.create", progress: {}, result: {}, error: null };
    const scopeA = JSON.stringify(["tenant-a", "principal-a", "issue.create", "same-key"]);
    const scopeB = JSON.stringify(["tenant-a", "principal-b", "issue.create", "same-key"]);
    await expect(Effect.runPromise(store.replayOrReserve(scopeA, "digest-a", pending))).resolves.toBeUndefined();
    await expect(Effect.runPromise(store.replayOrReserve(scopeA, "digest-b", pending))).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(Effect.runPromise(store.replayOrReserve(scopeB, "digest-b", { ...pending, id: "op-issue-b" }))).resolves.toBeUndefined();
    sql.db.prepare("UPDATE idempotency SET expires_at = '2026-10-07T00:00:00.000Z' WHERE actor_id = 'principal-a'").run();
    await expect(Effect.runPromise(store.replayOrReserve(scopeA, "digest-c", { ...pending, id: "op-issue-c" }))).resolves.toBeUndefined();
  });
});

function fixture(): SqliteD1 {
  const sql = new SqliteD1();
  sql.db.exec(readFileSync(new URL("../../../../docs/source/handoff/contracts/schema.sql", import.meta.url), "utf8"));
  seed(sql.db);
  return sql;
}

function seed(db: DatabaseSync) {
  const timestamp = now.toISOString();
  db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 1, "shard-a", "US", "{}");
  db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction,config_json) VALUES(?,?,?,?,?,?,?)").run("tenant-b", "tenant-b", "active", 1, "shard-b", "US", "{}");
  db.prepare("INSERT INTO connections(tenant_id,id,version,created_at,updated_at,issuer,external_tenant_id,audience,claims_json,active) VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "conn-a", 1, timestamp, timestamp, "https://issuer.example", "access", "public-audience", "{}", 1);
  db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-a", 1, timestamp, timestamp, "human", "Principal A", 1, 1);
  db.prepare("INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-b", 1, timestamp, timestamp, "human", "Principal B", 1, 1);
  db.prepare("INSERT INTO organization_namespaces(tenant_id,id,version,created_at,updated_at,name,description) VALUES(?,?,?,?,?,?,?)").run("tenant-a", "namespace-a", 1, timestamp, timestamp, "namespace-a", "Namespace A");
  db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 1, timestamp, timestamp, "namespace-a", "demo", "private", "main", 0, "tenant-a", "repo-a", null);
  db.prepare("INSERT INTO labels(tenant_id,id,version,created_at,updated_at,repository_id,name,color,description) VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "label-a", 1, timestamp, timestamp, "repo-a", "bug", "ff0000", "Bug");
}
