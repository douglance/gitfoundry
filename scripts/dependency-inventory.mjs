import { readFileSync, readdirSync, realpathSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const alchemy = realpathSync(path.join(root, "apps/api-worker/node_modules/alchemy/package.json"));
const require = createRequire(alchemy);
const { parse } = require("yaml");

const args = new Set(process.argv.slice(2));
const read = (name) => readFileSync(path.join(root, name), "utf8");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const rel = (name) => path.relative(root, name).split(path.sep).join("/");

const alchemyGraphPath = "apps/api-worker/alchemy.run.ts";
const alchemyGraphText = read(alchemyGraphPath);
const alchemyRoot = path.join(root, "apps/api-worker");

function resolveAlchemyRootFile(relativePath) {
  return rel(path.resolve(alchemyRoot, relativePath));
}

function parseAlchemyContainerRepositories(text) {
  const byDockerfile = new Map();
  const containerBlocks = text.matchAll(/class\s+([A-Za-z0-9_]+)\s+extends\s+Cloudflare\.Container<[^>]+>\(\)\("([^"]+)",\s*\{([\s\S]*?)\n\s*\}\)\s*\{\}/g);
  for (const match of containerBlocks) {
    const [, className, durableObjectName, body] = match;
    const dockerfileMatch = body.match(/dockerfile:\s*rootFile\("([^"]+)"\)/);
    const repositoryMatch = body.match(/publish:\s*\{\s*repository:\s*"([^"]+)"\s*\}/);
    if (!dockerfileMatch && !repositoryMatch) continue;
    if (!dockerfileMatch || !repositoryMatch) {
      throw new Error(`Cannot derive container repository for ${className}/${durableObjectName}`);
    }
    const dockerfile = resolveAlchemyRootFile(dockerfileMatch[1]);
    if (byDockerfile.has(dockerfile)) {
      const prior = byDockerfile.get(dockerfile);
      throw new Error(`Ambiguous Alchemy container repository for ${dockerfile}: ${prior.repository} and ${repositoryMatch[1]}`);
    }
    byDockerfile.set(dockerfile, {
      class_name: className,
      durable_object_name: durableObjectName,
      repository: repositoryMatch[1]
    });
  }
  return byDockerfile;
}

function alchemyRepositoryFor(dockerfile, repositories) {
  const found = repositories.get(dockerfile);
  if (!found) throw new Error(`Missing Alchemy container repository for ${dockerfile}`);
  return found;
}

function runSelfTest() {
  const quotedAlchemy = `
    class TrustedGitHelperContainer extends Cloudflare.Container<TrustedGitHelperDO>()("TrustedGitHelperDO", {
      context: rootFile("../../images"),
      dockerfile: rootFile("../../images/git-helper/Dockerfile"),
      publish: { repository: "gitfoundry-helper" },
      maxInstances: 1,
      className: "TrustedGitHelperDO"
    }) {}

    class UntrustedCiJobContainer extends Cloudflare.Container<UntrustedCiJobDO>()("UntrustedCiJobDO", {
      context: rootFile("../../images"),
      dockerfile: rootFile("../../images/ci-runner/Dockerfile"),
      publish: { repository: "gitfoundry-ci" },
      maxInstances: 1,
      className: "UntrustedCiJobDO"
    }) {}
  `;
  const parsed = parseAlchemyContainerRepositories(quotedAlchemy);
  if (alchemyRepositoryFor("images/git-helper/Dockerfile", parsed).repository !== "gitfoundry-helper") {
    throw new Error("self-test failed to derive git-helper repository");
  }
  if (alchemyRepositoryFor("images/ci-runner/Dockerfile", parsed).repository !== "gitfoundry-ci") {
    throw new Error("self-test failed to derive ci-runner repository");
  }
  const expectThrow = (name, fn) => {
    try {
      fn();
      throw new Error(`${name} did not throw`);
    } catch (error) {
      if (error.message === `${name} did not throw`) throw error;
    }
  };
  expectThrow("missing mapping", () => alchemyRepositoryFor("images/missing/Dockerfile", parsed));
  expectThrow("ambiguous mapping", () => parseAlchemyContainerRepositories(`${quotedAlchemy}\n${quotedAlchemy.replace("gitfoundry-helper", "gitfoundry-helper-copy")}`));
  console.log("dependency inventory self-test passed");
}

if (args.has("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const lockText = read("pnpm-lock.yaml");
const lock = parse(lockText);
const cargo = JSON.parse(readFileSync(0, "utf8"));
const packageJson = JSON.parse(read("package.json"));
const alchemyContainerRepositories = parseAlchemyContainerRepositories(alchemyGraphText);

const dockerRecipes = [
  {
    name: "linux-runner",
    role: "baseline local runner proof",
    dockerfile: "images/linux-runner/Dockerfile",
    input_paths: [
      "images/linux-runner/supervisor/Cargo.toml",
      "images/linux-runner/supervisor/Cargo.lock",
      "images/linux-runner/supervisor/src/main.rs"
    ],
    context: "images/linux-runner",
    local_tag: "gitfoundry-p0-linux-runner:local",
    cloudflare_container: false
  },
  {
    name: "git-helper",
    role: "trusted Git helper provider image",
    dockerfile: "images/git-helper/Dockerfile",
    input_paths: [
      "images/linux-runner/supervisor/Cargo.toml",
      "images/linux-runner/supervisor/Cargo.lock",
      "images/linux-runner/supervisor/src/main.rs",
      "images/git-helper/gitfoundry-git-helper"
    ],
    context: "images",
    local_tag: "gitfoundry-p0-git-helper:local",
    cloudflare_container: true
  },
  {
    name: "ci-runner",
    role: "untrusted CI job provider image",
    dockerfile: "images/ci-runner/Dockerfile",
    input_paths: [
      "images/linux-runner/supervisor/Cargo.toml",
      "images/linux-runner/supervisor/Cargo.lock",
      "images/linux-runner/supervisor/src/main.rs",
      "images/ci-runner/gitfoundry-ci-step"
    ],
    context: "images",
    local_tag: "gitfoundry-p0-ci-runner:local",
    cloudflare_container: true
  }
];

const imageRecipeInputPaths = [...new Set(dockerRecipes.flatMap((recipe) => [recipe.dockerfile, ...recipe.input_paths]))];

const sourceFingerprintPaths = [
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Cargo.toml",
  "rust-toolchain.toml",
  alchemyGraphPath,
  ...imageRecipeInputPaths
];

const sourceFingerprints = Object.fromEntries(sourceFingerprintPaths.map((name) => [name, digest(read(name))]));

function installedPackageMetadata() {
  const store = path.join(root, "node_modules/.pnpm");
  const installed = new Map();
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modules = path.join(store, entry.name, "node_modules");
    let children;
    try { children = readdirSync(modules, { withFileTypes: true }); } catch { continue; }
    const candidates = [];
    for (const child of children) {
      if (child.name.startsWith("@")) {
        try {
          for (const scoped of readdirSync(path.join(modules, child.name))) {
            candidates.push(path.join(modules, child.name, scoped, "package.json"));
          }
        } catch {}
      } else {
        candidates.push(path.join(modules, child.name, "package.json"));
      }
    }
    for (const candidate of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        installed.set(pkg.name + "@" + pkg.version, { pkg, package_json: candidate });
      } catch {}
    }
  }
  return installed;
}

const installed = installedPackageMetadata();

const npm = Object.entries(lock.packages ?? {}).map(([key, value]) => {
  const canonical = key.split("(")[0];
  const split = canonical.lastIndexOf("@");
  if (split <= 0) throw new Error("Unsupported lock package key: " + key);
  const name = canonical.slice(0, split);
  const version = canonical.slice(split + 1);
  const found = installed.get(canonical);
  const license = typeof found?.pkg.license === "string" ? found.pkg.license : found?.pkg.license?.type ?? null;
  return {
    ecosystem: "npm",
    name,
    version,
    lock_key: key,
    integrity: value.resolution?.integrity ?? null,
    declared_license: license,
    license_source: found ? "installed package.json" : "metadata unavailable for this host",
    license_source_path: found ? rel(found.package_json) : null,
    optional: value.optional === true,
    os: value.os ?? null,
    cpu: value.cpu ?? null
  };
});

const cargoComponents = cargo.packages.map((pkg) => ({
  ecosystem: "cargo",
  graph: "workspace-native-wasm",
  name: pkg.name,
  version: pkg.version,
  source: pkg.source ?? "workspace",
  checksum: pkg.checksum ?? null,
  declared_license: pkg.license ?? null,
  license_file_declared: pkg.license_file != null,
  license_source: "Cargo package metadata",
  license_source_path: pkg.manifest_path ?? null
}));

function parseManifestPackage(text, sourcePath) {
  const packageBlock = text.split(/^\[/m).find((block) => block.startsWith("package]"));
  if (!packageBlock) throw new Error("Missing [package] in " + sourcePath);
  const pick = (key) => packageBlock.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
  return { name: pick("name"), version: pick("version"), license: pick("license") };
}

function parseCargoLockPackages(text) {
  return text.split(/^\[\[package\]\]\s*$/m).slice(1).map((block) => {
    const pick = (key) => block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
    return { name: pick("name"), version: pick("version"), source: pick("source") ?? "workspace", checksum: pick("checksum") };
  }).filter((pkg) => pkg.name && pkg.version);
}

const supervisorManifestPath = "images/linux-runner/supervisor/Cargo.toml";
const supervisorLockPath = "images/linux-runner/supervisor/Cargo.lock";
const supervisorManifest = parseManifestPackage(read(supervisorManifestPath), supervisorManifestPath);
const supervisorCargo = parseCargoLockPackages(read(supervisorLockPath)).map((pkg) => ({
  ecosystem: "cargo",
  graph: "linux-runner-supervisor",
  name: pkg.name,
  version: pkg.version,
  source: pkg.source,
  checksum: pkg.checksum ?? null,
  declared_license: pkg.name === supervisorManifest.name ? supervisorManifest.license : null,
  license_file_declared: false,
  license_source: pkg.name === supervisorManifest.name ? "supervisor Cargo.toml" : "Cargo.lock has no license metadata",
  license_source_path: pkg.name === supervisorManifest.name ? supervisorManifestPath : null
}));

function labelValue(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`LABEL\\s+${escaped}=\"([^\"]*)\"`))?.[1] ?? null;
}

function parseDockerfile(recipe) {
  const text = read(recipe.dockerfile);
  const registryRepository = recipe.cloudflare_container ? alchemyRepositoryFor(recipe.dockerfile, alchemyContainerRepositories) : null;
  const dockerfileSha256 = digest(text);
  const inputFingerprints = recipe.input_paths.map((name) => ({ path: name, sha256: digest(read(name)) }));
  const recipeSha256 = digest(JSON.stringify({
    dockerfile: { path: recipe.dockerfile, sha256: dockerfileSha256 },
    inputs: inputFingerprints
  }));
  const from = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^FROM\s+--platform=([^\s]+)\s+([^\s@]+)(?:@sha256:([a-f0-9]{64}))?(?:\s+AS\s+(\S+))?/i);
    if (!match) continue;
    from.push({
      platform: match[1],
      image: match[2],
      digest: match[3] ? "sha256:" + match[3] : null,
      stage: match[4] ?? null,
      pinned: Boolean(match[3])
    });
  }
  const apt = [];
  const installMatches = text.match(/apt-get install -y --no-install-recommends[\s\S]*?&& rm -rf/g) ?? [];
  for (const install of installMatches) {
    for (const match of install.matchAll(/([a-z0-9.+-]+)=([^\s\\]+)/g)) {
      apt.push({ name: match[1], version: match[2], pinned: true });
    }
  }
  return {
    name: recipe.name,
    role: recipe.role,
    dockerfile: recipe.dockerfile,
    context: recipe.context,
    platform: "linux/amd64",
    recipe_sha256: recipeSha256,
    dockerfile_sha256: dockerfileSha256,
    input_fingerprints: inputFingerprints,
    base_images: from,
    apt_packages: apt.sort((a, b) => a.name.localeCompare(b.name)),
    declared_license: labelValue(text, "org.opencontainers.image.licenses"),
    license_source_path: recipe.dockerfile,
    registry_repository: registryRepository?.repository ?? null,
    registry_repository_source: registryRepository ? {
      path: alchemyGraphPath,
      sha256: sourceFingerprints[alchemyGraphPath],
      class_name: registryRepository.class_name,
      durable_object_name: registryRepository.durable_object_name
    } : null,
    registry_digest: null,
    registry_digest_status: "pending actual Alchemy publication",
    local_image: inspectLocalImage(recipe.local_tag)
  };
}

function inspectLocalImage(tag) {
  const docker = spawnSync("docker", ["image", "inspect", tag], { encoding: "utf8", timeout: 30_000 });
  if (docker.status !== 0) {
    return { tag, status: "not present on local Docker daemon", proof_scope: "local image proof only; not a registry publication digest", image_id: null, image_id_status: "pending fresh rebuild of current recipe inputs" };
  }
  return {
    tag,
    status: "present on local Docker daemon; selected image ID omitted because tag freshness is not proven against current recipe inputs",
    proof_scope: "local image proof only; not a registry publication digest",
    image_id: null,
    image_id_status: "pending fresh rebuild of current recipe inputs",
    repo_digests: [],
    platform: null,
    created: null
  };
}

const executionImages = dockerRecipes.map(parseDockerfile);

const components = [...npm, ...cargoComponents, ...supervisorCargo].sort((a, b) => {
  const left = [a.ecosystem, a.graph ?? "", a.name, a.version, a.lock_key ?? ""].join("/");
  const right = [b.ecosystem, b.graph ?? "", b.name, b.version, b.lock_key ?? ""].join("/");
  return left.localeCompare(right);
});
const missing = components.filter((pkg) => pkg.declared_license === null);

const inventory = {
  format: "gitfoundry-dependency-inventory-v1",
  generated_from: "scripts/dependency-inventory.mjs",
  source_fingerprints: sourceFingerprints,
  package_manager: packageJson.packageManager,
  generator_node: process.versions.node,
  platform: "linux/amd64",
  counts: {
    npm: npm.length,
    cargo_workspace_native_wasm: cargoComponents.length,
    cargo_linux_runner_supervisor: supervisorCargo.length,
    execution_images: executionImages.length,
    missing_declared_licenses: missing.length
  },
  components,
  execution_images: executionImages,
  execution_image_status: "registry digests pending until actual Alchemy publication; local image IDs are local proof only"
};

const imageRows = executionImages.map((image) => [
  image.name,
  image.platform,
  image.recipe_sha256,
  image.registry_repository ?? "local-only",
  image.base_images.map((base) => `${base.image}@${base.digest ?? "unpinned"}`).join("<br>"),
  image.apt_packages.map((pkg) => `${pkg.name}=${pkg.version}`).join("<br>"),
  `${image.local_image.status} (${image.local_image.tag})`,
  image.registry_digest_status
]);

const report = [
  "# Dependency inventory",
  "",
  "This inventory covers the locked TypeScript/npm graph, the native/WASM Cargo workspace graph, the isolated Linux supervisor Cargo lock, and the current Linux execution image recipes. License fields record only declarations found in package metadata, manifests, or image labels; missing declarations remain null in the JSON inventory.",
  "",
  "| Graph | Components |",
  "| --- | ---: |",
  "| npm | " + npm.length + " |",
  "| Cargo workspace native/WASM | " + cargoComponents.length + " |",
  "| Cargo linux-runner supervisor | " + supervisorCargo.length + " |",
  "| Execution image recipes | " + executionImages.length + " |",
  "| Missing declared license metadata | " + missing.length + " |",
  "",
  "The [complete inventory](dependency-inventory.json) includes lock fingerprints, Alchemy graph fingerprints, Dockerfile hashes, copied recipe input fingerprints, combined recipe hashes, versions, npm integrity values, platform constraints, local image ID status, pending registry digest fields, pinned base image digests, pinned apt versions, and declared license source paths.",
  "",
  "## Execution images",
  "",
  "| Image | Platform | Recipe SHA-256 | Registry repository | Pinned base images | Pinned apt packages | Local image proof | Registry digest |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...imageRows.map((row) => "| " + row.join(" | ") + " |"),
  "",
  "Cloudflare registry repositories for published container images are derived from `apps/api-worker/alchemy.run.ts`; missing or ambiguous mappings fail generation. Local image IDs are omitted until the exact tags are freshly rebuilt from the current recipe input hashes. `registry_digest` remains null until actual Alchemy publication returns Cloudflare registry digests.",
  "",
  "Offline rebuild evidence retained from the prior inventory: normal TCP control `01a11946-8295-70b3-995b-f4a714e786d1`, network denial `01a11946-8295-70b3-995b-f4b299706430`, forced TypeScript rebuild `01a11947-1fca-70a1-86b5-29cf8dd40589`, fresh-target locked/offline Rust tests `01a11947-1f8c-7fe2-b182-f68ce9e8090f`.",
  "",
  "The generator reads Cargo metadata on stdin and returns caller-owned file text. It writes no project source; `--check` compares regenerated text with the committed inventory files while normalizing volatile JSON local image IDs.",
  "",
  "tl;dr: Current locked npm, Cargo workspace, supervisor Cargo, and Linux execution image dependencies are inventoried from source. Registry image digests and selected local image IDs are still pending fresh Alchemy publication or exact-tag rebuild proof."
].join("\n") + "\n";

const files = {
  "docs/dependency-inventory.json": JSON.stringify(inventory, null, 2) + "\n",
  "docs/dependency-inventory.md": report
};

const stableForCheck = (name, text) => {
  if (name !== "docs/dependency-inventory.json") return text;
  const copy = JSON.parse(text);
  for (const image of copy.execution_images ?? []) {
    image.local_image = {
      tag: image.local_image?.tag ?? null,
      status: image.local_image?.status ?? null,
      proof_scope: image.local_image?.proof_scope ?? null,
      platform: image.local_image?.platform ?? null
    };
  }
  return JSON.stringify(copy, null, 2) + "\n";
};

if (args.has("--check")) {
  const mismatches = Object.entries(files).filter(([name, text]) => {
    if (!existsSync(path.join(root, name))) return true;
    return stableForCheck(name, read(name)) !== stableForCheck(name, text);
  }).map(([name]) => name);
  if (mismatches.length > 0) {
    console.error("dependency inventory out of date: " + mismatches.join(", "));
    process.exit(1);
  }
  console.log("dependency inventory check passed");
} else if (args.has("--ops")) {
  console.log(JSON.stringify(Object.entries(files).map(([name, text]) => ({ op: "create", overwrite: true, path: name, text }))));
} else {
  console.log(JSON.stringify(files));
}
