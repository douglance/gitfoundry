import { Data, Effect } from "effect";

import { InvalidStateTransitionError, NotFoundError, StalePreconditionError } from "../index.js";
import type { Actor } from "../index.js";
import type { Comment, CommentCreateInput, CommentPatchInput, ForgeStore as CoreForgeStore, ForgeVersionActionInput, IssueCloseInput, IssueCreateInput, IssuePatchInput, PullRequestCreateInput, PullRequestPatchInput, Review, ReviewCreateInput, ReviewDismissInput, ReviewPatchInput, ReviewSubmitInput } from "../forge/index.js";
import type { Clock, D1DatabaseLike } from "./index.js";

export interface ForgePage<T> { readonly items: readonly T[]; readonly next_cursor: string | null; readonly has_more: boolean }
export interface ForgeIssue { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly number: number; readonly title: string; readonly body: string; readonly state: "open" | "closed"; readonly state_reason: "completed" | "not_planned" | "reopened"; readonly author_id: string; readonly labels: readonly string[]; readonly assignees: readonly string[] }
export interface ForgeIssueListQuery { readonly limit?: number; readonly cursor?: string; readonly sort?: "created_at" | "updated_at" | "id"; readonly direction?: "asc" | "desc"; readonly repository_id?: string; readonly state?: string; readonly author_id?: string; readonly assignee_id?: string; readonly label_ids?: readonly string[]; readonly since?: string }
export interface ForgeIssueCreateInput { readonly repository_id: string; readonly title: string; readonly body?: string; readonly labels?: readonly string[]; readonly assignees?: readonly string[]; readonly milestone_id?: string }
export interface ForgeIssuePatchInput { readonly title?: string; readonly body?: string; readonly labels?: readonly string[]; readonly assignees?: readonly string[]; readonly milestone_id?: string | null }

export interface ForgePullRequest { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly number: number; readonly title: string; readonly body: string; readonly state: "open" | "closed" | "merged"; readonly draft: boolean; readonly source_repository_id: string; readonly source_ref: string; readonly head_sha: string; readonly target_ref: string; readonly base_sha: string; readonly author_id: string }
export interface ForgePullRequestListQuery { readonly limit?: number; readonly cursor?: string; readonly sort?: "created_at" | "updated_at" | "id"; readonly direction?: "asc" | "desc"; readonly repository_id?: string; readonly state?: string; readonly author_id?: string; readonly draft?: boolean; readonly source_repository_id?: string }
export interface ForgePullRequestCreateInput { readonly repository_id: string; readonly source_repository_id: string; readonly source_ref: string; readonly target_ref: string; readonly title: string; readonly body?: string; readonly draft?: boolean }
export interface ForgePullRequestPatchInput { readonly title?: string; readonly body?: string; readonly target_ref?: string }

export interface ForgeIssueStore { readonly list: (tenantId: string, query: ForgeIssueListQuery) => Effect.Effect<ForgePage<ForgeIssue>>; readonly get: (tenantId: string, id: string) => Effect.Effect<ForgeIssue, NotFoundError>; readonly create: (tenantId: string, actorId: string, input: ForgeIssueCreateInput) => Effect.Effect<ForgeIssue, Error | NotFoundError>; readonly update: (tenantId: string, id: string, actorId: string, input: ForgeIssuePatchInput, expectedVersion?: number) => Effect.Effect<ForgeIssue, Error | NotFoundError | StalePreconditionError> }
export interface ForgePullRequestStore { readonly list: (tenantId: string, query: ForgePullRequestListQuery) => Effect.Effect<ForgePage<ForgePullRequest>>; readonly get: (tenantId: string, id: string) => Effect.Effect<ForgePullRequest, NotFoundError>; readonly create: (tenantId: string, actorId: string, input: ForgePullRequestCreateInput) => Effect.Effect<ForgePullRequest, Error | GitReferenceUnavailableError | NotFoundError>; readonly update: (tenantId: string, id: string, actorId: string, input: ForgePullRequestPatchInput, expectedVersion?: number) => Effect.Effect<ForgePullRequest, Error | GitReferenceUnavailableError | NotFoundError | StalePreconditionError> }
export interface QualifiedGitReadPort { readonly resolveRef: (input: { readonly tenantId: string; readonly repositoryId: string; readonly ref: string }) => Effect.Effect<{ readonly sha: string }, GitReferenceUnavailableError> }

export class GitReferenceUnavailableError extends Data.TaggedError("GitReferenceUnavailableError")<{ reason: string; repositoryId: string; ref: string }> {}

const systemClock: Clock = { now: () => new Date() };
const shaPattern = /^[0-9a-f]{40}$/;

export function makeD1ForgeIssueStore(db: D1DatabaseLike, clock: Clock = systemClock): ForgeIssueStore {
  return {
    list: (tenantId, query) => Effect.promise(async () => ({ items: await listIssues(db, tenantId, query), next_cursor: null, has_more: false })),
    get: (tenantId, id) => Effect.tryPromise({ try: async () => { const issue = await readIssue(db, tenantId, id); if (!issue) throw new NotFoundError({ resource: "issue", id }); return issue; }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "issue", id }) }),
    create: (tenantId, actorId, input) => Effect.tryPromise({ try: async () => {
      await requireRepository(db, tenantId, input.repository_id);
      const now = clock.now().toISOString();
      const number = await nextIssueNumber(db, tenantId, input.repository_id);
      const id = stableResourceId("issue", input.repository_id, number);
      await db.prepare("INSERT INTO issues(tenant_id,id,version,created_at,updated_at,repository_id,number,title,body,state,state_reason,author_id,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(tenantId, id, 1, now, now, input.repository_id, number, input.title, input.body ?? "", "open", "reopened", actorId, "issue").run();
      await replaceIssueLinks(db, tenantId, id, input.labels ?? [], input.assignees ?? []);
      const created = await readIssue(db, tenantId, id);
      if (!created) throw new NotFoundError({ resource: "issue", id });
      return created;
    }, catch: (error) => error instanceof NotFoundError ? error : new Error(String(error)) }),
    update: (tenantId, id, _actorId, input, expectedVersion) => Effect.tryPromise({ try: async () => {
      const current = await readIssue(db, tenantId, id);
      if (!current) throw new NotFoundError({ resource: "issue", id });
      if (expectedVersion !== undefined && current.version !== expectedVersion) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
      const nextTitle = input.title ?? current.title;
      const nextBody = input.body ?? current.body;
      const now = clock.now().toISOString();
      await db.prepare("UPDATE issues SET version = version + 1, updated_at = ?, title = ?, body = ? WHERE tenant_id = ? AND id = ? AND kind = 'issue' AND (? IS NULL OR version = ?)").bind(now, nextTitle, nextBody, tenantId, id, expectedVersion ?? null, expectedVersion ?? null).run();
      const afterCas = await readIssue(db, tenantId, id);
      if (!afterCas) throw new NotFoundError({ resource: "issue", id });
      if (expectedVersion !== undefined && afterCas.version !== expectedVersion + 1) throw new StalePreconditionError({ expected: expectedVersion, actual: afterCas.version });
      if (input.labels !== undefined || input.assignees !== undefined) await replaceIssueLinks(db, tenantId, id, input.labels ?? afterCas.labels, input.assignees ?? afterCas.assignees);
      const updated = await readIssue(db, tenantId, id);
      if (!updated) throw new NotFoundError({ resource: "issue", id });
      return updated;
    }, catch: (error) => error instanceof NotFoundError || error instanceof StalePreconditionError ? error : new Error(String(error)) })
  };
}

export function makeD1ForgePullRequestStore(db: D1DatabaseLike, options: { readonly clock?: Clock | undefined; readonly gitRead?: QualifiedGitReadPort | undefined } = {}): ForgePullRequestStore {
  const clock = options.clock ?? systemClock;
  return {
    list: (tenantId, query) => Effect.promise(async () => ({ items: await listPullRequests(db, tenantId, query), next_cursor: null, has_more: false })),
    get: (tenantId, id) => Effect.tryPromise({ try: async () => { const pr = await readPullRequest(db, tenantId, id); if (!pr) throw new NotFoundError({ resource: "pull_request", id }); return pr; }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "pull_request", id }) }),
    create: (tenantId, actorId, input) => Effect.gen(function* () {
      if (!options.gitRead) return yield* Effect.fail(new GitReferenceUnavailableError({ reason: "qualified Git read port is not configured", repositoryId: input.repository_id, ref: input.target_ref }));
      yield* Effect.tryPromise({ try: () => requireRepository(db, tenantId, input.repository_id), catch: () => new NotFoundError({ resource: "repository", id: input.repository_id }) });
      yield* Effect.tryPromise({ try: () => requireRepository(db, tenantId, input.source_repository_id), catch: () => new NotFoundError({ resource: "repository", id: input.source_repository_id }) });
      const head = yield* options.gitRead.resolveRef({ tenantId, repositoryId: input.source_repository_id, ref: input.source_ref });
      const base = yield* options.gitRead.resolveRef({ tenantId, repositoryId: input.repository_id, ref: input.target_ref });
      return yield* Effect.tryPromise({ try: async () => {
        const now = clock.now().toISOString();
        const number = await nextIssueNumber(db, tenantId, input.repository_id);
        const id = stableResourceId("pr", input.repository_id, number);
        await db.prepare("INSERT INTO issues(tenant_id,id,version,created_at,updated_at,repository_id,number,title,body,state,state_reason,author_id,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(tenantId, id, 1, now, now, input.repository_id, number, input.title, input.body ?? "", "open", "reopened", actorId, "pull_request").run();
        await db.prepare("INSERT INTO pull_requests(tenant_id,id,version,created_at,updated_at,issue_id,repository_id,source_repository_id,source_ref,target_ref,head_sha,base_sha,draft,merge_sha,merged_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(tenantId, id, 1, now, now, id, input.repository_id, input.source_repository_id, input.source_ref, input.target_ref, head.sha, base.sha, input.draft ? 1 : 0, null, null, null).run();
        const created = await readPullRequest(db, tenantId, id);
        if (!created) throw new NotFoundError({ resource: "pull_request", id });
        return created;
      }, catch: (error) => error instanceof NotFoundError ? error : new Error(String(error)) });
    }),
    update: (tenantId, id, _actorId, input, expectedVersion) => Effect.gen(function* () {
      const current = yield* Effect.tryPromise({ try: async () => { const value = await readPullRequest(db, tenantId, id); if (!value) throw new NotFoundError({ resource: "pull_request", id }); return value; }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "pull_request", id }) });
      if (expectedVersion !== undefined && current.version !== expectedVersion) return yield* Effect.fail(new StalePreconditionError({ expected: expectedVersion, actual: current.version }));
      let baseSha = current.base_sha;
      if (input.target_ref !== undefined) {
        if (!options.gitRead) return yield* Effect.fail(new GitReferenceUnavailableError({ reason: "qualified Git read port is not configured", repositoryId: current.repository_id, ref: input.target_ref }));
        baseSha = (yield* options.gitRead.resolveRef({ tenantId, repositoryId: current.repository_id, ref: input.target_ref })).sha;
      }
      return yield* Effect.tryPromise({ try: async () => {
        const now = clock.now().toISOString();
        await db.prepare("UPDATE issues SET version = version + 1, updated_at = ?, title = ?, body = ? WHERE tenant_id = ? AND id = ? AND kind = 'pull_request' AND (? IS NULL OR version = ?)").bind(now, input.title ?? current.title, input.body ?? current.body, tenantId, id, expectedVersion ?? null, expectedVersion ?? null).run();
        const afterIssue = await readPullRequest(db, tenantId, id);
        if (!afterIssue) throw new NotFoundError({ resource: "pull_request", id });
        if (expectedVersion !== undefined && afterIssue.version !== expectedVersion + 1) throw new StalePreconditionError({ expected: expectedVersion, actual: afterIssue.version });
        await db.prepare("UPDATE pull_requests SET version = ?, updated_at = ?, target_ref = ?, base_sha = ? WHERE tenant_id = ? AND id = ?").bind(afterIssue.version, now, input.target_ref ?? current.target_ref, baseSha, tenantId, id).run();
        const updated = await readPullRequest(db, tenantId, id);
        if (!updated) throw new NotFoundError({ resource: "pull_request", id });
        return updated;
      }, catch: (error) => error instanceof NotFoundError || error instanceof StalePreconditionError ? error : new Error(String(error)) });
    })
  };
}

export function makeD1ForgeStore(db: D1DatabaseLike, options: { readonly clock?: Clock | undefined; readonly gitRead?: QualifiedGitReadPort | undefined } = {}): CoreForgeStore {
  const issues = makeD1ForgeIssueStore(db, options.clock ?? systemClock);
  const pullRequests = makeD1ForgePullRequestStore(db, options);
  const clock = options.clock ?? systemClock;
  return {
    listIssues: (tenantId, query) => issues.list(tenantId, query as ForgeIssueListQuery),
    getIssue: (tenantId, id) => issues.get(tenantId, id),
    createIssue: (tenantId, actor: Actor, input: IssueCreateInput) => Effect.mapError(issues.create(tenantId, actor.id, input), (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "issue", id: input.repository_id })),
    updateIssue: (tenantId, id, expectedVersion, input: IssuePatchInput) => Effect.mapError(issues.update(tenantId, id, "system", input, expectedVersion), (error) => error instanceof StalePreconditionError || error instanceof NotFoundError ? error : new NotFoundError({ resource: "issue", id })),
    listPullRequests: (tenantId, query) => pullRequests.list(tenantId, query as ForgePullRequestListQuery),
    getPullRequest: (tenantId, id) => pullRequests.get(tenantId, id),
    createPullRequest: (tenantId, actor: Actor, input: PullRequestCreateInput) => Effect.mapError(pullRequests.create(tenantId, actor.id, input), (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "pull_request", id: input.repository_id })),
    updatePullRequest: (tenantId, id, expectedVersion, input: PullRequestPatchInput) => Effect.mapError(pullRequests.update(tenantId, id, "system", input, expectedVersion), (error) => error instanceof StalePreconditionError || error instanceof NotFoundError ? error : new NotFoundError({ resource: "pull_request", id })),
    listComments: (tenantId, query) => Effect.promise(async () => ({ items: await listComments(db, tenantId, query), next_cursor: null, has_more: false })),
    getComment: (tenantId, id) => Effect.tryPromise({ try: async () => { const comment = await readComment(db, tenantId, id); if (!comment) throw new NotFoundError({ resource: "comment", id }); return comment; }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "comment", id }) }),
    createComment: (tenantId, actor: Actor, input: CommentCreateInput) => Effect.tryPromise({ try: async () => createComment(db, tenantId, actor.id, input, clock), catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "comment", id: input.subject_id }) }),
    updateComment: (tenantId, id, expectedVersion, input: CommentPatchInput) => Effect.tryPromise({ try: async () => updateComment(db, tenantId, id, expectedVersion, input, clock), catch: (error) => error instanceof NotFoundError || error instanceof StalePreconditionError ? error : new NotFoundError({ resource: "comment", id }) }),
    listReviews: (tenantId, query) => Effect.promise(async () => ({ items: await listReviews(db, tenantId, query), next_cursor: null, has_more: false })),
    getReview: (tenantId, id) => Effect.tryPromise({ try: async () => { const review = await readReview(db, tenantId, id); if (!review) throw new NotFoundError({ resource: "review", id }); return review; }, catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "review", id }) }),
    createReview: (tenantId, actor: Actor, input: ReviewCreateInput) => Effect.tryPromise({ try: async () => createReview(db, tenantId, actor.id, input, clock), catch: (error) => error instanceof NotFoundError ? error : new NotFoundError({ resource: "review", id: input.pull_request_id }) }),
    updateReview: (tenantId, id, expectedVersion, input: ReviewPatchInput) => Effect.tryPromise({ try: async () => updateReview(db, tenantId, id, expectedVersion, input, clock), catch: (error) => error instanceof NotFoundError || error instanceof StalePreconditionError ? error : new NotFoundError({ resource: "review", id }) }),
    closeIssue: (tenantId, id, input: IssueCloseInput) => Effect.tryPromise({ try: async () => closeIssue(db, tenantId, id, input, clock), catch: (error) => mapForgeTransitionError(error, "issue", id) }),
    reopenIssue: (tenantId, id, input: ForgeVersionActionInput) => Effect.tryPromise({ try: async () => reopenIssue(db, tenantId, id, input, clock), catch: (error) => mapForgeTransitionError(error, "issue", id) }),
    closePullRequest: (tenantId, id, input: ForgeVersionActionInput) => Effect.tryPromise({ try: async () => transitionPullRequest(db, tenantId, id, input.expected_version, "close", clock), catch: (error) => mapForgeTransitionError(error, "pull_request", id) }),
    reopenPullRequest: (tenantId, id, input: ForgeVersionActionInput) => Effect.tryPromise({ try: async () => transitionPullRequest(db, tenantId, id, input.expected_version, "reopen", clock), catch: (error) => mapForgeTransitionError(error, "pull_request", id) }),
    markPullRequestReady: (tenantId, id, input: ForgeVersionActionInput) => Effect.tryPromise({ try: async () => transitionPullRequest(db, tenantId, id, input.expected_version, "ready", clock), catch: (error) => mapForgeTransitionError(error, "pull_request", id) }),
    markPullRequestDraft: (tenantId, id, input: ForgeVersionActionInput) => Effect.tryPromise({ try: async () => transitionPullRequest(db, tenantId, id, input.expected_version, "draft", clock), catch: (error) => mapForgeTransitionError(error, "pull_request", id) }),
    submitReview: (tenantId, id, input: ReviewSubmitInput) => Effect.tryPromise({ try: async () => submitReview(db, tenantId, id, input, clock), catch: (error) => mapForgeTransitionError(error, "review", id) }),
    dismissReview: (tenantId, id, input: ReviewDismissInput) => Effect.tryPromise({ try: async () => dismissReview(db, tenantId, id, input, clock), catch: (error) => mapForgeTransitionError(error, "review", id) })
  };
}

async function listComments(db: D1DatabaseLike, tenantId: string, query: Record<string, unknown>): Promise<readonly Comment[]> {
  const params: unknown[] = [tenantId];
  const filters = ["tenant_id = ?", "deleted_at IS NULL"];
  if (typeof query.repository_id === "string") { filters.push("repository_id = ?"); params.push(query.repository_id) }
  if (typeof query.subject_kind === "string") { filters.push("subject_kind = ?"); params.push(query.subject_kind) }
  if (typeof query.subject_id === "string") { filters.push("subject_id = ?"); params.push(query.subject_id) }
  const rows = await db.prepare(`${commentSelectSql()} WHERE ${filters.join(" AND ")} ORDER BY ${sortColumn(typeof query.sort === "string" ? query.sort : undefined)} ${sortDirection(typeof query.direction === "string" ? query.direction : undefined)}, id ${sortDirection(typeof query.direction === "string" ? query.direction : undefined)} LIMIT ?`).bind(...params, readLimit(query.limit)).all<CommentRow>();
  return (rows.results ?? []).map(toComment);
}

async function readComment(db: D1DatabaseLike, tenantId: string, id: string): Promise<Comment | undefined> {
  const row = await db.prepare(`${commentSelectSql()} WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1`).bind(tenantId, id).first<CommentRow>();
  return row ? toComment(row) : undefined;
}

async function createComment(db: D1DatabaseLike, tenantId: string, actorId: string, input: CommentCreateInput, clock: Clock): Promise<Comment> {
  await requireRepository(db, tenantId, input.repository_id);
  await requireSubject(db, tenantId, input.repository_id, input.subject_kind, input.subject_id);
  const now = clock.now().toISOString();
  const id = stableResourceId("comment", input.repository_id, await nextTableOrdinal(db, "comments", tenantId, input.repository_id));
  await db.prepare("INSERT INTO comments(tenant_id,id,version,created_at,updated_at,repository_id,subject_kind,subject_id,author_id,body,anchor_json,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)").bind(tenantId, id, 1, now, now, input.repository_id, input.subject_kind, input.subject_id, actorId, input.body, JSON.stringify(input.anchor ?? {})).run();
  const created = await readComment(db, tenantId, id);
  if (!created) throw new NotFoundError({ resource: "comment", id });
  return created;
}

async function updateComment(db: D1DatabaseLike, tenantId: string, id: string, expectedVersion: number, input: CommentPatchInput, clock: Clock): Promise<Comment> {
  const current = await readComment(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "comment", id });
  if (current.version !== expectedVersion) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
  const now = clock.now().toISOString();
  await db.prepare("UPDATE comments SET version = version + 1, updated_at = ?, body = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND version = ?").bind(now, input.body, tenantId, id, expectedVersion).run();
  const updated = await readComment(db, tenantId, id);
  if (!updated) throw new NotFoundError({ resource: "comment", id });
  if (updated.version !== expectedVersion + 1) throw new StalePreconditionError({ expected: expectedVersion, actual: updated.version });
  return updated;
}

async function listReviews(db: D1DatabaseLike, tenantId: string, query: Record<string, unknown>): Promise<readonly Review[]> {
  const params: unknown[] = [tenantId];
  const filters = ["tenant_id = ?"];
  if (typeof query.repository_id === "string") { filters.push("repository_id = ?"); params.push(query.repository_id) }
  if (typeof query.pull_request_id === "string") { filters.push("pull_request_id = ?"); params.push(query.pull_request_id) }
  if (typeof query.head_sha === "string") { filters.push("head_sha = ?"); params.push(query.head_sha) }
  if (typeof query.state === "string") { filters.push("state = ?"); params.push(query.state) }
  const rows = await db.prepare(`${reviewSelectSql()} WHERE ${filters.join(" AND ")} ORDER BY ${sortColumn(typeof query.sort === "string" ? query.sort : undefined)} ${sortDirection(typeof query.direction === "string" ? query.direction : undefined)}, id ${sortDirection(typeof query.direction === "string" ? query.direction : undefined)} LIMIT ?`).bind(...params, readLimit(query.limit)).all<ReviewRow>();
  return (rows.results ?? []).map(toReview);
}

async function readReview(db: D1DatabaseLike, tenantId: string, id: string): Promise<Review | undefined> {
  const row = await db.prepare(`${reviewSelectSql()} WHERE tenant_id = ? AND id = ? LIMIT 1`).bind(tenantId, id).first<ReviewRow>();
  return row ? toReview(row) : undefined;
}

async function createReview(db: D1DatabaseLike, tenantId: string, actorId: string, input: ReviewCreateInput, clock: Clock): Promise<Review> {
  await requireRepository(db, tenantId, input.repository_id);
  const pullRequest = await readPullRequest(db, tenantId, input.pull_request_id);
  if (!pullRequest || pullRequest.repository_id !== input.repository_id) throw new NotFoundError({ resource: "pull_request", id: input.pull_request_id });
  const now = clock.now().toISOString();
  const id = stableResourceId("review", input.repository_id, await nextTableOrdinal(db, "reviews", tenantId, input.repository_id));
  await db.prepare("INSERT INTO reviews(tenant_id,id,version,created_at,updated_at,repository_id,pull_request_id,reviewer_id,head_sha,state,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(tenantId, id, 1, now, now, input.repository_id, input.pull_request_id, actorId, pullRequest.head_sha, "pending", input.body ?? "").run();
  const created = await readReview(db, tenantId, id);
  if (!created) throw new NotFoundError({ resource: "review", id });
  return created;
}

async function updateReview(db: D1DatabaseLike, tenantId: string, id: string, expectedVersion: number, input: ReviewPatchInput, clock: Clock): Promise<Review> {
  const current = await readReview(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "review", id });
  if (current.version !== expectedVersion) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
  const now = clock.now().toISOString();
  await db.prepare("UPDATE reviews SET version = version + 1, updated_at = ?, body = ? WHERE tenant_id = ? AND id = ? AND version = ?").bind(now, input.body ?? current.body, tenantId, id, expectedVersion).run();
  const updated = await readReview(db, tenantId, id);
  if (!updated) throw new NotFoundError({ resource: "review", id });
  if (updated.version !== expectedVersion + 1) throw new StalePreconditionError({ expected: expectedVersion, actual: updated.version });
  return updated;
}

async function closeIssue(db: D1DatabaseLike, tenantId: string, id: string, input: IssueCloseInput, clock: Clock): Promise<ForgeIssue> {
  const current = await readIssue(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "issue", id });
  await requireRepository(db, tenantId, current.repository_id);
  await requireActivePrincipal(db, tenantId, current.author_id);
  if (current.version !== input.expected_version) throw new StalePreconditionError({ expected: input.expected_version, actual: current.version });
  if (current.state !== "open") throw new InvalidStateTransitionError({ resource: "issue", id, state: current.state, expectedState: "open" });
  const now = clock.now().toISOString();
  await db.prepare("UPDATE issues SET version = version + 1, updated_at = ?, state = 'closed', state_reason = ? WHERE tenant_id = ? AND id = ? AND kind = 'issue' AND version = ?").bind(now, input.reason, tenantId, id, input.expected_version).run();
  const updated = await readIssue(db, tenantId, id);
  if (!updated) throw new NotFoundError({ resource: "issue", id });
  if (updated.version !== input.expected_version + 1) throw new StalePreconditionError({ expected: input.expected_version, actual: updated.version });
  return updated;
}

async function reopenIssue(db: D1DatabaseLike, tenantId: string, id: string, input: ForgeVersionActionInput, clock: Clock): Promise<ForgeIssue> {
  const current = await readIssue(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "issue", id });
  await requireRepository(db, tenantId, current.repository_id);
  await requireActivePrincipal(db, tenantId, current.author_id);
  if (current.version !== input.expected_version) throw new StalePreconditionError({ expected: input.expected_version, actual: current.version });
  if (current.state !== "closed") throw new InvalidStateTransitionError({ resource: "issue", id, state: current.state, expectedState: "closed" });
  const now = clock.now().toISOString();
  await db.prepare("UPDATE issues SET version = version + 1, updated_at = ?, state = 'open', state_reason = 'reopened' WHERE tenant_id = ? AND id = ? AND kind = 'issue' AND version = ?").bind(now, tenantId, id, input.expected_version).run();
  const updated = await readIssue(db, tenantId, id);
  if (!updated) throw new NotFoundError({ resource: "issue", id });
  if (updated.version !== input.expected_version + 1) throw new StalePreconditionError({ expected: input.expected_version, actual: updated.version });
  return updated;
}

async function transitionPullRequest(db: D1DatabaseLike, tenantId: string, id: string, expectedVersion: number, transition: "close" | "reopen" | "ready" | "draft", clock: Clock): Promise<ForgePullRequest> {
  const current = await readPullRequest(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "pull_request", id });
  await requireRepository(db, tenantId, current.repository_id);
  await requireRepository(db, tenantId, current.source_repository_id);
  await requireActivePrincipal(db, tenantId, current.author_id);
  if (current.version !== expectedVersion) throw new StalePreconditionError({ expected: expectedVersion, actual: current.version });
  const now = clock.now().toISOString();
  if (transition === "close") {
    if (current.state !== "open") throw new InvalidStateTransitionError({ resource: "pull_request", id, state: current.state, expectedState: "open" });
    await db.prepare("UPDATE issues SET version = version + 1, updated_at = ?, state = 'closed', state_reason = 'completed' WHERE tenant_id = ? AND id = ? AND kind = 'pull_request' AND version = ?").bind(now, tenantId, id, expectedVersion).run();
    const updated = await readPullRequestAfterIssueCas(db, tenantId, id, expectedVersion);
    await db.prepare("UPDATE pull_requests SET version = ?, updated_at = ?, closed_at = ? WHERE tenant_id = ? AND id = ?").bind(updated.version, now, now, tenantId, id).run();
    return await requirePullRequestReadback(db, tenantId, id);
  }
  if (transition === "reopen") {
    if (current.state !== "closed") throw new InvalidStateTransitionError({ resource: "pull_request", id, state: current.state, expectedState: "closed" });
    await db.prepare("UPDATE issues SET version = version + 1, updated_at = ?, state = 'open', state_reason = 'reopened' WHERE tenant_id = ? AND id = ? AND kind = 'pull_request' AND version = ?").bind(now, tenantId, id, expectedVersion).run();
    const updated = await readPullRequestAfterIssueCas(db, tenantId, id, expectedVersion);
    await db.prepare("UPDATE pull_requests SET version = ?, updated_at = ?, closed_at = NULL WHERE tenant_id = ? AND id = ?").bind(updated.version, now, tenantId, id).run();
    return await requirePullRequestReadback(db, tenantId, id);
  }
  if (current.state !== "open") throw new InvalidStateTransitionError({ resource: "pull_request", id, state: current.state, expectedState: "open" });
  if (transition === "ready" && !current.draft) throw new InvalidStateTransitionError({ resource: "pull_request", id, state: "ready", expectedState: "draft" });
  if (transition === "draft" && current.draft) throw new InvalidStateTransitionError({ resource: "pull_request", id, state: "draft", expectedState: "ready" });
  await db.prepare("UPDATE issues SET version = version + 1, updated_at = ? WHERE tenant_id = ? AND id = ? AND kind = 'pull_request' AND version = ?").bind(now, tenantId, id, expectedVersion).run();
  const updated = await readPullRequestAfterIssueCas(db, tenantId, id, expectedVersion);
  await db.prepare("UPDATE pull_requests SET version = ?, updated_at = ?, draft = ? WHERE tenant_id = ? AND id = ?").bind(updated.version, now, transition === "draft" ? 1 : 0, tenantId, id).run();
  return await requirePullRequestReadback(db, tenantId, id);
}

async function submitReview(db: D1DatabaseLike, tenantId: string, id: string, input: ReviewSubmitInput, clock: Clock): Promise<Review> {
  const current = await readReviewWithGuards(db, tenantId, id);
  if (current.version !== input.expected_version) throw new StalePreconditionError({ expected: input.expected_version, actual: current.version });
  if (current.state !== "pending") throw new InvalidStateTransitionError({ resource: "review", id, state: current.state, expectedState: "pending" });
  if (current.head_sha !== input.head_sha) throw new InvalidStateTransitionError({ resource: "review", id, state: input.head_sha, expectedState: current.head_sha });
  const now = clock.now().toISOString();
  await db.prepare("UPDATE reviews SET version = version + 1, updated_at = ?, state = ?, body = ? WHERE tenant_id = ? AND id = ? AND version = ?").bind(now, input.decision, input.body ?? current.body, tenantId, id, input.expected_version).run();
  return await readReviewAfterCas(db, tenantId, id, input.expected_version);
}

async function dismissReview(db: D1DatabaseLike, tenantId: string, id: string, input: ReviewDismissInput, clock: Clock): Promise<Review> {
  const current = await readReviewWithGuards(db, tenantId, id);
  if (current.version !== input.expected_version) throw new StalePreconditionError({ expected: input.expected_version, actual: current.version });
  if (current.state === "pending") throw new InvalidStateTransitionError({ resource: "review", id, state: current.state, expectedState: "submitted" });
  if (current.state === "dismissed") throw new InvalidStateTransitionError({ resource: "review", id, state: current.state, expectedState: "submitted" });
  const now = clock.now().toISOString();
  await db.prepare("UPDATE reviews SET version = version + 1, updated_at = ?, state = 'dismissed' WHERE tenant_id = ? AND id = ? AND version = ?").bind(now, tenantId, id, input.expected_version).run();
  return await readReviewAfterCas(db, tenantId, id, input.expected_version);
}

async function readPullRequestAfterIssueCas(db: D1DatabaseLike, tenantId: string, id: string, expectedVersion: number): Promise<ForgePullRequest> {
  const updated = await readPullRequest(db, tenantId, id);
  if (!updated) throw new NotFoundError({ resource: "pull_request", id });
  if (updated.version !== expectedVersion + 1) throw new StalePreconditionError({ expected: expectedVersion, actual: updated.version });
  return updated;
}

async function requirePullRequestReadback(db: D1DatabaseLike, tenantId: string, id: string): Promise<ForgePullRequest> {
  const updated = await readPullRequest(db, tenantId, id);
  if (!updated) throw new NotFoundError({ resource: "pull_request", id });
  return updated;
}

async function readReviewWithGuards(db: D1DatabaseLike, tenantId: string, id: string): Promise<Review> {
  const current = await readReview(db, tenantId, id);
  if (!current) throw new NotFoundError({ resource: "review", id });
  await requireRepository(db, tenantId, current.repository_id);
  const pullRequest = await readPullRequest(db, tenantId, current.pull_request_id);
  if (!pullRequest || pullRequest.repository_id !== current.repository_id) throw new NotFoundError({ resource: "pull_request", id: current.pull_request_id });
  await requireActivePrincipal(db, tenantId, current.reviewer_id);
  return current;
}

async function readReviewAfterCas(db: D1DatabaseLike, tenantId: string, id: string, expectedVersion: number): Promise<Review> {
  const updated = await readReview(db, tenantId, id);
  if (!updated) throw new NotFoundError({ resource: "review", id });
  if (updated.version !== expectedVersion + 1) throw new StalePreconditionError({ expected: expectedVersion, actual: updated.version });
  return updated;
}

async function requireActivePrincipal(db: D1DatabaseLike, tenantId: string, id: string): Promise<void> {
  const row = await db.prepare("SELECT id FROM principals WHERE tenant_id = ? AND id = ? AND active = 1 LIMIT 1").bind(tenantId, id).first<{ id: string }>();
  if (!row) throw new NotFoundError({ resource: "principal", id });
}

function mapForgeTransitionError(error: unknown, resource: string, id: string): NotFoundError | StalePreconditionError | InvalidStateTransitionError {
  return error instanceof NotFoundError || error instanceof StalePreconditionError || error instanceof InvalidStateTransitionError ? error : new NotFoundError({ resource, id });
}

async function requireSubject(db: D1DatabaseLike, tenantId: string, repositoryId: string, subjectKind: Comment["subject_kind"], subjectId: string): Promise<void> {
  if (subjectKind === "discussion") return;
  if (subjectKind === "issue") {
    const issue = await db.prepare("SELECT id FROM issues WHERE tenant_id = ? AND id = ? AND repository_id = ? AND kind = 'issue' LIMIT 1").bind(tenantId, subjectId, repositoryId).first<{ id: string }>();
    if (!issue) throw new NotFoundError({ resource: "issue", id: subjectId });
    return;
  }
  if (subjectKind === "pull_request") {
    const pullRequest = await readPullRequest(db, tenantId, subjectId);
    if (!pullRequest || pullRequest.repository_id !== repositoryId) throw new NotFoundError({ resource: "pull_request", id: subjectId });
    return;
  }
  const review = await readReview(db, tenantId, subjectId);
  if (!review || review.repository_id !== repositoryId) throw new NotFoundError({ resource: "review", id: subjectId });
}

async function nextTableOrdinal(db: D1DatabaseLike, table: "comments" | "reviews", tenantId: string, repositoryId: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) + 1 AS next_number FROM ${table} WHERE tenant_id = ? AND repository_id = ?`).bind(tenantId, repositoryId).first<{ next_number: number }>();
  return row?.next_number ?? 1;
}

function readLimit(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 100 }
function toComment(row: CommentRow): Comment { return { tenant_id: row.tenant_id, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, repository_id: row.repository_id, subject_kind: row.subject_kind, subject_id: row.subject_id, author_id: row.author_id, body: row.body, anchor: parseRecord(row.anchor_json) } }
function toReview(row: ReviewRow): Review { return { tenant_id: row.tenant_id, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, repository_id: row.repository_id, pull_request_id: row.pull_request_id, reviewer_id: row.reviewer_id, head_sha: row.head_sha, state: row.state, body: row.body } }
function commentSelectSql(): string { return "SELECT tenant_id,id,version,created_at,updated_at,repository_id,subject_kind,subject_id,author_id,body,anchor_json FROM comments" }
function reviewSelectSql(): string { return "SELECT tenant_id,id,version,created_at,updated_at,repository_id,pull_request_id,reviewer_id,head_sha,state,body FROM reviews" }
function parseRecord(value: string): Record<string, unknown> { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} }

async function listIssues(db: D1DatabaseLike, tenantId: string, query: ForgeIssueListQuery): Promise<readonly ForgeIssue[]> {
  const params: unknown[] = [tenantId];
  const filters = ["tenant_id = ?", "kind = 'issue'"];
  addIssueFilters(filters, params, query);
  const rows = await db.prepare(`${issueSelectSql()} WHERE ${filters.join(" AND ")} ORDER BY ${sortColumn(query.sort)} ${sortDirection(query.direction)}, id ${sortDirection(query.direction)} LIMIT ?`).bind(...params, query.limit ?? 100).all<IssueRow>();
  return Promise.all((rows.results ?? []).map((row) => toIssue(db, row)));
}

async function listPullRequests(db: D1DatabaseLike, tenantId: string, query: ForgePullRequestListQuery): Promise<readonly ForgePullRequest[]> {
  const params: unknown[] = [tenantId];
  const filters = ["i.tenant_id = ?"];
  if (query.repository_id) { filters.push("i.repository_id = ?"); params.push(query.repository_id) }
  if (query.author_id) { filters.push("i.author_id = ?"); params.push(query.author_id) }
  if (query.source_repository_id) { filters.push("pr.source_repository_id = ?"); params.push(query.source_repository_id) }
  if (query.draft !== undefined) { filters.push("pr.draft = ?"); params.push(query.draft ? 1 : 0) }
  if (query.state) filters.push(query.state === "merged" ? "pr.merged_at IS NOT NULL" : query.state === "open" ? "i.state = 'open'" : "i.state = 'closed' AND pr.merged_at IS NULL");
  const rows = await db.prepare(`${pullRequestSelectSql()} WHERE ${filters.join(" AND ")} ORDER BY i.${sortColumn(query.sort)} ${sortDirection(query.direction)}, i.id ${sortDirection(query.direction)} LIMIT ?`).bind(...params, query.limit ?? 100).all<PullRequestRow>();
  return (rows.results ?? []).map(toPullRequest);
}

async function readIssue(db: D1DatabaseLike, tenantId: string, id: string): Promise<ForgeIssue | undefined> {
  const row = await db.prepare(`${issueSelectSql()} WHERE tenant_id = ? AND id = ? AND kind = 'issue' LIMIT 1`).bind(tenantId, id).first<IssueRow>();
  return row ? toIssue(db, row) : undefined;
}

async function readPullRequest(db: D1DatabaseLike, tenantId: string, id: string): Promise<ForgePullRequest | undefined> {
  const row = await db.prepare(`${pullRequestSelectSql()} WHERE i.tenant_id = ? AND pr.id = ? LIMIT 1`).bind(tenantId, id).first<PullRequestRow>();
  return row ? toPullRequest(row) : undefined;
}

async function toIssue(db: D1DatabaseLike, row: IssueRow): Promise<ForgeIssue> {
  return { tenant_id: row.tenant_id, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, repository_id: row.repository_id, number: row.number, title: row.title, body: row.body, state: row.state, state_reason: row.state_reason, author_id: row.author_id, labels: await issueLabels(db, row.tenant_id, row.id), assignees: await issueAssignees(db, row.tenant_id, row.id) };
}

function toPullRequest(row: PullRequestRow): ForgePullRequest {
  return { tenant_id: row.tenant_id, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, repository_id: row.repository_id, number: row.number, title: row.title, body: row.body, state: row.issue_state === "open" ? "open" : row.merged_at ? "merged" : "closed", draft: row.draft === 1, source_repository_id: row.source_repository_id, source_ref: row.source_ref, head_sha: row.head_sha, target_ref: row.target_ref, base_sha: row.base_sha, author_id: row.author_id };
}

async function replaceIssueLinks(db: D1DatabaseLike, tenantId: string, issueId: string, labels: readonly string[], assignees: readonly string[]): Promise<void> {
  await db.prepare("DELETE FROM issue_labels WHERE tenant_id = ? AND issue_id = ?").bind(tenantId, issueId).run();
  for (const label of labels) await db.prepare("INSERT INTO issue_labels(tenant_id,issue_id,label_id) VALUES(?,?,?)").bind(tenantId, issueId, label).run();
  await db.prepare("DELETE FROM issue_assignees WHERE tenant_id = ? AND issue_id = ?").bind(tenantId, issueId).run();
  for (const assignee of assignees) await db.prepare("INSERT INTO issue_assignees(tenant_id,issue_id,principal_id) VALUES(?,?,?)").bind(tenantId, issueId, assignee).run();
}

async function issueLabels(db: D1DatabaseLike, tenantId: string, issueId: string): Promise<readonly string[]> {
  const rows = await db.prepare("SELECT label_id FROM issue_labels WHERE tenant_id = ? AND issue_id = ? ORDER BY label_id").bind(tenantId, issueId).all<{ label_id: string }>();
  return (rows.results ?? []).map((row) => row.label_id);
}

async function issueAssignees(db: D1DatabaseLike, tenantId: string, issueId: string): Promise<readonly string[]> {
  const rows = await db.prepare("SELECT principal_id FROM issue_assignees WHERE tenant_id = ? AND issue_id = ? ORDER BY principal_id").bind(tenantId, issueId).all<{ principal_id: string }>();
  return (rows.results ?? []).map((row) => row.principal_id);
}

async function requireRepository(db: D1DatabaseLike, tenantId: string, id: string): Promise<void> {
  const row = await db.prepare("SELECT id FROM repositories WHERE tenant_id = ? AND id = ? LIMIT 1").bind(tenantId, id).first<{ id: string }>();
  if (!row) throw new NotFoundError({ resource: "repository", id });
}

async function nextIssueNumber(db: D1DatabaseLike, tenantId: string, repositoryId: string): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next_number FROM issues WHERE tenant_id = ? AND repository_id = ?").bind(tenantId, repositoryId).first<{ next_number: number }>();
  return row?.next_number ?? 1;
}

function addIssueFilters(filters: string[], params: unknown[], query: ForgeIssueListQuery): void {
  if (query.repository_id) { filters.push("repository_id = ?"); params.push(query.repository_id) }
  if (query.state) { filters.push("state = ?"); params.push(query.state) }
  if (query.author_id) { filters.push("author_id = ?"); params.push(query.author_id) }
  if (query.assignee_id) { filters.push("EXISTS (SELECT 1 FROM issue_assignees ia WHERE ia.tenant_id = issues.tenant_id AND ia.issue_id = issues.id AND ia.principal_id = ?)"); params.push(query.assignee_id) }
  for (const label of query.label_ids ?? []) { filters.push("EXISTS (SELECT 1 FROM issue_labels il WHERE il.tenant_id = issues.tenant_id AND il.issue_id = issues.id AND il.label_id = ?)"); params.push(label) }
  if (query.since) { filters.push("updated_at >= ?"); params.push(query.since) }
}

function issueSelectSql(): string { return "SELECT tenant_id,id,version,created_at,updated_at,repository_id,number,title,body,state,state_reason,author_id FROM issues" }
function pullRequestSelectSql(): string { return "SELECT i.tenant_id AS tenant_id, pr.id AS id, i.version AS version, i.created_at AS created_at, i.updated_at AS updated_at, i.repository_id AS repository_id, i.number AS number, i.title AS title, i.body AS body, i.state AS issue_state, pr.draft AS draft, pr.source_repository_id AS source_repository_id, pr.source_ref AS source_ref, pr.head_sha AS head_sha, pr.target_ref AS target_ref, pr.base_sha AS base_sha, i.author_id AS author_id, pr.merged_at AS merged_at FROM pull_requests pr JOIN issues i ON i.tenant_id = pr.tenant_id AND i.id = pr.issue_id" }
function sortColumn(value: string | undefined): "created_at" | "updated_at" | "id" { return value === "updated_at" || value === "id" ? value : "created_at" }
function sortDirection(value: string | undefined): "ASC" | "DESC" { return value === "asc" ? "ASC" : "DESC" }
function stableResourceId(prefix: string, repositoryId: string, number: number): string { return `${prefix}-${repositoryId}-${number}`.replace(/[^A-Za-z0-9_.:-]/g, "-") }

interface IssueRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly number: number; readonly title: string; readonly body: string; readonly state: "open" | "closed"; readonly state_reason: "completed" | "not_planned" | "reopened"; readonly author_id: string }
interface PullRequestRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly number: number; readonly title: string; readonly body: string; readonly issue_state: "open" | "closed"; readonly draft: number; readonly source_repository_id: string; readonly source_ref: string; readonly head_sha: string; readonly target_ref: string; readonly base_sha: string; readonly author_id: string; readonly merged_at: string | null }
interface CommentRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly subject_kind: Comment["subject_kind"]; readonly subject_id: string; readonly author_id: string; readonly body: string; readonly anchor_json: string }
interface ReviewRow { readonly tenant_id: string; readonly id: string; readonly version: number; readonly created_at: string; readonly updated_at: string; readonly repository_id: string; readonly pull_request_id: string; readonly reviewer_id: string; readonly head_sha: string; readonly state: Review["state"]; readonly body: string }

export function assertQualifiedSha(value: string, repositoryId: string, ref: string): { readonly sha: string } {
  if (!shaPattern.test(value)) throw new GitReferenceUnavailableError({ reason: "qualified Git read port returned an invalid SHA", repositoryId, ref });
  return { sha: value };
}
