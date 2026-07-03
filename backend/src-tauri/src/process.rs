//! Streamed external-process runner.
//!
//! Powers the Cloud dialog's Deploy button (`npx wrangler deploy`) and any
//! future finite CLI work (MCP installs, etc.). Output lines are ANSI-stripped
//! and emitted as `process-output-event` events; the command's exit status is
//! returned when it finishes.
//!
//! Ported from Phorma Code's process infrastructure — including the Windows
//! lessons: `.cmd` shims for npm-family binaries and `CI=true` so CLIs fail
//! fast instead of prompting an output-only console.

use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
};

use serde::Serialize;
use tauri::Emitter;

const PROCESS_OUTPUT_EVENT: &str = "process-output-event";

/// Commands the frontend may run. An allow-list, not arbitrary execution.
const ALLOWED_PROGRAMS: [&str; 2] = ["npx", "npm"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessOutputEvent {
    request_id: String,
    /// `stdout`, `stderr`, or `exit`.
    stream: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResult {
    pub success: bool,
    pub exit_code: Option<i32>,
}

/// Runs an allow-listed program with streamed output.
///
/// # Errors
///
/// Returns a user-facing error when the program is not allow-listed, the
/// working directory is invalid, or the process cannot be spawned.
#[tauri::command]
pub async fn run_streamed_command(
    app: tauri::AppHandle,
    request_id: String,
    cwd: String,
    program: String,
    args: Vec<String>,
) -> Result<ProcessResult, String> {
    if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
        return Err(format!("Program '{program}' is not allowed."));
    }
    let dir = PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(format!("Folder '{cwd}' does not exist."));
    }

    // Windows: npm-family binaries are .cmd shims.
    let resolved = if cfg!(windows) { format!("{program}.cmd") } else { program };

    let mut child = Command::new(&resolved)
        .args(&args)
        .current_dir(&dir)
        // Non-interactive: CLIs fail fast instead of prompting a console that
        // can't answer (learned the hard way with ng serve in Phorma Code).
        .env("CI", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start {resolved}: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read process output.".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read process errors.".to_owned())?;

    let out_thread = spawn_line_reader(app.clone(), request_id.clone(), "stdout", stdout);
    let err_thread = spawn_line_reader(app.clone(), request_id.clone(), "stderr", stderr);

    // Wait off the async runtime's main thread.
    let status = tauri::async_runtime::spawn_blocking(move || child.wait())
        .await
        .map_err(|error| format!("Process wait failed: {error}"))?
        .map_err(|error| format!("Could not wait for the process: {error}"))?;

    let _ = out_thread.join();
    let _ = err_thread.join();

    let _ = app.emit(
        PROCESS_OUTPUT_EVENT,
        ProcessOutputEvent {
            request_id,
            stream: "exit".to_owned(),
            line: status.code().map_or_else(|| "terminated".to_owned(), |code| code.to_string()),
        },
    );

    Ok(ProcessResult {
        success: status.success(),
        exit_code: status.code(),
    })
}

fn spawn_line_reader<R>(
    app: tauri::AppHandle,
    request_id: String,
    stream: &'static str,
    reader: R,
) -> thread::JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let line = strip_ansi_codes(&line);
            if line.trim().is_empty() {
                continue;
            }
            let _ = app.emit(
                PROCESS_OUTPUT_EVENT,
                ProcessOutputEvent {
                    request_id: request_id.clone(),
                    stream: stream.to_owned(),
                    line,
                },
            );
        }
    })
}

/// Remove ANSI escape sequences (colors, cursor moves, etc.) from a line so
/// the console shows clean text instead of artifacts like `\x1b[33m`.
fn strip_ansi_codes(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            result.push(ch);
            continue;
        }

        match chars.peek() {
            // CSI sequence: ESC [ ... <final byte 0x40-0x7E>
            Some('[') => {
                chars.next();
                for inner in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&inner) {
                        break;
                    }
                }
            }
            // OSC sequence: ESC ] ... terminated by BEL or ST (ESC \)
            Some(']') => {
                chars.next();
                while let Some(inner) = chars.next() {
                    if inner == '\u{7}' {
                        break;
                    }
                    if inner == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Other two-character escape (e.g. ESC c); drop the next char.
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }

    result
}
