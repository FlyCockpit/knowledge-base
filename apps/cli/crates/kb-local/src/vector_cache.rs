//! Build checkpoint (L-1, L-2): one private SQLite file per KB,
//! `indexes/<kbId>/vectors.sqlite`, holding the exact unit vectors of chunks
//! that builds embedded but that are not yet in an active generation file,
//! keyed by `chunk_hash` (SHA-256 of the chunk text) under one profile
//! fingerprint. A build commits every embedded batch here before it moves on,
//! so an attempt cut short by `kb mcp` exiting, its watchdog or a crash resumes
//! where it stopped, and a superseding build of the same KB reuses the work.
//! Only the holder of the KB's build permit opens it; activation removes it
//! (the active file is then the reuse source). Disposable: losing it only
//! costs re-embedding.
//!
//! Lifecycle invariants, all enforced under the KB build permit:
//! 1. Stall accounting resets in the same transaction as committed progress
//!    (`put_batch`): a crash or cancellation after progress can never let
//!    earlier stalls count against later ones.
//! 2. It only holds vectors that resumable semantic work of the KB's current
//!    desired profile can use: each attempt keeps just its own chunk hashes
//!    (`retain`), another profile's file is replaced (`open_profile`), and
//!    `Store::reconcile_checkpoint` removes the file once no semantic
//!    generation is resumable (supersession, revocation, lexical activation,
//!    retention, activation).
use crate::{StoreError, StorePaths, generations::ProfileSnapshot, paths};
use kb_client::types::KbId;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::{fs::OpenOptions, path::PathBuf};

const FILE: &str = "vectors.sqlite";
const SCHEMA: &str = "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS cache_meta(id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, dimensions INTEGER NOT NULL, generation_id TEXT NOT NULL, stalls INTEGER NOT NULL, baseline INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS cache_units(h BLOB PRIMARY KEY CHECK(length(h)=32), u BLOB NOT NULL) STRICT;";

pub(crate) struct VectorCache {
    conn: Connection,
    dimensions: usize,
}

fn path(paths: &StorePaths, kb: &KbId) -> PathBuf {
    paths.index_dir(kb).join(FILE)
}

fn open_file(
    paths: &StorePaths,
    kb: &KbId,
    create: bool,
) -> Result<Option<Connection>, StoreError> {
    // Every caller owns the KB build permit. Retire only proven corruption
    // or a failed checkpoint contract, never busy/I/O/permission/path errors.
    for _ in 0..2 {
        match try_open_file(paths, kb, create) {
            Ok(conn) => return Ok(conn),
            Err(error) if damaged(&error) => {
                // try_open_file has dropped its SQLite connection first.
                VectorCache::remove(paths, kb)?;
                if !create {
                    return Ok(None);
                }
            }
            Err(error) => return Err(error),
        }
    }
    Err(StoreError::IndexUnavailable)
}

fn damaged(error: &StoreError) -> bool {
    match error {
        // Only emitted by the explicit schema/metadata validation below.
        StoreError::IndexUnavailable => true,
        StoreError::Sqlite(error) => matches!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
        ),
        _ => false,
    }
}

fn try_open_file(
    paths: &StorePaths,
    kb: &KbId,
    create: bool,
) -> Result<Option<Connection>, StoreError> {
    let file = path(paths, kb);
    paths.check_no_follow(&file)?;
    paths.check_no_follow(&paths.index_dir(kb).join(format!("{FILE}-journal")))?;
    match paths::open_no_follow(
        &file,
        OpenOptions::new().read(true).write(true).create(create),
    ) {
        Ok(_) => {}
        Err(StoreError::Io(e)) if !create && e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(e) => return Err(e),
    }
    let conn = Connection::open_with_flags(
        &file,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    if !schema_valid(&conn)? {
        return Err(StoreError::IndexUnavailable);
    }
    conn.execute_batch(SCHEMA)?;
    let meta = conn.query_row(
        "SELECT fingerprint,dimensions,generation_id,stalls,baseline FROM cache_meta WHERE id=1",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)),
    ).optional();
    match meta {
        Ok(Some((_, dims, _, stalls, baseline))) if dims <= 0 || stalls < 0 || baseline < 0 => {
            return Err(StoreError::IndexUnavailable);
        }
        Err(rusqlite::Error::InvalidColumnType(..)) => return Err(StoreError::IndexUnavailable),
        other => {
            other?;
        }
    }
    // Exercise the units table at this same recovery boundary too: its root
    // page can be damaged even when the schema and metadata remain readable.
    let _: bool = conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM cache_units)", [], |r| {
        r.get(0)
    })?;
    Ok(Some(conn))
}

/// Missing tables can be created, but an existing object must be the
/// checkpoint table we know how to read. A mismatch proves this derived
/// file is unusable without interpreting arbitrary SQLite error messages.
fn schema_valid(conn: &Connection) -> rusqlite::Result<bool> {
    for (table, columns) in [
        (
            "cache_meta",
            &[
                ("id", "INTEGER", false, 1),
                ("fingerprint", "TEXT", true, 0),
                ("dimensions", "INTEGER", true, 0),
                ("generation_id", "TEXT", true, 0),
                ("stalls", "INTEGER", true, 0),
                ("baseline", "INTEGER", true, 0),
            ][..],
        ),
        (
            "cache_units",
            &[("h", "BLOB", true, 1), ("u", "BLOB", true, 0)][..],
        ),
    ] {
        let kind: Option<String> = conn
            .query_row(
                "SELECT type FROM sqlite_schema WHERE name=?1",
                [table],
                |r| r.get(0),
            )
            .optional()?;
        let Some(kind) = kind else { continue };
        if kind != "table" {
            return Ok(false);
        }
        let strict: bool = conn.query_row(
            "SELECT strict FROM pragma_table_list WHERE schema='main' AND name=?1",
            [table],
            |r| r.get(0),
        )?;
        if !strict {
            return Ok(false);
        }
        let actual = conn
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, i64>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if actual
            .iter()
            .map(|(n, t, required, pk)| (n.as_str(), t.as_str(), *required, *pk))
            .ne(columns.iter().copied())
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `(generation_id, stalls, baseline)` of a checkpoint.
type CacheRecord = (String, i64, i64);
/// Opens the checkpoint of `pin`'s profile: a file of another fingerprint or
/// dimension count is useless, so it is removed whole and started afresh
/// (never an unqualified DELETE). Returns the connection and its meta row
/// `(generation_id, stalls, baseline)` when it belongs to this profile.
fn open_profile(
    paths: &StorePaths,
    kb: &KbId,
    pin: &ProfileSnapshot,
) -> Result<(Connection, Option<CacheRecord>), StoreError> {
    paths.ensure_index_dir(kb)?;
    let dims = i64::try_from(pin.dimensions).map_err(|_| StoreError::IndexUnavailable)?;
    for _ in 0..2 {
        let conn = open_file(paths, kb, true)?.ok_or(StoreError::IndexUnavailable)?;
        let meta: Option<(String, i64, String, i64, i64)> = conn
            .query_row(
                "SELECT fingerprint,dimensions,generation_id,stalls,baseline FROM cache_meta WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let empty: bool =
            conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM cache_units)", [], |r| {
                r.get(0)
            })?;
        match meta {
            Some((f, d, g, stalls, baseline)) if f == pin.fingerprint && d == dims => {
                return Ok((conn, Some((g, stalls, baseline))));
            }
            None if empty => return Ok((conn, None)),
            _ => {
                drop(conn);
                VectorCache::remove(paths, kb)?;
            }
        }
    }
    Err(StoreError::IndexUnavailable)
}

fn unit_bytes(unit: &[f32]) -> Vec<u8> {
    unit.iter().flat_map(|v| v.to_le_bytes()).collect()
}

impl VectorCache {
    /// Opens (creating) the KB's checkpoint for `generation` under `pin`. A
    /// checkpoint of another fingerprint or dimension count is replaced; a new
    /// generation starts with no stalls. The attempt's baseline is the number
    /// of vectors it starts with.
    pub(crate) fn open(
        paths: &StorePaths,
        kb: &KbId,
        generation: &KbId,
        pin: &ProfileSnapshot,
    ) -> Result<Self, StoreError> {
        let (conn, meta) = open_profile(paths, kb, pin)?;
        let dims = i64::try_from(pin.dimensions).map_err(|_| StoreError::IndexUnavailable)?;
        let tx = conn.unchecked_transaction()?;
        let count: i64 = tx.query_row("SELECT count(*) FROM cache_units", [], |r| r.get(0))?;
        if meta
            .as_ref()
            .is_some_and(|(g, ..)| g == generation.as_str())
        {
            tx.execute("UPDATE cache_meta SET baseline=?1 WHERE id=1", [count])?;
        } else {
            tx.execute(
                "INSERT INTO cache_meta VALUES(1,?1,?2,?3,0,?4) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,dimensions=excluded.dimensions,generation_id=excluded.generation_id,stalls=0,baseline=excluded.baseline",
                params![pin.fingerprint, dims, generation.as_str(), count],
            )?;
        }
        tx.commit()?;
        Ok(Self {
            conn,
            dimensions: pin.dimensions,
        })
    }

    pub(crate) fn get(&self, hash: &[u8; 32]) -> Result<Option<Vec<f32>>, StoreError> {
        let raw: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT u FROM cache_units WHERE h=?1",
                [hash.as_slice()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = raw else { return Ok(None) };
        if raw.len() != self.dimensions * 4 {
            return Ok(None);
        }
        Ok(Some(
            raw.as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_le_bytes(*b))
                .collect(),
        ))
    }

    /// Commits one embedded batch durably before the build moves on, and in
    /// the same transaction resets the stall count (invariant 1): committed
    /// progress is the evidence, and it survives a crash or cancellation.
    pub(crate) fn put_batch(&self, rows: &[([u8; 32], &[f32])]) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut put =
                tx.prepare_cached("INSERT OR REPLACE INTO cache_units(h,u) VALUES(?1,?2)")?;
            for (hash, unit) in rows {
                put.execute(params![hash.as_slice(), unit_bytes(unit)])?;
            }
        }
        if !rows.is_empty() {
            tx.execute(
                "UPDATE cache_meta SET stalls=0,baseline=(SELECT count(*) FROM cache_units) WHERE id=1",
                [],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Invariant 2: keep only the vectors of `hashes` (the current
    /// generation's chunks); everything older is obsolete.
    pub(crate) fn retain(&self, hashes: &[[u8; 32]]) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS keep(h BLOB PRIMARY KEY); DELETE FROM temp.keep WHERE true;")?;
        {
            let mut put = tx.prepare_cached("INSERT OR IGNORE INTO temp.keep(h) VALUES(?1)")?;
            for hash in hashes {
                put.execute([hash.as_slice()])?;
            }
        }
        tx.execute(
            "DELETE FROM cache_units WHERE h NOT IN (SELECT h FROM temp.keep)",
            [],
        )?;
        tx.execute(
            "UPDATE cache_meta SET baseline=(SELECT count(*) FROM cache_units) WHERE id=1",
            [],
        )?;
        tx.execute("DELETE FROM temp.keep WHERE true", [])?;
        tx.commit()?;
        Ok(())
    }

    /// The fingerprint and dimensions of an existing checkpoint, if any.
    pub(crate) fn profile_of(
        paths: &StorePaths,
        kb: &KbId,
    ) -> Result<Option<(String, i64)>, StoreError> {
        let Some(conn) = open_file(paths, kb, false)? else {
            return Ok(None);
        };
        Ok(conn
            .query_row(
                "SELECT fingerprint,dimensions FROM cache_meta WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    pub(crate) fn exists(paths: &StorePaths, kb: &KbId) -> bool {
        path(paths, kb).exists()
    }

    /// Bytes one cached vector of this profile takes on disk (admission).
    pub(crate) fn row_bytes(&self) -> u64 {
        (self.dimensions as u64 * 4 + 32) * 14 / 10 + 64
    }

    /// An attempt of `generation` ended without completing. Returns the stall
    /// count after it (persisted here, so it survives process exits): reset
    /// when the attempt embedded anything (or the checkpoint grew), else
    /// incremented. Another profile's or generation's record starts over.
    pub(crate) fn record_attempt(
        paths: &StorePaths,
        kb: &KbId,
        generation: &KbId,
        pin: &ProfileSnapshot,
        progressed: bool,
    ) -> Result<i64, StoreError> {
        let (conn, meta) = open_profile(paths, kb, pin)?;
        let dims = i64::try_from(pin.dimensions).map_err(|_| StoreError::IndexUnavailable)?;
        let tx = conn.unchecked_transaction()?;
        let count: i64 = tx.query_row("SELECT count(*) FROM cache_units", [], |r| r.get(0))?;
        let stalls = match meta {
            Some((g, stalls, baseline)) if g == generation.as_str() => {
                if progressed || count > baseline {
                    0
                } else {
                    stalls.saturating_add(1)
                }
            }
            _ => i64::from(!progressed),
        };
        tx.execute(
            "INSERT INTO cache_meta VALUES(1,?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,dimensions=excluded.dimensions,generation_id=excluded.generation_id,stalls=excluded.stalls,baseline=excluded.baseline",
            params![pin.fingerprint, dims, generation.as_str(), stalls, count],
        )?;
        tx.commit()?;
        Ok(stalls)
    }

    /// The active generation now holds every vector: drop the checkpoint.
    pub(crate) fn remove(paths: &StorePaths, kb: &KbId) -> Result<(), StoreError> {
        let mut removed = false;
        // Check both paths before removing either, including a journal link.
        for suffix in ["", "-journal"] {
            paths.check_no_follow(&paths.index_dir(kb).join(format!("{FILE}{suffix}")))?;
        }
        for suffix in ["", "-journal"] {
            let file = paths.index_dir(kb).join(format!("{FILE}{suffix}"));
            paths.check_no_follow(&file)?;
            match std::fs::remove_file(&file) {
                Ok(()) => removed = true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(StoreError::Io(e)),
            }
        }
        if removed {
            paths::sync_dir(&paths.index_dir(kb))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    #[test]
    fn checkpoint_damage_classification_preserves_storage_failures() {
        for code in [
            rusqlite::ffi::SQLITE_BUSY,
            rusqlite::ffi::SQLITE_LOCKED,
            rusqlite::ffi::SQLITE_IOERR,
            rusqlite::ffi::SQLITE_READONLY,
            rusqlite::ffi::SQLITE_FULL,
            rusqlite::ffi::SQLITE_NOMEM,
            rusqlite::ffi::SQLITE_PERM,
            rusqlite::ffi::SQLITE_CANTOPEN,
            rusqlite::ffi::SQLITE_INTERRUPT,
            rusqlite::ffi::SQLITE_ERROR,
        ] {
            let error = StoreError::Sqlite(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                None,
            ));
            assert!(!damaged(&error), "{code}");
        }
        assert!(!damaged(&StoreError::UnsafePath(
            "unsafe checkpoint".into()
        )));
        assert!(!damaged(&StoreError::Io(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied
        ))));
    }

    #[test]
    fn checkpoint_build_open_replaces_only_proven_damage_and_syncs_removal() {
        let root = std::env::temp_dir().join(format!(
            "kb-checkpoint-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        let store = Store::open(&root).expect("store");
        let kb = KbId::parse(&"k".repeat(24)).expect("kb");
        let generation = KbId::parse(&"g".repeat(24)).expect("generation");
        let paths = store.paths();
        let dir = paths.ensure_index_dir(&kb).expect("index directory");
        let _permit = crate::locks::try_named_model_lock(paths, &format!("index-build-{kb}.lock"))
            .expect("permit")
            .expect("uncontended");
        let pin = ProfileSnapshot {
            provider_id: KbId::parse(&"p".repeat(24)).expect("provider"),
            revision: 1,
            dimensions: 2,
            fingerprint: "fixture".into(),
            model: "fixture".into(),
            name: "fixture".into(),
            builtin: None,
        };
        let neighbor = dir.join("retained.sqlite");
        std::fs::write(&neighbor, b"retained generation").expect("neighbor");
        for malformed_schema in [false, true] {
            if malformed_schema {
                VectorCache::remove(paths, &kb).expect("clear previous checkpoint");
                Connection::open(path(paths, &kb))
                    .expect("sqlite")
                    .execute_batch("CREATE TABLE cache_meta(id INTEGER PRIMARY KEY,wrong TEXT);")
                    .expect("wrong schema");
            } else {
                std::fs::write(path(paths, &kb), b"damaged SQLite header")
                    .expect("corrupt checkpoint");
            }
            std::fs::write(dir.join("vectors.sqlite-journal"), b"").expect("disposable journal");
            paths::take_directory_syncs();
            let cache = VectorCache::open(paths, &kb, &generation, &pin).expect("fresh checkpoint");
            assert_eq!(cache.get(&[1; 32]).expect("empty"), None);
            assert!(paths::take_directory_syncs().contains(&dir));
            cache
                .put_batch(&[([1; 32], &[1.0, 0.0])])
                .expect("re-embedding");
            assert_eq!(cache.get(&[1; 32]).expect("vector"), Some(vec![1.0, 0.0]));
            assert_eq!(
                std::fs::read(&neighbor).expect("neighbor preserved"),
                b"retained generation"
            );
        }
        // A real lock failure must leave the usable checkpoint in place.
        let busy = Connection::open(path(paths, &kb)).expect("checkpoint");
        busy.execute_batch("BEGIN EXCLUSIVE")
            .expect("exclusive writer");
        assert!(matches!(
            VectorCache::profile_of(paths, &kb),
            Err(StoreError::Sqlite(_))
        ));
        assert!(path(paths, &kb).exists());
        busy.execute_batch("ROLLBACK").expect("release writer");
        drop(busy);
        drop(_permit);
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn checkpoint_recovery_refuses_symlinks_including_its_journal() {
        let root = std::env::temp_dir().join(format!(
            "kb-checkpoint-link-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        let store = Store::open(&root).expect("store");
        let paths = store.paths();
        let kb = KbId::parse(&"k".repeat(24)).expect("kb");
        let dir = paths.ensure_index_dir(&kb).expect("index directory");
        let target = dir.join("keep");
        std::fs::write(&target, b"must survive").expect("target");
        for name in [FILE, "vectors.sqlite-journal"] {
            let link = dir.join(name);
            std::os::unix::fs::symlink(&target, &link).expect("link");
            assert!(matches!(
                VectorCache::profile_of(paths, &kb),
                Err(StoreError::UnsafePath(_))
            ));
            assert_eq!(std::fs::read(&target).expect("untouched"), b"must survive");
            std::fs::remove_file(link).expect("remove fixture link");
        }
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }
}
