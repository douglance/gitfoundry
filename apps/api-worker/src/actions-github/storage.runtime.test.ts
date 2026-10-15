import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("stores and restores a checksum-verified SQLite snapshot through the native R2 binding", async () => {
  const entry = resolve("src/actions-github/storage.ts");
  const coordinatorEntry = resolve("src/actions-github/cloudflare.ts");
  const bundle = await build({
    stdin: { contents: `
      import { handleActionsStorage } from ${JSON.stringify(entry)};
      export { GitHubActionsBackendDO } from ${JSON.stringify(coordinatorEntry)};
      export default {
        fetch: (request, env) => handleActionsStorage(request, {
          GFY_ACTIONS_SQLITE_BUCKET: env.BUCKET,
          GFY_ACTIONS_INTERNAL_STORAGE_SECRET: "private-test-token",
          GFY_ACTIONS_STORAGE_GENERATION: "native-r2"
        }, {
          read: generation => env.SNAPSHOTS.get(env.SNAPSHOTS.idFromName("native-r2")).read(generation),
          commit: input => env.SNAPSHOTS.get(env.SNAPSHOTS.idFromName("native-r2")).commit(input)
        })
      };
    `, resolveDir: process.cwd(), sourcefile: "actions-r2-probe.ts" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"]
  });
  const script = bundle.outputFiles[0]!.text;
  const mf = new Miniflare({ modules: true, script, compatibilityDate: "2026-07-30", r2Buckets: ["BUCKET"], bindings: { GFY_ACTIONS_STORAGE_GENERATION: "native-r2" }, durableObjects: { SNAPSHOTS: { className: "GitHubActionsBackendDO", useSQLite: true } } });
  try {
    const bytes = new Uint8Array(512 * 1024);
    bytes.set(new TextEncoder().encode("SQLite format 3\0"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const url = "http://localhost/__internal/actions-github/storage/sqlite/";
    const headers = { authorization: "Bearer private-test-token", "x-gfy-actions-generation": "native-r2" };
    const empty = await mf.dispatchFetch(url + "latest?generation=native-r2", { headers });
    expect(empty.status).toBe(204);
    expect(empty.headers.get("x-gfy-actions-generation")).toBe("native-r2");
    const saved = await mf.dispatchFetch(url + "backups?generation=native-r2", {
      method: "POST", headers: { ...headers, "content-length": String(bytes.byteLength), "x-gfy-actions-sha256": digest }, body: bytes
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const version = saved.headers.get("x-gfy-actions-pointer-version");
    expect(version).toBeTruthy();
    const mismatch = await mf.dispatchFetch(url + "backups?generation=native-r2", {
      method: "POST",
      headers: { ...headers, "content-length": String(bytes.byteLength), "x-gfy-actions-sha256": "0".repeat(64), "x-gfy-actions-pointer-version": version! },
      body: bytes
    });
    expect(mismatch.status, await mismatch.clone().text()).toBe(400);
    const restored = await mf.dispatchFetch(url + "latest?generation=native-r2", { headers });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(bytes);
    expect(restored.headers.get("x-gfy-actions-pointer-version")).toBe(version);
    expect((await (await mf.getR2Bucket("BUCKET")).list()).objects).toHaveLength(1);
    const competing = await Promise.all([1, 2].map(() => mf.dispatchFetch(url + "backups?generation=native-r2", {
      method: "POST", headers: { ...headers, "content-length": String(bytes.byteLength), "x-gfy-actions-sha256": digest, "x-gfy-actions-pointer-version": version! }, body: bytes
    })));
    expect(competing.map(response => response.status).sort()).toEqual([201, 409]);
  } finally {
    await mf.dispose();
  }
}, 20_000);
