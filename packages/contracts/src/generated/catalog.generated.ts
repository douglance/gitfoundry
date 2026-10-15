export const expectedContractCounts = {
  requirements: 80,
  operations: 198,
  mcpTools: 198,
  openapiPaths: 129,
  sqlTables: 52
} as const;

export const sourceContractPaths = {
  handoff: "docs/source/handoff/HANDOFF.json",
  operations: "docs/source/handoff/contracts/operations.json",
  mcpTools: "docs/source/handoff/contracts/mcp-tools.json",
  openapi: "docs/source/handoff/contracts/openapi.json",
  schemaSql: "docs/source/handoff/contracts/schema.sql",
  requirementsTrace: "docs/source/handoff/requirements-trace.csv"
} as const;

export const catalogGeneration = {
  source: "docs/source/handoff",
  generatedBy: "scripts/generate-contract-artifacts.mjs",
  slice: "P0-01"
} as const;
