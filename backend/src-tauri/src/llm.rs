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
const KNOWN_PROVIDERS: [&str; 7] =
    ["anthropic", "openai", "gemini", "openrouter", "ollama", "bedrock", "lmstudio"];

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

fn validate_secret_key(key: &str) -> Result<(), String> {
    if key.starts_with(MCP_SECRET_PREFIX) {
        Ok(())
    } else {
        Err(format!("Secret key must start with '{MCP_SECRET_PREFIX}'."))
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
