import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const plugins = [];
if (process.env.GFY_E2E_COVERAGE === '1') {
  const { browserCoveragePlugin } = await import('../../../scripts/e2e-coverage.mjs');
  plugins.push(await browserCoveragePlugin(resolve(root, '../..')));
}
await build({ root, configFile: resolve(root, 'vite.config.js'), plugins });
console.log(JSON.stringify({ ok: true, dist: resolve(root, 'dist') }));
