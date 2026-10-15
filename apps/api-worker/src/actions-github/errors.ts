import { Data } from "effect";

export class ActionsConfigurationError extends Data.TaggedError("ActionsConfigurationError")<{ readonly message: string; readonly cause?: unknown }> {}
export class ActionsOwnerAuthenticationError extends Data.TaggedError("ActionsOwnerAuthenticationError")<{ readonly message: string; readonly cause?: unknown }> {}
export class ActionsRegistrationExchangeError extends Data.TaggedError("ActionsRegistrationExchangeError")<{ readonly message: string; readonly cause?: unknown }> {}
export class ActionsUpstreamProxyError extends Data.TaggedError("ActionsUpstreamProxyError")<{ readonly message: string; readonly cause?: unknown }> {}
export class ActionsStorageError extends Data.TaggedError("ActionsStorageError")<{ readonly message: string; readonly cause?: unknown }> {}

export type GitHubActionsError = ActionsConfigurationError | ActionsOwnerAuthenticationError | ActionsRegistrationExchangeError | ActionsUpstreamProxyError | ActionsStorageError;

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
