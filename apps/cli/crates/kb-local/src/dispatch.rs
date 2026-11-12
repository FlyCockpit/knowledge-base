//! Exhaustive common data-plane adapter. Schemas are checked before services
//! and after projection; services own live authority, confirmations and locks.
use crate::{
    LocalPrincipal, Store, StoreError, StorePaths,
    credentials::{Credentials, NativeCredentials},
    egress::{Dns, Http, NativeDns, NativeHttp, PinnedEgress},
    index::IndexEmbedder,
    qwen::ModelRuntime,
};
use kb_client::{
    ErrorCode, ToolName,
    stdio::{CallControl, tool_error},
    types::*,
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
pub struct DispatchIo<'a> {
    pub keys: &'a dyn Credentials,
    pub egress: &'a PinnedEgress<'a>,
    pub model: &'a ModelRuntime,
    /// A session's KB selection (`kb mcp --kb`): `knowledge_bases_list`
    /// pages over it. `None` lists every KB the principal can read.
    pub kbs: Option<&'a BTreeSet<String>>,
}
impl DispatchIo<'_> {
    fn embedder(&self) -> IndexEmbedder<'_> {
        IndexEmbedder::Routed {
            keys: self.keys,
            egress: self.egress,
            builtin: self.model,
        }
    }
}

/// The network a session's calls use: credential admission, DNS and HTTP.
pub struct SessionIo {
    pub keys: Box<dyn Credentials + Send + Sync>,
    pub dns: Box<dyn Dns + Send + Sync>,
    pub http: Box<dyn Http + Send + Sync>,
}
/// One `kb mcp` session's tool executor. Every call runs on the session's one
/// long-lived runtime, from the stdio loop's blocking worker. No call builds
/// or drops a runtime: dropping one waits for every blocking task it spawned,
/// so an abandoned blocking task (a stalled `getaddrinfo`) would hold the
/// reply past the call's own deadline.
pub struct Session {
    runtime: tokio::runtime::Handle,
    paths: StorePaths,
    store_uuid: Uuid,
    principal: LocalPrincipal,
    model: Arc<ModelRuntime>,
    io: SessionIo,
}
impl Session {
    /// `runtime` must stay driven (a thread inside its `block_on`) while
    /// calls run, as the stdio loop's own runtime is.
    pub fn new(
        runtime: tokio::runtime::Handle,
        store: &Store,
        principal: LocalPrincipal,
        model: Arc<ModelRuntime>,
        io: SessionIo,
    ) -> Self {
        Self {
            runtime,
            paths: store.paths().clone(),
            store_uuid: store.store_uuid().clone(),
            principal,
            model,
            io,
        }
    }
    pub fn model(&self) -> &ModelRuntime {
        &self.model
    }
    /// Run one admitted call to its reply. Call it off the runtime's own
    /// threads (the stdio loop runs handlers on its blocking pool).
    pub fn call(
        &self,
        name: ToolName,
        input: Value,
        control: CallControl,
        kbs: Option<&BTreeSet<String>>,
    ) -> Value {
        if control.is_cancelled() {
            return tool_error(ErrorCode::Cancelled, json!({}));
        }
        let s = match Store::reopen_controlled(&self.paths, &self.store_uuid, control.clone()) {
            Ok(s) => s,
            Err(e) => return tool_error(e.protocol_code(), json!({})),
        };
        s.attach_model_cache(self.model.host().cache().clone());
        let egress = PinnedEgress::new(self.io.dns.as_ref(), self.io.http.as_ref());
        self.runtime.block_on(dispatch_with_io(
            &s,
            &self.principal,
            name,
            input,
            &control,
            &DispatchIo {
                keys: self.io.keys.as_ref(),
                egress: &egress,
                model: &self.model,
                kbs,
            },
        ))
    }
}

fn failure(error: StoreError) -> Value {
    tool_error(error.protocol_code(), error.protocol_details())
}
pub async fn dispatch(
    s: &Store,
    p: &LocalPrincipal,
    name: ToolName,
    input: Value,
    c: &CallControl,
    host: &crate::qwen::ModelHost,
) -> Value {
    dispatch_observed(s, p, name, input, c, host, &|| {}).await
}
/// [`dispatch`] with a trusted test seam that runs after a tool refused and
/// before the refusal's live reauthorization.
#[doc(hidden)]
pub async fn dispatch_observed(
    s: &Store,
    p: &LocalPrincipal,
    name: ToolName,
    input: Value,
    c: &CallControl,
    host: &crate::qwen::ModelHost,
    before_refusal: &dyn Fn(),
) -> Value {
    let model = match ModelRuntime::new(s, host.clone()) {
        Ok(m) => m,
        Err(e) => return failure(e),
    };
    let keys = NativeCredentials::new(host.executable().into());
    let http = NativeHttp;
    let dns = NativeDns;
    let egress = PinnedEgress::new(&dns, &http);
    dispatch_with_io_observed(
        s,
        p,
        name,
        input,
        c,
        &DispatchIo {
            keys: &keys,
            egress: &egress,
            model: &model,
            kbs: None,
        },
        before_refusal,
    )
    .await
}
pub async fn dispatch_with_io(
    s: &Store,
    p: &LocalPrincipal,
    name: ToolName,
    input: Value,
    c: &CallControl,
    io: &DispatchIo<'_>,
) -> Value {
    dispatch_with_io_observed(s, p, name, input, c, io, &|| {}).await
}
async fn dispatch_with_io_observed(
    s: &Store,
    p: &LocalPrincipal,
    name: ToolName,
    input: Value,
    c: &CallControl,
    io: &DispatchIo<'_>,
    before_refusal: &dyn Fn(),
) -> Value {
    let input = match name.check_input(input.clone()) {
        Ok(v) => v,
        Err(error) => {
            return tool_error(
                ErrorCode::InvalidArgument,
                kb_client::error::invalid_input_details_value(&error, &input),
            );
        }
    };
    // The KB a refusal's details describe; reauthorized on the error path below.
    let refusal_kb = input
        .get("kbId")
        .and_then(Value::as_str)
        .and_then(|id| KbId::parse(id).ok())
        .filter(|_| {
            !matches!(
                name,
                ToolName::KnowledgeBasesDelete | ToolName::KnowledgeSealedResolve
            )
        });
    let _scope = crate::git_read::OperationDeadline::transport(c.clone());
    if let Err(e) = crate::git_read::OperationDeadline::check() {
        return failure(e);
    }
    macro_rules! call {
        ($marker:ty,$method:ident) => {{
            let i = kb_client::decode_input::<$marker>(input)
                .map_err(|_| StoreError::InvalidArgument("tool input".into()))?;
            serde_json::to_value(s.$method(p, i)?)
                .map_err(|_| StoreError::Internal("tool output".into()))?
        }};
    }
    let run = async {
        use ToolName::*;
        Ok::<Value, StoreError>(match name {
            KnowledgeBasesList => {
                let i = kb_client::decode_input::<BasesList>(input)
                    .map_err(|_| StoreError::InvalidArgument("tool input".into()))?;
                serde_json::to_value(s.bases_list_selected(p, i, io.kbs)?)
                    .map_err(|_| StoreError::Internal("tool output".into()))?
            }
            KnowledgeBasesGet => call!(BasesGet, bases_get),
            KnowledgeBasesCreate => call!(BasesCreate, bases_create),
            KnowledgeBasesUpdate => call!(BasesUpdate, bases_update),
            KnowledgeBasesDelete => call!(BasesDelete, bases_delete),
            KnowledgeDocumentsList => call!(DocumentsList, documents_list),
            KnowledgeDocumentsGet => call!(DocumentsGet, documents_get),
            KnowledgeChangesApply => call!(ChangesApply, changes_apply),
            KnowledgeDocumentsCreate => call!(DocumentsCreate, documents_create),
            KnowledgeDocumentsUpdate => call!(DocumentsUpdate, documents_update),
            KnowledgeDocumentsDelete => call!(DocumentsDelete, documents_delete),
            KnowledgeUploadBegin => call!(UploadBegin, upload_begin),
            KnowledgeUploadWrite => call!(UploadWrite, upload_write),
            KnowledgeUploadFinish => call!(UploadFinish, upload_finish),
            KnowledgeAssetsPut => call!(AssetsPut, assets_put),
            KnowledgeAssetsImport => call!(AssetsImport, assets_import),
            KnowledgeAssetsList => call!(AssetsList, assets_list),
            KnowledgeTransferRead => call!(TransferRead, transfer_read),
            KnowledgeExportComplete => call!(ExportComplete, export_complete),
            KnowledgeIndexStatus => call!(IndexStatusGet, index_status_get),
            KnowledgeIndexRebuild => call!(IndexRebuild, index_rebuild),
            KnowledgeEmbeddingProfileGet => call!(EmbeddingProfileGet, embedding_profile_get),
            KnowledgeEmbeddingProfileSet => call!(EmbeddingProfileSet, embedding_profile_set),
            KnowledgePullRequestsList => call!(PullRequestsList, pull_requests_list),
            KnowledgePullRequestsGet => call!(PullRequestsGet, pull_requests_get),
            KnowledgePullRequestsCreate => call!(PullRequestsCreate, pull_requests_create),
            KnowledgePullRequestsReview => call!(PullRequestsReview, pull_requests_review),
            KnowledgeExportPrepare => {
                let i = kb_client::decode_input::<ExportPrepare>(input)
                    .map_err(|_| StoreError::InvalidArgument("export input".into()))?;
                let mut ctl = crate::exports::ExportControl::default();
                ctl.cancelled = c.work_flag();
                serde_json::to_value(s.export_prepare_controlled(p, i, &ctl, &mut |_, _| Ok(()))?)
                    .map_err(|_| StoreError::Internal("export output".into()))?
            }
            KnowledgeSealedResolve => {
                let i = kb_client::decode_input::<SealedResolve>(input)
                    .map_err(|_| StoreError::InvalidArgument("sealed input".into()))?;
                serde_json::to_value(s.sealed_resolve(
                    p,
                    i,
                    io.keys,
                    &crate::embedder::ProviderControl::transport(c),
                )?)
                .map_err(|_| StoreError::Internal("sealed output".into()))?
            }
            KnowledgeSearch => {
                let i = kb_client::decode_input::<kb_client::types::KnowledgeSearch>(input)
                    .map_err(|_| StoreError::InvalidArgument("search input".into()))?;
                serde_json::to_value(
                    s.search(
                        p,
                        i,
                        io.embedder(),
                        &crate::search::SearchControl::transport(c),
                    )
                    .await?,
                )
                .map_err(|_| StoreError::Internal("search output".into()))?
            }
            KnowledgeStructuredSearch => {
                let i = kb_client::decode_input::<StructuredSearch>(input)
                    .map_err(|_| StoreError::InvalidArgument("structured input".into()))?;
                serde_json::to_value(
                    s.structured_search(
                        p,
                        i,
                        io.embedder(),
                        &crate::search::SearchControl::transport(c),
                    )
                    .await?,
                )
                .map_err(|_| StoreError::Internal("structured output".into()))?
            }
        })
    }
    .await;
    match run {
        Err(e) => {
            // Error details are a publication too (server dispatch parity): a
            // principal revoked mid-call gets the KB's empty denial, never a
            // reason describing its contents (`PATH_NOT_FOUND`, `PATH_EXISTS`,
            // a conflict's SHAs). The tombstone receipt and uniformly sealed
            // resolution keep their own admission boundaries.
            before_refusal();
            if let Some(kb) = &refusal_kb
                && let Err(denial) = s.reauthorize_read(p, kb)
            {
                return failure(denial);
            }
            failure(e)
        }
        Ok(data) => match name.check_output(data) {
            Err(_) => tool_error(ErrorCode::Internal, json!({})),
            Ok(data) => {
                let warnings = warnings(&data);
                let envelope = json!({"schemaVersion":"kb/1","data":data});
                let mut content = vec![json!({"type":"text","text":envelope.to_string()})];
                content.extend(
                    warnings
                        .into_iter()
                        .map(|text| json!({"type":"text","text":text})),
                );
                json!({"isError":false,"structuredContent":envelope,"content":content})
            }
        },
    }
}
/// The shared lexical-only warning, read from the one fixture the server
/// also reads (`packages/api/src/lib/kb/fixtures/lexical-only-warning.json`),
/// so the two transports cannot drift.
const LEXICAL_ONLY_WARNING: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/api/src/lib/kb/fixtures/lexical-only-warning.json"
));
fn lexical_only_warning(id: &str, detail: &str) -> String {
    static TABLE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let table =
        TABLE.get_or_init(|| serde_json::from_str(LEXICAL_ONLY_WARNING).unwrap_or_default());
    let why = table["why"][detail]
        .as_str()
        .or_else(|| table["why"]["default"].as_str())
        .unwrap_or_default();
    table["template"]
        .as_str()
        .unwrap_or_default()
        .replace("{kbId}", id)
        .replace("{why}", why)
}
fn warnings(data: &Value) -> Vec<String> {
    let structured = data["items"]
        .as_array()
        .is_some_and(|a| !a.is_empty() && a.iter().all(|v| v["mode"] == "structured"));
    let empty = data["items"].as_array().is_some_and(Vec::is_empty);
    data["indexNotices"].as_array().into_iter().flatten().map(|n|{let id=n["kbId"].as_str().unwrap_or_default();let detail=n["detail"].as_str().unwrap_or_default();
        if n["code"]=="LEXICAL_ONLY"{return lexical_only_warning(id,detail);}
        let pending=if detail=="EMBEDDING_RUNTIME_RELOADING"{"the built-in embedding runtime is reloading"}else{"embedding rebuild pending"};
        if structured{format!("Warning: knowledge base {id} was searched with exact structured filters using its previous index; {pending}.")}else if empty{format!("Warning: knowledge base {id} was searched using its previous index; {pending}.")}else{match detail{
            "EMBEDDING_MODEL_CHANGED"=>format!("Warning: knowledge base {id} was searched lexical-only because the built-in embedding model changed; rebuild pending."),
            "EMBEDDING_RUNTIME_RELOADING"=>format!("Warning: knowledge base {id} was searched lexical-only because the built-in embedding runtime is reloading with new settings; semantic ranking returns shortly."),
            _=>format!("Warning: semantic ranking for knowledge base {id} came from an index built with the previous embedding settings; rebuild pending.")
        }}
    }).collect()
}

#[cfg(test)]
mod warning_tests {
    use super::*;
    #[test]
    fn lexical_only_notices_get_the_server_warning_text() {
        let kb = "k".repeat(24);
        // The shared fixture is the server's table too; check it parses and
        // that a deliberately disabled model never reads as a failure.
        let table: Value = serde_json::from_str(LEXICAL_ONLY_WARNING).expect("shared fixture");
        let why_of = |detail: &str| {
            table["why"][detail]
                .as_str()
                .or_else(|| table["why"]["default"].as_str())
                .expect("why")
                .to_owned()
        };
        assert!(!why_of("EMBEDDING_PROFILE_UNAVAILABLE").contains("failing"));
        for (detail, why) in [
            "NO_EMBEDDING_PROFILE",
            "EMBEDDING_PROFILE_REVOKED",
            "EMBEDDING_PROFILE_UNAVAILABLE",
            "SEMANTIC_INDEX_BUILDING",
        ]
        .map(|d| (d, why_of(d)))
        {
            // Independent of the page shape (hits, empty or structured items).
            for items in [
                json!([{"mode":"lexical"}]),
                json!([]),
                json!([{"mode":"structured"}]),
            ] {
                let data = json!({"items":items,"indexNotices":[{"kbId":kb,"code":"LEXICAL_ONLY","detail":detail}]});
                assert_eq!(
                    warnings(&data),
                    vec![format!(
                        "Warning: knowledge base {kb} was searched lexical-only (keyword matching) because {why}."
                    )]
                );
            }
        }
        let pending = json!({"results":[{"mode":"lexical"}],"indexNotices":[{"kbId":kb,"code":"EMBEDDING_REBUILD_PENDING","detail":"EMBEDDING_MODEL_CHANGED"}]});
        assert_eq!(
            warnings(&pending),
            vec![format!(
                "Warning: knowledge base {kb} was searched lexical-only because the built-in embedding model changed; rebuild pending."
            )]
        );
    }
}
