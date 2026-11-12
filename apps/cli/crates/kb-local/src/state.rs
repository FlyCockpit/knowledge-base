//! `state.sqlite` connection settings, schema, local principals and the
//! shared permission expansion/ceiling rules.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use kb_client::types::{KbId, Permission, Uuid};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{Connection, OpenFlags};

use crate::StoreError;

/// Schema version written to `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 1;
/// The single initial schema; later local chunks extend it in place.
pub const INITIAL_SQL: &str = include_str!("db/0001_initial.sql");
/// SQLite busy timeout for every store connection.
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(10);

// ── Permissions ─────────────────────────────────────────────────────────────

const ORDER: [(Permission, u8); 5] = [
    (Permission::Read, 1),
    (Permission::Propose, 2),
    (Permission::Write, 4),
    (Permission::Review, 8),
    (Permission::Manage, 16),
];

/// A set of kb/1 permission bits. [`Bits::expand`] applies the shared rules
/// `manage => write, review`; `write => propose`;
/// `propose => read`; `review => read`. Write never implies review.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Bits(u8);

impl Bits {
    pub const NONE: Bits = Bits(0);
    pub const ALL: Bits = Bits(31);

    pub fn from_permissions(permissions: &[Permission]) -> Bits {
        let mut bits = 0;
        for permission in permissions {
            bits |= Self::bit(*permission);
        }
        Bits(bits)
    }

    fn bit(permission: Permission) -> u8 {
        ORDER
            .iter()
            .find(|(p, _)| *p == permission)
            .map_or(0, |(_, bit)| *bit)
    }

    pub(crate) fn from_raw(raw: i64) -> Bits {
        Bits(u8::try_from(raw & 31).unwrap_or(0))
    }

    pub(crate) fn raw(self) -> i64 {
        i64::from(self.0)
    }

    /// Transitive closure of the implication rules.
    pub fn expand(self) -> Bits {
        let mut bits = self.0;
        if bits & 16 != 0 {
            bits |= 4 | 8;
        }
        if bits & 4 != 0 {
            bits |= 2;
        }
        if bits & 2 != 0 {
            bits |= 1;
        }
        if bits & 8 != 0 {
            bits |= 1;
        }
        Bits(bits)
    }

    /// Effective bits: expanded ceiling ∩ expanded live bits.
    pub fn intersect(self, other: Bits) -> Bits {
        Bits(self.expand().0 & other.expand().0)
    }

    pub fn contains(self, permission: Permission) -> bool {
        self.0 & Self::bit(permission) != 0
    }

    /// Contract order: read, propose, write, review, manage.
    pub fn permissions(self) -> Vec<Permission> {
        ORDER
            .iter()
            .filter(|(_, bit)| self.0 & bit != 0)
            .map(|(p, _)| *p)
            .collect()
    }
}

// ── Principals ──────────────────────────────────────────────────────────────

/// Local principal kinds. The owner holds every bit on every live KB; config
/// and test principals are capability-narrowed by per-KB ceiling rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrincipalKind {
    Owner,
    Config,
    Test,
}

impl PrincipalKind {
    pub(crate) fn as_db(self) -> Option<&'static str> {
        match self {
            PrincipalKind::Owner => None,
            PrincipalKind::Config => Some("CONFIG"),
            PrincipalKind::Test => Some("TEST"),
        }
    }
}

/// An opaque local principal (random UUID, never an OS user name).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalPrincipal {
    id: String,
    kind: PrincipalKind,
}

impl LocalPrincipal {
    pub(crate) fn new(id: String, kind: PrincipalKind) -> Self {
        LocalPrincipal { id, kind }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn kind(&self) -> PrincipalKind {
        self.kind
    }

    /// Journal actor key (`local:<id>`), distinct per principal.
    pub fn actor_key(&self) -> String {
        format!("local:{}", self.id)
    }
}

// ── Randomness / clock ──────────────────────────────────────────────────────

pub(crate) fn random_bytes<const N: usize>() -> Result<[u8; N], StoreError> {
    let mut bytes = [0u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| StoreError::Internal("os rng unavailable".into()))?;
    Ok(bytes)
}

/// Random RFC 4122 version-4 UUID.
pub(crate) fn new_uuid_v4() -> Result<Uuid, StoreError> {
    let mut bytes: [u8; 16] = random_bytes()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let text = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    Uuid::parse(&text).map_err(|_| StoreError::Internal("uuid format".into()))
}

/// Random 25-character lowercase cuid2-style ID (leading letter).
/// A fresh idempotency key for one CLI action.
pub fn random_key() -> Result<String, StoreError> {
    Ok(new_uuid_v4()?.to_string())
}

pub(crate) fn new_id() -> Result<KbId, StoreError> {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(25);
    while out.len() < 25 {
        let bytes: [u8; 32] = random_bytes()?;
        for byte in bytes {
            // Rejection sampling keeps the distribution uniform.
            if byte >= 252 {
                continue;
            }
            let index = usize::from(byte % 36);
            if out.is_empty() && index >= 26 {
                continue;
            }
            out.push(char::from(ALPHABET[index]));
            if out.len() == 25 {
                break;
            }
        }
    }
    KbId::parse(&out).map_err(|_| StoreError::Internal("id format".into()))
}

/// Random 32-byte key (cursor HMAC).
pub(crate) fn new_key() -> Result<[u8; 32], StoreError> {
    random_bytes()
}

/// Seconds since the Unix epoch.
pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Current UTC time as RFC 3339 (`YYYY-MM-DDTHH:MM:SSZ`).
pub(crate) fn now_utc() -> String {
    format_utc(now_secs())
}

/// `secs` since the epoch as RFC 3339 UTC; lexicographic order is time order.
pub(crate) fn format_utc(secs: u64) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

// ── Connections ─────────────────────────────────────────────────────────────

/// Effective per-connection settings, for verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectionSettings {
    pub journal_mode: String,
    /// 2 = FULL.
    pub synchronous: i64,
    pub foreign_keys: bool,
    pub busy_timeout_ms: i64,
    pub user_version: i64,
}

fn base_flags() -> OpenFlags {
    OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW
}

fn apply_pragmas(conn: &Connection, wal: bool) -> Result<(), StoreError> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    if wal {
        let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(StoreError::StorageUnavailable(
                "WAL mode unavailable".into(),
            ));
        }
    }
    conn.execute_batch("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")?;
    Ok(())
}

/// Open an existing, initialized `state.sqlite`. Never creates the file.
pub(crate) fn open_existing(path: &Path) -> Result<Connection, StoreError> {
    open_existing_bound(path, None)
}

pub(crate) fn open_existing_bound(
    path: &Path,
    expected: Option<&Uuid>,
) -> Result<Connection, StoreError> {
    let conn = Connection::open_with_flags(path, base_flags()).map_err(recovery_on_corrupt)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // Check identity before any pragma could write to a foreign file.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(recovery_on_corrupt)?;
    if version != SCHEMA_VERSION {
        return Err(StoreError::RecoveryRequired(format!(
            "state.sqlite schema version {version} is not {SCHEMA_VERSION}"
        )));
    }
    if let Some(expected) = expected {
        let actual: String = conn
            .query_row("SELECT store_uuid FROM store_meta WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(recovery_on_corrupt)?;
        if actual != expected.as_str() {
            return Err(StoreError::RecoveryRequired(
                "launched store identity changed".into(),
            ));
        }
    }
    apply_pragmas(&conn, true).map_err(recovery_on_corrupt_store)?;
    Ok(conn)
}

/// Open an existing `state.sqlite` read-only for metadata reads: no setting
/// is written (`busy_timeout` and `query_only` are per-connection). A WAL
/// database is read read-only only beside its `-wal`/`-shm` files, which a
/// live writer (the launching session's store) keeps; without them SQLite
/// would create them, so this fails closed instead (never read-write).
pub(crate) fn open_read_only_bound(path: &Path, expected: &Uuid) -> Result<Connection, StoreError> {
    let side = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        std::path::PathBuf::from(name)
    };
    if !side("-wal").is_file() || !side("-shm").is_file() {
        return Err(StoreError::StorageUnavailable(
            "store metadata is readable only beside a live store writer".into(),
        ));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let conn = Connection::open_with_flags(path, flags).map_err(recovery_on_corrupt)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute_batch("PRAGMA query_only = ON;")?;
    let unavailable = |error: rusqlite::Error| match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::CannotOpen | rusqlite::ErrorCode::ReadOnly) => {
            StoreError::StorageUnavailable(
                "store metadata is readable only beside a live store writer".into(),
            )
        }
        _ => recovery_on_corrupt(error),
    };
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(unavailable)?;
    if version != SCHEMA_VERSION {
        return Err(StoreError::RecoveryRequired(format!(
            "state.sqlite schema version {version} is not {SCHEMA_VERSION}"
        )));
    }
    let actual: String = conn
        .query_row("SELECT store_uuid FROM store_meta WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(unavailable)?;
    if actual != expected.as_str() {
        return Err(StoreError::RecoveryRequired(
            "launched store identity changed".into(),
        ));
    }
    Ok(conn)
}

/// Write the initial schema + identity into a brand-new scratch database.
pub(crate) fn initialize(path: &Path, store: &Uuid, owner: &Uuid) -> Result<(), StoreError> {
    let mut conn = Connection::open_with_flags(path, base_flags())?;
    // WAL is persistent in the file header: set it before publication so
    // racing first openers never contend on the DELETE -> WAL switch (which
    // needs an exclusive lock and can fail busy without waiting).
    apply_pragmas(&conn, true)?;
    let tx = conn.transaction()?;
    tx.execute_batch(INITIAL_SQL)?;
    tx.execute(
        "INSERT INTO store_meta (id, store_uuid, owner_principal_id, cursor_key, created_at) \
         VALUES (1, ?1, ?2, ?3, ?4)",
        (
            store.as_str(),
            owner.as_str(),
            new_key()?.as_slice(),
            now_utc(),
        ),
    )?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    conn.close()
        .map_err(|(_, error)| StoreError::Sqlite(error))?;
    Ok(())
}

pub(crate) fn settings(conn: &Connection) -> Result<ConnectionSettings, StoreError> {
    let get_i =
        |sql: &str| -> Result<i64, StoreError> { Ok(conn.query_row(sql, [], |row| row.get(0))?) };
    let journal_mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    Ok(ConnectionSettings {
        journal_mode: journal_mode.to_ascii_lowercase(),
        synchronous: get_i("PRAGMA synchronous")?,
        foreign_keys: get_i("PRAGMA foreign_keys")? == 1,
        busy_timeout_ms: get_i("PRAGMA busy_timeout")?,
        user_version: get_i("PRAGMA user_version")?,
    })
}

fn recovery_on_corrupt(error: rusqlite::Error) -> StoreError {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt) => {
            StoreError::RecoveryRequired("state.sqlite is not a valid store database".into())
        }
        _ => StoreError::Sqlite(error),
    }
}

fn recovery_on_corrupt_store(error: StoreError) -> StoreError {
    match error {
        StoreError::Sqlite(inner) => recovery_on_corrupt(inner),
        other => other,
    }
}
