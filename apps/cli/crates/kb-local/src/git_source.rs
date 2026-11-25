//! Document sources at a readable revision: the exact blob a path names in a
//! commit's tree, read under the document size cap and parsed as kb Markdown.

use kb_client::ErrorCode;
use kb_client::host::snapshot::content_hash;
use kb_client::types::{KbPath, Sha};

use crate::git_read::{DOCUMENT_MAX_BYTES, GitError, GitRepo, ObjectKind, ObjectReader};
use crate::git_tree::blob_at;
use crate::markdown::{MarkdownIssue, SourceDocument, parse_markdown};

/// Why a source read failed.
#[derive(Debug)]
pub enum SourceError {
    InvalidPath,
    /// Unreadable revision (missing, foreign, unreachable) or no such file.
    NotFound,
    InvalidMarkdown(MarkdownIssue),
    TooLarge,
    Git(GitError),
}

impl SourceError {
    pub fn protocol_code(&self) -> ErrorCode {
        match self {
            SourceError::InvalidPath | SourceError::InvalidMarkdown(_) | SourceError::TooLarge => {
                ErrorCode::InvalidArgument
            }
            SourceError::NotFound => ErrorCode::NotFound,
            SourceError::Git(GitError::NotFound) => ErrorCode::NotFound,
            SourceError::Git(GitError::Budget(_)) => ErrorCode::InvalidArgument,
            SourceError::Git(GitError::Structure(_)) => ErrorCode::RepairRequired,
            SourceError::Git(GitError::Timeout) => ErrorCode::DeadlineExceeded,
            SourceError::Git(GitError::Cancelled) => ErrorCode::Cancelled,
            SourceError::Git(GitError::Io(_) | GitError::Failed(_)) => {
                ErrorCode::StorageUnavailable
            }
        }
    }
}

impl From<GitError> for SourceError {
    fn from(error: GitError) -> Self {
        match error {
            GitError::NotFound => SourceError::NotFound,
            other => SourceError::Git(other),
        }
    }
}

/// Read one document's immutable source at `commit`, which must be readable
/// (reachable from a branch of this repository). The path is matched
/// exactly, segment by segment, through the raw tree objects of that commit.
pub fn read_document(
    repo: &GitRepo,
    commit: &Sha,
    path: &str,
) -> Result<SourceDocument, SourceError> {
    let parsed_path = KbPath::parse(path).map_err(|_| SourceError::InvalidPath)?;
    repo.resolve_readable_commit(commit)?;
    let mut reader = repo.object_reader()?;
    let info = reader.read_commit(commit).map_err(referenced_object)?;
    read_document_at(&mut reader, commit, &info.tree, parsed_path.as_str())
}

/// Once a revision is proven readable, an unavailable object it references is
/// a storage fault. Only an absent path is document absence.
fn referenced_object(error: GitError) -> SourceError {
    match error {
        GitError::NotFound => {
            SourceError::Git(GitError::Failed("referenced object is unavailable".into()))
        }
        other => SourceError::from(other),
    }
}

/// [`read_document`] through an open reader, for a `commit` the caller
/// already proved readable and whose root `tree` it read (an index
/// build reads every document of one revision through one reader).
pub fn read_document_at(
    reader: &mut ObjectReader,
    commit: &Sha,
    tree: &Sha,
    path: &str,
) -> Result<SourceDocument, SourceError> {
    let path = KbPath::parse(path).map_err(|_| SourceError::InvalidPath)?;
    let referenced = referenced_object;
    let blob = blob_at(reader, tree, &path)
        .map_err(referenced)?
        .ok_or(SourceError::NotFound)?;
    let (kind, bytes) = match reader.read_checked(&blob, DOCUMENT_MAX_BYTES, &mut |_, _| Ok(())) {
        Err(GitError::Budget(_)) => return Err(SourceError::TooLarge),
        other => other.map_err(referenced)?,
    };
    if kind != ObjectKind::Blob {
        return Err(SourceError::Git(GitError::Failed(
            "document entry does not name a blob".into(),
        )));
    }
    let parsed = parse_markdown(&bytes).map_err(SourceError::InvalidMarkdown)?;
    let markdown = String::from_utf8(bytes).map_err(|_| {
        SourceError::Git(GitError::Failed("validated markdown is not UTF-8".into()))
    })?;
    Ok(SourceDocument {
        content_hash: content_hash(markdown.as_bytes()),
        blob_sha: Sha::parse(&blob).map_err(|_| GitError::Failed("invalid blob name".into()))?,
        path,
        commit_sha: commit.clone(),
        markdown,
        front_matter: parsed.front_matter,
        body_start: parsed.body_start,
        document_id: parsed.document_id,
        citations: parsed.citations,
    })
}
