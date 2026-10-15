import { Context, Data, Effect, Layer } from "effect";

export class ActionsBackendError extends Data.TaggedError("ActionsBackendError")<{
  readonly operation: "configuration" | "start" | "readiness" | "proxy";
}> {}

export interface ActionsBackendConfig {
  readonly publicOrigin: string;
  readonly generation: string;
  readonly runnerToken: string;
  readonly storageToken: string;
  readonly rsaPrivateKey: string;
  readonly storageAccessClientId?: string;
  readonly storageAccessClientSecret?: string;
}

export interface ActionsContainerPort {
  readonly running: boolean;
  start(options: {
    readonly enableInternet: boolean;
    readonly env: Record<string, string>;
    readonly labels: Record<string, string>;
  }): void;
  fetch(request: Request): Promise<Response>;
}

export interface ActionsBackend {
  readonly ready: Effect.Effect<void, ActionsBackendError>;
  readonly fetch: (request: Request) => Effect.Effect<Response, ActionsBackendError>;
}

export const ActionsBackend = Context.Service<ActionsBackend>("gitfoundry/ActionsBackend");

export function actionsBackendStartup(config: ActionsBackendConfig) {
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(config.generation) ||
      !config.runnerToken || !config.storageToken ||
      !config.rsaPrivateKey.includes("PRIVATE KEY") ||
      Boolean(config.storageAccessClientId) !== Boolean(config.storageAccessClientSecret)) {
    throw new ActionsBackendError({ operation: "configuration" });
  }
  return {
    enableInternet: true,
    env: {
      PORT: "80",
      GFY_ACTIONS_PUBLIC_ORIGIN: origin.origin,
      GFY_ACTIONS_GENERATION: config.generation,
      RUNNER_TOKEN: config.runnerToken,
      GFY_ACTIONS_STORAGE_TOKEN: config.storageToken,
      GFY_ACTIONS_STORAGE_URL: new URL("/__internal/actions-github/storage/", origin).toString(),
      GFY_ACTIONS_RSA_PRIVATE_KEY: config.rsaPrivateKey,
      ...(config.storageAccessClientId ? {
        GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_ID: config.storageAccessClientId,
        GFY_ACTIONS_STORAGE_CF_ACCESS_CLIENT_SECRET: config.storageAccessClientSecret!
      } : {})
    },
    labels: { "gfy.profile": "github-actions-server", "gfy.generation": config.generation }
  };
}

function healthBody(response: Response): Effect.Effect<unknown, ActionsBackendError> {
  return Effect.gen(function* () {
    if (!response.body) return yield* Effect.fail(new ActionsBackendError({ operation: "readiness" }));
    const reader = response.body.getReader();
    const text = yield* Effect.gen(function* () {
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      for (;;) {
        const chunk = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: () => new ActionsBackendError({ operation: "readiness" })
        });
        if (chunk.done) return text + decoder.decode();
        bytes += chunk.value.byteLength;
        if (bytes > 8192) {
          yield* Effect.tryPromise({
            try: () => reader.cancel(),
            catch: () => new ActionsBackendError({ operation: "readiness" })
          });
          return yield* Effect.fail(new ActionsBackendError({ operation: "readiness" }));
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    }).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock())));
    return yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new ActionsBackendError({ operation: "readiness" })
    });
  });
}

export function makeActionsBackend(
  container: ActionsContainerPort,
  config: ActionsBackendConfig,
  options: { readonly attempts?: number; readonly pause?: Effect.Effect<void> } = {}
): ActionsBackend {
  const attempts = options.attempts ?? 120;
  const pause = options.pause ?? Effect.sleep("250 millis");
  const probe = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: signal => container.fetch(new Request("http://container/__gitfoundry/health", { signal })),
      catch: () => new ActionsBackendError({ operation: "readiness" })
    });
    if (response.status !== 200) {
      if (response.body) yield* Effect.tryPromise({
        try: () => response.body!.cancel(),
        catch: () => new ActionsBackendError({ operation: "readiness" })
      });
      return false;
    }
    const health = yield* healthBody(response);
    return !!health && typeof health === "object" &&
      (health as { ready?: unknown }).ready === true &&
      (health as { generation?: unknown }).generation === config.generation;
  }).pipe(Effect.match({ onFailure: () => false, onSuccess: ready => ready }));

  const ready = Effect.gen(function* () {
    const startup = yield* Effect.try({
      try: () => actionsBackendStartup(config),
      catch: () => new ActionsBackendError({ operation: "configuration" })
    });
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 240) {
      return yield* Effect.fail(new ActionsBackendError({ operation: "configuration" }));
    }
    yield* Effect.try({
      try: () => { if (!container.running) container.start(startup); },
      catch: () => new ActionsBackendError({ operation: "start" })
    });
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (yield* probe) return;
      if (attempt + 1 < attempts) yield* pause;
    }
    return yield* Effect.fail(new ActionsBackendError({ operation: "readiness" }));
  });
  return {
    ready,
    fetch: request => Effect.gen(function* () {
      yield* ready;
      // Only readiness probes retry. A lost mutation acknowledgment stays uncertain.
      return yield* Effect.tryPromise({
        try: signal => container.fetch(new Request(request, { signal })),
        catch: () => new ActionsBackendError({ operation: "proxy" })
      });
    })
  };
}

export const actionsBackendLayer = (container: ActionsContainerPort, config: ActionsBackendConfig) =>
  Layer.succeed(ActionsBackend, makeActionsBackend(container, config));
