CREATE TABLE IF NOT EXISTS pr_eligibility_generations (
 tenant_id TEXT NOT NULL,
 pull_request_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 logical_key TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 actor_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('running','complete','failed')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 committed_at TEXT NOT NULL,
 head_sha TEXT NOT NULL,
 base_sha TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN('merge','squash','rebase','fast-forward')),
 policy_digest TEXT NOT NULL,
 progress_json TEXT NOT NULL CHECK(json_valid(progress_json)),
 snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
 error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
 PRIMARY KEY(tenant_id,operation_id),
 UNIQUE(tenant_id,pull_request_id,logical_key,generation),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,pull_request_id) REFERENCES pull_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS pr_eligibility_active (
 tenant_id TEXT NOT NULL,
 pull_request_id TEXT NOT NULL,
 logical_key TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,pull_request_id,logical_key)
);
CREATE INDEX IF NOT EXISTS idx_pr_eligibility_generation_lookup ON pr_eligibility_generations(tenant_id,pull_request_id,logical_key,generation);
CREATE INDEX IF NOT EXISTS idx_pr_eligibility_active_operation ON pr_eligibility_active(tenant_id,operation_id);
