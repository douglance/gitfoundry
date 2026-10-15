import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { PublicationConflictError, PublicationProviderError, makeFakePolicyPort, makeFakeProviderPort, makePublicationCoordinator, makePublicationScope, type GitPublicationIntent } from "./index.js";
import { makeSqlitePublicationJournal } from "./sqlite.js";

type SqliteValue = string | number | bigint | null | Uint8Array;

class SqliteAdapter {
  constructor(readonly db = new DatabaseSync(":memory:")) {}
  exec(sql: string) { this.db.exec(sql); }
  prepare(sql: string) {
    const database = this.db;
    return { run: (...values: readonly SqliteValue[]) => database.prepare(sql).run(...values), get: (...values: readonly SqliteValue[]) => database.prepare(sql).get(...values), all: (...values: readonly SqliteValue[]) => database.prepare(sql).all(...values) };
  }
}

const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const otherSha = "cccccccccccccccccccccccccccccccccccccccc";

function intent(overrides: Partial<GitPublicationIntent> = {}): GitPublicationIntent {
  return { tenantId: "tenant-a", repositoryId: "repo-a", principalId: "principal-a", operationId: "repo.ref-update", idempotencyKey: "idem-sqlite", expectedVersion: 4, policyEpoch: 2, leaseFence: "lease-sqlite", atomic: false, eligibilityId: null, reason: "sqlite recovery proof", changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: newSha, force: false }], ...overrides };
}

describe("SQLite Git publication journal", () => {
  it("persists unknown publication state and reconciles it across coordinator instances", async () => {
    const sqlite = new SqliteAdapter();
    const journal = makeSqlitePublicationJournal(sqlite);
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const request = intent();
    const publishReceipt = { receiptId: "publish-timeout", providerRequestId: "provider-timeout", submittedAt: "2026-10-08T00:00:00.000Z", capability: "old-oid-cas" as const, tenantId: request.tenantId, repositoryId: request.repositoryId, principalId: request.principalId, operationId: request.operationId, idempotencyKey: request.idempotencyKey, policyEpoch: request.policyEpoch, leaseFence: request.leaseFence, refs: request.changes };
    const unknown = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs, failPublish: new PublicationProviderError({ kind: "timeout_after_handoff", detail: "lost connection after handoff", receipt: publishReceipt }) }) }).publish(request));
    expect(unknown.state).toBe("unknown");
    refs.set("refs/heads/main", newSha);
    const recovered = await Effect.runPromise(makePublicationCoordinator({ journal: makeSqlitePublicationJournal(sqlite), policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs }) }).publish(request));
    expect(recovered.replayed).toBe(true);
    expect(recovered.state).toBe("accepted");
    expect(recovered.operation.status).toBe("succeeded");
    const row = sqlite.db.prepare("SELECT state, reason_code FROM git_publication_journal WHERE journal_id = ?").get(recovered.journal.journalId) as { state: string; reason_code: string | null };
    expect(row).toEqual({ state: "accepted", reason_code: null });
  });

  it("excludes conflicting refs across independent SQLite connections and releases fences on rejected preflight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gitfoundry-publication-"));
    try {
      const path = join(directory, "journal.sqlite");
      const firstJournal = makeSqlitePublicationJournal(new SqliteAdapter(new DatabaseSync(path)));
      const secondJournal = makeSqlitePublicationJournal(new SqliteAdapter(new DatabaseSync(path)));
      const firstIntent = intent({ idempotencyKey: "idem-first" });
      const secondIntent = intent({ idempotencyKey: "idem-second", changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: otherSha, force: false }] });
      const firstScope = await Effect.runPromise(makePublicationScope(firstIntent));
      const secondScope = await Effect.runPromise(makePublicationScope(secondIntent));
      const prepared = await Effect.runPromise(firstJournal.reservePrepared(firstIntent, firstScope, "2026-10-08T00:00:00.000Z"));
      await expect(Effect.runPromise(secondJournal.reservePrepared(secondIntent, secondScope, "2026-10-08T00:00:01.000Z"))).rejects.toBeInstanceOf(PublicationConflictError);
      await Effect.runPromise(firstJournal.finish(prepared.record.journalId, { state: "prepared", attempt: 0 }, "rejected", null, null, "stale_ref", "2026-10-08T00:00:02.000Z"));
      await expect(Effect.runPromise(secondJournal.reservePrepared(secondIntent, secondScope, "2026-10-08T00:00:03.000Z"))).resolves.toMatchObject({ replayed: false, record: { idempotencyKey: "idem-second" } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses attempt CAS and immutable terminal state to prevent late overwrites", async () => {
    const journal = makeSqlitePublicationJournal(new SqliteAdapter());
    const request = intent({ idempotencyKey: "idem-cas" });
    const scope = await Effect.runPromise(makePublicationScope(request));
    const prepared = await Effect.runPromise(journal.reservePrepared(request, scope, "2026-10-08T00:00:00.000Z"));
    const policy = { receiptId: "policy", tenantId: request.tenantId, repositoryId: request.repositoryId, principalId: request.principalId, capability: "repository.write" as const, policyEpoch: request.policyEpoch, leaseFence: request.leaseFence, observedAt: "2026-10-08T00:00:01.000Z" };
    const publishing = await Effect.runPromise(journal.markPublishing(prepared.record.journalId, { state: "prepared", attempt: 0 }, policy, "2026-10-08T00:00:02.000Z"));
    const staleTransition = await Effect.runPromise(journal.finish(publishing.journalId, { state: "prepared", attempt: 0 }, "unknown", null, null, "late_writer", "2026-10-08T00:00:03.000Z").pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag }))));
    expect(staleTransition).toEqual({ caught: true, tag: "PublicationConflictError" });
    const accepted = await Effect.runPromise(journal.finish(publishing.journalId, { state: "publishing", attempt: 1 }, "accepted", null, null, null, "2026-10-08T00:00:04.000Z"));
    expect(accepted.state).toBe("accepted");
    await expect(Effect.runPromise(journal.finish(publishing.journalId, { state: "accepted", attempt: 1 }, "unknown", null, null, "late_unknown", "2026-10-08T00:00:05.000Z"))).rejects.toBeInstanceOf(PublicationConflictError);
  });
});
