import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(readonly ctx: unknown, readonly env: unknown) {} } }));

import { makePrEligibilityCoordinator, PrEligibilityDO } from "./coordinator.js";
import { PrEligibilityError, type ForgePrEligibility, type PrEligibilityInput } from "./service.js";

const input = { tenantId: "tenant-a", pullRequestId: "pr-a", actorId: "principal-a", method: "merge" as const };
const request = (body: unknown) => new Request("https://eligibility.internal/get", { method: "POST", body: JSON.stringify(body) });
const snapshot = (): ForgePrEligibility => ({ tenant_id: "tenant-a", pull_request_id: "pr-a", pr_version: 1, id: "elig-a", status: "blocked", head_sha: "a".repeat(40), base_sha: "b".repeat(40), candidate_sha: "c".repeat(40), method: "merge", diff_digest: "d".repeat(64), policy_digest: "e".repeat(64), policy_epoch: 1, expires_at: "2026-10-09T00:10:00Z", blockers: [{ code: "provider_unqualified", resource_id: null, detail: "Publication evidence unavailable.", required_action: "pr.eligibility" }], reviews: [], checks: [] });

describe("awaited PR eligibility coordinator", () => {
  it("shares only identical live preparation and re-enters durable service after completion", async () => {
    let release: ((value: ForgePrEligibility) => void) | undefined;
    const pending = new Promise<ForgePrEligibility>((resolve) => { release = resolve; });
    const get = vi.fn(() => pending);
    const coordinator = makePrEligibilityCoordinator({ get });
    const first = coordinator.fetch(request(input));
    const duplicate = coordinator.fetch(request({ ...input, method: undefined }));
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    release!(snapshot());
    expect((await first).status).toBe(200);
    expect((await duplicate).status).toBe(200);
    await coordinator.fetch(request(input));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce different actors, methods or revision preconditions", async () => {
    const get = vi.fn(async (value: PrEligibilityInput) => ({ ...snapshot(), method: value.method ?? "merge" }));
    const coordinator = makePrEligibilityCoordinator({ get });
    await Promise.all([coordinator.fetch(request(input)), coordinator.fetch(request({ ...input, actorId: "principal-b" })), coordinator.fetch(request({ ...input, method: "squash" })), coordinator.fetch(request({ ...input, headSha: "a".repeat(40) }))]);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed private requests before service access", async () => {
    const get = vi.fn(async () => snapshot());
    const coordinator = makePrEligibilityCoordinator({ get });
    for (const value of [{ ...input, injected: true }, { ...input, actorId: "" }, { ...input, headSha: "branch" }, { ...input, method: "invented" }, { ...input, method: ["merge"] }, { ...input, method: null }]) expect((await coordinator.fetch(request(value))).status).toBe(400);
    const oversized = new Request("https://eligibility.internal/get", { method: "POST", body: " ".repeat(8193) });
    expect((await coordinator.fetch(oversized)).status).toBe(400);
    expect((await coordinator.fetch(new Request("https://eligibility.internal/get"))).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("returns only typed redacted failures and refuses malformed snapshots", async () => {
    const service = { get: vi.fn(async () => { throw new PrEligibilityError("pending", "secret-provider-token", "operation-a"); }) };
    const coordinator = makePrEligibilityCoordinator(service);
    const response = await coordinator.fetch(request(input));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ ok: false, operation_id: "operation-a" });
    expect(body).not.toContain("secret-provider-token");
    const invalid = makePrEligibilityCoordinator({ get: async () => ({ ...snapshot(), diff_digest: "pending" }) });
    expect((await invalid.fetch(request(input))).status).toBe(503);
    expect((await new PrEligibilityDO({} as DurableObjectState, {} as never).fetch(request(input))).status).toBe(503);
  });
});
