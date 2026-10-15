import { Context, Effect } from "effect";

import { InvalidStateTransitionError, NotFoundError, StalePreconditionError, type Actor, type Repository } from "../index.js";

export const forgeImplementedOperationIds = [
  "issue.list",
  "issue.view",
  "issue.create",
  "issue.edit",
  "issue.close",
  "issue.reopen",
  "pr.list",
  "pr.view",
  "pr.create",
  "pr.edit",
  "pr.close",
  "pr.reopen",
  "pr.ready",
  "pr.draft",
  "comment.list",
  "comment.view",
  "comment.create",
  "comment.edit",
  "review.list",
  "review.view",
  "review.create",
  "review.edit",
  "review.submit",
  "review.dismiss"
] as const;

export type ForgeImplementedOperationId = typeof forgeImplementedOperationIds[number];

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

export interface Issue {
  readonly tenant_id: string;
  readonly id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly repository_id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly state_reason: "completed" | "not_planned" | "reopened";
  readonly author_id: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export interface IssueCreateInput {
  readonly repository_id: string;
  readonly title: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestone_id?: string;
}

export interface IssuePatchInput {
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestone_id?: string | null;
}

export interface IssueCloseInput {
  readonly expected_version: number;
  readonly reason: "completed" | "not_planned";
}

export interface ForgeVersionActionInput {
  readonly expected_version: number;
  readonly reason?: string;
}

export interface PullRequest {
  readonly tenant_id: string;
  readonly id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly repository_id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly source_repository_id: string;
  readonly source_ref: string;
  readonly head_sha: string;
  readonly target_ref: string;
  readonly base_sha: string;
  readonly author_id: string;
}

export interface PullRequestCreateInput {
  readonly repository_id: string;
  readonly source_repository_id: string;
  readonly source_ref: string;
  readonly target_ref: string;
  readonly title: string;
  readonly body?: string;
  readonly draft?: boolean;
}

export interface PullRequestPatchInput {
  readonly title?: string;
  readonly body?: string;
  readonly target_ref?: string;
}

export interface Comment {
  readonly tenant_id: string;
  readonly id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly repository_id: string;
  readonly subject_kind: "issue" | "pull_request" | "review" | "discussion";
  readonly subject_id: string;
  readonly author_id: string;
  readonly body: string;
  readonly anchor: Record<string, unknown>;
}

export interface CommentCreateInput {
  readonly repository_id: string;
  readonly subject_kind: "issue" | "pull_request" | "review" | "discussion";
  readonly subject_id: string;
  readonly body: string;
  readonly anchor?: Record<string, unknown>;
}

export interface CommentPatchInput {
  readonly body: string;
}

export interface Review {
  readonly tenant_id: string;
  readonly id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly repository_id: string;
  readonly pull_request_id: string;
  readonly reviewer_id: string;
  readonly head_sha: string;
  readonly state: "pending" | "commented" | "approved" | "changes_requested" | "dismissed";
  readonly body: string;
}

export interface ReviewCreateInput {
  readonly repository_id: string;
  readonly pull_request_id: string;
  readonly body?: string;
  readonly comments?: readonly Record<string, unknown>[];
}

export interface ReviewPatchInput {
  readonly body?: string;
  readonly comments?: readonly Record<string, unknown>[];
}

export interface ReviewSubmitInput {
  readonly expected_version: number;
  readonly head_sha: string;
  readonly decision: "approved" | "commented" | "changes_requested";
  readonly body?: string;
}

export interface ReviewDismissInput {
  readonly expected_version: number;
  readonly reason: string;
}

export type ForgeListQuery = Record<string, unknown>;
export type ForgeStoreError = NotFoundError | StalePreconditionError | InvalidStateTransitionError;

export interface ForgeStore {
  readonly listIssues: (tenantId: string, query: ForgeListQuery) => Effect.Effect<Page<Issue>, NotFoundError>;
  readonly getIssue: (tenantId: string, id: string) => Effect.Effect<Issue, NotFoundError>;
  readonly createIssue: (tenantId: string, actor: Actor, input: IssueCreateInput) => Effect.Effect<Issue, NotFoundError>;
  readonly updateIssue: (tenantId: string, id: string, expectedVersion: number, input: IssuePatchInput) => Effect.Effect<Issue, ForgeStoreError>;
  readonly closeIssue?: (tenantId: string, id: string, input: IssueCloseInput) => Effect.Effect<Issue, ForgeStoreError>;
  readonly reopenIssue?: (tenantId: string, id: string, input: ForgeVersionActionInput) => Effect.Effect<Issue, ForgeStoreError>;
  readonly listPullRequests: (tenantId: string, query: ForgeListQuery) => Effect.Effect<Page<PullRequest>, NotFoundError>;
  readonly getPullRequest: (tenantId: string, id: string) => Effect.Effect<PullRequest, NotFoundError>;
  readonly createPullRequest: (tenantId: string, actor: Actor, input: PullRequestCreateInput) => Effect.Effect<PullRequest, NotFoundError>;
  readonly updatePullRequest: (tenantId: string, id: string, expectedVersion: number, input: PullRequestPatchInput) => Effect.Effect<PullRequest, ForgeStoreError>;
  readonly closePullRequest?: (tenantId: string, id: string, input: ForgeVersionActionInput) => Effect.Effect<PullRequest, ForgeStoreError>;
  readonly reopenPullRequest?: (tenantId: string, id: string, input: ForgeVersionActionInput) => Effect.Effect<PullRequest, ForgeStoreError>;
  readonly markPullRequestReady?: (tenantId: string, id: string, input: ForgeVersionActionInput) => Effect.Effect<PullRequest, ForgeStoreError>;
  readonly markPullRequestDraft?: (tenantId: string, id: string, input: ForgeVersionActionInput) => Effect.Effect<PullRequest, ForgeStoreError>;
  readonly listComments: (tenantId: string, query: ForgeListQuery) => Effect.Effect<Page<Comment>, NotFoundError>;
  readonly getComment: (tenantId: string, id: string) => Effect.Effect<Comment, NotFoundError>;
  readonly createComment: (tenantId: string, actor: Actor, input: CommentCreateInput) => Effect.Effect<Comment, NotFoundError>;
  readonly updateComment: (tenantId: string, id: string, expectedVersion: number, input: CommentPatchInput) => Effect.Effect<Comment, ForgeStoreError>;
  readonly listReviews: (tenantId: string, query: ForgeListQuery) => Effect.Effect<Page<Review>, NotFoundError>;
  readonly getReview: (tenantId: string, id: string) => Effect.Effect<Review, NotFoundError>;
  readonly createReview: (tenantId: string, actor: Actor, input: ReviewCreateInput) => Effect.Effect<Review, NotFoundError>;
  readonly updateReview: (tenantId: string, id: string, expectedVersion: number, input: ReviewPatchInput) => Effect.Effect<Review, ForgeStoreError>;
  readonly submitReview?: (tenantId: string, id: string, input: ReviewSubmitInput) => Effect.Effect<Review, ForgeStoreError>;
  readonly dismissReview?: (tenantId: string, id: string, input: ReviewDismissInput) => Effect.Effect<Review, ForgeStoreError>;
}

export const ForgeStore = Context.Service<ForgeStore>("gitfoundry/ForgeStore");

export function isForgeImplementedOperationId(operationId: string): operationId is ForgeImplementedOperationId {
  return (forgeImplementedOperationIds as readonly string[]).includes(operationId);
}

export function makeFakeForgeStore(input: {
  readonly repositories: readonly Repository[];
  readonly issues?: readonly Issue[];
  readonly pullRequests?: readonly PullRequest[];
  readonly comments?: readonly Comment[];
  readonly reviews?: readonly Review[];
  readonly now?: string;
}): ForgeStore {
  const now = input.now ?? "2026-10-07T18:00:00Z";
  const repositories = new Map(input.repositories.map((repository) => [key(repository.tenant_id, repository.id), { ...repository }]));
  const issues = new Map((input.issues ?? []).map((issue) => [key(issue.tenant_id, issue.id), copyIssue(issue)]));
  const pullRequests = new Map((input.pullRequests ?? []).map((pullRequest) => [key(pullRequest.tenant_id, pullRequest.id), copyPullRequest(pullRequest)]));
  const comments = new Map((input.comments ?? []).map((comment) => [key(comment.tenant_id, comment.id), copyComment(comment)]));
  const reviews = new Map((input.reviews ?? []).map((review) => [key(review.tenant_id, review.id), copyReview(review)]));

  return {
    listIssues: (tenantId, query) => Effect.gen(function* () {
      yield* assertOptionalRepository(repositories, tenantId, stringField(query, "repository_id"));
      return page(Array.from(issues.values()).filter((issue) => belongsToTenantAndQuery(issue, tenantId, query)).map(copyIssue));
    }),
    getIssue: (tenantId, id) => getFromMap(issues, tenantId, id, "issue", copyIssue),
    createIssue: (tenantId, actor, input) => Effect.gen(function* () {
      yield* requireRepository(repositories, tenantId, input.repository_id);
      const issue: Issue = {
        tenant_id: tenantId,
        id: makeId("issue", input.repository_id, nextNumber(issues, tenantId, input.repository_id)),
        version: 1,
        created_at: now,
        updated_at: now,
        repository_id: input.repository_id,
        number: nextNumber(issues, tenantId, input.repository_id),
        title: input.title,
        body: input.body ?? "",
        state: "open",
        state_reason: "reopened",
        author_id: actor.id,
        labels: [...(input.labels ?? [])],
        assignees: [...(input.assignees ?? [])]
      };
      issues.set(key(tenantId, issue.id), copyIssue(issue));
      return copyIssue(issue);
    }),
    updateIssue: (tenantId, id, expectedVersion, patch) => Effect.gen(function* () {
      const issue = yield* getFromMap(issues, tenantId, id, "issue", copyIssue);
      yield* requireVersion(expectedVersion, issue.version);
      const updated: Issue = { ...issue, ...definedPatch(patch), version: issue.version + 1, updated_at: now };
      issues.set(key(tenantId, id), copyIssue(updated));
      return copyIssue(updated);
    }),
    closeIssue: (tenantId, id, action) => Effect.gen(function* () {
      const issue = yield* getFromMap(issues, tenantId, id, "issue", copyIssue);
      yield* requireRepository(repositories, tenantId, issue.repository_id);
      yield* requireVersion(action.expected_version, issue.version);
      if (issue.state !== "open") return yield* invalidTransition("issue", id, issue.state, "closed");
      const updated: Issue = { ...issue, state: "closed", state_reason: action.reason, version: issue.version + 1, updated_at: now };
      issues.set(key(tenantId, id), copyIssue(updated));
      return copyIssue(updated);
    }),
    reopenIssue: (tenantId, id, action) => Effect.gen(function* () {
      const issue = yield* getFromMap(issues, tenantId, id, "issue", copyIssue);
      yield* requireRepository(repositories, tenantId, issue.repository_id);
      yield* requireVersion(action.expected_version, issue.version);
      if (issue.state !== "closed") return yield* invalidTransition("issue", id, issue.state, "open");
      const updated: Issue = { ...issue, state: "open", state_reason: "reopened", version: issue.version + 1, updated_at: now };
      issues.set(key(tenantId, id), copyIssue(updated));
      return copyIssue(updated);
    }),
    listPullRequests: (tenantId, query) => Effect.gen(function* () {
      yield* assertOptionalRepository(repositories, tenantId, stringField(query, "repository_id"));
      yield* assertOptionalRepository(repositories, tenantId, stringField(query, "source_repository_id"));
      return page(Array.from(pullRequests.values()).filter((pullRequest) => belongsToTenantAndQuery(pullRequest, tenantId, query)).map(copyPullRequest));
    }),
    getPullRequest: (tenantId, id) => getFromMap(pullRequests, tenantId, id, "pull_request", copyPullRequest),
    createPullRequest: (tenantId, actor, input) => Effect.gen(function* () {
      yield* requireRepository(repositories, tenantId, input.repository_id);
      yield* requireRepository(repositories, tenantId, input.source_repository_id);
      const number = nextNumber(pullRequests, tenantId, input.repository_id);
      const pullRequest: PullRequest = {
        tenant_id: tenantId,
        id: makeId("pr", input.repository_id, number),
        version: 1,
        created_at: now,
        updated_at: now,
        repository_id: input.repository_id,
        number,
        title: input.title,
        body: input.body ?? "",
        state: "open",
        draft: input.draft ?? false,
        source_repository_id: input.source_repository_id,
        source_ref: input.source_ref,
        head_sha: fakeSha("head", input.source_repository_id, input.source_ref),
        target_ref: input.target_ref,
        base_sha: fakeSha("base", input.repository_id, input.target_ref),
        author_id: actor.id
      };
      pullRequests.set(key(tenantId, pullRequest.id), copyPullRequest(pullRequest));
      return copyPullRequest(pullRequest);
    }),
    updatePullRequest: (tenantId, id, expectedVersion, patch) => Effect.gen(function* () {
      const pullRequest = yield* getFromMap(pullRequests, tenantId, id, "pull_request", copyPullRequest);
      yield* requireVersion(expectedVersion, pullRequest.version);
      const updated: PullRequest = { ...pullRequest, ...definedPatch(patch), version: pullRequest.version + 1, updated_at: now };
      pullRequests.set(key(tenantId, id), copyPullRequest(updated));
      return copyPullRequest(updated);
    }),
    closePullRequest: (tenantId, id, action) => Effect.gen(function* () {
      const pullRequest = yield* getFromMap(pullRequests, tenantId, id, "pull_request", copyPullRequest);
      yield* requirePullRequestRepositories(repositories, tenantId, pullRequest);
      yield* requireVersion(action.expected_version, pullRequest.version);
      if (pullRequest.state !== "open") return yield* invalidTransition("pull_request", id, pullRequest.state, "closed");
      const updated: PullRequest = { ...pullRequest, state: "closed", version: pullRequest.version + 1, updated_at: now };
      pullRequests.set(key(tenantId, id), copyPullRequest(updated));
      return copyPullRequest(updated);
    }),
    reopenPullRequest: (tenantId, id, action) => Effect.gen(function* () {
      const pullRequest = yield* getFromMap(pullRequests, tenantId, id, "pull_request", copyPullRequest);
      yield* requirePullRequestRepositories(repositories, tenantId, pullRequest);
      yield* requireVersion(action.expected_version, pullRequest.version);
      if (pullRequest.state !== "closed") return yield* invalidTransition("pull_request", id, pullRequest.state, "open");
      const updated: PullRequest = { ...pullRequest, state: "open", version: pullRequest.version + 1, updated_at: now };
      pullRequests.set(key(tenantId, id), copyPullRequest(updated));
      return copyPullRequest(updated);
    }),
    markPullRequestReady: (tenantId, id, action) => Effect.gen(function* () {
      const pullRequest = yield* getFromMap(pullRequests, tenantId, id, "pull_request", copyPullRequest);
      yield* requirePullRequestRepositories(repositories, tenantId, pullRequest);
      yield* requireVersion(action.expected_version, pullRequest.version);
      if (pullRequest.state !== "open") return yield* invalidTransition("pull_request", id, pullRequest.state, "open");
      if (!pullRequest.draft) return yield* invalidTransition("pull_request", id, "ready", "draft");
      const updated: PullRequest = { ...pullRequest, draft: false, version: pullRequest.version + 1, updated_at: now };
      pullRequests.set(key(tenantId, id), copyPullRequest(updated));
      return copyPullRequest(updated);
    }),
    markPullRequestDraft: (tenantId, id, action) => Effect.gen(function* () {
      const pullRequest = yield* getFromMap(pullRequests, tenantId, id, "pull_request", copyPullRequest);
      yield* requirePullRequestRepositories(repositories, tenantId, pullRequest);
      yield* requireVersion(action.expected_version, pullRequest.version);
      if (pullRequest.state !== "open") return yield* invalidTransition("pull_request", id, pullRequest.state, "open");
      if (pullRequest.draft) return yield* invalidTransition("pull_request", id, "draft", "ready");
      const updated: PullRequest = { ...pullRequest, draft: true, version: pullRequest.version + 1, updated_at: now };
      pullRequests.set(key(tenantId, id), copyPullRequest(updated));
      return copyPullRequest(updated);
    }),
    listComments: (tenantId, query) => Effect.gen(function* () {
      yield* assertOptionalRepository(repositories, tenantId, stringField(query, "repository_id"));
      return page(Array.from(comments.values()).filter((comment) => belongsToTenantAndQuery(comment, tenantId, query)).map(copyComment));
    }),
    getComment: (tenantId, id) => getFromMap(comments, tenantId, id, "comment", copyComment),
    createComment: (tenantId, actor, input) => Effect.gen(function* () {
      yield* requireRepository(repositories, tenantId, input.repository_id);
      yield* requireSubject(tenantId, input.repository_id, input.subject_kind, input.subject_id, issues, pullRequests, reviews);
      const comment: Comment = {
        tenant_id: tenantId,
        id: makeId("comment", input.repository_id, nextNumber(comments, tenantId, input.repository_id)),
        version: 1,
        created_at: now,
        updated_at: now,
        repository_id: input.repository_id,
        subject_kind: input.subject_kind,
        subject_id: input.subject_id,
        author_id: actor.id,
        body: input.body,
        anchor: { ...(input.anchor ?? {}) }
      };
      comments.set(key(tenantId, comment.id), copyComment(comment));
      return copyComment(comment);
    }),
    updateComment: (tenantId, id, expectedVersion, patch) => Effect.gen(function* () {
      const comment = yield* getFromMap(comments, tenantId, id, "comment", copyComment);
      yield* requireVersion(expectedVersion, comment.version);
      const updated: Comment = { ...comment, body: patch.body, version: comment.version + 1, updated_at: now };
      comments.set(key(tenantId, id), copyComment(updated));
      return copyComment(updated);
    }),
    listReviews: (tenantId, query) => Effect.gen(function* () {
      yield* assertOptionalRepository(repositories, tenantId, stringField(query, "repository_id"));
      return page(Array.from(reviews.values()).filter((review) => belongsToTenantAndQuery(review, tenantId, query)).map(copyReview));
    }),
    getReview: (tenantId, id) => getFromMap(reviews, tenantId, id, "review", copyReview),
    createReview: (tenantId, actor, input) => Effect.gen(function* () {
      yield* requireRepository(repositories, tenantId, input.repository_id);
      const pullRequest = yield* getFromMap(pullRequests, tenantId, input.pull_request_id, "pull_request", copyPullRequest);
      if (pullRequest.repository_id !== input.repository_id) return yield* Effect.fail(new NotFoundError({ resource: "pull_request", id: input.pull_request_id }));
      const review: Review = {
        tenant_id: tenantId,
        id: makeId("review", input.repository_id, nextNumber(reviews, tenantId, input.repository_id)),
        version: 1,
        created_at: now,
        updated_at: now,
        repository_id: input.repository_id,
        pull_request_id: input.pull_request_id,
        reviewer_id: actor.id,
        head_sha: pullRequest.head_sha,
        state: "pending",
        body: input.body ?? ""
      };
      reviews.set(key(tenantId, review.id), copyReview(review));
      return copyReview(review);
    }),
    updateReview: (tenantId, id, expectedVersion, patch) => Effect.gen(function* () {
      const review = yield* getFromMap(reviews, tenantId, id, "review", copyReview);
      yield* requireVersion(expectedVersion, review.version);
      const updated: Review = { ...review, ...definedPatch(patch), version: review.version + 1, updated_at: now };
      reviews.set(key(tenantId, id), copyReview(updated));
      return copyReview(updated);
    }),
    submitReview: (tenantId, id, action) => Effect.gen(function* () {
      const review = yield* getFromMap(reviews, tenantId, id, "review", copyReview);
      yield* requireReviewRepository(repositories, pullRequests, tenantId, review);
      yield* requireVersion(action.expected_version, review.version);
      if (review.state !== "pending") return yield* invalidTransition("review", id, review.state, "pending");
      if (review.head_sha !== action.head_sha) return yield* invalidTransition("review", id, action.head_sha, review.head_sha);
      const updated: Review = { ...review, state: action.decision, body: action.body ?? review.body, version: review.version + 1, updated_at: now };
      reviews.set(key(tenantId, id), copyReview(updated));
      return copyReview(updated);
    }),
    dismissReview: (tenantId, id, action) => Effect.gen(function* () {
      const review = yield* getFromMap(reviews, tenantId, id, "review", copyReview);
      yield* requireReviewRepository(repositories, pullRequests, tenantId, review);
      yield* requireVersion(action.expected_version, review.version);
      if (review.state === "pending") return yield* invalidTransition("review", id, review.state, "submitted");
      if (review.state === "dismissed") return yield* invalidTransition("review", id, review.state, "submitted");
      const updated: Review = { ...review, state: "dismissed", version: review.version + 1, updated_at: now };
      reviews.set(key(tenantId, id), copyReview(updated));
      return copyReview(updated);
    })
  };
}

function key(tenantId: string, id: string): string { return tenantId + ":" + id; }

function makeId(kind: string, repositoryId: string, number: number): string { return repositoryId + "-" + kind + "-" + number; }

function fakeSha(kind: string, repositoryId: string, ref: string): string {
  const source = kind + ":" + repositoryId + ":" + ref;
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) hash = ((hash << 5) + hash) ^ source.charCodeAt(index);
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(5).slice(0, 40);
}

function nextNumber<T extends { readonly tenant_id: string; readonly repository_id: string; readonly number?: number }>(items: Map<string, T>, tenantId: string, repositoryId: string): number {
  const numbers = Array.from(items.values()).filter((item) => item.tenant_id === tenantId && item.repository_id === repositoryId).map((item) => item.number ?? 0);
  return Math.max(0, ...numbers) + 1;
}

function page<T>(items: readonly T[]): Page<T> { return { items, next_cursor: null, has_more: false }; }

function definedPatch<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function stringField(query: ForgeListQuery, keyName: string): string | undefined {
  const value = query[keyName];
  return typeof value === "string" ? value : undefined;
}

function belongsToTenantAndQuery<T extends { readonly tenant_id: string }>(item: T, tenantId: string, query: ForgeListQuery): boolean {
  if (item.tenant_id !== tenantId) return false;
  const record = item as Record<string, unknown>;
  for (const [queryKey, queryValue] of Object.entries(query)) {
    if (queryValue === undefined || queryValue === null || queryKey === "cursor" || queryKey === "limit" || queryKey === "sort" || queryKey === "direction") continue;
    if (Array.isArray(queryValue)) {
      if (!queryValue.every((value) => Array.isArray(record[queryKey]) && (record[queryKey] as readonly unknown[]).includes(value))) return false;
    } else if (record[queryKey] !== queryValue) return false;
  }
  return true;
}

function requireRepository(repositories: Map<string, Repository>, tenantId: string, id: string): Effect.Effect<Repository, NotFoundError> {
  const repository = repositories.get(key(tenantId, id));
  return repository ? Effect.succeed({ ...repository }) : Effect.fail(new NotFoundError({ resource: "repository", id }));
}

function assertOptionalRepository(repositories: Map<string, Repository>, tenantId: string, id: string | undefined): Effect.Effect<void, NotFoundError> {
  return id ? Effect.asVoid(requireRepository(repositories, tenantId, id)) : Effect.void;
}

function requireVersion(expected: number, actual: number): Effect.Effect<void, StalePreconditionError> {
  return expected === actual ? Effect.void : Effect.fail(new StalePreconditionError({ expected, actual }));
}

function invalidTransition(resource: string, id: string, state: string, expectedState: string): Effect.Effect<never, InvalidStateTransitionError> {
  return Effect.fail(new InvalidStateTransitionError({ resource, id, state, expectedState }));
}

function requirePullRequestRepositories(repositories: Map<string, Repository>, tenantId: string, pullRequest: PullRequest): Effect.Effect<void, NotFoundError> {
  return Effect.gen(function* () {
    yield* requireRepository(repositories, tenantId, pullRequest.repository_id);
    yield* requireRepository(repositories, tenantId, pullRequest.source_repository_id);
  });
}

function requireReviewRepository(repositories: Map<string, Repository>, pullRequests: Map<string, PullRequest>, tenantId: string, review: Review): Effect.Effect<void, NotFoundError> {
  return Effect.gen(function* () {
    yield* requireRepository(repositories, tenantId, review.repository_id);
    const pullRequest = yield* getFromMap(pullRequests, tenantId, review.pull_request_id, "pull_request", copyPullRequest);
    if (pullRequest.repository_id !== review.repository_id) return yield* Effect.fail(new NotFoundError({ resource: "pull_request", id: review.pull_request_id }));
  });
}

function getFromMap<T>(items: Map<string, T>, tenantId: string, id: string, resource: string, copy: (value: T) => T): Effect.Effect<T, NotFoundError> {
  const item = items.get(key(tenantId, id));
  return item ? Effect.succeed(copy(item)) : Effect.fail(new NotFoundError({ resource, id }));
}

function requireSubject(
  tenantId: string,
  repositoryId: string,
  subjectKind: Comment["subject_kind"],
  subjectId: string,
  issues: Map<string, Issue>,
  pullRequests: Map<string, PullRequest>,
  reviews: Map<string, Review>
): Effect.Effect<void, NotFoundError> {
  if (subjectKind === "discussion") return Effect.void;
  const source = subjectKind === "issue" ? issues : subjectKind === "pull_request" ? pullRequests : reviews;
  const subject = source.get(key(tenantId, subjectId));
  if (!subject || subject.repository_id !== repositoryId) return Effect.fail(new NotFoundError({ resource: subjectKind, id: subjectId }));
  return Effect.void;
}

function copyIssue(issue: Issue): Issue { return { ...issue, labels: [...issue.labels], assignees: [...issue.assignees] }; }
function copyPullRequest(pullRequest: PullRequest): PullRequest { return { ...pullRequest }; }
function copyComment(comment: Comment): Comment { return { ...comment, anchor: { ...comment.anchor } }; }
function copyReview(review: Review): Review { return { ...review }; }
