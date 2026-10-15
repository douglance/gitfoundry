CREATE TABLE IF NOT EXISTS auth_refresh_families (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  authenticated_at TEXT NOT NULL,
  authentication_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  current_generation INTEGER NOT NULL DEFAULT 0 CHECK(current_generation >= 0),
  revoked_at TEXT,
  revoked_reason TEXT,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id) REFERENCES tenants(id),
  FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
  resources_json TEXT NOT NULL CHECK(json_valid(resources_json)),
  auth_epoch INTEGER NOT NULL,
  tenant_policy_epoch INTEGER NOT NULL,
  access_token_hash TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_family_id TEXT NOT NULL,
  refresh_generation INTEGER NOT NULL CHECK(refresh_generation >= 0),
  refresh_token_hash TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  last_used_at TEXT,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id) REFERENCES tenants(id),
  FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),
  FOREIGN KEY(tenant_id,refresh_family_id) REFERENCES auth_refresh_families(tenant_id,id),
  UNIQUE(tenant_id,access_token_hash),
  UNIQUE(tenant_id,refresh_token_hash)
);

CREATE TABLE IF NOT EXISTS auth_refresh_token_history (
  tenant_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
  resources_json TEXT NOT NULL CHECK(json_valid(resources_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  reused_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY(tenant_id,family_id,generation),
  FOREIGN KEY(tenant_id,family_id) REFERENCES auth_refresh_families(tenant_id,id),
  FOREIGN KEY(tenant_id,session_id) REFERENCES auth_sessions(tenant_id,id),
  UNIQUE(tenant_id,token_hash)
);

CREATE TABLE IF NOT EXISTS auth_transaction_assertions (
  id TEXT PRIMARY KEY CHECK(id = 'auth-transaction-assertion')
);
INSERT OR IGNORE INTO auth_transaction_assertions(id) VALUES('auth-transaction-assertion');

CREATE INDEX IF NOT EXISTS auth_sessions_access_idx ON auth_sessions(tenant_id,access_token_hash);
CREATE INDEX IF NOT EXISTS auth_sessions_principal_idx ON auth_sessions(tenant_id,principal_id,created_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_family_idx ON auth_sessions(tenant_id,refresh_family_id);
CREATE INDEX IF NOT EXISTS auth_refresh_history_token_idx ON auth_refresh_token_history(tenant_id,token_hash);
CREATE INDEX IF NOT EXISTS auth_refresh_families_principal_idx ON auth_refresh_families(tenant_id,principal_id,created_at DESC);
