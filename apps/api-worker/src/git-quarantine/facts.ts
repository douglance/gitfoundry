export interface PreparedReceivePackExpectation {
  readonly ref: string;
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly rawReceivePackSha256: string;
  readonly packSha256: string;
  readonly signatureTrust: "unconfigured" | "qualified";
}

export interface PreparedReceivePackLimits {
  readonly maxFactBytes: number;
  readonly maxNewObjects: number;
  readonly maxNewCommits: number;
  readonly maxChangedPaths: number;
  readonly maxPathBytes: number;
  readonly maxBlobBytes: number;
  readonly maxTotalBlobBytes: number;
}

export interface PreparedSignatureFact {
  readonly oid: string;
  readonly verification: "none" | "unsupported" | "valid" | "invalid" | "untrusted";
}

interface BoundFacts {
  readonly ref: string;
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly rawReceivePackSha256: string;
  readonly packSha256: string;
}

export type PreparedReceivePackFacts =
  | (BoundFacts & {
    readonly status: "accepted";
    readonly objectType: "commit" | "tag" | "tree" | "blob" | "none";
    readonly fastForward: boolean | null;
    readonly newObjectCount: number;
    readonly newCommitCount: number;
    readonly newBlobMaxBytes: number | null;
    readonly newBlobTotalBytes: number | null;
    readonly changedPaths: readonly string[];
    readonly signatures: readonly PreparedSignatureFact[];
  })
  | (BoundFacts & { readonly status: "rejected" | "unsupported"; readonly reason: string });

export class PreparedReceivePackFactsError extends Error {
  readonly name = "PreparedReceivePackFactsError";
}

const zeroOid = "0".repeat(40);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const scalarNames = new Set([
  "status", "reason", "ref", "old", "new", "raw_receive_pack_sha256", "pack_sha256",
  "object_format", "receive_pack_exit", "receive_pack_unpk", "receive_pack_ref",
  "result_ref_oid", "object_type", "fast_forward", "new_object_count", "new_commit_count",
  "new_blob_max_bytes", "new_blob_total_bytes", "changed_path_b64z"
]);
const signatureStatuses = new Set(["none", "unsupported", "valid", "invalid", "untrusted"]);

export function parsePreparedReceivePackFacts(stdout: string, expected: PreparedReceivePackExpectation, limits: PreparedReceivePackLimits): PreparedReceivePackFacts {
  if (!isRecord(limits)) fail("invalid fact limits");
  for (const name of ["maxFactBytes", "maxNewObjects", "maxNewCommits", "maxChangedPaths", "maxPathBytes", "maxBlobBytes", "maxTotalBlobBytes"] as const) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 1) fail("invalid fact limits");
  }
  if (typeof stdout !== "string" || stdout.length > limits.maxFactBytes) fail("fact output limit exceeded");
  const encoded = encoder.encode(stdout);
  if (encoded.byteLength > limits.maxFactBytes) fail("fact output limit exceeded");
  if (decoder.decode(encoded) !== stdout || stdout.includes("\r") || stdout.includes("\0")) fail("invalid fact encoding");
  if (!validExpected(expected)) fail("invalid fact expectation");
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "gitfoundry-prepared-receive-pack-v1" || lines.pop() !== "end") fail("incomplete fact frame");

  const fields = new Map<string, string>();
  const signatures: PreparedSignatureFact[] = [];
  const signatureOids = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const [key, value] = splitField(lines[i]!);
    if (key === "signature_oid") {
      if (!validOid(value) || value === zeroOid || signatureOids.has(value)) fail("invalid signature object");
      const [nextKey, verification] = splitField(lines[++i] ?? "");
      if (nextKey !== "signature_status" || !signatureStatuses.has(verification)) fail("invalid signature fact");
      if (verification === "valid" && expected.signatureTrust !== "qualified") fail("signature trust unavailable");
      signatureOids.add(value);
      signatures.push({ oid: value, verification: verification as PreparedSignatureFact["verification"] });
    } else {
      if (!scalarNames.has(key) || fields.has(key)) fail("unexpected fact field");
      fields.set(key, value);
    }
  }
  if (fields.size !== scalarNames.size) fail("missing fact field");
  const get = (name: string): string => fields.get(name)!;
  if (get("ref") !== expected.ref || get("old") !== (expected.oldOid ?? zeroOid) || get("new") !== (expected.newOid ?? zeroOid)) fail("fact command mismatch");
  if (get("raw_receive_pack_sha256") !== expected.rawReceivePackSha256 || get("pack_sha256") !== expected.packSha256) fail("fact digest mismatch");
  if (get("object_format") !== "sha1") fail("unsupported object format");
  const bound: BoundFacts = { ref: expected.ref, oldOid: expected.oldOid, newOid: expected.newOid, rawReceivePackSha256: expected.rawReceivePackSha256, packSha256: expected.packSha256 };
  const status = get("status");
  const reason = get("reason");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(reason)) fail("invalid fact reason");
  if (status === "rejected" || status === "unsupported") {
    if (reason === "none") fail("missing rejection reason");
    return { ...bound, status, reason };
  }
  if (status !== "accepted" || reason !== "none") fail("invalid accepted status");
  if (get("receive_pack_exit") !== "0" || get("receive_pack_unpk") !== "ok" || get("receive_pack_ref") !== "ok") fail("native receive-pack rejected");
  if (get("result_ref_oid") !== (expected.newOid ?? zeroOid)) fail("native ref result mismatch");

  const objectType = get("object_type");
  if (!["commit", "tag", "tree", "blob", "none"].includes(objectType)) fail("invalid object type");
  const newObjectCount = count(get("new_object_count"), limits.maxNewObjects);
  const newCommitCount = count(get("new_commit_count"), limits.maxNewCommits);
  if (newCommitCount > newObjectCount || signatures.length !== newCommitCount) fail("incomplete commit facts");
  const newBlobMaxBytes = nullableCount(get("new_blob_max_bytes"), limits.maxBlobBytes);
  const newBlobTotalBytes = nullableCount(get("new_blob_total_bytes"), limits.maxTotalBlobBytes);
  if ((newBlobMaxBytes === null) !== (newBlobTotalBytes === null) || (newBlobMaxBytes !== null && newBlobTotalBytes !== null && newBlobMaxBytes > newBlobTotalBytes)) fail("inconsistent blob facts");
  const changedPaths = decodePaths(get("changed_path_b64z"), limits);
  const fastForwardText = get("fast_forward");
  if (!["true", "false", "none"].includes(fastForwardText)) fail("invalid ancestry fact");
  const fastForward = fastForwardText === "none" ? null : fastForwardText === "true";
  if (expected.newOid === null) {
    if (objectType !== "none" || fastForward !== null || newObjectCount !== 0 || newCommitCount !== 0 || newBlobMaxBytes !== null || changedPaths.length !== 0) fail("inconsistent deletion facts");
  } else {
    if (objectType === "none") fail("missing new object type");
    if (expected.ref.startsWith("refs/heads/")) {
      if (objectType !== "commit" || (expected.oldOid === null ? fastForward !== null : fastForward === null)) fail("incomplete branch facts");
    } else if (fastForward !== null) fail("unexpected tag ancestry");
    if (newObjectCount === 0 && newBlobMaxBytes !== null) fail("inconsistent empty object graph");
    if (objectType === "blob" && newObjectCount > 0 && newBlobMaxBytes === null) fail("missing blob facts");
  }
  return { ...bound, status, objectType: objectType as Extract<PreparedReceivePackFacts, { status: "accepted" }>["objectType"], fastForward, newObjectCount, newCommitCount, newBlobMaxBytes, newBlobTotalBytes, changedPaths, signatures };
}

function validExpected(expected: PreparedReceivePackExpectation): boolean {
  return isRecord(expected) && typeof expected.ref === "string" && /^(refs\/heads\/|refs\/tags\/).+/.test(expected.ref) && !/[\u0000-\u0020\u007f]/.test(expected.ref) &&
    (expected.oldOid === null || (validOid(expected.oldOid) && expected.oldOid !== zeroOid)) &&
    (expected.newOid === null || (validOid(expected.newOid) && expected.newOid !== zeroOid)) &&
    (expected.oldOid !== null || expected.newOid !== null) &&
    /^[0-9a-f]{64}$/.test(expected.rawReceivePackSha256) && /^[0-9a-f]{64}$/.test(expected.packSha256) &&
    (expected.signatureTrust === "unconfigured" || expected.signatureTrust === "qualified");
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function validOid(value: string): boolean { return /^[0-9a-f]{40}$/.test(value) }
function splitField(line: string): [string, string] {
  const parts = line.split("\t");
  if (parts.length !== 2) fail("invalid fact field framing");
  return [parts[0]!, parts[1]!];
}
function count(value: string, ceiling: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) fail("invalid fact count");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > ceiling) fail("fact resource limit exceeded");
  return parsed;
}
function nullableCount(value: string, ceiling: number): number | null { return value === "none" ? null : count(value, ceiling) }

function decodePaths(encoded: string, limits: PreparedReceivePackLimits): readonly string[] {
  if (encoded === "") return [];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail("invalid path frame");
  let binary: string;
  try { binary = atob(encoded) } catch { return fail("invalid path frame") }
  if (btoa(binary) !== encoded || !binary.endsWith("\0")) fail("invalid path frame");
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const bytes of binary.slice(0, -1).split("\0")) {
    if (bytes.length === 0 || bytes.length > limits.maxPathBytes || paths.length >= limits.maxChangedPaths) fail("path resource limit exceeded");
    let path: string;
    try { path = decoder.decode(Uint8Array.from(bytes, (byte) => byte.charCodeAt(0))) } catch { return fail("invalid path encoding") }
    if (seen.has(path)) fail("duplicate path fact");
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function fail(reason: string): never { throw new PreparedReceivePackFactsError(reason) }
