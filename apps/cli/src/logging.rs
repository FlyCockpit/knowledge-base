//! Logging setup (tracing).
//!
//! Filtering precedence (highest first):
//!   1. `KB_LOG` env var (e.g. `KB_LOG=kb=debug,warn`)
//!   2. `RUST_LOG` env var
//!   3. `-v` / `-vv` / `--quiet` flags
//!
//! Logs go to **stderr** so they never corrupt machine-readable stdout (e.g.
//! `--json` output piped into `jq`).

use std::io::{IsTerminal, Write};

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::MakeWriterExt;

use crate::cli::LogFormat;

/// Initialize the global tracing subscriber. Call exactly once, early in
/// `main`. Safe to call before argument validation.
pub fn init(format: LogFormat, verbose: u8, quiet: bool) {
    let filter = env_filter("KB_LOG")
        .or_else(|| env_filter("RUST_LOG"))
        .unwrap_or_else(|| EnvFilter::new(default_directive(verbose, quiet)));

    // Always write logs to stderr; keep stdout clean for command output.
    let writer = std::io::stderr.with_max_level(tracing::Level::TRACE);
    let ansi = std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none();

    match format {
        LogFormat::Text => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(writer)
            .with_ansi(ansi)
            .with_target(false)
            .init(),
        LogFormat::Json => tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .with_writer(writer)
            .with_ansi(ansi)
            .init(),
    }
}

fn env_filter(name: &str) -> Option<EnvFilter> {
    std::env::var_os(name)?;
    match EnvFilter::try_from_env(name) {
        Ok(filter) => Some(filter),
        Err(err) => {
            let _ = writeln!(
                std::io::stderr().lock(),
                "warning: ignoring invalid `{name}` filter: {err}"
            );
            None
        }
    }
}

/// Map the verbosity flags to an `EnvFilter` directive when no env var is set.
fn default_directive(verbose: u8, quiet: bool) -> String {
    if quiet {
        return "error".to_string();
    }
    match verbose {
        0 => "info",
        1 => "debug",
        _ => "trace",
    }
    .to_string()
}
