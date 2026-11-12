//! Shared SQLite index file format v1 and the one TS/Rust quantization spec
//! (`packages/api/src/lib/kb/fixtures/index-format.json`,
//! `index-quantization-cases.json`; TS twin `lib/kb/index-file/format.ts`).
//! DDL is rendered only from validated integers; quantization is pure.
use crate::StoreError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::Read, sync::OnceLock};

const SPEC_JSON: &str =
    include_str!("../../../../../packages/api/src/lib/kb/fixtures/index-format.json");
const CASES_JSON: &str =
    include_str!("../../../../../packages/api/src/lib/kb/fixtures/index-quantization-cases.json");
/// SQLite's 16-byte magic; header bytes 18-19 = 1 is the rollback-journal
/// (non-WAL) file format every published index file must have.
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
pub const MAX_DIMENSIONS: usize = 2000;
/// Calibration sample size target: stride = max(1, ceil(chunkCount / 4096)).
const INT8_CALIBRATION_TARGET: u64 = 4096;
const INT8_CALIBRATION_QUANTILE: f64 = 0.999;
const UNIT_TOLERANCE: f64 = 1e-4;
/// Per-slice KNN depth for vec0 arms (TS `VEC0_SLICE_K`), merged then cut.
pub const VEC0_SLICE_K: u64 = 128;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    format: i64,
    /// The single format every reader accepts.
    readable_formats: Vec<i64>,
    vec_version: String,
    slice_rows: u64,
    pragmas: Vec<String>,
    statements: Vec<String>,
    vector_statements: BTreeMap<String, Vec<String>>,
    /// `meta` of a lexical-only (FTS5) file: null profile columns.
    lexical_meta_statement: String,
    vector_reuse: VectorReuse,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorReuse {
    min_reused_fraction: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cases {
    empty_index_int8_scale: f64,
}

fn spec() -> Result<&'static Spec, StoreError> {
    static SPEC: OnceLock<Option<Spec>> = OnceLock::new();
    SPEC.get_or_init(|| serde_json::from_str(SPEC_JSON).ok())
        .as_ref()
        .ok_or(StoreError::IndexUnavailable)
}

/// Per-generation vector storage, frozen in the job snapshot and file `meta`.
/// The CLI builds every KB as [`IndexQuantization::BinaryInt8Rescore`]; the
/// other is the shared format's server-selectable variant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexQuantization {
    Int8,
    #[default]
    BinaryInt8Rescore,
}
impl IndexQuantization {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Int8 => "int8",
            Self::BinaryInt8Rescore => "binary_int8_rescore",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        [Self::Int8, Self::BinaryInt8Rescore]
            .into_iter()
            .find(|q| q.as_str() == value)
    }
}

pub fn format_version() -> Result<i64, StoreError> {
    Ok(spec()?.format)
}
/// Whether a reader accepts a file of `format`.
pub fn readable_format(format: i64) -> Result<bool, StoreError> {
    Ok(spec()?.readable_formats.contains(&format))
}
/// Whether `conn` holds every table its kind's shared DDL creates (review r2
/// #2): a file missing one opens and passes `quick_check`, yet fails every
/// query on that arm, so it is a broken contract. `meta` is read first
/// (`read_meta`), which fixes `format`.
pub(crate) fn has_required_tables(conn: &Connection, meta: &FileMeta) -> Result<bool, StoreError> {
    let ddl = match (meta.quantization, meta.dimensions) {
        (Some(q), Some(dims)) => render_ddl(q, dims)?,
        _ => render_lexical_ddl()?,
    };
    for sql in &ddl {
        let Some(name) = sql
            .strip_prefix("CREATE VIRTUAL TABLE ")
            .or_else(|| sql.strip_prefix("CREATE TABLE "))
            .and_then(|rest| rest.split(['(', ' ']).next())
        else {
            continue;
        };
        let present: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
            [name],
            |r| r.get(0),
        )?;
        if !present {
            return Ok(false);
        }
    }
    Ok(true)
}
/// A build inherits the active file's int8 scale and copies its vectors
/// only when at least this fraction of its chunks has an unchanged twin there.
pub fn vector_reuse_min_fraction() -> Result<f64, StoreError> {
    Ok(spec()?.vector_reuse.min_reused_fraction)
}
/// `chunk_hash.h` (format 1): SHA-256 of the chunk's stored text, the
/// embedder input, so equal hashes under one fingerprint embed identically.
pub fn chunk_hash(text: &str) -> [u8; 32] {
    let digest = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}
pub fn vec_version() -> Result<&'static str, StoreError> {
    Ok(&spec()?.vec_version)
}
/// `slice = (id - 1) / sliceRows` on every vec0 row.
pub fn slice_of(id: u64) -> Result<u64, StoreError> {
    Ok(id.saturating_sub(1) / spec()?.slice_rows)
}
/// Number of stored vec0 slices of a file with `chunk_count` chunks.
pub fn slice_count(chunk_count: u64) -> Result<u64, StoreError> {
    Ok(chunk_count.div_ceil(spec()?.slice_rows))
}
fn check_dimensions(dims: usize) -> Result<(), StoreError> {
    if (1..=MAX_DIMENSIONS).contains(&dims) {
        Ok(())
    } else {
        Err(StoreError::IndexUnavailable)
    }
}
/// `bit[ceil(dims/8)*8]`: zero pad bits never change a hamming distance.
pub fn bit_dimensions(dims: usize) -> usize {
    dims.div_ceil(8) * 8
}
/// Every writer pragma, in order (page_size first; journal_mode=DELETE, never WAL).
pub(crate) fn writer_pragmas() -> Result<&'static [String], StoreError> {
    Ok(&spec()?.pragmas)
}
/// DDL of one file; `{dims}`/`{bitDims}` substituted only from a validated integer.
pub fn render_ddl(q: IndexQuantization, dims: usize) -> Result<Vec<String>, StoreError> {
    check_dimensions(dims)?;
    let spec = spec()?;
    let vectors = spec
        .vector_statements
        .get(q.as_str())
        .ok_or(StoreError::IndexUnavailable)?;
    let bits = bit_dimensions(dims).to_string();
    Ok(spec
        .statements
        .iter()
        .chain(vectors)
        .map(|sql| {
            sql.replace("{dims}", &dims.to_string())
                .replace("{bitDims}", &bits)
        })
        .collect())
}
/// DDL of a lexical-only (FTS5) file: the shared statements with `meta`
/// replaced by the lexical `meta` and no vector tables (TS `renderLexicalIndexDdl`).
pub fn render_lexical_ddl() -> Result<Vec<String>, StoreError> {
    let spec = spec()?;
    Ok(spec
        .statements
        .iter()
        .map(|sql| {
            if sql.starts_with("CREATE TABLE meta(") {
                spec.lexical_meta_statement.clone()
            } else {
                sql.clone()
            }
        })
        .collect())
}

/// Quantizer input `u = f32(v / ‖v‖₂)`: the norm in f64, every component
/// rounded to f32 (the bytes passed to `vec_f32`). Refuses wrong length,
/// non-finite values and a result whose f64 norm is not 1 within 1e-4.
pub fn unit_vector(raw: &[f64], dims: usize) -> Result<Vec<f32>, StoreError> {
    check_dimensions(dims)?;
    if raw.len() != dims || raw.iter().any(|v| !v.is_finite()) {
        return Err(StoreError::IndexUnavailable);
    }
    let norm = raw.iter().map(|v| v * v).sum::<f64>().sqrt();
    if !norm.is_finite() || norm <= 0. {
        return Err(StoreError::IndexUnavailable);
    }
    let unit = raw.iter().map(|v| (v / norm) as f32).collect::<Vec<_>>();
    let check = unit
        .iter()
        .map(|v| f64::from(*v) * f64::from(*v))
        .sum::<f64>();
    if unit.iter().any(|v| !v.is_finite()) || (check.sqrt() - 1.).abs() > UNIT_TOLERANCE {
        return Err(StoreError::IndexUnavailable);
    }
    Ok(unit)
}
/// Calibration sample ids `r` with `(r - 1) % stride == 0`, ascending.
pub fn calibration_ids(chunk_count: u64) -> Vec<u64> {
    let stride = chunk_count.div_ceil(INT8_CALIBRATION_TARGET).max(1);
    (1..=chunk_count)
        .step_by(usize::try_from(stride).unwrap_or(usize::MAX))
        .collect()
}
/// `values[floor(0.999 * (n - 1))]` of every sampled |u_i|, ascending. A very sparse sample (e.g.
/// one chunk with two non-zero components out of 1,024) has a 0 quantile; the scale then falls
/// back to the sample maximum `values[n - 1]`, which is > 0 for any validated unit vector.
pub fn int8_scale<'a>(samples: impl IntoIterator<Item = &'a [f32]>) -> Result<f64, StoreError> {
    let mut values = samples
        .into_iter()
        .flatten()
        .map(|v| f64::from(v.abs()))
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Err(StoreError::IndexUnavailable);
    }
    values.sort_by(f64::total_cmp);
    let at = (INT8_CALIBRATION_QUANTILE * (values.len() - 1) as f64).floor() as usize;
    let mut scale = values[at.min(values.len() - 1)];
    if scale == 0. {
        scale = values[values.len() - 1];
    }
    if !scale.is_finite() || scale <= 0. {
        return Err(StoreError::IndexUnavailable);
    }
    Ok(scale)
}
/// `meta.int8_scale` of an int8 / binary_int8_rescore file with zero chunks.
pub fn empty_index_int8_scale() -> Result<f64, StoreError> {
    static SCALE: OnceLock<Option<f64>> = OnceLock::new();
    SCALE
        .get_or_init(|| {
            serde_json::from_str::<Cases>(CASES_JSON)
                .ok()
                .map(|c| c.empty_index_int8_scale)
                .filter(|s| s.is_finite() && *s > 0.)
        })
        .ok_or(StoreError::IndexUnavailable)
}
/// `clamp(roundHalfAwayFromZero(u_i * 127 / scale), -127, 127)`.
pub fn quantize_int8(unit: &[f32], scale: f64) -> Result<Vec<i8>, StoreError> {
    if !scale.is_finite() || scale <= 0. {
        return Err(StoreError::IndexUnavailable);
    }
    Ok(unit
        .iter()
        .map(|u| (f64::from(*u) * 127. / scale).round().clamp(-127., 127.) as i8)
        .collect())
}
/// Appends `ceil(dims/8)*8 - dims` zeros.
pub fn pad8(unit: &[f32]) -> Vec<f32> {
    let mut padded = unit.to_vec();
    padded.resize(bit_dimensions(unit.len()), 0.);
    padded
}
/// Bytes `vec_quantize_binary(vec_f32(pad8(u)))` stores: bit i = u_i > 0, LSB first.
pub fn binary_bits(unit: &[f32]) -> Vec<u8> {
    let padded = pad8(unit);
    let mut out = vec![0u8; padded.len() / 8];
    for (i, v) in padded.iter().enumerate() {
        if *v > 0. {
            out[i >> 3] |= 1 << (i & 7);
        }
    }
    out
}
pub fn f32_bytes(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}
pub fn i8_bytes(values: &[i8]) -> Vec<u8> {
    values.iter().map(|v| v.to_le_bytes()[0]).collect()
}
/// Global rescore candidate count for `n` eligible chunks (binary_int8_rescore).
pub fn rescore_k(n: u64) -> u64 {
    use crate::limits::{
        INDEX_RESCORE_CHUNKS_PER_CANDIDATE, INDEX_RESCORE_MAX_CANDIDATES,
        INDEX_RESCORE_MIN_CANDIDATES,
    };
    n.div_ceil(INDEX_RESCORE_CHUNKS_PER_CANDIDATE)
        .clamp(INDEX_RESCORE_MIN_CANDIDATES, INDEX_RESCORE_MAX_CANDIDATES)
}
/// Conservative on-disk vector bytes per chunk (TS `vectorBytesPerChunk`).
pub(crate) fn vector_bytes_per_chunk(q: IndexQuantization, dims: usize) -> u64 {
    let row = |payload: usize| (payload as u64 * 14).div_ceil(10) + 32;
    let dims64 = dims as u64;
    match q {
        IndexQuantization::Int8 => (dims64 * 11).div_ceil(10) + 64,
        IndexQuantization::BinaryInt8Rescore => row(bit_dimensions(dims) / 8) + row(dims),
    }
}

/// Independent of provider batching; at 2000 dimensions holds at most 32 MiB.
pub(crate) const VECTOR_WRITE_BATCH_ROWS: usize = 4096;

/// One buffered vector row: a fresh unit vector, or the stored bytes of an
/// unchanged chunk copied from a file with the same profile and int8 scale
/// Writers accept only these typed rows, each checked against the
/// file's dimensions (review r2 #2).
pub(crate) enum VectorRow {
    Unit(Vec<f32>),
    Stored(StoredVector),
}
/// Stored vector bytes, decoded once and validated: `int8` holds exactly
/// `dims` values and `bits` (binary_int8_rescore only) exactly the padded
/// bit width. Constructed only by [`StoredVector::decode`].
pub(crate) struct StoredVector {
    bits: Option<Vec<u8>>,
    int8: Vec<u8>,
}
impl StoredVector {
    /// The one typed decoding of stored vector bytes at the read/reuse
    /// boundary: a row of another width (a damaged or foreign file) is
    /// refused, so it is embedded again instead of copied on.
    pub(crate) fn decode(
        q: IndexQuantization,
        dims: usize,
        bits: Option<Vec<u8>>,
        int8: Vec<u8>,
    ) -> Result<Self, StoreError> {
        let bits_ok = match (q, &bits) {
            (IndexQuantization::BinaryInt8Rescore, Some(b)) => b.len() == bit_dimensions(dims) / 8,
            (IndexQuantization::Int8, None) => true,
            _ => false,
        };
        if !bits_ok || int8.len() != dims {
            return Err(StoreError::IndexUnavailable);
        }
        Ok(Self { bits, int8 })
    }
}
/// Bounded writer-owned buffer of normalized, embed-once vectors.
pub(crate) struct VectorWriter {
    dims: usize,
    rows: Vec<(u64, VectorRow)>,
}
impl VectorWriter {
    pub(crate) fn new(dims: usize) -> Self {
        Self { dims, rows: vec![] }
    }
    pub(crate) fn append_row(
        &mut self,
        conn: &Connection,
        q: IndexQuantization,
        id: u64,
        row: VectorRow,
        scale: Option<f64>,
    ) -> Result<(), StoreError> {
        let width = match &row {
            VectorRow::Unit(unit) => unit.len(),
            VectorRow::Stored(stored) => stored.int8.len(),
        };
        if width != self.dims {
            return Err(StoreError::IndexUnavailable);
        }
        self.rows.push((id, row));
        if self.rows.len() == VECTOR_WRITE_BATCH_ROWS {
            self.flush(conn, q, scale)?;
        }
        Ok(())
    }

    pub(crate) fn flush(
        &mut self,
        conn: &Connection,
        q: IndexQuantization,
        scale: Option<f64>,
    ) -> Result<(), StoreError> {
        // Text rows precede pass 2 and FTS is rebuilt afterwards. Keep vector tables
        // in long page runs too, regardless of how many rows the provider returns.
        if q == IndexQuantization::BinaryInt8Rescore {
            let mut bits = conn.prepare_cached(
                "INSERT INTO chunk_bits(id,b) VALUES(?1,vec_quantize_binary(vec_f32(?2)))",
            )?;
            let mut stored = conn.prepare_cached("INSERT INTO chunk_bits(id,b) VALUES(?1,?2)")?;
            for (id, row) in &self.rows {
                let rowid = i64::try_from(*id).map_err(|_| StoreError::IndexUnavailable)?;
                match row {
                    VectorRow::Unit(unit) => bits.execute((rowid, f32_bytes(&pad8(unit))))?,
                    VectorRow::Stored(StoredVector {
                        bits: Some(bytes), ..
                    }) => stored.execute((rowid, bytes))?,
                    VectorRow::Stored(StoredVector { bits: None, .. }) => {
                        return Err(StoreError::IndexUnavailable);
                    }
                };
            }
        }
        let sql = match q {
            IndexQuantization::Int8 => {
                "INSERT INTO chunk_vec(rowid,slice,embedding) VALUES(?1,?2,vec_int8(?3))"
            }
            IndexQuantization::BinaryInt8Rescore => "INSERT INTO chunk_int8(id,e) VALUES(?1,?2)",
        };
        let mut int8 = conn.prepare_cached(sql)?;
        for (id, row) in &self.rows {
            let rowid = i64::try_from(*id).map_err(|_| StoreError::IndexUnavailable)?;
            let bytes = match row {
                VectorRow::Unit(unit) => i8_bytes(&quantize_int8(
                    unit,
                    scale.ok_or(StoreError::IndexUnavailable)?,
                )?),
                VectorRow::Stored(StoredVector { int8, .. }) => int8.clone(),
            };
            match q {
                IndexQuantization::Int8 => {
                    let slice =
                        i64::try_from(slice_of(*id)?).map_err(|_| StoreError::IndexUnavailable)?;
                    int8.execute((rowid, slice, bytes))?;
                }
                IndexQuantization::BinaryInt8Rescore => {
                    int8.execute((rowid, bytes))?;
                }
            }
        }
        self.rows.clear();
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn insert_vectors(
    conn: &Connection,
    q: IndexQuantization,
    id: u64,
    unit: &[f32],
    scale: Option<f64>,
) -> Result<(), StoreError> {
    let mut writer = VectorWriter::new(unit.len());
    writer.append_row(conn, q, id, VectorRow::Unit(unit.to_vec()), scale)?;
    writer.flush(conn, q, scale)
}

/// Refuses anything but a SQLite 3 file in rollback-journal format.
/// Review #4: `Ok(false)` for a header that proves the file is not an
/// index (too short, wrong magic or version), `Err` for a failed read.
pub(crate) fn header_valid(file: &mut std::fs::File) -> std::io::Result<bool> {
    let mut header = [0u8; 100];
    match file.read_exact(&mut header) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
        Err(e) => return Err(e),
    }
    Ok(&header[..16] == SQLITE_MAGIC && header[18] == 1 && header[19] == 1)
}
pub(crate) fn check_header(file: &mut std::fs::File) -> Result<(), StoreError> {
    let mut header = [0u8; 100];
    file.read_exact(&mut header)
        .map_err(|_| StoreError::IndexUnavailable)?;
    if &header[..16] != SQLITE_MAGIC || header[18] != 1 || header[19] != 1 {
        return Err(StoreError::IndexUnavailable);
    }
    Ok(())
}

/// The single `meta` row of a file. Profile columns are `None` only in a
/// lexical-only file, which has no vector tables.
#[derive(Clone, Debug, PartialEq)]
pub struct FileMeta {
    pub generation_id: String,
    pub kb_id: String,
    pub commit_sha: String,
    pub fingerprint: Option<String>,
    pub dimensions: Option<usize>,
    pub quantization: Option<IndexQuantization>,
    pub int8_scale: Option<f64>,
    pub document_count: u64,
    pub chunk_count: u64,
    pub host_snapshot: String,
}
/// Reads `meta`; refuses a file with != 1 row, another format or sqlite-vec
/// version, or an int8 scale that contradicts the quantization. `lexical` is
/// the expected generation's kind (TS `readMeta`): a lexical file must have
/// null fingerprint/dimensions/quantization/int8_scale, a hybrid file all four.
pub(crate) fn read_meta(conn: &Connection, lexical: bool) -> Result<FileMeta, StoreError> {
    let mut stmt = conn.prepare("SELECT format,generation_id,kb_id,commit_sha,fingerprint,dimensions,quantization,int8_scale,document_count,chunk_count,vec_version,host_snapshot FROM meta LIMIT 2")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                FileMeta {
                    generation_id: r.get(1)?,
                    kb_id: r.get(2)?,
                    commit_sha: r.get(3)?,
                    fingerprint: r.get(4)?,
                    dimensions: r
                        .get::<_, Option<i64>>(5)?
                        .map(|d| usize::try_from(d).unwrap_or(0)),
                    quantization: None,
                    int8_scale: r.get(7)?,
                    document_count: u64::try_from(r.get::<_, i64>(8)?).unwrap_or(u64::MAX),
                    chunk_count: u64::try_from(r.get::<_, i64>(9)?).unwrap_or(u64::MAX),
                    host_snapshot: r.get(11)?,
                },
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(10)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let [(format, mut meta, quantization, version)] =
        <[_; 1]>::try_from(rows).map_err(|_| StoreError::IndexUnavailable)?;
    let profile = if lexical {
        quantization.is_none()
            && meta.fingerprint.is_none()
            && meta.dimensions.is_none()
            && meta.int8_scale.is_none()
    } else {
        meta.quantization = quantization.as_deref().and_then(IndexQuantization::parse);
        meta.quantization.is_some()
            && meta.fingerprint.is_some()
            && meta.dimensions.is_some()
            && meta.int8_scale.is_some_and(|s| s.is_finite() && s > 0.)
    };
    if !profile
        || !readable_format(format)?
        || !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='chunk_hash')",
            [],
            |r| r.get::<_, bool>(0),
        )?
        || version != vec_version()?
        || meta.document_count == u64::MAX
        || meta.chunk_count == u64::MAX
    {
        return Err(StoreError::IndexUnavailable);
    }
    Ok(meta)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture(name: &str) -> Value {
        serde_json::from_slice(
            &std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../../packages/api/src/lib/kb/fixtures")
                    .join(name),
            )
            .expect("shared fixture"),
        )
        .expect("shared fixture JSON")
    }
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    // Current-thread tests inject only into their own next build connection.
    std::thread_local! {
        static FLUSH_FAILURE: std::cell::Cell<Option<(usize, usize)>> = const { std::cell::Cell::new(None) };
    }
    pub(crate) fn install_flush_failure(conn: &Connection) -> Result<(), StoreError> {
        if let Some((count, fail_id)) = FLUSH_FAILURE.take() {
            // The error marker proves all bits and part of int8 were written before failing.
            conn.execute_batch(&format!(
                "CREATE TRIGGER fail_grouped_flush BEFORE INSERT ON chunk_int8
                 WHEN new.id={fail_id} AND (SELECT count(*) FROM chunk_bits)={count}
                   AND (SELECT count(*) FROM chunk_int8)={previous}
                 BEGIN SELECT RAISE(ABORT, 'injected grouped flush failure'); END",
                previous = fail_id - 1,
            ))?;
        }
        Ok(())
    }

    async fn grouped_flush_failure(count: usize, fail_id: usize) {
        use crate::{CreateKbRequest, Store};
        use kb_client::types::*;
        use std::time::Duration;
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                FLUSH_FAILURE.set(None);
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let root = std::env::temp_dir().join(format!(
            "kb-flush-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        let _cleanup = Cleanup(root.clone());
        let store = Store::open(&root).expect("store");
        let kb = store
            .create_kb(
                &store.owner(),
                CreateKbRequest {
                    name: "Flush tests".into(),
                    slug: "flush-tests".into(),
                    description: "Grouped vector failure fixture".into(),
                    idempotency_key: "create-flush-0001".into(),
                },
            )
            .expect("kb")
            .kb_id;
        let provider = "p".repeat(24);
        store
            .conn
            .execute(
                "INSERT INTO providers(id,name) VALUES(?1,'Fixture')",
                [&provider],
            )
            .expect("provider");
        store.conn.execute("INSERT INTO provider_revisions(provider_id,revision,endpoint_url,model,dimensions,fingerprint,state) VALUES(?1,1,'https://example.invalid/embeddings','fixture',8,?2,'READY')", (&provider, format!("sha256:{}", "a".repeat(64)))).expect("revision");
        store.conn.execute("INSERT INTO provider_registrations(operation_id,idempotency_key,request_mac,provider_id,revision) VALUES(?1,'fixture-register-0001',zeroblob(32),?2,1)",(store.owner().id(), &provider)).expect("registration");
        let job = store.embedding_profile_set(&store.owner(), serde_json::from_value(serde_json::json!({
            "kbId":kb, "providerId":provider, "revision":1, "idempotencyKey":"profile-flush-0001", "confirm":"RUN"
        })).expect("input")).expect("profile");
        // A semantic build waits for its lexical companion (every head
        // that nothing of its commit serves yet gets one).
        let settle_companion = async || {
            let companion: String = store
                .conn
                .query_row(
                    "SELECT id FROM index_generations WHERE kb_id=?1 AND state='PENDING' AND json_type(snapshot_json,'$.profile') IS NOT 'object'",
                    [kb.as_str()],
                    |r| r.get(0),
                )
                .expect("companion");
            let companion = KbId::parse(&companion).expect("id");
            let lexical = store
                .build_generation(
                    store
                        .claim_generation(&companion, Duration::from_secs(120))
                        .expect("companion claim"),
                    async |_, _| -> Result<Vec<Vec<f64>>, StoreError> { panic!("lexical") },
                    &mut |_| Ok(()),
                )
                .await
                .expect("companion");
            store.activate_built(lexical).expect("companion activation");
            companion
        };
        let first = settle_companion().await;
        assert_eq!(
            store.kb(&kb).expect("kb").expect("kb").active_generation_id,
            Some(first)
        );
        let old = store
            .build_generation(
                store
                    .claim_generation(&job.generation_id, Duration::from_secs(120))
                    .expect("claim"),
                async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
                &mut |_| Ok(()),
            )
            .await
            .expect("previous build");
        assert!(store.activate_built(old).expect("activate"));
        let old_path = store.paths.index_file(&kb, &job.generation_id);
        let old_bytes = std::fs::read(&old_path).expect("previous file");
        let head = Sha::parse(
            &store
                .kb(&kb)
                .expect("kb")
                .expect("kb")
                .head_sha
                .expect("head"),
        )
        .expect("sha");
        let changes = (0..8)
            .map(|i| {
                let n = if i == 7 { count - 7 * 512 } else { 512 };
                // Distinct words: every chunk text differs, so none is reused.
                let body = (0..400 + (n - 1) * 320)
                    .map(|k| format!("w{i}x{k} "))
                    .collect::<String>();
                assert_eq!(crate::chunk::chunk_body(&body).chunks.len(), n);
                crate::FileChange {
                    // Replace the seeded index.md so the total is exactly `count`.
                    path: if i == 7 {
                        "index.md".into()
                    } else {
                        format!("d{i:02}.md")
                    },
                    content: Some(body.into_bytes()),
                }
            })
            .collect();
        store
            .commit_files(
                &store.owner(),
                crate::CommitRequest {
                    kb: kb.clone(),
                    base_revision: head,
                    idempotency_key: "publish-flush-0001".into(),
                    changes,
                },
            )
            .expect("publish source");
        let failed = store
            .index_status_get(&store.owner(), KbRef { kb_id: kb.clone() })
            .expect("status")
            .desired_generation_id
            .expect("desired");
        // Lexical@head serves the new head as soon as it completes.
        let covering = settle_companion().await;
        assert_eq!(
            store.kb(&kb).expect("kb").expect("kb").active_generation_id,
            Some(covering.clone())
        );
        let attempt = store
            .claim_generation(&failed, Duration::from_secs(120))
            .expect("claim");
        FLUSH_FAILURE.set(Some((count, fail_id)));
        let mut rows_finished = false;
        let mut reserved = false;
        let mut embedded = 0;
        let result = store
            .build_generation(
                attempt,
                async |pin, texts| {
                    embedded += texts.len();
                    reserved |= store
                        .conn
                        .query_row(
                            "SELECT reserved_bytes>0 FROM index_generations WHERE id=?1",
                            [failed.as_str()],
                            |r| r.get::<_, bool>(0),
                        )
                        .expect("reservation");
                    Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
                },
                &mut |stage| {
                    // Reuse examination precedes the rows; only later stages count.
                    rows_finished |= stage != crate::index::BuildStage::ReuseCandidate;
                    Ok(())
                },
            )
            .await;
        let error = result
            .err()
            .expect("failed attempt cannot produce a publish capability");
        assert!(
            error.to_string().contains("injected grouped flush failure"),
            "{error}"
        );
        assert!(reserved);
        assert_eq!(
            embedded, count,
            "the fixture reaches the intended batch boundary"
        );
        assert!(
            !rows_finished,
            "failure precedes finalization/fsync/completion"
        );
        assert!(!store.paths.index_file(&kb, &failed).exists());
        // semantic@head failed: the companion keeps serving.
        drop(store.lock_write(&[]).expect("recovery"));
        assert_eq!(
            store.kb(&kb).expect("kb").expect("kb").active_generation_id,
            Some(covering.clone())
        );
        let ledger: (String, i64, i64) = store
            .conn
            .query_row(
                "SELECT state,reserved_bytes,reclaimed FROM index_generations WHERE id=?1",
                [failed.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("ledger");
        assert_eq!(ledger, ("FAILED".into(), 0, 0));
        let temp = store.paths.index_temp_file(&kb, &failed);
        let db = Connection::open_with_flags(&temp, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("retained attempt");
        for table in ["chunks", "chunk_bits", "chunk_int8", "meta"] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .expect("rolled back"),
                0
            );
        }
        drop(db);
        let leftovers = || {
            std::fs::read_dir(store.paths.index_dir(&kb))
                .expect("index dir")
                .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with(failed.as_str()))
                .collect::<Vec<_>>()
        };
        assert!(leftovers().contains(&format!("{failed}.tmp")));
        for name in leftovers() {
            assert!(
                [
                    format!("{failed}.tmp"),
                    format!("{failed}.tmp-journal"),
                    format!("{failed}.sqlite.cancel")
                ]
                .contains(&name)
            );
        }
        assert_eq!(
            store
                .sweep_generations(store.now_ms())
                .expect("early sweep"),
            0
        );
        assert!(
            temp.exists(),
            "failed files remain through the one-day retention period"
        );
        assert_eq!(
            store
                .sweep_generations(store.now_ms() + 86_400_001)
                .expect("retention"),
            1
        );
        assert!(leftovers().is_empty());
        assert_eq!(std::fs::read(old_path).expect("previous file"), old_bytes);
        let lease = store
            .lease_active_generation(&store.owner(), &kb)
            .expect("the serving generation remains readable");
        assert_eq!(lease.snapshot.id, covering);
    }

    #[tokio::test]
    async fn sqlite_failure_inside_full_grouped_flush_cannot_publish() {
        grouped_flush_failure(4096, 2048).await;
    }
    #[tokio::test]
    async fn sqlite_failure_inside_final_partial_grouped_flush_cannot_publish() {
        grouped_flush_failure(4099, 4098).await;
    }

    #[test]
    fn writer_batches_cluster_vector_leaves_independently_of_provider_batches() {
        crate::sqlite_vec::register().expect("sqlite-vec");
        let ts = include_str!("../../../../../packages/api/src/lib/kb/index-file/writer.ts");
        assert!(ts.contains(&format!(
            "VECTOR_WRITE_BATCH_ROWS = {VECTOR_WRITE_BATCH_ROWS};"
        )));
        for provider_batch in [1, 32, 777] {
            let db = Connection::open_in_memory().expect("SQLite");
            for pragma in writer_pragmas().expect("pragmas") {
                db.execute_batch(pragma).expect("pragma");
            }
            let q = IndexQuantization::BinaryInt8Rescore;
            for ddl in render_ddl(q, 256).expect("DDL") {
                db.execute_batch(&ddl).expect("DDL");
            }
            let scale = Some(1. / 16.);
            let mut writer = VectorWriter::new(256);
            let count = 20_537u64;
            let tx = db.unchecked_transaction().expect("transaction");
            for first in (1..=count).step_by(provider_batch) {
                for id in first..=(first + provider_batch as u64 - 1).min(count) {
                    writer
                        .append_row(&tx, q, id, VectorRow::Unit(vec![1. / 16.; 256]), scale)
                        .expect("vector");
                    assert!(writer.rows.len() < VECTOR_WRITE_BATCH_ROWS);
                }
            }
            writer.flush(&tx, q, scale).expect("partial final batch");
            tx.commit().expect("commit");
            for (table, column, bytes, byte) in
                [("chunk_bits", "b", 32, 255), ("chunk_int8", "e", 256, 127)]
            {
                let leaves = db
                    .prepare(
                        "SELECT pageno FROM dbstat WHERE name=?1 AND pagetype='leaf' ORDER BY path",
                    )
                    .expect("dbstat")
                    .query_map([table], |r| r.get::<_, i64>(0))
                    .expect("leaves")
                    .collect::<Result<Vec<_>, _>>()
                    .expect("pages");
                assert!(leaves.len() > 100);
                let consecutive = leaves
                    .windows(2)
                    .filter(|pair| pair[1] == pair[0] + 1)
                    .count();
                let fraction = consecutive as f64 / (leaves.len() - 1) as f64;
                assert!(fraction >= 0.95, "{table}: {fraction}");
                let n: i64 = db
                    .query_row(
                        &format!("SELECT count(*) FROM {table} WHERE length({column})=?1"),
                        [bytes as i64],
                        |r| r.get(0),
                    )
                    .expect("count");
                assert_eq!(n, count as i64);
                for id in [1, 4096, 4097, count] {
                    let stored: Vec<u8> = db
                        .query_row(
                            &format!("SELECT {column} FROM {table} WHERE id=?1"),
                            [id as i64],
                            |r| r.get(0),
                        )
                        .expect("row");
                    assert_eq!(stored, vec![byte; bytes as usize]);
                }
            }
        }
    }

    #[test]
    fn shared_quantization_cases_match_bit_for_bit() {
        let cases = fixture("index-quantization-cases.json");
        assert_eq!(
            empty_index_int8_scale().expect("scale"),
            cases["emptyIndexInt8Scale"].as_f64().expect("scale")
        );
        crate::sqlite_vec::register().expect("sqlite-vec");
        let db = Connection::open_in_memory().expect("SQLite");
        let mut seen_pad = false;
        for case in cases["cases"].as_array().expect("cases") {
            let dims = case["dims"].as_u64().expect("dims") as usize;
            seen_pad |= !dims.is_multiple_of(8);
            let units = case["vectors"]
                .as_array()
                .expect("vectors")
                .iter()
                .map(|v| {
                    let raw = v
                        .as_array()
                        .expect("vector")
                        .iter()
                        .map(|x| x.as_f64().expect("number"))
                        .collect::<Vec<_>>();
                    unit_vector(&raw, dims).expect("unit")
                })
                .collect::<Vec<_>>();
            let name = case["name"].as_str().expect("name");
            for (i, unit) in units.iter().enumerate() {
                assert_eq!(
                    hex(&f32_bytes(unit)),
                    case["unitF32LeHex"][i].as_str().expect("hex"),
                    "{name} unit {i}"
                );
            }
            let scale = int8_scale(units.iter().map(Vec::as_slice)).expect("scale");
            assert_eq!(scale, case["int8Scale"].as_f64().expect("scale"), "{name}");
            for (i, unit) in units.iter().enumerate() {
                let q = quantize_int8(unit, scale).expect("int8");
                let expected = case["int8"][i]
                    .as_array()
                    .expect("int8")
                    .iter()
                    .map(|x| x.as_i64().expect("int") as i8)
                    .collect::<Vec<_>>();
                assert_eq!(q, expected, "{name} int8 {i}");
                let bits = binary_bits(unit);
                assert_eq!(
                    hex(&bits),
                    case["bitsHex"][i].as_str().expect("hex"),
                    "{name} bits {i}"
                );
                // The writer stores sqlite-vec's own quantizer output: identical bytes.
                let stored: Vec<u8> = db
                    .query_row(
                        "SELECT vec_quantize_binary(vec_f32(?1))",
                        [f32_bytes(&pad8(unit))],
                        |r| r.get(0),
                    )
                    .expect("vec_quantize_binary");
                assert_eq!(stored, bits, "{name} sqlite-vec bits {i}");
            }
        }
        assert!(seen_pad, "the corpus covers a dims % 8 != 0 case");
    }

    #[test]
    fn reader_constants_match_the_ts_reader() {
        let format = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../packages/api/src/lib/kb/index-file/format.ts"),
        )
        .expect("format.ts");
        assert!(format.contains(&format!("VEC0_SLICE_K = {VEC0_SLICE_K};")));
        assert_eq!(slice_count(0).expect("slices"), 0);
        assert_eq!(slice_count(65_536).expect("slices"), 1);
        assert_eq!(slice_count(65_537).expect("slices"), 2);
        assert_eq!(slice_of(65_537).expect("slice"), 1);
    }

    #[test]
    fn calibration_rescore_and_unit_validation() {
        assert_eq!(calibration_ids(0), Vec::<u64>::new());
        assert_eq!(calibration_ids(3), vec![1, 2, 3]);
        assert_eq!(calibration_ids(4096).len(), 4096);
        let ids = calibration_ids(4097);
        assert_eq!(&ids[..3], &[1, 3, 5]);
        assert!(ids.len() <= 4096);
        assert_eq!(rescore_k(0), 200);
        assert_eq!(rescore_k(1), 200);
        assert_eq!(rescore_k(40_000), 200);
        assert_eq!(rescore_k(40_001), 201);
        assert_eq!(rescore_k(80_000), 400);
        assert_eq!(rescore_k(200_000), 1000);
        assert_eq!(rescore_k(399_800), 1999);
        assert_eq!(rescore_k(399_801), 2000);
        assert_eq!(rescore_k(400_000), 2000);
        assert_eq!(rescore_k(400_001), 2000);
        assert_eq!(rescore_k(10_000_000), 2000);
        assert!(unit_vector(&[1.], 2).is_err());
        assert!(unit_vector(&[0., 0.], 2).is_err());
        assert!(unit_vector(&[f64::NAN, 1.], 2).is_err());
        assert!(unit_vector(&[1.; 2001], 2001).is_err());
        assert!(int8_scale(std::iter::empty()).is_err());
        assert!(int8_scale([[0f32, 0.].as_slice()]).is_err());
        let mut sparse = vec![0.; 1024];
        sparse[0] = 3.;
        sparse[1000] = -4.;
        let sparse = unit_vector(&sparse, 1024).expect("unit");
        assert_eq!(
            int8_scale([sparse.as_slice()]).expect("max fallback"),
            f64::from(0.8f32)
        );
        assert_eq!(bit_dimensions(12), 16);
        assert_eq!(bit_dimensions(1024), 1024);
    }

    #[test]
    fn float32_quantization_is_unsupported_in_snapshots_and_files() {
        assert_eq!(IndexQuantization::parse("float32"), None);
        assert!(serde_json::from_str::<IndexQuantization>(r#""float32""#).is_err());
        let db = Connection::open_in_memory().expect("SQLite");
        // An external file can carry a quantization the writer never emits.
        db.execute_batch("CREATE TABLE meta(format,generation_id,kb_id,commit_sha,fingerprint,dimensions,quantization,int8_scale,document_count,chunk_count,vec_version,host_snapshot)").expect("meta");
        for scale in [None, Some(1.)] {
            db.execute(
                "INSERT INTO meta VALUES(1,'g','k','c','f',8,'float32',?1,0,0,?2,'{}')",
                (scale, vec_version().expect("version")),
            )
            .expect("row");
            assert!(matches!(
                read_meta(&db, false),
                Err(StoreError::IndexUnavailable)
            ));
            db.execute("DELETE FROM meta WHERE quantization='float32'", [])
                .expect("clear fixture");
        }
    }

    #[test]
    fn lexical_meta_has_null_profile_columns_and_pairs_with_the_generation_kind() {
        crate::sqlite_vec::register().expect("sqlite-vec");
        let spec = fixture("index-format.json");
        let lexical = render_lexical_ddl().expect("lexical DDL");
        let shared = spec["statements"].as_array().expect("statements");
        assert_eq!(lexical.len(), shared.len());
        assert!(
            lexical.contains(
                &spec["lexicalMetaStatement"]
                    .as_str()
                    .expect("lexical meta")
                    .to_owned()
            )
        );
        assert!(lexical.iter().all(|sql| !sql.contains("chunk_vec")
            && !sql.contains("chunk_bits")
            && !sql.contains("chunk_int8")));
        let version = vec_version().expect("version");
        let lexical_db = Connection::open_in_memory().expect("SQLite");
        for sql in &lexical {
            lexical_db.execute_batch(sql).expect("lexical DDL");
        }
        // The DDL itself refuses profile columns in a lexical file.
        assert!(
            lexical_db
                .execute(
                    "INSERT INTO meta VALUES(1,'g','k','c','f',NULL,NULL,NULL,0,0,?1,'{}')",
                    [version],
                )
                .is_err()
        );
        lexical_db
            .execute(
                "INSERT INTO meta VALUES(1,'g','k','c',NULL,NULL,NULL,NULL,2,3,?1,'{}')",
                [version],
            )
            .expect("lexical meta row");
        let meta = read_meta(&lexical_db, true).expect("lexical reader");
        assert_eq!(
            (
                meta.fingerprint,
                meta.dimensions,
                meta.quantization,
                meta.int8_scale
            ),
            (None, None, None, None)
        );
        assert_eq!((meta.document_count, meta.chunk_count), (2, 3));
        assert!(matches!(
            read_meta(&lexical_db, false),
            Err(StoreError::IndexUnavailable)
        ));
        let hybrid_db = Connection::open_in_memory().expect("SQLite");
        for sql in render_ddl(IndexQuantization::BinaryInt8Rescore, 8).expect("DDL") {
            hybrid_db.execute_batch(&sql).expect("hybrid DDL");
        }
        hybrid_db
            .execute(
                "INSERT INTO meta VALUES(1,'g','k','c','f',8,'binary_int8_rescore',0.5,0,0,?1,'{}')",
                [version],
            )
            .expect("hybrid meta row");
        let meta = read_meta(&hybrid_db, false).expect("hybrid reader");
        assert!(has_required_tables(&hybrid_db, &meta).expect("current layout"));
        hybrid_db
            .execute_batch("ALTER TABLE chunk_hash RENAME TO absent_chunk_hash")
            .expect("model a missing required table");
        assert!(!has_required_tables(&hybrid_db, &meta).expect("incomplete layout"));
        assert!(matches!(
            read_meta(&hybrid_db, false),
            Err(StoreError::IndexUnavailable)
        ));
        assert_eq!(
            meta.quantization,
            Some(IndexQuantization::BinaryInt8Rescore)
        );
        assert!(matches!(
            read_meta(&hybrid_db, true),
            Err(StoreError::IndexUnavailable)
        ));
    }

    /// Format 1 includes `chunk_hash` (SHA-256 of the stored chunk text);
    /// the TS twin runs the same cases.
    #[test]
    fn chunk_hash_cases_and_readable_formats_match_the_shared_spec() {
        let cases = fixture("index-quantization-cases.json");
        for case in cases["chunkHashCases"].as_array().expect("cases") {
            assert_eq!(
                hex(&chunk_hash(case["text"].as_str().expect("text"))),
                case["sha256Hex"].as_str().expect("hash")
            );
        }
        let spec = fixture("index-format.json");
        assert_eq!(format_version().expect("format"), 1);
        assert!(readable_format(1).expect("format"));
        assert!(!readable_format(2).expect("unsupported format"));
        assert!(!readable_format(3).expect("v3"));
        assert_eq!(
            vector_reuse_min_fraction().expect("fraction"),
            spec["vectorReuse"]["minReusedFraction"]
                .as_f64()
                .expect("fraction")
        );
        assert!(
            render_ddl(IndexQuantization::BinaryInt8Rescore, 8)
                .expect("DDL")
                .iter()
                .any(|sql| sql.starts_with("CREATE TABLE chunk_hash("))
        );
    }

    #[test]
    fn ddl_renders_every_quantization_from_the_shared_spec() {
        crate::sqlite_vec::register().expect("sqlite-vec");
        for q in [
            IndexQuantization::Int8,
            IndexQuantization::BinaryInt8Rescore,
        ] {
            assert_eq!(IndexQuantization::parse(q.as_str()), Some(q));
            assert_eq!(
                serde_json::to_value(q).expect("serialize"),
                Value::String(q.as_str().into())
            );
            let db = Connection::open_in_memory().expect("SQLite");
            for sql in render_ddl(q, 12).expect("ddl") {
                assert!(!sql.contains('{'), "{sql}");
                db.execute_batch(&sql).expect("shared DDL");
            }
        }
        assert!(render_ddl(IndexQuantization::Int8, 0).is_err());
        assert!(render_ddl(IndexQuantization::Int8, 2001).is_err());
        assert_eq!(
            writer_pragmas().expect("pragmas")[0],
            "PRAGMA page_size=4096"
        );
    }
}
