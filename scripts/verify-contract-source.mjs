import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateSourceCatalog } from "../packages/contracts/dist/index.js";

const root = path.resolve(import.meta.dirname, "..");
const readText = (relative) => readFile(path.join(root, relative), "utf8");
const readJson = async (relative) => JSON.parse(await readText(relative));

const summary = validateSourceCatalog({
  operations: await readJson("docs/source/handoff/contracts/operations.json"),
  mcpTools: await readJson("docs/source/handoff/contracts/mcp-tools.json"),
  openapi: await readJson("docs/source/handoff/contracts/openapi.json"),
  schemaSql: await readText("docs/source/handoff/contracts/schema.sql"),
  requirementsTraceCsv: await readText("docs/source/handoff/requirements-trace.csv")
});

console.log(JSON.stringify({ ok: true, summary }));
