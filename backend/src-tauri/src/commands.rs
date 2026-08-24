//! Tauri commands exposed to the Phorma Agent Studio front-end.
//!
//! Commands are the typed bridge between the Angular UI and the Rust core. Each
//! function annotated with `#[tauri::command]` becomes invokable from the
//! front-end via `invoke('command_name', { ... })`.
//!
//! Phase 1 keeps this surface intentionally small: workflow documents are
//! portable JSON files, so the backend only needs to read and write them.
//! Later phases add the streaming LLM proxy, OS-keychain secret storage, and
//! process management for MCP servers and cloud deploys.

use std::{fs, path::PathBuf};

/// Reads a workflow document (`.phorma.json`) from disk.
///
/// # Errors
///
/// Returns a user-facing error string when the file does not exist or cannot
/// be read.
#[tauri::command]
pub fn read_workflow_file(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    fs::read_to_string(&path)
        .map_err(|error| format!("Could not read workflow '{}': {error}", path.display()))
}

/// Writes a workflow document (`.phorma.json`) to disk, creating parent
/// folders as needed.
///
/// # Errors
///
/// Returns a user-facing error string when the folders or file cannot be
/// written.
#[tauri::command]
pub fn write_workflow_file(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create folder '{}': {error}", parent.display()))?;
    }
    fs::write(&path, content)
        .map_err(|error| format!("Could not write workflow '{}': {error}", path.display()))
}

/// Reports a coarse operating system version string, for example
/// `Windows 11 Pro (24H2)` or `Darwin 14.5`.
///
/// Used by the anonymous telemetry rollup, so it must never carry a machine
/// name, a user name, or any other identifier: only the OS product and its
/// version. Infallible by construction - an unavailable lookup degrades to
/// `unknown` rather than an error, so the caller never has to branch.
#[tauri::command]
#[must_use]
pub fn os_version() -> String {
    let long = sysinfo::System::long_os_version()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(long) = long {
        return long;
    }

    let name = sysinfo::System::name()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let version = sysinfo::System::os_version()
        .or_else(sysinfo::System::kernel_version)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    match (name, version) {
        (Some(name), Some(version)) => format!("{name} {version}"),
        (Some(name), None) => name,
        (None, Some(version)) => version,
        (None, None) => "unknown".to_owned(),
    }
}
