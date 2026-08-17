//! Bundled deploy runtime.
//!
//! A BYO deploy runs `wrangler` (Cloudflare) or `phorma-aws` (AWS) with the
//! working directory set to a package that holds the runtime source. Those
//! packages ship INSIDE the installer as Tauri resources, so a production install
//! can deploy without a checkout of the Phorma repository - which is what the
//! operator otherwise has to supply by hand.
//!
//! `prepare_deploy_workspace` copies the bundled tree into the app data folder and
//! reports whether the workspace's npm dependencies are already installed for THIS
//! app version. The frontend runs `npm install` when they are not, then stamps the
//! version - so an app update automatically invalidates a stale install.
//!
//! Layout, which is load-bearing rather than cosmetic:
//!
//! ```text
//! <app data>/deploy/engine/          both packages declare `@phorma/engine` as
//! <app data>/deploy/cloud/           `file:../engine` and resolve it through
//! <app data>/deploy/cloud-aws/       `../engine/src/index.ts`
//! ```
//!
//! `cloud-aws`'s CDK app derives its Docker build context by walking four
//! segments up from `src/infra/stack.ts`, which lands on `deploy/` - exactly the
//! parent that `cloud-aws/Dockerfile` COPYs `cloud-aws/` and `engine/` from.

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::Manager;

/// Deploy targets the installer carries. An allow-list, not a free path.
const DEPLOY_TARGETS: [&str; 2] = ["cloud", "cloud-aws"];

/// Written by the frontend after a successful install, read here.
const VERSION_STAMP: &str = ".phorma-runtime-version";

/// Directories that belong to the workspace, never to the bundle. Copying over
/// them would fight npm and the CDK.
const WORKSPACE_OWNED: [&str; 3] = ["node_modules", "cdk.out", "dist"];

/// A materialized deploy workspace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployWorkspace {
    /// Absolute path the deploy CLI runs in.
    pub path: String,
    /// App version the bundle came from.
    pub version: String,
    /// Whether `npm install` has already run for this version.
    pub dependencies_ready: bool,
}

/// Copies the bundled deploy runtime for `target` into the app data folder.
///
/// Safe to call repeatedly: source files are replaced, and anything npm or the
/// CDK owns is left alone.
///
/// # Errors
///
/// Returns a user-facing error when the target is not a known one, when this
/// build carries no bundle for it, or when the copy fails.
#[tauri::command]
pub fn prepare_deploy_workspace(
    app: tauri::AppHandle,
    target: String,
) -> Result<DeployWorkspace, String> {
    if !DEPLOY_TARGETS.contains(&target.as_str()) {
        return Err(format!("'{target}' is not a deploy target."));
    }

    let bundled = app
        .path()
        .resolve("deploy", BaseDirectory::Resource)
        .map_err(|error| format!("Could not locate the bundled deploy runtime: {error}"))?;
    if !bundled.join(&target).is_dir() {
        return Err(format!(
            "This build does not carry the {target} deploy runtime (looked in '{}').",
            bundled.display()
        ));
    }

    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate the app data folder: {error}"))?
        .join("deploy");

    copy_tree(&bundled.join("engine"), &root.join("engine"))?;
    copy_tree(&bundled.join(&target), &root.join(&target))?;

    let workspace = root.join(&target);
    let version = app.package_info().version.to_string();
    let stamped = fs::read_to_string(workspace.join(VERSION_STAMP))
        .map(|value| value.trim() == version)
        .unwrap_or(false);

    Ok(DeployWorkspace {
        path: workspace.to_string_lossy().into_owned(),
        version,
        dependencies_ready: stamped && workspace.join("node_modules").is_dir(),
    })
}

/// Recursively copies `from` into `to`, replacing files and never deleting
/// anything the workspace owns.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| {
        format!("Could not create folder '{}': {error}", to.display())
    })?;

    let entries = fs::read_dir(from)
        .map_err(|error| format!("Could not read folder '{}': {error}", from.display()))?;

    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Could not read folder '{}': {error}", from.display()))?;
        let name = entry.file_name();
        if WORKSPACE_OWNED.iter().any(|owned| *owned == name) {
            continue;
        }

        let source = entry.path();
        let destination = to.join(&name);
        if source.is_dir() {
            copy_tree(&source, &destination)?;
        } else {
            // Resources inside a signed app bundle can be read-only, and so can a
            // previous copy of them, so replace rather than overwrite in place.
            let _ = fs::remove_file(&destination);
            fs::copy(&source, &destination)
                .map_err(|error| format!("Could not copy '{}': {error}", source.display()))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A unique scratch directory, so tests never share state.
    fn scratch(label: &str) -> std::path::PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("phorma-deploy-{label}-{id}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, content).expect("write");
    }

    #[test]
    fn copies_nested_files_and_preserves_structure() {
        let root = scratch("nested");
        let from = root.join("bundle");
        let to = root.join("workspace");
        write(&from.join("package.json"), "{}");
        write(&from.join("src/index.ts"), "export {};");
        write(&from.join("src/infra/stack.ts"), "// stack");

        copy_tree(&from, &to).expect("copy");

        assert_eq!(fs::read_to_string(to.join("package.json")).unwrap(), "{}");
        assert_eq!(fs::read_to_string(to.join("src/index.ts")).unwrap(), "export {};");
        assert!(to.join("src/infra/stack.ts").is_file());
    }

    #[test]
    fn leaves_workspace_owned_directories_alone() {
        let root = scratch("owned");
        let from = root.join("bundle");
        let to = root.join("workspace");
        write(&from.join("package.json"), "{}");
        // A bundle should never carry these, but if one ever did, installed
        // dependencies and synth output must still survive a re-prepare.
        write(&from.join("node_modules/marker.txt"), "from bundle");
        write(&to.join("node_modules/installed.txt"), "installed");
        write(&to.join("cdk.out/manifest.json"), "{}");

        copy_tree(&from, &to).expect("copy");

        assert!(to.join("node_modules/installed.txt").is_file());
        assert!(!to.join("node_modules/marker.txt").exists());
        assert!(to.join("cdk.out/manifest.json").is_file());
    }

    #[test]
    fn replaces_a_read_only_previous_copy() {
        let root = scratch("readonly");
        let from = root.join("bundle");
        let to = root.join("workspace");
        write(&from.join("cdk.json"), "new");
        write(&to.join("cdk.json"), "old");

        let stale = to.join("cdk.json");
        let mut permissions = fs::metadata(&stale).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&stale, permissions).unwrap();

        copy_tree(&from, &to).expect("copy over a read-only file");

        assert_eq!(fs::read_to_string(&stale).unwrap(), "new");
    }
}
