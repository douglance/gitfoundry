import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../../../../packages/core/src/live/index.js";
import type { ArtifactsBinding, WorkersArtifactsCreateTokenResult, WorkersArtifactsRepoInfo } from "../git-provider.js";
import { handleGitTransportRequest } from "./index.js";

const timestamp = "2026-10-08T00:00:00.000Z";
const namespace = "gitfoundry-staging";
const name = "stored-provider-name";
const providerTokenPlaintext = "fixture-provider-read-token";
const clientCredential = "fixture-client-credential";
const firstReadme = "gitfoundry native transport fixture\nfirst object bytes\n";
const secondReadme = "gitfoundry native transport fixture\nsecond object bytes\n";

describe("Git transport child process fixture", () => {
  it("handles a child closing stdin early without masking its exit status", async () => {
    const input = Buffer.alloc(2 * 1024 * 1024);
    const success = await runCommandBuffer(process.execPath, ["-e", "process.exit(0)"], process.cwd(), stringEnv(process.env), input);
    expect(success.stdout).toEqual(Buffer.alloc(0));
    await expect(runCommandBuffer(process.execPath, ["-e", "process.exit(17)"], process.cwd(), stringEnv(process.env), input)).rejects.toThrow("failed 17");
  });
});

class SqliteD1 implements D1DatabaseLike {
  readonly db = new DatabaseSync(":memory:");

  prepare<T = Record<string, unknown>>(sql: string): D1PreparedStatement<T> {
    const statement = this.db.prepare(sql);
    return {
      bind: (...values: readonly unknown[]) => {
        const sqliteValues = values as readonly SQLInputValue[];
        return {
          bind: (...nextValues: readonly unknown[]) => this.prepare<T>(sql).bind(...nextValues),
          first: async <R = T>() => statement.get(...sqliteValues) as R | null,
          all: async <R = T>() => ({ results: statement.all(...sqliteValues) as R[], success: true }) satisfies D1Result<R>,
          run: async () => { statement.run(...sqliteValues); return { success: true } satisfies D1Result<T> }
        };
      },
      first: async <R = T>() => statement.get() as R | null,
      all: async <R = T>() => ({ results: statement.all() as R[], success: true }) satisfies D1Result<R>,
      run: async () => { statement.run(); return { success: true } satisfies D1Result<T> }
    };
  }
}

class FakeRepo {
  readonly tokenCalls: Array<{ scope: "read" | "write" | undefined; ttl: number | undefined }> = [];
  readonly revokedTokens: string[] = [];
  disposed = false;
  infoValue: WorkersArtifactsRepoInfo = repoInfo(namespace, name);

  async info(): Promise<WorkersArtifactsRepoInfo> { return this.infoValue }
  async createToken(scope?: "read" | "write", ttl?: number): Promise<WorkersArtifactsCreateTokenResult> {
    this.tokenCalls.push({ scope, ttl });
    return tokenResult(`token-${this.tokenCalls.length}`, providerTokenPlaintext);
  }
  async revokeToken(token: string): Promise<boolean> {
    this.revokedTokens.push(token);
    return true;
  }
  [Symbol.dispose](): void { this.disposed = true }
}

class FakeArtifacts {
  readonly getCalls: string[] = [];
  readonly repos = new Map<string, FakeRepo>();

  async get(repoName: string): Promise<FakeRepo> {
    this.getCalls.push(repoName);
    const repo = this.repos.get(repoName);
    if (!repo) throw new Error("missing repo");
    return repo;
  }
  async create(): Promise<never> { throw new Error("create not used") }
  async list(): Promise<{ repos: []; total: number }> { return { repos: [], total: 0 } }
}

class HttpHarness {
  readonly sql = fixture();
  readonly repo = new FakeRepo();
  readonly artifacts = new FakeArtifacts();
  readonly authorizeCalls: Array<{ tenantId: string; capability: "repository.read" | "repository.write"; sawCallerCredential: boolean }> = [];
  readonly providerUrls: string[] = [];
  readonly waitUntilPromises: Promise<unknown>[] = [];
  forwardedClientCredential = false;
  readGrantActive = true;

  constructor(readonly origin: OriginServer) {
    this.artifacts.repos.set(name, this.repo);
  }

  env() {
    return { GFY_DB: this.sql, GFY_GIT: this.artifacts as unknown as ArtifactsBinding, GFY_GIT_NAMESPACE: namespace };
  }

  deps() {
    return {
      authorize: async (request: Request, tenantId: string, capability: "repository.read" | "repository.write") => {
        this.authorizeCalls.push({ tenantId, capability, sawCallerCredential: request.headers.get("authorization")?.includes(clientCredential) === true });
        return this.readGrantActive ? undefined : new Response("denied", { status: 403 });
      },
      originFetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        const upstream = new URL(String(url));
        this.providerUrls.push(upstream.toString());
        expect(upstream.protocol).toBe("https:");
        expect(upstream.host).toBe("artifacts.example");
        expect(upstream.pathname).toMatch(new RegExp(`^/git/${namespace}/${name}\\.git/(info/refs|git-upload-pack)$`));
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${providerTokenPlaintext}`);
        this.forwardedClientCredential ||= Array.from(headers.values()).some((value) => value.includes(clientCredential));
        const local = new URL(this.origin.url);
        local.pathname = upstream.pathname;
        local.search = upstream.search;
        return await fetch(local, init);
      },
      waitUntil: (promise: Promise<unknown>) => { this.waitUntilPromises.push(promise) }
    };
  }

  async flushWaitUntil(): Promise<void> {
    await Promise.all(this.waitUntilPromises.splice(0));
  }
}

describe("Git transport native HTTP fixture", () => {
  it("moves ls-remote, clone, and fetch object data through the gateway with server-side provider credentials", async () => {
    const temp = await mkdtemp(join(tmpdir(), "gitfoundry-transport-"));
    let origin: OriginServer | undefined;
    let gateway: GatewayServer | undefined;
    try {
      const repository = await createNativeRepository(temp);
      origin = await startOriginServer(repository.projectRoot);
      const harness = new HttpHarness(origin);
      gateway = await startGatewayServer(harness);
      const gatewayRepoUrl = `${gateway.url}/git/${namespace}/${name}.git`;

      const listed = await runGit(clientGitArgs("2", ["ls-remote", gatewayRepoUrl]), temp);
      expect(listed.stdout).toContain(repository.firstCommit);
      expect(harness.authorizeCalls.some((call) => call.sawCallerCredential)).toBe(true);

      const cloneDir = join(temp, "clone");
      await runGit(clientGitArgs("1", ["clone", gatewayRepoUrl, cloneDir]), temp);
      await harness.flushWaitUntil();
      expect(await readFile(join(cloneDir, "README.md"), "utf8")).toBe(firstReadme);
      expect((await runGit(["-C", cloneDir, "rev-parse", "HEAD"], temp)).stdout.trim()).toBe(repository.firstCommit);

      const secondCommit = await pushSecondCommit(repository.worktree);
      await runGit(clientGitArgs("2", ["-C", cloneDir, "fetch", "origin", "main"]), temp);
      await harness.flushWaitUntil();
      expect((await runGit(["-C", cloneDir, "rev-parse", "FETCH_HEAD"], temp)).stdout.trim()).toBe(secondCommit);
      expect((await runGit(["-C", cloneDir, "show", "FETCH_HEAD:README.md"], temp)).stdout).toBe(secondReadme);

      await harness.flushWaitUntil();
      expect(harness.repo.tokenCalls.every((call) => call.scope === "read" && call.ttl === 60)).toBe(true);
      expect(harness.repo.revokedTokens).toHaveLength(harness.repo.tokenCalls.length);
      expect(new Set(harness.repo.revokedTokens).size).toBe(harness.repo.revokedTokens.length);
      expect(harness.forwardedClientCredential).toBe(false);
      expect(origin.sawClientCredential).toBe(false);
      expect(origin.calls.some((call) => call.protocol === "version=2")).toBe(true);
      expect(origin.calls.some((call) => call.path.endsWith("/git-upload-pack"))).toBe(true);
      expect(harness.providerUrls.every((url) => url.startsWith(`https://artifacts.example/git/${namespace}/${name}.git/`))).toBe(true);

      const providerCallCount = origin.calls.length;
      const tokenCallCount = harness.repo.tokenCalls.length;
      harness.readGrantActive = false;
      await expect(runGit(clientGitArgs("2", ["ls-remote", gatewayRepoUrl]), temp)).rejects.toThrow(/git failed/);
      await harness.flushWaitUntil();
      expect(origin.calls).toHaveLength(providerCallCount);
      expect(harness.repo.tokenCalls).toHaveLength(tokenCallCount);
    } finally {
      await gateway?.close();
      await origin?.close();
      await rm(temp, { recursive: true, force: true });
    }
  }, 60_000);
});

interface NativeRepository {
  readonly projectRoot: string;
  readonly worktree: string;
  readonly firstCommit: string;
}

interface OriginCall {
  readonly path: string;
  readonly protocol: string | undefined;
}

interface OriginServer {
  url: string;
  readonly calls: OriginCall[];
  sawClientCredential: boolean;
  close: () => Promise<void>;
}

interface GatewayServer {
  readonly url: string;
  close: () => Promise<void>;
}

async function createNativeRepository(temp: string): Promise<NativeRepository> {
  const projectRoot = join(temp, "origin-root");
  const bare = join(projectRoot, "git", namespace, `${name}.git`);
  const worktree = join(temp, "source");
  await mkdir(join(projectRoot, "git", namespace), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await runGit(["init", "-b", "main"], worktree);
  await writeFile(join(worktree, "README.md"), firstReadme, "utf8");
  await runGit(["add", "README.md"], worktree);
  await commit(worktree, "first fixture commit");
  const firstCommit = (await runGit(["rev-parse", "HEAD"], worktree)).stdout.trim();
  await runGit(["init", "--bare", bare], temp);
  await runGit(["remote", "add", "origin", bare], worktree);
  await runGit(["push", "origin", "main"], worktree);
  await runGit(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"], temp);
  return { projectRoot, worktree, firstCommit };
}

async function pushSecondCommit(worktree: string): Promise<string> {
  await writeFile(join(worktree, "README.md"), secondReadme, "utf8");
  await runGit(["add", "README.md"], worktree);
  await commit(worktree, "second fixture commit");
  const secondCommit = (await runGit(["rev-parse", "HEAD"], worktree)).stdout.trim();
  await runGit(["push", "origin", "main"], worktree);
  return secondCommit;
}

async function commit(cwd: string, message: string): Promise<void> {
  await runGit(["-c", "user.name=GitFoundry Fixture", "-c", "user.email=fixture@gitfoundry.invalid", "commit", "-m", message], cwd);
}

async function startOriginServer(projectRoot: string): Promise<OriginServer> {
  const calls: OriginCall[] = [];
  const origin: OriginServer = {
    url: "",
    calls,
    sawClientCredential: false,
    close: async () => undefined
  };
  const server = createServer(async (req, res) => {
    try {
      const authorization = header(req, "authorization");
      origin.sawClientCredential ||= authorization.includes(clientCredential);
      if (authorization !== `Bearer ${providerTokenPlaintext}`) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        res.end("unauthorized");
        return;
      }
      calls.push({ path: req.url ?? "", protocol: header(req, "git-protocol") || undefined });
      await runGitHttpBackend(req, res, projectRoot);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("origin fixture failed");
    }
  });
  const url = await listen(server);
  origin.url = url;
  origin.close = () => closeServer(server);
  return origin;
}

async function startGatewayServer(harness: HttpHarness): Promise<GatewayServer> {
  const server = createServer(async (req, res) => {
    try {
      const body = await collectIncoming(req);
      const headers = requestHeaders(req);
      const init: RequestInit & { duplex?: "half" } = { method: req.method ?? "GET", headers };
      if (body.length > 0) {
        init.body = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
        init.duplex = "half";
      }
      const response = await handleGitTransportRequest(new Request(`https://gitfoundry.example${req.url ?? "/"}`, init), harness.env(), harness.deps()) ?? new Response("not found", { status: 404 });
      const responseBody = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(responseBody);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("gateway fixture failed");
    }
  });
  const url = await listen(server);
  return { url, close: () => closeServer(server) };
}

async function runGitHttpBackend(req: IncomingMessage, res: ServerResponse, projectRoot: string): Promise<void> {
  const body = await collectIncoming(req);
  const requestUrl = new URL(req.url ?? "/", "http://origin.local");
  const env: Record<string, string> = {
    ...stringEnv(process.env),
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_PROJECT_ROOT: projectRoot,
    PATH_INFO: requestUrl.pathname,
    QUERY_STRING: requestUrl.search.slice(1),
    REQUEST_METHOD: req.method ?? "GET",
    CONTENT_LENGTH: String(body.length),
    CONTENT_TYPE: header(req, "content-type")
  };
  const gitProtocol = header(req, "git-protocol");
  if (gitProtocol) env.HTTP_GIT_PROTOCOL = gitProtocol;
  const output = await runCommandBuffer("git", ["http-backend"], projectRoot, env, body);
  const parsed = parseCgiResponse(output.stdout);
  res.writeHead(parsed.status, parsed.headers);
  res.end(parsed.body);
}

function parseCgiResponse(output: Buffer): { status: number; headers: Record<string, string>; body: Buffer } {
  let separator = output.indexOf(Buffer.from("\r\n\r\n", "binary"));
  let separatorLength = 4;
  if (separator < 0) {
    separator = output.indexOf(Buffer.from("\n\n", "binary"));
    separatorLength = 2;
  }
  if (separator < 0) throw new Error("missing git http-backend headers");
  const headerText = new TextDecoder("iso-8859-1").decode(output.subarray(0, separator)).replace(/\r\n/gu, "\n");
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of headerText.split("\n")) {
    const index = line.indexOf(":");
    if (index < 1) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (key.toLowerCase() === "status") {
      status = Number.parseInt(value, 10);
    } else {
      headers[key] = value;
    }
  }
  return { status, headers, body: output.subarray(separator + separatorLength) };
}

function clientGitArgs(protocol: "1" | "2", args: readonly string[]): string[] {
  return ["-c", `http.extraHeader=Authorization: Bearer ${clientCredential}`, "-c", `protocol.version=${protocol}`, ...args];
}

async function runGit(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return await runCommand("git", args, cwd, {
    ...stringEnv(process.env),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null"
  });
}

async function runCommand(executable: string, args: readonly string[], cwd: string, env: Record<string, string>, input?: Buffer): Promise<{ stdout: string; stderr: string }> {
  const result = await runCommandBuffer(executable, args, cwd, env, input);
  return { stdout: new TextDecoder().decode(result.stdout), stderr: result.stderr };
}

async function runCommandBuffer(executable: string, args: readonly string[], cwd: string, env: Record<string, string>, input?: Buffer): Promise<{ stdout: Buffer; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
      } else {
        reject(new Error(`${executable} failed ${code}: ${sanitizeGitArgs(args).join(" ")}\n${sanitizeGitOutput(err)}`));
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A backend may finish before consuming stdin; its exit status still decides success.
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

function sanitizeGitArgs(args: readonly string[]): string[] {
  return args.map((arg) => arg.includes(clientCredential) ? arg.replace(clientCredential, "<client-credential>") : arg);
}

function sanitizeGitOutput(output: string): string {
  return output.replaceAll(clientCredential, "<client-credential>").replaceAll(providerTokenPlaintext, "<provider-token>");
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function fixture(): SqliteD1 {
  const sql = new SqliteD1();
  sql.db.exec("CREATE TABLE repositories(tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, namespace_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL, default_branch TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, artifacts_namespace TEXT NOT NULL, artifacts_name TEXT NOT NULL, fork_of TEXT, PRIMARY KEY(tenant_id,id));");
  insertRepository(sql, { tenantId: "tenant-a", repositoryId: "repo-a", artifactsNamespace: namespace, artifactsName: name });
  return sql;
}

function insertRepository(sql: SqliteD1, input: { readonly tenantId: string; readonly repositoryId: string; readonly artifactsNamespace: string; readonly artifactsName: string }): void {
  sql.db.prepare("INSERT INTO repositories(tenant_id,id,version,created_at,updated_at,namespace_id,name,visibility,default_branch,archived,artifacts_namespace,artifacts_name,fork_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(input.tenantId, input.repositoryId, 1, timestamp, timestamp, "namespace-a", "demo", "private", "main", 0, input.artifactsNamespace, input.artifactsName, null);
}

function repoInfo(repoNamespace: string, repoName: string, remote = `https://artifacts.example/git/${repoNamespace}/${repoName}.git`): WorkersArtifactsRepoInfo {
  return { id: `provider-${repoName}`, name: repoName, description: null, defaultBranch: "main", createdAt: timestamp, updatedAt: timestamp, lastPushAt: null, source: null, readOnly: false, remote };
}

function tokenResult(id: string, plaintext: string): WorkersArtifactsCreateTokenResult {
  return { id, plaintext, scope: "read", expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

async function collectIncoming(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (typeof value === "string") headers.set(key, value);
  }
  return headers;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : "";
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
