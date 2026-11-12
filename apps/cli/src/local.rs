//! Local-store selection shared by `kb mcp`, `kb model`, `kb sealed` and
//! `kb providers` (L-16/L-17): `--root`, else the config file's `root`.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use kb_local::Store;

use crate::config::Config;

/// `--root` shared by the local subcommands.
#[derive(Debug, Clone, clap::Args)]
pub struct RootArg {
    /// Local store directory (created on first use by `kb mcp` and by
    /// commands that change it). Default: `root` from the config file
    /// (`kb config set-root <path>`).
    #[arg(long, global = true, value_name = "PATH")]
    pub root: Option<PathBuf>,
}

impl RootArg {
    /// The selected store root, if any.
    pub fn resolve(&self, config: &Config) -> Option<PathBuf> {
        self.root.clone().or_else(|| config.root.clone())
    }
    /// The selected store root, or an error that says how to select one.
    pub fn require(&self, config: &Config) -> Result<PathBuf> {
        self.resolve(config).ok_or_else(|| {
            anyhow::anyhow!(
                "no local store selected; pass `--root <path>` or run `kb config set-root <path>`"
            )
        })
    }
}

/// Open an existing store, never creating one (read-only commands).
pub fn open_existing(root: &Path) -> Result<Store> {
    Store::open_existing(root).with_context(|| format!("opening store `{}`", root.display()))
}

/// Open a store for a command that changes it, creating it if absent.
pub fn open_or_create(root: &Path) -> Result<Store> {
    Store::open(root).with_context(|| format!("opening or creating store `{}`", root.display()))
}

/// Shared clap parser for a human-readable knowledge base ID error.
pub fn parse_kb_id(value: &str) -> Result<kb_client::types::KbId, String> {
    kb_client::types::KbId::parse(value.trim())
        .map_err(|_| format!("`{value}` is not a knowledge base ID"))
}
