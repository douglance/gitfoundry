-- gitfoundry normative relational baseline. SQLite and D1 compatible. No secret plaintext.
PRAGMA foreign_keys=ON;
CREATE TABLE tenants(id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, state TEXT NOT NULL, policy_epoch INTEGER NOT NULL DEFAULT 1, shard_id TEXT NOT NULL, jurisdiction TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json)));
CREATE TABLE connections (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 issuer TEXT NOT NULL, external_tenant_id TEXT NOT NULL, audience TEXT NOT NULL, claims_json TEXT NOT NULL CHECK(json_valid(claims_json)), active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 UNIQUE(tenant_id,issuer,external_tenant_id)
);
CREATE TABLE principals (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('human','service','extension','job','migration','system','historical')), display_name TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), auth_epoch INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 CHECK(kind!='historical' OR active=0)
);
CREATE TABLE directory_members (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 connection_id TEXT NOT NULL, external_id TEXT NOT NULL, principal_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN(0,1)), emails_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(emails_json)),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id), UNIQUE(tenant_id,connection_id,external_id)
);
CREATE TABLE groups (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 connection_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN(0,1)),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id), UNIQUE(tenant_id,connection_id,external_id)
);
CREATE TABLE group_memberships(tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, principal_id TEXT NOT NULL, directory_version INTEGER NOT NULL, PRIMARY KEY(tenant_id,group_id,principal_id), FOREIGN KEY(tenant_id,group_id) REFERENCES groups(tenant_id,id), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id));
CREATE TABLE roles (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 name TEXT NOT NULL, capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 UNIQUE(tenant_id,name)
);
CREATE TABLE grants (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 subject_kind TEXT NOT NULL CHECK(subject_kind IN('group','service','tenant_role','recovery_human')), subject_id TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, role_id TEXT NOT NULL, expires_at TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,role_id) REFERENCES roles(tenant_id,id), CHECK(subject_kind!='recovery_human' OR expires_at IS NOT NULL)
);
CREATE TABLE credentials (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 principal_id TEXT NOT NULL, token_hash TEXT NOT NULL, scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)), expires_at TEXT NOT NULL, revoked_at TEXT, credential_epoch INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id), UNIQUE(tenant_id,token_hash)
);
CREATE TRIGGER historical_credentials_insert BEFORE INSERT ON credentials WHEN EXISTS(SELECT 1 FROM principals WHERE tenant_id=NEW.tenant_id AND id=NEW.principal_id AND kind='historical') BEGIN SELECT RAISE(ABORT,'historical principal cannot receive credentials'); END;
CREATE TRIGGER historical_credentials_update BEFORE UPDATE OF principal_id ON credentials WHEN EXISTS(SELECT 1 FROM principals WHERE tenant_id=NEW.tenant_id AND id=NEW.principal_id AND kind='historical') BEGIN SELECT RAISE(ABORT,'historical principal cannot receive credentials'); END;
CREATE TABLE organization_namespaces (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 name TEXT NOT NULL, description TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 UNIQUE(tenant_id,name)
);
CREATE TABLE identity_links (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 principal_id TEXT NOT NULL, connection_id TEXT NOT NULL, issuer TEXT NOT NULL, stable_subject TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, verified INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id), FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id), UNIQUE(tenant_id,connection_id,stable_subject,source_kind,source_id)
);
CREATE TABLE repositories (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 namespace_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN('private','internal','public')), default_branch TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, artifacts_namespace TEXT NOT NULL, artifacts_name TEXT NOT NULL, fork_of TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 UNIQUE(tenant_id,namespace_id,name), FOREIGN KEY(tenant_id,namespace_id) REFERENCES organization_namespaces(tenant_id,id), FOREIGN KEY(tenant_id,fork_of) REFERENCES repositories(tenant_id,id)
);
CREATE TABLE repo_counters (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, next_number INTEGER NOT NULL CHECK(next_number>0),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), UNIQUE(tenant_id,repository_id)
);
CREATE TABLE rulesets (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, priority INTEGER NOT NULL, rules_json TEXT NOT NULL CHECK(json_valid(rules_json)), enabled INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id)
);
CREATE TABLE git_mutations (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, actor_id TEXT NOT NULL, state TEXT NOT NULL, fencing_token TEXT NOT NULL, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)), result_json TEXT, observed_refs_json TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE issues (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('open','closed')), state_reason TEXT NOT NULL, author_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('issue','pull_request')),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,author_id) REFERENCES principals(tenant_id,id), UNIQUE(tenant_id,repository_id,number)
);
CREATE TABLE pull_requests (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 issue_id TEXT NOT NULL, repository_id TEXT NOT NULL, source_repository_id TEXT NOT NULL, source_ref TEXT NOT NULL, target_ref TEXT NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, draft INTEGER NOT NULL, merge_sha TEXT, merged_at TEXT, closed_at TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,issue_id) REFERENCES issues(tenant_id,id), FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,source_repository_id) REFERENCES repositories(tenant_id,id), UNIQUE(tenant_id,issue_id)
);
CREATE TABLE reviews (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, pull_request_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, head_sha TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,pull_request_id) REFERENCES pull_requests(tenant_id,id), FOREIGN KEY(tenant_id,reviewer_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE comments (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, anchor_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(anchor_json)), deleted_at TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,author_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE labels (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, description TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), UNIQUE(tenant_id,repository_id,name)
);
CREATE TABLE issue_labels(tenant_id TEXT NOT NULL, issue_id TEXT NOT NULL, label_id TEXT NOT NULL, PRIMARY KEY(tenant_id,issue_id,label_id), FOREIGN KEY(tenant_id,issue_id) REFERENCES issues(tenant_id,id), FOREIGN KEY(tenant_id,label_id) REFERENCES labels(tenant_id,id));
CREATE TABLE issue_assignees(tenant_id TEXT NOT NULL, issue_id TEXT NOT NULL, principal_id TEXT NOT NULL, PRIMARY KEY(tenant_id,issue_id,principal_id), FOREIGN KEY(tenant_id,issue_id) REFERENCES issues(tenant_id,id), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id));
CREATE TABLE milestones (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, due_at TEXT, state TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id)
);
CREATE TABLE eligibility (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, pull_request_id TEXT NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, candidate_sha TEXT NOT NULL, policy_epoch INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), expires_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,pull_request_id) REFERENCES pull_requests(tenant_id,id)
);
CREATE TABLE merge_queue (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, pull_request_id TEXT NOT NULL, position INTEGER NOT NULL, state TEXT NOT NULL, eligibility_id TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,pull_request_id) REFERENCES pull_requests(tenant_id,id), FOREIGN KEY(tenant_id,eligibility_id) REFERENCES eligibility(tenant_id,id)
);
CREATE TABLE runs (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, commit_sha TEXT NOT NULL, workflow_path TEXT NOT NULL, workflow_digest TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, plan_key TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id)
);
CREATE TABLE jobs (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 run_id TEXT NOT NULL, logical_key TEXT NOT NULL, matrix_json TEXT NOT NULL CHECK(json_valid(matrix_json)), dependency_json TEXT NOT NULL CHECK(json_valid(dependency_json)), status TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id), UNIQUE(tenant_id,run_id,logical_key)
);
CREATE TABLE job_attempts (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 job_id TEXT NOT NULL, attempt INTEGER NOT NULL, state TEXT NOT NULL, lease_generation INTEGER NOT NULL, fencing_token TEXT NOT NULL, image_digest TEXT NOT NULL, command_digest TEXT NOT NULL, started_at TEXT, finished_at TEXT, exit_code INTEGER,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id), UNIQUE(tenant_id,job_id,attempt)
);
CREATE TABLE checks (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, commit_sha TEXT NOT NULL, evidence_kind TEXT NOT NULL CHECK(evidence_kind IN('native_job','external','historical')), candidate_bound INTEGER NOT NULL CHECK(candidate_bound IN(0,1)), head_sha TEXT NOT NULL, base_sha TEXT, execution_sha TEXT, plan_digest TEXT, policy_digest TEXT, job_attempt_id TEXT, provider_evidence_ref TEXT, name TEXT NOT NULL, producer_id TEXT NOT NULL, status TEXT NOT NULL, conclusion TEXT, source_run_id TEXT, details_key TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,source_run_id) REFERENCES runs(tenant_id,id), FOREIGN KEY(tenant_id,job_attempt_id) REFERENCES job_attempts(tenant_id,id), CHECK(candidate_bound=0 OR (base_sha IS NOT NULL AND execution_sha IS NOT NULL AND plan_digest IS NOT NULL AND policy_digest IS NOT NULL)), CHECK(evidence_kind!='native_job' OR job_attempt_id IS NOT NULL), CHECK(evidence_kind='native_job' OR provider_evidence_ref IS NOT NULL)
);
CREATE TABLE environments (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, name TEXT NOT NULL, policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), UNIQUE(tenant_id,repository_id,name)
);
CREATE TABLE secrets (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT, environment_id TEXT, name TEXT NOT NULL, secret_store_ref TEXT NOT NULL, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), rotation_version INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,environment_id) REFERENCES environments(tenant_id,id)
);
CREATE TABLE artifacts (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, run_id TEXT, name TEXT NOT NULL, r2_key TEXT NOT NULL, digest TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0), expires_at TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id)
);
CREATE TABLE cache_entries (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, trust_domain TEXT NOT NULL, cache_key TEXT NOT NULL, restore_prefix TEXT NOT NULL, snapshot_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, expires_at TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), UNIQUE(tenant_id,repository_id,trust_domain,cache_key)
);
CREATE TABLE releases (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT NOT NULL, tag_name TEXT NOT NULL, commit_sha TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, draft INTEGER NOT NULL, prerelease INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), UNIQUE(tenant_id,repository_id,tag_name)
);
CREATE TABLE projects (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 name TEXT NOT NULL, fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id)
);
CREATE TABLE project_items (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 project_id TEXT NOT NULL, repository_id TEXT NOT NULL, subject_id TEXT NOT NULL, values_json TEXT NOT NULL CHECK(json_valid(values_json)),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id), FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id)
);
CREATE TABLE extensions (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 name TEXT NOT NULL, semver TEXT NOT NULL, manifest_digest TEXT NOT NULL, manifest_key TEXT NOT NULL, signature_key_id TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 UNIQUE(tenant_id,name,semver)
);
CREATE TABLE extension_installations (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 extension_id TEXT NOT NULL, state TEXT NOT NULL, capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)), config_key TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,extension_id) REFERENCES extensions(tenant_id,id)
);
CREATE TABLE oauth_apps (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 client_id TEXT NOT NULL, redirect_uris_json TEXT NOT NULL CHECK(json_valid(redirect_uris_json)), scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)), secret_hash TEXT, active INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 UNIQUE(tenant_id,client_id)
);
CREATE TABLE oauth_grants (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 app_id TEXT NOT NULL, principal_id TEXT NOT NULL, scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)), token_family_id TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,app_id) REFERENCES oauth_apps(tenant_id,id), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE oauth_connections (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 installation_id TEXT, provider TEXT NOT NULL, external_tenant_id TEXT NOT NULL, secret_store_ref TEXT NOT NULL, state TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,installation_id) REFERENCES extension_installations(tenant_id,id)
);
CREATE TABLE events (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL, aggregate_sequence INTEGER NOT NULL CHECK(aggregate_sequence>0), envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)), occurred_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 UNIQUE(tenant_id,aggregate_type,aggregate_id,aggregate_sequence)
);
CREATE TABLE outbox (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 event_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES events(tenant_id,id), UNIQUE(tenant_id,event_id)
);
CREATE TABLE subscriptions (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 installation_id TEXT, event_types_json TEXT NOT NULL CHECK(json_valid(event_types_json)), endpoint TEXT, state TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,installation_id) REFERENCES extension_installations(tenant_id,id)
);
CREATE TABLE deliveries (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, response_code INTEGER,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,subscription_id) REFERENCES subscriptions(tenant_id,id), FOREIGN KEY(tenant_id,event_id) REFERENCES events(tenant_id,id), UNIQUE(tenant_id,subscription_id,event_id)
);
CREATE TABLE operations (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 kind TEXT NOT NULL, actor_id TEXT NOT NULL, state TEXT NOT NULL, progress_json TEXT NOT NULL CHECK(json_valid(progress_json)), result_key TEXT, error_json TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE idempotency (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 actor_id TEXT NOT NULL, operation_kind TEXT NOT NULL, key TEXT NOT NULL, request_digest TEXT NOT NULL, response_key TEXT NOT NULL, expires_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id), UNIQUE(tenant_id,actor_id,operation_kind,key)
);
CREATE TABLE migrations (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 source_host TEXT NOT NULL, source_organization TEXT NOT NULL, state TEXT NOT NULL, plan_key TEXT NOT NULL, checkpoint_key TEXT NOT NULL, report_key TEXT, approved_by TEXT,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,approved_by) REFERENCES principals(tenant_id,id)
);
CREATE TABLE migration_mappings (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 migration_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, mapping_state TEXT NOT NULL, checksum TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,migration_id) REFERENCES migrations(tenant_id,id), UNIQUE(tenant_id,migration_id,source_kind,source_id)
);
CREATE TABLE audit (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 actor_id TEXT NOT NULL, operation TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, decision TEXT NOT NULL, policy_epoch INTEGER NOT NULL, request_id TEXT NOT NULL, payload_digest TEXT NOT NULL, r2_record_key TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals(tenant_id,id)
);
CREATE TABLE notifications (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 principal_id TEXT NOT NULL, event_id TEXT NOT NULL, read_at TEXT, reason TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES principals(tenant_id,id), FOREIGN KEY(tenant_id,event_id) REFERENCES events(tenant_id,id)
);
CREATE TABLE search_documents (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 repository_id TEXT, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, resource_version INTEGER NOT NULL, title TEXT NOT NULL, text_content TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 FOREIGN KEY(tenant_id,repository_id) REFERENCES repositories(tenant_id,id), UNIQUE(tenant_id,resource_kind,resource_id)
);
CREATE INDEX idx_issues_query ON issues(tenant_id,repository_id,state,number);
CREATE INDEX idx_pull_requests_query ON pull_requests(tenant_id,repository_id,head_sha);
CREATE INDEX idx_reviews_query ON reviews(tenant_id,pull_request_id,head_sha);
CREATE INDEX idx_comments_query ON comments(tenant_id,subject_kind,subject_id,created_at);
CREATE INDEX idx_checks_query ON checks(tenant_id,repository_id,commit_sha,name);
CREATE INDEX idx_runs_query ON runs(tenant_id,repository_id,status,created_at);
CREATE INDEX idx_jobs_query ON jobs(tenant_id,run_id,status);
CREATE INDEX idx_job_attempts_query ON job_attempts(tenant_id,job_id,state);
CREATE INDEX idx_grants_query ON grants(tenant_id,subject_kind,subject_id,resource_kind,resource_id);
CREATE INDEX idx_deliveries_query ON deliveries(tenant_id,state,next_attempt_at);
CREATE INDEX idx_outbox_query ON outbox(tenant_id,state,next_attempt_at);
CREATE INDEX idx_audit_query ON audit(tenant_id,created_at,operation);
CREATE INDEX idx_search_documents_query ON search_documents(tenant_id,repository_id,resource_kind);
