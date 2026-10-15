import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCommand } from './local-forge-runner.mjs';

test('R1 native jobs preserve a configured browser in their isolated environment', async t => {
  const original = process.env.CHROME_BIN;
  process.env.CHROME_BIN = 'configured-browser-marker';
  t.after(() => { if (original === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = original; });
  const home = await mkdtemp(join(tmpdir(), 'gfy-browser-env-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await runCommand({ command: [process.execPath, '-e', 'process.stdout.write(process.env.CHROME_BIN ?? "unset")'], cwd: process.cwd(), home, timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString(), 'configured-browser-marker');
});

test('R1 native jobs preserve absence of browser configuration', async t => {
  const original = process.env.CHROME_BIN;
  delete process.env.CHROME_BIN;
  t.after(() => { if (original === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = original; });
  const home = await mkdtemp(join(tmpdir(), 'gfy-browser-env-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await runCommand({ command: [process.execPath, '-e', 'process.stdout.write(Object.hasOwn(process.env, "CHROME_BIN") ? "set" : "unset")'], cwd: process.cwd(), home, timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString(), 'unset');
});
