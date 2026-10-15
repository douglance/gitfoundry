#[test]
fn cli_help_is_available_without_api_credentials() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_gfy"))
        .arg("--help")
        .env_remove("GFY_API_BASE_URL")
        .env_remove("GFY_TENANT_ID")
        .env_remove("GFY_ACCESS_JWT")
        .env_remove("GFY_ACCESS_JWT_FILE")
        .output()
        .expect("native gfy should launch");
    assert!(
        output.status.success(),
        "help failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let help = String::from_utf8(output.stdout).expect("help should be UTF-8");
    assert!(help.starts_with("gfy@"), "CLI banner must use gfy: {help}");
    assert!(
        help.contains("Usage: gfy <command>"),
        "CLI usage must use gfy: {help}"
    );
    assert!(
        help.contains("GitFoundry native CLI"),
        "CLI must show the product name: {help}"
    );
    assert!(
        help.contains("forge  forge operations"),
        "forge commands are absent from help"
    );
}
