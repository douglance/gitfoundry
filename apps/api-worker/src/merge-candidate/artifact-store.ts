import { createHash } from "node:crypto";

export type CandidateArtifactKind = "source_manifest" | "source_target_pack" | "source_head_pack" | "candidate_manifest" | "candidate_raw_commit" | "candidate_pack";
export interface CandidateArtifactScope {
  readonly tenantId: string; readonly repositoryId: string; readonly operationId: string;
  readonly requestSha256: string; readonly kind: CandidateArtifactKind;
}
export interface CandidateArtifactInput extends CandidateArtifactScope {
  readonly body: ReadableStream<Uint8Array>; readonly expectedSha256: string; readonly expectedSizeBytes: number;
  readonly contentType: string; readonly expiresAt: string | null;
}
export interface ImmutableBlobLocator extends CandidateArtifactScope {
  readonly key: string; readonly sha256: string; readonly sizeBytes: number;
  readonly etag: string; readonly version: string; readonly expiresAt: string | null;
}
type FixedStreamFactory = (length: number) => { readonly readable: ReadableStream<Uint8Array>; readonly writable: WritableStream<Uint8Array> };
const kinds = new Set<CandidateArtifactKind>(["source_manifest", "source_target_pack", "source_head_pack", "candidate_manifest", "candidate_raw_commit", "candidate_pack"]);
const maxArtifactBytes = 128 * 1024 * 1024;

export class CandidateArtifactStore {
  constructor(
    private readonly bucket: Pick<R2Bucket, "put" | "get">,
    private readonly db: Pick<D1Database, "prepare">,
    private readonly fixedStream: FixedStreamFactory = (length) => new FixedLengthStream(length)
  ) {}

  async putAppendOnly(input: CandidateArtifactInput): Promise<ImmutableBlobLocator> {
    validateScope(input); validateDigest(input.expectedSha256);
    validateSize(input.expectedSizeBytes);
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(input.contentType)) throw new Error("artifact content type is invalid");
    validateExpiry(input.expiresAt);
    const key = artifactKey(input);
    const transport = this.fixedStream(input.expectedSizeBytes);
    const pump = verifiedStream(input.body, input.expectedSha256, input.expectedSizeBytes).pipeTo(transport.writable);
    const write = this.bucket.put(key, transport.readable, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      sha256: input.expectedSha256,
      httpMetadata: { contentType: input.contentType },
      customMetadata: scopeMetadata(input)
    });
    const [stored] = await Promise.all([write, pump]);
    let object: R2Object;
    if (stored) {
      object = stored;
      assertObject(object, input, key);
    } else {
      const existing = await this.bucket.get(key);
      if (!existing || !("body" in existing) || !existing.body) throw new Error("artifact conditional write lost its existing object");
      object = existing;
      assertObject(object, input, key);
      await drain(verifiedStream(existing.body, input.expectedSha256, input.expectedSizeBytes));
    }
    const locator: ImmutableBlobLocator = {
      tenantId: input.tenantId, repositoryId: input.repositoryId, operationId: input.operationId,
      requestSha256: input.requestSha256, kind: input.kind, key,
      sha256: input.expectedSha256, sizeBytes: input.expectedSizeBytes,
      etag: object.etag, version: object.version, expiresAt: input.expiresAt
    };
    await this.record(locator);
    return locator;
  }

  async getVerified(locator: ImmutableBlobLocator): Promise<ReadableStream<Uint8Array>> {
    validateScope(locator); validateDigest(locator.sha256); validateSize(locator.sizeBytes); validateExpiry(locator.expiresAt);
    if (locator.key !== artifactKey(locator)) throw new Error("artifact locator scope mismatch");
    const object = await this.bucket.get(locator.key, { onlyIf: { etagMatches: locator.etag } });
    if (!object || !("body" in object) || !object.body || object.version !== locator.version) throw new Error("artifact object version unavailable");
    assertObject(object, { ...locator, expectedSha256: locator.sha256, expectedSizeBytes: locator.sizeBytes }, locator.key);
    return verifiedStream(object.body, locator.sha256, locator.sizeBytes);
  }

  private async record(locator: ImmutableBlobLocator): Promise<void> {
    const id = createHash("sha256").update(locator.key).digest("hex");
    const timestamp = new Date().toISOString();
    const name = `merge:${locator.operationId}:${locator.kind}:${locator.requestSha256}`;
    const result = await this.db.prepare("INSERT INTO artifacts (tenant_id,id,created_at,updated_at,repository_id,name,r2_key,digest,size_bytes,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO NOTHING")
      .bind(locator.tenantId, id, timestamp, timestamp, locator.repositoryId, name, locator.key, locator.sha256, locator.sizeBytes, locator.expiresAt).run();
    if (!result.success) throw new Error("artifact record write failed");
    const row = await this.db.prepare("SELECT tenant_id,id,repository_id,name,r2_key,digest,size_bytes,expires_at FROM artifacts WHERE tenant_id=? AND id=?")
      .bind(locator.tenantId, id).first<Record<string, unknown>>();
    if (!row || row.tenant_id !== locator.tenantId || row.id !== id || row.repository_id !== locator.repositoryId ||
        row.name !== name || row.r2_key !== locator.key || row.digest !== locator.sha256 ||
        row.size_bytes !== locator.sizeBytes || row.expires_at !== locator.expiresAt) throw new Error("artifact record mismatch");
  }
}

function artifactKey(scope: CandidateArtifactScope): string {
  return `v1/tenants/${scope.tenantId}/repositories/${scope.repositoryId}/merge-operations/${scope.operationId}/${scope.requestSha256}/${scope.kind}`;
}
function validateScope(scope: CandidateArtifactScope): void {
  for (const id of [scope.tenantId, scope.repositoryId, scope.operationId]) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(id) || id.includes("..")) throw new Error("artifact identity is invalid");
  }
  validateDigest(scope.requestSha256);
  if (!kinds.has(scope.kind)) throw new Error("artifact kind is invalid");
}
function validateDigest(digest: string): void {
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) throw new Error("artifact digest is invalid");
}
function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxArtifactBytes) throw new Error("artifact size is outside its bound");
}
function validateExpiry(expiresAt: string | null): void {
  if (expiresAt !== null && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt || Date.parse(expiresAt) <= Date.now())) throw new Error("artifact locator expired or invalid");
}
function scopeMetadata(input: CandidateArtifactInput): Record<string, string> {
  return { tenantId: input.tenantId, repositoryId: input.repositoryId, operationId: input.operationId, requestSha256: input.requestSha256, kind: input.kind, sha256: input.expectedSha256, sizeBytes: String(input.expectedSizeBytes), expiresAt: input.expiresAt ?? "" };
}
function assertObject(object: R2Object, input: CandidateArtifactScope & { expectedSha256: string; expectedSizeBytes: number; expiresAt: string | null }, key: string): void {
  const metadata = object.customMetadata;
  if (object.key !== key || !metadata || metadata.tenantId !== input.tenantId ||
      metadata.repositoryId !== input.repositoryId || metadata.operationId !== input.operationId ||
      metadata.requestSha256 !== input.requestSha256 || metadata.kind !== input.kind) throw new Error("artifact scope mismatch");
  if (object.size !== input.expectedSizeBytes || metadata.sizeBytes !== String(input.expectedSizeBytes)) throw new Error("artifact size mismatch");
  if (metadata.sha256 !== input.expectedSha256) throw new Error("artifact digest mismatch");
  if (metadata.expiresAt !== (input.expiresAt ?? "")) throw new Error("artifact expiry mismatch");
  const checksum = object.checksums.sha256;
  if (!checksum || Buffer.from(checksum).toString("hex") !== input.expectedSha256) throw new Error("artifact digest checksum mismatch");
}

function verifiedStream(body: ReadableStream<Uint8Array>, expectedDigest: string, expectedSize: number): ReadableStream<Uint8Array> {
  const hash = createHash("sha256");
  let size = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) throw new Error("artifact stream contains non-byte data");
      size += chunk.byteLength;
      if (size > expectedSize) throw new Error("artifact size mismatch");
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (size !== expectedSize) throw new Error("artifact size mismatch");
      if (hash.digest("hex") !== expectedDigest) throw new Error("artifact digest mismatch");
    }
  }));
}
async function drain(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  try { while (!(await reader.read()).done) {} } finally { reader.releaseLock() }
}
