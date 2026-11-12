//! Command-line interface definition.
//!
//! All argument parsing lives here (clap derive). Each subcommand's *logic*
//! lives in its own file under `src/commands/` — this file only declares the
//! shape of the CLI. Keeping parsing and logic separate keeps both readable and
//! makes commands easy to test in isolation.

use clap::{Parser, Subcommand, ValueEnum};

/// Top-level CLI. The `about` text is shown in `--help`.
#[derive(Debug, Parser)]
#[command(
    name = "kb",
    version,
    about = "Knowledge-base CLI and local or remote MCP server",
    // Let every subcommand report the same package version.
    propagate_version = true
)]
pub struct Cli {
    /// How to format log output. `text` is human-friendly; `json` is for
    /// machines (pipe into `jq`, ship to a log collector, etc.).
    #[arg(long, value_enum, default_value_t = LogFormat::Text, global = true)]
    pub log_format: LogFormat,

    /// Increase log verbosity (-v = debug, -vv = trace). Overridden by the
    /// `KB_LOG` / `RUST_LOG` env var if set.
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    pub verbose: u8,

    /// Silence all logs except errors.
    #[arg(short, long, global = true, conflicts_with = "verbose")]
    pub quiet: bool,

    #[command(subcommand)]
    pub command: Command,
}

/// Log output format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum LogFormat {
    /// Human-readable, colored when attached to a terminal.
    Text,
    /// One JSON object per line.
    Json,
}

/// The subcommands. Add new ones here, then implement them in `src/commands/`.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Serve the local or remote knowledge-base data plane over bounded stdio.
    Mcp(crate::commands::mcp::Args),
    /// Enroll, approve and revoke local sealed records (human control).
    Sealed(crate::commands::sealed::Args),
    /// Manage optional local CPU built-in embedding models.
    Model(crate::commands::model::Args),
    /// Create, list and remove local principals for `kb mcp --principal`.
    Principals(crate::commands::principals::Args),
    /// Manage local immutable providers and OS-keystore credentials.
    Providers(crate::commands::providers::Args),
    /// Approve a device login or import a private token.
    Login(crate::commands::login::Args),
    /// Revoke this server's PAT and clear its local credential.
    Logout(crate::commands::logout::Args),
    /// Download, verify and acknowledge a remote knowledge-base ZIP.
    Export(crate::commands::export::Args),
    /// Inspect the configuration file and resolved paths.
    Config(crate::commands::config::Args),

    /// Generate shell completion scripts.
    Completions(crate::commands::completions::Args),
}
