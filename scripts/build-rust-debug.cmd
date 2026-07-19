@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
cargo build --manifest-path=backend/src-tauri/Cargo.toml