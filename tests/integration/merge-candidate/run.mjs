#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const helperPath = resolve(repoRoot, "images/git-helper/gitfoundry-merge-candidate");
const dockerContext = resolve(repoRoot, "images");
const image = process.env.GFY_MERGE_CANDIDATE_IMAGE || "gitfoundry-merge-candidate-test:local";
const frame = "gitfoundry.merge-candidate.prepare.v1";
const resultFrame = "gitfoundry.merge-candidate.result.v1";
const tenant = "tenant-a";
const repo = "repo-a";
const op = "op-a";
let parseWorkerResult;

async function main() {
  await access(helperPath, constants.F_OK);
  await run("docker", ["build", "--platform", "linux/amd64", "-f", resolve(dockerContext, "git-helper/Dockerfile"), "-t", image, dockerContext], { cwd: repoRoot, expectExit: 0 });

  const root = await mkdtemp(join(tmpdir(), "gitfoundry-merge-candidate-"));
  try {
    parseWorkerResult = await loadWorkerParser(root);
    await runAll(root);
  } finally {
    if (!process.env.GFY_KEEP_MERGE_CANDIDATE_TMP) await rm(root, { recursive: true, force: true });
  }
}

async function loadWorkerParser(root) {
  const shim = join(root, "cloudflare-workers-shim.js");
  const bundle = join(root, "merge-candidate-worker-parser.mjs");
  await writeFile(shim, "export class DurableObject {}\nexport class WorkerEntrypoint {}\n", "utf8");
  await run("pnpm", [
    "exec", "esbuild", "apps/api-worker/src/merge-candidate/index.ts",
    "--bundle", "--platform=node", "--format=esm",
    "--alias:cloudflare:workers=" + shim,
    "--outfile=" + bundle,
  ], { cwd: repoRoot, expectExit: 0 });
  const mod = await import(pathToFileURL(bundle).href + "?t=" + Date.now());
  return mod.parseMergeCandidateResult;
}

async function runAll(root) {
  const mergeFixture = await makeFixture(root, "merge", { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt" });
  const mergeTree = await expectedMergedTree(mergeFixture);
  const merge = await invokeHelper(mergeFixture, { method: "merge", message: "Merge pull request pr-a" });
  await assertCommit(mergeFixture, merge, { parents: [mergeFixture.base, mergeFixture.head], tree: mergeTree, generated: true });

  const squashFixture = await makeFixture(root, "squash", { sourceText: "squash source", targetText: "squash target", sourcePath: "source.txt", targetPath: "target.txt", coauthor: true });
  const squashTree = await expectedMergedTree(squashFixture);
  const squash = await invokeHelper(squashFixture, { method: "squash", message: "Squash pr-a" });
  await assertCommit(squashFixture, squash, { parents: [squashFixture.base], tree: squashTree, generated: true, messageIncludes: ["Co-authored-by: Source Author <source@example.invalid>", "Co-authored-by: Helper Friend <friend@example.invalid>"] });

  const rebaseFixture = await makeFixture(root, "rebase", { sourceText: "rebase source", targetText: "rebase target", sourcePath: "source.txt", targetPath: "target.txt", secondSource: true });
  const rebase = await invokeHelper(rebaseFixture, { method: "rebase", message: "ignored for rebase" });
  if (rebase.original_to_rebased.length !== rebaseFixture.sourceCommits.length) throw new Error("rebase did not report every source commit mapping");
  for (const [index, entry] of rebase.original_to_rebased.entries()) {
    if (entry.original !== rebaseFixture.sourceCommits[index]) throw new Error("rebase mapping original commit mismatch");
    if (entry.original === entry.rebased) throw new Error("rebase retained original commit oid");
    const committer = await gitNoReplace(["-C", rebaseFixture.gitDir, "show", "-s", "--format=%cn <%ce>", entry.rebased]);
    if (committer.stdout.trim() !== "GitFoundry Merge Bot <merge-bot@gitfoundry.invalid>") throw new Error("rebase did not use authenticated committer");
  }
  const rebaseTree = (await gitNoReplace(["-C", rebaseFixture.gitDir, "rev-parse", rebase.original_to_rebased.at(-1).rebased + "^{tree}"])).stdout.trim();
  await assertCommit(rebaseFixture, rebase, { parents: [rebase.original_to_rebased[0].rebased], tree: rebaseTree, generated: true });

  const ffFixture = await makeFixture(root, "fast-forward", { fastForward: true });
  const ffTree = (await gitNoReplace(["-C", ffFixture.gitDir, "rev-parse", ffFixture.head + "^{tree}"])).stdout.trim();
  const ff = await invokeHelper(ffFixture, { method: "fast_forward", message: "Fast forward" });
  if (ff.candidate_oid !== ffFixture.head) throw new Error("fast_forward candidate must be exactly H");
  await assertCommit(ffFixture, ff, { parents: [ffFixture.base], tree: ffTree, generated: false });

  const reused = await invokeHelper(mergeFixture, { method: "merge", message: "Merge pull request pr-a" });
  if (reused.candidate_oid !== merge.candidate_oid || reused.candidate_bytes_sha256 !== merge.candidate_bytes_sha256) throw new Error("identical request did not reuse persisted candidate");
  await assertCorruptArtifactRejected(root);
  await assertLinkedStateRejected(root);
  await assertScopeSubstitutionRejected(root);
  await assertConcurrentRequestsSerialized(root);
  await assertTamperedManifestRejected(mergeFixture, merge);
  const drift = await invokeHelper(mergeFixture, { method: "merge", message: "changed message" });
  if (drift.ok !== false || drift.status !== "stale_input") throw new Error("changed input on same operation did not refuse reuse");

  await assertOversizeOpenInputRejected(root);
  await assertAlternateOnlyObjectRejected(root);
  await assertHostileMergeDriverNotRun(root);

  const conflictFixture = await makeFixture(root, "conflict", { sourceText: "source", targetText: "target", sourcePath: "file.txt", targetPath: "file.txt" });
  const conflict = await invokeHelper(conflictFixture, { method: "merge", message: "Conflict" });
  if (conflict.ok !== false || conflict.status !== "conflict") throw new Error("conflict was not typed as conflict");

  const nonFfFixture = await makeFixture(root, "non-ff", { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt" });
  const nonFf = await invokeHelper(nonFfFixture, { method: "fast_forward", message: "Non ff" });
  if (nonFf.ok !== false || nonFf.status !== "non_fast_forward") throw new Error("non fast-forward was not typed correctly");

  const missingFixture = await makeFixture(root, "missing", { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt" });
  const missing = await invokeHelper(missingFixture, { method: "merge", message: "Missing", headSha: "9".repeat(40) });
  if (missing.ok !== false || missing.status !== "invalid_objects") throw new Error("missing object was not typed invalid_objects");

  const topologyFixture = await makeFixture(root, "unsupported-topology", { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt", mergeSource: true });
  const topology = await invokeHelper(topologyFixture, { method: "rebase", message: "Unsupported topology" });
  if (topology.ok !== false || topology.status !== "rejected" || topology.diagnostics[0]?.code !== "unsupported_topology") throw new Error("source merge topology was not explicitly rejected");

  const hostile = await makeFixture(root, "hostile", { sourceText: "safe source", targetText: "safe target", sourcePath: "source.txt", targetPath: "target.txt" });
  await installHostileRepoInputs(hostile);
  const hostileTree = await expectedMergedTree(hostile);
  const hostileResult = await invokeHelper(hostile, { method: "merge", message: "Hostile" });
  await assertCommit(hostile, hostileResult, { parents: [hostile.base, hostile.head], tree: hostileTree, generated: true });

  const symlinkFixture = await makeFixture(root, "symlink", { fastForward: true });
  const symlinkStateHost = join(symlinkFixture.hostFixtureRoot, "work", tenant, repo, op, "merge-candidates");
  await rm(symlinkStateHost, { recursive: true, force: true });
  await symlink("/tmp", symlinkStateHost);
  const symlinkResult = await invokeHelper(symlinkFixture, { method: "fast_forward", message: "Symlink" });
  if (symlinkResult.ok !== false || symlinkResult.status !== "rejected") throw new Error("symlink state path was not rejected");

  console.log(JSON.stringify({ ok: true, image, helper: "/usr/local/bin/gitfoundry-merge-candidate", artifact_root: root }));
}

async function makeFixture(root, name, options) {
  const fixtureRoot = join(root, name);
  const trustedGitDir = join(fixtureRoot, "work", tenant, repo, op, "trusted-git");
  const stateDir = join(fixtureRoot, "work", tenant, repo, op, "merge-candidates");
  await mkdir(trustedGitDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await git(["-C", trustedGitDir, "init", "-q"]);
  await git(["-C", trustedGitDir, "config", "user.name", "Fixture Author"]);
  await git(["-C", trustedGitDir, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(trustedGitDir, "base.txt"), "base\n", "utf8");
  await git(["-C", trustedGitDir, "add", "."]);
  await git(["-C", trustedGitDir, "commit", "-q", "-m", "base"]);
  const base = (await gitNoReplace(["-C", trustedGitDir, "rev-parse", "HEAD"])).stdout.trim();
  let head;
  const sourceCommits = [];
  if (options.fastForward) {
    await writeFile(join(trustedGitDir, "ff.txt"), "ff\n", "utf8");
    await git(["-C", trustedGitDir, "add", "."]);
    await git(["-C", trustedGitDir, "commit", "-q", "-m", "ff"]);
    head = (await gitNoReplace(["-C", trustedGitDir, "rev-parse", "HEAD"])).stdout.trim();
  } else {
    await git(["-C", trustedGitDir, "checkout", "-q", "-b", "source", base]);
    await writeFile(join(trustedGitDir, options.sourcePath), options.sourceText + "\n", "utf8");
    await git(["-C", trustedGitDir, "add", "."]);
    if (options.coauthor) {
      await git(["-C", trustedGitDir, "commit", "-q", "--author", "Source Author <source@example.invalid>", "-m", "source one", "-m", "Co-authored-by: Helper Friend <friend@example.invalid>"]);
    } else {
      await git(["-C", trustedGitDir, "commit", "-q", "-m", "source one"]);
    }
    sourceCommits.push((await gitNoReplace(["-C", trustedGitDir, "rev-parse", "HEAD"])).stdout.trim());
    if (options.secondSource) {
      await writeFile(join(trustedGitDir, "source-two.txt"), "source two\n", "utf8");
      await git(["-C", trustedGitDir, "add", "."]);
      await git(["-C", trustedGitDir, "commit", "-q", "-m", "source two"]);
      sourceCommits.push((await gitNoReplace(["-C", trustedGitDir, "rev-parse", "HEAD"])).stdout.trim());
    }
    if (options.mergeSource) {
      const sourceTip = (await gitNoReplace(["-C", trustedGitDir, "rev-parse", "HEAD"])).stdout.trim();
      await git(["-C", trustedGitDir, "checkout", "-q", "-b", "source-side", sourceCommits[0]]);
      await writeFile(join(trustedGitDir, "side.txt"), "side\n", "utf8");
      await git(["-C", trustedGitDir, "add", "."]);
      await git(["-C", trustedGitDir, "commit", "-q", "-m", "side source"]);
      const side = (await gitNoReplace(["-C", trustedGitDir, "rev-parse", "HEAD"])).stdout.trim();
      await git(["-C", trustedGitDir, "checkout", "-q", "source"]);
      await git(["-C", trustedGitDir, "merge", "--no-ff", "-q", "-m", "merge side", side]);
      sourceCommits.push(side);
      sourceCommits.push((await gitNoReplace(["-C", trustedGitDir, "rev-parse", "HEAD"])).stdout.trim());
    }
    head = (await gitNoReplace(["-C", trustedGitDir, "rev-parse", "HEAD"])).stdout.trim();
    await git(["-C", trustedGitDir, "checkout", "-q", "-b", "target", base]);
    await writeFile(join(trustedGitDir, options.targetPath), options.targetText + "\n", "utf8");
    await git(["-C", trustedGitDir, "add", "."]);
    await git(["-C", trustedGitDir, "commit", "-q", "-m", "target"]);
    const target = (await gitNoReplace(["-C", trustedGitDir, "rev-parse", "HEAD"])).stdout.trim();
    return { gitDir: trustedGitDir, trustedGitDir: containerPath(fixtureRoot, trustedGitDir), stateDir: containerPath(fixtureRoot, stateDir), hostFixtureRoot: fixtureRoot, base: target, head, sourceCommits };
  }
  return { gitDir: trustedGitDir, trustedGitDir: containerPath(fixtureRoot, trustedGitDir), stateDir: containerPath(fixtureRoot, stateDir), hostFixtureRoot: fixtureRoot, base, head, sourceCommits };
}

async function installHostileRepoInputs(fixture) {
  await writeFile(join(fixture.gitDir, ".git", "config"), "[user]\n\tname = Hostile\n[commit]\n\tgpgsign = true\n[filter \"bad\"]\n\tclean = sh -c 'echo hostile-filter >&2; exit 1'\n[merge \"evil\"]\n\tdriver = sh -c 'echo hostile-merge >&2; exit 1'\n", "utf8");
  await writeFile(join(fixture.gitDir, ".gitattributes"), "* filter=bad\nsource.txt merge=evil\n", "utf8");
  await mkdir(join(fixture.gitDir, ".git", "hooks"), { recursive: true });
  await writeFile(join(fixture.gitDir, ".git", "hooks", "post-commit"), "#!/bin/sh\necho hostile-hook >&2\nexit 1\n", "utf8");
  const evilTree = (await gitNoReplace(["-C", fixture.gitDir, "rev-parse", fixture.base + "^{tree}"])).stdout.trim();
  const evil = await run("git", ["-C", fixture.gitDir, "commit-tree", evilTree, "-m", "evil replacement"], { expectExit: 0, env: { GIT_AUTHOR_NAME: "Evil", GIT_AUTHOR_EMAIL: "evil@example.invalid", GIT_COMMITTER_NAME: "Evil", GIT_COMMITTER_EMAIL: "evil@example.invalid" } });
  await git(["-C", fixture.gitDir, "replace", fixture.head, evil.stdout.trim()]);
}

async function invokeHelper(fixture, options) {
  const request = {
    frame,
    tenant_id: tenant,
    repository_id: repo,
    operation_id: op,
    pull_request_id: "pr-a",
    pull_request_version: 7,
    method: options.method,
    head_sha: options.headSha || fixture.head,
    base_sha: options.baseSha || fixture.base,
    trusted_git_dir: fixture.trustedGitDir,
    state_dir: fixture.stateDir,
    committer: { name: "GitFoundry Merge Bot", email: "merge-bot@gitfoundry.invalid", committed_at: "2026-10-08T00:00:00.000Z" },
    message: options.message,
    options: { preserve_source_commits: true, signing: "disabled", external_filters: "disabled", hooks: "disabled", replace_refs: "disabled" },
  };
  const stdin = JSON.stringify(request) + "\n";
  const requestSha = sha256(stdin);
  fixture.lastStdin = stdin;
  fixture.lastRequestSha = requestSha;
  const beforeRefs = await refsSnapshot(fixture.gitDir);
  const result = await run("docker", [
    "run", "--rm", "-i", "--platform", "linux/amd64", "--network", "none",
    ...dockerEnvArgs(hostileEnv()),
    "--mount", `type=bind,source=${fixture.hostFixtureRoot}/work,target=/work`,
    "--workdir", request.trusted_git_dir,
    "--entrypoint", "/usr/local/bin/gitfoundry-merge-candidate",
    image, "prepare", "--request-format", frame, "--request-sha256", requestSha,
  ], { input: stdin, expectExit: 0 });
  const afterRefs = await refsSnapshot(fixture.gitDir);
  if (beforeRefs !== afterRefs) throw new Error("helper mutated refs\nbefore=" + beforeRefs + "\nafter=" + afterRefs);
  const lines = result.stdout.trim().split(/\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("helper wrote unexpected stdout: " + JSON.stringify(result.stdout) + " stderr=" + JSON.stringify(result.stderr));
  const parsed = JSON.parse(lines[0]);
  if (parsed.frame !== resultFrame) throw new Error("wrong result frame");
  parseWorkerResult(result.stdout, workerInputFromRequest(request));
  return parsed;
}

async function assertTamperedManifestRejected(fixture, original) {
  const manifestPath = join(fixture.hostFixtureRoot, "work", tenant, repo, op, original.state_ref);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.result = { ...manifest.result, candidate_oid: "8".repeat(40), candidate_tree: "7".repeat(40), candidate_bytes_sha256: "6".repeat(64) };
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n", "utf8");
  const result = await invokeHelper(fixture, { method: "merge", message: "Merge pull request pr-a" });
  if (result.ok !== false || result.status !== "rejected") throw new Error("tampered manifest reuse was not rejected");
}

async function assertCorruptArtifactRejected(root) {
  const fixture = await makeFixture(root, "corrupt-artifact", { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt" });
  const result = await invokeHelper(fixture, { method: "merge", message: "Corrupt artifact" });
  const manifestPath = join(fixture.hostFixtureRoot, "work", tenant, repo, op, result.state_ref);
  const rawPath = join(dirname(manifestPath), "candidate.commit");
  await writeFile(rawPath, "corrupt\n", "utf8");
  const corrupt = await invokeHelper(fixture, { method: "merge", message: "Corrupt artifact" });
  if (corrupt.ok !== false || corrupt.status !== "rejected") throw new Error("corrupt persisted candidate.commit was reused: " + JSON.stringify(corrupt));

  const missingFixture = await makeFixture(root, "missing-artifact", { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt" });
  const missingResult = await invokeHelper(missingFixture, { method: "merge", message: "Missing artifact" });
  const missingManifestPath = join(missingFixture.hostFixtureRoot, "work", tenant, repo, op, missingResult.state_ref);
  await unlink(join(dirname(missingManifestPath), "candidate.commit"));
  const missing = await invokeHelper(missingFixture, { method: "merge", message: "Missing artifact" });
  if (missing.ok !== false || missing.status !== "rejected") throw new Error("missing persisted candidate.commit was reused: " + JSON.stringify(missing));
}


async function assertLinkedStateRejected(root) {
  for (const kind of ["artifact-hardlink", "manifest-symlink", "guard-symlink"]) {
    const fixture = await makeFixture(root, kind, { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt" });
    const result = await invokeHelper(fixture, { method: "merge", message: "Linked state" });
    if (result.ok !== true) throw new Error("linked-state baseline was not prepared");
    const manifestPath = join(fixture.hostFixtureRoot, "work", tenant, repo, op, result.state_ref);
    const guardPath = join(fixture.hostFixtureRoot, "work", tenant, repo, op, "merge-candidates", "operation-request-sha256");
    const path = kind === "artifact-hardlink" ? join(dirname(manifestPath), "candidate.commit") : kind === "manifest-symlink" ? manifestPath : guardPath;
    await run("docker", [
      "run", "--rm", "--platform", "linux/amd64", "--network", "none",
      "--mount", `type=bind,source=${fixture.hostFixtureRoot}/work,target=/work`,
      "--entrypoint", "perl", image, "-e",
      "my ($path,$kind)=@ARGV; my $alias=$path.'.alias'; if ($kind eq 'artifact-hardlink') { link($path,$alias) or die 'link mutation failed'; my @s=stat($path); die 'hardlink mutation not visible in Linux' unless @s && $s[3]>1; } else { rename($path,$alias) or die 'rename mutation failed'; my $target=$alias; $target =~ s{.*/}{}; symlink($target,$path) or die 'symlink mutation failed'; die 'symlink mutation not visible in Linux' unless -l $path; }",
      containerPath(fixture.hostFixtureRoot, path), kind,
    ], { expectExit: 0 });

    const linked = await invokeHelper(fixture, { method: "merge", message: "Linked state" });
    if (linked.ok !== false || linked.status !== "rejected") throw new Error(kind + " state was reused: " + JSON.stringify(linked));
  }
}

async function assertScopeSubstitutionRejected(root) {
  const fixture = await makeFixture(root, "scope-substitution", { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt" });
  const result = await invokeHelper(fixture, { method: "merge", message: "Scope substitution" });
  const manifestPath = join(fixture.hostFixtureRoot, "work", tenant, repo, op, result.state_ref);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.result = { ...manifest.result, tenant_id: "tenant-b" };
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n", "utf8");
  const scoped = await invokeHelper(fixture, { method: "merge", message: "Scope substitution" });
  if (scoped.ok !== false || scoped.status !== "rejected") throw new Error("scope-substituted manifest was reused: " + JSON.stringify(scoped));
}

async function assertConcurrentRequestsSerialized(root) {
  const identicalFixture = await makeFixture(root, "concurrent-identical", { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt" });
  const identical = await Promise.all([
    invokeHelper(identicalFixture, { method: "merge", message: "Concurrent identical" }),
    invokeHelper(identicalFixture, { method: "merge", message: "Concurrent identical" }),
  ]);
  const identicalSuccesses = identical.filter((r) => r.ok === true);
  if (identicalSuccesses.length === 2 && identicalSuccesses[0].candidate_oid !== identicalSuccesses[1].candidate_oid) throw new Error("concurrent identical requests produced different candidates");
  if (identical.some((r) => r.ok !== true && r.status !== "rejected")) throw new Error("concurrent identical request returned unexpected status: " + JSON.stringify(identical));

  const differentFixture = await makeFixture(root, "concurrent-different", { sourceText: "source", targetText: "target", sourcePath: "source.txt", targetPath: "target.txt" });
  const different = await Promise.all([
    invokeHelper(differentFixture, { method: "merge", message: "Concurrent A" }),
    invokeHelper(differentFixture, { method: "merge", message: "Concurrent B" }),
  ]);
  const differentSuccesses = different.filter((r) => r.ok === true);
  if (differentSuccesses.length > 1) throw new Error("concurrent different requests both succeeded: " + JSON.stringify(different));
  if (different.some((r) => r.ok !== true && !["rejected", "stale_input"].includes(r.status))) throw new Error("concurrent different request returned unexpected status: " + JSON.stringify(different));
}

async function assertHostileMergeDriverNotRun(root) {
  const fixture = await makeFixture(root, "hostile-merge-driver", { sourceText: "source", targetText: "target", sourcePath: "file.txt", targetPath: "file.txt" });
  const marker = join(fixture.hostFixtureRoot, "work", "merge-driver-marker");
  await writeFile(join(fixture.gitDir, ".gitattributes"), "file.txt merge=evil\n", "utf8");
  await git(["-C", fixture.gitDir, "config", "merge.evil.driver", `sh -c 'printf ran > ${containerPath(fixture.hostFixtureRoot, marker)}; exit 1'`]);
  const result = await invokeHelper(fixture, { method: "merge", message: "Hostile merge driver" });
  if (result.ok !== false || !["conflict", "rejected"].includes(result.status)) throw new Error("shared-path hostile merge did not fail closed: " + JSON.stringify(result));
  try {
    await access(marker, constants.F_OK);
    throw new Error("hostile merge driver marker was created");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertOversizeOpenInputRejected(root) {
  const fixture = await makeFixture(root, "oversize", { fastForward: true });
  const created = await run("docker", [
    "create", "-i", "--platform", "linux/amd64", "--network", "none",
    "--mount", `type=bind,source=${fixture.hostFixtureRoot}/work,target=/work`,
    "--workdir", fixture.trustedGitDir,
    "--entrypoint", "/usr/local/bin/gitfoundry-merge-candidate",
    image, "prepare", "--request-format", frame, "--request-sha256", "0".repeat(64),
  ], { expectExit: 0 });
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error("invalid owned stdin container ID");
  try {
    const child = spawn("docker", ["start", "--attach", "--interactive", containerId], {
      cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks = [];
    child.stdout.resume();
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.stdin.on("error", () => {});
    const startupDeadline = performance.now() + 30000;
    let running = false;
    while (performance.now() < startupDeadline) {
      const state = await run("docker", ["inspect", "--format", "{{.State.Running}}", containerId], { expectExit: 0 });
      if (state.stdout.trim() === "true") { running = true; break; }
      if (child.exitCode !== null || child.signalCode !== null) break;
    }
    if (!running) throw new Error("stdin fixture container did not reach running state: " + Buffer.concat(stderrChunks).toString("utf8"));
    child.stdin.write("{" + "x".repeat(9000));
    const exit = await waitForExitOrKill(child, 5000);
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (exit.timedOut) throw new Error("oversized open stdin did not fail before EOF after confirmed startup");
    if (exit.code === 0 || !stderr.includes("request exceeds stdin bound")) throw new Error("oversized stdin did not return the bounded diagnostic: " + stderr);
  } finally {
    await run("docker", ["rm", "--force", containerId], { expectExit: 0 });
  }
}


async function assertAlternateOnlyObjectRejected(root) {
  const fixture = await makeFixture(root, "alternate-only", { fastForward: true });
  const foreign = join(fixture.hostFixtureRoot, "work", "foreign");
  await mkdir(foreign, { recursive: true });
  await git(["-C", foreign, "init", "-q"]);
  await git(["-C", foreign, "config", "user.name", "Foreign"]);
  await git(["-C", foreign, "config", "user.email", "foreign@example.invalid"]);
  await writeFile(join(foreign, "foreign.txt"), "foreign\n", "utf8");
  await git(["-C", foreign, "add", "."]);
  await git(["-C", foreign, "commit", "-q", "-m", "foreign"]);
  const foreignHead = (await gitNoReplace(["-C", foreign, "rev-parse", "HEAD"])).stdout.trim();
  await mkdir(join(fixture.gitDir, ".git", "objects", "info"), { recursive: true });
  await writeFile(join(fixture.gitDir, ".git", "objects", "info", "alternates"), containerPath(fixture.hostFixtureRoot, join(foreign, ".git", "objects")) + "\n", "utf8");
  const result = await invokeHelper(fixture, { method: "fast_forward", message: "Foreign alternate", headSha: foreignHead });
  if (result.ok !== false || result.status !== "invalid_objects") throw new Error("alternate-only foreign commit was admitted: " + JSON.stringify(result));
}

function waitForExitOrKill(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ timedOut: true, code: null, signal: "SIGKILL" });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code, signal });
    });
  });
}

function workerInputFromRequest(request) {
  return { commandId: "cmd-a", tenantId: tenant, repositoryId: repo, operationId: op, fenceToken: "fence-a", pullRequestId: request.pull_request_id, pullRequestVersion: request.pull_request_version, headSha: request.head_sha, baseSha: request.base_sha, method: request.method, committerName: request.committer.name, committerEmail: request.committer.email, committedAt: request.committer.committed_at, message: request.message };
}

function dockerEnvArgs(env) {
  return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

function hostileEnv() {
  return { GIT_CONFIG_GLOBAL: "/tmp/hostile-global", GIT_CONFIG_NOSYSTEM: "0", GIT_DIR: "/tmp/bad", GIT_WORK_TREE: "/tmp/bad", GIT_INDEX_FILE: "/tmp/bad-index", GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/bad-objects", GIT_REPLACE_REF_BASE: "refs/replace" };
}

async function assertCommit(fixture, result, expected) {
  if (result.ok !== true) throw new Error("expected prepared result, got " + JSON.stringify(result));
  if (result.candidate_tree !== expected.tree) throw new Error(`candidate_tree ${result.candidate_tree} !== independently expected tree ${expected.tree}`);
  const tree = (await gitNoReplace(["-C", fixture.gitDir, "rev-parse", result.candidate_oid + "^{tree}"])).stdout.trim();
  if (tree !== result.candidate_tree) throw new Error("candidate tree mismatch");
  const expectedEntries = await treeEntries(fixture.gitDir, expected.tree);
  const candidateEntries = await treeEntries(fixture.gitDir, result.candidate_tree);
  if (JSON.stringify(candidateEntries) !== JSON.stringify(expectedEntries)) throw new Error("candidate tree entries/blobs mismatch");
  const parents = (await gitNoReplace(["-C", fixture.gitDir, "show", "-s", "--format=%P", result.candidate_oid])).stdout.trim().split(/\s+/).filter(Boolean);
  if (parents.join(" ") !== expected.parents.join(" ")) throw new Error(`parents mismatch ${parents.join(" ")} !== ${expected.parents.join(" ")}`);
  const committer = (await gitNoReplace(["-C", fixture.gitDir, "show", "-s", "--format=%cn <%ce>", result.candidate_oid])).stdout.trim();
  if (expected.generated && committer !== "GitFoundry Merge Bot <merge-bot@gitfoundry.invalid>") throw new Error("generated commit did not use authenticated committer");
  if (expected.messageIncludes) {
    const message = (await gitNoReplace(["-C", fixture.gitDir, "show", "-s", "--format=%B", result.candidate_oid])).stdout;
    for (const required of expected.messageIncludes) {
      if (!message.includes(required)) throw new Error("candidate message lost expected trailer: " + required);
    }
  }
  const raw = await run("git", ["-C", fixture.gitDir, "cat-file", "commit", result.candidate_oid], { expectExit: 0, env: { GIT_NO_REPLACE_OBJECTS: "1" } });
  if (sha256(raw.stdoutBuffer) !== result.candidate_bytes_sha256) throw new Error("candidate raw bytes digest mismatch");
  const manifestPath = join(fixture.hostFixtureRoot, "work", tenant, repo, op, result.state_ref);
  await access(manifestPath, constants.F_OK);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.candidate_oid !== result.candidate_oid || manifest.result.git_version !== result.git_version || !manifest.observed_git_version) throw new Error("manifest does not bind candidate/result/observed Git version");
  const beforeExportRefs = await refsSnapshot(fixture.gitDir);
  const captured = {};
  for (const kind of ["manifest", "commit", "pack"]) {
    const exported = await run("docker", [
      "run", "--rm", "-i", "--platform", "linux/amd64", "--network", "none",
      "--mount", `type=bind,source=${fixture.hostFixtureRoot}/work,target=/work`,
      "--workdir", fixture.trustedGitDir,
      "--entrypoint", "/usr/local/bin/gitfoundry-merge-candidate",
      image, "export-" + kind, "--request-format", frame, "--request-sha256", fixture.lastRequestSha
    ], { input: fixture.lastStdin, expectExit: 0 });
    captured[kind] = exported.stdoutBuffer;
  }
  if (!captured.manifest.equals(await readFile(manifestPath))) throw new Error("exported manifest bytes differ");
  if (!captured.commit.equals(raw.stdoutBuffer)) throw new Error("exported commit differs from actual Git bytes");
  if (sha256(captured.pack) !== manifest.bundle_sha256) throw new Error("exported pack digest differs");
  if (manifest.candidate_size_bytes !== captured.commit.length || manifest.pack_size_bytes !== captured.pack.length) throw new Error("exported artifact sizes are not measured");
  if ((await refsSnapshot(fixture.gitDir)) !== beforeExportRefs) throw new Error("candidate export changed refs");

}

async function expectedMergedTree(fixture) {
  const result = await gitNoReplace(["-C", fixture.gitDir, "merge-tree", "--write-tree", fixture.base, fixture.head]);
  return result.stdout.trim();
}

async function treeEntries(gitDir, tree) {
  const result = await gitNoReplace(["-C", gitDir, "ls-tree", "-r", "--format=%(path)%x00%(objectname)", tree]);
  return result.stdout.trim().split(/\n/).filter(Boolean).sort();
}

async function refsSnapshot(gitDir) {
  const result = await gitNoReplace(["-C", gitDir, "for-each-ref", "--format=%(refname) %(objectname)", "refs"]);
  return result.stdout.trim().split(/\n/).filter(Boolean).sort().join("\n");
}

function containerPath(fixtureRoot, path) {
  return "/work" + path.slice(join(fixtureRoot, "work").length);
}

async function git(args, options = {}) {
  return await run("git", args, { ...options, expectExit: Object.hasOwn(options, "expectExit") ? options.expectExit : 0 });
}

async function gitNoReplace(args, options = {}) {
  return await git(args, { ...options, env: { ...(options.env || {}), GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd || repoRoot, env: { ...process.env, ...(options.env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  const [code, signal] = await once(child, "exit");
  const stdoutBuffer = Buffer.concat(stdoutChunks);
  const stderrBuffer = Buffer.concat(stderrChunks);
  const result = { code, signal, stdout: stdoutBuffer.toString("utf8"), stdoutBuffer, stderr: stderrBuffer.toString("utf8") };
  if (options.expectExit !== undefined && code !== options.expectExit) throw new Error(command + " " + args.join(" ") + " exited " + code + " signal=" + signal + " stdout=" + JSON.stringify(result.stdout) + " stderr=" + JSON.stringify(result.stderr));
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error) => {
  console.error(error && error.stack || String(error));
  process.exit(1);
});
