#!/usr/bin/env node
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const port = Number.parseInt(process.env.PORT || '0', 10);
const bindHost = process.env.BIND_HOST || '127.0.0.1';
const snapshotPath = resolve(process.env.GFY_ACTIONS_FIXTURE_SNAPSHOT || 'actions-server-snapshot.db');
const token = process.env.GFY_ACTIONS_STORAGE_TOKEN || 'fixture-token';
let failWrites = process.env.GFY_ACTIONS_FIXTURE_FAIL_WRITES === '1';
let corruptLatestSha = process.env.GFY_ACTIONS_FIXTURE_CORRUPT_LATEST_SHA === '1';
let omitAckSha = process.env.GFY_ACTIONS_FIXTURE_OMIT_ACK_SHA === '1';
let generation = process.env.GFY_ACTIONS_GENERATION || 'fixture-generation';
let latest = null;
let pointerVersion = null;
try {
  latest = await readFile(snapshotPath);
  pointerVersion = randomUUID();
} catch {}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', 'x-gfy-actions-generation': generation, ...headers });
  response.end(JSON.stringify(value));
}

async function readBody(request, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    if (request.headers.authorization !== `Bearer ${token}`) return sendJson(response, 401, { error: 'unauthorized' });
    if (url.searchParams.get('generation') !== generation) return sendJson(response, 409, { error: 'generation_mismatch' });
    if (request.method === 'GET' && url.pathname === '/sqlite/latest') {
      if (!latest) { response.writeHead(204, { 'x-gfy-actions-generation': generation }); return response.end(); }
      const digest = corruptLatestSha ? '0'.repeat(64) : sha256(latest);
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-gfy-actions-generation': generation, 'x-gfy-actions-sha256': digest, 'x-gfy-actions-pointer-version': pointerVersion });
      return response.end(latest);
    }
    if (request.method === 'POST' && url.pathname === '/sqlite/backups') {
      if (failWrites) return sendJson(response, 503, { error: 'persist_unavailable' });
      const expectedPointer = request.headers['x-gfy-actions-pointer-version'];
      if (latest && expectedPointer !== pointerVersion) return sendJson(response, 409, { error: 'pointer_version_mismatch', expected: pointerVersion });
      if (!latest && expectedPointer) return sendJson(response, 409, { error: 'pointer_version_mismatch', expected: null });
      const body = await readBody(request);
      const digest = sha256(body);
      if (!request.headers['x-gfy-actions-sha256'] || request.headers['x-gfy-actions-sha256'] !== digest) return sendJson(response, 400, { error: 'sha256_mismatch' });
      await mkdir(dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, body, { mode: 0o600 });
      latest = body;
      pointerVersion = randomUUID();
      const headers = { 'x-gfy-actions-generation': generation, 'x-gfy-actions-pointer-version': pointerVersion };
      if (!omitAckSha) headers['x-gfy-actions-sha256'] = digest;
      response.writeHead(201, headers);
      return response.end();
    }
    if (request.method === 'POST' && url.pathname === '/fixture/fail-writes') {
      const body = JSON.parse((await readBody(request)).toString('utf8') || '{}');
      if (typeof body.fail === 'boolean') failWrites = body.fail;
      if (typeof body.omitAckSha === 'boolean') omitAckSha = body.omitAckSha;
      return sendJson(response, 200, { failWrites, omitAckSha, pointerVersion });
    }
    return sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    return sendJson(response, error.statusCode || 500, { error: 'fixture_error' });
  }
});

server.listen(port, bindHost, () => {
  const address = server.address();
  console.log(JSON.stringify({ ready: true, port: address.port, snapshotPath, generation }));
});
