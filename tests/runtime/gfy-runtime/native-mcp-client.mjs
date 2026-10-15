import { spawn } from "node:child_process";
import readline from "node:readline";

export class NativeGfyMcpClient {
  constructor({ child, stdin, stdout, stderrLines }) {
    this.child = child;
    this.stdin = stdin;
    this.stderrLines = stderrLines;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    stdout.on("line", (line) => this.#handleLine(line));
    child.once("exit", (code, signal) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`gfy exited before JSON-RPC response: code=${code} signal=${signal} stderr=${this.stderrTail()}`));
      }
      this.pending.clear();
    });
  }

  static start({ binary, cwd, env }) {
    const child = spawn(binary, ["--mcp"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stderrLines = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        stderrLines.push(line.slice(0, 400));
        if (stderrLines.length > 20) stderrLines.shift();
      }
    });
    return new NativeGfyMcpClient({
      child,
      stdin: child.stdin,
      stdout: readline.createInterface({ input: child.stdout }),
      stderrLines
    });
  }

  async initialize() {
    const initialized = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "gitfoundry-gfy-runtime-harness", version: "0" }
    });
    this.notify("notifications/initialized", {});
    return initialized;
  }

  listTools() {
    return this.request("tools/list", {});
  }

  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }

  request(method, params = {}, timeoutMs = 10_000) {
    if (this.closed) throw new Error(`gfy is closed: ${this.stderrTail()}`);
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const body = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}: ${this.stderrTail()}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.stdin.write(body, "utf8", (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  notify(method, params = {}) {
    if (this.closed) return;
    this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8");
  }

  async close() {
    this.closed = true;
    this.stdin.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }
  }

  stderrTail() {
    return this.stderrLines.slice(-5).join(" | ");
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line.trim());
    } catch (error) {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.resolve(message);
  }
}

export function toolPayload(response) {
  if (response?.error) throw new Error(JSON.stringify(response.error));
  const result = response?.result;
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, "structuredContent")) return result.structuredContent;
  const text = result.content?.find?.((entry) => entry.type === "text")?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return result;
}

export function unwrapToolValue(value) {
  let current = value;
  for (let index = 0; index < 8; index += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return current;
    if (Object.prototype.hasOwnProperty.call(current, "data")) { current = current.data; continue; }
    if (Object.prototype.hasOwnProperty.call(current, "structuredContent")) { current = current.structuredContent; continue; }
    if (Object.prototype.hasOwnProperty.call(current, "result") && !Object.prototype.hasOwnProperty.call(current, "id")) { current = current.result; continue; }
    if (Object.prototype.hasOwnProperty.call(current, "value")) { current = current.value; continue; }
    return current;
  }
  return current;
}
