import { describe, expect, it, vi } from "vitest";
import { handleForkRequest, type ForkAction, type ForkApiPorts, type ForkActor } from "./http.js";
import { CloudForgeGitError } from "./cloud-git.js";

const sha = "1".repeat(40);
const next = "2".repeat(40);
const third = "3".repeat(40);
const actor: ForkActor = { id: "human-a", kind: "human", tenant_id: "tenant-a" };
const base = "/api/v2/tenants/tenant-a/repositories/repo-a/forge";
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

function ports(overrides: Partial<ForkApiPorts> = {}): ForkApiPorts {
  return { authenticate: vi.fn(async () => actor), invoke: vi.fn(async () => ({ version: { version_commit: sha } })), ...overrides };
}
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request("https://gitfoundry.test" + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function rawRequest(path: string, init: RequestInit = {}) { return new Request("https://gitfoundry.test" + path, init); }

describe("fork API boundary", () => {
  it("leaves unrelated routes to the existing API", async () => {
    const p = ports();
    expect(await handleForkRequest(request("/health"), p)).toBeUndefined();
    expect(p.authenticate).not.toHaveBeenCalled();
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", base + "/head", "head", {}, "forge.read"],
    ["GET", base + "/forks", "list", {}, "forge.read"],
    ["GET", base + "/versions/" + sha, "view", { version_commit: sha }, "forge.read"],
    ["GET", base + "/files?version=" + sha + "&tree=state&path=a.json", "read", { version: sha, tree: "state", path: "a.json" }, "forge.read"],
    ["GET", base + "/compare?base_version=" + sha + "&head_version=" + next, "compare", { base_version: sha, head_version: next }, "forge.compare"],
    ["POST", base + "/initialize", "initialize", { operation_id: "op-a", code_commit: sha }, "forge.initialize"],
    ["POST", base + "/fork", "fork", { operation_id: "op-a", parent_version: sha }, "forge.fork"],
    ["POST", base + "/commit", "commit", { operation_id: "op-a", parent_version: sha, changes: [{ tree: "code", path: "README.md", content_base64: "e30=", mode: "100755" }] }, "forge.commit"],
    ["POST", base + "/merge", "merge", { operation_id: "op-a", base_version: sha, left_version: next, right_version: third }, "forge.merge"],
    ["POST", base + "/publish", "publish", { operation_id: "op-a", expected_head: sha, new_version: next }, "forge.publish"],
    ["POST", base + "/recover", "recover", { operation_id: "op-a", publication_operation_id: "publish-a" }, "forge.recover"]
  ] as const)("routes %s %s", async (method, path, action, payload, capability) => {
    const p = ports();
    const init = method === "POST" ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : { method };
    const response = await handleForkRequest(rawRequest(path, init), p);
    expect(response?.status).toBe(200);
    expect(p.authenticate).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ tenant_id: "tenant-a", repository_id: "repo-a" }), capability);
    expect(p.invoke).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a", repository_id: "repo-a" }), action satisfies ForkAction, payload, actor);
  });

  it.each([["POST", base + "/head"], ["POST", base + "/forks"], ["POST", base + "/versions/" + sha], ["GET", base + "/fork"], ["GET", base + "/publish"]])("rejects wrong method %s %s", async (method, path) => {
    const p = ports();
    const response = await handleForkRequest(rawRequest(path, { method }), p);
    expect(response?.status).toBe(405);
    expect(p.authenticate).not.toHaveBeenCalled();
  });

  it("recovers by the durable publication ID without requiring a second operation ID", async () => {
    const p = ports();
    const response = await handleForkRequest(request(base + "/recover", { publication_operation_id: "publish-a" }), p);
    expect(response?.status).toBe(200);
    expect(p.authenticate).toHaveBeenCalledWith(expect.any(Request), expect.any(Object), "forge.recover");
    expect(p.invoke).toHaveBeenCalledWith(expect.any(Object), "recover", { publication_operation_id: "publish-a" }, actor);
  });

  it("rejects a recovery request without its target publication ID", async () => {
    const p = ports();
    const response = await handleForkRequest(request(base + "/recover", {}), p);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "publication_operation_id_required" });
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it("returns denial without touching Git", async () => {
    const p = ports({ authenticate: vi.fn(async () => Response.json({ error: "denied" }, { status: 403 })) });
    const response = await handleForkRequest(request(base + "/commit", { operation_id: "op-a", parent_version: sha, changes: [] }), p);
    expect(response?.status).toBe(403);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it("refuses identity outside the routed tenant", async () => {
    const p = ports({ authenticate: vi.fn(async () => ({ ...actor, tenant_id: "tenant-b" })) });
    const response = await handleForkRequest(request(base + "/head"), p);
    expect(response?.status).toBe(403);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it.each(["actor", "creator_id", "creator_kind", "tenant_id", "repository_id"])("rejects client-supplied %s", async (field) => {
    const p = ports();
    const response = await handleForkRequest(request(base + "/fork", { operation_id: "op-a", parent_version: sha, [field]: "forged" }), p);
    expect(response?.status).toBe(400);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it("accepts the operation ID from the idempotency header", async () => {
    const p = ports();
    expect((await handleForkRequest(request(base + "/fork", { parent_version: sha }, { "Idempotency-Key": "op-a" }), p))?.status).toBe(200);
    expect(p.invoke).toHaveBeenCalledWith(expect.any(Object), "fork", { operation_id: "op-a", parent_version: sha }, actor);
  });

  it("rejects body/header idempotency disagreement", async () => {
    const p = ports();
    const response = await handleForkRequest(request(base + "/fork", { operation_id: "op-a", parent_version: sha }, { "Idempotency-Key": "op-b" }), p);
    expect(response?.status).toBe(409);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it("accepts bootstrap files and state through initialize", async () => {
    const p = ports();
    const body = { initial_code: [{ path: "README.md", content_base64: b64("hello"), mode: "100755" }], initial_state: [{ path: "issues/one.json", content_base64: b64("{}"), mode: "100644" }] };
    const response = await handleForkRequest(request(base + "/initialize", body, { "Idempotency-Key": "init-bootstrap" }), p);
    expect(response?.status).toBe(200);
    expect(p.invoke).toHaveBeenCalledWith(expect.any(Object), "initialize", { ...body, operation_id: "init-bootstrap" }, actor);
  });

  it.each([
    ["both sources", { operation_id: "op-a", code_commit: sha, initial_code: [{ path: "README.md", content_base64: b64("hello") }] }],
    ["no source", { operation_id: "op-a" }],
    ["empty initial code", { operation_id: "op-a", initial_code: [] }],
    ["unsafe initial path", { operation_id: "op-a", initial_code: [{ path: "../README.md", content_base64: b64("hello") }] }],
    ["empty initial content", { operation_id: "op-a", initial_code: [{ path: "README.md", content_base64: "" }] }],
    ["duplicate initial path", { operation_id: "op-a", initial_code: [{ path: "README.md", content_base64: b64("hello") }, { path: "README.md", content_base64: b64("again") }] }],
    ["state shape", { operation_id: "op-a", initial_code: [{ path: "README.md", content_base64: b64("hello") }], initial_state: { path: "config/publication.json", content_base64: b64("{}") } }],
    ["unsafe state path", { operation_id: "op-a", initial_code: [{ path: "README.md", content_base64: b64("hello") }], initial_state: [{ path: "../config/publication.json", content_base64: b64("{}") }] }],
    ["bad state base64", { operation_id: "op-a", initial_code: [{ path: "README.md", content_base64: b64("hello") }], initial_state: [{ path: "config/publication.json", content_base64: "not base64" }] }],
    ["reserved state readme", { operation_id: "op-a", initial_code: [{ path: "README.md", content_base64: b64("hello") }], initial_state: [{ path: "README.md", content_base64: b64("bad") }] }]
  ])("rejects invalid initialize bootstrap %s", async (_label, body) => {
    const p = ports();
    const response = await handleForkRequest(request(base + "/initialize", body), p);
    expect(response?.status).toBe(400);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid initialize mode", base + "/initialize", { operation_id: "op-a", initial_code: [{ path: "README.md", content_base64: b64("hello"), mode: "100664" }] }],
    ["initialize delete plus mode", base + "/initialize", { operation_id: "op-a", initial_code: [{ path: "README.md", content_base64: null, mode: "100644" }] }],
    ["invalid commit mode", base + "/commit", { operation_id: "op-a", parent_version: sha, changes: [{ tree: "code", path: "README.md", content_base64: b64("hello"), mode: "100664" }] }],
    ["commit delete plus mode", base + "/commit", { operation_id: "op-a", parent_version: sha, changes: [{ tree: "code", path: "README.md", content_base64: null, mode: "100644" }] }]
  ])("rejects invalid mode payload %s", async (_label, path, body) => {
    const p = ports();
    const response = await handleForkRequest(request(path, body), p);
    expect(response?.status).toBe(400);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it.each(["main", "1".repeat(7), "A".repeat(40), "0".repeat(40)])("rejects nonimmutable SHA %s", async (parent) => {
    const p = ports();
    expect((await handleForkRequest(request(base + "/fork", { operation_id: "op-a", parent_version: parent }), p))?.status).toBe(400);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it.each(["../secret", "/etc/passwd", "a/../../b", ".git/config", "a/.git/config", "a//b"])("rejects unsafe path %s", async (path) => {
    const p = ports();
    const response = await handleForkRequest(request(base + "/commit", { operation_id: "op-a", parent_version: sha, changes: [{ tree: "state", path, content_base64: "e30=" }] }), p);
    expect(response?.status).toBe(400);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it("allows null delete content but rejects empty base64 and invalid trees", async () => {
    const p = ports();
    expect((await handleForkRequest(request(base + "/commit", { operation_id: "op-a", parent_version: sha, changes: [{ tree: "code", path: "README.md", content_base64: null }] }), p))?.status).toBe(200);
    expect((await handleForkRequest(request(base + "/commit", { operation_id: "op-b", parent_version: sha, changes: [{ tree: "code", path: "README.md", content_base64: "" }] }), p))?.status).toBe(400);
    expect((await handleForkRequest(request(base + "/commit", { operation_id: "op-c", parent_version: sha, changes: [{ tree: "other", path: "README.md", content_base64: "e30=" }] }), p))?.status).toBe(400);
  });

  it("rejects invalid read tree and duplicate query parameters before invoking", async () => {
    const p = ports();
    expect((await handleForkRequest(rawRequest(base + "/files?version=" + sha + "&tree=other&path=a.json"), p))?.status).toBe(400);
    expect((await handleForkRequest(rawRequest(base + "/files?version=" + sha + "&version=" + next + "&tree=state&path=a.json"), p))?.status).toBe(400);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it("routes exact tree listing reads with optional prefixes", async () => {
    const p = ports();
    const root = await handleForkRequest(rawRequest(base + "/files?version=" + sha + "&tree=code"), p);
    expect(root?.status).toBe(200);
    expect(p.invoke).toHaveBeenLastCalledWith(expect.any(Object), "read", { version: sha, tree: "code" }, actor);
    const prefixed = await handleForkRequest(rawRequest(base + "/files?version=" + sha + "&tree=state&prefix=issues%2F"), p);
    expect(prefixed?.status).toBe(200);
    expect(p.invoke).toHaveBeenLastCalledWith(expect.any(Object), "read", { version: sha, tree: "state", prefix: "issues/" }, actor);
  });

  it("rejects ambiguous or unsafe read selectors", async () => {
    const p = ports();
    expect((await handleForkRequest(rawRequest(base + "/files?version=" + sha + "&tree=code&path=README.md&prefix=docs%2F"), p))?.status).toBe(400);
    expect((await handleForkRequest(rawRequest(base + "/files?version=" + sha + "&tree=code&prefix=..%2F"), p))?.status).toBe(400);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed body without invoking the backend", async () => {
    const p = ports({ maxBodyBytes: 64 });
    expect((await handleForkRequest(request(base + "/fork", { operation_id: "op-a", parent_version: sha, extra: "x".repeat(100) }), p))?.status).toBe(413);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const p = ports();
    const req = new Request("https://gitfoundry.test" + base + "/fork", { method: "POST", body: "{" });
    expect((await handleForkRequest(req, p))?.status).toBe(400);
    expect(p.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["provider_unavailable", "provider_unavailable"],
    ["credential_unavailable", "credential_unavailable"],
    ["trusted_execution_failed", "trusted_execution_failed"],
    ["trusted_response_invalid", "trusted_response_invalid"],
    ["invalid_input", "invalid_input"],
    ["unavailable", "unavailable"],
    ["password=private-provider-token", "unknown"],
    [undefined, "unknown"],
  ])("logs a sanitized backend failure code %s", async (code, expectedCode) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = ports({ invoke: vi.fn(async () => { throw { code, message: "password=private-provider-token", credential: "private-provider-token" }; }) });
      const response = await handleForkRequest(request(base + "/head"), p);
      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({ error: "fork_backend_unavailable", code: expectedCode });
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("gitfoundry.forge.backend_unavailable", { action: "head", code: expectedCode });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-provider-token");
    } finally {
      log.mockRestore();
    }
  });

  it("logs which forge Git step failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = ports({ invoke: vi.fn(async () => { throw new CloudForgeGitError("provider_unavailable", "push unpack failed", undefined, { helper_detail: "unpack index-pack abnormal exit" }); }) });
      expect((await handleForkRequest(request(base + "/head"), p))?.status).toBe(503);
      expect(log).toHaveBeenCalledWith("gitfoundry.forge.backend_unavailable", { action: "head", code: "provider_unavailable", detail: { helper_detail: "unpack index-pack abnormal exit" }, step: "push unpack failed" });
    } finally {
      log.mockRestore();
    }
  });

  it("logs the named failed check of a backend failure without leaking its message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [reason, logged] of [["credential_expiry_invalid", { reason: "credential_expiry_invalid" }], ["password=private-provider-token", {}]] as const) {
        log.mockClear();
        const p = ports({ invoke: vi.fn(async () => { throw { code: "credential_unavailable", reason, message: "password=private-provider-token" }; }) });
        const response = await handleForkRequest(request(base + "/head"), p);
        expect(await response?.json()).toEqual({ error: "fork_backend_unavailable", code: "credential_unavailable" });
        expect(log).toHaveBeenCalledWith("gitfoundry.forge.backend_unavailable", { action: "head", code: "credential_unavailable", ...logged });
        expect(JSON.stringify(log.mock.calls)).not.toContain("private-provider-token");
      }
    } finally {
      log.mockRestore();
    }
  });

  it("logs the trusted helper's failure detail and drops anything else it carries", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = ports({ invoke: vi.fn(async () => { throw { code: "trusted_execution_failed", detail: { receipt_status: "failed", exit_code: 128, rpc_phase: "readRef", helper_detail: "remoteUrl is invalid", stderr: "private-provider-token", helper_error: "password=private-provider-token" } }; }) });
      const response = await handleForkRequest(request(base + "/head"), p);
      expect(response?.status).toBe(503);
      expect(log).toHaveBeenCalledWith("gitfoundry.forge.backend_unavailable", { action: "head", code: "trusted_execution_failed", detail: { receipt_status: "failed", exit_code: 128, rpc_phase: "readRef", helper_detail: "remoteUrl is invalid" } });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-provider-token");
    } finally {
      log.mockRestore();
    }
  });

  it("refuses a publish whose evidence fails the rules, naming what is missing, not a backend outage", async () => {
    class PublicationEvidenceVerificationError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "PublicationEvidenceVerificationError"; } }
    const p = ports({ invoke: vi.fn(async () => { throw new PublicationEvidenceVerificationError("evidence_missing", "expected 1 approval(s), found 0"); }) });
    const response = await handleForkRequest(request(base + "/publish", { operation_id: "publish-a", expected_head: sha, new_version: next }), p);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ error: "publication_refused", code: "evidence_missing", reason: "expected 1 approval(s), found 0" });
  });

  it("names an unexpected backend error by its class without leaking its message", async () => {
    class ForkForgeUnavailableError extends Error {}
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = ports({ invoke: vi.fn(async () => { throw new ForkForgeUnavailableError("password=private-provider-token"); }) });
      const response = await handleForkRequest(request(base + "/head"), p);
      expect(response?.status).toBe(503);
      const body = await response?.json();
      expect(body).toEqual({ error: "fork_backend_unavailable", code: "ForkForgeUnavailableError" });
      expect(JSON.stringify(body) + JSON.stringify(log.mock.calls)).not.toContain("private-provider-token");
    } finally {
      log.mockRestore();
    }
  });

  it("does not expose backend diagnostics or credentials", async () => {
    const p = ports({ invoke: vi.fn(async () => { throw new Error("password=private-provider-token"); }) });
    const response = await handleForkRequest(request(base + "/head"), p);
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain("private-provider-token");
  });

  it("maps typed backend outcomes", async () => {
    expect((await handleForkRequest(request(base + "/publish", { operation_id: "op-a", expected_head: sha, new_version: next }), ports({ invoke: vi.fn(async () => { throw { code: "stale_head", expected: sha, actual: next }; }) })))?.status).toBe(409);
    expect((await handleForkRequest(request(base + "/recover", { operation_id: "op-a", publication_operation_id: "publish-a" }), ports({ invoke: vi.fn(async () => ({ status: "pending", operation_id: "op-a" })) })))?.status).toBe(202);
  });
});
