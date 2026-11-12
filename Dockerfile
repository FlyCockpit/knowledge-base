FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base

# Runtime base:
#   - openssl: required by Prisma query engine
#   - postgresql-client-${PG_MAJOR}: provides psql, used by docker-entrypoint.sh
#     for guarded migrations and encrypted full-bundle backup/restore.
# The client comes from the upstream PostgreSQL apt repository (PGDG), pinned to
# PG_MAJOR, not from Debian's default repo whose `postgresql-client` major can be
# older than your Postgres server. PG_MAJOR must match your Postgres server's
# major version (and the same ARG in Dockerfile.worker); `pnpm docker:check-copy`
# fails on drift. A newer
# client can dump/connect to an older server; the reverse is not supported, so
# bump PG_MAJOR when you upgrade the database. The PGDG repo is enabled by the
# script bundled with Debian's own postgresql-common (it carries the signing key,
# so no curl/gnupg is needed) and the codename comes from /etc/os-release.
# `apt-get upgrade` pulls the latest Debian security patches for packages
# already in node:26-trixie-slim (glibc, libcap2, systemd libs, etc.) — the base image
# lags the Debian point release, so Trivy fails on fixable HIGH CVEs without it.
# APT_CACHE_DATE exists only to break the buildx layer cache: CI passes the
# current UTC date so this layer is rebuilt (and re-upgraded) at most daily —
# a warm cache would otherwise freeze the upgrade at whenever the layer was
# first built and Trivy would fail on patches Debian shipped since. Local
# builds keep the constant default and stay fully cached. Keep this block in
# both runtime Dockerfiles (AGENTS.md § keep in sync).
ARG APT_CACHE_DATE=static
ARG PG_MAJOR=18
RUN echo "apt-cache-date: ${APT_CACHE_DATE}" \
  && apt-get update -y && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
  && . /etc/os-release \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y "${VERSION_CODENAME:-}" \
  && apt-get install -y \
  openssl \
  postgresql-client-${PG_MAJOR} \
  git \
  tini \
  && rm -rf /var/lib/apt/lists/* \
  && test -x /usr/lib/git-core/git-http-backend \
  && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/private/ssl-cert-snakeoil.pem

# --- Native supervisor ---
# Linux process fence: volume flock, subreaper, descendant drain. Warnings
# are errors. The binary is COPYd into the runner; it is never optional.
FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS native
ARG APT_CACHE_DATE=static
RUN echo "apt-cache-date: ${APT_CACHE_DATE}" \
  && apt-get update -y \
  && apt-get install -y --no-install-recommends gcc make libc6-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY apps/server/native/ ./
COPY apps/worker/src/native/child-guard.c ./
# Drop a host-built binary if the context still contains one (gitignore +
# dockerignore should already exclude it). Timestamp-based make would otherwise
# copy a glibc-newer binary into node:26-trixie-slim.
RUN rm -f kb-supervisor && make -j2 \
  && test -x /src/kb-supervisor \
  && gcc -std=c11 -Wall -Wextra -Werror -O2 -D_GNU_SOURCE -o kb-child-guard child-guard.c

# Pinned age archives and SHA-256 verification shared by all recovery commands.
FROM base AS age-tooling
ARG TARGETARCH
COPY scripts/lib/age-pin.mjs /tmp/age-pin.mjs
RUN node /tmp/age-pin.mjs --install /opt/age --arch "$TARGETARCH" \
  && /opt/age/age --version | grep -Fx v1.3.2 \
  && /opt/age/age-keygen --version | grep -Fx v1.3.2 \
  && rm /tmp/age-pin.mjs

# --- Build-time base ---
# Adds pnpm. Git is already in `base` so the runner can read repos and
# invoke git-http-backend (`/usr/lib/git-core/git-http-backend`).
FROM base AS build-base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Canonical pnpm toolchain step (`pnpm docker:check-copy`), identical in all
# three Dockerfiles. Node 25+ no longer bundles Corepack: install the pinned
# version globally under /usr/local (already on PATH), only in this build stage.
# Corepack verifies the packageManager sha512,
# and the first run fetches pnpm 12's signature-checked native binary here,
# at build time, never at runtime.
RUN npm install --global --no-fund --no-audit corepack@0.36.0 && mkdir -p "$PNPM_HOME" && corepack enable --install-directory "$PNPM_HOME" pnpm && corepack prepare pnpm@12.17.0+sha512.b8d223ebec04b580a89ed206daa71d1bccb6a1ee1d52efa95cc3b0db75271561df8f0d8e2c43add39c5ec08018af7a8a95108e7090f95a29f88727b7a40fd53d --activate && test "$(pnpm --version)" = "12.17.0"

# --- Builder stage ---
# pnpm install runs here with source files present so workspace symlinks resolve correctly
FROM build-base AS builder

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY patches/ patches/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY packages/api/package.json packages/api/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/i18n-translate/package.json packages/i18n-translate/
COPY packages/locales/package.json packages/locales/
COPY packages/mailer/package.json packages/mailer/
COPY packages/queue/package.json packages/queue/
COPY packages/test-utils/package.json packages/test-utils/
COPY packages/ui/package.json packages/ui/

# Prisma schema + config must be present before install (postinstall runs prisma generate)
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma

# Strip the root `postinstall` (which only runs `lefthook install`, a dev-only
# git hook installer that errors without a real repo). The real package.json is
# restored by the subsequent `COPY . .`, so this only affects the install step.
RUN node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));delete p.scripts.postinstall;require('fs').writeFileSync(f,JSON.stringify(p,null,2))"

RUN pnpm install --frozen-lockfile

COPY . .

# Keep the restored root package.json from reintroducing the dev-only lefthook
# installer in later Docker build steps after the full source tree is copied.
RUN node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));delete p.scripts.postinstall;require('fs').writeFileSync(f,JSON.stringify(p,null,2))"

# Remove any stale .js files next to .tsx route files (breaks TanStack Router)
RUN find apps/web/src/routes -name '*.js' -delete 2>/dev/null || true

# Build-time client env. Vite inlines VITE_* into the SPA bundle during the
# build below — they are NOT read at runtime, so they must be present here.
# Platforms that forward env vars into the Docker build inject them as build
# args with matching keys. Both are
# optional; an empty value falls back to the app default (VITE_APP_NAME -> "KnowledgeBase",
# VITE_SERVER_URL -> window.location.origin). Changing either requires a REBUILD,
# not just a restart.
# Worker note: Dockerfile.worker does NOT build the web SPA, so it needs no
# matching ARG block — this is the one build-arg surface that legitimately
# differs between the two Dockerfiles.
ARG VITE_APP_NAME=""
ARG VITE_SERVER_URL=""
ENV VITE_APP_NAME=$VITE_APP_NAME \
    VITE_SERVER_URL=$VITE_SERVER_URL

# Deterministic build version. The web build (vite.config.ts → getBuildVersion())
# prefers process.env.BUILD_VERSION over `git rev-parse`. Only minimal Git
# metadata enters the build context; contexts without it fall back to a random UUID
# per build (a fresh "version" on every rebuild of the SAME commit). Pass a
# stable value (the git SHA) so identical content keeps the same version across
# rebuilds. Empty = falls back to the random UUID. Pass it as a build arg
# (wired to the commit SHA) to make it stable.
# Worker note: Dockerfile.worker does NOT build the web SPA, so it needs no
# matching ARG — same as the VITE_* block above.
ARG BUILD_VERSION=""
ENV BUILD_VERSION=$BUILD_VERSION

# --- Turborepo Remote Cache ---
# Shipped present-but-inert: with both empty (the default on a fresh clone),
# turbo reports NotLinked and the build runs normally with local cache only —
# no error, no behavior change ("just skips"). Set TURBO_TOKEN + TURBO_TEAM
# (BOTH required; a token alone is ignored) to make `turbo build` replay cached
# app outputs from Vercel's free remote cache ("just works"). Platforms that
# forward env vars into the Docker build as build args
# populate these automatically; everywhere else pass them explicitly, e.g.
# `docker build --build-arg TURBO_TOKEN=… --build-arg TURBO_TEAM=…`. Self-host
# instead? add a matching `ARG TURBO_API=""` here and point it at your cache
# (see the pattern doc). Builder stage ONLY — the final runner stage is
# FROM base and never inherits these ENVs, so the token never ships in the
# image. Keep this block in BOTH Dockerfiles (AGENTS.md § keep in sync).
ARG TURBO_TOKEN=""
ARG TURBO_TEAM=""
ENV TURBO_TOKEN=$TURBO_TOKEN \
    TURBO_TEAM=$TURBO_TEAM

# Give the Vite/rolldown + turbo build heap headroom. Builder stage ONLY — the
# runner stage is FROM base and sets its own (much lower) runtime default below.
# Keep this line identical in BOTH Dockerfiles (AGENTS.md § keep in sync).
ENV NODE_OPTIONS="--max-old-space-size=4096"

RUN pnpm turbo build --concurrency=3 --filter=server --filter=web
RUN node scripts/build-commit.mjs . > apps/server/dist/BUILD_COMMIT

# Verify build outputs exist. The index reader thread entry ships flat next to the server
# bundle, and the index writer (marked "__KB_INDEX_WRITER__") must never reach the server.
RUN test -f apps/server/dist/index.mjs && test -f apps/server/dist/service.mjs && test -d apps/web/dist/client && test -d apps/web/dist/server \
  && test -f apps/server/dist/kb-index-reader.mjs \
  && ! grep -rl '__KB_INDEX_WRITER__' apps/server/dist

# Deploy the existing db package's full lockfile-pinned CLI/pg/S3 closure.
# Plain copies avoid lower-layer pnpm-store hardlink copy-up and fsync.
# Bundle only the existing Better Auth decryption primitive for retained TOTP
# records; esbuild comes from the already pinned tsx closure. No extra dependency.
RUN node --input-type=module -e 'import {createRequire} from "node:module";const r=createRequire(import.meta.url);const e=createRequire(r.resolve("tsx/package.json"))("esbuild");await e.build({stdin:{contents:"export { symmetricDecrypt } from \"better-auth/crypto\"; export { decryptKbSecretBytes } from \"../api/src/lib/kb/envelope.ts\"; export { embeddingFingerprint } from \"../api/src/lib/kb/fingerprint.ts\"; export { parseAssetManifest, validateManifestDocument } from \"../api/src/lib/kb/manifest.ts\";",resolveDir:"/app/packages/auth"},bundle:true,platform:"node",format:"esm",banner:{js:"import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);"},outfile:"/app/restore-crypto.mjs"})'

# The offline reader shares the exact SDK/key/hash/size verification with runtime.
RUN node --input-type=module -e 'import {createRequire} from "node:module";const r=createRequire(import.meta.url);const e=createRequire(r.resolve("tsx/package.json"))("esbuild");await e.build({entryPoints:["packages/api/src/lib/kb/asset-storage-offline.ts"],bundle:true,platform:"node",format:"esm",external:["@aws-sdk/client-s3"],banner:{js:"import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);"},outfile:"/app/asset-storage-domain.mjs"})'

# Startup/schema guards share a small import-pure domain with runtime admission.
RUN node --input-type=module -e 'import {createRequire} from "node:module";const r=createRequire(import.meta.url);const e=createRequire(r.resolve("tsx/package.json"))("esbuild");await e.build({entryPoints:["packages/api/src/lib/kb/asset-storage-mode.ts"],bundle:true,platform:"node",format:"esm",outfile:"/app/asset-storage-admission.mjs"})'

RUN pnpm --filter @knowledge-base/db --config.inject-workspace-packages=true \
  --config.package-import-method=copy deploy --prod /app/schema-runtime \
  && rm -rf /app/schema-runtime/node_modules/.pnpm/typescript@* \
    /app/schema-runtime/node_modules/.pnpm/@typescript+typescript-* \
    /app/schema-runtime/node_modules/typescript

# --- Production deps stage ---
FROM build-base AS prod-deps

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY patches/ patches/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/api/package.json packages/api/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/i18n-translate/package.json packages/i18n-translate/
COPY packages/locales/package.json packages/locales/
COPY packages/mailer/package.json packages/mailer/
COPY packages/queue/package.json packages/queue/
COPY packages/test-utils/package.json packages/test-utils/
COPY packages/ui/package.json packages/ui/

# Prisma schema + config needed for postinstall
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma

# Install prod deps for BOTH the server and the web app. The server bundle
# imports the built web SSR handler (apps/web/dist/server), which leaves `react`
# external — so web's runtime deps must be present in the image for SSR to load.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter=server... --filter=web...

# Strip the TypeScript compiler from the prod tree. It lands here only because
# pnpm materializes it as a resolved (optional, types-only) peer of runtime deps
# like @prisma/client, i18next, and @t3-oss/env-core — nothing imports it at
# runtime. The Prisma CLI's sole reference is a try/catch version probe that
# falls back to "unknown" (`prisma validate`/migration wrappers work without it; verified).
# TS 7 ships a platform-native Go binary whose embedded stdlib Trivy flags for
# fixable CVEs we cannot patch via pnpm — removing it eliminates that class and
# shrinks the image. Keep this block in BOTH Dockerfiles (AGENTS.md § keep in sync).
RUN rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/@typescript+typescript-* node_modules/typescript

# Probe the stock better-sqlite3 prebuilt (packaged in the npm tarball) + sqlite-vec.
COPY scripts/sqlite-native.mjs ./scripts/
RUN node scripts/sqlite-native.mjs apps/server

# --- Runner stage ---
# Hono API + SSR + SPA, plus guarded migrations and encrypted full-bundle
# backup/restore tooling. Server startup leads migrations; worker startup waits.
# The image ships no .env files; the orchestrator injects runtime values.
FROM base AS runner

COPY LICENSE NOTICE THIRD-PARTY-LICENSES.md /app/

# Smart HTTP must be present in the actual runtime stage.
RUN test -x "$(git --exec-path)/git-http-backend"

ENV NODE_ENV=production \
    KB_DATA_ROOT=/var/lib/knowledge-base \
    BACKUP_DIR=/app/backups
# Default Node heap cap so the server behaves predictably on small hosts.
# Deploy-time env always wins (`docker run -e NODE_OPTIONS=…` / the
# orchestrator's env panel). SSR + Prisma + request handling live on the V8
# heap, so 512 MB is the safe floor for the server; sharp's pixel buffers are
# native/off-heap and unaffected by this flag. Size the container's memory
# LIMIT ~25–50% above this cap to leave room for that native memory when using
# an external worker.
#
# Do not lower this from plan arithmetic alone. The tempting argument is a
# small plan with a 512 MB TOTAL memory limit, where a 512 MB heap cap lets
# V8 grow to the whole container before collecting hard and
# sharp's native allocations then push RSS into a platform OOM-kill instead of
# V8 back-pressure. True as far as it goes — but a lower cap does not lower
# actual demand. If SSR + Prisma + request handling genuinely need more than the
# lower number under load, the trade is a guaranteed heap OOM for a possible one.
# Measure the heap high-water mark under real SSR traffic first; if it does not
# sit comfortably under the proposed cap, the answer is a larger plan.
ENV NODE_OPTIONS="--max-old-space-size=512"
WORKDIR /app

# Copy workspace config (needed for pnpm --filter at runtime)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/

# Copy production node_modules. The two Prisma-bearing trees are
# --chown=node:node: the Prisma migration runner runs as USER node and
# materializes its schema engine into node_modules, so uid 1000 must own
# them. Done at COPY time (not a RUN chown) to avoid duplicating the layer.
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --chown=node:node --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
# web's node_modules: the server bundle dynamically imports apps/web/dist/server,
# whose SSR chunks resolve `react` (left external by the web build) from here.
COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules

# Copy committed migrations, fixtures, schema and config for runtime migration tooling.
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/prisma.config.ts ./packages/db/prisma.config.ts
# Copy generated Prisma client (built during deps stage)
COPY --from=builder /app/packages/db/prisma/generated ./packages/db/prisma/generated
# Root scripts and packages/db resolve the SAME deployed tooling closure.
COPY --chown=node:node --from=builder /app/schema-runtime/node_modules ./schema-runtime/node_modules
RUN rm -f /app/packages/db/node_modules/prisma /app/packages/db/node_modules/.bin/prisma \
  && mkdir -p /app/packages/db/node_modules/.bin /app/node_modules/@aws-sdk \
  && ln -s /app/schema-runtime/node_modules/.bin/prisma /app/packages/db/node_modules/.bin/prisma \
  && ln -s /app/schema-runtime/node_modules/prisma /app/packages/db/node_modules/prisma \
  && rm -f /app/node_modules/prisma /app/node_modules/pg /app/node_modules/dotenv /app/node_modules/@aws-sdk/client-s3 \
  && ln -s /app/schema-runtime/node_modules/prisma /app/node_modules/prisma \
  && ln -s /app/schema-runtime/node_modules/pg /app/node_modules/pg \
  && ln -s /app/schema-runtime/node_modules/dotenv /app/node_modules/dotenv \
  && ln -s /app/schema-runtime/node_modules/@aws-sdk/client-s3 /app/node_modules/@aws-sdk/client-s3

# Copy built server and web SPA
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/dist/git-pre-receive.mjs ./apps/server/dist/git-pre-receive.mjs
# Image-owned hook and its fixed core.hooksPath entry must be executable.
RUN test -x /app/apps/server/dist/git-pre-receive.mjs && test -x /app/apps/server/dist/hooks/pre-receive
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Migration and offline recovery retain native supervision and volume fences.
COPY --from=native /src/kb-supervisor /usr/local/bin/kb-supervisor
COPY --from=native /src/kb-child-guard /usr/local/bin/kb-child-guard
RUN test -x /usr/local/bin/kb-supervisor && test -x /usr/local/bin/kb-child-guard
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/init-kb-volumes.mjs ./scripts/
COPY scripts/backup.sh scripts/restore-archive.mjs scripts/upload-backup-to-s3.mjs scripts/backup-heartbeat.mjs ./scripts/
COPY scripts/db/ ./scripts/db/
COPY scripts/backup/ ./scripts/backup/
COPY scripts/lib/asset-storage-migration.mjs scripts/lib/asset-storage-control.mjs scripts/lib/kb-restore.mjs scripts/lib/asset-storage-domain.mjs scripts/lib/kb-backup.mjs scripts/lib/backup-identity.mjs scripts/lib/backup-s3-env.mjs scripts/lib/backup-env.sh scripts/lib/session-timezone.mjs scripts/lib/bounded-child.mjs scripts/lib/owned-child.sh scripts/lib/validate-kb-master-key.mjs ./scripts/lib/
COPY --from=age-tooling /opt/age/age /opt/age/age-keygen /usr/local/bin/
COPY --from=builder /app/restore-crypto.mjs ./restore-crypto.mjs
COPY --from=builder /app/asset-storage-domain.mjs ./asset-storage-domain.mjs
COPY --from=builder /app/asset-storage-admission.mjs ./asset-storage-admission.mjs
RUN chmod +x /usr/local/bin/docker-entrypoint.sh ./scripts/backup.sh ./scripts/backup/*.sh \
  && mkdir -p /app/backups \
  && chown node:node /app/backups \
  && node --input-type=module -e 'import {createRequire} from "node:module"; const r=createRequire(import.meta.url); for(const p of ["prisma/config","pg","dotenv","@aws-sdk/client-s3"]) r.resolve(p); const d=await import("./asset-storage-domain.mjs"); if(typeof d.createOfflineAssetVerifier!=="function") throw Error("Offline asset artifact incomplete");'

# KB data-volume skeleton (UID/GID 1000 root; repos/, assets/, models/,
# index/; private dirs; fence files). Docker
# copies a mount point's image contents and ownership into an EMPTY named
# volume on first mount, so fresh volumes arrive nonroot-owned without a root
# init container. Bind mounts get no copy-up: provision those on the host.
# Keep this block identical in Dockerfile and Dockerfile.worker:
# whichever image mounts a fresh volume first must leave
# the whole skeleton (scripts/init-kb-volumes.test.mjs asserts the RUN line).
RUN mkdir -p /var/lib/knowledge-base \
  && KB_RUNTIME_UID=1000 KB_RUNTIME_GID=1000 node scripts/init-kb-volumes.mjs

# Strip the global npm CLI from the runtime image. The server runs `node`
# directly (CMD) and the entrypoint invokes the COPY'd prisma binary by path
# (not `npx`), so npm is never used at runtime. node:slim's bundled npm
# vendors its own dependency tree (e.g. picomatch) that Trivy flags as
# fixable HIGH CVEs we cannot patch via pnpm overrides — removing npm
# eliminates that whole class, shrinks the image, and cuts attack surface.
# Build stages keep npm; this only affects the final runner image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Drop privileges. The `node` user (uid 1000) ships in node:26-trixie-slim. The
# server only reads /app at runtime; the entrypoint's writes go to /tmp
# (private migration staging and full bundles in /app/backups) and to
# Postgres over the network, so no chown of /app is needed.
USER node

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]

EXPOSE 3000

# Dokploy uses the Docker healthcheck for rolling updates.
# Use Node's built-in fetch; node:slim does not ship curl or wget.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10800s --retries=3 \
  CMD node -e "const port=process.env.SERVER_PORT||process.env.PORT||3000;fetch('http://localhost:'+port+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Startup runs the migration runner before handing off to the output supervisor.
CMD ["node", "apps/server/dist/index.mjs", "--fenced"]
