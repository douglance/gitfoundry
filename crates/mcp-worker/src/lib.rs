use std::sync::Arc;

use gitfoundry_catalog::VerifiedIdentity;
#[cfg(target_arch = "wasm32")]
use gitfoundry_catalog::{ApiError, GitFoundryApiPort, OperationInvocation};
use incurs_remote::{
    CapabilityDefinition, CapabilityManifest, REMOTE_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    REMOTE_PROTOCOL_VERSION,
};
use serde_json::json;

pub fn manifest() -> CapabilityManifest {
    let summary = gitfoundry_catalog::summary();
    CapabilityManifest {
        schema_version: REMOTE_CAPABILITY_MANIFEST_SCHEMA_VERSION.to_string(),
        protocol_version: REMOTE_PROTOCOL_VERSION.to_string(),
        name: "gitfoundry-mcp-worker".to_string(),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        capabilities: vec![CapabilityDefinition {
            id: "gitfoundry.catalog.summary".to_string(),
            description:
                "Source-validated P0 catalog metadata exposed through the remote Incurs seam"
                    .to_string(),
            input_schema: json!({ "type": "object", "additionalProperties": false }),
            output_schema: Some(json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "operations": { "type": "integer", "const": summary.operations },
                    "mcp_tools": { "type": "integer", "const": summary.mcp_tools },
                    "openapi_paths": { "type": "integer", "const": summary.openapi_paths },
                    "sql_tables": { "type": "integer", "const": summary.sql_tables }
                },
                "required": ["operations", "mcp_tools", "openapi_paths", "sql_tables"]
            })),
            annotations: None,
            instructions: None,
            examples: Vec::new(),
            result_content: Vec::new(),
            metadata: Default::default(),
        }],
        metadata: Default::default(),
    }
}

pub fn direct_tool_catalog() -> Result<incurs::tool::ToolCatalog, incurs::tool::ToolCatalogError> {
    gitfoundry_catalog::build_tool_catalog(Arc::new(gitfoundry_catalog::UnavailableApiPort))
}

pub fn durable_partition_name(identity: &VerifiedIdentity) -> String {
    let tuple =
        serde_json::to_string(&[identity.tenant_id.as_str(), identity.principal_id.as_str()])
            .expect("tenant/principal partition tuple is serializable");
    format!("tenant-principal:{tuple}")
}

#[cfg(target_arch = "wasm32")]
mod worker_host {
    use super::*;
    use std::cell::OnceCell;
    use std::future::Future;
    use std::pin::Pin;
    use std::rc::Rc;
    use std::task::Poll;

    use futures_util::StreamExt;
    use incurs::tool::ToolCallOptions;
    use incurs_codemode::{
        CodeMode, CodeModeRunOptions, ExecutionState, IncurConnector, SearchOutput,
    };
    use incurs_codemode_cloudflare::{
        CloudflareClock, DurableSqlStore, DynamicWorkerExecutor, DynamicWorkerOptions,
        McpHttpOptions as CodeModeMcpOptions, McpHttpRequest as CodeModeMcpRequest, WorkerLoader,
        drive_with_terminal_failure, handle_mcp_request as handle_codemode_mcp_request,
        persist_terminal_failure,
    };
    use serde_json::Value;
    use wasm_bindgen::JsValue;
    use worker::{
        Context, DurableObject, Env, Fetcher, Headers, Method, Request, RequestInit, Response,
        Result, State, durable_object, event, wasm_bindgen,
    };

    const API_BINDING: &str = "API";
    const CODEMODE_DO: &str = "CODEMODE";

    #[event(fetch)]
    async fn fetch(mut request: Request, env: Env, _context: Context) -> Result<Response> {
        if request.path() == "/mcp/tools" {
            return handle_direct_tools(request, env).await;
        }
        if request.path() != "/mcp" {
            return Response::error("Not found", 404);
        }
        if request.method() == Method::Options {
            return route_to_partition("mcp-preflight".to_string(), request, env).await;
        }
        let Some(requested_tenant) = requested_tenant_header(&request)? else {
            return Response::error("x-gitfoundry-tenant-id header is required", 400);
        };
        let api = Arc::new(WorkerApiPort::from_env(&env)?);
        let authorization = request.headers().get("authorization")?;
        let (status, value) = api
            .identity_response(authorization.as_deref(), &requested_tenant)
            .await
            .map_err(api_error)?;
        if !(200..300).contains(&status) {
            return Ok(Response::from_json(&value)?.with_status(status));
        }
        let identity = serde_json::from_value(value).map_err(|error| {
            api_error(ApiError::backend("IDENTITY_RESPONSE_INVALID", error.to_string(), false))
        })?;
        route_to_partition(durable_partition_name(&identity), request, env).await
    }

    async fn route_to_partition(name: String, request: Request, env: Env) -> Result<Response> {
        env.durable_object(CODEMODE_DO)?
            .id_from_name(&name)?
            .get_stub()?
            .fetch_with_request(request)
            .await
    }

    async fn handle_direct_tools(mut request: Request, env: Env) -> Result<Response> {
        let api = Arc::new(WorkerApiPort::from_env(&env)?);
        let method = request.method().as_ref().to_string();
        let headers = request.headers().entries().collect();
        let allowed_origins = allowed_origins(&env, &request);
        let options = incurs_mcp_cloudflare::McpHttpOptions {
            allowed_origins,
            ..incurs_mcp_cloudflare::McpHttpOptions::default()
        };
        let body = if method.eq_ignore_ascii_case("POST") {
            Some(read_bounded_body(&mut request, options.max_body_bytes).await?)
        } else {
            None
        };
        let input = incurs_mcp_cloudflare::McpHttpRequest {
            method,
            path: request.path(),
            headers,
            body,
        };
        let catalog = gitfoundry_catalog::build_tool_catalog(api).map_err(|error| {
            worker::Error::RustError(format!("build direct tool catalog: {error}"))
        })?;
        let response = incurs_mcp_cloudflare::handle_mcp_request(&catalog, input, &options).await;
        mcp_response(response.status, response.headers, response.body)
    }

    #[durable_object]
    pub struct GitFoundryCodeMode {
        state: State,
        env: Env,
        runtime: OnceCell<Rc<CodeMode>>,
    }

    impl DurableObject for GitFoundryCodeMode {
        fn new(state: State, env: Env) -> Self {
            Self {
                state,
                env,
                runtime: OnceCell::new(),
            }
        }

        async fn fetch(&self, mut request: Request) -> Result<Response> {
            let runtime = self.runtime()?;
            let path = request.path();
            if path == "/mcp" {
                let method = request.method().as_ref().to_string();
                let headers = request.headers().entries().collect();
                let options = CodeModeMcpOptions {
                    allowed_origins: allowed_origins(&self.env, &request),
                    ..CodeModeMcpOptions::default()
                };
                let body = if method.eq_ignore_ascii_case("POST") {
                    Some(read_bounded_body(&mut request, options.max_body_bytes).await?)
                } else {
                    None
                };
                let input = CodeModeMcpRequest {
                    method,
                    path,
                    headers,
                    body,
                };
                let response = handle_codemode_mcp_request(
                    &WorkerCodeModeService {
                        runtime: Rc::clone(runtime),
                        state: &self.state,
                    },
                    input,
                    &options,
                )
                .await;
                return mcp_response(response.status, response.headers, response.body);
            }
            if path == "/__incurs_codemode_dispatch" {
                let input = request.json::<incurs_codemode::DispatchRequest>().await?;
                return Response::from_json(
                    &runtime
                        .dispatch(input)
                        .await
                        .map_err(worker::Error::RustError)?,
                );
            }
            Response::error("Not found", 404)
        }
    }

    impl GitFoundryCodeMode {
        fn runtime(&self) -> Result<&Rc<CodeMode>> {
            if let Some(runtime) = self.runtime.get() {
                return Ok(runtime);
            }
            let loader = self.env.get_binding::<WorkerLoader>("LOADER")?;
            let dispatcher = self
                .env
                .durable_object(CODEMODE_DO)?
                .id_from_string(&self.state.id().to_string())?
                .get_stub()?;
            let store = Arc::new(DurableSqlStore::new(self.state.storage().sql())?);
            let artifacts = store.clone();
            let api = Arc::new(WorkerApiPort::from_env(&self.env)?);
            let catalog = gitfoundry_catalog::build_tool_catalog(api).map_err(|error| {
                worker::Error::RustError(format!("build Code Mode catalog: {error}"))
            })?;
            self.runtime
                .set(Rc::new(CodeMode::with_clock_and_artifact_store(
                    store,
                    artifacts,
                    DynamicWorkerExecutor::new(loader, dispatcher, DynamicWorkerOptions::default()),
                    vec![Arc::new(
                        IncurConnector::new(catalog)
                            .with_name("gitfoundry")
                            .with_call_options(ToolCallOptions::isolated()),
                    )],
                    CloudflareClock,
                )))
                .map_err(|_| {
                    worker::Error::RustError("Code Mode runtime already initialized".into())
                })?;
            Ok(self.runtime.get().unwrap())
        }
    }

    struct WorkerCodeModeService<'a> {
        runtime: Rc<CodeMode>,
        state: &'a State,
    }

    #[async_trait::async_trait(?Send)]
    impl incurs_codemode_cloudflare::WorkerCodeModeService for WorkerCodeModeService<'_> {
        async fn search(&self, query: String) -> std::result::Result<SearchOutput, String> {
            self.runtime.search(&query).await
        }

        async fn execute(
            &self,
            code: String,
            options: CodeModeRunOptions,
        ) -> std::result::Result<ExecutionState, String> {
            let state = self.runtime.start(&code).await?;
            let execution_id = state.id.clone();
            let runtime = Rc::clone(&self.runtime);
            self.state.wait_until(async move {
                let _ =
                    drive_with_terminal_failure(&runtime, &execution_id, options, &CloudflareClock)
                        .await;
            });
            Ok(state)
        }

        async fn execution(
            &self,
            execution_id: String,
        ) -> std::result::Result<ExecutionState, String> {
            self.runtime.execution_snapshot(&execution_id).await
        }

        async fn artifact(
            &self,
            execution_id: String,
            artifact_id: String,
        ) -> std::result::Result<Value, String> {
            self.runtime.artifact(&execution_id, &artifact_id).await
        }

        async fn approve(
            &self,
            execution_id: String,
            seq: u64,
            options: CodeModeRunOptions,
        ) -> std::result::Result<ExecutionState, String> {
            if let Err(error) = self.runtime.approve_with(&execution_id, seq, options).await {
                let _ = persist_terminal_failure(
                    &self.runtime,
                    &execution_id,
                    &error,
                    &CloudflareClock,
                )
                .await;
                return Err(error);
            }
            self.runtime.execution_snapshot(&execution_id).await
        }

        async fn reject(
            &self,
            execution_id: String,
            seq: u64,
        ) -> std::result::Result<ExecutionState, String> {
            self.runtime.reject(&execution_id, seq).await?;
            self.runtime.execution_snapshot(&execution_id).await
        }

        async fn cancel(
            &self,
            execution_id: String,
        ) -> std::result::Result<ExecutionState, String> {
            self.runtime.cancel(&execution_id).await?;
            self.runtime.execution_snapshot(&execution_id).await
        }
    }

    struct WorkerApiPort {
        api: Fetcher,
    }

    struct WasmSend<F>(F);

    unsafe impl<F> Send for WasmSend<F> {}

    impl<F: Future> Future for WasmSend<F> {
        type Output = F::Output;

        fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<Self::Output> {
            unsafe { self.map_unchecked_mut(|wrapper| &mut wrapper.0) }.poll(cx)
        }
    }

    fn wasm_send<F: Future>(future: F) -> WasmSend<F> {
        WasmSend(future)
    }

    impl WorkerApiPort {
        fn from_env(env: &Env) -> Result<Self> {
            Ok(Self {
                api: env.service(API_BINDING)?,
            })
        }

        async fn identity_response(
            &self,
            authorization: Option<&str>,
            requested_tenant: &str,
        ) -> std::result::Result<(u16, Value), ApiError> {
            self.post_json_response("/identity", None, &json!({
                "userAuthorization": authorization,
                "requested_tenant_id": requested_tenant,
            })).await
        }

        async fn post_json<T: serde::Serialize>(
            &self,
            path: &str,
            authorization: Option<&str>,
            body: &T,
        ) -> std::result::Result<Value, ApiError> {
            let (status, value) = self.post_json_response(path, authorization, body).await?;
            if (200..300).contains(&status) {
                Ok(value)
            } else {
                Err(api_error_from_value(status, value))
            }
        }

        async fn post_json_response<T: serde::Serialize>(
            &self,
            path: &str,
            authorization: Option<&str>,
            body: &T,
        ) -> std::result::Result<(u16, Value), ApiError> {
            let mut headers = Headers::new();
            headers
                .set("content-type", "application/json")
                .map_err(|error| {
                    ApiError::backend("API_REQUEST_BUILD_FAILED", error.to_string(), false)
                })?;
            if let Some(authorization) = authorization {
                headers
                    .set("authorization", authorization)
                    .map_err(|error| {
                        ApiError::backend("API_REQUEST_BUILD_FAILED", error.to_string(), false)
                    })?;
            }
            let body = serde_json::to_string(body).map_err(|error| {
                ApiError::backend("API_REQUEST_BUILD_FAILED", error.to_string(), false)
            })?;
            let mut init = RequestInit::new();
            init.with_method(Method::Post)
                .with_headers(headers)
                .with_body(Some(JsValue::from_str(&body)));
            let mut response = self
                .api
                .fetch(format!("https://gitfoundry.internal{path}"), Some(init))
                .await
                .map_err(|error| {
                    ApiError::backend("API_BINDING_FAILED", error.to_string(), true)
                })?;
            let status = response.status_code();
            let value = response.json::<Value>().await.map_err(|error| {
                ApiError::backend("API_RESPONSE_INVALID", error.to_string(), false)
            })?;
            Ok((status, value))
        }
    }

    #[async_trait::async_trait]
    impl GitFoundryApiPort for WorkerApiPort {
        async fn identify(
            &self,
            authorization: Option<&str>,
            requested_tenant: &str,
        ) -> std::result::Result<VerifiedIdentity, ApiError> {
            let value = wasm_send(self.post_json(
                "/identity",
                None,
                &json!({
                    "userAuthorization": authorization,
                    "requested_tenant_id": requested_tenant,
                }),
            ))
            .await?;
            serde_json::from_value(value).map_err(|error| {
                ApiError::backend("IDENTITY_RESPONSE_INVALID", error.to_string(), false)
            })
        }

        async fn invoke(
            &self,
            invocation: OperationInvocation,
        ) -> std::result::Result<Value, ApiError> {
            let operation = gitfoundry_catalog::operations()
                .map_err(|error| ApiError::backend("CATALOG_INVALID", error.to_string(), false))?
                .into_iter()
                .find(|operation| operation.id == invocation.operation_id)
                .ok_or_else(|| {
                    ApiError::backend(
                        "UNSUPPORTED_OPERATION",
                        format!("unsupported operation {}", invocation.operation_id),
                        false,
                    )
                })?;
            let private_invocation =
                gitfoundry_catalog::private_agent_api_invocation(&operation, invocation)?;
            wasm_send(self.post_json::<OperationInvocation>("/invoke", None, &private_invocation))
                .await
        }
    }

    fn requested_tenant_header(request: &Request) -> Result<Option<String>> {
        Ok(request
            .headers()
            .get("x-gitfoundry-tenant-id")?
            .filter(|value| !value.is_empty()))
    }

    fn allowed_origins(env: &Env, request: &Request) -> Vec<String> {
        let mut origins = request
            .url()
            .ok()
            .map(|url| vec![url.origin().ascii_serialization()])
            .unwrap_or_default();
        if let Ok(extra) = env.var("MCP_ALLOWED_ORIGINS") {
            origins.extend(
                extra
                    .to_string()
                    .split(',')
                    .map(str::trim)
                    .filter(|origin| !origin.is_empty())
                    .map(ToString::to_string),
            );
        }
        origins
    }

    async fn read_bounded_body(request: &mut Request, limit: usize) -> Result<String> {
        let mut stream = request.stream()?;
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len() + chunk.len() > limit {
                return Ok("\0".repeat(limit + 1));
            }
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8(bytes)
            .map_err(|_| worker::Error::RustError("MCP request body must be UTF-8".into()))
    }

    fn mcp_response(
        status: u16,
        headers: std::collections::BTreeMap<String, String>,
        body: Option<Value>,
    ) -> Result<Response> {
        let mut response = match body {
            Some(body) => Response::from_json(&body)?.with_status(status),
            None => Response::empty()?.with_status(status),
        };
        for (name, value) in headers {
            response.headers_mut().set(&name, &value)?;
        }
        Ok(response)
    }

    fn api_error(error: ApiError) -> worker::Error {
        worker::Error::RustError(format!("{}: {}", error.code, error.message))
    }

    fn api_error_from_value(status: u16, value: Value) -> ApiError {
        let code = value
            .pointer("/error/code")
            .or_else(|| value.get("code"))
            .or_else(|| value.get("error").filter(|error| error.is_string()))
            .and_then(Value::as_str)
            .unwrap_or("API_ERROR");
        let message = value
            .pointer("/error/message")
            .or_else(|| value.get("message"))
            .or_else(|| value.get("detail"))
            .and_then(Value::as_str)
            .unwrap_or("API request failed");
        ApiError::backend(code, format!("{message} (status {status})"), status >= 500)
    }
}

#[cfg(target_arch = "wasm32")]
pub fn cloudflare_adapter_status() -> &'static str {
    "real-incurs-worker-and-durable-object"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_uses_incurs_remote_contracts() {
        let manifest = manifest();
        assert_eq!(manifest.protocol_version, REMOTE_PROTOCOL_VERSION);
        assert_eq!(manifest.capabilities.len(), 1);
    }

    #[test]
    fn direct_tool_catalog_uses_shared_source_catalog() {
        let source = gitfoundry_catalog::mcp_tools().unwrap();
        let catalog = direct_tool_catalog().unwrap();
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
    }

    #[test]
    fn durable_partition_uses_verified_tenant_and_principal() {
        let one = VerifiedIdentity {
            tenant_id: "tenant-a".to_string(),
            principal_id: "principal-1".to_string(),
            grant_ref: Some("grant-secret".to_string()),
            policy_epoch: 1,
        };
        let two = VerifiedIdentity {
            tenant_id: "tenant-a".to_string(),
            principal_id: "principal-2".to_string(),
            grant_ref: Some("grant-secret".to_string()),
            policy_epoch: 1,
        };
        assert_ne!(durable_partition_name(&one), durable_partition_name(&two));
        assert!(durable_partition_name(&one).starts_with("tenant-principal:"));
        assert!(durable_partition_name(&one).contains("tenant-a"));
        assert!(durable_partition_name(&one).contains("principal-1"));
        assert!(!durable_partition_name(&one).contains("grant-secret"));
    }

    #[test]
    fn durable_partition_distinguishes_separator_like_verified_ids() {
        let slash = VerifiedIdentity {
            tenant_id: "a/b".to_string(),
            principal_id: "principal".to_string(),
            grant_ref: Some("grant-secret".to_string()),
            policy_epoch: 1,
        };
        let underscore = VerifiedIdentity {
            tenant_id: "a_b".to_string(),
            principal_id: "principal".to_string(),
            grant_ref: Some("grant-secret".to_string()),
            policy_epoch: 1,
        };
        let tenant_principal_swap = VerifiedIdentity {
            tenant_id: "a".to_string(),
            principal_id: "b/principal".to_string(),
            grant_ref: Some("grant-secret".to_string()),
            policy_epoch: 1,
        };
        assert_ne!(
            durable_partition_name(&slash),
            durable_partition_name(&underscore)
        );
        assert_ne!(
            durable_partition_name(&slash),
            durable_partition_name(&tenant_principal_swap)
        );
        assert!(!durable_partition_name(&slash).contains("grant-secret"));
    }
}
