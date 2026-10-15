import { Effect } from "effect";

import { ActionsStorageError, errorMessage } from "./errors.js";

export interface ActionsStorageEnv {
  readonly GFY_ACTIONS_SQLITE_BUCKET?: R2Bucket;
  readonly GFY_ACTIONS_STORAGE_TOKEN?: string;
  readonly GFY_ACTIONS_INTERNAL_STORAGE_SECRET?: string;
  readonly GFY_ACTIONS_STORAGE_GENERATION?: string;
  readonly GFY_ACTIONS_STORAGE_POINTER_KEY?: string;
  readonly GFY_ACTIONS_STORAGE_MAX_BYTES?: string;
}

export interface SnapshotPointer {
  readonly generation: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly key: string;
  readonly created_at: string;
}

export interface ActionsStoragePointerPort {
  read(generation: string): Promise<{ readonly pointer: SnapshotPointer | null; readonly version: string | null }>;
  commit(input: { readonly generation: string; readonly pointer: SnapshotPointer; readonly expected_version: string | null }): Promise<{ readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: "stale" }>;
}

const storagePrefix = "/__internal/actions-github/storage";
const maxDefaultBytes = 64 * 1024 * 1024;
const sqliteHeader = new TextEncoder().encode("SQLite format 3\0");

class SnapshotStreamError extends Error {
  constructor(readonly code: "snapshot_not_sqlite" | "snapshot_too_large", readonly status: 400 | 413) {
    super(code);
  }
}

export function handleActionsStorageEffect(request: Request, env: ActionsStorageEnv, pointerPort?: ActionsStoragePointerPort, now: () => Date = () => new Date()): Effect.Effect<Response | undefined, ActionsStorageError> {
  return Effect.gen(function*() {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(storagePrefix + "/")) return undefined;
    const route = url.pathname.slice(storagePrefix.length);
    if (!["/sqlite/latest", "/sqlite/backups", "/health"].includes(route)) return json({ error: "not_found" }, 404);
    const auth = authenticateStorage(request, env);
    if (auth) return auth;
    const generation = yield* Effect.try({
      try: () => requireGeneration(env),
      catch: storageFailure
    });
    const suppliedGeneration = url.searchParams.get("generation");
    const headerGeneration = request.headers.get("x-gfy-actions-generation");
    if (suppliedGeneration !== generation || (headerGeneration !== null && headerGeneration !== generation)) return json({ error: "generation_mismatch" }, 409);
    const bucket = env.GFY_ACTIONS_SQLITE_BUCKET;
    if (!bucket) return json({ error: "storage_unavailable" }, 503);
    if (!pointerPort) return json({ error: "pointer_unavailable" }, 503);
    const pointer = pointerPort;
    if (request.method === "GET" && route === "/sqlite/latest") return yield* getLatest(bucket, pointer, generation);
    if (request.method === "POST" && route === "/sqlite/backups") return yield* putBackup(request, bucket, pointer, env, generation, now);
    if (request.method === "GET" && route === "/health") return yield* storageHealth(pointer, generation);
    return json({ error: "method_not_allowed" }, 405);
  });
}

export function handleActionsStorage(request: Request, env: ActionsStorageEnv, pointerPort?: ActionsStoragePointerPort, now: () => Date = () => new Date()): Promise<Response | undefined> {
  return Effect.runPromise(handleActionsStorageEffect(request, env, pointerPort, now));
}

function getLatest(bucket: R2Bucket, pointerPort: ActionsStoragePointerPort, generation: string): Effect.Effect<Response, ActionsStorageError> {
  return Effect.gen(function*() {
    const current = yield* readPointer(pointerPort, generation);
    if (!current) return json({ error: "pointer_unavailable" }, 503);
    const headers = pointerVersionHeaders(current.version);
    headers.set("x-gfy-actions-generation", generation);
    if (!current.pointer) return new Response(null, { status: 204, headers });
    const pointer = current.pointer;
    if (pointer.generation !== generation) return json({ error: "generation_mismatch" }, 409);
    const object = yield* getObject(bucket, pointer.key);
    if (!object) return json({ error: "snapshot_missing" }, 503);
    if (!objectMatchesPointer(object, pointer)) return json({ error: "snapshot_corrupt" }, 503);
    const body = yield* verifiedSqliteBodyEffect(object);
    if (!body) return json({ error: "snapshot_corrupt" }, 503);
    headers.set("content-type", "application/octet-stream");
    headers.set("x-gfy-actions-generation", generation);
    headers.set("x-gfy-actions-sha256", pointer.sha256);
    headers.set("content-length", String(pointer.bytes));
    return new Response(body, { status: 200, headers });
  });
}

function putBackup(request: Request, bucket: R2Bucket, pointerPort: ActionsStoragePointerPort, env: ActionsStorageEnv, generation: string, now: () => Date): Effect.Effect<Response, ActionsStorageError> {
  return Effect.gen(function*() {
    const expected = request.headers.get("x-gfy-actions-sha256");
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return json({ error: "sha256_required" }, 400);
    const current = yield* readPointer(pointerPort, generation);
    if (!current) return json({ error: "pointer_unavailable" }, 503);
    const expectedVersion = request.headers.get("x-gfy-actions-pointer-version");
    if ((expectedVersion ?? null) !== current.version) return json({ error: "pointer_version_stale" }, 409);
    const declaredLength = request.headers.get("content-length");
    if (!declaredLength || !/^(0|[1-9][0-9]*)$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
      return json({ error: "content_length_required" }, 411);
    }
    const length = Number(declaredLength);
    const limit = maxBytes(env);
    if (length > limit) return json({ error: "snapshot_too_large" }, 413);
    const bounded = boundedSqliteStream(request.body, limit);
    const state = bounded.state;
    const stream = typeof FixedLengthStream === "function"
      ? bounded.stream.pipeThrough(new FixedLengthStream(length))
      : bounded.stream;
    const objectKey = `actions-github/sqlite/${generation}/${expected}.db`;
    return yield* Effect.gen(function*() {
      yield* putR2Object(bucket, objectKey, stream, { generation, sha256: expected });
      if (state.bytes !== length) return json({ error: "snapshot_length_mismatch" }, 400);
      const pointer: SnapshotPointer = { generation, sha256: expected, bytes: state.bytes, key: objectKey, created_at: now().toISOString() };
      const committed = yield* commitPointer(pointerPort, { generation, pointer, expected_version: current.version });
      if (!committed.ok) return json({ error: "pointer_version_stale" }, 409);
      return new Response(null, { status: 201, headers: { "x-gfy-actions-generation": generation, "x-gfy-actions-sha256": expected, "x-gfy-actions-pointer-version": committed.version } });
    }).pipe(Effect.catch((cause) => {
      if (cause instanceof SnapshotStreamError) return Effect.succeed(json({ error: cause.code }, cause.status));
      if (isChecksumMismatch(cause)) return Effect.succeed(json({ error: "sha256_mismatch" }, 400));
      return Effect.succeed(json({ error: "persist_unavailable" }, 503));
    }));
  });
}

function storageHealth(pointerPort: ActionsStoragePointerPort, generation: string): Effect.Effect<Response, never> {
  return Effect.gen(function*() {
    const current = yield* readPointer(pointerPort, generation);
    if (!current) return json({ error: "pointer_unavailable" }, 503);
    return json({ generation, pointer_version: current.version, latest: current.pointer ? { sha256: current.pointer.sha256, bytes: current.pointer.bytes, created_at: current.pointer.created_at } : null }, 200);
  });
}

function r2PointerPort(bucket: R2Bucket, env: ActionsStorageEnv): ActionsStoragePointerPort {
  return {
    async read(generation) {
      const object = await bucket.get(pointerKey(env, generation));
      if (!object) return { pointer: null, version: null };
      const text = await object.text();
      const pointer = parsePointer(text);
      return { pointer, version: pointer.sha256 };
    },
    async commit(input) {
      await bucket.put(pointerKey(env, input.generation), JSON.stringify(input.pointer), { httpMetadata: { contentType: "application/json" } });
      return { ok: true, version: input.pointer.sha256 };
    }
  };
}

function parsePointer(text: string): SnapshotPointer {
  const parsed = JSON.parse(text) as SnapshotPointer;
  if (typeof parsed.generation !== "string" || typeof parsed.sha256 !== "string" || typeof parsed.key !== "string" || typeof parsed.created_at !== "string" || !Number.isSafeInteger(parsed.bytes)) throw new Error("pointer corrupt");
  if (!/^[0-9a-f]{64}$/.test(parsed.sha256) || parsed.bytes < sqliteHeader.length) throw new Error("pointer corrupt");
  return parsed;
}

function readPointer(pointerPort: ActionsStoragePointerPort, generation: string): Effect.Effect<{ readonly pointer: SnapshotPointer | null; readonly version: string | null } | null, never> {
  return Effect.tryPromise({
    try: () => pointerPort.read(generation),
    catch: (cause) => cause
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function commitPointer(pointerPort: ActionsStoragePointerPort, input: { readonly generation: string; readonly pointer: SnapshotPointer; readonly expected_version: string | null }): Effect.Effect<{ readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: "stale" }, unknown> {
  return Effect.tryPromise({
    try: () => pointerPort.commit(input),
    catch: (cause) => cause
  });
}

function getObject(bucket: R2Bucket, key: string): Effect.Effect<R2ObjectBody | null, ActionsStorageError> {
  return Effect.tryPromise({
    try: () => bucket.get(key),
    catch: storageFailure
  });
}

function boundedSqliteStream(body: ReadableStream<Uint8Array> | null, limit: number): { readonly stream: ReadableStream<Uint8Array>; readonly state: { bytes: number } } {
  const state = { bytes: 0 };
  const header = new Uint8Array(sqliteHeader.length);
  let headerBytes = 0;
  const stream = (body ?? emptyStream()).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      state.bytes += chunk.byteLength;
      if (state.bytes > limit) throw new SnapshotStreamError("snapshot_too_large", 413);
      if (headerBytes < sqliteHeader.length) {
        const take = Math.min(sqliteHeader.length - headerBytes, chunk.byteLength);
        header.set(chunk.subarray(0, take), headerBytes);
        headerBytes += take;
        if (headerBytes === sqliteHeader.length && !isSqlite(header)) throw new SnapshotStreamError("snapshot_not_sqlite", 400);
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (headerBytes < sqliteHeader.length || !isSqlite(header)) throw new SnapshotStreamError("snapshot_not_sqlite", 400);
    }
  }));
  return { stream, state };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
}

function putR2Object(bucket: R2Bucket, key: string, value: ReadableStream<Uint8Array>, metadata: { readonly generation: string; readonly sha256: string }): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await bucket.put(key, value, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: metadata,
        sha256: metadata.sha256
      });
    },
    catch: (cause) => cause
  });
}

function objectMatchesPointer(object: R2ObjectBody, pointer: SnapshotPointer): boolean {
  const size = (object as { readonly size?: unknown }).size;
  if (size !== pointer.bytes) return false;
  return checksumHex(object.checksums.sha256) === pointer.sha256;
}

function verifiedSqliteBodyEffect(object: R2ObjectBody): Effect.Effect<ReadableStream<Uint8Array> | null, ActionsStorageError> {
  return Effect.gen(function* () {
    if (!object.body) return null;
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    const header = new Uint8Array(sqliteHeader.length);
    let offset = 0;
    let handedOff = false;
    let released = false;
    const release = () => {
      if (!released) { released = true; reader.releaseLock(); }
    };
    return yield* Effect.gen(function* () {
      while (offset < sqliteHeader.length) {
        const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: storageFailure });
        if (chunk.done) return null;
        chunks.push(chunk.value);
        const take = Math.min(sqliteHeader.length - offset, chunk.value.byteLength);
        header.set(chunk.value.subarray(0, take), offset);
        offset += take;
      }
      if (!isSqlite(header)) return null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { release(); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) { release(); controller.error(error); }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); } finally { release(); }
        }
      });
      handedOff = true;
      return stream;
    }).pipe(Effect.ensuring(Effect.gen(function* () {
      if (!handedOff) {
        yield* Effect.tryPromise({ try: () => reader.cancel(), catch: storageFailure }).pipe(
          Effect.match({ onFailure: () => undefined, onSuccess: () => undefined })
        );
        yield* Effect.sync(release);
      }
    })));
  });
}

function isChecksumMismatch(cause: unknown): boolean {
  return cause instanceof Error && /checksum/i.test(`${cause.name} ${cause.message}`);
}

function storageFailure(cause: unknown): ActionsStorageError {
  return cause instanceof ActionsStorageError ? cause : new ActionsStorageError({ message: errorMessage(cause, "actions storage failed"), cause });
}

function authenticateStorage(request: Request, env: ActionsStorageEnv): Response | null {
  const token = env.GFY_ACTIONS_INTERNAL_STORAGE_SECRET || env.GFY_ACTIONS_STORAGE_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  return null;
}
function requireGeneration(env: ActionsStorageEnv): string {
  const generation = env.GFY_ACTIONS_STORAGE_GENERATION;
  if (!generation || !/^[A-Za-z0-9._:-]{1,128}$/.test(generation)) throw new Error("actions storage generation invalid");
  return generation;
}
function pointerKey(env: ActionsStorageEnv, generation: string): string { return env.GFY_ACTIONS_STORAGE_POINTER_KEY || `actions-github/sqlite/${generation}/latest.json`; }
function pointerVersionHeaders(version: string | null): Headers {
  const headers = new Headers();
  if (version !== null) headers.set("x-gfy-actions-pointer-version", version);
  return headers;
}
function maxBytes(env: ActionsStorageEnv): number {
  const parsed = Number.parseInt(env.GFY_ACTIONS_STORAGE_MAX_BYTES || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maxDefaultBytes ? parsed : maxDefaultBytes;
}
function isSqlite(bytes: Uint8Array): boolean {
  if (bytes.byteLength < sqliteHeader.length) return false;
  for (let index = 0; index < sqliteHeader.length; index += 1) if (bytes[index] !== sqliteHeader[index]) return false;
  return true;
}
function checksumHex(value: unknown): string | null {
  if (typeof value === "string") return value.toLowerCase();
  if (value instanceof ArrayBuffer) return bytesHex(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return bytesHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return null;
}
function bytesHex(bytes: Uint8Array): string { return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
function json(value: unknown, status: number): Response { return Response.json(value, { status }); }
