CREATE TABLE IF NOT EXISTS resource_events (
 tenant_id TEXT NOT NULL, id INTEGER PRIMARY KEY AUTOINCREMENT, cursor TEXT NOT NULL DEFAULT '', source_event_id TEXT NOT NULL, occurred_at TEXT NOT NULL, repository_id TEXT, kind TEXT NOT NULL, operation_id TEXT NOT NULL, resource_uris_json TEXT NOT NULL CHECK(json_valid(resource_uris_json)), authoritative_revision TEXT NOT NULL,
 FOREIGN KEY(tenant_id) REFERENCES tenants(id), FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), UNIQUE(tenant_id,source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_events_tenant_id ON resource_events(tenant_id,id);
CREATE INDEX IF NOT EXISTS idx_resource_events_repo_id ON resource_events(tenant_id,repository_id,id);
