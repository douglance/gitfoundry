import { Context, Data, Effect, Layer } from "effect";
import type { ActionsStoragePointerPort, SnapshotPointer } from "./storage.js";

export interface SnapshotState {
  readonly pointer: SnapshotPointer | null;
  readonly version: string | null;
}

export interface SnapshotCommit {
  readonly generation: string;
  readonly pointer: SnapshotPointer;
  readonly expected_version: string | null;
}

export type SnapshotCommitResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: "stale" };

export class ActionsSnapshotStateError extends Data.TaggedError("ActionsSnapshotStateError")<{
  readonly operation: "read" | "commit";
  readonly reason: "generation_mismatch" | "corrupt" | "unavailable";
}> {}

export interface SnapshotTransaction {
  get<A>(key: string): Promise<A | undefined>;
  put<A>(key: string, value: A): Promise<void>;
}

export interface SnapshotStorage {
  get<A>(key: string): Promise<A | undefined>;
  transaction<A>(body: (transaction: SnapshotTransaction) => Promise<A>): Promise<A>;
}

export interface ActionsSnapshotCoordinator {
  readonly read: (generation: string) => Effect.Effect<SnapshotState, ActionsSnapshotStateError>;
  readonly commit: (input: SnapshotCommit) => Effect.Effect<SnapshotCommitResult, ActionsSnapshotStateError>;
}

export const ActionsSnapshotCoordinator = Context.Service<ActionsSnapshotCoordinator>(
  "gitfoundry/ActionsSnapshotCoordinator"
);

const stateKey = "actions-github/snapshot";
const generationPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const digestPattern = /^[0-9a-f]{64}$/;

function validateState(value: unknown, generation: string): SnapshotState {
  if (value === undefined) return { pointer: null, version: null };
  if (!value || typeof value !== "object") throw new Error("invalid snapshot state");
  const current = value as SnapshotState;
  const pointer = current.pointer;
  if (!pointer || typeof current.version !== "string" || !current.version ||
      pointer.generation !== generation || !digestPattern.test(pointer.sha256) ||
      !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 16 ||
      pointer.key !== `actions-github/sqlite/${generation}/${pointer.sha256}.db` ||
      typeof pointer.created_at !== "string" || !Number.isFinite(Date.parse(pointer.created_at))) {
    throw new Error("invalid snapshot state");
  }
  return current;
}

export function makeActionsSnapshotCoordinator(
  storage: SnapshotStorage,
  generation: string,
  newVersion: () => string = () => crypto.randomUUID()
): ActionsSnapshotCoordinator {
  const validateGeneration = (supplied: string, operation: "read" | "commit") =>
    supplied === generation && generationPattern.test(generation)
      ? Effect.void
      : Effect.fail(new ActionsSnapshotStateError({ operation, reason: "generation_mismatch" }));

  const decode = (value: unknown, operation: "read" | "commit") => Effect.try({
    try: () => validateState(value, generation),
    catch: () => new ActionsSnapshotStateError({ operation, reason: "corrupt" })
  });

  const read = (supplied: string) => Effect.gen(function* () {
    yield* validateGeneration(supplied, "read");
    const value = yield* Effect.tryPromise({
      try: () => storage.get<unknown>(stateKey),
      catch: () => new ActionsSnapshotStateError({ operation: "read", reason: "unavailable" })
    });
    return yield* decode(value, "read");
  });

  const commit = (input: SnapshotCommit) => Effect.gen(function* () {
    yield* validateGeneration(input.generation, "commit");
    yield* decode({ pointer: input.pointer, version: "validation" }, "commit");
    return yield* Effect.tryPromise({
      try: () => storage.transaction(transaction => Effect.runPromise(Effect.gen(function* () {
        const value = yield* Effect.tryPromise({
          try: () => transaction.get<unknown>(stateKey),
          catch: () => new ActionsSnapshotStateError({ operation: "commit", reason: "unavailable" })
        });
        const current = yield* decode(value, "commit");
        if (current.version !== input.expected_version) return { ok: false, reason: "stale" } as const;
        const version = yield* Effect.try({
          try: () => {
            const next = newVersion();
            if (!next || next === current.version) throw new Error("snapshot version did not advance");
            return next;
          },
          catch: () => new ActionsSnapshotStateError({ operation: "commit", reason: "unavailable" })
        });
        yield* Effect.tryPromise({
          try: () => transaction.put(stateKey, { pointer: input.pointer, version }),
          catch: () => new ActionsSnapshotStateError({ operation: "commit", reason: "unavailable" })
        });
        return { ok: true, version } as const;
      }))),
      catch: error => error instanceof ActionsSnapshotStateError
        ? error
        : new ActionsSnapshotStateError({ operation: "commit", reason: "unavailable" })
    });
  }).pipe(Effect.uninterruptible);

  return { read, commit };
}

export const actionsSnapshotCoordinatorLayer = (
  storage: SnapshotStorage,
  generation: string
) => Layer.succeed(ActionsSnapshotCoordinator, makeActionsSnapshotCoordinator(storage, generation));

export function actionsSnapshotPointerPort(coordinator: ActionsSnapshotCoordinator): ActionsStoragePointerPort {
  return {
    read: generation => Effect.runPromise(coordinator.read(generation)),
    commit: input => Effect.runPromise(coordinator.commit(input))
  };
}
