import { Data, Effect } from "effect";

export interface D1Result<T = Record<string, unknown>> { readonly results?: readonly T[]; readonly success?: boolean; readonly meta?: { readonly changes?: number } }
export interface D1PreparedStatement<T = Record<string, unknown>> {
  readonly bind: (...values: readonly unknown[]) => D1PreparedStatement<T>;
  readonly first: <R = T>() => Promise<R | null>;
  readonly all: <R = T>() => Promise<D1Result<R>>;
  readonly run: () => Promise<D1Result<T>>;
}
export interface D1DatabaseLike { readonly prepare: <T = Record<string, unknown>>(sql: string) => D1PreparedStatement<T>; readonly batch?: (statements: readonly D1PreparedStatement[]) => Promise<readonly D1Result[]> }
export interface Clock { readonly now: () => Date }

export class ScimDirectoryDenied extends Data.TaggedError("ScimDirectoryDenied")<{ readonly reason: string; readonly tenantId: string; readonly status: number; readonly scimType?: string }> {}
export class ScimDirectoryStoreUnavailable extends Data.TaggedError("ScimDirectoryStoreUnavailable")<{ readonly reason: string }> {}
export type ScimDirectoryError = ScimDirectoryDenied | ScimDirectoryStoreUnavailable;

export interface ProvisioningCredentialProof {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly credentialId?: string;
  readonly scopes: readonly string[];
}

export interface ScimRequestContext { readonly credential: ProvisioningCredentialProof; readonly baseUrl: string; readonly requestId?: string }
export interface ScimName { readonly givenName?: string; readonly familyName?: string }
export interface ScimEmail { readonly value: string; readonly primary?: boolean; readonly type?: string }
export interface ScimUserInput { readonly externalId: string; readonly userName: string; readonly active?: boolean; readonly displayName?: string; readonly name?: ScimName; readonly emails?: readonly ScimEmail[] }
export interface ScimGroupInput { readonly externalId: string; readonly displayName: string; readonly members?: readonly ScimGroupMemberInput[] }
export interface ScimGroupMemberInput { readonly value: string; readonly display?: string }
export interface ScimPatchOperation { readonly op: string; readonly path?: string; readonly value?: unknown }
export interface ScimListQuery { readonly startIndex?: number; readonly count?: number; readonly filter?: string }
export interface ScimListResponse<T> { readonly schemas: readonly ["urn:ietf:params:scim:api:messages:2.0:ListResponse"]; readonly totalResults: number; readonly startIndex: number; readonly itemsPerPage: number; readonly Resources: readonly T[] }
export interface ScimMeta { readonly resourceType: "User" | "Group"; readonly version: string; readonly lastModified: string; readonly location: string }
export interface ScimUserResource { readonly schemas: readonly ["urn:ietf:params:scim:schemas:core:2.0:User"]; readonly id: string; readonly externalId: string; readonly userName: string; readonly active: boolean; readonly displayName: string; readonly name: Required<ScimName>; readonly emails: readonly ScimEmail[]; readonly meta: ScimMeta }
export interface ScimGroupResource { readonly schemas: readonly ["urn:ietf:params:scim:schemas:core:2.0:Group"]; readonly id: string; readonly externalId: string; readonly displayName: string; readonly members: readonly { readonly value: string; readonly display: string }[]; readonly meta: ScimMeta }

export interface ScimDirectoryService {
  readonly createUser: (input: { readonly context: ScimRequestContext; readonly user: ScimUserInput }) => Effect.Effect<ScimUserResource, ScimDirectoryError>;
  readonly getUser: (input: { readonly context: ScimRequestContext; readonly id: string }) => Effect.Effect<ScimUserResource, ScimDirectoryError>;
  readonly listUsers: (input: { readonly context: ScimRequestContext; readonly query?: ScimListQuery }) => Effect.Effect<ScimListResponse<ScimUserResource>, ScimDirectoryError>;
  readonly replaceUser: (input: { readonly context: ScimRequestContext; readonly id: string; readonly user: ScimUserInput; readonly ifMatch?: string }) => Effect.Effect<ScimUserResource, ScimDirectoryError>;
  readonly patchUser: (input: { readonly context: ScimRequestContext; readonly id: string; readonly operations: readonly ScimPatchOperation[]; readonly ifMatch?: string }) => Effect.Effect<ScimUserResource, ScimDirectoryError>;
  readonly deleteUser: (input: { readonly context: ScimRequestContext; readonly id: string; readonly ifMatch?: string }) => Effect.Effect<ScimUserResource, ScimDirectoryError>;
  readonly createGroup: (input: { readonly context: ScimRequestContext; readonly group: ScimGroupInput }) => Effect.Effect<ScimGroupResource, ScimDirectoryError>;
  readonly getGroup: (input: { readonly context: ScimRequestContext; readonly id: string }) => Effect.Effect<ScimGroupResource, ScimDirectoryError>;
  readonly listGroups: (input: { readonly context: ScimRequestContext; readonly query?: ScimListQuery }) => Effect.Effect<ScimListResponse<ScimGroupResource>, ScimDirectoryError>;
  readonly replaceGroup: (input: { readonly context: ScimRequestContext; readonly id: string; readonly group: ScimGroupInput; readonly ifMatch?: string }) => Effect.Effect<ScimGroupResource, ScimDirectoryError>;
  readonly patchGroup: (input: { readonly context: ScimRequestContext; readonly id: string; readonly operations: readonly ScimPatchOperation[]; readonly ifMatch?: string }) => Effect.Effect<ScimGroupResource, ScimDirectoryError>;
  readonly deleteGroup: (input: { readonly context: ScimRequestContext; readonly id: string; readonly ifMatch?: string }) => Effect.Effect<ScimGroupResource, ScimDirectoryError>;
}

const systemClock: Clock = { now: () => new Date() };

type UserRow = { readonly id: string; readonly external_id: string; readonly principal_id: string; readonly active: number; readonly member_version: number; readonly profile_version: number; readonly updated_at: string; readonly user_name: string; readonly display_name: string; readonly given_name: string; readonly family_name: string; readonly emails_json: string; readonly tombstoned_at: string | null };
type GroupRow = { readonly id: string; readonly external_id: string; readonly name: string; readonly active: number; readonly version: number; readonly updated_at: string };
type ConnectionRow = { readonly active: number; readonly claims_json: string; readonly issuer: string };

export function makeD1ScimDirectory(db: D1DatabaseLike, options: { readonly clock?: Clock } = {}): ScimDirectoryService {
  const clock = options.clock ?? systemClock;
  return {
    createUser: (input) => Effect.tryPromise({ try: () => createUser(db, clock, input.context, input.user), catch: toError }),
    getUser: (input) => Effect.tryPromise({ try: () => readUserResource(db, input.context, input.id), catch: toError }),
    listUsers: (input) => Effect.tryPromise({ try: () => listUsers(db, clock, input.context, input.query ?? {}), catch: toError }),
    replaceUser: (input) => Effect.tryPromise({ try: () => replaceUser(db, clock, input.context, input.id, input.user, input.ifMatch), catch: toError }),
    patchUser: (input) => Effect.tryPromise({ try: () => patchUser(db, clock, input.context, input.id, input.operations, input.ifMatch), catch: toError }),
    deleteUser: (input) => Effect.tryPromise({ try: () => deleteUser(db, clock, input.context, input.id, input.ifMatch), catch: toError }),
    createGroup: (input) => Effect.tryPromise({ try: () => createGroup(db, clock, input.context, input.group), catch: toError }),
    getGroup: (input) => Effect.tryPromise({ try: () => readGroupResource(db, input.context, input.id), catch: toError }),
    listGroups: (input) => Effect.tryPromise({ try: () => listGroups(db, clock, input.context, input.query ?? {}), catch: toError }),
    replaceGroup: (input) => Effect.tryPromise({ try: () => replaceGroup(db, clock, input.context, input.id, input.group, input.ifMatch), catch: toError }),
    patchGroup: (input) => Effect.tryPromise({ try: () => patchGroup(db, clock, input.context, input.id, input.operations, input.ifMatch), catch: toError }),
    deleteGroup: (input) => Effect.tryPromise({ try: () => deleteGroup(db, clock, input.context, input.id, input.ifMatch), catch: toError })
  };
}

async function createUser(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, input: ScimUserInput): Promise<ScimUserResource> {
  await authorizeProvisioner(db, clock, context);
  const user = normalizeUserInput(context.credential.tenantId, input);
  const existing = await findUserByExternalId(db, context, user.externalId);
  if (existing) throw denied(context, "SCIM user externalId already exists", 409, "uniqueness");
  const now = clock.now().toISOString();
  const principalId = stableId("principal", context.credential.tenantId, context.credential.connectionId, user.externalId);
  const memberId = stableId("dir_user", context.credential.tenantId, context.credential.connectionId, user.externalId);
  const linkId = stableId("identity", context.credential.tenantId, context.credential.connectionId, user.externalId);
  const connection = await readConnection(db, context);
  await runAtomic(db, [
    stmt(db, "INSERT INTO principals(tenant_id,id,version,created_at,updated_at,kind,display_name,active,auth_epoch) VALUES(?,?,?,?,?,'human',?,0,1)", context.credential.tenantId, principalId, 1, now, now, user.displayName || user.userName),
    stmt(db, "INSERT INTO directory_members(tenant_id,id,version,created_at,updated_at,connection_id,external_id,principal_id,active,emails_json) VALUES(?,?,?,?,?,?,?,?,?,?)", context.credential.tenantId, memberId, 1, now, now, context.credential.connectionId, user.externalId, principalId, user.active ? 1 : 0, JSON.stringify(user.emails)),
    stmt(db, "INSERT INTO identity_links(tenant_id,id,version,created_at,updated_at,principal_id,connection_id,issuer,stable_subject,source_kind,source_id,verified) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)", context.credential.tenantId, linkId, 1, now, now, principalId, context.credential.connectionId, connection.issuer, user.externalId, "directory", user.externalId),
    stmt(db, "INSERT INTO scim_directory_profiles(tenant_id,connection_id,external_id,directory_member_id,user_name,display_name,given_name,family_name,emails_json,tombstoned_at,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,1,?,?)", context.credential.tenantId, context.credential.connectionId, user.externalId, memberId, user.userName, user.displayName, user.givenName, user.familyName, JSON.stringify(user.emails), now, now),
    auditStmt(db, context, now, context.credential.principalId, "identity.scim.user.create", "directory_user", memberId, digestPayload(user))
  ]);
  return readUserResource(db, context, memberId);
}

async function replaceUser(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, id: string, input: ScimUserInput, ifMatch: string | undefined): Promise<ScimUserResource> {
  await authorizeProvisioner(db, clock, context);
  const before = await readUserRow(db, context, id);
  requireVersion(context, before.member_version, ifMatch);
  const user = normalizeUserInput(context.credential.tenantId, input);
  if (user.externalId !== before.external_id) throw denied(context, "SCIM user externalId is immutable", 400, "mutability");
  await writeUserState(db, clock, context, before, user, "identity.scim.user.replace");
  return readUserResource(db, context, id);
}

async function patchUser(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, id: string, operations: readonly ScimPatchOperation[], ifMatch: string | undefined): Promise<ScimUserResource> {
  await authorizeProvisioner(db, clock, context);
  const before = await readUserRow(db, context, id);
  requireVersion(context, before.member_version, ifMatch);
  let user = userInputFromRow(before);
  for (const operation of operations) user = applyUserPatch(context, user, operation);
  await writeUserState(db, clock, context, before, user, "identity.scim.user.patch");
  return readUserResource(db, context, id);
}

async function deleteUser(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, id: string, ifMatch: string | undefined): Promise<ScimUserResource> {
  await authorizeProvisioner(db, clock, context);
  const before = await readUserRow(db, context, id);
  requireVersion(context, before.member_version, ifMatch);
  const next = { ...userInputFromRow(before), active: false };
  await writeUserState(db, clock, context, before, next, "identity.scim.user.delete", true);
  return readUserResource(db, context, id);
}

async function writeUserState(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, before: UserRow, user: NormalizedUser, operation: string, tombstone = false): Promise<void> {
  const now = clock.now().toISOString();
  const activeChanged = before.active !== (user.active ? 1 : 0);
  const principalActive = user.active && before.tombstoned_at === null ? "CASE WHEN EXISTS(SELECT 1 FROM identity_links WHERE tenant_id = ? AND connection_id = ? AND source_id = ? AND verified = 1) THEN 1 ELSE 0 END" : "0";
  const statements: D1PreparedStatement[] = [
    stmt(db, "UPDATE directory_members SET version = version + 1, updated_at = ?, active = ?, emails_json = ? WHERE tenant_id = ? AND id = ? AND version = ?", now, user.active ? 1 : 0, JSON.stringify(user.emails), context.credential.tenantId, before.id, before.member_version),
    stmt(db, `UPDATE principals SET version = version + 1, updated_at = ?, display_name = ?, active = ${principalActive}, auth_epoch = auth_epoch + ? WHERE tenant_id = ? AND id = ? AND EXISTS(SELECT 1 FROM directory_members WHERE tenant_id = ? AND id = ? AND version = ?)`, ...(principalActive.includes("SELECT") ? [now, user.displayName || user.userName, context.credential.tenantId, context.credential.connectionId, before.external_id, activeChanged ? 1 : 0, context.credential.tenantId, before.principal_id, context.credential.tenantId, before.id, before.member_version + 1] : [now, user.displayName || user.userName, activeChanged ? 1 : 0, context.credential.tenantId, before.principal_id, context.credential.tenantId, before.id, before.member_version + 1])),
    stmt(db, "UPDATE scim_directory_profiles SET version = version + 1, updated_at = ?, user_name = ?, display_name = ?, given_name = ?, family_name = ?, emails_json = ?, tombstoned_at = CASE WHEN ? THEN COALESCE(tombstoned_at, ?) ELSE tombstoned_at END WHERE tenant_id = ? AND connection_id = ? AND external_id = ? AND directory_member_id = ?", now, user.userName, user.displayName, user.givenName, user.familyName, JSON.stringify(user.emails), tombstone ? 1 : 0, now, context.credential.tenantId, context.credential.connectionId, before.external_id, before.id),
    auditStmt(db, context, now, context.credential.principalId, operation, "directory_user", before.id, digestPayload([before.id, user, tombstone]))
  ];
  if (activeChanged || tombstone) statements.push(...revocationStatements(db, context, now, before.principal_id));
  await runAtomic(db, statements);
}

async function createGroup(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, input: ScimGroupInput): Promise<ScimGroupResource> {
  await authorizeProvisioner(db, clock, context);
  const group = normalizeGroupInput(context, input);
  if (await findGroupByExternalId(db, context, group.externalId)) throw denied(context, "SCIM group externalId already exists", 409, "uniqueness");
  const memberPrincipals = await resolveMemberPrincipals(db, context, group.members);
  const now = clock.now().toISOString();
  const groupId = stableId("dir_group", context.credential.tenantId, context.credential.connectionId, group.externalId);
  await runAtomic(db, [
    stmt(db, "INSERT INTO groups(tenant_id,id,version,created_at,updated_at,connection_id,external_id,name,active) VALUES(?,?,?,?,?,?,?,?,1)", context.credential.tenantId, groupId, 1, now, now, context.credential.connectionId, group.externalId, group.displayName),
    ...memberPrincipals.map((member) => stmt(db, "INSERT INTO group_memberships(tenant_id,group_id,principal_id,directory_version) VALUES(?,?,?,1)", context.credential.tenantId, groupId, member.principalId)),
    stmt(db, "UPDATE tenants SET policy_epoch = policy_epoch + 1 WHERE id = ?", context.credential.tenantId),
    auditStmt(db, context, now, context.credential.principalId, "identity.scim.group.create", "directory_group", groupId, digestPayload(group))
  ]);
  return readGroupResource(db, context, groupId);
}

async function replaceGroup(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, id: string, input: ScimGroupInput, ifMatch: string | undefined): Promise<ScimGroupResource> {
  await authorizeProvisioner(db, clock, context);
  const before = await readGroupRow(db, context, id);
  requireVersion(context, before.version, ifMatch);
  const group = normalizeGroupInput(context, input);
  if (group.externalId !== before.external_id) throw denied(context, "SCIM group externalId is immutable", 400, "mutability");
  await writeGroupState(db, clock, context, before, group.displayName, group.members, true, "identity.scim.group.replace");
  return readGroupResource(db, context, id);
}

async function patchGroup(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, id: string, operations: readonly ScimPatchOperation[], ifMatch: string | undefined): Promise<ScimGroupResource> {
  await authorizeProvisioner(db, clock, context);
  const before = await readGroupRow(db, context, id);
  requireVersion(context, before.version, ifMatch);
  let displayName = before.name;
  let members = await readGroupMemberInputs(db, context, id);
  for (const operation of operations) {
    const op = operation.op.toLowerCase();
    if (op === "replace" && lower(operation.path) === "displayname" && typeof operation.value === "string") displayName = operation.value;
    else if ((op === "add" || op === "replace") && lower(operation.path) === "members") members = op === "replace" ? memberInputs(operation.value) : mergeMembers(members, memberInputs(operation.value));
    else if (op === "remove" && lower(operation.path) === "members") members = [];
    else if (op === "remove" && operation.path?.startsWith("members[")) members = members.filter((member) => member.value !== parseMemberFilter(context, operation.path ?? ""));
    else throw denied(context, "unsupported SCIM group patch operation", 400, "mutability");
  }
  await writeGroupState(db, clock, context, before, displayName, members, true, "identity.scim.group.patch");
  return readGroupResource(db, context, id);
}

async function deleteGroup(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, id: string, ifMatch: string | undefined): Promise<ScimGroupResource> {
  await authorizeProvisioner(db, clock, context);
  const before = await readGroupRow(db, context, id);
  requireVersion(context, before.version, ifMatch);
  await writeGroupState(db, clock, context, before, before.name, [], false, "identity.scim.group.delete");
  return readGroupResource(db, context, id);
}

async function writeGroupState(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, before: GroupRow, displayName: string, members: readonly ScimGroupMemberInput[], active: boolean, operation: string): Promise<void> {
  if (!nonEmpty(displayName)) throw denied(context, "SCIM group displayName is required", 400, "invalidValue");
  const resolved = await resolveMemberPrincipals(db, context, members);
  const now = clock.now().toISOString();
  await runAtomic(db, [
    stmt(db, "UPDATE groups SET version = version + 1, updated_at = ?, name = ?, active = ? WHERE tenant_id = ? AND id = ? AND version = ?", now, displayName, active ? 1 : 0, context.credential.tenantId, before.id, before.version),
    stmt(db, "DELETE FROM group_memberships WHERE tenant_id = ? AND group_id = ? AND EXISTS(SELECT 1 FROM groups WHERE tenant_id = ? AND id = ? AND version = ?)", context.credential.tenantId, before.id, context.credential.tenantId, before.id, before.version + 1),
    ...resolved.map((member) => stmt(db, "INSERT INTO group_memberships(tenant_id,group_id,principal_id,directory_version) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM groups WHERE tenant_id = ? AND id = ? AND version = ?)", context.credential.tenantId, before.id, member.principalId, before.version + 1, context.credential.tenantId, before.id, before.version + 1)),
    stmt(db, "UPDATE tenants SET policy_epoch = policy_epoch + 1 WHERE id = ? AND EXISTS(SELECT 1 FROM groups WHERE tenant_id = ? AND id = ? AND version = ?)", context.credential.tenantId, context.credential.tenantId, before.id, before.version + 1),
    auditStmt(db, context, now, context.credential.principalId, operation, "directory_group", before.id, digestPayload([before.id, displayName, active, members]))
  ]);
}

async function authorizeProvisioner(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext): Promise<void> {
  const credential = context.credential;
  if (!nonEmpty(credential.tenantId) || !nonEmpty(credential.connectionId) || !nonEmpty(credential.principalId)) throw denied(context, "provisioning credential proof incomplete", 401);
  if (!credential.scopes.includes("directory.write")) throw denied(context, "provisioning credential lacks directory.write", 403);
  const connection = await readConnection(db, context);
  if (connection.active !== 1 || !connectionIsQualified(connection.claims_json)) throw denied(context, "directory connection inactive or unqualified", 403);
  if (credential.credentialId) {
    const now = clock.now().toISOString();
    const row = await db.prepare("SELECT scopes_json FROM credentials WHERE tenant_id = ? AND id = ? AND principal_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1").bind(credential.tenantId, credential.credentialId, credential.principalId, now).first<{ scopes_json: string }>();
    if (!row || !parseStringArray(row.scopes_json).includes("directory.write")) throw denied(context, "provisioning credential record denied", 403);
  }
}

async function readConnection(db: D1DatabaseLike, context: ScimRequestContext): Promise<ConnectionRow> {
  const row = await db.prepare("SELECT active, claims_json, issuer FROM connections WHERE tenant_id = ? AND id = ? LIMIT 1").bind(context.credential.tenantId, context.credential.connectionId).first<ConnectionRow>();
  if (!row) throw denied(context, "directory connection missing", 404);
  return row;
}

async function readUserRow(db: D1DatabaseLike, context: ScimRequestContext, id: string): Promise<UserRow> {
  const row = await db.prepare(`SELECT dm.id, dm.external_id, dm.principal_id, dm.active, dm.version AS member_version, sp.version AS profile_version, sp.updated_at, sp.user_name, sp.display_name, sp.given_name, sp.family_name, sp.emails_json, sp.tombstoned_at FROM directory_members dm JOIN scim_directory_profiles sp ON sp.tenant_id = dm.tenant_id AND sp.connection_id = dm.connection_id AND sp.external_id = dm.external_id WHERE dm.tenant_id = ? AND dm.connection_id = ? AND dm.id = ? LIMIT 1`).bind(context.credential.tenantId, context.credential.connectionId, id).first<UserRow>();
  if (!row) throw denied(context, "SCIM user not found", 404);
  return row;
}

async function findUserByExternalId(db: D1DatabaseLike, context: ScimRequestContext, externalId: string): Promise<UserRow | null> {
  return await db.prepare(`SELECT dm.id, dm.external_id, dm.principal_id, dm.active, dm.version AS member_version, sp.version AS profile_version, sp.updated_at, sp.user_name, sp.display_name, sp.given_name, sp.family_name, sp.emails_json, sp.tombstoned_at FROM directory_members dm JOIN scim_directory_profiles sp ON sp.tenant_id = dm.tenant_id AND sp.connection_id = dm.connection_id AND sp.external_id = dm.external_id WHERE dm.tenant_id = ? AND dm.connection_id = ? AND dm.external_id = ? LIMIT 1`).bind(context.credential.tenantId, context.credential.connectionId, externalId).first<UserRow>();
}

async function readUserResource(db: D1DatabaseLike, context: ScimRequestContext, id: string): Promise<ScimUserResource> { return userResource(context, await readUserRow(db, context, id)) }

async function listUsers(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, query: ScimListQuery): Promise<ScimListResponse<ScimUserResource>> {
  await authorizeProvisioner(db, clock, context);
  const filter = parseFilter(context, query.filter, "User");
  const rows = await db.prepare(`SELECT dm.id, dm.external_id, dm.principal_id, dm.active, dm.version AS member_version, sp.version AS profile_version, sp.updated_at, sp.user_name, sp.display_name, sp.given_name, sp.family_name, sp.emails_json, sp.tombstoned_at FROM directory_members dm JOIN scim_directory_profiles sp ON sp.tenant_id = dm.tenant_id AND sp.connection_id = dm.connection_id AND sp.external_id = dm.external_id WHERE dm.tenant_id = ? AND dm.connection_id = ? ${filter.sql} ORDER BY sp.user_name, dm.id`).bind(context.credential.tenantId, context.credential.connectionId, ...filter.values).all<UserRow>();
  const resources = (rows.results ?? []).map((row) => userResource(context, row));
  return listResponse(resources, query);
}

async function readGroupRow(db: D1DatabaseLike, context: ScimRequestContext, id: string): Promise<GroupRow> {
  const row = await db.prepare("SELECT id, external_id, name, active, version, updated_at FROM groups WHERE tenant_id = ? AND connection_id = ? AND id = ? LIMIT 1").bind(context.credential.tenantId, context.credential.connectionId, id).first<GroupRow>();
  if (!row) throw denied(context, "SCIM group not found", 404);
  return row;
}

async function findGroupByExternalId(db: D1DatabaseLike, context: ScimRequestContext, externalId: string): Promise<GroupRow | null> {
  return await db.prepare("SELECT id, external_id, name, active, version, updated_at FROM groups WHERE tenant_id = ? AND connection_id = ? AND external_id = ? LIMIT 1").bind(context.credential.tenantId, context.credential.connectionId, externalId).first<GroupRow>();
}

async function readGroupResource(db: D1DatabaseLike, context: ScimRequestContext, id: string): Promise<ScimGroupResource> { return groupResource(context, await readGroupRow(db, context, id), await readGroupMembers(db, context, id)) }

async function listGroups(db: D1DatabaseLike, clock: Clock, context: ScimRequestContext, query: ScimListQuery): Promise<ScimListResponse<ScimGroupResource>> {
  await authorizeProvisioner(db, clock, context);
  const filter = parseFilter(context, query.filter, "Group");
  const rows = await db.prepare(`SELECT id, external_id, name, active, version, updated_at FROM groups WHERE tenant_id = ? AND connection_id = ? ${filter.sql} ORDER BY name, id`).bind(context.credential.tenantId, context.credential.connectionId, ...filter.values).all<GroupRow>();
  const resources = [] as ScimGroupResource[];
  for (const row of rows.results ?? []) resources.push(groupResource(context, row, await readGroupMembers(db, context, row.id)));
  return listResponse(resources, query);
}

async function readGroupMembers(db: D1DatabaseLike, context: ScimRequestContext, groupId: string): Promise<readonly { readonly value: string; readonly display: string }[]> {
  const rows = await db.prepare("SELECT dm.id AS value, sp.display_name AS display FROM group_memberships gm JOIN directory_members dm ON dm.tenant_id = gm.tenant_id AND dm.principal_id = gm.principal_id JOIN scim_directory_profiles sp ON sp.tenant_id = dm.tenant_id AND sp.connection_id = dm.connection_id AND sp.external_id = dm.external_id WHERE gm.tenant_id = ? AND gm.group_id = ? AND dm.connection_id = ? ORDER BY sp.display_name, dm.id").bind(context.credential.tenantId, groupId, context.credential.connectionId).all<{ value: string; display: string }>();
  return rows.results ?? [];
}

async function readGroupMemberInputs(db: D1DatabaseLike, context: ScimRequestContext, groupId: string): Promise<readonly ScimGroupMemberInput[]> { return (await readGroupMembers(db, context, groupId)).map((member) => ({ value: member.value, display: member.display })) }

async function resolveMemberPrincipals(db: D1DatabaseLike, context: ScimRequestContext, members: readonly ScimGroupMemberInput[]): Promise<readonly { readonly principalId: string }[]> {
  const out = [] as { readonly principalId: string }[];
  const seen = new Set<string>();
  for (const member of members) {
    if (!nonEmpty(member.value)) throw denied(context, "SCIM group member value is required", 400, "invalidValue");
    if (seen.has(member.value)) continue;
    seen.add(member.value);
    const row = await db.prepare("SELECT principal_id FROM directory_members WHERE tenant_id = ? AND connection_id = ? AND id = ? LIMIT 1").bind(context.credential.tenantId, context.credential.connectionId, member.value).first<{ principal_id: string }>();
    if (!row) throw denied(context, "SCIM group member not found in tenant connection", 400, "invalidValue");
    out.push({ principalId: row.principal_id });
  }
  return out;
}

function normalizeUserInput(tenantId: string, input: ScimUserInput): NormalizedUser {
  if (!nonEmpty(input.externalId) || !nonEmpty(input.userName)) throw new ScimDirectoryDenied({ reason: "SCIM user externalId and userName are required", tenantId, status: 400, scimType: "invalidValue" });
  if (input.externalId.length > 512 || input.userName.length > 512) throw new ScimDirectoryDenied({ reason: "SCIM user value too long", tenantId, status: 400, scimType: "invalidValue" });
  return { externalId: input.externalId, userName: input.userName, active: input.active ?? true, displayName: input.displayName ?? "", givenName: input.name?.givenName ?? "", familyName: input.name?.familyName ?? "", emails: normalizeEmails(tenantId, input.emails ?? []) };
}

interface NormalizedUser { readonly externalId: string; readonly userName: string; readonly active: boolean; readonly displayName: string; readonly givenName: string; readonly familyName: string; readonly emails: readonly ScimEmail[] }
function userInputFromRow(row: UserRow): NormalizedUser { return { externalId: row.external_id, userName: row.user_name, active: row.active === 1, displayName: row.display_name, givenName: row.given_name, familyName: row.family_name, emails: parseEmails(row.emails_json) } }

function applyUserPatch(context: ScimRequestContext, user: NormalizedUser, operation: ScimPatchOperation): NormalizedUser {
  const op = operation.op.toLowerCase();
  const path = lower(operation.path ?? "");
  if ((op === "replace" || op === "add") && path === "active" && typeof operation.value === "boolean") return { ...user, active: operation.value };
  if ((op === "replace" || op === "add") && path === "username" && typeof operation.value === "string") return { ...user, userName: operation.value };
  if ((op === "replace" || op === "add") && path === "displayname" && typeof operation.value === "string") return { ...user, displayName: operation.value };
  if ((op === "replace" || op === "add") && path === "name.givenname" && typeof operation.value === "string") return { ...user, givenName: operation.value };
  if ((op === "replace" || op === "add") && path === "name.familyname" && typeof operation.value === "string") return { ...user, familyName: operation.value };
  if ((op === "replace" || op === "add") && path === "emails") return { ...user, emails: normalizeEmails(context.credential.tenantId, emailInputs(operation.value)) };
  if (op === "remove" && path === "emails") return { ...user, emails: [] };
  if (op === "remove" && path === "displayname") return { ...user, displayName: "" };
  throw denied(context, "unsupported SCIM user patch operation", 400, "mutability");
}

function normalizeGroupInput(context: ScimRequestContext, input: ScimGroupInput): { readonly externalId: string; readonly displayName: string; readonly members: readonly ScimGroupMemberInput[] } {
  if (!nonEmpty(input.externalId) || !nonEmpty(input.displayName)) throw denied(context, "SCIM group externalId and displayName are required", 400, "invalidValue");
  return { externalId: input.externalId, displayName: input.displayName, members: memberInputs(input.members ?? []) };
}

function userResource(context: ScimRequestContext, row: UserRow): ScimUserResource {
  return { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], id: row.id, externalId: row.external_id, userName: row.user_name, active: row.active === 1, displayName: row.display_name, name: { givenName: row.given_name, familyName: row.family_name }, emails: parseEmails(row.emails_json), meta: meta(context, "User", row.id, row.member_version, row.updated_at) };
}

function groupResource(context: ScimRequestContext, row: GroupRow, members: readonly { readonly value: string; readonly display: string }[]): ScimGroupResource {
  return { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], id: row.id, externalId: row.external_id, displayName: row.name, members, meta: meta(context, "Group", row.id, row.version, row.updated_at) };
}

function meta(context: ScimRequestContext, resourceType: "User" | "Group", id: string, version: number, updatedAt: string): ScimMeta {
  return { resourceType, version: `W/\"${version}\"`, lastModified: updatedAt, location: `${context.baseUrl.replace(/\/$/, "")}/${resourceType}s/${encodeURIComponent(id)}` };
}

function parseFilter(context: ScimRequestContext, filter: string | undefined, resourceType: "User" | "Group"): { readonly sql: string; readonly values: readonly string[] } {
  if (!filter) return { sql: "", values: [] };
  const match = /^(id|externalId|userName|displayName) eq "([^"]{1,512})"$/i.exec(filter.trim());
  if (!match) throw denied(context, "unsupported SCIM filter", 400, "invalidFilter");
  const attr = lower(match[1] ?? "");
  const value = match[2] ?? "";
  if (resourceType === "User") {
    if (attr === "id") return { sql: "AND dm.id = ?", values: [value] };
    if (attr === "externalid") return { sql: "AND dm.external_id = ?", values: [value] };
    if (attr === "username") return { sql: "AND sp.user_name = ?", values: [value] };
  }
  if (resourceType === "Group") {
    if (attr === "id") return { sql: "AND id = ?", values: [value] };
    if (attr === "externalid") return { sql: "AND external_id = ?", values: [value] };
    if (attr === "displayname") return { sql: "AND name = ?", values: [value] };
  }
  throw denied(context, "unsupported SCIM filter attribute", 400, "invalidFilter");
}

function listResponse<T>(resources: readonly T[], query: ScimListQuery): ScimListResponse<T> {
  const startIndex = Math.max(1, query.startIndex ?? 1);
  const count = Math.min(200, Math.max(0, query.count ?? 100));
  const page = resources.slice(startIndex - 1, startIndex - 1 + count);
  return { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: resources.length, startIndex, itemsPerPage: page.length, Resources: page };
}

function requireVersion(context: ScimRequestContext, current: number, ifMatch: string | undefined): void {
  if (ifMatch === undefined) return;
  const match = /^W\/"(\d+)"$|^"(\d+)"$|^(\d+)$/.exec(ifMatch);
  const expected = Number(match?.[1] ?? match?.[2] ?? match?.[3] ?? NaN);
  if (!Number.isSafeInteger(expected) || expected !== current) throw denied(context, "SCIM version precondition failed", 412, "versionMismatch");
}

function revocationStatements(db: D1DatabaseLike, context: ScimRequestContext, now: string, principalId: string): D1PreparedStatement[] {
  return [
    stmt(db, "UPDATE tenants SET policy_epoch = policy_epoch + 1 WHERE id = ?", context.credential.tenantId),
    stmt(db, "UPDATE credentials SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE tenant_id = ? AND principal_id = ?", now, now, context.credential.tenantId, principalId),
    stmt(db, "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'directory_lifecycle') WHERE tenant_id = ? AND principal_id = ?", now, context.credential.tenantId, principalId),
    stmt(db, "UPDATE auth_refresh_families SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'directory_lifecycle') WHERE tenant_id = ? AND principal_id = ?", now, context.credential.tenantId, principalId)
  ];
}

function auditStmt(db: D1DatabaseLike, context: ScimRequestContext, now: string, actorId: string, operation: string, resourceKind: string, resourceId: string, payloadDigest: string): D1PreparedStatement {
  return stmt(db, "INSERT INTO audit(tenant_id,id,version,created_at,updated_at,actor_id,operation,resource_kind,resource_id,decision,policy_epoch,request_id,payload_digest,r2_record_key) SELECT ?,?,?,?,?,?,?,?,?,?,?,?, ?, ? FROM tenants WHERE id = ?", context.credential.tenantId, randomId("audit"), 1, now, now, actorId, operation, resourceKind, resourceId, "allow", 0, context.requestId ?? randomId("request"), payloadDigest, "inline:" + payloadDigest, context.credential.tenantId);
}

async function runAtomic(db: D1DatabaseLike, statements: readonly D1PreparedStatement[]): Promise<void> {
  if (!db.batch) throw new Error("D1 batch transaction support required");
  await db.batch(statements);
}

function stmt(db: D1DatabaseLike, sql: string, ...values: readonly unknown[]): D1PreparedStatement { return db.prepare(sql).bind(...values) }
function denied(context: Pick<ScimRequestContext, "credential">, reason: string, status = 403, scimType?: string): ScimDirectoryDenied { return new ScimDirectoryDenied({ reason, tenantId: context.credential.tenantId, status, ...(scimType ? { scimType } : {}) }) }
function toError(error: unknown): ScimDirectoryError { return error instanceof ScimDirectoryDenied ? error : new ScimDirectoryStoreUnavailable({ reason: String(error) }) }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 }
function lower(value: string | undefined): string { return (value ?? "").toLowerCase() }
function connectionIsQualified(value: string): boolean { try { const parsed = JSON.parse(value) as Record<string, unknown>; return parsed.identity_qualified === true && typeof parsed.immutable_subject_claim === "string" && parsed.immutable_subject_claim.length > 0; } catch { return false; } }
function parseStringArray(value: string): readonly string[] { try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []; } catch { return []; } }
function normalizeEmails(tenantId: string, emails: readonly ScimEmail[]): readonly ScimEmail[] { return emails.map((email) => { if (!nonEmpty(email.value) || email.value.length > 512) throw new ScimDirectoryDenied({ reason: "SCIM email value invalid", tenantId, status: 400, scimType: "invalidValue" }); return { value: email.value, ...(email.primary !== undefined ? { primary: email.primary } : {}), ...(email.type !== undefined ? { type: email.type } : {}) }; }); }
function parseEmails(value: string): readonly ScimEmail[] { try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((entry): entry is ScimEmail => typeof entry === "object" && entry !== null && typeof (entry as { value?: unknown }).value === "string") : []; } catch { return []; } }
function emailInputs(value: unknown): readonly ScimEmail[] { return Array.isArray(value) ? value as readonly ScimEmail[] : [value as ScimEmail] }
function memberInputs(value: unknown): readonly ScimGroupMemberInput[] { if (value === undefined) return []; const raw = Array.isArray(value) ? value : [value]; return raw.map((entry) => { if (typeof entry === "string") return { value: entry }; if (typeof entry === "object" && entry !== null && typeof (entry as { value?: unknown }).value === "string") { const display = (entry as { display?: unknown }).display; return typeof display === "string" ? { value: (entry as { value: string }).value, display } : { value: (entry as { value: string }).value }; } throw new Error("invalid member input"); }); }
function mergeMembers(left: readonly ScimGroupMemberInput[], right: readonly ScimGroupMemberInput[]): readonly ScimGroupMemberInput[] { const map = new Map<string, ScimGroupMemberInput>(); for (const member of [...left, ...right]) map.set(member.value, member); return [...map.values()]; }
function parseMemberFilter(context: ScimRequestContext, path: string): string { const match = /^members\[value eq "([^"]{1,512})"\]$/i.exec(path); if (!match?.[1]) throw denied(context, "unsupported SCIM member selector", 400, "invalidFilter"); return match[1]; }
function stableId(prefix: string, ...parts: readonly string[]): string { return `${prefix}_${stableDigest(parts.join("\u001f"))}` }
function randomId(prefix: string): string { const bytes = new Uint8Array(12); globalThis.crypto.getRandomValues(bytes); return `${prefix}_${base64Url(bytes)}` }
function base64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") }
function digestPayload(value: unknown): string { return "sha256:" + stableDigest(JSON.stringify(value)) }
function stableDigest(value: string): string { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0") }
