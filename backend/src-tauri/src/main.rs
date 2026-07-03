// Prevents an additional console window on Windows in release builds. DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Desktop entry point.
///
/// Intentionally minimal: the actual application wiring lives in the library
/// crate (`phorma_agent_studio_lib`) so it can be shared across desktop and
/// mobile targets.
fn main() {
    phorma_agent_studio_lib::run();
}
