//! Ollama detection, installation, and model pulling.
//!
//! Powers the first-run onboarding wizard. All long-running operations stream
//! progress back to the frontend as `ollama-event` events (same emit pattern
//! as `llm.rs`), keyed by `request_id` and cancellable via a watch channel.
//!
//! The daemon is never bundled — the user explicitly consents to each step
//! (install Ollama, pull a model). Nothing is downloaded without a button
//! click that states the size.

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// Event channel carrying Ollama progress to the frontend.
const OLLAMA_EVENT: &str = "ollama-event";

/// Default Ollama daemon base URL.
const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";

/// Active pull cancellation flags, keyed by request id.
static ACTIVE_PULLS: Mutex<Option<HashMap<String, tokio::sync::watch::Sender<bool>>>> =
    Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OllamaEvent {
    request_id: String,
    /// `progress`, `done`, or `error`.
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

/// Status response from `ollama_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub models: Vec<String>,
}

/// One entry in the Ollama `/api/tags` response.
#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<TagsModel>,
}

#[derive(Deserialize)]
struct TagsModel {
    name: String,
}

/// One line of the `/api/pull` NDJSON stream.
#[derive(Deserialize)]
struct PullProgress {
    #[serde(default)]
    status: String,
    #[serde(default)]
    completed: Option<u64>,
    #[serde(default)]
    total: Option<u64>,
}

/// Checks whether the Ollama daemon is running and lists installed models.
///
/// # Errors
///
/// Returns a user-facing error only on unexpected HTTP failures (not on
/// "daemon not running", which is reported as `running: false`).
#[tauri::command]
pub async fn ollama_status(base_url: Option<String>) -> Result<OllamaStatus, String> {
    let base = base_url.unwrap_or_else(|| DEFAULT_OLLAMA_URL.to_string());
    let client = reqwest::Client::new();

    // Check if the daemon responds.
    let version = match client
        .get(format!("{base}/api/version"))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            #[derive(Deserialize)]
            struct VersionResp {
                version: String,
            }
            resp.json::<VersionResp>()
                .await
                .ok()
                .map(|v| v.version)
        }
        _ => None,
    };

    let running = version.is_some();
    let mut models = Vec::new();

    if running {
        if let Ok(resp) = client
            .get(format!("{base}/api/tags"))
            .send()
            .await
        {
            if let Ok(tags) = resp.json::<TagsResponse>().await {
                models = tags.models.into_iter().map(|m| m.name).collect();
            }
        }
    }

    Ok(OllamaStatus {
        running,
        version,
        models,
    })
}

/// Downloads and installs Ollama, streaming progress events.
///
/// - **Windows**: downloads `OllamaSetup.exe` and runs it with `/S` (silent),
///   then polls `/api/version` until the daemon is up.
/// - **macOS**: downloads the `.zip` (Ollama's silent-install format) and
///   extracts it to `/Applications`; the daemon starts on next login. The
///   user is prompted to launch it.
/// - **Linux**: not auto-installed; the frontend shows the official curl
///   command for the user to run manually.
///
/// Emits `ollama-event` events with `kind: "progress"` (data = message),
/// `"done"`, or `"error"`.
///
/// # Errors
///
/// Returns a user-facing error when the download or install fails.
#[tauri::command]
pub async fn ollama_install(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<(), String> {
    let emit = |kind: &str, data: Option<String>| {
        let _ = app.emit(
            OLLAMA_EVENT,
            OllamaEvent {
                request_id: request_id.clone(),
                kind: kind.to_owned(),
                data,
            },
        );
    };

    emit("progress", Some("Downloading Ollama installer...".to_string()));

    let (url, installer_name) = if cfg!(target_os = "windows") {
        (
            "https://ollama.com/download/OllamaSetup.exe".to_string(),
            "OllamaSetup.exe".to_string(),
        )
    } else if cfg!(target_os = "macos") {
        (
            "https://ollama.com/download/Ollama-darwin.zip".to_string(),
            "Ollama.zip".to_string(),
        )
    } else {
        emit(
            "error",
            Some("Automatic install is not supported on Linux. Please install Ollama manually.".to_string()),
        );
        return Ok(());
    };

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download Ollama: {e}"))?;

    if !response.status().is_success() {
        emit("error", Some(format!("HTTP {} from ollama.com", response.status())));
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join(&installer_name);
    let mut file = std::fs::File::create(&installer_path)
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    let mut received: u64 = 0;
    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                emit("error", Some(format!("Download stream error: {e}")));
                return Err(format!("Download stream error: {e}"));
            }
        };
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|e| format!("Failed to write installer: {e}"))?;
        received += chunk.len() as u64;
        if let Some(t) = total {
            let pct = (received as f64 / t as f64 * 100.0) as u32;
            emit("progress", Some(format!("Downloading... {pct}%")));
        }
    }
    drop(file);

    emit("progress", Some("Installing Ollama...".to_string()));

    if cfg!(target_os = "windows") {
        // Silent install: OllamaSetup.exe /S
        let status = std::process::Command::new(&installer_path)
            .arg("/S")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("Failed to run installer: {e}"))?;

        if !status.success() {
            emit("error", Some("Installer exited with an error.".to_string()));
            return Err("Ollama installer failed.".to_string());
        }

        // Poll the daemon until it responds (it starts as a service).
        emit("progress", Some("Waiting for Ollama daemon...".to_string()));
        poll_daemon(&app, &request_id, 30).await?;

    } else if cfg!(target_os = "macos") {
        // Extract the zip to /Applications (Ollama.app).
        let status = std::process::Command::new("unzip")
            .arg("-o")
            .arg(&installer_path)
            .arg("-d")
            .arg("/Applications/")
            .status()
            .map_err(|e| format!("Failed to extract: {e}"))?;

        if !status.success() {
            emit("error", Some("Extraction failed.".to_string()));
            return Err("Failed to extract Ollama.zip.".to_string());
        }

        emit(
            "progress",
            Some("Ollama installed. Launching...".to_string()),
        );

        // Launch Ollama.app to start the daemon.
        let _ = std::process::Command::new("open")
            .arg("/Applications/Ollama.app")
            .spawn();

        poll_daemon(&app, &request_id, 30).await?;
    }

    // Clean up the temp installer.
    let _ = std::fs::remove_file(&installer_path);

    emit("done", None);
    Ok(())
}

/// Pulls a model from the Ollama registry, streaming NDJSON progress.
///
/// Emits `ollama-event` events with `kind: "progress"` (data = status line
/// or "completed/total" fraction), `"done"`, or `"error"`. Cancellable via
/// `ollama_cancel_pull`.
///
/// # Errors
///
/// Returns a user-facing error when the pull cannot be started. Errors after
/// streaming begins arrive as `kind: "error"` events.
#[tauri::command]
pub async fn ollama_pull(
    app: tauri::AppHandle,
    request_id: String,
    model: String,
    base_url: Option<String>,
) -> Result<(), String> {
    let base = base_url.unwrap_or_else(|| DEFAULT_OLLAMA_URL.to_string());
    let url = format!("{base}/api/pull");

    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut guard = ACTIVE_PULLS.lock().map_err(|_| "Pull registry poisoned.")?;
        guard
            .get_or_insert_with(HashMap::new)
            .insert(request_id.clone(), cancel_tx);
    }

    let emit = |kind: &str, data: Option<String>| {
        let _ = app.emit(
            OLLAMA_EVENT,
            OllamaEvent {
                request_id: request_id.clone(),
                kind: kind.to_owned(),
                data,
            },
        );
    };

    let client = reqwest::Client::new();
    let response = match client
        .post(&url)
        .json(&serde_json::json!({ "name": model }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            emit("error", Some(format!("Pull request failed: {e}")));
            remove_pull(&request_id);
            return Err(format!("Pull request failed: {e}"));
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        emit("error", Some(format!("HTTP {status}")));
        remove_pull(&request_id);
        return Err(format!("Pull failed: HTTP {status}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    loop {
        if *cancel_rx.borrow() {
            emit("progress", Some("Cancelled.".to_string()));
            emit("done", None);
            remove_pull(&request_id);
            return Ok(());
        }

        let chunk_result = match stream.next().await {
            Some(r) => r,
            None => {
                emit("done", None);
                remove_pull(&request_id);
                return Ok(());
            }
        };

        let bytes = match chunk_result {
            Ok(b) => b,
            Err(e) => {
                emit("error", Some(format!("Stream error: {e}")));
                remove_pull(&request_id);
                return Err(format!("Stream error: {e}"));
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].to_string();
            buffer = buffer[pos + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            if let Ok(progress) = serde_json::from_str::<PullProgress>(&line) {
                let msg = if let (Some(completed), Some(total)) =
                    (progress.completed, progress.total)
                {
                    if total > 0 {
                        let pct = (completed as f64 / total as f64 * 100.0) as u32;
                        format!("{} {pct}%", progress.status)
                    } else {
                        progress.status
                    }
                } else {
                    progress.status
                };
                emit("progress", Some(msg));
            }
        }
    }
}

/// Cancels an in-progress model pull.
///
/// # Errors
///
/// Returns a user-facing error when the pull id is not found.
#[tauri::command]
pub fn ollama_cancel_pull(request_id: String) -> Result<(), String> {
    let mut guard = ACTIVE_PULLS.lock().map_err(|_| "Pull registry poisoned.")?;
    if let Some(map) = guard.as_mut() {
        if let Some(tx) = map.remove(&request_id) {
            let _ = tx.send(true);
        }
    }
    Ok(())
}

/// Returns the available disk space (bytes) on the home/temp drive.
///
/// Used by the wizard to warn before pulling a large model.
///
/// # Errors
///
/// Returns a user-facing error when the disk space cannot be determined.
#[tauri::command]
pub fn disk_free() -> Result<u64, String> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let temp = std::env::temp_dir();

    // Find the disk whose mount point contains the temp dir.
    let best = disks
        .list()
        .iter()
        .filter(|d| temp.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().components().count());

    let available = best
        .or_else(|| disks.list().first())
        .map(|d| d.available_space())
        .unwrap_or(0);

    if available == 0 {
        Err("Could not determine free disk space.".to_string())
    } else {
        Ok(available)
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn remove_pull(request_id: &str) {
    if let Ok(mut guard) = ACTIVE_PULLS.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(request_id);
        }
    }
}

/// Polls the Ollama daemon until it responds or the timeout is reached.
async fn poll_daemon(
    app: &tauri::AppHandle,
    request_id: &str,
    max_seconds: u64,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut elapsed = 0u64;
    while elapsed < max_seconds {
        if let Ok(resp) = client
            .get(format!("{DEFAULT_OLLAMA_URL}/api/version"))
            .send()
            .await
        {
            if resp.status().is_success() {
                let _ = app.emit(
                    OLLAMA_EVENT,
                    OllamaEvent {
                        request_id: request_id.to_string(),
                        kind: "progress".to_string(),
                        data: Some("Ollama daemon is running.".to_string()),
                    },
                );
                return Ok(());
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        elapsed += 2;
    }
    Err("Ollama daemon did not start within the timeout.".to_string())
}
