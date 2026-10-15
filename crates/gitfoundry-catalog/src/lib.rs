use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use incurs::cli::Cli;
use incurs::command::{
    CommandContext, CommandDef, CommandHandler, McpAnnotations, McpCommandOptions,
};
use incurs::output::CommandResult;
use incurs::schema::{FieldMeta, FieldType};
use serde::{Deserialize, Serialize};
use serde_json::Value;

include!(concat!(env!("OUT_DIR"), "/generated_catalog.rs"));

const FORK_CATALOG_JSON: &str = include_str!("../../../packages/contracts/src/fork-catalog.json");

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct NativeOperation {
    pub id: String,
    pub method: String,
    pub path: String,
    pub capability: String,
    pub output_schema: String,
    pub input_schema: Option<String>,
    pub asynchronous: bool,
    pub cli: String,
    pub mcp_tool: String,
    pub request_schema: Option<String>,
    pub request_location: String,
    pub batch_eligible: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct McpToolSpec {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
    #[serde(rename = "outputSchema")]
    pub output_schema: Value,
    #[serde(default)]
    pub annotations: McpToolAnnotations,
    #[serde(rename = "x-operation")]
    pub operation_id: String,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpToolAnnotations {
    pub read_only_hint: Option<bool>,
    pub destructive_hint: Option<bool>,
    pub idempotent_hint: Option<bool>,
    pub open_world_hint: Option<bool>,
}

impl From<&McpToolAnnotations> for McpAnnotations {
    fn from(value: &McpToolAnnotations) -> Self {
        Self {
            title: None,
            read_only_hint: value.read_only_hint,
            destructive_hint: value.destructive_hint,
            idempotent_hint: value.idempotent_hint,
            open_world_hint: value.open_world_hint,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogSummary {
    pub operations: usize,
    pub mcp_tools: usize,
    pub openapi_paths: usize,
    pub sql_tables: usize,
}

#[derive(Debug, Deserialize)]
struct ForkCatalogDocument {
    operations: Vec<NativeOperation>,
    mcp_tools: Vec<McpToolSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifiedIdentity {
    pub tenant_id: String,
    pub principal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_ref: Option<String>,
    pub policy_epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InvocationContext {
    pub tenant_id: String,
    pub principal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_ref: Option<String>,
    pub policy_epoch: u64,
}

impl From<VerifiedIdentity> for InvocationContext {
    fn from(identity: VerifiedIdentity) -> Self {
        Self {
            tenant_id: identity.tenant_id,
            principal_id: identity.principal_id,
            grant_ref: identity.grant_ref,
            policy_epoch: identity.policy_epoch,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OperationInvocation {
    pub operation_id: String,
    pub arguments: Value,
    pub context: InvocationContext,
    pub execution: ExecutionInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl ApiError {
    pub fn unconfigured() -> Self {
        Self {
            code: "API_PORT_UNCONFIGURED".to_string(),
            message: "GitFoundry API service binding is not configured".to_string(),
            retryable: false,
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            code: "UNAUTHORIZED".to_string(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_INPUT".to_string(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn backend(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }
}

#[async_trait::async_trait]
pub trait GitFoundryApiPort: Send + Sync {
    fn default_tenant(&self) -> Option<&str> {
        None
    }

    async fn identify(
        &self,
        authorization: Option<&str>,
        requested_tenant: &str,
    ) -> Result<VerifiedIdentity, ApiError>;

    async fn invoke(&self, invocation: OperationInvocation) -> Result<Value, ApiError>;
}

#[derive(Debug, Default)]
pub struct UnavailableApiPort;

#[async_trait::async_trait]
impl GitFoundryApiPort for UnavailableApiPort {
    async fn identify(
        &self,
        _authorization: Option<&str>,
        _requested_tenant: &str,
    ) -> Result<VerifiedIdentity, ApiError> {
        Err(ApiError::unconfigured())
    }

    async fn invoke(&self, _invocation: OperationInvocation) -> Result<Value, ApiError> {
        Err(ApiError::unconfigured())
    }
}

#[derive(Clone)]
struct OperationBinding {
    operation: NativeOperation,
    tool: McpToolSpec,
    segments: Vec<String>,
}

#[derive(Clone)]
struct OperationCommand {
    operation: NativeOperation,
    backend: Arc<dyn GitFoundryApiPort>,
}

#[async_trait::async_trait]
impl CommandHandler for OperationCommand {
    async fn run(&self, context: CommandContext) -> CommandResult {
        match invoke_operation(&self.operation, Arc::clone(&self.backend), context).await {
            Ok(data) => CommandResult::Ok {
                data,
                cta: None,
                exit_code: None,
            },
            Err(error) => CommandResult::Error {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                exit_code: Some(1),
                cta: None,
            },
        }
    }
}

async fn invoke_operation(
    operation: &NativeOperation,
    backend: Arc<dyn GitFoundryApiPort>,
    context: CommandContext,
) -> Result<Value, ApiError> {
    let mut arguments = operation_arguments(&context.options);
    let requested_tenant = arguments
        .get("tenant_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| backend.default_tenant().map(ToString::to_string))
        .ok_or_else(|| ApiError::invalid_input("tenant_id is required"))?;
    arguments
        .entry("tenant_id".to_string())
        .or_insert_with(|| Value::String(requested_tenant.clone()));
    let authorization = context
        .request
        .as_ref()
        .and_then(|request| request.headers.get("authorization"))
        .map(String::as_str);
    let identity = backend.identify(authorization, &requested_tenant).await?;
    let execution = ExecutionInput {
        idempotency_key: arguments
            .get("idempotency_key")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        execution_id: context
            .request
            .as_ref()
            .and_then(|request| request.headers.get("x-gitfoundry-execution-id"))
            .cloned(),
        expected_version: arguments.get("expected_version").and_then(Value::as_u64),
    };
    backend
        .invoke(OperationInvocation {
            operation_id: operation.id.clone(),
            arguments: Value::Object(arguments),
            context: identity.into(),
            execution,
        })
        .await
}

fn operation_arguments(options: &Value) -> serde_json::Map<String, Value> {
    options
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| {
                    let decoded = if matches!(key.as_str(), "input" | "initial_code" | "initial_state" | "changes") {
                        value.as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()).unwrap_or_else(|| value.clone())
                    } else {
                        value.clone()
                    };
                    (key.clone(), decoded)
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn private_agent_api_invocation(
    operation: &NativeOperation,
    invocation: OperationInvocation,
) -> Result<OperationInvocation, ApiError> {
    let arguments = invocation
        .arguments
        .as_object()
        .ok_or_else(|| ApiError::invalid_input("operation arguments must be an object"))?;
    validate_source_tenant(arguments, &invocation.context)?;
    let (route, route_keys) = route_arguments(operation, arguments, &invocation.context)?;
    let mut input = request_arguments(arguments);
    for key in ["tenant_id", "idempotency_key", "expected_version"] {
        input.remove(key);
    }
    for key in &route_keys {
        input.remove(key.as_str());
    }
    let (query, body) = match operation.request_location.as_str() {
        "query" => (Value::Object(input), Value::Null),
        "body" => (Value::Object(serde_json::Map::new()), Value::Object(input)),
        "none" | "route" => (Value::Object(serde_json::Map::new()), Value::Null),
        other => {
            return Err(ApiError::backend(
                "UNSUPPORTED_REQUEST_LOCATION",
                format!("{} uses {other}", operation.id),
                false,
            ));
        }
    };
    let execution = normalize_execution(arguments, invocation.execution)?;
    Ok(OperationInvocation {
        operation_id: invocation.operation_id,
        arguments: serde_json::json!({
            "route": Value::Object(route),
            "query": query,
            "headers": {},
            "cookies": {},
            "body": body,
        }),
        context: invocation.context,
        execution,
    })
}

fn route_arguments(
    operation: &NativeOperation,
    arguments: &serde_json::Map<String, Value>,
    context: &InvocationContext,
) -> Result<(serde_json::Map<String, Value>, Vec<String>), ApiError> {
    let mut route = serde_json::Map::new();
    let mut keys = Vec::new();
    let mut rest = operation.path.as_str();
    while let Some(start) = rest.find('{') {
        let after_prefix = &rest[start..];
        let end = after_prefix.find('}').ok_or_else(|| {
            ApiError::backend(
                "CATALOG_INVALID",
                format!("bad path template for {}", operation.id),
                false,
            )
        })?;
        let key = &after_prefix[1..end];
        let value = if key == "tenant_id" {
            context.tenant_id.clone()
        } else {
            arguments
                .get(key)
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .ok_or_else(|| ApiError::invalid_input(format!("{key} is required")))?
        };
        route.insert(key.to_string(), Value::String(value));
        keys.push(key.to_string());
        rest = &after_prefix[end + 1..];
    }
    Ok((route, keys))
}

fn validate_source_tenant(
    arguments: &serde_json::Map<String, Value>,
    context: &InvocationContext,
) -> Result<(), ApiError> {
    for (field, value) in [
        ("tenant_id", arguments.get("tenant_id")),
        (
            "input.tenant_id",
            arguments
                .get("input")
                .and_then(Value::as_object)
                .and_then(|input| input.get("tenant_id")),
        ),
    ] {
        let Some(value) = value else { continue };
        let Some(tenant_id) = value.as_str() else {
            return Err(ApiError::invalid_input(format!("{field} must be a string")));
        };
        if tenant_id != context.tenant_id {
            return Err(ApiError::unauthorized(format!(
                "{field} does not match verified tenant"
            )));
        }
    }
    Ok(())
}

fn request_arguments(arguments: &serde_json::Map<String, Value>) -> serde_json::Map<String, Value> {
    let mut values = arguments
        .get("input")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, value) in arguments {
        if key != "input" && !value.is_null() {
            values.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    values
}

fn normalize_execution(
    arguments: &serde_json::Map<String, Value>,
    execution: ExecutionInput,
) -> Result<ExecutionInput, ApiError> {
    let expected_version = match (
        execution.expected_version,
        arguments.get("expected_version"),
    ) {
        (Some(value), _) => Some(value),
        (None, Some(value)) => Some(value.as_u64().ok_or_else(|| {
            ApiError::invalid_input("expected_version must be a non-negative integer")
        })?),
        (None, None) => None,
    };
    Ok(ExecutionInput {
        idempotency_key: execution.idempotency_key.or_else(|| {
            arguments
                .get("idempotency_key")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }),
        execution_id: execution.execution_id,
        expected_version,
    })
}

pub fn summary() -> CatalogSummary {
    CatalogSummary {
        operations: OPERATION_COUNT,
        mcp_tools: MCP_TOOL_COUNT,
        openapi_paths: OPENAPI_PATH_COUNT,
        sql_tables: SQL_TABLE_COUNT,
    }
}

pub fn operations() -> Result<Vec<NativeOperation>, serde_json::Error> {
    Ok(serde_json::from_str::<ForkCatalogDocument>(FORK_CATALOG_JSON)?.operations)
}

pub fn mcp_tools() -> Result<Vec<McpToolSpec>, serde_json::Error> {
    Ok(serde_json::from_str::<ForkCatalogDocument>(FORK_CATALOG_JSON)?.mcp_tools)
}

pub fn mcp_tool_count_from_source() -> Result<usize, serde_json::Error> {
    Ok(mcp_tools()?.len())
}

pub fn build_cli_with_unavailable_backend() -> Cli {
    build_cli(Arc::new(UnavailableApiPort))
}

pub fn build_cli(backend: Arc<dyn GitFoundryApiPort>) -> Cli {
    let bindings = operation_bindings()
        .expect("source operation and MCP catalogs are valid")
        .into_iter()
        .map(|(operation, tool)| OperationBinding {
            segments: cli_segments(&operation),
            operation,
            tool,
        })
        .collect();
    add_bindings(
        Cli::create("gfy")
            .version(env!("CARGO_PKG_VERSION"))
            .description("GitFoundry native CLI and MCP operation catalog"),
        bindings,
        backend,
    )
}

pub fn build_tool_catalog(
    backend: Arc<dyn GitFoundryApiPort>,
) -> Result<incurs::tool::ToolCatalog, incurs::tool::ToolCatalogError> {
    build_cli(backend).try_tool_catalog()
}

pub fn operation_bindings() -> Result<Vec<(NativeOperation, McpToolSpec)>, serde_json::Error> {
    let operations = operations()?;
    let tools = mcp_tools()?;
    let by_operation = tools
        .into_iter()
        .map(|tool| (tool.operation_id.clone(), tool))
        .collect::<HashMap<_, _>>();
    Ok(operations
        .into_iter()
        .map(|operation| {
            let tool = by_operation
                .get(&operation.id)
                .unwrap_or_else(|| panic!("missing MCP tool for {}", operation.id))
                .clone();
            assert_eq!(
                operation.mcp_tool, tool.name,
                "MCP tool mapping for {}",
                operation.id
            );
            (operation, tool)
        })
        .collect())
}

fn add_bindings(
    mut cli: Cli,
    bindings: Vec<OperationBinding>,
    backend: Arc<dyn GitFoundryApiPort>,
) -> Cli {
    let mut grouped: BTreeMap<String, Vec<OperationBinding>> = BTreeMap::new();
    for binding in bindings {
        let head = binding
            .segments
            .first()
            .unwrap_or_else(|| panic!("{} has no CLI command", binding.operation.id))
            .clone();
        grouped.entry(head).or_default().push(binding);
    }
    for (name, group) in grouped {
        if group.len() == 1 && group[0].segments.len() == 1 {
            let binding = group.into_iter().next().unwrap();
            cli = cli.command(
                name.clone(),
                command_for(&name, binding, Arc::clone(&backend)),
            );
        } else {
            let nested = group
                .into_iter()
                .map(|mut binding| {
                    binding.segments.remove(0);
                    assert!(
                        !binding.segments.is_empty(),
                        "{} CLI command cannot end at a group",
                        binding.operation.id
                    );
                    binding
                })
                .collect::<Vec<_>>();
            cli = cli.group(add_bindings(
                Cli::create(name.clone()).description(format!("{name} operations")),
                nested,
                Arc::clone(&backend),
            ));
        }
    }
    cli
}

fn cli_segments(operation: &NativeOperation) -> Vec<String> {
    let mut parts = operation.cli.split_whitespace();
    assert_eq!(
        parts.next(),
        Some("gfy"),
        "{} CLI must start with gfy",
        operation.id
    );
    parts.map(ToString::to_string).collect()
}

fn command_for(
    name: &str,
    binding: OperationBinding,
    backend: Arc<dyn GitFoundryApiPort>,
) -> CommandDef {
    let mut command = CommandDef::build(
        name,
        OperationCommand {
            operation: binding.operation.clone(),
            backend,
        },
    )
    .description(binding.tool.description.clone())
    .mcp(McpCommandOptions {
        name: Some(binding.tool.name.clone()),
        description: Some(binding.tool.description.clone()),
        annotations: Some(McpAnnotations::from(&binding.tool.annotations)),
        input_schema: Some(binding.tool.input_schema.clone()),
        ..McpCommandOptions::default()
    })
    .done();
    command.options_fields = envelope_fields(&binding.tool.input_schema);
    command.output_schema = Some(binding.tool.output_schema);
    command
}

fn envelope_fields(schema: &Value) -> Vec<FieldMeta> {
    [
        "tenant_id",
        "input",
        "idempotency_key",
        "expected_version",
        "expected_head",
        "operation_id",
        "repository_id",
        "parent_version",
        "version_commit",
        "version",
        "tree",
        "path",
        "code_commit",
        "content_base64",
        "prefix",
        "initial_code",
        "initial_state",
        "changes",
        "base_version",
        "head_version",
        "left_version",
        "right_version",
        "new_version",
        "publication_operation_id",
        "limit",
        "cursor",
        "id",
        "job_id",
        "sha",
    ]
    .into_iter()
    .filter(|name| schema.get("properties").and_then(Value::as_object).is_some_and(|properties| properties.contains_key(*name)))
    .map(value_field)
    .collect()
}

fn value_field(name: &'static str) -> FieldMeta {
    FieldMeta {
        name,
        cli_name: if name == "version" { "revision".to_string() } else { name.replace('_', "-") },
        description: Some("Source MCP argument envelope field"),
        field_type: FieldType::Value,
        required: false,
        default: None,
        alias: None,
        deprecated: false,
        env_name: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use incurs::command::RequestContext;
    use incurs::tool::{ToolCallOptions, ToolCallOutcome};
    use serde_json::json;
    #[test]
    fn exact_revision_cli_flags_do_not_shadow_global_version() {
        let schema = json!({"properties": {"tenant_id": {}, "repository_id": {}, "version": {}, "tree": {}, "path": {}, "prefix": {}}});
        let fields = envelope_fields(&schema);
        let revision = fields.iter().find(|field| field.name == "version").unwrap();
        assert_eq!(revision.cli_name, "revision");
        assert!(fields.iter().any(|field| field.cli_name == "prefix"));
        assert_eq!(fields.len(), 6);
        assert!(!fields.iter().any(|field| field.name == "job_id"));
    }

    #[test]
    fn bootstrap_cli_exposes_code_and_state_documents() {
        let schema = json!({"properties": {"tenant_id": {}, "repository_id": {}, "operation_id": {}, "initial_code": {}, "initial_state": {}}});
        let fields = envelope_fields(&schema);
        assert_eq!(fields.len(), 5);
        assert!(fields.iter().any(|field| field.cli_name == "initial-code"));
        assert!(fields.iter().any(|field| field.cli_name == "initial-state"));
    }

    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn generated_counts_match_source_contracts() {
        assert_eq!(summary().operations, 198);
        assert_eq!(summary().mcp_tools, 198);
        assert_eq!(summary().openapi_paths, 129);
        assert_eq!(summary().sql_tables, 52);
        let operations = operations().unwrap();
        let bootstrap_count = operations
            .iter()
            .filter(|operation| {
                matches!(
                    operation.id.as_str(),
                    "auth.whoami" | "repo.create" | "repo.list" | "repo.view"
                )
            })
            .count();
        let forge_count = operations
            .iter()
            .filter(|operation| operation.id.starts_with("forge."))
            .count();
        assert_eq!(bootstrap_count, 4);
        assert_eq!(forge_count, 11);
        assert_eq!(operations.len(), bootstrap_count + forge_count);
        assert_eq!(mcp_tool_count_from_source().unwrap(), operations.len());
    }

    #[test]
    fn structured_cli_flags_decode_without_changing_typed_mcp_values_or_identifiers() {
        let expected = serde_json::json!([{"tree":"state","path":"issues/cli.json","content_base64":"e30="}]);
        let decoded = operation_arguments(&serde_json::json!({"changes":"[{\"tree\":\"state\",\"path\":\"issues/cli.json\",\"content_base64\":\"e30=\"}]","operation_id":"[literal-id]"}));
        assert_eq!(decoded["changes"], expected);
        assert_eq!(decoded["operation_id"], "[literal-id]");
        assert_eq!(operation_arguments(&serde_json::json!({"changes":expected}))["changes"], expected);
        assert_eq!(operation_arguments(&serde_json::json!({"changes":"not-json"}))["changes"], "not-json");
    }

    #[test]
    fn native_catalog_preserves_cli_and_mcp_mapping() {
        let operations = operations().unwrap();
        let forge_head = operations
            .iter()
            .find(|operation| operation.id == "forge.head")
            .unwrap();
        assert_eq!(forge_head.cli, "gfy forge head");
        assert_eq!(forge_head.mcp_tool, "gfy_forge_head");
        let repo_create = operations
            .iter()
            .find(|operation| operation.id == "repo.create")
            .unwrap();
        assert_eq!(repo_create.path, "/api/v1/tenants/{tenant_id}/repositories");
        assert_eq!(repo_create.request_location, "body");
    }

    #[test]
    fn tool_catalog_exposes_exact_source_mcp_tools() {
        let source = mcp_tools().unwrap();
        let catalog = build_tool_catalog(Arc::new(UnavailableApiPort)).unwrap();
        let definitions = catalog.definitions();
        assert_eq!(definitions.len(), 15);
        let mut source_names = source
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();
        source_names.sort_unstable();
        let mut definition_names = definitions
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();
        definition_names.sort_unstable();
        assert_eq!(definition_names, source_names);
        let source_forge_head = source
            .iter()
            .find(|tool| tool.name == "gfy_forge_head")
            .unwrap();
        let forge_head = definitions
            .iter()
            .find(|tool| tool.name == "gfy_forge_head")
            .unwrap();
        assert_eq!(forge_head.input_schema, source_forge_head.input_schema);
        assert_eq!(
            forge_head.output_schema.as_ref(),
            Some(&source_forge_head.output_schema)
        );
        assert_eq!(
            forge_head
                .annotations
                .as_ref()
                .and_then(|value| value.read_only_hint),
            Some(true)
        );
    }

    #[tokio::test]
    async fn operation_dispatch_fails_closed_without_api_port() {
        let catalog = build_tool_catalog(Arc::new(UnavailableApiPort)).unwrap();
        let outcome = catalog
            .call(
                "gfy_forge_head",
                BTreeMap::from([
                    ("tenant_id".to_string(), json!("tenant-a")),
                    ("repository_id".to_string(), json!("repo-a")),
                ]),
                ToolCallOptions::isolated(),
            )
            .await;
        match outcome {
            ToolCallOutcome::Error { code, message, .. } => {
                assert_eq!(code, "API_PORT_UNCONFIGURED");
                assert!(message.contains("service binding"));
            }
            ToolCallOutcome::Ok { .. } => panic!("unconfigured backend must fail closed"),
        }
    }

    #[tokio::test]
    async fn each_tool_call_revalidates_current_grant() {
        let backend = Arc::new(RecordingApiPort::default());
        let catalog = build_tool_catalog(backend.clone()).unwrap();
        for _ in 0..2 {
            let outcome = catalog
                .call(
                    "gfy_forge_head",
                    BTreeMap::from([
                        ("tenant_id".to_string(), json!("tenant-a")),
                        ("repository_id".to_string(), json!("repo-a")),
                    ]),
                    ToolCallOptions {
                        request: Some(RequestContext {
                            headers: HashMap::from([(
                                "authorization".to_string(),
                                "Bearer ephemeral".to_string(),
                            )]),
                            method: "POST".to_string(),
                            path: "/mcp/tools".to_string(),
                        }),
                        ..ToolCallOptions::isolated()
                    },
                )
                .await;
            assert!(matches!(outcome, ToolCallOutcome::Ok { .. }));
        }
        let invocations = backend.invocations.lock().unwrap();
        assert_eq!(invocations.len(), 2);
        assert_eq!(invocations[0].context.tenant_id, "tenant-a");
        assert_eq!(invocations[0].context.principal_id, "principal-ephemeral");
        assert_ne!(
            invocations[0].context.policy_epoch,
            invocations[1].context.policy_epoch
        );
    }

    #[test]
    fn private_agent_api_invocation_normalizes_forge_commit() {
        let operation = operations()
            .unwrap()
            .into_iter()
            .find(|operation| operation.id == "forge.commit")
            .unwrap();
        let invocation = source_invocation(
            "forge.commit",
            json!({
                "tenant_id": "tenant-a",
                "repository_id": "repo-1",
                "idempotency_key": "commit-1",
                "input": {
                    "parent_version": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "changes": [{
                        "tree": "state",
                        "path": "checkpoints/cp-1.json",
                        "content_base64": "e30="
                    }]
                }
            }),
        );

        let normalized = private_agent_api_invocation(&operation, invocation).unwrap();

        assert_eq!(normalized.operation_id, "forge.commit");
        assert_eq!(normalized.context.tenant_id, "tenant-a");
        assert_eq!(
            normalized.execution.idempotency_key.as_deref(),
            Some("commit-1")
        );
        assert_eq!(
            normalized.arguments["route"],
            json!({ "tenant_id": "tenant-a", "repository_id": "repo-1" })
        );
        assert_eq!(normalized.arguments["query"], json!({}));
        assert_eq!(normalized.arguments["headers"], json!({}));
        assert_eq!(normalized.arguments["cookies"], json!({}));
        assert_eq!(
            normalized.arguments["body"]["parent_version"],
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(normalized.arguments["body"]["changes"][0]["tree"], "state");
        assert!(normalized.arguments["body"].get("repository_id").is_none());
        assert!(normalized.arguments["body"].get("tenant_id").is_none());
        assert!(
            normalized.arguments["body"]
                .get("idempotency_key")
                .is_none()
        );
    }

    #[test]
    fn private_agent_api_invocation_normalizes_route_query_and_publish() {
        let operations = operations().unwrap();
        let forge_head = operations
            .iter()
            .find(|operation| operation.id == "forge.head")
            .unwrap();
        let normalized_head = private_agent_api_invocation(
            forge_head,
            source_invocation(
                "forge.head",
                json!({
                    "tenant_id": "tenant-a",
                    "repository_id": "repo-1"
                }),
            ),
        )
        .unwrap();
        assert_eq!(
            normalized_head.arguments["route"],
            json!({ "tenant_id": "tenant-a", "repository_id": "repo-1" })
        );
        assert_eq!(normalized_head.arguments["query"], json!({}));
        assert_eq!(normalized_head.arguments["body"], Value::Null);

        let forge_compare = operations
            .iter()
            .find(|operation| operation.id == "forge.compare")
            .unwrap();
        let normalized_compare = private_agent_api_invocation(
            forge_compare,
            source_invocation(
                "forge.compare",
                json!({
                    "tenant_id": "tenant-a",
                    "repository_id": "repo-1",
                    "base_version": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "head_version": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                }),
            ),
        )
        .unwrap();
        assert_eq!(
            normalized_compare.arguments["route"],
            json!({ "tenant_id": "tenant-a", "repository_id": "repo-1" })
        );
        assert_eq!(
            normalized_compare.arguments["query"],
            json!({
                "base_version": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "head_version": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            })
        );
        assert_eq!(normalized_compare.arguments["body"], Value::Null);

        let forge_publish = operations
            .iter()
            .find(|operation| operation.id == "forge.publish")
            .unwrap();
        let normalized_publish = private_agent_api_invocation(
            forge_publish,
            source_invocation(
                "forge.publish",
                json!({
                    "tenant_id": "tenant-a",
                    "repository_id": "repo-1",
                    "idempotency_key": "publish-1",
                    "expected_head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "new_version": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                }),
            ),
        )
        .unwrap();
        assert_eq!(normalized_publish.execution.expected_version, None);
        assert_eq!(
            normalized_publish.execution.idempotency_key.as_deref(),
            Some("publish-1")
        );
        assert_eq!(
            normalized_publish.arguments["body"]["expected_head"],
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            normalized_publish.arguments["body"]["new_version"],
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert!(
            normalized_publish.arguments["body"]
                .get("repository_id")
                .is_none()
        );
        assert!(
            normalized_publish.arguments["body"]
                .get("idempotency_key")
                .is_none()
        );
    }

    #[test]
    fn private_agent_api_invocation_denies_source_path_tenant_substitution() {
        let operation = operations()
            .unwrap()
            .into_iter()
            .find(|operation| operation.id == "forge.commit")
            .unwrap();
        let error = private_agent_api_invocation(
            &operation,
            source_invocation(
                "forge.commit",
                json!({
                    "tenant_id": "tenant-b",
                    "repository_id": "repo-tenant-a",
                    "input": {
                        "parent_version": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "changes": []
                    }
                }),
            ),
        )
        .unwrap_err();

        assert_eq!(error.code, "UNAUTHORIZED");
        assert!(error.message.contains("tenant_id"));
    }

    #[test]
    fn private_agent_api_invocation_denies_source_input_tenant_substitution() {
        let operation = operations()
            .unwrap()
            .into_iter()
            .find(|operation| operation.id == "forge.commit")
            .unwrap();
        let error = private_agent_api_invocation(
            &operation,
            source_invocation(
                "forge.commit",
                json!({
                    "tenant_id": "tenant-a",
                    "repository_id": "repo-tenant-a",
                    "input": {
                        "tenant_id": "tenant-b",
                        "parent_version": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "changes": []
                    }
                }),
            ),
        )
        .unwrap_err();

        assert_eq!(error.code, "UNAUTHORIZED");
        assert!(error.message.contains("input.tenant_id"));
    }

    fn source_invocation(operation_id: &str, arguments: Value) -> OperationInvocation {
        OperationInvocation {
            operation_id: operation_id.to_string(),
            arguments,
            context: InvocationContext {
                tenant_id: "tenant-a".to_string(),
                principal_id: "principal-a".to_string(),
                grant_ref: Some("grant-a".to_string()),
                policy_epoch: 42,
            },
            execution: ExecutionInput::default(),
        }
    }

    #[derive(Default)]
    struct RecordingApiPort {
        epoch: AtomicU64,
        invocations: Mutex<Vec<OperationInvocation>>,
    }

    #[async_trait::async_trait]
    impl GitFoundryApiPort for RecordingApiPort {
        async fn identify(
            &self,
            authorization: Option<&str>,
            requested_tenant: &str,
        ) -> Result<VerifiedIdentity, ApiError> {
            assert_eq!(authorization, Some("Bearer ephemeral"));
            let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(VerifiedIdentity {
                tenant_id: requested_tenant.to_string(),
                principal_id: "principal-ephemeral".to_string(),
                grant_ref: Some(format!("grant-{epoch}")),
                policy_epoch: epoch,
            })
        }

        async fn invoke(&self, invocation: OperationInvocation) -> Result<Value, ApiError> {
            self.invocations.lock().unwrap().push(invocation.clone());
            Ok(json!({
                "operation_id": invocation.operation_id,
                "principal_id": invocation.context.principal_id,
                "policy_epoch": invocation.context.policy_epoch,
                "grant_ref": invocation.context.grant_ref
            }))
        }
    }
}
