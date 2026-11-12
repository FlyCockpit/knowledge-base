//! Immutable external embedding space. Credentials cannot be an input.
use crate::{
    StoreError,
    egress::{Endpoint, unavailable},
};
pub const EMBEDDING_VERSIONS: [&str; 10] = [
    "l2-f32-v1",
    "source-spans-whitespace-400-80-v1",
    "unicode-white-space-v1",
    "credential-ranges-pem-sealed-v1",
    "frontmatter-source-v1",
    "gfm-scalar-rows-nfkc-fold-v1",
    "explicit-frontmatter-pinned-assets-v1",
    "unicode-scalars-240-v1",
    "markdown-only-v1",
    "hybrid-v1",
];
pub fn embedding_fingerprint(
    endpoint: &Endpoint,
    model: &str,
    dimensions: usize,
    versions: &[&str; 10],
) -> Result<String, StoreError> {
    if !(1..=2000).contains(&dimensions) {
        return Err(unavailable());
    }
    let mut parts = vec![
        serde_json::json!("OPENAI_COMPAT"),
        serde_json::json!(endpoint.url().as_str()),
        serde_json::json!(model),
        serde_json::json!(dimensions),
    ];
    parts.extend(versions.iter().map(|v| serde_json::Value::from(*v)));
    let bytes = serde_json::to_vec(&parts).map_err(|_| unavailable())?;
    Ok(kb_client::snapshot::content_hash(&bytes)
        .as_str()
        .to_owned())
}
