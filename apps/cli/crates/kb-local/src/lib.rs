//! On-device knowledge-base backend: the managed multi-KB store behind
//! `kb mcp --root <store>`.
//!
//! Layout of a store root (owner-only directories, no-follow access):
//!
//! ```text
//! <store>/state.sqlite                         durable registry (NOT disposable)
//! <store>/locks/store.lock, kb_<id>.lock       persistent OS lock files
//! <store>/repos/kb_<id>.git                    bare Git repositories
//! <store>/assets/, <store>/uploads/            CAS blobs and staging
//! <store>/indexes/<kbId>/<generationId>.sqlite disposable derived indexes
//!                                              (built as `<generationId>.tmp`)
//! ```
//!
//! * [`Store::open`] initializes an empty directory exactly once (identity is
//!   published by an atomic rename). A nonempty directory without
//!   `state.sqlite` fails closed with [`StoreError::RecoveryRequired`] (kb/1
//!   `REPAIR_REQUIRED`); identity and authority are never silently recreated,
//!   and no arbitrary directory or worktree is adopted.
//!   Long-lived MCP hosts use [`Store::reopen`] with the launched directory
//!   handle and store UUID; losing/replacing either fails before initialization.
//! * Losing only `indexes/` clears each affected active-generation pointer and
//!   flags the KB rebuildable; store UUID and KB IDs are unchanged.
//! * Writers serialize on OS file locks — store lock first, then sorted KB
//!   locks ([`WriteGuard`]). See [`locks`] for Unix extra-fd drain and Windows
//!   handle-list / kill-on-close Job Object drain.
//! * Local attachment identity: `kb-local://<storeUuid>/<kbId>`, sealed
//!   namespace `UUIDv5(NAMESPACE_URL, b"flycockpit/knowledge-attachment/v1\0local\0" + locator)`
//!   — the shared kb-client algorithm, fixture-tested against
//!   `packages/api/src/lib/kb/fixtures/attachment.json`.
//!
//! * Git reads ([`git_read`]) are hardened (emptied env, no config/replace
//!   refs/hooks), supervised (deadline watchdog, capped output) and
//!   read-only; a readable revision is a commit reachable from a branch of
//!   THIS repository. [`tree`] is the shared whole-tree validator (identical
//!   decisions to `packages/api/src/lib/kb/validate-tree.ts` on the shared
//!   corpus) and [`markdown`] the source/front-matter parser.
//!
//! * Publication ([`journal`], [`git_write`], [`recovery`]) is a durable
//!   one-ref journal: PREPARED -> COMMITTING -> FINALIZED | ABORTED per
//!   actor + KB + operation + idempotency key, objects fsynced before
//!   COMMITTING, an expected-old CAS on `refs/heads/main`, and success only
//!   after the SQLite finalize. Every locked Git child inherits the store lock
//!   (descendant drain). Recovery runs under the store lock at open, at every
//!   write-lock acquisition and from gated reads ([`Store::read_kb`]):
//!   ref == intended finalizes once, ref == old aborts with a stable
//!   receipt, any third SHA marks the KB `REPAIR_REQUIRED` (never
//!   reset/adopt).
//!
//! * KB lifecycle ([`bases`]) and the immutable document catalog
//!   ([`documents`]) return the common kb/1 output types: create through
//!   the journal (owner, or a CONFIG/TEST principal with a create
//!   capability that grants exactly its `created_kb_bits`), metadata update
//!   and owner tombstone as FINALIZED receipts, live-KB quota and creation
//!   window from [`limits`] (lower-only), and HMAC page cursors keyed by
//!   `store_meta.cursor_key` and bound to principal, KB, filter, pinned
//!   revision and a 15-minute expiry.
//!
//! * Atomic edits ([`changes`]) and proposal ownership ([`proposals`]):
//!   `knowledge_changes_apply` (edit mode) and the single-document wrappers
//!   share one service — upfront validation with zero effects on rejection,
//!   one commit to main (write) or an owned proposal source (auto
//!   `refs/heads/pr/<n>` for propose-only or an explicitly named
//!   proposal), identical replacements as durable noop receipts, per-KB
//!   proposal numbers allocated in the finalize transaction, and the exact
//!   `ApplyResult` as the replay response. [`assets`] and [`manifest`] add
//!   actor-owned READY consumption, canonical manifests, permanent recipient
//!   lineage and source-readable reachable-revision imports under sorted locks.
//!   Catalog/lineage/consumption commit only with journal finalize; durable
//!   upload bindings protect recovery from TTL cleanup. Historical asset lists
//!   and Markdown asset references resolve the cited manifest. [`uploads`]
//!   supplies the begin/write/finish
//!   trio, durable pending-frame intent, READY staging, and an owned minute
//!   expiry timer. Durability attempts are durably poisoned before file writes
//!   and cleared only after successful fsync; uncertain attempts need a new
//!   begin key. Existing begin replay preserves staging on temporary I/O errors.
//!   New begin and finish share a durable 60/minute actor+KB window; frames and
//!   exact begin replay are exempt. Indexed admission excludes retained expired
//!   receipts. Cleanup retries require the directory barrier even after ENOENT.
//!   [`cas`] publishes immutable blobs under the same store fence used by its
//!   bounded orphan-temp sweeps; already-fenced consumers use publish_cas_locked.
//!   [`mime`] sniffs media. These synchronous filesystem services require local
//!   volumes: lock admission is bounded to five seconds, but kernel I/O stalls
//!   and a caller's synchronous Read do not have a cancellable wall-clock bound.
//!
//! * Dreams ([`dream`]): `knowledge_changes_apply` dream mode through the
//!   same service — deterministic Markdown byte-identical to the server,
//!   existing ID keeps its path / new ID -> `concepts/<id>.md`, human or
//!   absent provenance protected (FORBIDDEN), sealed references and known
//!   credential patterns ([`sensitive_text`], a conservative floor) reject
//!   the whole dream before any effect, digest-only Git trailers, a noop
//!   receipt keeping model/source metadata, and a proposed dream's
//!   persisted merge-guard input checked by [`Store::dream_merge_guard`].
//!
//! * Reviewed PRs ([`pull_requests`], [`diff`]): owned user branches and
//!   actor auto-proposals, immutable base/head diff pages and manifest deltas,
//!   review-only FF or clean divergent merges (main first parent), current
//!   dream provenance guard, whole-result validation, and MERGED/main/desired
//!   epoch journal finalization and recovery once. Terminal branches remain
//!   reachable and immutable.
//!
//! * Revision exports ([`exports`], [`transfers`]) validate a reachable Git
//!   snapshot before reserving one/actor and two/store durable slots. Private
//!   ZIP32 STORE artifacts stream CAS members, verify length/hash, and publish
//!   READY only after fsync. New generations spend the shared mutation window
//!   and reserve complete ZIP bytes plus pending uploads above the 1 GiB disk
//!   floor, measured with supervised OS utilities (measurement fails closed).
//!   Actor/live-read checks and sealed frame hashes gate
//!   every random-access 192 KiB frame. EOF starts a fixed ten-minute grace;
//!   acknowledgement/cancel/expiry reclaim only the artifact. Startup/admission
//!   and the existing minute timer recover abandoned WRITING receipts. The
//!   cloneable export control cancels lock admission, recovery and supervised
//!   children, bounds work to 120 seconds,
//!   and is the shutdown/join seam for the future stdio transport. As with CAS,
//!   a stalled synchronous kernel filesystem call cannot be forcibly cancelled.
//!
//! [`dispatch`] binds every common data-plane tool with canonical input/output
//! schemas. The CLI owns bounded stdio admission and index delivery; control
//! commands remain outside the catalog.

pub mod assets;
pub mod bases;
pub mod breaker;
pub mod cas;
pub mod changes;
pub mod chunk;
pub mod citation;
pub mod credentials;
mod cursor;
pub mod diff;
pub mod dispatch;
pub mod documents;
pub mod dream;
pub mod egress;
pub mod embed_service;
pub mod embedder;
pub mod exports;
pub mod fingerprint;
pub mod generations;
pub mod git_read;
pub mod git_write;
pub mod index;
pub mod index_format;
pub mod journal;
pub mod limits;
pub mod locks;
mod logical_merge;
pub mod manifest;
pub mod markdown;
pub mod metadata;
pub mod mime;
pub mod model_download;
pub mod paths;
pub mod plain_snippet;
mod pr_merge;
pub mod proposals;
pub mod providers;
pub mod pull_requests;
pub mod qwen;
pub mod recovery;
pub mod sealed;
pub mod search;
pub mod sensitive_text;
mod sqlite_vec;
pub mod state;
mod store;
pub mod structured;
pub mod transfers;
pub mod tree;
pub mod uploads;
mod vector_cache;
#[cfg(windows)]
mod win;

pub use journal::{
    CommitRequest, CreateKbRequest, FileChange, IntentRow, MAX_CHANGES, Phase, Receipt, Stage,
};
pub use locks::WriteGuard;
pub use paths::StorePaths;
pub use recovery::{ConsolidationDeferral, READ_GATE_TIMEOUT, RecoveryReport};
pub use state::{Bits, ConnectionSettings, LocalPrincipal, PrincipalKind};
pub use store::{KbRecord, KbState, NewKb, OpenStage, Store, StoreError, local_attachment};

#[cfg(test)]
#[path = "../tests/support/temp_dir.rs"]
mod test_temp;
