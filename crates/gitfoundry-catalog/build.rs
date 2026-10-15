use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let source_root = manifest_dir.join("../../docs/source/handoff");
    let operations_text = fs::read_to_string(source_root.join("contracts/operations.json"))
        .expect("read operations source");
    let mcp_text = fs::read_to_string(source_root.join("contracts/mcp-tools.json"))
        .expect("read MCP tool source");
    let openapi_text = fs::read_to_string(source_root.join("contracts/openapi.json"))
        .expect("read OpenAPI source");
    let sql =
        fs::read_to_string(source_root.join("contracts/schema.sql")).expect("read SQL source");

    let operations: serde_json::Value =
        serde_json::from_str(&operations_text).expect("operations JSON");
    let mcp_tools: serde_json::Value = serde_json::from_str(&mcp_text).expect("MCP tools JSON");
    let openapi: serde_json::Value = serde_json::from_str(&openapi_text).expect("OpenAPI JSON");

    let operation_count = operations["operations"]
        .as_array()
        .expect("operations array")
        .len();
    let mcp_tool_count = mcp_tools["tools"].as_array().expect("tools array").len();
    let openapi_path_count = openapi["paths"].as_object().expect("paths object").len();
    let sql_table_count = sql.matches("CREATE TABLE ").count();

    assert_eq!(operation_count, 198, "source operation count");
    assert_eq!(mcp_tool_count, 198, "source MCP tool count");
    assert_eq!(openapi_path_count, 129, "source OpenAPI path count");
    assert_eq!(sql_table_count, 52, "source SQL table count");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("generated_catalog.rs");
    fs::write(out, format!(
        "pub const OPERATION_COUNT: usize = {operation_count};\npub const MCP_TOOL_COUNT: usize = {mcp_tool_count};\npub const OPENAPI_PATH_COUNT: usize = {openapi_path_count};\npub const SQL_TABLE_COUNT: usize = {sql_table_count};\n"
    )).expect("write generated catalog");

    println!(
        "cargo:rerun-if-changed={}",
        source_root.join("contracts/operations.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        source_root.join("contracts/mcp-tools.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        source_root.join("contracts/openapi.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        source_root.join("contracts/schema.sql").display()
    );
    println!("cargo:rerun-if-changed=../../packages/contracts/src/fork-catalog.json");
}
