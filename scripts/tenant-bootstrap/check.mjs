#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(new URL("../..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
const coreUrl = new URL("../../packages/core/dist/identity-bootstrap/index.js", import.meta.url);

async function main() {
  if (!args.manifest) throw new Error("usage: node scripts/tenant-bootstrap/check.mjs --manifest manifest.json [--validate-only] [--local-fixture-context trusted.json --db tenant.db --install-schema docs/source/handoff/contracts/schema.sql] [--now 2026-10-08T00:00:00Z]");
  const { initializeTenantBootstrapPromise, makeStaticTenantBootstrapTrustedContext, validateTenantBootstrapManifestPromise } = await import(coreUrl.href);
  const manifest = JSON.parse(readFileSync(resolve(root, args.manifest), "utf8"));
  if (args.validateOnly) {
    const validated = await validateTenantBootstrapManifestPromise(manifest, { now: args.now });
    console.log(JSON.stringify({ ok: true, mode: "validate-only", manifest_digest: validated.digest }, null, 2));
    return;
  }
  if (!args.localFixtureContext) throw new Error("--local-fixture-context is required for this local initializer harness; production remote bootstrap must use real provider adapters and an authoritative operator context");
  if (!args.db) throw new Error("--db is required unless --validate-only is set");
  const trustedContext = makeStaticTenantBootstrapTrustedContext(JSON.parse(readFileSync(resolve(root, args.localFixtureContext), "utf8")));
  const db = new DatabaseSync(resolve(root, args.db));
  if (args.installSchema) db.exec(readFileSync(resolve(root, args.installSchema), "utf8"));
  const result = await initializeTenantBootstrapPromise(manifest, sqliteBootstrapStore(db), trustedContext, { now: args.now });
  console.log(JSON.stringify({ ok: true, result }, null, 2));
}

function parseArgs(argv) {
  const parsed = { validateOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--validate-only") parsed.validateOnly = true;
    else if (arg === "--manifest") parsed.manifest = requireValue(argv, ++index, arg);
    else if (arg === "--local-fixture-context") parsed.localFixtureContext = requireValue(argv, ++index, arg);
    else if (arg === "--db") parsed.db = requireValue(argv, ++index, arg);
    else if (arg === "--install-schema") parsed.installSchema = requireValue(argv, ++index, arg);
    else if (arg === "--now") parsed.now = requireValue(argv, ++index, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function sqliteBootstrapStore(db) {
  return {
    kind: "sqlite-transactional",
    async transaction(body) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await body({
          async get(sql, values = []) {
            return db.prepare(sql).get(...values) ?? null;
          },
          async run(sql, values = []) {
            db.prepare(sql).run(...values);
          }
        });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error), tag: error?._tag }, null, 2));
  process.exitCode = 1;
});
