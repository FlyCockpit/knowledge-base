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
pnpm dokploy:config --environment production --git-ref release/0123456789abcdef0123456789abcdef01234567 --git-url https://github.com/<owner>/knowledge-base.git --url https://kb.example --project knowledge-base-production --proxy-network dokploy-network
```

The SHA above is a placeholder: use the deployed immutable release tag.
The command writes `docker-compose.dokploy.yml` and emits the settings JSON.
Import that Compose in Dokploy; supply complete env values privately.

The generated file is gitignored, so Dokploy can't build it from a checkout of
the repository. Every build context is therefore the pinned Git context
`"<git-url>#<git-ref>"`: the Dokploy server's Docker fetches that ref itself,
and a pasted (raw) Compose needs no source tree or repository connection.
`--git-url` defaults to the checkout's `origin` remote; with neither, the
generator stops and names the flag. It accepts `https://`, `ssh://` and
`git@host:owner/repo.git` URLs and refuses credentials (the file is stored in
Dokploy), `#`, queries, quotes, `$`, backslashes and spaces. A private
repository needs an SSH URL the Dokploy server's Docker can fetch. The server
build keeps `.git` in the Git context (`BUILDKIT_CONTEXT_KEEP_GIT_DIR: "1"`)
because the image reads its commit from `.git/HEAD` when `BUILD_VERSION` is
unset, so `/ready` and `pnpm deploy:check` still see the release.
`--git-url local` keeps `context: .`, only for plain `docker compose` from a
checkout. The
checklist records the choice as `compose.buildContext` and fills
`customGitUrl` for native applications. Generated Compose uses
server-led migrations and a dedicated waiting worker. Preserve generated mounts,
health checks, tmpfs, placement, init and stop-first policies. To review a real
running deployment use `pnpm dokploy:verify` with its documented CLI flags.
The generator is configuration preparation, not a deployment.

For a new deployment, set only `POSTGRES_PASSWORD`, `REDIS_PASSWORD`,
`KB_MASTER_KEY`, `BETTER_AUTH_SECRET` and `ADMIN_EMAIL` in Dokploy. Generate
strong per-instance secrets privately (`KB_MASTER_KEY` is base64 of 32 random
bytes). The generated Compose supplies database/cache URLs and the HTTPS auth
origin. No SMTP, IdP, backup settings, backup volume or backup sidecar is needed.
Public signup stays closed; bootstrap uses the configured admin identity.
The native-application checklist matches: `applications[].environment`
references only `DATABASE_URL`, `REDIS_URL`, `KB_MASTER_KEY`,
`BETTER_AUTH_SECRET` and `ADMIN_EMAIL` from Dokploy's environment (native
applications use separate database and cache services, so they take URLs
instead of the two passwords; listed under `environmentVariablesToSetOnce`).
Every other key is either a literal default (`BACKUP_ENABLED=false`,
`SIGNUP_ENABLED=false`, `SMTP_PORT=587`, ...) or left out; to opt in to SMTP,
backups, S3 assets or a provider, add the keys listed for that application in
`optionalEnvironmentKeys` (each role lists only what it may receive).

Backups default off: `BACKUP_ENABLED` defaults to `false`, including before
migrations and due deletions. Startup prints one notice with opt-in
instructions (the `migrate` job too); disabled
backups do not affect health/readiness. To enable, regenerate with
`--backups true`, set `BACKUP_ENABLED=true` and `BACKUP_AGE_RECIPIENT`, and keep
the generated shared backup output mount. Set `BACKUP_SCHEDULE=daily` on one
backup service to schedule runs. S3 upload is optional. See
[backup configuration and custody](./backup-restore.md).

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
| BETTER_AUTH_SECRET / BETTER_AUTH_URL | Server; strong secret and exact HTTPS canonical origin; retain secret for restored passwords and TOTP/backup codes |
| ADMIN_EMAIL | One canonical identity required for first production bootstrap, even with public signup on |
| MIGRATE_ON_START | Server true; worker false. Optional one-shot migrate before rollout. |
| BACKUP_ENABLED / BACKUP_AGE_RECIPIENT | Optional: default off; enable backups and supply the public recipient only when opting in; private identity separately held by operator |
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
| Cloudflare Tunnel: `cloudflared` → server ([home server](#home-server-behind-a-cloudflare-tunnel)) | `1` |
| Cloudflare Tunnel: `cloudflared` → Traefik → server, Traefik trusting `cloudflared` | `2` |
| No proxy: the server port is reached directly (LAN, bare host, local dev) | `0` (default) |

With `0` the server keys on the TCP socket peer and ignores `X-Forwarded-For`.
If a proxy is in front but the value stays `0`, every client is keyed on the
proxy's address and shares **one** rate-limit bucket: a single noisy client can
exhaust sign-in or MCP budgets for everyone. That fails safe (nobody can pick
their own bucket) but is wrong for production; set the hop count. With a value
above `0`, the server must be reachable only through those proxies (the
generated Compose publishes no host port and only the server joins the proxy
network); a caller that can reach the port directly could otherwise forge the
trusted entries. A proxy that appends the client's port (`1.2.3.4:5678` or
`[2001:db8::1]:5678`, Azure Application Gateway's default) needs no change: the
server strips the port from the selected entry before validating it. A request
whose chain is shorter than the hop count, or whose trusted entry is still not
an IP address, is keyed on the socket peer, never on a client-supplied entry.
Set the value higher than your real proxy count and clients choose their own
key again, so count exactly.

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

The server image applies committed migrations before HTTP admission; the worker waits and registers. Use an explicit `migrate` one-shot with MIGRATE_ON_START=false on runtimes if your platform manages jobs. Backups default off, so migrations and due deletions proceed without backup settings or storage. When BACKUP_ENABLED=true, initialized-database migrations and due deletions require a verified encrypted Postgres + Git + file-store bundle; provision BACKUP_AGE_RECIPIENT and the shared backup output volume, and configured S3 upload failure blocks mutation. BACKUP_ENABLED=true with no destination (no `BACKUP_AGE_RECIPIENT`, or neither a volume mounted at `BACKUP_DIR` nor `BACKUP_S3_BUCKET`; the image's unmounted `/app/backups` does not count) refuses every start that migrates at startup, even with nothing pending, and refuses the migration, a brand-new database too: a proven-empty first `0_init` has nothing to back up, so the runner takes no bundle there but still runs the hook's destination check. Pending restore blocks every admission branch. See [migration operations](./schema-migrations.md) and [offline restore](./backup-restore.md).

The worker wait is 300 seconds; a long bundle can outlast it. Keep automatic restart enabled and retry the worker after the leader completes. Stop-first replacement means a refused migration can cause downtime. Confirm the deployed commit with `pnpm deploy:check <url>`; DEPLOY_CHECK_URL enables the optional GitHub deploy check. The deeper host-side `pnpm dokploy:verify` remains available.

Health includes schema and the actual queue consumer inventory, beyond a Redis
ping. Native helper/hook/model child/SSH wrapper/Prisma runtime closure must be
present before admission. Server shutdown closes HTTP admissions and joins
publication/cleanup; worker stops effects and drains model/mirror children.
Generated server and backup grace is 100 s, worker 30 s. A failed observation leaves the
fence closed; inspect durable intent and process ownership before retrying.
For upgrade replace stop-first, verify schema/readiness, then exercise the public
workflow. Preserve volumes and all operator key custody. Production volume
removal is not an upgrade or recovery step. See [hosting details](./hosting.md).

## Optional S3 asset authority

S3 is default OFF. Follow [asset configuration and role custody](./assets.md#opt-in-s3-operation-and-role-configuration)
before enabling it. The generated Compose explicitly forwards location/mode to
server, worker and backup roles, and cache limit to both runtimes. Only the server gets the runtime asset secret. Full-bundle snapshot children need the operator asset reader and the actual runtime comparison ID; the backup/offline child must not receive the runtime writer secret. The server container receives the read-only asset operator pair for the startup
pre-migrate snapshot when backups are enabled, and the backup writer pair when off-site upload is configured.
The entrypoint is PID 1 while it validates and migrates (both Dockerfiles set
`ENTRYPOINT ["docker-entrypoint.sh"]`); after the runner finishes it removes both
pairs and the backup heartbeat URL, then execs `tini` with the CMD, so neither
`/proc/1/environ` nor the HTTP process carries them (`docker inspect` still shows
every configured variable). A stop signal during startup reaches the running
check or the runner, which drains before the container exits (143/130/129). One-shot backup/restore/storage
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

## Home server behind a Cloudflare Tunnel

A home machine with no public IP can serve the instance through a named
Cloudflare Tunnel (Free or Pro plan). Nothing needs an inbound port: the
server, worker, database and cache all stay private, and `cloudflared` makes
the only outbound connection. TLS ends at Cloudflare's edge.

Two topologies are supported:

- **Direct:** browser / Git / MCP client → Cloudflare edge (TLS) → tunnel →
  `cloudflared` → server `:3000`. No Traefik or Dokploy proxy.
- **Through Traefik:** client → Cloudflare edge → tunnel → `cloudflared` →
  Dokploy's Traefik → server `:3000`, for a Dokploy host that already runs
  Traefik for other apps.

Generate the Compose as usual with the tunnel hostname as `--url`
(`--url https://kb.example.com`). For the direct topology, create a private
Docker network, pass it as `--proxy-network`, and run `cloudflared` on it; the
server joins that network under the alias `<project>-server`. No host port is
published, so the tunnel is the only way in. If you run `cloudflared` on the
host instead of in a container, publish the server only on loopback
(`127.0.0.1:3000:3000`), never on `0.0.0.0`: Docker's published ports bypass
host firewalls such as `ufw`. Its ingress then points at
`http://127.0.0.1:3000`.

Create a named tunnel either way:

- **Remotely managed** (simplest): create it in the Zero Trust dashboard, add
  the public hostname there, and run the connector with the tunnel token. The
  token is the only secret; keep it in the Compose environment block, never in
  a file in the checkout.
- **Locally managed**: `cloudflared tunnel login`, `cloudflared tunnel create`,
  `cloudflared tunnel route dns`, then a `config.yml`. Keep it and the
  credentials JSON **outside the checkout** (for example `/etc/cloudflared`):
  the image build runs `COPY . .`, so a credentials file inside the checkout
  would land in the build layers. The official `cloudflare/cloudflared` image
  runs as UID 65532 and the credentials file is owner-readable only, so hand
  the directory to that UID (`chmod 400` the named `<tunnel-uuid>.json`, then
  `chown -R 65532:65532` and `chmod 700` the directory; these need root, so
  run them yourself).

Sample `/etc/cloudflared/config.yml` (direct; the project name is
`knowledge-base-production`):

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: kb.example.com
    service: http://knowledge-base-production-server:3000
  - service: http_status:404
```

and the connector, on the same private network as the server:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:<version>   # pin a version you have tested
    command: tunnel --no-autoupdate run
    # Remotely managed: no volume; set TUNNEL_TOKEN in the environment instead.
    volumes:
      - /etc/cloudflared:/etc/cloudflared:ro
    networks: [<proxy-network>]
    restart: unless-stopped
```

Through Traefik, point the ingress at Traefik's TLS entrypoint instead; the
generated router listens only on `websecure`. Use the address `cloudflared`
can reach: `https://localhost:443` when `cloudflared` runs on the host, or
Traefik's container name when `cloudflared` is a container on
`dokploy-network` (Dokploy names it `dokploy-traefik`). With no inbound ports
the generated HTTP-01 `letsencrypt` resolver cannot issue, so Traefik serves
its default self-signed certificate. Prefer a valid certificate (a DNS-01
resolver, or one Traefik already holds) and keep verification on; only for the
self-signed fallback on that local hop add `noTLSVerify`:

```yaml
  - hostname: kb.example.com
    service: https://dokploy-traefik:443
    originRequest:
      originServerName: kb.example.com
      noTLSVerify: true # only while Traefik serves its self-signed default
```

Or skip the certificate on that local hop: add a router for the hostname on a
plain-HTTP Traefik entrypoint that does not redirect to HTTPS and point the
ingress at `http://dokploy-traefik:80`. Either way, a Traefik port published
on the host is reachable from the LAN, and anyone there can send a forged
`X-Forwarded-For` through a hop the server trusts; forward no router ports and
keep those ports to trusted machines.

**Environment.** These match the generated Compose apart from the hop count:

| Setting | Direct | Through Traefik |
| --- | --- | --- |
| `BETTER_AUTH_URL` | `https://kb.example.com` (from `--url`) | same |
| `CORS_ORIGIN` | unset (same origin) | unset |
| `PUBLIC_APP_URL` | unset, or the tunnel origin (translation metadata only) | same |
| `TRUST_PROXY_HOPS` | `1` (the generated value) | `2`, only after Traefik trusts `cloudflared` (below); otherwise `1` |
| `SMTP_HOST` / `SMTP_PORT` | a submission relay on `587` (generated default) or `465` | same |

`BETTER_AUTH_URL` and `CORS_ORIGIN` are the server's only origin allow-list:
the same-site JSON checks, export downloads and MCP OAuth metadata all use the
configured origin, never the request's `Host`. Home ISPs usually block outbound
port 25, so use an authenticated relay on 587 or 465.

**Client IP.** Cloudflare appends the visitor's address to `X-Forwarded-For`,
and `cloudflared` forwards it unchanged; the socket peer is `cloudflared` (or
Traefik). Direct, `1` selects the visitor. Through Traefik, `2` is right only
when Traefik keeps that header: set
`entryPoints.websecure.forwardedHeaders.trustedIPs` to `cloudflared`'s address
(for example its container network's subnet). The server does **not** read
`CF-Connecting-IP`: the hop count already yields the same address, and that
header is forgeable by anything that can reach the server without the tunnel.
Leaving `0` puts every visitor in one rate-limit bucket; the server then logs
`client-ip.proxy-hops` once, because `cloudflared` connects from a private
address.

**Request limits.** Cloudflare rejects request bodies over 100 MB on Free and
Pro. It answers `524` when the origin sends no response within its proxy read
timeout (documented as 125 s; plan for 100 s) or does not accept the request
within its 30 s write timeout. This app reads every body as it arrives and caps
it below 100 MB. The surfaces that can run long have these deadlines before
their first response byte (ordinary database and session lookups have none of
their own and are normally milliseconds):

| Surface | Body cap | Server-side time caps |
| --- | --- | --- |
| Git push (`git-receive-pack`) | 50 MiB | upload 120 s (10 s idle), then 60 s to validate and publish |
| Git fetch / clone (`git-upload-pack`) | 50 MiB request | upload 120 s (10 s idle), then 60 s for the response |
| MCP (`POST /mcp`) | 1 MiB | 30 s per tool call |
| Asset and Markdown uploads | chunked: 192 KiB raw chunks (512 KiB encoded request) from the browser, `knowledge_upload_write` calls within the MCP cap from `kb` and agents | 30 s per request |
| Other `/rpc` and form requests | 10 MiB | body 30 s; searches 60 s, KB mutations 30 s |
| Sign-up, password reset, email 2FA (and its relay preflight), invitations | 10 MiB | per SMTP attempt: 10 s setup, 10 s to send; 3 attempts (about 60 s worst case); preflight 10 s |
| Export start and status (`kbExports.prepare` / `status` / `cancel`, MCP `knowledge_export_*`) | 10 MiB / MCP 1 MiB | admission only (milliseconds); the ZIP is built in the background, outside any request, within its own 30 min deadline (at most 256 MiB of content) |
| Admin web-push broadcast (`push.send`) | 10 MiB | 10 s per device, 8 devices at a time; no overall cap |
| Asset reads, export downloads | responses stream (no request body) | asset reads 120 s |

Responses are not capped by the 100 MB limit. The read timeout runs once the
request has been sent, so for Git only the 60 s phase counts against it; the
upload phase keeps bytes moving (a 10 s stall is refused, well inside the 30 s
write timeout). An asset read from a cold S3 cache waits for the object before
its first byte, up to the 120 s asset deadline, which is longer than the
100 s budget. A cancelled read discards the partial cache fill, so a retry
starts cold again; keep S3 latency low (or use disk assets) behind a tunnel.
Exports never wait inside a request: starting one returns at once, the server
builds the ZIP as a background job (it survives the browser closing), and the
web app and `kb` poll its status with short requests, then download the
finished ZIP as an ordinary streamed response. A build that outlasts its 30 min
deadline, or that a server restart interrupts, ends failed with a clear reason
and is started again. An admin push broadcast to many slow push services
can outlast the timeout too; the broadcast still completes, only its summary
reply is lost. Model downloads, mirrors and backups are outbound or run on the
host, and offline restore is a one-shot command; none of them go through the
tunnel.

**Connections.** The app opens no WebSockets or event streams: the web app
uses ordinary requests and MCP is POST-only JSON. When Cloudflare restarts an
edge or `cloudflared` reconnects, only in-flight requests fail. Nothing retries
a failed write automatically: the web app and `kb` show the error, and you
repeat the action. After an interrupted `git push`, check the remote ref
(`git ls-remote`) before pushing again. The server keeps idle upstream
connections open for 95 s, longer than `cloudflared`'s 90 s `keepAliveTimeout`
and Traefik's 90 s idle reuse, which avoids the idle-timeout race with those
proxies' defaults (a proxy configured to reuse connections longer than 95 s
reintroduces it).

**Does not apply:** the `letsencrypt` certresolver and `websecure` router
labels in the direct topology (harmless, unused; through Traefik see above),
opening ports 80/443 on the home router, and the Cloudflare → Traefik
`trustedIPs` ranges above (`cloudflared` connects from your own network, not
from Cloudflare's published ranges). Do not expose the server port with a
router port-forward alongside the tunnel; with a hop count above `0` that
would let callers forge their rate-limit key.

## Confirming a deploy is live

Run `pnpm deploy:check https://kb.example` after deploying. It defaults to the current checkout commit, polls the public /ready endpoint and requires two consecutive ready replies reporting that commit. Use `--commit <sha>` for an explicit release and `--timeout <seconds>` for slow VPS builds. The image bakes its commit; missing metadata produces a clear failure. A failed check means the expected release has not been confirmed live.

Set GitHub repository variable DEPLOY_CHECK_URL to the **development** origin that auto-deploys main to enable the optional default-branch deploy-check workflow. Production deploys immutable release tags manually; run deploy:check with that release SHA after its deployment. DEPLOY_CHECK_TIMEOUT defaults to 1800 seconds. It uses no secrets. For host placement, mounts, runtime inventory and readiness details, use `pnpm dokploy:verify --server <project>-server --worker <project>-worker --url <origin>`.

`BETTER_AUTH_SECRET_PREVIOUS` is optional on the server during password pepper rotation; see [password pepper](./hosting.md#password-pepper) for the required replica and two-factor precautions.
