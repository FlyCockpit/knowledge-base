import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The entrypoint's backups notice / check (`--startup-notice`) and the
// destination rule every enabled backup shares (scripts/backup.sh): a volume
// mounted at BACKUP_DIR, or BACKUP_S3_BUCKET. The image's own /app/backups
// without a mount lives in the container's writable layer and does not count.
// No database: psql / pg_dump stubs fail loudly if anything reaches them.
const hook = fileURLToPath(new URL("./pre-migrate.sh", import.meta.url));
const backupScript = fileURLToPath(new URL("../backup.sh", import.meta.url));

function hasAge() {
  return spawnSync("age-keygen", ["--version"]).status === 0;
}
const needsAge = hasAge() ? {} : { skip: "needs age / age-keygen on PATH" };

function fixture(t, { mounted = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kb-pre-migrate-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const backups = join(root, "backups");
  mkdirSync(bin);
  mkdirSync(backups);
  for (const [name, body] of Object.entries({
    // A stand-in for util-linux mountpoint: BACKUP_DIR is (not) a mount.
    mountpoint: `#!/bin/sh\n[ "$1" = -q ] && [ "$2" = '${backups}' ] && exit ${mounted ? 0 : 1}\nexit 1\n`,
    psql: "#!/bin/sh\necho 'psql must not run' >&2\nexit 70\n",
    pg_dump: "#!/bin/sh\necho 'pg_dump must not run' >&2\nexit 70\n",
  })) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const run = (script, args, env = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        BACKUP_DIR: backups,
        ...env,
      },
    });
  return { root, backups, run };
}

function recipient(root) {
  const identity = join(root, "identity");
  execFileSync("age-keygen", ["-o", identity], { stdio: "pipe" });
  return execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
}

test("startup notice, backups off (default): one notice, exit 0, nothing written", (t) => {
  const f = fixture(t);
  for (const env of [{}, { BACKUP_ENABLED: "" }, { BACKUP_ENABLED: "false" }]) {
    const result = f.run(hook, ["--startup-notice"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.match(
      result.stderr,
      /^NOTICE: Backups are off \(BACKUP_ENABLED is false, the default\)\..*BACKUP_ENABLED=true.*docs\/backup-restore\.md/,
    );
    // How to enable, as the entrypoint test used to check on the server's stderr.
    assert.match(result.stderr, /BACKUP_ENABLED=true.*BACKUP_AGE_RECIPIENT.*BACKUP_DIR/);
    assert.match(result.stderr, /Dokploy generator: --backups true/);
    assert.deepEqual(readdirSync(f.backups), []);
  }
});

test("startup notice: BACKUP_ENABLED is strict", (t) => {
  const f = fixture(t);
  for (const value of ["TRUE", "1", "yes", " true"]) {
    const result = f.run(hook, ["--startup-notice"], { BACKUP_ENABLED: value });
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /BACKUP_ENABLED must be true or false/);
  }
});

test(
  "startup check, BACKUP_ENABLED=true: no recipient or no destination refuses; a mount or S3 passes",
  needsAge,
  (t) => {
    const unmounted = fixture(t);
    const key = recipient(unmounted.root);
    const on = { BACKUP_ENABLED: "true", BACKUP_AGE_RECIPIENT: key };

    // The image default without a volume: a directory, writable, but no mount.
    const noDestination = unmounted.run(hook, ["--startup-notice"], on);
    assert.equal(noDestination.status, 1);
    assert.match(
      noDestination.stderr,
      /no backup destination: BACKUP_DIR \(.*\) is not a mounted volume and BACKUP_S3_BUCKET is unset/,
    );

    const s3 = unmounted.run(hook, ["--startup-notice"], {
      ...on,
      BACKUP_S3_BUCKET: "fixture-bucket",
      BACKUP_S3_ACCESS_KEY_ID: "fixture-writer-id",
      BACKUP_S3_SECRET_ACCESS_KEY: "fixture-writer-secret",
      BACKUP_S3_REGION: "us-east-1",
    });
    assert.equal(s3.status, 0, s3.stderr);
    assert.match(s3.stdout, /Backup destination OK: .* and s3:\/\/fixture-bucket\./);
    assert.doesNotMatch(s3.stdout + s3.stderr, /fixture-writer-secret/);

    const mounted = fixture(t, { mounted: true });
    const noRecipient = mounted.run(hook, ["--startup-notice"], { BACKUP_ENABLED: "true" });
    assert.equal(noRecipient.status, 1);
    assert.match(noRecipient.stderr, /BACKUP_AGE_RECIPIENT is unset or not an age recipient/);

    const local = mounted.run(hook, ["--startup-notice"], on);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /Backup destination OK: encrypted bundles go to .*backups\.$/m);

    for (const f of [unmounted, mounted]) assert.deepEqual(readdirSync(f.backups), []);
  },
);

test(
  "every enabled backup refuses an unmounted BACKUP_DIR without S3, before any database access",
  needsAge,
  (t) => {
    const f = fixture(t);
    const result = f.run(backupScript, ["--label", "manual"], {
      BACKUP_ENABLED: "true",
      BACKUP_AGE_RECIPIENT: recipient(f.root),
      DATABASE_URL: "postgresql://inert:inert@mock-db.example:5432/mock",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not a mounted volume and BACKUP_S3_BUCKET is unset/);
    assert.doesNotMatch(result.stderr, /must not run/);
    assert.deepEqual(readdirSync(f.backups), []);
  },
);
