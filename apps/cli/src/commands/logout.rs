//! `kb logout`: revoke only the presented PAT, then remove matching local state.
use crate::{
    auth::{Remote, Revocation, ServerArgs},
    config::Config,
    output,
    state::CredentialStore,
};
use anyhow::Result;
use serde::Serialize;

#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(flatten)]
    server: ServerArgs,
    /// Delete only the local credential; the remote token remains active.
    #[arg(long)]
    local: bool,
    /// Emit JSON status, never a token.
    #[arg(long)]
    json: bool,
}
pub fn run(args: &Args) -> Result<()> {
    let config = Config::load()?;
    let resource = args.server.resolve(&config)?;
    let store = CredentialStore::new(crate::paths::credentials_dir()?);
    let Some(token) = store.load(&resource)? else {
        if args.json {
            return output::json(&LogoutOutput {
                resource: resource.as_string(),
                removed: false,
                remote_revoked: false,
                already_revoked: false,
            });
        }
        return output::line("no local credential for this server");
    };
    let revocation = if args.local {
        output::diagnostic("local-only logout: remote token remains active")?;
        None
    } else {
        let remote = Remote::new(resource.clone(), config.proxy.as_deref())?;
        Some(crate::runtime()?.block_on(remote.revoke(&token))?)
    };
    let already_revoked = revocation == Some(Revocation::AlreadyRevoked);
    let removed = store.remove_if_matches(&resource, &token)?;
    if !removed {
        output::diagnostic("credential changed during logout; current local credential retained")?;
    }
    if args.json {
        output::json(&LogoutOutput {
            resource: resource.as_string(),
            removed,
            remote_revoked: !args.local,
            already_revoked,
        })
    } else if already_revoked && removed {
        output::line("credential was already revoked on the server; removed locally")
    } else {
        output::line("logged out")
    }
}
#[derive(Serialize)]
struct LogoutOutput {
    resource: String,
    removed: bool,
    remote_revoked: bool,
    already_revoked: bool,
}
