//! Subcommand implementations.
//!
//! One module per subcommand. Each module exposes:
//!   - an `Args` struct (clap-derived) describing its flags/positionals, and
//!   - a `run(args: &Args) -> anyhow::Result<()>` function with the logic.
//!
//! `src/cli.rs` wires the `Args` into the top-level `Command` enum; `main.rs`
//! calls `run`.

pub mod completions;
pub mod config;
pub mod export;
pub mod login;
pub mod logout;

pub mod model;
pub mod principals;
pub mod providers;

pub mod sealed;

pub mod mcp;
