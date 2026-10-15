CREATE TABLE owner_access_bindings (
 tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
 principal_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 public_audience TEXT NOT NULL,
 mcp_audience TEXT,
 subject TEXT NOT NULL,
 email TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','revoked')),
 created_at TEXT NOT NULL,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE owner_access_grants (
 tenant_id TEXT NOT NULL,
 id TEXT NOT NULL,
 principal_id TEXT NOT NULL,
 resource_kind TEXT NOT NULL CHECK(resource_kind='tenant'),
 resource_id TEXT NOT NULL,
 role_id TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id),
 FOREIGN KEY(tenant_id,role_id) REFERENCES roles(tenant_id,id)
);
