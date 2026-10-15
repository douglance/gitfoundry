CREATE TABLE IF NOT EXISTS github_workflow_runs (
  tenant_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  workflows_json TEXT NOT NULL CHECK(json_valid(workflows_json)),
  version_commit TEXT NOT NULL,
  code_commit TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatching','running','completed','failed','reconciliation_required')),
  conclusion TEXT CHECK(conclusion IN ('success','failure','cancelled')),
  backend_run_id TEXT,
  lease_id TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (tenant_id, repository_id, id),
  UNIQUE (tenant_id, repository_id, operation_id)
);

CREATE INDEX IF NOT EXISTS github_workflow_runs_list_idx ON github_workflow_runs(tenant_id, repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS github_workflow_runs_status_idx ON github_workflow_runs(tenant_id, repository_id, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS github_workflow_runs_backend_idx ON github_workflow_runs(tenant_id, repository_id, backend_run_id) WHERE backend_run_id IS NOT NULL;
