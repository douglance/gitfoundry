import { createHash } from "node:crypto";

export const forgeDescriptorSchemaVersion = 1 as const;

export type ForgeTreeKind = "code" | "state";

export type ForgeFileMode = "100644" | "100755" | "120000";

export interface ForgeActor {
  readonly id: string;
  readonly kind: "human" | "agent" | "service";
}

export interface ForgeVersionDescriptor {
  readonly schema_version: typeof forgeDescriptorSchemaVersion;
  readonly fork_id: string;
  readonly tenant_id: string;
  readonly repository_id: string;
  readonly parents: readonly string[];
  readonly code_commit: string;
  readonly state_commit: string;
  readonly creator_id: string;
  readonly creator_kind: ForgeActor["kind"];
  readonly operation_id: string;
  readonly request_digest: string;
}

export interface ForgeVersion {
  readonly version_commit: string;
  readonly descriptor: ForgeVersionDescriptor;
}

export interface ForkForgeChange {
  readonly tree: ForgeTreeKind;
  readonly path: string;
  readonly content_base64: string | null;
  readonly mode?: ForgeFileMode;
}

export interface ForkForgeConflict {
  readonly tree: ForgeTreeKind;
  readonly path: string;
}

export class ForkForgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ForkForgeInputError extends ForkForgeError {}
export class ForgeVersionNotFoundError extends ForkForgeError { readonly code = "not_found" as const; }
export class ForgeVersionAuthenticationError extends ForkForgeError { readonly code = "permission_denied" as const; }
export class ForkForgeIdempotencyConflictError extends ForkForgeError { readonly code = "idempotency_conflict" as const; }
export class ForkForgeStaleHeadError extends ForkForgeError { readonly code = "stale_head" as const; }
export class ForkForgeUnavailableError extends ForkForgeError {}
export class ForkForgeMergeConflictError extends ForkForgeError {
  readonly conflicts: readonly ForkForgeConflict[];

  constructor(conflicts: readonly ForkForgeConflict[]) {
    super(`merge produced ${conflicts.length} conflict(s)`);
    this.conflicts = conflicts;
  }
}

const shaPattern = /^[0-9a-f]{40}$/;
const safeIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const invalidBase64Character = /[^A-Za-z0-9+/]/u;
const forgeFileModes = new Set<string>(["100644", "100755", "120000"]);

export function assertSha40(value: string, field: string): string {
  if (!shaPattern.test(value)) throw new ForkForgeInputError(`${field} must be a lower-case SHA-1`);
  return value;
}

export function assertSafeId(value: string, field: string): string {
  if (!safeIdPattern.test(value)) throw new ForkForgeInputError(`${field} must be a safe ref component`);
  return value;
}

export function safeRefPart(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  if (safe.length === 0) throw new ForkForgeInputError("operation produced an empty ref component");
  return safe;
}

export function assertBase64(value: string, field: string): string {
  if (value.length > 8 * 1024 * 1024) throw new ForkForgeInputError(`${field} is too large`);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const payload = value.slice(0, value.length - padding);
  if (value.length % 4 !== 0 || invalidBase64Character.test(payload)) throw new ForkForgeInputError(`${field} must be base64`);
  return value;
}

export function assertForgeFileMode(value: string, field: string): ForgeFileMode {
  if (!forgeFileModes.has(value)) throw new ForkForgeInputError(`${field} must be one of 100644, 100755, or 120000`);
  return value as ForgeFileMode;
}

export function assertForgePath(path: string): string {
  if (path.length === 0 || path.length > 512) throw new ForkForgeInputError("path must be 1-512 characters");
  if (path.startsWith("/") || path.includes("\\")) throw new ForkForgeInputError(`invalid path: ${path}`);
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new ForkForgeInputError(`invalid path: ${path}`);
  }
  return path;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const item = input[key];
      if (item !== undefined) output[key] = canonicalize(item);
    }
    return output;
  }
  throw new ForkForgeInputError(`unsupported JSON value: ${typeof value}`);
}

export function semanticDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function encodeBase64Utf8(text: string): string {
  return encodeBase64(utf8Bytes(text));
}

export function decodeBase64Utf8(base64: string): string {
  return utf8Text(decodeBase64(assertBase64(base64, "content")));
}

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const point of text) {
    const code = point.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes.push(code);
    else if (code <= 0x7ff) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code <= 0xffff) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

function utf8Text(bytes: readonly number[]): string {
  let text = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index] ?? 0;
    if (first < 0x80) {
      text += String.fromCodePoint(first);
      index += 1;
    } else if (first < 0xe0) {
      const second = bytes[index + 1] ?? 0;
      text += String.fromCodePoint(((first & 0x1f) << 6) | (second & 0x3f));
      index += 2;
    } else if (first < 0xf0) {
      const second = bytes[index + 1] ?? 0;
      const third = bytes[index + 2] ?? 0;
      text += String.fromCodePoint(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f));
      index += 3;
    } else {
      const second = bytes[index + 1] ?? 0;
      const third = bytes[index + 2] ?? 0;
      const fourth = bytes[index + 3] ?? 0;
      text += String.fromCodePoint(((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f));
      index += 4;
    }
  }
  return text;
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: readonly number[]): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const triplet = (first << 16) | (second << 8) | third;
    output += base64Alphabet[(triplet >> 18) & 0x3f];
    output += base64Alphabet[(triplet >> 12) & 0x3f];
    output += index + 1 < bytes.length ? base64Alphabet[(triplet >> 6) & 0x3f] : "=";
    output += index + 2 < bytes.length ? base64Alphabet[triplet & 0x3f] : "=";
  }
  return output;
}

function decodeBase64(base64: string): number[] {
  const clean = base64.replace(/=+$/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = base64Alphabet.indexOf(char);
    if (value < 0) throw new ForkForgeInputError("content must be base64");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

export function parseForgeDescriptorJson(text: string): ForgeVersionDescriptor {
  const value = JSON.parse(text) as Partial<ForgeVersionDescriptor>;
  if (value.schema_version !== forgeDescriptorSchemaVersion) throw new ForgeVersionAuthenticationError("unsupported forge descriptor schema");
  const creatorKind = value.creator_kind;
  const descriptor: ForgeVersionDescriptor = {
    schema_version: forgeDescriptorSchemaVersion,
    fork_id: assertSafeId(String(value.fork_id ?? ""), "fork_id"),
    tenant_id: assertSafeId(String(value.tenant_id ?? ""), "tenant_id"),
    repository_id: assertSafeId(String(value.repository_id ?? ""), "repository_id"),
    parents: Array.isArray(value.parents) ? value.parents.map((parent, index) => assertSha40(String(parent), `parents[${index}]`)) : [],
    code_commit: assertSha40(String(value.code_commit ?? ""), "code_commit"),
    state_commit: assertSha40(String(value.state_commit ?? ""), "state_commit"),
    creator_id: assertSafeId(String(value.creator_id ?? ""), "creator_id"),
    creator_kind: creatorKind === "human" || creatorKind === "agent" || creatorKind === "service" ? creatorKind : "agent",
    operation_id: assertSafeId(String(value.operation_id ?? ""), "operation_id"),
    request_digest: String(value.request_digest ?? "")
  };
  if (descriptor.request_digest.length === 0) throw new ForgeVersionAuthenticationError("descriptor request_digest is required");
  return descriptor;
}
