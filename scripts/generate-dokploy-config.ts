/** Generate a reviewable native-Git setup. No network or credential reads. */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serverVars } from "../packages/env/src/vars/server.js";
import { sharedVars } from "../packages/env/src/vars/shared.js";
import { ENV_VARS } from "./lib/env-manifest.js";

type Options = {
  environment: "development" | "production";
  gitRef: string;
  url: string;
  project?: string;
  proxyNetwork?: string;
  backups?: boolean;
  /**
   * The repository Dokploy builds from. Set: every Compose build context is
   * the pinned Git context `<gitUrl>#<gitRef>`, so a pasted (raw) Dokploy
   * Compose builds without a source tree, and native applications get it as
   * `customGitUrl`. Unset: `context: .` (plain `docker compose` from a
   * checkout; the CLI's `--git-url local`).
   */
  gitUrl?: string;
};
/** The only keys native applications reference from Dokploy's environment. */
const SET_ONCE_KEYS = [
  "DATABASE_URL",
  "REDIS_URL",
  "KB_MASTER_KEY",
  "BETTER_AUTH_SECRET",
  "ADMIN_EMAIL",
] as const;
const keys = new Set(ENV_VARS.map((variable) => variable.key));
const sharedKeys = new Set(Object.keys(sharedVars));
const serverKeys = new Set([...sharedKeys, ...Object.keys(serverVars)]);
const kbDataRoot = "/var/lib/knowledge-base";
const backupRoot = "/app/backups";
const smtpKeys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"];
const backupKeys = [
  "BACKUP_ENABLED",
  "BACKUP_AGE_RECIPIENT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_REGION",
  "BACKUP_S3_PREFIX",
  "BACKUP_S3_FORCE_PATH_STYLE",
  "BACKUP_S3_SSE",
  "BACKUP_HEARTBEAT_URL",
];
const monitorKeys = [
  "BACKUP_ENABLED",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_REGION",
  "BACKUP_S3_PREFIX",
  "BACKUP_S3_FORCE_PATH_STYLE",
  "BACKUP_MAX_AGE_HOURS",
  "BACKUP_MONITOR_S3_ACCESS_KEY_ID",
  "BACKUP_MONITOR_S3_SECRET_ACCESS_KEY",
];
const assetLocationKeys = [
  "KB_ASSET_S3_ENABLED",
  "KB_ASSET_S3_BUCKET",
  "KB_ASSET_S3_ENDPOINT",
  "KB_ASSET_S3_REGION",
  "KB_ASSET_S3_PREFIX",
  "KB_ASSET_S3_FORCE_PATH_STYLE",
];
const assetComparisonKeys = ["KB_ASSET_S3_ACCESS_KEY_ID", "KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID"];
const assetRoleKeys = {
  server: [
    ...assetLocationKeys,
    "KB_ASSET_CACHE_MAX_BYTES",
    "KB_ASSET_S3_ACCESS_KEY_ID",
    "KB_ASSET_S3_SECRET_ACCESS_KEY",
  ],
  worker: [...assetLocationKeys, "KB_ASSET_CACHE_MAX_BYTES"],
  backup: [...assetLocationKeys, ...assetComparisonKeys, "KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY"],
  operator: [
    ...assetLocationKeys,
    ...assetComparisonKeys,
    "KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY",
    "KB_ASSET_CACHE_MAX_BYTES",
  ],
};

/**
 * A repository URL Docker can use as a Git build context: https://, ssh:// or
 * scp-like `user@host:path`. Never credentials (the file is pasted into
 * Dokploy and kept in its database), never a `#` (the ref is appended).
 */
export function assertGitUrl(gitUrl: string) {
  const fail = (why: string): never => {
    throw new Error(`--git-url ${why}`);
  };
  if (!gitUrl || /[\s#?"'`$\\]/.test(gitUrl))
    fail(
      "must be a repository URL without spaces, quotes, `$`, `\\`, a query (`?`) or `#` (the ref is appended).",
    );
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/]/.test(gitUrl)) return;
  let parsed: URL;
  try {
    parsed = new URL(gitUrl);
  } catch {
    return fail("must be https://…, ssh://… or git@host:owner/repo.git.");
  }
  if (
    !["https:", "ssh:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.pathname.length < 2
  )
    fail("must be https://…, ssh://… or git@host:owner/repo.git.");
  if (parsed.password || (parsed.protocol === "https:" && parsed.username))
    fail(
      "must not contain credentials: the generated file is pasted into Dokploy. Use a public URL, or an SSH URL the Dokploy server's Docker can fetch.",
    );
  if (parsed.search || parsed.hash) fail("must not have a query or fragment.");
}

/**
 * `--git-url`: the repository each image builds from (`<url>#<git-ref>`).
 * Absent: the checkout's `origin` remote. `local`: `context: .` (plain
 * `docker compose` from a checkout, never a pasted Dokploy Compose).
 */
export function resolveGitUrl(
  flag: string | undefined,
  origin: () => string | undefined,
): string | undefined {
  if (flag === "local") return undefined;
  if (flag !== undefined) return flag;
  const remote = origin()?.trim();
  if (!remote)
    throw new Error(
      "No --git-url and no `origin` remote: pass --git-url <repository URL> (what Dokploy builds from), or --git-url local for plain docker compose in a checkout.",
    );
  return remote;
}

/** All emitters use this validation, including direct Compose API callers. */
function validated(options: Options) {
  if (!["development", "production"].includes(options.environment))
    throw new Error("Choose development or production.");
  if (Object.hasOwn(options, "topology"))
    throw new Error("--topology was removed; server leads migrations and worker waits.");
  if (options.environment === "development" && options.gitRef !== "main")
    throw new Error("Development automatic deployment follows main.");
  if (options.environment === "production" && !/^release\/[a-f0-9]{40}$/.test(options.gitRef))
    throw new Error("Production requires an immutable release/<full-commit-sha> Git tag.");
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error("Invalid configuration URL.");
  }
  // A DNS hostname is also embedded in a Traefik rule and YAML. Refuse rule,
  // interpolation and quote syntax even if the WHATWG parser accepts it.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.port ||
    url.hostname.length > 253 ||
    !url.hostname.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    throw new Error(
      "URL must be an HTTPS origin with a DNS hostname, without credentials, port, query, or path.",
    );
  // Leave seven characters for the proxy-facing service DNS suffix.
  const project = options.project ?? `knowledge-base-${options.environment}`;
  if (!/^[a-z0-9][a-z0-9-]{0,55}$/.test(project))
    throw new Error(
      "Project must contain 1..56 lowercase letters, digits or hyphens, starting with a letter or digit.",
    );
  const proxyNetwork = options.proxyNetwork ?? "dokploy-network";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(proxyNetwork))
    throw new Error(
      "Proxy network must contain 1..128 letters, digits, dots, underscores or hyphens.",
    );
  if (options.gitUrl !== undefined) assertGitUrl(options.gitUrl);
  return { ...options, url, project, proxyNetwork };
}

/** A Compose build context: the pinned Git context, or `.`. */
const buildContext = (options: Options) =>
  options.gitUrl === undefined ? "." : JSON.stringify(`${options.gitUrl}#${options.gitRef}`);

const reference = (key: string) => {
  if (!keys.has(key)) throw new Error(`Environment manifest is missing ${key}.`);
  return `\${{environment.${key}}}`;
};
const refs = (names: string[]) => Object.fromEntries(names.map((name) => [name, reference(name)]));
const composeVar = (name: string, fallback = "") => `\${${name}:-${fallback}}`;
const defaults: Record<string, string> = {
  POSTGRES_USER: "knowledge_base",
  POSTGRES_DB: "knowledge_base",
  SMTP_PORT: "587",
  BACKUP_ENABLED: "false",
  BACKUP_SCHEDULE: "off",
  BACKUP_HOUR_UTC: "3",
  BACKUP_KEEP: "14",
  BACKUP_S3_REGION: "auto",
  BACKUP_S3_PREFIX: "database",
  BACKUP_S3_FORCE_PATH_STYLE: "false",
  KB_ASSET_S3_ENABLED: "false",
  KB_ASSET_S3_FORCE_PATH_STYLE: "false",
  SIGNUP_ENABLED: "false",
};
const interpolations = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, composeVar(name, defaults[name])]));

function environments(compose: boolean, project: string) {
  const values = compose ? interpolations : refs;
  const runtime = compose
    ? {
        DATABASE_URL: `postgresql://\${POSTGRES_USER:-knowledge_base}:\${POSTGRES_PASSWORD:-}@${project}-postgres:5432/\${POSTGRES_DB:-knowledge_base}`,
        REDIS_URL: `redis://:\${REDIS_PASSWORD:-}@${project}-redis:6379`,
      }
    : { DATABASE_URL: reference("DATABASE_URL"), REDIS_URL: reference("REDIS_URL") };
  return {
    postgres: interpolations(["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]),
    redis: interpolations(["REDIS_PASSWORD"]),
    server: {
      ...runtime,
      ...values(assetRoleKeys.server),
      // Startup migration children require a read-only asset operator and dump
      // writer. The entrypoint strips both pairs before the HTTP runtime exec.
      ...values(assetRoleKeys.backup),
      ...values(backupKeys),
      ...values(smtpKeys),
      ...values([
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_URL",
        "ADMIN_EMAIL",
        "SIGNUP_ENABLED",
        "KB_MASTER_KEY",
      ]),
      NODE_ENV: "production",
      KB_DATA_ROOT: kbDataRoot,
      BACKUP_DIR: backupRoot,
      MIGRATE_ON_START: "true",
      // Dokploy's Traefik is the one proxy in front of the server; it appends
      // the client address to X-Forwarded-For. Add one per extra proxy (e.g.
      // Cloudflare in front of Traefik is 2). See apps/server/src/client-ip.ts.
      TRUST_PROXY_HOPS: "1",
    },
    worker: {
      ...runtime,
      ...values(assetRoleKeys.worker),
      ...values(smtpKeys),
      ...values(monitorKeys),
      ...values(["KB_MASTER_KEY"]),
      NODE_ENV: "production",
      KB_DATA_ROOT: kbDataRoot,
      MIGRATE_ON_START: "false",
    },
    backup: {
      DATABASE_URL: runtime.DATABASE_URL,
      ...values(assetRoleKeys.backup),
      ...values(backupKeys),
      ...values(["BACKUP_SCHEDULE", "BACKUP_HOUR_UTC", "BACKUP_KEEP"]),
      NODE_ENV: "production",
      KB_DATA_ROOT: kbDataRoot,
      BACKUP_DIR: backupRoot,
    },
    "asset-operator": {
      DATABASE_URL: runtime.DATABASE_URL,
      ...values(assetRoleKeys.operator),
      KB_DATA_ROOT: kbDataRoot,
    },
  };
}

/**
 * A native application's environment: the set-once keys stay Dokploy
 * references, fixed values stay, a key with a default gets it literally, and
 * every other key is left out (listed in optionalEnvironmentKeys), matching
 * the Compose path where only the set-once keys have to be set.
 */
function nativeEnvironment(entries: Record<string, string>) {
  const environment: Record<string, string> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value !== `\${{environment.${key}}}`) environment[key] = value;
    else if ((SET_ONCE_KEYS as readonly string[]).includes(key)) environment[key] = value;
    else if (Object.hasOwn(defaults, key)) environment[key] = defaults[key]!;
    else omitted.push(key);
  }
  return { environment, omitted };
}

export function generateDokployConfig(options: Options) {
  const { url, project, proxyNetwork } = validated(options);
  const env = environments(false, project);
  const native = {
    server: nativeEnvironment({ ...env.server, BETTER_AUTH_URL: url.origin }),
    worker: nativeEnvironment(env.worker),
    backup: nativeEnvironment(env.backup),
  };
  const dataMount = {
    source: `${project}-kb-data`,
    target: kbDataRoot,
    mode: "rw",
    uid: 1000,
    gid: 1000,
  };
  const backupMount = {
    source: `${project}-backups`,
    target: backupRoot,
    mode: "rw",
    uid: 1000,
    gid: 1000,
  };
  const application = (
    role: "server" | "worker" | "backup",
    environment: Record<string, string>,
  ) => ({
    name: `${project}-${role}`,
    sourceType: "git",
    customGitUrl:
      options.gitUrl ?? "<your repository URL; configure its Git credentials in Dokploy>",
    customGitBranch: options.gitRef,
    autoDeploy: options.environment === "development",
    buildType: "dockerfile",
    dockerfile: role === "worker" ? "Dockerfile.worker" : "Dockerfile",
    dockerContextPath: ".",
    createEnvFile: false,
    command: role === "backup" ? "backup-schedule" : null,
    modeSwarm: { Replicated: { Replicas: 1 } },
    restartPolicySwarm: { Condition: "any" },
    updateConfigSwarm: { Parallelism: 1, Order: "stop-first", FailureAction: "rollback" },
    rollbackConfigSwarm: { Parallelism: 1, Order: "stop-first" },
    // Matches the Compose stop_grace_period: server and backup 100s (a stop
    // during an upload waits for its cleanup and the snapshot child), worker 30s.
    stopGracePeriodSwarm: role === "worker" ? 30_000_000_000 : 100_000_000_000,
    placementSwarm: { Constraints: ["node.labels.knowledge-base == true"] },
    tmpfs:
      role === "worker"
        ? ["/run/kb-mirror:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700"]
        : [],
    environment,
    mounts: role === "worker" || !options.backups ? [dataMount] : [dataMount, backupMount],
    domain: role === "server" ? { host: url.hostname, port: 3000, https: true } : null,
    optional: role === "backup",
  });
  const applications = [
    application("server", native.server.environment),
    application("worker", native.worker.environment),
    ...(options.backups ? [application("backup", native.backup.environment)] : []),
  ];
  const required = [
    ...new Set(
      applications.flatMap((app) =>
        Object.values(app.environment).flatMap((value) => {
          const match = /^\$\{\{environment\.([A-Z0-9_]+)\}\}$/.exec(value);
          return match ? [match[1]!] : [];
        }),
      ),
    ),
  ];
  const excluded =
    /^(KB_ASSET_S3_OPERATOR_|KB_INSTANCE_ID$|BACKUP_S3_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)$|MIGRATE_ON_START$)/;
  const optionalFor = (allowed: Set<string>, mapped: Record<string, string>) =>
    ENV_VARS.filter(
      (variable) =>
        allowed.has(variable.key) &&
        !Object.hasOwn(mapped, variable.key) &&
        !excluded.test(variable.key) &&
        !variable.key.startsWith("KB_ASSET_"),
    ).map((variable) => variable.key);
  const composeEnv = environments(true, project);
  return {
    format: "Dokploy settings checklist; not an import or API payload",
    environment: options.environment,
    project,
    proxyNetwork,
    database: { name: `${project}-postgres`, sharedWithOtherEnvironments: false },
    redis: {
      name: `${project}-redis`,
      sharedWithOtherEnvironments: false,
      maxmemoryPolicy: "noeviction",
    },
    environmentVariablesToSetOnce: Object.fromEntries(
      required
        .filter((key) =>
          [
            "DATABASE_URL",
            "REDIS_URL",
            "KB_MASTER_KEY",
            "BETTER_AUTH_SECRET",
            "ADMIN_EMAIL",
          ].includes(key),
        )
        .map((key) => [
          key,
          `<set ${key} for ${options.environment}; complete literal value, no nested references>`,
        ]),
    ),
    applications,
    // Add a key to that application's environment only to opt in (SMTP,
    // backups, S3 asset authority, providers); each role lists only what it
    // may receive.
    optionalEnvironmentKeys: {
      server: [...native.server.omitted, ...optionalFor(serverKeys, env.server)],
      worker: [...native.worker.omitted, ...optionalFor(sharedKeys, env.worker)],
      ...(options.backups ? { backup: native.backup.omitted } : {}),
    },
    compose: {
      file: "docker-compose.dokploy.yml",
      topology: "server-led migrations + dedicated worker + optional encrypted backup service",
      buildContext:
        options.gitUrl === undefined
          ? "local (`context: .`): only for plain `docker compose` in a checkout. A pasted Dokploy Compose has no source tree; regenerate with --git-url <repository URL> for Dokploy."
          : `${options.gitUrl}#${options.gitRef}: every deploy builds ${options.gitRef} from the repository, so the pasted Compose needs no source tree. The Dokploy server's Docker fetches the URL itself (an SSH URL needs that Docker's SSH access).`,
      import:
        options.gitUrl === undefined
          ? "Not for a pasted Dokploy Compose: regenerate with --git-url. Plain docker compose in a checkout: set complete literal environment values."
          : "Paste the generated Compose into Dokploy (raw; it builds from the pinned Git context, so no repository connection is needed), then set complete literal environment values.",
      environmentVariables: Object.fromEntries(
        Object.entries(composeEnv).map(([service, entries]) => [
          service,
          [
            ...new Set(
              Object.values(entries).flatMap((value) =>
                [...value.matchAll(/\$\{([A-Z0-9_]+):-\}/g)].map((match) => match[1]!),
              ),
            ),
          ].sort(),
        ]),
      ),
      acceptance: `pnpm deploy:check ${url.origin} --commit <deployed-sha>`,
      deeperVerification: `pnpm dokploy:verify --server ${project}-server --worker ${project}-worker --url ${url.origin}`,
    },
    assetStorageRoles: {
      schemaLeader: assetRoleKeys.backup,
      scheduledBackup: assetRoleKeys.backup,
      offlineOperator: assetRoleKeys.operator,
      note: "Asset S3 defaults OFF. Runtime writer secret only on server; entrypoint removes it from migration/backup/offline children. Full bundles need the read-only operator pair and both comparison IDs. Entrypoint strips the operator pair, backup writer pair and heartbeat URL before runtime exec, after the pre-migrate bundle. Offline storage migration needs its own reviewed operator grants. Worker gets location/cache only; never give it asset writer/operator or backup writer secrets.",
    },
    backupOptIn:
      "Backups default off; migrations and due deletions proceed without backup storage. To enable, regenerate with --backups true, set BACKUP_ENABLED=true and BACKUP_AGE_RECIPIENT, and use the shared node-writable backups volume. Enabled backup failures block mutation. Set BACKUP_SCHEDULE=daily on exactly one backup service (default off), BACKUP_HOUR_UTC (default 3) and BACKUP_KEEP (default 14). S3 and separate monitor credentials are optional off-site coverage.",
    volumeInit:
      "Label exactly one local-disk host knowledge-base=true. All roles use that host. Fresh named volumes copy UID/GID 1000 skeletons from images; bind roots must be pre-owned 1000:1000. Server/worker share kb-data read-write; server/backup share backups only with --backups true. A compromised worker can modify Git/CAS bytes. Worker gets private /run/kb-mirror tmpfs. Manual resources use the project prefix; Compose volumes use its project scope.",
    rolloutContract:
      "Use stop-first replacement; native supervisors keep lifetime volume fences and drain descendants. One-shots never register runtime instances. Image startup health grace is 10800s for full bundles and migrations. Worker wait expires at 300s and exits; restart policy retries while server finishes its bundle. If retries stop, redeploy/restart the worker after server migrations complete. Never shorten health grace to the worker wait. Run deploy:check for the selected commit; dokploy:verify is optional deeper inspection on the VPS.",
    releaseContract:
      options.environment === "development"
        ? "Follow main for every role; adjacent queue payloads must stay compatible."
        : "Disable automatic deployment, select the same immutable release tag for every role, deploy server first, then worker, and run deploy:check.",
  };
}

export function generateDokployCompose(options: Options): string {
  const { url, project, proxyNetwork } = validated(options);
  const env = environments(true, project);
  const envLines = (entries: Record<string, string>) =>
    Object.entries(entries)
      .map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`)
      .join("\n");
  const router = `${project}-server`;
  const labels = [
    "io.knowledge-base.role=server",
    "traefik.enable=true",
    `traefik.docker.network=${proxyNetwork}`,
    `traefik.http.routers.${router}.rule=Host(\`${url.hostname}\`)`,
    `traefik.http.routers.${router}.entrypoints=websecure`,
    `traefik.http.routers.${router}.tls.certresolver=letsencrypt`,
    `traefik.http.routers.${router}.service=${router}`,
    `traefik.http.services.${router}.loadbalancer.server.port=3000`,
    `traefik.http.middlewares.${router}-compress.compress=true`,
    `traefik.http.middlewares.${router}-compress.compress.encodings=zstd,br,gzip`,
    `traefik.http.routers.${router}.middlewares=${router}-compress`,
  ];
  const placement = `      replicas: 1
      placement:
        constraints: ["node.labels.knowledge-base == true"]`;
  const runtimePolicy = `    deploy:
${placement}
      update_config:
        parallelism: 1
        order: stop-first
        failure_action: rollback
      rollback_config:
        parallelism: 1
        order: stop-first
      restart_policy:
        condition: any`;
  const depends = `    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy`;
  // Docker copies the image skeleton into an empty named volume when the first
  // container mounting it is created; concurrent creation races ("mkdir …: file
  // exists"). Create worker and backup only after the server has started.
  const afterServer = `
      ${router}:
        condition: service_started`;
  // A Git build context drops `.git` unless asked to keep it; the server image
  // reads its commit from `.git/HEAD` (scripts/build-commit.mjs) when
  // BUILD_VERSION is unset, so `/ready` and `pnpm deploy:check` can tell which
  // release is live. The worker image reads no commit.
  const keepGitDir =
    options.gitUrl === undefined
      ? ""
      : '\n        # Keep .git in the Git context: the build reads its commit from .git/HEAD.\n        BUILDKIT_CONTEXT_KEEP_GIT_DIR: "1"';
  const context = buildContext(options);
  return `# GENERATED by pnpm dokploy:config. Import into Dokploy; do not commit.
# Project: ${project}; repository ref: ${options.gitRef}; --git-url ${options.gitUrl ?? "local"}.
${
  options.gitUrl === undefined
    ? `# Build context: \`.\` (--git-url local), for plain docker compose in a checkout only;
# a pasted Dokploy Compose has no source tree, so regenerate with --git-url <repository URL>.`
    : `# Every image builds from the pinned Git context ${options.gitUrl}#${options.gitRef}:
# the Dokploy server's Docker fetches it, so a pasted Compose needs no source tree.`
}
# Only server joins the shared proxy network; no host ports are published.
# Server leads migrations; worker retries its 300s wait during long full bundles.
# Image health grace: 10800s. Acceptance: pnpm deploy:check ${url.origin} --commit <sha>
name: ${project}

services:
  postgres:
    image: postgres:18.6-trixie@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42
    restart: unless-stopped
    hostname: ${project}-postgres
    networks:
      default:
        aliases: ["${project}-postgres"]
    environment:
${envLines(env.postgres)}
    volumes:
      - postgres-data:/var/lib/postgresql
    deploy:
${placement}
    healthcheck:
      test: pg_isready -U $\${POSTGRES_USER} -d $\${POSTGRES_DB}
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: valkey/valkey:9.1.3-trixie@sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7
    restart: unless-stopped
    hostname: ${project}-redis
    networks:
      default:
        aliases: ["${project}-redis"]
    command: ["valkey-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction", "--requirepass", "\${REDIS_PASSWORD:-}"]
    environment:
${envLines(env.redis)}
    volumes:
      - redis-data:/data
    deploy:
${placement}
    healthcheck:
      test: valkey-cli --no-auth-warning -a "$\${REDIS_PASSWORD}" ping
      interval: 10s
      timeout: 5s
      retries: 5

  ${router}:
    image: ${project}-server
    build: &server-build
      context: ${context}
      dockerfile: Dockerfile
      args:
        BUILD_VERSION: \${BUILD_VERSION:-}${keepGitDir}
    restart: unless-stopped
    stop_grace_period: 100s
${depends}
    environment:
${envLines({ ...env.server, BETTER_AUTH_URL: url.origin })}
    volumes:
      - kb-data:${kbDataRoot}
${options.backups ? `      - backups:${backupRoot}\n` : ""}    labels:
${labels.map((label) => `      - ${JSON.stringify(label)}`).join("\n")}
    networks:
      default:
      proxy:
        aliases: ["${router}"]
${runtimePolicy}

  worker:
    build:
      context: ${context}
      dockerfile: Dockerfile.worker
    restart: unless-stopped
    stop_grace_period: 30s
${depends}${afterServer}
    environment:
${envLines(env.worker)}
    volumes:
      - kb-data:${kbDataRoot}
    tmpfs:
      - /run/kb-mirror:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700
${runtimePolicy}

${
  options.backups
    ? `  # Opt-in scheduler: idles while BACKUP_SCHEDULE=off (default).
  # Enable daily on exactly one service. It never takes a runtime lifetime fence.
  backup:
    image: ${project}-server
    build: *server-build
    command: ["backup-schedule"]
    restart: unless-stopped
    stop_grace_period: 100s
    depends_on:
      postgres:
        condition: service_healthy${afterServer}
    environment:
${envLines(env.backup)}
    volumes:
      - kb-data:${kbDataRoot}
      - backups:${backupRoot}
    healthcheck:
      test: ["CMD", "node", "scripts/backup/schedule.mjs", "health"]
      interval: 60s
      timeout: 10s
      start_period: 360s
${runtimePolicy}

`
    : ""
}  # Offline operator: stop server and worker first; keep this on the same host.
  asset-operator:
    image: ${project}-server
    build: *server-build
    profiles: ["offline"]
    command: ["asset-storage", "status"]
    restart: "no"
    healthcheck:
      disable: true
    environment:
${envLines(env["asset-operator"])}
    volumes:
      - kb-data:${kbDataRoot}
    deploy:
${placement}
      restart_policy:
        condition: none

volumes:
  postgres-data:
  redis-data:
  kb-data:
${options.backups ? "  backups:\n" : ""}
networks:
  proxy:
    name: ${proxyNetwork}
    external: true
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const fields: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (
        !key ||
        ![
          "--environment",
          "--git-ref",
          "--url",
          "--project",
          "--proxy-network",
          "--backups",
          "--git-url",
        ].includes(key) ||
        fields[key] ||
        !value ||
        value.startsWith("--")
      )
        throw new Error(
          "Use --environment development|production --git-ref <ref> --url <https-origin> [--git-url <repository URL, default the origin remote>|local] [--project <name>] [--proxy-network <name>] [--backups true|false].",
        );
      fields[key] = value;
    }
    if (!fields["--environment"] || !fields["--git-ref"] || !fields["--url"])
      throw new Error("--environment, --git-ref, and --url are required.");
    if (fields["--backups"] && !["true", "false"].includes(fields["--backups"]))
      throw new Error("--backups must be true or false.");
    const gitUrl = resolveGitUrl(fields["--git-url"], () => {
      const remote = spawnSync("git", ["remote", "get-url", "origin"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
      });
      return remote.status === 0 ? remote.stdout : undefined;
    });
    const options = {
      backups: fields["--backups"] === "true",
      gitUrl,
      environment: fields["--environment"],
      gitRef: fields["--git-ref"],
      url: fields["--url"],
      project: fields["--project"],
      proxyNetwork: fields["--proxy-network"],
    } as Options;
    const config = generateDokployConfig(options);
    const composePath = fileURLToPath(new URL("../docker-compose.dokploy.yml", import.meta.url));
    writeFileSync(composePath, generateDokployCompose(options));
    console.error(
      `[dokploy] wrote ${relative(process.cwd(), composePath)} — import in Dokploy and complete the environment checklist.`,
    );
    console.log(JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid configuration.");
    process.exitCode = 1;
  }
}
