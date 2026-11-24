//! Filesystem locations.
//!
//! Resolves the per-user config/data directories in a cross-platform way
//! via the `dirs` crate:
//!
//!   | Dir    | Linux                     | macOS                              | Windows                       |
//!   |--------|---------------------------|------------------------------------|-------------------------------|
//!   | config | ~/.config/kb           | ~/Library/Application Support/kb | %APPDATA%\kb               |
//!   | data   | ~/.local/share/kb      | ~/Library/Application Support/kb | %APPDATA%\kb               |
//!
//! Any of these can be overridden with the `KB_CONFIG_DIR` / `KB_DATA_DIR`
//! environment variables — useful for tests and for users who want everything
//! in one place.
//!
//! The data, cache and runtime directories hold credentials, models and the
//! worker socket: they are resolved once here, through
//! [`kb_local::paths::resolve_entry_path`] (only root-controlled system
//! links such as macOS `/var` are followed), and every caller uses that
//! canonical path. The editable config directory is not resolved.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Application directory name.
const APP: &str = "kb";

/// The directory holding the user's editable configuration file.
pub fn config_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("KB_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = dirs::config_dir().context("could not determine the user config directory")?;
    Ok(base.join(APP))
}

/// The canonical spelling of an environment-derived directory.
fn resolve(dir: &Path, what: &str) -> Result<PathBuf> {
    kb_local::paths::resolve_entry_path(dir)
        .with_context(|| format!("resolving the {what} directory `{}`", dir.display()))
}

/// The directory for application-managed data (databases, caches, state).
pub fn data_dir() -> Result<PathBuf> {
    let dir = match std::env::var_os("KB_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => dirs::data_dir()
            .context("could not determine the user data directory")?
            .join(APP),
    };
    resolve(&dir, "data")
}

/// Full path to the config file (`config.toml` inside [`config_dir`]).
pub fn config_file() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

/// Private origin/resource-bound credentials, outside editable configuration.
pub fn credentials_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("credentials"))
}

/// Per-user cache directory (`kb` under the platform cache dir).
pub fn cache_dir() -> Result<PathBuf> {
    let base = dirs::cache_dir().context("could not determine the user cache directory")?;
    resolve(&base.join(APP), "cache")
}

/// The per-user model cache shared by every store, or `configured` (the
/// config file's `models_dir`, absolute paths only) when one is set.
pub fn models_dir(configured: Option<&Path>) -> Result<PathBuf> {
    match configured {
        Some(dir) => Ok(dir.to_path_buf()),
        None => Ok(cache_dir()?.join("models")),
    }
}

/// Owner-only directory for the shared embedding worker's socket and
/// locks: `$XDG_RUNTIME_DIR/kb` where the platform has one, else
/// `<cache>/run`.
pub fn runtime_dir() -> Result<PathBuf> {
    match dirs::runtime_dir() {
        Some(dir) if dir.is_absolute() => resolve(&dir.join(APP), "runtime"),
        _ => Ok(cache_dir()?.join("run")),
    }
}

/// The owner-only cache for verified private copies of model files that
/// are not safe to load in place.
fn private_models_dir() -> Result<PathBuf> {
    Ok(cache_dir()?.join("models"))
}

/// The per-user model cache the worker of [`model_host`] loads: the same
/// [`models_dir`] of `configured_models` and private cache.
pub fn model_cache(
    configured_models: Option<&Path>,
) -> Result<kb_local::model_download::ModelCache> {
    Ok(kb_local::model_download::ModelCache::with_private(
        models_dir(configured_models)?,
        private_models_dir()?,
    )?)
}

/// The shared embedding worker host for this user, reading models from
/// [`models_dir`] of `configured_models`.
pub fn model_host(configured_models: Option<&Path>) -> Result<kb_local::qwen::ModelHost> {
    let exe = std::env::current_exe().context("locating the `kb` executable")?;
    // A configured `models_dir` may be shared with another program: files
    // not safe to load in place are copied, verified, into the owner-only
    // default cache (the same directory when nothing is configured).
    Ok(kb_local::qwen::ModelHost::new(
        exe,
        runtime_dir()?,
        models_dir(configured_models)?,
        std::time::Duration::from_secs(900),
    )?
    .with_private_cache(private_models_dir()?)?)
}
