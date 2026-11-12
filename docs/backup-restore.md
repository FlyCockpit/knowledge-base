# Encrypted offline backup and restore

Back up Git, asset authority and PostgreSQL metadata together. Disk bundles
include all retained CAS bytes; S3 bundles record verified remote references
without asset bytes, as described in [asset storage](./assets.md#storage-aware-encrypted-backup-and-restore-p5). The
SQLite search index under `index/` is rebuildable and excluded; authority,
journals, sealed/provider records and Git history are not disposable. Model
weights and Valkey are also excluded. Every pre-migration/pre-drop backup is this same full recovery unit; a database-only dump cannot restore a KB instance.

## Operator key custody

The server image pins official age v1.3.2 with its published SHA-256. Recommend
`age-keygen -pq` (hybrid ML-KEM-768 + X25519, `age1pq1…` recipient); classic
`age1…` recipients also work. Provision keys in a private operator vault:

```sh
age-keygen -pq -o /private/operator/backup-identity.txt
```

Supply only the public recipient as `BACKUP_AGE_RECIPIENT` to the backup role.
Retain the private identity, original `KB_MASTER_KEY`, `BETTER_AUTH_SECRET` and
any other needed auth keys separately from the encrypted bundle and application
volumes. Provider/sealed/share ciphertext needs the original master key; TOTP
and backup-code records need the original auth secret. Missing/wrong required
keys refuse restore promotion. Never print those values to diagnose readiness.

## Quiesced bundle

Use the generated server-image `backup` command or opt-in `backup-schedule` service. Mount the shared backup output volume and the data volume read-only for inventory (repos/ and assets/ only; models and index excluded). Set BACKUP_AGE_RECIPIENT. Local completed bundles are valid; when BACKUP_S3_BUCKET is configured, upload must succeed. S3 asset mode also needs its operator reader and actual runtime comparison ID. Do not reuse the runtime asset writer secret or backup key for another role.

`BACKUP_SCHEDULE=off` is the default. Set daily, BACKUP_HOUR_UTC=3 and BACKUP_KEEP=14 for one verified daily full bundle, retaining local completed pairs by UTC day. Successful manual, pre-migrate and pre-drop deliveries each retain their newest seven pairs, including when daily scheduling is off; failed deliveries and staging files are preserved. Pair verification is cached by both files’ inode, size and timestamps during a scheduler process. The scheduler catches up after restart with an initial five-minute delay and retries a failed upload hourly using the same immutable pair. Success/health requires verified delivery; partial uploads never count. S3 retention is an operator lifecycle policy. Keep backup and monitor credentials separate.

The initialized-database runner requires this full bundle before pending migrations or due deletions. Missing recipient/output, disabled backup or failed configured upload blocks mutation. Only a proven-empty managed catalog with no applied history and 0_init first skips it, for all pending folders in that initial deploy. The hook publishes structured identity after completion; no prose parsing or plain-dump fallback. Labels manual/pre-migrate/pre-drop/daily are metadata on immutable backup-UUID.age files.

A durable maintenance request closes server writes/uploads and worker effects.
The five-minute quiesce budget waits for explicit drain acknowledgements, stops
application processes, then the native offline coordinator acquires both volume
flocks and database maintenance/schema locks. It cannot take another exclusive
flock while a live supervisor still owns one. One exported PostgreSQL snapshot
captures metadata with Git/CAS, instance/authority epoch, heads, schema inputs
and every file hash/size. No valid bundle is published before all checks complete.
The encrypted `.age` and its `.complete` hash marker travel together.

Incomplete drain retains maintenance: inspect ownership, restart the fenced
server once for journal/CAS recovery without HTTP admission, then retry offline.
Never delete fence/evidence files while a former process may still exist. Success
resumes the restart-managed app only after offline descendants drain and locks
release. Audit records the cutoff/outcome; remote upload needs a completed marker.

## Restore into a fresh destination

Use an empty PostgreSQL 18 database and one new data volume at `KB_DATA_ROOT`
that is empty or skeleton-only and node-writable (uid 1000), with the app
stopped. A fresh named volume receives the skeleton from the server image;
a bind mount needs a node-writable root. Restore creates the skeleton first and
refuses any other content (`RESTORE_EMPTY_TARGET_REQUIRED`); a missing or
relative `KB_DATA_ROOT` is refused before any IO (`RESTORE_DATA_ROOT_REQUIRED`). Keep the source bundle/marker and identity
read-only. Do not overlay live storage. The image
entrypoint passes this exact supported command to the supervised coordinator:

```sh
# Command arguments to the offline server image, with its prepared mounts.
restore /input/bundle.age /keys/identity.txt 00000000-0000-4000-8000-000000000001
```

S3 restores require explicit `KB_ASSET_S3_ENABLED=true`, the source locator
configuration and operator asset credentials. To restore replicated references
at a different configured endpoint/bucket/prefix, append `--asset-source-remap`
to the restore command. This flag, target locator and reference inventory are
bound to the attempt; retry cannot change them. It verifies referenced objects
at the target and leaves imported source-only intents historical. It never
converts storage modes or restores local cache bytes.

After a successful S3 restore, initialize its empty local cache ledger before
starting runtimes: run `asset-storage cache-reconcile` with the target locator,
operator pair, desired `KB_ASSET_CACHE_MAX_BYTES` and a fresh reconciliation
attempt UUID (see [offline commands](./assets.md#offline-storage-migration-p6)).
The restore path discards imported cache metadata; runtime attachment refuses
missing metadata and never guesses that existing payload is safe to reclaim.

Choose a fresh attempt UUID for a new restore, and reuse it on retry. Supply the
original needed keys privately in the restore role. It holds exclusive server
and worker volume fences plus request, maintenance and schema database locks.
Verify encryption/completion, paths/no symlinks, hash inventory, every Git
ref/history/lineage, profile, source catalog compatibility and finished journals before promotion.
Incomplete/tampered sources and unexplained publication state block readiness.
Do not remove production volumes or reset a live database to make it "empty".

On failure retain the destination, inspect read-only, and retry offline with
the SAME bundle, identity, target and attempt UUID. Durable kb_restore intent
blocks server, worker and migration admission until a verified ready result. Native
schema comparison and archive children must drain before fences release; a
printed diff without complete child acknowledgement is insufficient.

## Authority reset and return to service

Promotion increments authority epoch once; revoke ALL OAuth, PAT, device and browser
credentials/sessions/grants, preserving permanent tombstones. Destroy mirror
deploy-key ciphertext and disconnect mirrors. Cancel transient jobs/uploads/query
leases. Keep users/roles/bootstrap, so this is fresh login, not first-admin
bootstrap. Providers remain only with usable original master-key custody.

Clear active index pointers, recreate index jobs (with each KB's quantization)
from durable desired state, redownload verified enabled weights and rebuild the
SQLite index files from Git; never restore a Valkey queue as
job authority. Verify the new migration history/contract state and source catalog, recovery audit
and mounted inventory before reconnecting traffic. A repeated ready attempt
rechecks inventory with admission closed. Users authenticate anew and approve
new tokens/recipients; managers explicitly reconnect mirrors with fresh keys.
Test a representative private KB, historical asset/export, provider and index
before calling recovery complete. [Hosting notes](./hosting.md) describe
failure/re-entry details. No production `down -v` workflow is supported.

## Asset role configuration and retention

Use the [role matrix](./assets.md#opt-in-s3-operation-and-role-configuration)
for scheduled backup, snapshot children, direct invocations and restore.
Forward the actual runtime `KB_ASSET_S3_ACCESS_KEY_ID` unchanged and the separate
operator ID; supply the operator secret only where asset reads are needed.
Never supply `KB_ASSET_S3_SECRET_ACCESS_KEY` to an offline role. Every full-bundle snapshot needs both comparison IDs and the operator reader when assets are enabled. Dump key A/B/A or A/B/B reuse is refused; A/B/C still
requires independently isolated IAM grants. The generated scheduled and offline
role templates preserve these references and the scheduler preserves them.

S3 bundles exclude asset bytes/cache and verify every referenced catalog hash,
including historical/tombstoned references, remotely before completion and again
on restore. Enable bucket versioning plus replication or object lock; avoid
lifecycle expiration of retained asset keys. Keep age identities and original
master/auth keys separately. Replica remap binds the target and reference
inventory to the attempt; source-only orphan history is not copied. A bucket
outage blocks S3 backup/restore even when local cache files exist. See the asset
operator guide for active/historical generations and offline migration retry.

## Snapshot migration history and deletion holds

Bundles contain shipped migration SQL/checksums and snapshot-consistent applied _prisma_migrations plus _knowledge_base_* contract state and source catalog, captured in the same exported snapshot as pg_dump. Applied history may be a matching subset of shipped files, including out-of-order merges; pre-drop snapshots intentionally retain retired data. Prerelease archive formats are refused. Source control schema is excluded so destination restore intent remains authoritative.

Before import, restore checks every current authority-reset, key, audit, model/job and asset projection against the source catalog. The explicit `RESTORE_SURFACE` in `scripts/lib/kb-restore.mjs` defines required typed columns and enum labels, including cache reconciliation and authority reset. Retired application fields and unused labels outside that surface do not prevent same-image restore. Use a compatible image if the restore surface is unsupported. Restore source state unchanged; do not apply pending migrations inside the offline operation. Final commit publishes READY, invalidates imported live registrations and extends the restore deletion hold to at least seven days without shortening existing holds. Next normal startup backs up and applies newer migrations.

Runner exclusion is acquired before offline preflight, then request/maintenance, DADP and Prisma locks, under both native volume fences. Snapshots use DADP then Prisma and never reacquire a parent runner lock. Every child drains before fence release. See [lock and interruption rules](./schema-migrations.md#locks-and-interruption).

The server image also offers `hold-deletions [days|--clear]` (default seven days) and `restore-drill`. Drills use a disposable database AND isolated KB data volume with the operator identity; never drill against the live data root. Restore CLI remains `restore <bundle.age> <identity-file> <attempt-uuid> [--asset-source-remap]`, requires empty targets, and retries the same source and attempt.


Restore discovery (`--list` and `latest`) accepts every verified `.age` + `.age.complete` pair in the backup directory. Local `.result.json` delivery sidecars are optional and portable across directory moves. Without a valid sidecar, discovery uses the marker's creation time (or its modification time for legacy markers) and labels the pair `imported`; unknown delivery metadata never counts as scheduler success or authorizes automatic pruning.

A failed snapshot after a clean runtime drain reopens maintenance only after the snapshot child has settled and maintenance exclusion is reacquired. Incomplete drains, inherited recovery requests and a still-held snapshot lock keep admission closed until offline recovery succeeds.
