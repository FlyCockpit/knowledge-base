# SQLite state and indexes

kb-local already uses bundled rusqlite. Reuse its `Store`/database helpers and
existing owner-only, no-follow filesystem/locking boundaries; do not add another
`kb.db` or an independent migration system. The fresh durable schema is
`crates/kb-local/src/db/0001_initial.sql`, extended in place. `state.sqlite`
contains authority, identities, receipts/journals, proposals and provider/sealed
metadata and is not disposable. Missing state in a nonempty root fails closed.

Per-generation files under `indexes/` use the shared SQLite index format v1
(`packages/api/src/lib/kb/fixtures/index-format.json`, the same file the server
writes and reads; `index_format.rs`), FTS5 and statically linked sqlite-vec.
They are built under `<generationId>.tmp` in `journal_mode=DELETE`, closed,
fsynced, header-checked and then hard-linked to `<generationId>.sqlite` (never
replacing a file); readers verify the single `meta` row written last. The CLI
builds every KB as `binary_int8_rescore`; quantization follows the shared
`index-quantization-cases.json` corpus, so change both sides together. They are
derived and rebuildable from Git/pinned profiles. Never load arbitrary SQLite
extensions. Publication and recovery must preserve store-then-sorted-KB locks
and descendant drain.

Tests use private temporary stores and deterministic fake providers, never user
state. Native platform tests must execute durability and locking boundaries;
cross-compilation cannot prove runtime filesystem behavior. See
[CLI operation and custody](../../../docs/cli.md) and [agent rules](../AGENTS.md).
