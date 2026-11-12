//! `kb config` — inspect configuration and resolved paths.
//!
//! Subcommands:
//!   - `config path`  print the config file path (whether or not it exists)
//!   - `config show`  print the effective config (defaults + file) as TOML
//!   - `config init`  write a default config file if none exists

use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::Config;
use crate::output;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    // `global` only because this command has subcommands: it lets the flag
    // appear on either side (`config --json path` and `config path --json`).
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Sub,
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Print the path to the config file.
    Path,
    /// Print the effective configuration (defaults merged with the file).
    Show,
    /// Create a default config file if one does not already exist.
    Init,
    /// Set the default local store used when `--root` is not given
    /// (an absolute path; relative paths are resolved against the current
    /// directory now, never later).
    SetRoot { root: std::path::PathBuf },
    /// Set the per-user model cache directory (absolute path), e.g. another
    /// program's model directory that already holds the model files.
    SetModelsDir { dir: std::path::PathBuf },
    /// Set the default server origin (credentials stay in private state).
    SetServer {
        server: String,
        /// Permit plain HTTP for this loopback development server; the opt-in
        /// is remembered for this server only.
        #[arg(long)]
        allow_loopback_http: bool,
    },
}

fn absolute(path: &Path) -> Result<std::path::PathBuf> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("resolving the current directory")?
            .join(path)
    };
    // Lexically clean `.`/`..` without requiring the path to exist yet.
    let mut clean = std::path::PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other),
        }
    }
    Ok(clean)
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        Sub::SetRoot { root } => {
            let root = absolute(root)?;
            let config = Config::update(|config| config.root = Some(root.clone()))?;
            if args.json {
                output::json(&config.safe_for_output())?;
            } else {
                output::line(format!("root set to `{}`", root.display()))?;
            }
        }
        Sub::SetModelsDir { dir } => {
            let dir = absolute(dir)?;
            let config = Config::update(|config| config.models_dir = Some(dir.clone()))?;
            if args.json {
                output::json(&config.safe_for_output())?;
            } else {
                output::line(format!("models_dir set to `{}`", dir.display()))?;
            }
        }
        Sub::SetServer {
            server,
            allow_loopback_http,
        } => {
            let resource = crate::auth::ServerArgs {
                server: Some(server.clone()),
                allow_loopback_http: *allow_loopback_http,
            }
            .resolve(&Config::default())?;
            let config = Config::update(|config| {
                config.server = Some(resource.origin().to_owned());
                // Remember the plain-HTTP opt-in for exactly this origin, so
                // `login`, `mcp`, `logout` and `export` need no flag; setting
                // any other server (or omitting the flag) forgets it.
                config.loopback_http_opt_in = (*allow_loopback_http
                    && resource.origin().starts_with("http://"))
                .then(|| resource.origin().to_owned());
            })?;
            if args.json {
                output::json(&config.safe_for_output())?;
            } else {
                output::line(format!("server set to {}", resource.origin()))?;
            }
        }
        Sub::Path => {
            let path = crate::paths::config_file()?;
            tracing::debug!(path = %path.display(), "resolved config path");
            if args.json {
                output::json(&ConfigPath::new(&path))?;
            } else {
                output::line(path.display())?;
            }
        }
        Sub::Show => {
            // An invalid setting fails without echoing its value (it may hold
            // a credential); the error names the `set-*` command that fixes it.
            let config = Config::load()?;
            if args.json {
                output::json(&config)?;
            } else if config == Config::default() {
                output::line(format!(
                    "# no settings (defaults); `kb config init` writes a commented template to `{}`",
                    crate::paths::config_file()?.display()
                ))?;
            } else {
                output::text(toml::to_string_pretty(&config)?)?;
            }
        }
        Sub::Init => {
            let path = crate::paths::config_file()?;
            let created = Config::default()
                .save_new()
                .context("writing the default config file")?;

            if args.json {
                output::json(&ConfigInit::new(&path, created))?;
            } else if created {
                output::line(format!("wrote default config to `{}`", path.display()))?;
            } else {
                output::line(format!("config already exists at `{}`", path.display()))?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct ConfigPath {
    path: String,
}

impl ConfigPath {
    fn new(path: &Path) -> Self {
        Self {
            path: path.display().to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ConfigInit {
    path: String,
    created: bool,
}

impl ConfigInit {
    fn new(path: &Path, created: bool) -> Self {
        Self {
            path: path.display().to_string(),
            created,
        }
    }
}
