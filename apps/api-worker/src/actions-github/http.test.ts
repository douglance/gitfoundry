import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  GitHubWorkflowHttpPortError,
  handleGitHubWorkflowRequest,
  type GitHubWorkflowAuthenticationResult,
  type GitHubWorkflowHttpPorts,
  type GitHubWorkflowVerifiedActor,
  type GitHubWorkflowVerifiedVersion
} from "./http.js";
import { WorkflowReplayConflict, type GitHubWorkflowRun, type GitHubWorkflowServiceShape, type WorkflowDispatchInput } from "./workflows.js";

const tenantId = "tenant-a";
const repositoryId = "repo-a";
const repository = "core/gitfoundry";
const actor: GitHubWorkflowVerifiedActor = { actorId: "owner-a" };
const versionCommit = "a".repeat(40);
const codeCommit = "b".repeat(40);
const verifiedVersion: GitHubWorkflowVerifiedVersion = { tenantId, repositoryId, repository, versionCommit, codeCommit };

describe("GitHub workflow HTTP API", () => {
  it("leaves repository, forge, and other API routes to their own handlers", async () => {
    const calls: string[] = [];
    for (const path of [
      "/api/v2/tenants/tenant-a/repositories",
      "/api/v2/tenants/tenant-a/repositories/repo-a",
      "/api/v2/tenants/tenant-a/repositories/repo-a/forge/versions/" + versionCommit,
      "/api/v2/tenants/tenant-a/repositories/repo-a/actions/runner-registration",
      "/api/v2/tenants/tenant-a/repositories/repo-a/actions/runs-extra"
    ]) {
      expect(await handleGitHubWorkflowRequest(new Request(baseUrl() + path), ports(calls, fakeService()))).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it("leaves runs of other repositories, and all runs when no repository is configured, to GitFoundry's runner", async () => {
    const calls: string[] = [];
    const runs = "/actions/runs";
    expect(await handleGitHubWorkflowRequest(new Request(baseUrl() + "/api/v2/tenants/tenant-a/repositories/repo-b" + runs, { method: "POST", body: "{}" }), ports(calls, fakeService()))).toBeUndefined();
    expect(await handleGitHubWorkflowRequest(new Request(baseUrl() + "/api/v2/tenants/tenant-b/repositories/repo-a" + runs + "/run-1"), ports(calls, fakeService()))).toBeUndefined();
    const unconfigured = { ...ports(calls, fakeService()), owner: { tenantId: "", repositoryId: "", repository: "" } };
    expect(await handleGitHubWorkflowRequest(new Request(baseUrl() + "/api/v2/tenants/tenant-a/repositories/repo-a" + runs, { method: "POST", body: "{}" }), unconfigured)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("dispatches through verified context only and returns a sanitized pending run", async () => {
    const calls: string[] = [];
    const service = fakeService({
      dispatch: input => {
        calls.push(`dispatch:${input.tenantId}:${input.repositoryId}:${input.repository}:${input.actorId}:${input.versionCommit}:${input.codeCommit}`);
        expect(input).toMatchObject({ tenantId, repositoryId, repository, actorId: actor.actorId, versionCommit, codeCommit, operationId: "workflow-op-1" });
        return Effect.succeed(run({ operationId: input.operationId, event: input.event, status: "running" }));
      }
    });
    const response = await handleGitHubWorkflowRequest(dispatchRequest({ operationId: "workflow-op-1", versionCommit }), ports(calls, service));

    expect(response?.status).toBe(202);
    expect(calls).toEqual(["auth:repository.write", "verifyVersion", "service:repository.write", `dispatch:${tenantId}:${repositoryId}:${repository}:${actor.actorId}:${versionCommit}:${codeCommit}`]);
    const body = await response!.json() as Record<string, any>;
    expect(body.state).toBe("pending");
    expect(body.run.workflow_files).toEqual([{ path: ".github/workflows/ci.yml", sha256: "c".repeat(64) }]);
    expect(JSON.stringify(body)).not.toContain("lease");
    expect(JSON.stringify(body)).not.toContain("contents");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("does not verify versions or create the service before authentication succeeds", async () => {
    const calls: string[] = [];
    const response = await handleGitHubWorkflowRequest(dispatchRequest({ operationId: "workflow-op-2", versionCommit }), ports(calls, fakeService(), { auth: Effect.succeed({ ok: false, denialResponse: Response.json({ error: "denied" }, { status: 403 }) }) }));

    expect(response?.status).toBe(403);
    expect(calls).toEqual(["auth:repository.write"]);
  });

  it("requires duplicated-free query strings before touching auth", async () => {
    const calls: string[] = [];
    const response = await handleGitHubWorkflowRequest(new Request(`${baseUrl()}/api/v2/tenants/${tenantId}/repositories/${repositoryId}/actions/runs?limit=1&limit=2`), ports(calls, fakeService()));

    expect(response?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("rejects bodies over 64KiB after auth but before version or service calls", async () => {
    const calls: string[] = [];
    const response = await handleGitHubWorkflowRequest(new Request(`${baseUrl()}/api/v2/tenants/${tenantId}/repositories/${repositoryId}/actions/runs`, {
      method: "POST",
      headers: { "idempotency-key": "workflow-op-3", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "workflow-op-3", versionCommit, event: { name: "workflow_dispatch", payload: "x".repeat(70 * 1024) } })
    }), ports(calls, fakeService()));

    expect(response?.status).toBe(400);
    expect(calls).toEqual(["auth:repository.write"]);
  });

  it("requires idempotency header and body operation id to match", async () => {
    const calls: string[] = [];
    const response = await handleGitHubWorkflowRequest(dispatchRequest({ operationId: "workflow-op-4", headerOperationId: "other-op", versionCommit }), ports(calls, fakeService()));

    expect(response?.status).toBe(400);
    expect(calls).toEqual(["auth:repository.write"]);
  });

  it("rejects client supplied identity fields that conflict with verified context", async () => {
    const calls: string[] = [];
    const response = await handleGitHubWorkflowRequest(dispatchRequest({ operationId: "workflow-op-5", versionCommit, bodyExtra: { actorId: "other-owner" } }), ports(calls, fakeService()));

    expect(response?.status).toBe(403);
    expect(calls).toEqual(["auth:repository.write", "verifyVersion"]);
  });

  it("rejects client supplied code commits that do not match the verified version", async () => {
    const calls: string[] = [];
    const response = await handleGitHubWorkflowRequest(dispatchRequest({ operationId: "workflow-op-6", versionCommit, codeCommit: "d".repeat(40) }), ports(calls, fakeService()));

    expect(response?.status).toBe(403);
    expect(calls).toEqual(["auth:repository.write", "verifyVersion"]);
  });

  it("returns terminal runs as 200 and maps idempotency conflicts to 409", async () => {
    const terminalService = fakeService({ dispatch: input => Effect.succeed(run({ operationId: input.operationId, event: input.event, status: "completed", conclusion: "success" })) });
    const terminal = await handleGitHubWorkflowRequest(dispatchRequest({ operationId: "workflow-op-7", versionCommit }), ports([], terminalService));
    expect(terminal?.status).toBe(200);
    expect((await terminal!.json() as Record<string, any>).state).toBe("terminal");

    const conflict = await handleGitHubWorkflowRequest(dispatchRequest({ operationId: "workflow-op-8", versionCommit }), ports([], fakeService({ dispatch: () => Effect.fail(new WorkflowReplayConflict({ message: "different input", operationId: "workflow-op-8" })) })));
    expect(conflict?.status).toBe(409);
  });

  it("uses read scope for list and write scope for cancel while preserving pending cancel state", async () => {
    const calls: string[] = [];
    const service = fakeService({
      list: input => Effect.succeed([run({ operationId: "workflow-op-9", event: { name: "workflow_dispatch", payload: null }, status: "running" })]),
      cancel: input => Effect.succeed(run({ id: input.runId, operationId: "workflow-op-9", event: { name: "workflow_dispatch", payload: null }, status: "running" }))
    });
    const list = await handleGitHubWorkflowRequest(new Request(`${baseUrl()}/api/v2/tenants/${tenantId}/repositories/${repositoryId}/actions/runs?limit=10`), ports(calls, service));
    const cancel = await handleGitHubWorkflowRequest(new Request(`${baseUrl()}/api/v2/tenants/${tenantId}/repositories/${repositoryId}/actions/runs/run-a/cancel`, { method: "POST", headers: { "idempotency-key": "workflow-op-cancel" }, body: JSON.stringify({ operationId: "workflow-op-cancel" }) }), ports(calls, service));

    expect(list?.status).toBe(200);
    expect(cancel?.status).toBe(202);
    expect((await cancel!.json() as Record<string, any>).state).toBe("pending");
    expect(calls).toEqual(["auth:repository.read", "service:repository.read", "auth:repository.write", "service:repository.write"]);
  });
});

function baseUrl(): string { return "https://gitfoundry.dev"; }

function dispatchRequest(input: { readonly operationId: string; readonly versionCommit: string; readonly headerOperationId?: string; readonly codeCommit?: string; readonly bodyExtra?: Record<string, unknown> }): Request {
  const body: Record<string, unknown> = {
    operationId: input.operationId,
    versionCommit: input.versionCommit,
    event: { name: "workflow_dispatch", payload: { ref: "main" } },
    ...input.bodyExtra
  };
  if (input.codeCommit !== undefined) body.codeCommit = input.codeCommit;
  return new Request(`${baseUrl()}/api/v2/tenants/${tenantId}/repositories/${repositoryId}/actions/runs`, {
    method: "POST",
    headers: { "idempotency-key": input.headerOperationId ?? input.operationId, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function ports(calls: string[], service: GitHubWorkflowServiceShape, options: { readonly auth?: Effect.Effect<GitHubWorkflowAuthenticationResult, GitHubWorkflowHttpPortError>; readonly version?: Effect.Effect<GitHubWorkflowVerifiedVersion, GitHubWorkflowHttpPortError> } = {}): GitHubWorkflowHttpPorts {
  return {
    owner: { tenantId, repositoryId, repository },
    authenticate: input => {
      calls.push(`auth:${input.capability}`);
      return options.auth ?? Effect.succeed({ ok: true as const, actor });
    },
    verifyVersion: input => {
      calls.push("verifyVersion");
      expect(input.versionCommit).toBe(versionCommit);
      return options.version ?? Effect.succeed(verifiedVersion);
    },
    workflowService: input => {
      calls.push(`service:${input.capability}`);
      return Effect.succeed(service);
    }
  };
}

function fakeService(overrides: Partial<GitHubWorkflowServiceShape> = {}): GitHubWorkflowServiceShape {
  return {
    dispatch: (input: WorkflowDispatchInput) => Effect.succeed(run({ operationId: input.operationId, event: input.event, status: "running" })),
    get: input => Effect.succeed(run({ id: input.runId, operationId: "workflow-op-get", event: { name: "workflow_dispatch", payload: null }, status: "running" })),
    list: () => Effect.succeed([]),
    cancel: input => Effect.succeed(run({ id: input.runId, operationId: "workflow-op-cancel", event: { name: "workflow_dispatch", payload: null }, status: "running" })),
    reconcile: input => Effect.succeed(run({ id: input.runId, operationId: "workflow-op-reconcile", event: { name: "workflow_dispatch", payload: null }, status: "completed", conclusion: "success" })),
    ...overrides
  };
}

function run(extra: Partial<GitHubWorkflowRun> & Pick<GitHubWorkflowRun, "operationId" | "event" | "status">): GitHubWorkflowRun {
  const { operationId, event, status, ...rest } = extra;
  return {
    tenantId,
    repositoryId,
    id: "run-a",
    operationId,
    actorId: actor.actorId,
    repository,
    versionCommit,
    codeCommit,
    inputDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64),
    event,
    workflows: [{ path: ".github/workflows/ci.yml", contents: "secret workflow contents", sha256: "c".repeat(64) }],
    status,
    conclusion: extra.conclusion ?? null,
    backendRunId: "backend-a",
    leaseId: "lease-secret",
    leaseGeneration: 3,
    createdAt: "2026-10-09T20:00:00.000Z",
    updatedAt: "2026-10-09T20:01:00.000Z",
    error: null,
    ...rest
  };
}
