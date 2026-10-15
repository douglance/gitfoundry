import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CandidateArtifactStore, type CandidateArtifactInput } from "./artifact-store.js";

const bytes = new TextEncoder().encode("actual candidate pack bytes");
const hash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const input = (body = bytes): CandidateArtifactInput => ({
  tenantId: "tenant-a", repositoryId: "repo-a", operationId: "op-a", requestSha256: "a".repeat(64),
  kind: "candidate_pack", expectedSha256: hash(bytes), expectedSizeBytes: bytes.byteLength,
  contentType: "application/octet-stream", expiresAt: null,
  body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); c.close() } })
});
const fixed = (_length: number) => new TransformStream<Uint8Array, Uint8Array>();
const read = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer());

class Bucket {
  readonly entries = new Map<string, { bytes: Uint8Array; metadata: Record<string,string>; etag: string }>();
  puts = 0;
  race = false;
  async put(key: string, body: ReadableStream<Uint8Array>, options: R2PutOptions) {
    this.puts++;
    expect(options.onlyIf).toBeInstanceOf(Headers);
    expect((options.onlyIf as Headers).get("If-None-Match")).toBe("*");
    const data = await read(body);
    if (this.race && !this.entries.has(key)) this.entries.set(key, { bytes: data, metadata: options.customMetadata!, etag: "first" });
    if (this.entries.has(key)) return null;
    this.entries.set(key, { bytes: data, metadata: options.customMetadata!, etag: "first" });
    return this.object(key);
  }
  async get(key: string, options?: R2GetOptions) {
    const object = this.object(key);
    if (!object) return null;
    if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches !== object.etag) return { ...object, body: undefined };
    const data = this.entries.get(key)!.bytes;
    return { ...object, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close() } }) };
  }
  object(key: string) {
    const e = this.entries.get(key);
    return e ? { key, size: e.bytes.length, etag: e.etag, version: "version-1", customMetadata: e.metadata, checksums: { sha256: Uint8Array.from(Buffer.from(e.metadata.sha256!,"hex")).buffer } } : null;
  }
}
class Database {
  row: Record<string, unknown> | undefined;
  fail = false;
  prepare(_sql: string) {
    const db = this;
    return { bind(...values: unknown[]) {
      return {
        async run() { if (db.fail) throw new Error("D1 temporarily unavailable"); db.row ??= { tenant_id:values[0], id:values[1], repository_id:values[4], name:values[5], r2_key:values[6], digest:values[7], size_bytes:values[8], expires_at:values[9] }; return { success:true } },
        async first() { return db.row }
      };
    }};
  }
}
function fixture() {
  const bucket = new Bucket(); const db = new Database();
  const store = new CandidateArtifactStore(bucket as unknown as R2Bucket, db as unknown as D1Database, fixed);
  return { store, bucket, db };
}
describe("durable candidate artifact storage", () => {
  it("captures exact bytes, records metadata, and returns a verified stream", async () => {
    const {store,bucket,db}=fixture(); const locator=await store.putAppendOnly(input());
    expect(locator.key).toContain("/tenant-a/repositories/repo-a/merge-operations/op-a/");
    expect(db.row).toMatchObject({ tenant_id:"tenant-a", repository_id:"repo-a", digest:hash(bytes), size_bytes:bytes.length, r2_key:locator.key });
    expect(await read(await store.getVerified(locator))).toEqual(bytes);
    expect(bucket.puts).toBe(1);
  });
  it("reuses matching concurrent conditional writes without replacement", async () => {
    const {store,bucket}=fixture(); bucket.race=true;
    const first=await store.putAppendOnly(input()); const second=await store.putAppendOnly(input());
    expect(first).toEqual(second); expect(bucket.entries.size).toBe(1); expect(bucket.puts).toBe(2);
  });
  it("rejects changed contents at the same immutable key", async () => {
    const {store,bucket}=fixture(); const locator=await store.putAppendOnly(input());
    const changed=new TextEncoder().encode("a different candidate");
    await expect(store.putAppendOnly({...input(changed),expectedSha256:hash(changed),expectedSizeBytes:changed.length})).rejects.toThrow(/mismatch/);
    expect(bucket.entries.get(locator.key)!.bytes).toEqual(bytes);
  });
  it("does not trust a claimed digest on corrupted existing bytes", async () => {
    const {store,bucket}=fixture(); const locator=await store.putAppendOnly(input());
    bucket.entries.get(locator.key)!.bytes=bytes.map((b,i)=>i===0?b^1:b);
    await expect(store.putAppendOnly(input())).rejects.toThrow(/digest/);
    await expect(read(await store.getVerified(locator))).rejects.toThrow(/digest/);
  });
  it("rejects truncated and oversized input without recording artifact metadata", async () => {
    for(const body of [bytes.slice(0,-1),new Uint8Array([...bytes,0])]) {
      const {store,db}=fixture(); await expect(store.putAppendOnly(input(body))).rejects.toThrow(/size/); expect(db.row).toBeUndefined();
    }
  });
  it("rejects input whose byte count matches but digest does not", async () => {
    const {store,db}=fixture(); await expect(store.putAppendOnly(input(bytes.map(b=>b^1)))).rejects.toThrow(/digest/); expect(db.row).toBeUndefined();
  });
  it("rejects scope metadata drift and stale object versions", async () => {
    const {store,bucket}=fixture(); const locator=await store.putAppendOnly(input());
    bucket.entries.get(locator.key)!.metadata.tenantId="tenant-b";
    await expect(store.getVerified(locator)).rejects.toThrow(/scope/);
    bucket.entries.get(locator.key)!.metadata.tenantId="tenant-a";
    await expect(store.getVerified({...locator,etag:"different"})).rejects.toThrow(/version/);
  });
  it("keeps a verified blob recoverable when D1 recording fails", async () => {
    const {store,bucket,db}=fixture(); db.fail=true;
    await expect(store.putAppendOnly(input())).rejects.toThrow("D1 temporarily unavailable");
    expect(bucket.entries.size).toBe(1); db.fail=false;
    const locator=await store.putAppendOnly(input()); expect(db.row!.r2_key).toBe(locator.key);
  });
  it("rejects conflicting durable artifact rows after the byte write", async () => {
    const {store,db}=fixture(); await store.putAppendOnly(input()); db.row!.repository_id="repo-b";
    await expect(store.putAppendOnly(input())).rejects.toThrow(/record/);
  });
  it("rejects path escapes, invalid digests, and expired locators", async () => {
    const {store}=fixture();
    await expect(store.putAppendOnly({...input(),tenantId:"../other"})).rejects.toThrow(/identity/);
    await expect(store.putAppendOnly({...input(),expectedSha256:"invalid"})).rejects.toThrow(/digest/);
    const locator=await store.putAppendOnly(input());
    await expect(store.getVerified({...locator,expiresAt:"2020-01-01T00:00:00.000Z"})).rejects.toThrow(/expired/);
  });
});
