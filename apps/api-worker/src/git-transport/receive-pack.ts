export interface ReceivePackCommand {
  readonly ref: string;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

export interface ReceivePackOptions {
  readonly advertisedCapabilities: ReadonlySet<string>;
  readonly maxCommandBytes?: number;
  readonly maxCommands?: number;
  readonly signal?: AbortSignal;
}

export interface ReceivePackRequest {
  readonly commands: readonly ReceivePackCommand[];
  readonly capabilities: readonly string[];
  readonly pack: ReadableStream<Uint8Array>;
}

export class ReceivePackInputError extends Error {
  readonly name = "ReceivePackInputError";
}

const zeroOid = "0".repeat(40);
const implementedCapabilities = new Set(["report-status", "report-status-v2", "side-band-64k", "ofs-delta", "delete-refs", "atomic", "quiet", "agent", "object-format"]);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function parseReceivePack(body: ReadableStream<Uint8Array>, options: ReceivePackOptions): Promise<ReceivePackRequest> {
  const maxBytes = positiveLimit(options.maxCommandBytes ?? 64 * 1024, 256 * 1024);
  const maxCommands = positiveLimit(options.maxCommands ?? 128, 1024);
  const reader = body.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0;
  let released = false;
  let packController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let aborted: unknown;
  let rejectAbort: (reason: unknown) => void = () => {};
  const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
  // Abort may occur while the pack consumer is idle.
  void abortPromise.catch(() => {});
  function release(): void {
    if (released) return;
    released = true;
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  function cancel(reason: unknown): void {
    if (released) return;
    void reader.cancel(reason).catch(() => {});
    release();
  }
  function onAbort(): void {
    aborted = options.signal?.reason ?? new Error("receive-pack aborted");
    rejectAbort(aborted);
    packController?.error(aborted);
    cancel(aborted);
  }
  async function nextChunk(): Promise<boolean> {
    if (aborted !== undefined) throw aborted;
    const next = await Promise.race([reader.read(), abortPromise]);
    if (next.done) return false;
    if (!(next.value instanceof Uint8Array)) throw new ReceivePackInputError("receive-pack body must contain bytes");
    chunk = next.value;
    offset = 0;
    return true;
  }
  async function take(count: number): Promise<Uint8Array> {
    const out = new Uint8Array(count);
    let written = 0;
    while (written < count) {
      if (offset === chunk.length && !await nextChunk()) throw new ReceivePackInputError("truncated receive-pack command");
      const available = Math.min(count - written, chunk.length - offset);
      out.set(chunk.subarray(offset, offset + available), written);
      offset += available;
      written += available;
    }
    return out;
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const commands: ReceivePackCommand[] = [];
    let capabilities: string[] = [];
    let commandBytes = 0;
    for (;;) {
      commandBytes += 4;
      if (commandBytes > maxBytes) throw new ReceivePackInputError("receive-pack command byte limit exceeded");
      const header = decoder.decode(await take(4));
      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new ReceivePackInputError("invalid receive-pack packet length");
      const length = Number.parseInt(header, 16);
      if (length === 0) break;
      if (length <= 4 || length > 65520) throw new ReceivePackInputError("invalid receive-pack packet length");
      if (commands.length >= maxCommands) throw new ReceivePackInputError("receive-pack command count limit exceeded");
      commandBytes += length - 4;
      if (commandBytes > maxBytes) throw new ReceivePackInputError("receive-pack command byte limit exceeded");
      let text = decoder.decode(await take(length - 4));
      if (text.endsWith("\n")) text = text.slice(0, -1);
      const nul = text.indexOf("\0");
      if (nul !== -1) {
        if (commands.length !== 0 || text.indexOf("\0", nul + 1) !== -1) throw new ReceivePackInputError("capabilities are allowed only on the first command");
        capabilities = parseCapabilities(text.slice(nul + 1), options.advertisedCapabilities);
        text = text.slice(0, nul);
      }
      const match = /^([0-9a-fA-F]{40}) ([0-9a-fA-F]{40}) (.+)$/u.exec(text);
      if (!match) throw new ReceivePackInputError("invalid receive-pack ref command");
      const oldOid = match[1]!.toLowerCase();
      const newOid = match[2]!.toLowerCase();
      const ref = match[3]!;
      if (!validRef(ref)) throw new ReceivePackInputError("invalid or unsupported receive-pack ref");
      if (oldOid === zeroOid && newOid === zeroOid) throw new ReceivePackInputError("ref command cannot have two absent object IDs");
      if (newOid === zeroOid && !options.advertisedCapabilities.has("delete-refs")) throw new ReceivePackInputError("ref deletion was not advertised");
      if (commands.some((other) => other.ref === ref || other.ref.startsWith(ref + "/") || ref.startsWith(other.ref + "/"))) throw new ReceivePackInputError("duplicate or conflicting receive-pack ref");
      commands.push({ ref, oldOid: oldOid === zeroOid ? null : oldOid, newOid: newOid === zeroOid ? null : newOid });
    }
    if (commands.length === 0) throw new ReceivePackInputError("receive-pack command list is empty");
    const pack = new ReadableStream<Uint8Array>({
      start(controller) { packController = controller; },
      async pull(controller) {
        try {
          if (aborted !== undefined) throw aborted;
          while (offset === chunk.length) {
            if (!await nextChunk()) { release(); controller.close(); return; }
          }
          const remainder = chunk.subarray(offset);
          offset = chunk.length;
          controller.enqueue(remainder);
        } catch (error) { cancel(error); controller.error(error); }
      },
      cancel(reason) { cancel(reason); }
    }, { highWaterMark: 0 });
    return { commands, capabilities, pack };
  } catch (error) {
    cancel(error);
    throw error;
  }
}

function positiveLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ReceivePackInputError("invalid receive-pack limit");
  return value;
}

function parseCapabilities(text: string, advertised: ReadonlySet<string>): string[] {
  text = text.replace(/^ +| +$/g, "");
  if (!text || !/^[!-~]+(?: +[!-~]+)*$/.test(text)) throw new ReceivePackInputError("invalid receive-pack capabilities");
  const capabilities = text.split(/ +/);
  const seen = new Set<string>();
  for (const capability of capabilities) {
    const name = capability.split("=")[0]!;
    if (seen.has(name) || !implementedCapabilities.has(name) || !advertised.has(name)) throw new ReceivePackInputError("unsupported or duplicate receive-pack capability");
    if (name === "agent" ? !/^agent=[!-~]{1,256}$/.test(capability) : name === "object-format" ? capability !== "object-format=sha1" : capability !== name) throw new ReceivePackInputError("invalid receive-pack capability value");
    seen.add(name);
  }
  return capabilities;
}

function validRef(ref: string): boolean {
  if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/")) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/u.test(ref) || ref.includes("..") || ref.includes("@{") || ref.endsWith(".")) return false;
  return ref.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
