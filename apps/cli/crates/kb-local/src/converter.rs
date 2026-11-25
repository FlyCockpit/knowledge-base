//! Admitted Markdown source to index inputs, the twin of the server's
//! `converter.ts`: validated source document, manifest asset references,
//! chunked body and structured document of one reachable commit.

use kb_client::types::{KbPath, Sha};

use crate::markdown::{SourceDocument, parse_markdown};

/// Caller supplies admitted source and manifest from one reachable commit.
pub struct ConversionInput<'a> {
    pub media_type: &'a str,
    pub bytes: &'a [u8],
    pub path: &'a KbPath,
    pub commit_sha: &'a Sha,
    pub commit_timestamp: &'a str,
    pub manifest_commit_sha: &'a Sha,
    pub manifest_entries: &'a [crate::tree::ManifestEntry],
}
#[derive(Debug)]
pub struct ConvertedSource {
    pub source: SourceDocument,
    pub asset_refs: Vec<kb_client::types::AssetRef>,
    pub chunked: crate::chunk::ChunkedBody,
    pub structured: crate::structured::StructuredDocument,
}
#[derive(Debug)]
pub enum ConversionError {
    UnsupportedMedia,
    InvalidSource,
}
impl ConversionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedMedia => "UNSUPPORTED_MEDIA",
            Self::InvalidSource => "INVALID_ARGUMENT",
        }
    }
}
impl std::fmt::Display for ConversionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for ConversionError {}
pub fn convert_source(input: &ConversionInput<'_>) -> Result<ConvertedSource, ConversionError> {
    if input.media_type != "text/markdown" {
        return Err(ConversionError::UnsupportedMedia);
    }
    if input.bytes.len() > crate::git_read::DOCUMENT_MAX_BYTES
        || input.commit_sha != input.manifest_commit_sha
    {
        return Err(ConversionError::InvalidSource);
    }
    let parsed = parse_markdown(input.bytes).map_err(|_| ConversionError::InvalidSource)?;
    let markdown = std::str::from_utf8(input.bytes).map_err(|_| ConversionError::InvalidSource)?;
    let body = &markdown[parsed.body_start..];
    let refs = crate::manifest::referenced_paths(body, input.path.as_str());
    let asset_refs = input
        .manifest_entries
        .iter()
        .filter(|e| refs.contains(&e.path))
        .map(crate::manifest::asset_ref)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ConversionError::InvalidSource)?;
    let structured =
        crate::structured::extract_structured_document(&parsed, body, input.commit_timestamp)
            .map_err(|_| ConversionError::InvalidSource)?;
    Ok(ConvertedSource {
        chunked: crate::chunk::chunk_body(body),
        structured,
        asset_refs,
        source: SourceDocument {
            path: input.path.clone(),
            commit_sha: input.commit_sha.clone(),
            blob_sha: kb_client::host::snapshot::git_blob_sha(input.bytes),
            content_hash: kb_client::host::snapshot::content_hash(input.bytes),
            markdown: markdown.into(),
            front_matter: parsed.front_matter,
            body_start: parsed.body_start,
            document_id: parsed.document_id,
            citations: parsed.citations,
        },
    })
}
/// Internal unsupported-media errors project to the common tool code.
pub fn convert_markdown_source(
    input: &ConversionInput<'_>,
) -> Result<ConvertedSource, crate::StoreError> {
    convert_source(input)
        .map_err(|_| crate::StoreError::InvalidArgument("invalid Markdown source or media".into()))
}
