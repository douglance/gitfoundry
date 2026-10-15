import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const readText = async (relative) => readFile(path.join(root, relative), "utf8");

const operations = await readJson("docs/source/handoff/contracts/operations.json");
const mcpTools = await readJson("docs/source/handoff/contracts/mcp-tools.json");
const openapi = await readJson("docs/source/handoff/contracts/openapi.json");
const schemaSql = await readText("docs/source/handoff/contracts/schema.sql");

const summary = {
  operations: operations.operations.length,
  mcpTools: mcpTools.tools.length,
  openapiPaths: Object.keys(openapi.paths).length,
  sqlTables: [...schemaSql.matchAll(/CREATE TABLE\s+[A-Za-z0-9_]+/g)].length
};

const text = `export const generatedSummary = ${JSON.stringify(summary, null, 2)} as const;\n`;

if (process.argv.includes("--print")) {
  process.stdout.write(text);
} else {
  console.log(JSON.stringify({ ok: true, summary, note: "Use --print and apply caller-owned output through griz." }));
}
