import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;
const commandTimeoutMs = 900_000;

function rsaPem() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
}

function bounded(text, limit = 12_000) {
  return text.length > limit ? text.slice(0, limit) + '\n[truncated]' : text;
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd || root, env: options.env || process.env, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (options.input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(options.input); }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs || commandTimeoutMs);
    child.stdout.on('data', chunk => { stdout = bounded(stdout + chunk.toString('utf8')); });
    child.stderr.on('data', chunk => { stderr = bounded(stderr + chunk.toString('utf8')); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr };
      if (options.allowFailure || code === 0) resolve(result);
      else reject(new Error(`${executable} ${args.join(' ')} failed code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function waitLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index >= 0) resolve(JSON.parse(buffer.slice(0, index)));
    });
    child.on('exit', code => reject(new Error(`fixture exited before ready: ${code}`)));
  });
}

async function sha256File(path) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'gitfoundry-actions-server-e2e' } });
  if (response.status !== 200) {
    assert.fail(`GET ${url} failed ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function waitDockerHealth(containerName) {
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const result = await run('docker', ['exec', containerName, 'curl', '-fsS', 'http://127.0.0.1/__gitfoundry/health'], { allowFailure: true, timeoutMs: 10_000 });
    last = result.stdout + result.stderr;
    if (result.code === 0 && /"ready":true/.test(result.stdout)) return JSON.parse(result.stdout);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const logs = await run('docker', ['logs', containerName], { allowFailure: true, timeoutMs: 30_000 });
  throw new Error(`server did not become healthy: ${last}\ncontainer logs:\n${logs.stdout}${logs.stderr}`);
}

async function startFixture(t, dir, generation) {
  const child = spawn(process.execPath, ['scripts/github-actions-server-storage-fixture.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: '0', BIND_HOST: '0.0.0.0', GFY_ACTIONS_STORAGE_TOKEN: 'fixture-token', GFY_ACTIONS_GENERATION: generation, GFY_ACTIONS_FIXTURE_SNAPSHOT: join(dir, 'snapshot.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  const ready = await waitLine(child);
  return { child, urlForContainer: `http://host.docker.internal:${ready.port}/`, snapshotPath: ready.snapshotPath, generation };
}

async function dockerRm(name) {
  await run('docker', ['rm', '-f', name], { allowFailure: true, timeoutMs: 30_000 });
}

async function dockerNetworkRm(name) {
  await run('docker', ['network', 'rm', name], { allowFailure: true, timeoutMs: 30_000 });
}

async function startServer({ name, network, image, fixture, secretVolume }) {
  await dockerRm(name);
  await run('docker', [
    'run', '-d', '--name', name, '--network', network, '--add-host', 'host.docker.internal:host-gateway',
    '-e', 'PORT=80',
    '-e', `GFY_ACTIONS_PUBLIC_ORIGIN=http://${name}`,
    '-e', 'RUNNER_TOKEN=runner-token',
    '-e', `GFY_ACTIONS_STORAGE_URL=${fixture.urlForContainer}`,
    '-e', 'GFY_ACTIONS_STORAGE_TOKEN=fixture-token',
    '-e', `GFY_ACTIONS_GENERATION=${fixture.generation}`,
    '-e', 'GFY_ACTIONS_RSA_PRIVATE_KEY_FILE=/secrets/rsa.pem',
    '-v', `${secretVolume}:/secrets:ro`,
    image,
  ]);
  return await waitDockerHealth(name);
}

async function serverDiagnostics(containerName) {
  const health = await run('docker', ['exec', containerName, 'curl', '-fsS', 'http://127.0.0.1/__gitfoundry/health'], { allowFailure: true, timeoutMs: 30_000 });
  const logs = await run('docker', ['logs', containerName], { allowFailure: true, timeoutMs: 30_000 });
  return `server health:\n${health.stdout}${health.stderr}\nserver logs:\n${logs.stdout}${logs.stderr}`;
}

async function waitRunnerReady(containerName) {
  const deadline = Date.now() + 120_000;
  let last = '';
  while (Date.now() < deadline) {
    const result = await run('docker', ['exec', containerName, 'bash', '-lc', 'cat /tmp/runner.log 2>/dev/null || true'], { allowFailure: true, timeoutMs: 30_000 });
    last = result.stdout + result.stderr;
    if (/Listening for Jobs/.test(last)) return;
    if (/Runner listener exit|Unhandled exception|Access denied/i.test(last)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`runner did not become ready:\n${last}`);
}

async function scheduleWorkflow({ image, network, serverName, workDir, workflowName, expectedSuccess, runnerName }) {
  let output = '';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await run('docker', [
      'run', '--rm', '--network', network, '--entrypoint', 'dotnet', '-v', `${workDir}:/work`, '-w', '/work', image,
      '/opt/runner/client/Runner.Client.dll', '--workflow', workflowName, '--event', 'push', '--server', `http://${serverName}`,
    ], { allowFailure: true, timeoutMs: 180_000 });
    output = result.stdout + result.stderr;
    if (expectedSuccess && result.code !== 0 && /No Runner available|No runner is registered/.test(output) && attempt < 5) {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      continue;
    }
    if (expectedSuccess) {
      if (result.code !== 0 && runnerName) {
        const runnerLog = await run('docker', ['exec', runnerName, 'bash', '-lc', 'cat /tmp/runner.log 2>/dev/null || true'], { allowFailure: true, timeoutMs: 30_000 });
        output += `\nrunner log:\n${runnerLog.stdout}${runnerLog.stderr}`;
      }
      assert.equal(result.code, 0, output);
      assert.match(output, /All Workflows finished successfully|Workflow .*Completed with Status: Succeeded/i);
    } else {
      assert.notEqual(result.code, 0, output);
      assert.match(output, /gfy-official-failure|exit 7|All Workflows finished, at least one workflow failed/i);
    }
    return output;
  }
  assert.fail(output);
}

test('official actions runner registers, reconnects after server restart, and runs success and failure workflows', { timeout: 1_200_000 }, async (t) => {
  const id = 'gfy-actions-' + randomUUID().slice(0, 8);
  const dir = await mkdtemp(join(tmpdir(), `${id}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const serverImage = `${id}:server`;
  const runnerImage = `${id}:runner`;
  const network = `${id}-net`;
  const serverName = `${id}-server`;
  const runnerName = `${id}-runner`;
  const secretVolume = `${id}-secrets`;
  t.after(async () => { await dockerRm(runnerName); await dockerRm(serverName); await dockerNetworkRm(network); await run('docker', ['volume', 'rm', secretVolume], { allowFailure: true, timeoutMs: 30_000 }); });

  const release = await fetchJson('https://api.github.com/repos/actions/runner/releases/latest');
  const asset = release.assets.find(item => /^actions-runner-linux-x64-.*\.tar\.gz$/.test(item.name));
  assert.ok(asset?.browser_download_url, 'missing official linux-x64 runner asset');
  assert.match(asset.digest || '', /^sha256:[0-9a-f]{64}$/);
  const runnerArchive = join(dir, 'actions-runner.tar.gz');
  await run('curl', ['-fsSL', asset.browser_download_url, '-o', runnerArchive], { timeoutMs: 300_000 });
  assert.equal('sha256:' + await sha256File(runnerArchive), asset.digest);

  await run('docker', ['build', '-t', serverImage, '-f', 'images/github-actions-server/Dockerfile', 'images'], { timeoutMs: 900_000 });
  const runnerDockerfile = join(dir, 'Dockerfile.runner');
  await writeFile(runnerDockerfile, `FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git iproute2 jq libicu74 tar gzip && rm -rf /var/lib/apt/lists/*\nWORKDIR /runner\nCOPY actions-runner.tar.gz /tmp/actions-runner.tar.gz\nRUN tar -xzf /tmp/actions-runner.tar.gz -C /runner && rm /tmp/actions-runner.tar.gz && ./bin/installdependencies.sh || true\n`);
  await run('docker', ['build', '--platform', 'linux/amd64', '-t', runnerImage, '-f', runnerDockerfile, dir], { timeoutMs: 600_000 });

  await run('docker', ['network', 'create', network]);
  await run('docker', ['volume', 'create', secretVolume]);
  await run('docker', ['run', '--rm', '-i', '--user', '0:0', '--mount', `type=volume,source=${secretVolume},target=/secrets`, '--entrypoint', 'node', serverImage, '-e', "const fs=require('node:fs');const user=fs.readFileSync('/etc/passwd','utf8').split('\\n').find(line=>line.startsWith('gitfoundry:'));if(!user)throw Error('server user missing');const fields=user.split(':');let pem='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>pem+=data);process.stdin.on('end',()=>{const path='/secrets/rsa.pem';fs.writeFileSync(path,pem,{mode:0o600});fs.chownSync(path,Number(fields[2]),Number(fields[3]));fs.chmodSync(path,0o600);const stat=fs.statSync(path);if((stat.mode&0o777)!==0o600||stat.uid!==Number(fields[2]))throw Error('private key ownership invalid');});"], { input: rsaPem() });
  const fixture = await startFixture(t, dir, `${id}-generation`);
  await startServer({ name: serverName, network, image: serverImage, fixture, secretVolume });

  await dockerRm(runnerName);
  await run('docker', ['run', '-d', '--name', runnerName, '--network', network, '-e', 'RUNNER_ALLOW_RUNASROOT=1', ...(process.arch === 'arm64' ? ['-e', 'DOTNET_EnableWriteXorExecute=0'] : []), runnerImage, 'sleep', 'infinity']);
  try {
    await run('docker', ['exec', '-e', 'RUNNER_ALLOW_RUNASROOT=1', runnerName, './config.sh', '--unattended', '--url', `http://${serverName}/runner/server`, '--token', 'runner-token', '--name', runnerName, '--labels', 'self-hosted,linux,x64'], { timeoutMs: 120_000 });
  } catch (error) {
    throw new Error(`${error.message}\n${await serverDiagnostics(serverName)}`);
  }
  await run('docker', ['exec', '-d', '-e', 'RUNNER_ALLOW_RUNASROOT=1', runnerName, 'bash', '-lc', 'exec ./run.sh > /tmp/runner.log 2>&1']);
  await waitRunnerReady(runnerName);

  const workDir = join(dir, 'workflows');
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, 'success.yml'), 'on: push\njobs:\n  ok:\n    runs-on: self-hosted\n    steps:\n      - run: echo gfy-official-success\n');
  await writeFile(join(workDir, 'failure.yml'), 'on: push\njobs:\n  bad:\n    runs-on: self-hosted\n    steps:\n      - run: echo gfy-official-failure && exit 7\n');

  await scheduleWorkflow({ image: serverImage, network, serverName, workDir, workflowName: 'success.yml', expectedSuccess: true, runnerName });
  await dockerRm(serverName);
  await startServer({ name: serverName, network, image: serverImage, fixture, secretVolume });
  const runnerProcesses = await run('docker', ['exec', runnerName, 'bash', '-lc', 'pgrep -af "Runner.Listener|run.sh"'], { timeoutMs: 30_000 });
  assert.match(runnerProcesses.stdout, /Runner.Listener|run\.sh/);
  await waitRunnerReady(runnerName);
  await new Promise(resolve => setTimeout(resolve, 5000));
  await scheduleWorkflow({ image: serverImage, network, serverName, workDir, workflowName: 'success.yml', expectedSuccess: true, runnerName });
  await scheduleWorkflow({ image: serverImage, network, serverName, workDir, workflowName: 'failure.yml', expectedSuccess: false, runnerName });
});
