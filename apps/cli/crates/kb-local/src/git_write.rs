//! Hardened, lock-owned Git object and ref writes for local publication.
//!
//! * Every child, including ref reads and validation readers, uses
//!   GitRepo's hardened spawn boundary and inherits its held store lock on
//!   an extra fd (Unix) or explicit handle list + Job Object (Windows).
//!   Stdin remains available for ordinary Git protocols. Publication content
//!   still uses private scratch files and fixed arguments.
//! * Objects written by an operation are fsynced (file, fan-out directory,
//!   `objects/`) before the journal records COMMITTING; the single ref move
//!   is `update-ref <ref> <new> <expected-old>` (compare-and-swap, zero OID
//!   = must not exist) followed by a directory fsync.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kb_client::types::{KbPath, Sha, Uuid};

use crate::StoreError;
use crate::git_read::{EntryKind, GitError, GitRepo, IncomingBudget, WalkBudget, walk_tree};
use crate::locks::WriteGuard;
use crate::paths::{StorePaths, create_dir_exclusive, sync_dir};
use crate::tree::TREE_LIMITS;

pub(crate) const MAIN_REF: &str = "refs/heads/main";
const ZERO_OID: &str = "0000000000000000000000000000000000000000";
/// Fixed server identity for direct commits.
const COMMITTER_NAME: &str = "kb";
const COMMITTER_EMAIL: &str = "kb@local.invalid";

fn failed(what: &str) -> StoreError {
    StoreError::StorageUnavailable(format!("git {what} failed"))
}

fn sha_from(out: &[u8], what: &str) -> Result<Sha, StoreError> {
    let text = std::str::from_utf8(out).map_err(|_| failed(what))?.trim();
    Sha::parse(text).map_err(|_| failed(what))
}

/// Run a mutating child through the universal lock handoff boundary.
fn run_locked(
    repo: &GitRepo,
    guard: &WriteGuard,
    command: std::process::Command,
    what: &str,
) -> Result<Vec<u8>, StoreError> {
    let _ = guard; // GitRepo's spawn boundary attaches this repo's held store lock.
    let (ok, out) = repo.run_command(command, 4096)?;
    if !ok {
        return Err(failed(what));
    }
    Ok(out)
}

// ── Scratch files ──────────────────────────────────────────────────────────

/// Owner-only per-operation scratch directory; removed on drop.
pub(crate) struct Scratch {
    dir: PathBuf,
    next: usize,
    paths: StorePaths,
}

impl Scratch {
    pub(crate) fn dir_for(paths: &StorePaths, op: &Uuid) -> PathBuf {
        paths.uploads_dir().join(format!("publish-{op}"))
    }

    pub(crate) fn new(paths: &StorePaths, op: &Uuid) -> Result<Scratch, StoreError> {
        let dir = Self::dir_for(paths, op);
        remove_scratch(paths, op);
        create_dir_exclusive(paths, &dir)?;
        Ok(Scratch {
            dir,
            next: 0,
            paths: paths.clone(),
        })
    }

    /// A disposable object store inside this scratch directory (removed with
    /// it): see [`GitRepo::staged`].
    pub(crate) fn objects_dir(&self) -> Result<PathBuf, StoreError> {
        let objects = self.dir.join("objects");
        if !objects.exists() {
            create_dir_exclusive(&self.paths, &objects)?;
        }
        Ok(objects)
    }

    /// Write `bytes` to a fresh file and return its generated basename.
    /// Git must open it relative to `dir`: Windows canonical paths include a
    /// verbatim prefix whose `?` Git's NTFS filename validation rejects.
    fn file(&mut self, bytes: &[u8]) -> Result<PathBuf, StoreError> {
        self.next += 1;
        let name = PathBuf::from(format!("f{}", self.next));
        let path = self.dir.join(&name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = crate::paths::open_no_follow(&path, &mut options)?;
        std::io::Write::write_all(&mut file, bytes).map_err(StoreError::Io)?;
        Ok(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Best-effort removal of a crashed operation's scratch directory.
pub(crate) fn remove_scratch(paths: &StorePaths, op: &Uuid) {
    let dir = Scratch::dir_for(paths, op);
    if paths.check_no_follow(&dir).is_ok() {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The caller owns the store fence after every former Git descendant has
/// drained. No live publisher can own scratch here, even before PREPARED.
pub(crate) fn recover_scratch(
    paths: &StorePaths,
    conn: &rusqlite::Connection,
) -> Result<(), StoreError> {
    let mut removed = false;
    let result: Result<(), StoreError> = (|| {
        for entry in std::fs::read_dir(paths.uploads_dir()).map_err(StoreError::Io)? {
            crate::git_read::OperationDeadline::check()?;
            let entry = entry.map_err(StoreError::Io)?;
            let name = entry.file_name();
            let Some(op) = name.to_str().and_then(|n| n.strip_prefix("publish-")) else {
                continue;
            };
            if Uuid::parse(op).is_err() {
                continue;
            }
            let dir = entry.path();
            paths.check_no_follow(&dir)?;
            if entry.file_type().map_err(StoreError::Io)?.is_dir() {
                std::fs::remove_dir_all(dir).map_err(StoreError::Io)?;
                removed = true;
            }
        }
        Ok(())
    })();
    // Only deleted top-level entries change uploads. Fence completed removals
    // even on a later error/deadline. Scratch has no durable references: a crash
    // during recursive deletion may leave partial scratch for the next sweep;
    // once its directory is removed, this parent fence makes that durable.
    if removed {
        sync_dir(&paths.uploads_dir())?;
    }
    result?;
    recover_unindexed_packs(paths, conn)
}

/// A crash between the pack and index links can leave a complete, invisible
/// pack. Publication journals cannot reference it: both files are durable
/// before PREPARED. Rollup retirement intent owns any index-first leftovers.
/// Called only under the drained store fence, alongside scratch recovery.
fn recover_unindexed_packs(
    paths: &StorePaths,
    conn: &rusqlite::Connection,
) -> Result<(), StoreError> {
    for entry in std::fs::read_dir(paths.root().join("repos")).map_err(StoreError::Io)? {
        crate::git_read::OperationDeadline::check()?;
        let entry = entry.map_err(StoreError::Io)?;
        let name = entry.file_name();
        let Some(kb) = name
            .to_str()
            .and_then(|n| n.strip_prefix("kb_"))
            .and_then(|n| n.strip_suffix(".git"))
            .and_then(|n| kb_client::types::KbId::parse(n).ok())
        else {
            continue;
        };
        let packs = paths.repo_dir(&kb).join("objects/pack");
        paths.check_no_follow(&packs)?;
        let entries = match std::fs::read_dir(&packs) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(StoreError::Io(e)),
        };
        let mut removed = false;
        for entry in entries {
            crate::git_read::OperationDeadline::check()?;
            let entry = entry.map_err(StoreError::Io)?;
            let name = entry.file_name();
            let Some(hash) = name
                .to_str()
                .and_then(|n| n.strip_prefix("pack-"))
                .and_then(|n| n.strip_suffix(".pack"))
            else {
                continue;
            };
            if Sha::parse(hash).is_err() {
                continue;
            }
            let pack = entry.path();
            let index = pack.with_extension("idx");
            paths.check_no_follow(&pack)?;
            paths.check_no_follow(&index)?;
            if !index.exists() {
                // An index-first retirement still belongs to its durable intent,
                // including back-off after a blocked data unlink. Orphan recovery
                // must not retry that removal outside maintenance admission.
                let owed: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM pack_cleanup_entries WHERE kb_id=?1 AND kind='pack' AND name=?2)",
                    rusqlite::params![kb.as_str(), hash], |r| r.get(0))?;
                if !owed {
                    removed |= remove_pack_file(&pack)?;
                }
            }
        }
        if removed {
            sync_dir(&packs)?;
        }
    }
    Ok(())
}

// ── Object consolidation ───────────────────────────────────────────────────

/// Every publication installs one pack and Git's own maintenance (auto-gc,
/// multi-pack index, repack) is disabled, so a publication's lock
/// acquisition rolls the repository's small packs up instead (geometric,
/// like Git's `repack --geometric=2`). At this many unfrozen packs a
/// rollup is due.
pub(crate) const CONSOLIDATE_PACKS: usize = 8;
/// Loose objects (direct writes, aborted operations) are sampled like Git's
/// `gc.auto`: this many in `objects/17` estimates ~6,900 in the repository.
pub(crate) const CONSOLIDATE_LOOSE_SAMPLE: usize = 27;
/// Most bytes (packs plus loose objects) one rollup reads and writes, so a
/// pass costs the same whatever the repository's size. Retry back-off never
/// shrinks this cap: two unfrozen packs always fit, and cap-truncated folds
/// still cross the frozen threshold, preserving progress and amplification.
pub(crate) const CONSOLIDATE_MAX_BYTES: u64 = 32 << 20;
/// Packs of at least this size are frozen: never rolled up again and not
/// counted toward a due rollup.
///
/// Write amplification is bounded by construction. In every rollup the
/// largest folded pack meets at least as many bytes as it holds (the
/// geometric split folds the pack above the broken progression too) and a
/// cascaded pack at least half its size, so each rewrite multiplies the
/// pack holding a byte by at least 1.5; a rollup the cap truncates holds
/// more than half the cap and is frozen. A byte is therefore rewritten at
/// most `log1.5(CONSOLIDATE_FROZEN_BYTES / write) + 1` times (about 23 for
/// 2 KiB writes; the simulation test measures single digits).
pub(crate) const CONSOLIDATE_FROZEN_BYTES: u64 = CONSOLIDATE_MAX_BYTES / 2;
/// Most loose objects one rollup folds.
const CONSOLIDATE_MAX_LOOSE: usize = 20_000;
/// Bound tiny-pack selection independently of bytes. No pairwise discovery.
pub(crate) const CONSOLIDATE_MAX_PACKS: usize = 128;
/// Exact retirement entries visited per pass, independent of repository size.
pub(crate) const CLEANUP_BATCH: usize = 256;
/// Wall-clock budget of one pass, well under the five-second lock admission
/// every other actor waits while this pass holds the store fence.
pub(crate) const CONSOLIDATE_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// One indexed pack: its name and data size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PackFile {
    pub(crate) hash: String,
    pub(crate) bytes: u64,
}

/// What decides whether a rollup is due: the unfrozen indexed packs
/// (smallest first) and the loose-object sample.
pub(crate) struct Pressure {
    pub(crate) packs: Vec<PackFile>,
    pub(crate) loose_sample: usize,
}

impl Pressure {
    pub(crate) fn measure(paths: &StorePaths, repo: &Path) -> Result<Pressure, StoreError> {
        let objects = repo.join("objects");
        let packs = objects.join("pack");
        paths.check_no_follow(&packs)?;
        let entries = match std::fs::read_dir(&packs) {
            Ok(entries) => Some(entries),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(StoreError::Io(e)),
        };
        let mut found = Vec::new();
        for entry in entries.into_iter().flatten() {
            crate::git_read::OperationDeadline::check()?;
            let name = entry.map_err(StoreError::Io)?.file_name();
            let Some(hash) = name
                .to_str()
                .and_then(|n| n.strip_prefix("pack-"))
                .and_then(|n| n.strip_suffix(".idx"))
                .filter(|h| Sha::parse(h).is_ok())
            else {
                continue;
            };
            let data = packs.join(format!("pack-{hash}.pack"));
            paths.check_no_follow(&data)?;
            // An index without data is not a usable pack; skip it here.
            let meta = match std::fs::symlink_metadata(&data) {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(StoreError::Io(e)),
            };
            found.push(PackFile {
                hash: hash.to_owned(),
                bytes: meta.len(),
            });
        }
        found.sort_by(|a, b| a.bytes.cmp(&b.bytes).then_with(|| a.hash.cmp(&b.hash)));
        let unfrozen = found
            .iter()
            .take_while(|p| p.bytes < CONSOLIDATE_FROZEN_BYTES)
            .count();
        found.truncate(unfrozen);
        let loose_sample = loose_in(paths, &objects.join("17"), usize::MAX, u64::MAX)?.len();
        Ok(Pressure {
            packs: found,
            loose_sample,
        })
    }

    /// Due when the loose sample is reached or the unfrozen packs reach the
    /// threshold and do not already form a progression (a progression of
    /// small packs is the geometric steady state, not work).
    pub(crate) fn due(&self) -> bool {
        self.loose_sample >= CONSOLIDATE_LOOSE_SAMPLE
            || (self.packs.len() >= CONSOLIDATE_PACKS && plan_rollup(&self.packs, 0) >= 2)
    }

    /// The level a back-off compares against: unfrozen packs plus loose
    /// sample.
    pub(crate) fn level(&self) -> u64 {
        (self.packs.len() + self.loose_sample) as u64
    }
}

/// Visit loose paths without buffering a directory. Check cancellation even
/// for skipped entries; a false visitor result stops this fan-out scan.
fn visit_loose(
    paths: &StorePaths,
    dir: &Path,
    mut visit: impl FnMut(String, u64) -> Result<bool, StoreError>,
) -> Result<(), StoreError> {
    paths.check_no_follow(dir)?;
    let fan = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(StoreError::Io(e)),
    };
    for entry in entries {
        crate::git_read::OperationDeadline::check()?;
        let entry = entry.map_err(StoreError::Io)?;
        let Some(rest) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if rest.len() != 38 || !rest.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            continue;
        }
        paths.check_no_follow(&entry.path())?;
        let size = entry.metadata().map_err(StoreError::Io)?.len();
        if !visit(format!("{fan}{rest}"), size)? {
            break;
        }
    }
    Ok(())
}

/// Loose objects of one fan-out directory, bounded by count and total bytes.
/// Individually oversized objects stay loose, preserved but excluded from
/// actionable pressure as well as selection. Never stop at an input that
/// cannot fit: smaller objects later in the directory can still progress.
fn loose_in(
    paths: &StorePaths,
    dir: &Path,
    max: usize,
    max_bytes: u64,
) -> Result<Vec<(String, u64)>, StoreError> {
    let (mut found, mut bytes) = (Vec::new(), 0u64);
    visit_loose(paths, dir, |name, size| {
        if found.len() >= max {
            return Ok(false);
        }
        if size <= CONSOLIDATE_MAX_BYTES / 2 && bytes.saturating_add(size) <= max_bytes {
            bytes += size;
            found.push((name, size));
        }
        Ok(true)
    })?;
    Ok(found)
}

/// Loose objects of a repository, bounded per pass.
fn loose_objects(
    paths: &StorePaths,
    objects: &Path,
    max: usize,
) -> Result<Vec<(String, u64)>, StoreError> {
    let mut found: Vec<(String, u64)> = Vec::new();
    let mut bytes = 0u64;
    for fan in 0..=255u8 {
        crate::git_read::OperationDeadline::check()?;
        let more = loose_in(
            paths,
            &objects.join(format!("{fan:02x}")),
            max - found.len(),
            CONSOLIDATE_MAX_BYTES / 2 - bytes,
        )?;
        bytes += more.iter().map(|(_, b)| b).sum::<u64>();
        found.extend(more);
        if found.len() >= max {
            break;
        }
    }
    Ok(found)
}

/// How many of the smallest packs (`packs` sorted by size) one rollup folds
/// together with `loose_bytes` of loose objects: Git's geometric split with
/// factor two (the packs left over each hold at least twice the bytes of
/// all smaller ones together), capped at [`CONSOLIDATE_MAX_BYTES`]. Frozen packs
/// ([`CONSOLIDATE_FROZEN_BYTES`]) never take part.
pub(crate) fn plan_rollup(packs: &[PackFile], loose_bytes: u64) -> usize {
    let unfrozen = packs
        .iter()
        .take_while(|p| p.bytes < CONSOLIDATE_FROZEN_BYTES)
        .count();
    let packs = &packs[..unfrozen];
    // Packs [split..] already form a progression; everything below it rolls.
    let mut split = packs.len().saturating_sub(1);
    while split > 0 && packs[split].bytes >= packs[split - 1].bytes.saturating_mul(2) {
        split -= 1;
    }
    let mut total = loose_bytes.saturating_add(packs[..split].iter().map(|p| p.bytes).sum());
    // A remaining pack smaller than twice the rollup would break the
    // progression again: fold it in too.
    while split < packs.len() && packs[split].bytes < total.saturating_mul(2) {
        total = total.saturating_add(packs[split].bytes);
        split += 1;
    }
    // The byte cap keeps the smallest packs: a pass always makes progress.
    let mut budget = loose_bytes;
    let mut roll = 0;
    while roll < split {
        budget = budget.saturating_add(packs[roll].bytes);
        if budget > CONSOLIDATE_MAX_BYTES {
            break;
        }
        roll += 1;
    }
    roll.min(CONSOLIDATE_MAX_PACKS)
}

const PACK_INDEX_HEADER: usize = 8 + 256 * 4;

/// Version-2 SHA-1 index, opened without following links and size checked.
fn pack_index_file(path: &Path) -> Result<(std::fs::File, usize), StoreError> {
    use std::io::Read;
    let corrupt = || StoreError::StorageUnavailable("unreadable pack index".into());
    let mut file = crate::paths::open_regular_read(path)?;
    let len = file.metadata().map_err(StoreError::Io)?.len();
    let mut header = [0u8; PACK_INDEX_HEADER];
    file.read_exact(&mut header).map_err(|_| corrupt())?;
    if header[..8] != [0xff, b't', b'O', b'c', 0, 0, 0, 2] {
        return Err(corrupt());
    }
    let count = u32::from_be_bytes(header[8 + 255 * 4..].try_into().map_err(|_| corrupt())?);
    if (header.len() as u64) + u64::from(count) * 28 + 40 > len {
        return Err(corrupt());
    }
    Ok((file, count as usize))
}

/// Sorted names, validated before they can authorize retirement.
fn pack_index_names(path: &Path) -> Result<Vec<[u8; 20]>, StoreError> {
    use std::io::Read;
    let (mut file, count) = pack_index_file(path)?;
    let mut names = vec![[0u8; 20]; count];
    for name in &mut names {
        file.read_exact(name).map_err(StoreError::Io)?;
    }
    if names.windows(2).any(|w| w[0] >= w[1]) {
        return Err(StoreError::StorageUnavailable(
            "unreadable pack index".into(),
        ));
    }
    Ok(names)
}

fn hex(name: &[u8; 20]) -> String {
    name.iter().map(|b| format!("{b:02x}")).collect()
}

/// Remove one superseded or unindexed pack file; whether it is gone. Any
/// failure but a refused path means "not yet": the file is already
/// invisible or still fully indexed, and a later pass retries it (Windows
/// refuses to delete a file another process holds open).
fn remove_pack_file(path: &Path) -> Result<bool, StoreError> {
    #[cfg(test)]
    if (BLOCK_RETIREMENT.with(|blocked| blocked.get())
        && path.extension().is_some_and(|s| s == "idx"))
        || (BLOCK_PACK_DATA.with(|blocked| blocked.get())
            && path.extension().is_some_and(|s| s == "pack"))
    {
        RETIREMENT_ATTEMPTS.with(|n| n.set(n.get() + 1));
        return Ok(false);
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(_) => match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(e) => Err(StoreError::Io(e)),
            Ok(_) => Ok(false),
        },
    }
}

#[cfg(test)]
type AfterRollupInstall = Box<dyn FnOnce() -> Option<crate::git_read::OperationDeadline>>;

#[cfg(test)]
type RollupBoundary = Box<dyn FnOnce() -> Result<(), StoreError>>;
#[cfg(test)]
type RetirementBoundary = Box<dyn FnMut() -> Result<(), StoreError>>;

#[cfg(test)]
thread_local! {
    pub(crate) static BLOCK_RETIREMENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(crate) static BLOCK_PACK_DATA: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(crate) static RETIREMENT_ATTEMPTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(crate) static CLEANUP_INDEX_OPENS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(crate) static CLEANUP_ENTRIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(crate) static ROLLUP_INSTALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(crate) static BEFORE_ROLLUP_INTENT: std::cell::RefCell<Option<RollupBoundary>> = const { std::cell::RefCell::new(None) };
    pub(crate) static AFTER_ROLLUP_INTENT: std::cell::RefCell<Option<RollupBoundary>> = const { std::cell::RefCell::new(None) };
    pub(crate) static AFTER_RETIREMENT_UNLINK: std::cell::RefCell<Option<RetirementBoundary>> = const { std::cell::RefCell::new(None) };
    pub(crate) static BEFORE_PRUNE: std::cell::RefCell<Option<Box<dyn FnMut() -> crate::git_read::OperationDeadline>>> = const { std::cell::RefCell::new(None) };
    pub(crate) static AFTER_ROLLUP_INSTALL: std::cell::RefCell<Option<AfterRollupInstall>> = const { std::cell::RefCell::new(None) };
}

/// Installation commits the fold, but does not discharge its cleanup debt.
/// SQLite records the exact debt before the covering pack is installed.
pub(crate) enum ConsolidationOutcome {
    NoWork,
    Complete,
    /// A bounded batch finished; continue next pass without failure back-off.
    Progress,
    CleanupPending(StoreError),
}

fn object_name(sha: &str) -> Result<[u8; 20], StoreError> {
    let mut name = [0u8; 20];
    for (i, byte) in name.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&sha[i * 2..i * 2 + 2], 16)
            .map_err(|_| StoreError::Internal("object name".into()))?;
    }
    Ok(name)
}

/// The intent is independent of retry history. A crash may lose settlement,
/// but never the list of objects that authorizes each retirement.
pub(crate) fn has_cleanup_intent(
    conn: &rusqlite::Connection,
    kb: &kb_client::types::KbId,
) -> Result<bool, StoreError> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pack_cleanup WHERE kb_id=?1)",
        [kb.as_str()],
        |r| r.get(0),
    )?)
}

fn record_cleanup(
    conn: &rusqlite::Connection,
    kb: &kb_client::types::KbId,
    covering: &str,
    names: &[String],
    packs: &[PackFile],
    loose: &[String],
) -> Result<(), StoreError> {
    let tx = conn.unchecked_transaction()?;
    let names = names
        .iter()
        .map(|sha| object_name(sha))
        .collect::<Result<Vec<_>, _>>()?;
    tx.execute(
        "INSERT INTO pack_cleanup(kb_id,covering,names) VALUES(?1,?2,?3)",
        rusqlite::params![kb.as_str(), covering, names.concat()],
    )?;
    {
        let mut stmt =
            tx.prepare("INSERT INTO pack_cleanup_entries(kb_id,kind,name) VALUES(?1,?2,?3)")?;
        for (kind, name) in packs
            .iter()
            .filter(|p| p.hash != covering)
            .map(|p| ("pack", p.hash.as_str()))
            .chain(loose.iter().map(|n| ("loose", n.as_str())))
        {
            stmt.execute(rusqlite::params![kb.as_str(), kind, name])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Only a committed intent may authorize deletion. Verify its complete selected
/// object set against the installed index, then touch at most CLEANUP_BATCH
/// exact paths. No other pack indexes or loose directories are searched.
fn resume_cleanup(
    paths: &StorePaths,
    objects: &Path,
    conn: &rusqlite::Connection,
    kb: &kb_client::types::KbId,
) -> Result<ConsolidationOutcome, StoreError> {
    let (covering, names): (String, Vec<u8>) = conn.query_row(
        "SELECT covering,names FROM pack_cleanup WHERE kb_id=?1",
        [kb.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Sha::parse(&covering).map_err(|_| failed("cleanup intent"))?;
    let packs = objects.join("pack");
    let index = packs.join(format!("pack-{covering}.idx"));
    let data = packs.join(format!("pack-{covering}.pack"));
    paths.check_no_follow(&index)?;
    paths.check_no_follow(&data)?;
    if !index.try_exists().map_err(StoreError::Io)? || !data.try_exists().map_err(StoreError::Io)? {
        // Crash before installation: originals are still authoritative. Never
        // retire anything, even if an invisible data link survived.
        conn.execute("DELETE FROM pack_cleanup WHERE kb_id=?1", [kb.as_str()])?;
        return Ok(ConsolidationOutcome::NoWork);
    }
    // Re-establish installation barriers if the process died after linking.
    sync_file(&data)?;
    sync_file(&index)?;
    sync_dir(&packs)?;
    #[cfg(test)]
    CLEANUP_INDEX_OPENS.with(|n| n.set(n.get() + 1));
    let kept = pack_index_names(&index)?;
    // Both name sets are sorted: a single linear merge verifies complete
    // coverage without per-name parsing or repeated index searches on retry.
    if names.len() % 20 != 0 {
        return Err(failed("cleanup intent"));
    }
    let mut at = 0;
    for name in names.as_chunks::<20>().0 {
        let name = name.as_slice();
        while kept.get(at).is_some_and(|kept| kept.as_slice() < name) {
            at += 1;
        }
        if kept.get(at).map(|kept| kept.as_slice()) != Some(name) {
            return Err(failed("rollup coverage"));
        }
    }
    let mut stmt = conn.prepare("SELECT kind,name FROM pack_cleanup_entries WHERE kb_id=?1 ORDER BY kind DESC,name DESC LIMIT ?2")?;
    let entries = stmt
        .query_map(rusqlite::params![kb.as_str(), CLEANUP_BATCH as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut done = Vec::new();
    let mut fans = std::collections::BTreeSet::new();
    let result = (|| {
        for (kind, name) in &entries {
            crate::git_read::OperationDeadline::check()?;
            Sha::parse(name).map_err(|_| failed("cleanup intent"))?;
            #[cfg(test)]
            CLEANUP_ENTRIES.with(|n| n.set(n.get() + 1));
            if kind == "pack" {
                if name == &covering {
                    return Err(failed("cleanup intent"));
                }
                for suffix in ["idx", "pack", "rev", "bitmap"] {
                    let path = packs.join(format!("pack-{name}.{suffix}"));
                    paths.check_no_follow(&path)?;
                    if !remove_pack_file(&path)? {
                        return Err(failed("pack retirement pending"));
                    }
                    #[cfg(test)]
                    AFTER_RETIREMENT_UNLINK.with(|hook| {
                        if let Some(hook) = hook.borrow_mut().as_mut() {
                            hook()?;
                        }
                        Ok::<_, StoreError>(())
                    })?;
                }
            } else {
                if kept.binary_search(&object_name(name)?).is_err() {
                    return Err(failed("rollup coverage"));
                }
                #[cfg(test)]
                let _scope =
                    BEFORE_PRUNE.with(|hook| hook.borrow_mut().as_mut().map(|hook| hook()));
                crate::git_read::OperationDeadline::check()?;
                let fan = objects.join(&name[..2]);
                let path = fan.join(&name[2..]);
                paths.check_no_follow(&path)?;
                match std::fs::remove_file(path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(failed("loose cleanup pending")),
                }
                fans.insert(fan);
            }
            done.push((kind, name));
        }
        Ok(())
    })();
    // Fence completed retirements even on a later error/deadline. If a crash
    // precedes SQL acknowledgement, repeating these exact removals is safe,
    // including an old pack whose index has already disappeared.
    sync_dir(&packs)?;
    for fan in fans {
        match sync_dir(&fan) {
            Ok(()) => {}
            // Git or a completed earlier removal may have retired an empty
            // fan-out. Fence its absence in objects before acknowledging it.
            Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                sync_dir(objects)?
            }
            Err(error) => return Err(error),
        }
    }
    let tx = conn.unchecked_transaction()?;
    for (kind, name) in done {
        tx.execute(
            "DELETE FROM pack_cleanup_entries WHERE kb_id=?1 AND kind=?2 AND name=?3",
            rusqlite::params![kb.as_str(), kind, name],
        )?;
    }
    tx.commit()?;
    result?;
    let remaining: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pack_cleanup_entries WHERE kb_id=?1)",
        [kb.as_str()],
        |r| r.get(0),
    )?;
    if remaining {
        return Ok(ConsolidationOutcome::Progress);
    }
    conn.execute("DELETE FROM pack_cleanup WHERE kb_id=?1", [kb.as_str()])?;
    Ok(ConsolidationOutcome::Complete)
}

/// One bounded fold or recorded cleanup batch under the store fence.
pub(crate) fn consolidate_objects(
    paths: &StorePaths,
    kb: &kb_client::types::KbId,
    _guard: &WriteGuard,
    conn: &rusqlite::Connection,
    pressure: &Pressure,
    admit: impl FnOnce(u64) -> Result<(), StoreError>,
) -> Result<ConsolidationOutcome, StoreError> {
    use ConsolidationOutcome::{CleanupPending, NoWork};
    let repo = GitRepo::for_kb(paths, kb)?;
    let objects = repo.git_dir().join("objects");
    let packs = objects.join("pack");
    if has_cleanup_intent(conn, kb)? {
        return Ok(resume_cleanup(paths, &objects, conn, kb).unwrap_or_else(CleanupPending));
    }
    if !pressure.due() {
        return Ok(NoWork);
    }
    let loose = loose_objects(paths, &objects, CONSOLIDATE_MAX_LOOSE)?;
    let loose_bytes: u64 = loose.iter().map(|(_, b)| b).sum();
    let roll = &pressure.packs[..plan_rollup(&pressure.packs, loose_bytes)];
    if roll.len() < 2 && loose.is_empty() {
        return Ok(NoWork);
    }
    let loose: Vec<String> = loose.into_iter().map(|(sha, _)| sha).collect();
    let mut names = loose.clone();
    for pack in roll {
        crate::git_read::OperationDeadline::check()?;
        let index = packs.join(format!("pack-{}.idx", pack.hash));
        paths.check_no_follow(&index)?;
        names.extend(pack_index_names(&index)?.iter().map(hex));
    }
    names.sort();
    names.dedup();
    // SHA-1 v2 index: header/fanout + 20-byte names + 4-byte CRCs +
    // 4-byte offsets + two SHA-1 trailers. Conservatively allow an 8-byte
    // large-offset entry per object too, independent of output offsets.
    let index_bytes = PACK_INDEX_HEADER as u64 + names.len() as u64 * 36 + 40;
    // Include SQLite intent payload, entry/index pages and WAL headroom while
    // the originals, scratch pack and installed replacement all coexist.
    let intent_bytes = names.len() as u64 * 128 + (roll.len() + loose.len()) as u64 * 1024;
    admit(loose_bytes + roll.iter().map(|p| p.bytes).sum::<u64>() + index_bytes + intent_bytes)?;
    let scratch = Scratch::new(paths, &crate::state::new_uuid_v4()?)?;
    let staged = repo.staged(&scratch.objects_dir()?)?;
    staged.install_rollup(&repo, &names, |new| {
        #[cfg(test)]
        if let Some(hook) = BEFORE_ROLLUP_INTENT.take() {
            hook()?;
        }
        record_cleanup(conn, kb, new, &names, roll, &loose)?;
        #[cfg(test)]
        if let Some(hook) = AFTER_ROLLUP_INTENT.take() {
            hook()?;
        }
        Ok(())
    })?;
    drop(scratch);
    #[cfg(test)]
    ROLLUP_INSTALLS.with(|n| n.set(n.get() + 1));
    #[cfg(test)]
    let _post_install_scope = AFTER_ROLLUP_INSTALL
        .take()
        .and_then(|after_install| after_install());
    Ok(resume_cleanup(paths, &objects, conn, kb).unwrap_or_else(CleanupPending))
}

// ── Repository + refs ──────────────────────────────────────────────────────

/// `git init --bare` into the reserved, empty repository directory: no
/// templates (no sample hooks), `HEAD` -> `refs/heads/main`.
pub(crate) fn init_repo(dir: &Path, guard: &WriteGuard) -> Result<GitRepo, StoreError> {
    let repo = GitRepo::open(dir)?;
    let command = repo.init_command([
        "init",
        "--bare",
        "--quiet",
        "--template=",
        "--initial-branch=main",
    ]);
    run_locked(&repo, guard, command, "init")?;
    crate::paths::make_tree_owner_only(dir)?;
    repo.check_integrity()?;
    Ok(repo)
}

/// Current `refs/heads/main`, or `None` when it does not exist.
pub(crate) fn read_main(repo: &GitRepo) -> Result<Option<Sha>, GitError> {
    read_ref(repo, MAIN_REF)
}

/// Current value of the exact branch `name` (`refs/heads/...`), or `None`
/// when it does not exist.
pub(crate) fn read_ref(repo: &GitRepo, name: &str) -> Result<Option<Sha>, GitError> {
    let command = repo.command(["for-each-ref", "--format=%(refname) %(objectname)", name])?;
    let (ok, out) = repo.run_command(command, 64 * 1024)?;
    if !ok {
        return Err(GitError::Failed("for-each-ref".into()));
    }
    let text = String::from_utf8_lossy(&out);
    for line in text.lines() {
        // `for-each-ref` matches prefixes; only the exact name counts.
        if let Some(oid) = line
            .strip_prefix(name)
            .and_then(|rest| rest.strip_prefix(' '))
        {
            return Sha::parse(oid.trim())
                .map(Some)
                .map_err(|_| GitError::Failed("unexpected ref value".into()));
        }
    }
    Ok(None)
}

/// Compare-and-swap `refs/heads/main` from `old` (`None` = absent) to
/// `new`, then fsync the ref directories. `Ok(false)` when Git refused
/// (the ref was not `old`) — the caller resolves the outcome from the ref.
pub(crate) fn update_main(
    repo: &GitRepo,
    guard: &WriteGuard,
    new: &Sha,
    old: Option<&Sha>,
) -> Result<bool, StoreError> {
    update_ref(repo, guard, MAIN_REF, new, old)
}

/// [`update_main`] for the exact branch `name` (main or a server-owned
/// `refs/heads/pr/<n>`); every parent directory of the ref file is fsynced.
pub(crate) fn update_ref(
    repo: &GitRepo,
    guard: &WriteGuard,
    name: &str,
    new: &Sha,
    old: Option<&Sha>,
) -> Result<bool, StoreError> {
    let old = old.map_or(ZERO_OID, Sha::as_str);
    let command = repo.command(["update-ref", "--no-deref", name, new.as_str(), old])?;
    let _ = guard; // GitRepo's spawn boundary attaches this repo's held store lock.
    let (ok, _) = repo.run_command(command, 4096)?;
    if ok {
        sync_ref(repo, name)?;
    }
    Ok(ok)
}

fn ref_path(repo: &GitRepo, name: &str) -> Result<PathBuf, StoreError> {
    // Persisted names are generated/validated by the publishers. Refuse a
    // corrupt journal path before any filesystem cleanup or barrier.
    if !name.starts_with("refs/heads/")
        || name
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == ".." || s.contains('\\'))
    {
        return Err(StoreError::UnsafePath("invalid journal ref path".into()));
    }
    let path = repo.git_dir().join(name);
    repo.check_managed_path(&path)?;
    Ok(path)
}

/// Re-establish the file and every entry barrier, including the repository
/// entry, before normal or recovered publication can acknowledge success.
pub(crate) fn sync_ref(repo: &GitRepo, name: &str) -> Result<(), StoreError> {
    let path = ref_path(repo, name)?;
    sync_file(&path)?;
    sync_ref_parents(repo, path)
}

fn sync_ref_parents(repo: &GitRepo, mut dir: PathBuf) -> Result<(), StoreError> {
    while dir.pop() {
        repo.check_managed_path(&dir)?;
        match sync_dir(&dir) {
            Ok(()) => {}
            // A CAS killed before creating a proposal directory needs its
            // nearest existing ancestor's absence barrier.
            Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        if dir == repo.git_dir().parent().ok_or(StoreError::LockNotHeld)? {
            break;
        }
    }
    Ok(())
}

/// The pending COMMITTING CAS is the ownership record for the exact loose
/// ref lock. Never sweep wildcard locks or touch the persistent store locks.
pub(crate) fn recover_ref_lock(
    paths: &StorePaths,
    repo: &GitRepo,
    row: &crate::journal::Pending,
    guard: &WriteGuard,
) -> Result<(), StoreError> {
    use std::io::Read;
    if !guard.matches(paths)? {
        return Err(StoreError::LockNotHeld);
    }
    let mut name = ref_path(repo, &row.ref_name)?.into_os_string();
    name.push(".lock");
    let path = PathBuf::from(name);
    paths.check_no_follow(&path)?;
    let open = || crate::paths::open_no_follow(&path, std::fs::OpenOptions::new().read(true));
    let mut file = match open() {
        Ok(file) => file,
        Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            // ENOENT does not complete a previously failed unlink barrier.
            return sync_ref_parents(repo, path);
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.by_ref()
        .take(42)
        .read_to_end(&mut bytes)
        .map_err(StoreError::Io)?;
    let expected = row.intended_new.as_ref().map(|s| format!("{s}\n"));
    if !bytes.is_empty() && expected.as_deref().map(str::as_bytes) != Some(bytes.as_slice()) {
        return Err(StoreError::RecoveryRequired(
            "unrecognized ref lock contents".into(),
        ));
    }
    paths.check_no_follow(&path)?;
    if !crate::paths::same_file(&file, &open()?)? {
        return Err(StoreError::UnsafePath("ref lock identity changed".into()));
    }
    if !guard.matches(paths)? {
        return Err(StoreError::LockNotHeld);
    }
    drop(file);
    std::fs::remove_file(&path).map_err(StoreError::Io)?;
    sync_ref_parents(repo, path)
}

fn sync_file(path: &Path) -> Result<(), StoreError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    // FlushFileBuffers requires a writable handle on Windows.
    #[cfg(windows)]
    options.write(true);
    crate::paths::open_no_follow(path, &mut options)?
        .sync_all()
        .map_err(StoreError::Io)
}

// ── Objects ────────────────────────────────────────────────────────────────

/// Writes objects for one operation and remembers them for [`sync_objects`].
pub(crate) struct ObjectWriter<'a> {
    repo: &'a GitRepo,
    guard: &'a WriteGuard,
    scratch: Scratch,
    written: Vec<String>,
}

impl<'a> ObjectWriter<'a> {
    pub(crate) fn new(repo: &'a GitRepo, guard: &'a WriteGuard, scratch: Scratch) -> Self {
        ObjectWriter {
            repo,
            guard,
            scratch,
            written: Vec::new(),
        }
    }

    fn hash_object(&mut self, kind: &str, bytes: &[u8]) -> Result<String, StoreError> {
        let path = self.scratch.file(bytes)?;
        let mut command = self.repo.command([
            std::ffi::OsStr::new("hash-object"),
            "-t".as_ref(),
            kind.as_ref(),
            "-w".as_ref(),
            "--no-filters".as_ref(),
            "--".as_ref(),
            path.as_os_str(),
        ])?;
        command.current_dir(&self.scratch.dir);
        let out = run_locked(self.repo, self.guard, command, "hash-object")?;
        let sha = sha_from(&out, "hash-object")?.as_str().to_owned();
        self.written.push(sha.clone());
        Ok(sha)
    }

    pub(crate) fn blob(&mut self, bytes: &[u8]) -> Result<String, StoreError> {
        self.hash_object("blob", bytes)
    }

    /// Write a raw tree object (canonical entry bytes, sorted by the caller).
    pub(crate) fn tree_raw(&mut self, bytes: &[u8]) -> Result<String, StoreError> {
        self.hash_object("tree", bytes)
    }

    /// Write many tree objects whose names the caller computed, in a few
    /// Git processes (chunks bounded for any command-line limit), never one
    /// per tree; every returned name is checked against the computed one.
    pub(crate) fn trees_batch(&mut self, trees: &[(String, Vec<u8>)]) -> Result<(), StoreError> {
        const CHUNK: usize = 512;
        for chunk in trees.chunks(CHUNK) {
            crate::git_read::OperationDeadline::check()?;
            let mut args: Vec<std::ffi::OsString> = vec![
                "hash-object".into(),
                "-t".into(),
                "tree".into(),
                "-w".into(),
                "--no-filters".into(),
                "--".into(),
            ];
            for (_, body) in chunk {
                args.push(self.scratch.file(body)?.into_os_string());
            }
            let mut command = self.repo.command(&args)?;
            command.current_dir(&self.scratch.dir);
            let (ok, out) = self.repo.run_command(command, chunk.len() * 41 + 64)?;
            if !ok {
                return Err(failed("hash-object"));
            }
            let names: Vec<&str> = std::str::from_utf8(&out)
                .map_err(|_| failed("hash-object"))?
                .lines()
                .collect();
            if names.len() != chunk.len()
                || names
                    .iter()
                    .zip(chunk)
                    .any(|(got, (want, _))| got.trim() != want)
            {
                return Err(failed("hash-object"));
            }
            self.written
                .extend(chunk.iter().map(|(sha, _)| sha.clone()));
        }
        Ok(())
    }

    /// Promote into the canonical store exactly the objects `commit` needs
    /// beyond `known` (its parents): those reachable from it and present
    /// only in this writer's disposable store. Returns loose objects still
    /// needing [`sync_objects`]; a promoted pack is already durable. A plan
    /// that is never promoted leaves the canonical
    /// object set unchanged.
    pub(crate) fn promote(&self, commit: &Sha, known: &[&Sha]) -> Result<Vec<String>, StoreError> {
        let staging = self.repo.write_objects_dir();
        let canonical = self.repo.canonical();
        let canonical_objects = canonical.git_dir().join("objects");
        if staging == canonical_objects {
            return Ok(self.written.clone());
        }
        let mut args = vec![
            "rev-list".to_owned(),
            "--objects".to_owned(),
            commit.as_str().to_owned(),
        ];
        if !known.is_empty() {
            args.push("--not".to_owned());
            args.extend(known.iter().map(|sha| sha.as_str().to_owned()));
        }
        let (ok, out) = self.repo.run_command(
            self.repo.command(&args)?,
            2 * TREE_LIMITS.max_entries * (kb_client::PATH_MAX_BYTES + 64),
        )?;
        if !ok {
            return Err(failed("rev-list"));
        }
        let mut promoted = Vec::new();
        for line in String::from_utf8_lossy(&out).lines() {
            let sha = line.split(' ').next().unwrap_or_default();
            if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(failed("rev-list"));
            }
            // Only what this plan wrote; everything else is canonical already.
            let (fan, rest) = sha.split_at(2);
            if staging.join(fan).join(rest).exists() {
                promoted.push(sha.to_owned());
            }
        }
        if promoted.is_empty() {
            return Ok(promoted);
        }
        crate::git_read::OperationDeadline::check()?;
        // index-pack finishes in managed scratch; its completed pack becomes
        // visible as one graph when the durable index is installed last.
        self.repo.install_objects(&canonical, &promoted)?;
        Ok(Vec::new())
    }

    /// Commit `tree` with the server identity at `epoch_secs`.
    pub(crate) fn commit(
        &mut self,
        tree: &str,
        parent: Option<&Sha>,
        message: &str,
        epoch_secs: u64,
    ) -> Result<Sha, StoreError> {
        self.commit_parents(
            tree,
            &parent.into_iter().collect::<Vec<_>>(),
            message,
            epoch_secs,
        )
    }

    /// Commit a merge with ordered parents (main first).
    pub(crate) fn commit_parents(
        &mut self,
        tree: &str,
        parents: &[&Sha],
        message: &str,
        epoch_secs: u64,
    ) -> Result<Sha, StoreError> {
        let message_file = self.scratch.file(message.as_bytes())?;
        let mut args: Vec<std::ffi::OsString> = vec!["commit-tree".into(), tree.into()];
        for parent in parents {
            args.push("-p".into());
            args.push(parent.as_str().into());
        }
        args.push("-F".into());
        args.push(message_file.into_os_string());
        let mut command = self.repo.command(&args)?;
        command.current_dir(&self.scratch.dir);
        let date = format!("{epoch_secs} +0000");
        command
            .env("GIT_AUTHOR_NAME", COMMITTER_NAME)
            .env("GIT_AUTHOR_EMAIL", COMMITTER_EMAIL)
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_NAME", COMMITTER_NAME)
            .env("GIT_COMMITTER_EMAIL", COMMITTER_EMAIL)
            .env("GIT_COMMITTER_DATE", &date);
        let out = run_locked(self.repo, self.guard, command, "commit-tree")?;
        let sha = sha_from(&out, "commit-tree")?;
        self.written.push(sha.as_str().to_owned());
        Ok(sha)
    }

    /// Objects written so far (blobs, trees, commit).
    pub(crate) fn written(&self) -> &[String] {
        &self.written
    }
}

/// fsync every loose object in `objects` (file, fan-out dir) and
/// `objects/`. An object Git deduplicated into an existing pack has no loose
/// file and is already durable (promotion fences its pack and index).
pub(crate) fn sync_objects(repo: &GitRepo, objects: &[String]) -> Result<(), StoreError> {
    let root = repo.git_dir().join("objects");
    let mut dirs = std::collections::BTreeSet::new();
    for sha in objects {
        crate::git_read::OperationDeadline::check()?;
        let (fan, rest) = sha.split_at(2);
        let dir = root.join(fan);
        let file = dir.join(rest);
        repo.check_managed_path(&file)?;
        match sync_file(&file) {
            Ok(()) => {}
            Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        }
        dirs.insert(dir);
    }
    for dir in dirs {
        crate::git_read::OperationDeadline::check()?;
        sync_dir(&dir)?;
    }
    sync_dir(&root)
}

// ── Trees ──────────────────────────────────────────────────────────────────

enum Node {
    Blob(String),
    /// `sha` is the unchanged original tree; `None` once modified.
    Dir {
        sha: Option<String>,
        children: BTreeMap<Vec<u8>, Node>,
    },
}

/// A mutable view of a commit tree; unchanged subtrees keep their object.
pub(crate) struct TreeEdit {
    root: Node,
    // Immutable metadata from the bounded load, reused by merge construction
    // and changed-blob policy checks after this view is edited.
    original_blobs: std::collections::HashMap<String, String>,
}

impl TreeEdit {
    pub(crate) fn empty() -> TreeEdit {
        TreeEdit {
            original_blobs: std::collections::HashMap::new(),
            root: Node::Dir {
                sha: None,
                children: BTreeMap::new(),
            },
        }
    }

    /// Load the tree of `commit` (already validated when published).
    pub(crate) fn load(repo: &GitRepo, commit: &Sha) -> Result<TreeEdit, StoreError> {
        let mut reader = repo.object_reader()?;
        let info = reader.read_commit(commit)?;
        let entries = walk_tree(
            &mut reader,
            &info.tree,
            &mut WalkBudget::new(TREE_LIMITS.max_entries),
            &mut IncomingBudget::new(
                TREE_LIMITS.max_objects,
                TREE_LIMITS.max_uncompressed_object_bytes,
                None,
            ),
        )?;
        let original_blobs = entries
            .iter()
            .filter(|entry| entry.kind == EntryKind::Blob)
            .map(|entry| (entry.path.clone(), entry.sha.clone()))
            .collect();
        let mut edit = TreeEdit {
            original_blobs,
            root: Node::Dir {
                sha: Some(info.tree.as_str().to_owned()),
                children: BTreeMap::new(),
            },
        };
        for entry in entries {
            let segments: Vec<&str> = entry.path.split('/').collect();
            let (last, parents) = segments
                .split_last()
                .ok_or_else(|| StoreError::Internal("empty tree path".into()))?;
            let dir = edit.dir_mut(parents, false)?;
            let node = match entry.kind {
                EntryKind::Tree => Node::Dir {
                    sha: Some(entry.sha),
                    children: BTreeMap::new(),
                },
                EntryKind::Blob => Node::Blob(entry.sha),
                EntryKind::Commit => {
                    return Err(StoreError::RecoveryRequired(
                        "gitlink in published tree".into(),
                    ));
                }
            };
            dir.insert(last.as_bytes().to_vec(), node);
        }
        Ok(edit)
    }

    /// Blob identities of the loaded revision, before any edits to this view.
    pub(crate) fn original_blobs(&self) -> &std::collections::HashMap<String, String> {
        &self.original_blobs
    }

    /// Children of the directory at `segments`; `dirty` invalidates the
    /// original tree object of every directory on the way.
    fn dir_mut(
        &mut self,
        segments: &[&str],
        dirty: bool,
    ) -> Result<&mut BTreeMap<Vec<u8>, Node>, StoreError> {
        let mut node = &mut self.root;
        for segment in segments {
            let Node::Dir { sha, children } = node else {
                return Err(StoreError::InvalidArgument("path crosses a file".into()));
            };
            if dirty {
                *sha = None;
            }
            node = children
                .entry(segment.as_bytes().to_vec())
                .or_insert_with(|| Node::Dir {
                    sha: None,
                    children: BTreeMap::new(),
                });
        }
        match node {
            Node::Dir { sha, children } => {
                if dirty {
                    *sha = None;
                }
                Ok(children)
            }
            Node::Blob(_) => Err(StoreError::InvalidArgument("path crosses a file".into())),
        }
    }

    /// What `path` names in this tree: `Some(Ok(blob))` a file, `Some(Err(()))`
    /// a directory or a path below a file, `None` nothing.
    pub(crate) fn lookup(&self, path: &KbPath) -> Option<Result<&str, ()>> {
        let mut node = &self.root;
        for segment in path.as_str().split('/') {
            match node {
                Node::Dir { children, .. } => node = children.get(segment.as_bytes())?,
                Node::Blob(_) => return Some(Err(())),
            }
        }
        Some(match node {
            Node::Blob(sha) => Ok(sha.as_str()),
            Node::Dir { .. } => Err(()),
        })
    }

    /// Put `blob` at `path` (create or replace a file, never a directory).
    pub(crate) fn put(&mut self, path: &KbPath, blob: String) -> Result<(), StoreError> {
        let segments: Vec<&str> = path.as_str().split('/').collect();
        let (last, parents) = segments
            .split_last()
            .ok_or_else(|| StoreError::InvalidArgument("empty path".into()))?;
        let dir = self.dir_mut(parents, true)?;
        if matches!(dir.get(last.as_bytes()), Some(Node::Dir { .. })) {
            return Err(StoreError::InvalidArgument("path names a directory".into()));
        }
        dir.insert(last.as_bytes().to_vec(), Node::Blob(blob));
        Ok(())
    }

    /// Delete the file at `path`; it must exist. Empty parents are pruned.
    pub(crate) fn delete(&mut self, path: &KbPath) -> Result<(), StoreError> {
        let segments: Vec<&str> = path.as_str().split('/').collect();
        if !remove(&mut self.root, &segments)? {
            return Err(StoreError::InvalidArgument(
                "path does not name a file".into(),
            ));
        }
        Ok(())
    }

    /// Write every modified directory; returns the root tree. Names are
    /// computed bottom-up here and every new tree is written in a few batched
    /// Git processes (a tree per modified directory would be one process per
    /// directory, too slow for deep valid trees).
    pub(crate) fn write(&self, writer: &mut ObjectWriter<'_>) -> Result<String, StoreError> {
        let mut trees = Vec::new();
        let root = tree_names(&self.root, &mut trees)?;
        writer.trees_batch(&trees)?;
        Ok(root)
    }
}

/// Remove the blob at `segments` below `node`; prunes emptied directories.
fn remove(node: &mut Node, segments: &[&str]) -> Result<bool, StoreError> {
    let Node::Dir { sha, children } = node else {
        return Ok(false);
    };
    let Some((first, rest)) = segments.split_first() else {
        return Ok(false);
    };
    let key = first.as_bytes().to_vec();
    let removed = match children.get_mut(&key) {
        None => false,
        Some(Node::Blob(_)) if rest.is_empty() => {
            children.remove(&key);
            true
        }
        Some(Node::Blob(_)) => false,
        Some(child @ Node::Dir { .. }) => {
            if rest.is_empty() {
                false
            } else {
                let removed = remove(child, rest)?;
                if removed && matches!(child, Node::Dir { children, .. } if children.is_empty()) {
                    children.remove(&key);
                }
                removed
            }
        }
    };
    if removed {
        *sha = None;
    }
    Ok(removed)
}

/// Git's object name of a tree body.
fn tree_sha(body: &[u8]) -> String {
    let mut data = format!("tree {}\0", body.len()).into_bytes();
    data.extend_from_slice(body);
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &data);
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// The name of `node`, collecting every modified tree's (name, body).
fn tree_names(node: &Node, out: &mut Vec<(String, Vec<u8>)>) -> Result<String, StoreError> {
    match node {
        Node::Blob(sha) => Ok(sha.clone()),
        Node::Dir { sha: Some(sha), .. } => Ok(sha.clone()),
        Node::Dir {
            sha: None,
            children,
        } => {
            // Git order: names compared bytewise, directories as `name/`.
            let mut rows: Vec<(Vec<u8>, &str, &[u8], String)> = Vec::new();
            for (name, child) in children {
                let sha = tree_names(child, out)?;
                let (mode, key) = match child {
                    Node::Blob(_) => ("100644", name.clone()),
                    Node::Dir { .. } => {
                        let mut key = name.clone();
                        key.push(b'/');
                        ("40000", key)
                    }
                };
                rows.push((key, mode, name.as_slice(), sha));
            }
            rows.sort_by(|a, b| a.0.cmp(&b.0));
            let mut body = Vec::new();
            for (_, mode, name, sha) in rows {
                body.extend_from_slice(mode.as_bytes());
                body.push(b' ');
                body.extend_from_slice(name);
                body.push(0);
                for i in (0..sha.len()).step_by(2) {
                    let byte = u8::from_str_radix(&sha[i..i + 2], 16)
                        .map_err(|_| StoreError::Internal("object name".into()))?;
                    body.push(byte);
                }
            }
            let sha = tree_sha(&body);
            out.push((sha.clone(), body));
            Ok(sha)
        }
    }
}

#[cfg(test)]
mod consolidation_tests {
    use super::*;

    fn packs(sizes: &[u64]) -> Vec<PackFile> {
        sizes
            .iter()
            .map(|bytes| PackFile {
                hash: String::new(),
                bytes: *bytes,
            })
            .collect()
    }

    #[test]
    fn oversized_loose_paths_are_kept_out_of_due_measurement_and_selection() {
        let root = std::env::temp_dir().join(format!(
            "kb-local-loose-pressure-{}",
            crate::state::new_uuid_v4().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let paths = StorePaths::new(root.clone()).unwrap();
        let repo = root.join("repo.git");
        let fan = repo.join("objects/17");
        std::fs::create_dir_all(&fan).unwrap();
        // Metadata is the admission input; real Git object preservation is
        // separately covered by changes.rs's 17 MiB blob regression.
        for n in 0..CONSOLIDATE_LOOSE_SAMPLE {
            std::fs::File::create(fan.join(format!("{n:038x}")))
                .unwrap()
                .set_len(CONSOLIDATE_MAX_BYTES / 2 + 1)
                .unwrap();
        }
        let pressure = Pressure::measure(&paths, &repo).unwrap();
        assert_eq!(pressure.loose_sample, 0);
        assert!(!pressure.due());
        assert!(
            loose_objects(&paths, &repo.join("objects"), CONSOLIDATE_MAX_LOOSE)
                .unwrap()
                .is_empty()
        );
        // A file exceeding only the remaining allowance must not stop the
        // directory either: every fitting small path is still selectable.
        let medium = fan.join(format!("{:038x}", CONSOLIDATE_LOOSE_SAMPLE + 1));
        std::fs::write(&medium, b"too big!").unwrap();
        let small = fan.join(format!("{:038x}", CONSOLIDATE_LOOSE_SAMPLE));
        std::fs::write(&small, b"tiny").unwrap();
        let selected = loose_in(&paths, &fan, CONSOLIDATE_MAX_LOOSE, 4).unwrap();
        assert_eq!(
            selected,
            vec![(format!("17{:038x}", CONSOLIDATE_LOOSE_SAMPLE), 4)]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tiny_pack_selection_is_bounded_independently_of_bytes() {
        assert_eq!(
            plan_rollup(&packs(&vec![64; 601]), 0),
            CONSOLIDATE_MAX_PACKS
        );
    }

    #[test]
    fn geometric_rollup_folds_only_the_small_packs() {
        // Eight one-publication packs below a large pack: only they roll.
        assert_eq!(
            plan_rollup(&packs(&[10, 10, 10, 10, 10, 10, 10, 10, 1_000]), 0),
            8
        );
        // A progression has nothing to roll, unless loose objects break it.
        assert_eq!(plan_rollup(&packs(&[10, 40, 200, 1_000]), 0), 0);
        assert_eq!(plan_rollup(&packs(&[10, 40, 200, 1_000]), 9), 1);
        // Rolling up can cascade into packs only just over twice as large.
        assert_eq!(plan_rollup(&packs(&[10, 30, 70, 200]), 9), 4);
        // A small new pack beside a progression rolls with what it breaks.
        assert_eq!(plan_rollup(&packs(&[10, 12, 40, 1_000]), 0), 3);
    }

    /// m-r4b: a pack just under the cap was rewritten on almost every write.
    #[test]
    fn near_cap_packs_are_frozen_and_never_rolled() {
        let near = CONSOLIDATE_MAX_BYTES - (1 << 20);
        let mut sizes = vec![2048];
        sizes.extend([near; 10]);
        assert_eq!(plan_rollup(&packs(&sizes), 0), 0);
        assert_eq!(plan_rollup(&packs(&[2048, near, near]), 0), 0);
        let frozen = CONSOLIDATE_FROZEN_BYTES;
        assert_eq!(plan_rollup(&packs(&[10, 10, frozen, frozen]), 0), 2);
    }

    /// The model of one store: every write adds one pack of `size(i)`
    /// bytes; before it, a publication's lock rolls up when due. Returns
    /// (bytes rewritten, bytes written, most packs seen, most unfrozen).
    fn simulate(
        start: &[u64],
        writes: usize,
        size: impl Fn(usize) -> u64,
        failures_at: Option<usize>,
    ) -> (u64, u64, usize, usize) {
        // Frozen packs never reenter the planner; count them separately so
        // this 50,000-write model also stays cheap in debug builds.
        let mut frozen = start
            .iter()
            .filter(|b| **b >= CONSOLIDATE_FROZEN_BYTES)
            .count();
        let mut all: Vec<u64> = start
            .iter()
            .copied()
            .filter(|b| *b < CONSOLIDATE_FROZEN_BYTES)
            .collect();
        let (mut rewritten, mut written, mut most, mut most_unfrozen) = (0u64, 0u64, 0, 0);
        let mut deferred: Option<crate::recovery::ConsolidationDeferral> = None;
        let mut failures_left = 0;
        for i in 0..writes {
            if failures_at == Some(i) {
                failures_left = 5;
            }
            all.sort_unstable();
            let pressure = Pressure {
                packs: packs(&all),
                loose_sample: 0,
            };
            if pressure.due()
                && deferred
                    .as_ref()
                    .is_none_or(|d| pressure.level() >= d.retry_level())
            {
                if failures_left > 0 {
                    failures_left -= 1;
                    deferred = Some(crate::recovery::ConsolidationDeferral {
                        code: "DEADLINE_EXCEEDED".into(),
                        level: pressure.level(),
                        deferrals: deferred.as_ref().map_or(1, |d| d.deferrals + 1),
                        at_ms: 0,
                    });
                } else {
                    let roll = plan_rollup(&packs(&all), 0);
                    if roll >= 2 {
                        let folded: u64 = all[..roll].iter().sum();
                        rewritten += folded;
                        all.drain(..roll);
                        if folded >= CONSOLIDATE_FROZEN_BYTES {
                            frozen += 1;
                        } else {
                            all.push(folded);
                        }
                        deferred = None;
                    }
                }
            }
            let bytes = size(i);
            written += bytes;
            if bytes >= CONSOLIDATE_FROZEN_BYTES {
                frozen += 1;
            } else {
                all.push(bytes);
            }
            most = most.max(all.len() + frozen);
            most_unfrozen = most_unfrozen.max(all.len());
        }
        assert_eq!(failures_left, 0, "all injected failures exercised");
        assert!(
            deferred.is_none(),
            "a later retry made progress and cleared back-off"
        );
        let tail = (CONSOLIDATE_FROZEN_BYTES / 512).ilog2() as usize + 1;
        assert!(
            all.len() <= CONSOLIDATE_PACKS + tail,
            "returned to the steady-state pack bound"
        );
        (rewritten, written, most, most_unfrozen)
    }

    /// Property: over many writes of any size mix, bytes rewritten stay a
    /// small multiple of bytes written (below the constructive bound), the
    /// unfrozen packs stay at the threshold plus a geometric tail, and every
    /// frozen pack holds at least half the cap of written data.
    #[test]
    fn rollups_bound_write_amplification_and_pack_count() {
        let near = CONSOLIDATE_MAX_BYTES - (1 << 20);
        let mut x: u64 = 0x2545_f491_4f6c_dd1d;
        let mut random = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let mixed: Vec<u64> = (0..50_000).map(|_| 512 + random() % (2 << 20)).collect();
        type Case = (&'static str, Vec<u64>, usize, Box<dyn Fn(usize) -> u64>);
        let cases: Vec<Case> = vec![
            ("2 KiB", vec![], 50_000, Box::new(|_| 2048)),
            ("64 KiB", vec![], 50_000, Box::new(|_| 64 << 10)),
            (
                "2 KiB over near-cap packs",
                vec![near; 10],
                5_000,
                Box::new(|_| 2048),
            ),
            ("mixed", vec![], 50_000, Box::new(move |i| mixed[i])),
        ];
        // A factor-2 progression from the smallest write (512 B) to the freeze.
        let tail = (CONSOLIDATE_FROZEN_BYTES / 512).ilog2() as usize + 1;
        for (name, start, writes, size) in cases {
            // Inject five failures at a deterministic pseudo-random write.
            // Only retry spacing changes; the same cap/freeze proof applies.
            for failure in [None, Some(random() as usize % (writes / 2))] {
                let (rewritten, written, most, most_unfrozen) =
                    simulate(&start, writes, &size, failure);
                let retry_tail = if failure.is_some() {
                    8 + 16 + 32 + 64 + 128
                } else {
                    0
                };
                let amplification = rewritten as f64 / written as f64;
                assert!(
                    amplification <= 12.0,
                    "{name}: {amplification:.1}x rewritten"
                );
                assert!(
                    most_unfrozen <= CONSOLIDATE_PACKS + tail + retry_tail,
                    "{name}: {most_unfrozen} unfrozen"
                );
                let frozen_bound = (written / CONSOLIDATE_FROZEN_BYTES) as usize + start.len();
                assert!(
                    most <= CONSOLIDATE_PACKS + tail + frozen_bound + retry_tail,
                    "{name}: {most} packs for {written} bytes"
                );
            }
        }
    }

    #[test]
    fn rollup_is_capped_and_never_rewrites_a_large_pack() {
        let large = CONSOLIDATE_MAX_BYTES;
        assert_eq!(plan_rollup(&packs(&[10, 10, large, large]), 0), 2);
        // Just below the freeze: a cap-truncated rollup only takes what fits.
        let below = CONSOLIDATE_FROZEN_BYTES - 1;
        assert_eq!(plan_rollup(&packs(&[below, below, below]), 0), 2);
        // Loose objects alone fill the budget: the smallest packs wait.
        assert_eq!(plan_rollup(&packs(&[10, 10]), CONSOLIDATE_MAX_BYTES), 0);
    }
}
