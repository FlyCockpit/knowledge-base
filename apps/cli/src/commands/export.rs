//! Remote ZIP export: start a background job -> bounded wait -> private
//! temporary bytes -> verify -> durable save -> ack.

use std::{path::PathBuf, time::Duration};

use anyhow::{Context, Result};
use kb_client::export::{
    ExportError, cancel_export, download_export, export_status, start_export, wait_for_export,
};
use kb_client::types::{
    ExportJob, ExportKind, ExportPrepareInput, IdempotencyKey, KbId, Sha, Uuid,
};
use kb_client::{
    CallControl, ClientError, ClientOptions, Credential, ErrorCode, KbError, McpClient,
};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use tempfile::NamedTempFile;

use crate::{
    auth::{self, ServerArgs},
    config::Config,
    exit::{CodedError, ExitCode},
    output,
    state::CredentialStore,
};

/// The server builds an export for at most 30 minutes; wait a little longer.
const DEFAULT_WAIT_SECS: u64 = 35 * 60;
/// Bound for one start/status/cancel exchange (with its retries).
const CALL_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// Bound for downloading a ready artifact (256 MiB of bounded frames).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Export a remote knowledge base as a ZIP.
///
/// The server prepares the ZIP in the background. By default this command
/// starts the export, waits for it (polling its status with a bounded
/// backoff; progress goes to stderr), downloads and verifies it, saves it to
/// `--output` and releases it on the server. Use `--no-wait` to only start it,
/// and `--transfer <ID>` to check, cancel or download a started export.
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(flatten)]
    server: ServerArgs,
    /// Knowledge-base ID to export with the stored PAT.
    #[arg(long)]
    kb: KbId,
    /// Immutable revision (defaults to the current main revision).
    #[arg(long, conflicts_with = "transfer")]
    rev: Option<Sha>,
    /// ZIP contents: whole knowledge-base or assets only.
    #[arg(long, value_enum, default_value_t = Kind::Whole, conflicts_with = "transfer")]
    kind: Kind,
    /// New destination file; existing files are never overwritten. Required
    /// unless `--no-wait`, `--status` or `--cancel` is given.
    #[arg(long, required_unless_present_any = ["no_wait", "status", "cancel"])]
    output: Option<PathBuf>,
    /// Reuse this key to get back the same export job (a repeated start never
    /// builds a second ZIP).
    #[arg(long, conflicts_with = "transfer")]
    idempotency_key: Option<IdempotencyKey>,
    /// Start the export and print its job (transfer ID and state) without
    /// waiting; resume later with `--transfer <ID> --output <FILE>`.
    #[arg(long, conflicts_with_all = ["transfer", "output"])]
    no_wait: bool,
    /// Use an export that was already started instead of starting a new one:
    /// wait for it and download it to `--output`.
    #[arg(long, value_name = "ID")]
    transfer: Option<Uuid>,
    /// With `--transfer`: print the job's state and progress, then exit.
    #[arg(long, requires = "transfer", conflicts_with_all = ["cancel", "output"])]
    status: bool,
    /// With `--transfer`: cancel the export (or discard it once ready) and
    /// print its final state.
    #[arg(long, requires = "transfer", conflicts_with = "output")]
    cancel: bool,
    /// Give up waiting after this many seconds; the export keeps going on the
    /// server and can be resumed with `--transfer`.
    #[arg(long, value_name = "SECS", default_value_t = DEFAULT_WAIT_SECS,
          value_parser = clap::value_parser!(u64).range(1..=24 * 3600))]
    wait_timeout: u64,
    /// Emit the job or saved-file metadata and acknowledgement status as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum Kind {
    Whole,
    Assets,
}

#[derive(Serialize)]
struct SavedExport<'a> {
    path: &'a std::path::Path,
    descriptor: &'a ExportJob,
    acknowledged: bool,
}

fn new_key() -> Result<IdempotencyKey> {
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("could not generate export key"))?;
    let key: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(IdempotencyKey::parse(&key)?)
}

/// One line for a job: `<transferId> <state>` plus progress or the reason.
fn summary(job: &ExportJob) -> String {
    let state = serde_json::to_value(job.state)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    let mut line = format!("{} {state}", job.transfer_id.as_str());
    match (&job.error, job.progress.total_bytes) {
        (Some(error), _) => line.push_str(&format!(": {}", error.message)),
        (None, Some(total)) if job.state.is_running() => {
            line.push_str(&format!(" ({} of {total} bytes)", job.progress.done_bytes));
        }
        _ => {}
    }
    line
}

fn print_job(job: &ExportJob, json: bool) -> Result<()> {
    if json {
        output::json(job)
    } else {
        output::line(summary(job))
    }
}

/// An export error with its exit code: another user's or an unknown job is
/// not found (3); every other failure is a generic failure (1).
fn coded(error: ExportError) -> anyhow::Error {
    let not_found = matches!(
        &error,
        ExportError::Client(ClientError::Kb(KbError::Tool(tool)))
            if tool.code() == ErrorCode::NotFound
    );
    let error = anyhow::Error::new(error);
    if not_found {
        error.context(CodedError::new(ExitCode::NotFound))
    } else {
        error
    }
}

pub fn run(args: &Args) -> Result<()> {
    let config = Config::load()?;
    let resource = args.server.resolve(&config)?;
    let token = CredentialStore::new(crate::paths::credentials_dir()?)
        .load(&resource)?
        .ok_or_else(|| anyhow::anyhow!("no credential for this server; run `kb login`"))?;
    let credential = Credential::new(resource.clone(), token);
    let options = ClientOptions {
        name: "kb-cli".into(),
        ..ClientOptions::default()
    };
    let client = if let Some(proxy) = config.proxy.as_deref() {
        auth::validate_proxy(proxy)?;
        McpClient::new_with_proxy(
            resource,
            credential,
            options,
            reqwest::Proxy::all(proxy).map_err(|_| anyhow::anyhow!("invalid configured proxy"))?,
        )?
    } else {
        McpClient::new(resource, credential, options)?
    };
    if let Some(output) = &args.output
        && output.symlink_metadata().is_ok()
    {
        anyhow::bail!("destination already exists");
    }
    crate::runtime()?.block_on(async {
        let call = || CallControl::timeout(CALL_TIMEOUT);
        let job = match &args.transfer {
            Some(id) if args.cancel => {
                let job = cancel_export(&client, &args.kb, id, &call())
                    .await
                    .map_err(coded)?;
                return print_job(&job, args.json);
            }
            Some(id) => {
                let job = export_status(&client, &args.kb, id, &call())
                    .await
                    .map_err(coded)?;
                if args.status {
                    return print_job(&job, args.json);
                }
                job
            }
            None => {
                let input = ExportPrepareInput {
                    kb_id: args.kb.clone(),
                    rev: args.rev.clone(),
                    kind: match args.kind {
                        Kind::Whole => ExportKind::Whole,
                        Kind::Assets => ExportKind::Assets,
                    },
                    idempotency_key: match &args.idempotency_key {
                        Some(key) => key.clone(),
                        None => new_key()?,
                    },
                };
                let job = start_export(&client, &input, &call())
                    .await
                    .map_err(coded)?;
                if args.no_wait {
                    return print_job(&job, args.json);
                }
                job
            }
        };
        let Some(output_path) = args.output.as_deref() else {
            anyhow::bail!("`--output` is required to download an export");
        };
        let id = job.transfer_id.clone();
        if job.state.is_running() {
            output::diagnostic(format!(
                "export `{}` started; waiting for the server to prepare it",
                id.as_str()
            ))?;
        }
        let wait = Duration::from_secs(args.wait_timeout);
        // The wait has its own bound; each status poll is bounded separately.
        let waiting = CallControl::timeout(wait + CALL_TIMEOUT);
        let mut last = None;
        let ready = wait_for_export(&client, &args.kb, job, wait, &waiting, |job| {
            let line = summary(job);
            if last.as_ref() != Some(&line) {
                let _ = output::diagnostic(&line);
                last = Some(line);
            }
        })
        .await
        .map_err(|error| match error {
            ExportError::StillRunning(_) => anyhow::Error::new(error).context(format!(
                "stopped waiting after {}s; the export continues on the server. Resume with `kb export --kb {} --transfer {} --output <FILE>`",
                args.wait_timeout,
                args.kb.as_str(),
                id.as_str()
            )),
            other => coded(other),
        })?;
        let parent = output_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        let mut temp = NamedTempFile::new_in(parent).context("creating private export file")?;
        let ctl = CallControl::timeout(DOWNLOAD_TIMEOUT);
        let verified = download_export(&client, &args.kb, &ready, temp.as_file_mut(), &ctl)
            .await
            .map_err(coded)?;
        temp.as_file()
            .sync_all()
            .context("syncing verified export")?;
        temp.persist_noclobber(output_path)
            .map_err(|error| error.error)
            .context("saving verified export")?;
        crate::config::sync_parent_dir(output_path)?;
        let acknowledged = verified.complete(&call()).await.is_ok();
        if !acknowledged {
            output::diagnostic(
                "export saved; acknowledgement failed; server grace cleanup will release the slot",
            )?;
        }
        if args.json {
            output::json(&SavedExport {
                path: output_path,
                descriptor: verified.descriptor(),
                acknowledged,
            })
        } else {
            output::line(format!("saved export to `{}`", output_path.display()))
        }
    })
}
