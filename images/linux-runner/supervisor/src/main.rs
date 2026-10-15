use std::env;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;
const MAX_STREAM_BYTES: usize = 1_048_576;

unsafe extern "C" {
    fn setpgid(pid: i32, pgid: i32) -> i32;
    fn getpgid(pid: i32) -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
}

#[derive(Debug)]
struct Config {
    command_id: String,
    deadline_ms: u64,
    kill_after_ms: u64,
    cwd: PathBuf,
    argv: Vec<String>,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("gitfoundry-supervise: {error}");
            ExitCode::from(125)
        }
    }
}

fn run() -> Result<u8, String> {
    let invoked = env::args()
        .next()
        .unwrap_or_else(|| "gitfoundry-supervise".to_string());
    let args: Vec<String> = env::args().skip(1).collect();
    if args
        .iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| arg == "--version")
    {
        println!("gitfoundry-supervisor 0.1.0");
        return Ok(0);
    }
    if invoked.ends_with("gitfoundry-cancel") || args.first().map(String::as_str) == Some("cancel") {
        return cancel(args);
    }
    supervise(parse(args)?)
}

fn parse(args: Vec<String>) -> Result<Config, String> {
    let mut command_id = None;
    let mut deadline_ms = None;
    let mut kill_after_ms = Some(5000_u64);
    let mut cwd = Some(PathBuf::from("/work"));
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--command-id" => {
                i += 1;
                command_id = args.get(i).cloned();
            }
            "--deadline-ms" => {
                i += 1;
                deadline_ms = args.get(i).and_then(|v| v.parse().ok());
            }
            "--kill-after-ms" => {
                i += 1;
                kill_after_ms = args.get(i).and_then(|v| v.parse().ok());
            }
            "--cwd" => {
                i += 1;
                cwd = args.get(i).map(PathBuf::from);
            }
            "--" => {
                return Ok(Config {
                    command_id: command_id.ok_or("missing --command-id")?,
                    deadline_ms: deadline_ms.ok_or("missing --deadline-ms")?,
                    kill_after_ms: kill_after_ms.ok_or("missing --kill-after-ms")?,
                    cwd: cwd.ok_or("missing --cwd")?,
                    argv: args[(i + 1)..].to_vec(),
                })
            }
            other => return Err(format!("unexpected argument {other}")),
        }
        i += 1;
    }
    Err("missing -- command separator".to_string())
}

fn supervise(config: Config) -> Result<u8, String> {
    if config.argv.is_empty() {
        return Err("empty command".to_string());
    }
    let run_dir = run_dir();
    fs::create_dir_all(&run_dir).map_err(|error| error.to_string())?;
    let stdout_path = run_dir.join(format!("{}.stdout", config.command_id));
    let stderr_path = run_dir.join(format!("{}.stderr", config.command_id));
    let state_path = run_dir.join(format!("{}.json", config.command_id));
    prepare_cwd(&config.cwd)?;

    let mut command = Command::new(&config.argv[0]);
    command
        .current_dir(&config.cwd)
        .args(&config.argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn failed: {error}"))?;
    let pid = child.id() as i32;
    let pgid = unsafe { getpgid(pid) };
    write_state(&state_path, &config.command_id, pid, pgid, "running", None)?;

    let stdout = child.stdout.take().ok_or("missing stdout pipe")?;
    let stderr = child.stderr.take().ok_or("missing stderr pipe")?;
    let stdout_rx = spawn_drain(stdout, stdout_path, false);
    let stderr_rx = spawn_drain(stderr, stderr_path, true);
    let deadline = Instant::now() + Duration::from_millis(config.deadline_ms);
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            terminate_group(pgid, config.kill_after_ms);
            break child.wait().map_err(|error| error.to_string())?;
        }
        thread::sleep(Duration::from_millis(25));
    };
    let drain_deadline = Instant::now() + Duration::from_millis(config.kill_after_ms);
    let stdout_result = wait_for_drain(stdout_rx, "stdout", drain_deadline)?;
    let stderr_result = wait_for_drain(stderr_rx, "stderr", drain_deadline)?;
    let exit = status.code().unwrap_or(if timed_out { 124 } else { 1 });
    let final_state = if timed_out {
        "timed_out"
    } else if exit == 0 {
        "succeeded"
    } else {
        "failed"
    };
    write_state(
        &state_path,
        &config.command_id,
        pid,
        pgid,
        final_state,
        Some((
            exit,
            stdout_result.0,
            stdout_result.1,
            stderr_result.0,
            stderr_result.1,
        )),
    )?;
    Ok(u8::try_from(exit).unwrap_or(1))
}

fn cancel(args: Vec<String>) -> Result<u8, String> {
    let mut command_id = None;
    let mut term_ms = 5000_u64;
    let mut i = if args.first().map(String::as_str) == Some("cancel") {
        1
    } else {
        0
    };
    while i < args.len() {
        match args[i].as_str() {
            "--command-id" => {
                i += 1;
                command_id = args.get(i).cloned();
            }
            "--term-ms" => {
                i += 1;
                term_ms = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(5000);
            }
            other => return Err(format!("unexpected argument {other}")),
        }
        i += 1;
    }
    let command_id = command_id.ok_or("missing --command-id")?;
    let state = fs::read_to_string(run_dir().join(format!("{command_id}.json")))
        .map_err(|error| error.to_string())?;
    let pgid = json_number(&state, "pgid").ok_or("missing pgid")? as i32;
    terminate_group(pgid, term_ms);
    if process_group_exists(pgid) {
        return Err("process group still exists after cancel".to_string());
    }
    println!(
        "{{\"commandId\":\"{}\",\"status\":\"canceled\",\"pgid\":{}}}",
        json_escape(&command_id),
        pgid
    );
    Ok(0)
}

fn terminate_group(pgid: i32, term_ms: u64) {
    if pgid <= 0 {
        return;
    }
    unsafe {
        kill(-pgid, SIGTERM);
    }
    let until = Instant::now() + Duration::from_millis(term_ms);
    while Instant::now() < until {
        if !process_group_exists(pgid) {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    unsafe {
        kill(-pgid, SIGKILL);
    }
}

fn process_group_exists(pgid: i32) -> bool {
    if pgid <= 0 {
        return false;
    }
    unsafe { kill(-pgid, 0) == 0 }
}

type DrainResult = Result<(usize, bool), String>;

fn spawn_drain(
    mut input: impl Read + Send + 'static,
    path: PathBuf,
    stderr: bool,
) -> Receiver<DrainResult> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let result = if stderr {
            drain(&mut input, path, io::stderr())
        } else {
            drain(&mut input, path, io::stdout())
        };
        let _ = tx.send(result);
    });
    rx
}

fn wait_for_drain(rx: Receiver<DrainResult>, name: &str, deadline: Instant) -> DrainResult {
    let now = Instant::now();
    if now >= deadline {
        return Err(format!("{name} drain cleanup deadline expired"));
    }
    match rx.recv_timeout(deadline - now) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("{name} drain cleanup deadline expired"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(format!("{name} drain thread disconnected"))
        }
    }
}

fn drain(
    mut input: impl Read,
    path: PathBuf,
    mut output: impl Write,
) -> Result<(usize, bool), String> {
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    let mut total = 0_usize;
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let n = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if n == 0 {
            break;
        }
        if total < MAX_STREAM_BYTES {
            let keep = std::cmp::min(n, MAX_STREAM_BYTES - total);
            file.write_all(&buffer[..keep])
                .map_err(|error| error.to_string())?;
            output
                .write_all(&buffer[..keep])
                .map_err(|error| error.to_string())?;
        }
        total = total.saturating_add(n);
        if total > MAX_STREAM_BYTES {
            truncated = true;
        }
    }
    output.flush().map_err(|error| error.to_string())?;
    Ok((std::cmp::min(total, MAX_STREAM_BYTES), truncated))
}

fn prepare_cwd(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("--cwd must be absolute".to_string());
    }
    let mut built = PathBuf::from("/");
    let mut components = path.components();
    match components.next() {
        Some(Component::RootDir) => {}
        _ => return Err("--cwd must start at root".to_string()),
    }
    for component in components {
        match component {
            Component::Normal(part) => {
                built.push(part);
                match fs::symlink_metadata(&built) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink() {
                            return Err(format!(
                                "--cwd component is a symlink: {}",
                                built.display()
                            ));
                        }
                        if !metadata.is_dir() {
                            return Err(format!(
                                "--cwd component is not a directory: {}",
                                built.display()
                            ));
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        fs::create_dir(&built).map_err(|error| error.to_string())?
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
            _ => return Err("--cwd must not contain dot or parent components".to_string()),
        }
    }
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !canonical.starts_with(Path::new("/work")) {
        return Err("--cwd must stay under /work".to_string());
    }
    Ok(())
}

fn write_state(
    path: &PathBuf,
    command_id: &str,
    pid: i32,
    pgid: i32,
    status: &str,
    result: Option<(i32, usize, bool, usize, bool)>,
) -> Result<(), String> {
    let mut body = format!(
        "{{\"commandId\":\"{}\",\"pid\":{},\"pgid\":{},\"status\":\"{}\",\"updatedAtMs\":{}",
        json_escape(command_id),
        pid,
        pgid,
        status,
        now_ms()
    );
    if let Some((exit, stdout_bytes, stdout_truncated, stderr_bytes, stderr_truncated)) = result {
        body.push_str(&format!(",\"exitCode\":{},\"stdoutBytes\":{},\"stdoutTruncated\":{},\"stderrBytes\":{},\"stderrTruncated\":{}", exit, stdout_bytes, stdout_truncated, stderr_bytes, stderr_truncated));
    }
    body.push('}');
    fs::write(path, body).map_err(|error| error.to_string())
}

fn json_number(body: &str, key: &str) -> Option<i64> {
    let needle = format!("\"{key}\":");
    let start = body.find(&needle)? + needle.len();
    let rest = &body[start..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '-')
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn run_dir() -> PathBuf {
    PathBuf::from(env::var("GFY_RUN_DIR").unwrap_or_else(|_| "/run/gitfoundry".to_string()))
}
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
