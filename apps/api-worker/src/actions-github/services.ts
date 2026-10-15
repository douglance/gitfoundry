import { Context, Effect, Layer } from "effect";

import { ActionsOwnerAuthenticationError, ActionsUpstreamProxyError, errorMessage } from "./errors.js";
import type { GitHubActionsPorts } from "./index.js";

export interface OwnerAuthenticationInput {
  readonly request: Request;
  readonly tenant_id: string;
  readonly repository_id: string;
  readonly capability: "actions:runner-registration";
}

export type OwnerAuthenticationResult = { readonly ok: true; readonly actor_id: string } | { readonly ok: false; readonly response: Response };

export interface GitHubActionsServicesShape {
  readonly authenticateOwner: (input: OwnerAuthenticationInput) => Effect.Effect<OwnerAuthenticationResult, ActionsOwnerAuthenticationError>;
  readonly now: Effect.Effect<Date>;
  readonly proxyUpstream: (request: Request, upstreamOrigin?: string) => Effect.Effect<Response, ActionsUpstreamProxyError>;
  readonly storagePointer: GitHubActionsPorts["storagePointer"];
}

export class GitHubActionsServices extends Context.Service<GitHubActionsServices, GitHubActionsServicesShape>()("gitfoundry/GitHubActionsServices") {}

export function makeGitHubActionsServices(ports: GitHubActionsPorts): GitHubActionsServicesShape {
  return {
    authenticateOwner: (input) => Effect.tryPromise({
      try: () => ports.authenticateOwner(input),
      catch: (cause) => new ActionsOwnerAuthenticationError({ message: errorMessage(cause, "actions owner authentication failed"), cause })
    }),
    now: Effect.sync(() => ports.now?.() ?? new Date()),
    proxyUpstream: (request, upstreamOrigin) => {
      if (ports.proxyUpstream) {
        return Effect.tryPromise({
          try: () => ports.proxyUpstream!(request),
          catch: (cause) => new ActionsUpstreamProxyError({ message: errorMessage(cause, "actions upstream proxy failed"), cause })
        });
      }
      if (!upstreamOrigin) return Effect.fail(new ActionsUpstreamProxyError({ message: "actions_upstream_unavailable" }));
      const incoming = new URL(request.url);
      const upstream = new Request(new URL(incoming.pathname + incoming.search, upstreamOrigin), request);
      return Effect.tryPromise({
        try: (signal) => fetch(upstream, { signal }),
        catch: (cause) => new ActionsUpstreamProxyError({ message: errorMessage(cause, "actions upstream proxy failed"), cause })
      });
    },
    storagePointer: ports.storagePointer
  };
}

export function makeGitHubActionsServicesLayer(ports: GitHubActionsPorts): Layer.Layer<GitHubActionsServices> {
  return Layer.succeed(GitHubActionsServices, makeGitHubActionsServices(ports));
}
