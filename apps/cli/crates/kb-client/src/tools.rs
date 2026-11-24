//! The pinned kb/1 tool catalog: [`ToolName`], one [`Tool`] marker per
//! catalog tool binding its typed input and output, and the per-call checks
//! that run a value through the schema artifact and the typed shape. Above the
//! value types and the schema evaluator; below every transport.

use std::fmt;
use std::str::FromStr;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::authoring::{ToolAuthoring, WriteKind};
use crate::error::{KbError, ProtocolError};
use crate::schema::{self, Direction};
use crate::types::*;

// ── Catalog ─────────────────────────────────────────────────────────────────

/// One kb/1 catalog tool with owned, thread-safe input and output so the HTTP
/// transport can validate them off the async executor under call control.
pub trait Tool {
    const NAME: ToolName;
    type Input: Serialize + DeserializeOwned + fmt::Debug + Clone + PartialEq + Send + 'static;
    type Output: Serialize + DeserializeOwned + fmt::Debug + Clone + PartialEq + Send + 'static;
}

fn check_typed<T: Serialize + DeserializeOwned>(
    tool: &str,
    direction: Direction,
    value: Value,
) -> Result<Value, KbError> {
    let wrap = |violation| match direction {
        Direction::Input => KbError::Protocol(ProtocolError::InvalidInput(violation)),
        Direction::Output => KbError::Protocol(ProtocolError::InvalidOutput(violation)),
    };
    schema::validate(tool, direction, &value).map_err(wrap)?;
    let typed: T = serde_json::from_value(schema::normalize_integers(value))
        .map_err(|_| wrap(typed_violation()))?;
    serde_json::to_value(&typed).map_err(|_| wrap(typed_violation()))
}

pub(crate) fn typed_violation() -> schema::SchemaViolation {
    schema::SchemaViolation {
        pointer: String::new(),
        keyword: "typed-shape",
        member: None,
        min: None,
        max: None,
    }
}

macro_rules! catalog {
    ($( $variant:ident => $marker:ident, $wire:literal, $read_only:literal, $input:ty, $output:ty; )*) => {
        /// The pinned kb/1 tool catalog. Arbitrary operation names do not parse.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum ToolName { $( $variant, )* }

        impl ToolName {
            /// Every catalog tool.
            pub const ALL: &'static [ToolName] = &[ $( ToolName::$variant, )* ];

            /// Wire name.
            pub fn as_str(self) -> &'static str {
                match self { $( ToolName::$variant => $wire, )* }
            }

            /// Read tools accept `mcp:read` or `mcp:write`; others need `mcp:write`.
            pub fn read_only(self) -> bool {
                match self { $( ToolName::$variant => $read_only, )* }
            }

            /// Validate an untyped input against the contract and the typed
            /// shape; returns the canonical re-serialization.
            pub fn check_input(self, value: Value) -> Result<Value, KbError> {
                match self {
                    $( ToolName::$variant => check_typed::<$input>($wire, Direction::Input, value), )*
                }
            }

            /// Validate an untyped output against the contract and the typed
            /// shape; returns the canonical re-serialization.
            pub fn check_output(self, value: Value) -> Result<Value, KbError> {
                match self {
                    $( ToolName::$variant => check_typed::<$output>($wire, Direction::Output, value), )*
                }
            }

            /// Validate a complete success or domain-error envelope without
            /// changing its wire representation (agent forwarding).
            pub fn check_envelope(self, value: Value) -> Result<(), KbError> {
                match self {
                    $( ToolName::$variant => match crate::decode_envelope::<$marker>(value) {
                        Ok(_) | Err(KbError::Tool(_)) => Ok(()),
                        Err(error) => Err(error),
                    }, )*
                }
            }
        }

        impl FromStr for ToolName {
            type Err = KbError;
            fn from_str(s: &str) -> Result<Self, KbError> {
                match s {
                    $( $wire => Ok(ToolName::$variant), )*
                    _ => Err(KbError::Protocol(ProtocolError::UnknownTool)),
                }
            }
        }

        $(
            #[doc = concat!("Marker for `", $wire, "`.")]
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub struct $marker;

            impl Tool for $marker {
                const NAME: ToolName = ToolName::$variant;
                type Input = $input;
                type Output = $output;
            }
        )*
    };
}

catalog! {
    KnowledgeBasesList => BasesList, "knowledge_bases_list", true,
        BasesListInput, Page<KbAttachment>;
    KnowledgeBasesGet => BasesGet, "knowledge_bases_get", true, KbRef, BasesGetOutput;
    KnowledgeBasesCreate => BasesCreate, "knowledge_bases_create", false,
        BasesCreateInput, KbMutationOutput;
    KnowledgeBasesUpdate => BasesUpdate, "knowledge_bases_update", false,
        BasesUpdateInput, KbMutationOutput;
    KnowledgeBasesDelete => BasesDelete, "knowledge_bases_delete", false,
        BasesDeleteInput, BasesDeleteOutput;
    KnowledgeDocumentsList => DocumentsList, "knowledge_documents_list", true,
        DocumentsListInput, Page<DocumentListItem>;
    KnowledgeDocumentsGet => DocumentsGet, "knowledge_documents_get", true,
        DocumentsGetInput, Document;
    KnowledgeSearch => KnowledgeSearch, "knowledge_search", true, SearchInput, SearchOutput;
    KnowledgeSearchAll => SearchAll, "knowledge_search_all", true,
        SearchAllInput, SearchAllOutput;
    KnowledgeStructuredSearch => StructuredSearch, "knowledge_structured_search", true,
        StructuredSearchInput, StructuredSearchOutput;
    KnowledgeChangesApply => ChangesApply, "knowledge_changes_apply", false,
        ChangesApplyInput, ApplyResult;
    KnowledgeDocumentsCreate => DocumentsCreate, "knowledge_documents_create", false,
        DocumentWriteInput, ApplyResult;
    KnowledgeDocumentsUpdate => DocumentsUpdate, "knowledge_documents_update", false,
        DocumentWriteInput, ApplyResult;
    KnowledgeDocumentsDelete => DocumentsDelete, "knowledge_documents_delete", false,
        DocumentsDeleteInput, ApplyResult;
    KnowledgeUploadBegin => UploadBegin, "knowledge_upload_begin", false,
        UploadBeginInput, UploadBeginOutput;
    KnowledgeUploadWrite => UploadWrite, "knowledge_upload_write", false,
        UploadWriteInput, UploadWriteOutput;
    KnowledgeUploadFinish => UploadFinish, "knowledge_upload_finish", false,
        UploadRef, UploadFinishOutput;
    KnowledgeAssetsPut => AssetsPut, "knowledge_assets_put", false, AssetsPutInput, ApplyResult;
    KnowledgeAssetsImport => AssetsImport, "knowledge_assets_import", false,
        AssetsImportInput, ApplyResult;
    KnowledgeAssetsList => AssetsList, "knowledge_assets_list", true,
        AssetsListInput, Page<AssetRef>;
    KnowledgeExportPrepare => ExportPrepare, "knowledge_export_prepare", true,
        ExportPrepareInput, ExportJob;
    KnowledgeExportStatus => ExportStatus, "knowledge_export_status", true,
        TransferRef, ExportJob;
    KnowledgeExportCancel => ExportCancel, "knowledge_export_cancel", true,
        TransferRef, ExportJob;
    KnowledgeTransferRead => TransferRead, "knowledge_transfer_read", true,
        TransferReadInput, TransferReadOutput;
    KnowledgeExportComplete => ExportComplete, "knowledge_export_complete", true,
        TransferRef, ExportCompleteOutput;
    KnowledgeIndexStatus => IndexStatusGet, "knowledge_index_status", true, KbRef, IndexStatus;
    KnowledgeIndexRebuild => IndexRebuild, "knowledge_index_rebuild", false,
        IndexRebuildInput, GenerationJobOutput;
    KnowledgeEmbeddingProfileGet => EmbeddingProfileGet, "knowledge_embedding_profile_get", true,
        KbRef, EmbeddingProfileOutput;
    KnowledgeEmbeddingProfileSet => EmbeddingProfileSet, "knowledge_embedding_profile_set", false,
        EmbeddingProfileSetInput, ProfileSetOutput;
    KnowledgePullRequestsList => PullRequestsList, "knowledge_pull_requests_list", true,
        PullRequestsListInput, Page<PrSummary>;
    KnowledgePullRequestsGet => PullRequestsGet, "knowledge_pull_requests_get", true,
        PullRequestsGetInput, PullRequestsGetOutput;
    KnowledgePullRequestsCreate => PullRequestsCreate, "knowledge_pull_requests_create", false,
        PullRequestsCreateInput, PrMutationOutput;
    KnowledgePullRequestsReview => PullRequestsReview, "knowledge_pull_requests_review", false,
        PullRequestsReviewInput, PrMutationOutput;
    KnowledgeSealedResolve => SealedResolve, "knowledge_sealed_resolve", true,
        SealedResolveInput, SealedResolveOutput;
}

impl fmt::Display for ToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ── Write modes ─────────────────────────────────────────────────────────────

/// What one call of `name` with `input` needs from the write mode (the
/// server's `toolAuthoringNeed`); `None` when it writes nothing a mode
/// governs. An unreadable catalog needs an edit (fail closed).
pub fn tool_authoring_need(name: ToolName, input: &Value) -> Option<WriteKind> {
    let authoring = match schema::tool_authoring(name.as_str()) {
        Ok(authoring) => authoring?,
        Err(_) => return (!name.read_only()).then_some(WriteKind::Edit),
    };
    match authoring {
        ToolAuthoring::Edit => Some(WriteKind::Edit),
        ToolAuthoring::ByMode => Some(if input["mode"] == "dream" {
            WriteKind::Dream
        } else {
            WriteKind::Edit
        }),
        ToolAuthoring::Merge => (input["decision"] == "merge").then_some(WriteKind::Edit),
    }
}

/// Whether a dream-only credential can use `name` at all (the server's
/// `toolUsableDreamOnly`): every tool but the always-edit ones.
pub fn tool_usable_dream_only(name: ToolName) -> bool {
    match schema::tool_authoring(name.as_str()) {
        Ok(authoring) => authoring != Some(ToolAuthoring::Edit),
        Err(_) => name.read_only(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn needs_follow_the_catalog() {
        let apply = |mode: &str| json!({"mode": mode});
        assert_eq!(
            tool_authoring_need(ToolName::KnowledgeChangesApply, &apply("dream")),
            Some(WriteKind::Dream)
        );
        assert_eq!(
            tool_authoring_need(ToolName::KnowledgeChangesApply, &apply("edit")),
            Some(WriteKind::Edit)
        );
        assert_eq!(
            tool_authoring_need(
                ToolName::KnowledgePullRequestsReview,
                &json!({"decision": "merge"})
            ),
            Some(WriteKind::Edit)
        );
        assert_eq!(
            tool_authoring_need(
                ToolName::KnowledgePullRequestsReview,
                &json!({"decision": "close"})
            ),
            None
        );
        for name in [
            ToolName::KnowledgeDocumentsCreate,
            ToolName::KnowledgeUploadBegin,
            ToolName::KnowledgeAssetsImport,
            ToolName::KnowledgeBasesCreate,
            ToolName::KnowledgeBasesDelete,
            ToolName::KnowledgePullRequestsCreate,
        ] {
            assert_eq!(
                tool_authoring_need(name, &json!({})),
                Some(WriteKind::Edit),
                "{}",
                name.as_str()
            );
            assert!(!tool_usable_dream_only(name));
        }
        for name in [
            ToolName::KnowledgeBasesUpdate,
            ToolName::KnowledgeIndexRebuild,
            ToolName::KnowledgeEmbeddingProfileSet,
            ToolName::KnowledgeSearch,
        ] {
            assert_eq!(tool_authoring_need(name, &json!({})), None);
            assert!(tool_usable_dream_only(name));
        }
        // No read tool ever needs a write mode.
        for name in ToolName::ALL {
            if name.read_only() {
                assert_eq!(tool_authoring_need(*name, &json!({})), None);
            }
        }
    }

    #[test]
    fn embedded_artifact_loads_and_is_fully_understood() {
        let names = schema::artifact_tool_names().expect("artifact passes the fail-closed audit");
        assert_eq!(names.len(), ToolName::ALL.len());
    }

    #[test]
    fn artifact_groups_cover_the_catalog() {
        let tools_in = |group: &str| -> Vec<&str> {
            ToolName::ALL
                .iter()
                .map(|name| name.as_str())
                .filter(|name| schema::tool_groups(name).expect("grouped").contains(&group))
                .collect()
        };
        assert_eq!(
            tools_in("read"),
            [
                "knowledge_documents_list",
                "knowledge_documents_get",
                "knowledge_search",
                "knowledge_search_all",
                "knowledge_structured_search"
            ]
        );
        assert_eq!(
            schema::tool_groups("knowledge_upload_begin").expect("grouped"),
            ["edit", "assets"]
        );
        assert!(
            schema::tool_groups("knowledge_bases_list")
                .expect("grouped")
                .is_empty()
        );
        assert!(
            schema::tool_groups("knowledge_bases_get")
                .expect("grouped")
                .is_empty()
        );
        for group in schema::TOOL_GROUPS {
            assert!(!tools_in(group).is_empty(), "{group} governs no tool");
        }
    }
}
