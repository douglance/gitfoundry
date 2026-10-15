import { createHash } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { handleActionsStorage, handleActionsStorageEffect, type ActionsStorageEnv, type ActionsStoragePointerPort, type SnapshotPointer } from "./storage.js";

const sqliteBytes = new TextEncoder().encode("SQLite format 3\0fixture");
const generation = "generation-a";

function env(bucket: FakeR2Bucket): ActionsStorageEnv {
  return { GFY_ACTIONS_SQLITE_BUCKET: bucket as unknown as R2Bucket, GFY_ACTIONS_STORAGE_TOKEN: "storage-token", GFY_ACTIONS_STORAGE_GENERATION: generation };
}

describe("actions storage pointer CAS", () => {
  it("requires an atomic coordinator and admits an empty restore only for its generation", async () => {
    const bucket = new FakeR2Bucket();
    const request = () => storageRequest("/sqlite/latest?generation=generation-a", { headers: { authorization: "Bearer storage-token" } });
    expect((await handleActionsStorage(request(), env(bucket)))?.status).toBe(503);
    const empty = await handleActionsStorage(request(), env(bucket), new FakePointerPort());
    expect(empty?.status).toBe(204);
    expect(empty?.headers.get("x-gfy-actions-generation")).toBe(generation);
  });
  it("exposes typed Effect failures before the Promise compatibility wrapper", async () => {
    const bucket = new FakeR2Bucket();
    const program = handleActionsStorageEffect(storageRequest("/sqlite/latest?generation=generation-a", { headers: { authorization: "Bearer storage-token" } }), { ...env(bucket), GFY_ACTIONS_STORAGE_GENERATION: "invalid generation" }, new FakePointerPort());

    await expect(Effect.runPromise(program)).rejects.toMatchObject({ _tag: "ActionsStorageError", message: "actions storage generation invalid" });
  });

  it("does not commit a pointer when the R2 snapshot write fails", async () => {
    const bucket = new FakeR2Bucket();
    const pointer = new FakePointerPort();
    bucket.failPuts = true;

    const response = await handleActionsStorage(storageRequest("/sqlite/backups?generation=generation-a", { method: "POST", headers: { authorization: "Bearer storage-token", "x-gfy-actions-sha256": sha256(sqliteBytes) }, body: sqliteBytes }), env(bucket), pointer);

    expect(response?.status).toBe(503);
    expect(pointer.commits).toBe(0);
    expect(pointer.pointer).toBeNull();
  });

  it("exports pointer versions on latest snapshot responses", async () => {
    const bucket = new FakeR2Bucket();
    const pointer = new FakePointerPort();
    const digest = sha256(sqliteBytes);
    const key = `actions-github/sqlite/${generation}/${digest}.db`;
    bucket.objects.set(key, new FakeR2Object(sqliteBytes));
    pointer.pointer = { generation, sha256: digest, bytes: sqliteBytes.byteLength, key, created_at: "2026-10-09T18:00:00.000Z" };
    pointer.version = "version-123";

    const response = await handleActionsStorage(storageRequest("/sqlite/latest?generation=generation-a", { headers: { authorization: "Bearer storage-token" } }), env(bucket), pointer);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-gfy-actions-pointer-version")).toBe("version-123");
  });

  it("rejects checksum mismatches and corrupt R2 snapshots without committing a pointer", async () => {
    const bucket = new FakeR2Bucket();
    const pointer = new FakePointerPort();
    const badSha = sha256(new TextEncoder().encode("different"));

    const mismatch = await handleActionsStorage(storageRequest("/sqlite/backups?generation=generation-a", { method: "POST", headers: { authorization: "Bearer storage-token", "x-gfy-actions-sha256": badSha }, body: sqliteBytes }), env(bucket), pointer);

    expect(mismatch?.status).toBe(400);
    expect(pointer.commits).toBe(0);
    expect(pointer.pointer).toBeNull();

    const digest = sha256(sqliteBytes);
    const key = `actions-github/sqlite/${generation}/${digest}.db`;
    const corruptObject = new FakeR2Object(new TextEncoder().encode("not sqlite"));
    bucket.objects.set(key, corruptObject);
    pointer.pointer = { generation, sha256: digest, bytes: sqliteBytes.byteLength, key, created_at: "2026-10-09T18:00:00.000Z" };

    const corrupt = await handleActionsStorage(storageRequest("/sqlite/latest?generation=generation-a", { headers: { authorization: "Bearer storage-token" } }), env(bucket), pointer);

    expect(corrupt?.status).toBe(503);
    expect(corruptObject.arrayBufferCalls).toBe(0);
  });
});

function storageRequest(path: string, init: RequestInit): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("content-length") && init.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") headers.set("content-length", String(new TextEncoder().encode(init.body).byteLength));
    else if (init.body instanceof Uint8Array) headers.set("content-length", String(init.body.byteLength));
  }
  return new Request(`https://gitfoundry.dev/__internal/actions-github/storage${path}`, { ...init, headers });
}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

class FakeR2Object {
  readonly size: number;
  readonly checksums: { readonly sha256: ArrayBuffer };
  arrayBufferCalls = 0;

  constructor(readonly bytes: Uint8Array) {
    this.size = bytes.byteLength;
    this.checksums = { sha256: digestBytes(bytes) };
  }

  get body(): ReadableStream<Uint8Array> {
    const bytes = new Uint8Array(this.bytes);
    return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }

  async arrayBuffer(): Promise<ArrayBuffer> { this.arrayBufferCalls += 1; return new Uint8Array(this.bytes).buffer; }
  async text(): Promise<string> { return new TextDecoder().decode(this.bytes); }
}

class FakeR2Bucket {
  readonly objects = new Map<string, FakeR2Object>();
  failPuts = false;
  async get(key: string): Promise<FakeR2Object | null> { return this.objects.get(key) ?? null; }
  async put(_key: string, value?: string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>, options?: { sha256?: string | ArrayBuffer | ArrayBufferView }): Promise<void> {
    if (this.failPuts) throw new Error("put failed");
    const bytes = await bytesFromPutValue(value);
    if (options?.sha256 && sha256(bytes) !== checksumHex(options.sha256)) {
      const error = new Error("checksum mismatch");
      error.name = "R2ChecksumMismatch";
      throw error;
    }
  }
}

function digestBytes(bytes: Uint8Array): ArrayBuffer {
  const digest = createHash("sha256").update(bytes).digest();
  const out = new Uint8Array(digest.byteLength);
  out.set(digest);
  return out.buffer;
}

function checksumHex(value: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof value === "string") return value;
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(bytes).toString("hex");
}

async function bytesFromPutValue(value?: string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (!value) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = value.getReader();
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

class FakePointerPort implements ActionsStoragePointerPort {
  pointer: SnapshotPointer | null = null;
  version: string | null = null;
  commits = 0;
  async read(): Promise<{ pointer: SnapshotPointer | null; version: string | null }> { return { pointer: this.pointer, version: this.version }; }
  async commit(): Promise<{ ok: true; version: string } | { ok: false; reason: "stale" }> {
    this.commits += 1;
    return { ok: true, version: "unused" };
  }
}
