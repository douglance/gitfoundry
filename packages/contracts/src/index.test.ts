import { describe, expect, it } from "vitest";

import {
  decodeNativeOperation,
  decodeRequestEnvelope,
  decodeSourceSchema,
  validateSourceCatalog,
  type SourceDomainDocument
} from "./index.js";

const readSources = async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "../../..");
  const readJson = async (relative: string) => JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
  const readText = async (relative: string) => fs.readFile(path.join(root, relative), "utf8");
  return { readJson, readText };
};

describe("Effect contract validation", () => {
  it("enforces sibling constraints around schema compositions and conditionals", () => {
    const domain = { $defs: {
      composed: { type: "object", additionalProperties: false, required: ["digest", "mode"], properties: { digest: { type: "string", pattern: "^[0-9a-f]{64}$" }, mode: { enum: ["ready", "blocked"] } }, allOf: [{ if: { properties: { mode: { const: "ready" } }, required: ["mode"] }, then: { properties: { digest: { minLength: 64 } } } }] },
      conditional: { type: "object", additionalProperties: false, required: ["kind", "count"], properties: { kind: { enum: ["a", "b"] }, count: { type: "integer", minimum: 1 } }, if: { properties: { kind: { const: "a" } }, required: ["kind"] }, then: { properties: { count: { maximum: 2 } } }, else: { properties: { count: { maximum: 5 } } } },
      referenced: { $ref: "#/$defs/digest", minLength: 64 }, digest: { type: "string" }
    } } as unknown as SourceDomainDocument;
    expect(() => decodeSourceSchema(domain, "composed", { digest: "d".repeat(64), mode: "blocked" })).not.toThrow();
    for (const value of [{ digest: "pending", mode: "blocked" }, { mode: "blocked" }, { digest: "d".repeat(64), mode: "blocked", surprise: true }, { digest: "d".repeat(64), mode: "unknown" }]) expect(() => decodeSourceSchema(domain, "composed", value)).toThrow();
    expect(() => decodeSourceSchema(domain, "conditional", { kind: "a", count: 2 })).not.toThrow();
    expect(() => decodeSourceSchema(domain, "conditional", { kind: "b", count: 5 })).not.toThrow();
    for (const value of [{ kind: "a", count: 0 }, { kind: "a", count: 3 }, { kind: "a" }, { kind: "b", count: 6 }, { kind: "b", count: 2, surprise: true }]) expect(() => decodeSourceSchema(domain, "conditional", value)).toThrow();
    expect(() => decodeSourceSchema(domain, "referenced", "short")).toThrow();
    expect(() => decodeSourceSchema(domain, "referenced", "d".repeat(64))).not.toThrow();
  });

  it("rejects malformed actual eligibility snapshots despite conditional allOf", async () => {
    const { readJson } = await readSources();
    const domain = await readJson("docs/source/handoff/contracts/domain.schema.json") as SourceDomainDocument;
    const value = { tenant_id: "tenant-a", pull_request_id: "pr-a", pr_version: 1, id: "elig-a", status: "blocked", head_sha: "a".repeat(40), base_sha: "b".repeat(40), candidate_sha: null, method: "merge", diff_digest: "d".repeat(64), policy_digest: "e".repeat(64), policy_epoch: 1, expires_at: "2026-10-09T00:10:00Z", blockers: [], reviews: [], checks: [] };
    expect(() => decodeSourceSchema(domain, "ForgePrEligibility", value)).not.toThrow();
    for (const patch of [{ diff_digest: "pending" }, { head_sha: "branch" }, { pr_version: 0 }, { surprise: true }, { status: "eligible" }, { blockers: [{ code: "unknown", resource_id: null, detail: "Invalid.", required_action: "pr.eligibility" }] }]) expect(() => decodeSourceSchema(domain, "ForgePrEligibility", { ...value, ...patch })).toThrow();
    const { policy_digest: omitted, ...missing } = value;
    expect(() => decodeSourceSchema(domain, "ForgePrEligibility", missing)).toThrow();
  });


  it("rejects operation fixtures that violate source constraints", () => {
    expect(() => decodeNativeOperation({
      id: "repo.list",
      method: "TRACE",
      path: "/api/v1/tenants/{tenant_id}/repositories",
      capability: "repository.read",
      output_schema: "RepositoryPage",
      input_schema: null,
      asynchronous: false,
      cli: "gfy repo list",
      mcp_tool: "gfy_repo_list",
      request_schema: "RepositoryListQuery",
      request_location: "query",
      batch_eligible: true
    })).toThrow();
  });

  it("validates the full native operation to route to MCP mapping from source", async () => {
    const { readJson, readText } = await readSources();
    const summary = validateSourceCatalog({
      operations: await readJson("docs/source/handoff/contracts/operations.json"),
      mcpTools: await readJson("docs/source/handoff/contracts/mcp-tools.json"),
      openapi: await readJson("docs/source/handoff/contracts/openapi.json"),
      schemaSql: await readText("docs/source/handoff/contracts/schema.sql"),
      requirementsTraceCsv: await readText("docs/source/handoff/requirements-trace.csv")
    });

    expect(summary).toMatchObject({
      requirements: 80,
      operations: 198,
      mcpTools: 198,
      openapiPaths: 129,
      sqlTables: 52
    });
    expect(summary.operationIds).toContain("repo.view");
    expect(summary.mcpToolNames).toContain("gfy_repo_create");
    expect(summary.unimplementedOperationIds).toHaveLength(198);
  });

  it("validates source domain fixtures against their actual JSON schemas", async () => {
    const { readJson } = await readSources();
    const domain = await readJson("docs/source/handoff/contracts/domain.schema.json") as SourceDomainDocument;
    const fixtures = await readJson("docs/source/handoff/examples/domain-fixtures.json") as Array<{ schema: string; value: unknown }>;

    for (const fixture of fixtures) {
      expect(() => decodeSourceSchema(domain, fixture.schema, fixture.value), fixture.schema).not.toThrow();
    }
  });

  it("rejects independently crafted invalid domain and request fixtures", async () => {
    const { readJson } = await readSources();
    const domain = await readJson("docs/source/handoff/contracts/domain.schema.json") as SourceDomainDocument;

    expect(() => decodeSourceSchema(domain, "Repository", {
      tenant_id: "tenant_a",
      id: "repo_a",
      version: 0,
      created_at: "not-a-date",
      updated_at: "2026-10-07T18:00:00Z",
      namespace_id: "ns_a",
      name: "bad name with spaces",
      visibility: "private",
      default_branch: "main",
      archived: false,
      fork_of: null,
      git_url: "not a uri",
      extra: true
    })).toThrow();

    expect(() => decodeSourceSchema(domain, "RepositoryCreate", {
      namespace_id: "ns_a",
      name: "demo",
      initial_files: [{ path: "README.md", encoding: "binary", content: "hello" }]
    })).toThrow();
  });

  it("rejects unknown fields in decoded request envelopes", () => {
    expect(() => decodeRequestEnvelope({
      operation_id: "repo.view",
      route: { tenant_id: "tenant_a", id: "repo_a" },
      query: {},
      headers: {},
      body: null,
      cookies: {},
      api_version: "v1",
      surprise: true
    })).toThrow(/unknown field/);
  });
});
