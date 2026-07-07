//! Desktop OAuth loopback callback capture.
//!
//! Interactive MCP OAuth (spec 2025-06-18) needs a browser round-trip: we open
//! the system browser at the authorization URL, the user consents, and the
//! authorization server redirects back to a `redirect_uri`. Public desktop
//! clients use a loopback URI (`http://127.0.0.1:<port>/callback`), which the
//! spec explicitly permits and which pairs cleanly with dynamic client
//! registration (no pre-registered URI needed).
//!
//! Flow across the IPC boundary:
//!   1. `oauth_loopback_start` binds an ephemeral port and returns the
//!      `redirect_uri` + an opaque `listener_id`. The webview's engine builds
//!      the authorization URL with this redirect and opens the browser.
//!   2. `oauth_loopback_wait(listener_id)` blocks (with a timeout) until the
//!      browser hits the loopback, then returns the `code` + `state` query
//!      params. The listener is single-shot and cleaned up either way.
//!
//! The token EXCHANGE happens in the engine (webview), not here — this module
//! only captures the redirect. Tokens are persisted via the existing keychain
//! `set_secret`/`get_secret` path.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    sync::Mutex,
    time::{Duration, Instant},
};

/// How long to wait for the user to complete consent before giving up.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

/// Pending loopback listeners, keyed by an opaque id handed to the webview.
static LISTENERS: Mutex<Option<HashMap<String, TcpListener>>> = Mutex::new(None);

/// Result of a captured OAuth redirect.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackStart {
    /// The opaque handle passed back to `oauth_loopback_wait`.
    listener_id: String,
    /// The `redirect_uri` the engine must use in the authorization request.
    redirect_uri: String,
}

/// Binds a loopback listener on an ephemeral port and returns its redirect URI.
///
/// The listener is retained server-side under `listener_id` until
/// `oauth_loopback_wait` consumes it (or the process exits).
///
/// # Errors
///
/// Returns a user-facing error if no local port can be bound.
#[tauri::command]
pub fn oauth_loopback_start(preferred_port: Option<u16>) -> Result<LoopbackStart, String> {
    // Try the preferred (stable) port first so users can register a fixed
    // redirect URI with providers like GitHub; fall back to an OS-assigned
    // ephemeral port (0) if it's taken.
    let listener = preferred_port
        .and_then(|port| TcpListener::bind(("127.0.0.1", port)).ok())
        .map_or_else(
            || TcpListener::bind("127.0.0.1:0"),
            Ok,
        )
        .map_err(|error| format!("Could not open a local callback port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read the callback port: {error}"))?
        .port();

    let listener_id = format!("oauth-{port}-{}", monotonic_nonce());
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let mut guard = LISTENERS.lock().map_err(|_| "OAuth listener registry poisoned.")?;
    guard
        .get_or_insert_with(HashMap::new)
        .insert(listener_id.clone(), listener);

    Ok(LoopbackStart { listener_id, redirect_uri })
}

/// Query params captured from the OAuth redirect.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackResult {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Blocks until the browser hits the loopback redirect, then returns the
/// captured query params. Sends a small HTML page back to the browser so the
/// user sees a friendly "you can close this tab" message.
///
/// # Errors
///
/// Returns a user-facing error if the listener id is unknown, the wait times
/// out, or the socket fails.
#[tauri::command]
pub async fn oauth_loopback_wait(listener_id: String) -> Result<LoopbackResult, String> {
    let listener = {
        let mut guard = LISTENERS.lock().map_err(|_| "OAuth listener registry poisoned.")?;
        guard
            .as_mut()
            .and_then(|map| map.remove(&listener_id))
            .ok_or_else(|| "OAuth callback listener not found (already used or expired).".to_owned())?
    };

    // Bound the blocking accept so a user who never finishes consent can't
    // pin the port forever.
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure the callback listener: {error}"))?;
    let deadline = Instant::now() + CONSENT_TIMEOUT;

    loop {
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                let request_line = {
                    let mut reader = BufReader::new(&stream);
                    let mut line = String::new();
                    reader
                        .read_line(&mut line)
                        .map_err(|error| format!("Could not read the callback request: {error}"))?;
                    line
                };

                let params = parse_query(&request_line);
                let ok = params.contains_key("code");
                write_browser_response(&mut stream, ok);

                return Ok(LoopbackResult {
                    code: params.get("code").cloned(),
                    state: params.get("state").cloned(),
                    error: params.get("error").cloned(),
                    error_description: params.get("error_description").cloned(),
                });
            }
            Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("Timed out waiting for OAuth consent.".to_owned());
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(error) => return Err(format!("OAuth callback listener failed: {error}")),
        }
    }
}

/// Releases a pending listener without waiting (e.g. the user cancelled).
#[tauri::command]
pub fn oauth_loopback_cancel(listener_id: String) {
    if let Ok(mut guard) = LISTENERS.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(&listener_id);
        }
    }
}

/// Extracts the query string from an HTTP request line
/// (`GET /callback?code=…&state=… HTTP/1.1`) into a map, URL-decoding values.
fn parse_query(request_line: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    let Some(path) = request_line.split_whitespace().nth(1) else {
        return params;
    };
    let Some((_, query)) = path.split_once('?') else {
        return params;
    };
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            params.insert(key.to_owned(), percent_decode(value));
        }
    }
    params
}

/// Minimal application/x-www-form-urlencoded percent-decoder (`+` => space).
fn percent_decode(input: &str) -> String {
    let bytes = input.replace('+', " ");
    let bytes = bytes.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&format!("{}{}", bytes[i + 1] as char, bytes[i + 2] as char), 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Writes a tiny HTML page back to the browser tab, then closes the socket.
fn write_browser_response(stream: &mut std::net::TcpStream, ok: bool) {
    let (title, message) = if ok {
        ("Connected", "Authorization complete. You can close this tab and return to Phorma Agent Studio.")
    } else {
        ("Authorization failed", "Something went wrong. You can close this tab and try again in Phorma Agent Studio.")
    };
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{font-family:system-ui,sans-serif;background:#0b0b0f;color:#e5e5ee;\
         display:grid;place-items:center;height:100vh;margin:0}}\
         .card{{text-align:center;max-width:28rem;padding:2rem}}\
         h1{{font-size:1.25rem;margin:0 0 .5rem}}p{{opacity:.75;line-height:1.5}}</style></head>\
         <body><div class=\"card\"><h1>{title}</h1><p>{message}</p></div></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// A process-lifetime monotonic counter for unique listener ids.
fn monotonic_nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}
