import { Context, Data, Effect, Layer } from "effect";

import {
  decodeRequestEnvelope,
  decodeSourceSchema,
  expectedContractCounts,
  type CatalogBindingSummary,
  type CatalogValidationSummary,
  type NativeOperation,
  type RequestEnvelope,
  type SourceDomainDocument
} from "@gitfoundry/contracts";
import {
  ForgeStore,
  forgeImplementedOperationIds,
  makeFakeForgeStore,
  type Comment,
  type CommentCreateInput,
  type CommentPatchInput,
  type ForgeListQuery,
  type ForgeVersionActionInput,
  type Issue,
  type IssueCloseInput,
  type IssueCreateInput,
  type IssuePatchInput,
  type PullRequest,
  type PullRequestCreateInput,
  type PullRequestPatchInput,
  type Review,
  type ReviewCreateInput,
  type ReviewDismissInput,
  type ReviewPatchInput,
  type ReviewSubmitInput
} from "./forge/index.js";
import {
  CheckStore,
  checksImplementedOperationIds,
  makeFakeCheckStore,
  type Check,
  type CheckAnnotationQuery,
  type CheckCreateInput,
  type CheckJobAttempt,
  type CheckListQuery,
  type CheckPatchInput,
  type PrChecksQuery,
  type TrustedRevision
} from "./checks/index.js";

import { CollaborationMetadataStore, collaborationMetadataImplementedOperationIds, makeFakeCollaborationMetadataStore, type ForgeLabelListQuery, type ForgeLabelCreateInput, type ForgeLabelPatchInput, type ForgeMilestoneListQuery, type ForgeMilestoneCreateInput, type ForgeMilestonePatchInput, type ForgeDeleteInput } from "./collaboration-metadata/index.js";

export interface CoreReadiness {
  ready: boolean;
  summary: CatalogValidationSummary;
}

export interface Actor {
  id: string;
  tenantId: string;
  revoked: boolean;
  capabilities: readonly string[];
}

export interface Namespace {
  tenant_id: string;
  id: string;
}

export interface Repository {
  tenant_id: string;
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
  namespace_id: string;
  name: string;
  visibility: "private" | "internal" | "public";
  default_branch: string;
  archived: boolean;
  fork_of: string | null;
  git_url: string;
}

export interface RepositoryCreateInput {
  namespace_id: string;
  name: string;
  visibility?: "private" | "internal" | "public";
  default_branch?: string;
  description?: string;
  initial_files?: readonly { path: string; encoding: "utf8" | "base64"; content: string }[];
}

export interface RepositoryPatchInput {
  name?: string;
  description?: string;
  visibility?: "private" | "internal" | "public";
  default_branch?: string;
}

export interface RepositoryVersionActionInput {
  expected_version: number;
  reason?: string;
}

export interface ForgeForkRequest {
  readonly expected_version: number;
  readonly target_namespace_id: string;
  readonly name: string;
  readonly visibility: Repository["visibility"];
  readonly default_branch_only?: boolean;
}

export interface ForgeForkResult {
  readonly source_repository_id: string;
  readonly repository_id: string;
  readonly copied_ref_count: number;
  readonly copied_object_count: number;
  readonly source_snapshot_digest: string;
}

export interface OperationRecord {
  tenant_id: string;
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  kind: string;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  error: null | { code: string; detail: string; request_id: string; retryable: boolean; details: Record<string, unknown> };
}

export interface CapabilityDiscoveryEntry {
  operationId: string;
  mcpTool: string;
  capability: string;
  implemented: boolean;
  asynchronous: boolean;
}

export interface CapabilityDiscovery {
  total: number;
  implemented: readonly string[];
  entries: readonly CapabilityDiscoveryEntry[];
}

export type OperationReceipt =
  | { readonly status: "succeeded"; readonly operationId: string; readonly response: unknown; readonly replayed: boolean }
  | { readonly status: "pending"; readonly operationId: string; readonly reason: "in_progress"; readonly receiptId: string };

export class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{ reason: string; actorId: string; tenantId: string; capability: string }> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{ resource: string; id: string }> {}
export class StalePreconditionError extends Data.TaggedError("StalePreconditionError")<{ expected: number; actual: number }> {}
export class InvalidStateTransitionError extends Data.TaggedError("InvalidStateTransitionError")<{ resource: string; id: string; state: string; expectedState: string }> {}
export class IdempotencyConflictError extends Data.TaggedError("IdempotencyConflictError")<{ key: string }> {}
export class DomainContractError extends Data.TaggedError("DomainContractError")<{ message: string }> {}
export class UnsupportedOperationError extends Data.TaggedError("UnsupportedOperationError")<{ operationId: string; reason: string }> {}
export class RepositoryNameConflictError extends Data.TaggedError("RepositoryNameConflictError")<{ tenantId: string; namespaceId: string; name: string }> {}
export class RepositoryHasForksError extends Data.TaggedError("RepositoryHasForksError")<{ tenantId: string; id: string }> {}
export class RepositoryStoreUnavailableError extends Data.TaggedError("RepositoryStoreUnavailableError")<{ operationId: string; resource: "repository"; id: string; reason: "storage_unavailable" }> {}

export interface CurrentIdentity {
  readonly currentActor: () => Effect.Effect<Actor>;
}

export interface TenantAuthorizer {
  readonly authorize: (actor: Actor, tenantId: string, capability: string) => Effect.Effect<void, UnauthorizedError>;
}

export interface ContractSchemas {
  readonly domain: SourceDomainDocument;
}

export interface NamespaceStore {
  readonly get: (tenantId: string, id: string) => Effect.Effect<Namespace, NotFoundError>;
}

export interface RepositoryStore {
  readonly get: (tenantId: string, id: string) => Effect.Effect<Repository, NotFoundError>;
  readonly list: (tenantId: string) => Effect.Effect<readonly Repository[]>;
  readonly create: (tenantId: string, input: RepositoryCreateInput) => Effect.Effect<Repository>;
  readonly fork: (tenantId: string, actor: Actor, id: string, input: ForgeForkRequest) => Effect.Effect<OperationRecord, DomainContractError | NotFoundError | RepositoryNameConflictError | RepositoryStoreUnavailableError | StalePreconditionError>;
  readonly update: (tenantId: string, id: string, expectedVersion: number, patch: RepositoryPatchInput) => Effect.Effect<Repository, NotFoundError | RepositoryNameConflictError | RepositoryStoreUnavailableError | StalePreconditionError | UnsupportedOperationError>;
  readonly setArchived: (tenantId: string, id: string, input: RepositoryVersionActionInput, archived: boolean) => Effect.Effect<Repository, InvalidStateTransitionError | NotFoundError | RepositoryStoreUnavailableError | StalePreconditionError>;
  readonly delete?: (tenantId: string, id: string, input: RepositoryVersionActionInput) => Effect.Effect<OperationRecord, NotFoundError | RepositoryHasForksError | RepositoryStoreUnavailableError | StalePreconditionError>;
}

export interface OperationStore {
  readonly get: (tenantId: string, id: string) => Effect.Effect<OperationRecord, NotFoundError>;
  readonly put: (record: OperationRecord) => Effect.Effect<void>;
}

export interface IdempotencyStore {
  readonly replayOrReserve: (scope: string, fingerprint: string, pending: OperationRecord) => Effect.Effect<OperationReceipt | undefined, IdempotencyConflictError>;
  readonly commit: (scope: string, fingerprint: string, receipt: OperationReceipt, reservationId: string) => Effect.Effect<void, IdempotencyConflictError>;
}

export interface NativeDispatcher {
  readonly dispatch: (operation: NativeOperation, envelope: RequestEnvelope) => Effect.Effect<OperationReceipt, DomainContractError | InvalidStateTransitionError | NotFoundError | RepositoryHasForksError | RepositoryNameConflictError | RepositoryStoreUnavailableError | StalePreconditionError | UnauthorizedError | UnsupportedOperationError, CurrentIdentity | ContractSchemas | NamespaceStore | RepositoryStore | OperationStore | ForgeStore | CheckStore | CollaborationMetadataStore>;
}

export const CurrentIdentity = Context.Service<CurrentIdentity>("gitfoundry/CurrentIdentity");
export const TenantAuthorizer = Context.Service<TenantAuthorizer>("gitfoundry/TenantAuthorizer");
export const ContractSchemas = Context.Service<ContractSchemas>("gitfoundry/ContractSchemas");
export const NamespaceStore = Context.Service<NamespaceStore>("gitfoundry/NamespaceStore");
export const RepositoryStore = Context.Service<RepositoryStore>("gitfoundry/RepositoryStore");
export const OperationStore = Context.Service<OperationStore>("gitfoundry/OperationStore");
export const IdempotencyStore = Context.Service<IdempotencyStore>("gitfoundry/IdempotencyStore");
export const NativeDispatcher = Context.Service<NativeDispatcher>("gitfoundry/NativeDispatcher");
export { ForgeStore, CheckStore, CollaborationMetadataStore };
export * from "./fork-forge/index.js";
export type { Comment, CommentCreateInput, CommentPatchInput, ForgeListQuery, ForgeVersionActionInput, Issue, IssueCloseInput, IssueCreateInput, IssuePatchInput, PullRequest, PullRequestCreateInput, PullRequestPatchInput, Review, ReviewCreateInput, ReviewDismissInput, ReviewPatchInput, ReviewSubmitInput };
export { canonicalizeForgeDescriptor, forgeDescriptorDigest, retainedDescriptorRef, serializeForgeDescriptor } from "./fork.js";
export type { ForgeVersionDescriptor, ForgeVersionDescriptorInput } from "./fork.js";
export type { Check, CheckAnnotationQuery, CheckCreateInput, CheckJobAttempt, CheckListQuery, CheckPatchInput, PrChecksQuery, TrustedRevision };

const checkPublicOperationIds = [...checksImplementedOperationIds, "check.view", "check.annotations"] as const;

export const implementedOperationIds = ["repo.list", "repo.view", "repo.create", "repo.fork", "repo.edit", "repo.archive", "repo.unarchive", "repo.delete", "repo.clone", "operation.view", ...forgeImplementedOperationIds, ...checkPublicOperationIds, ...collaborationMetadataImplementedOperationIds] as const;

export function assertCatalogReady(summary: CatalogValidationSummary): CoreReadiness {
  if (summary.operations !== expectedContractCounts.operations) throw new Error(`catalog operation count mismatch: ${summary.operations}`);
  if (summary.mcpTools !== expectedContractCounts.mcpTools) throw new Error(`catalog MCP tool count mismatch: ${summary.mcpTools}`);
  return { ready: true, summary };
}

export function discoverCapabilities(summary: CatalogBindingSummary, operations: readonly NativeOperation[]): CapabilityDiscovery {
  assertCatalogReady(summary);
  const implemented = new Set<string>(implementedOperationIds);
  return {
    total: operations.length,
    implemented: implementedOperationIds,
    entries: operations.map((operation) => ({
      operationId: operation.id,
      mcpTool: operation.mcp_tool,
      capability: operation.capability,
      asynchronous: operation.asynchronous,
      implemented: implemented.has(operation.id)
    }))
  };
}

export interface IdempotencyReservationInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly operationId: string;
  readonly key: string;
  readonly semanticInput: unknown;
}

export interface IdempotencyReservationKeys {
  readonly scope: string;
  readonly requestDigest: string;
  readonly intentId: string;
}

export function makeIdempotencyReservationKeys(input: IdempotencyReservationInput): Effect.Effect<IdempotencyReservationKeys, DomainContractError> {
  return Effect.gen(function* () {
    const keyHex = yield* sha256Hex(canonicalJson(["gitfoundry.idempotency.key.v1", input.key]));
    const scope = canonicalJson([input.tenantId, input.principalId, input.operationId, `sha256:${keyHex}`]);
    const scopeHex = yield* sha256Hex(canonicalJson(["gitfoundry.idempotency.scope.v1", scope]));
    const requestHex = yield* sha256Hex(canonicalJson(["gitfoundry.idempotency.request.v1", input.operationId, input.semanticInput]));
    return {
      scope,
      requestDigest: `sha256:${requestHex}`,
      intentId: `idem-${scopeHex.slice(0, 32)}`
    };
  });
}

export function dispatchOperation(operation: NativeOperation, envelopeInput: unknown): Effect.Effect<OperationReceipt, DomainContractError | IdempotencyConflictError | InvalidStateTransitionError | NotFoundError | RepositoryHasForksError | RepositoryNameConflictError | RepositoryStoreUnavailableError | StalePreconditionError | UnauthorizedError | UnsupportedOperationError, CurrentIdentity | TenantAuthorizer | ContractSchemas | NamespaceStore | RepositoryStore | OperationStore | IdempotencyStore | NativeDispatcher | ForgeStore | CheckStore | CollaborationMetadataStore> {
  return Effect.gen(function* () {
    const schemas = yield* ContractSchemas;
    const envelope = yield* Effect.try({
      try: () => decodeAndValidateEnvelope(operation, envelopeInput, schemas.domain),
      catch: (error) => new DomainContractError({ message: String(error) })
    });
    if (!isImplemented(operation.id)) return yield* Effect.fail(new UnsupportedOperationError({ operationId: operation.id, reason: "no P0 adapter" }));

    const identity = yield* CurrentIdentity;
    const authorizer = yield* TenantAuthorizer;
    const idempotency = yield* IdempotencyStore;
    const native = yield* NativeDispatcher;
    const actor = yield* identity.currentActor();
    const tenantId = requiredRoute(envelope, "tenant_id");

    yield* authorizer.authorize(actor, tenantId, operation.capability);

    const key = envelope.idempotency_key;
    const reservation = key ? yield* makeIdempotencyReservationKeys({
      tenantId,
      principalId: actor.id,
      operationId: operation.id,
      key,
      semanticInput: semanticFingerprint(operation, envelope)
    }) : undefined;
    const reservationId = reservation ? `${reservation.intentId}-${globalThis.crypto.randomUUID()}` : "";
    if (reservation) {
      const replay = yield* idempotency.replayOrReserve(reservation.scope, reservation.requestDigest, makeOperationRecord(tenantId, reservationId, operation.id, "running", {}));
      if (replay) return replay;
    }

    const receipt = yield* native.dispatch(operation, envelope);
    if (reservation) yield* idempotency.commit(reservation.scope, reservation.requestDigest, receipt, reservationId);
    return receipt;
  });
}

export function makeNativeDispatcher(operations: readonly NativeOperation[]): NativeDispatcher {
  const operationIds = new Set(operations.map((operation) => operation.id));
  return {
    dispatch: (operation, envelope) => Effect.gen(function* () {
      if (!operationIds.has(operation.id)) return yield* Effect.fail(new UnsupportedOperationError({ operationId: operation.id, reason: "not in catalog" }));
      const schemas = yield* ContractSchemas;
      switch (operation.id) {
        case "repo.list": {
          const store = yield* RepositoryStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const items = yield* store.list(tenantId);
          return validateSucceeded(operation, { items, next_cursor: null, has_more: false }, schemas.domain);
        }
        case "repo.clone":
        case "repo.view": {
          const store = yield* RepositoryStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const id = requiredRoute(envelope, "id");
          const repository = yield* store.get(tenantId, id);
          return validateSucceeded(operation, repository, schemas.domain);
        }
        case "repo.create": {
          if (envelope.expected_version !== undefined && envelope.expected_version !== 0) return yield* Effect.fail(new StalePreconditionError({ expected: envelope.expected_version, actual: 0 }));
          const namespaces = yield* NamespaceStore;
          const store = yield* RepositoryStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const request = envelope.body as RepositoryCreateInput;
          yield* namespaces.get(tenantId, request.namespace_id);
          const repository = yield* store.create(tenantId, request);
          return validateSucceeded(operation, repository, schemas.domain);
        }
        case "repo.fork": {
          const namespaces = yield* NamespaceStore;
          const store = yield* RepositoryStore;
          const identity = yield* CurrentIdentity;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const request = actionInput<ForgeForkRequest>(envelope);
          yield* namespaces.get(tenantId, request.target_namespace_id);
          const record = yield* store.fork(tenantId, yield* identity.currentActor(), requiredRoute(envelope, "id"), request);
          return validateSucceeded(operation, record, schemas.domain);
        }
        case "repo.edit": {
          const store = yield* RepositoryStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const repository = yield* store.update(tenantId, requiredRoute(envelope, "id"), requiredExpectedVersion(envelope), envelope.body as RepositoryPatchInput);
          return validateSucceeded(operation, repository, schemas.domain);
        }
        case "repo.archive": {
          const store = yield* RepositoryStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const repository = yield* store.setArchived(tenantId, requiredRoute(envelope, "id"), actionInput<RepositoryVersionActionInput>(envelope), true);
          return validateSucceeded(operation, repository, schemas.domain);
        }
        case "repo.unarchive": {
          const store = yield* RepositoryStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const repository = yield* store.setArchived(tenantId, requiredRoute(envelope, "id"), actionInput<RepositoryVersionActionInput>(envelope), false);
          return validateSucceeded(operation, repository, schemas.domain);
        }
        case "repo.delete": {
          const store = yield* RepositoryStore;
          if (!store.delete) return yield* unsupportedAdapter(operation);
          const tenantId = requiredRoute(envelope, "tenant_id");
          const record = yield* store.delete(tenantId, requiredRoute(envelope, "id"), actionInput<RepositoryVersionActionInput>(envelope));
          return validateSucceeded(operation, record, schemas.domain);
        }
        case "operation.view": {
          const store = yield* OperationStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const id = requiredRoute(envelope, "id");
          const record = yield* store.get(tenantId, id);
          return validateSucceeded(operation, record, schemas.domain);
        }
        case "issue.list": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.listIssues(tenantId, envelope.query as ForgeListQuery), schemas.domain);
        }
        case "issue.view": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.getIssue(tenantId, requiredRoute(envelope, "id")), schemas.domain);
        }
        case "issue.create": {
          yield* requireCreateVersion(envelope);
          const store = yield* ForgeStore;
          const identity = yield* CurrentIdentity;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.createIssue(tenantId, yield* identity.currentActor(), envelope.body as IssueCreateInput), schemas.domain);
        }
        case "issue.edit": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.updateIssue(tenantId, requiredRoute(envelope, "id"), requiredExpectedVersion(envelope), envelope.body as IssuePatchInput), schemas.domain);
        }
        case "issue.close": {
          const store = yield* ForgeStore;
          if (!store.closeIssue) return yield* unsupportedAdapter(operation);
          const tenantId = requiredRoute(envelope, "tenant_id");
          const input = actionInput<IssueCloseInput>(envelope);
          return validateSucceeded(operation, yield* store.closeIssue(tenantId, requiredRoute(envelope, "id"), input), schemas.domain);
        }
        case "issue.reopen": {
          const store = yield* ForgeStore;
          if (!store.reopenIssue) return yield* unsupportedAdapter(operation);
          const tenantId = requiredRoute(envelope, "tenant_id");
          const input = actionInput<ForgeVersionActionInput>(envelope);
          return validateSucceeded(operation, yield* store.reopenIssue(tenantId, requiredRoute(envelope, "id"), input), schemas.domain);
        }
        case "pr.list": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.listPullRequests(tenantId, envelope.query as ForgeListQuery), schemas.domain);
        }
        case "pr.view": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.getPullRequest(tenantId, requiredRoute(envelope, "id")), schemas.domain);
        }
        case "pr.create": {
          yield* requireCreateVersion(envelope);
          const store = yield* ForgeStore;
          const identity = yield* CurrentIdentity;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.createPullRequest(tenantId, yield* identity.currentActor(), envelope.body as PullRequestCreateInput), schemas.domain);
        }
        case "pr.edit": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.updatePullRequest(tenantId, requiredRoute(envelope, "id"), requiredExpectedVersion(envelope), envelope.body as PullRequestPatchInput), schemas.domain);
        }
        case "pr.close": {
          const store = yield* ForgeStore;
          if (!store.closePullRequest) return yield* unsupportedAdapter(operation);
          const tenantId = requiredRoute(envelope, "tenant_id");
          const input = actionInput<ForgeVersionActionInput>(envelope);
          return validateSucceeded(operation, yield* store.closePullRequest(tenantId, requiredRoute(envelope, "id"), input), schemas.domain);
        }
        case "pr.reopen": {
          const store = yield* ForgeStore;
          if (!store.reopenPullRequest) return yield* unsupportedAdapter(operation);
          const tenantId = requiredRoute(envelope, "tenant_id");
          const input = actionInput<ForgeVersionActionInput>(envelope);
          return validateSucceeded(operation, yield* store.reopenPullRequest(tenantId, requiredRoute(envelope, "id"), input), schemas.domain);
        }
        case "pr.ready": {
          const store = yield* ForgeStore;
          if (!store.markPullRequestReady) return yield* unsupportedAdapter(operation);
          const tenantId = requiredRoute(envelope, "tenant_id");
          const input = actionInput<ForgeVersionActionInput>(envelope);
          return validateSucceeded(operation, yield* store.markPullRequestReady(tenantId, requiredRoute(envelope, "id"), input), schemas.domain);
        }
        case "pr.draft": {
          const store = yield* ForgeStore;
          if (!store.markPullRequestDraft) return yield* unsupportedAdapter(operation);
          const tenantId = requiredRoute(envelope, "tenant_id");
          const input = actionInput<ForgeVersionActionInput>(envelope);
          return validateSucceeded(operation, yield* store.markPullRequestDraft(tenantId, requiredRoute(envelope, "id"), input), schemas.domain);
        }
        case "comment.list": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.listComments(tenantId, envelope.query as ForgeListQuery), schemas.domain);
        }
        case "comment.view": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.getComment(tenantId, requiredRoute(envelope, "id")), schemas.domain);
        }
        case "comment.create": {
          yield* requireCreateVersion(envelope);
          const store = yield* ForgeStore;
          const identity = yield* CurrentIdentity;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.createComment(tenantId, yield* identity.currentActor(), envelope.body as CommentCreateInput), schemas.domain);
        }
        case "comment.edit": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.updateComment(tenantId, requiredRoute(envelope, "id"), requiredExpectedVersion(envelope), envelope.body as CommentPatchInput), schemas.domain);
        }
        case "review.list": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.listReviews(tenantId, envelope.query as ForgeListQuery), schemas.domain);
        }
        case "review.view": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.getReview(tenantId, requiredRoute(envelope, "id")), schemas.domain);
        }
        case "review.create": {
          yield* requireCreateVersion(envelope);
          const store = yield* ForgeStore;
          const identity = yield* CurrentIdentity;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.createReview(tenantId, yield* identity.currentActor(), envelope.body as ReviewCreateInput), schemas.domain);
        }
        case "review.edit": {
          const store = yield* ForgeStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.updateReview(tenantId, requiredRoute(envelope, "id"), requiredExpectedVersion(envelope), envelope.body as ReviewPatchInput), schemas.domain);
        }
        case "review.submit": {
          const store = yield* ForgeStore;
          if (!store.submitReview) return yield* unsupportedAdapter(operation);
          const tenantId = requiredRoute(envelope, "tenant_id");
          const input = actionInput<ReviewSubmitInput>(envelope);
          return validateSucceeded(operation, yield* store.submitReview(tenantId, requiredRoute(envelope, "id"), input), schemas.domain);
        }
        case "review.dismiss": {
          const store = yield* ForgeStore;
          if (!store.dismissReview) return yield* unsupportedAdapter(operation);
          const tenantId = requiredRoute(envelope, "tenant_id");
          const input = actionInput<ReviewDismissInput>(envelope);
          return validateSucceeded(operation, yield* store.dismissReview(tenantId, requiredRoute(envelope, "id"), input), schemas.domain);
        }
        case "check.list": {
          const store = yield* CheckStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.list(tenantId, envelope.query as CheckListQuery), schemas.domain);
        }
        case "check.create": {
          yield* requireCreateVersion(envelope);
          const store = yield* CheckStore;
          const identity = yield* CurrentIdentity;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.create(tenantId, yield* identity.currentActor(), envelope.body as CheckCreateInput), schemas.domain);
        }
        case "check.edit": {
          const store = yield* CheckStore;
          const identity = yield* CurrentIdentity;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.update(tenantId, requiredRoute(envelope, "id"), yield* identity.currentActor(), requiredExpectedVersion(envelope), envelope.body as CheckPatchInput), schemas.domain);
        }
        case "check.view": {
          const store = yield* CheckStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.view(tenantId, requiredRoute(envelope, "id")), schemas.domain);
        }
        case "check.annotations": {
          const store = yield* CheckStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.listAnnotations(tenantId, requiredRoute(envelope, "id"), envelope.query as CheckAnnotationQuery), schemas.domain);
        }
        case "pr.checks": {
          const store = yield* CheckStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.listForPullRequest(tenantId, requiredRoute(envelope, "id"), envelope.query as PrChecksQuery), schemas.domain);
        }
        case "label.list": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.listLabels(tenantId, envelope.query as ForgeLabelListQuery), schemas.domain);
        }
        case "label.view": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.getLabel(tenantId, requiredRoute(envelope, "id")), schemas.domain);
        }
        case "label.create": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const actor = yield* (yield* CurrentIdentity).currentActor();
          return validateSucceeded(operation, yield* store.createLabel(tenantId, actor, envelope.body as ForgeLabelCreateInput), schemas.domain);
        }
        case "label.edit": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const patch = actionInput<ForgeLabelPatchInput & { readonly expected_version: number }>(envelope);
          return validateSucceeded(operation, yield* store.updateLabel(tenantId, requiredRoute(envelope, "id"), patch.expected_version, patch), schemas.domain);
        }
        case "label.delete": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const actor = yield* (yield* CurrentIdentity).currentActor();
          return validateSucceeded(operation, yield* store.deleteLabel(tenantId, requiredRoute(envelope, "id"), actor, actionInput<ForgeDeleteInput>(envelope)), schemas.domain);
        }
        case "milestone.list": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.listMilestones(tenantId, envelope.query as ForgeMilestoneListQuery), schemas.domain);
        }
        case "milestone.view": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          return validateSucceeded(operation, yield* store.getMilestone(tenantId, requiredRoute(envelope, "id")), schemas.domain);
        }
        case "milestone.create": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const actor = yield* (yield* CurrentIdentity).currentActor();
          return validateSucceeded(operation, yield* store.createMilestone(tenantId, actor, envelope.body as ForgeMilestoneCreateInput), schemas.domain);
        }
        case "milestone.edit": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const patch = actionInput<ForgeMilestonePatchInput & { readonly expected_version: number }>(envelope);
          return validateSucceeded(operation, yield* store.updateMilestone(tenantId, requiredRoute(envelope, "id"), patch.expected_version, patch), schemas.domain);
        }
        case "milestone.delete": {
          const store = yield* CollaborationMetadataStore;
          const tenantId = requiredRoute(envelope, "tenant_id");
          const actor = yield* (yield* CurrentIdentity).currentActor();
          return validateSucceeded(operation, yield* store.deleteMilestone(tenantId, requiredRoute(envelope, "id"), actor, actionInput<ForgeDeleteInput>(envelope)), schemas.domain);
        }
        default:
          return yield* Effect.fail(new UnsupportedOperationError({ operationId: operation.id, reason: "no P0 adapter" }));
      }
    })
  };
}

export function makeFakeGitFoundryLayer(input: {
  actor: Actor | (() => Actor);
  domain: SourceDomainDocument;
  operations: readonly NativeOperation[];
  namespaces?: readonly Namespace[];
  repositories?: readonly Repository[];
  issues?: readonly Issue[];
  pullRequests?: readonly PullRequest[];
  comments?: readonly Comment[];
  reviews?: readonly Review[];
  checks?: readonly Check[];
  trustedRevisions?: readonly TrustedRevision[];
  jobAttempts?: readonly CheckJobAttempt[];
  now?: string;
  createDelayMs?: number;
}): Layer.Layer<CurrentIdentity | TenantAuthorizer | ContractSchemas | NamespaceStore | RepositoryStore | OperationStore | IdempotencyStore | NativeDispatcher | ForgeStore | CheckStore | CollaborationMetadataStore> {
  const namespaces = new Map<string, Namespace>();
  for (const namespace of input.namespaces ?? []) namespaces.set(resourceKey(namespace.tenant_id, namespace.id), { ...namespace });
  const repositories = new Map<string, Repository>();
  for (const repository of input.repositories ?? []) repositories.set(resourceKey(repository.tenant_id, repository.id), { ...repository });
  const operations = new Map<string, OperationRecord>();
  const receipts = new Map<string, { fingerprint: string; receipt?: OperationReceipt; pending: OperationRecord }>();
  const now = input.now ?? "2026-10-07T18:00:00Z";

  const identity: CurrentIdentity = {
    currentActor: () => Effect.succeed(typeof input.actor === "function" ? input.actor() : input.actor)
  };
  const authorizer: TenantAuthorizer = {
    authorize: (actor, tenantId, capability) => {
      if (actor.revoked) return Effect.fail(new UnauthorizedError({ reason: "actor revoked", actorId: actor.id, tenantId, capability }));
      if (actor.tenantId !== tenantId) return Effect.fail(new UnauthorizedError({ reason: "tenant mismatch", actorId: actor.id, tenantId, capability }));
      if (!actor.capabilities.includes(capability)) return Effect.fail(new UnauthorizedError({ reason: "missing capability", actorId: actor.id, tenantId, capability }));
      return Effect.succeed(undefined);
    }
  };
  const namespaceStore: NamespaceStore = {
    get: (tenantId, id) => {
      const namespace = namespaces.get(resourceKey(tenantId, id));
      return namespace ? Effect.succeed({ ...namespace }) : Effect.fail(new NotFoundError({ resource: "namespace", id }));
    }
  };
  const repositoryStore: RepositoryStore = {
    get: (tenantId, id) => {
      const repository = repositories.get(resourceKey(tenantId, id));
      return repository ? Effect.succeed({ ...repository }) : Effect.fail(new NotFoundError({ resource: "repository", id }));
    },
    list: (tenantId) => Effect.sync(() => Array.from(repositories.values()).filter((repository) => repository.tenant_id === tenantId).map((repository) => ({ ...repository }))),
    create: (tenantId, request) => {
      const create = () => {
        const id = `${request.namespace_id}-${request.name}`;
        const repository: Repository = {
          tenant_id: tenantId,
          id,
          version: 1,
          created_at: now,
          updated_at: now,
          namespace_id: request.namespace_id,
          name: request.name,
          visibility: request.visibility ?? "private",
          default_branch: request.default_branch ?? "main",
          archived: false,
          fork_of: null,
          git_url: `https://gitfoundry.example/${tenantId}/${request.namespace_id}/${request.name}.git`
        };
        repositories.set(resourceKey(tenantId, id), repository);
        return { ...repository };
      };
      if (!input.createDelayMs) return Effect.sync(create);
      return Effect.promise(() => new Promise<Repository>((resolve) => setTimeout(() => resolve(create()), input.createDelayMs)));
    },
    fork: (tenantId, actor, id, request) => Effect.gen(function* () {
      const source = repositories.get(resourceKey(tenantId, id));
      if (!source) return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      if (source.version !== request.expected_version) return yield* Effect.fail(new StalePreconditionError({ expected: request.expected_version, actual: source.version }));
      if (!namespaces.has(resourceKey(tenantId, request.target_namespace_id))) return yield* Effect.fail(new NotFoundError({ resource: "namespace", id: request.target_namespace_id }));
      for (const candidate of repositories.values()) {
        if (candidate.tenant_id === tenantId && candidate.namespace_id === request.target_namespace_id && candidate.name === request.name) {
          return yield* Effect.fail(new RepositoryNameConflictError({ tenantId, namespaceId: request.target_namespace_id, name: request.name }));
        }
      }
      const repositoryId = `${request.target_namespace_id}-${request.name}`;
      const sourceSnapshotDigest = yield* sha256Hex(canonicalJson(["gitfoundry.fork.source.v1", tenantId, id, source.version, source.default_branch, source.git_url, actor.id, request.default_branch_only ?? false]));
      const repository: Repository = {
        tenant_id: tenantId,
        id: repositoryId,
        version: 1,
        created_at: now,
        updated_at: now,
        namespace_id: request.target_namespace_id,
        name: request.name,
        visibility: request.visibility,
        default_branch: source.default_branch,
        archived: false,
        fork_of: id,
        git_url: `https://gitfoundry.example/${tenantId}/${request.target_namespace_id}/${request.name}.git`
      };
      repositories.set(resourceKey(tenantId, repositoryId), repository);
      return {
        tenant_id: tenantId,
        id: `op-fork-${sourceSnapshotDigest.slice(0, 32)}`,
        version: 1,
        created_at: now,
        updated_at: now,
        status: "succeeded",
        kind: "repo.fork",
        progress: { stage: "completed", completed: 1, total: 1, blocked_reason: null },
        result: { source_repository_id: id, repository_id: repositoryId, copied_ref_count: 0, copied_object_count: 0, source_snapshot_digest: sourceSnapshotDigest },
        error: null
      } satisfies OperationRecord;
    }),
    update: (tenantId, id, expectedVersion, patch) => Effect.gen(function* () {
      const key = resourceKey(tenantId, id);
      const current = repositories.get(key);
      if (!current) return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      if (current.version !== expectedVersion) return yield* Effect.fail(new StalePreconditionError({ expected: expectedVersion, actual: current.version }));
      if (patch.name !== undefined && patch.name !== current.name) {
        for (const candidate of repositories.values()) {
          if (candidate.tenant_id === tenantId && candidate.namespace_id === current.namespace_id && candidate.id !== id && candidate.name === patch.name) {
            return yield* Effect.fail(new RepositoryNameConflictError({ tenantId, namespaceId: current.namespace_id, name: patch.name }));
          }
        }
      }
      if (patch.description !== undefined) return yield* Effect.fail(new UnsupportedOperationError({ operationId: "repo.edit", reason: "repository description metadata has no persisted contract field in the current repository store" }));
      const updated: Repository = {
        ...current,
        version: current.version + 1,
        updated_at: now,
        name: patch.name ?? current.name,
        visibility: patch.visibility ?? current.visibility,
        default_branch: patch.default_branch ?? current.default_branch
      };
      repositories.set(key, updated);
      return { ...updated };
    }),
    setArchived: (tenantId, id, action, archived) => Effect.gen(function* () {
      const key = resourceKey(tenantId, id);
      const current = repositories.get(key);
      if (!current) return yield* Effect.fail(new NotFoundError({ resource: "repository", id }));
      if (current.version !== action.expected_version) return yield* Effect.fail(new StalePreconditionError({ expected: action.expected_version, actual: current.version }));
      if (current.archived === archived) return yield* Effect.fail(new InvalidStateTransitionError({ resource: "repository", id, state: current.archived ? "archived" : "active", expectedState: archived ? "active" : "archived" }));
      const updated: Repository = { ...current, version: current.version + 1, updated_at: now, archived };
      repositories.set(key, updated);
      return { ...updated };
    })
  };
  const operationStore: OperationStore = {
    get: (tenantId, id) => {
      const record = operations.get(resourceKey(tenantId, id));
      return record ? Effect.succeed({ ...record }) : Effect.fail(new NotFoundError({ resource: "operation", id }));
    },
    put: (record) => Effect.sync(() => {
      operations.set(resourceKey(record.tenant_id, record.id), { ...record });
    })
  };
  const idempotency: IdempotencyStore = {
    replayOrReserve: (scope, fingerprint, pending) => {
      const existing = receipts.get(scope);
      if (!existing) {
        receipts.set(scope, { fingerprint, pending });
        operations.set(resourceKey(pending.tenant_id, pending.id), { ...pending });
        return Effect.succeed(undefined);
      }
      if (existing.fingerprint !== fingerprint) return Effect.fail(new IdempotencyConflictError({ key: scope }));
      if (existing.receipt) return Effect.succeed(withReplay(existing.receipt));
      return Effect.succeed({ status: "pending", operationId: pending.kind, reason: "in_progress", receiptId: existing.pending.id } satisfies OperationReceipt);
    },
    commit: (scope, fingerprint, receipt, reservationId) => Effect.try({
      try: () => {
        const existing = receipts.get(scope);
        if (!existing || existing.fingerprint !== fingerprint || existing.pending.id !== reservationId || existing.receipt) throw new IdempotencyConflictError({ key: scope });
        const status = receipt.status === "succeeded" ? "succeeded" : "running";
        const result = receipt.status === "succeeded" ? { response: receipt.response } : { receipt_id: receipt.receiptId };
        const record = { ...existing.pending, status, result, updated_at: now } satisfies OperationRecord;
        operations.set(resourceKey(record.tenant_id, record.id), record);
        receipts.set(scope, { fingerprint, receipt, pending: existing.pending });
      },
      catch: () => new IdempotencyConflictError({ key: scope })
    })
  };

  return Layer.mergeAll(
    Layer.succeed(CurrentIdentity, identity),
    Layer.succeed(TenantAuthorizer, authorizer),
    Layer.succeed(ContractSchemas, { domain: input.domain }),
    Layer.succeed(NamespaceStore, namespaceStore),
    Layer.succeed(RepositoryStore, repositoryStore),
    Layer.succeed(OperationStore, operationStore),
    Layer.succeed(IdempotencyStore, idempotency),
    Layer.succeed(ForgeStore, makeFakeForgeStore({
      repositories: Array.from(repositories.values()),
      now,
      ...(input.issues ? { issues: input.issues } : {}),
      ...(input.pullRequests ? { pullRequests: input.pullRequests } : {}),
      ...(input.comments ? { comments: input.comments } : {}),
      ...(input.reviews ? { reviews: input.reviews } : {})
    })),
    Layer.succeed(CheckStore, makeFakeCheckStore({
      repositories: Array.from(repositories.values()),
      now,
      ...(input.pullRequests ? { pullRequests: input.pullRequests } : {}),
      ...(input.checks ? { checks: input.checks } : {}),
      ...(input.trustedRevisions ? { trustedRevisions: input.trustedRevisions } : {}),
      ...(input.jobAttempts ? { jobAttempts: input.jobAttempts } : {})
    })),
    Layer.succeed(CollaborationMetadataStore, makeFakeCollaborationMetadataStore({ repositories: Array.from(repositories.values()), now })),
    Layer.succeed(NativeDispatcher, makeNativeDispatcher(input.operations))
  );
}

export function succeededReceipt(operationId: string, response: unknown): OperationReceipt {
  return { status: "succeeded", operationId, response, replayed: false };
}

function withReplay(receipt: OperationReceipt): OperationReceipt {
  return receipt.status === "succeeded" ? { ...receipt, replayed: true } : receipt;
}

function decodeAndValidateEnvelope(operation: NativeOperation, envelopeInput: unknown, domain: SourceDomainDocument): RequestEnvelope {
  const envelope = decodeRequestEnvelope(envelopeInput);
  if (envelope.operation_id !== operation.id) throw new Error(`envelope operation ${envelope.operation_id} does not match ${operation.id}`);
  validateRoute(operation, envelope);
  validateRequestPayload(operation, envelope, domain);
  return envelope;
}

function validateRoute(operation: NativeOperation, envelope: RequestEnvelope): void {
  const expected = routeKeys(operation.path);
  const actual = Object.keys(envelope.route).sort();
  if (actual.join("\u0000") !== expected.join("\u0000")) throw new Error(`route keys expected ${expected.join(",")}, got ${actual.join(",")}`);
}

function validateRequestPayload(operation: NativeOperation, envelope: RequestEnvelope, domain: SourceDomainDocument): void {
  if (operation.request_schema) {
    const value = operation.request_location === "query" ? envelope.query : operation.request_location === "body" ? envelope.body : envelope.route;
    decodeSourceSchema(domain, operation.request_schema, value);
    rejectUnknownRequestFields(operation, operation.request_schema, value, domain);
  } else {
    if (operation.request_location === "query" && Object.keys(envelope.query).length > 0) throw new Error(`${operation.id} query must be empty`);
    if (operation.request_location === "body" && envelope.body !== null && envelope.body !== undefined) throw new Error(`${operation.id} body must be empty`);
  }
}

function rejectUnknownRequestFields(operation: NativeOperation, schemaName: string, value: unknown, domain: SourceDomainDocument): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const definitions = schemaDefinitions(domain);
  const allowed = schemaPropertyKeys(definitions[schemaName], definitions, new Set());
  if (allowed.size === 0) return;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${operation.id} ${operation.request_location} unknown fields: ${unknown.join(",")}`);
}

function schemaDefinitions(domain: SourceDomainDocument): Record<string, unknown> {
  const document = domain as unknown as { readonly $defs?: Record<string, unknown>; readonly definitions?: Record<string, unknown> };
  return document.$defs ?? document.definitions ?? {};
}

function schemaPropertyKeys(schema: unknown, definitions: Record<string, unknown>, seen: Set<string>): Set<string> {
  const allowed = new Set<string>();
  if (!schema || typeof schema !== "object") return allowed;
  const record = schema as { readonly $ref?: string; readonly properties?: Record<string, unknown>; readonly allOf?: readonly unknown[]; readonly anyOf?: readonly unknown[]; readonly oneOf?: readonly unknown[]; readonly then?: unknown; readonly else?: unknown };
  if (record.$ref?.startsWith("#/$defs/")) {
    const name = record.$ref.slice("#/$defs/".length);
    if (!seen.has(name)) {
      seen.add(name);
      for (const key of schemaPropertyKeys(definitions[name], definitions, seen)) allowed.add(key);
    }
  }
  for (const key of Object.keys(record.properties ?? {})) allowed.add(key);
  for (const branch of [...(record.allOf ?? []), ...(record.anyOf ?? []), ...(record.oneOf ?? []), record.then, record.else]) {
    for (const key of schemaPropertyKeys(branch, definitions, seen)) allowed.add(key);
  }
  return allowed;
}

function validateSucceeded(operation: NativeOperation, response: unknown, domain: SourceDomainDocument): OperationReceipt {
  decodeSourceSchema(domain, operation.output_schema, response);
  return succeededReceipt(operation.id, response);
}

function semanticFingerprint(operation: NativeOperation, envelope: RequestEnvelope): unknown {
  return {
    operation_id: operation.id,
    route: envelope.route,
    query: envelope.query,
    body: envelope.body,
    expected_version: envelope.expected_version ?? null,
    api_version: envelope.api_version
  };
}

function routeKeys(path: string): string[] {
  return Array.from(path.matchAll(/\{([^}]+)\}/g)).map((match) => match[1]).filter((key): key is string => typeof key === "string").sort();
}

function isImplemented(operationId: string): boolean {
  return (implementedOperationIds as readonly string[]).includes(operationId);
}

function unsupportedAdapter(operation: NativeOperation): Effect.Effect<never, UnsupportedOperationError> {
  return Effect.fail(new UnsupportedOperationError({ operationId: operation.id, reason: "forge adapter does not implement this state transition" }));
}

function requiredExpectedVersion(envelope: RequestEnvelope): number {
  if (envelope.expected_version === undefined) throw new DomainContractError({ message: "expected_version is required for updates" });
  return envelope.expected_version;
}

function actionInput<T extends { readonly expected_version: number }>(envelope: RequestEnvelope): T {
  const body = envelope.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainContractError({ message: "action body is required" });
  const expectedVersion = (body as { readonly expected_version?: unknown }).expected_version;
  if (!Number.isInteger(expectedVersion)) throw new DomainContractError({ message: "body.expected_version is required for actions" });
  if (envelope.expected_version !== undefined && envelope.expected_version !== expectedVersion) throw new DomainContractError({ message: "expected_version must match body.expected_version" });
  return body as T;
}

function requireCreateVersion(envelope: RequestEnvelope): Effect.Effect<void, StalePreconditionError> {
  return envelope.expected_version === undefined || envelope.expected_version === 0 ? Effect.void : Effect.fail(new StalePreconditionError({ expected: envelope.expected_version, actual: 0 }));
}

function requiredRoute(envelope: RequestEnvelope, key: string): string {
  const value = envelope.route[key];
  if (!value) throw new DomainContractError({ message: `route.${key} is required` });
  return value;
}

function resourceKey(tenantId: string, id: string): string {
  return `${tenantId}:${id}`;
}

function makeOperationRecord(tenantId: string, id: string, kind: string, status: OperationRecord["status"], result: Record<string, unknown>): OperationRecord {
  return {
    tenant_id: tenantId,
    id,
    version: 1,
    created_at: "2026-10-07T18:00:00Z",
    updated_at: "2026-10-07T18:00:00Z",
    status,
    kind,
    progress: {},
    result,
    error: null
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}


function sha256Hex(value: string): Effect.Effect<string, DomainContractError> {
  return Effect.tryPromise({
    try: async () => {
      if (!globalThis.crypto?.subtle) throw new Error("WebCrypto subtle digest is unavailable");
      const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (error) => new DomainContractError({ message: String(error) })
  });
}
