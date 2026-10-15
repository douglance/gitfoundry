import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";
import { PrEligibilityStoreConflictError, makeD1PrEligibilityStore } from "./store.js";

class SqliteStatement<T = Record<string, unknown>> implements D1PreparedStatement<T> {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly values: readonly unknown[] = []) {}
  bind(...values: readonly unknown[]): D1PreparedStatement<T> { return new SqliteStatement<T>(this.db, this.sql, values); }
  async first<R = T>(): Promise<R | null> { return this.db.prepare(this.sql).get(...this.values as SQLInputValue[]) as R | null; }
  async all<R = T>(): Promise<D1Result<R>> { return { success: true, results: this.db.prepare(this.sql).all(...this.values as SQLInputValue[]) as R[] }; }
  async run(): Promise<D1Result<T>> { const result = this.db.prepare(this.sql).run(...this.values as SQLInputValue[]); return { success: true, meta: { changes: Number(result.changes) } }; }
}

class SqliteD1 implements D1DatabaseLike {
  readonly db = new DatabaseSync(":memory:");
  beforeBatch?: (statements: readonly D1PreparedStatement[]) => void;
  constructor(public failBatchAt?: number) {}
  prepare<T = Record<string, unknown>>(sql: string): D1PreparedStatement<T> { return new SqliteStatement<T>(this.db, sql); }
  async batch(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
    this.beforeBatch?.(statements);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result[] = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (this.failBatchAt === index) throw new Error("injected batch failure");
        results.push(await statements[index]!.run());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const now = "2026-10-09T00:00:00.000Z";
const later = "2026-10-09T00:10:00.000Z";
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const policyDigest = "d".repeat(64);

function install(db: DatabaseSync) {
  db.exec(readFileSync(new URL("../../../../infra/migrations/0001_handbook.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../../infra/migrations/0003_pr_eligibility.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../../../infra/migrations/0004_pr_eligibility_finalization.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO tenants VALUES('tenant-a','tenant-a','active',7,'shard-a','US','{}')");
  db.exec("INSERT INTO principals VALUES('tenant-a','actor-a',1,'2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z','human','Actor A',1,1)");
  db.exec("INSERT INTO principals VALUES('tenant-a','author-a',1,'2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z','human','Author A',1,1)");
  db.exec("INSERT INTO organization_namespaces VALUES('tenant-a','ns-a',1,'2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z','ns-a','Namespace A')");
  db.exec("INSERT INTO repositories VALUES('tenant-a','repo-a',1,'2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z','ns-a','repo-a','private','main',0,'tenant-a','repo-a',NULL)");
  db.exec("INSERT INTO issues VALUES('tenant-a','issue-a',5,'2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z','repo-a',1,'PR','Body','open','','author-a','pull_request')");
  db.exec(`INSERT INTO pull_requests VALUES('tenant-a','pr-a',3,'2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z','issue-a','repo-a','repo-a','refs/heads/topic','refs/heads/main','${head}','${base}',0,NULL,NULL,NULL)`);
  db.exec("INSERT INTO rulesets VALUES('tenant-a','ruleset-a',1,'2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z','repo-a',1,'{}',1)");
}

function reservation(overrides: Partial<Parameters<ReturnType<typeof makeD1PrEligibilityStore>["reserve"]>[0]> = {}): Parameters<ReturnType<typeof makeD1PrEligibilityStore>["reserve"]>[0] {
  return {
    tenantId: "tenant-a",
    pullRequestId: "pr-a",
    actorId: "actor-a",
    logicalKey: "key-a",
    operationPrefix: "pr-eligibility-key-a",
    now,
    expiresAt: later,
    committedAt: now,
    headSha: head,
    baseSha: base,
    method: "merge",
    policyDigest,
    progress: { committedAt: now, observedRuleRows: [{ id: "ruleset-a", version: 1, priority: 1, enabled: 1, rules_json: "{}" }] },
    ...overrides
  };
}

function finalization(overrides: Partial<Parameters<ReturnType<typeof makeD1PrEligibilityStore>["complete"]>[0]> = {}): Parameters<ReturnType<typeof makeD1PrEligibilityStore>["complete"]>[0] {
  return {
    tenantId: "tenant-a",
    operationId: "pr-eligibility-key-a-g1",
    logicalKey: "key-a",
    generation: 1,
    now,
    snapshot: { id: "pr-eligibility-key-a-g1", status: "blocked" },
    result: { snapshot: { id: "pr-eligibility-key-a-g1", status: "blocked" }, committedAt: now },
    progress: { committedAt: now },
    candidateSha: "cccccccccccccccccccccccccccccccccccccccc",
    repositoryId: "repo-a",
    sourceRepositoryId: "repo-a",
    pullRequestId: "pr-a",
    prVersion: 3,
    issueVersion: 5,
    issueState: "open",
    draft: false,
    closedAt: null,
    mergedAt: null,
    sourceRef: "refs/heads/topic",
    targetRef: "refs/heads/main",
    headSha: head,
    baseSha: base,
    policyEpoch: 7,
    expiresAt: later,
    observedRuleRows: [{ id: "ruleset-a", version: 1, priority: 1, enabled: 1, rules_json: "{}" }],
    ...overrides
  };
}

describe("D1 PR eligibility store", () => {
  it("refreshes an expired active pointer for the same logical key without overwriting immutable generations", async () => {
    const sql = new SqliteD1(); install(sql.db);
    const store = makeD1PrEligibilityStore(sql);

    const first = await store.reserve(reservation({ expiresAt: "2026-10-09T00:00:01.000Z" }));
    const second = await store.reserve(reservation({ now: "2026-10-09T00:00:02.000Z", committedAt: "2026-10-09T00:00:02.000Z", expiresAt: "2026-10-09T00:10:02.000Z" }));

    expect(first.operationId).toBe("pr-eligibility-key-a-g1");
    expect(second.operationId).toBe("pr-eligibility-key-a-g2");
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM pr_eligibility_generations").get()).toEqual({ count: 2 });
    expect(sql.db.prepare("SELECT operation_id,generation FROM pr_eligibility_active").get()).toEqual({ operation_id: "pr-eligibility-key-a-g2", generation: 2 });
  });

  it("replays a running active generation with the same operation and committedAt", async () => {
    const sql = new SqliteD1(); install(sql.db);
    const store = makeD1PrEligibilityStore(sql);

    const first = await store.reserve(reservation());
    const second = await store.reserve(reservation({ now: "2026-10-09T00:01:00.000Z", committedAt: "2026-10-09T00:01:00.000Z" }));

    expect(second).toMatchObject({ operationId: first.operationId, committedAt: now, replayed: true, snapshot: null });
    expect(second).toMatchObject({ expiresAt: later, generation: 1 });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE kind = 'pr.eligibility.prepare'").get()).toEqual({ count: 1 });
  });

  it("rejects finalization exactly at the active generation expiry boundary", async () => {
    const sql = new SqliteD1(); install(sql.db);
    const store = makeD1PrEligibilityStore(sql);
    await store.reserve(reservation({ expiresAt: "2026-10-09T00:00:01.000Z" }));

    await expect(store.complete(finalization({ now: "2026-10-09T00:00:01.000Z", expiresAt: "2026-10-09T00:00:01.000Z" }))).rejects.toThrow(PrEligibilityStoreConflictError);

    expect(sql.db.prepare("SELECT state,snapshot_json FROM pr_eligibility_generations").get()).toEqual({ state: "running", snapshot_json: null });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
  });

  it("rejects expired pointer refresh when the prior generation is outside safe bounds", async () => {
    const sql = new SqliteD1(); install(sql.db);
    const store = makeD1PrEligibilityStore(sql);
    await store.reserve(reservation({ expiresAt: "2026-10-09T00:00:01.000Z" }));
    sql.db.exec("UPDATE pr_eligibility_active SET generation = 2147483647 WHERE logical_key = 'key-a'");

    await expect(store.reserve(reservation({ now: "2026-10-09T00:00:02.000Z", committedAt: "2026-10-09T00:00:02.000Z" }))).rejects.toThrow(PrEligibilityStoreConflictError);
  });

  it("converges duplicate expired refresh attempts on the same winning operation", async () => {
    const sql = new SqliteD1(); install(sql.db);
    const store = makeD1PrEligibilityStore(sql);

    await store.reserve(reservation({ expiresAt: "2026-10-09T00:00:01.000Z" }));
    const refresh = reservation({ now: "2026-10-09T00:00:02.000Z", committedAt: "2026-10-09T00:00:02.000Z", expiresAt: "2026-10-09T00:10:02.000Z" });
    const first = await store.reserve(refresh);
    const second = await store.reserve(refresh);

    expect(first.operationId).toBe("pr-eligibility-key-a-g2");
    expect(second.operationId).toBe("pr-eligibility-key-a-g2");
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM pr_eligibility_generations").get()).toEqual({ count: 2 });
  });

  it("does not persist result or eligibility when the final SQL guard sees ruleset drift", async () => {
    const sql = new SqliteD1(); install(sql.db);
    const store = makeD1PrEligibilityStore(sql);
    await store.reserve(reservation());
    sql.db.exec("UPDATE rulesets SET version = 2 WHERE id = 'ruleset-a'");

    await expect(store.complete(finalization())).rejects.toThrow(PrEligibilityStoreConflictError);

    expect(sql.db.prepare("SELECT state,snapshot_json FROM pr_eligibility_generations").get()).toEqual({ state: "running", snapshot_json: null });
    expect(sql.db.prepare("SELECT result_key FROM operations WHERE id = ?").get("pr-eligibility-key-a-g1")).toEqual({ result_key: null });
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
  });

  it("rolls back finalization when a later statement fails after the guarded update", async () => {
    const sql = new SqliteD1(); install(sql.db);
    const store = makeD1PrEligibilityStore(sql);
    await store.reserve(reservation());
    sql.failBatchAt = 1;

    await expect(store.complete(finalization())).rejects.toThrow(PrEligibilityStoreConflictError);

    expect(sql.db.prepare("SELECT state,snapshot_json FROM pr_eligibility_generations").get()).toEqual({ state: "running", snapshot_json: null });
    expect(sql.db.prepare("SELECT result_key FROM operations WHERE id = ?").get("pr-eligibility-key-a-g1")).toEqual({ result_key: null });
  });

  it("leaves eligibility unchanged when an identical completed owner loses the new transition", async () => {
    const sql = new SqliteD1(); install(sql.db);
    const store = makeD1PrEligibilityStore(sql);
    await store.reserve(reservation());
    const completed = finalization({ candidateSha: null });
    await store.complete(completed);
    await expect(store.complete({ ...completed, candidateSha: "cccccccccccccccccccccccccccccccccccccccc" })).rejects.toThrow(PrEligibilityStoreConflictError);
    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT result_key FROM operations WHERE id = ?").get(completed.operationId)).toEqual({ result_key: "json:" + JSON.stringify(completed.result) });
  });

  it("does not let a duplicate completion publish eligibility from an already completed conflict generation", async () => {
    const sql = new SqliteD1(); install(sql.db);
    const store = makeD1PrEligibilityStore(sql);
    await store.reserve(reservation());
    await store.complete(finalization({ candidateSha: null, snapshot: { id: "pr-eligibility-key-a-g1", status: "blocked", candidate_sha: null }, result: { snapshot: { id: "pr-eligibility-key-a-g1", status: "blocked", candidate_sha: null }, outcome: { ok: false, status: "conflict" } }, progress: { committedAt: now, outcome: { ok: false, status: "conflict" } } }));

    await expect(store.complete(finalization({ candidateSha: "cccccccccccccccccccccccccccccccccccccccc", snapshot: { id: "pr-eligibility-key-a-g1", status: "blocked", candidate_sha: "cccccccccccccccccccccccccccccccccccccccc" }, result: { snapshot: { id: "pr-eligibility-key-a-g1", status: "blocked", candidate_sha: "cccccccccccccccccccccccccccccccccccccccc" }, outcome: { ok: true, status: "prepared" } }, progress: { committedAt: now, outcome: { ok: true, status: "prepared" } } }))).rejects.toThrow(PrEligibilityStoreConflictError);

    expect(sql.db.prepare("SELECT COUNT(*) AS count FROM eligibility").get()).toEqual({ count: 0 });
    expect(sql.db.prepare("SELECT result_key FROM operations WHERE id = ?").get("pr-eligibility-key-a-g1")).toEqual({ result_key: "json:{\"snapshot\":{\"id\":\"pr-eligibility-key-a-g1\",\"status\":\"blocked\",\"candidate_sha\":null},\"outcome\":{\"ok\":false,\"status\":\"conflict\"}}" });
  });
});
