//! Remote ZIP export: private temporary bytes -> verify -> durable save -> ack.

use std::{path::PathBuf, time::Duration};

use anyhow::{Context, Result};
use kb_client::export::download_export;
use kb_client::types::{ExportKind, ExportPrepareInput, IdempotencyKey, KbId, Sha};
use kb_client::{CallControl, ClientOptions, Credential, McpClient};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use tempfile::NamedTempFile;

use crate::{
    auth::{self, ServerArgs},
    config::Config,
    output,
    state::CredentialStore,
};

#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(flatten)]
    server: ServerArgs,
    /// Knowledge-base ID to export with the stored PAT.
    #[arg(long)]
    kb: KbId,
    /// Immutable revision (defaults to the current main revision).
    #[arg(long)]
    rev: Option<Sha>,
    /// ZIP contents: whole knowledge-base or assets only.
    #[arg(long, value_enum, default_value_t = Kind::Whole)]
    kind: Kind,
    /// New destination file; existing files are never overwritten.
    #[arg(long)]
    output: PathBuf,
    /// Reuse this key to recover an interrupted prepare within its lifetime.
    #[arg(long)]
    idempotency_key: Option<IdempotencyKey>,
    /// Emit saved-file metadata and acknowledgement status as JSON.
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
    descriptor: &'a kb_client::types::ExportPrepareOutput,
    acknowledged: bool,
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
    if args.output.symlink_metadata().is_ok() {
        anyhow::bail!("destination already exists");
    }
    let parent = args
        .output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let mut temp = NamedTempFile::new_in(parent).context("creating private export file")?;
    let idempotency_key = match &args.idempotency_key {
        Some(key) => key.clone(),
        None => {
            let mut bytes = [0u8; 16];
            SystemRandom::new()
                .fill(&mut bytes)
                .map_err(|_| anyhow::anyhow!("could not generate export key"))?;
            let key: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            IdempotencyKey::parse(&key)?
        }
    };
    let input = ExportPrepareInput {
        kb_id: args.kb.clone(),
        rev: args.rev.clone(),
        kind: match args.kind {
            Kind::Whole => ExportKind::Whole,
            Kind::Assets => ExportKind::Assets,
        },
        idempotency_key,
    };
    crate::runtime()?.block_on(async {
        let ctl = CallControl::timeout(Duration::from_secs(15 * 60));
        let verified = download_export(&client, &input, temp.as_file_mut(), &ctl).await?;
        temp.as_file()
            .sync_all()
            .context("syncing verified export")?;
        temp.persist_noclobber(&args.output)
            .map_err(|error| error.error)
            .context("saving verified export")?;
        crate::config::sync_parent_dir(&args.output)?;
        let acknowledged = verified.complete(&ctl).await.is_ok();
        if !acknowledged {
            output::diagnostic(
                "export saved; acknowledgement failed; server grace cleanup will release the slot",
            )?;
        }
        if args.json {
            output::json(&SavedExport {
                path: &args.output,
                descriptor: verified.descriptor(),
                acknowledged,
            })
        } else {
            output::line(format!("saved export to `{}`", args.output.display()))
        }
    })
}
