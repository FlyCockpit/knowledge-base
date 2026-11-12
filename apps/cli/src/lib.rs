//! Shared implementation for the `kb` binary.
//!
//! The binary entry point stays thin, while command definitions, config, exit
//! codes, logging, paths, and output helpers live here so they can be tested and
//! documented like normal Rust code.

pub mod auth;
pub mod cli;
pub mod commands;
pub mod config;
pub mod exit;
pub mod local;
pub mod logging;
pub mod output;
pub mod paths;
pub mod remote;
pub mod state;

/// The process's one async runtime, shared by every command and request
/// handler. It is never dropped: dropping a runtime waits for every blocking
/// task it spawned, which would let abandoned blocking work (a stalled system
/// resolver, a peer-stalled stdin read) hold a reply or the process exit.
/// Process exit ends whatever blocking work remains.
pub fn runtime() -> anyhow::Result<&'static tokio::runtime::Runtime> {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }
    let built = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| anyhow::anyhow!("could not initialize the async runtime"))?;
    Ok(RUNTIME.get_or_init(|| built))
}
