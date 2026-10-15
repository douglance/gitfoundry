CREATE TABLE IF NOT EXISTS scim_directory_profiles (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  directory_member_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  given_name TEXT NOT NULL DEFAULT '',
  family_name TEXT NOT NULL DEFAULT '',
  emails_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(emails_json)),
  tombstoned_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, connection_id, external_id),
  UNIQUE(tenant_id, directory_member_id),
  FOREIGN KEY(tenant_id, connection_id, external_id) REFERENCES directory_members(tenant_id, connection_id, external_id),
  FOREIGN KEY(tenant_id, directory_member_id) REFERENCES directory_members(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS scim_transaction_assertions (
  id TEXT PRIMARY KEY
);

CREATE INDEX IF NOT EXISTS scim_directory_profiles_user_name_idx ON scim_directory_profiles(tenant_id, connection_id, user_name);
