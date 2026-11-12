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

use std::path::PathBuf;

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

/// The directory for application-managed data (databases, caches, state).
pub fn data_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("KB_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let base = dirs::data_dir().context("could not determine the user data directory")?;
    Ok(base.join(APP))
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
    Ok(base.join(APP))
}

/// The per-user model cache shared by every store. `models_dir` in the
/// config file overrides it (absolute paths only).
pub fn models_dir(config: &crate::config::Config) -> Result<PathBuf> {
    match &config.models_dir {
        Some(dir) => Ok(dir.clone()),
        None => Ok(cache_dir()?.join("models")),
    }
}

/// Owner-only directory for the shared embedding worker's socket and
/// locks: `$XDG_RUNTIME_DIR/kb` where the platform has one, else
/// `<cache>/run`.
pub fn runtime_dir() -> Result<PathBuf> {
    match dirs::runtime_dir() {
        Some(dir) if dir.is_absolute() => Ok(dir.join(APP)),
        _ => Ok(cache_dir()?.join("run")),
    }
}

/// The shared embedding worker host for this user and configuration.
pub fn model_host(config: &crate::config::Config) -> Result<kb_local::qwen::ModelHost> {
    let exe = std::env::current_exe().context("locating the `kb` executable")?;
    // A configured `models_dir` may be shared with another program: files
    // not safe to load in place are copied, verified, into the owner-only
    // default cache (the same directory when nothing is configured).
    Ok(kb_local::qwen::ModelHost::new(
        exe,
        runtime_dir()?,
        models_dir(config)?,
        std::time::Duration::from_secs(900),
    )?
    .with_private_cache(cache_dir()?.join("models"))?)
}
