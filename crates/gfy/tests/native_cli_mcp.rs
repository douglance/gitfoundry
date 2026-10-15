use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

#[test]
fn native_cli_command_uses_rest_port() {
    let server = FixtureServer::start(vec![
        response(200, actor(1)),
        response(200, json!({"version": null})),
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_gfy"))
        .arg("forge")
        .arg("head")
        .arg("--repository-id")
        .arg("repo-a")
        .env("GFY_API_BASE_URL", server.base_url())
        .env("GFY_TENANT_ID", "tenant-a")
        .env("GFY_ACCESS_JWT", "cli-token")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = server.requests(2);
    assert_eq!(requests[0].path, "/api/v1/tenants/tenant-a/auth/whoami");
    assert_eq!(requests[0].authorization(), Some("Bearer cli-token"));
    assert_eq!(requests[1].method, "GET");
    assert_eq!(
        requests[1].path,
        "/api/v2/tenants/tenant-a/repositories/repo-a/forge/head"
    );
    assert_eq!(requests[1].authorization(), Some("Bearer cli-token"));
}

#[test]
fn native_cli_repo_list_uses_v1_repository_route() {
    let server = FixtureServer::start(vec![
        response(200, actor(1)),
        response(
            200,
            json!({"items": [], "next_cursor": null, "has_more": false}),
        ),
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_gfy"))
        .arg("repo")
        .arg("list")
        .env("GFY_API_BASE_URL", server.base_url())
        .env("GFY_TENANT_ID", "tenant-a")
        .env("GFY_ACCESS_JWT", "repo-token")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = server.requests(2);
    assert_eq!(requests[0].path, "/api/v1/tenants/tenant-a/auth/whoami");
    assert_eq!(requests[0].authorization(), Some("Bearer repo-token"));
    assert_eq!(requests[1].method, "GET");
    assert_eq!(requests[1].path, "/api/v1/tenants/tenant-a/repositories");
    assert_eq!(requests[1].authorization(), Some("Bearer repo-token"));
}

#[test]
fn stdio_mcp_initialize_list_and_call_use_same_catalog() {
    let server = FixtureServer::start(vec![
        response(200, actor(1)),
        response(200, json!({"version": null})),
    ]);
    let mut child = Command::new(env!("CARGO_BIN_EXE_gfy"))
        .arg("--mcp")
        .env("GFY_API_BASE_URL", server.base_url())
        .env("GFY_TENANT_ID", "tenant-a")
        .env("GFY_ACCESS_JWT", "stdio-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (line_tx, line_rx) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if line_tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });

    send_json_rpc(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "gfy-test", "version": "0"}
            }
        }),
    );
    let initialized = read_json_rpc(&line_rx);
    assert_eq!(initialized["result"]["protocolVersion"], "2025-11-25");

    send_json_rpc(
        &mut stdin,
        json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}),
    );
    send_json_rpc(
        &mut stdin,
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
    );
    let listed = read_json_rpc(&line_rx);
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 4);
    assert!(tools.iter().any(|tool| tool["name"] == "search_tools"));
    assert!(tools.iter().any(|tool| tool["name"] == "call_read_tool"));

    send_json_rpc(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "search_tools",
                "arguments": {"query": "", "limit": 250}
            }
        }),
    );
    let searched = read_json_rpc(&line_rx);
    let discovered = searched["result"]["structuredContent"]["tools"]
        .as_array()
        .unwrap();
    assert_eq!(discovered.len(), 15);
    assert!(
        discovered
            .iter()
            .any(|tool| tool["name"] == "gfy_repo_create")
    );
    assert!(
        discovered
            .iter()
            .any(|tool| tool["name"] == "gfy_forge_head")
    );

    send_json_rpc(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 100,
            "method": "tools/call",
            "params": {
                "name": "call_read_tool",
                "arguments": {"name": "gfy_forge_head", "arguments": {"repository_id": "repo-a"}}
            }
        }),
    );
    let called = read_json_rpc(&line_rx);
    assert!(called.get("error").is_none(), "{called}");
    assert_eq!(called["id"], 100);

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();

    let requests = server.requests(2);
    assert_eq!(requests[0].path, "/api/v1/tenants/tenant-a/auth/whoami");
    assert_eq!(requests[0].authorization(), Some("Bearer stdio-token"));
    assert_eq!(
        requests[1].path,
        "/api/v2/tenants/tenant-a/repositories/repo-a/forge/head"
    );
}

fn send_json_rpc(stdin: &mut std::process::ChildStdin, value: Value) {
    let body = value.to_string();
    writeln!(stdin, "{body}").unwrap();
    stdin.flush().unwrap();
}

fn read_json_rpc(rx: &Receiver<String>) -> Value {
    let line = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    serde_json::from_str(line.trim()).unwrap()
}

fn actor(epoch: u64) -> Value {
    json!({
        "tenant_id": "tenant-a",
        "principal_id": "principal-a",
        "kind": "human",
        "policy_epoch": epoch,
        "scopes": ["repo.read"]
    })
}

fn response(status: u16, body: Value) -> FixtureResponse {
    FixtureResponse { status, body }
}

struct FixtureResponse {
    status: u16,
    body: Value,
}

#[derive(Debug)]
struct RecordedRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
}

impl RecordedRequest {
    fn authorization(&self) -> Option<&str> {
        self.headers.get("authorization").map(String::as_str)
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
                tx.send(read_request(&mut stream)).unwrap();
                let body = response.body.to_string();
                let reply = format!(
                    "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.status,
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
            return RecordedRequest {
                method,
                path,
                headers,
            };
        }
    }
}
