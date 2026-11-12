//! Binary entry point.
//!
//! Responsibilities, in order:
//!   1. Parse arguments (clap).
//!   2. Initialize logging.
//!   3. Dispatch to the chosen subcommand.
//!   4. Map any error to a process exit code and a clean stderr message.
//!
//! Keep this file small. Real work belongs in `src/commands/`.

use clap::Parser;

use kb::cli::{Cli, Command};
use kb::exit::ExitCode;
use kb::{commands, exit, logging, output};

fn main() {
    // The shared per-user embedding worker, started on demand by
    // `kb mcp` (never by hand); it exits by itself when idle.
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(kb_local::embed_service::WORKER_ARG))
    {
        std::process::exit(
            if kb_local::qwen::run_native_worker(std::env::args_os().skip(2)).is_ok() {
                0
            } else {
                1
            },
        );
    }
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new("--kb-native-credential-worker"))
    {
        std::process::exit(kb_local::credentials::credential_worker_exit());
    }
    let cli = Cli::parse();
    logging::init(cli.log_format, cli.verbose, cli.quiet);

    let code = match run(&cli) {
        Ok(()) => ExitCode::Success,
        Err(err) if exit::is_broken_pipe(&err) => ExitCode::Success,
        Err(err) => {
            // Identifiers in error messages are wrapped in `backticks`, never
            // 'single quotes' — see AGENTS.md.
            let _ = output::diagnostic(format!("error: {}", exit::message_for(&err)));
            exit::code_for(&err)
        }
    };

    // MCP has already flushed or timed out through its bounded writer. A
    // blocked Tokio OS write still owns stdout; taking that lock can hang exit.
    if !matches!(&cli.command, Command::Mcp(_)) {
        let _ = output::flush_stdout();
    }
    std::process::exit(code as i32);
}

/// Dispatch to the selected subcommand. Returning `Result` here keeps `main`
/// free of branching and lets every command use `?`.
fn run(cli: &Cli) -> anyhow::Result<()> {
    match &cli.command {
        Command::Mcp(args) => commands::mcp::run(args),
        Command::Sealed(args) => commands::sealed::run(args),
        Command::Model(args) => commands::model::run(args),
        Command::Principals(args) => commands::principals::run(args),
        Command::Providers(args) => commands::providers::run(args),
        Command::Login(args) => commands::login::run(args),
        Command::Logout(args) => commands::logout::run(args),
        Command::Export(args) => commands::export::run(args),
        Command::Config(args) => commands::config::run(args),
        Command::Completions(args) => commands::completions::run(args),
    }
}
