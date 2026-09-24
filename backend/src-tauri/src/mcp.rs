//! MCP (Model Context Protocol) stdio sessions + a plain HTTP fetch command.
//!
//! `mcp-tool` nodes with `transport: 'stdio'` spawn a local MCP server
//! process (e.g. `npx -y @modelcontextprotocol/server-filesystem`). MCP's
//! stdio transport is newline-delimited JSON-RPC: one message per line over
//! stdin/stdout. Sessions live in a registry keyed by the tool node id and
//! are reused across calls within a run.
//!
//! `http_request` backs the HTTP and Web Search tools on desktop, where
//! webview CORS rules would otherwise block arbitrary APIs.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{Receiver, Sender},
        Mutex,
    },
    thread,
    time::Duration,
};

use serde::Serialize;

/// How long to wait for one JSON-RPC response before giving up.
const MCP_RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);

struct McpSession {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
}

static SESSIONS: Mutex<Option<HashMap<String, McpSession>>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    /// Response headers (lower-cased names) so callers can read e.g.
    /// `WWW-Authenticate` for OAuth discovery. Header values that aren't valid
    /// UTF-8 are skipped.
    pub headers: HashMap<String, String>,
}

/// Performs a plain HTTP request from Rust (no webview CORS, no key access).
///
/// # Errors
///
/// Returns a user-facing error when the URL is invalid or the request fails
/// at the transport level. Non-2xx responses are returned normally with
/// their status so the calling agent can react to them.
#[tauri::command]
pub async fn http_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("Unsupported URL '{url}'."));
    }

    let client = reqwest::Client::new();
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("Unsupported HTTP method '{method}'."))?;
    let mut request = client.request(method, &url);
    for (name, value) in &headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let response = request
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|error| format!("Request failed: {error}"))?;

    let status = response.status().as_u16();
    // Capture response headers (lower-cased) before consuming the body.
    let mut response_headers: HashMap<String, String> = HashMap::new();
    for (name, value) in response.headers() {
        if let Ok(value) = value.to_str() {
            response_headers.insert(name.as_str().to_lowercase(), value.to_owned());
        }
    }

    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read the response body: {error}"))?;
    // Cap the payload so a huge response can't flood the IPC bridge. The cut
    // lands on a character boundary: slicing a `str` mid-character panics.
    let body = if text.len() > 64_000 {
        format!(
            "{}…(truncated)",
            crate::web_fetch::truncate_at_char_boundary(&text, 64_000)
        )
    } else {
        text
    };

    Ok(HttpResponse {
        status,
        body,
        headers: response_headers,
    })
}

/// Resolves a bare command name to an executable path the spawned process
/// can actually launch.
///
/// On Windows:
/// - `npx`/`npm` are `.cmd` shims (not real binaries) → append `.cmd`.
/// - `uvx`/`uv` are standalone `.exe` files installed by the uv installer to
///   `~/.local/bin`, which is added to the *shell* PATH but NOT the system
///   PATH that GUI-launched apps (like Tauri) inherit. We probe the known
///   install locations and fall back to the bare name (letting the OS find
///   it via PATH if it happens to be there).
/// - Other commands are passed through as-is.
fn resolve_command(command: &str) -> Result<String, String> {
    if command.trim().is_empty() {
        return Err("No MCP command configured.".to_owned());
    }

    // Absolute or relative path with a separator — trust it as-is.
    if command.contains(std::path::MAIN_SEPARATOR) || command.contains('/') {
        return Ok(command.to_owned());
    }

    #[cfg(windows)]
    {
        // npm-family: .cmd shims.
        if matches!(command, "npx" | "npm") {
            return Ok(format!("{command}.cmd"));
        }
        if command == "node" {
            return Ok(command.to_owned());
        }

        // uv-family: standalone .exe in ~/.local/bin (not always on PATH for
        // GUI apps). Probe the known install location before falling back.
        if matches!(command, "uvx" | "uv" | "uvw") {
            if let Ok(home) = std::env::var("USERPROFILE") {
                let candidate = std::path::Path::new(&home)
                    .join(".local")
                    .join("bin")
                    .join(format!("{command}.exe"));
                if candidate.exists() {
                    return Ok(candidate.to_string_lossy().into_owned());
                }
            }
            // Fall back to the bare name — works if it's on PATH.
            return Ok(command.to_owned());
        }
    }

    Ok(command.to_owned())
}

/// Connects to (or restarts) a stdio MCP server and returns its tool list as
/// a JSON string (the `tools/list` result).
///
/// `env_keys` are keychain secret names whose values are resolved server-side
/// via `llm::get_secret` and injected as environment variables — the values
/// never cross the IPC boundary. Resolution order per key: the node-scoped
/// secret (`mcp:{server_id}:{env_key}`) wins; when absent and `preset_id` is
/// provided, the preset-scoped application default
/// (`mcp:preset:{preset_id}:{env_key}`, configured in Settings → Integrations)
/// is used as a fallback.
///
/// # Errors
///
/// Returns a user-facing error when the process cannot spawn, a configured
/// secret is missing, or the MCP handshake fails.
#[tauri::command]
pub fn mcp_connect(
    server_id: String,
    command: String,
    args: Vec<String>,
    env_keys: Vec<String>,
    preset_id: Option<String>,
) -> Result<String, String> {
    // Drop any previous session for this id.
    mcp_disconnect(server_id.clone());

    // Resolve secret env vars from the keychain (values stay in Rust).
    let mut env: HashMap<String, String> = HashMap::new();
    for env_key in &env_keys {
        let node_secret_id = format!("mcp:{server_id}:{env_key}");
        let value = crate::llm::get_secret(&node_secret_id).or_else(|| {
            preset_id
                .as_ref()
                .and_then(|preset| crate::llm::get_secret(&format!("mcp:preset:{preset}:{env_key}")))
        });
        match value {
            Some(value) => {
                env.insert(env_key.clone(), value);
            }
            None => {
                return Err(format!(
                    "Missing secret '{env_key}' for MCP node '{server_id}'. \
                     Configure it in Settings > Integrations (application default) \
                     or override it in the node's properties."
                ));
            }
        }
    }

    // npm-family binaries are .cmd shims on Windows.
    // uvx/uv are standalone .exe files that may not be on the Tauri process's
    // PATH (the uv installer adds ~/.local/bin to the shell profile, not the
    // system PATH that GUI-launched apps inherit).
    let resolved = resolve_command(&command)?;

    let mut child = Command::new(&resolved)
        .args(&args)
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start MCP server '{resolved}': {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open the MCP server's stdin.".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not open the MCP server's stdout.".to_owned())?;

    let (tx, rx): (Sender<String>, Receiver<String>) = std::sync::mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let mut session = McpSession { child, stdin, lines: rx, next_id: 0 };

    // MCP handshake: initialize → notifications/initialized → tools/list.
    request(
        &mut session,
        "initialize",
        serde_json::json!({
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "phorma-agent-studio", "version": "0.1.0" }
        }),
    )?;
    notify(&mut session, "notifications/initialized")?;
    let tools = request(&mut session, "tools/list", serde_json::json!({}))?;

    let mut guard = SESSIONS.lock().map_err(|_| "MCP registry poisoned.")?;
    guard.get_or_insert_with(HashMap::new).insert(server_id, session);

    Ok(tools.to_string())
}

/// Calls a tool on a connected stdio MCP server; returns the raw
/// `tools/call` result JSON.
///
/// # Errors
///
/// Returns a user-facing error when the session is missing or the call fails.
#[tauri::command]
pub fn mcp_call(server_id: String, name: String, arguments_json: String) -> Result<String, String> {
    let arguments: serde_json::Value =
        serde_json::from_str(&arguments_json).unwrap_or(serde_json::Value::Object(Default::default()));

    let mut guard = SESSIONS.lock().map_err(|_| "MCP registry poisoned.")?;
    let session = guard
        .as_mut()
        .and_then(|map| map.get_mut(&server_id))
        .ok_or_else(|| "MCP server is not connected. Re-run the workflow.".to_owned())?;

    let result = request(
        session,
        "tools/call",
        serde_json::json!({ "name": name, "arguments": arguments }),
    )?;
    Ok(result.to_string())
}

/// Stops a stdio MCP server session (fire-and-forget).
#[tauri::command]
pub fn mcp_disconnect(server_id: String) {
    if let Ok(mut guard) = SESSIONS.lock() {
        if let Some(map) = guard.as_mut() {
            if let Some(mut session) = map.remove(&server_id) {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
    }
}

/// Resolves the bearer token for a REMOTE (`sse`) MCP node so the webview's
/// `HttpMcpClient` can send `Authorization: Bearer <token>`.
///
/// Unlike stdio secrets (which stay in Rust and are injected as env vars),
/// a remote bearer token must reach the HTTP request made in the webview.
/// This returns ONLY the single named secret — node-scoped
/// (`mcp:{server_id}:{auth_key}`) first, then preset-scoped
/// (`mcp:preset:{preset_id}:{auth_key}`) — and nothing else.
///
/// # Errors
///
/// Never errors; returns `None` when no matching secret is stored.
#[tauri::command]
pub fn get_mcp_bearer(
    server_id: String,
    auth_key: String,
    preset_id: Option<String>,
) -> Option<String> {
    crate::llm::get_secret(&format!("mcp:{server_id}:{auth_key}")).or_else(|| {
        preset_id
            .as_ref()
            .and_then(|preset| crate::llm::get_secret(&format!("mcp:preset:{preset}:{auth_key}")))
    })
}

/// Sends one JSON-RPC request and blocks until the matching response arrives.
fn request(
    session: &mut McpSession,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    session.next_id += 1;
    let id = session.next_id;
    let message = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    writeln!(session.stdin, "{message}")
        .map_err(|error| format!("Could not write to the MCP server: {error}"))?;

    // Read lines until the response with our id shows up (skip notifications).
    loop {
        let line = session
            .lines
            .recv_timeout(MCP_RESPONSE_TIMEOUT)
            .map_err(|_| format!("MCP server did not answer '{method}' in time."))?;
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if parsed.get("id").and_then(serde_json::Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = parsed.get("error") {
            let message = error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown error");
            return Err(format!("MCP {method} failed: {message}"));
        }
        return Ok(parsed.get("result").cloned().unwrap_or(serde_json::Value::Null));
    }
}

/// Sends a JSON-RPC notification (no response expected).
fn notify(session: &mut McpSession, method: &str) -> Result<(), String> {
    let message = serde_json::json!({ "jsonrpc": "2.0", "method": method });
    writeln!(session.stdin, "{message}")
        .map_err(|error| format!("Could not write to the MCP server: {error}"))
}
