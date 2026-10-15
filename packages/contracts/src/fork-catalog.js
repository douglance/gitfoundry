import catalog from "./fork-catalog.json" with { type: "json" };

export const forkCatalogVersion = Object.freeze({
  current: catalog.schema_version,
  historical: catalog.historical_schema_version
});

export const forkOperations = Object.freeze(catalog.operations);
export const forkMcpTools = Object.freeze(catalog.mcp_tools);
export const forkCatalog = Object.freeze(catalog);
