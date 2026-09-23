//! Streaming LLM proxy + OS-keychain secret storage.
//!
//! The frontend builds the full provider HTTP request (URL, headers, body)
//! with the engine's provider adapters, leaving `{{API_KEY}}` placeholders in
//! sensitive values. This module substitutes the real key from the OS
//! keychain, performs the HTTP call from Rust (no CORS, no key in the
//! webview), and streams response lines back as `llm-stream-event` events.

use std::{collections::HashMap, sync::Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// Keychain service name under which provider keys are stored.
const KEYRING_SERVICE: &str = "phorma-agent-studio";
/// Placeholder substituted with the real API key (mirrors the engine).
const API_KEY_PLACEHOLDER: &str = "{{API_KEY}}";
/// Event channel carrying stream chunks to the frontend.
const LLM_STREAM_EVENT: &str = "llm-stream-event";

/// Providers allowed to have keys stored. Guards the keyring namespace.
///
/// `typesafe` is the System One (Jev) decision-model key. It is not a chat
/// provider - the webview never builds a streaming request for it - but it
/// lives in the same namespace so Settings reuses `set_provider_key` /
/// `has_provider_key`, and [`crate::decisions`] reads it here.
const KNOWN_PROVIDERS: [&str; 8] = [
    "anthropic",
    "openai",
    "gemini",
    "openrouter",
    "ollama",
    "bedrock",
    "lmstudio",
    "typesafe",
];

/// Reads a stored provider key. Crate-internal: a provider key never crosses
/// IPC; callers use it to authenticate a request performed in Rust.
pub(crate) fn provider_key(provider: &str) -> Result<Option<String>, String> {
    validate_provider(provider)?;
    read_secret_value(provider)
}

/// Max characters stored in a single keychain entry. Windows Credential
/// Manager caps a credential blob at 2560 UTF-16 code units, so large secrets
/// (e.g. Bedrock short-term API keys, which embed an AWS session token) are
/// split across multiple entries and reassembled on read. Kept well under the
/// limit to stay safe even for multi-byte characters.
const MAX_SECRET_CHARS: usize = 1000;

/// Marker stored in the primary entry when a secret is split into chunks,
/// followed by the chunk count. The leading control character cannot appear in
/// a real API key, token, or env value, so it can't collide with a raw secret.
const CHUNK_MANIFEST_PREFIX: &str = "\u{1}phorma-chunks:";

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

/// Prefix for connection-scoped secrets in the keychain. Sits alongside
/// `MCP_SECRET_PREFIX` so the generic secret commands stay namespaced. Entry
/// names have the form `conn:{connectionId}:{secretKey}` and reuse the same
/// chunked `store_secret_value` / `clear_secret_value` path.
const CONNECTION_SECRET_PREFIX: &str = "conn:";

/// Prefix for the Phorma account credential namespace.
///
/// Exactly one entry lives under it, [`DEVICE_TOKEN_KEY`]. It is a prefix rather
/// than a bare name so it passes the same namespace validation as the other two
/// and so a future second entry (a refresh token, when lean v1 grows one) needs no
/// change here.
const PHORMA_AUTH_PREFIX: &str = "phorma-auth:";

/// Keychain entry holding the Phorma desktop sign-in token.
///
/// Written by the studio after the browser handoff completes, read back by
/// [`phorma_auth_token`], and deleted on sign-out.
pub(crate) const DEVICE_TOKEN_KEY: &str = "phorma-auth:device-token";

fn validate_secret_key(key: &str) -> Result<(), String> {
    if key.starts_with(MCP_SECRET_PREFIX)
        || key.starts_with(CONNECTION_SECRET_PREFIX)
        || key.starts_with(PHORMA_AUTH_PREFIX)
    {
        Ok(())
    } else {
        Err(format!(
            "Secret key must start with '{MCP_SECRET_PREFIX}', '{CONNECTION_SECRET_PREFIX}' or \
             '{PHORMA_AUTH_PREFIX}'."
        ))
    }
}

/// Keychain entry name of the `index`-th chunk for a base secret name.
fn chunk_entry_name(base: &str, index: usize) -> String {
    format!("{base}\u{1}chunk\u{1}{index}")
}

/// Removes a stored secret and every chunk entry it may have spilled into.
fn clear_secret_value(base: &str) -> Result<(), String> {
    // If the primary entry holds a chunk manifest, delete the referenced
    // chunk entries first so nothing is orphaned.
    match keyring_entry(base)?.get_password() {
        Ok(value) => {
            if let Some(count) = value.strip_prefix(CHUNK_MANIFEST_PREFIX) {
                let count: usize = count.parse().unwrap_or(0);
                for index in 0..count {
                    match keyring_entry(&chunk_entry_name(base, index))?.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => {}
                        Err(error) => {
                            return Err(format!("Could not remove a stored key chunk: {error}"));
                        }
                    }
                }
            }
        }
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(error) => return Err(format!("Could not read the OS keychain: {error}")),
    }
    match keyring_entry(base)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not remove the stored value: {error}")),
    }
}

/// Stores a secret, transparently splitting values that exceed the per-entry
/// platform limit across multiple keychain entries.
fn store_secret_value(base: &str, value: &str) -> Result<(), String> {
    // Replace any previous value (and its chunks) before writing the new one.
    clear_secret_value(base)?;

    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= MAX_SECRET_CHARS {
        return keyring_entry(base)?
            .set_password(value)
            .map_err(|error| format!("Could not store the key: {error}"));
    }

    let chunks: Vec<String> = chars
        .chunks(MAX_SECRET_CHARS)
        .map(|chunk| chunk.iter().collect())
        .collect();
    for (index, chunk) in chunks.iter().enumerate() {
        keyring_entry(&chunk_entry_name(base, index))?
            .set_password(chunk)
            .map_err(|error| format!("Could not store the key: {error}"))?;
    }
    keyring_entry(base)?
        .set_password(&format!("{CHUNK_MANIFEST_PREFIX}{}", chunks.len()))
        .map_err(|error| format!("Could not store the key: {error}"))
}

/// Keychain entry name for one connection secret field, matching
/// `connectionSecretName` in `engine/src/connections.ts`.
fn connection_secret_name(connection_id: &str, secret_key: &str) -> String {
    format!("{CONNECTION_SECRET_PREFIX}{connection_id}:{secret_key}")
}

/// Reads one connection secret through the shared chunked keychain path.
///
/// The only door the data path uses to reach a connection secret, so there is
/// exactly one storage format and one namespace check. The value stays in Rust:
/// callers apply it to an outbound request and never return it to the webview.
///
/// # Errors
///
/// Returns a user-facing error when the keychain is unreadable or the stored
/// chunk manifest is corrupt. A key that was never stored yields `Ok(None)`.
pub(crate) fn read_connection_secret(
    connection_id: &str,
    secret_key: &str,
) -> Result<Option<String>, String> {
    let name = connection_secret_name(connection_id, secret_key);
    validate_secret_key(&name)?;
    read_secret_value(&name)
}

/// Reads a secret, reassembling chunked values. `None` when nothing is stored.
fn read_secret_value(base: &str) -> Result<Option<String>, String> {
    let primary = match keyring_entry(base)?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(format!("Could not read the OS keychain: {error}")),
    };
    let Some(count) = primary.strip_prefix(CHUNK_MANIFEST_PREFIX) else {
        return Ok(Some(primary));
    };
    let count: usize = count
        .parse()
        .map_err(|_| "Stored key manifest is corrupt.".to_owned())?;
    let mut assembled = String::new();
    for index in 0..count {
        let chunk = keyring_entry(&chunk_entry_name(base, index))?
            .get_password()
            .map_err(|_| "A stored key chunk is missing.".to_owned())?;
        assembled.push_str(&chunk);
    }
    Ok(Some(assembled))
}

/// Stores a provider API key in the OS keychain (chunked when large).
///
/// # Errors
///
/// Returns a user-facing error when the provider is unknown or the keychain
/// rejects the write.
#[tauri::command]
pub fn set_provider_key(provider: String, key: String) -> Result<(), String> {
    validate_provider(&provider)?;
    let key = key.trim();
    if key.is_empty() {
        return clear_secret_value(&provider); // Empty key = delete.
    }
    store_secret_value(&provider, key)
}

/// Whether a key is stored for the provider (the key itself never leaves Rust).
///
/// # Errors
///
/// Returns a user-facing error when the provider is unknown.
#[tauri::command]
pub fn has_provider_key(provider: String) -> Result<bool, String> {
    validate_provider(&provider)?;
    Ok(read_secret_value(&provider)?.is_some())
}

/// One entry in the bedrock-mantle `/v1/models` (OpenAI-shaped) response.
#[derive(Deserialize)]
struct BedrockModel {
    id: String,
}

#[derive(Deserialize)]
struct BedrockModelsResponse {
    #[serde(default)]
    data: Vec<BedrockModel>,
}

/// Lists model ids available on the Amazon Bedrock `bedrock-mantle` endpoint
/// for an AWS region, authenticating with the stored Bedrock API key. Powers
/// the studio's "Fetch available models" action so users pick real, region-
/// valid ids instead of guessing (Bedrock model ids are catalog- and region-
/// specific). The key never leaves Rust.
///
/// # Errors
///
/// Returns a user-facing error when no key is stored, the region is empty, or
/// the request fails.
#[tauri::command]
pub async fn list_bedrock_models(region: String) -> Result<Vec<String>, String> {
    let region = region.trim();
    if region.is_empty() {
        return Err("Choose an AWS region first.".to_owned());
    }
    let key = read_secret_value("bedrock")?
        .ok_or_else(|| "No Bedrock API key configured. Add one in Settings → API Keys.".to_owned())?;

    let url = format!("https://bedrock-mantle.{region}.api.aws/v1/models");
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|error| format!("Could not reach Bedrock: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let trimmed: String = detail.chars().take(300).collect();
        return Err(format!("Bedrock models request failed ({status}): {trimmed}"));
    }

    let parsed: BedrockModelsResponse = response
        .json()
        .await
        .map_err(|error| format!("Could not parse the Bedrock models response: {error}"))?;
    let mut ids: Vec<String> = parsed.data.into_iter().map(|model| model.id).collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// One entry in the Bedrock `ListInferenceProfiles` control-plane response.
#[derive(Deserialize)]
struct InferenceProfileSummary {
    #[serde(rename = "inferenceProfileId")]
    inference_profile_id: String,
}

#[derive(Deserialize)]
struct ListInferenceProfilesResponse {
    #[serde(rename = "inferenceProfileSummaries", default)]
    inference_profile_summaries: Vec<InferenceProfileSummary>,
}

/// Lists the system-defined inference profile ids available in a region (e.g.
/// `au.anthropic.claude-opus-4-7`), authenticating with the stored Bedrock API
/// key. This hits the Bedrock CONTROL-PLANE endpoint (`bedrock.{region}`), not
/// the runtime one; the API key is valid for Amazon Bedrock control-plane
/// actions. Merged into the model picker so region-locked Claude/Nova profiles
/// are discoverable. The key never leaves Rust.
///
/// # Errors
///
/// Returns a user-facing error when no key is stored, the region is empty, or
/// the request fails.
#[tauri::command]
pub async fn list_bedrock_inference_profiles(region: String) -> Result<Vec<String>, String> {
    let region = region.trim();
    if region.is_empty() {
        return Err("Choose an AWS region first.".to_owned());
    }
    let key = read_secret_value("bedrock")?
        .ok_or_else(|| "No Bedrock API key configured. Add one in Settings → API Keys.".to_owned())?;

    let url = format!(
        "https://bedrock.{region}.amazonaws.com/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000"
    );
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|error| format!("Could not reach Bedrock: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let trimmed: String = detail.chars().take(300).collect();
        return Err(format!("Bedrock inference-profiles request failed ({status}): {trimmed}"));
    }

    let parsed: ListInferenceProfilesResponse = response.json().await.map_err(|error| {
        format!("Could not parse the Bedrock inference-profiles response: {error}")
    })?;
    let mut ids: Vec<String> = parsed
        .inference_profile_summaries
        .into_iter()
        .map(|profile| profile.inference_profile_id)
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// One entry in the OpenAI/OpenRouter `data` array (also used by Anthropic).
#[derive(Deserialize)]
struct ProviderModelEntry {
    id: Option<String>,
}

/// One entry in the Google Gemini `models` array.
#[derive(Deserialize)]
struct GeminiModelEntry {
    name: Option<String>,
}

/// Lists model ids available for a BYO provider (anthropic/openai/gemini/
/// openrouter), authenticating with the stored API key. Powers the model
/// picker's live dropdown so users pick real ids instead of guessing. The key
/// never leaves Rust.
///
/// # Errors
///
/// Returns a user-facing error when no key is stored or the request fails.
#[tauri::command]
pub async fn list_provider_models(provider: String) -> Result<Vec<String>, String> {
    let provider = provider.trim();
    let key = read_secret_value(provider)?.ok_or_else(|| {
        format!("No {provider} API key configured. Add one in Settings → API Keys.")
    })?;

    let client = reqwest::Client::new();
    let (url, use_bearer, use_anthropic_version, is_gemini) = match provider {
        "anthropic" => (
            "https://api.anthropic.com/v1/models?limit=1000".to_owned(),
            false,
            true,
            false,
        ),
        "openai" => ("https://api.openai.com/v1/models".to_owned(), true, false, false),
        "openrouter" => (
            "https://openrouter.ai/api/v1/models".to_owned(),
            true,
            false,
            false,
        ),
        "gemini" => (
            format!("https://generativelanguage.googleapis.com/v1beta/models?key={key}"),
            false,
            false,
            true,
        ),
        _ => return Err(format!("Provider '{provider}' has no models endpoint.")),
    };

    let mut request = client.get(&url);
    if use_bearer {
        request = request.bearer_auth(&key);
    }
    if use_anthropic_version {
        request = request
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01");
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach {provider}: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let trimmed: String = detail.chars().take(300).collect();
        return Err(format!("{provider} models request failed ({status}): {trimmed}"));
    }

    let mut ids: Vec<String> = if is_gemini {
        let parsed: GeminiModelsResponse = response
            .json()
            .await
            .map_err(|error| format!("Could not parse the {provider} models response: {error}"))?;
        parsed
            .models
            .into_iter()
            .filter_map(|model| model.name)
            // Strip the "models/" prefix Google prepends.
            .map(|name| name.strip_prefix("models/").unwrap_or(&name).to_owned())
            .collect()
    } else {
        let parsed: ProviderModelsResponse = response
            .json()
            .await
            .map_err(|error| format!("Could not parse the {provider} models response: {error}"))?;
        parsed.data.into_iter().filter_map(|model| model.id).collect()
    };
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// OpenAI/OpenRouter/Anthropic models-list response shape.
#[derive(Deserialize)]
struct ProviderModelsResponse {
    #[serde(default)]
    data: Vec<ProviderModelEntry>,
}

/// Google Gemini models-list response shape.
#[derive(Deserialize)]
struct GeminiModelsResponse {
    #[serde(default)]
    models: Vec<GeminiModelEntry>,
}

/// Stores (or clears, when empty) a generic secret in the OS keychain.
///
/// Used for MCP server env vars (`mcp:{nodeId}:{envVarName}`) and connection
/// secrets (`conn:{connectionId}:{secretKey}`); the key must carry one of those
/// two prefixes. The value never leaves Rust except when `get_secret` resolves
/// it internally for `mcp_connect` or the data-path commands.
///
/// # Errors
///
/// Returns a user-facing error when the key is invalid or the keychain
/// rejects the write.
#[tauri::command]
pub fn set_secret(key: String, value: String) -> Result<(), String> {
    validate_secret_key(&key)?;
    let value = value.trim();
    if value.is_empty() {
        return clear_secret_value(&key);
    }
    store_secret_value(&key, value)
}

/// Whether a secret is stored for the given key (the value never leaves Rust).
///
/// # Errors
///
/// Returns a user-facing error when the key is invalid.
#[tauri::command]
pub fn has_secret(key: String) -> Result<bool, String> {
    validate_secret_key(&key)?;
    Ok(read_secret_value(&key)?.is_some())
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
    read_secret_value(key).ok().flatten()
}

/// Reads the stored Phorma desktop sign-in token. `None` when signed out.
///
/// This is the ONE command that hands a stored secret back to the webview, and the
/// exception is deliberate rather than an erosion of the rule. Two things make it
/// different from a provider API key:
///
/// 1. **It is our credential for our own API, not the user's credential for a third
///    party.** An Anthropic or OpenAI key that leaks costs the user money at a
///    vendor we do not control and cannot revoke for them. This token addresses one
///    Phorma tenant, expires on its own, and can be invalidated wholesale by
///    rotating `PHORMA_AUTH_SECRET` on the worker.
/// 2. **The webview has to present it.** It is a bearer on `fetch` calls the studio
///    makes from the webview (`/api/me`, `/api/infer`, the billing routes). The only
///    design in which the webview never sees it is one where every one of those
///    calls is proxied through Rust, which is a much larger change than the
///    credential is worth at this stage.
///
/// So the keychain is doing at-rest protection here - OS-guarded storage instead of
/// `localStorage` or IndexedDB, surviving restarts - and NOT in-memory isolation.
///
/// Note the entry name is HARD-CODED. There is deliberately no generic
/// "read any secret" command: one that took a key would let the webview ask for
/// `mcp:*` and `conn:*` values, which is exactly what `get_secret` staying
/// `pub(crate)` prevents.
///
/// # Errors
///
/// Returns a user-facing error when the keychain cannot be read. A missing entry is
/// `Ok(None)`, not an error - being signed out is a normal state.
#[tauri::command]
pub fn phorma_auth_token() -> Result<Option<String>, String> {
    read_secret_value(DEVICE_TOKEN_KEY)
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
        let key = read_secret_value(&provider)?
            .ok_or_else(|| format!("No API key configured for {provider}. Add one in Settings."))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Entry base used by the keychain-backed tests. Inside the accepted `conn:`
    /// namespace and named for a connection id no operator would create, so a
    /// test run can never touch a real connection secret.
    fn test_base(secret_key: &str) -> String {
        connection_secret_name("conn-rust-unit-test", secret_key)
    }

    /// Whether this machine exposes a usable credential store, probed under the
    /// very entry the caller is about to use: that keeps two tests running in
    /// parallel off each other's entries, and clears anything an interrupted run
    /// left behind. Headless build agents often have no credential store, and a
    /// driver test must not fail for that reason, so the keychain-backed tests
    /// skip when the probe fails.
    fn keychain_ready(base: &str) -> bool {
        match store_secret_value(base, "probe-value") {
            Ok(()) => clear_secret_value(base).is_ok(),
            Err(_) => false,
        }
    }

    #[test]
    fn accepts_mcp_connection_and_phorma_auth_prefixes() {
        assert!(validate_secret_key("mcp:node-1:API_TOKEN").is_ok());
        assert!(validate_secret_key("conn:conn-crm:apiKey").is_ok());
        assert!(validate_secret_key(DEVICE_TOKEN_KEY).is_ok());
    }

    /// The entry `phorma_auth_token` reads must be inside the validated namespace.
    /// If these ever disagree, storing the token from the studio would be refused
    /// while reading it silently returned `None` - a sign-in that appears to work
    /// and never persists.
    #[test]
    fn the_device_token_entry_is_inside_the_phorma_auth_namespace() {
        assert!(DEVICE_TOKEN_KEY.starts_with(PHORMA_AUTH_PREFIX));
        assert!(validate_secret_key(DEVICE_TOKEN_KEY).is_ok());
    }

    #[test]
    fn rejects_any_other_prefix_naming_every_accepted_one() {
        for key in [
            "",
            "anthropic",
            "conn",
            "mcp",
            "CONN:x:y",
            " conn:x:y",
            "other:x",
            // Near-misses on the new namespace, which must not open it up.
            "phorma-auth",
            "phorma_auth:device-token",
            "PHORMA-AUTH:device-token",
        ] {
            let error = validate_secret_key(key).expect_err("key must be rejected");
            assert!(error.contains("mcp:"), "message names the mcp prefix: {error}");
            assert!(error.contains("conn:"), "message names the conn prefix: {error}");
            assert!(
                error.contains("phorma-auth:"),
                "message names the phorma-auth prefix: {error}"
            );
        }
    }

    #[test]
    fn connection_secret_name_matches_the_engine_entry_shape() {
        let name = connection_secret_name("conn-crm", "apiKey");
        assert_eq!(name, "conn:conn-crm:apiKey");
        assert!(validate_secret_key(&name).is_ok());
    }

    /// Requirement 3.9: a key outside the two accepted prefixes is rejected
    /// before the keychain is touched at all, so no entry appears for it.
    #[test]
    fn a_rejected_key_creates_no_keychain_entry() {
        if !keychain_ready(&test_base("rejection")) {
            eprintln!("skipped: no usable OS keychain in this environment");
            return;
        }
        let key = "other:rust-unit-test:value";
        assert!(set_secret(key.to_owned(), "a-value-long-enough".to_owned()).is_err());
        assert!(
            matches!(
                keyring_entry(key).expect("entry").get_password(),
                Err(keyring::Error::NoEntry)
            ),
            "a rejected key must leave no entry behind"
        );
    }

    /// Requirement 3.1: a value longer than one entry is split into chunks of at
    /// most `MAX_SECRET_CHARS` characters that a read reassembles into the
    /// identical value, and replacing it leaves no orphaned chunk.
    #[test]
    fn a_long_secret_round_trips_through_the_chunked_keychain_path() {
        let base = test_base("dsn");
        if !keychain_ready(&base) {
            eprintln!("skipped: no usable OS keychain in this environment");
            return;
        }

        // Four entries' worth, with a multi-byte character in every repetition so
        // a byte-wise split would come back corrupt rather than identical.
        let long = "aé9-".repeat(MAX_SECRET_CHARS);
        assert_eq!(long.chars().count(), MAX_SECRET_CHARS * 4);

        store_secret_value(&base, &long).expect("long value stored");
        assert_eq!(
            keyring_entry(&base).expect("entry").get_password().ok(),
            Some(format!("{CHUNK_MANIFEST_PREFIX}4")),
            "the primary entry holds the chunk manifest, not the value"
        );
        assert_eq!(
            read_secret_value(&base).expect("read back").as_deref(),
            Some(long.as_str()),
            "the reassembled value is identical to the stored one"
        );

        // A shorter replacement collapses back to a single entry and clears the
        // chunks the previous value spilled into.
        store_secret_value(&base, "single-entry-value").expect("short value stored");
        assert_eq!(
            read_secret_value(&base).expect("read back").as_deref(),
            Some("single-entry-value")
        );
        for index in 0..4 {
            assert!(
                matches!(
                    keyring_entry(&chunk_entry_name(&base, index))
                        .expect("entry")
                        .get_password(),
                    Err(keyring::Error::NoEntry)
                ),
                "chunk {index} must not survive the replacement"
            );
        }

        clear_secret_value(&base).expect("cleared");
        assert!(read_secret_value(&base).expect("read back").is_none());
    }

    /// The data path's only door to a connection secret: same chunked storage,
    /// same namespace check, `None` for a key that was never stored.
    #[test]
    fn read_connection_secret_reads_the_chunked_entry_and_reports_absence() {
        if !keychain_ready(&test_base("password")) {
            eprintln!("skipped: no usable OS keychain in this environment");
            return;
        }
        let long = "x".repeat(MAX_SECRET_CHARS + 7);
        store_secret_value(&test_base("password"), &long).expect("stored");

        assert_eq!(
            read_connection_secret("conn-rust-unit-test", "password").expect("read"),
            Some(long)
        );
        assert_eq!(
            read_connection_secret("conn-rust-unit-test", "never-stored").expect("read"),
            None
        );

        clear_secret_value(&test_base("password")).expect("cleared");
    }
}
