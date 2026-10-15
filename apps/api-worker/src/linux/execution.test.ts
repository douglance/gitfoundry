import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class<Env = unknown> { readonly ctx: DurableObjectState; readonly env: Env; constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env } } }));

const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const env = { GFY_TRUSTED_GIT_HELPER_IMAGE: `registry.example/gitfoundry-helper@sha256:${digest}`, GFY_UNTRUSTED_CI_IMAGE: `registry.example/gitfoundry-ci@sha256:${"b".repeat(64)}` };

describe("Linux execution admission", () => {
  it("wraps trusted helper commands with an exact supervisor argv and denied internet startup", async () => {
    const { admitLinuxExecution } = await import("./execution.js");
    const admission = admitLinuxExecution("trusted_git_helper", base({ argv: ["/usr/bin/git", "status", "--porcelain"], env: { GIT_AUTHOR_NAME: "GitFoundry", GFY_TRACE_ID: "trace-a" } }), env);

    expect(admission.supervisorArgv).toEqual(["/usr/local/bin/gitfoundry-supervise", "--command-id", "cmd-a", "--deadline-ms", "30000", "--kill-after-ms", "5000", "--cwd", "/work/tenant-a/repo-a/op-a/subdir", "--", "/usr/bin/git", "status", "--porcelain"]);
    expect(admission.startup).toMatchObject({ enableInternet: false, env: {}, labels: { "gfy.command_id": "86f558981296b3ebf9b7646ca3ad62554e9e948ae62e65c6d0946b6277cb62a9", "gfy.fence_token": "0e896f7eedf652cd0b7269c35e37fab388ac8e5bb6defc46badbc3e7ad5c7ad7" } });
    expect(admission.env).toMatchObject({ HOME: "/tmp/gitfoundry-home", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", TMPDIR: "/tmp", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
    expect(admission.cwd).toBe("/work/tenant-a/repo-a/op-a/subdir");
    expect(admission.containerIdentity).toBe("19:gitfoundry-linux-v218:trusted_git_helper8:tenant-a6:repo-a4:op-a5:cmd-a7:fence-a");
  });

  it.each([
    ["trusted_git_helper", ["/usr/bin/git", "--version"], "registry.example/gitfoundry-helper@sha256:" + "a".repeat(64)],
    ["untrusted_ci_job", ["/usr/local/bin/gitfoundry-ci-step", "step-a"], "registry.example/gitfoundry-ci@sha256:" + "b".repeat(64)],
  ] as const)("starts %s with its distinct admitted digest", async (profile, argv, expectedImage) => {
    const { executeLinuxCommand } = await import("./execution.js");
    const container = new FakeContainer({ stdout: "", stderr: "", exitCode: 0 });
    const { admitLinuxExecution } = await import("./execution.js");
    expect(admitLinuxExecution(profile, base({ argv: [...argv] }), env).startup.image).toBe(expectedImage);
    if (profile === "untrusted_ci_job") container.images.gfy = "registry.example/gitfoundry-ci@sha256:" + "b".repeat(64);
    const response = await executeLinuxCommand(profile, fakeCtx(new MemoryStorage(), container), env, base({ argv: [...argv] }));
    expect(response.status).toBe(200);
    expect(container.lastStart?.image).toBe(expectedImage);
    expect(container.lastStart?.enableInternet).toBe(false);
    expect(await response.json()).toMatchObject({ receipt: { status: "succeeded", image: expectedImage } });
  });

  it("rejects an absent running image before work or credential transport", async () => {
    const { executeTrustedGitHelperOperation } = await import("./execution.js");
    const container = new FakeContainer({ stdout: "", stderr: "", exitCode: 0 });
    container.inspect = async () => container.running ? { image: "", labels: container.labels } : null;
    const response = await executeTrustedGitHelperOperation(fakeCtx(new MemoryStorage(), container), env, trustedGitBase());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, receipt: { status: "failed", cleanupRequired: false, stderr: "native container image does not match admitted digest" } });
    expect(container.lastStart?.image).toBe("registry.example/gitfoundry-helper@sha256:" + "a".repeat(64));
    expect(container.execHistory.map(call => call.argv)).toEqual([["/usr/bin/true"]]);
    expect(container.capturedStdin).toBe("");
    expect(container.destroyCalls).toHaveLength(1);
  });

  it.each([
    ["missing", {}],
    ["mismatched", { gfy: "registry.example/unapproved@sha256:" + "c".repeat(64) }],
  ] as const)("rejects a %s native image map before startup or credential transport", async (_kind, images) => {
    const { executeTrustedGitHelperOperation } = await import("./execution.js");
    const container = new FakeContainer({ stdout: "", stderr: "", exitCode: 0 });
    container.images = { ...images };
    const response = await executeTrustedGitHelperOperation(fakeCtx(new MemoryStorage(), container), env, trustedGitBase());
    expect(response.status).toBe(500);
    expect(container.lastStart).toBeUndefined();
    expect(container.execHistory).toEqual([]);
    expect(container.httpsIntercepts).toEqual([]);
    expect(container.capturedStdin).toBe("");
    expect(container.destroyCalls).toHaveLength(1);
    expect(await response.json()).toMatchObject({ ok: false, receipt: { status: "failed", cleanupRequired: false, stderr: "native container image map does not match admitted digest" } });
  });

  it("denies credential-shaped environment names and safe path overrides", async () => {
    const { admitLinuxExecution, LinuxExecutionAdmissionError } = await import("./execution.js");
    expect(() => admitLinuxExecution("untrusted_ci_job", base({ argv: ["/usr/local/bin/gitfoundry-ci-step", "step-a"], env: { GITHUB_TOKEN: "secret" } }), env)).toThrow(LinuxExecutionAdmissionError);
    expect(() => admitLinuxExecution("trusted_git_helper", base({ argv: ["/usr/bin/git", "status"], env: { PATH: "/work/tenant-a/repo-a/op-a/bin" } }), env)).toThrow(LinuxExecutionAdmissionError);
    expect(() => admitLinuxExecution("trusted_git_helper", base({ argv: ["/usr/bin/git", "status"], env: { HOME: "/work/tenant-a/repo-a/op-a/home" } }), env)).toThrow(LinuxExecutionAdmissionError);
  });

  it("rejects shell strings, cwd escapes, incomplete digests, mutable images, and path-spoofed commands before Container.exec", async () => {
    const { admitLinuxExecution } = await import("./execution.js");
    expect(() => admitLinuxExecution("trusted_git_helper", base({ argv: ["sh", "-c", "git status"] }), env)).toThrow(/not allowed/);
    expect(() => admitLinuxExecution("trusted_git_helper", base({ cwd: "/work/tenant-a/repo-a/op-b", argv: ["/usr/bin/git", "status"] }), env)).toThrow(/cwd/);
    expect(() => admitLinuxExecution("trusted_git_helper", base({ argv: ["/usr/bin/git", "status"] }), { ...env, GFY_TRUSTED_GIT_HELPER_IMAGE: "registry.example/gitfoundry-helper:latest" })).toThrow(/sha256/);
    expect(() => admitLinuxExecution("trusted_git_helper", base({ argv: ["/usr/bin/git", "status"] }), { ...env, GFY_TRUSTED_GIT_HELPER_IMAGE: `registry.example/gitfoundry-helper@sha256:${digest.slice(0, 63)}` })).toThrow(/sha256/);
    expect(() => admitLinuxExecution("trusted_git_helper", base({ argv: ["/work/tenant-a/repo-a/op-a/git", "status"] }), env)).toThrow(/not allowed/);
  });

  it("rejects unimplemented I/O reference ports explicitly", async () => {
    const { admitLinuxExecution } = await import("./execution.js");
    for (const key of ["stdinRef", "stdoutRef", "stderrRef", "journalRef"] as const) {
      expect(() => admitLinuxExecution("trusted_git_helper", base({ [key]: "artifact-a", argv: ["/usr/bin/git", "status"] }), env)).toThrow(/not supported/);
    }
  });

  it("admits CI only through the CI command profile and returns explicit unsupported profiles", async () => {
    const { admitLinuxExecution, LinuxExecutionAdmissionError } = await import("./execution.js");
    expect(admitLinuxExecution("untrusted_ci_job", base({ argv: ["/usr/local/bin/gitfoundry-ci-step", "step-a"] }), env).profile).toBe("untrusted_ci_job");
    expect(() => admitLinuxExecution("trusted_git_helper", base({ argv: ["/usr/local/bin/gitfoundry-ci-step", "step-a"] }), env)).toThrow(LinuxExecutionAdmissionError);
  });

  it("maps private trusted Git operations to fixed helper argv and rejects credential identity drift", async () => {
    const { executeTrustedGitHelperOperation } = await import("./execution.js");
    const storage = new MemoryStorage();
    const container = new FakeContainer({ stdout: "ref\n", stderr: "", exitCode: 0 });
    const secret = "private-helper-secret";
    const ctx = fakeCtx(storage, container);

    const response = await executeTrustedGitHelperOperation(ctx, env, trustedGitBase({ credential: credential({ password: secret }) }));

    expect(response.status).toBe(200);
    expect(container.execCalls).toBe(2);
    expect(container.execHistory[0]).toMatchObject({ argv: ["/usr/local/bin/gitfoundry-supervise", "--command-id", "private-cwd", "--deadline-ms", "30000", "--kill-after-ms", "5000", "--cwd", "/work/tenant-a/repo-a/op-a/subdir", "--", "/usr/local/bin/gitfoundry-git-helper", "version"], options: { cwd: "/work" } });
    expect(container.execHistory[1]).toMatchObject({ argv: ["/usr/local/bin/gitfoundry-git-helper", "ls-remote", "https://gitfoundry-artifacts.internal/git/tenant-a/repo-a.git", "refs/heads/main"], options: { cwd: "/work/tenant-a/repo-a/op-a/subdir" } });
    expect(JSON.stringify(container.execHistory)).not.toContain(secret);
    expect(container.httpsIntercepts).toEqual([{ host: "gitfoundry-artifacts.internal", fetcher: { props: artifactsEgress() } }]);
    expect(container.capturedStdin).toContain("password_b64=");
    expect(container.capturedStdin).toContain("proof_b64=");
    expect(container.capturedStdin).not.toContain(secret);
    expect(JSON.stringify([...storage.map.values()])).not.toContain(secret);
    expect(JSON.stringify([...storage.map.values()])).not.toContain(artifactsEgress().opaqueProof);

    const drift = await executeTrustedGitHelperOperation(ctx, env, trustedGitBase({ commandId: "cmd-drift", fenceToken: "fence-drift", credential: credential({ repositoryId: "repo-b", password: secret }) }));
    expect(drift.status).toBe(400);
    expect(await drift.json()).toMatchObject({ ok: false, error: "credential_request_denied" });
  });

  it("tells the forge helper to trust the certificate the platform issues for intercepted Artifacts traffic", async () => {
    const { executeForgeGitOperation } = await import("./execution.js");
    const container = new FakeContainer({ stdout: JSON.stringify({ ok: true, result: null }) + "\n", stderr: "", exitCode: 0 });
    const { operation: _ignored, ...base } = trustedGitBase();
    const response = await executeForgeGitOperation(fakeCtx(new MemoryStorage(), container), env, { ...base, operation: { kind: "forge_rpc", remoteUrl: "https://gitfoundry-artifacts.internal/git/tenant-a/repo-a.git", method: "readRef", args: ["refs/heads/main"] } });
    expect(response.status, await response.clone().text()).toBe(200);
    const rpc = container.execHistory.find((call) => call.argv.includes("/usr/local/bin/gitfoundry-forge-rpc"));
    expect((rpc?.options.env as Record<string, string> | undefined)?.GFY_FORGE_RPC_CA_FILE).toBe("/etc/cloudflare/certs/cloudflare-containers-ca.crt");
  });

  it("names an unexpected failure while reading a forge request by its kind", async () => {
    const { executeForgeGitOperation } = await import("./execution.js");
    const response = await executeForgeGitOperation(fakeCtx(new MemoryStorage(), new FakeContainer({ stdout: "", stderr: "", exitCode: 0 })), env, { ...trustedGitBase(), operation: { kind: "forge_rpc", remoteUrl: "not a url", method: "readRef", args: [] } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "invalid_request", detail: expect.stringMatching(/^[A-Za-z].+/u) });
  });

  it("frees the helper for the next command once a destroyed container finishes stopping", async () => {
    const { executeForgeGitOperation } = await import("./execution.js");
    const storage = new MemoryStorage();
    const container = new FakeContainer({ stdout: JSON.stringify({ ok: true, result: null }) + "\n", stderr: "", exitCode: 0 });
    // Cloudflare reports a destroyed container for a moment longer while it stops.
    const destroy = container.destroy.bind(container);
    let stopping = 0;
    container.destroy = async (error?: unknown) => { await destroy(error); stopping = 2; };
    const inspect = container.inspect.bind(container);
    container.inspect = async () => stopping-- > 0 ? { image: "stopping", labels: {} } : inspect();
    const ctx = fakeCtx(storage, container);
    const { operation: _ignored, ...base } = trustedGitBase();
    const frame = (id: string) => ({ ...base, commandId: id, fenceToken: "fence-" + id, operation: { kind: "forge_rpc", remoteUrl: "https://gitfoundry-artifacts.internal/git/tenant-a/repo-a.git", method: "readRef", args: ["refs/heads/main"] } });
    const first = await executeForgeGitOperation(ctx, env, frame("cmd-first"));
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toMatchObject({ receipt: { cleanupRequired: false } });
    const second = await executeForgeGitOperation(ctx, env, frame("cmd-second"));
    expect(second.status, await second.clone().text()).toBe(200);
  });

  it("rejects an unexpected running image before executing work or transporting a Git credential", async () => {
    const { executeTrustedGitHelperOperation } = await import("./execution.js");
    const container = new FakeContainer({ stdout: "refs/heads/main\n", stderr: "", exitCode: 0 });
    container.inspect = async () => container.running ? { image: "registry.example/unapproved@sha256:" + "b".repeat(64), labels: container.labels } : null;
    const response = await executeTrustedGitHelperOperation(fakeCtx(new MemoryStorage(), container), env, trustedGitBase());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, receipt: { status: "failed", cleanupRequired: false, stderr: "native container image does not match admitted digest" } });
    expect(container.execCalls).toBe(0);
    expect(container.capturedStdin).toBe("");
    expect(container.destroyCalls).toHaveLength(1);
  });

  it("requires durable bindings before a source-pack container or credential transport", async () => {
    const { executeTrustedGitHelperOperation } = await import("./execution.js");
    const container = new FakeContainer({ stdout: "", stderr: "", exitCode: 0 });
    const response = await executeTrustedGitHelperOperation(fakeCtx(new MemoryStorage(), container), env,
      trustedGitBase({ operation: { kind: "produce_source_pack", remoteUrl: "https://gitfoundry-artifacts.internal/git/tenant-a/repo-a.git", ref: "refs/heads/main", expectedOid: "1".repeat(40), role: "source_target_pack" } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "gfy_source_artifact_store_unavailable" });
    expect(container.execCalls).toBe(0); expect(container.capturedStdin).toBe("");
  });

  it("denies source-pack write egress and unsupported roles before execution", async () => {
    const { executeTrustedGitHelperOperation } = await import("./execution.js");
    for (const mutation of [{ artifactsEgress: { ...artifactsEgress(), allowWrite: true } }, { operation: { kind: "produce_source_pack", remoteUrl: "https://gitfoundry-artifacts.internal/git/tenant-a/repo-a.git", ref: "refs/heads/main", expectedOid: "1".repeat(40), role: "candidate_pack" } }]) {
      const container = new FakeContainer({ stdout: "", stderr: "", exitCode: 0 });
      const response = await executeTrustedGitHelperOperation(fakeCtx(new MemoryStorage(), container), env,
        trustedGitBase({ operation: { kind: "produce_source_pack", remoteUrl: "https://gitfoundry-artifacts.internal/git/tenant-a/repo-a.git", ref: "refs/heads/main", expectedOid: "1".repeat(40), role: "source_head_pack" }, ...mutation }));
      expect(response.status).toBe(400); expect(container.execCalls).toBe(0);
    }
  });

  it("bounds output draining while continuing to drain the stream", async () => {
    const { collectStream } = await import("./execution.js");
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled === 1) controller.enqueue(new TextEncoder().encode("abcdef"));
        else if (pulled === 2) controller.enqueue(new TextEncoder().encode("ghijkl"));
        else controller.close();
      },
      cancel() { throw new Error("collectStream must not cancel after the byte bound") }
    });

    await expect(collectStream(stream, 8)).resolves.toEqual({ text: "abcdefgh", bytes: 8, truncated: true });
    expect(pulled).toBe(3);
  });

  it("keeps stdout bounded on a flood while discarding the rest", async () => {
    const { collectStream } = await import("./execution.js");
    const chunks = Array.from({ length: 64 }, () => new TextEncoder().encode("0123456789abcdef"));
    let index = 0;
    const stream = new ReadableStream({ pull(controller) { const chunk = chunks[index++]; if (chunk) controller.enqueue(chunk); else controller.close(); } });

    const result = await collectStream(stream, 31);

    expect(result).toEqual({ text: "0123456789abcdef0123456789abcde", bytes: 31, truncated: true });
    expect(index).toBe(chunks.length + 1);
  });
});

describe("Linux execution state fencing", () => {
  it("persists terminal receipts, destroys successful dedicated containers, clears active state and replays duplicate completed attempts", async () => {
    const { executeLinuxCommand } = await import("./execution.js");
    const storage = new MemoryStorage();
    const container = new FakeContainer({ stdout: "ok\n", stderr: "", exitCode: 0, escapedDescendantAlive: true });
    const ctx = fakeCtx(storage, container);

    const response = await executeLinuxCommand("trusted_git_helper", ctx, env, base({ argv: ["/usr/bin/git", "status"] }));
    expect(response.status).toBe(200);
    const body = await response.json() as { receipt: { status: string; attemptGeneration: number; stdout: string; cleanupRequired: boolean } };
    expect(body.receipt).toMatchObject({ status: "succeeded", attemptGeneration: 1, stdout: "ok\n", cleanupRequired: false });
    expect(container.lastExec).toMatchObject({ argv: ["/usr/local/bin/gitfoundry-supervise", "--command-id", "cmd-a", "--deadline-ms", "30000", "--kill-after-ms", "5000", "--cwd", "/work/tenant-a/repo-a/op-a/subdir", "--", "/usr/bin/git", "status"], options: { cwd: "/work" } });
    expect(container.destroyCalls).toHaveLength(1);
    expect(container.escapedDescendantAlive).toBe(false);
    expect(await storage.get("linux.activeAttempt")).toBeUndefined();
    expect(storage.alarmAt).toBeUndefined();
    expect([...storage.map.keys()].some((key) => key.startsWith("linux.receipt."))).toBe(true);

    const replay = await executeLinuxCommand("trusted_git_helper", ctx, env, base({ argv: ["/usr/bin/git", "status"] }));
    expect(await replay.json()).toMatchObject({ ok: true, replayed: true, receipt: { status: "succeeded", attemptGeneration: 1, cleanupRequired: false } });
    expect(container.execCalls).toBe(1);
  });

  it("rejects stale cancellation without destroying the current attempt, then cancels only the matching tuple", async () => {
    const { executeLinuxCommand, cancelLinuxCommand } = await import("./execution.js");
    const storage = new MemoryStorage();
    const container = new FakeContainer({ stdout: "", stderr: "", exitCode: "deferred" });
    const ctx = fakeCtx(storage, container);
    const run = executeLinuxCommand("trusted_git_helper", ctx, env, base({ commandId: "cmd-current", fenceToken: "fence-current", argv: ["/usr/bin/git", "status"] }));
    await eventually(() => expect(container.execCalls).toBe(1));

    const stale = await cancelLinuxCommand(ctx, { commandId: "cmd-old", tenantId: "tenant-a", repositoryId: "repo-a", operationId: "op-a", fenceToken: "fence-current" });
    expect(stale.status).toBe(409);
    expect(container.destroyCalls).toHaveLength(0);
    expect(await storage.get("linux.activeAttempt")).toMatchObject({ commandId: "cmd-current", fenceToken: "fence-current" });

    const canceled = await cancelLinuxCommand(ctx, { commandId: "cmd-current", tenantId: "tenant-a", repositoryId: "repo-a", operationId: "op-a", fenceToken: "fence-current" });
    expect(canceled.status).toBe(200);
    expect(container.destroyCalls).toHaveLength(1);
    expect(await storage.get("linux.activeAttempt")).toBeUndefined();
    const runBody = await (await run).json() as { receipt: { status: string; cleanupRequired: boolean } };
    expect(runBody.receipt).toMatchObject({ status: "canceled", cleanupRequired: false });
  });

  it("persists timeout before destroy so an in-flight exec cannot overwrite timeout as failed", async () => {
    const { executeLinuxCommand, linuxExecutionAlarm } = await import("./execution.js");
    const storage = new MemoryStorage();
    const container = new FakeContainer({ stdout: "", stderr: "", exitCode: "deferred" });
    const ctx = fakeCtx(storage, container);
    const run = executeLinuxCommand("trusted_git_helper", ctx, env, base({ commandId: "cmd-timeout", fenceToken: "fence-timeout", deadlineMs: 1, argv: ["/usr/bin/git", "status"] }));
    await eventually(() => expect(container.execCalls).toBe(1));
    const active = await storage.get<Record<string, unknown>>("linux.activeAttempt");
    await storage.put("linux.activeAttempt", { ...active, alarmAtMs: Date.now() - 1 });

    await linuxExecutionAlarm(ctx);

    const body = await (await run).json() as { receipt: { status: string; cleanupRequired: boolean } };
    expect(body.receipt).toMatchObject({ status: "timed_out", cleanupRequired: false });
    expect(container.destroyCalls[0]).toContain("deadline alarm cmd-timeout");
    expect(await storage.get("linux.activeAttempt")).toBeUndefined();
  });

  it("keeps active state and replays cleanup-required receipts when successful command cleanup cannot be verified", async () => {
    const { executeLinuxCommand } = await import("./execution.js");
    const storage = new MemoryStorage();
    const container = new FakeContainer({ stdout: "ok", stderr: "", exitCode: 0, destroyError: new Error("provider did not confirm VM death") });
    const ctx = fakeCtx(storage, container);

    const response = await executeLinuxCommand("trusted_git_helper", ctx, env, base({ argv: ["/usr/bin/git", "status"] }));
    expect(response.status).toBe(409);
    const body = await response.json() as { receipt: { status: string; cleanupRequired: boolean; cleanupError: string } };
    expect(body.receipt).toMatchObject({ status: "succeeded", cleanupRequired: true, cleanupError: "provider did not confirm VM death" });
    expect(await storage.get("linux.activeAttempt")).toMatchObject({ commandId: "cmd-a" });

    const replay = await executeLinuxCommand("trusted_git_helper", ctx, env, base({ argv: ["/usr/bin/git", "status"] }));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ ok: false, replayed: true, receipt: { status: "succeeded", cleanupRequired: true } });

    const blocked = await executeLinuxCommand("trusted_git_helper", ctx, env, base({ commandId: "cmd-b", fenceToken: "fence-b", argv: ["/usr/bin/git", "status"] }));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ ok: false, error: "gfy_linux_active_attempt_exists" });
  });

  it("reschedules a stale alarm that fires before the persisted current attempt deadline", async () => {
    const { admitLinuxExecution, linuxExecutionAlarm } = await import("./execution.js");
    const storage = new MemoryStorage();
    const container = new FakeContainer({ stdout: "", stderr: "", exitCode: 0 });
    const ctx = fakeCtx(storage, container);
    const admission = admitLinuxExecution("trusted_git_helper", base({ commandId: "cmd-new", fenceToken: "fence-new", argv: ["/usr/bin/git", "status"] }), env);
    const alarmAtMs = Date.now() + 60_000;
    await storage.put("linux.activeAttempt", { ...admission.receiptBase, attemptGeneration: 7, deadlineAtMs: alarmAtMs - 6000, alarmAtMs, startedAt: new Date().toISOString(), admission });

    await linuxExecutionAlarm(ctx);

    expect(container.destroyCalls).toHaveLength(0);
    expect(storage.alarmAt).toBe(alarmAtMs);
    expect(await storage.get("linux.activeAttempt")).toMatchObject({ commandId: "cmd-new", attemptGeneration: 7 });
  });
});


describe("native container cleanup evidence", () => {
  it("does not treat an inspect response without a running field as destroyed", async () => {
    const { destroyContainer } = await import("./execution.js");
    const container = { destroy: async () => {}, inspect: async () => ({ image: env.GFY_TRUSTED_GIT_HELPER_IMAGE, labels: {} }) } as unknown as Container;
    vi.useFakeTimers();
    try {
      const outcome = expect(destroyContainer(container, "qualification cleanup")).rejects.toThrow("container still running after destroy");
      await vi.runAllTimersAsync();
      await outcome;
    } finally { vi.useRealTimers(); }
  });

  it("does not treat inspection failure as proof that cleanup completed", async () => {
    const { destroyContainer } = await import("./execution.js");
    const container = { destroy: async () => {}, inspect: async () => { throw new Error("inspection unavailable") } } as unknown as Container;
    await expect(destroyContainer(container, "qualification cleanup")).rejects.toThrow("inspection unavailable");
  });
});

function base(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { commandId: "cmd-a", tenantId: "tenant-a", repositoryId: "repo-a", operationId: "op-a", fenceToken: "fence-a", deadlineMs: 30000, cwd: "/work/tenant-a/repo-a/op-a/subdir", argv: ["/usr/bin/git", "status"], ...overrides };
}

function trustedGitBase(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { commandId: "cmd-a", tenantId: "tenant-a", repositoryId: "repo-a", operationId: "op-a", fenceToken: "fence-a", deadlineMs: 30000, cwd: "/work/tenant-a/repo-a/op-a/subdir", providerId: "cloudflare-artifacts", providerRepositoryId: "tenant-a/repo-a", operation: { kind: "ls_remote", remoteUrl: "https://gitfoundry-artifacts.internal/git/tenant-a/repo-a.git", ref: "refs/heads/main" }, credential: credential(), artifactsEgress: artifactsEgress(), ...overrides };
}

function credential(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { tenantId: "tenant-a", repositoryId: "repo-a", providerId: "cloudflare-artifacts", providerRepositoryId: "tenant-a/repo-a", username: "gitfoundry", password: "private-helper-secret", expiresAtMs: Date.now() + 60_000, ...overrides };
}

function artifactsEgress(): Record<string, unknown> {
  return { allowedProviderHostname: "gitfoundry-artifacts.internal", namespace: "tenant-a", repository: "repo-a", artifactsRemoteUrl: "https://gitfoundry-artifacts.internal/artifacts/tenant-a/repo-a.git", opaqueProof: "proof_0123456789abcdef", allowWrite: false };
}

function fakeCtx(storage: MemoryStorage, container: FakeContainer): DurableObjectState {
  return { storage, container, exports: { GitFoundryArtifactsEgress: (init: { readonly props: unknown }) => ({ props: init.props }) } } as unknown as DurableObjectState;
}

class MemoryStorage {
  readonly map = new Map<string, unknown>();
  alarmAt: number | undefined;

  async get<T>(key: string): Promise<T | undefined> { return this.map.get(key) as T | undefined }
  async put(key: string, value: unknown): Promise<void> { this.map.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.map.delete(key) }
  async setAlarm(timestamp: number): Promise<void> { this.alarmAt = timestamp }
  async deleteAlarm(): Promise<void> { this.alarmAt = undefined }
}

class FakeContainer {
  images: Record<string, string> = { gfy: "registry.example/gitfoundry-helper@sha256:" + "a".repeat(64) };
  running = false;
  labels: Record<string, string> = {};
  execCalls = 0;
  lastExec: { readonly argv: readonly string[]; readonly options: Record<string, unknown> } | undefined;
  readonly execHistory: { readonly argv: readonly string[]; readonly options: Record<string, unknown> }[] = [];
  readonly httpsIntercepts: { readonly host: string; readonly fetcher: unknown }[] = [];
  escapedDescendantAlive: boolean;
  readonly destroyCalls: string[] = [];
  private readonly stdout: string;
  private readonly stderr: string;
  private readonly exitCode: number | "deferred";
  private readonly destroyError: Error | undefined;
  private resolveExit: ((code: number) => void) | undefined;
  private readonly stdinChunks: string[] = [];

  constructor(options: { readonly stdout: string; readonly stderr: string; readonly exitCode: number | "deferred"; readonly destroyError?: Error; readonly escapedDescendantAlive?: boolean }) {
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
    this.destroyError = options.destroyError;
    this.escapedDescendantAlive = options.escapedDescendantAlive ?? false;
  }

  lastStart: ContainerStartupOptions | undefined;

  async inspect(): Promise<{ readonly image: string; readonly labels: Record<string, string> } | null> { return this.running ? { image: this.lastStart?.image ?? "", labels: this.labels } : null }

  start(options: ContainerStartupOptions): void {
    this.lastStart = options;
    for (const key of Object.keys(options.labels ?? {})) {
      if (new TextEncoder().encode(key).byteLength > 16) throw new Error("Label names cannot exceed 16 bytes");
    }
    for (const value of Object.values(options.labels ?? {})) {
      if (new TextEncoder().encode(value).byteLength > 64 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Label values cannot exceed 64 bytes or contain controls");
    }
    this.running = true;
    this.labels = options.labels ?? {};
  }

  async exec(argv: readonly string[], options: Record<string, unknown>): Promise<{ readonly stdin: WritableStream | null; readonly stdout: ReadableStream; readonly stderr: ReadableStream; readonly exitCode: Promise<number> }> {
    this.execCalls += 1;
    this.lastExec = { argv, options };
    this.execHistory.push(this.lastExec);
    const exitCode = this.exitCode === "deferred" ? new Promise<number>((resolve) => { this.resolveExit = resolve }) : Promise.resolve(this.exitCode);
    return { stdin: new WritableStream({ write: (chunk) => { this.stdinChunks.push(textFrom(chunk)) } }), stdout: streamFrom(this.stdout), stderr: streamFrom(this.stderr), exitCode };
  }

  get capturedStdin(): string { return this.stdinChunks.join("") }

  async destroy(error?: unknown): Promise<void> {
    this.destroyCalls.push(String(error));
    if (this.destroyError) throw this.destroyError;
    this.running = false;
    this.escapedDescendantAlive = false;
    this.resolveExit?.(137);
  }

  async interceptOutboundHttp(): Promise<void> {}
  async interceptOutboundHttps(host: string, fetcher: unknown): Promise<void> { this.httpsIntercepts.push({ host, fetcher }) }
}

function streamFrom(text: string): ReadableStream {
  return new ReadableStream({ start(controller) { if (text.length > 0) controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

function textFrom(value: unknown): string {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  return String(value);
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < 50; index += 1) {
    try { assertion(); return } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 0)) }
  }
  throw lastError;
}
