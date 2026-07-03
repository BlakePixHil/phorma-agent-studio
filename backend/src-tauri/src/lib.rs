//! Phorma Agent Studio core library.
//!
//! Hosts the Tauri application builder and the commands that are invokable from
//! the Angular front-end. Keeping the runnable surface in a library crate (with
//! `main.rs` as a thin shim) is the Tauri 2.0 convention and also lets the
//! mobile targets reuse the same entry point.

mod commands;
mod llm;
mod mcp;
mod process;

/// Builds and runs the Phorma Agent Studio desktop application.
///
/// This is the single entry point shared by the desktop binary (`main.rs`) and
/// any future mobile targets. It registers plugins and the command handlers
/// that the front-end can `invoke`.
///
/// # Panics
///
/// Panics only if the Tauri runtime fails to initialize, which is an
/// unrecoverable startup condition.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_workflow_file,
            commands::write_workflow_file,
            llm::set_provider_key,
            llm::has_provider_key,
            llm::set_secret,
            llm::has_secret,
            llm::llm_proxy_stream,
            llm::cancel_llm_stream,
            process::run_streamed_command,
            mcp::http_request,
            mcp::mcp_connect,
            mcp::mcp_call,
            mcp::mcp_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Phorma Agent Studio application");
}
