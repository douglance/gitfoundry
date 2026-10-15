use incurs::cli::Cli;

pub fn build_cli() -> Cli {
    gitfoundry_catalog::build_cli_with_unavailable_backend()
}

#[cfg(not(target_arch = "wasm32"))]
mod native_rest {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use gitfoundry_catalog::{
        ApiError, ExecutionInput, GitFoundryApiPort, InvocationContext, NativeOperation,
        OperationInvocation, VerifiedIdentity,
    };
    use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue, IF_MATCH};
    use reqwest::redirect::Policy;
    use reqwest::{Client, Method, Url};
    use serde_json::{Map, Value, json};

    const ENV_BASE_URL: &str = "GFY_API_BASE_URL";
    const ENV_TENANT_ID: &str = "GFY_TENANT_ID";
    const ENV_ACCESS_JWT: &str = "GFY_ACCESS_JWT";
    const ENV_ACCESS_JWT_FILE: &str = "GFY_ACCESS_JWT_FILE";
    const ENV_SESSION: &str = "GFY_SESSION";
    const ENV_SESSION_FILE: &str = "GFY_SESSION_FILE";
    const DEFAULT_BASE_URL: &str = "https://gitfoundry.dev";
    /// Where `gfy login` keeps the sign-in token, relative to the home directory.
    pub const DEFAULT_SESSION_FILE: &str = ".config/gitfoundry/session";
    /// Where `gfy login` records the workspace that sign-in belongs to.
    pub const DEFAULT_WORKSPACE_FILE: &str = ".config/gitfoundry/workspace";
    const MAX_RESPONSE_BYTES: u64 = 1_048_576;

    #[derive(Clone, Debug)]
    pub struct RestConfig {
        pub base_url: String,
        pub tenant_id: Option<String>,
        pub credential: CredentialSource,
    }

    #[derive(Clone, Debug)]
    pub enum CredentialSource {
        Env(String),
        File(PathBuf),
        #[cfg(test)]
        Literal(String),
    }

    impl RestConfig {
        pub fn from_env() -> Result<Self, ApiError> {
            Self::resolve(optional_env, std::env::var_os("HOME").map(PathBuf::from))
        }

        /// Settings win in this order: an explicit sign-in token, an explicit token file, then
        /// the session `gfy login` saved. The API defaults to gitfoundry.dev.
        pub fn resolve(
            lookup: impl Fn(&str) -> Option<String>,
            home: Option<PathBuf>,
        ) -> Result<Self, ApiError> {
            let base_url = lookup(ENV_BASE_URL).unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
            let saved_workspace = home.as_ref().and_then(|home| {
                std::fs::read_to_string(home.join(DEFAULT_WORKSPACE_FILE))
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            });
            let tenant_id = lookup(ENV_TENANT_ID).or(saved_workspace);
            let tokens = [lookup(ENV_SESSION), lookup(ENV_ACCESS_JWT)];
            let files = [lookup(ENV_SESSION_FILE), lookup(ENV_ACCESS_JWT_FILE)];
            if tokens.iter().chain(files.iter()).flatten().count() > 1 {
                return Err(ApiError::invalid_input(
                    "set only one of GFY_SESSION, GFY_SESSION_FILE, GFY_ACCESS_JWT or GFY_ACCESS_JWT_FILE",
                ));
            }
            let saved = home
                .map(|home| home.join(DEFAULT_SESSION_FILE))
                .filter(|path| path.is_file());
            let credential = if let Some(token) = tokens.into_iter().flatten().next() {
                CredentialSource::Env(token)
            } else if let Some(path) = files.into_iter().flatten().next() {
                CredentialSource::File(PathBuf::from(path))
            } else if let Some(path) = saved {
                CredentialSource::File(path)
            } else {
                return Err(ApiError::unconfigured());
            };
            Ok(Self {
                base_url,
                tenant_id,
                credential,
            })
        }

        #[cfg(test)]
        fn test(base_url: String, tenant_id: Option<&str>, token: &str) -> Self {
            Self {
                base_url,
                tenant_id: tenant_id.map(ToString::to_string),
                credential: CredentialSource::Literal(token.to_string()),
            }
        }
    }

    #[derive(Clone)]
    pub struct NativeRestApiPort {
        client: Client,
        config: RestConfig,
    }

    impl NativeRestApiPort {
        pub fn new(config: RestConfig) -> Result<Self, ApiError> {
            validate_base_url(&config.base_url)?;
            let client = Client::builder()
                .redirect(Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|error| {
                    ApiError::backend("HTTP_CLIENT_INVALID", error.to_string(), false)
                })?;
            Ok(Self { client, config })
        }

        pub fn from_env() -> Result<Self, ApiError> {
            Self::new(RestConfig::from_env()?)
        }

        async fn authorization(&self) -> Result<String, ApiError> {
            let token = match &self.config.credential {
                CredentialSource::Env(token) => token.clone(),
                CredentialSource::File(path) => read_credential_file(path)?,
                #[cfg(test)]
                CredentialSource::Literal(token) => token.clone(),
            };
            let trimmed = token.trim();
            if trimmed.is_empty() {
                return Err(ApiError::unauthorized("GitFoundry sign-in is empty; run gfy login"));
            }
            if trimmed.starts_with("Bearer ") {
                Ok(trimmed.to_string())
            } else {
                Ok(format!("Bearer {trimmed}"))
            }
        }

        async fn send_json(
            &self,
            method: Method,
            path: &str,
            authorization: &str,
            body: Option<Value>,
            headers: HeaderMap,
            query: &[(String, String)],
        ) -> Result<Value, ApiError> {
            let url = operation_url(&self.config.base_url, path, query)?;
            let mut request = self
                .client
                .request(method, url)
                .headers(headers)
                .header(AUTHORIZATION, header_value(authorization, "authorization")?);
            if let Some(body) = body {
                request = request.json(&body);
            }
            let response = request.send().await.map_err(|error| {
                ApiError::backend("HTTP_REQUEST_FAILED", error.to_string(), true)
            })?;
            let status = response.status();
            if let Some(length) = response.content_length() {
                if length > MAX_RESPONSE_BYTES {
                    return Err(ApiError::backend(
                        "HTTP_RESPONSE_TOO_LARGE",
                        "response exceeds native gfy size limit",
                        false,
                    ));
                }
            }
            let bytes = response.bytes().await.map_err(|error| {
                ApiError::backend("HTTP_RESPONSE_READ_FAILED", error.to_string(), true)
            })?;
            if bytes.len() as u64 > MAX_RESPONSE_BYTES {
                return Err(ApiError::backend(
                    "HTTP_RESPONSE_TOO_LARGE",
                    "response exceeds native gfy size limit",
                    false,
                ));
            }
            let text = std::str::from_utf8(&bytes).map_err(|error| {
                ApiError::backend("HTTP_RESPONSE_INVALID", error.to_string(), false)
            })?;
            if !status.is_success() {
                return Err(parse_error(status.as_u16(), text));
            }
            if text.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(text).map_err(json_error)
            }
        }
    }

    #[async_trait::async_trait]
    impl GitFoundryApiPort for NativeRestApiPort {
        fn default_tenant(&self) -> Option<&str> {
            self.config.tenant_id.as_deref()
        }

        async fn identify(
            &self,
            _authorization: Option<&str>,
            requested_tenant: &str,
        ) -> Result<VerifiedIdentity, ApiError> {
            let authorization = self.authorization().await?;
            let path = format!(
                "/api/v1/tenants/{}/auth/whoami",
                encode_path_segment(requested_tenant)
            );
            let actor = self
                .send_json(
                    Method::GET,
                    &path,
                    &authorization,
                    None,
                    HeaderMap::new(),
                    &[],
                )
                .await?;
            parse_actor_identity(actor, requested_tenant)
        }

        async fn invoke(&self, invocation: OperationInvocation) -> Result<Value, ApiError> {
            let operation = gitfoundry_catalog::operations()
                .map_err(|error| ApiError::backend("CATALOG_INVALID", error.to_string(), false))?
                .into_iter()
                .find(|operation| operation.id == invocation.operation_id)
                .ok_or_else(|| {
                    ApiError::backend(
                        "UNSUPPORTED_OPERATION",
                        invocation.operation_id.clone(),
                        false,
                    )
                })?;
            let authorization = self.authorization().await?;
            let request = NativeRequest::from_invocation(&operation, &invocation)?;
            self.send_json(
                request.method,
                &request.path,
                &authorization,
                request.body,
                request.headers,
                &request.query,
            )
            .await
        }
    }

    struct NativeRequest {
        method: Method,
        path: String,
        query: Vec<(String, String)>,
        body: Option<Value>,
        headers: HeaderMap,
    }

    impl NativeRequest {
        fn from_invocation(
            operation: &NativeOperation,
            invocation: &OperationInvocation,
        ) -> Result<Self, ApiError> {
            let arguments = invocation
                .arguments
                .as_object()
                .ok_or_else(|| ApiError::invalid_input("operation arguments must be an object"))?;
            let (path, path_keys) = render_path(operation, arguments, &invocation.context)?;
            let mut headers = HeaderMap::new();
            if let Some(value) = idempotency_key(arguments, &invocation.execution) {
                headers.insert(
                    HeaderName::from_static("idempotency-key"),
                    header_value(&value, "idempotency_key")?,
                );
            }
            let tool = gitfoundry_catalog::mcp_tools()
                .map_err(|error| ApiError::backend("CATALOG_INVALID", error.to_string(), false))?
                .into_iter()
                .find(|tool| tool.operation_id == operation.id)
                .ok_or_else(|| {
                    ApiError::backend("CATALOG_INVALID", "missing command schema", false)
                })?;
            let accepts_body_version = operation.request_location == "body"
                && tool
                    .input_schema
                    .pointer("/properties/input/properties/expected_version")
                    .is_some();
            let outer_version = arguments
                .get("expected_version")
                .cloned()
                .or_else(|| invocation.execution.expected_version.map(Value::from));
            let body_version = if accepts_body_version {
                arguments
                    .get("input")
                    .and_then(|input| input.get("expected_version"))
            } else {
                None
            };
            if let (Some(outer), Some(body)) = (outer_version.as_ref(), body_version) {
                if outer != body {
                    return Err(ApiError::invalid_input(
                        "expected_version must agree with input.expected_version",
                    ));
                }
            }
            let expected_version = outer_version.as_ref().or(body_version);
            let mut input = input_arguments(arguments);
            for key in ["tenant_id", "idempotency_key", "expected_version"] {
                input.remove(key);
            }
            if let Some(value) = expected_version {
                if value.as_u64().is_none() {
                    return Err(ApiError::invalid_input(
                        "expected_version must be a nonnegative integer",
                    ));
                }
                headers.insert(
                    IF_MATCH,
                    header_value(&value_to_string(value), "expected_version")?,
                );
                if accepts_body_version {
                    input.insert("expected_version".to_string(), value.clone());
                }
            }
            for key in &path_keys {
                input.remove(key.as_str());
            }
            let method = Method::from_bytes(operation.method.as_bytes()).map_err(|error| {
                ApiError::invalid_input(format!("invalid operation method: {error}"))
            })?;
            let (query, body) = match operation.request_location.as_str() {
                "query" => (query_pairs(&input), None),
                "body" => (Vec::new(), Some(Value::Object(input))),
                "none" | "route" => (Vec::new(), None),
                other => {
                    return Err(ApiError::backend(
                        "UNSUPPORTED_REQUEST_LOCATION",
                        format!("{} uses {other}", operation.id),
                        false,
                    ));
                }
            };
            Ok(Self {
                method,
                path,
                query,
                body,
                headers,
            })
        }
    }

    fn validate_base_url(base_url: &str) -> Result<(), ApiError> {
        let url = base_url
            .parse::<Url>()
            .map_err(|error| ApiError::invalid_input(format!("invalid API base URL: {error}")))?;
        match url.scheme() {
            "https" => Ok(()),
            "http" if is_loopback_url(&url) => Ok(()),
            "http" => Err(ApiError::backend(
                "INSECURE_API_BASE_URL",
                "native gfy requires https outside explicit loopback tests",
                false,
            )),
            _ => Err(ApiError::invalid_input(
                "GFY_API_BASE_URL must start with http:// or https://",
            )),
        }
    }

    fn is_loopback_url(url: &Url) -> bool {
        matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("::1") | Some("[::1]")
        )
    }

    fn operation_url(
        base_url: &str,
        operation_path: &str,
        query: &[(String, String)],
    ) -> Result<Url, ApiError> {
        let base = base_url
            .parse::<Url>()
            .map_err(|error| ApiError::invalid_input(format!("invalid API base URL: {error}")))?;
        validate_base_url(base_url)?;
        let host = base
            .host_str()
            .ok_or_else(|| ApiError::invalid_input("API base URL must include a host"))?;
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        let port = base
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default();
        let mut path = String::new();
        let base_path = base.path().trim_end_matches('/');
        if !base_path.is_empty() {
            path.push_str(base_path);
        }
        path.push('/');
        path.push_str(operation_path.trim_start_matches('/'));
        let mut url = format!("{}://{}{}{}", base.scheme(), host, port, path)
            .parse::<Url>()
            .map_err(|error| ApiError::invalid_input(format!("invalid API URL: {error}")))?;
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }
        Ok(url)
    }

    fn render_path(
        operation: &NativeOperation,
        arguments: &Map<String, Value>,
        context: &InvocationContext,
    ) -> Result<(String, Vec<String>), ApiError> {
        let mut rendered = String::new();
        let mut keys = Vec::new();
        let mut rest = operation.path.as_str();
        while let Some(start) = rest.find('{') {
            let (prefix, after_prefix) = rest.split_at(start);
            rendered.push_str(prefix);
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
            rendered.push_str(&encode_path_segment(&value));
            keys.push(key.to_string());
            rest = &after_prefix[end + 1..];
        }
        rendered.push_str(rest);
        Ok((rendered, keys))
    }

    fn input_arguments(arguments: &Map<String, Value>) -> Map<String, Value> {
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

    fn query_pairs(input: &Map<String, Value>) -> Vec<(String, String)> {
        let mut pairs = Vec::new();
        let ordered = input.iter().collect::<BTreeMap<_, _>>();
        for (key, value) in ordered {
            append_query_value(&mut pairs, key, value);
        }
        pairs
    }

    fn append_query_value(pairs: &mut Vec<(String, String)>, key: &str, value: &Value) {
        match value {
            Value::Null => {}
            Value::Array(items) => {
                for item in items {
                    append_query_value(pairs, key, item);
                }
            }
            _ => pairs.push((key.to_string(), value_to_string(value))),
        }
    }

    fn value_to_string(value: &Value) -> String {
        match value {
            Value::String(value) => value.clone(),
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.to_string(),
            other => other.to_string(),
        }
    }

    fn idempotency_key(
        arguments: &Map<String, Value>,
        execution: &ExecutionInput,
    ) -> Option<String> {
        execution.idempotency_key.clone().or_else(|| {
            arguments
                .get("idempotency_key")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
    }

    fn encode_path_segment(value: &str) -> String {
        let mut output = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                output.push(byte as char);
            } else {
                output.push_str(&format!("%{byte:02X}"));
            }
        }
        output
    }

    fn header_value(value: &str, name: &str) -> Result<HeaderValue, ApiError> {
        HeaderValue::from_str(value).map_err(|_| {
            ApiError::invalid_input(format!("{name} is not a valid HTTP header value"))
        })
    }

    fn optional_env(name: &str) -> Option<String> {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    }

    fn read_credential_file(path: &PathBuf) -> Result<String, ApiError> {
        reject_unprotected_file(path)?;
        std::fs::read_to_string(path).map_err(|error| {
            ApiError::backend("CREDENTIAL_FILE_READ_FAILED", error.to_string(), false)
        })
    }

    #[cfg(unix)]
    fn reject_unprotected_file(path: &PathBuf) -> Result<(), ApiError> {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(path).map_err(|error| {
            ApiError::backend("CREDENTIAL_FILE_READ_FAILED", error.to_string(), false)
        })?;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(ApiError::backend(
                "CREDENTIAL_FILE_UNPROTECTED",
                "credential file must not be group- or world-readable",
                false,
            ));
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn reject_unprotected_file(_path: &PathBuf) -> Result<(), ApiError> {
        Ok(())
    }

    fn parse_actor_identity(
        value: Value,
        requested_tenant: &str,
    ) -> Result<VerifiedIdentity, ApiError> {
        let tenant_id = string_field(&value, "tenant_id")?;
        if tenant_id != requested_tenant {
            return Err(ApiError::unauthorized(format!(
                "auth.whoami returned tenant {tenant_id}, expected {requested_tenant}"
            )));
        }
        Ok(VerifiedIdentity {
            tenant_id,
            principal_id: string_field(&value, "principal_id")?,
            grant_ref: None,
            policy_epoch: value
                .get("policy_epoch")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    ApiError::backend("IDENTITY_RESPONSE_INVALID", "policy_epoch missing", false)
                })?,
        })
    }

    fn string_field(value: &Value, name: &str) -> Result<String, ApiError> {
        value
            .get(name)
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .ok_or_else(|| {
                ApiError::backend(
                    "IDENTITY_RESPONSE_INVALID",
                    format!("{name} missing"),
                    false,
                )
            })
    }

    fn parse_error(status: u16, text: &str) -> ApiError {
        if let Ok(body) = serde_json::from_str::<Value>(text) {
            if let Some(error) = body.get("error") {
                if let Some(code) = error.get("code").and_then(Value::as_str) {
                    return ApiError::backend(
                        code,
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("backend error"),
                        error
                            .get("retryable")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    );
                }
            }
            if let Some(code) = body.get("code").and_then(Value::as_str) {
                return ApiError::backend(
                    code,
                    body.get("message")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| format!("HTTP {status}")),
                    body.get("retryable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                );
            }
        }
        ApiError::backend(format!("HTTP_{status}"), text.to_string(), status >= 500)
    }

    fn json_error(error: serde_json::Error) -> ApiError {
        ApiError::backend("HTTP_RESPONSE_JSON_INVALID", error.to_string(), false)
    }

    pub fn build_cli_from_env() -> Result<incurs::cli::Cli, ApiError> {
        match NativeRestApiPort::from_env() {
            Ok(port) => Ok(gitfoundry_catalog::build_cli(Arc::new(port))),
            Err(error) if error.code == "API_PORT_UNCONFIGURED" => {
                Ok(gitfoundry_catalog::build_cli(Arc::new(SignedOutPort)))
            }
            Err(error) => Err(error),
        }
    }

    /// Answers every command when nobody is signed in.
    #[derive(Debug, Default)]
    pub struct SignedOutPort;

    #[async_trait::async_trait]
    impl GitFoundryApiPort for SignedOutPort {
        fn default_tenant(&self) -> Option<&str> {
            Some("signed-out")
        }

        async fn identify(&self, _authorization: Option<&str>, _requested_tenant: &str) -> Result<VerifiedIdentity, ApiError> {
            Err(ApiError::unauthorized("Not signed in. Run gfy login."))
        }

        async fn invoke(&self, _invocation: OperationInvocation) -> Result<Value, ApiError> {
            Err(ApiError::unauthorized("Not signed in. Run gfy login."))
        }
    }

    pub fn build_cli_with_rest_config(config: RestConfig) -> Result<incurs::cli::Cli, ApiError> {
        Ok(gitfoundry_catalog::build_cli(Arc::new(
            NativeRestApiPort::new(config)?,
        )))
    }

    #[cfg(test)]
    pub(crate) fn test_port(
        base_url: String,
        tenant_id: Option<&str>,
        token: &str,
    ) -> Result<NativeRestApiPort, ApiError> {
        NativeRestApiPort::new(RestConfig::test(base_url, tenant_id, token))
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native_rest::{
    CredentialSource, NativeRestApiPort, RestConfig, SignedOutPort, build_cli_from_env, build_cli_with_rest_config,
};

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::mpsc::{self, Receiver};
    use std::thread;
    use std::time::Duration;

    use gitfoundry_catalog::build_tool_catalog;
    use incurs::tool::{ToolCallOptions, ToolCallOutcome};
    use serde_json::{Value, json};

    use super::*;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: BTreeMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn config_uses_the_saved_login_session_and_gitfoundry_dev_by_default() {
        let home = std::env::temp_dir().join(format!("gfy-home-{}", std::process::id()));
        let saved = home.join(".config/gitfoundry/session");
        std::fs::create_dir_all(saved.parent().unwrap()).unwrap();
        std::fs::write(&saved, "gfys_saved").unwrap();
        std::fs::write(home.join(".config/gitfoundry/workspace"), "ws-saved\n").unwrap();
        let config = RestConfig::resolve(lookup(&[]), Some(home.clone())).unwrap();
        assert_eq!(config.base_url, "https://gitfoundry.dev");
        assert_eq!(config.tenant_id.as_deref(), Some("ws-saved"));
        assert!(matches!(config.credential, CredentialSource::File(ref path) if path == &saved));
        let explicit = RestConfig::resolve(lookup(&[("GFY_SESSION", "gfys_explicit"), ("GFY_API_BASE_URL", "http://127.0.0.1:4183")]), Some(home.clone())).unwrap();
        assert_eq!(explicit.base_url, "http://127.0.0.1:4183");
        assert!(matches!(explicit.credential, CredentialSource::Env(ref token) if token == "gfys_explicit"));
        assert!(RestConfig::resolve(lookup(&[("GFY_SESSION", "a"), ("GFY_ACCESS_JWT_FILE", "/x")]), Some(home.clone())).is_err());
        std::fs::remove_dir_all(&home).unwrap();
        assert!(RestConfig::resolve(lookup(&[]), Some(home)).is_err());
    }

    #[tokio::test]
    async fn signed_out_cli_tells_the_person_to_sign_in() {
        use gitfoundry_catalog::GitFoundryApiPort;
        let port = SignedOutPort;
        let error = port.identify(None, port.default_tenant().unwrap()).await.unwrap_err();
        assert_eq!(error.code, "UNAUTHORIZED");
        assert!(error.message.contains("gfy login"));
    }

    #[test]
    fn cli_exposes_source_tools_through_incurs_catalog() {
        let catalog = build_cli().try_tool_catalog().unwrap();
        let names: Vec<_> = catalog
            .definitions()
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert_eq!(names.len(), 15);
        assert!(names.iter().any(|name| name == "gfy_repo_create"));
        assert!(names.iter().any(|name| name == "gfy_repo_list"));
        assert!(names.iter().any(|name| name == "gfy_forge_head"));
        assert!(names.iter().any(|name| name == "gfy_forge_publish"));
    }

    #[tokio::test]
    async fn rest_port_routes_public_whoami_query_body_auth_and_idempotency() {
        let server = FixtureServer::start(vec![
            response(200, actor("tenant-a", 1)),
            response(200, json!({"version": null})),
            response(200, actor("caller-supplied", 2)),
            response(200, json!({"version": {"version_commit": "c".repeat(40)}})),
        ]);
        let port =
            native_rest::test_port(server.base_url(), Some("tenant-a"), "signed-one").unwrap();
        let catalog = build_tool_catalog(std::sync::Arc::new(port)).unwrap();

        let list = catalog
            .call(
                "gfy_forge_head",
                BTreeMap::from([("repository_id".to_string(), json!("repo-a"))]),
                ToolCallOptions::isolated(),
            )
            .await;
        assert!(matches!(list, ToolCallOutcome::Ok { .. }));

        let publish = catalog
            .call(
                "gfy_forge_publish",
                BTreeMap::from([
                    ("tenant_id".to_string(), json!("caller-supplied")),
                    ("repository_id".to_string(), json!("repo-a")),
                    ("idempotency_key".to_string(), json!("publish-left")),
                    ("expected_head".to_string(), json!("a".repeat(40))),
                    ("new_version".to_string(), json!("b".repeat(40))),
                ]),
                ToolCallOptions::isolated(),
            )
            .await;
        assert!(matches!(publish, ToolCallOutcome::Ok { .. }));

        let requests = server.requests(4);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].path, "/api/v1/tenants/tenant-a/auth/whoami");
        assert_eq!(requests[0].authorization(), Some("Bearer signed-one"));
        for request in &requests {
            assert_eq!(request.header("cf-access-token"), None);
        }
        assert_eq!(requests[1].method, "GET");
        assert_eq!(
            requests[1].path,
            "/api/v2/tenants/tenant-a/repositories/repo-a/forge/head"
        );
        assert_eq!(requests[1].authorization(), Some("Bearer signed-one"));
        assert_eq!(
            requests[2].path,
            "/api/v1/tenants/caller-supplied/auth/whoami"
        );
        assert_eq!(requests[3].method, "POST");
        assert_eq!(
            requests[3].path,
            "/api/v2/tenants/caller-supplied/repositories/repo-a/forge/publish"
        );
        assert_eq!(requests[3].authorization(), Some("Bearer signed-one"));
        assert_eq!(requests[3].header("idempotency-key"), Some("publish-left"));
        assert_eq!(requests[3].header("if-match"), None);
        assert_eq!(requests[3].body["expected_head"], "a".repeat(40));
        assert_eq!(requests[3].body["new_version"], "b".repeat(40));
    }

    #[tokio::test]
    async fn publish_preserves_expected_head_body_and_idempotency_header() {
        let server = FixtureServer::start(vec![
            response(200, actor("tenant-a", 1)),
            response(200, json!({"version": {"version_commit": "b".repeat(40)}})),
        ]);
        let port =
            native_rest::test_port(server.base_url(), Some("tenant-a"), "signed-one").unwrap();
        let catalog = build_tool_catalog(std::sync::Arc::new(port)).unwrap();
        let outcome = catalog
            .call(
                "gfy_forge_publish",
                BTreeMap::from([
                    ("repository_id".to_string(), json!("repo-a")),
                    ("idempotency_key".to_string(), json!("publish-1")),
                    ("expected_head".to_string(), json!("a".repeat(40))),
                    ("new_version".to_string(), json!("b".repeat(40))),
                ]),
                ToolCallOptions::isolated(),
            )
            .await;
        assert!(matches!(outcome, ToolCallOutcome::Ok { .. }));
        let requests = server.requests(2);
        assert_eq!(
            requests[1].path,
            "/api/v2/tenants/tenant-a/repositories/repo-a/forge/publish"
        );
        assert_eq!(requests[1].header("idempotency-key"), Some("publish-1"));
        assert_eq!(requests[1].header("if-match"), None);
        assert_eq!(
            requests[1].body,
            json!({"expected_head": "a".repeat(40), "new_version": "b".repeat(40)})
        );
    }

    #[tokio::test]
    async fn publish_requires_repository_id_before_operation() {
        let server = FixtureServer::start(vec![response(200, actor("tenant-a", 1))]);
        let port =
            native_rest::test_port(server.base_url(), Some("tenant-a"), "signed-one").unwrap();
        let catalog = build_tool_catalog(std::sync::Arc::new(port)).unwrap();
        let outcome = catalog
            .call(
                "gfy_forge_publish",
                BTreeMap::from([
                    ("idempotency_key".to_string(), json!("publish-2")),
                    ("expected_head".to_string(), json!("a".repeat(40))),
                    ("new_version".to_string(), json!("b".repeat(40))),
                ]),
                ToolCallOptions::isolated(),
            )
            .await;
        match outcome {
            ToolCallOutcome::Error { message, .. } => {
                assert!(message.contains("repository_id"), "{message}")
            }
            ToolCallOutcome::Ok { .. } => panic!("missing repository_id must be rejected"),
        }
        assert_eq!(
            server.requests(1)[0].path,
            "/api/v1/tenants/tenant-a/auth/whoami"
        );
    }

    #[tokio::test]
    async fn rest_port_refreshes_credential_file_for_each_call() {
        let server = FixtureServer::start(vec![
            response(200, actor("tenant-a", 1)),
            response(200, json!({"version": null})),
            response(200, actor("tenant-a", 2)),
            response(200, json!({"version": null})),
        ]);
        let path = std::env::temp_dir().join(format!(
            "gfy-token-{}-{}.txt",
            std::process::id(),
            unique_suffix()
        ));
        std::fs::write(&path, "token-one").unwrap();
        protect_file(&path);
        let config = RestConfig {
            base_url: server.base_url(),
            tenant_id: Some("tenant-a".to_string()),
            credential: CredentialSource::File(path.clone()),
        };
        let catalog = build_cli_with_rest_config(config)
            .unwrap()
            .try_tool_catalog()
            .unwrap();

        for token in ["token-one", "token-two"] {
            std::fs::write(&path, token).unwrap();
            protect_file(&path);
            let outcome = catalog
                .call(
                    "gfy_forge_head",
                    BTreeMap::from([("repository_id".to_string(), json!("repo-a"))]),
                    ToolCallOptions::isolated(),
                )
                .await;
            assert!(matches!(outcome, ToolCallOutcome::Ok { .. }));
        }
        let requests = server.requests(4);
        assert_eq!(requests[0].authorization(), Some("Bearer token-one"));
        assert_eq!(requests[1].authorization(), Some("Bearer token-one"));
        assert_eq!(requests[2].authorization(), Some("Bearer token-two"));
        assert_eq!(requests[3].authorization(), Some("Bearer token-two"));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn public_auth_rejects_wrong_tenant_before_operation() {
        let server = FixtureServer::start(vec![response(200, actor("tenant-b", 1))]);
        let port =
            native_rest::test_port(server.base_url(), Some("tenant-a"), "signed-one").unwrap();
        let catalog = build_tool_catalog(std::sync::Arc::new(port)).unwrap();
        let outcome = catalog
            .call(
                "gfy_forge_head",
                BTreeMap::from([("repository_id".to_string(), json!("repo-a"))]),
                ToolCallOptions::isolated(),
            )
            .await;
        match outcome {
            ToolCallOutcome::Error { code, message, .. } => {
                assert_eq!(code, "UNAUTHORIZED");
                assert!(message.contains("tenant-b"));
            }
            ToolCallOutcome::Ok { .. } => panic!("wrong tenant actor must fail closed"),
        }
        let requests = server.requests(1);
        assert_eq!(requests[0].path, "/api/v1/tenants/tenant-a/auth/whoami");
    }

    #[tokio::test]
    async fn public_rest_never_uses_private_identity_or_invoke_paths() {
        let server = FixtureServer::start(vec![
            response(
                404,
                json!({"code": "NOT_FOUND", "message": "private path denied"}),
            ),
            response(200, actor("tenant-a", 1)),
            response(200, json!({"version": null})),
        ]);
        let private = reqwest::Client::new()
            .post(format!("{}/identity", server.base_url()))
            .send()
            .await
            .unwrap();
        assert_eq!(private.status(), reqwest::StatusCode::NOT_FOUND);

        let port =
            native_rest::test_port(server.base_url(), Some("tenant-a"), "signed-one").unwrap();
        let catalog = build_tool_catalog(std::sync::Arc::new(port)).unwrap();
        let outcome = catalog
            .call(
                "gfy_forge_head",
                BTreeMap::from([("repository_id".to_string(), json!("repo-a"))]),
                ToolCallOptions::isolated(),
            )
            .await;
        assert!(matches!(outcome, ToolCallOutcome::Ok { .. }));
        let requests = server.requests(3);
        assert_eq!(requests[0].path, "/identity");
        assert_eq!(requests[1].path, "/api/v1/tenants/tenant-a/auth/whoami");
        assert_eq!(
            requests[2].path,
            "/api/v2/tenants/tenant-a/repositories/repo-a/forge/head"
        );
    }

    #[tokio::test]
    async fn rest_port_returns_typed_error_json_and_does_not_follow_redirects() {
        let server = FixtureServer::start(vec![
            response(200, actor("tenant-a", 1)),
            redirect("https://example.invalid/elsewhere"),
        ]);
        let port =
            native_rest::test_port(server.base_url(), Some("tenant-a"), "signed-one").unwrap();
        let catalog = build_tool_catalog(std::sync::Arc::new(port)).unwrap();
        let outcome = catalog
            .call(
                "gfy_forge_head",
                BTreeMap::from([("repository_id".to_string(), json!("repo-a"))]),
                ToolCallOptions::isolated(),
            )
            .await;
        match outcome {
            ToolCallOutcome::Error { code, .. } => assert_eq!(code, "HTTP_302"),
            ToolCallOutcome::Ok { .. } => panic!("redirects must not be followed"),
        }
        let requests = server.requests(2);
        assert_eq!(requests[1].authorization(), Some("Bearer signed-one"));
    }

    #[tokio::test]
    async fn https_self_signed_server_is_rejected_without_disabling_certificate_verification() {
        let Some(server) = OpensslServer::start() else {
            return;
        };
        let port =
            native_rest::test_port(server.base_url(), Some("tenant-a"), "signed-one").unwrap();
        let catalog = build_tool_catalog(std::sync::Arc::new(port)).unwrap();
        let outcome = catalog
            .call(
                "gfy_forge_head",
                BTreeMap::from([("repository_id".to_string(), json!("repo-a"))]),
                ToolCallOptions::isolated(),
            )
            .await;
        match outcome {
            ToolCallOutcome::Error { code, message, .. } => {
                assert_eq!(code, "HTTP_REQUEST_FAILED");
                assert!(!message.is_empty());
            }
            ToolCallOutcome::Ok { .. } => panic!("self-signed TLS must be rejected"),
        }
    }

    fn actor(tenant: &str, epoch: u64) -> Value {
        json!({
            "tenant_id": tenant,
            "principal_id": "principal-a",
            "kind": "human",
            "policy_epoch": epoch,
            "scopes": ["repo.read"]
        })
    }

    fn response(status: u16, body: Value) -> FixtureResponse {
        FixtureResponse {
            status,
            body,
            location: None,
        }
    }

    fn redirect(location: &str) -> FixtureResponse {
        FixtureResponse {
            status: 302,
            body: json!({}),
            location: Some(location.to_string()),
        }
    }

    struct FixtureResponse {
        status: u16,
        body: Value,
        location: Option<String>,
    }

    #[derive(Debug)]
    struct RecordedRequest {
        method: String,
        path: String,
        headers: BTreeMap<String, String>,
        body: Value,
    }

    impl RecordedRequest {
        fn authorization(&self) -> Option<&str> {
            self.header("authorization")
        }

        fn header(&self, name: &str) -> Option<&str> {
            self.headers.get(name).map(String::as_str)
        }
    }

    struct FixtureServer {
        base_url: String,
        rx: Receiver<RecordedRequest>,
    }

    impl FixtureServer {
        fn start(responses: Vec<FixtureResponse>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            let (tx, rx) = mpsc::channel();
            thread::spawn(move || {
                for response in responses {
                    let (mut stream, _) = listener.accept().unwrap();
                    let request = read_request(&mut stream);
                    tx.send(request).unwrap();
                    let body = response.body.to_string();
                    let location = response
                        .location
                        .map(|location| format!("Location: {location}\r\n"))
                        .unwrap_or_default();
                    let reply = format!(
                        "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                        response.status,
                        location,
                        body.len(),
                        body
                    );
                    stream.write_all(reply.as_bytes()).unwrap();
                }
            });
            Self { base_url, rx }
        }

        fn base_url(&self) -> String {
            self.base_url.clone()
        }

        fn requests(&self, count: usize) -> Vec<RecordedRequest> {
            (0..count)
                .map(|_| self.rx.recv_timeout(Duration::from_secs(2)).unwrap())
                .collect()
        }
    }

    fn read_request(stream: &mut std::net::TcpStream) -> RecordedRequest {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let read = stream.read(&mut buffer).unwrap();
            assert_ne!(read, 0, "client closed before request headers");
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(split) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let header_text = String::from_utf8_lossy(&bytes[..split]).to_string();
                let mut lines = header_text.lines();
                let first = lines.next().unwrap();
                let mut first_parts = first.split_whitespace();
                let method = first_parts.next().unwrap().to_string();
                let path = first_parts.next().unwrap().to_string();
                let headers = lines
                    .filter_map(|line| line.split_once(':'))
                    .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
                    .collect::<BTreeMap<_, _>>();
                let content_length = headers
                    .get("content-length")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                let body_start = split + 4;
                while bytes.len() < body_start + content_length {
                    let read = stream.read(&mut buffer).unwrap();
                    assert_ne!(read, 0, "client closed before request body");
                    bytes.extend_from_slice(&buffer[..read]);
                }
                let body_slice = &bytes[body_start..body_start + content_length];
                let body = if body_slice.is_empty() {
                    json!({})
                } else {
                    serde_json::from_slice(body_slice).unwrap()
                };
                return RecordedRequest {
                    method,
                    path,
                    headers,
                    body,
                };
            }
        }
    }

    struct OpensslServer {
        child: std::process::Child,
        base_url: String,
        dir: PathBuf,
    }

    impl OpensslServer {
        fn start() -> Option<Self> {
            if !std::process::Command::new("openssl")
                .arg("version")
                .status()
                .ok()?
                .success()
            {
                return None;
            }
            let dir = std::env::temp_dir().join(format!(
                "gfy-selfsigned-{}-{}",
                std::process::id(),
                unique_suffix()
            ));
            std::fs::create_dir_all(&dir).ok()?;
            let key = dir.join("key.pem");
            let cert = dir.join("cert.pem");
            let generated = std::process::Command::new("openssl")
                .arg("req")
                .arg("-x509")
                .arg("-newkey")
                .arg("rsa:2048")
                .arg("-nodes")
                .arg("-subj")
                .arg("/CN=localhost")
                .arg("-keyout")
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .arg("-days")
                .arg("1")
                .output()
                .ok()?;
            if !generated.status.success() {
                return None;
            }
            let listener = TcpListener::bind("127.0.0.1:0").ok()?;
            let port = listener.local_addr().ok()?.port();
            drop(listener);
            let child = std::process::Command::new("openssl")
                .arg("s_server")
                .arg("-quiet")
                .arg("-accept")
                .arg(port.to_string())
                .arg("-cert")
                .arg(&cert)
                .arg("-key")
                .arg(&key)
                .arg("-www")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()?;
            std::thread::sleep(Duration::from_millis(250));
            Some(Self {
                child,
                base_url: format!("https://127.0.0.1:{port}"),
                dir,
            })
        }

        fn base_url(&self) -> String {
            self.base_url.clone()
        }
    }

    impl Drop for OpensslServer {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn unique_suffix() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .to_string()
    }

    #[cfg(unix)]
    fn protect_file(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn protect_file(_path: &std::path::Path) {}
}
