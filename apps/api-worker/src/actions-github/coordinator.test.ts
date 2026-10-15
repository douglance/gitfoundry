import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  ActionsSnapshotStateError,
  makeActionsSnapshotCoordinator,
  type SnapshotStorage,
  type SnapshotTransaction
} from "./coordinator.js";
import type { SnapshotPointer } from "./storage.js";

function storage() {
  const values = new Map<string, unknown>();
  let queue = Promise.resolve();
  const transaction: SnapshotTransaction = {
    get: async <A>(key: string) => values.get(key) as A | undefined,
    put: async <A>(key: string, value: A) => { values.set(key, value); }
  };
  const port: SnapshotStorage = {
    get: transaction.get,
    transaction: <A>(body: (port: SnapshotTransaction) => Promise<A>) => {
      const result = queue.then(() => body(transaction));
      queue = result.then(() => undefined, () => undefined);
      return result;
    }
  };
  return { port, values };
}

function pointer(digit = "a"): SnapshotPointer {
  const sha256 = digit.repeat(64);
  return {
    generation: "repo-owner",
    sha256,
    bytes: 4096,
    key: `actions-github/sqlite/repo-owner/${sha256}.db`,
    created_at: "2026-10-09T20:00:00.000Z"
  };
}

describe("durable Actions snapshot coordinator", () => {
  it("keeps exactly one winner when concurrent writers share a version", async () => {
    const memory = storage();
    let serial = 0;
    const coordinator = makeActionsSnapshotCoordinator(memory.port, "repo-owner", () => `version-${++serial}`);
    expect(await Effect.runPromise(coordinator.read("repo-owner"))).toEqual({ pointer: null, version: null });
    const results = await Promise.all(["a", "b"].map(digit => Effect.runPromise(coordinator.commit({
      generation: "repo-owner", pointer: pointer(digit), expected_version: null
    }))));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: "stale" }]);
    const current = await Effect.runPromise(coordinator.read("repo-owner"));
    expect(current.version).toBe("version-1");
    expect(current.pointer?.sha256).toBe("a".repeat(64));
  });

  it("rejects an old version after snapshot contents return to their prior digest", async () => {
    const memory = storage();
    let serial = 0;
    const coordinator = makeActionsSnapshotCoordinator(memory.port, "repo-owner", () => `version-${++serial}`);
    const commit = (digit: string, expected_version: string | null) => Effect.runPromise(coordinator.commit({
      generation: "repo-owner", pointer: pointer(digit), expected_version
    }));
    expect(await commit("a", null)).toEqual({ ok: true, version: "version-1" });
    expect(await commit("b", "version-1")).toEqual({ ok: true, version: "version-2" });
    expect(await commit("a", "version-2")).toEqual({ ok: true, version: "version-3" });
    expect(await commit("c", "version-1")).toEqual({ ok: false, reason: "stale" });
    expect((await Effect.runPromise(coordinator.read("repo-owner"))).version).toBe("version-3");
  });

  it("fails closed on a corrupt persisted pointer and mismatched instance generation", async () => {
    const memory = storage();
    memory.values.set("actions-github/snapshot", { pointer: { ...pointer(), key: "outside-instance.db" }, version: "one" });
    const coordinator = makeActionsSnapshotCoordinator(memory.port, "repo-owner");
    await expect(Effect.runPromise(coordinator.read("repo-owner"))).rejects.toMatchObject({
      _tag: "ActionsSnapshotStateError", operation: "read", reason: "corrupt"
    });
    await expect(Effect.runPromise(coordinator.read("other-repository"))).rejects.toMatchObject({
      _tag: "ActionsSnapshotStateError", reason: "generation_mismatch"
    });
  });

  it("reports typed storage failure instead of treating it as an empty registry", async () => {
    const coordinator = makeActionsSnapshotCoordinator({
      get: async () => { throw new Error("unavailable"); },
      transaction: async () => { throw new Error("unavailable"); }
    }, "repo-owner");
    const result = await Effect.runPromise(Effect.result(coordinator.read("repo-owner")));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ActionsSnapshotStateError);
  });
});
