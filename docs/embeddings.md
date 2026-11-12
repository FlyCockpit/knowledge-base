# Embeddings, generations and model evidence

Each KB selects a user-owned OpenAI-compatible provider revision or the
admin-enabled `SYSTEM_BUILTIN` provider. No built-in starts enabled. The admin
chooses one active EmbeddingGemma 2 or Qwen model; Gemma is recommended when it
fits. Context tiers are 1024 (default), 2048, 4096 and 8192 tokens, including
prefixes/special tokens. The UI ranks measured quality first among options below
90% of worker-available memory and offers smaller options. Above 70% requires
acknowledgement; at or above 90%, or unknown memory, admission fails closed.
The limit comes from cgroups, then host RAM. Low-RAM operators can use only an
external provider. [CLI owner commands](./cli.md) apply the same model choices.
Both built-in models are Apache-2.0: `ggml-org/embeddinggemma-2-GGUF` (based on
`google/embeddinggemma-2`) and `Qwen/Qwen3-Embedding-0.6B-GGUF`. Weights are
downloaded only after the admin opts in and are never bundled
([third-party notices](../THIRD-PARTY-LICENSES.md)).

## Provider custody and search

Register keys in the human provider page; server revisions encrypt keys with
`KB_MASTER_KEY` and purpose/owner/version AAD. Keep that key separately for
recovery. HTTPS public-IP egress is pinned per connection, with no redirects or
alternate endpoint guessing. Local owners may explicitly opt into literal
loopback development; remote service providers never gain private networking.
Exact vector count/index permutation, dimension 1–2000, finite f32 values and
positive norm are validated; the vector itself is passed on raw. Every embedder
(external providers and both built-ins, server and CLI) returns raw pooled
vectors that are generally not unit length (the real Qwen output has norms
near 100, Gemma near 1,000). The index format normalizes exactly once,
`u = f32(v / ‖v‖)` with the norm in f64: on write (before int8 calibration,
quantization and the sqlite-vec arm) and on the query arm. Server and CLI
produce the same bytes for the same raw vector (shared fixture
`packages/test-utils/src/kb/embedding-normalization.json`, recorded from the
real models). Vector reuse and the CLI checkpoint copy already-normalized data
and never normalize again. RRF fuses ranks, so it does not depend on norms. Revoke destroys ciphertext and
query capability: retained vectors alone cannot serve hybrid search, so the
KB's index serves its lexical arm (below).

Git changes and profile/config changes enqueue durable jobs pinned to source,
revision, dimensions, fingerprint and desired epoch. Complete generations swap
atomically after validation; no mixed vectors. A per-generation SQLite file
(FTS5 + sqlite-vec) serves remote search; the CLI's local store uses the same
file format, tool shapes, filters and citation contract. Arbitrary prose rank
scores can differ between server and CLI. Both arms have at most 80 candidates;
RRF uses `1/(60+rank1)`, rank1 starts at 1, first weight 1/61, with path/chunk
tie breaks. A hit's `score` is that sum normalized by its maximum for the arms
that ran, `rrf * 61 / arms`, so it lies in (0, 1]: 1 means first in every arm,
and a hybrid hit found by only one arm scores at most 0.5. It measures rank
agreement between the arms, not calibrated relevance; compare scores within one
reply only. A hit's `snippet` is plain text on every transport (MCP, CLI and
web): Markdown markup is reduced to its text (shared corpus
`fixtures/plain-snippet.json`); its `span` still cites the exact source bytes.

The lexical arm matches any query word. A word with punctuation inside
(`e-mail`, `3.14`, `user@example.com`) needs all of its letter/digit runs;
text in double quotes is an exact phrase. Query words are always plain terms,
never FTS5 operators. Common words (`how`, `the`, `my`, `para`, `cómo`: the
English and Spanish lists in `packages/api/src/lib/kb/fixtures/stopwords.json`)
are dropped outside quotes, unless the query has nothing else; every other
word of the query takes part. Hits rank by how many of the query's words they
match, then bm25, so a chunk with every word ranks above one with some.
In a hybrid search the lexical arm keeps only
chunks that match more than half of the query's words: a note that shares one
incidental word with a paraphrased question no longer outranks the vector
arm's best hit (with stopwords dropped and all-words-first ranking alone,
real Gemma reached only 12/20 first hits on the shared corpus; with it, 20/20).
A lexical-only search keeps every match. Server and CLI build the same words from the shared corpus
`packages/api/src/lib/kb/fixtures/fts-query.json` and are scored on the shared
retrieval corpus `fixtures/retrieval-quality.json` (25 notes, 20 paraphrased
and 7 keyword queries): CI replays a recorded Gemma vector ranking, and the
real-model lanes (`pnpm test:kb -- qwen-model`, CLI `qwen_model -- --ignored`)
run the real model.

## Search index files

The worker writes each generation to one immutable file,
`index/<kbId>/<generationId>.sqlite` under `KB_DATA_ROOT`. It is built under a
temporary name, closed and fsynced, then published by hard-linking the
temporary file to the final name, unlinking the temporary name, making the file
read-only and fsyncing the directory. Publication refuses an existing final
file, so it never overwrites one; only a retried build, inside its fenced
publish step, first removes its own earlier attempt's file. The server opens
published files read-only from a small pool of reader threads; it never writes
them. The lexical arm is FTS5 bm25; the vector arm is sqlite-vec. Each KB picks a
vector quantization, and changing it schedules a rebuild:

| Quantization | Stored vectors | Search |
| --- | --- | --- |
| `binary_int8_rescore` (default) | bit vectors plus int8 | hamming candidates, int8 cosine rescore |
| `int8` | int8 with a per-file calibrated scale | int8 cosine |

For `binary_int8_rescore`, both server and CLI rescore one hamming candidate per
200 eligible chunks, rounded up, with a minimum of 200 and a maximum of 2,000:
`K(n) = clamp(ceil(n / 200), 200, 2000)`. At 400,000 eligible chunks, K is 2,000.
The vector arm returns at most 80 candidates after the int8 cosine rescore.

The hard chunk bounds are **200,000 for `int8`** and **400,000 for
`binary_int8_rescore`**. A KB's default limit is `min(400,000, bound[q])`,
so int8 defaults to 200,000. An instance admin sets a ceiling per quantization
in admin settings; an absent ceiling uses the same clamped default. The owner
may set a limit up to the smaller of that ceiling and the quantization's bound.
Stored limits and ceilings above a bound are clamped on read. A build uses the
smallest of the KB limit (or default), the ceiling and the bound, and fails
before any embedding spend if its chunk count exceeds that limit.

Switching quantization requires the stored KB limit to fit the target ceiling
and bound, and the active generation's chunk count to fit the target effective
limit. Otherwise the switch is rejected: the owner must lower the stored limit
first, or reduce the indexed content and rebuild. Quantization needs KB manage
access; the limit is owner-only. These settings live in the web control plane
and are never MCP tools. The CLI uses binary rescoring only, with a default
clamped to its 400,000 bound and optional lower local limits.

Builds are incremental. Index format 1 stores a SHA-256 of every chunk's
text (`chunk_hash`). When at least half of a new
build's chunks have an unchanged twin in the KB's newest retained hybrid file
(the active one first, else one a lexical index of a newer commit retired) of
the same profile fingerprint, dimensions and quantization, the build inherits that
file's int8 scale and copies the stored vectors of every unchanged chunk, so a
one-line edit embeds only the changed chunks (server and CLI). Otherwise it
calibrates afresh and embeds everything. The CLI also checkpoints every
embedded batch in `indexes/<kbId>/vectors.sqlite` (exact unit vectors keyed by
chunk hash, removed once a generation activates; it only ever holds the
current desired generation's chunks of the current profile, every committed
batch resets stall accounting in the same transaction, and under the KB build
permit it is reclaimed once no semantic generation is resumable: supersession,
revocation, lexical activation, retention or KB removal): a build interrupted when
`kb mcp` exits, by a crash or by its watchdog goes back to PENDING and the next
attempt (in this or a later session) embeds only what is missing. A session
ending, a crash or a killed process never counts against a build; only three
watchdog expiries in a row that embedded nothing mark it FAILED
(`INDEX_BUILD_STALLED`). A CLI attempt has no fixed deadline: every finished
bounded group of documents or embedding batch extends a five-minute
no-progress window, up to six hours per attempt. The CLI reserves storage
in capacity slabs and reads the pinned tree once, so unchanged documents do
not each trigger catalog traversal or a durable disk reservation.

### Generation and attempt states

A **generation** is desired work (one commit, one profile or none, one epoch);
an **attempt** is one try at building it. Attempt outcomes never decide
still-desired work: only newer desired work (a later epoch of the same KB)
or a repeatedly observed no-progress stall makes a generation terminal.

| From | Event | To |
| --- | --- | --- |
| — | scheduled (commit, profile set, rebuild, revoke) | PENDING (a semantic build while nothing of the head commit is active, an older hybrid included, also schedules its lexical companion one epoch below) |
| PENDING | claimed (a semantic one only once its companion is built or settled) | BUILDING |
| PENDING, BUILDING, INDEXING, or COMPLETE not yet active | newer desired work for the KB | SUPERSEDED |
| BUILDING | host interruption: shutdown cancellation, process exit or crash (CLI) | PENDING (resumes from the checkpoint) |
| BUILDING | watchdog expired with no progress (CLI) | PENDING; the third such stall in a row → FAILED |
| BUILDING | lost worker or attempt failure (server) | retried by the durable job (bounded retries) |
| BUILDING | build error (provider failure, chunk limit, disk full) | FAILED |
| BUILDING (server INDEXING) | file published | COMPLETE |
| COMPLETE | activation: still desired, or a companion that outranks the active generation (serve order below) | active |
| COMPLETE awaiting recovered activation, file missing (CLI) | recovery would activate it | FAILED (`INDEX_FILE_LOST`); the KB is rescheduled, the store never blocks |
| COMPLETE | attempt expired or cancelled before activation, profile momentarily unusable | stays COMPLETE; recovery (CLI, in serve order, falling through a refused activation) or the job retry (server) activates it under a fresh attempt |
| active or an outranked COMPLETE generation | another generation activates above it in the serve order | SUPERSEDED at once |

The CLI walks this table in `tests/index.rs`
(`generation_state_machine_walks_every_transition`), the server in
`generations.integration.test.ts`, both including an active older hybrid plus
a new head.

**Serve invariant.** One definition on each side (`Store::serve` in the
CLI's `generations.rs`; `serveRankSql` and `lexicalServesSql` in the server's
`generations.ts`) decides what serves a KB: the best activatable generation in
the order desired generation (what the configuration asks for: semantic, or
lexical with no usable profile) > semantic of the head commit > lexical of the
head commit > the newest generation of an older commit. After a commit the new
head's lexical companion serves as soon as it completes and stays until
semantic@head activates (read-your-writes); an older generation serves only
while nothing of the head is servable yet, i.e. before the companion
completes. What serves never depends on how semantic@head's build is doing, so
no claim or progress window can change it. Scheduling guarantees lexical@head
exists or is being built whenever nothing of the head commit is active;
activation and CLI completion recovery follow the order. A query whose
embedding fails degrades to the serving generation's keyword arm. Search
admission decides whether the serving generation can embed a query now with
one predicate (`queryAvailability` on the server, `Store::query_available` in
the CLI): the profile is usable and a built-in is enabled, serves the pinned
model and is not reloading under an exclusive config probe. An unpinned
server search whose embedding fails is re-admitted, within the same deadline,
to the generation active at that moment (its FTS5 arm), and every reply field
(generation, indexed commit, freshness, notices) comes from that generation
and the status read with it; a cursor-pinned one keeps its generation and
reports it stale when it is no longer active.

Builds reserve disk on the data volume's quota account before writing and fail
with a disk-full reason instead of filling the filesystem. A failed build
deletes its temporary file and journal at once. Retention deletes the remaining
files of superseded generations seven days after retirement, and of failed
generations one day after their final attempt. A reconciler removes abandoned
temporary files after a five-minute grace. If a published file is missing
or proven corrupt, CLI search retries once with fresh admission within the
same deadline, which charges the query budget again. A readable retained
lexical generation of the head serves immediately and is reused as the
semantic rebuild's companion.
A missing file of a superseded generation pinned by a cursor returns
INVALID_CURSOR without a retry, and a failed read-transaction commit returns
INDEX_UNAVAILABLE without a retry. The index is never backed up; restore
rebuilds it from Git.

Ordinary chunks use 400 Unicode whitespace words with 80 overlap. Built-in
chunks further split to fit the model context, retaining overlapping exact
source byte/token spans and window ordinals. Credential-shaped windows are
skipped, sealed symbols redacted before embedding/FTS, sensitive queries refused.
This is a conservative floor; clients must redact their own secrets before
upload/dream. Citations pin full Markdown SHA-256, blob/commit and source span;
fetch immutable source at the cited SHA, even after HEAD advances.

A usable previous-settings index serves during sequential built-in rebuilds,
with `EMBEDDING_REBUILD_PENDING`. After model identity change, lexical-only hits
carry `mode:"lexical"` and `EMBEDDING_MODEL_CHANGED`; a stop/probe gap reports
`EMBEDDING_RUNTIME_RELOADING`. These are explicit model transition cases.
Every generation file carries the FTS5 arm, so search always keeps a lexical
index. A KB with no embedding profile, or whose user provider can no
longer embed (revoked, owner gone), gets a lexical-only generation: an FTS5
file with no vector tables whose generation row and `meta` pin no profile.
Revoking a provider schedules that generation for every live KB on it, in the
revocation transaction. When semantic search can't run for a hybrid
generation, search serves the same file's FTS5 arm instead of failing:

| Cause | `LEXICAL_ONLY` detail |
| --- | --- |
| No profile selected | `NO_EMBEDDING_PROFILE` |
| Provider revoked | `EMBEDDING_PROFILE_REVOKED` |
| Built-in disabled or removed, provider unready, or the query embedding failed, timed out or was invalid | `EMBEDDING_PROFILE_UNAVAILABLE` |
| A newly chosen profile's first hybrid build is still running | `SEMANTIC_INDEX_BUILDING` |

Those hits carry `mode:"lexical"`; the web UI shows "Keyword search only: no
embedding model is selected" or "the embedding model is failing (reason)".
A search has one effective mode: it can only drop from hybrid to keyword
ranking, when the profile is lost or the query embedding fails, at any
point up to the reply (a profile lost after the vector arm ran re-ranks by
keyword). That classification is closed on both sides: only a failed
embedder (provider or model error, including a provider rate limit, or an
invalid embedding), the embedding call's own timeout, the model rejecting the
query as longer than its context, and a lost profile degrade. The decision is by
purpose: these degrade only a query; a build's embedding errors fail or retry
the attempt. Timeouts keep their source: an
admission, lock, Git or storage deadline is never the embedding timeout (and in
CLI builds never a watchdog stall; only the attempt's own no-progress watchdog
counts as one). The tag is raised only at the provider or
model call itself (`EmbedderCallError` on the server, `StoreError::EmbeddingFailed`
in the CLI); an adapter's own admission, authority and SQL work never carries it. Losing read authority, a generation lease,
the request, the index file, or an SQL failure always fails the search. Structured-search cursors pin the page's ranking mode: a
keyword-ranked page continues keyword-ranked even after the profile
recovered, and a hybrid-ranked page whose continuation could only rank by
keyword returns INVALID_CURSOR (restart the search; it then ranks by
keyword). The query embedding waits at most 8 s, and never more than the search
budget minus a reserve (10 s, at most a quarter of what is left), so a slow or
unreachable embedder still leaves time for the lexical arm. A provider
revision or built-in model whose query embedding timed out is then
skipped for 30 s: searches serve the lexical arm at once
(`EMBEDDING_PROFILE_UNAVAILABLE`) instead of each waiting out the timeout.
After the pause one search tries again (half-open); success resumes hybrid
search, another failure doubles the pause, up to 5 minutes. Each server
process and each `kb` process keeps its own breaker
(`packages/api/src/lib/kb/embed-breaker.ts`, CLI `breaker.rs`). Index status agrees: a COMPLETE active generation stays
current or stale while it serves lexically. Whenever nothing of the KB's head commit is active
(a new KB, a lost active file on the CLI, or any index, hybrid included, of an
older commit), a semantic build is preceded by a lexical-only companion of the same commit,
one epoch below it, built first: search serves the new commit keyword-only
(`SEMANTIC_INDEX_BUILDING`) as soon as it completes and stays so if the
semantic build fails or stalls, until a semantic
generation replaces it. The older hybrid stays the vector-reuse source. A
companion that finishes late never displaces an active semantic generation of
the head. A built-in
profile that is not build-current never replaces an index of the head commit
with a lexical one (it keeps serving, lexically while the model is
disabled), but a new head gets a lexical generation. Format 1
files stay readable, and retention never removes an active file; a missing
active file is an integrity error on the server and a rebuild (companion
first) on the CLI. INDEX_UNAVAILABLE remains for
a missing or unreadable index file or a failing SQL arm. Queryless structured
search is an explicit filter operation and is never substituted for a query.
Freshness is current/stale/building/failed/unavailable. Search has one
absolute 60 s budget across embedding, SQL and final authorization; each page
spends the query budget.

### Measured chunk bounds

The final P7 measurements on 2026-10-19 used the grouped writer at `0472968`,
cached Qwen 1024-dimensional vectors, and a quiet reference host: Intel
Core i7-8550U (4 cores / 8 threads), 65,831,739,392 bytes RAM (61.3 GiB),
NE-1TB NVMe disk with ext4, Linux 7.0.0-38-generic, Node v24.21.0.
The criterion is `max(warm p95, cold-pass p95, evicted-each p95) <= 2,000 ms`.
The bound is linearly interpolated at the threshold and rounded down in
100,000-chunk steps (`interpolateBound`).

Each warm/cold pass ran 200 real queries plus 20 frequent terms, unfiltered
and with a path-prefix filter (440 tasks). The evicted-each sample ran 20 tasks,
evicting the target file's page cache with `fadvise` before each task. Timing
covers the production `pool.read` round trip, including worker messages, FTS,
vector search/rescoring and RRF; query embedding is excluded.

| Quantization | Chunks | Warm p95 (ms) | Cold-pass p95 (ms) | Evicted-each p95 (ms) | Worst p95 meets 2 s |
| --- | ---: | ---: | ---: | ---: | --- |
| `int8` | 200,000 | 512.7 | 779.0 | 1,451.7 | Yes |
| `int8` | 300,000 | 789.9 | 1,223.4 | 2,386.6 | No |
| `binary_int8_rescore` | 400,000 | 638.8 | 610.8 | 1,798.0 | Yes |
| `binary_int8_rescore` | 500,000 | 817.4 | 806.8 | 2,467.8 | No |

Source results: `~/.cache/kb-bench-p7/latency-results-int8-grouped.json` and
`~/.cache/kb-bench-p7/latency-results-binary-grouped.json` on the measurement
host. These establish the limits on that reference host, not a latency promise
for other hardware or concurrent workloads.

## Pinned artifacts and native runtime

Weights download only on enable into `models/` on the data volume, never into
images.
The registry [fixture](../packages/api/src/lib/kb/fixtures/builtin-models.json)
pins exact commit URLs, hashes, sizes, prefixes, pooling and token behavior:

| Model | Artifact / bytes | SHA-256 | Dimensions / pooling |
| --- | --- | --- | --- |
| Qwen | Qwen3-Embedding-0.6B-Q8_0.gguf / 639150592 | 06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439 | 1024 / LAST |
| Gemma | embeddinggemma-2-Q8_0.gguf / 309855456 | 2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135 | 768 / MEAN |

Qwen commit `370f27d7550e0def9b39c1f16d3fbaa13aa67728` is in Qwen's
Qwen3-Embedding-0.6B-GGUF repository. Query prefix is
`Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: `
with an actual newline; documents have no prefix. No BOS; EOS 151643 exactly
once; causal batches capped at 512. Gemma commit
`bfcd298762cc34d0357ece5ebdd31791a3a374d8` is in ggml-org/embeddinggemma-2-GGUF.
It uses `task: search result | query: ` and `title: none | text: ` prefixes,
BOS 2/EOS 1 and one full-input noncausal batch. Both return the raw pooled vector; the index normalizes it (above).

Worker uses Node26 Debian glibc x64/arm64, `node-llama-cpp` 3.22.2 (the 3.22.x
line) with a pinned, unpatched source-built llama.cpp v0.7.0;
[embedding runtime pins](../packages/api/src/lib/kb/fixtures/embedding-runtime.json)
and [Rust vendor notes](../apps/cli/vendor/README.md) define the source closure.
Alpine/musl is not a supported worker image runtime (the static musl `kb` CLI
is separate: see [CLI](./cli.md)). Only a forked child loads the addon;
the API process never loads it. Native work is serial and bounded. After 15
minutes without running/admitted work the child exits; the parent waits for OS
exit before reload. Disable, parent death, timeout and shutdown kill/drain the
child before releasing its permit. Process exit frees native RSS.

Changes are load-probed at maximum context before activation: side by side if
both estimates fit, otherwise drain old child, record the reloading gap, and
restart last-good settings on failure. Interrupted probes fail visibly without
auto-retry. Built-in attached KBs rebuild one at a time deployment-wide.
Disable retains verified selected weights, so enabling again re-verifies
them without a download; obsolete weights are removed only when no retained
generation/lease references them. The admin's separate **Remove** (type
`REMOVE` to confirm; only once disabled or failed) deletes the downloaded
weights at the worker's next cleanup; enabling first voids the request. KBs
on the built-in keep keyword search meanwhile. Low-level oversize inference
returns EMBEDDING_INPUT_TOO_LONG; chunk adaptation avoids that for KB builds.

## Local CLI built-in (shared cache and worker)

A local store records only which built-in it enabled (`kb model enable`); the
weights live in one per-user model cache shared by every store:
`kb/models` under the platform cache directory (`~/.cache/kb/models` on
Linux), or `models_dir = "/absolute/path"` in the CLI config. A directory that
already holds the pinned file names (for example another program's model
directory) is used as a source: every file is trusted only after its pinned
size and SHA-256 match. Native code only ever parses an inode `kb` created
itself (exclusive creation, owner-only from the start, filled from the
stream that was hashed) through a directory chain nobody else can change:
downloads and adoptions are always created in the owner-only `verified/`
directory of the platform cache (a configured `models_dir` is only ever read),
and each such inode's creation mark is recorded (Unix device,
inode, size, mtime, ctime, mode and owner; Windows file ID, ChangeTime and an
owner-only ACL). A file loads in place only while its current mark equals
the recorded one; location proves nothing. Every other file, including one
whose mark no longer matches (any `chmod`, ACL change or write moves ctime),
is copied into a fresh `verified/` inode while hashing, then reused. Permissions are
not enough for a file `kb` did not create, because they say nothing about a
writer who opened it earlier. A marked file loads in place only while it and
every directory above it stay changeable by nobody but this user (Unix: owned
by this user or root, no group or world write bit, a root-owned sticky
directory such as `/tmp` excepted; Windows: an owner-only ACL); otherwise it
is refused. Weights are read into the worker's memory, never mapped, so a
loaded model holds no handle on the file. The worker re-checks the file and
its protection on every request: a replaced file or a changed mode,
directory or ACL stops the loaded copy serving. `kb model remove` takes the
per-model fence (no load starts or finishes meanwhile), requires proof the
model is released (the authenticated acknowledgement of THE worker (at most
one lives per identity), or the lifecycle lock every worker holds for its
whole life showing none is alive), then deletes `kb`'s own copy by name in
`verified/`, opened once without following links and proven to be the
owner-only directory `kb` created (its recorded identity), so it was never
redirected or swapped; everything in it is `kb`'s. The per-file creation mark
only decides whether native code may load a file in place. Nothing in a configured
`models_dir` is ever deleted, and every kept file is reported with the reason.
The removal is recorded in the private cache; a kept source is not adopted
again until an explicit `kb model enable` or `kb model download`.
It takes effect at once for every store: no store blocks it (like the server's
Remove), and stores that have the model enabled search by keyword with
`EMBEDDING_PROFILE_UNAVAILABLE` (and report their profile and the `builtin`
provider as unavailable: availability checks the cached file) until it is
downloaded again, then hybrid with
their existing generations (same fingerprint, no rebuild). `kb model disable`
requires the same release proof. Without it (a request using the model is
still running, or the worker is stalled or cannot be authenticated), both fail
with `DEADLINE_EXCEEDED`, `remove` deletes nothing, and the accepted release
still happens when that request finishes. `kb model status` shows the cache,
what is downloaded, the store's enabled model and the worker; `kb model
verify` re-hashes the cache; `kb model remove <model>` asks for confirmation
(`--yes` skips it) and prints each deleted and kept path. Downloads print progress on stderr
and publish atomically, and drop a damaged private copy that a load would
otherwise keep finding before the downloaded file (with the same provenance
proof); an interrupted download leaves only a partial file that the next
download removes.

Inference runs in one shared embedding worker per user, started on demand
as a detached `kb embed-worker` by the first `kb mcp` (or `kb model enable`)
that needs it. Every other `kb mcp`, for any store, connects to it: a Unix
domain socket in an owner-only (0700) runtime directory
(`$XDG_RUNTIME_DIR/kb`, else `kb/run` in the cache directory) with the peer
user checked on both sides, or on Windows a named pipe with an owner-only DACL
whose random name is published in an owner-only file there. Every worker
writes a fresh secret to an owner-only key file before listening and proves it
in the handshake (HMAC over a client nonce), so a stale or squatted endpoint
never receives document text. One OS lock per
worker identity (protocol, `kb` version, executable, model directory) keeps a
single instance; a crash leaves a stale socket that the next worker replaces.
The worker keeps at most one model in memory, runs one request at a time with
interactive queries ahead of index builds (but a waiting build or probe runs
after at most three queries, and requests for another model wait at most 16
others), and moves through Serving, Draining and Stopped. Index builds of
different KBs share it: each `kb mcp` runs up to two builds at once and a
store at most two built-in builds, so a small incremental build finishes
between a large build's batches instead of after it. The worker starts
draining 15 minutes after its last successful request (decided at every
dequeue, so a stream of failing requests cannot keep it alive). A draining
worker accepts no new connection and unpublishes its endpoint, finishes its
running request and accepted releases, releases its model and only then hands
the identity to a fresh worker: at most one live worker per user identity,
ever. Queued callers retry and wait for that fresh worker (at most one
in-flight request, bounded by their own deadline and cancellation). It also
ends itself if one request runs over ten minutes, and is restarted
transparently by the next request. A request abandoned by its caller is
skipped. When the worker cannot start, searches fall back to the lexical arm
with the `EMBEDDING_PROFILE_UNAVAILABLE` notice. Attach a KB to the
enabled built-in with `kb providers attach --kb <KB_ID> --provider builtin`
or `knowledge_embedding_profile_set` with `providerId: "builtin"` (no
revision needed).

Build scratch (`<generation>.tmp` and its journal) of a generation that is not
building is removed by the next retention pass of a running `kb mcp` (about
once a minute), and so is its `.cancel` intent once it can no longer be
activated (it settled, or it is the active one). Lock files go once nothing
can take them again: a generation's completion permit when it is superseded,
failed or cancelled, its read permit when it failed, was cancelled or is
reclaimed, and a deleted KB's lock and build permit when its repository and
index directory are purged (each pass sweeps a bounded page, in name order;
Windows keeps held lock files).

## Execution evidence boundary

The early Qwen host spike used x64 Node25.7.0/rustc1.96.1. It is evidence about
that host only. Patched Gemma/Qwen host measurements informed memory formulas;
they do not establish Node26 image or arm64/macOS/Windows runtime readiness.

Mandatory architecture smoke is `.github/workflows/kb-model-smoke.yml`: real
Node26 worker x64/arm64 and both models on all shipped Rust release targets,
nonzero selected tests, checksum-keyed weights and architecture-tagged evidence.
Run `pnpm test:kb -- qwen-model` for the local real-image lane; the explicit Rust
model command is in [apps/cli README](../apps/cli/README.md). The aggregate status
requires every leg. Cross-compilation and fake inference tests do not prove it.
Architecture lanes not executed in a documentation pass remain incomplete in
its handoff; do not relabel missing evidence optional or passed. The handoff
records actual commands/results separately from inherited spike reports.
