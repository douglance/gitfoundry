export interface ForgeVersionDescriptorInput {
  readonly fork_id: string;
  readonly parent_fork_ids: readonly string[];
  readonly code_sha: string;
  readonly state_sha: string;
  readonly creator_id: string;
  readonly operation_id: string;
  readonly created_at: string;
}

export interface ForgeVersionDescriptor extends ForgeVersionDescriptorInput {
  readonly format: "gitfoundry.forge-version.v1";
}

const shaPattern = /^[0-9a-f]{40,64}$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export function canonicalizeForgeDescriptor(input: ForgeVersionDescriptorInput): ForgeVersionDescriptor {
  assertId("fork_id", input.fork_id);
  assertId("creator_id", input.creator_id);
  assertId("operation_id", input.operation_id);
  assertSha("code_sha", input.code_sha);
  assertSha("state_sha", input.state_sha);
  if (!input.created_at) throw new Error("created_at is required");
  const parents = [...input.parent_fork_ids];
  const seen = new Set<string>();
  for (const parent of parents) {
    assertId("parent_fork_ids", parent);
    if (seen.has(parent)) throw new Error(`duplicate parent fork ${parent}`);
    seen.add(parent);
  }
  return {
    format: "gitfoundry.forge-version.v1",
    fork_id: input.fork_id,
    parent_fork_ids: parents,
    code_sha: input.code_sha,
    state_sha: input.state_sha,
    creator_id: input.creator_id,
    operation_id: input.operation_id,
    created_at: input.created_at
  };
}

export function serializeForgeDescriptor(input: ForgeVersionDescriptorInput): string {
  return canonicalJson(canonicalizeForgeDescriptor(input)) + "\n";
}

export async function forgeDescriptorDigest(input: ForgeVersionDescriptorInput): Promise<`sha256:${string}`> {
  const digest = await sha256Hex(serializeForgeDescriptor(input));
  return `sha256:${digest}`;
}

export function retainedDescriptorRef(digest: `sha256:${string}`): string {
  const hex = digest.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/u.test(hex)) throw new Error("descriptor digest must be sha256 hex");
  return `refs/gitfoundry/descriptors/${hex}`;
}

function assertId(name: string, value: string): void {
  if (!idPattern.test(value)) throw new Error(`${name} is not a stable identifier`);
}

function assertSha(name: string, value: string): void {
  if (!shaPattern.test(value)) throw new Error(`${name} must be a Git object id`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
