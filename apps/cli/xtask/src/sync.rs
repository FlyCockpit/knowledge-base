//! `cargo xtask sync-docs` — keep harness-specific instruction files in sync
//! with the canonical `AGENTS.md`.
//!
//! AGENTS.md is the single source of truth. Every other agent harness gets a
//! generated mirror with a "do not edit" banner. A CI job runs
//! `sync-docs --check` and fails the build if any mirror has drifted — so the
//! rule that "you only edit AGENTS.md" is enforced by the repo, not by trust.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::workspace_root;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Verify mirrors are up to date without writing. Exit non-zero on drift.
    #[arg(long)]
    check: bool,
}

/// The canonical source file.
const SOURCE: &str = "AGENTS.md";

/// Generated mirrors. Add a harness by appending a `(path, banner)` here.
/// Do not regenerate deleted agent-harness mirrors. Copilot reads the
/// repo-root instructions; this CLI directory only mirrors the harness
/// files that support nested scopes.
fn targets() -> Vec<(PathBuf, String)> {
    let banner = "<!-- GENERATED FILE — DO NOT EDIT.\n     Edit AGENTS.md, then run `cargo xtask sync-docs`. -->\n\n";
    vec![(PathBuf::from("CLAUDE.md"), banner.to_string())]
}

pub fn run(args: Args) -> Result<()> {
    run_in(&workspace_root(), args)
}

fn run_in(root: &Path, args: Args) -> Result<()> {
    let source_path = root.join(SOURCE);
    let source = fs::read_to_string(&source_path)
        .with_context(|| format!("reading `{}`", source_path.display()))?;

    let mut drifted = Vec::new();

    for (rel, banner) in targets() {
        let path = root.join(&rel);
        let expected = format!("{banner}{source}");

        if args.check {
            let current = fs::read_to_string(&path).unwrap_or_default();
            if current != expected {
                drifted.push(rel.display().to_string());
            }
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("creating `{}`", parent.display()))?;
            }
            fs::write(&path, &expected).with_context(|| format!("writing `{}`", path.display()))?;
            println!("wrote {}", rel.display());
        }
    }

    if args.check && !drifted.is_empty() {
        bail!(
            "agent docs are out of sync: {}\n  fix with: cargo xtask sync-docs",
            drifted.join(", ")
        );
    }
    if !args.check {
        println!("agent docs are in sync with {SOURCE}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn targets_only_include_supported_mirrors() {
        let names: Vec<PathBuf> = targets().into_iter().map(|(path, _)| path).collect();
        assert_eq!(names, vec![PathBuf::from("CLAUDE.md")]);
    }

    #[test]
    fn sync_docs_twice_is_idempotent_and_writes_only_listed_mirrors() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("kb-xtask-sync-{stamp}"));
        fs::create_dir_all(&dir).expect("temp dir");
        fs::write(dir.join("AGENTS.md"), "# kb CLI\n").expect("source");
        run_in(&dir, Args { check: false }).expect("first sync");
        let first = fs::read_to_string(dir.join("CLAUDE.md")).expect("first mirror");
        run_in(&dir, Args { check: false }).expect("second sync");
        let second = fs::read_to_string(dir.join("CLAUDE.md")).expect("second mirror");
        assert_eq!(first, second);
        let mut names: Vec<String> = fs::read_dir(&dir)
            .expect("list")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["AGENTS.md".to_string(), "CLAUDE.md".to_string()]
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
