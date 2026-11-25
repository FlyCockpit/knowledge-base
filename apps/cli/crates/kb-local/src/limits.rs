//! Shared kb/1 budgets for the local backend.
//!
//! The values are the server's code constants (`packages/api/src/lib/kb/
//! {limits,cursor}.ts`, `protocol/common.ts`; a test in `tests/catalog/bases/lifecycle.rs`
//! fails on drift). A local store may opt into LOWER limits with
//! [`LocalLimits::lowered`]; there is no way to raise or unbound one.

use crate::StoreError;

// ── The local store's own rate limits ─────────────────────────────────
//
// The shared constants below are the server's multi-tenant budgets (one
// abusive account must not starve the others). A local store has a single
// owner on their own machine, whose agents legitimately burst: evaluation
// loops issue hundreds of searches, bulk imports create many KBs and
// documents. The local budgets are therefore 10-20x higher, but still
// bounded, so an agent stuck in a loop is stopped within a minute instead of
// spinning forever (every hit is a durable `RATE_LIMITED` with retry-after).

/// Searches per KB per minute (10/s sustained; server: 30/min).
pub const LOCAL_QUERIES_PER_MINUTE_PER_KB: i64 = 600;
/// KB creations per rolling hour (server: 5).
pub const LOCAL_CREATES_PER_HOUR: u32 = 60;
/// Index rebuilds/profile switches per KB per hour (server: 3).
pub const LOCAL_REBUILDS_PER_HOUR_PER_KB: i64 = 30;
/// Provider probes per minute (server: 5).
pub const LOCAL_PROBES_PER_MINUTE: u32 = 30;
/// Writes (and upload begin/finish) per actor and KB per minute (server: 60).
/// `mutation_windows.times_json` has the same bound as a CHECK constraint
/// (`db/0001_initial.sql`; a unit test pins them together).
pub const LOCAL_MUTATIONS_PER_MINUTE_PER_KB: usize = 600;
/// Staged upload bytes per rolling hour (server: 100 MiB); disk headroom
/// still applies to every reservation.
pub const LOCAL_UPLOAD_BYTES_PER_HOUR: u64 = 1 << 30;

/// Live (non-tombstoned) KBs one user may own. The local store has one
/// human user, so this bounds the whole store.
pub const OWNED_LIVE_KBS_PER_USER: u32 = 20;
/// KB creations per user per rolling hour.
pub const CREATES_PER_HOUR_PER_USER: u32 = 5;
/// Rolling window of [`CREATES_PER_HOUR_PER_USER`], in seconds.
pub const CREATE_WINDOW_SECS: u64 = 3600;
/// Default and maximum `Page.limit`.
pub const PAGE_DEFAULT: u64 = 20;
pub const PAGE_MAX: u64 = 50;
/// Opaque cursor size cap (UTF-8 bytes) and lifetime.
pub const CURSOR_MAX_BYTES: usize = 1024;
pub const CURSOR_TTL_SECS: u64 = 15 * 60;
/// Encoded response cap for one document read or list page (CONTRACT: 8 MiB
/// encoded response; total overflow fails before sending).
pub const RESPONSE_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Largest asset blob (upload, CAS publication and media sniffing).
pub const ASSET_MAX_BYTES: u64 = 25 * 1024 * 1024;
/// Leave this much measured space after cost-bearing disk reservations.
pub const FREE_DISK_FLOOR_BYTES: u64 = 1024 * 1024 * 1024;
/// Conservative headroom for a fresh registry/WAL/Git metadata write.
pub const WRITE_DISK_RESERVE_BYTES: u64 = 1024 * 1024;

pub const PROVIDERS_PER_USER: u32 = 20;
pub const PROVIDER_REVISIONS_PER_PROVIDER: u32 = 50;
pub const PROVIDER_REVISIONS_PER_USER: u32 = 1000;
pub const PROBES_PER_MINUTE_PER_USER: u32 = 5;
/// Default chunk limit of one index generation (`KB_LIMITS.indexChunksDefault`).
/// Local stores use binary_int8_rescore and have no admin ceiling.
pub const INDEX_CHUNKS_DEFAULT: u64 = 400_000;
/// Measured hard bounds, mirrored from `KB_LIMITS.indexChunkBound`.
pub const INDEX_CHUNK_BOUND_INT8: u64 = 200_000;
pub const INDEX_CHUNK_BOUND_BINARY_INT8_RESCORE: u64 = 400_000;
/// Local binary indexes clamp the base default to their quantization's bound.
pub const INDEX_CHUNKS_LOCAL_DEFAULT: u64 =
    if INDEX_CHUNKS_DEFAULT < INDEX_CHUNK_BOUND_BINARY_INT8_RESCORE {
        INDEX_CHUNKS_DEFAULT
    } else {
        INDEX_CHUNK_BOUND_BINARY_INT8_RESCORE
    };
/// binary_int8_rescore candidate count `K(n) = min(max, max(min, ceil(n / per)))`
/// (`KB_INDEX_RESCORE`).
pub const INDEX_RESCORE_MIN_CANDIDATES: u64 = 200;
pub const INDEX_RESCORE_MAX_CANDIDATES: u64 = 2000;
pub const INDEX_RESCORE_CHUNKS_PER_CANDIDATE: u64 = 200;

/// Effective local limits: each value is at least 1 and at most its local
/// default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalLimits {
    live_kbs: u32,
    creates_per_hour: u32,
    probes_per_minute: u32,
    index_chunks: u64,
}

impl Default for LocalLimits {
    fn default() -> Self {
        LocalLimits {
            live_kbs: OWNED_LIVE_KBS_PER_USER,
            creates_per_hour: LOCAL_CREATES_PER_HOUR,
            probes_per_minute: LOCAL_PROBES_PER_MINUTE,
            index_chunks: INDEX_CHUNKS_LOCAL_DEFAULT,
        }
    }
}

impl LocalLimits {
    /// Opt into lower limits. Zero or anything above the shared constant is
    /// rejected (`INVALID_ARGUMENT`).
    pub fn lowered(live_kbs: u32, creates_per_hour: u32) -> Result<LocalLimits, StoreError> {
        if !(1..=OWNED_LIVE_KBS_PER_USER).contains(&live_kbs)
            || !(1..=LOCAL_CREATES_PER_HOUR).contains(&creates_per_hour)
        {
            return Err(StoreError::InvalidArgument(
                "local limits may only be lowered".into(),
            ));
        }
        Ok(LocalLimits {
            live_kbs,
            creates_per_hour,
            probes_per_minute: LOCAL_PROBES_PER_MINUTE,
            index_chunks: INDEX_CHUNKS_LOCAL_DEFAULT,
        })
    }

    /// Lower the per-generation chunk limit (`1..=INDEX_CHUNKS_LOCAL_DEFAULT`).
    pub fn with_index_chunk_limit(mut self, value: u64) -> Result<Self, StoreError> {
        if !(1..=INDEX_CHUNKS_LOCAL_DEFAULT).contains(&value) {
            return Err(StoreError::InvalidArgument(
                "local limits may only be lowered".into(),
            ));
        }
        self.index_chunks = value;
        Ok(self)
    }
    pub fn index_chunks(&self) -> u64 {
        self.index_chunks
    }

    pub fn with_probe_limit(mut self, value: u32) -> Result<Self, StoreError> {
        if !(1..=LOCAL_PROBES_PER_MINUTE).contains(&value) {
            return Err(StoreError::InvalidArgument(
                "local limits may only be lowered".into(),
            ));
        }
        self.probes_per_minute = value;
        Ok(self)
    }
    pub fn probes_per_minute(&self) -> u32 {
        self.probes_per_minute
    }
    pub fn live_kbs(&self) -> u32 {
        self.live_kbs
    }

    pub fn creates_per_hour(&self) -> u32 {
        self.creates_per_hour
    }
}

/// Page size from an optional request limit (already schema-bounded).
pub(crate) fn page_limit(limit: Option<u64>) -> Result<usize, StoreError> {
    let limit = limit.unwrap_or(PAGE_DEFAULT);
    if !(1..=PAGE_MAX).contains(&limit) {
        return Err(StoreError::InvalidArgument("limit".into()));
    }
    usize::try_from(limit).map_err(|_| StoreError::InvalidArgument("limit".into()))
}

/// Fail before sending when an encoded response exceeds `max` bytes.
/// Pass `serde_json::to_vec(&response)`.
pub(crate) fn check_response_size(
    encoded: Result<Vec<u8>, serde_json::Error>,
    max: usize,
) -> Result<(), StoreError> {
    let bytes = encoded.map_err(|_| StoreError::Internal("response encoding".into()))?;
    if bytes.len() > max {
        return Err(StoreError::InvalidArgument("response too large".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_responses_fail_before_sending() {
        let value = serde_json::json!({ "markdown": "x".repeat(100) });
        assert!(check_response_size(serde_json::to_vec(&value), 1000).is_ok());
        let err = check_response_size(serde_json::to_vec(&value), 50).expect_err("too large");
        assert_eq!(err.protocol_code(), kb_client::ErrorCode::InvalidArgument);
    }

    #[test]
    fn page_limit_defaults_and_bounds() {
        assert_eq!(page_limit(None).ok(), Some(20));
        assert_eq!(page_limit(Some(50)).ok(), Some(50));
        assert!(page_limit(Some(0)).is_err());
        assert!(page_limit(Some(51)).is_err());
    }
}

#[cfg(test)]
mod local_limit_tests {
    #[test]
    fn mutation_window_bound_matches_its_schema_check() {
        let schema = include_str!("db/0001_initial.sql");
        assert!(schema.contains(&format!(
            "json_array_length(times_json)<={})",
            super::LOCAL_MUTATIONS_PER_MINUTE_PER_KB
        )));
    }
}
