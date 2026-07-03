//! Streaming LLM proxy + OS-keychain secret storage.
//!
//! The frontend builds the full provider HTTP request (URL, headers, body)
//! with the engine's provider adapters, leaving `{{API_KEY}}` placeholders in
//! sensitive values. This module substitutes the real key from the OS
//! keychain, performs the HTTP call from Rust (no CORS, no key in the
//! webview), and streams response lines back as `llm-stream-event` events.

use std::{collections::HashMap, sync::Mutex};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;

/// Keychain service name under which provider keys are stored.
const KEYRING_SERVICE: &str = "phorma-agent-studio";
/// Placeholder substituted with the real API key (mirrors the engine).
const API_KEY_PLACEHOLDER: &str = "{{API_KEY}}";
/// Event channel carrying stream chunks to the frontend.
const LLM_STREAM_EVENT: &str = "llm-stream-event";

/// Providers allowed to have keys stored. Guards the keyring namespace.
const KNOWN_PROVIDERS: [&str; 5] = ["anthropic", "openai", "gemini", "openrouter", "ollama"];

/// Active stream cancellation flags, keyed by request id.
static ACTIVE_STREAMS: Mutex<Option<HashMap<String, tokio::sync::watch::Sender<bool>>>> =
    Mutex::new(None);

/// One frame of a proxied LLM stream.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmStreamEvent {
    request_id: String,
    /// `line` (one response line), `done`, or `error`.
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

fn validate_provider(provider: &str) -> Result<(), String> {
    if KNOWN_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!("Unknown provider '{provider}'."))
    }
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, provider)
        .map_err(|error| format!("Could not access the OS keychain: {error}"))
}

/// Prefix for MCP-scoped secrets in the keychain. Guards the namespace so
/// arbitrary keys can't be written/read via the generic secret commands.
const MCP_SECRET_PREFIX: &str = "mcp:";

fn validate_secret_key(key: &str) -> Result<(), String> {
    if key.starts_with(MCP_SECRET_PREFIX) {
        Ok(())
    } else {
        Err(format!("Secret key must start with '{MCP_SECRET_PREFIX}'."))
    }
}

/// Stores a provider API key in the OS keychain.
///
/// # Errors
///
/// Returns a user-facing error when the provider is unknown or the keychain
/// rejects the write.
#[tauri::command]
pub fn set_provider_key(provider: String, key: String) -> Result<(), String> {
    validate_provider(&provider)?;
    let entry = keyring_entry(&provider)?;
    if key.trim().is_empty() {
        // Empty key = delete.
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => return Ok(()),
            Err(error) => return Err(format!("Could not remove the stored key: {error}")),
        }
    }
    entry
        .set_password(key.trim())
        .map_err(|error| format!("Could not store the key: {error}"))
}

/// Whether a key is stored for the provider (the key itself never leaves Rust).
///
/// # Errors
///
/// Returns a user-facing error when the provider is unknown.
#[tauri::command]
pub fn has_provider_key(provider: String) -> Result<bool, String> {
    validate_provider(&provider)?;
    let entry = keyring_entry(&provider)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("Could not read the OS keychain: {error}")),
    }
}

/// Stores (or clears, when empty) a generic secret in the OS keychain.
///
/// Used for MCP server env vars — the key must be `mcp:`-prefixed (e.g.
/// `mcp:{nodeId}:{envVarName}`). The value never leaves Rust except when
/// `get_secret` resolves it internally for `mcp_connect`.
///
/// # Errors
///
/// Returns a user-facing error when the key is invalid or the keychain
/// rejects the write.
#[tauri::command]
pub fn set_secret(key: String, value: String) -> Result<(), String> {
    validate_secret_key(&key)?;
    let entry = keyring_entry(&key)?;
    if value.trim().is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => return Ok(()),
            Err(error) => return Err(format!("Could not remove the stored secret: {error}")),
        }
    }
    entry
        .set_password(value.trim())
        .map_err(|error| format!("Could not store the secret: {error}"))
}

/// Whether a secret is stored for the given key (the value never leaves Rust).
///
/// # Errors
///
/// Returns a user-facing error when the key is invalid.
#[tauri::command]
pub fn has_secret(key: String) -> Result<bool, String> {
    validate_secret_key(&key)?;
    let entry = keyring_entry(&key)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("Could not read the OS keychain: {error}")),
    }
}

/// Resolves a secret's value from the keychain (Rust-internal — NOT a command).
///
/// Used by `mcp::mcp_connect` to inject env vars into the spawned process
/// without the value ever crossing the IPC boundary to the webview.
///
/// # Errors
///
/// Returns `None` when the secret is absent (caller decides whether to fail).
pub(crate) fn get_secret(key: &str) -> Option<String> {
    let entry = keyring_entry(key).ok()?;
    entry.get_password().ok()
}

/// Starts a streaming LLM request. Response lines are emitted as
/// `llm-stream-event` events tagged with `request_id`; the command returns
/// once the stream ends (the events carry the data).
///
/// # Errors
///
/// Returns a user-facing error when the request cannot be started. Errors
/// after streaming begins arrive as `kind: "error"` events instead.
#[tauri::command]
pub async fn llm_proxy_stream(
    app: tauri::AppHandle,
    request_id: String,
    provider: String,
    url: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<(), String> {
    validate_provider(&provider)?;

    // Substitute the API key placeholder from the keychain when present.
    let needs_key = url.contains(API_KEY_PLACEHOLDER)
        || headers.values().any(|value| value.contains(API_KEY_PLACEHOLDER));
    let (url, headers) = if needs_key {
        let key = keyring_entry(&provider)?
            .get_password()
            .map_err(|_| format!("No API key configured for {provider}. Add one in Settings."))?;
        let substituted_url = url.replace(API_KEY_PLACEHOLDER, &key);
        let substituted_headers = headers
            .into_iter()
            .map(|(name, value)| (name, value.replace(API_KEY_PLACEHOLDER, &key)))
            .collect::<HashMap<_, _>>();
        (substituted_url, substituted_headers)
    } else {
        (url, headers)
    };

    let client = reqwest::Client::new();
    let mut request = client.post(&url).body(body);
    for (name, value) in &headers {
        request = request.header(name, value);
    }

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut guard = ACTIVE_STREAMS.lock().map_err(|_| "Stream registry poisoned.")?;
        guard
            .get_or_insert_with(HashMap::new)
            .insert(request_id.clone(), cancel_tx);
    }

    let emit = |kind: &str, data: Option<String>| {
        let _ = app.emit(
            LLM_STREAM_EVENT,
            LlmStreamEvent {
                request_id: request_id.clone(),
                kind: kind.to_owned(),
                data,
            },
        );
    };

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            emit("error", Some(format!("Request failed: {error}")));
            cleanup_stream(&request_id);
            return Ok(());
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let trimmed: String = detail.chars().take(300).collect();
        emit("error", Some(format!("{provider} request failed ({status}): {trimmed}")));
        cleanup_stream(&request_id);
        return Ok(());
    }

    // Stream the body, splitting into lines for the frontend parser.
    let mut buffered = String::new();
    let mut stream = response.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    emit("done", None);
                    break;
                }
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        buffered.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(index) = buffered.find('\n') {
                            let line = buffered[..index].trim_end().to_owned();
                            buffered.drain(..=index);
                            if !line.is_empty() {
                                emit("line", Some(line));
                            }
                        }
                    }
                    Some(Err(error)) => {
                        emit("error", Some(format!("Stream interrupted: {error}")));
                        break;
                    }
                    None => {
                        if !buffered.trim().is_empty() {
                            emit("line", Some(buffered.trim().to_owned()));
                        }
                        emit("done", None);
                        break;
                    }
                }
            }
        }
    }

    cleanup_stream(&request_id);
    Ok(())
}

/// Cancels an in-flight proxied stream (fire-and-forget).
#[tauri::command]
pub fn cancel_llm_stream(request_id: String) {
    let guard = ACTIVE_STREAMS.lock().ok();
    if let Some(mut streams) = guard {
        if let Some(map) = streams.as_mut() {
            if let Some(sender) = map.remove(&request_id) {
                let _ = sender.send(true);
            }
        }
    }
}

fn cleanup_stream(request_id: &str) {
    if let Ok(mut guard) = ACTIVE_STREAMS.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(request_id);
        }
    }
}
