import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeNativeOperation, validateSourceCatalog, type NativeOperation, type SourceDomainDocument } from "@gitfoundry/contracts";
import {
  DomainContractError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  StalePreconditionError,
  UnauthorizedError,
  UnsupportedOperationError,
  discoverCapabilities,
  dispatchOperation,
  makeFakeGitFoundryLayer,
  makeIdempotencyReservationKeys,
  type Actor,
  type Namespace,
  type Repository,
  type Issue,
  type PullRequest,
  type Review,
  type Check,
  type TrustedRevision
} from "./index.js";

const readSources = async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "../../..");
  const readJson = async (relative: string) => JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
  const readText = async (relative: string) => fs.readFile(path.join(root, relative), "utf8");
  const catalog = {
    operations: await readJson("docs/source/handoff/contracts/operations.json"),
    mcpTools: await readJson("docs/source/handoff/contracts/mcp-tools.json"),
    openapi: await readJson("docs/source/handoff/contracts/openapi.json"),
    schemaSql: await readText("docs/source/handoff/contracts/schema.sql"),
    requirementsTraceCsv: await readText("docs/source/handoff/requirements-trace.csv")
  };
  const domain = await readJson("docs/source/handoff/contracts/domain.schema.json") as SourceDomainDocument;
  const operations = catalog.operations.operations.map(decodeNativeOperation);
  return { catalog, domain, operations };
};

const actor: Actor = {
  id: "actor-a",
  tenantId: "tenant-a",
  revoked: false,
  capabilities: ["repository.read", "repository.write", "repository.admin", "operation.read", "issue.read", "issue.write", "pull_request.read", "pull_request.write", "comment.read", "comment.write", "review.read", "review.write", "review.admin", "check.read", "check.write"]
};

const namespace: Namespace = { tenant_id: "tenant-a", id: "namespace-a" };

const otherNamespace: Namespace = { tenant_id: "tenant-b", id: "namespace-b" };

const repository: Repository = {
  tenant_id: "tenant-a",
  id: "repo-a",
  version: 1,
  created_at: "2026-10-07T18:00:00Z",
  updated_at: "2026-10-07T18:00:00Z",
  namespace_id: "namespace-a",
  name: "demo",
  visibility: "private",
  default_branch: "main",
  archived: false,
  fork_of: null,
  git_url: "https://acme.gitfoundry.example/git/acme/demo.git"
};

const sourceRepository: Repository = {
  ...repository,
  id: "repo-source",
  name: "source",
  git_url: "https://acme.gitfoundry.example/git/acme/source.git"
};

const otherTenantRepository: Repository = {
  ...repository,
  tenant_id: "tenant-b",
  id: "repo-b",
  namespace_id: "namespace-b",
  name: "other",
  git_url: "https://acme.gitfoundry.example/git/other/repo-b.git"
};

const issue: Issue = {
  tenant_id: "tenant-a",
  id: "issue-a",
  version: 2,
  created_at: "2026-10-07T18:00:00Z",
  updated_at: "2026-10-07T18:00:00Z",
  repository_id: "repo-a",
  number: 1,
  title: "Existing issue",
  body: "Existing issue body",
  state: "open",
  state_reason: "reopened",
  author_id: "actor-a",
  labels: ["bug"],
  assignees: []
};

const pullRequest: PullRequest = {
  tenant_id: "tenant-a",
  id: "pr-a",
  version: 1,
  created_at: "2026-10-07T18:00:00Z",
  updated_at: "2026-10-07T18:00:00Z",
  repository_id: "repo-a",
  number: 1,
  title: "Existing PR",
  body: "Existing PR body",
  state: "open",
  draft: false,
  source_repository_id: "repo-source",
  source_ref: "feature",
  head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target_ref: "main",
  base_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  author_id: "actor-a"
};

const draftPullRequest: PullRequest = { ...pullRequest, id: "pr-draft", version: 3, number: 2, draft: true };

const review: Review = {
  tenant_id: "tenant-a",
  id: "review-a",
  version: 1,
  created_at: "2026-10-07T18:00:00Z",
  updated_at: "2026-10-07T18:00:00Z",
  repository_id: "repo-a",
  pull_request_id: "pr-a",
  reviewer_id: "actor-a",
  head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  state: "pending",
  body: "draft review"
};

const check: Check = {
  tenant_id: "tenant-a",
  id: "check-a",
  version: 1,
  created_at: "2026-10-07T18:00:00Z",
  updated_at: "2026-10-07T18:00:00Z",
  repository_id: "repo-a",
  commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  evidence_kind: "external",
  candidate_bound: false,
  head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  base_sha: null,
  execution_sha: null,
  plan_digest: null,
  policy_digest: null,
  job_attempt_id: null,
  provider_evidence_ref: "provider/run/1",
  name: "ci/build",
  producer_id: "actor-a",
  status: "in_progress",
  conclusion: null,
  details_url: "https://checks.example/run/1",
  output: null,
  annotations: [{ path: "src/main.ts", start_line: 1, end_line: 1, start_column: null, end_column: null, level: "notice", message: "initial annotation", title: null, raw_details: null }]
};

const staleHeadCheck: Check = { ...check, id: "check-stale", commit_sha: "cccccccccccccccccccccccccccccccccccccccc", head_sha: "cccccccccccccccccccccccccccccccccccccccc", provider_evidence_ref: "provider/run/stale" };

const trustedRevisions: readonly TrustedRevision[] = [
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "cccccccccccccccccccccccccccccccccccccccc"
].map((sha) => ({ tenant_id: "tenant-a", repository_id: "repo-a", sha }));

function operation(operations: readonly NativeOperation[], id: string): NativeOperation {
  const found = operations.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing operation ${id}`);
  return found;
}

function repoCreateRequest(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "repo.create",
    route: { tenant_id: "tenant-a" },
    query: {},
    headers: { authorization: "dummy-a" },
    body: { namespace_id: "namespace-a", name: "repo-one" },
    cookies: {},
    idempotency_key: "repo-create-key",
    expected_version: 0,
    api_version: "v1",
    ...overrides
  };
}

function repoEditRequest(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "repo.edit",
    route: { tenant_id: "tenant-a", id: "repo-a" },
    query: {},
    headers: {},
    body: { name: "renamed", visibility: "internal", default_branch: "trunk" },
    cookies: {},
    idempotency_key: "repo-edit-key",
    expected_version: 1,
    api_version: "v1",
    ...overrides
  };
}

function repoActionRequest(operationId: "repo.archive" | "repo.unarchive", expectedVersion: number, overrides: Record<string, unknown> = {}) {
  return {
    operation_id: operationId,
    route: { tenant_id: "tenant-a", id: "repo-a" },
    query: {},
    headers: {},
    body: { expected_version: expectedVersion, reason: "metadata change" },
    cookies: {},
    idempotency_key: `${operationId}-key`,
    api_version: "v1",
    ...overrides
  };
}

describe("P0-02 core domain use cases", () => {
  it("discovers implemented capabilities while accounting for all catalog entries", async () => {
    const { catalog, operations } = await readSources();
    const summary = validateSourceCatalog(catalog);
    const discovery = discoverCapabilities(summary, operations);

    expect(discovery.total).toBe(198);
    expect(discovery.implemented).toEqual(["repo.list", "repo.view", "repo.create", "repo.fork", "repo.edit", "repo.archive", "repo.unarchive", "repo.delete", "repo.clone", "operation.view", "issue.list", "issue.view", "issue.create", "issue.edit", "issue.close", "issue.reopen", "pr.list", "pr.view", "pr.create", "pr.edit", "pr.close", "pr.reopen", "pr.ready", "pr.draft", "comment.list", "comment.view", "comment.create", "comment.edit", "review.list", "review.view", "review.create", "review.edit", "review.submit", "review.dismiss", "check.list", "check.create", "check.edit", "pr.checks", "check.view", "check.annotations", "label.list", "label.view", "label.create", "label.edit", "label.delete", "milestone.list", "milestone.view", "milestone.create", "milestone.edit", "milestone.delete"]);
    expect(discovery.entries.filter((entry) => !entry.implemented)).toHaveLength(discovery.total - discovery.implemented.length);
  });

  it("rejects malformed repo.create bodies on the dispatch path before fake mutation", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace] });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), repoCreateRequest({
      body: { namespace_id: "namespace-a", name: 17 }
    })), layer))).rejects.toBeInstanceOf(DomainContractError);
  });

  it("resolves repository reads only for the current tenant and authorized capability", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository] });
    const receipt = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.view"), {
      operation_id: "repo.view",
      route: { tenant_id: "tenant-a", id: "repo-a" },
      query: {},
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1"
    }), layer));

    expect(receipt.status).toBe("succeeded");
    if (receipt.status !== "succeeded") throw new Error("expected succeeded receipt");
    expect(receipt.response).toMatchObject({ id: "repo-a", tenant_id: "tenant-a" });
  });

  it("rejects tenant substitution, revoked actors, and unknown route fields", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository] });
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.view"), {
      operation_id: "repo.view",
      route: { tenant_id: "tenant-b", id: "repo-a" },
      query: {},
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(UnauthorizedError);

    const revokedLayer = makeFakeGitFoundryLayer({ actor: { ...actor, revoked: true }, domain, operations, namespaces: [namespace], repositories: [repository] });
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.view"), {
      operation_id: "repo.view",
      route: { tenant_id: "tenant-a", id: "repo-a" },
      query: {},
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1"
    }), revokedLayer))).rejects.toBeInstanceOf(UnauthorizedError);

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.view"), {
      operation_id: "repo.view",
      route: { tenant_id: "tenant-a", id: "repo-a", extra: "x" },
      query: {},
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(DomainContractError);
  });

  it("creates repositories only in owned namespaces and validates source-shaped outputs", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace] });
    const receipt = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), repoCreateRequest({
      body: { namespace_id: "namespace-a", name: "new-repo", visibility: "internal" }
    })), layer));

    expect(receipt.status).toBe("succeeded");
    if (receipt.status !== "succeeded") throw new Error("expected succeeded receipt");
    expect(receipt.response).toMatchObject({ tenant_id: "tenant-a", id: "namespace-a-new-repo", visibility: "internal" });

    const noNamespaceLayer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [] });
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), repoCreateRequest()), noNamespaceLayer))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("forks a repository only from the exact source version", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository] });
    const request = {
      operation_id: "repo.fork",
      route: { tenant_id: "tenant-a", id: "repo-a" },
      query: {},
      headers: {},
      body: { expected_version: 1, target_namespace_id: "namespace-a", name: "demo-fork", visibility: "private" },
      cookies: {},
      idempotency_key: "repo-fork-key",
      api_version: "v1"
    };

    const forked = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.fork"), request), layer));
    expect(forked).toMatchObject({ status: "succeeded", replayed: false });
    if (forked.status !== "succeeded") throw new Error("expected repo.fork success");
    expect(forked.response).toMatchObject({
      status: "succeeded",
      kind: "repo.fork",
      progress: { stage: "completed", completed: 1, total: 1, blocked_reason: null },
      result: { source_repository_id: "repo-a", repository_id: "namespace-a-demo-fork", copied_ref_count: 0, copied_object_count: 0 }
    });
    const result = forked.response as { result: { source_snapshot_digest: string } };
    expect(result.result.source_snapshot_digest).toMatch(/^[0-9a-f]{64}$/u);

    const replay = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.fork"), { ...request, headers: { authorization: "refreshed" } }), layer));
    expect(replay).toMatchObject({ status: "succeeded", replayed: true, response: forked.response });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.fork"), {
      ...request,
      idempotency_key: "repo-fork-stale",
      body: { expected_version: 2, target_namespace_id: "namespace-a", name: "stale-fork", visibility: "private" }
    }), layer))).rejects.toBeInstanceOf(StalePreconditionError);
  });

  it("edits repository metadata with version fencing while preserving the provider Git mapping", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository] });

    const edited = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.edit"), repoEditRequest()), layer));
    expect(edited).toMatchObject({ status: "succeeded", replayed: false });
    if (edited.status !== "succeeded") throw new Error("expected repo.edit success");
    expect(edited.response).toMatchObject({ id: "repo-a", name: "renamed", visibility: "internal", default_branch: "trunk", version: 2, git_url: repository.git_url });

    const duplicate = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.edit"), repoEditRequest({ headers: { authorization: "refreshed" } })), layer));
    expect(duplicate).toMatchObject({ status: "succeeded", replayed: true, response: edited.response });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.edit"), repoEditRequest({ idempotency_key: "repo-edit-stale", body: { visibility: "public" }, expected_version: 1 })), layer))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.edit"), repoEditRequest({ idempotency_key: "repo-edit-description", body: { description: "not yet persisted" }, expected_version: 2 })), layer))).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("archives and unarchives repositories as versioned metadata transitions with replay", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository] });

    const archived = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.archive"), repoActionRequest("repo.archive", 1)), layer));
    expect(archived).toMatchObject({ status: "succeeded", replayed: false });
    if (archived.status !== "succeeded") throw new Error("expected repo.archive success");
    expect(archived.response).toMatchObject({ id: "repo-a", archived: true, version: 2, git_url: repository.git_url });

    const duplicate = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.archive"), repoActionRequest("repo.archive", 1, { headers: { authorization: "refreshed" } })), layer));
    expect(duplicate).toMatchObject({ status: "succeeded", replayed: true, response: archived.response });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.archive"), repoActionRequest("repo.archive", 2, { idempotency_key: "repo-archive-again" })), layer))).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const unarchived = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.unarchive"), repoActionRequest("repo.unarchive", 2)), layer));
    expect(unarchived).toMatchObject({ status: "succeeded" });
    if (unarchived.status !== "succeeded") throw new Error("expected repo.unarchive success");
    expect(unarchived.response).toMatchObject({ id: "repo-a", archived: false, version: 3 });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.unarchive"), repoActionRequest("repo.unarchive", 2, { idempotency_key: "repo-unarchive-stale" })), layer))).rejects.toBeInstanceOf(StalePreconditionError);
  });

  it("scopes idempotency by tenant principal operation and key", async () => {
    const { domain, operations } = await readSources();
    let currentActor = actor;
    const layer = makeFakeGitFoundryLayer({ actor: () => currentActor, domain, operations, namespaces: [namespace] });

    const first = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), repoCreateRequest({
      body: { namespace_id: "namespace-a", name: "principal-a" },
      idempotency_key: "shared-key"
    })), layer));
    expect(first.status).toBe("succeeded");

    currentActor = { ...actor, id: "actor-b" };
    const second = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), repoCreateRequest({
      body: { namespace_id: "namespace-a", name: "principal-b" },
      idempotency_key: "shared-key"
    })), layer));
    expect(second).toMatchObject({ status: "succeeded", replayed: false });
  });

  it("replays identical semantic inputs across refreshed transport credentials", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace] });
    const request = repoCreateRequest({
      body: { namespace_id: "namespace-a", name: "idem-repo" },
      idempotency_key: "token-refresh"
    });

    const first = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), request), layer));
    const second = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), {
      ...request,
      headers: { authorization: "dummy-b" }
    }), layer));
    expect(first).toMatchObject({ status: "succeeded", replayed: false });
    if (first.status !== "succeeded") throw new Error("expected first succeeded receipt");
    expect(second).toMatchObject({ status: "succeeded", replayed: true, response: first.response });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), {
      ...request,
      body: { namespace_id: "namespace-a", name: "different-repo" }
    }), layer))).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("reauthorizes before idempotent replay", async () => {
    const { domain, operations } = await readSources();
    let currentActor = actor;
    const layer = makeFakeGitFoundryLayer({ actor: () => currentActor, domain, operations, namespaces: [namespace] });
    const request = repoCreateRequest({ body: { namespace_id: "namespace-a", name: "revoked-replay" }, idempotency_key: "replay-after-revoke" });

    await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), request), layer));
    currentActor = { ...actor, revoked: true };
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), request), layer))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("returns one pending intent for overlapping same-key requests and operation.view can retrieve it", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], createDelayMs: 30 });
    const request = repoCreateRequest({ body: { namespace_id: "namespace-a", name: "overlap-repo" }, idempotency_key: "overlap-key" });

    const [first, second] = await Promise.all([
      Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), request), layer)),
      Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), request), layer))
    ]);
    const pending = [first, second].find((receipt) => receipt.status === "pending");
    expect(pending).toMatchObject({ status: "pending", reason: "in_progress" });
    if (!pending || pending.status !== "pending") throw new Error("expected pending receipt");

    const viewed = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "operation.view"), {
      operation_id: "operation.view",
      route: { tenant_id: "tenant-a", id: pending.receiptId },
      query: {},
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1"
    }), layer));
    expect(viewed).toMatchObject({ status: "succeeded" });
  });

  it("derives SHA-256 idempotency scope and semantic request digest without plaintext payload", async () => {
    const first = await Effect.runPromise(makeIdempotencyReservationKeys({
      tenantId: "tenant-a",
      principalId: "actor-a",
      operationId: "issue.create",
      key: "same-key",
      semanticInput: { operation_id: "issue.create", body: { repository_id: "repo-a", title: "secret-title" }, api_version: "v1" }
    }));
    const changedRequest = await Effect.runPromise(makeIdempotencyReservationKeys({
      tenantId: "tenant-a",
      principalId: "actor-a",
      operationId: "issue.create",
      key: "same-key",
      semanticInput: { operation_id: "issue.create", body: { repository_id: "repo-a", title: "other-title" }, api_version: "v1" }
    }));
    const changedPrincipal = await Effect.runPromise(makeIdempotencyReservationKeys({
      tenantId: "tenant-a",
      principalId: "actor-b",
      operationId: "issue.create",
      key: "same-key",
      semanticInput: { operation_id: "issue.create", body: { repository_id: "repo-a", title: "secret-title" }, api_version: "v1" }
    }));

    const parsedScope = JSON.parse(first.scope) as string[];
    expect(parsedScope).toHaveLength(4);
    expect(parsedScope.slice(0, 3)).toEqual(["tenant-a", "actor-a", "issue.create"]);
    expect(parsedScope[3]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.scope).not.toContain("same-key");
    expect(first.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.intentId).toMatch(/^idem-[a-f0-9]{32}$/);
    expect(first.requestDigest).not.toContain("secret-title");
    expect(changedRequest.requestDigest).not.toBe(first.requestDigest);
    expect(changedRequest.scope).toBe(first.scope);
    expect(changedPrincipal.scope).not.toBe(first.scope);
  });

  it("rejects stale preconditions and unsupported adapters without invented pending receipts", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor: { ...actor, capabilities: ["repository.read", "repository.write", "repository.admin", "operation.read"] }, domain, operations, namespaces: [namespace], repositories: [repository] });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.create"), repoCreateRequest({
      body: { namespace_id: "namespace-a", name: "stale-repo" },
      idempotency_key: "stale-key",
      expected_version: 5
    })), layer))).rejects.toBeInstanceOf(StalePreconditionError);

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "repo.delete"), {
      operation_id: "repo.delete",
      route: { tenant_id: "tenant-a", id: "repo-a" },
      query: {},
      headers: {},
      body: { expected_version: 1 },
      cookies: {},
      idempotency_key: "delete-1",
      expected_version: 1,
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(UnsupportedOperationError);

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "operation.view"), {
      operation_id: "operation.view",
      route: { tenant_id: "tenant-a", id: "does-not-exist" },
      query: {},
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(NotFoundError);
  });
});


describe("P1 forge domain use cases", () => {
  it("creates lists views and updates issues with source-shaped output", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository], issues: [issue] });

    const created = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.create"), {
      operation_id: "issue.create",
      route: { tenant_id: "tenant-a" },
      query: {},
      headers: {},
      body: { repository_id: "repo-a", title: "New issue", body: "Body", labels: ["p1"] },
      cookies: {},
      idempotency_key: "issue-create-1",
      expected_version: 0,
      api_version: "v1"
    }), layer));
    expect(created).toMatchObject({ status: "succeeded" });
    if (created.status !== "succeeded") throw new Error("expected issue.create success");
    expect(created.response).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", title: "New issue", author_id: "actor-a", version: 1 });

    const listed = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.list"), {
      operation_id: "issue.list",
      route: { tenant_id: "tenant-a" },
      query: { repository_id: "repo-a" },
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1"
    }), layer));
    expect(listed).toMatchObject({ status: "succeeded" });
    if (listed.status !== "succeeded") throw new Error("expected issue.list success");
    expect(listed.response).toMatchObject({ has_more: false, next_cursor: null });
    expect((listed.response as { items: unknown[] }).items).toHaveLength(2);

    const updated = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.edit"), {
      operation_id: "issue.edit",
      route: { tenant_id: "tenant-a", id: "issue-a" },
      query: {},
      headers: {},
      body: { title: "Updated issue" },
      cookies: {},
      idempotency_key: "issue-edit-1",
      expected_version: 2,
      api_version: "v1"
    }), layer));
    expect(updated).toMatchObject({ status: "succeeded" });
    if (updated.status !== "succeeded") throw new Error("expected issue.edit success");
    expect(updated.response).toMatchObject({ id: "issue-a", title: "Updated issue", version: 3 });
  });

  it("rejects crossed tenant repositories and stale forge update versions", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace, otherNamespace], repositories: [repository, sourceRepository, otherTenantRepository], issues: [issue] });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "pr.create"), {
      operation_id: "pr.create",
      route: { tenant_id: "tenant-a" },
      query: {},
      headers: {},
      body: { repository_id: "repo-a", source_repository_id: "repo-b", source_ref: "feature", target_ref: "main", title: "Cross tenant" },
      cookies: {},
      idempotency_key: "pr-cross-tenant",
      expected_version: 0,
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(NotFoundError);

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.edit"), {
      operation_id: "issue.edit",
      route: { tenant_id: "tenant-a", id: "issue-a" },
      query: {},
      headers: {},
      body: { title: "Stale" },
      cookies: {},
      idempotency_key: "issue-edit-stale",
      expected_version: 1,
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(StalePreconditionError);
  });

  it("creates pull requests comments and reviews within owned repositories", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository, sourceRepository], issues: [issue], pullRequests: [pullRequest] });

    const createdPr = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "pr.create"), {
      operation_id: "pr.create",
      route: { tenant_id: "tenant-a" },
      query: {},
      headers: {},
      body: { repository_id: "repo-a", source_repository_id: "repo-source", source_ref: "feature-two", target_ref: "main", title: "New PR", draft: true },
      cookies: {},
      idempotency_key: "pr-create-1",
      expected_version: 0,
      api_version: "v1"
    }), layer));
    expect(createdPr).toMatchObject({ status: "succeeded" });
    if (createdPr.status !== "succeeded") throw new Error("expected pr.create success");
    expect(createdPr.response).toMatchObject({ repository_id: "repo-a", source_repository_id: "repo-source", draft: true });

    const comment = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "comment.create"), {
      operation_id: "comment.create",
      route: { tenant_id: "tenant-a" },
      query: {},
      headers: {},
      body: { repository_id: "repo-a", subject_kind: "issue", subject_id: "issue-a", body: "Looks reproducible" },
      cookies: {},
      idempotency_key: "comment-create-1",
      expected_version: 0,
      api_version: "v1"
    }), layer));
    expect(comment).toMatchObject({ status: "succeeded" });
    if (comment.status !== "succeeded") throw new Error("expected comment.create success");
    expect(comment.response).toMatchObject({ subject_kind: "issue", subject_id: "issue-a", author_id: "actor-a" });

    const review = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "review.create"), {
      operation_id: "review.create",
      route: { tenant_id: "tenant-a" },
      query: {},
      headers: {},
      body: { repository_id: "repo-a", pull_request_id: "pr-a", body: "Review body" },
      cookies: {},
      idempotency_key: "review-create-1",
      expected_version: 0,
      api_version: "v1"
    }), layer));
    expect(review).toMatchObject({ status: "succeeded" });
    if (review.status !== "succeeded") throw new Error("expected review.create success");
    expect(review.response).toMatchObject({ pull_request_id: "pr-a", reviewer_id: "actor-a", state: "pending" });
  });

  it("reauthorizes forge operations before idempotent replay and replays duplicate semantic requests", async () => {
    const { domain, operations } = await readSources();
    let currentActor = actor;
    const layer = makeFakeGitFoundryLayer({ actor: () => currentActor, domain, operations, namespaces: [namespace], repositories: [repository] });
    const request = {
      operation_id: "issue.create",
      route: { tenant_id: "tenant-a" },
      query: {},
      headers: { authorization: "old-token" },
      body: { repository_id: "repo-a", title: "Idempotent issue" },
      cookies: {},
      idempotency_key: "issue-idem",
      expected_version: 0,
      api_version: "v1"
    };

    const first = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.create"), request), layer));
    const duplicate = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.create"), { ...request, headers: { authorization: "new-token" } }), layer));
    expect(first).toMatchObject({ status: "succeeded", replayed: false });
    expect(duplicate).toMatchObject({ status: "succeeded", replayed: true });

    currentActor = { ...actor, revoked: true };
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.create"), request), layer))).rejects.toBeInstanceOf(UnauthorizedError);
  });


  it("applies issue close and reopen transitions with duplicate semantic replay", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository], issues: [issue] });
    const closeRequest = {
      operation_id: "issue.close",
      route: { tenant_id: "tenant-a", id: "issue-a" },
      query: {},
      headers: { authorization: "old-token" },
      body: { expected_version: 2, reason: "completed" },
      cookies: {},
      idempotency_key: "issue-close-1",
      api_version: "v1"
    };

    const closed = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.close"), closeRequest), layer));
    const duplicate = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.close"), { ...closeRequest, headers: { authorization: "new-token" } }), layer));
    expect(closed).toMatchObject({ status: "succeeded", replayed: false });
    if (closed.status !== "succeeded") throw new Error("expected issue.close success");
    expect(closed.response).toMatchObject({ id: "issue-a", state: "closed", state_reason: "completed", version: 3 });
    expect(duplicate).toMatchObject({ status: "succeeded", replayed: true, response: closed.response });

    const reopened = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.reopen"), {
      operation_id: "issue.reopen",
      route: { tenant_id: "tenant-a", id: "issue-a" },
      query: {},
      headers: {},
      body: { expected_version: 3, reason: "work resumed" },
      cookies: {},
      idempotency_key: "issue-reopen-1",
      api_version: "v1"
    }), layer));
    expect(reopened).toMatchObject({ status: "succeeded" });
    if (reopened.status !== "succeeded") throw new Error("expected issue.reopen success");
    expect(reopened.response).toMatchObject({ state: "open", state_reason: "reopened", version: 4 });
  });

  it("applies pull request draft ready close and reopen transitions", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository, sourceRepository], pullRequests: [draftPullRequest] });

    const ready = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "pr.ready"), {
      operation_id: "pr.ready",
      route: { tenant_id: "tenant-a", id: "pr-draft" },
      query: {},
      headers: {},
      body: { expected_version: 3, reason: "ready for review" },
      cookies: {},
      idempotency_key: "pr-ready-1",
      api_version: "v1"
    }), layer));
    expect(ready).toMatchObject({ status: "succeeded" });
    if (ready.status !== "succeeded") throw new Error("expected pr.ready success");
    expect(ready.response).toMatchObject({ draft: false, state: "open", version: 4 });

    const draft = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "pr.draft"), {
      operation_id: "pr.draft",
      route: { tenant_id: "tenant-a", id: "pr-draft" },
      query: {},
      headers: {},
      body: { expected_version: 4, reason: "needs work" },
      cookies: {},
      idempotency_key: "pr-draft-1",
      api_version: "v1"
    }), layer));
    expect(draft).toMatchObject({ status: "succeeded" });

    const closed = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "pr.close"), {
      operation_id: "pr.close",
      route: { tenant_id: "tenant-a", id: "pr-draft" },
      query: {},
      headers: {},
      body: { expected_version: 5, reason: "superseded" },
      cookies: {},
      idempotency_key: "pr-close-1",
      api_version: "v1"
    }), layer));
    expect(closed).toMatchObject({ status: "succeeded" });
    if (closed.status !== "succeeded") throw new Error("expected pr.close success");
    expect(closed.response).toMatchObject({ state: "closed", version: 6 });

    const reopened = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "pr.reopen"), {
      operation_id: "pr.reopen",
      route: { tenant_id: "tenant-a", id: "pr-draft" },
      query: {},
      headers: {},
      body: { expected_version: 6, reason: "valid again" },
      cookies: {},
      idempotency_key: "pr-reopen-1",
      api_version: "v1"
    }), layer));
    expect(reopened).toMatchObject({ status: "succeeded" });
  });

  it("submits and dismisses reviews with source-shaped decisions", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository, sourceRepository], pullRequests: [pullRequest], reviews: [review] });

    const submitted = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "review.submit"), {
      operation_id: "review.submit",
      route: { tenant_id: "tenant-a", id: "review-a" },
      query: {},
      headers: {},
      body: { expected_version: 1, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", decision: "changes_requested", body: "please revise" },
      cookies: {},
      idempotency_key: "review-submit-1",
      api_version: "v1"
    }), layer));
    expect(submitted).toMatchObject({ status: "succeeded" });
    if (submitted.status !== "succeeded") throw new Error("expected review.submit success");
    expect(submitted.response).toMatchObject({ state: "changes_requested", body: "please revise", version: 2 });

    const dismissed = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "review.dismiss"), {
      operation_id: "review.dismiss",
      route: { tenant_id: "tenant-a", id: "review-a" },
      query: {},
      headers: {},
      body: { expected_version: 2, reason: "stale review" },
      cookies: {},
      idempotency_key: "review-dismiss-1",
      api_version: "v1"
    }), layer));
    expect(dismissed).toMatchObject({ status: "succeeded" });
    if (dismissed.status !== "succeeded") throw new Error("expected review.dismiss success");
    expect(dismissed.response).toMatchObject({ state: "dismissed", version: 3 });
  });

  it("rejects stale versions tenant substitution revoked replay and invalid state transitions", async () => {
    const { domain, operations } = await readSources();
    let currentActor = actor;
    const layer = makeFakeGitFoundryLayer({ actor: () => currentActor, domain, operations, namespaces: [namespace], repositories: [repository, sourceRepository], issues: [issue], pullRequests: [pullRequest], reviews: [review] });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.close"), {
      operation_id: "issue.close",
      route: { tenant_id: "tenant-a", id: "issue-a" },
      query: {},
      headers: {},
      body: { expected_version: 1, reason: "completed" },
      cookies: {},
      idempotency_key: "issue-close-stale",
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(StalePreconditionError);

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "pr.ready"), {
      operation_id: "pr.ready",
      route: { tenant_id: "tenant-a", id: "pr-a" },
      query: {},
      headers: {},
      body: { expected_version: 1, reason: "already ready" },
      cookies: {},
      idempotency_key: "pr-ready-invalid",
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const closeRequest = {
      operation_id: "issue.close",
      route: { tenant_id: "tenant-a", id: "issue-a" },
      query: {},
      headers: {},
      body: { expected_version: 2, reason: "not_planned" },
      cookies: {},
      idempotency_key: "issue-close-revoked-replay",
      api_version: "v1"
    };
    await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.close"), closeRequest), layer));
    currentActor = { ...actor, revoked: true };
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.close"), closeRequest), layer))).rejects.toBeInstanceOf(UnauthorizedError);

    currentActor = actor;
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.reopen"), {
      operation_id: "issue.reopen",
      route: { tenant_id: "tenant-b", id: "issue-a" },
      query: {},
      headers: {},
      body: { expected_version: 3, reason: "wrong tenant" },
      cookies: {},
      idempotency_key: "issue-reopen-tenant-b",
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects crossed repository review state and keeps deletion operations fail closed", async () => {
    const { domain, operations } = await readSources();
    const crossedPr: PullRequest = { ...pullRequest, id: "pr-cross", repository_id: "repo-source" };
    const crossedReview: Review = { ...review, id: "review-cross", pull_request_id: "pr-cross" };
    const layer = makeFakeGitFoundryLayer({ actor: { ...actor, capabilities: [...actor.capabilities, "issue.admin"] }, domain, operations, namespaces: [namespace], repositories: [repository, sourceRepository], pullRequests: [pullRequest, crossedPr], reviews: [review, crossedReview] });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "review.submit"), {
      operation_id: "review.submit",
      route: { tenant_id: "tenant-a", id: "review-cross" },
      query: {},
      headers: {},
      body: { expected_version: 1, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", decision: "commented" },
      cookies: {},
      idempotency_key: "review-crossed-repo",
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(NotFoundError);

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "review.submit"), {
      operation_id: "review.submit",
      route: { tenant_id: "tenant-a", id: "review-a" },
      query: {},
      headers: {},
      body: { expected_version: 1, head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decision: "commented" },
      cookies: {},
      idempotency_key: "review-head-mismatch",
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(InvalidStateTransitionError);

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "issue.delete"), {
      operation_id: "issue.delete",
      route: { tenant_id: "tenant-a", id: "issue-a" },
      query: {},
      headers: {},
      body: { expected_version: 2, reason: "retention requires tombstone" },
      cookies: {},
      idempotency_key: "issue-delete-unsupported",
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("fails closed for provider-qualified forge operations outside this slice", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor: { ...actor, capabilities: [...actor.capabilities, "pull_request.merge"] }, domain, operations, namespaces: [namespace], repositories: [repository] });

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "pr.merge"), {
      operation_id: "pr.merge",
      route: { tenant_id: "tenant-a", id: "pr-a" },
      query: {},
      headers: {},
      body: { head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", base_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", method: "merge", delete_source_branch: false, eligibility_id: "eligibility-a" },
      cookies: {},
      idempotency_key: "merge-unsupported",
      expected_version: 1,
      api_version: "v1"
    }), layer))).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("creates lists edits and PR-filters checks with source-shaped dispatch output", async () => {
    const { domain, operations } = await readSources();
    const layer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository, sourceRepository], pullRequests: [pullRequest], checks: [check, staleHeadCheck], trustedRevisions });

    const created = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.create"), checkCreateRequest({ idempotency_key: "check-create-dispatch" })), layer));
    expect(created).toMatchObject({ status: "succeeded", replayed: false });
    if (created.status !== "succeeded") throw new Error("expected check.create success");
    expect(created.response).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", producer_id: "actor-a", status: "in_progress", conclusion: null });

    const listed = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.list"), {
      operation_id: "check.list",
      route: { tenant_id: "tenant-a" },
      query: { repository_id: "repo-a", head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1"
    }), layer));
    expect(listed).toMatchObject({ status: "succeeded" });
    if (listed.status !== "succeeded") throw new Error("expected check.list success");
    expect((listed.response as { items: Check[] }).items.map((item) => item.id)).not.toContain("check-stale");

    const viewed = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.view"), checkViewRequest({ idempotency_key: "check-view-dispatch" })), layer));
    const viewedReplay = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.view"), checkViewRequest({ headers: { authorization: "refreshed-token" }, idempotency_key: "check-view-dispatch" })), layer));
    expect(viewed).toMatchObject({ status: "succeeded", replayed: false });
    expect(viewedReplay).toMatchObject({ status: "succeeded", replayed: true });
    if (viewed.status !== "succeeded") throw new Error("expected check.view success");
    expect(viewed.response).toMatchObject({ id: "check-a", tenant_id: "tenant-a", repository_id: "repo-a", annotations: [{ message: "initial annotation" }] });

    const annotations = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.annotations"), checkAnnotationsRequest({ query: { limit: 1 }, idempotency_key: "check-annotations-dispatch" })), layer));
    const annotationsReplay = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.annotations"), checkAnnotationsRequest({ query: { limit: 1 }, headers: { authorization: "refreshed-token" }, idempotency_key: "check-annotations-dispatch" })), layer));
    expect(annotations).toMatchObject({ status: "succeeded", replayed: false });
    expect(annotationsReplay).toMatchObject({ status: "succeeded", replayed: true });
    if (annotations.status !== "succeeded") throw new Error("expected check.annotations success");
    expect(annotations.response).toEqual({ items: [{ path: "src/main.ts", start_line: 1, end_line: 1, start_column: null, end_column: null, level: "notice", message: "initial annotation", title: null, raw_details: null }], next_cursor: null, has_more: false });

    const prChecks = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "pr.checks"), {
      operation_id: "pr.checks",
      route: { tenant_id: "tenant-a", id: "pr-a" },
      query: {},
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1"
    }), layer));
    expect(prChecks).toMatchObject({ status: "succeeded" });
    if (prChecks.status !== "succeeded") throw new Error("expected pr.checks success");
    expect((prChecks.response as { items: Check[] }).items.map((item) => item.id)).not.toContain("check-stale");

    const edited = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.edit"), {
      operation_id: "check.edit",
      route: { tenant_id: "tenant-a", id: "check-a" },
      query: {},
      headers: {},
      body: { status: "completed", conclusion: "success" },
      cookies: {},
      idempotency_key: "check-edit-dispatch",
      expected_version: 1,
      api_version: "v1"
    }), layer));
    expect(edited).toMatchObject({ status: "succeeded" });
    if (edited.status !== "succeeded") throw new Error("expected check.edit success");
    expect(edited.response).toMatchObject({ id: "check-a", version: 2, status: "completed", conclusion: "success" });
  });

  it("enforces check dispatch malformed input revision ownership version terminal and idempotency boundaries", async () => {
    const { domain, operations } = await readSources();
    let currentActor = actor;
    const layer = makeFakeGitFoundryLayer({ actor: () => currentActor, domain, operations, namespaces: [namespace], repositories: [repository, sourceRepository], pullRequests: [pullRequest], checks: [check], trustedRevisions });
    const request = checkCreateRequest({ idempotency_key: "check-idem", headers: { authorization: "old-token" } });

    const first = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.create"), request), layer));
    const duplicate = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.create"), { ...request, headers: { authorization: "new-token" } }), layer));
    expect(first).toMatchObject({ status: "succeeded", replayed: false });
    expect(duplicate).toMatchObject({ status: "succeeded", replayed: true });
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.create"), { ...request, body: { ...(request.body as Record<string, unknown>), name: "ci/test" } }), layer))).rejects.toBeInstanceOf(IdempotencyConflictError);

    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.create"), checkCreateRequest({ body: { ...(request.body as Record<string, unknown>), extra: "nope" }, idempotency_key: "check-unknown-field" })), layer))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.annotations"), checkAnnotationsRequest({ query: { extra: "nope" } })), layer))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.create"), checkCreateRequest({ body: { ...(request.body as Record<string, unknown>), commit_sha: "dddddddddddddddddddddddddddddddddddddddd", head_sha: "dddddddddddddddddddddddddddddddddddddddd" }, idempotency_key: "check-untrusted-sha" })), layer))).rejects.toBeInstanceOf(NotFoundError);
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.edit"), checkEditRequest({ expected_version: 5 })), layer))).rejects.toBeInstanceOf(StalePreconditionError);

    const firstView = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.view"), checkViewRequest({ idempotency_key: "check-view-revoked-replay" })), layer));
    expect(firstView).toMatchObject({ status: "succeeded", replayed: false });
    currentActor = { ...actor, revoked: true };
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.view"), checkViewRequest({ idempotency_key: "check-view-revoked-replay" })), layer))).rejects.toBeInstanceOf(UnauthorizedError);
    currentActor = actor;

    const completed = await Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.edit"), checkEditRequest({ idempotency_key: "check-complete", body: { status: "completed", conclusion: "success" } })), layer));
    expect(completed).toMatchObject({ status: "succeeded" });
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.edit"), checkEditRequest({ expected_version: 2, idempotency_key: "check-terminal", body: { conclusion: "failure" } })), layer))).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const producerGuard = makeFakeGitFoundryLayer({ actor: { ...actor, id: "actor-b" }, domain, operations, namespaces: [namespace], repositories: [repository], checks: [check], trustedRevisions });
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.edit"), checkEditRequest()), producerGuard))).rejects.toBeInstanceOf(UnauthorizedError);

    const readlessLayer = makeFakeGitFoundryLayer({ actor: { ...actor, capabilities: actor.capabilities.filter((capability) => capability !== "check.read") }, domain, operations, namespaces: [namespace], repositories: [repository], checks: [check], trustedRevisions });
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.view"), checkViewRequest()), readlessLayer))).rejects.toBeInstanceOf(UnauthorizedError);

    const hiddenRepositoryLayer = makeFakeGitFoundryLayer({ actor, domain, operations, namespaces: [namespace], repositories: [repository], checks: [{ ...check, id: "check-hidden", repository_id: "repo-source" }], trustedRevisions });
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.view"), checkViewRequest({ route: { tenant_id: "tenant-a", id: "check-hidden" } })), hiddenRepositoryLayer))).rejects.toBeInstanceOf(NotFoundError);
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.annotations"), checkAnnotationsRequest({ route: { tenant_id: "tenant-b", id: "check-a" } })), layer))).rejects.toBeInstanceOf(UnauthorizedError);

    currentActor = { ...actor, revoked: true };
    await expect(Effect.runPromise(Effect.provide(dispatchOperation(operation(operations, "check.create"), request), layer))).rejects.toBeInstanceOf(UnauthorizedError);
  });

});

function checkCreateRequest(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "check.create",
    route: { tenant_id: "tenant-a" },
    query: {},
    headers: {},
    body: {
      repository_id: "repo-a",
      commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      base_sha: null,
      execution_sha: null,
      plan_digest: null,
      policy_digest: null,
      job_attempt_id: null,
      evidence_kind: "external",
      candidate_bound: false,
      provider_evidence_ref: "provider/run/2",
      name: "ci/build",
      status: "in_progress",
      conclusion: null,
      details_url: "https://checks.example/run/2",
      output: { title: "build", summary: "running", text: null },
      annotations: []
    },
    cookies: {},
    idempotency_key: "check-create-key",
    expected_version: 0,
    api_version: "v1",
    ...overrides
  };
}

function checkEditRequest(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "check.edit",
    route: { tenant_id: "tenant-a", id: "check-a" },
    query: {},
    headers: {},
    body: { details_url: "https://checks.example/run/1-updated" },
    cookies: {},
    idempotency_key: "check-edit-key",
    expected_version: 1,
    api_version: "v1",
    ...overrides
  };
}

function checkViewRequest(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "check.view",
    route: { tenant_id: "tenant-a", id: "check-a" },
    query: {},
    headers: {},
    body: null,
    cookies: {},
    api_version: "v1",
    ...overrides
  };
}

function checkAnnotationsRequest(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "check.annotations",
    route: { tenant_id: "tenant-a", id: "check-a" },
    query: {},
    headers: {},
    body: null,
    cookies: {},
    api_version: "v1",
    ...overrides
  };
}
