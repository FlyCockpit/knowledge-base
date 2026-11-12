# Deploying a single instance

Dokploy on a Linux VPS is the supported target: one server and one dedicated
worker on the same host/local persistent filesystem, stop-first replacement.
No horizontal replicas, multi-host writers or network filesystems. In Swarm,
label exactly one node `knowledge-base=true`; every generated service is placed
there with one replica. Native supervisors hold volume lifetime flocks and drain
descendants before successors enter. Do not unlink locks to recover readiness.
A successor that finds the volume flock still held logs `supervisor.fatal` with
`reason: FENCE_HELD` and exits 85; other supervisor startup failures carry their
own `reason` and exit status.

## Prerequisites and generated Compose

Use the shipped Node 26 Debian 13 (trixie) glibc images: every image builds on
one digest-pinned `node:26-trixie-slim` base. The server and worker refuse to
start on git older than 2.45 (PR merges and conflict checks run
`git merge-tree --write-tree -X… --merge-base=<tree>`); Debian 12's git 2.39 is
too old. The worker includes Git/OpenSSH/native compiler closure and both
optional model runtimes. No weights are baked in. PostgreSQL 18
uses the official `postgres:18.6-trixie@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42`;
it needs no extension for search. The stock better-sqlite3 prebuilt binary comes
inside its npm package; image builds fetch nothing else for it.
Valkey 9.1 (Redis-compatible; Redis also works) uses AOF and noeviction. Provide HTTPS, the Dokploy external network and
sufficient storage/RAM for selected models and retained Git/CAS history.
PostgreSQL 18 mounts its volume at `/var/lib/postgresql`, with PGDATA at
`/var/lib/postgresql/18/docker`.

Generate the reviewable configuration and environment checklist from source:

```sh
pnpm dokploy:config --environment production --git-ref release/0123456789abcdef0123456789abcdef01234567 --url https://kb.example --project knowledge-base-production --proxy-network dokploy-network
```

The SHA above is a placeholder: use the deployed immutable release tag.
The command writes `docker-compose.dokploy.yml` and emits the settings JSON.
Import that Compose in Dokploy; supply complete env values privately. Generated Compose uses
server-led migrations and a dedicated waiting worker. Preserve generated mounts,
health checks, tmpfs, placement, init and stop-first policies. To review a real
running deployment use `pnpm dokploy:verify` with its documented CLI flags.
The generator is configuration preparation, not a deployment.

## Environment, roles and custody

Env schema and `scripts/lib/env-manifest.ts` are authoritative; regenerate
examples with `pnpm env:sync`, check with `pnpm env:check`. Never copy production
credentials to development or commit filled env files.

| Input | Recipient / purpose |
| --- | --- |
| DATABASE_URL | Server, worker, schema leader, backup/restore as appropriate; distinct roles for runtime and operator work |
| REDIS_URL | Server and worker; private authenticated network, no public port |
| KB_DATA_ROOT | Server, worker, backup/restore; the one data volume, default `/var/lib/knowledge-base` |
| KB_MASTER_KEY | Server and worker; exactly base64 32 bytes, encrypts providers/sealed/shares/mirror keys; retain separately for restore |
| BETTER_AUTH_SECRET / BETTER_AUTH_URL | Server; strong secret and exact HTTPS canonical origin; retain secret for restored TOTP/backup codes |
| ADMIN_EMAIL | One canonical identity required for first production bootstrap, even with public signup on |
| MIGRATE_ON_START | Server true; worker false. Optional one-shot migrate before rollout. |
| BACKUP_AGE_RECIPIENT | Offline backup role public recipient; private identity separately held by operator |
| BACKUP_S3_* | Optional private off-site backup target with distinct dump-writer key; not KB asset storage |
| SMTP_* / SIGNUP_ENABLED | Server human invitations/signup policy; no-SMTP private links remain available |
| TRUST_PROXY_HOPS | Server; exact count of trusted reverse proxies for the client-IP rate-limit key. Generated Compose sets `1` (Traefik). See below. |

The search index needs no database role or credential: the worker writes SQLite
files to the data volume and the server reads them. The generated checklist
explains provisioning; don't use the disposable agent profile's passwords for
production. Bootstrap completes once; it never re-promotes a
demoted identity. Instance administration does not confer private KB access.

### Client IP and reverse proxies

Anonymous rate limits (sign-in, 2FA, MCP, public pages) key on the client IP.
The server never trusts `X-Forwarded-For` by itself; `TRUST_PROXY_HOPS` is the
exact number of proxies you run between the client and the server, and the
client is the address the outermost of them appended:

| Topology | `TRUST_PROXY_HOPS` |
| --- | --- |
| Generated Dokploy Compose (client → Traefik → server) | `1` (set by the generator) |
| Cloudflare → Traefik → server, with Traefik trusting Cloudflare (below) | `2` |
| No proxy: the server port is reached directly (LAN, bare host, local dev) | `0` (default) |

With `0` the server keys on the TCP socket peer and ignores `X-Forwarded-For`.
If a proxy is in front but the value stays `0`, every client is keyed on the
proxy's address and shares **one** rate-limit bucket: a single noisy client can
exhaust sign-in or MCP budgets for everyone. That fails safe (nobody can pick
their own bucket) but is wrong for production; set the hop count. With a value
above `0`, the server must be reachable only through those proxies (the
generated Compose publishes no host port and only the server joins the proxy
network); a caller that can reach the port directly could otherwise forge the
trusted entries. A request whose chain is shorter than the hop count, or whose
trusted entry is not an IP address, is keyed on the socket peer, never on a
client-supplied entry. Set the value higher than your real proxy count and
clients choose their own key again, so count exactly.

A proxy only counts if the next one keeps what it wrote. Dokploy's Traefik
does not trust incoming `X-Forwarded-For` by default: behind Cloudflare it
replaces the header with Cloudflare's edge address, so `2` finds a one-entry
chain and every visitor shares the socket bucket, and `1` keys visitors per
Cloudflare edge. Use `2` only after setting Traefik's
`entryPoints.<name>.forwardedHeaders.trustedIPs` to Cloudflare's published
ranges and firewalling the origin to Cloudflare; otherwise keep `1`.

The proxy network is shared: other Dokploy applications on `dokploy-network`
can reach the server container directly and set their own forwarded entry.
Treat co-tenants on that network as trusted, or give Traefik and this server a
dedicated network.

When the value is `0` and a private-network peer sends `X-Forwarded-For` (an
uncounted proxy), the server logs `client-ip.proxy-hops` once per process.

## Persistent mount graph

One data volume, `kb-data`, is mounted at `KB_DATA_ROOT`
(`/var/lib/knowledge-base`). It holds `repos/`, `assets/`, `models/` and
`index/`; nothing may be mounted below it.

| Volume / path | Server | Worker | Offline backup / restore |
| --- | --- | --- | --- |
| kb-data / /var/lib/knowledge-base | RW | RW | RO (repos/, assets/ only) / exclusive RW, empty or skeleton-only |
| PostgreSQL data | private database service | private database service | consistent snapshot / empty destination |
| Valkey data | queue/rate-limit service | queue service | excluded / reconstruct durable jobs |

Every image carries a UID/GID 1000-owned data-volume skeleton; on first
mount Docker copies it into the empty named volume, and the nonroot entrypoints
re-create missing pieces without following symlinks. No container runs as root.
Bind mounts get no copy-up: pre-create the host root directory owned 1000:1000.
If ownership later drifts, the runtime admission check refuses to start; fix it
on the host (`chown -R 1000:1000` on the volume) rather than in a container.
`index/` holds rebuildable search files; size the volume for them alongside Git
and CAS history (see [embeddings](./embeddings.md)). Mirror private-key scratch must be UID/GID 1000 mode 0700
**tmpfs** at `/run/kb-mirror`, with no disk fallback; generated mount is 16 MiB,
noexec/nosuid/nodev.

**Security tradeoff.** The worker mounts the data volume read-write, so a
compromised worker (provider HTTP client, native model child, mirror Git/SSH
path) can modify Git repositories, CAS bytes and index files; the server also
mounts `models/`. No read-only OS control
remains for the worker: the read-only mounts and the admission checks that
required them are gone. What remains is the nonroot UID 1000, the private
tmpfs key check for mirrors, mirror scratch/alternates isolation, the process
fences, Git/CAS hash verification and backups. One filesystem also means one
disk-quota account for repos, assets, models and the index.

## Schema, readiness and replacement

The server image applies committed migrations before HTTP admission; the worker waits and registers. Use an explicit `migrate` one-shot with MIGRATE_ON_START=false on runtimes if your platform manages jobs. A proven-empty first `0_init` needs no backup; initialized-database migrations and due deletions require a verified encrypted Postgres + Git + file-store bundle. Provision BACKUP_AGE_RECIPIENT and the shared backup output volume before the next schema change; configured S3 upload failure blocks mutation. Pending restore blocks every admission branch. See [migration operations](./schema-migrations.md) and [offline restore](./backup-restore.md).

The worker wait is 300 seconds; a long bundle can outlast it. Keep automatic restart enabled and retry the worker after the leader completes. Stop-first replacement means a refused migration can cause downtime. Confirm the deployed commit with `pnpm deploy:check <url>`; DEPLOY_CHECK_URL enables the optional GitHub deploy check. The deeper host-side `pnpm dokploy:verify` remains available.

Health includes schema and the actual queue consumer inventory, beyond a Redis
ping. Native helper/hook/model child/SSH wrapper/Prisma runtime closure must be
present before admission. Server shutdown closes HTTP admissions and joins
publication/cleanup; worker stops effects and drains model/mirror children.
Generated server grace is 100 s, worker 30 s. A failed observation leaves the
fence closed; inspect durable intent and process ownership before retrying.
For upgrade replace stop-first, verify schema/readiness, then exercise the public
workflow. Preserve volumes and all operator key custody. Production volume
removal is not an upgrade or recovery step. See [hosting details](./hosting.md).

## Optional S3 asset authority

S3 is default OFF. Follow [asset configuration and role custody](./assets.md#opt-in-s3-operation-and-role-configuration)
before enabling it. The generated Compose explicitly forwards location/mode to
server, worker and backup roles, and cache limit to both runtimes. Only the server gets the runtime asset secret. Full-bundle snapshot children need the operator asset reader and the actual runtime comparison ID; the backup/offline child must not receive the runtime writer secret. The server container receives the read-only asset operator pair for the startup
pre-migrate snapshot, and the backup writer pair for its required off-site upload.
After the runner finishes, the entrypoint removes both pairs and the backup
heartbeat URL before starting the HTTP process. One-shot backup/restore/storage
commands retain their operator inputs. The runtime asset writer stays on the
server only; the worker keeps only its ListBucket freshness-monitor credentials.
BACKUP_S3_* keys must differ from both asset identities. Worker freshness uses its separate BACKUP_MONITOR_S3_* pair. Distinct IDs still require independently provisioned IAM.

The opt-in backup service keeps `kb-data` RO. Use the generated
`asset-operator` profile for offline migration/reconciliation (RW data mount,
same image/ref and host placement). Stop server and worker first. To initialize
S3, including an empty instance, run the offline migration before starting
runtimes. To change cache capacity, use the offline
reconciliation command, then restart both roles with the installed limit.
Startup rejects missing cache metadata, mode/location mismatch or pending
migration before accepting traffic; matching S3 startup makes no remote request.
Retry interrupted offline work with the original attempt UUID and retain evidence.

Agent development uses explicit `AGENT_KB_ASSET_*` inputs, default OFF, overriding
host `.env` asset values. Use disposable fixture credentials and buckets only.
The worker override excludes both runtime and operator secrets. Image-smoke and
integration infrastructure default to disk; S3 tests use in-process HTTP fixtures.
Run `pnpm dokploy:verify` for health, placement and readiness acceptance; it never
reads service environment values or certifies bucket IAM/retention. Also verify
an upload, historical asset/Range, export and encrypted backup/restore before
accepting an enabled deployment. The one-host, one-server/one-worker topology
continues to apply when asset authority is remote.

## Sharing a Dokploy host

`--project` defaults to `knowledge-base-<environment>` and prefixes Compose resources, private networks, volumes and Traefik router/service/middleware IDs. Use a distinct project for every instance. `--proxy-network` defaults to the shared external `dokploy-network`; select the existing proxy network, not a new proxy. Only the server joins it; database, cache and worker stay private. Database and cache URLs use project-prefixed hostnames with aliases on the project-private network, avoiding bare postgres/redis names that other stacks may publish on the shared proxy network. No container_name or default host ports are required. Keep ports 80/443 with Dokploy; do not bind another app to 3000 on the host. Always supply the intended HTTPS `--url`.

## Confirming a deploy is live

Run `pnpm deploy:check https://kb.example` after deploying. It defaults to the current checkout commit, polls the public /ready endpoint and requires two consecutive ready replies reporting that commit. Use `--commit <sha>` for an explicit release and `--timeout <seconds>` for slow VPS builds. The image bakes its commit; missing metadata produces a clear failure. A failed check means the expected release has not been confirmed live.

Set GitHub repository variable DEPLOY_CHECK_URL to the **development** origin that auto-deploys main to enable the optional default-branch deploy-check workflow. Production deploys immutable release tags manually; run deploy:check with that release SHA after its deployment. DEPLOY_CHECK_TIMEOUT defaults to 1800 seconds. It uses no secrets. For host placement, mounts, runtime inventory and readiness details, use `pnpm dokploy:verify --server <project>-server --worker <project>-worker --url <origin>`.
