# Assets and immutable downloads

Assets live outside Git in SHA-256 content-addressed storage under `assets/` in the `KB_DATA_ROOT` data volume.
Repos, assets, models and the search index share that filesystem and one disk-quota account.
Each KB commits a canonical sorted `.assets/manifest.json`:
`{version:1,entries:[{path,hash,size,mime}]}`. A hash never grants access. Every
entry must match trusted sniffed metadata and permanent per-KB lineage. Blobs
are published without replacing existing bytes; deleting a current manifest
entry preserves historical assets. There is no asset garbage collection.

## Upload and import

Use `knowledge_upload_begin`, contiguous `knowledge_upload_write` frames of at
most 196608 raw bytes, then `knowledge_upload_finish`. Staging binds actor, KB,
kind, declared hash/length and a one-hour TTL. Identical frame retries are safe;
changed bytes at a used offset are rejected. Finish does not commit content:
consume the READY handle through `knowledge_assets_put` or an atomic change set.
Asset uploads are at most 25 MiB; Markdown at most 2 MiB (128 KiB inline).
Propose-only consumers change a proposal manifest. A cross-KB import requires
current source read at a reachable revision plus target propose. Authorized
copied lineage survives a later source revocation; copying a hash alone fails.

The web editor's **Insert image** button, drag-and-drop and paste use the same
staging and `assets_put` path for PNG, JPEG, GIF and WebP. Each image is
committed at once (to main, or to your proposal when you can only propose) as
`assets/<name>-<hash8>.<ext>`, and a root-relative link such as
`![Diagram](/assets/diagram-1a2b3c4d.png)` is inserted at the cursor.

## Media and historical reads

The viewer renders safe Markdown/GFM and supported images/video/audio inline:
JPEG, PNG, GIF, WebP; MP4, WebM; MP3, WAV, Ogg. PDF is attachment-only; HTML, SVG
and unknown formats are rejected by the trusted MIME boundary. Text content is
Markdown only; there is no PDF/DOCX conversion. Raw HTML is skipped. External
media is not fetched by the saved-document preview.

`/kb-assets/:kbId/:hash?rev=<sha>` requires live session or complete bearer
admission, reachable same-KB commit, manifest membership and lineage at that
commit. One bounded Range is supported (206/416); no multipart ranges or public
signed download URL. Responses are private/no-store, nosniff and sandboxed.
Missing/corrupt catalog bytes fail STORAGE_UNAVAILABLE, never a partial success.
Removing HEAD's reference does not break a historical citation's manifest.

## ZIP and clone

Download assets-only or whole-KB ZIP from the UI or `kb export`. Whole includes
Markdown and that revision's assets; clone uses the [Git URL](./git.md) for full
Markdown history. ZIP paths are normalized/disjoint, with at most 8192 entries
and 256 MiB uncompressed; a 200 MiB export is supported. One active export per
user, two per server, 120 s generation deadline; preparation starts a 15-minute
expiry. `knowledge_export_prepare` pins a revision, size/hash and transfer ID;
`knowledge_transfer_read` returns at most 196608 raw bytes per reauthorized frame
for the preparing actor. Verify the full size/hash and durably save before
`knowledge_export_complete` acknowledges it and immediately releases the slot:

```json kb/1 knowledge_export_complete input
{
  "kbId": "abcdefghijklmnopqrstuvwx",
  "transferId": "00000000-0000-4000-8000-000000000001"
}
```

The last frame starts a fixed ten-minute grace, allowing a lost EOF reply to be
retried. It does not release the slot. Without acknowledgement, expiry reclaims
it; terminal failure releases immediately. After completion it is unreadable.
A lost acknowledgement leaves a verified local ZIP usable; do not claim the
server received it. See [CLI export](./cli.md).

## Storage boundary (P1)

Disk remains the only backend. Runtime injects a `BlobStore`; constructing it
performs no IO. Publication still completes before Git refs or catalog/lineage
finalization. Staging and ZIP artifacts keep their existing local directories.

| Surface | Storage owner | Preserved checks / evidence |
| --- | --- | --- |
| Staged assets and catalog publication | `publishCasBytes` delegates to `blob-store-disk.ts` | Hash, size, MIME, pinned temp inode, no-replace hard link, dedup verification and fsync; CAS and temp-race suites |
| GET, HEAD and Range | `authorizedAssetStream` owns a store reader with `download` purpose | Complete disk preflight, bounded frames, completion before terminal frame/HEAD, final live authority before enqueue; authorized-stream and asset-http suites |
| ZIP source assets | Same authorized reader with `internal` purpose | Revision/recipient/lineage checks and ZIP/transfer caps; exports and CLI export suites |
| Runtime/document/MCP publication | Explicit `blobStore` dependency, including the existing MCP runtime spread | No ambient backend fallback; staged documents, imports and changes suites |
| Offline backup/restore | Existing dedicated disk inventory/promotion modules | Archive layout unchanged; storage-aware offline operations belong to P5 |
| Git quarantine, push/merge scratch, local ZIP transfers and CLI local CAS | Existing owners | No new asset-byte reads or storage dependency |

`blob-store.ts` exposes verified metadata/durability and owned readers, with no
filesystem paths. Only disk internals and explicit disk fixtures use CAS path
helpers. `scripts/check-cas-ownership.mjs`, registered in `policy:checks`, guards
these operations and the disk modules' import purity with focused exceptions.
S3, cache accounting, storage configuration and offline mode migration remain
later phases; P1 adds no configuration or remote operations.

## Shared cache foundation (P2)

P2 adds the cache coordinator for the future S3 backend. Disk remains the only
selected runtime backend; no environment setting enables caching in this phase.
The cache modules perform no database, filesystem or network IO on construction.
They receive the recorded S3 storage generation, canonical configuration, actual
filesystem/root identity, transaction port, disk meter and role lifecycle explicitly.

`asset-cache.ts` owns cache file descriptors and generated `cache-<uuid>` fill
names. Postgres reserves the entire expected size before file creation. Its
charged total includes FILLING, READY, INVALID and unconfirmed EVICTING entries;
hardlinked aliases represent one reservation. Cache allocations use the same
filesystem quota account/free floor as staging, Git and ZIPs. Logical lineage
quotas remain independent. A pin commits before a reader opens bytes, and file
close/drain precedes pin deletion. No wall-clock timeout releases ownership.

Only zero-pin entries can enter the shared removal transition. Cleanup checks
recorded file and directory identities and all aliases, unlinks them and fsyncs
the directory chains before conditional one-time credit. Corrupt owned bytes
remain charged until that protocol succeeds. Request cleanup, pressure and the
existing non-overlapping recovery sweep share this implementation. EIO and lost
SQL acknowledgements leave retryable accounting; replaced directories/inodes,
untracked hardlinks or uncertain file creation require fenced offline inspection.
They never trigger an overwrite, silent reset or early credit.

Each native-fenced server or worker generation supplies one immutable owner UUID
to its stores. Startup registers it under that role's fence, then recovers its
predecessors. Attaching a store never reaps pins; restarting the server cannot
reap worker or same-generation sibling ownership. Missing metadata over existing
payload is refused; only a verified empty namespace may be initialized under
both offline fences. Future migration/reconciliation must establish recorded S3
authority before treating any existing disk files as cache.

To change the effective cache limit/configuration, stop **both** roles and retain
both native offline fences. Reclaim proven dead owners, trim through the ordinary
removal protocol while retaining the old effective limit, retire the temporary
offline owner, then install the new configuration. A limit below 25 MiB, remaining
charge above the new limit, or a live/uncertain owner refuses installation. Restart
both roles with the same recorded configuration. No running process shrinks the
limit independently.

Download readers/fills expose a post-enqueue sample hook for P4. It records advisory
recency in a bounded transaction on the exact incarnation, with one outstanding
sample per reader. READY promotion preserves the maximum, and hash breaks eviction
ties. Failed/lost samples never delay pin release or require recovery. HEAD,
internal reads and publication must not invoke it. Shutdown closes byte owners
independently of samples, then joins started SQL before database disconnect and
maintenance acknowledgement. Remote publication, HTTP wiring and operator mode
commands use these ownership rules.

## Durable S3 publication foundation (P3)

The S3 publication factory is selected by the P7 opt-in runtime configuration
below. P3 installed the publication boundary, P4 downloads, P5 backup/restore
and P6 mode migration/startup guards. Disk remains the default.

The existing descriptor-pinned CAS verifier supplies the remote publisher with
complete, hash/size-checked and sniffed bytes. Remote verification scratch is
unlinked before network IO while its descriptor and disk reservation remain owned;
process death reclaims it without an untracked temporary alias. Both production byte-publication
call sites still use `publishCasBytes`. The S3 backend records an exact
storage-generation/locator/hash/size PENDING intent before remote effects, uses
one conditional whole-object PUT, then confirms size and canonical SHA-256
metadata. Existing objects without hash metadata require a complete GET/hash;
ETag and size alone never establish durability. Mismatches fail closed without
overwriting objects. Unknown PUT outcomes are probed before bounded replay of a
fresh verified body. No delete, multipart, public ACL or signed URL is used.

Only confirmed remote bytes earn DURABLE retained-object status. These rows
preserve orphan evidence and grant no catalog entry, KB lineage or read access.
Mandatory cache admission follows remote confirmation; each publication drains
and releases its own cache pin before the next asset, so a batch can exceed the
cache limit in aggregate. Publication never updates download recency. Cache or
remote failure prevents ref/catalog publication and leaves READY staging reusable
with a **fresh** publication idempotency key after unpublished settlement. An
aborted key keeps the existing conflict semantics. Lost lease/SQL acknowledgements
retain the existing fenced journal recovery path.

Runtime retained-intent writes require the `kb.asset-storage` marker's exact
version, S3 mode, generation and canonical locator, with no pending migration.
Offline target writes additionally require a matching COPYING attempt in
`knowledge_base_control.asset_storage_migration` and both native role fences;
these retained-byte copies bypass cache admission while runtime publication
always requires it. P6 owns creating/activating these records. Historical
generations never authorize a new write. Credentials are explicit and excluded
from locator identity; asset storage remains separate from backup S3 credentials.

| P3 surface / invariants | Enforcement | Evidence |
| --- | --- | --- |
| Both publishers; I2–I4, I16 | Common verification -> retained intent -> remote confirmation -> cache admission -> ref/catalog | CAS regressions; SDK HTTP fixture; 403, lost response, metadata-free/corrupt dedup, body replay and cancellation tests |
| Unpublished READY claims; I3 | Drained S3 error settles the unchanged operation journal before ref update | Real PG/Git upload retry with fresh key; aborted-key conflict; orphan retained evidence |
| Imported grants; I2, I6 | Existing live source/target authority plus remote durability before target ref; no admission | Missing remote refuses lineage; valid remote HEAD succeeds without cache fill |
| Cache ownership; I7–I8, I9 | P2 reservation/admission/close protocol; no publication touch | Batch with two 14 MiB assets on a 25 MiB cache; zero remaining byte pins |
| Durable orphan/ref crash; I2–I3, I15, I17 | Remote intent independent of catalog; existing journal recovery after ref | Concurrent KB publishers; SIGKILL after S3-backed ref fsync; exactly-once recovery |

`blob-store-s3.test.ts` exercises bounded replay/deadline and failure cleanup;
`asset-manifest` integration uses the pinned SDK against an in-process HTTP
fixture plus real disposable Postgres, Git and cache files. Existing default-off
CAS, uploads, changes and export suites remain the disk regression contract.

## Streaming S3 readers (P4)

The S3 store supports downloads through the opt-in runtime selection below.
Backup/restore and offline mode commands use the same storage domain.

A cache hit pins and verifies the complete local inode without any remote call,
so cached downloads work during S3 outages. A download miss reserves the full
object before GET, hashes/counts bounded chunks and writes each chunk to cache
before yielding it to the response. Client demand bounds that tee; followers
never see a partial fill. The final requested frame waits for the whole remote
object, including its tail and EOF, and the cache's durable READY transition.
A short Range therefore still verifies the whole object. Remote corruption after
headers aborts the binary body with its final frame withheld; its HTTP status
cannot be changed after transmission. A prefix may already have been delivered.

HEAD uses the internal read policy: a verified pinned cache hit or a full remote
GET/hash without admission. ZIP source misses also use this policy, so exports
cannot displace hot downloads. Neither HEAD, internal reads nor local ZIP artifact
transfers update download recency. Malformed/unsupported ranges return 416 before
storage IO. Authorization, lineage, private/no-store headers and the existing
119-point work budget remain at the HTTP boundary.

Only a successful synchronous download enqueue invokes the non-awaited advisory
sample, for both FILLING and READY entries. Its failure cannot fail delivery or
retain a drained pin. Cache/remote readers share the role's lifecycle registry;
cancellation/shutdown drains the GET and actual byte work before releasing pins.
Oversized objects bypass admission and touches; ordinary capacity contention
waits within the existing deadline and fails closed rather than bypassing cache.

| P4 surface / invariants | Enforcement | Evidence |
| --- | --- | --- |
| GET/Range; I4–I8 | Bounded tee, full SHA/size/EOF, terminal frame after READY and final live authority | S3 reader unit tests; asset-http real SDK/SQL/Git/cache overlap, range, corrupt-tail, repair and revocation cases |
| Advisory recency; I9 | Post-enqueue hook, exact P2 incarnation, independent pin close | Authorized-stream sampling/denial tests; FILLING -> READY HTTP evidence; P2 lifecycle/state race tests |
| HEAD/internal; I5, I9–I11 | Complete verification, no admission/touch on misses; hits have no remote dependency | HEAD/internal/outage/416 HTTP tests; oversized and full-capacity unit tests |
| Lifecycle; I17 | Owned reader abort, body drain, fill/cache close before pin release | Blocked-body shutdown unit test and partial-fill HTTP cancellation/shutdown cases |

## Storage-aware encrypted backup and restore (P5)

Disk mode keeps `kb/backup/1`, including every retained disk CAS object. The
explicit S3 variant, `kb/backup/2`, contains **no asset bytes or cache files**.
It encrypts a sorted, streamed `asset-inventory.jsonl` of every catalog
`{hash,size}`, including historical and tombstoned assets, with a credential-free
source locator. Backup verifies remote size and hash metadata (or hashes a full
GET when metadata is absent), then repeats verification after encryption before
publishing `.complete`. The local cache never establishes backup durability.

Offline restore requires the recorded mode and verifies the complete remote
inventory before promotion and readiness. Replica restores require the explicit
`--asset-source-remap` flag and bind the new locator, inventory digest and remap
choice to the same restore attempt. Retry never contacts the retired source.
Every restore uses a fresh target storage generation: only verified references
become target DURABLE obligations. Imported remote intents, including PENDING
and orphan objects, remain historical source evidence. Imported cache ownership,
occupancy and volume reservations are discarded under both native fences.
Repeated READY attempts close readiness and repeat verification.

The offline role uses `KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID` and
`KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY`, plus the actual runtime writer's
`KB_ASSET_S3_ACCESS_KEY_ID` for comparison only. Never forward its runtime secret.
Dump credentials must differ from **both** asset IDs; configured S3 dump consumers
need both IDs and the operator reader for full pre-migration bundles. Distinct IDs do not
prove IAM isolation: provision read-only asset access for backup/restore, deny
asset identities access to dumps, and keep dump custody separate.

Enable bucket versioning plus replication or object lock. Avoid lifecycle rules
that delete retained asset keys; the encrypted S3 bundle depends on external
object retention. Keep encryption identities and original application keys
separately. Runtime activation and offline migration are described below.

## Offline storage migration (P6)

The versioned `kb.asset-storage` marker fixes the active mode, normalized locator
and storage generation. Credentials may rotate without a migration. Changing
mode or S3 location requires the explicit offline operator command. To change S3
locations, migrate through disk. Existing unmarked disk instances cannot become
S3 instances merely by setting environment variables. Only a fenced server may
initialize an empty instance; workers wait for that authority before effects.
Existing S3 startup checks configuration without contacting the bucket.

Run these in the server image offline role with its prepared mounts. Migration needs the
data volume **read-write** and both native role fences. The operator asset
identity needs scoped ListBucket/GetObject/PutObject capability; it never needs
DeleteObject. The runtime writer ID remains comparison-only in this role.

```sh
/app/scripts/docker-entrypoint.sh asset-storage status
/app/scripts/docker-entrypoint.sh asset-storage migrate --to s3 --attempt 00000000-0000-4000-8000-000000000006 --dry-run
/app/scripts/docker-entrypoint.sh asset-storage migrate --to s3 --attempt 00000000-0000-4000-8000-000000000006
/app/scripts/docker-entrypoint.sh asset-storage migrate --to disk --attempt 00000000-0000-4000-8000-000000000007
/app/scripts/docker-entrypoint.sh asset-storage cache-reconcile --limit 26214400 --attempt 00000000-0000-4000-8000-000000000008
```

Choose a fresh UUID for each new operation, and reuse it after interruption.
For target disk, keep the **source** S3 locator and operator credentials even
with `KB_ASSET_S3_ENABLED=false`; the command explicitly selects the recorded
source. For target S3, supply the target locator, operator credentials and
`KB_ASSET_CACHE_MAX_BYTES` (at least 26214400). Status is read-only and exposes
no credentials. Dry-run inventories and verifies under offline fences without
changing authority or removing bytes.

The durable request drains participants before native dual-fence handoff.
Request, maintenance and schema locks serialize the offline copy. An immutable,
sorted Postgres spool and its digest/checkpoints live in
`knowledge_base_control`, outside imported public metadata. Checkpoints never
justify skipping verification on retry. A pending attempt blocks both runtime
roles, maintenance recovery, schema apply/readiness, backup and restore. It
never expires. Attempt-named publisher scratch and exact operation-owned disk
reservations are recovered only under both native fences. On failure inspect status and retry the same target/UUID; keep
source and destination bytes, staging and durable evidence.

Disk-to-S3 preserves every verified retained disk object, including uncatalogued
orphans. S3-to-disk includes catalog requirements, active-generation exact-locator
intents and the paginated current namespace. Missing committed/DURABLE bytes,
malformed keys, conflicting sizes and corruption refuse completion. An absent,
uncatalogued PENDING attempt has no materialized bytes to retain. Historical
intent generations remain evidence and never require a retired bucket online.

Only after copying and verification does conversion begin. Disk-to-S3 trims to
an **empty cache**, with a remote verification before each local unlink and
filesystem barriers before activation. This deliberately sacrifices cache warmth
to keep conversion simple. A crash during trim keeps admission closed until
that conversion finishes. The disk destination may grow beyond the old cache
limit; it is offline authority under construction, not a live cache. Final
activation updates marker and READY atomically. No remote objects are deleted.
Cache reconciliation uses the same inventory/fence protocol and installs the
requested limit with an empty cache. Completed-attempt replay verifies the target
again under a durable VERIFYING state and resolves a lost final acknowledgement
without contacting retired stores.

| P6 invariant | Enforcement | Verification |
| --- | --- | --- |
| I12 | Marker and pending-control guards precede recovery/effects/readiness | Startup mismatch/outage and control guard tests |
| I15 | Current-generation predicate, catalog union, disk scan/current namespace listing | Above-limit A → disk → B → disk, orphans and absent PENDING tests |
| I7–I8, I17 | Native dual fences, existing cache cleanup, verified trim and fsync | Native kill during trim, checkpoint/replay and bounded-cache tests |
| I16, I18 | Shared publisher/reader and explicit operator credentials | Real SDK HTTP fixture; no remote delete operations |

Runtime activation and complete role propagation follow the configuration matrix below.

## Opt-in S3 operation and role configuration

`KB_ASSET_S3_ENABLED` defaults to `false`: disk CAS remains authoritative, no
S3 client is created and no cache eviction runs. When enabled, S3 holds asset
authority and `assets/` holds only verified cache payload. Git manifests,
retained lineage and live authorization still govern every download; no public
or presigned asset URL exists. Runtime never falls back to disk authority.

Set the following location fields identically across runtime and offline roles:
`KB_ASSET_S3_BUCKET`, `KB_ASSET_S3_REGION`, optional `KB_ASSET_S3_ENDPOINT`,
optional `KB_ASSET_S3_PREFIX`, and `KB_ASSET_S3_FORCE_PATH_STYLE` (default
`false`). Region is required; `auto` requires a custom endpoint. Endpoints must
be HTTP(S) origins without credentials, path, query or fragment. Prefixes are
normalized by trimming outer slashes; traversal and empty interior segments are
refused. These settings use strict booleans. Old template `S3_*` variables do
not select asset storage.

`KB_ASSET_CACHE_MAX_BYTES` is explicit when enabled: a safe integer of at least
26214400 bytes (25 MiB). It bounds resident cache payload plus full fill
reservations and unconfirmed evictions, shared across processes. It excludes
staging, verification scratch, Git, indexes, models and ZIP artifacts; all local
allocations still obey the common disk free floor. Logical 1 GiB/KB and
5 GiB/owner lineage quotas remain unchanged and eviction does not refund them.
S3 object bytes do not consume local physical quota.

| Role | Asset inputs beyond location/mode |
| --- | --- |
| Server | Cache limit; runtime `KB_ASSET_S3_ACCESS_KEY_ID` and `KB_ASSET_S3_SECRET_ACCESS_KEY` with scoped GetObject/PutObject |
| Worker | Cache limit; no asset credentials, no startup remote request |
| Migration runner full-bundle hook | Actual runtime writer ID plus operator ID and read-only operator secret for asset inventory; no runtime writer secret |
| Scheduled backup / restore | Both actual comparison IDs; `KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY` with read-only asset grants; no runtime secret |
| Offline migration / cache reconciliation | Both comparison IDs, operator pair with ListBucket/GetObject/PutObject as needed, explicit cache limit for S3 target |

Every dump credential (`BACKUP_S3_ACCESS_KEY_ID`) must differ from **both**
asset IDs. A/B/A and A/B/B are refused; A/B/C is accepted only as an identity
check. Distinct IDs do not prove IAM isolation. Deny asset identities access to
dumps, provision backup/restore asset readers separately from migration writers,
and keep dump custody separate. Direct script invocations must supply the
actual runtime writer ID, never a substitute or the operator ID. Runtime
secrets never go to offline roles; operator secrets reach server migration/backup children for read-only snapshots; keep them out of ordinary runtime asset writes. Comparison-only IDs do not grant bucket access. Backup monitor ListBucket credentials stay worker-only. Scheduler and snapshot
children forward the same location and comparison IDs without logging secrets.

Provision even a new empty S3 instance through the offline `migrate --to s3`
command above before starting either runtime. After S3 restore, run offline `cache-reconcile`
with the desired limit before runtime attachment. The existing dual-fence initializer
creates the cache ledger; ordinary startup only attaches. Missing metadata,
a changed limit, a different volume or a mismatched recorded locator refuses
service. Use offline `cache-reconcile` to change the limit. Merely setting env
on an existing disk instance cannot convert authority. Changing credentials alone
does not change locator identity. The generated Dokploy backup template keeps
the volume RO; its offline operator template mounts it RW on the same host.
Stop both roles for migration/reconciliation and reuse the same attempt UUID
after interruption. Never remove pending evidence or locks to force readiness.

Cached downloads work during bucket outages without a remote HEAD, including
a restart with matching recorded cache metadata. Uncached reads, new durable
publication and remote verification fail `STORAGE_UNAVAILABLE`. Cache capacity
held by active readers/fills waits within the caller deadline, then fails; it
never evicts active bytes or bypasses mandatory publication admission. Range
misses and HEAD can require a full remote GET/hash, so short ranges still incur
whole-object transfer cost. Corrupt tails abort an already-started response;
the final requested frame is withheld and the transfer cannot finish successfully.
Objects above the entire limit defensively stream without cache admission.

Only a successful download enqueue attempts advisory recency. One non-awaited,
bounded sample per reader updates a monotonic maximum for the exact incarnation;
eviction ties use hash order. Crash-lost/coalesced samples are allowed. Failed
samples neither delay delivery nor hold byte pins. HEAD, internal ZIP reads,
publication and ZIP-artifact downloads never touch recency. INVALID entries
stay charged until zero pins, verified alias removal and directory fsync permit
one-time credit. Request cleanup and the existing recovery sweep retry that
protocol; unknown inodes require fenced offline inspection. Shutdown drains
actual byte work before pins/fences release and observes started SQL separately.

Current-generation exact-locator retained intents preserve remote orphan evidence
without granting access. Historical generations are evidence only, so retired
buckets need not remain online after migration. No app operation deletes remote
objects. Enable bucket versioning plus replication or object lock, and avoid
lifecycle rules that delete retained asset keys. S3 encrypted bundles contain
references only: their recovery depends on external object retention. Replica
remap verifies the bundle's referenced inventory at the target; it does not copy
source-only orphans or asset bytes. Retain age identities, original master/auth
keys and bucket recovery access separately.

| P7 coverage / invariants | Enforcement | Evidence |
| --- | --- | --- |
| Runtime selection; I1, I10–I12 | Import-pure role validation; marker-bound factory; prepared cache attachment before listen | Env/role tests; native migration + configured factory integration; disk and S3 HTTP regressions |
| Role custody; I18 | Shared interpolation sources; schema IDs only; offline operator pair; no runtime secret forwarding | Generated A/B/A, A/B/B, A/B/C and missing-ID fixtures; cron/snapshot tests |
| Packaging/lifecycle; I16–I18 | Existing common offline artifact and native fences; recovery registered on the role lifecycle | Docker COPY/artifact probes, setup and deployment tests |

Local HTTP fixtures exercise the pinned SDK and failure behavior; they do not
certify arbitrary S3 providers or a multi-host deployment.
