//! Immutable local document catalog (CONTRACT `knowledge_documents_list`,
//! `knowledge_documents_get`; parity with `documents-read.ts`).
//!
//! * The revision is resolved once per call: the explicit `rev`, the
//!   cursor's pinned revision, or the recorded head after the gated read
//!   (interrupted publications resolve first; an external ref edit is
//!   `REPAIR_REQUIRED`). It must be a commit reachable from a branch of THIS
//!   repository; anything else is `NOT_FOUND`.
//! * Bytes, blob SHA and content hash come from the cited commit, never from
//!   the current head. `assetRefs` are the Markdown references resolved in
//!   that commit's manifest with exact trusted catalog metadata and retained
//!   recipient lineage. Removed HEAD entries remain readable in history.
//! * Pages are ordered by path (UTF-16 code units, the JS `<` order), bounded
//!   by `Page.limit`, and continued by an HMAC cursor bound to principal,
//!   KB, prefix filter and pinned revision. Encoded responses over 8 MiB fail
//!   before sending.

use kb_client::types::{
    Document, DocumentListItem, DocumentsGet, DocumentsGetInput, DocumentsList, DocumentsListInput,
    KbPath, KbPathPrefix, Page, Permission, Sha,
};

use crate::bases::check_input;
use crate::cursor::{self, Binding};
use crate::git_read::{
    DOCUMENT_MAX_BYTES, EntryKind, GitError, GitRepo, IncomingBudget, ObjectKind, SourceError,
    WalkBudget, read_document, walk_tree,
};
use crate::limits::{check_response_size, page_limit};
use crate::markdown::{map_to_json, parse_markdown};
use crate::state::LocalPrincipal;
use crate::store::{Store, StoreError};
use crate::tree::TREE_LIMITS;

/// The tool shape of a document read at `commit`, its asset references
/// resolved against that revision's manifest `entries`.
pub(crate) fn document_from_source(
    source: crate::markdown::SourceDocument,
    entries: &[crate::tree::ManifestEntry],
    commit: Sha,
) -> Result<Document, StoreError> {
    let referenced = crate::manifest::referenced_paths(source.body(), source.path.as_str());
    let asset_refs = entries
        .iter()
        .filter(|e| referenced.contains(&e.path))
        .map(crate::manifest::asset_ref)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Document {
        path: source.path.clone(),
        document_id: source.document_id.clone(),
        front_matter: map_to_json(&source.front_matter),
        commit_sha: commit,
        blob_sha: source.blob_sha.clone(),
        content_hash: source.content_hash.clone(),
        document_citations: source.citations.clone(),
        asset_refs,
        markdown: source.markdown,
    })
}

pub(crate) fn source_error(error: SourceError) -> StoreError {
    match error {
        SourceError::NotFound => StoreError::NotFound,
        SourceError::InvalidPath => StoreError::InvalidArgument("path".into()),
        SourceError::InvalidMarkdown(_) => {
            StoreError::InvalidArgument("document is not valid Markdown".into())
        }
        SourceError::TooLarge => StoreError::InvalidArgument("document too large".into()),
        SourceError::Git(error) => git_error(error),
    }
}

fn git_error(error: GitError) -> StoreError {
    match error {
        GitError::NotFound => StoreError::NotFound,
        other => StoreError::from(other),
    }
}

fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

impl Store {
    /// Authorize `read`, run the gated read, and resolve the revision once.
    pub(crate) fn pinned_revision(
        &self,
        principal: &LocalPrincipal,
        input_kb: &kb_client::types::KbId,
        rev: Option<&Sha>,
    ) -> Result<(GitRepo, Sha), StoreError> {
        self.authorize(principal, input_kb, Permission::Read)?;
        let record = self.read_kb(input_kb)?;
        self.authorize(principal, input_kb, Permission::Read)?;
        let head = record
            .head_sha
            .as_deref()
            .and_then(|s| Sha::parse(s).ok())
            .ok_or_else(|| StoreError::RecoveryRequired("active kb without head".into()))?;
        let pinned = rev.cloned().unwrap_or(head);
        let repo = GitRepo::for_kb(&self.paths, input_kb)?;
        repo.resolve_readable_commit(&pinned).map_err(git_error)?;
        Ok((repo, pinned))
    }

    /// `knowledge_documents_list`: Markdown paths at one pinned revision.
    pub fn documents_list(
        &self,
        principal: &LocalPrincipal,
        input: DocumentsListInput,
    ) -> Result<Page<DocumentListItem>, StoreError> {
        self.documents_list_observed(principal, input, &mut || Ok(()))
    }

    /// Trusted host seam after actual assembly and child drain, before live
    /// return authorization. An error cannot publish the assembled response.
    #[doc(hidden)]
    pub fn documents_list_observed(
        &self,
        principal: &LocalPrincipal,
        input: DocumentsListInput,
        before_return: &mut dyn FnMut() -> Result<(), StoreError>,
    ) -> Result<Page<DocumentListItem>, StoreError> {
        let kb = input.kb_id.clone();
        let assembled = self.documents_list_assembled(principal, input);
        self.reauthorized(principal, &kb, assembled, before_return)
    }

    fn documents_list_assembled(
        &self,
        principal: &LocalPrincipal,
        input: DocumentsListInput,
    ) -> Result<Page<DocumentListItem>, StoreError> {
        check_input::<DocumentsList>(&input)?;
        let limit = page_limit(input.limit)?;
        let prefix = input.prefix.as_ref().map(KbPathPrefix::as_str);
        let binding = Binding {
            actor_key: principal.actor_key(),
            kb_id: input.kb_id.as_str().to_owned(),
            filter_hash: cursor::filter_hash(&[
                b"knowledge_documents_list",
                prefix.map_or(b"\0".as_slice(), str::as_bytes),
            ]),
            sort_key: "path",
        };
        // Revocation is checked before (and independently of) the cursor.
        self.authorize(principal, &input.kb_id, Permission::Read)?;
        let (rev, after) = match input.cursor.flatten() {
            Some(token) => {
                let verified = cursor::verify(
                    &self.cursor_key,
                    &token,
                    &binding,
                    input.rev.as_ref(),
                    self.now_ms(),
                )?;
                let rev = verified.revision.ok_or(StoreError::InvalidCursor)?;
                (Some(rev), verified.last_key)
            }
            None => (input.rev.clone(), None),
        };
        let (repo, pinned) = self.pinned_revision(principal, &input.kb_id, rev.as_ref())?;
        let mut reader = repo.object_reader().map_err(git_error)?;
        let info = reader.read_commit(&pinned).map_err(git_error)?;
        let mut walk = WalkBudget::new(TREE_LIMITS.max_entries);
        let mut incoming = IncomingBudget::new(
            TREE_LIMITS.max_objects,
            TREE_LIMITS.max_uncompressed_object_bytes,
            None,
        );
        let mut entries: Vec<_> = walk_tree(&mut reader, &info.tree, &mut walk, &mut incoming)
            .map_err(git_error)?
            .into_iter()
            .filter(|entry| {
                entry.kind == EntryKind::Blob
                    && entry.path.ends_with(".md")
                    && prefix.is_none_or(|p| entry.path.starts_with(p))
                    && after
                        .as_deref()
                        .is_none_or(|a| utf16_cmp(&entry.path, a).is_gt())
            })
            .collect();
        entries.sort_by(|a, b| utf16_cmp(&a.path, &b.path));
        let more = entries.len() > limit;
        entries.truncate(limit);
        let mut items = Vec::with_capacity(entries.len());
        for entry in entries {
            let mut size = 0usize;
            let (kind, bytes) = reader
                .read_checked(&entry.sha, DOCUMENT_MAX_BYTES, &mut |_, n| {
                    size = n;
                    Ok(())
                })
                .map_err(git_error)?;
            if kind != ObjectKind::Blob {
                return Err(StoreError::RecoveryRequired(
                    "tree entry is not a blob".into(),
                ));
            }
            items.push(DocumentListItem {
                path: KbPath::parse(&entry.path)
                    .map_err(|_| StoreError::RecoveryRequired("unnormalized path".into()))?,
                document_id: parse_markdown(&bytes).ok().and_then(|p| p.document_id),
                commit_sha: pinned.clone(),
                blob_sha: Sha::parse(&entry.sha)
                    .map_err(|_| StoreError::Internal("blob name".into()))?,
                size: size as u64,
            });
        }
        let next_cursor = match (more, items.last()) {
            (true, Some(last)) => Some(cursor::sign(
                &self.cursor_key,
                &binding,
                Some(pinned.clone()),
                last.path.as_str().to_owned(),
                self.now_ms(),
            )?),
            _ => None,
        };
        let page = Page { items, next_cursor };
        check_response_size(serde_json::to_vec(&page), self.response_limit.get())?;
        drop(reader);
        drop(repo);
        Ok(page)
    }

    /// Live read authority under the store fence.
    pub(crate) fn reauthorize_read(
        &self,
        principal: &LocalPrincipal,
        kb: &kb_client::types::KbId,
    ) -> Result<(), StoreError> {
        let guard = self.lock_write(&[])?;
        self.check_guard(&guard)?;
        self.authorize(principal, kb, Permission::Read).map(|_| ())
    }

    /// Final live read authority under the store fence for a read's result,
    /// success OR failure: a detailed refusal (`PATH_NOT_FOUND`, a bad cursor)
    /// is a publication too, so a principal revoked mid-call gets the same
    /// empty `NOT_FOUND` either way (server dispatch parity).
    pub(crate) fn reauthorized<T>(
        &self,
        principal: &LocalPrincipal,
        kb: &kb_client::types::KbId,
        result: Result<T, StoreError>,
        before_return: &mut dyn FnMut() -> Result<(), StoreError>,
    ) -> Result<T, StoreError> {
        // The delivery seam belongs to an assembled response only.
        if result.is_ok() {
            before_return()?;
        }
        self.reauthorize_read(principal, kb)?;
        result
    }

    /// `knowledge_documents_get`: one document's source at a pinned revision.
    pub fn documents_get(
        &self,
        principal: &LocalPrincipal,
        input: DocumentsGetInput,
    ) -> Result<Document, StoreError> {
        self.documents_get_observed(principal, input, &mut || Ok(()))
    }

    /// See [`Store::documents_list_observed`].
    #[doc(hidden)]
    pub fn documents_get_observed(
        &self,
        principal: &LocalPrincipal,
        input: DocumentsGetInput,
        before_return: &mut dyn FnMut() -> Result<(), StoreError>,
    ) -> Result<Document, StoreError> {
        let kb = input.kb_id.clone();
        let assembled = self.documents_get_assembled(principal, input);
        self.reauthorized(principal, &kb, assembled, before_return)
    }

    fn documents_get_assembled(
        &self,
        principal: &LocalPrincipal,
        input: DocumentsGetInput,
    ) -> Result<Document, StoreError> {
        check_input::<DocumentsGet>(&input)?;
        let (repo, pinned) = self.pinned_revision(principal, &input.kb_id, input.rev.as_ref())?;
        let source =
            read_document(&repo, &pinned, input.path.as_str()).map_err(|error| match error {
                // Say it is the path that is missing (server parity).
                SourceError::NotFound => StoreError::PathNotFound {
                    field: Some("/path".into()),
                },
                other => source_error(other),
            })?;
        let entries = self.manifest_entries(&input.kb_id, &repo, &pinned)?;
        self.authorize(principal, &input.kb_id, Permission::Read)?;
        let document = document_from_source(source, &entries, pinned)?;
        check_response_size(serde_json::to_vec(&document), self.response_limit.get())?;
        drop(repo);
        Ok(document)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integral_numbers_serialize_like_javascript() {
        assert_eq!(crate::markdown::json_number(2.0), serde_json::json!(2));
        assert_eq!(crate::markdown::json_number(-3.0), serde_json::json!(-3));
        assert_eq!(crate::markdown::json_number(1.5), serde_json::json!(1.5));
    }

    #[test]
    fn paths_order_by_utf16_code_units() {
        // U+FF5E sorts after U+1F600 in UTF-8 bytes but before it in UTF-16.
        assert!(utf16_cmp("\u{1F600}", "\u{FF5E}").is_lt());
        assert!("\u{1F600}".as_bytes() > "\u{FF5E}".as_bytes());
    }
}
