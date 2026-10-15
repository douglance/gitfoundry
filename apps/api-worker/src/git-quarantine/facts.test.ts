import { describe, expect, it } from "vitest";
import { parsePreparedReceivePackFacts, PreparedReceivePackFactsError, type PreparedReceivePackExpectation } from "./facts.js";

const oldOid = "a".repeat(40);
const newOid = "b".repeat(40);
const rawSha256 = "c".repeat(64);
const packSha256 = "d".repeat(64);
const expected: PreparedReceivePackExpectation = { ref: "refs/heads/main", oldOid, newOid, rawReceivePackSha256: rawSha256, packSha256, signatureTrust: "unconfigured" as const };
const limits = { maxFactBytes: 8192, maxNewObjects: 20, maxNewCommits: 5, maxChangedPaths: 10, maxPathBytes: 128, maxBlobBytes: 1024, maxTotalBlobBytes: 4096 };
const fields = {
  status: "accepted", reason: "none", ref: expected.ref, old: oldOid, new: newOid,
  raw_receive_pack_sha256: rawSha256, pack_sha256: packSha256, object_format: "sha1",
  receive_pack_exit: "0", receive_pack_unpk: "ok", receive_pack_ref: "ok", result_ref_oid: newOid,
  object_type: "commit", fast_forward: "true", new_object_count: "3", new_commit_count: "1",
  new_blob_max_bytes: "17", new_blob_total_bytes: "17", changed_path_b64z: "UkVBRE1FAHMubWRcbi50eHQA"
};
function wire(overrides: Record<string, string> = {}, signatures = `signature_oid\t${newOid}\nsignature_status\tnone\n`): string {
  return "gitfoundry-prepared-receive-pack-v1\n" + Object.entries({ ...fields, ...overrides }).map(([key, value]) => key + "\t" + value + "\n").join("") + signatures + "end\n";
}
function parse(overrides: Record<string, string> = {}) { return parsePreparedReceivePackFacts(wire(overrides), expected, limits) }
function rejects(text: string, expectedInput = expected, limitInput = limits) {
  expect(() => parsePreparedReceivePackFacts(text, expectedInput, limitInput)).toThrow(PreparedReceivePackFactsError);
}

describe("trusted native quarantine fact boundary", () => {
  it("binds native facts to exact commands and independently supplied input digests", () => {
    const paths = Buffer.from("README\0s.md\n.txt\0", "utf8").toString("base64");
    const result = parse({ changed_path_b64z: paths });
    expect(result).toMatchObject({ status: "accepted", ref: "refs/heads/main", oldOid, newOid, objectType: "commit", fastForward: true, newObjectCount: 3, newCommitCount: 1, newBlobMaxBytes: 17, newBlobTotalBytes: 17, changedPaths: ["README", "s.md\n.txt"], signatures: [{ oid: newOid, verification: "none" }] });
  });

  it.each([
    ["ref", "refs/heads/other"], ["old", "e".repeat(40)], ["new", "f".repeat(40)],
    ["raw_receive_pack_sha256", "1".repeat(64)], ["pack_sha256", "2".repeat(64)],
    ["result_ref_oid", oldOid], ["object_format", "sha256"],
    ["receive_pack_exit", "1"], ["receive_pack_unpk", "error"], ["receive_pack_ref", "ng"],
    ["receive_pack_ref", "missing"], ["object_type", "tag"], ["fast_forward", "none"],
    ["reason", "unexpected_acceptance_reason"]
  ])("refuses accepted facts with mismatched or unsuccessful %s", (key, value) => rejects(wire({ [key]: value })));

  it.each(["new_object_count", "new_commit_count", "new_blob_max_bytes", "new_blob_total_bytes"])("rejects malformed numeric %s", (key) => {
    for (const value of ["-1", "1.5", "01", "NaN", "9007199254740992"]) rejects(wire({ [key]: value }));
  });

  it("enforces object, commit, blob and path resource ceilings", () => {
    rejects(wire({ new_object_count: "21" }));
    rejects(wire({ new_commit_count: "6" }));
    rejects(wire({ new_blob_max_bytes: "1025", new_blob_total_bytes: "1025" }));
    rejects(wire({ new_blob_total_bytes: "4097" }));
    rejects(wire({ changed_path_b64z: Buffer.from("x".repeat(129) + "\0").toString("base64") }));
    rejects(wire({ changed_path_b64z: Buffer.from(Array.from({ length: 11 }, (_, i) => "path-" + i + "\0").join("")).toString("base64") }));
    rejects(wire(), expected, { ...limits, maxFactBytes: 10 });
  });

  it("rejects invalid server resource configuration", () => {
    for (const value of [0, -1, 1.5, NaN, Infinity]) rejects(wire(), expected, { ...limits, maxNewObjects: value });
  });

  it("requires every resource ceiling and rejects malformed server inputs", () => {
    for (const key of Object.keys(limits)) {
      const incomplete = { ...limits };
      delete (incomplete as Partial<typeof limits>)[key as keyof typeof limits];
      rejects(wire(), expected, incomplete);
    }
    for (const invalid of [null, {}, { ...expected, oldOid: "0".repeat(40) }, { ...expected, newOid: null, oldOid: null }]) {
      expect(() => parsePreparedReceivePackFacts(wire(), invalid as PreparedReceivePackExpectation, limits)).toThrow(PreparedReceivePackFactsError);
    }
  });

  it("preserves UTF-8 ref names and measures complete output bytes", () => {
    const ref = "refs/heads/作業";
    const text = wire({ ref });
    const result = parsePreparedReceivePackFacts(text, { ...expected, ref }, limits);
    expect(result.ref).toBe(ref);
    rejects(text, { ...expected, ref }, { ...limits, maxFactBytes: Buffer.byteLength(text) - 1 });
  });

  it("rejects malformed, unterminated, duplicate and non-UTF8 paths", () => {
    for (const bytes of [Buffer.from("README"), Buffer.from("\0"), Buffer.from("x\0x\0"), Buffer.from([0xff, 0])]) {
      rejects(wire({ changed_path_b64z: bytes.toString("base64") }));
    }
    rejects(wire({ changed_path_b64z: "!not-base64!" }));
    rejects(wire({ changed_path_b64z: "eAA" }));
    rejects(wire({ changed_path_b64z: "eAB=" }));
  });

  it("preserves Unicode and BOM filename bytes instead of silently renaming them", () => {
    const path = "\uFEFFrésumé.md";
    const parsed = parse({ changed_path_b64z: Buffer.from(path + "\0").toString("base64") });
    expect(parsed.status === "accepted" && parsed.changedPaths).toEqual([path]);
    rejects(wire({ changed_path_b64z: Buffer.from(path + "\0").toString("base64") }), expected, { ...limits, maxPathBytes: Buffer.byteLength(path) - 1 });
  });

  it("rejects unknown, repeated, truncated and trailing frames without echoing native text", () => {
    for (const text of [
      wire().replace("end\n", ""), wire() + "unexpected\n", wire().replace("end\n", "unknown\tprivate-secret\nend\n"),
      wire().replace("end\n", "ref\trefs/heads/main\nend\n"), wire().replace("gitfoundry-prepared-receive-pack-v1", "wrong-header"),
      wire().replace("status\taccepted", "status\taccepted\tprivate-secret"), wire().replace("end\n", "end\r\n")
    ]) {
      rejects(text);
      try { parsePreparedReceivePackFacts(text, expected, limits) } catch (error) { expect(String(error)).not.toContain("private-secret") }
    }
  });

  it("requires complete unique signature facts for each newly reachable commit", () => {
    rejects(wire({}, ""));
    rejects(wire({}, `signature_oid\t${newOid}\nsignature_status\tnone\nsignature_oid\t${newOid}\nsignature_status\tnone\n`));
    rejects(wire({}, `signature_status\tnone\n`));
    rejects(wire({}, `signature_oid\t${newOid}\nsignature_status\tvalid\n`));
    rejects(wire({}, `signature_oid\t${"0".repeat(40)}\nsignature_status\tnone\n`));
    rejects(wire({ new_commit_count: "4" }));
    rejects(wire({ new_object_count: "0" }));
    const unsupported = parsePreparedReceivePackFacts(wire({}, `signature_oid\t${newOid}\nsignature_status\tunsupported\n`), expected, limits);
    expect(unsupported.status === "accepted" && unsupported.signatures[0]?.verification).toBe("unsupported");
  });

  it("does not turn native rejection into acceptance even when process exit is zero", () => {
    const rejected = parse({ status: "rejected", reason: "native_ref_rejected", receive_pack_ref: "ng", result_ref_oid: oldOid });
    expect(rejected).toEqual({ status: "rejected", reason: "native_ref_rejected", ref: expected.ref, oldOid, newOid, rawReceivePackSha256: rawSha256, packSha256 });
    rejects(wire({ status: "rejected", reason: "private secret token" }));
  });

  it("retains old-to-new path changes when a force rewind adds no reachable objects", () => {
    const result = parsePreparedReceivePackFacts(wire({ fast_forward: "false", new_object_count: "0", new_commit_count: "0", new_blob_max_bytes: "none", new_blob_total_bytes: "none", changed_path_b64z: "UkVBRE1FAA==" }, ""), expected, limits);
    expect(result).toMatchObject({ status: "accepted", fastForward: false, newObjectCount: 0, newCommitCount: 0, changedPaths: ["README"], signatures: [] });
  });

  it("models create, deletion, tags, and empty newly reachable graphs explicitly", () => {
    const zero = "0".repeat(40);
    const create = parsePreparedReceivePackFacts(wire({ old: zero, fast_forward: "none" }), { ...expected, oldOid: null }, limits);
    expect(create.status === "accepted" && create.fastForward).toBeNull();
    const deletionFields = { new: zero, result_ref_oid: zero, object_type: "none", fast_forward: "none", new_object_count: "0", new_commit_count: "0", new_blob_max_bytes: "none", new_blob_total_bytes: "none", changed_path_b64z: "" };
    const deleted = parsePreparedReceivePackFacts(wire(deletionFields, ""), { ...expected, newOid: null }, limits);
    expect(deleted).toMatchObject({ status: "accepted", newOid: null, objectType: "none", changedPaths: [], signatures: [], newObjectCount: 0 });
    rejects(wire({ ...deletionFields, object_type: "commit" }, ""), { ...expected, newOid: null });
    const tag = parsePreparedReceivePackFacts(wire({ ref: "refs/tags/release", object_type: "tag", fast_forward: "none" }), { ...expected, ref: "refs/tags/release" }, limits);
    expect(tag.status === "accepted" && tag.objectType).toBe("tag");
    const unchanged = parsePreparedReceivePackFacts(wire({ new_object_count: "0", new_commit_count: "0", new_blob_max_bytes: "none", new_blob_total_bytes: "none", changed_path_b64z: "" }, ""), expected, limits);
    expect(unchanged.status === "accepted" && unchanged.newCommitCount).toBe(0);
    rejects(wire({ new_blob_max_bytes: "18", new_blob_total_bytes: "17" }));
    rejects(wire({ new_blob_max_bytes: "none" }));
  });
});
