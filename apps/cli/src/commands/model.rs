//! Human local-owner model controls; no credentials and no bundled weights.
//!
//! Weights live in one per-user cache shared by every store; a store
//! only records which built-in it has enabled. `list`, `status`, `verify` and
//! `remove` never create a store.
use crate::{config::Config, local::RootArg, output};
use anyhow::Result;
use kb_local::{
    Store,
    model_download::{CachedFile, Verification},
    qwen::{ModelState, available_memory, descriptor, options},
};
use serde::Serialize;
use std::io::IsTerminal;
use std::path::PathBuf;

#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(flatten)]
    root: RootArg,
    /// Emit JSON instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Sub,
}

fn model_help() -> String {
    format!(
        "Built-in model ID: {}",
        kb_local::qwen::model_ids().join(", ")
    )
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// List every model x context tier with its memory estimate, whether it
    /// is downloaded, and the recommendation for this machine.
    List,
    /// Show the model cache, what is downloaded, the store's enabled model
    /// and whether the shared embedding worker is running.
    Status,
    /// Download a pinned, checksum-verified model into the shared cache
    /// without enabling it.
    Download {
        #[arg(default_value_t = kb_local::qwen::default_model(), help = model_help())]
        model: String,
    },
    /// Download (if needed) and enable one built-in for the store; attach
    /// knowledge bases with `kb providers attach --provider builtin`.
    Enable {
        #[arg(default_value_t = kb_local::qwen::default_model(), help = model_help())]
        model: String,
        /// Context tokens per chunk: 1024, 2048, 4096 or 8192.
        #[arg(long, default_value_t = kb_local::qwen::default_context())]
        context: u32,
        /// Enable a configuration whose memory estimate is above 70% of
        /// available memory.
        #[arg(long)]
        acknowledge_memory_warning: bool,
    },
    /// Disable the store's built-in model. The cached file is kept.
    Disable,
    /// Re-check the size and SHA-256 of cached model files.
    Verify {
        /// Only this model (default: every built-in).
        #[arg(help = model_help())]
        model: Option<String>,
    },
    /// Delete `kb`'s own copy of one model (stores that enabled it search by
    /// keyword until it is downloaded again; a `models_dir` is never touched).
    Remove {
        #[arg(help = model_help())]
        model: String,
        /// Skip the confirmation (required without a terminal).
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListRow {
    #[serde(flatten)]
    option: kb_local::qwen::ModelOption,
    downloaded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedModel {
    model_id: String,
    file: PathBuf,
    size_bytes: u64,
    cached: CachedFile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    models_dir: PathBuf,
    models: Vec<CachedModel>,
    store: Option<PathBuf>,
    /// The store's built-in state (`None` without a selected store).
    state: Option<ModelState>,
    worker: Option<kb_local::embed_service::WorkerInfo>,
    /// A worker is alive even when it did not answer (`worker` is null):
    /// never reported as "not running" without proof.
    worker_alive: bool,
    /// R3-L7: why no worker could be started from here (null when one can).
    worker_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Downloaded {
    model_id: String,
    path: PathBuf,
    size_bytes: u64,
    sha256: String,
    verified: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Verified {
    model_id: String,
    file: PathBuf,
    result: Verification,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Removed {
    model_id: String,
    /// Every file deleted (R3-L9: the actual paths).
    files: Vec<PathBuf>,
    /// Model files left in place, each with why.
    kept: Vec<KeptFile>,
    removed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeptFile {
    path: PathBuf,
    reason: &'static str,
}

/// Interactive confirmation for `kb model remove` without `--yes`: type the
/// model ID. Without a terminal, `--yes` is required.
fn confirm_removal(model_id: &str) -> Result<bool> {
    use anyhow::Context;
    use std::io::{BufRead, Read};
    if !std::io::stdin().is_terminal() {
        anyhow::bail!(
            "removing `{model_id}` needs confirmation: pass `--yes` (stores that enabled it search by keyword until it is downloaded again)"
        );
    }
    output::diagnostic(format!(
        "Remove `{model_id}`? Stores that enabled it search by keyword until it is downloaded again. Type `{model_id}` to confirm:"
    ))?;
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .take(1024)
        .read_line(&mut line)
        .context("reading the confirmation")?;
    Ok(line.trim() == model_id)
}

/// Review #1: `kb` never writes to a configured `models_dir` (it only reads
/// it); a download always lands in the private cache, and the user is told
/// so when a different `models_dir` is configured (stderr, so `--json`
/// stays parseable).
fn note_unused_models_dir(
    cache: &kb_local::model_download::ModelCache,
    path: &std::path::Path,
) -> Result<()> {
    let canonical = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    if canonical(cache.dir()) != canonical(cache.private_dir()) {
        output::diagnostic(format!(
            "`kb` only reads models_dir `{}`; the model is in the private cache at {}",
            cache.dir().display(),
            path.display()
        ))?;
    }
    Ok(())
}

fn mib(bytes: u64) -> u64 {
    bytes.div_ceil(1048576)
}

/// Match configure's admission before a potentially large network download.
/// Configure still checks again with fresh availability after the download.
fn preflight_enable(
    model: &str,
    context: u32,
    acknowledge_memory_warning: bool,
    budget: Option<u64>,
) -> Result<(), kb_local::StoreError> {
    let m = descriptor(model)?;
    let bytes = m.estimate_bytes(context)?;
    let row = options(budget)?
        .into_iter()
        .find(|row| row.model_id == model && row.context_tokens == context)
        .ok_or_else(|| kb_local::qwen::unsupported(model, Some(context)))?;
    if !matches!(row.level, "ok" | "warn") || (row.level == "warn" && !acknowledge_memory_warning) {
        return Err(kb_local::StoreError::InvalidArgument(format!(
            "memory budget {}: estimated {} MiB for `{}` at {} tokens{}",
            match row.level {
                "warn" => "warning requires `--acknowledge-memory-warning`",
                "block" => "blocks this configuration",
                _ => "is unknown",
            },
            bytes / 1048576,
            model,
            context,
            budget.map_or(String::new(), |b| format!(
                ", {} MiB available",
                b / 1048576
            )),
        )));
    }
    Ok(())
}

/// Bounded stderr progress for long downloads (L-18).
fn progress(model: &str) -> impl FnMut(u64, u64) {
    let tty = std::io::stderr().is_terminal();
    let mut last = std::time::Instant::now();
    let mut shown = None;
    let model = model.to_owned();
    move |done, total| {
        let percent = done.saturating_mul(100) / total.max(1);
        let due = last.elapsed() >= std::time::Duration::from_secs(if tty { 1 } else { 10 });
        if shown != Some(percent) && (due || done == total || done == 0) {
            shown = Some(percent);
            last = std::time::Instant::now();
            let _ = output::diagnostic(format!(
                "downloading `{model}`: {} / {} MiB ({percent}%)",
                mib(done),
                mib(total)
            ));
        }
    }
}

pub fn run(a: &Args) -> Result<()> {
    let config = Config::load()?;
    let host = crate::paths::model_host(&config)?;
    let cache = host.cache();
    let root = a.root.resolve(&config);
    match &a.command {
        Sub::List => {
            let rows = options(available_memory())?
                .into_iter()
                .map(|option| {
                    let downloaded = descriptor(&option.model_id)
                        .and_then(|m| cache.cached(&m))
                        .is_ok_and(|c| c == CachedFile::Present);
                    ListRow { option, downloaded }
                })
                .collect::<Vec<_>>();
            if a.json {
                output::json(&rows)?;
            } else {
                for r in rows {
                    let o = &r.option;
                    output::line(format!(
                        "{:<28} {:>2}K  ~{:>5} MiB  memory {:<7}{}{}",
                        o.model_id,
                        o.context_tokens / 1024,
                        mib(o.estimated_bytes),
                        o.level,
                        if r.downloaded { "  downloaded" } else { "" },
                        if o.recommended { "  recommended" } else { "" }
                    ))?;
                }
                output::line(format!(
                    "available memory: {}",
                    available_memory().map_or("unknown".into(), |n| format!("{} MiB", mib(n)))
                ))?;
            }
        }
        Sub::Status => {
            // A configured root that was never created is just "no store".
            let store = match &root {
                Some(root) => match Store::open_existing(root) {
                    Ok(store) => Some(store),
                    Err(e) if e.protocol_code() == kb_client::ErrorCode::NotFound => None,
                    Err(e) => return Err(e.into()),
                },
                None => None,
            };
            let mut models = Vec::new();
            for id in kb_local::qwen::model_ids() {
                let m = descriptor(&id)?;
                // The file actually inspected (a private copy when present).
                let (cached, file) = cache.cached_file(&m)?;
                models.push(CachedModel {
                    file,
                    size_bytes: m.size_bytes,
                    cached,
                    model_id: id,
                });
            }
            let status = Status {
                models_dir: cache.dir().to_path_buf(),
                models,
                state: store.as_ref().map(Store::model_state).transpose()?,
                store: store.as_ref().map(|s| s.paths().root().to_path_buf()),
                worker: host.status(),
                worker_alive: host.worker_alive(),
                worker_error: None,
            };
            let mut status = status;
            if status.worker.is_none() && !status.worker_alive {
                status.worker_error = host.startability().err().map(|e| e.to_string());
            }
            if a.json {
                output::json(&status)?;
            } else {
                output::line(format!("model cache: {}", status.models_dir.display()))?;
                for m in &status.models {
                    output::line(format!(
                        "  {:<28} {}",
                        m.model_id,
                        match m.cached {
                            CachedFile::Present =>
                                format!("downloaded ({} MiB)", mib(m.size_bytes)),
                            CachedFile::Missing => "not downloaded".into(),
                            CachedFile::Mismatch =>
                                "unexpected file (run `kb model verify`)".into(),
                        }
                    ))?;
                }
                match (&status.store, &status.state) {
                    (Some(store), Some(state)) => output::line(format!(
                        "store {}: {}",
                        store.display(),
                        if state.enabled {
                            format!(
                                "enabled `{}` with {} context tokens",
                                state.model_id, state.context_tokens
                            )
                        } else {
                            "no built-in model enabled (`kb model enable`)".into()
                        }
                    ))?,
                    _ => match &root {
                        Some(root) => {
                            output::line(format!("store {}: not created yet", root.display()))?
                        }
                        None => output::line(
                            "store: none selected (pass `--root` or run `kb config set-root`)",
                        )?,
                    },
                }
                output::line(match &status.worker {
                    Some(w) => format!(
                        "embedding worker: running (pid {}{})",
                        w.pid,
                        w.loaded
                            .as_deref()
                            .map_or(String::new(), |m| format!(", `{m}` loaded"))
                    ),
                    None if status.worker_alive => {
                        "embedding worker: running but not responding".into()
                    }
                    None => match &status.worker_error {
                        Some(why) => format!(
                            "embedding worker: cannot start: {why} (searches fall back to keyword search)"
                        ),
                        None => "embedding worker: not running (starts on demand)".into(),
                    },
                })?;
            }
        }
        Sub::Download { model } => {
            let m = descriptor(model)?;
            let path = crate::runtime()?.block_on(cache.download(&m, &mut progress(model)))?;
            note_unused_models_dir(cache, &path)?;
            let reply = Downloaded {
                model_id: m.model_id.clone(),
                path,
                size_bytes: m.size_bytes,
                sha256: m.sha256.clone(),
                verified: true,
            };
            if a.json {
                output::json(&reply)?;
            } else {
                output::line(format!(
                    "downloaded `{}` to {} ({} MiB, SHA-256 verified)",
                    reply.model_id,
                    reply.path.display(),
                    mib(reply.size_bytes)
                ))?;
            }
        }
        Sub::Enable {
            model,
            context,
            acknowledge_memory_warning,
        } => {
            let m = descriptor(model)?;
            preflight_enable(
                model,
                *context,
                *acknowledge_memory_warning,
                available_memory(),
            )?;
            let s = crate::local::open_or_create(&a.root.require(&config)?)?;
            let owner = s.owner();
            let path = crate::runtime()?.block_on(cache.download(&m, &mut progress(model)))?;
            note_unused_models_dir(cache, &path)?;
            s.model_configure(
                &owner,
                &host,
                model,
                *context,
                *acknowledge_memory_warning,
                available_memory(),
            )?;
            let state = s.model_state()?;
            if a.json {
                output::json(&state)?;
            } else {
                output::line(format!(
                    "enabled `{}` with {} context tokens",
                    state.model_id, state.context_tokens
                ))?;
                output::line(
                    "attach a knowledge base with `kb providers attach --kb <KB_ID> --provider builtin`",
                )?;
            }
        }
        Sub::Disable => {
            let s = crate::local::open_existing(&a.root.require(&config)?)?;
            s.model_disable(&s.owner())?;
            let state = s.model_state()?;
            // Free the shared worker's copy now and confirm it (other stores
            // that use the model reload it on their next request).
            host.unload(&state.model_id).map_err(|e| {
                anyhow::anyhow!(
                    "`{}` is disabled for this store, but {e}; run `kb model disable` again to confirm the release",
                    state.model_id
                )
            })?;
            if a.json {
                output::json(&state)?;
            } else {
                output::line(format!(
                    "disabled `{}`; the cached file is kept (`kb model remove` deletes it)",
                    state.model_id
                ))?;
            }
        }
        Sub::Verify { model } => {
            let ids = match model {
                Some(m) => vec![descriptor(m)?.model_id],
                None => kb_local::qwen::model_ids(),
            };
            let mut rows = Vec::new();
            for id in ids {
                let m = descriptor(&id)?;
                let (result, file) = cache.verify_file(&m)?;
                rows.push(Verified {
                    file,
                    result,
                    model_id: id,
                });
            }
            if a.json {
                output::json(&rows)?;
            } else {
                for r in &rows {
                    output::line(format!(
                        "{:<28} {}",
                        r.model_id,
                        match r.result {
                            Verification::Verified => "ok (size and SHA-256 match)".to_owned(),
                            Verification::Missing => "not downloaded".to_owned(),
                            Verification::Mismatch => format!(
                                "MISMATCH: {} fails its size/SHA-256 check; run `kb model remove {} --yes`",
                                r.file.display(),
                                r.model_id
                            ),
                        }
                    ))?;
                }
            }
            if rows.iter().any(|r| r.result == Verification::Mismatch) {
                anyhow::bail!("a cached model file failed verification");
            }
        }
        Sub::Remove { model, yes } => {
            let m = descriptor(model)?;
            // Like the server's Remove: no store blocks it; stores that have
            // it enabled search by keyword (EMBEDDING_PROFILE_UNAVAILABLE)
            // until it is downloaded again, then hybrid with the same index.
            if !yes && !confirm_removal(&m.model_id)? {
                anyhow::bail!("`{}` was not removed", m.model_id);
            }
            // Deletes only `kb`'s own copy in its private cache, after the
            // worker confirmed it released the model (else DEADLINE_EXCEEDED).
            let removal = host.remove_model_report(&m)?;
            let reply = Removed {
                removed: !removal.removed.is_empty(),
                files: removal.removed,
                kept: removal
                    .kept
                    .into_iter()
                    .map(|k| KeptFile {
                        path: k.path,
                        reason: k.reason.why(),
                    })
                    .collect(),
                model_id: m.model_id,
            };
            if a.json {
                output::json(&reply)?;
            } else {
                for file in &reply.files {
                    output::line(format!("removed {}", file.display()))?;
                }
                for kept in &reply.kept {
                    output::line(format!(
                        "kept {}: {}; delete it yourself if nothing needs it",
                        kept.path.display(),
                        kept.reason
                    ))?;
                }
                if reply.files.is_empty() && reply.kept.is_empty() {
                    output::line(format!("`{}` was not downloaded", reply.model_id))?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enable_preflight_rejects_the_same_memory_budgets_as_configure_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("store")).unwrap();
        let host = kb_local::qwen::ModelHost::new(
            dir.path().join("unused-worker"),
            dir.path().join("runtime"),
            dir.path().join("models"),
            std::time::Duration::from_secs(60),
        )
        .unwrap();
        let model = kb_local::qwen::default_model();
        let context = kb_local::qwen::default_context();
        let bytes = descriptor(&model).unwrap().estimate_bytes(context).unwrap();
        let warning_budget = bytes * 5 / 4;
        for (budget, ack, reason) in [
            (None, false, "is unknown"),
            (None, true, "is unknown"),
            (Some(0), true, "is unknown"),
            (Some(bytes), false, "blocks this configuration"),
            (Some(bytes), true, "blocks this configuration"),
            (Some(warning_budget), false, "warning requires"),
        ] {
            let error = preflight_enable(&model, context, ack, budget).unwrap_err();
            assert!(error.to_string().contains(reason), "{error}");
            let final_error = store
                .model_configure(&store.owner(), &host, &model, context, ack, budget)
                .unwrap_err();
            assert_eq!(error.to_string(), final_error.to_string());
        }
        assert!(!host.cache().dir().exists(), "no weights downloaded");
        assert!(!store.model_state().unwrap().enabled);
        assert!(preflight_enable(&model, context, true, Some(warning_budget)).is_ok());
        assert!(preflight_enable(&model, context, false, Some(bytes * 2)).is_ok());
    }

    #[test]
    fn enable_preflight_preserves_model_and_context_errors() {
        let model = kb_local::qwen::default_model();
        let invalid_model = preflight_enable("unsupported", 1024, true, None).unwrap_err();
        assert_eq!(
            invalid_model.to_string(),
            descriptor("unsupported").unwrap_err().to_string()
        );
        let invalid_context = preflight_enable(&model, 1, true, None).unwrap_err();
        assert_eq!(
            invalid_context.to_string(),
            descriptor(&model)
                .unwrap()
                .estimate_bytes(1)
                .unwrap_err()
                .to_string()
        );
    }
}
