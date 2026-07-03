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
