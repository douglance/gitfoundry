import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { PublicationConflictError, PublicationDeniedError, PublicationProviderError, PublicationStorageError, makePublicationScope, type GitPublicationIntent, type PolicyAdmissionPort, type PolicyReceipt, type ProviderObservationReceipt, type ProviderPublicationReceipt, type TrustedGitPublicationPort } from "../../../../packages/core/src/git-publication/index.js";
import { handleGitPublicationJournalRequest, makeDurableObjectPublicationJournal, publishWithDurableJournal, recoverWithDurableJournal, type DurablePublicationStorage } from "./index.js";

vi.mock("cloudflare:workers", () => ({ DurableObject: class<Env = unknown> { readonly ctx: DurableObjectState; readonly env: Env; constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env } } }));

type SqlValue = ArrayBuffer | string | number | null;

const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const otherSha = "cccccccccccccccccccccccccccccccccccccccc";

function intent(overrides: Partial<GitPublicationIntent> = {}): GitPublicationIntent {
  return { tenantId: "tenant-a", repositoryId: "repo-a", principalId: "principal-a", operationId: "repo.ref-update", idempotencyKey: "idem-do", expectedVersion: 9, policyEpoch: 4, leaseFence: "lease-do", atomic: true, eligibilityId: "eligibility-do", reason: "publish via repository durable object", changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: newSha, force: false }], ...overrides };
}

function policyReceipt(request: GitPublicationIntent = intent()): PolicyReceipt {
  return { receiptId: `policy-${request.leaseFence}`, tenantId: request.tenantId, repositoryId: request.repositoryId, principalId: request.principalId, capability: "repository.write", policyEpoch: request.policyEpoch, leaseFence: request.leaseFence, observedAt: "2026-10-08T00:00:00.000Z" };
}

function publicationReceipt(request: GitPublicationIntent = intent()): ProviderPublicationReceipt {
  return { receiptId: `publish-${request.leaseFence}`, providerRequestId: `provider-${request.leaseFence}`, submittedAt: "2026-10-08T00:00:01.000Z", capability: "old-oid-cas", tenantId: request.tenantId, repositoryId: request.repositoryId, principalId: request.principalId, operationId: request.operationId, idempotencyKey: request.idempotencyKey, policyEpoch: request.policyEpoch, leaseFence: request.leaseFence, refs: request.changes };
}

function observation(request: GitPublicationIntent = intent(), oid = newSha): ProviderObservationReceipt {
  return { receiptId: `observe-${request.leaseFence}`, providerRequestId: `provider-observe-${request.leaseFence}`, observedAt: "2026-10-08T00:00:02.000Z", refs: request.changes.map((change) => ({ ref: change.ref, oid })) };
}

describe("Git publication Durable Object journal", () => {

  it.each(["accepted", "unknown"] as const)("recovers persisted %s after closing and reopening SQLite without a write-capable policy", async (state) => {
    const directory = mkdtempSync(path.join(tmpdir(), "gitfoundry-recovery-reopen-"));
    const databasePath = path.join(directory, "journal.sqlite");
    let storage = new SqliteDurableStorage(new DatabaseSync(databasePath));
    try {
      const request = intent({ idempotencyKey: "reopen-" + state });
      const journal = makeDurableObjectPublicationJournal(storage);
      const prepared = await Effect.runPromise(journal.reservePrepared(request, await Effect.runPromise(makePublicationScope(request)), fixedClock.now().toISOString()));
      const publishing = await Effect.runPromise(journal.markPublishing(prepared.record.journalId, { state: "prepared", attempt: 0 }, policyReceipt(request), fixedClock.now().toISOString()));
      await Effect.runPromise(journal.finish(publishing.journalId, { state: "publishing", attempt: 1 }, state, publicationReceipt(request), state === "accepted" ? observation(request) : null, state === "unknown" ? "reply_lost" : null, fixedClock.now().toISOString()));
      storage.db.close();
      storage = new SqliteDurableStorage(new DatabaseSync(databasePath));
      const calls: string[] = [];
      const refs = new Map<string, string | null>([["refs/heads/main", state === "accepted" ? otherSha : newSha]]);
      const recovered = await Effect.runPromise(recoverWithDurableJournal({ storage, scope: { tenantId: request.tenantId, repositoryId: request.repositoryId, journalId: publishing.journalId }, provider: providerPort({ refs, calls }), clock: fixedClock }));
      expect(recovered).toMatchObject({ state: "accepted", replayed: true, journal: { attempt: 1, journalId: publishing.journalId } });
      expect(calls).toEqual(state === "accepted" ? [] : ["observe"]);
      expect(refs.get("refs/heads/main")).toBe(state === "accepted" ? otherSha : newSha);
      expect(storage.db.prepare("SELECT COUNT(*) AS count FROM git_publication_ref_fences").get()).toEqual({ count: 0 });
      await expectRecord(storage, publishing.journalId, { state: "accepted", reasonCode: null });
    } finally {
      storage.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains the persisted fence after restart when recovery has no commit receipt", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gitfoundry-recovery-fence-"));
    const databasePath = path.join(directory, "journal.sqlite");
    let storage = new SqliteDurableStorage(new DatabaseSync(databasePath));
    try {
      const request = intent({ idempotencyKey: "missing-receipt-reopen" });
      const journal = makeDurableObjectPublicationJournal(storage);
      const prepared = await Effect.runPromise(journal.reservePrepared(request, await Effect.runPromise(makePublicationScope(request)), fixedClock.now().toISOString()));
      const publishing = await Effect.runPromise(journal.markPublishing(prepared.record.journalId, { state: "prepared", attempt: 0 }, policyReceipt(request), fixedClock.now().toISOString()));
      storage.db.close();
      storage = new SqliteDurableStorage(new DatabaseSync(databasePath));
      const calls: string[] = [];
      const recovered = await Effect.runPromise(recoverWithDurableJournal({ storage, scope: { tenantId: request.tenantId, repositoryId: request.repositoryId, journalId: publishing.journalId }, provider: providerPort({ refs: new Map([["refs/heads/main", newSha]]), calls }), clock: fixedClock }));
      expect(recovered).toMatchObject({ state: "unknown", journal: { reasonCode: "missing_provider_commit_receipt", attempt: 1 } });
      expect(calls).toEqual(["observe"]);
      expect(storage.db.prepare("SELECT COUNT(*) AS count FROM git_publication_ref_fences").get()).toEqual({ count: 1 });
      const competing = intent({ idempotencyKey: "must-stay-fenced" });
      await expect(Effect.runPromise(makeDurableObjectPublicationJournal(storage).reservePrepared(competing, await Effect.runPromise(makePublicationScope(competing)), fixedClock.now().toISOString()))).rejects.toBeInstanceOf(PublicationConflictError);
    } finally {
      storage.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not expose trusted recovery through the journal HTTP handler", async () => {
    const storage = new SqliteDurableStorage();
    try {
      const response = await handleGitPublicationJournalRequest(storage, new Request("https://git-publication.test/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: "tenant-a", repositoryId: "repo-a", journalId: "gitpub-" + "1".repeat(32) }) }));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: "not_found" });
      expect(storage.sqlStatements).toEqual([]);
    } finally { storage.db.close(); }
  });
  it("persists typed intent receipt CAS and fence state through transactionSync without explicit SQL transactions", async () => {
    const storage = new SqliteDurableStorage();
    const journal = makeDurableObjectPublicationJournal(storage);
    const request = intent();
    const scope = await Effect.runPromise(makePublicationScope(request));
    const prepared = await Effect.runPromise(journal.reservePrepared(request, scope, "2026-10-08T00:00:00.000Z"));
    const publishing = await Effect.runPromise(journal.markPublishing(prepared.record.journalId, { state: "prepared", attempt: 0 }, policyReceipt(request), "2026-10-08T00:00:01.000Z"));
    const unknown = await Effect.runPromise(journal.finish(publishing.journalId, { state: "publishing", attempt: 1 }, "unknown", publicationReceipt(request), observation(request), "provider_timeout_after_handoff", "2026-10-08T00:00:02.000Z"));
    expect(unknown).toMatchObject({ tenantId: "tenant-a", repositoryId: "repo-a", principalId: "principal-a", state: "unknown", attempt: 1, atomic: true, policyReceipt: { leaseFence: "lease-do" }, providerReceipt: { capability: "old-oid-cas", leaseFence: "lease-do" }, observationReceipt: { refs: [{ ref: "refs/heads/main", oid: newSha }] } });

    const replay = await Effect.runPromise(journal.reservePrepared(request, scope, "2026-10-08T00:00:03.000Z"));
    expect(replay).toMatchObject({ replayed: true, record: { state: "unknown", journalId: unknown.journalId } });
    const conflictIntent = intent({ idempotencyKey: "idem-conflict", changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: otherSha, force: false }] });
    const conflict = await Effect.runPromise(journal.reservePrepared(conflictIntent, await Effect.runPromise(makePublicationScope(conflictIntent)), "2026-10-08T00:00:04.000Z").pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag }))));
    expect(conflict).toEqual({ caught: true, tag: "PublicationConflictError" });
    expect(storage.transactionCount).toBeGreaterThanOrEqual(3);
    expect(storage.sqlStatements.some((statement) => /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i.test(statement))).toBe(false);
  });

  it("routes stale transition conflicts and unexpected storage faults through typed Effect failures", async () => {
    const storage = new SqliteDurableStorage();
    const journal = makeDurableObjectPublicationJournal(storage);
    const request = intent({ idempotencyKey: "typed-fail" });
    const prepared = await Effect.runPromise(journal.reservePrepared(request, await Effect.runPromise(makePublicationScope(request)), "2026-10-08T00:00:00.000Z"));
    const publishing = await Effect.runPromise(journal.markPublishing(prepared.record.journalId, { state: "prepared", attempt: 0 }, policyReceipt(request), "2026-10-08T00:00:01.000Z"));
    const stale = await Effect.runPromise(journal.finish(publishing.journalId, { state: "prepared", attempt: 0 }, "accepted", null, null, null, "2026-10-08T00:00:02.000Z").pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag }))));
    expect(stale).toEqual({ caught: true, tag: "PublicationConflictError" });

    const broken = makeDurableObjectPublicationJournal(new BrokenDurableStorage());
    const storageFault = await Effect.runPromise(broken.get("journal-a").pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag }))));
    expect(storageFault).toEqual({ caught: true, tag: "PublicationStorageError" });
  });

  it("uses the core coordinator but fails closed while the trusted Git helper is not wired", async () => {
    const storage = new SqliteDurableStorage();
    const request = intent({ idempotencyKey: "fail-closed" });
    const outcome = await Effect.runPromise(publishWithDurableJournal({ storage, intent: request, clock: { now: () => new Date("2026-10-08T00:00:00.000Z") } }));
    expect(outcome).toMatchObject({ state: "rejected", journal: { reasonCode: "provider_unreachable" }, operation: { status: "failed" } });
    expect(await Effect.runPromise(makeDurableObjectPublicationJournal(storage).get(outcome.journal.journalId))).toMatchObject({ state: "rejected", reasonCode: "provider_unreachable" });
  });

  it("blocks publication with the default unavailable policy even when a provider is configured", async () => {
    const storage = new SqliteDurableStorage();
    const request = intent({ idempotencyKey: "default-policy-unavailable" });
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const providerCalls: string[] = [];
    const blocked = await Effect.runPromise(publishWithDurableJournal({ storage, intent: request, provider: providerPort({ refs, calls: providerCalls }), clock: fixedClock }).pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag, kind: (error as { readonly kind?: string }).kind }))));

    expect(blocked).toEqual({ caught: true, tag: "PublicationProviderError", kind: "unreachable" });
    expect(providerCalls).toEqual(["observe"]);
    expect(refs.get("refs/heads/main")).toBe(oldSha);
    const scope = await Effect.runPromise(makePublicationScope(request));
    await expectRecord(storage, scope.journalId, { state: "rejected", reasonCode: "policy_denied" });

    const followup = intent({ idempotencyKey: "after-default-policy-unavailable" });
    const followupOutcome = await Effect.runPromise(publishWithDurableJournal({ storage, intent: followup, policy: policyPort(), provider: providerPort({ refs }), clock: fixedClock }));
    expect(followupOutcome).toMatchObject({ state: "accepted", journal: { reasonCode: null } });
  });

  it("uses a supplied authoritative policy port at finalization", async () => {
    const storage = new SqliteDurableStorage();
    const request = intent({ idempotencyKey: "authoritative-policy" });
    const policyCalls: GitPublicationIntent[] = [];
    const providerCalls: string[] = [];
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);

    const outcome = await Effect.runPromise(publishWithDurableJournal({ storage, intent: request, policy: policyPort({ calls: policyCalls }), provider: providerPort({ refs, calls: providerCalls }), clock: fixedClock }));

    expect(outcome).toMatchObject({ state: "accepted", replayed: false, journal: { policyReceipt: { leaseFence: "lease-do" }, reasonCode: null }, operation: { status: "succeeded" } });
    expect(policyCalls).toHaveLength(1);
    expect(policyCalls[0]).toMatchObject({ idempotencyKey: "authoritative-policy", leaseFence: "lease-do" });
    expect(providerCalls).toEqual(["observe", "publish", "observe"]);
  });

  it("denies publication through the authoritative policy port and releases the rejected journal fence", async () => {
    const storage = new SqliteDurableStorage();
    const request = intent({ idempotencyKey: "policy-denied" });
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const denied = await Effect.runPromise(publishWithDurableJournal({ storage, intent: request, policy: policyPort({ deny: true }), provider: providerPort({ refs }), clock: fixedClock }).pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag }))));

    expect(denied).toEqual({ caught: true, tag: "PublicationDeniedError" });
    const deniedScope = await Effect.runPromise(makePublicationScope(request));
    await expectRecord(storage, deniedScope.journalId, { state: "rejected", reasonCode: "policy_denied" });

    const followup = intent({ idempotencyKey: "after-policy-denial" });
    const followupOutcome = await Effect.runPromise(publishWithDurableJournal({ storage, intent: followup, policy: policyPort(), provider: providerPort({ refs }), clock: fixedClock }));
    expect(followupOutcome).toMatchObject({ state: "accepted", journal: { reasonCode: null } });
  });

  it("fails stale policy receipts from an authoritative port", async () => {
    const storage = new SqliteDurableStorage();
    const request = intent({ idempotencyKey: "stale-policy-receipt" });
    const providerCalls: string[] = [];
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const stale = await Effect.runPromise(publishWithDurableJournal({
      storage,
      intent: request,
      policy: policyPort({ receipt: (_intent, receipt) => ({ ...receipt, leaseFence: "stale-lease" }) }),
      provider: providerPort({ refs, calls: providerCalls }),
      clock: fixedClock
    }).pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag, reason: (error as { readonly reason?: string }).reason }))));

    expect(stale).toEqual({ caught: true, tag: "PublicationConflictError", reason: "policy_receipt_fence_mismatch" });
    expect(providerCalls).toEqual(["observe"]);
    const scope = await Effect.runPromise(makePublicationScope(request));
    await expectRecord(storage, scope.journalId, { state: "rejected", reasonCode: "policy_receipt_fence_mismatch" });
  });

  it("revalidates policy before returning a terminal replay", async () => {
    const storage = new SqliteDurableStorage();
    const request = intent({ idempotencyKey: "terminal-replay" });
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const first = await Effect.runPromise(publishWithDurableJournal({ storage, intent: request, policy: policyPort(), provider: providerPort({ refs }), clock: fixedClock }));
    expect(first).toMatchObject({ state: "accepted", replayed: false });

    const replayPolicyCalls: GitPublicationIntent[] = [];
    const replayProviderCalls: string[] = [];
    const replay = await Effect.runPromise(publishWithDurableJournal({ storage, intent: request, policy: policyPort({ deny: true, calls: replayPolicyCalls }), provider: providerPort({ refs, calls: replayProviderCalls }), clock: fixedClock }).pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag }))));

    expect(replay).toEqual({ caught: true, tag: "PublicationDeniedError" });
    expect(replayPolicyCalls).toHaveLength(1);
    expect(replayProviderCalls).toEqual([]);
  });

  it("rejects forged HTTP policy receipts before journal or provider effects", async () => {
    const storage = new SqliteDurableStorage();
    const request = intent({ idempotencyKey: "forged-http-policy" });
    const response = await handleGitPublicationJournalRequest(storage, new Request("https://git-publication.test/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: request, policy_receipt: policyReceipt(request) }) }));
    const body = await response.json() as { readonly ok: boolean; readonly error: string };

    expect(response.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "client_policy_receipt_not_accepted" });
    expect(storage.sqlStatements).toEqual([]);
    expect(storage.transactionCount).toBe(0);
  });

  it("rejects valid JSON non-object publish bodies before journal effects", async () => {
    for (const bodyValue of ["just-a-string", 1, true, [], null]) {
      const storage = new SqliteDurableStorage();
      const response = await handleGitPublicationJournalRequest(storage, new Request("https://git-publication.test/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyValue) }));
      const body = await response.json() as { readonly ok: boolean; readonly error: string };

      expect(response.status).toBe(400);
      expect(body).toEqual({ ok: false, error: "invalid_publication_request" });
      expect(storage.sqlStatements).toEqual([]);
      expect(storage.transactionCount).toBe(0);
    }
  });

  it("persists a rejected publication journal across actual installed workerd restarts", async () => {
    const result = runPersistenceProbeInWorkerd();
    expect(result.first.status).toBe(200);
    const outcome = result.first.body.outcome;
    expect(outcome).toBeDefined();
    if (!outcome) throw new Error("publication outcome missing");
    expect(outcome.state).toBe("rejected");
    expect(outcome.journal.reasonCode).toBe("provider_unreachable");
    expect(result.second.status).toBe(200);
    expect(result.second.body.record).toMatchObject({ journalId: outcome.journal.journalId, state: "rejected", reasonCode: "provider_unreachable", tenantId: "tenant-a", repositoryId: "repo-a" });
  }, 45_000);
});

const fixedClock = { now: () => new Date("2026-10-08T00:00:00.000Z") };

function policyPort(input: { readonly deny?: boolean; readonly calls?: GitPublicationIntent[]; readonly receipt?: (intent: GitPublicationIntent, receipt: PolicyReceipt) => PolicyReceipt } = {}): PolicyAdmissionPort {
  return { revalidate: (request) => {
    input.calls?.push(request);
    if (input.deny) return Effect.fail(new PublicationDeniedError({ reason: "policy denied", tenantId: request.tenantId, principalId: request.principalId, capability: "repository.write" }));
    const receipt = policyReceipt(request);
    return Effect.succeed(input.receipt ? input.receipt(request, receipt) : receipt);
  } };
}

function providerPort(input: { readonly refs: Map<string, string | null>; readonly calls?: string[]; readonly failObserve?: PublicationProviderError; readonly failPublish?: PublicationProviderError }): TrustedGitPublicationPort {
  return {
    observeRefs: (request) => {
      input.calls?.push("observe");
      if (input.failObserve) return Effect.fail(input.failObserve);
      return Effect.succeed({ receiptId: `observe-${input.calls?.length ?? 0}`, providerRequestId: `provider-observe-${input.calls?.length ?? 0}`, observedAt: fixedClock.now().toISOString(), refs: request.changes.map((change) => ({ ref: change.ref, oid: input.refs.get(change.ref) ?? null })) });
    },
    publishRefs: (request, policy) => {
      input.calls?.push("publish");
      if (input.failPublish) return Effect.fail(input.failPublish);
      if (policy.policyEpoch !== request.policyEpoch || policy.leaseFence !== request.leaseFence) return Effect.fail(new PublicationProviderError({ kind: "unsupported", detail: "policy receipt does not match publication fence" }));
      for (const change of request.changes) if ((input.refs.get(change.ref) ?? null) !== change.old_sha) return Effect.fail(new PublicationProviderError({ kind: "cas_mismatch", detail: `old OID changed for ${change.ref}` }));
      for (const change of request.changes) input.refs.set(change.ref, change.new_sha);
      return Effect.succeed(publicationReceipt(request));
    }
  };
}

async function expectRecord(storage: DurablePublicationStorage, journalId: string, expected: { readonly state: string; readonly reasonCode: string | null }) {
  await expect(Effect.runPromise(makeDurableObjectPublicationJournal(storage).get(journalId))).resolves.toMatchObject(expected);
}

class SqliteDurableStorage implements DurablePublicationStorage {
  readonly db: DatabaseSync;
  readonly sqlStatements: string[] = [];
  transactionCount = 0;

  constructor(db = new DatabaseSync(":memory:")) { this.db = db }

  readonly sql = { exec: <T extends Record<string, SqlValue>>(query: string, ...bindings: readonly SqlValue[]) => {
    this.sqlStatements.push(query);
    const statement = this.db.prepare(query);
    const sqlBindings = bindings as (string | number | bigint | null)[];
    if (/^\s*(SELECT|PRAGMA)\b/i.test(query) || /\bRETURNING\b/i.test(query)) return cursor(statement.all(...sqlBindings) as T[], 0);
    const result = statement.run(...sqlBindings);
    return cursor<T>([], Number(result.changes ?? 0));
  } };

  transactionSync<T>(closure: () => T): T {
    this.transactionCount += 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = closure();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class BrokenDurableStorage implements DurablePublicationStorage {
  readonly sql = { exec: <T extends Record<string, SqlValue>>(): ReturnType<typeof cursor<T>> => { throw new Error("disk unavailable") } };
  transactionSync<T>(closure: () => T): T { return closure() }
}

function cursor<T extends Record<string, SqlValue>>(rows: T[], rowsWritten: number) { return { rowsWritten, toArray: () => rows, one: () => { const row = rows[0]; if (!row) throw new Error("expected one row"); return row; } } }

type WorkerdProbeResult = { readonly first: { readonly status: number; readonly contentType: string | null; readonly body: { readonly outcome?: { readonly state: string; readonly journal: { readonly journalId: string; readonly reasonCode: string | null } }; readonly error?: unknown } }; readonly second: { readonly status: number; readonly contentType: string | null; readonly body: { readonly record: { readonly journalId: string; readonly state: string; readonly reasonCode: string | null; readonly tenantId: string; readonly repositoryId: string } | null } } };

function runPersistenceProbeInWorkerd(): WorkerdProbeResult {
  const root = path.resolve(__dirname, "../../../..");
  const storageRoot = mkdtempSync(path.join(tmpdir(), "gitfoundry-publication-do-"));
  const fixture = JSON.stringify({ root, storageRoot, intent: intent({ idempotencyKey: "workerd-restart" }) });
  const script = `
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const fixture = JSON.parse(process.env.GFY_PUBLICATION_FIXTURE ?? "{}");
const runtimeRoot = path.join(fixture.root, "node_modules/.pnpm/node_modules/@alchemy.run/cloudflare-runtime");
const effectRoot = path.join(fixture.root, "node_modules/.pnpm/effect@4.0.2/node_modules/effect/dist");
const platformNode = path.join(fixture.root, "node_modules/.pnpm/@effect+platform-node@4.0.2_effect@4.0.2_redis@6.3.0/node_modules/@effect/platform-node/dist/NodeServices.js");
const rolldownPackage = path.join(fixture.root, "node_modules/.pnpm/node_modules/rolldown/dist/index.mjs");
for (const file of [path.join(runtimeRoot, "dist/core/node/workerd/Workerd.mjs"), path.join(runtimeRoot, "dist/core/node/internal/internal-modules.mjs"), path.join(runtimeRoot, "dist/core/node/internal/internal-worker.mjs"), path.join(effectRoot, "Effect.js"), path.join(effectRoot, "Layer.js"), platformNode, rolldownPackage]) {
  if (fs.readFileSync(file).byteLength <= 0) throw new Error("runtime module missing");
}
const [Effect, Layer, NodeServices, Workerd, _internalModules, _internalWorker, { rolldown }] = await Promise.all([
  import(pathToFileURL(path.join(effectRoot, "Effect.js")).href),
  import(pathToFileURL(path.join(effectRoot, "Layer.js")).href),
  import(pathToFileURL(platformNode).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/workerd/Workerd.mjs")).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/internal/internal-modules.mjs")).href),
  import(pathToFileURL(path.join(runtimeRoot, "dist/core/node/internal/internal-worker.mjs")).href),
  import(pathToFileURL(rolldownPackage).href)
]);
const bundle = await rolldown({ input: path.join(fixture.root, "apps/api-worker/src/git-publication/index.ts") });
const output = await bundle.generate({ format: "es", codeSplitting: false, sourcemap: false });
const chunk = output.output.find((item) => item.type === "chunk");
if (!chunk) throw new Error("publication bundle missing");
const suffix = String(process.pid) + "-" + path.basename(fixture.storageRoot).replace(/[^a-zA-Z0-9_-]/g, "-");
const socketName = "git-publication-http-" + suffix;
const serviceName = "git-publication-" + suffix;
const storageName = "git-publication-storage-" + suffix;
const workerSource = "import { GitPublicationRepositoryJournal } from './git-publication.js';\\n" +
  "export { GitPublicationRepositoryJournal };\\n" +
  "export default { async fetch(request, env) { const id = env.GIT_PUBLICATION_JOURNAL.idFromName('tenant-a/repo-a'); const url = new URL(request.url); const body = await request.text(); return env.GIT_PUBLICATION_JOURNAL.get(id).fetch('https://git-publication-journal.internal' + url.pathname, { method: request.method, headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }, body }); } };";
const config = {
  sockets: [{ name: socketName, address: "127.0.0.1:0", service: { name: serviceName } }],
  services: [
    { name: storageName, disk: { path: fixture.storageRoot, writable: true } },
    { name: serviceName, worker: { compatibilityDate: "2026-03-10", modules: [{ name: "index.js", esModule: workerSource }, { name: "git-publication.js", esModule: chunk.code }], durableObjectNamespaces: [{ className: "GitPublicationRepositoryJournal", enableSql: true, uniqueKey: "gitfoundry-git-publication-journal-v1-" + suffix, preventEviction: true }], durableObjectStorage: { localDisk: storageName }, bindings: [{ name: "GIT_PUBLICATION_JOURNAL", durableObjectNamespace: { className: "GitPublicationRepositoryJournal", serviceName } }] } }
  ]
};
const services = Layer.provide(Workerd.WorkerdLive, NodeServices.layer);
async function serveOnce(kind, journalId) {
  return await Effect.runPromise(Effect.provide(Effect.scoped(Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const ports = yield* workerd.serve(config);
    return yield* Effect.promise(async () => {
      const body = kind === "publish" ? JSON.stringify({ intent: fixture.intent }) : JSON.stringify({ journal_id: journalId });
      const response = await fetch("http://127.0.0.1:" + ports[socketName] + "/" + kind, { method: "POST", body, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      let parsed;
      try { parsed = text.length === 0 ? null : JSON.parse(text); } catch (error) { parsed = { parse_error: String(error), raw: text }; }
      return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
    });
  })), services));
}
const first = await serveOnce("publish");
if (first.status !== 200 || !first.body?.outcome?.journal?.journalId) throw new Error("publish response missing persisted journal: " + JSON.stringify(first));
const second = await serveOnce("get", first.body.outcome.journal.journalId);
console.log(JSON.stringify({ first, second }));
`;
  try {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: { ...process.env, GFY_PUBLICATION_FIXTURE: fixture }, encoding: "utf8", timeout: 45_000 })) as WorkerdProbeResult;
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
}

void pathToFileURL;
void PublicationConflictError;
void PublicationStorageError;
