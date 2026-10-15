import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { DomainContractError, InvalidStateTransitionError, NotFoundError, StalePreconditionError, UnauthorizedError, type Actor, type Repository } from "../index.js";
import type { PullRequest } from "../forge/index.js";
import { makeFakeCheckStore, type Check, type CheckAnnotation, type TrustedRevision } from "./index.js";

const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const staleHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const executionSha = "cccccccccccccccccccccccccccccccccccccccc";
const baseSha = "dddddddddddddddddddddddddddddddddddddddd";
const now = "2026-10-08T00:00:00Z";

const actor: Actor = { id: "producer-a", tenantId: "tenant-a", revoked: false, capabilities: ["check.read", "check.write"] };
const otherActor: Actor = { ...actor, id: "producer-b" };
const repository: Repository = { tenant_id: "tenant-a", id: "repo-a", version: 1, created_at: now, updated_at: now, namespace_id: "namespace-a", name: "repo", visibility: "private", default_branch: "main", archived: false, fork_of: null, git_url: "https://gitfoundry.invalid/repo-a.git" };
const otherTenantRepository: Repository = { ...repository, tenant_id: "tenant-b", id: "repo-b", namespace_id: "namespace-b" };
const pullRequest: PullRequest = { tenant_id: "tenant-a", id: "pr-a", version: 1, created_at: now, updated_at: now, repository_id: "repo-a", number: 1, title: "PR", body: "", state: "open", draft: false, source_repository_id: "repo-a", source_ref: "feature", head_sha: headSha, target_ref: "main", base_sha: baseSha, author_id: "actor-a" };
const trustedRevisions: readonly TrustedRevision[] = [headSha, staleHeadSha, executionSha, baseSha].map((sha) => ({ tenant_id: "tenant-a", repository_id: "repo-a", sha }));

const annotation = (overrides: Partial<CheckAnnotation> = {}): CheckAnnotation => ({
  path: "src/main.ts",
  start_line: 1,
  end_line: 1,
  start_column: null,
  end_column: null,
  level: "notice",
  message: "ok",
  title: null,
  raw_details: null,
  ...overrides
});

const createExternal = (overrides: Partial<Parameters<ReturnType<typeof makeFakeCheckStore>["create"]>[2]> = {}) => ({
  repository_id: "repo-a",
  commit_sha: headSha,
  head_sha: headSha,
  base_sha: null,
  execution_sha: null,
  plan_digest: null,
  policy_digest: null,
  job_attempt_id: null,
  evidence_kind: "external" as const,
  candidate_bound: false,
  provider_evidence_ref: "provider/run/1",
  name: "ci/build",
  status: "in_progress" as const,
  conclusion: null,
  details_url: "https://checks.example/run/1",
  output: { title: "build", summary: "running", text: null },
  annotations: [],
  ...overrides
});

const existingCheck: Check = {
  tenant_id: "tenant-a",
  id: "check-a",
  version: 2,
  created_at: now,
  updated_at: now,
  repository_id: "repo-a",
  commit_sha: headSha,
  evidence_kind: "external",
  candidate_bound: false,
  head_sha: headSha,
  base_sha: null,
  execution_sha: null,
  plan_digest: null,
  policy_digest: null,
  job_attempt_id: null,
  provider_evidence_ref: "provider/run/1",
  name: "ci/build",
  producer_id: "producer-a",
  status: "in_progress",
  conclusion: null,
  details_url: "https://checks.example/run/1",
  output: null,
  annotations: []
};

const staleCheck: Check = { ...existingCheck, id: "check-stale", version: 1, head_sha: staleHeadSha, commit_sha: staleHeadSha, provider_evidence_ref: "provider/run/stale" };

describe("fake check domain store", () => {
  it("creates source-shaped external checks after repository ownership and exact revision validation", async () => {
    const store = makeFakeCheckStore({ repositories: [repository], trustedRevisions, now });

    const check = await Effect.runPromise(store.create("tenant-a", actor, createExternal()));

    expect(check).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", commit_sha: headSha, head_sha: headSha, producer_id: "producer-a", status: "in_progress", conclusion: null, version: 1 });
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ repository_id: "repo-b" })))).rejects.toBeInstanceOf(NotFoundError);
    await expect(Effect.runPromise(makeFakeCheckStore({ repositories: [otherTenantRepository], trustedRevisions, now }).create("tenant-a", actor, createExternal({ repository_id: "repo-b" })))).rejects.toBeInstanceOf(NotFoundError);
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ commit_sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", head_sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" })))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("enforces candidate-bound, native, historical, and terminal conclusion rules", async () => {
    const store = makeFakeCheckStore({ repositories: [repository], trustedRevisions, jobAttempts: [{ tenant_id: "tenant-a", id: "attempt-a" }], now });

    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ candidate_bound: true, commit_sha: executionSha, base_sha: baseSha, execution_sha: executionSha, plan_digest: "sha256:plan", policy_digest: "sha256:policy" })))).resolves.toMatchObject({ candidate_bound: true, commit_sha: executionSha });
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ candidate_bound: true, commit_sha: headSha, base_sha: baseSha, execution_sha: null, plan_digest: "sha256:plan", policy_digest: "sha256:policy" })))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ evidence_kind: "native_job", job_attempt_id: "missing", provider_evidence_ref: null })))).rejects.toBeInstanceOf(NotFoundError);
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ evidence_kind: "historical", status: "in_progress" })))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ status: "completed", conclusion: null })))).rejects.toBeInstanceOf(DomainContractError);
  });

  it("updates only by producer with CAS and rejects terminal mutation", async () => {
    const store = makeFakeCheckStore({ repositories: [repository], checks: [existingCheck], trustedRevisions, now });

    const completed = await Effect.runPromise(store.update("tenant-a", "check-a", actor, 2, { status: "completed", conclusion: "success", annotations_append: [{ path: "src/a.ts", start_line: 1, end_line: 1, start_column: null, end_column: null, level: "notice", message: "ok", title: null, raw_details: null }] }));
    expect(completed).toMatchObject({ version: 3, status: "completed", conclusion: "success", annotations: [{ message: "ok" }] });
    await expect(Effect.runPromise(store.update("tenant-a", "check-a", actor, 2, { details_url: "https://checks.example/old" }))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(store.update("tenant-a", "check-a", actor, 3, { conclusion: "failure" }))).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const producerGuard = makeFakeCheckStore({ repositories: [repository], checks: [existingCheck], trustedRevisions, now });
    await expect(Effect.runPromise(producerGuard.update("tenant-a", "check-a", otherActor, 2, { details_url: "https://checks.example/other" }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("views checks and pages source-bounded annotations within the tenant repository", async () => {
    const annotated = { ...existingCheck, annotations: [annotation({ message: "first" }), annotation({ message: "second", level: "warning" })] };
    const store = makeFakeCheckStore({ repositories: [repository], checks: [annotated], trustedRevisions, now });

    await expect(Effect.runPromise(store.view("tenant-a", "check-a"))).resolves.toMatchObject({ id: "check-a", repository_id: "repo-a" });
    await expect(Effect.runPromise(store.view("tenant-b", "check-a"))).rejects.toBeInstanceOf(NotFoundError);

    await expect(Effect.runPromise(store.listAnnotations("tenant-a", "check-a", { limit: 1 }))).resolves.toEqual({ items: [annotation({ message: "first" })], next_cursor: "1", has_more: true });
    await expect(Effect.runPromise(store.listAnnotations("tenant-a", "check-a", { cursor: "1", limit: 1 }))).resolves.toEqual({ items: [annotation({ message: "second", level: "warning" })], next_cursor: null, has_more: false });
  });

  it("rejects source-invalid annotation payloads before persistence", async () => {
    const store = makeFakeCheckStore({ repositories: [repository], checks: [existingCheck], trustedRevisions, now });
    const tooManyAnnotations = Array.from({ length: 51 }, (_, index) => annotation({ message: "annotation " + index }));

    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ annotations: tooManyAnnotations })))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(store.create("tenant-a", actor, createExternal({ annotations: [annotation({ path: "" })] })))).rejects.toBeInstanceOf(DomainContractError);
    await expect(Effect.runPromise(store.update("tenant-a", "check-a", actor, 2, { annotations_append: tooManyAnnotations }))).rejects.toBeInstanceOf(DomainContractError);
  });

  it("lists repository checks and PR checks for only the current head", async () => {
    const store = makeFakeCheckStore({ repositories: [repository], pullRequests: [pullRequest], checks: [existingCheck, staleCheck], trustedRevisions, now });

    await expect(Effect.runPromise(store.list("tenant-a", { repository_id: "repo-a", head_sha: headSha }))).resolves.toMatchObject({ items: [{ id: "check-a" }], has_more: false });
    await expect(Effect.runPromise(store.listForPullRequest("tenant-a", "pr-a", {}))).resolves.toMatchObject({ items: [{ id: "check-a" }], has_more: false });
    await expect(Effect.runPromise(store.listForPullRequest("tenant-b", "pr-a", {}))).rejects.toBeInstanceOf(NotFoundError);
  });
});
