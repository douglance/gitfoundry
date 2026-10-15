import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { handleGitHubWorkflowRequest } from "./http.js";
import { makeGitHubWorkflowWorkerPorts, type GitHubWorkflowWorkerEnv } from "./worker-ports.js";
import { SourceReadUnavailableError, type ForgeTreePage, type SourceFileResponse, type SourceReadPort } from "../source-read.js";

const tenantId = "tenant-a";
const repositoryId = "repo-a";
const repository = "core/gitfoundry";
const actorId = "owner-a";
const versionCommit = "a".repeat(40);
const codeCommit = "b".repeat(40);
const workflowContents = "name: ci\non: [push]\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo hi\n";
const baseUrl = "https://gitfoundry.dev";

class SqliteD1 {
  constructor(readonly db = new DatabaseSync(":memory:")) {
    db.exec(readFileSync(new URL("../../../../infra/migrations/0009_github_workflow_runs.sql", import.meta.url), "utf8"));
  }

  async batch(statements: readonly { run(): Promise<any> }[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  prepare(sql: string) {
    const database = this.db;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) { return { ...this, values }; },
      async first<T>() { return database.prepare(sql).get(...(this.values as SQLInputValue[])) as T | null; },
      async all<T>() { return { results: database.prepare(sql).all(...(this.values as SQLInputValue[])) as T[] }; },
      async run() {
        const result = database.prepare(sql).run(...(this.values as SQLInputValue[]));
        return { success: true, meta: { changes: Number(result.changes) } };
      }
    };
  }
}

class FakeSourceRead implements SourceReadPort {
  readonly treeCalls: unknown[] = [];
  readonly readFileCalls: unknown[] = [];

  tree(input: Parameters<SourceReadPort["tree"]>[0]) {
    this.treeCalls.push(input);
    return Effect.succeed({
      items: [{ path: ".github/workflows/ci.yml", path_base64: null, mode: "100644", kind: "blob", sha: sha256(workflowContents), size_bytes: workflowContents.length }],
      next_cursor: null,
      has_more: false,
      repository_id: input.repositoryId,
      resolved_sha: input.ref,
      tree_sha: input.ref,
      truncated: false,
      truncation_reason: null
    } satisfies ForgeTreePage);
  }

  diff(input: Parameters<SourceReadPort["diff"]>[0]) {
    return Effect.fail(new SourceReadUnavailableError({ code: "unsupported", reason: "diff should not be used by workflow dispatch", repositoryId: input.repositoryId }));
  }

  readFile(input: Parameters<SourceReadPort["readFile"]>[0]) {
    this.readFileCalls.push(input);
    return Effect.succeed({
      repository_id: input.repositoryId,
      resolved_sha: input.ref,
      path: input.path,
      sha: sha256(workflowContents),
      size_bytes: workflowContents.length,
      encoding: "utf-8",
      contents: workflowContents,
      truncated: false
    } satisfies SourceFileResponse);
  }
}

class FakeActionsBackendStub {
  readonly requests: Array<{ readonly url: string; readonly method: string; readonly headers: Headers }> = [];

  async fetch(request: Request): Promise<Response> {
    this.requests.push({ url: request.url, method: request.method, headers: new Headers(request.headers) });
    const url = new URL(request.url);
    if (url.pathname !== "/runner/server/_apis/v1/Message/schedule2") return Response.json({ error: "unexpected_backend_route" }, { status: 500 });
    return sse("event: job\ndata: {\"runid\":123,\"status\":\"queued\"}\n\n");
  }
}

class FakeActionsNamespace {
  readonly names: string[] = [];
  readonly stub = new FakeActionsBackendStub();

  idFromName(name: string) {
    this.names.push(name);
    return name as unknown as DurableObjectId;
  }

  get() {
    return this.stub as unknown as DurableObjectStub;
  }
}

function env(extra: Partial<GitHubWorkflowWorkerEnv> = {}): GitHubWorkflowWorkerEnv {
  return {
    GFY_ACTIONS_OWNER_TENANT_ID: tenantId,
    GFY_ACTIONS_OWNER_REPOSITORY_ID: repositoryId,
    GFY_ACTIONS_OWNER_REPOSITORY: repository,
    GFY_ACTIONS_STORAGE_GENERATION: "generation-a",
    ...extra
  };
}

function ports(input: {
  readonly env?: GitHubWorkflowWorkerEnv;
  readonly apiResponse?: unknown;
  readonly apiStatus?: number;
  readonly authenticate?: ReturnType<typeof vi.fn>;
  readonly apiEnv?: unknown;
} = {}) {
  const calls: Array<{ readonly url: string; readonly method: string; readonly authorization: string | null; readonly env: unknown }> = [];
  const authenticate = input.authenticate ?? vi.fn(async () => ({ ok: true as const, actor_id: actorId }));
  const apiEnv = input.apiEnv ?? { forge: true };
  const fetchApi = vi.fn(async (request: Request, requestEnv: unknown) => {
    calls.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization"), env: requestEnv });
    return Response.json(input.apiResponse ?? validVersionBody(), { status: input.apiStatus ?? 200 });
  });
  return {
    calls,
    authenticate,
    fetchApi,
    ports: makeGitHubWorkflowWorkerPorts(input.env ?? env(), { authenticateOwner: authenticate, fetchApi, forgeEnv: apiEnv })
  };
}

describe("GitHub workflow Worker ports", () => {
  it("falls through non-workflow API routes before auth or API fetch", async () => {
    const p = ports();

    const response = await handleGitHubWorkflowRequest(new Request(`${baseUrl}/api/v2/tenants/${tenantId}/repositories/${repositoryId}/forge/versions/${versionCommit}`), p.ports);

    expect(response).toBeUndefined();
    expect(p.authenticate).not.toHaveBeenCalled();
    expect(p.fetchApi).not.toHaveBeenCalled();
  });

  it("maps mutation auth denial and performs no version, source, store, or backend work", async () => {
    const namespace = new FakeActionsNamespace();
    const p = ports({
      env: env({ GITHUB_ACTIONS_BACKEND: namespace as unknown as DurableObjectNamespace }),
      authenticate: vi.fn(async () => ({ ok: false as const, response: Response.json({ error: "denied" }, { status: 403 }) }))
    });

    const response = await handleGitHubWorkflowRequest(dispatchRequest("workflow-op-denied"), p.ports);

    expect(response?.status).toBe(403);
    expect(p.authenticate).toHaveBeenCalledWith(expect.any(Request), tenantId, "repository.write");
    expect(p.fetchApi).not.toHaveBeenCalled();
    expect(namespace.names).toEqual([]);
  });

  it("verifies versions through direct API fetch with the original authorization headers", async () => {
    const apiEnv = { marker: "with-forge-backend" };
    const p = ports({ apiEnv });

    const response = await handleGitHubWorkflowRequest(dispatchRequest("workflow-op-forged-code", { codeCommit: "c".repeat(40) }), p.ports);

    expect(response?.status).toBe(403);
    expect(p.fetchApi).toHaveBeenCalledTimes(1);
    const call = p.calls[0];
    expect(call?.env).toBe(apiEnv);
    expect(call?.method).toBe("GET");
    expect(new URL(call!.url).pathname).toBe(`/api/v2/tenants/${tenantId}/repositories/${repositoryId}/forge/versions/${versionCommit}`);
    expect(call?.authorization).toBe("Bearer owner-token");
  });

  it("fails closed when the forge version descriptor belongs to another repository", async () => {
    const namespace = new FakeActionsNamespace();
    const p = ports({
      env: env({ GITHUB_ACTIONS_BACKEND: namespace as unknown as DurableObjectNamespace }),
      apiResponse: validVersionBody({ descriptor: { tenant_id: "tenant-b" } })
    });

    const response = await handleGitHubWorkflowRequest(dispatchRequest("workflow-op-mismatch"), p.ports);

    expect(response?.status).toBe(503);
    await expect(response!.json()).resolves.toMatchObject({ error: "workflow_version_unavailable" });
    expect(namespace.names).toEqual([]);
  });

  it("wires verified source, D1 store, and actions backend stub for dispatch", async () => {
    const source = new FakeSourceRead();
    const db = new SqliteD1();
    const namespace = new FakeActionsNamespace();
    const p = ports({ env: env({ GFY_SOURCE_READ: source, GFY_DB: db, GITHUB_ACTIONS_BACKEND: namespace as unknown as DurableObjectNamespace }) });

    const response = await handleGitHubWorkflowRequest(dispatchRequest("workflow-op-dispatch"), p.ports);

    expect(response?.status).toBe(202);
    await expect(response!.json()).resolves.toMatchObject({ state: "pending", run: { operation_id: "workflow-op-dispatch", code_commit: codeCommit } });
    expect(source.treeCalls).toEqual([{ tenantId, repositoryId, ref: codeCommit, path: ".github/workflows", recursive: true, direction: "asc", limit: 1000 }]);
    expect(source.readFileCalls).toEqual([{ tenantId, repositoryId, ref: codeCommit, path: ".github/workflows/ci.yml", maxBytes: 1024 * 1024 }]);
    expect(namespace.names).toEqual(["actions-github:generation-a"]);
    expect(namespace.stub.requests).toHaveLength(1);
    const backendRequest = namespace.stub.requests[0]!;
    expect(backendRequest.method).toBe("POST");
    expect(new URL(backendRequest.url).pathname).toBe("/runner/server/_apis/v1/Message/schedule2");
    expect(backendRequest.headers.get("X-GitFoundry-Tenant")).toBe(tenantId);
    expect(backendRequest.headers.get("X-GitFoundry-Code-Commit")).toBe(codeCommit);
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM github_workflow_runs WHERE operation_id = ?").get("workflow-op-dispatch")?.count).toBe(1);
  });
});

function dispatchRequest(operationId: string, extra: Record<string, unknown> = {}): Request {
  return new Request(`${baseUrl}/api/v2/tenants/${tenantId}/repositories/${repositoryId}/actions/runs`, {
    method: "POST",
    headers: { authorization: "Bearer owner-token", "content-type": "application/json", "idempotency-key": operationId },
    body: JSON.stringify({ operationId, versionCommit, event: { name: "workflow_dispatch", payload: { ref: "main" } }, ...extra })
  });
}

function validVersionBody(extra: { readonly version_commit?: string; readonly descriptor?: Record<string, unknown> } = {}) {
  return {
    version: {
      version_commit: extra.version_commit ?? versionCommit,
      descriptor: {
        schema_version: 1,
        fork_id: "fork-a",
        tenant_id: tenantId,
        repository_id: repositoryId,
        parents: [],
        code_commit: codeCommit,
        state_commit: "c".repeat(40),
        creator_id: actorId,
        creator_kind: "human",
        operation_id: "forge-op-a",
        request_digest: "sha256:fixture",
        ...extra.descriptor
      }
    }
  };
}

function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
