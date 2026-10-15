#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "local") {
        let script = find_local_entrypoint()?;
        let status = std::process::Command::new("node")
            .arg(script)
            .args(args.iter().skip(1))
            .stdin(std::process::Stdio::inherit())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .status()?;
        std::process::exit(status.code().unwrap_or(1));
    }
    let cli =
        gfy::build_cli_from_env().map_err(|error| format!("{}: {}", error.code, error.message))?;
    tokio::runtime::Runtime::new()?.block_on(cli.serve())
}

#[cfg(not(target_arch = "wasm32"))]
fn find_local_entrypoint() -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let relative = std::path::Path::new("scripts").join("gfy-local.mjs");
    if relative.exists() {
        return Ok(relative);
    }
    if let Ok(root) = std::env::var("GFY_REPO_ROOT") {
        let candidate = std::path::PathBuf::from(root).join(&relative);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    if let Ok(current) = std::env::current_dir() {
        if let Some(found) = find_upwards(&current, &relative) {
            return Ok(found);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(found) = find_upwards(parent, &relative) {
                return Ok(found);
            }
        }
    }
    Err("unable to find scripts/gfy-local.mjs; run from the GitFoundry repository or set GFY_REPO_ROOT".into())
}

#[cfg(not(target_arch = "wasm32"))]
fn find_upwards(start: &std::path::Path, relative: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut current = Some(start);
    while let Some(directory) = current {
        let candidate = directory.join(relative);
        if candidate.exists() {
            return Some(candidate);
        }
        current = directory.parent();
    }
    None
}

#[cfg(target_arch = "wasm32")]
fn main() {}
