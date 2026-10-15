import { Schema } from "effect";
import * as JsonSchema from "effect/JSONSchema";

import { expectedContractCounts, sourceContractPaths } from "./generated/catalog.generated.js";

export { expectedContractCounts, sourceContractPaths };

const HttpMethodSchema = Schema.Union([
  Schema.Literal("GET"),
  Schema.Literal("POST"),
  Schema.Literal("PATCH"),
  Schema.Literal("DELETE"),
  Schema.Literal("PUT")
]);
const RequestLocationSchema = Schema.Union([
  Schema.Literal("query"),
  Schema.Literal("body"),
  Schema.Literal("path"),
  Schema.Literal("none")
]);
const NonEmptyString = Schema.NonEmptyString;
const HeaderMapSchema = Schema.Record(Schema.String, Schema.String);
const UnknownMapSchema = Schema.Record(Schema.String, Schema.Unknown);

const supportedSchemaKeys = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "default",
  "description",
  "else",
  "enum",
  "format",
  "if",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "propertyNames",
  "required",
  "then",
  "type",
  "uniqueItems"
]);

export const NativeOperationSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/)),
  method: HttpMethodSchema,
  path: Schema.String.check(Schema.isPattern(/^\/api\/v[12]\/tenants\/\{tenant_id\}/)),
  capability: Schema.String.check(Schema.isPattern(/^[a-z_]+(\.[a-z_]+)+$/)),
  output_schema: NonEmptyString,
  input_schema: Schema.NullOr(NonEmptyString),
  asynchronous: Schema.Boolean,
  cli: Schema.String.check(Schema.isPattern(/^gfy [a-z0-9_-]+( [a-z0-9_-]+)*$/)),
  mcp_tool: Schema.String.check(Schema.isPattern(/^gfy_[a-z0-9_]+$/)),
  request_schema: Schema.NullOr(NonEmptyString),
  request_location: RequestLocationSchema,
  batch_eligible: Schema.Boolean,
  page_item_schema: Schema.optional(NonEmptyString)
});

export const JsonSchemaObjectSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  additionalProperties: Schema.optional(Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Schema.Unknown)])),
  properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optional(Schema.Array(Schema.String)),
  $defs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
});

export const McpToolSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^gfy_[a-z0-9_]+$/)),
  description: NonEmptyString,
  inputSchema: JsonSchemaObjectSchema,
  outputSchema: JsonSchemaObjectSchema,
  annotations: Schema.Struct({
    readOnlyHint: Schema.Boolean,
    destructiveHint: Schema.Boolean,
    idempotentHint: Schema.Boolean,
    openWorldHint: Schema.Boolean
  }),
  "x-operation": NativeOperationSchema.fields.id
});

export const RequestEnvelopeSchema = Schema.Struct({
  operation_id: NativeOperationSchema.fields.id,
  route: HeaderMapSchema,
  query: UnknownMapSchema,
  headers: HeaderMapSchema,
  body: Schema.Unknown,
  cookies: HeaderMapSchema,
  idempotency_key: Schema.optional(Schema.String.check(Schema.isBetweenLength(1, 128))),
  expected_version: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
  api_version: Schema.String.check(Schema.isPattern(/^v[0-9]+$/))
});

export type NativeOperation = typeof NativeOperationSchema.Type;
export type McpTool = typeof McpToolSchema.Type;
export type RequestEnvelope = typeof RequestEnvelopeSchema.Type;

export interface SourceCatalogInput {
  operations: { operations: unknown[] };
  mcpTools: { tools: unknown[] };
  openapi: { paths: Record<string, Record<string, unknown>> };
  schemaSql: string;
  requirementsTraceCsv: string;
}

export interface SourceDomainDocument {
  $defs: Record<string, JsonSchemaValue>;
}

export type JsonSchemaValue = Record<string, unknown>;

export interface CatalogValidationSummary {
  operations: number;
  mcpTools: number;
  openapiPaths: number;
  sqlTables: number;
  requirements: number;
}

export interface CatalogBindingSummary extends CatalogValidationSummary {
  operationIds: readonly string[];
  mcpToolNames: readonly string[];
  unimplementedOperationIds: readonly string[];
}

export interface JsonSchemaDecodeError {
  path: string;
  message: string;
}

export class JsonSchemaValidationError extends Error {
  readonly schemaName: string;
  readonly issues: readonly JsonSchemaDecodeError[];

  constructor(schemaName: string, issues: readonly JsonSchemaDecodeError[]) {
    super(`${schemaName} does not satisfy source JSON schema: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "JsonSchemaValidationError";
    this.schemaName = schemaName;
    this.issues = issues;
  }
}

export class ContractBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractBindingError";
  }
}

export function decodeNativeOperation(value: unknown): NativeOperation {
  return Schema.decodeUnknownSync(NativeOperationSchema)(value);
}

export function decodeMcpTool(value: unknown): McpTool {
  return Schema.decodeUnknownSync(McpToolSchema)(value);
}

export function decodeRequestEnvelope(value: unknown): RequestEnvelope {
  assertOnlyKeys("request envelope", value, [
    "operation_id",
    "route",
    "query",
    "headers",
    "body",
    "cookies",
    "idempotency_key",
    "expected_version",
    "api_version"
  ]);
  const envelope = Schema.decodeUnknownSync(RequestEnvelopeSchema)(value);
  if (envelope.api_version !== "v1") {
    throw new ContractBindingError(`unsupported api_version ${envelope.api_version}`);
  }
  if (envelope.expected_version !== undefined && !Number.isInteger(envelope.expected_version)) {
    throw new ContractBindingError("expected_version must be an integer");
  }
  return envelope;
}

export function createJsonSchemaEffectSchema(document: SourceDomainDocument, schemaName: string): typeof Schema.Unknown {
  const validator = createJsonSchemaValidator(document, schemaName);
  return Schema.Unknown.check(Schema.makeFilter((input) => validator(input).length === 0));
}

export function validateSourceSchema(document: SourceDomainDocument, schemaName: string, value: unknown): readonly JsonSchemaDecodeError[] {
  return createJsonSchemaValidator(document, schemaName)(value);
}

export function decodeSourceSchema(document: SourceDomainDocument, schemaName: string, value: unknown): unknown {
  const issues = validateSourceSchema(document, schemaName, value);
  if (issues.length > 0) {
    Schema.decodeUnknownSync(createJsonSchemaEffectSchema(document, schemaName))(value);
    throw new JsonSchemaValidationError(schemaName, issues);
  }
  return value;
}

export function validateSourceCatalog(input: SourceCatalogInput): CatalogBindingSummary {
  const operations = input.operations.operations.map(decodeNativeOperation);
  const tools = input.mcpTools.tools.map(decodeMcpTool);
  const operationIds = new Set<string>();
  const toolNames = new Set<string>();

  for (const operation of operations) {
    if (operationIds.has(operation.id)) throw new ContractBindingError(`duplicate operation id ${operation.id}`);
    operationIds.add(operation.id);
  }

  for (const tool of tools) {
    if (toolNames.has(tool.name)) throw new ContractBindingError(`duplicate MCP tool ${tool.name}`);
    toolNames.add(tool.name);
  }

  for (const operation of operations) {
    if (!toolNames.has(operation.mcp_tool)) throw new ContractBindingError(`operation ${operation.id} maps to missing MCP tool ${operation.mcp_tool}`);
    const pathItem = input.openapi.paths[operation.path];
    if (!pathItem || !Object.prototype.hasOwnProperty.call(pathItem, operation.method.toLowerCase())) {
      throw new ContractBindingError(`operation ${operation.id} maps to missing OpenAPI route ${operation.method} ${operation.path}`);
    }
  }

  for (const tool of tools) {
    if (!operationIds.has(tool["x-operation"])) throw new ContractBindingError(`MCP tool ${tool.name} maps to missing operation ${tool["x-operation"]}`);
    const operation = operations.find((candidate) => candidate.id === tool["x-operation"]);
    if (operation && operation.mcp_tool !== tool.name) {
      throw new ContractBindingError(`MCP tool ${tool.name} reverse maps to ${tool["x-operation"]}, expected ${operation.mcp_tool}`);
    }
  }

  const summary = {
    operations: operations.length,
    mcpTools: tools.length,
    openapiPaths: Object.keys(input.openapi.paths).length,
    sqlTables: countSqlTables(input.schemaSql),
    requirements: countCsvRows(input.requirementsTraceCsv),
    operationIds: operations.map((operation) => operation.id).sort(),
    mcpToolNames: tools.map((tool) => tool.name).sort(),
    unimplementedOperationIds: operations.map((operation) => operation.id).sort()
  } satisfies CatalogBindingSummary;

  assertExpectedCounts(summary);
  return summary;
}

export function findOperation(input: SourceCatalogInput, operationId: string): NativeOperation {
  const operation = input.operations.operations.map(decodeNativeOperation).find((candidate) => candidate.id === operationId);
  if (!operation) throw new ContractBindingError(`unknown operation ${operationId}`);
  return operation;
}

export function countSqlTables(sql: string): number {
  return Array.from(sql.matchAll(/CREATE TABLE\s+[A-Za-z0-9_]+/g)).length;
}

export function countCsvRows(csv: string): number {
  const trimmed = csv.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(0, trimmed.split(/\r?\n/).length - 1);
}

function assertExpectedCounts(summary: CatalogValidationSummary): void {
  const expected = expectedContractCounts;
  const mismatches = Object.entries(expected).filter(([key, expectedValue]) => summary[key as keyof CatalogValidationSummary] !== expectedValue);
  if (mismatches.length > 0) {
    throw new ContractBindingError(
      mismatches.map(([key, expectedValue]) => `${key}: expected ${expectedValue}, got ${summary[key as keyof CatalogValidationSummary]}`).join("; ")
    );
  }
}

function createJsonSchemaValidator(document: SourceDomainDocument, schemaName: string): (value: unknown) => JsonSchemaDecodeError[] {
  if (!document.$defs || !document.$defs[schemaName]) throw new ContractBindingError(`unknown source schema ${schemaName}`);
  const normalized = JsonSchema.fromSchemaDraft2020_12({ $defs: document.$defs, $ref: `#/$defs/${schemaName}` });
  const definitions = normalized.definitions as Record<string, JsonSchemaValue>;
  return (value) => validateJsonSchema(value, normalized.schema as JsonSchemaValue, definitions, "$", new Set());
}

function validateJsonSchema(value: unknown, schema: JsonSchemaValue, definitions: Record<string, JsonSchemaValue>, path: string, seen: Set<string>): JsonSchemaDecodeError[] {
  const unsupported = unsupportedSchemaKeys(schema);
  if (unsupported.length > 0) return unsupported.map((key) => ({ path, message: `uses unsupported schema keyword ${key}` }));

  const compositionIssues: JsonSchemaDecodeError[] = [];
  const ref = readString(schema.$ref);
  if (ref) {
    const target = resolveRef(ref, definitions);
    const seenKey = `${ref}:${path}`;
    if (seen.has(seenKey)) return [];
    compositionIssues.push(...validateJsonSchema(value, target, definitions, path, new Set([...seen, seenKey])));
  }

  const ifSchema = isPlainRecord(schema.if) ? schema.if as JsonSchemaValue : undefined;
  if (ifSchema) {
    const branch = validateJsonSchema(value, ifSchema, definitions, path, seen).length === 0 ? schema.then : schema.else;
    if (isPlainRecord(branch)) compositionIssues.push(...validateJsonSchema(value, branch as JsonSchemaValue, definitions, path, seen));
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && !enumValues.some((candidate) => Object.is(candidate, value))) return [{ path, message: `must be one of ${enumValues.map(String).join(", ")}` }];
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !Object.is(schema.const, value)) return [{ path, message: `must equal ${String(schema.const)}` }];

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf as JsonSchemaValue[] : undefined;
  if (anyOf && !anyOf.some((candidate) => validateJsonSchema(value, candidate, definitions, path, seen).length === 0)) return [{ path, message: "must satisfy at least one anyOf schema" }];

  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf as JsonSchemaValue[] : undefined;
  if (oneOf) {
    const matches = oneOf.filter((candidate) => validateJsonSchema(value, candidate, definitions, path, seen).length === 0).length;
    if (matches !== 1) return [{ path, message: `must satisfy exactly one oneOf schema, matched ${matches}` }];
  }

  const allOf = Array.isArray(schema.allOf) ? schema.allOf as JsonSchemaValue[] : undefined;
  if (allOf) compositionIssues.push(...allOf.flatMap((candidate) => validateJsonSchema(value, candidate, definitions, path, seen)));

  const notSchema = isPlainRecord(schema.not) ? schema.not as JsonSchemaValue : undefined;
  if (notSchema && validateJsonSchema(value, notSchema, definitions, path, seen).length === 0) return [{ path, message: "must not satisfy negated schema" }];

  const type = schema.type;
  if (Array.isArray(type)) {
    if (!type.some((candidate) => validateJsonSchema(value, { ...schema, type: candidate }, definitions, path, seen).length === 0)) return [{ path, message: `must match one of types ${type.join(", ")}` }];
    return [];
  }

  if (typeof type === "string") {
    const typeIssue = validateType(value, type, path);
    if (typeIssue) return [typeIssue];
  }

  if (type === "object" || schema.properties || schema.required || schema.additionalProperties === false) return [...compositionIssues, ...validateObject(value, schema, definitions, path, seen)];
  if (type === "array" || schema.items || schema.contains) return [...compositionIssues, ...validateArray(value, schema, definitions, path, seen)];
  if (typeof value === "string") return [...compositionIssues, ...validateString(value, schema, path)];
  if (typeof value === "number") return [...compositionIssues, ...validateNumber(value, schema, path)];
  return compositionIssues;
}

function validateObject(value: unknown, schema: JsonSchemaValue, definitions: Record<string, JsonSchemaValue>, path: string, seen: Set<string>): JsonSchemaDecodeError[] {
  if (!isPlainRecord(value)) return [{ path, message: "must be an object" }];
  const issues: JsonSchemaDecodeError[] = [];
  const properties = isPlainRecord(schema.properties) ? schema.properties as Record<string, JsonSchemaValue> : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  const minProperties = readNumber(schema.minProperties);
  const maxProperties = readNumber(schema.maxProperties);

  if (minProperties !== undefined && Object.keys(value).length < minProperties) issues.push({ path, message: `must have at least ${minProperties} properties` });
  if (maxProperties !== undefined && Object.keys(value).length > maxProperties) issues.push({ path, message: `must have at most ${maxProperties} properties` });

  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) issues.push({ path: `${path}.${key}`, message: "is required" });

  const propertyNamesSchema = isPlainRecord(schema.propertyNames) ? schema.propertyNames as JsonSchemaValue : undefined;
  for (const [key, item] of Object.entries(value)) {
    if (propertyNamesSchema) issues.push(...validateJsonSchema(key, propertyNamesSchema, definitions, `${path}.${key}{key}`, seen));
    const propertySchema = properties[key];
    if (propertySchema) issues.push(...validateJsonSchema(item, propertySchema, definitions, `${path}.${key}`, seen));
    else if (schema.additionalProperties === false) issues.push({ path: `${path}.${key}`, message: "is not allowed" });
    else if (isPlainRecord(schema.additionalProperties)) issues.push(...validateJsonSchema(item, schema.additionalProperties as JsonSchemaValue, definitions, `${path}.${key}`, seen));
  }

  return issues;
}

function validateArray(value: unknown, schema: JsonSchemaValue, definitions: Record<string, JsonSchemaValue>, path: string, seen: Set<string>): JsonSchemaDecodeError[] {
  if (!Array.isArray(value)) return [{ path, message: "must be an array" }];
  const issues: JsonSchemaDecodeError[] = [];
  const minItems = readNumber(schema.minItems);
  const maxItems = readNumber(schema.maxItems);
  if (minItems !== undefined && value.length < minItems) issues.push({ path, message: `must have at least ${minItems} items` });
  if (maxItems !== undefined && value.length > maxItems) issues.push({ path, message: `must have at most ${maxItems} items` });
  if (schema.uniqueItems === true && new Set(value.map(canonicalJson)).size !== value.length) issues.push({ path, message: "must have unique items" });
  const itemSchema = isPlainRecord(schema.items) ? schema.items as JsonSchemaValue : undefined;
  if (itemSchema) value.forEach((item, index) => issues.push(...validateJsonSchema(item, itemSchema, definitions, `${path}[${index}]`, seen)));
  const containsSchema = isPlainRecord(schema.contains) ? schema.contains as JsonSchemaValue : undefined;
  if (containsSchema && !value.some((item, index) => validateJsonSchema(item, containsSchema, definitions, `${path}[${index}]`, seen).length === 0)) issues.push({ path, message: "must contain a matching item" });
  return issues;
}

function validateString(value: string, schema: JsonSchemaValue, path: string): JsonSchemaDecodeError[] {
  const issues: JsonSchemaDecodeError[] = [];
  const minLength = readNumber(schema.minLength);
  const maxLength = readNumber(schema.maxLength);
  if (minLength !== undefined && value.length < minLength) issues.push({ path, message: `must have length at least ${minLength}` });
  if (maxLength !== undefined && value.length > maxLength) issues.push({ path, message: `must have length at most ${maxLength}` });
  const pattern = readString(schema.pattern);
  if (pattern && !new RegExp(pattern).test(value)) issues.push({ path, message: `must match ${pattern}` });
  const format = readString(schema.format);
  if (format === "date-time" && Number.isNaN(Date.parse(value))) issues.push({ path, message: "must be date-time" });
  if (format === "uri" && !isUri(value)) issues.push({ path, message: "must be uri" });
  return issues;
}

function validateNumber(value: number, schema: JsonSchemaValue, path: string): JsonSchemaDecodeError[] {
  const issues: JsonSchemaDecodeError[] = [];
  const minimum = readNumber(schema.minimum);
  const maximum = readNumber(schema.maximum);
  if (minimum !== undefined && value < minimum) issues.push({ path, message: `must be at least ${minimum}` });
  if (maximum !== undefined && value > maximum) issues.push({ path, message: `must be at most ${maximum}` });
  return issues;
}

function validateType(value: unknown, type: string, path: string): JsonSchemaDecodeError | undefined {
  switch (type) {
    case "null": return value === null ? undefined : { path, message: "must be null" };
    case "boolean": return typeof value === "boolean" ? undefined : { path, message: "must be boolean" };
    case "string": return typeof value === "string" ? undefined : { path, message: "must be string" };
    case "number": return typeof value === "number" && Number.isFinite(value) ? undefined : { path, message: "must be number" };
    case "integer": return typeof value === "number" && Number.isInteger(value) ? undefined : { path, message: "must be integer" };
    case "array": return Array.isArray(value) ? undefined : { path, message: "must be array" };
    case "object": return isPlainRecord(value) ? undefined : { path, message: "must be object" };
    default: return { path, message: `uses unsupported JSON Schema type ${type}` };
  }
}

function unsupportedSchemaKeys(schema: JsonSchemaValue): string[] {
  return Object.keys(schema).filter((key) => !supportedSchemaKeys.has(key));
}

function resolveRef(ref: string, definitions: Record<string, JsonSchemaValue>): JsonSchemaValue {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new ContractBindingError(`unsupported schema ref ${ref}`);
  const key = decodeURIComponent(ref.slice(prefix.length));
  const target = definitions[key];
  if (!target) throw new ContractBindingError(`missing schema ref ${ref}`);
  return target;
}

function assertOnlyKeys(label: string, value: unknown, keys: readonly string[]): void {
  if (!isPlainRecord(value)) return;
  const allowed = new Set(keys);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) throw new ContractBindingError(`${label} has unknown field ${extra[0]}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol.length > 0;
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
