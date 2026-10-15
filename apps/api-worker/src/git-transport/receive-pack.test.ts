import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseReceivePack } from "./receive-pack.js";

const a = "a".repeat(40);
const b = "b".repeat(40);
const zero = "0".repeat(40);
const encoder = new TextEncoder();
const advertised = new Set(["report-status", "report-status-v2", "side-band-64k", "ofs-delta", "delete-refs", "atomic", "quiet", "agent", "object-format"]);
function packet(text: string): Uint8Array {
  const payload = encoder.encode(text);
  return encoder.encode((payload.length + 4).toString(16).padStart(4, "0") + text);
}
function join(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function body(bytes: Uint8Array, size = bytes.length): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + size)); offset += Math.min(size, bytes.length - offset);
  } }, { highWaterMark: 0 });
}
const options = { advertisedCapabilities: advertised };
const command = (ref = "refs/heads/main", old = a, next = b) => old + " " + next + " " + ref;
async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("receive-pack command parsing", () => {
  it.each([1, 2, 3, 4, 7, 4096])("preserves commands and every pack byte with chunk size %i", async (size) => {
    const pack = new Uint8Array([80, 65, 67, 75, 0, 255, 128, 10, 13]);
    const wire = join(packet(command() + "\0report-status atomic agent=git/2.39.5\n"), packet(command("refs/tags/café", zero, a)), encoder.encode("0000"), pack);
    const parsed = await parseReceivePack(body(wire, size), options);
    expect(parsed.commands).toEqual([
      { ref: "refs/heads/main", oldOid: a, newOid: b },
      { ref: "refs/tags/café", oldOid: null, newOid: a }
    ]);
    expect(parsed.capabilities).toEqual(["report-status", "atomic", "agent=git/2.39.5"]);
    expect(await bytes(parsed.pack)).toEqual(pack);
  });

  it("accepts native Git capability spacing and explicit SHA-1 format", async () => {
    const parsed = await parseReceivePack(body(join(packet(command() + "\0 report-status  object-format=sha1 agent=git/2.39.5 "), encoder.encode("0000"))), options);
    expect(parsed.capabilities).toEqual(["report-status", "object-format=sha1", "agent=git/2.39.5"]);
    await parsed.pack.cancel();
  });

  it("accepts delete-only requests without a pack and normalizes uppercase object IDs", async () => {
    const parsed = await parseReceivePack(body(join(packet(command("refs/tags/v1", a.toUpperCase(), zero)), encoder.encode("0000"))), options);
    expect(parsed.commands).toEqual([{ ref: "refs/tags/v1", oldOid: a, newOid: null }]);
    expect(await bytes(parsed.pack)).toEqual(new Uint8Array());
  });

  it("does not pull pack bytes until the consumer asks for them", async () => {
    let pulls = 0;
    const chunks = [join(packet(command()), encoder.encode("0000")), encoder.encode("PACK")];
    const source = new ReadableStream<Uint8Array>({ pull(controller) {
      pulls += 1;
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk); else controller.close();
    } }, { highWaterMark: 0 });
    const parsed = await parseReceivePack(source, options);
    expect(pulls).toBe(1);
    expect(await bytes(parsed.pack)).toEqual(encoder.encode("PACK"));
    expect(source.locked).toBe(false);
  });

  it.each(["zzzz", "0001", "0002", "0003", "0004", "ffff", "000", "0010abc", "0000"])("rejects malformed framing %s and cancels the source", async (wire) => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(wire)); c.close(); }, cancel });
    await expect(parseReceivePack(source, options)).rejects.toThrow();
    expect(source.locked).toBe(false);
  });

  it.each([
    "refs/heads/.hidden", "refs/heads/main.lock", "refs/heads/x..y", "refs/heads/x@{y",
    "refs/heads/x.", "refs/heads/x//y", "refs/heads/x/", "refs/heads/a b",
    "refs/heads/x\u007f", "refs/heads/x\\y", "refs/private/main", "HEAD"
  ])("rejects invalid or unsupported ref %s", async (ref) => {
    await expect(parseReceivePack(body(join(packet(command(ref)), encoder.encode("0000"))), options)).rejects.toThrow();
  });

  it.each([
    command() + "\0push-options", command() + "\0push-cert",
    command() + "\0object-format=sha256", command() + "\0atomic atomic",
    command() + "\0report-status\tatomic", command() + "\0agent=bad\0atomic",
    command("refs/heads/main", zero, zero), command("refs/heads/main", "x".repeat(40), b)
  ])("rejects unsupported or malformed commands/capabilities", async (text) => {
    await expect(parseReceivePack(body(join(packet(text), encoder.encode("0000"))), options)).rejects.toThrow();
  });

  it("rejects a UTF-8 BOM before the first command rather than silently stripping it", async () => {
    await expect(parseReceivePack(body(join(packet("\ufeff" + command()), encoder.encode("0000"))), options)).rejects.toThrow();
  });

  it("rejects invalid UTF-8 rather than authorizing a replacement-character ref", async () => {
    const line = join(encoder.encode(command("refs/heads/")), new Uint8Array([255]));
    const wire = join(encoder.encode((line.length + 4).toString(16).padStart(4, "0")), line, encoder.encode("0000"));
    await expect(parseReceivePack(body(wire), options)).rejects.toThrow();
  });

  it.each(["refs/heads/main", "refs/heads/main/child"])("rejects duplicate or conflicting ref paths %s", async (ref) => {
    await expect(parseReceivePack(body(join(packet(command()), packet(command(ref)), encoder.encode("0000"))), options)).rejects.toThrow();
  });

  it("rejects capabilities on a later command and deletes when the server did not advertise support", async () => {
    await expect(parseReceivePack(body(join(packet(command()), packet(command("refs/heads/other") + "\0atomic"), encoder.encode("0000"))), options)).rejects.toThrow();
    await expect(parseReceivePack(body(join(packet(command("refs/heads/main", a, zero)), encoder.encode("0000"))), { advertisedCapabilities: new Set() })).rejects.toThrow();
  });

  it("enforces the command byte and count limits before consuming the pack", async () => {
    const wire = join(packet(command()), packet(command("refs/heads/other")), encoder.encode("0000"), encoder.encode("PACK"));
    await expect(parseReceivePack(body(wire, 4), { ...options, maxCommandBytes: 40 })).rejects.toThrow("limit");
    await expect(parseReceivePack(body(wire, 4), { ...options, maxCommands: 1 })).rejects.toThrow("limit");
    await expect(parseReceivePack(body(wire), { ...options, maxCommands: NaN })).rejects.toThrow("limit");
  });

  it("aborts an incomplete command even when source cancellation never settles", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const source = new ReadableStream<Uint8Array>({ cancel });
    const parsed = parseReceivePack(source, { ...options, signal: controller.signal });
    controller.abort(new Error("push deadline"));
    await expect(parsed).rejects.toThrow("push deadline");
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("propagates consumer cancellation and aborts after header parsing", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(join(packet(command()), encoder.encode("0000"))); }, cancel }, { highWaterMark: 0 });
    const parsed = await parseReceivePack(source, { ...options, signal: controller.signal });
    controller.abort(new Error("push deadline"));
    await expect(bytes(parsed.pack)).rejects.toThrow("push deadline");
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
    const secondCancel = vi.fn();
    const second = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(join(packet(command()), encoder.encode("0000"))); }, cancel: secondCancel }, { highWaterMark: 0 });
    const other = await parseReceivePack(second, options);
    await other.pack.cancel("policy denied");
    expect(secondCancel).toHaveBeenCalledWith("policy denied");
    expect(second.locked).toBe(false);
  });

  it("parses an actual native Git HTTP push and preserves its verified pack", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gitfoundry-push-parser-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target.git");
    const git = (args: string[], cwd = root, input?: string | Uint8Array) => execFileSync("git", args, { cwd, input, stdio: ["pipe", "pipe", "pipe"] });
    git(["init", "--bare", target]); git(["init", source]);
    const blob = git(["hash-object", "-w", "--stdin"], source, "gitfoundry parser fixture\n").toString().trim();
    const tree = git(["mktree"], source, "100644 blob " + blob + "\tREADME.md\n").toString().trim();
    const oid = git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", tree, "-m", "fixture"], source).toString().trim();
    git(["update-ref", "refs/heads/main", oid], source);
    let captured: Uint8Array | undefined;
    const server = createServer(async (request, response) => {
      try {
        if (request.method === "GET") {
          response.writeHead(200, { "content-type": "application/x-git-receive-pack-advertisement" });
          response.end(join(packet("# service=git-receive-pack\n"), encoder.encode("0000"), git(["receive-pack", "--stateless-rpc", "--advertise-refs", target])));
        } else {
          const chunks: Uint8Array[] = [];
          for await (const chunk of request) chunks.push(chunk);
          captured = join(...chunks);
          response.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
          response.end(git(["receive-pack", "--stateless-rpc", target], root, captured));
        }
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server unavailable");
      await promisify(execFile)("git", ["-c", "http.proxy=", "-c", "http.followRedirects=false", "push", "http://127.0.0.1:" + address.port + "/target.git", "refs/heads/main:refs/heads/main"], { cwd: source, timeout: 10000 });
      expect(git(["rev-parse", "refs/heads/main"], target).toString().trim()).toBe(oid);
      expect(git(["cat-file", "-p", oid + ":README.md"], target).toString()).toBe("gitfoundry parser fixture\n");
      if (!captured) throw new Error("push request missing");
      const wireCapabilities = new TextDecoder().decode(captured.subarray(4, Number.parseInt(new TextDecoder().decode(captured.subarray(0, 4)), 16))).split("\0")[1];
      let parsed;
      try { parsed = await parseReceivePack(body(captured, 7), options); }
      catch (error) { throw new Error(String(error) + " native fixture capabilities: " + JSON.stringify(wireCapabilities)); }
      expect(parsed.commands).toEqual([{ ref: "refs/heads/main", oldOid: null, newOid: oid }]);
      const pack = await bytes(parsed.pack);
      expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");
      const packOffset = Buffer.from(captured).indexOf(Buffer.from("PACK"));
      expect(packOffset).toBeGreaterThan(0);
      expect(pack).toEqual(captured.subarray(packOffset));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
