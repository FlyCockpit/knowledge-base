# Hosting

Dokploy on a VPS is the documented deployment target. Production and container development run one server and one dedicated worker on the same host.

## Bootstrap

- `ADMIN_EMAIL` is one trimmed lowercase valid email. It identifies a single bootstrap administrator.
- Production requires that identity before first-user bootstrap, including when `SIGNUP_ENABLED=true`. A different first signup fails without creating a user.
- Dev/test may bootstrap the first valid account when `ADMIN_EMAIL` is unset.
- After `BootstrapState` completes, the email never re-promotes a demoted user.
- Disabled public signup still accepts admin invitations. When SMTP is off, invite returns the one-time link privately.

## Volumes and processes

- One data volume at `KB_DATA_ROOT` holds `repos/`, `assets/`, `models/` and `index/`. Server and worker both mount it RW; nothing is mounted below it.
- Security tradeoff: a compromised worker (provider HTTP client, native model child, mirror Git/SSH path) can modify Git repos, CAS bytes and index files, and the server also mounts `models/`. No read-only OS control remains; the nonroot UID, the private mirror-key tmpfs check, process fences, Git/CAS hash verification and backups remain.
- Git is the Markdown source of truth. Postgres holds application metadata. The derived search index is SQLite files on the data volume.
- The server applies committed migrations; MIGRATE_ON_START=false workers wait and register. See [schema migrations](./schema-migrations.md).

Git push recovery runs under the drained server volume fence. Startup and periodic
recovery remove abandoned request spools while preserving every live upload through
disposal. Unpublished pushes release history quota for discarded quarantine files;
files migrated into canonical object storage remain charged, including partial
migrations and unreachable objects. The hook records the incoming file inventory
before publication so recovery can distinguish these outcomes. Native child drain
and exit delivery bind both the operation identity and PID.

## Human vs data plane

Server control pages configure users, instance settings, jobs, shares, credentials, mirrors, and sealed enrollment. MCP exposes the complete common data-plane catalog. No locally unsupported tools; no handler stubs for unpublished tools.

The worker builds each index generation as one immutable SQLite file, `index/<kbId>/<generationId>.sqlite` under `KB_DATA_ROOT`, under one-per-KB and two-global build permits; no database role or credential is involved. Builds reserve disk on the volume's quota account first. The server reads published files read-only through its reader-thread pool and never writes them. Retention deletes superseded and failed generations' files; a reconciler removes abandoned temporaries after a five-minute grace. Postgres is the plain official `postgres:18.6-trixie` image.

Source server development rebuilds the executable pre-receive hook before startup. Every receive also checks the fixed hook before launching Git. Volume initialization restores owner read/write/search permissions without changing group/other bits; packaged admission checks the data root's effective read/write/search access for both roles.

The mirror worker requires a UID 1000-owned private tmpfs at `/run/kb-mirror` (mode 0700); the generated worker Compose service provides it. Worker admission refuses a disk-backed key directory. Mirror activation verifies a pending key with SSH and a dry-run; pushing main is always an explicit human action. Lost push acknowledgements are recorded as unknown and retries reconcile the advertised remote SHA before sending again; an aggregate Git error alone does not prove rejection. A later failed probe or rejection retains earlier uncertainty until reconciliation succeeds. Accepted bytes cannot be rolled back. Failed ownership/process observation or cleanup retains the execution reservation and retired ciphertext, so disconnect cannot report success until a later recovery confirms drain. Restore observation access and rerun worker recovery before retrying disconnect.

Mirror recovery requires readable, valid helper and process-group ownership evidence before it acknowledges a drain. Invalid process records are re-observed at most twice; only a newly validated record or confirmed process absence permits progress. Observation or cleanup failures retain the reservation and retired deploy-key ciphertext and prevent disconnect success. Restore access to the existing private tmpfs evidence and retry recovery; do not delete it while a previous process may still be running. Helper and network admission each wait for their identity marker to be recorded, and normal cleanup removes the private scratch only after both have drained.

## Quiesced backup bundles

Scheduled/operator `scripts/backup.sh` backups require `BACKUP_AGE_RECIPIENT`.
The server image backup role mounts the data volume read-only and inventories only repos/ and assets/.
Use pinned age v1.3.2; recommend `age-keygen -pq` and its `age1pq1…` public
recipient. Classic `age1…` recipients also work. Keep the private identity,
`KB_MASTER_KEY`, and Better Auth secrets separately with the operator.

A durable maintenance request closes server writes/uploads and worker effects.
After five-minute bounded drain acknowledgements, the offline role acquires
both volume lifetime flocks and the maintenance/schema database locks. A single
exported PostgreSQL snapshot accompanies Git history, disk CAS bytes (or verified S3 references), schema
ownership inputs, instance identity/authority epoch, head and hash inventories.
The encrypted `.age` file is uploadable only with its completed hash marker.
Valkey and model weights are excluded. Failed/incomplete drains retain maintenance;
restart the fenced server once to run journal/CAS recovery without HTTP admission,
then retry the offline backup. Recovery refuses while a live coordinator owns
maintenance. The read-only backup role never performs Git publication.
Ordinary server startup also reclaims abandoned Git upload spool files before
HTTP admission, under the exclusive server volume fence. This recovery follows
no symlinks and leaves unrelated repository temporary files alone; it does not
run periodically against live uploads. If a CGI spawn or drain cannot be
confirmed within its 60-second execution plus five-second drain budget, native
and Git HTTP admission close. A pending spawn retains its original owner until
the supervisor acknowledges and drains it; replacement requires that fence to
be released.
A successful backup clears admission only after the offline supervisor drains
and releases its locks. Runtime Swarm policies restart on any exit (Compose
uses unless-stopped), so scheduled maintenance returns both processes to service.
While the request persists, replacement startup refuses admission and retries.
Required pre-migration/pre-drop backups use these same encrypted full bundles; no database-only fallback exists.

## Offline restore

Use only the server image offline role, with server and worker stopped. Mount a completed
`.age` bundle and its `.complete` marker plus the operator age identity read-only.
Mount one new, empty or skeleton-only, node-writable data volume at `KB_DATA_ROOT`; models, the index and Valkey are rebuilt.
Point DATABASE_URL at a separate empty PostgreSQL 18 database. Run
`restore <bundle.age> <identity-file> <attempt-uuid>` in the
server image. Restore initializes the two volume fence files,
then holds both exclusive flocks and database maintenance/schema locks.

Keep the original KB_MASTER_KEY for provider/sealed/share ciphertext and
BETTER_AUTH_SECRET for TOTP/backup-code records. Missing or wrong needed keys
refuse promotion. Restore verifies every file, Git ref/history/asset lineage,
profile, migration prefix/checksums and source catalog. Unfinished publication journals
are rejected: valid quiesced bundles have already completed that recovery.
Every live Prisma comparison requires a complete successful native diff RPC,
a successful CLI exit, and all native engines drained. Printed SQL followed by
a missing or truncated result cannot admit startup.

On failure, leave staging intact and retry offline with the SAME attempt UUID,
bundle, identity and target. The durable control row blocks migrations and
server/worker startup. Do not copy files onto
an existing deployment; restore requires empty targets and the offline fences.

Promotion increments the authority epoch once, preserves roles/bootstrap and
permanent revocation tombstones, revokes OAuth/PAT/device/browser authority,
destroys deploy keys and disconnects mirrors. Transient work is cancelled.
Active index pointers are cleared; enabled built-in models download again and
usable external profiles receive fresh index jobs. The seven-day deletion hold, invalidated runtime registrations, READY and restore
audit commit only after verified promotion. Users log in again; administrators
explicitly re-enroll credentials and reconnect mirrors. A repeated ready
attempt rechecks its mounted inventory with admission closed during verification.


Reviewed PR merge preparation and details use one operation deadline across Git
reads, final-tree checks, and asynchronous object writes/fsyncs. Interrupted
children drain before the KB lease is released. Divergent merge scratch lives
under the repository volume's `.private/tmp/merge-<attempt-uuid>` inventory,
with a disk-volume reservation before Git object work. Startup and minute
journal recovery reclaim abandoned attempts only under the drained server
volume fence; a live attempt keeps ownership through child/I/O drain and
cleanup. Ordinary cleanup releases the temporary reservation; a reservation
whose cleanup is interrupted also has the existing one-hour expiry fallback.

Concrete setup and custody: [deployment](./deploy.md),
[backup/restore](./backup-restore.md), [model evidence](./embeddings.md).

## Optional asset authority

Disk CAS remains the default. Opt-in S3 makes remote objects authoritative and
local asset payload a strictly bounded shared cache; staging/ZIPs still need
local disk capacity. Logical lineage quotas and live read/revision/manifest/KB
authority checks stay unchanged. Downloads remain server-streamed and private;
there is no signed public bypass or remote deletion. See the
[operator role/configuration matrix](./assets.md#opt-in-s3-operation-and-role-configuration)
for writer/operator/dump identity separation, advisory recency, outage behavior,
dual-fenced initialization/migration/reconciliation and reference-only backup
retention. One server and one worker still share one host/local volume.
