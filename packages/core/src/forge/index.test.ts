import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { InvalidStateTransitionError, NotFoundError, StalePreconditionError, type Actor, type Repository } from "../index.js";
import { makeFakeForgeStore, type Issue, type PullRequest, type Review } from "./index.js";

const actor: Actor = { id: "actor-a", tenantId: "tenant-a", revoked: false, capabilities: [] };
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
  git_url: "https://gitfoundry.example/tenant-a/repo-a.git"
};
const issue: Issue = {
  tenant_id: "tenant-a",
  id: "issue-a",
  version: 2,
  created_at: "2026-10-07T18:00:00Z",
  updated_at: "2026-10-07T18:00:00Z",
  repository_id: "repo-a",
  number: 1,
  title: "Old title",
  body: "Old body",
  state: "open",
  state_reason: "reopened",
  author_id: "actor-a",
  labels: [],
  assignees: []
};
const pullRequest: PullRequest = {
  tenant_id: "tenant-a",
  id: "pr-a",
  version: 4,
  created_at: "2026-10-07T18:00:00Z",
  updated_at: "2026-10-07T18:00:00Z",
  repository_id: "repo-a",
  number: 2,
  title: "PR",
  body: "PR body",
  state: "open",
  draft: true,
  source_repository_id: "repo-a",
  source_ref: "feature",
  head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target_ref: "main",
  base_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  author_id: "actor-a"
};
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

describe("P1 forge fake storage port", () => {
  it("creates only in repositories owned by the tenant", async () => {
    const store = makeFakeForgeStore({ repositories: [repository] });
    const created = await Effect.runPromise(store.createIssue("tenant-a", actor, { repository_id: "repo-a", title: "New issue" }));
    expect(created).toMatchObject({ tenant_id: "tenant-a", repository_id: "repo-a", title: "New issue", version: 1 });

    await expect(Effect.runPromise(store.createIssue("tenant-a", actor, { repository_id: "repo-b", title: "Missing repo" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("enforces expected-version compare-and-swap on updates", async () => {
    const store = makeFakeForgeStore({ repositories: [repository], issues: [issue] });
    await expect(Effect.runPromise(store.updateIssue("tenant-a", "issue-a", 1, { title: "stale" }))).rejects.toBeInstanceOf(StalePreconditionError);

    const updated = await Effect.runPromise(store.updateIssue("tenant-a", "issue-a", 2, { title: "Fresh" }));
    expect(updated).toMatchObject({ title: "Fresh", version: 3 });
  });

  it("applies issue and pull request state transitions through the fake port", async () => {
    const store = makeFakeForgeStore({ repositories: [repository], issues: [issue], pullRequests: [pullRequest] });

    const closedIssue = await Effect.runPromise(store.closeIssue!("tenant-a", "issue-a", { expected_version: 2, reason: "completed" }));
    expect(closedIssue).toMatchObject({ state: "closed", state_reason: "completed", version: 3 });
    const reopenedIssue = await Effect.runPromise(store.reopenIssue!("tenant-a", "issue-a", { expected_version: 3 }));
    expect(reopenedIssue).toMatchObject({ state: "open", state_reason: "reopened", version: 4 });

    const ready = await Effect.runPromise(store.markPullRequestReady!("tenant-a", "pr-a", { expected_version: 4 }));
    expect(ready).toMatchObject({ draft: false, state: "open", version: 5 });
    const draft = await Effect.runPromise(store.markPullRequestDraft!("tenant-a", "pr-a", { expected_version: 5 }));
    expect(draft).toMatchObject({ draft: true, state: "open", version: 6 });
    const closedPr = await Effect.runPromise(store.closePullRequest!("tenant-a", "pr-a", { expected_version: 6 }));
    expect(closedPr).toMatchObject({ state: "closed", version: 7 });
    const reopenedPr = await Effect.runPromise(store.reopenPullRequest!("tenant-a", "pr-a", { expected_version: 7 }));
    expect(reopenedPr).toMatchObject({ state: "open", version: 8 });
  });

  it("submits and dismisses reviews only from valid states", async () => {
    const store = makeFakeForgeStore({ repositories: [repository], pullRequests: [pullRequest], reviews: [review] });

    const submitted = await Effect.runPromise(store.submitReview!("tenant-a", "review-a", {
      expected_version: 1,
      head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      decision: "approved",
      body: "ship it"
    }));
    expect(submitted).toMatchObject({ state: "approved", body: "ship it", version: 2 });
    const dismissed = await Effect.runPromise(store.dismissReview!("tenant-a", "review-a", { expected_version: 2, reason: "superseded" }));
    expect(dismissed).toMatchObject({ state: "dismissed", version: 3 });

    await expect(Effect.runPromise(store.dismissReview!("tenant-a", "review-a", { expected_version: 3, reason: "again" }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("rejects invalid state transitions and crossed repository review state", async () => {
    const crossedPullRequest: PullRequest = { ...pullRequest, id: "pr-cross", repository_id: "repo-missing" };
    const crossedReview: Review = { ...review, id: "review-cross", pull_request_id: "pr-cross" };
    const store = makeFakeForgeStore({ repositories: [repository], issues: [{ ...issue, state: "closed", state_reason: "completed" }], pullRequests: [pullRequest, crossedPullRequest], reviews: [review, crossedReview] });

    await expect(Effect.runPromise(store.closeIssue!("tenant-a", "issue-a", { expected_version: 2, reason: "completed" }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(Effect.runPromise(store.markPullRequestReady!("tenant-a", "pr-a", { expected_version: 3 }))).rejects.toBeInstanceOf(StalePreconditionError);
    await expect(Effect.runPromise(store.submitReview!("tenant-a", "review-a", { expected_version: 1, head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decision: "commented" }))).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(Effect.runPromise(store.submitReview!("tenant-a", "review-cross", { expected_version: 1, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", decision: "commented" }))).rejects.toBeInstanceOf(NotFoundError);
  });
});
