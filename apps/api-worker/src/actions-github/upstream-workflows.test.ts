import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ActionsBackendError, type ActionsBackend } from "./backend.js";
import { WorkflowBackendRejectedError, WorkflowBackendUncertainAckError, type WorkflowBackendScheduleInput } from "./workflows.js";
import { makeUpstreamGitHubWorkflowBackend } from "./upstream-workflows.js";

const tenantId = "tenant-a";
const repositoryId = "repo-a";
const repository = "core/gitfoundry";
const runId = "run-a";
const operationId = "op-a";
const versionCommit = "a".repeat(40);
const codeCommit = "b".repeat(40);
const sourceDigest = "c".repeat(64);
const workflowContents = "name: ci\non: [push]\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo hi\n";

function input(extra: Partial<WorkflowBackendScheduleInput> = {}): WorkflowBackendScheduleInput {
  return {
    tenantId,
    repositoryId,
    repository,
    runId,
    operationId,
    versionCommit,
    codeCommit,
    actorId: "owner-a",
    event: { name: "push", payload: { ref: "refs/heads/main" } },
    sourceDigest,
    workflows: [{ path: ".github/workflows/ci.yml", contents: workflowContents, sha256: "d".repeat(64) }],
    ...extra
  };
}

describe("Runner.Server upstream workflow backend", () => {
  it.each(["operationId", "runId", "sourceDigest"] as const)("rejects a foreign %s even when repository and commits match", async field => {
    const eventPayload = JSON.stringify({ gitfoundry: {
      tenantId, repositoryId, repository, runId, operationId, versionCommit, codeCommit, sourceDigest, workflows: [],
      [field]: field === "sourceDigest" ? "e".repeat(64) : "foreign"
    } });
    const actions = new FakeActionsBackend(request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/attempts")) return Response.json([{ attempt: 1, eventPayload, sha: codeCommit, status: "completed", result: "succeeded" }]);
      if (path === "/runner/server/_apis/v1/Message") return Response.json([{ runid: 123, status: "completed", result: "succeeded" }]);
      throw new Error("A foreign run must never receive a mutation");
    });
    const backend = makeUpstreamGitHubWorkflowBackend(actions);
    await expect(Effect.runPromise(backend.inspect(identity("runner-server:123")))).rejects.toBeInstanceOf(WorkflowBackendRejectedError);
    await expect(Effect.runPromise(backend.cancel(identity("runner-server:123")))).rejects.toBeInstanceOf(WorkflowBackendRejectedError);
    expect(actions.requests.some(request => request.method === "POST")).toBe(false);
  });

  it("schedules immutable workflow files through Runner.Server schedule2 and persists runtime identity", async () => {
    let scheduledEvent!: Record<string, any>;
    const files: Record<string, string> = {};
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(async request => {
      const requestUrl = new URL(request.url);
      expect(request.method).toBe("POST");
      expect(requestUrl.pathname).toBe("/runner/server/_apis/v1/Message/schedule2");
      expect(requestUrl.searchParams.get("Repository")).toBe(repository);
      expect(requestUrl.searchParams.get("Sha")).toBe(codeCommit);
      expect(request.headers.get("X-GitHub-Event")).toBe("push");
      const form = await request.formData();
      scheduledEvent = JSON.parse(await (form.get("event") as File).text());
      for (const value of form.getAll("workflow") as File[]) files[value.name] = await value.text();
      return sse("event: job\ndata: {\"runid\":123,\"status\":\"queued\"}\n\n");
    }));

    const result = await Effect.runPromise(backend.schedule(input()));

    expect(result.backendRunId).toBe("runner-server:123");
    expect(files).toEqual({ ".github/workflows/ci.yml": workflowContents });
    expect(scheduledEvent.gitfoundry).toMatchObject({ tenantId, repositoryId, repository, runId, operationId, versionCommit, codeCommit, sourceDigest });
    expect(scheduledEvent.gitfoundry.workflows).toEqual([{ path: ".github/workflows/ci.yml", sha256: "d".repeat(64) }]);
    expect(scheduledEvent.repository.full_name).toBe(repository);
    expect(scheduledEvent.after).toBe(codeCommit);
  });

  it("tracks every top-level workflow run returned by Runner.Server schedule2", async () => {
    const seenFiles: string[] = [];
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(async request => {
      const form = await request.formData();
      for (const value of form.getAll("workflow") as File[]) seenFiles.push(value.name);
      return sse([
        "event: job\ndata: {\"runid\":123,\"status\":\"queued\"}\n\n",
        "event: job\ndata: {\"runid\":124,\"status\":\"queued\"}\n\n"
      ].join(""));
    }));

    const result = await Effect.runPromise(backend.schedule(input({ workflows: [
      { path: ".github/workflows/ci.yml", contents: workflowContents, sha256: "d".repeat(64) },
      { path: ".github/workflows/lint.yml", contents: workflowContents.replace("name: ci", "name: lint"), sha256: "e".repeat(64) }
    ] })));

    expect(result.backendRunId).toBe("runner-server:123,124");
    expect(seenFiles).toEqual([".github/workflows/ci.yml", ".github/workflows/lint.yml"]);
  });

  it("recovers skipped and reusable workflow run receipts from the durable native manifest", async () => {
    const seenFiles: string[] = [];
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(async request => {
      const url = new URL(request.url);
      if (url.pathname === "/runner/server/_apis/v1/Message/workflow/runs") return Response.json({ value: [
        runtimeRun(123, ".github/workflows/ci.yml"),
        runtimeRun(124, ".github/workflows/reusable.yml", { status: "completed", result: "skipped" })
      ] });
      if (url.pathname.endsWith("/workflow/run/123/attempts")) return Response.json([runtimeAttempt(1, manifest([
        [".github/workflows/ci.yml", "d".repeat(64)],
        [".github/workflows/reusable.yml", "e".repeat(64)]
      ]))]);
      if (url.pathname.endsWith("/workflow/run/124/attempts")) return Response.json([runtimeAttempt(1, manifest([
        [".github/workflows/ci.yml", "d".repeat(64)],
        [".github/workflows/reusable.yml", "e".repeat(64)]
      ]))]);
      const form = await request.formData();
      for (const value of form.getAll("workflow") as File[]) seenFiles.push(value.name);
      return sse("event: job\ndata: {\"runid\":123,\"status\":\"queued\"}\n\n");
    }));

    const result = await Effect.runPromise(backend.schedule(input({ workflows: [
      { path: ".github/workflows/ci.yml", contents: workflowContents.replace("on: [push]", '\"on\": [push]'), sha256: "d".repeat(64) },
      { path: ".github/workflows/reusable.yml", contents: "name: reusable\non:\n  workflow_call:\njobs:\n  helper:\n    runs-on: self-hosted\n    steps:\n      - run: echo helper\n", sha256: "e".repeat(64) }
    ] })));

    expect(result.backendRunId).toBe("runner-server:123,124");
    expect(seenFiles).toEqual([".github/workflows/ci.yml", ".github/workflows/reusable.yml"]);
  });

  it("treats an incomplete multi-workflow schedule acknowledgement as uncertain with partial runtime identity", async () => {
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(() => sse("event: job\ndata: {\"runid\":123,\"status\":\"queued\"}\n\n")));

    await expect(Effect.runPromise(backend.schedule(input({ workflows: [
      { path: ".github/workflows/ci.yml", contents: workflowContents, sha256: "d".repeat(64) },
      { path: ".github/workflows/lint.yml", contents: workflowContents.replace("name: ci", "name: lint"), sha256: "e".repeat(64) }
    ] })))).rejects.toMatchObject({ _tag: "WorkflowBackendUncertainAckError", backendRunId: "runner-server:partial:2:123" });
  });

  it("never inspects a partial acknowledgement as a complete workflow set", async () => {
    const actions = new FakeActionsBackend(() => { throw new Error("partial receipt must not reach runtime inspection"); });
    const backend = makeUpstreamGitHubWorkflowBackend(actions);
    await expect(Effect.runPromise(backend.inspect(identity("runner-server:partial:2:123")))).rejects.toBeInstanceOf(WorkflowBackendRejectedError);
    expect(actions.requests).toHaveLength(0);
  });

  it("recovers a lost schedule acknowledgement without retrying the schedule POST", async () => {
    const actions = new FakeActionsBackend(request => {
      const url = new URL(request.url);
      if (request.method === "POST") throw new ActionsBackendError({ operation: "proxy" });
      if (url.pathname === "/runner/server/_apis/v1/Message/workflow/runs") return Response.json({ value: [runtimeRun(123, ".github/workflows/ci.yml")] });
      if (url.pathname.endsWith("/workflow/run/123/attempts")) return Response.json([runtimeAttempt(1, manifest([[".github/workflows/ci.yml", "d".repeat(64)]]))]);
      throw new Error(`unexpected ${request.method} ${url.pathname}`);
    });
    const backend = makeUpstreamGitHubWorkflowBackend(actions);

    const result = await Effect.runPromise(backend.schedule(input()));

    expect(result.backendRunId).toBe("runner-server:123");
    expect(actions.requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("skips prior same-code workflow candidates from another operation before accepting the current manifest", async () => {
    const attemptsSeen: number[] = [];
    const actions = new FakeActionsBackend(request => {
      const url = new URL(request.url);
      if (request.method === "POST") throw new ActionsBackendError({ operation: "proxy" });
      if (url.pathname === "/runner/server/_apis/v1/Message/workflow/runs") return Response.json({ value: [
        runtimeRun(122, ".github/workflows/ci.yml"),
        runtimeRun(123, ".github/workflows/ci.yml")
      ] });
      if (url.pathname.endsWith("/workflow/run/122/attempts")) {
        attemptsSeen.push(122);
        return Response.json([runtimeAttempt(1, JSON.stringify({ gitfoundry: {
          tenantId, repositoryId, repository,
          runId: "previous-run", operationId: "previous-op",
          versionCommit, codeCommit, sourceDigest,
          workflows: [{ path: ".github/workflows/ci.yml", sha256: "d".repeat(64) }]
        } }))]);
      }
      if (url.pathname.endsWith("/workflow/run/123/attempts")) {
        attemptsSeen.push(123);
        return Response.json([runtimeAttempt(1, manifest([[".github/workflows/ci.yml", "d".repeat(64)]]))]);
      }
      throw new Error(`unexpected ${request.method} ${url.pathname}`);
    });
    const backend = makeUpstreamGitHubWorkflowBackend(actions);

    const result = await Effect.runPromise(backend.schedule(input()));

    expect(result.backendRunId).toBe("runner-server:123");
    expect(attemptsSeen).toEqual([122, 123]);
    expect(actions.requests.filter(request => request.method === "POST")).toHaveLength(1);
  });

  it("fails closed when recovery sees duplicate or foreign manifest candidates", async () => {
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(request => {
      const url = new URL(request.url);
      if (request.method === "POST") return sse("event: job\ndata: {\"runid\":123,\"status\":\"queued\"}\n\n");
      if (url.pathname === "/runner/server/_apis/v1/Message/workflow/runs") return Response.json({ value: [
        runtimeRun(123, ".github/workflows/ci.yml"),
        runtimeRun(124, ".github/workflows/ci.yml")
      ] });
      if (url.pathname.endsWith("/workflow/run/123/attempts")) return Response.json([runtimeAttempt(1, manifest([[".github/workflows/ci.yml", "d".repeat(64)]]))]);
      if (url.pathname.endsWith("/workflow/run/124/attempts")) return Response.json([runtimeAttempt(1, manifest([[".github/workflows/ci.yml", "f".repeat(64)]]))]);
      throw new Error(`unexpected ${url.pathname}`);
    }));

    await expect(Effect.runPromise(backend.schedule(input({ workflows: [
      { path: ".github/workflows/ci.yml", contents: workflowContents, sha256: "d".repeat(64) },
      { path: ".github/workflows/lint.yml", contents: workflowContents.replace("name: ci", "name: lint"), sha256: "e".repeat(64) }
    ] })))).rejects.toBeInstanceOf(WorkflowBackendUncertainAckError);
  });

  it("recovers runtime manifests from bounded paginated discovery", async () => {
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(request => {
      const url = new URL(request.url);
      if (request.method === "POST") return sse("event: end\ndata: {}\n\n");
      if (url.pathname === "/runner/server/_apis/v1/Message/workflow/runs" && url.searchParams.get("page") === "1") {
        return Response.json({ value: Array.from({ length: 30 }, (_, index) => runtimeRun(200 + index, `.github/workflows/foreign-${index}.yml`, { sha: "f".repeat(40) })) });
      }
      if (url.pathname === "/runner/server/_apis/v1/Message/workflow/runs" && url.searchParams.get("page") === "2") return Response.json({ value: [runtimeRun(123, ".github/workflows/ci.yml")] });
      if (url.pathname.endsWith("/workflow/run/123/attempts")) return Response.json([runtimeAttempt(1, manifest([[".github/workflows/ci.yml", "d".repeat(64)]]))]);
      throw new Error(`unexpected ${url.pathname}`);
    }));

    const result = await Effect.runPromise(backend.schedule(input()));

    expect(result.backendRunId).toBe("runner-server:123");
  });

  it("inspects exact runtime identity and refuses green status while jobs are incomplete", async () => {
    const eventPayload = JSON.stringify({ gitfoundry: { tenantId, repositoryId, repository, runId, operationId, versionCommit, codeCommit, sourceDigest, workflows: [{ path: ".github/workflows/ci.yml", sha256: "d".repeat(64) }] } });
    let jobsCompleted = false;
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/workflow/run/123/attempts")) return Response.json([{ attempt: 1, eventPayload, sha: codeCommit, status: "completed", result: "succeeded" }]);
      if (url.pathname.endsWith("/workflow/run/123/attempt/1/jobs")) return Response.json([{ runId: 123, status: jobsCompleted ? "completed" : "running", result: jobsCompleted ? "succeeded" : null }]);
      throw new Error(`unexpected ${url.pathname}`);
    }));

    const running = await Effect.runPromise(backend.inspect(identity("runner-server:123")));
    jobsCompleted = true;
    const completed = await Effect.runPromise(backend.inspect(identity("runner-server:123")));

    expect(running).toMatchObject({ status: "running", conclusion: null, tenantId, repositoryId, repository, versionCommit, codeCommit });
    expect(completed).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("aggregates inspection across every tracked runtime workflow run", async () => {
    const eventPayload = JSON.stringify({ gitfoundry: { tenantId, repositoryId, repository, runId, operationId, versionCommit, codeCommit, sourceDigest, workflows: [] } });
    let secondCompleted = false;
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/workflow/run/123/attempts")) return Response.json([{ attempt: 1, eventPayload, sha: codeCommit, status: "completed", result: "succeeded" }]);
      if (url.pathname.endsWith("/workflow/run/124/attempts")) return Response.json([{ attempt: 1, eventPayload, sha: codeCommit, status: secondCompleted ? "completed" : "running", result: secondCompleted ? "succeeded" : null }]);
      if (url.pathname.endsWith("/workflow/run/123/attempt/1/jobs")) return Response.json([{ runId: 123, status: "completed", result: "succeeded" }]);
      if (url.pathname.endsWith("/workflow/run/124/attempt/1/jobs")) return Response.json([{ runId: 124, status: secondCompleted ? "completed" : "running", result: secondCompleted ? "succeeded" : null }]);
      throw new Error(`unexpected ${url.pathname}`);
    }));

    const running = await Effect.runPromise(backend.inspect(identity("runner-server:123,124")));
    secondCompleted = true;
    const completed = await Effect.runPromise(backend.inspect(identity("runner-server:123,124")));

    expect(running).toMatchObject({ status: "running", conclusion: null });
    expect(completed).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("rejects mismatched runtime identity instead of completing a foreign run", async () => {
    const eventPayload = JSON.stringify({ gitfoundry: { tenantId, repositoryId, repository, runId, operationId, versionCommit, codeCommit: "e".repeat(40), sourceDigest, workflows: [] } });
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/workflow/run/123/attempts")) return Response.json([{ attempt: 1, eventPayload, status: "completed", result: "succeeded" }]);
      if (url.pathname.endsWith("/workflow/run/123/attempt/1/jobs")) return Response.json([{ runid: 123, status: "completed", result: "succeeded" }]);
      throw new Error(`unexpected ${url.pathname}`);
    }));

    await expect(Effect.runPromise(backend.inspect(identity("runner-server:123")))).rejects.toBeInstanceOf(WorkflowBackendRejectedError);
  });

  it("cancels only after the runtime run id and identity are acknowledged", async () => {
    const eventPayload = JSON.stringify({ gitfoundry: { tenantId, repositoryId, repository, runId, operationId, versionCommit, codeCommit, sourceDigest, workflows: [] } });
    const paths: string[] = [];
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(request => {
      const url = new URL(request.url);
      paths.push(`${request.method} ${url.pathname}`);
      if (url.pathname.endsWith("/workflow/run/123/attempts")) return Response.json([{ attempt: 1, eventPayload, status: "running", result: null }]);
      if (url.pathname.endsWith("/workflow/run/123/attempt/1/jobs")) return Response.json([{ runid: 123, status: "running", result: null }]);
      if (url.pathname.endsWith("/cancelWorkflow/123")) return new Response("", { status: 200 });
      throw new Error(`unexpected ${url.pathname}`);
    }));

    const ack = await Effect.runPromise(backend.cancel(identity("runner-server:123")));
    await expect(Effect.runPromise(backend.cancel(identity("unknown:123")))).rejects.toBeInstanceOf(WorkflowBackendRejectedError);

    expect(ack).toEqual({ acknowledged: true });
    expect(paths).toEqual([
      "GET /runner/server/_apis/v1/Message/workflow/run/123/attempts",
      "GET /runner/server/_apis/v1/Message/workflow/run/123/attempt/1/jobs",
      "POST /runner/server/_apis/v1/Message/cancelWorkflow/123"
    ]);
  });

  it("cancels every tracked runtime workflow run after aggregate identity inspection", async () => {
    const eventPayload = JSON.stringify({ gitfoundry: { tenantId, repositoryId, repository, runId, operationId, versionCommit, codeCommit, sourceDigest, workflows: [] } });
    const paths: string[] = [];
    const backend = makeUpstreamGitHubWorkflowBackend(new FakeActionsBackend(request => {
      const url = new URL(request.url);
      paths.push(`${request.method} ${url.pathname}${url.searchParams.get("runid") ? `?runid=${url.searchParams.get("runid")}` : ""}`);
      if (url.pathname.endsWith("/workflow/run/123/attempts") || url.pathname.endsWith("/workflow/run/124/attempts")) return Response.json([{ attempt: 1, eventPayload, status: "running", result: null }]);
      if (url.pathname.endsWith("/workflow/run/123/attempt/1/jobs") || url.pathname.endsWith("/workflow/run/124/attempt/1/jobs")) return Response.json([{ runid: Number(url.pathname.includes("/123/") ? 123 : 124), status: "running", result: null }]);
      if (url.pathname.endsWith("/cancelWorkflow/123") || url.pathname.endsWith("/cancelWorkflow/124")) return new Response("", { status: 200 });
      throw new Error(`unexpected ${url.pathname}`);
    }));

    const ack = await Effect.runPromise(backend.cancel(identity("runner-server:123,124")));

    expect(ack).toEqual({ acknowledged: true });
    expect(paths).toContain("POST /runner/server/_apis/v1/Message/cancelWorkflow/123");
    expect(paths).toContain("POST /runner/server/_apis/v1/Message/cancelWorkflow/124");
  });
});

function identity(backendRunId: string) {
  return { tenantId, repositoryId, repository, runId, operationId, sourceDigest, versionCommit, codeCommit, backendRunId };
}

function sse(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function manifest(workflows: readonly (readonly [string, string])[]) {
  return JSON.stringify({ gitfoundry: { tenantId, repositoryId, repository, runId, operationId, versionCommit, codeCommit, sourceDigest, workflows: workflows.map(([path, sha256]) => ({ path, sha256 })) } });
}

function runtimeAttempt(attempt: number, eventPayload: string, extra: Record<string, unknown> = {}) {
  return { attempt, eventPayload, sha: codeCommit, status: "running", result: null, ...extra };
}

function runtimeRun(id: number, fileName: string, extra: Record<string, unknown> = {}) {
  return { id, fileName, owner: "core", repo: "gitfoundry", sha: codeCommit, status: "running", result: null, ...extra };
}

class FakeActionsBackend implements ActionsBackend {
  readonly ready = Effect.void;
  readonly requests: Request[] = [];
  constructor(readonly handler: (request: Request) => Response | Promise<Response>) {}
  fetch(request: Request) {
    this.requests.push(request);
    return Effect.tryPromise({ try: () => Promise.resolve(this.handler(request)), catch: () => new ActionsBackendError({ operation: "proxy" }) });
  }
}
