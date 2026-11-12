//! L-23: owner-only control of local CONFIG principals, the identities a
//! `kb mcp --principal <id>` session acts as. A `propose` principal's writes
//! become pull requests the owner reviews (`knowledge_pull_requests_review`).
use crate::{config::Config, local::RootArg, output};
use anyhow::Result;
use kb_client::types::{KbId, Permission};
use serde::Serialize;

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

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum Access {
    /// Search and read.
    Read,
    /// Read, and propose changes as pull requests (never writes `main`).
    Propose,
    /// Read, propose and write `main` directly.
    Write,
    /// Read and review (merge or close) pull requests.
    Review,
    /// Everything, including index and KB settings (not deletion).
    Manage,
}
impl Access {
    fn permission(self) -> Permission {
        match self {
            Access::Read => Permission::Read,
            Access::Propose => Permission::Propose,
            Access::Write => Permission::Write,
            Access::Review => Permission::Review,
            Access::Manage => Permission::Manage,
        }
    }
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Create a principal with one access level on the given knowledge bases.
    Create {
        /// A knowledge base ID (repeatable).
        #[arg(long = "kb", value_name = "KB_ID", required = true, value_parser = crate::local::parse_kb_id)]
        kbs: Vec<KbId>,
        #[arg(long, value_enum)]
        access: Access,
    },
    /// List principals (one page; pass the last ID as `--after` for the next).
    List {
        #[arg(long)]
        after: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Remove a principal; its sessions lose access on their next call.
    Remove { id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    kb_id: KbId,
    permissions: Vec<Permission>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Principal {
    principal_id: String,
    grants: Vec<Grant>,
}
#[derive(Serialize)]
struct Removed {
    removed: bool,
}

pub fn run(args: &Args) -> Result<()> {
    let config = Config::load()?;
    let root = args.root.require(&config)?;
    let store = crate::local::open_existing(&root)?;
    let owner = store.owner();
    match &args.command {
        Sub::Create { kbs, access } => {
            let p = store.create_config_principal(&owner, kbs, access.permission())?;
            if args.json {
                output::json(&Principal {
                    principal_id: p.id().to_owned(),
                    grants: kbs
                        .iter()
                        .map(|kb| Grant {
                            kb_id: kb.clone(),
                            permissions: kb_local::Bits::from_permissions(&[access.permission()])
                                .expand()
                                .permissions(),
                        })
                        .collect(),
                })?;
            } else {
                output::line(p.id())?;
                output::diagnostic(format!("serve it with `kb mcp --principal {}`", p.id()))?;
            }
        }
        Sub::List { after, limit } => {
            let rows = store
                .config_principals(&owner, after.as_deref(), *limit)?
                .into_iter()
                .map(|(principal_id, grants)| Principal {
                    principal_id,
                    grants: grants
                        .into_iter()
                        .map(|(kb_id, permissions)| Grant { kb_id, permissions })
                        .collect(),
                })
                .collect::<Vec<_>>();
            if args.json {
                output::json(&rows)?;
            } else if rows.is_empty() {
                output::line("no principals; create one with `kb principals create`")?;
            } else {
                for p in rows {
                    let grants = p
                        .grants
                        .iter()
                        .map(|g| {
                            format!(
                                "{} ({})",
                                g.kb_id,
                                g.permissions
                                    .iter()
                                    .map(|x| format!("{x:?}").to_lowercase())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("; ");
                    output::line(format!("{} {grants}", p.principal_id))?;
                }
            }
        }
        Sub::Remove { id } => {
            let removed = store.remove_config_principal(&owner, id)?;
            if args.json {
                output::json(&Removed { removed })?;
            } else if removed {
                output::line(format!("removed `{id}`"))?;
            }
            if !removed {
                return Err(anyhow::anyhow!("no principal `{id}`").context(
                    crate::exit::CodedError::new(crate::exit::ExitCode::NotFound),
                ));
            }
        }
    }
    Ok(())
}
