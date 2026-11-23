# Encrypted offline backup and restore

Back up Git, asset authority and PostgreSQL metadata together. Disk bundles
include all retained CAS bytes; S3 bundles record verified remote references
without asset bytes, as described in [asset storage](./assets.md#storage-aware-encrypted-backup-and-restore). The
SQLite search index under `index/` is rebuildable and excluded; authority,
journals, sealed/provider records and Git history are not disposable. Model
weights and Valkey are also excluded. Every pre-migration/pre-drop backup is this same full recovery unit; a database-only dump cannot restore a KB instance.

Backups are **off by default**: `BACKUP_ENABLED` defaults to `false` (unset
means `false`; only the literal `true` turns backups on). New deployments need no
backup settings, storage or scheduler; migrations and due deletions proceed
without a backup. Every start that migrates (the server, and a `migrate` job)
and every waiting server prints one notice explaining how to opt in
(`pre-migrate.sh --startup-notice`, run by the image entrypoint).
Disabled backups do not affect health/readiness or produce freshness warnings.

To opt in, regenerate Dokploy configuration with `--backups true`, set
`BACKUP_ENABLED=true` and `BACKUP_AGE_RECIPIENT`, and mount the generated shared
backup output volume (`BACKUP_DIR=/app/backups`). A backup destination is that
volume mounted at `BACKUP_DIR` (the mount point itself; a subdirectory of a
volume mounted elsewhere does not count), or `BACKUP_S3_BUCKET`: the image's own
`/app/backups` without a mounted volume lives in the container and is lost with
it, so it does not count. With `BACKUP_ENABLED=true` and no destination (or no
recipient), every start that migrates refuses at startup, even with nothing
pending, and every backup refuses before touching the database. Set `BACKUP_SCHEDULE=daily` on
one backup service for daily runs; scheduling otherwise stays off. S3 upload
and its separate freshness-monitor credentials are optional. Keep the private
age identity and original application keys separately as described below.

## Operator key custody

The server and worker images build age v1.3.2 from its commit-pinned source
with a patched, digest-pinned Go. Recommend
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

The scheduler logs one line per attempt outcome, so `docker logs <backup container> | grep kb-backup-schedule` shows its history:

```text
kb-backup-schedule attempt=started kind=bundle run=<uuid>
kb-backup-schedule attempt=uploaded kind=bundle run=<uuid>
kb-backup-schedule attempt=local-only kind=bundle run=<uuid>
kb-backup-schedule attempt=failed kind=upload run=<uuid> code=S3_HTTP_403
kb-backup-schedule attempt=timed-out kind=upload run=<uuid> code=UPLOAD_TIMEOUT
```

`kind=bundle` is a new snapshot and its upload, `kind=upload` the hourly retry of a completed pair's upload, `kind=discover` reading the completed pairs before either, and `kind=gate` / `kind=prune` the scheduler's own migration check and retention. `code` is stable and never a provider message: a Node or child code (`ECONNREFUSED`, `CHILD_DEADLINE`), `S3_HTTP_<status>`, `UPLOAD_TIMEOUT`, `BUNDLE_FAILED` (the snapshot child failed before delivery), `MIGRATION_UNFINISHED` or `UNKNOWN`. One upload of a pair (both objects, read back and verified) is bounded at one hour (`UPLOAD_TIMEOUT`, also for manual and pre-migration backups), and a new bundle with its upload at 4,000 seconds (`CHILD_DEADLINE`). A timed-out or cancelled upload gets 30 seconds to finish its own cleanup (a multipart abort); one that still hasn't stopped is abandoned, and the backup process (or the scheduler, once it stops) then exits even if that upload still holds a connection. A failed upload records its code in the pair's `.result.json` sidecar (`upload.code`), and a manual backup's `FATAL` line carries it too. An `IfNoneMatch` 412 on a re-delivered object is expected (the remote bytes are then verified by digest) and is not logged.

With BACKUP_ENABLED=true, the initialized-database runner requires this full bundle before pending migrations or due deletions. Missing recipient/output or failed configured upload blocks mutation. Disabled backups skip the hook entirely. A brand-new database (proven-empty managed catalog, no applied history, `0_init` first) gets no bundle, since there is nothing to back up; but with BACKUP_ENABLED=true the hook still runs `--check-destination` (recipient, a writable BACKUP_DIR that is a mounted volume unless BACKUP_S3_BUCKET is set, BACKUP_S3_* settings), and a failed check or a missing hook refuses the migration. A stop signal during a startup backup sends the hook one TERM (backup.sh drains its writer) and the start ends without migrating. A bundle interrupted while it is written never gets its `.complete` marker, so it is never used; one interrupted during S3 delivery keeps its completed, verified local pair (valid for restore, and the upload is retried). The hook publishes structured identity after completion; no prose parsing or plain-dump fallback. Labels manual/pre-migrate/pre-drop/daily are metadata on immutable backup-UUID.age files.

A durable maintenance request closes server writes/uploads and worker effects.
The five-minute quiesce budget waits for explicit drain acknowledgements, stops
application processes, then the native offline coordinator acquires both volume
flocks and database maintenance/schema locks. It cannot take another exclusive
flock while a live supervisor still owns one. One exported PostgreSQL snapshot
captures metadata with Git/CAS, instance/authority epoch, heads, schema inputs
and every file hash/size. No valid bundle is published before all checks complete.
The encrypted `.age` and its `.complete` hash marker travel together.

Each server and worker registers as a maintenance participant and holds a
liveness token, a session-scoped PostgreSQL advisory lock (class `0x4b424d50`),
for as long as its database session lives. A process that dies without draining
(crash, OOM kill, a PostgreSQL restart) loses the token with its session, so
before writing the request the coordinator deletes the rows of participants
that are already gone and logs them (`reclaimed N participant row(s) … <host>
pid <pid>`); only processes alive at the request take part in the drain. No
manual database edit and no wall-clock lease is involved, and a healthy process
is never expired. Unfinished journal work such a process left still refuses the
snapshot (`JOURNAL_RECOVERY_REQUIRED`, the same unfinished intents or pending
CAS publications restore refuses) until the restarted server recovers it, and a
process that lost only its database session still owns its volume fence, so the
snapshot waits for it until the quiesce deadline and then fails
(`MAINTENANCE_FENCE_HELD`). A row without
a token (written by an older build) cannot be proven dead and still counts as
an incomplete drain; the recovery below clears it.

A failed quiesce has a stable code and names the processes: `MAINTENANCE_DRAIN_TIMEOUT`
(five minutes passed; "Still draining: <host> pid <pid>"), `MAINTENANCE_DRAIN_INCOMPLETE`
(a participant alive at the request exited without acknowledging it) or
`MAINTENANCE_BUSY` (another backup owns maintenance). The backup's `FATAL`
line carries the code and the next line the detail; a scheduled run logs it
from its bundle child just before its own `code=BUNDLE_FAILED` line. Incomplete drain
retains maintenance: inspect ownership, restart the fenced server once for
journal/CAS recovery without HTTP admission, then retry offline (re-run the
backup: it inherits the request and takes the recovery snapshot).
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
attempt UUID (see [offline commands](./assets.md#offline-storage-migration)).
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

A backup refuses a database that holds PostgreSQL large objects
(`BACKUP_LARGE_OBJECTS`, checked inside the exported snapshot before any dump
is written), so no completed bundle can be one restore would refuse; KB itself
never creates them. Archives containing PostgreSQL large objects (`BLOB`, `BLOB METADATA` or
`BLOBS` entries in the archive's `pg_restore --list`) are refused with
`RESTORE_LARGE_OBJECTS` before any restore script is written or imported:
pg_restore commits each large object in its own transaction, which would end
the single import transaction early. The refusal comes after the durable
restore intent exists, so that attempt can never complete and keeps blocking
admission: recreate the
empty target (a new empty database and data volume) before restoring a
different bundle. A missing `age` fails the attempt with
`RESTORE_DECRYPT_CLIENT_MISSING`; a missing `pg_restore` or `psql` fails it
with the generic import code (`RESTORE_FAILED_IMPORT`). Install a compatible
image and retry the same attempt.

### Host helper

`scripts/backup/host.sh` (Linux only: bash, GNU coreutils, docker) runs the
server image's `list`, `backup`, `restore`, `drill` and `hold-deletions`
commands next to an existing deployment. It discovers the server by its
`io.knowledge-base.role=server` label, the private Postgres network, the data
and backup bind mounts and an allowlisted environment, and mounts the identity
read-only. `list`, `backup`, `restore` and `drill` need the backups mount
(`BACKUP_DIR`), which a deployment generated with backups off (the default)
does not have: regenerate it with `pnpm dokploy:config --backups true` and
redeploy first; only `hold-deletions` works without it.
Every command runs the server container's own image ID, never its tag. If a
redeploy that changed nothing dropped that image (Docker 29's containerd image
store can retag the name and remove the old ID while the server still points at
it), the helper stops with exit 1 before anything runs or stops and prints the
fix: `cd <compose directory> && docker compose -p <project> -f <compose file>
up -d --no-build --force-recreate <server service>` (directory, file and service
come from the server container's Compose labels), which recreates the server from the current
image (it restarts the app); then re-run the command.
`restore <bundle|latest> <host-identity> <attempt-uuid>` asks you to
type the compose project name, then stops the server, worker and backup
writers (stopped ones included, so a completed retry starts every one of them
again). Its exit status:

| Exit | Meaning | Writers afterwards |
|---|---|---|
| 0 | Restore completed | Started again |
| 3 | Cancelled at the typed-project prompt (another answer, Enter, EOF, Ctrl-C, TERM or HUP) | Never stopped |
| 3, "Refused; nothing was changed" | The restore refused before it wrote any restore state, on a target with no earlier attempt (`REFUSED: <code>`): bad arguments (`RESTORE_INVALID_ARGUMENTS`), a missing data root or fence, a busy target (`RESTORE_MAINTENANCE_BUSY`, or `RESTORE_ACTIVE_CONNECTIONS` for any other session on the target database; Postgres autovacuum workers do not count), a non-empty target (`RESTORE_EMPTY_TARGET_REQUIRED`), an unreadable or incomplete bundle, no completed pair for `latest`, or a cancel before the first write; also a different attempt on a target an earlier restore finished (`RESTORE_ATTEMPT_CONFLICT` against a READY restore) | Started again, only the ones that were running before the helper stopped them |
| non-zero, "Restore was not invoked" | A stop failed or a signal (128+n) arrived before the restore container ran | Started again, only the ones that were running (nothing was restored) |
| other non-zero, "did not finish" | The restore failed or was interrupted after it wrote its restore intent, refused a different attempt while an earlier one is pending (`RESTORE_ATTEMPT_CONFLICT`), or the supervisor itself refused (80–92) | **Stay stopped**; the exact `docker start …` command is printed |

The restore command's own status is the same contract: 0 restored, 3 refused
with nothing changed (`REFUSED: …`), 1 anything else (`FATAL: …`; the target
may hold a partial attempt). A refusal while an earlier attempt is still
pending is never "nothing changed" once the restore has read that attempt;
when it comes earlier (for example a busy target or a mistyped bundle), the
helper starts only the writers that were running before it stopped them, so
ones an earlier failed attempt left stopped stay stopped (and the runner,
maintenance admission and the scheduler all refuse while a restore is pending).

After any other non-zero restore, inspect the destination and retry offline with the
same source, identity and attempt UUID (the helper prints the command); start
the writers only after a completed retry or to abandon the restore.
`bash host.sh restore … | tee restore.log` works: only stdin must be a
terminal. Use `set -o pipefail` or `${PIPESTATUS[0]}` to read the helper's
status through the pipe; a terminal Ctrl-C also kills `tee`, so use `tee -i`
to keep the log.

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

Bundles contain shipped migration SQL/checksums and snapshot-consistent applied _prisma_migrations plus _knowledge_base_* contract state and source catalog, captured in the same exported snapshot as pg_dump. Applied history may be a matching subset of shipped files, including out-of-order merges; pre-drop snapshots intentionally retain retired data. Only `kb/backup/1` bundles are accepted. Source control schema is excluded so destination restore intent remains authoritative.

Before import, restore checks every current authority-reset, key, audit, model/job and asset projection against the source catalog. The explicit `RESTORE_SURFACE` in `scripts/lib/kb-restore.mjs` defines required typed columns and enum labels, including cache reconciliation and authority reset. Retired application fields and unused labels outside that surface do not prevent same-image restore. Use a compatible image if the restore surface is unsupported. Restore source state unchanged; do not apply pending migrations inside the offline operation. Final commit publishes READY, invalidates imported live registrations and extends the restore deletion hold to at least seven days without shortening existing holds. Next normal startup applies newer migrations, taking a backup first only when backups are enabled.

Runner exclusion is acquired before offline preflight, then request/maintenance, DADP and Prisma locks, under both native volume fences. Snapshots use DADP then Prisma and never reacquire a parent runner lock. Every child drains before fence release. See [lock and interruption rules](./schema-migrations.md#locks-and-interruption).

The server image also offers `hold-deletions [days|--clear]` (default seven days) and `restore-drill`. Drills use a disposable database AND isolated KB data volume with the operator identity; never drill against the live data root. Restore CLI remains `restore <bundle.age> <identity-file> <attempt-uuid> [--asset-source-remap]`, requires empty targets, and retries the same source and attempt.


Restore discovery (`--list` and `latest`) accepts every verified `.age` + `.age.complete` pair in the backup directory. Local `.result.json` delivery sidecars are optional and portable across directory moves. Without a valid sidecar, discovery uses the marker's creation time (or its modification time for a marker without one) and labels the pair `imported`; unknown delivery metadata never counts as scheduler success or authorizes automatic pruning.

A failed snapshot after a clean runtime drain reopens maintenance only after the snapshot child has settled and maintenance exclusion is reacquired. Incomplete drains, inherited recovery requests and a still-held snapshot lock keep admission closed until offline recovery succeeds.
