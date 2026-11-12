<!-- GENERATED FILE — DO NOT EDIT.
     Edit AGENTS.md, then run `cargo xtask sync-docs`. -->

# CLI agent & contributor guide

This file covers the Rust CLI under `apps/cli`. The repo-root `AGENTS.md` still
applies; use this file for CLI-specific conventions. Within this directory,
`CLAUDE.md` is a **generated copy** of this file.

> **Golden rule:** never edit the generated mirrors. Edit `AGENTS.md`, then run
> `cargo xtask sync-docs` (from `apps/cli`). CI fails if the mirrors drift
> (`sync-docs --check`).

---

## What this is

Companion Rust CLI `kb` for the knowledge-base: config, completions, local MCP,
and remote MCP. CI, cross-platform release builds, and installers live with it.

The CLI is intentionally **not** part of the pnpm/Turborepo graph — it has no
`package.json`, and `pnpm build` / `pnpm check-types` never touch it. All work
in here happens with `cargo`, run from `apps/cli`.

## Orientation — where things live

| Path | What's there |
|------|--------------|
| `src/lib.rs` | Shared implementation modules used by the binary and tests. |
| `src/main.rs` | Entry point: parse → init logging → dispatch → map errors to exit codes. Keep it thin. |
| `src/cli.rs` | All clap argument definitions. The *shape* of the CLI, no logic. |
| `src/commands/` | One file per subcommand, each exposing `Args` + `run(&Args)`. |
| `src/config.rs` | The TOML config struct, with `load()`/`save()`. |
| `src/remote.rs` | Agent-only `kb mcp --server`: origin-bound credentials, pinned catalog-subset/schema admission (advertises the server's validated list and instructions; refuses unlisted tools), one-attempt ciphertext forwarding with the stdio deadline/cancel token. |
| `src/paths.rs` | Cross-platform config/data/cache directories (via `dirs`), the model cache and embedding-worker runtime dirs. |
| `src/local.rs` | `--root`/config `root` selection shared by the local commands; read-only commands never create a store. |
| `src/logging.rs` | tracing setup. Logs go to **stderr**. |
| `src/exit.rs` | Stable process exit codes. |
| `tests/cli.rs` | Black-box tests that run the built binary. |
| `crates/kb-client/` | Reusable kb/1 protocol crate (types, schema evaluator with the generated groups/presets, errors, `scope.rs` local `--tools`/`--kb` discovery and call admission shared through `stdio::Advertised`) and the origin-bound MCP 2026-07-28 stateless HTTP client (`origin.rs`, `protocol.rs`, `client.rs`; SDK interop via `pnpm test:kb -- client-interop`), and the Cockpit host adapter seams (`attachment.rs` identity, `snapshot.rs` verified retrieval, `dream.rs` one-call dream apply, `sealed.rs` host-only sealed resolution). No CLI/UI dependency — never add `kb`, `clap` or tracing-subscriber to it. |
| `crates/kb-local/` | On-device managed store for `kb mcp --root <store>` (served through `commands/mcp.rs` under an owner-chosen `kb-client::scope::ToolScope` with live, side-effect-free discovery/admission reads from `metadata.rs`, bounded `kb-client::stdio`, and exhaustive `dispatch.rs`; owner/config principals and read-scope ceilings are selected by the launcher): durable `state.sqlite` registry (`src/db/0001_initial.sql` is the only durable schema file — extend it in place, never add a migration), owner-only no-follow managed paths (`paths.rs`), OS file locks with store-then-sorted-KB order and descendant-drain via inherited lock handle (`locks.rs`; Unix child-only extra fd, Windows explicit handle list plus kill-on-close Job Object and successor drain), local principals/permission expansion (`state.rs`), hardened supervised Git (`git_read.rs`: emptied env, `--git-dir`, no replace refs/grafts/shallow/commit-graph/hooks, repo-local config limited to an allowlisted `[core]` subset and alternates refused before every spawn, `cat-file --batch` with header-first budgets; readable revision = commit reachable from `refs/heads/*` of that repo), publication (`journal.rs` PREPARED/COMMITTING/FINALIZED/ABORTED one-ref journal per actor+KB+operation+key, `git_write.rs` lock-inheriting object/ref writes — every managed Git child, including ordinary readers without a caller guard, takes or reuses an identity-matched store lease at the single spawn boundary, retains it through child wait, and inherits it while keeping normal stdin — and `recovery.rs`: ref==intended finalizes once, ref==old aborts, third SHA -> `REPAIR_REQUIRED`, run at open/lock/gated read; a publication's lock (`Store::lock_publication`: commits, change sets, PR merges) then bounds its own KB's packs, which Git's own maintenance (disabled) would: when 8 unfrozen packs break the factor-2 progression or Git's loose-object sample is reached, a geometric rollup (at most 128 selected packs, capped at 32 MiB; packs of 16 MiB or more are frozen, so rewrites per written byte are bounded by construction; 2-second budget, skipped when the caller has less than budget plus 3 s left; disk-admitted) folds the small packs and loose objects into one pack, installed like a publication's pack; old packs are removed index-first only after the new index covers them, a durable SQLite cleanup intent records the covering pack, selected objects and exact retirement paths before installation; each later pass verifies that coverage and retires at most 256 entries, acknowledging them only after directory barriers, without scanning for cleanup debt; cleanup errors or a deferred rollup are recorded in `pack_consolidation`, spaces retries without shrinking the cap (completed maintenance and no-work passes clear it; fold and cleanup deferrals share retry spacing, while caller interruption leaves history unchanged) and is logged by the `kb mcp` sweep (`git_write::consolidate_objects`, `Store::consolidate_locked`); `tests/git_recovery.rs` kills real child processes at every stage), the shared whole-tree validator (`tree.rs`) and Markdown/restricted-YAML source parser (`markdown.rs`) — ports of `packages/api/src/lib/kb/{validate-tree,parse-markdown,manifest}.ts`; `tests/trees.rs` runs the shared `fixtures/tree-cases.json` corpus, so change both sides together. KB lifecycle (`bases.rs`: create via the journal, owner or CONFIG/TEST principal with a create capability granting exactly its `created_kb_bits`; metadata update and owner tombstone as FINALIZED receipts; live-KB quota and hourly create window from `limits.rs`, lower-only) and the immutable document catalog (`documents.rs`: list/get at one pinned reachable revision, 8 MiB response cap) return the kb-client output types; `cursor.rs` HMAC cursors use `store_meta.cursor_key`; private generation files use the shared index format 1 (`chunk_hash` per chunk text; `index_format.rs` reads `fixtures/index-format.json` and runs the shared `index-quantization-cases.json` corpus — change both sides together; built under `<gen>.tmp`, linked to `<gen>.sqlite`, `meta` verified on open; a KB without a usable non-built-in profile gets a lexical-only (FTS5) generation whose snapshot pins no profile and whose file uses `lexicalMetaStatement` with null profile columns, searched FTS-only with one `LEXICAL_ONLY` notice; `binary_int8_rescore` for every KB, chunk limit and rescore K drift-checked against `limits.ts`), FTS5 bm25 and statically registered sqlite-vec (`sqlite_vec.rs`); `generations.rs` pins desired profiles/jobs in the publication transaction, bounds builds with OS permits, reserves file/journal capacity under the producer fence with SQLite page caps, fences activation after fsync and protects readers through retention; cancellation acknowledges only after a durable attempt marker, completed capabilities own a drain permit, and recovery transfers attempt identity after deferred admission; built-in inputs are measured and split with exact source spans before inference (`index.rs`); builds copy unchanged chunks' vectors from the active file under an inherited int8 scale, checkpoint embedded batches in the per-KB `vector_cache.rs` file, run under a no-progress watchdog (`BuildDeadline`) and return to PENDING when the host interrupts them or their watchdog expires (`interrupt_generation`; only three no-progress watchdog stalls fail), wait for their lexical companion before a semantic claim, and keep a completed-but-unactivated generation COMPLETE for recovery; `tests/bases.rs` checks every output against the shared schema and drift-checks the constants against `limits.ts`/`cursor.ts`/`protocol/common.ts`. Atomic edits (`changes.rs`: `changes_apply` edit mode plus the `documents_{create,update,delete}` wrappers share ONE service; upfront validation incl. the whole-tree validator runs before the PREPARED row is inserted, so a rejected batch has zero journal/ref/PR/counter effects; identical replacement = durable FINALIZED noop receipt; the exact `ApplyResult` is the replay response; `assets.rs`/`manifest.rs` consume actor/KB/kind/TTL-bound READY staging through the same journal; canonical manifests require trusted metadata and permanent per-KB lineage, imports require live source read at a reachable listing revision under sorted locks, and catalog/lineage/consumption finalize atomically; historical asset lists and document assetRefs use the cited manifest) and proposal ownership (`proposals.rs`: write -> main, propose-only -> the actor's auto-PR `refs/heads/pr/<n>`, an explicit `proposalNumber` must be an active PR the actor's branch owns; `kbs.next_pr_number` advances only in the finalize transaction; `branch_owners`/`pull_requests` rows are immutable once CLOSED/MERGED via SQL triggers; proposals never touch the desired-index epoch). `tests/changes.rs` kills real child processes around the proposal ref move. Dreams (`dream.rs`, same service: deterministic Markdown byte-identical to the server on the shared `fixtures/dream-golden.json` corpus — change both sides together; non-`dream` provenance FORBIDDEN; sealed references and the `sensitive_text.rs` credential floor reject the whole dream; digest-only trailers; proposal rows persist the merge-guard input for `Store::dream_merge_guard`). Reviewed PRs (`pull_requests.rs`, `diff.rs`): list/get/create from owned USER branches, pinned complete file/asset pages, close by review or author+propose, and review-only FF/clean divergent merge (main first parent) with expected source/target SHAs. Logical conflicts (`logical_merge.rs`, a port of `logical-merge.ts` run on the shared `fixtures/logical-merge-cases.json` corpus — change both sides together; `pr_merge.rs` Git plumbing, every line merge in ONE `git merge-tree --merge-base` over flat synthetic trees exactly as the server, checked against the server-generated `fixtures/text-merge-cases.json`; Git >= 2.45, checked once at `kb mcp` startup): status, rebase status and the reviewed merge are one validated plan (`Store::plan_merge`) planned in a disposable object store (`GitRepo::staged`; only a successful publication promotes the objects its commit needs, trees written in batches), a request naming a PR against main carries the observed `proposalHeadSha`, cached per checked main and refreshed on list/get before filtering, a request against current main moves the PR onto main / resolves recorded `pending_conflicts` progressively / applies on its head, and updates and merges that still clash fail with typed `PROPOSAL_CONFLICT` details. Merge calls the dream guard under the KB lock, validates the entire result tree, and journals MERGED with main/desired epoch for once-only recovery. Retained terminal branches stay immutable. Shared lock admission is bounded to five seconds; PR calls share a 30-second Git/publication deadline. Recovery sweeps abandoned publish scratch under the drained store fence; PR and changes/document receipts require ACTIVE before replay. Locks never handed to a descendant are explicitly unlocked on drop (a concurrent fork would otherwise hold them until its exec). A nonempty store without `state.sqlite` fails closed (`REPAIR_REQUIRED`); never recreate it. Sealed values (`sealed.rs`): human `kb sealed enroll/grant/revoke`, bounded stdin/private-file UTF8, a random32-byte store key in the OS keystore, SQLite AES-GCM ciphertext with namespace/record/version AAD, absent-only record identity, disk-admitted key initialization/enrollment/grants and atomic revocation; owner revocation remains available during repair, KB tombstoning destroys ciphertext/grants while retaining identities, and immutable exports retain revoked symbols; common resolver requires live read, exact consumer/key approval, expiry and source occurrence at a reachable revision, and wraps through kb-client into a <=60-second recipient envelope. Source remains symbolic; index redacts; dreams reject references. Built-in models: weights in the per-user checksum-verified `model_download::ModelCache` (`models_dir`), inference in one shared per-user `kb embed-worker` (`embed_service.rs`: owner-only socket/pipe, single-instance lock, idle exit, crash restart); `qwen.rs` `ModelRuntime` pools client connections. Local rate limits are the store's own (`limits.rs` `LOCAL_*`). |
| `xtask/` | Project automation in Rust: `sync-docs`. Run via `cargo xtask`. |
| `docs/` | Async/storage conventions and release instructions. |

CLI CI lives at the **repo root**: `.github/workflows/cli-ci.yml` (checks),
`.github/workflows/release-preflight.yml` (pre-release gate), and the CLI jobs
in `.github/workflows/release.yml` (cargo-dist artifact builds). All of them run
cargo with `working-directory: apps/cli`.

## Setup & everyday commands

Run everything from `apps/cli`:

```sh
cargo build                       # build
cargo test --workspace --all-targets --locked  # unit + integration tests
cargo clippy --workspace --all-targets --all-features -- -D warnings   # lint (warnings are errors)
cargo fmt                         # format (CI checks `cargo fmt --all --check`)
cargo run -- --help               # run the CLI
cargo xtask sync-docs             # regenerate agent doc mirrors
```

Before you consider a change done, all of these must pass:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
cargo deny check
```

(`typos` also runs in CI; install local tools with
`cargo install cargo-deny typos-cli` to check locally.)

---

## Agent safety rules (hard constraints)

These are non-negotiable. They exist because they're the mistakes that are
easy to make and expensive to undo. The repo-root Agent Safety Rules apply on
top of these.

1. **Never weaken the lint or CI gates to make a change "pass."** Do not add
   blanket `#[allow(...)]`, `// clippy::` overrides, or delete CI steps to get
   green. Fix the underlying issue. Narrow, commented `#[allow(...)]` on a
   single item is acceptable only with a one-line justification.
2. **Never bypass commit or CI checks** (`git commit --no-verify`, `--force`
   pushing to the default branch, editing generated files by hand).
3. **No unaudited `unsafe`.** The CLI forbids it. Reviewed exceptions cover
   kb-local's child-only fd handoff, Windows process/ACL module, and static
   sqlite-vec registration in `sqlite_vec.rs`; each
   unsafe block requires a `// SAFETY:` justification. Other uses need approval.
4. **No secrets in the repo.** No API keys, tokens, or credentials in source,
   tests, fixtures, or commit messages — even temporarily. If one is committed,
   flag it for rotation.
5. **Don't add dependencies casually.** Each new crate is attack surface,
   license risk, and build time. Prefer the standard library. Before adding one,
   confirm it's needed, check it passes `cargo deny check`, and mention it. See
   "Dependencies".
6. **Don't print to stdout for anything but command output.** Logs, progress,
   and diagnostics go to **stderr** (use `tracing`). stdout must stay clean so
   `--json` output can be piped. See "Conventions".
7. **No `unwrap()` / `panic!` / `todo!` / `dbg!` in non-test code.** Clippy
   enforces this. Use `?` with `anyhow::Context`, or `expect("reason")` only
   when the invariant is truly local and documented.
8. **Don't run destructive shell commands** (`rm -rf`, `git reset --hard`,
   force-push) or `sudo` on the user's behalf. Ask first.
9. **Don't create backup copies** (`*.bak`, `*.old`, `foo copy.rs`). Git is the
   backup. Edit in place.

## kb/1 protocol contract (`crates/kb-client`)

- The canonical protocol is the TypeScript-generated artifact in
  `packages/api/src/lib/kb/protocol/` (`schema.json`, `fixtures.json`).
  `kb-client` embeds `schema.json` at compile time and its contract tests read
  `fixtures.json` directly — there is no Rust-side fixture copy. Change the
  protocol in TypeScript, run `pnpm kb:protocol:generate`, then re-run the
  cargo gate.
- The schema evaluator fails closed on any keyword or `pattern` it does not
  know; teach it (`src/schema.rs`) in the same change that adds one.
- The case-fold table in `src/path.rs` is a checked copy of
  `packages/api/src/lib/kb/paths.ts`; a unit test fails on drift.
- MSRV is `[workspace.package] rust-version` (1.96) for every package; the CI
  `msrv` lane runs the full test suite on the pinned 1.96.1 toolchain.
- CLI CI path filters must list every path the workspace reads (all of
  `apps/cli/**` plus the shared protocol inputs); `tests/contract.rs` checks it.

## Conventions

- **Error handling.** Application code returns `anyhow::Result<T>`. Add context
  at each boundary: `.with_context(|| format!("reading `{}`", path.display()))`.
  Reserve `thiserror` for a stable public library API (see
  `docs/error-handling.md`).
- **Error messages.** Quote identifiers and paths in `` `backticks` ``, never
  'single quotes'. Lowercase, no trailing period: `` error: no profile named `default` ``.
- **Exit codes** are a public contract; see `src/exit.rs`. `0` success, `1`
  generic failure, `2` usage (clap), `3` not-found. To set a specific code,
  attach `CodedError::new(ExitCode::…)`.
- **stdout vs stderr.** Results → stdout. Everything else → stderr.
- **`--json`.** Any command that prints data should support `--json` and emit it
  from a typed `Serialize` struct (see `src/commands/config.rs`), not hand-built
  strings. Declare the flag on the
  command's own `Args`; if the command has subcommands, add `global = true` so
  it works on either side of the subcommand. Use `src/output.rs` for stdout
  writes so command output stays deliberate and diagnostics stay on stderr.
- **Tests live next to code** (`#[cfg(test)] mod tests`) for pure logic, and in
  `tests/` for black-box CLI behavior. `.unwrap()` is fine in tests.
- **Talking to the app.** Browser cookies are not CLI/MCP credentials. Headless
  access uses tokens minted for that purpose.

## Adding a command

1. Add `src/commands/<name>.rs` with `Args` and `run`.
2. Register the module in `src/commands/mod.rs`.
3. Add a variant to `Command` in `src/cli.rs` and a match arm in `src/main.rs`.
4. Add black-box tests in `tests/cli.rs`.

## Dependencies

- Versions live in `[dependencies]` in `Cargo.toml`. Keep the set small. The
  pnpm catalog does **not** apply here; Dependabot covers `apps/cli` with a
  dedicated cargo ecosystem entry in the root `.github/dependabot.yml`.
- Prefer crates that are widely used, actively maintained, and license-compatible
  with `deny.toml`'s allowlist (MIT/Apache/BSD/ISC/etc.).
- For async and storage, reuse the existing runtime/store boundaries described
  in `docs/`; a new TUI needs dependency approval.

## Releasing

CLI releases are cut by the **root** `Release` GitHub Actions workflow
(`.github/workflows/release.yml`), which drives `dist` (cargo-dist). The flow:

1. Bump `version` in `apps/cli/Cargo.toml` and merge it to the default branch.
2. In GitHub Actions, run the **Release** workflow with `version = vX.Y.Z`. It
   validates the tag against `apps/cli/Cargo.toml`, runs the preflight gates,
   builds all platforms, generates installers + checksums, and publishes a
   GitHub Release with archives, shell/PowerShell installers, `sha256.sum`,
   and `THIRD_PARTY_LICENSES.html` generated by cargo-about from `about.toml`
   and `about.hbs`.

Release **orchestration** lives in the root `.github/workflows/release.yml`;
cargo-dist **artifact** settings (targets and installers) live in
`dist-workspace.toml` here. When you change `dist-workspace.toml`, run
`dist generate` locally to inspect the generated workflow and port the relevant
changes into the root workflow deliberately — CI has no release-drift check.
See `docs/releasing.md`.

## Operational documentation

Keep [CLI](../../docs/cli.md), [MCP](../../docs/mcp.md),
[embeddings](../../docs/embeddings.md) and [host adapter](../../docs/cockpit-adapter.md)
aligned with shared schemas and real fixture commands. `state.sqlite` is not
disposable; indexes are derived. Sealed enrollment/provider secrets require a
native keystore, while remote credentials are private and origin/resource-bound.
Report missing platform/model checks as incomplete. Never claim a host spike
certifies another architecture. Native build jobs are capped at three.
