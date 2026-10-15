import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { actionsBackendStartup, makeActionsBackend, type ActionsBackendConfig, type ActionsContainerPort } from "./backend.js";

const config: ActionsBackendConfig = {
  publicOrigin: "https://gitfoundry.dev",
  generation: "actions-v1",
  runnerToken: "private-runner-token",
  storageToken: "private-storage-token",
  rsaPrivateKey: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----"
};

function fixture(probe: () => Response | Promise<Response>, mutation: (request: Request) => Response | Promise<Response> = () => new Response("ok")) {
  const calls: Request[] = [];
  const starts: Parameters<ActionsContainerPort["start"]>[0][] = [];
  const container: ActionsContainerPort = {
    running: false,
    start: options => { starts.push(options); Object.assign(container, { running: true }); },
    fetch: async request => {
      calls.push(request);
      return request.url.endsWith("/__gitfoundry/health") ? probe() : mutation(request);
    }
  };
  return { calls, starts, container, backend: makeActionsBackend(container, config, { attempts: 3, pause: Effect.void }) };
}

describe("Effect managed Actions backend", () => {
  it("waits for the configured generation before sending a mutation and starts only once", async () => {
    let probes = 0;
    const f = fixture(() => Response.json({ ready: true, generation: ++probes < 2 ? "old-generation" : "actions-v1" }));
    await Effect.runPromise(f.backend.fetch(new Request("https://gitfoundry.dev/_apis/agents", { method: "POST", body: "one" })));
    await Effect.runPromise(f.backend.fetch(new Request("https://gitfoundry.dev/_apis/agents", { method: "POST", body: "two" })));
    expect(f.starts).toHaveLength(1);
    expect(f.calls.map(request => request.method)).toEqual(["GET", "GET", "POST", "GET", "POST"]);
    expect(f.starts[0]!.env.GFY_ACTIONS_STORAGE_URL).toBe("https://gitfoundry.dev/__internal/actions-github/storage/");
    expect(JSON.stringify(f.starts[0]!.labels)).not.toContain("private");
  });

  it("rejects stale generations and bounded health overflow without forwarding the request", async () => {
    for (const probe of [
      () => Response.json({ ready: true, generation: "old-generation" }),
      () => new Response("x".repeat(8193))
    ]) {
      const f = fixture(probe);
      await expect(Effect.runPromise(f.backend.fetch(new Request("https://gitfoundry.dev/_apis/agents", { method: "POST" })))).rejects.toThrow();
      expect(f.calls).toHaveLength(3);
      expect(f.calls.every(request => request.method === "GET")).toBe(true);
    }
  });

  it("never retries a mutation with a lost acknowledgment", async () => {
    let sent = 0;
    const f = fixture(() => Response.json({ ready: true, generation: "actions-v1" }), () => {
      sent++;
      throw new Error("connection lost after backend accepted mutation");
    });
    await expect(Effect.runPromise(f.backend.fetch(new Request("https://gitfoundry.dev/_apis/agents", { method: "POST" })))).rejects.toThrow();
    expect(sent).toBe(1);
  });

  it("passes interruption to the native protocol fetch", async () => {
    let aborted = false;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture(() => Response.json({ ready: true, generation: "actions-v1" }), request => new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
      entered();
    }));
    const abort = new AbortController();
    const running = Effect.runPromise(f.backend.fetch(new Request("https://gitfoundry.dev/_apis/messages")), { signal: abort.signal });
    await started;
    abort.abort();
    await expect(running).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it("rejects incomplete Access credentials and unsafe public origins before starting", async () => {
    for (const changed of [
      { publicOrigin: "http://gitfoundry.dev" },
      { publicOrigin: "https://user:password@gitfoundry.dev" },
      { publicOrigin: "https://gitfoundry.dev/unexpected" },
      { storageAccessClientId: "client-without-secret" },
      { rsaPrivateKey: "" }
    ]) {
      let starts = 0;
      const backend = makeActionsBackend({
        running: false,
        start: () => { starts++; },
        fetch: async () => new Response()
      }, { ...config, ...changed });
      await expect(Effect.runPromise(backend.ready)).rejects.toThrow();
      expect(starts).toBe(0);
    }
  });
});
