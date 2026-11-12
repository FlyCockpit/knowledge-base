import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { generateDokployCompose, generateDokployConfig } from "./generate-dokploy-config.js";
import { validateAssetDumpIdentity } from "./lib/backup-s3-env.mjs";

const defaults = {
  environment: "development" as const,
  gitRef: "main",
  url: "https://dev.example.com",
};
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = (role: string) =>
  generateDokployConfig(defaults).applications.find((entry) => entry.name.endsWith(`-${role}`))!;
const service = (yaml: string, role: string) =>
  yaml
    .split(role === "server" ? /\n {2}[a-z0-9-]+-server:\n/ : `\n  ${role}:\n`)[1]!
    .split(/^ {2}[a-z][a-z-]*:\s*$/m)[0]!;

test("server leads migrations, worker waits, and optional scheduler shares the same source ref", () => {
  const config = generateDokployConfig(defaults);
  assert.deepEqual(
    config.applications.map((entry) => entry.name),
    [
      "knowledge-base-development-server",
      "knowledge-base-development-worker",
      "knowledge-base-development-backup",
    ],
  );
  assert.equal(app("server").environment.MIGRATE_ON_START, "true");
  assert.equal(app("worker").environment.MIGRATE_ON_START, "false");
  // Traefik is exactly one trusted proxy; only the HTTP server keys rate limits on it.
  assert.equal(app("server").environment.TRUST_PROXY_HOPS, "1");
  assert.equal(app("worker").environment.TRUST_PROXY_HOPS, undefined);
  assert.equal(app("backup").command, "backup-schedule");
  assert.equal(app("backup").optional, true);
  for (const entry of config.applications) {
    assert.equal(entry.autoDeploy, true);
    assert.equal(entry.customGitBranch, "main");
    assert.equal(entry.updateConfigSwarm.Order, "stop-first");
    assert.equal(entry.rollbackConfigSwarm.Order, "stop-first");
    assert.equal(entry.modeSwarm.Replicated.Replicas, 1);
    assert.ok(entry.placementSwarm.Constraints.includes("node.labels.knowledge-base == true"));
  }
  for (const role of ["server", "worker", "backup"]) {
    assert.ok(
      app(role).mounts.some(
        (mount) =>
          mount.target === "/var/lib/knowledge-base" && mount.mode === "rw" && mount.uid === 1000,
      ),
    );
  }
  for (const role of ["server", "backup"])
    assert.ok(app(role).mounts.some((mount) => mount.target === "/app/backups"));
  assert.equal(app("worker").domain, null);
  assert.equal(app("backup").domain, null);
  assert.deepEqual(app("worker").tmpfs, [
    "/run/kb-mirror:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700",
  ]);
  assert.match(config.rolloutContract, /300s/);
  assert.match(config.rolloutContract, /10800s/);
  assert.match(config.compose.acceptance, /deploy:check/);
  assert.match(config.compose.deeperVerification, /dokploy:verify/);
  assert.doesNotMatch(
    JSON.stringify(config),
    /APPLY_SCHEMA|WAIT_FOR_SCHEMA|DB_APPLIER|schema-apply|INDEX_BUILDER/,
  );
  for (const value of Object.values(config.environmentVariablesToSetOnce))
    assert.ok(!value.includes("${{"));
});

test("project prefixes all global resources and only server joins the selected proxy network", () => {
  for (const environment of ["development", "production"] as const) {
    const opts = {
      ...defaults,
      environment,
      gitRef: environment === "development" ? "main" : `release/${"a".repeat(40)}`,
    };
    const config = generateDokployConfig(opts);
    assert.equal(config.project, `knowledge-base-${environment}`);
    assert.equal(config.database.name, `${config.project}-postgres`);
    assert.equal(config.redis.name, `${config.project}-redis`);
  }
  const opts = { ...defaults, project: "kb-team-b", proxyNetwork: "shared.proxy_net" };
  const config = generateDokployConfig(opts);
  const yaml = generateDokployCompose(opts);
  assert.match(yaml, /^name: kb-team-b$/m);
  assert.match(yaml, /name: shared\.proxy_net/);
  for (const entry of config.applications) {
    assert.ok(entry.name.startsWith("kb-team-b-"));
    for (const mount of entry.mounts) assert.ok(mount.source.startsWith("kb-team-b-"));
  }
  assert.doesNotMatch(
    yaml,
    /^ {2}server:$/m,
    "Compose service key is an automatic proxy DNS alias",
  );
  const server = service(yaml, "server");
  assert.ok(server.includes("io.knowledge-base.role=server"));
  for (const label of [
    "traefik.docker.network=shared.proxy_net",
    "traefik.http.routers.kb-team-b-server.service=kb-team-b-server",
    "traefik.http.services.kb-team-b-server.loadbalancer.server.port=3000",
    "traefik.http.middlewares.kb-team-b-server-compress.compress=true",
    "traefik.http.routers.kb-team-b-server.rule=Host(`dev.example.com`)",
  ])
    assert.ok(server.includes(label), label);
  assert.match(server, /aliases: \["kb-team-b-server"\]/);
  for (const role of ["postgres", "redis", "worker", "backup", "asset-operator"])
    assert.doesNotMatch(service(yaml, role), /proxy:|traefik/);
  assert.doesNotMatch(yaml, /^\s*(ports|container_name):/m);
  assert.doesNotMatch(yaml, /schema-apply|db-applier|APPLY_SCHEMA|WAIT_FOR_SCHEMA/);
  const second = generateDokployCompose({ ...opts, project: "kb-team-c" });
  assert.ok(!second.includes("kb-team-b"));
  assert.ok(second.includes("name: shared.proxy_net"));
});

test("both public generator APIs validate refs, project, network and URL before interpolation", () => {
  for (const generate of [generateDokployConfig, generateDokployCompose]) {
    for (const project of ["", "bad_name", "A", "a\nb", "a: b", `\${BAD}`, "x".repeat(57)])
      assert.throws(() => generate({ ...defaults, project }), /Project/);
    for (const proxyNetwork of ["", "-bad", "space name", "x\ny", 'quote"', `\${BAD}`])
      assert.throws(() => generate({ ...defaults, proxyNetwork }), /Proxy network/);
    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com/path",
      "https://example.com?q=1",
      "https://example.com/#x",
      "https://example.com:444",
      "https://exa`mple.com",
      "https://exa$mple.com",
      "https://exa_mple.com",
    ])
      assert.throws(() => generate({ ...defaults, url }), /URL|HTTPS/);
    assert.throws(() => generate({ ...defaults, environment: "production" }), /immutable/);
    assert.throws(() => generate({ ...defaults, gitRef: "other" }), /main/);
    assert.throws(() => generate({ ...defaults, ...{ topology: "app-applier" } }), /removed/);
  }
  const config = generateDokployConfig({
    ...defaults,
    environment: "production",
    gitRef: `release/${"a".repeat(40)}`,
    url: "https://example.com",
  });
  assert.ok(config.applications.every((entry) => !entry.autoDeploy));
  assert.equal(app("server").environment.BETTER_AUTH_URL, defaults.url);
});

test("backup settings reach the leader and scheduler; SMTP and monitor keys reach worker", () => {
  for (const role of ["server", "backup"]) {
    for (const key of [
      "BACKUP_AGE_RECIPIENT",
      "BACKUP_S3_BUCKET",
      "BACKUP_S3_ACCESS_KEY_ID",
      "BACKUP_S3_SECRET_ACCESS_KEY",
      "KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY",
    ])
      assert.equal(app(role).environment[key], `\${{environment.${key}}}`);
  }
  for (const role of ["server", "worker"]) {
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"])
      assert.equal(app(role).environment[key], `\${{environment.${key}}}`);
    assert.equal(app(role).environment.KB_MASTER_KEY, `\${{environment.KB_MASTER_KEY}}`);
  }
  for (const key of [
    "BACKUP_S3_SECRET_ACCESS_KEY",
    "KB_ASSET_S3_SECRET_ACCESS_KEY",
    "KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY",
    "BETTER_AUTH_SECRET",
  ])
    assert.ok(!(key in app("worker").environment));
  assert.ok(app("worker").environment.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY);
  const config = generateDokployConfig(defaults);
  for (const optional of Object.values(config.optionalEnvironmentKeys)) {
    assert.ok(optional.includes("OPENROUTER_API_KEY"));
    assert.ok(!optional.includes("KB_INSTANCE_ID"));
  }
  for (const role of Object.values(config.assetStorageRoles).filter(
    (value) => typeof value === "object",
  )) {
    assert.equal(
      role.KB_ASSET_S3_ACCESS_KEY_ID,
      app("server").environment.KB_ASSET_S3_ACCESS_KEY_ID,
    );
    assert.ok(role.KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID);
    assert.ok(!("KB_ASSET_S3_SECRET_ACCESS_KEY" in role));
    assert.throws(
      () =>
        validateAssetDumpIdentity({
          KB_ASSET_S3_ENABLED: "true",
          KB_ASSET_S3_ACCESS_KEY_ID: "writer",
          KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "operator",
          BACKUP_S3_ACCESS_KEY_ID: "writer",
        }),
      /differ from both/,
    );
  }
});

test("Compose shares data and backup volumes, reuses server build and keeps secrets unset", () => {
  const yaml = generateDokployCompose(defaults);
  for (const role of ["server", "backup"]) {
    const block = service(yaml, role);
    assert.match(block, /kb-data:\/var\/lib\/knowledge-base/);
    assert.match(block, /backups:\/app\/backups/);
    assert.match(block, /image: knowledge-base-development-server/);
  }
  assert.match(service(yaml, "backup"), /build: \*server-build/);
  assert.match(service(yaml, "backup"), /command: \["backup-schedule"\]/);
  assert.match(service(yaml, "backup"), /BACKUP_SCHEDULE: "\$\{BACKUP_SCHEDULE:-off\}"/);
  assert.match(service(yaml, "backup"), /schedule\.mjs", "health"/);
  assert.match(service(yaml, "server"), /MIGRATE_ON_START: "true"/);
  assert.match(service(yaml, "worker"), /MIGRATE_ON_START: "false"/);
  assert.match(service(yaml, "server"), /stop_grace_period: 100s/);
  assert.match(yaml, /order: stop-first/);
  assert.match(yaml, /failure_action: rollback/);
  assert.match(yaml, /postgres:18\.6-trixie@sha256:/);
  assert.match(yaml, /valkey\/valkey:9\.1\.3-trixie@sha256:/);
  assert.match(yaml, /--maxmemory-policy", "noeviction"/);
  assert.match(yaml, /postgres-data:\/var\/lib\/postgresql\n/);
  assert.match(yaml, /pg_isready -U \$\$\{POSTGRES_USER\}/);
  for (const match of yaml.matchAll(
    /\$\{([A-Z0-9_]*(?:SECRET|PASSWORD|PASS)[A-Z0-9_]*):-([^}]*)\}/g,
  ))
    assert.equal(match[2], "", match[1] ?? "secret default");
  const config = generateDokployConfig(defaults);
  assert.deepEqual(config.compose.environmentVariables.postgres, ["POSTGRES_PASSWORD"]);
  assert.ok(config.compose.environmentVariables.server?.includes("BACKUP_AGE_RECIPIENT"));
  assert.ok(config.compose.environmentVariables.worker?.includes("SMTP_HOST"));
  assert.ok(config.compose.environmentVariables.backup?.includes("BACKUP_AGE_RECIPIENT"));
});

test("images retain guards, pins, native embedding, notices and the deployed tooling closure", () => {
  for (const file of ["Dockerfile", "Dockerfile.worker"]) {
    const source = read(file);
    assert.match(
      source,
      /--filter @knowledge-base\/db --config\.inject-workspace-packages=true\s+\\\s+--config\.package-import-method=copy deploy --prod \/app\/schema-runtime/,
    );
    assert.match(
      source,
      /COPY --chown=node:node --from=builder \/app\/schema-runtime\/node_modules/,
    );
    for (const dependency of ["prisma", "pg", "dotenv", "@aws-sdk/client-s3"])
      assert.ok(
        source.includes(
          `/app/schema-runtime/node_modules/${dependency} /app/node_modules/${dependency}`,
        ),
      );
    assert.match(source, /COPY scripts\/db\/ \.\/scripts\/db\//);
    assert.match(source, /COPY scripts\/backup\/ \.\/scripts\/backup\//);
    assert.match(
      source,
      /COPY --from=native \/src\/kb-child-guard \/usr\/local\/bin\/kb-child-guard/,
    );
    assert.match(
      source,
      /COPY --from=native \/src\/kb-supervisor \/usr\/local\/bin\/kb-supervisor/,
    );
    assert.match(source, /gcc -std=c11 -Wall -Wextra -Werror/);
    assert.match(source, /ARG PG_MAJOR=18/);
    assert.match(source, /age --version \| grep -Fx v1\.3\.2/);
    assert.match(source, /LICENSE NOTICE THIRD-PARTY-LICENSES\.md/);
    assert.match(source, /^USER node$/m);
    assert.match(source, /--start-period=10800s/);
    assert.match(
      source,
      /node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc/,
    );
    assert.doesNotMatch(source, /db-applier|APPLY_SCHEMA|WAIT_FOR_SCHEMA|prisma\s+db\s+push/);
    assert.doesNotMatch(source, /COPY .*gguf/i);
  }
  assert.match(
    read("Dockerfile"),
    /node scripts\/build-commit\.mjs \. > apps\/server\/dist\/BUILD_COMMIT/,
  );
  assert.match(read("Dockerfile.worker"), /source-built pinned embedding addon/);
  for (const entry of [
    "!.git/HEAD",
    "!.git/packed-refs",
    "!.git/refs/heads/**",
    "**/.env.*",
    "backups",
    "*.gguf",
    "apps/server/native/kb-supervisor",
  ])
    assert.ok(read(".dockerignore").split("\n").includes(entry), entry);
});

// Exercise the real dispatcher against inert scripts in a private directory.
// No database, network, runtime mount or production secret is involved.
test("entrypoint dispatches one-shots without registry identity and runtime apply/wait share a fresh UUID", () => {
  const root = mkdtempSync(join(tmpdir(), "kb-entrypoint-"));
  try {
    const audit = join(root, "calls.jsonl");
    const fixture = `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ file:process.argv[1], args:process.argv.slice(2), id:process.env.KB_INSTANCE_ID ?? null, writer:process.env.KB_ASSET_S3_SECRET_ACCESS_KEY ?? null, operator:!!process.env.KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY, operatorId:!!process.env.KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID, backup:!!process.env.BACKUP_S3_SECRET_ACCESS_KEY, backupId:!!process.env.BACKUP_S3_ACCESS_KEY_ID, heartbeat:!!process.env.BACKUP_HEARTBEAT_URL, monitor:!!process.env.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY })+'\\n'); if(process.argv[1].includes('/scripts/db/') && process.env.TEST_FAIL_RUNNER) process.exit(17);`;
    for (const relative of [
      "scripts/db/migrate-runtime.mjs",
      "scripts/backup/schedule.mjs",
      "scripts/backup/drill.mjs",
      "scripts/lib/asset-storage-migration.mjs",
      "apps/server/dist/index.mjs",
      "apps/worker/dist/index.mjs",
    ]) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, fixture);
    }
    for (const name of ["pre-migrate", "restore"])
      writeFileSync(
        join(root, `scripts/backup/${name}.sh`),
        `exec node '${join(root, "scripts/backup/drill.mjs")}' "$@"\n`,
      );
    writeFileSync(join(root, "scripts/lib/validate-kb-master-key.mjs"), "");
    writeFileSync(join(root, "scripts/init-kb-volumes.mjs"), "");
    const shell = join(root, "entrypoint.sh");
    writeFileSync(shell, read("scripts/docker-entrypoint.sh").replaceAll("/app/", `${root}/`));
    const env = {
      PATH: process.env.PATH,
      DATABASE_URL: "fixture",
      REDIS_URL: "fixture",
      BETTER_AUTH_SECRET: "fixture",
      KB_INSTANCE_ID: "inherited-id",
      KB_ASSET_S3_SECRET_ACCESS_KEY: "fixture-writer",
      KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "fixture",
      KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: "fixture",
      BACKUP_S3_ACCESS_KEY_ID: "fixture",
      BACKUP_S3_SECRET_ACCESS_KEY: "fixture",
      BACKUP_HEARTBEAT_URL: "https://fixture.invalid",
      BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "fixture",
    };
    for (const command of [
      "migrate",
      "hold-deletions",
      "backup",
      "backup-schedule",
      "restore",
      "restore-drill",
      "asset-storage",
    ])
      execFileSync("sh", [shell, command], { env });
    const calls = () =>
      readFileSync(audit, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.equal(calls().length, 7);
    for (const call of calls()) {
      assert.equal(call.id, null);
      assert.equal(call.writer, null);
      assert.equal(call.operator, true);
      assert.equal(call.backup, true);
      assert.equal(call.heartbeat, true);
    }
    assert.deepEqual(calls()[0].args, ["apply"]);
    assert.deepEqual(calls()[1].args, ["hold"]);
    assert.deepEqual(calls()[2].args, ["--label", "manual"]);
    assert.deepEqual(calls()[3].args, ["run"]);
    for (const role of ["server", "worker"])
      execFileSync("sh", [shell, "node", `apps/${role}/dist/index.mjs`, "--fenced"], {
        env,
        cwd: root,
      });
    const runtime = calls().slice(7);
    assert.deepEqual(runtime[0].args, ["apply", "--role", "server"]);
    assert.deepEqual(runtime[2].args, ["wait", "--role", "worker"]);
    assert.match(runtime[0].id, /^[a-f0-9-]{36}$/);
    assert.equal(runtime[0].id, runtime[1].id);
    assert.equal(runtime[2].id, runtime[3].id);
    assert.notEqual(runtime[0].id, runtime[2].id);
    assert.equal(runtime[0].writer, null);
    assert.equal(runtime[1].writer, "fixture-writer");
    assert.equal(runtime[3].writer, null);
    for (const call of [runtime[0], runtime[2]]) {
      assert.equal(call.operator, true, "startup child retains asset reader");
      assert.equal(call.backup, true, "startup child retains pre-migrate dump writer");
    }
    for (const call of [runtime[1], runtime[3]]) {
      for (const key of ["operator", "operatorId", "backup", "backupId", "heartbeat"])
        assert.equal(call[key], false, `runtime must strip ${key}`);
    }
    assert.equal(runtime[3].monitor, true, "worker retains ListBucket-only freshness key");
    assert.throws(() =>
      execFileSync("sh", [shell, "node", "apps/server/dist/index.mjs"], {
        env: { ...env, MIGRATE_ON_START: "invalid" },
        cwd: root,
        stdio: "pipe",
      }),
    );
    const before = calls().length;
    assert.throws(() =>
      execFileSync("sh", [shell, "node", "apps/server/dist/index.mjs"], {
        env: { ...env, TEST_FAIL_RUNNER: "1" },
        cwd: root,
        stdio: "pipe",
      }),
    );
    assert.equal(calls().length, before + 1, "refused migration must not launch the app");
    assert.throws(() =>
      execFileSync("sh", [shell, "migrate", "--role", "server"], { env, cwd: root, stdio: "pipe" }),
    );
    assert.equal(calls().length, before + 1, "one-shot migrate never accepts registration flags");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("container development retains the production worker security boundary", () => {
  const agent = readFileSync(new URL("../docker-compose.agent.yml", import.meta.url), "utf8");
  assert.match(agent, /node scripts\/build-embedding-runtime\.mjs .* --install/);
  const devImage = readFileSync(new URL("../Dockerfile.dev", import.meta.url), "utf8");
  for (const tool of ["g++", "cmake", "patch", "curl"])
    assert.ok(devImage.includes(`  ${tool} \\`), `native development build needs ${tool}`);
  for (const name of ["app-dev", "worker-dev"]) {
    const block = agent
      .split(new RegExp(`^  ${name}:[^\\n]*\\n`, "m"))[1]
      ?.split(/^ {2}[a-z][a-z-]*:[^\n]*\n/m)[0];
    assert.ok(block, name);
    assert.match(block, /KB_MASTER_KEY:/);
    // One read-write data volume everywhere (decision 19).
    assert.match(block, /^ {6}- kb-data:\/var\/lib\/knowledge-base$/m);
    assert.doesNotMatch(block, /kb-(repos|assets|models)|knowledge-base:ro/);
    if (name.startsWith("worker"))
      assert.match(block, /\/run\/kb-mirror:rw,noexec,nosuid,nodev,size=16m,uid=.*mode=0700/);
    if (name === "worker-dev") assert.match(block, /<<: \*dev-runtime/);
    else assert.match(block, /order: stop-first/);
  }
  for (const path of ["../docker-compose.agent.yml", "../docker-compose.dev.yml"]) {
    const file = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(file, /--maxmemory-policy.*noeviction/);
  }
});

test("CI inventories every non-model suite and retains real two-model architecture evidence", () => {
  for (const name of ["pr-checks", "main-checks"]) {
    const workflow = readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    );
    assert.match(workflow, /assertSuiteCoverage\(\)/);
    assert.match(workflow, /filter\(.*!config.qwenModel/);
    assert.match(workflow, /fromJSON\(needs.setup.outputs.kb-suites\)/);
    assert.match(workflow, /pnpm test:kb -- \$\{\{ matrix.suite \}\}/);
    assert.match(workflow, /RESULT.*needs.kb-integration.result/);
  }
  const model = readFileSync(
    new URL("../.github/workflows/kb-model-smoke.yml", import.meta.url),
    "utf8",
  );
  for (const required of [
    "arch: x64",
    "arch: arm64",
    "node-version: 26",
    "--check-evidence",
    "--check-gemma-evidence",
    "if-no-files-found: error",
  ])
    assert.ok(model.includes(required), required);
  const cli = readFileSync(new URL("../.github/workflows/cli-ci.yml", import.meta.url), "utf8");
  for (const path of [
    "apps/cli/**",
    "packages/api/src/lib/kb/protocol/**",
    "packages/api/src/lib/kb/fixtures/**",
  ])
    assert.equal(cli.split(`- "${path}"`).length - 1, 2, path);
});

test("two projects resolve private services through distinct private-network aliases", () => {
  for (const project of ["kb-team-a", "kb-team-b"]) {
    const yaml = generateDokployCompose({ ...defaults, project });
    for (const role of ["postgres", "redis"]) {
      const block = service(yaml, role);
      assert.match(block, new RegExp(`hostname: ${project}-${role}`));
      assert.ok(block.includes(`default:\n        aliases: ["${project}-${role}"]`));
      assert.doesNotMatch(block, /proxy:/);
    }
    for (const role of ["server", "worker", "backup", "asset-operator"]) {
      const block = service(yaml, role);
      assert.ok(block.includes(`@${project}-postgres:5432/`));
      if (role === "server" || role === "worker")
        assert.ok(block.includes(`@${project}-redis:6379`));
      assert.doesNotMatch(block, /@(?:postgres|redis):/);
    }
    const other = project === "kb-team-a" ? "kb-team-b" : "kb-team-a";
    assert.ok(!yaml.includes(`@${other}-`));
  }
});
