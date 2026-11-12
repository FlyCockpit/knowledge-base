//! `kb completions <shell>` — print a shell completion script to stdout.
//!
//! Usage examples:
//!   kb completions bash > /etc/bash_completion.d/kb
//!   kb completions zsh  > ~/.zfunc/_kb
//!   kb completions fish > ~/.config/fish/completions/kb.fish
//!
//! Generating from the live clap definition means completions never go stale.

use anyhow::Result;
use clap::CommandFactory;
use clap_complete::Shell;

use crate::cli::Cli;
use crate::output;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Shell to generate completions for.
    shell: Shell,
}

pub fn run(args: &Args) -> Result<()> {
    let mut cmd = Cli::command();
    let bin_name = cmd.get_name().to_string();
    let mut completions = Vec::new();
    clap_complete::generate(args.shell, &mut cmd, bin_name, &mut completions);
    output::bytes(&completions)?;
    Ok(())
}
