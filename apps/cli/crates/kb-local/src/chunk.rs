//! Source-body Unicode White_Space windows; safe text never changes source spans.
use crate::sensitive_text::{known_credential_ranges, prepare_embedding_query};
use kb_client::types::CitationSpan;
use serde::Serialize;
use std::ops::Range;

pub const CHUNK_WORDS: usize = 400;
pub const CHUNK_OVERLAP: usize = 80;
pub const SNIPPET_SCALARS: usize = 240;
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceChunk {
    pub chunk_index: usize,
    pub span: CitationSpan,
    pub text: String,
    pub snippet: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DocumentState {
    Indexed,
    Empty,
    SkippedRedacted,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkedBody {
    pub state: DocumentState,
    pub original_window_count: usize,
    pub chunks: Vec<SourceChunk>,
}
pub fn source_tokens(body: &str) -> Vec<Range<usize>> {
    body.split_whitespace()
        .map(|word| {
            // split_whitespace returns subslices of this exact body allocation.
            let start = word.as_ptr() as usize - body.as_ptr() as usize;
            start..start + word.len()
        })
        .collect()
}

pub fn citation_snippet(text: &str) -> String {
    citation_snippet_from_scalars(text.chars())
}

fn citation_snippet_from_scalars(scalars: impl Iterator<Item = char>) -> String {
    // Word count does not bound bytes. Format only a small scalar-safe lookahead
    // window, then clip the plain result, just like the server.
    let window: String = scalars.take(SNIPPET_SCALARS + 1024).collect();
    let text = crate::plain_snippet::plain_snippet(&window);
    if text.chars().count() <= SNIPPET_SCALARS {
        return text.to_owned();
    }
    text.chars()
        .take(SNIPPET_SCALARS - 1)
        .chain(['…'])
        .collect()
}

pub fn chunk_body(body: &str) -> ChunkedBody {
    let tokens = source_tokens(body);
    let rejected = known_credential_ranges(body);
    let mut chunks = Vec::new();
    let mut original_window_count = 0;
    let mut range_index = 0;
    for start in (0..tokens.len()).step_by(CHUNK_WORDS - CHUNK_OVERLAP) {
        let end = (start + CHUNK_WORDS).min(tokens.len());
        let bytes = tokens[start].start..tokens[end - 1].end;
        let chunk_index = original_window_count;
        original_window_count += 1;
        while rejected
            .get(range_index)
            .is_some_and(|r| r.end <= bytes.start)
        {
            range_index += 1;
        }
        if !rejected
            .get(range_index)
            .is_some_and(|r| r.start < bytes.end)
            && let Ok(safe) = prepare_embedding_query(&body[bytes.clone()])
        {
            let text = safe.split_whitespace().collect::<Vec<_>>().join(" ");
            chunks.push(SourceChunk {
                chunk_index,
                span: CitationSpan {
                    start_token: start as u64,
                    end_token: end as u64,
                    start_byte: bytes.start as u64,
                    end_byte: bytes.end as u64,
                },
                snippet: citation_snippet(&text),
                text,
            });
        }
        if end == tokens.len() {
            break;
        }
    }
    let state = if tokens.is_empty() {
        DocumentState::Empty
    } else if chunks.is_empty() {
        DocumentState::SkippedRedacted
    } else {
        DocumentState::Indexed
    };
    ChunkedBody {
        state,
        original_window_count,
        chunks,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    #[test]
    fn citation_snippet_source_work_is_independent_of_document_size() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/api/src/lib/kb/fixtures/plain-snippet.json"
        ))
        .expect("shared corpus");
        let limit = corpus["maxCitationSourceScalars"].as_u64().unwrap() as usize;
        for case in corpus["stressCases"].as_array().expect("stress cases") {
            let unit = case["unit"].as_str().unwrap();
            let near_limit = limit / unit.chars().count() + 1;
            for count in [near_limit, case["repeat"].as_u64().unwrap() as usize] {
                let input = case["head"].as_str().unwrap().to_owned()
                    + &unit.repeat(count)
                    + case["tail"].as_str().unwrap();
                let visited = Cell::new(0);
                // Count the source consumed by the production helper rather than
                // timing the host. Removing take() makes this grow to ~2 MiB.
                let snippet = super::citation_snippet_from_scalars(input.chars().inspect(|_| {
                    visited.set(visited.get() + 1);
                }));
                assert_eq!(visited.get(), limit, "{}", case["name"]);
                assert_eq!(
                    snippet,
                    case["snippet"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
                assert_eq!(super::citation_snippet(&input), snippet);
            }
        }
    }
}
