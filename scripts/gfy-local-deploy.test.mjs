import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublishedHeadAdmission, deployPublishedLocalCandidate, localDeploy, normalizeForgeVersion, startDeployRun, verifyCandidateForPublication } from './gfy-local-deploy.mjs';
import { rollbackPlanForPrepared } from './gfy-cloudflare-deploy.mjs';

const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const candidate = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const source = 'cccccccccccccccccccccccccccccccccccccccc';
const other = 'dddddddddddddddddddddddddddddddddddddddd';

function forge({ headVersion = head, headCode = 'old-code', candidateCode = source } = {}) {
  return {
    headCalls: 0,
    async head() { this.headCalls += 1; return { version: { version_commit: headVersion, descriptor: { code_commit: headCode } } }; },
    async view() { return { version: { version_commit: candidate, descriptor: { code_commit: candidateCode } } }; },
    async publish() { return { version: { version_commit: candidate, descriptor: { code_commit: source } } }; },
  };
}

test('candidate publication guard rejects stale head and source mismatch', async () => {
  await verifyCandidateForPublication({ forge: forge(), tenantId: 'local', repositoryId: 'gitfoundry', expectedHead: head, versionCommit: candidate, sourceRevision: source });
  await assert.rejects(verifyCandidateForPublication({ forge: forge({ headVersion: other }), tenantId: 'local', repositoryId: 'gitfoundry', expectedHead: head, versionCommit: candidate, sourceRevision: source }), /forge head moved/);
  await assert.rejects(verifyCandidateForPublication({ forge: forge({ candidateCode: other }), tenantId: 'local', repositoryId: 'gitfoundry', expectedHead: head, versionCommit: candidate, sourceRevision: source }), /candidate source mismatch/);
});

test('provider admission re-reads published head before every mutation', async () => {
  const versions = [candidate, other];
  const sourceRevisions = [source, source];
  const fakeForge = { async head() { return { version: { version_commit: versions.shift(), descriptor: { code_commit: sourceRevisions.shift() } } }; } };
  const admit = createPublishedHeadAdmission({ forge: fakeForge, tenantId: 'local', repositoryId: 'gitfoundry', expectedVersionCommit: candidate, expectedCodeCommit: source });
  assert.deepEqual(await admit(), { version_commit: candidate, code_commit: source });
  await assert.rejects(admit(), /published forge head changed/);
});

test('local deploy publishes through forge and submits the fixed deploy runner command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-local-deploy-'));
  try {
    const deployConfig = join(dir, 'deploy.json');
    await writeFile(deployConfig, '{}', { mode: 0o600 });
    const calls = [];
    let published = false;
    const fakeForge = forge({ headCode: source });
    fakeForge.head = async () => ({ version: { version_commit: published ? candidate : head, descriptor: { code_commit: source } } });
    fakeForge.publish = async input => { published = true; calls.push(['publish', input]); return { version: { version_commit: candidate, descriptor: { code_commit: source } } }; };
    const result = await localDeploy({ options: { 'version-commit': candidate, 'expected-head': head, 'source-revision': source, 'operation-id': 'deploytest', 'deploy-config': deployConfig }, positionals: [] }, {
      print: false,
      forge: fakeForge,
      startDeployRun: async input => { calls.push(['run', input]); return { run_id: input.operationId, status: 'finished', exit_code: 0 }; },
    });
    assert.equal(result.status, 'submitted');
    assert.equal(calls[0][0], 'publish');
    assert.equal(calls[0][1].expectedHead, head);
    assert.equal(calls[0][1].versionCommit, candidate);
    assert.equal(calls[1][0], 'run');
    assert.equal(calls[1][1].versionCommit, candidate);
    assert.equal(calls[1][1].sourceRevision, source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('start deploy run carries deploy inputs inside the materialized command argv', async () => {
  let captured;
  const result = await startDeployRun({
    localGfy: 'scripts/gfy-local.mjs',
    url: 'http://127.0.0.1:4181',
    tokenFile: '/private/local-owner.jwt',
    tenantId: 'local',
    repositoryId: 'gitfoundry',
    versionCommit: candidate,
    sourceRevision: source,
    deployConfigFile: '/private/deploy.json',
    operationId: 'deploy-op',
    runCommand: async (command, args, options) => { captured = { command, args, options }; return JSON.stringify({ run_id: 'deploy-op', status: 'submitted' }); },
  });
  const argv = JSON.parse(captured.args[captured.args.indexOf('--argv-json') + 1]);
  assert.equal(result.run_id, 'deploy-op');
  assert.deepEqual(argv.slice(0, 2), ['node', '-e']);
  assert.match(argv[2], /GFY_DEPLOY_CONFIG_FILE/);
  assert.deepEqual(argv.slice(3, 5), [source, '/private/deploy.json']);
  assert.deepEqual(JSON.parse(argv[5]), { gfyBin: 'gfy', url: 'http://127.0.0.1:4181', tokenFile: '/private/local-owner.jwt', tenantId: 'local', repositoryId: 'gitfoundry', expectedVersionCommit: candidate, expectedCodeCommit: source });
});

test('local deploy rejects a public deployment config before publication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gfy-local-deploy-mode-'));
  try {
    const deployConfig = join(dir, 'deploy.json');
    await writeFile(deployConfig, '{}', { mode: 0o600 });
    await chmod(deployConfig, 0o644);
    let published = false;
    await assert.rejects(localDeploy({ options: { 'version-commit': candidate, 'expected-head': head, 'source-revision': source, 'operation-id': 'deploytest', 'deploy-config': deployConfig }, positionals: [] }, { print: false, forge: forge(), publish: async () => { published = true; } }), /mode 0600/);
    assert.equal(published, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rollback plan preserves previous deployment identities without secrets', () => {
  const plan = rollbackPlanForPrepared([
    { role: 'api', name: 'api-worker', previous_deployment_id: 'deployment-before', previous_versions: [{ version_id: 'version-before', percentage: 100 }], secrets_file: '/private/secrets.json' },
  ], { GFY_SOURCE_REVISION: source }, () => '2026-10-10T00:00:00.000Z');
  assert.deepEqual(plan.workers, [{ role: 'api', worker_name: 'api-worker', previous_deployment_id: 'deployment-before', previous_versions: [{ version_id: 'version-before', percentage: 100 }] }]);
  assert.equal(JSON.stringify(plan).includes('secrets'), false);
  assert.equal(plan.source_revision, source);
});

test('forge version normalization accepts response and descriptor shapes', () => {
  assert.deepEqual(normalizeForgeVersion({ version: { version_commit: candidate, descriptor: { code_commit: source } } }), { version_commit: candidate, code_commit: source });
  assert.deepEqual(normalizeForgeVersion({ versionCommit: candidate, codeCommit: source }), { version_commit: candidate, code_commit: source });
});

test('local bootstrap passes a live admission gate and refuses a head change during deployment', async () => {
  let current = candidate;
  const liveForge = { async head() { return { version: { version_commit: current, descriptor: { code_commit: source } } }; } };
  let mutations = 0;
  await assert.rejects(deployPublishedLocalCandidate({ forge: liveForge, tenantId: 'local', repositoryId: 'gitfoundry', expectedVersionCommit: candidate, expectedCodeCommit: source, env: { GFY_SOURCE_REVISION: source } }, {
    deploy: async (env, { finalDeployAdmission }) => {
      assert.equal(env.GFY_SOURCE_REVISION, source);
      await finalDeployAdmission();
      mutations += 1;
      current = other;
      await finalDeployAdmission();
      mutations += 1;
    },
  }), /published forge head changed/);
  assert.equal(mutations, 1);
});
