//! Projection exclusively from one leased index; never reads mutable HEAD.
use crate::{StoreError, generations::GenerationSnapshot, structured::StructuredRow};
use kb_client::types::*;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct IndexedRow {
    #[serde(flatten)]
    pub row: StructuredRow,
    pub snippet: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    commit_sha: Sha,
    blob_sha: Sha,
    content_hash: ContentHash,
    document_id: Option<String>,
    document_citations: Vec<DocCitation>,
    asset_refs: Vec<AssetRef>,
}
pub(crate) fn decode<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, StoreError> {
    serde_json::from_str(s).map_err(|_| StoreError::IndexUnavailable)
}
pub(crate) struct Context<'a> {
    pub snapshot: &'a GenerationSnapshot,
    pub name: &'a str,
    pub freshness: Freshness,
    pub mode: SearchMode,
}
pub(crate) fn project(
    conn: &Connection,
    id: i64,
    row: Option<&IndexedRow>,
    score: f64,
    ctx: &Context<'_>,
) -> Result<CitationHit, StoreError> {
    let (path,index,span,snippet,source) = conn.query_row("SELECT c.path,c.chunk_index,c.start_token,c.end_token,c.start_byte,c.end_byte,c.snippet,d.source_json FROM chunks c JOIN documents d ON d.path=c.path WHERE c.id=?1",[id],|r|Ok((r.get::<_,String>(0)?,u64::from(r.get::<_,u32>(1)?),CitationSpan {start_token:u64::from(r.get::<_,u32>(2)?),end_token:u64::from(r.get::<_,u32>(3)?),start_byte:u64::from(r.get::<_,u32>(4)?),end_byte:u64::from(r.get::<_,u32>(5)?)},r.get::<_,String>(6)?,r.get::<_,String>(7)?)))?;
    let s: Source = decode(&source)?;
    if s.commit_sha != ctx.snapshot.commit_sha || !score.is_finite() {
        return Err(StoreError::IndexUnavailable);
    }
    Ok(CitationHit {
        knowledge_base_id: ctx.snapshot.kb_id.clone(),
        knowledge_base_name: ctx.name.into(),
        path: KbPath::parse(&path).map_err(|_| StoreError::IndexUnavailable)?,
        document_id: s.document_id,
        commit_sha: s.commit_sha,
        blob_sha: s.blob_sha,
        content_hash: s.content_hash,
        chunk_index: index,
        span: row.map_or(span, |r| r.row.span),
        // R2-27: plain text on every transport; the span stays exact.
        snippet: row.map_or(snippet, |r| r.snippet.clone()),
        score,
        mode: ctx.mode,
        index_generation_id: ctx.snapshot.id.clone(),
        freshness: ctx.freshness,
        document_citations: s.document_citations,
        asset_refs: s.asset_refs,
        matched_row: row.map(|r| r.row.values.clone()),
    })
}
