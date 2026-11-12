//! Helpers for writing command output.
//!
//! Command results go to stdout; logs and diagnostics go to stderr. Keeping the
//! stdout writes behind tiny helpers gives new commands one obvious pattern for
//! human-readable and machine-readable output.

use std::io::{self, Write};

use anyhow::{Context, Result};
use serde::Serialize;

/// Write a line of human-readable command output to stdout.
pub fn line(text: impl std::fmt::Display) -> Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{text}").context("writing to stdout")
}

/// Write human-readable command output to stdout without appending a newline.
pub fn text(text: impl std::fmt::Display) -> Result<()> {
    let mut out = io::stdout().lock();
    write!(out, "{text}").context("writing to stdout")
}

/// Write raw command output to stdout.
pub fn bytes(bytes: &[u8]) -> Result<()> {
    let mut out = io::stdout().lock();
    out.write_all(bytes).context("writing to stdout")
}

/// Serialize a typed value as one JSON object to stdout.
pub fn json<T: Serialize>(value: &T) -> Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, value).context("serializing JSON output")?;
    writeln!(out).context("writing to stdout")
}

/// Flush stdout before exiting the process explicitly.
pub fn flush_stdout() -> Result<()> {
    io::stdout().lock().flush().context("flushing stdout")
}

/// Write a diagnostic line to stderr.
pub fn diagnostic(text: impl std::fmt::Display) -> Result<()> {
    let mut err = io::stderr().lock();
    writeln!(err, "{text}").context("writing to stderr")
}
