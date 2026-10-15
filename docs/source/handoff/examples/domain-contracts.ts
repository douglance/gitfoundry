/** gitfoundry owned domain ports. Implementation sketch, not a compiled provider adapter. */
import type * as Effect from "effect/Effect";
export type Id = string;
export type Sha1 = string;
export interface Actor {
  readonly tenant_id: Id;
  readonly principal_id: Id;
  readonly kind: "human" | "service" | "extension" | "job" | "migration" | "system";
  readonly policy_epoch: number;
  readonly scopes: readonly string[];
}
export interface RequestContext {
  readonly actor: Actor;
  readonly request_id: Id;
  readonly deadline_at: string;
  readonly idempotency_key: string;
}
export type DomainError =
  | { readonly _tag: "Forbidden"; readonly code: "FORBIDDEN"; readonly detail: string }
  | { readonly _tag: "VersionConflict"; readonly code: "VERSION_CONFLICT"; readonly detail: string }
  | { readonly _tag: "ProviderUnavailable"; readonly code: "PROVIDER_UNAVAILABLE"; readonly detail: string }
  | { readonly _tag: "OutcomeUnknown"; readonly code: "OUTCOME_UNKNOWN"; readonly operation_id: Id };
export interface RefUpdate { readonly ref: string; readonly old_sha: Sha1; readonly new_sha: Sha1 }
export interface GitIntent {
  readonly tenant_id: Id;
  readonly repository_id: Id;
  readonly updates: readonly RefUpdate[];
  readonly expected_policy_epoch: number;
  readonly fencing_token: string;
  readonly approved_hook_digest: string;
}
export interface GitPort {
  readRefs(tenant: Id, repository: Id): Effect.Effect<readonly RefUpdate[], DomainError>;
  /** Exact old refs and fenced admission. Unknown outcomes are reconciled, never blindly repeated. */
  publish(intent: GitIntent): Effect.Effect<{ journal_id: Id; observed_refs: readonly RefUpdate[] }, DomainError>;
  reconcile(tenant: Id, journal: Id): Effect.Effect<"committed" | "not_committed" | "partial" | "unknown", DomainError>;
}
export interface ExecutorIntent {
  readonly tenant_id: Id;
  readonly job_attempt_id: Id;
  readonly lease_generation: number;
  readonly fencing_token: string;
  readonly image_digest: string;
  readonly argv: readonly string[];
  readonly environment_refs: readonly Id[];
  readonly deadline_at: string;
  readonly side_effect_policy: "read_only" | "idempotent" | "nonrepeatable";
}
export interface ExecutorPort {
  start(intent: ExecutorIntent): Effect.Effect<{ executor_id: Id }, DomainError>;
  cancel(tenant: Id, attempt: Id, fence: string): Effect.Effect<void, DomainError>;
  /** Persist progress and redact before logs become user-visible. */
  observe(tenant: Id, attempt: Id): Effect.Effect<{ state: string; redacted_log_cursor: string }, DomainError>;
}
export interface PolicyPort {
  decide(actor: Actor, action: string, resource: { tenant_id: Id; id: Id }): Effect.Effect<{ allowed: boolean; epoch: number; reasons: readonly string[] }, DomainError>;
}
/** Implement each port as an Effect service + live/fake Layers using pinned Effect 4 APIs.
 * Bind provider resources in Alchemy. Use Workflow checkpoints for durable orchestrations.
 * Never run user code inside these control-plane service Layers.
 */
