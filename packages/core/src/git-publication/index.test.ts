import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { PublicationConflictError, PublicationDeniedError, PublicationInputError, PublicationProviderError, makeFakePolicyPort, makeFakeProviderPort, makeInMemoryPublicationJournal, makePublicationCoordinator, makePublicationScope, type GitPublicationIntent, type ProviderPublicationReceipt } from "./index.js";

const oldSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const newSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const otherSha = "cccccccccccccccccccccccccccccccccccccccc";

function intent(overrides: Partial<GitPublicationIntent> = {}): GitPublicationIntent {
  return { tenantId: "tenant-a", repositoryId: "repo-a", principalId: "principal-a", operationId: "repo.ref-update", idempotencyKey: "idem-a", expectedVersion: 7, policyEpoch: 3, leaseFence: "lease-7", atomic: false, eligibilityId: "eligibility-a", reason: "publish tested ref", changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: newSha, force: false }], ...overrides };
}

function timeoutReceipt(input: GitPublicationIntent = intent()): ProviderPublicationReceipt {
  return { receiptId: "publish-timeout", providerRequestId: "provider-timeout", submittedAt: "2026-10-08T00:00:00.000Z", capability: "old-oid-cas", tenantId: input.tenantId, repositoryId: input.repositoryId, principalId: input.principalId, operationId: input.operationId, idempotencyKey: input.idempotencyKey, policyEpoch: input.policyEpoch, leaseFence: input.leaseFence, refs: input.changes };
}

describe("protected Git publication coordinator", () => {

  it("recovers accepted history after access revocation without policy checks or another provider effect", async () => {
    const journal = makeInMemoryPublicationJournal();
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const accepted = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs }) }).publish(intent()));
    refs.set("refs/heads/main", otherSha);
    const calls: string[] = [];
    const policyCalls: GitPublicationIntent[] = [];
    const recovered = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort({ deny: true, calls: policyCalls }), provider: makeFakeProviderPort({ refs, calls }) }).recover({ tenantId: "tenant-a", repositoryId: "repo-a", journalId: accepted.journal.journalId }));
    expect(recovered).toMatchObject({ state: "accepted", replayed: true, journal: accepted.journal });
    expect(refs.get("refs/heads/main")).toBe(otherSha);
    expect(calls).toEqual([]);
    expect(policyCalls).toEqual([]);
  });

  it("returns rejected history and leaves prepared work untouched during trusted recovery", async () => {
    for (const state of ["prepared", "rejected"] as const) {
      const journal = makeInMemoryPublicationJournal();
      const request = intent();
      const prepared = await Effect.runPromise(journal.reservePrepared(request, await Effect.runPromise(makePublicationScope(request)), "2026-10-08T00:00:00.000Z"));
      const record = state === "prepared" ? prepared.record : await Effect.runPromise(journal.finish(prepared.record.journalId, { state: "prepared", attempt: 0 }, "rejected", null, null, "policy_denied", "2026-10-08T00:00:01.000Z"));
      const calls: string[] = [];
      const policyCalls: GitPublicationIntent[] = [];
      const recovered = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort({ deny: true, calls: policyCalls }), provider: makeFakeProviderPort({ refs: new Map(), calls }) }).recover({ tenantId: request.tenantId, repositoryId: request.repositoryId, journalId: record.journalId }));
      expect(recovered).toMatchObject({ state, replayed: true, journal: record });
      expect(calls).toEqual([]);
      expect(policyCalls).toEqual([]);
    }
  });

  it("reconciles a recorded handoff after policy revocation using observation only", async () => {
    const journal = makeInMemoryPublicationJournal();
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const unknown = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs, failPublish: new PublicationProviderError({ kind: "timeout_after_handoff", detail: "accepted but reply was lost", receipt: timeoutReceipt() }) }) }).publish(intent()));
    refs.set("refs/heads/main", newSha);
    const calls: string[] = [];
    const policyCalls: GitPublicationIntent[] = [];
    const recovered = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort({ deny: true, calls: policyCalls }), provider: makeFakeProviderPort({ refs, calls }) }).recover({ tenantId: "tenant-a", repositoryId: "repo-a", journalId: unknown.journal.journalId }));
    expect(recovered).toMatchObject({ state: "accepted", replayed: true, journal: { attempt: 1 } });
    expect(calls).toEqual(["observe"]);
    expect(policyCalls).toEqual([]);
  });

  it.each(["publishing", "unknown"] as const)("keeps %s fenced when matching readback has no bound provider receipt", async (state) => {
    const journal = makeInMemoryPublicationJournal();
    const request = intent();
    const prepared = await Effect.runPromise(journal.reservePrepared(request, await Effect.runPromise(makePublicationScope(request)), "2026-10-08T00:00:00.000Z"));
    const policy = await Effect.runPromise(makeFakePolicyPort().revalidate(request));
    const publishing = await Effect.runPromise(journal.markPublishing(prepared.record.journalId, { state: "prepared", attempt: 0 }, policy, "2026-10-08T00:00:01.000Z"));
    if (state === "unknown") await Effect.runPromise(journal.finish(publishing.journalId, { state: "publishing", attempt: 1 }, "unknown", null, null, "reply_lost", "2026-10-08T00:00:02.000Z"));
    const calls: string[] = [];
    const policyCalls: GitPublicationIntent[] = [];
    const recovered = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort({ deny: true, calls: policyCalls }), provider: makeFakeProviderPort({ refs: new Map([["refs/heads/main", newSha]]), calls }) }).recover({ tenantId: "tenant-a", repositoryId: "repo-a", journalId: publishing.journalId }));
    expect(recovered).toMatchObject({ state: "unknown", journal: { reasonCode: "missing_provider_commit_receipt", attempt: 1 } });
    expect(calls).toEqual(["observe"]);
    expect(policyCalls).toEqual([]);
    const competing = intent({ idempotencyKey: "competing", changes: [{ ref: "refs/heads/main", old_sha: newSha, new_sha: otherSha, force: false }] });
    await expect(Effect.runPromise(journal.reservePrepared(competing, await Effect.runPromise(makePublicationScope(competing)), "2026-10-08T00:00:03.000Z"))).rejects.toBeInstanceOf(PublicationConflictError);
  });

  it.each([{ tenantId: "tenant-b", repositoryId: "repo-a" }, { tenantId: "tenant-a", repositoryId: "repo-b" }])("refuses recovery from a foreign scope %j before provider effects", async (scope) => {
    const journal = makeInMemoryPublicationJournal();
    const record = (await Effect.runPromise(journal.reservePrepared(intent(), await Effect.runPromise(makePublicationScope(intent())), "2026-10-08T00:00:00.000Z"))).record;
    const calls: string[] = [];
    const coordinator = makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map(), calls }) });
    await expect(Effect.runPromise(coordinator.recover({ ...scope, journalId: record.journalId }))).rejects.toBeInstanceOf(PublicationConflictError);
    expect(calls).toEqual([]);
    expect(journal.records()).toEqual([record]);
  });

  it.each(["requestDigest", "journalId"] as const)("rejects a corrupted stored %s before recovery effects", async (field) => {
    const journal = makeInMemoryPublicationJournal();
    const record = (await Effect.runPromise(journal.reservePrepared(intent(), await Effect.runPromise(makePublicationScope(intent())), "2026-10-08T00:00:00.000Z"))).record;
    const corrupted = { ...record, [field]: field === "requestDigest" ? "sha256:" + "0".repeat(64) : "gitpub-" + "0".repeat(32) };
    const calls: string[] = [];
    const coordinator = makePublicationCoordinator({ journal: { ...journal, get: () => Effect.succeed(corrupted) }, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map(), calls }) });
    await expect(Effect.runPromise(coordinator.recover({ tenantId: "tenant-a", repositoryId: "repo-a", journalId: record.journalId }))).rejects.toBeInstanceOf(PublicationConflictError);
    expect(calls).toEqual([]);
  });

  it("rejects an accepted journal whose provider evidence was substituted", async () => {
    const journal = makeInMemoryPublicationJournal();
    const accepted = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map([["refs/heads/main", oldSha]]) }) }).publish(intent()));
    const corrupted = { ...accepted.journal, providerReceipt: { ...timeoutReceipt(), repositoryId: "repo-b" } };
    const calls: string[] = [];
    await expect(Effect.runPromise(makePublicationCoordinator({ journal: { ...journal, get: () => Effect.succeed(corrupted) }, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map(), calls }) }).recover({ tenantId: "tenant-a", repositoryId: "repo-a", journalId: accepted.journal.journalId }))).rejects.toBeInstanceOf(PublicationConflictError);
    expect(calls).toEqual([]);
  });

  it("validates recovery input before journal access and never reserves missing work", async () => {
    const journal = makeInMemoryPublicationJournal();
    const gets: string[] = [];
    const calls: string[] = [];
    const coordinator = makePublicationCoordinator({ journal: { ...journal, get: (id) => { gets.push(id); return journal.get(id); } }, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map(), calls }) });
    for (const scope of [
      { tenantId: "", repositoryId: "repo-a", journalId: "gitpub-" + "1".repeat(32) },
      { tenantId: "tenant-a", repositoryId: "", journalId: "gitpub-" + "1".repeat(32) },
      { tenantId: "tenant-a", repositoryId: "repo-a", journalId: "not-a-journal" }
    ]) await expect(Effect.runPromise(coordinator.recover(scope))).rejects.toBeInstanceOf(PublicationInputError);
    expect(gets).toEqual([]);
    await expect(Effect.runPromise(coordinator.recover({ tenantId: "tenant-a", repositoryId: "repo-a", journalId: "gitpub-" + "1".repeat(32) }))).rejects.toBeInstanceOf(PublicationConflictError);
    expect(journal.records()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/.hidden", "refs/heads/a/.hidden",
    "refs/heads/a.", "refs/heads/a//b", "refs/heads/a/", "refs/heads/a@{b",
    "refs/heads/a~b", "refs/heads/a^b", "refs/heads/a:b", "refs/heads/a?b",
    "refs/heads/a*b", "refs/heads/a[b", "refs/heads/a\\\\b", "refs/heads/a\u007fb"
  ])("rejects invalid Git ref %s before journal or provider effects", async (ref) => {
    const calls: string[] = [];
    const journal = makeInMemoryPublicationJournal();
    const coordinator = makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map(), calls }) });
    await expect(Effect.runPromise(coordinator.publish(intent({ changes: [{ ref, old_sha: oldSha, new_sha: newSha, force: false }] })))).rejects.toBeInstanceOf(PublicationInputError);
    expect(journal.records()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each(["refs/heads/a.b", "refs/heads/a.LOCK", "refs/heads/feature/topic", "refs/tags/v1.0", "refs/heads/日本語"])("accepts valid Git ref %s", async (ref) => {
    const refs = new Map([[ref, oldSha]]);
    const result = await Effect.runPromise(makePublicationCoordinator({ journal: makeInMemoryPublicationJournal(), policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs }) }).publish(intent({ changes: [{ ref, old_sha: oldSha, new_sha: newSha, force: false }] })));
    expect(result.state).toBe("accepted");
    expect(refs.get(ref)).toBe(newSha);
  });

  it("rejects ref path collisions and zero object IDs before journal or provider effects", async () => {
    for (const changes of [
      [{ ref: "refs/heads/topic", old_sha: oldSha, new_sha: newSha, force: false }, { ref: "refs/heads/topic/child", old_sha: null, new_sha: newSha, force: false }],
      [{ ref: "refs/heads/main", old_sha: "0".repeat(40), new_sha: newSha, force: false }],
      [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: "0".repeat(40), force: false }]
    ]) {
      const calls: string[] = [];
      const journal = makeInMemoryPublicationJournal();
      await expect(Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map(), calls }) }).publish(intent({ changes })))).rejects.toBeInstanceOf(PublicationInputError);
      expect(journal.records()).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it("routes input validation and journal conflicts through Effect failure values", async () => {
    const badOperation = await Effect.runPromise(makePublicationScope(intent({ operationId: "wrong.operation" as "repo.ref-update" })).pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag }))));
    expect(badOperation).toEqual({ caught: true, tag: "PublicationInputError" });

    const journal = makeInMemoryPublicationJournal();
    const first = intent();
    const changed = intent({ changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: otherSha, force: false }] });
    await Effect.runPromise(journal.reservePrepared(first, await Effect.runPromise(makePublicationScope(first)), "2026-10-08T00:00:00.000Z"));
    const conflict = await Effect.runPromise(journal.reservePrepared(changed, await Effect.runPromise(makePublicationScope(changed)), "2026-10-08T00:00:01.000Z").pipe(Effect.catch((error) => Effect.succeed({ caught: true, tag: (error as { readonly _tag?: string })._tag }))));
    expect(conflict).toEqual({ caught: true, tag: "PublicationConflictError" });
  });

  it("revalidates policy immediately before the provider CAS publication and returns source-shaped operation output", async () => {
    const calls: string[] = [];
    const policyCalls: GitPublicationIntent[] = [];
    const journal = makeInMemoryPublicationJournal();
    const coordinator = makePublicationCoordinator({ journal, policy: { revalidate: (request) => Effect.sync(() => { calls.push("policy"); policyCalls.push(request); return { receiptId: "policy-a", tenantId: request.tenantId, repositoryId: request.repositoryId, principalId: request.principalId, capability: "repository.write", policyEpoch: request.policyEpoch, leaseFence: request.leaseFence, observedAt: "2026-10-08T00:00:00.000Z" }; }) }, provider: makeFakeProviderPort({ refs: new Map([["refs/heads/main", oldSha]]), calls }) });
    const result = await Effect.runPromise(coordinator.publish(intent()));
    expect(calls).toEqual(["observe", "policy", "publish", "observe"]);
    expect(policyCalls).toHaveLength(1);
    expect(result.state).toBe("accepted");
    expect(result.operation).toMatchObject({ tenant_id: "tenant-a", id: result.journal.journalId, status: "succeeded", kind: "repo.ref-update" });
    expect(result.operation.result).toMatchObject({ repository_id: "repo-a", atomic: false, changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: newSha, outcome: "accepted", reason_code: null }] });
    expect(result.journal.providerReceipt).toMatchObject({ capability: "old-oid-cas", tenantId: "tenant-a", repositoryId: "repo-a", principalId: "principal-a", leaseFence: "lease-7" });
  });

  it("revalidates authorization before replaying a terminal receipt", async () => {
    const policyCalls: GitPublicationIntent[] = [];
    const journal = makeInMemoryPublicationJournal();
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    await expect(Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort({ calls: policyCalls }), provider: makeFakeProviderPort({ refs }) }).publish(intent()))).resolves.toMatchObject({ state: "accepted" });
    await expect(Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort({ deny: true, calls: policyCalls }), provider: makeFakeProviderPort({ refs }) }).publish(intent()))).rejects.toBeInstanceOf(PublicationDeniedError);
    expect(policyCalls).toHaveLength(2);
  });

  it("replays the same idempotency key and digest without double publishing, but rejects ambiguous key reuse", async () => {
    const calls: string[] = [];
    const journal = makeInMemoryPublicationJournal();
    const coordinator = makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map([["refs/heads/main", oldSha]]), calls }) });
    const first = await Effect.runPromise(coordinator.publish(intent()));
    const replay = await Effect.runPromise(coordinator.publish(intent()));
    expect(first.state).toBe("accepted");
    expect(replay.state).toBe("accepted");
    expect(replay.replayed).toBe(true);
    expect(calls.filter((call) => call === "publish")).toHaveLength(1);
    await expect(Effect.runPromise(coordinator.publish(intent({ changes: [{ ref: "refs/heads/main", old_sha: oldSha, new_sha: otherSha, force: false }] })))).rejects.toBeInstanceOf(PublicationConflictError);
  });

  it("rejects stale writers before releasing a provider write and keeps the failed journal recoverable", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(makePublicationCoordinator({ journal: makeInMemoryPublicationJournal(), policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map([["refs/heads/main", otherSha]]), calls }) }).publish(intent()));
    expect(result.state).toBe("rejected");
    expect(result.operation.status).toBe("failed");
    expect(result.journal.reasonCode).toBe("stale_ref");
    expect(calls).toEqual(["observe"]);
  });

  it("uses provider-side old-OID CAS so a race after preflight rejects without overwriting the new tip", async () => {
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const result = await Effect.runPromise(makePublicationCoordinator({ journal: makeInMemoryPublicationJournal(), policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs, beforePublish: () => refs.set("refs/heads/main", otherSha) }) }).publish(intent()));
    expect(result.state).toBe("rejected");
    expect(result.journal.reasonCode).toBe("provider_cas_mismatch");
    expect(refs.get("refs/heads/main")).toBe(otherSha);
  });

  it("fails closed for unsupported providers, mismatched receipts, denied policy, and protected bypass inputs", async () => {
    const unsupported = new PublicationProviderError({ kind: "unsupported", detail: "provider has no qualified CAS proof" });
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    await expect(Effect.runPromise(makePublicationCoordinator({ journal: makeInMemoryPublicationJournal(), policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs }) }).publish(intent({ changes: [{ ref: "refs/gfy/internal", old_sha: oldSha, new_sha: newSha, force: false }] })))).rejects.toBeInstanceOf(PublicationInputError);
    const unsupportedResult = await Effect.runPromise(makePublicationCoordinator({ journal: makeInMemoryPublicationJournal(), policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map([["refs/heads/main", oldSha]]), failPublish: unsupported }) }).publish(intent()));
    expect(unsupportedResult).toMatchObject({ state: "rejected", journal: { reasonCode: "provider_capability_unsupported" } });
    const mismatchResult = await Effect.runPromise(makePublicationCoordinator({ journal: makeInMemoryPublicationJournal(), policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs: new Map([["refs/heads/main", oldSha]]), receipt: (_request, receipt) => ({ ...receipt, leaseFence: "wrong-fence" }) }) }).publish(intent()));
    expect(mismatchResult).toMatchObject({ state: "unknown", journal: { reasonCode: "provider_receipt_mismatch" } });
    const deniedJournal = makeInMemoryPublicationJournal();
    await expect(Effect.runPromise(makePublicationCoordinator({ journal: deniedJournal, policy: makeFakePolicyPort({ deny: true }), provider: makeFakeProviderPort({ refs: new Map([["refs/heads/main", oldSha]]) }) }).publish(intent()))).rejects.toBeInstanceOf(PublicationDeniedError);
    expect(deniedJournal.records()[0]).toMatchObject({ state: "rejected", reasonCode: "policy_denied" });
  });

  it("records unknown after a handed-off timeout and later reconciles only with an exact provider commit receipt", async () => {
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const calls: string[] = [];
    const journal = makeInMemoryPublicationJournal();
    const unknown = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs, calls, failPublish: new PublicationProviderError({ kind: "timeout_after_handoff", detail: "helper timed out after submitting", receipt: timeoutReceipt() }) }) }).publish(intent()));
    expect(unknown).toMatchObject({ state: "unknown", journal: { reasonCode: "provider_timeout_after_handoff" } });
    refs.set("refs/heads/main", newSha);
    const recovered = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs, calls }) }).publish(intent()));
    expect(recovered.replayed).toBe(true);
    expect(recovered.state).toBe("accepted");
    expect(calls.filter((call) => call === "publish")).toHaveLength(1);
  });

  it("does not fabricate acceptance from matching readback when the journal lacks an exact provider commit receipt", async () => {
    const refs = new Map<string, string | null>([["refs/heads/main", oldSha]]);
    const journal = makeInMemoryPublicationJournal();
    const unknown = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs, failPublish: new PublicationProviderError({ kind: "timeout_after_handoff", detail: "lost after handoff without receipt" }) }) }).publish(intent({ idempotencyKey: "idem-no-receipt" })));
    expect(unknown.state).toBe("unknown");
    refs.set("refs/heads/main", newSha);
    const replay = await Effect.runPromise(makePublicationCoordinator({ journal, policy: makeFakePolicyPort(), provider: makeFakeProviderPort({ refs }) }).publish(intent({ idempotencyKey: "idem-no-receipt" })));
    expect(replay.state).toBe("unknown");
    expect(replay.journal.reasonCode).toBe("missing_provider_commit_receipt");
  });
});
