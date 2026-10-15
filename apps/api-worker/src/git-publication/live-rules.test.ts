import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { GitPublicationIntent } from "../../../../packages/core/src/git-publication/index.js";
import type { PreparedRefFacts } from "../../../../packages/core/src/git-publication/write-rules.js";
import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";
import { makeD1WriteRulesValidator } from "./live-rules.js";

const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const candidateSha = newSha;
const headSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const otherSha = "cccccccccccccccccccccccccccccccccccccccc";
const digest = "d".repeat(64);
const now = new Date("2026-10-08T00:00:00.000Z");

class SqliteD1 implements D1DatabaseLike {
  readonly db = new DatabaseSync(":memory:");
  prepare<T = Record<string, unknown>>(sql: string): D1PreparedStatement<T> {
    const statement = this.db.prepare(sql);
    return { bind: (...values: readonly unknown[]) => { const sqliteValues = values as readonly SQLInputValue[]; return { bind: (...nextValues: readonly unknown[]) => this.prepare<T>(sql).bind(...nextValues), first: async <R = T>() => statement.get(...sqliteValues) as R | null, all: async <R = T>() => ({ results: statement.all(...sqliteValues) as R[], success: true }) satisfies D1Result<R>, run: async () => { statement.run(...sqliteValues); return { success: true } satisfies D1Result<T>; } }; }, first: async <R = T>() => statement.get() as R | null, all: async <R = T>() => ({ results: statement.all() as R[], success: true }) satisfies D1Result<R>, run: async () => { statement.run(); return { success: true } satisfies D1Result<T>; } };
  }
}

class FailedQueryD1 extends SqliteD1 {
  override prepare<T = Record<string, unknown>>(sql: string): D1PreparedStatement<T> {
    const wrap = (statement: D1PreparedStatement<T>): D1PreparedStatement<T> => ({
      ...statement,
      bind: (...values: readonly unknown[]) => wrap(statement.bind(...values)),
      all: async <R = T>() => ({ results: [] as R[], success: false })
    });
    return wrap(super.prepare<T>(sql));
  }
}

class ThrowingD1 extends SqliteD1 { override prepare<T = Record<string, unknown>>(_sql: string): D1PreparedStatement<T> { throw new Error("private d1 token"); } }

function intent(overrides: Partial<GitPublicationIntent> = {}): GitPublicationIntent {
  return { tenantId: "tenant-a", repositoryId: "repo-a", principalId: "principal-a", operationId: "repo.ref-update", idempotencyKey: "idem-live-rules", expectedVersion: 1, policyEpoch: 1, leaseFence: "lease-live-rules", atomic: true, eligibilityId: "elig-a", reason: "validate live rules", changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: newSha, force: false }], ...overrides };
}

const prepared: readonly PreparedRefFacts[] = [{ ref: "refs/heads/main", oldSha, newSha, objectType: "commit", fastForward: true, changedPaths: ["src/app.ts"], maxBlobSizeBytes: 512, signatures: ["valid"], hasMergeCommit: false }];

describe("D1 live write rules validator", () => {
  it("reads current PR head and target base independently before counting current approvals", async () => {
    const sql = fixture();
    let nativeCalls = 0;
    const validator = makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: (request) => Effect.sync(() => { nativeCalls += 1; expect(request.repositoryId).toBe("repo-a"); return prepared; }) });

    const result = await capture(validator(intent()));

    expect(result).toEqual({ ok: true });
    expect(nativeCalls).toBe(1);
  });

  it("uses current active group, principal and connection membership", async () => {
    for (const [name, mutate] of [
      ["membership", (db: DatabaseSync) => db.prepare("DELETE FROM group_memberships WHERE tenant_id = 'tenant-a' AND principal_id = 'principal-a'").run()],
      ["group", (db: DatabaseSync) => db.prepare("UPDATE groups SET active = 0").run()],
      ["connection", (db: DatabaseSync) => db.prepare("UPDATE connections SET active = 0").run()],
      ["principal", (db: DatabaseSync) => db.prepare("UPDATE principals SET active = 0").run()]
    ] as const) {
      const sql = fixture();
      mutate(sql.db);
      const result = await capture(makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(intent()));
      expect(result, name).toMatchObject({ ok: false, tag: "PublicationDeniedError", reason: "writer_group_denied" });
    }
  });

  it("denies missing, expired and stale policy eligibility before accepting a PR-gated rule", async () => {
    for (const [name, mutate, request] of [
      ["missing", (db: DatabaseSync) => db.exec("DELETE FROM merge_queue; DELETE FROM eligibility"), intent()],
      ["expired", (db: DatabaseSync) => db.prepare("UPDATE eligibility SET expires_at = ?").run("2026-10-07T00:00:00.000Z"), intent()],
      ["epoch", (db: DatabaseSync) => db.prepare("UPDATE eligibility SET policy_epoch = 0").run(), intent()],
      ["candidate", (db: DatabaseSync) => db.prepare("UPDATE eligibility SET candidate_sha = ?").run(otherSha), intent()],
      ["base", (db: DatabaseSync) => db.prepare("UPDATE eligibility SET base_sha = ?").run(otherSha), intent()],
      ["head", (db: DatabaseSync) => db.prepare("UPDATE eligibility SET head_sha = ?").run(otherSha), intent()]
    ] as const) {
      const sql = fixture();
      mutate(sql.db);
      const result = await capture(makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(request));
      expect(result, name).toMatchObject({ ok: false, tag: "PublicationDeniedError" });
    }
  });

  it("rejects current PR changes even while the eligibility snapshot remains eligible", async () => {
    for (const [name, mutate] of [
      ["version", (db: DatabaseSync) => db.exec("UPDATE pull_requests SET version = 2")],
      ["head", (db: DatabaseSync) => db.prepare("UPDATE pull_requests SET head_sha = ?").run(otherSha)],
      ["base", (db: DatabaseSync) => db.prepare("UPDATE pull_requests SET base_sha = ?").run(otherSha)],
      ["target", (db: DatabaseSync) => db.exec("UPDATE pull_requests SET target_ref = 'refs/heads/other'")],
      ["draft", (db: DatabaseSync) => db.exec("UPDATE pull_requests SET draft = 1")],
      ["closed", (db: DatabaseSync) => db.prepare("UPDATE pull_requests SET closed_at = ?").run(now.toISOString())],
      ["merged", (db: DatabaseSync) => db.prepare("UPDATE pull_requests SET merged_at = ?, merge_sha = ?").run(now.toISOString(), newSha)]
    ] as const) {
      const sql = fixture(); mutate(sql.db);
      expect(await capture(makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(intent())), name)
        .toMatchObject({ ok: false, tag: "PublicationDeniedError" });
    }
  });

  it("counts only current approved reviews from active principals and actual human identities", async () => {
    for (const [name, mutate] of [
      ["missing review", (db: DatabaseSync) => db.exec("DELETE FROM reviews")],
      ["dismissed review", (db: DatabaseSync) => db.exec("UPDATE reviews SET state = 'dismissed'")],
      ["changes requested", (db: DatabaseSync) => db.exec("UPDATE reviews SET state = 'changes_requested'")],
      ["old head", (db: DatabaseSync) => db.prepare("UPDATE reviews SET head_sha = ?").run(otherSha)],
      ["inactive reviewer", (db: DatabaseSync) => db.exec("UPDATE principals SET active = 0 WHERE id = 'reviewer-a'")],
      ["service reviewer", (db: DatabaseSync) => db.exec("UPDATE principals SET kind = 'service' WHERE id = 'reviewer-a'")],
      ["wrong reviewer", (db: DatabaseSync) => db.exec("UPDATE reviews SET reviewer_id = 'principal-a'")]
    ] as const) {
      const sql = fixture(); mutate(sql.db);
      expect(await capture(makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(intent())), name)
        .toMatchObject({ ok: false, tag: "PublicationDeniedError" });
    }
  });

  it("uses chronological review decisions across timestamp offsets rather than lexical ordering", async () => {
    const sql = fixture();
    sql.db.prepare("UPDATE reviews SET created_at = ?, updated_at = ?").run("2026-10-07T23:58:00.000Z", "2026-10-07T23:59:00.000Z");
    sql.db.prepare("INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "review-new", 1, "2026-10-07T19:59:30.000-04:00", "2026-10-07T19:59:30.000-04:00", "repo-a", "pr-a", "reviewer-a", headSha, "changes_requested", "");
    expect(await capture(makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(intent())))
      .toMatchObject({ ok: false, tag: "PublicationDeniedError", reason: "changes_requested" });
  });

  it("does not multiply one reviewer through duplicate snapshot evidence", async () => {
    const sql = fixture(); const evidence = snapshot();
    sql.db.prepare("UPDATE eligibility SET snapshot_json = ?").run(JSON.stringify({ ...evidence, reviews: [evidence.reviews[0], evidence.reviews[0]] }));
    sql.db.prepare("UPDATE rulesets SET rules_json = ?").run(JSON.stringify({ ...rule(), required_approvals: 2 }));
    expect(await capture(makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(intent())))
      .toMatchObject({ ok: false, tag: "PublicationDeniedError", reason: "approval_count_denied" });
  });

  it("does not infer code owners, resolved threads, or check success from eligible snapshot booleans", async () => {
    for (const patch of [
      { require_latest_push_approval: true }, { require_code_owners: true }, { require_resolved_threads: true },
      { required_checks: [{ context: "test", producer_id: "ci", accepted_conclusions: ["success"], max_age_seconds: 3600 }] }
    ]) {
      const sql = fixture();
      sql.db.prepare("UPDATE rulesets SET rules_json = ?").run(JSON.stringify({ ...rule(), ...patch }));
      expect(await capture(makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(intent())))
        .toMatchObject({ ok: false });
    }
  });

  it("rejects noncanonical eligibility snapshots instead of trusting invented booleans", async () => {
    const sql = fixture();
    sql.db.prepare("UPDATE eligibility SET snapshot_json = ?").run(JSON.stringify({ ...snapshot(), fresh: true }));

    const result = await capture(makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(intent()));

    expect(result).toMatchObject({ ok: false, tag: "PublicationProviderError", kind: "unreachable" });
  });

  it("rejects failed D1 query envelopes instead of interpreting them as no active rules", async () => {
    const sql = new FailedQueryD1();
    installSchema(sql.db); seed(sql.db);
    const result = await capture(makeD1WriteRulesValidator(sql, { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(intent()));
    expect(result).toMatchObject({ ok: false, tag: "PublicationProviderError", kind: "unreachable" });
  });

  it("maps malformed storage to bounded provider errors without leaking private diagnostics", async () => {
    const result = await capture(makeD1WriteRulesValidator(new ThrowingD1(), { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed(prepared) })(intent()));

    expect(result).toMatchObject({ ok: false, tag: "PublicationProviderError", kind: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("private d1 token");
  });

  it("maps missing native rule evidence to unsupported instead of policy allow", async () => {
    const result = await capture(makeD1WriteRulesValidator(fixture(), { clock: { now: () => now }, loadPreparedRefFacts: () => Effect.succeed([{ ...prepared[0]!, signatures: null }]) })(intent()));

    expect(result).toMatchObject({ ok: false, tag: "PublicationProviderError", kind: "unsupported" });
  });
});

async function capture(effect: Effect.Effect<void, unknown>): Promise<{ readonly ok: true } | { readonly ok: false; readonly tag: string | undefined; readonly reason: string | undefined; readonly kind: string | undefined }> {
  return await Effect.runPromise(effect.pipe(Effect.map(() => ({ ok: true as const })), Effect.catch((error) => Effect.succeed({ ok: false as const, tag: tagOf(error), reason: reasonOf(error), kind: kindOf(error) }))));
}

function fixture(): SqliteD1 {
  const sql = new SqliteD1();
  installSchema(sql.db);
  seed(sql.db);
  return sql;
}

function installSchema(db: DatabaseSync) {
  db.exec(readFileSync(new URL("../../../../docs/source/handoff/contracts/schema.sql", import.meta.url), "utf8"));
}

function seed(db: DatabaseSync) {
  const ts = now.toISOString();
  db.prepare("INSERT INTO tenants(id,slug,state,policy_epoch,shard_id,jurisdiction) VALUES(?,?,?,?,?,?)").run("tenant-a", "tenant-a", "active", 1, "shard-a", "global");
  db.prepare("INSERT INTO organization_namespaces VALUES(?,?,?,?,?,?,?)").run("tenant-a", "namespace-a", 1, ts, ts, "org", "");
  db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "repo-a", 1, ts, ts, "namespace-a", "repo", "private", "main", 0, "artifacts", "repo", null);
  db.prepare("INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "conn-a", 1, ts, ts, "issuer", "external-tenant", "audience", "{}", 1);
  db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "principal-a", 1, ts, ts, "human", "Principal A", 1, 1);
  db.prepare("INSERT INTO principals VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "reviewer-a", 1, ts, ts, "human", "Reviewer A", 1, 1);
  db.prepare("INSERT INTO issues VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "issue-a", 1, ts, ts, "repo-a", 1, "PR", "", "open", "", "principal-a", "pull_request");
  db.prepare("INSERT INTO pull_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "pr-a", 1, ts, ts, "issue-a", "repo-a", "repo-a", "refs/heads/topic", "refs/heads/main", headSha, oldSha, 0, null, null, null);
  db.prepare("INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "review-a", 1, ts, ts, "repo-a", "pr-a", "reviewer-a", headSha, "approved", "");
  db.prepare("INSERT INTO groups VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "group-writers", 1, ts, ts, "conn-a", "external-writers", "writers", 1);
  db.prepare("INSERT INTO group_memberships VALUES(?,?,?,?)").run("tenant-a", "group-writers", "principal-a", 1);
  db.prepare("INSERT INTO rulesets VALUES(?,?,?,?,?,?,?,?,?)").run("tenant-a", "rule-a", 1, ts, ts, "repo-a", 1, JSON.stringify(rule()), 1);
  db.prepare("INSERT INTO eligibility VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "elig-a", 1, ts, ts, "repo-a", "pr-a", headSha, oldSha, candidateSha, 1, JSON.stringify(snapshot()), "2026-10-09T00:00:00.000Z");
  db.prepare("INSERT INTO merge_queue VALUES(?,?,?,?,?,?,?,?,?,?)").run("tenant-a", "queue-a", 1, ts, ts, "repo-a", "pr-a", 1, "queued", "elig-a");
}

function rule() {
  return { id: "rule-a", name: "main", state: "active", target: "branch", include_patterns: ["refs/heads/main"], exclude_patterns: [], require_pull_request: true, required_approvals: 1, require_human_approval: true, dismiss_stale_reviews: true, require_latest_push_approval: false, require_code_owners: false, require_resolved_threads: false, require_linear_history: true, require_signed_commits: true, require_merge_queue: true, allow_force_push: false, allow_deletion: false, allowed_writer_group_ids: ["group-writers"], required_checks: [], required_environment_ids: [], allowed_merge_methods: ["merge"], bypass: [], max_blob_size_bytes: 1024, forbidden_path_patterns: ["secrets/**"], mandatory: false };
}

function snapshot() {
  return { tenant_id: "tenant-a", pull_request_id: "pr-a", pr_version: 1, id: "elig-a", status: "eligible", head_sha: headSha, base_sha: oldSha, candidate_sha: candidateSha, method: "merge", diff_digest: digest, policy_digest: digest, policy_epoch: 1, expires_at: "2026-10-09T00:00:00.000Z", blockers: [], reviews: [{ review_id: "review-a", reviewer_id: "reviewer-a", head_sha: headSha, diff_digest: digest, policy_digest: digest, eligible: true, reason: null }], checks: [{ check_id: "check-a", producer_id: "ci", context: "test", commit_sha: candidateSha, generation: 1, satisfied: true }] };
}

function tagOf(error: unknown): string | undefined { return typeof error === "object" && error !== null && "_tag" in error ? String((error as { readonly _tag?: unknown })._tag) : undefined; }
function reasonOf(error: unknown): string | undefined { return typeof error === "object" && error !== null && "reason" in error ? String((error as { readonly reason?: unknown }).reason) : undefined; }
function kindOf(error: unknown): string | undefined { return typeof error === "object" && error !== null && "kind" in error ? String((error as { readonly kind?: unknown }).kind) : undefined; }
