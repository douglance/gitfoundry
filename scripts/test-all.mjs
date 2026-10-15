#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const pnpm = process.env.GFY_TEST_PNPM || "pnpm";
const cargo = process.env.GFY_TEST_CARGO || "cargo";
const docker = process.env.GFY_TEST_DOCKER || "docker";
const python = process.env.GFY_TEST_PYTHON || "python3";
const bash = process.env.GFY_TEST_BASH || "bash";

const helperImage = process.env.GFY_TEST_GIT_HELPER_IMAGE || "gitfoundry-p0-git-helper:local";
const ciRunnerImage = process.env.GFY_TEST_CI_RUNNER_IMAGE || "gitfoundry-p0-ci-runner:local";
const linuxRunnerImage = process.env.GFY_TEST_LINUX_RUNNER_IMAGE || "gitfoundry-p0-linux-runner:local";
const rpcImage = process.env.GFY_TEST_FORGE_RPC_IMAGE || "gitfoundry-helper:fork-rpc";
const candidateCiImage = process.env.GFY_TEST_CANDIDATE_CI_IMAGE || "gitfoundry-candidate-ci-test:local";
const candidateCiHelperImage = process.env.GFY_TEST_CANDIDATE_CI_HELPER_IMAGE || "gitfoundry-candidate-ci-helper-test:local";
const sourceHydrateImage = process.env.GFY_TEST_SOURCE_HYDRATE_IMAGE || "gitfoundry-source-hydrate-test:local";
const mergeCandidateImage = process.env.GFY_TEST_MERGE_CANDIDATE_IMAGE || "gitfoundry-merge-candidate-test:local";

const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  ".wrangler",
  "dist",
  "node_modules",
  "target",
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function exists(relativePath) {
  return existsSync(path.join(root, relativePath));
}

function discoverFiles(startDirectory, predicate) {
  const absoluteStart = path.join(root, startDirectory);
  if (!existsSync(absoluteStart)) {
    return [];
  }

  const results = [];
  const stack = [absoluteStart];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(current, entry.name);
      const rel = relative(filePath);
      if (predicate(rel)) {
        results.push(rel);
      }
    }
  }

  return results.sort();
}

const scriptTestFiles = discoverFiles("scripts", (filePath) => filePath.endsWith(".test.mjs"));
const standaloneScriptFiles = unique([
  exists("scripts/test-forge-rpc.mjs") ? "scripts/test-forge-rpc.mjs" : null,
  ...discoverFiles(
    "scripts",
    (filePath) =>
      filePath.startsWith("scripts/local-forge-runner") &&
      filePath.includes("test") &&
      filePath.endsWith(".mjs") &&
      !scriptTestFiles.includes(filePath),
  ),
]);
const integrationTestFiles = discoverFiles(
  "tests/integration",
  (filePath) =>
    filePath.endsWith(".test.mjs") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.tsx"),
);
const integrationRunMjsFiles = discoverFiles("tests/integration", (filePath) => filePath.endsWith("/run.mjs"));
const integrationRunShFiles = discoverFiles("tests/integration", (filePath) => filePath.endsWith("/run.sh"));
const planningValidator = "tools/validate_planning.py";
const cloudLiveGateScript = "scripts/check-cloud-live.mjs";

const dockerFixtures = [
  {
    name: "git-helper",
    dockerfile: "images/git-helper/Dockerfile",
    context: "images",
    tags: unique([helperImage, "gitfoundry-helper:test", rpcImage, "gitfoundry-p0-git-helper:local"]),
  },
  {
    name: "ci-runner",
    dockerfile: "images/ci-runner/Dockerfile",
    context: "images",
    tags: unique([ciRunnerImage, "gitfoundry-ci:test", "gitfoundry-p0-ci-runner:local"]),
  },
  {
    name: "linux-runner",
    dockerfile: "images/linux-runner/Dockerfile",
    context: "images/linux-runner",
    tags: unique([linuxRunnerImage, "gitfoundry-linux-runner:test", "gitfoundry-p0-linux-runner:local"]),
  },
];

const inventory = {
  packageScripts: ["build", "test", "test:all", "check:contracts", "check", "dev"],
  workspacePackageTests: [
    "apps/api-worker/package.json test",
    "apps/web/package.json test",
    "packages/contracts/package.json test",
    "packages/core/package.json test",
  ],
  scriptTestFiles,
  standaloneScriptFiles,
  integrationTestFiles,
  integrationRunMjsFiles,
  integrationRunShFiles,
  rustWorkspaceManifests: ["Cargo.toml"],
  rustSupervisorManifest: "images/linux-runner/supervisor/Cargo.toml",
  dockerFixtures,
  deterministicRuntimeGates: [
    "scripts/check-worker-runtime.mjs",
    "scripts/check-git-provider-runtime.mjs",
    "scripts/check-git-egress-runtime.mjs",
    "scripts/check-gfy-runtime.mjs",
  ],
  planningValidator: exists(planningValidator) ? planningValidator : null,
  cloudLiveGate: exists(cloudLiveGateScript) ? cloudLiveGateScript : null,
};

function selectedEnv(extra = {}) {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "CI",
    "TERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "PNPM_HOME",
    "PNPM_STORE_DIR",
    "COREPACK_HOME",
    "CHROME_BIN",
    "GOOGLE_CHROME_BIN",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "BUILDKIT_PROGRESS",
    "RUSTUP_HOME",
    "CARGO_HOME",
  ];
  const env = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GFY_TEST_") && value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

function phase(name, argv, options = {}) {
  return {
    name,
    argv,
    required: options.required ?? true,
    reason: options.reason,
    env: options.env,
  };
}

function notConfiguredPhase(name, reason) {
  return {
    name,
    argv: [],
    required: false,
    configured: false,
    reason,
  };
}

function dockerBuildArgs(fixture) {
  return [
    "build",
    "--platform",
    "linux/amd64",
    ...fixture.tags.flatMap((tag) => ["--tag", tag]),
    "--file",
    fixture.dockerfile,
    fixture.context,
  ];
}

function integrationRunEnv(filePath) {
  if (filePath.endsWith("candidate-ci/run.mjs")) {
    return {
      GITFOUNDRY_CANDIDATE_CI_IMAGE: candidateCiImage,
      GITFOUNDRY_CANDIDATE_CI_HELPER_IMAGE: candidateCiHelperImage,
    };
  }

  if (filePath.endsWith("git-helper-http/run.mjs")) {
    return { GFY_HELPER_IMAGE: helperImage };
  }

  if (filePath.endsWith("git-helper-publication/run.mjs")) {
    return {
      GFY_HELPER_IMAGE: helperImage,
      GFY_HELPER_PACKAGED: "1",
      GFY_HELPER_TEST_MODE: "1",
    };
  }

  if (filePath.endsWith("linux-execution/run.sh")) {
    return {
      IMAGE_PREFIX: "gitfoundry-p0",
      PLATFORM: "linux/amd64",
      GFY_HELPER_TEST_MODE: "1",
    };
  }

  if (filePath.endsWith("source-hydration/run.mjs")) {
    return { GITFOUNDRY_SOURCE_HYDRATE_IMAGE: sourceHydrateImage };
  }

  if (filePath.endsWith("merge-candidate/run.mjs")) {
    return { GFY_MERGE_CANDIDATE_IMAGE: mergeCandidateImage };
  }

  return {};
}

function standaloneScriptEnv(filePath) {
  if (filePath === "scripts/test-forge-rpc.mjs") {
    return { GFY_FORGE_RPC_TEST_IMAGE: rpcImage };
  }
  return {};
}

function buildPhases() {
  const phases = [
    phase("node-dependencies", [pnpm, "install", "--frozen-lockfile", ...(process.env.PNPM_STORE_DIR ? ["--store-dir", process.env.PNPM_STORE_DIR] : [])]),
    phase("workspace-build", [pnpm, "-r", "build"]),
    phase("cloudflare-provisioning-typecheck", [pnpm, "--dir", "apps/api-worker", "exec", "tsc", "-p", "tsconfig.alchemy.json"]),
    phase("rust-toolchain-cache-env", [
      node,
      "-e",
      "if (!process.env.RUSTUP_HOME || !process.env.CARGO_HOME) { console.error('RUSTUP_HOME and CARGO_HOME must be supplied by the gfy local-run selected env'); process.exit(1); }",
    ]),
    phase("rust-dependencies", [cargo, "fetch", "--locked"]),
    phase("supervisor-rust-dependencies", [
      cargo,
      "fetch",
      "--locked",
      "--manifest-path",
      "images/linux-runner/supervisor/Cargo.toml",
    ]),
    ...dockerFixtures.map((fixture) =>
      phase(`docker-${fixture.name}-fixture`, [docker, ...dockerBuildArgs(fixture)]),
    ),
    phase("workspace-js-tests", [pnpm, "-r", "test"]),
  ];

  const nodeTestFiles = scriptTestFiles.filter(file => /from\s+[\'"]node:test[\'"]/.test(readFileSync(path.join(root, file), "utf8")));
  const vitestFiles = scriptTestFiles.filter(file => !nodeTestFiles.includes(file));
  if (nodeTestFiles.length > 0) phases.push(phase("script-node-tests", [node, "--test", ...nodeTestFiles]));
  if (vitestFiles.length > 0) phases.push(phase("script-vitest-tests", [pnpm, "exec", "vitest", "run", ...vitestFiles]));

  for (const filePath of standaloneScriptFiles) {
    phases.push(
      phase(`standalone-${path.basename(filePath, ".mjs")}`, [node, filePath], {
        env: standaloneScriptEnv(filePath),
      }),
    );
  }

  if (integrationTestFiles.length > 0) {
    phases.push(phase("integration-vitest-tests", [pnpm, "exec", "vitest", "run", ...integrationTestFiles]));
  }

  for (const filePath of integrationRunMjsFiles) {
    const parentName = path.basename(path.dirname(filePath));
    phases.push(
      phase(`integration-${parentName}-run-mjs`, [node, filePath], {
        env: integrationRunEnv(filePath),
      }),
    );
  }

  for (const filePath of integrationRunShFiles) {
    const parentName = path.basename(path.dirname(filePath));
    phases.push(
      phase(`integration-${parentName}-run-sh`, [bash, filePath], {
        env: integrationRunEnv(filePath),
      }),
    );
  }

  phases.push(
    phase("web-browser-tests", [pnpm, "--filter", "@gitfoundry/web", "test:browser"]),
    phase("contract-source-check", [node, "scripts/verify-contract-source.mjs"]),
    phase("rust-workspace-tests", [cargo, "test", "--workspace", "--locked"]),
    phase("supervisor-rust-tests", [
      cargo,
      "test",
      "--locked",
      "--manifest-path",
      "images/linux-runner/supervisor/Cargo.toml",
    ]),
    phase("gfy-release-build", [cargo, "build", "--release", "--locked", "-p", "gfy"]),
    phase("persistent-full-stack-browser-check", [node, "scripts/check-full-stack.mjs"]),
    phase("mcp-worker-release-build", ["worker-build", "--release", "--no-opt", "--out-dir", "../../target/p0-remote-worker-build", "crates/mcp-worker", "--locked"]),
    phase("mcp-tenant-header-runtime-check", [node, "crates/mcp-worker/tests/tenant-header-runtime.mjs"]),
    phase("worker-runtime-check", [node, "scripts/check-worker-runtime.mjs"]),
    phase("git-provider-runtime-check", [node, "scripts/check-git-provider-runtime.mjs"]),
    phase("git-egress-runtime-check", [node, "scripts/check-git-egress-runtime.mjs"]),
    phase("gfy-runtime-check", [node, "scripts/check-gfy-runtime-clean.mjs"]),
  );

  if (inventory.planningValidator) {
    phases.push(phase("planning-validator", [python, planningValidator, "--bundle", "--self-test"]));
  }

  if (process.env.GFY_TEST_CLOUD_LIVE === "1") {
    if (inventory.cloudLiveGate) {
      phases.push(phase("cloud-live-gates", [node, cloudLiveGateScript]));
    } else {
      phases.push({
        name: "cloud-live-gates",
        argv: [],
        required: true,
        configured: false,
        reason: "GFY_TEST_CLOUD_LIVE=1 was set, but no repository-owned cloud live gate script is present.",
      });
    }
  } else {
    phases.push(
      notConfiguredPhase(
        "cloud-live-gates",
        "Live Cloudflare gates are not configured; this harness runs local deterministic gates only and makes no live-cloud claim.",
      ),
    );
  }

  return phases;
}

function printJson(event) {
  console.log(JSON.stringify(event));
}

async function runPhase(item) {
  const startedAt = Date.now();

  if (item.configured === false) {
    const outcome = item.required ? "not_run" : "not_configured";
    const result = {
      name: item.name,
      required: item.required,
      outcome,
      exitCode: null,
      signal: null,
      durationMs: 0,
      reason: item.reason,
      argv: item.argv,
    };
    printJson({ event: "phase_end", ...result });
    return result;
  }

  if (!Array.isArray(item.argv) || item.argv.length === 0) {
    const result = {
      name: item.name,
      required: item.required,
      outcome: "not_run",
      exitCode: null,
      signal: null,
      durationMs: 0,
      reason: item.reason || "phase has no argv",
      argv: item.argv || [],
    };
    printJson({ event: "phase_end", ...result });
    return result;
  }

  printJson({ event: "phase_start", name: item.name, required: item.required, argv: item.argv });

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      printJson({ event: "phase_end", ...result });
      resolve(result);
    };

    const [command, ...args] = item.argv;
    const child = spawn(command, args, {
      cwd: root,
      env: selectedEnv(item.env),
      shell: false,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      finish({
        name: item.name,
        required: item.required,
        outcome: "failed",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        reason: error.message,
        argv: item.argv,
      });
    });

    child.on("close", (exitCode, signal) => {
      finish({
        name: item.name,
        required: item.required,
        outcome: exitCode === 0 && signal === null ? "passed" : "failed",
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        reason: item.reason,
        argv: item.argv,
      });
    });
  });
}

const phases = buildPhases();

if (process.argv.includes("--list")) {
  console.log(JSON.stringify({ inventory, phases: phases.map(({ env: _env, ...item }) => item) }));
  process.exit(0);
}

printJson({ event: "inventory", inventory });

const results = [];
for (const item of phases) {
  results.push(await runPhase(item));
}

const requiredFailures = results.filter((result) => result.required && result.outcome !== "passed");
const requiredNotRun = results.filter((result) => result.required && result.outcome === "not_run");

const summary = {
  event: "summary",
  outcome: requiredFailures.length === 0 ? "passed" : "failed",
  required: results.filter((result) => result.required).length,
  optional: results.filter((result) => !result.required).length,
  failedRequired: requiredFailures.map((result) => result.name),
  notRunRequired: requiredNotRun.map((result) => result.name),
  phases: results,
};

console.log(JSON.stringify(summary));
process.exitCode = summary.outcome === "passed" ? 0 : 1;
