/** Explicit KB integration suite runner. Owns uniquely named disposable fixtures. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildArtifactDirectory,
  buildArtifactPath,
} from "../packages/test-utils/src/kb/build-artifacts.mjs";
import { createBuildSupervisor } from "./build-embedding-runtime.mjs";
import { ensureKbDataSkeleton } from "./init-kb-volumes.mjs";
import { assertPinnedAgeDir, ensureAge } from "./lib/age-pin.mjs";
import {
  loadArtifactIdentity,
  nativeDockerPlatform,
  runImageSmoke,
  verifyModelArtifact,
} from "./test-qwen-image.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(ROOT, "docker-compose.kb-test.yml");
const VITEST_CONFIG = join(ROOT, "vitest.kb.config.ts");
const ARTIFACT_DIR = join(tmpdir(), "kb-test-artifacts");

/** @typedef {{ include: string[]; isolatedFirst?: string[]; services: Array<"postgres"|"redis">; nodeTests?: string[]; requireDocker?: boolean; supervised?: boolean; playwright?: string; qwenModel?: boolean; age?: boolean; imageGit?: { reached: string[] } }} Suite */

/** @type {Record<string, Suite>} */
export const SUITES = {
  "asset-migration": {
    include: ["packages/test-utils/src/kb/asset-storage-migration.integration.test.ts"],
    nodeTests: [
      "scripts/lib/asset-storage-control.test.mjs",
      "scripts/generate-dokploy-config.test.ts",
    ],
    services: ["postgres"],
  },
  "asset-storage": {
    include: ["packages/test-utils/src/kb/asset-storage.integration.test.ts"],
    services: ["postgres"],
  },
  deployment: {
    include: ["packages/test-utils/src/kb/deployment.integration.test.ts"],
    services: ["postgres", "redis"],
  },
  restore: {
    include: [
      "packages/test-utils/src/kb/restore.integration.test.ts",
      "packages/test-utils/src/kb/asset-storage-offline.integration.test.ts",
    ],
    nodeTests: ["scripts/lib/kb-restore.test.mjs", "scripts/restore-archive.test.mjs"],
    services: ["postgres"],
    age: true,
  },
  backup: {
    include: [
      "packages/test-utils/src/kb/backup.integration.test.ts",
      "packages/api/src/lib/kb/maintenance.test.ts",
    ],
    nodeTests: [
      "scripts/lib/age-pin.test.mjs",
      "scripts/lib/kb-backup.test.mjs",
      "scripts/test-backup-writer.mjs",
    ],
    services: ["postgres", "redis"],
    // Real age/age-keygen: the pinned release, provisioned by resolveAgeDir().
    age: true,
  },
  "git-push": {
    include: [
      "packages/test-utils/src/kb/git-push.integration.test.ts",
      "apps/server/src/git-pre-receive.test.ts",
      "apps/server/src/push-context.test.ts",
      "packages/api/src/lib/kb/push-validation.test.ts",
    ],
    services: ["postgres"],
    imageGit: { reached: ["path http-backend", "core git receive-pack", "core git merge-base"] },
    supervised: true,
  },
  "git-http": {
    include: [
      "packages/test-utils/src/kb/git-http.integration.test.ts",
      "apps/server/src/git-http.test.ts",
      "apps/server/src/git-cgi.test.ts",
      "packages/api/src/lib/kb/push-spool.test.ts",
    ],
    services: ["postgres"],
    imageGit: { reached: ["path http-backend", "core git upload-pack"] },
    supervised: true,
  },
  mcp: {
    include: [
      "packages/test-utils/src/kb/mcp.integration.test.ts",
      "apps/server/src/mcp/tools.test.ts",
      "apps/server/src/mcp/tool-dispatch.test.ts",
      "apps/server/src/mcp/tool-coverage-doc.test.ts",
      "packages/api/src/lib/kb/protocol/protocol.test.ts",
    ],
    services: ["postgres", "redis"],
    imageGit: { reached: ["path init"] },
  },
  device: {
    include: [
      "packages/test-utils/src/kb/device.integration.test.ts",
      "packages/auth/src/device-approval.test.ts",
      "packages/api/src/routers/cli-credentials.test.ts",
      "apps/server/src/device-approval-gate.test.ts",
      "apps/server/src/cors-headers.test.ts",
    ],
    services: ["postgres"],
  },
  admission: {
    include: [
      "packages/test-utils/src/kb/admission.integration.test.ts",
      "apps/server/src/mcp/*.test.ts",
      "apps/server/src/kb-token-routes.test.ts",
      "apps/server/src/kb-asset-routes.test.ts",
      "apps/server/src/kb-export-routes.test.ts",
      "apps/server/src/lifecycle.test.ts",
      "apps/server/src/session-middleware.test.ts",
      "packages/api/src/routers/mcp-tokens.test.ts",
      "packages/api/src/routers/mcp-consent.test.ts",
      "packages/api/src/lib/kb/permissions.test.ts",
    ],
    services: ["postgres"],
  },
  oauth: {
    include: [
      "packages/test-utils/src/kb/cimd.integration.test.ts",
      "packages/test-utils/src/kb/oauth.integration.test.ts",
      "packages/auth/src/mcp-plugins.test.ts",
      "apps/server/src/mcp-authorize-scope-guard.test.ts",
      "apps/server/src/mcp-discovery.test.ts",
    ],
    services: ["postgres"],
  },
  consent: {
    include: [
      "packages/test-utils/src/kb/consent.integration.test.ts",
      "packages/auth/src/mcp-consent.test.ts",
      "packages/auth/src/mcp-refresh.test.ts",
      "packages/auth/src/mcp-grant.test.ts",
      "packages/api/src/routers/mcp-consent.test.ts",
    ],
    services: ["postgres"],
  },
  grants: {
    include: [
      "packages/test-utils/src/kb/grants.integration.test.ts",
      "packages/api/src/lib/mcp-token-access.test.ts",
      "packages/api/src/lib/kb/permissions.test.ts",
      "packages/api/src/routers/mcp-tokens.test.ts",
      "packages/api/src/routers/mcp-grants.test.ts",
      "packages/auth/src/mcp-config.test.ts",
      "packages/auth/src/mcp-grant.test.ts",
      "packages/auth/src/ban.test.ts",
    ],
    services: ["postgres"],
  },
  sealed: {
    include: [
      "packages/test-utils/src/kb/sealed.integration.test.ts",
      "packages/api/src/lib/kb/sealed-reference.test.ts",
      "packages/api/src/lib/kb/sealed-records.test.ts",
      "packages/api/src/lib/kb/sealed-resolve.test.ts",
      "packages/api/src/lib/kb/sealed-envelope.test.ts",
      "packages/api/src/routers/kb-sealed.test.ts",
    ],
    services: ["postgres"],
  },
  mirror: {
    include: [
      "packages/test-utils/src/kb/mirror.integration.test.ts",
      "apps/worker/src/handlers/push-mirror.test.ts",
      "apps/worker/src/lib/mirror-ssh.test.ts",
      "packages/api/src/lib/kb/ssh-url.test.ts",
      "packages/api/src/lib/kb/deploy-key.test.ts",
      "packages/api/src/lib/kb/mirror.test.ts",
      "packages/api/src/routers/kb-mirror.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  "model-download": {
    include: [
      "packages/test-utils/src/kb/model-download.integration.test.ts",
      "packages/test-utils/src/kb/model-transport.integration.test.ts",
      "packages/api/src/lib/kb/builtin-registry.test.ts",
      "packages/api/src/lib/kb/model-artifact.test.ts",
      "packages/api/src/lib/kb/local-model.test.ts",
      "packages/api/src/routers/kb-model.test.ts",
      "apps/worker/src/handlers/download-model.test.ts",
    ],
    services: ["postgres"],
  },
  // The Rust kb-client (apps/cli/crates/kb-client/tests/sdk_interop.rs)
  // against the official TS MCP SDK server; needs cargo, no services.
  parity: {
    include: ["packages/test-utils/src/kb/parity.integration.test.ts"],
    services: ["postgres", "redis"],
  },
  "client-interop": {
    include: [
      "packages/test-utils/src/kb/client-interop.integration.test.ts",
      "packages/test-utils/src/kb/remote-stdio.integration.test.ts",
    ],
    services: [],
  },
  "qwen-process": {
    include: [
      "packages/test-utils/src/kb/qwen-process.integration.test.ts",
      "apps/worker/src/lib/qwen-lifecycle.test.ts",
      "apps/worker/src/lib/qwen-child.test.ts",
    ],
    services: [],
  },
  // Both pinned artifacts (KB_QWEN_MODEL_PATH / KB_GEMMA_MODEL_PATH, cached by SHA),
  // host real-child tests, then the built Node 26 trixie-slim worker image on the native
  // arch (scripts/test-qwen-image.mjs). Never part of `pnpm gate`; never skips.
  "qwen-model": {
    include: [
      "packages/test-utils/src/kb/qwen-model.integration.test.ts",
      "packages/test-utils/src/kb/gemma-model.integration.test.ts",
    ],
    services: ["postgres"],
    qwenModel: true,
  },
  // Built-in embedder runtime config change: memory gate, new
  // fingerprint, sequential re-embedding under the DB lease, rebuild notices.
  "qwen-reembed": {
    include: [
      "packages/test-utils/src/kb/qwen-reembed.integration.test.ts",
      "packages/test-utils/src/kb/model-runtime-io.integration.test.ts",
      "packages/test-utils/src/kb/builtin-memory.integration.test.ts",
      "packages/api/src/lib/kb/qwen-runtime-config.test.ts",
      "packages/api/src/routers/kb-model.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  search: {
    include: [
      "packages/test-utils/src/kb/search.integration.test.ts",
      "packages/api/src/lib/kb/search.test.ts",
      "packages/api/src/lib/kb/rrf.test.ts",
      "packages/api/src/lib/kb/citation.test.ts",
      "packages/api/src/routers/search.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  "structured-search": {
    include: [
      "packages/test-utils/src/kb/structured-search.integration.test.ts",
      "packages/api/src/lib/kb/structured-search.test.ts",
      "packages/api/src/lib/kb/structured.test.ts",
      "packages/api/src/lib/kb/search.test.ts",
      "packages/api/src/lib/kb/cursor.test.ts",
      "packages/api/src/routers/search.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  // Bounded retention, credential artifact windows and audit coverage.
  retention: {
    include: [
      "packages/test-utils/src/kb/retention-boundaries.integration.test.ts",
      "packages/test-utils/src/kb/retention.integration.test.ts",
      "packages/api/src/lib/kb/retention.test.ts",
      "packages/api/src/lib/kb/audit-map.test.ts",
      "apps/worker/src/handlers/kb-retention.test.ts",
      "apps/worker/src/handlers/reap-expired-auth-tokens.test.ts",
      "apps/server/src/kb-staging-cleanup.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  "query-embedding": {
    include: [
      "packages/test-utils/src/kb/query-embedding.integration.test.ts",
      "packages/api/src/lib/kb/query-embedding.test.ts",
      "packages/api/src/lib/kb/embedder.test.ts",
      "apps/worker/src/handlers/query-embedding.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  "index-settings": {
    include: [
      "packages/test-utils/src/kb/index-settings.integration.test.ts",
      "packages/api/src/lib/kb/index-settings.test.ts",
      "packages/api/src/routers/kb-index.test.ts",
    ],
    services: ["postgres"],
  },
  generations: {
    include: [
      "packages/test-utils/src/kb/generations.integration.test.ts",
      "packages/api/src/lib/kb/generations.test.ts",
      "packages/api/src/lib/kb/index-status.test.ts",
      "packages/api/src/routers/kb-index.test.ts",
      "apps/worker/src/handlers/index-kb.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  providers: {
    include: [
      "packages/test-utils/src/kb/providers.integration.test.ts",
      "packages/api/src/lib/kb/providers.test.ts",
      "packages/api/src/lib/kb/embed-client.test.ts",
      "packages/api/src/lib/kb/embedder.test.ts",
      "packages/api/src/lib/kb/fingerprint.test.ts",
      "packages/api/src/routers/embedding-providers.test.ts",
      "apps/worker/src/handlers/provider-probe.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  jobs: {
    include: [
      "packages/test-utils/src/kb/jobs.integration.test.ts",
      "packages/api/src/lib/kb/jobs.test.ts",
      "packages/api/src/lib/kb/job-attempt.test.ts",
      "apps/worker/src/durable-dispatcher.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  harness: {
    include: ["packages/test-utils/src/kb/harness.integration.test.ts"],
    services: ["postgres", "redis"],
    nodeTests: ["scripts/test-kb.test.mjs", "scripts/build-embedding-runtime.test.mjs"],
  },
  // flk8: real-daemon build-supervisor proof. Its duration follows the Docker
  // daemon, so it runs under build-only bounds in its own suite (`test:kb all`,
  // and merges touching build-* sources), not in every harness run.
  build: {
    include: [],
    services: [],
    requireDocker: true,
    nodeTests: ["scripts/test-kb-build-docker.test.mjs"],
  },
  // R3-W3: the built server/worker entrypoints never print a credential on an
  // import-time failure (malformed or unreachable credential-bearing URLs).
  "entry-canary": {
    include: ["packages/test-utils/src/kb/entry-canary.integration.test.ts"],
    services: ["postgres", "redis"],
    imageGit: { reached: ["path --version"] },
  },
  bootstrap: {
    include: ["packages/auth/src/bootstrap.integration.test.ts"],
    services: ["postgres"],
  },
  schema: {
    include: ["packages/test-utils/src/kb/schema.integration.test.ts"],
    services: ["postgres"],
  },
  topology: {
    include: ["packages/test-utils/src/kb/topology.integration.test.ts"],
    services: ["redis"],
    nodeTests: ["scripts/init-kb-volumes.test.mjs"],
  },
  fence: {
    include: ["packages/test-utils/src/kb/fence.integration.test.ts"],
    services: [],
    requireDocker: true,
  },
  locks: {
    include: [
      "packages/test-utils/src/kb/locks.integration.test.ts",
      "apps/server/src/kb-write-coordinator.integration.test.ts",
      "apps/server/src/kb-write-shutdown.integration.test.ts",
    ],
    services: ["postgres"],
  },
  authority: {
    include: ["packages/test-utils/src/kb/authority.integration.test.ts"],
    services: ["postgres"],
  },
  journal: {
    include: [
      "apps/server/src/kb-journal.integration.test.ts",
      "packages/api/src/lib/kb/operation-intent.test.ts",
      "packages/api/src/lib/kb/git-read.test.ts",
      "packages/api/src/lib/kb/git-write.test.ts",
      "packages/api/src/lib/kb/recovery.test.ts",
    ],
    services: ["postgres", "redis"],
  },
  bases: {
    include: [
      "packages/test-utils/src/kb/bases.integration.test.ts",
      "packages/api/src/lib/kb/attachment.test.ts",
      "packages/api/src/lib/kb/cursor.test.ts",
      "packages/api/src/lib/kb/documents-read.test.ts",
      "packages/api/src/lib/kb/bases.test.ts",
      "packages/api/src/routers/kbs.test.ts",
      "packages/api/src/routers/documents.test.ts",
    ],
    services: ["postgres"],
  },
  members: {
    include: [
      "packages/mailer/src/index.integration.test.ts",
      "packages/test-utils/src/kb/members.integration.test.ts",
      "packages/api/src/lib/kb/shares.test.ts",
      "packages/api/src/lib/kb/transfer.test.ts",
      "packages/api/src/lib/kb/account-removal.test.ts",
      "packages/api/src/routers/kb-members.test.ts",
      "packages/auth/src/account-deletion-policy.test.ts",
    ],
    services: ["postgres"],
  },
  changes: {
    include: [
      "packages/test-utils/src/kb/changes.integration.test.ts",
      "packages/test-utils/src/kb/git-rollup.integration.test.ts",
      "packages/api/src/lib/kb/git-rollup.test.ts",
      "apps/worker/src/handlers/kb-git-rollup.test.ts",
      "packages/api/src/lib/kb/changes.test.ts",
      "packages/api/src/lib/kb/staged-tree.test.ts",
      "packages/api/src/lib/kb/branch-owner.test.ts",
      "packages/api/src/lib/kb/proposals.test.ts",
    ],
    services: ["postgres"],
    imageGit: { reached: ["path merge-base"] },
  },
  pr: {
    include: [
      "packages/test-utils/src/kb/pr.integration.test.ts",
      "packages/api/src/lib/kb/pr-merge.test.ts",
      "packages/api/src/lib/kb/merge-scratch.test.ts",
      "packages/api/src/lib/kb/diff.test.ts",
      "packages/api/src/lib/kb/pull-requests.test.ts",
      "packages/api/src/routers/pull-requests.test.ts",
    ],
    services: ["postgres"],
    imageGit: { reached: ["path merge-tree"] },
  },
  dream: {
    include: [
      "packages/test-utils/src/kb/dream.integration.test.ts",
      "packages/api/src/lib/kb/dream.test.ts",
      "packages/api/src/lib/kb/sensitive-text.test.ts",
      "packages/api/src/lib/kb/parse-markdown.test.ts",
    ],
    services: ["postgres"],
  },
  tree: {
    include: [
      "packages/test-utils/src/kb/tree.integration.test.ts",
      "packages/api/src/lib/kb/paths.test.ts",
      "packages/api/src/lib/kb/manifest.test.ts",
      "packages/api/src/lib/kb/parse-markdown.test.ts",
      "packages/api/src/lib/kb/validate-tree.test.ts",
    ],
    services: [],
  },
  cas: {
    include: [
      "packages/test-utils/src/kb/cas.integration.test.ts",
      "packages/api/src/lib/kb/cas.test.ts",
      "packages/api/src/lib/kb/cas-temp-race.test.ts",
      "packages/api/src/lib/kb/blob-store-disk.test.ts",
      "packages/api/src/lib/sniff-mime.test.ts",
    ],
    services: ["postgres"],
    requireDocker: true,
  },
  uploads: {
    include: [
      "packages/test-utils/src/kb/uploads.integration.test.ts",
      "packages/api/src/lib/kb/uploads.test.ts",
      "packages/api/src/routers/kb-uploads.test.ts",
      "apps/server/src/body-policy.test.ts",
    ],
    services: ["postgres"],
    requireDocker: true,
  },
  "asset-manifest": {
    include: [
      "packages/test-utils/src/kb/asset-manifest.integration.test.ts",
      "packages/api/src/lib/kb/assets.test.ts",
      "packages/api/src/lib/kb/asset-authz.test.ts",
      "packages/api/src/routers/kb-assets.test.ts",
      "packages/api/src/lib/kb/manifest.test.ts",
    ],
    services: ["postgres"],
  },
  "asset-http": {
    include: [
      "packages/test-utils/src/kb/asset-http.integration.test.ts",
      "packages/api/src/lib/kb/authorized-stream.test.ts",
      "apps/server/src/kb-asset-routes.test.ts",
      "apps/server/src/security-headers.test.ts",
      "apps/server/src/body-policy.test.ts",
    ],
    services: ["postgres"],
  },
  exports: {
    // The RSS-bound test runs first, alone, in its own Vitest process,
    // so no earlier test's heap can skew its 160 MiB bound.
    isolatedFirst: [
      "packages/test-utils/src/kb/exports-rss.integration.test.ts",
      "packages/test-utils/src/kb/exports-s3-rss.integration.test.ts",
    ],
    include: [
      "packages/test-utils/src/kb/exports-rss.integration.test.ts",
      "packages/test-utils/src/kb/exports-s3-rss.integration.test.ts",
      "packages/test-utils/src/kb/exports.integration.test.ts",
      "packages/test-utils/src/kb/exports-cli.integration.test.ts",
      "packages/api/src/lib/kb/transfers.integration.test.ts",
      "packages/api/src/lib/kb/exports.test.ts",
      "packages/api/src/lib/kb/transfers.test.ts",
      "packages/api/src/routers/kb-exports.test.ts",
      "apps/server/src/kb-export-routes.test.ts",
    ],
    services: ["postgres"],
  },
  // Real Chromium against the seeded fixture origin (apps/web/tests/kb-*.spec.ts).
  browser: {
    include: [],
    services: ["postgres", "redis"],
    playwright: "apps/web/playwright.kb.config.ts",
  },
  egress: {
    include: [
      "packages/test-utils/src/kb/egress.integration.test.ts",
      "packages/api/src/lib/kb/envelope.test.ts",
      "packages/api/src/lib/kb/egress.test.ts",
      "packages/api/src/lib/kb/private-ip.test.ts",
      "packages/env/src/kb-master-key.test.ts",
    ],
    services: [],
  },
};

/** Build-only wall-clock limit, independent of Vitest hooks and operation deadlines. */
export const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

/** Exhaustive compiler inventory for suites and their real-process unit siblings. */
// Artifact needs derived from the suite's own sources, so a new caller cannot miss its prerequisite.
function usesSource(suite, needle) {
  return (suite.include ?? []).some((file) => {
    const path = join(ROOT, file);
    return existsSync(path) && readFileSync(path, "utf8").includes(needle);
  });
}

export function buildPrerequisites(name, suite = SUITES[name], project) {
  const steps = [];
  const add = (artifact, file, args) => steps.push({ artifact, file, args });
  if (
    name === "device" ||
    name === "exports" ||
    name === "mcp" ||
    name === "parity" ||
    name === "client-interop" ||
    suite.playwright
  )
    add("cli", "cargo", [
      "build",
      "--locked",
      "-j3",
      "-p",
      "kb",
      "--manifest-path",
      join(ROOT, "apps/cli/Cargo.toml"),
    ]);
  if (name === "parity")
    add("parity-fixture", "cargo", [
      "build",
      "--locked",
      "-j3",
      "-p",
      "kb-local",
      "--bin",
      "kb-parity-fixture",
      "--manifest-path",
      join(ROOT, "apps/cli/Cargo.toml"),
    ]);
  if (suite.playwright)
    add("browser-harness", "pnpm", [
      "exec",
      "tsx",
      join(ROOT, "apps/web/tests/kb-browser.build.ts"),
    ]);
  if (name === "client-interop")
    add("sdk-interop", "cargo", [
      "test",
      "--no-run",
      "--locked",
      "-j3",
      "-p",
      "kb-client",
      "--test",
      "sdk_interop",
      "--message-format=json",
      "--manifest-path",
      join(ROOT, "apps/cli/Cargo.toml"),
    ]);
  if (
    suite.supervised ||
    ["asset-migration", "backup", "restore", "fence", "locks", "pr", "entry-canary"].includes(name)
  )
    add("supervisor", "make", ["-C", "apps/server/native", "-j2"]);
  if (name === "entry-canary")
    add("output-canary", "pnpm", [
      "--filter",
      "worker",
      "exec",
      "tsdown",
      "--config",
      join(ROOT, "apps/worker/output-canary.config.ts"),
      "--out-dir",
      buildArtifactPath("output-canary", project),
    ]);
  const gcc = (artifact, source, flags = ["-D_GNU_SOURCE"]) =>
    add(artifact, "gcc", [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      ...flags,
      "-o",
      buildArtifactPath(artifact, project),
      source,
    ]);
  if (name === "fence" || name === "git-push")
    gcc("static-supervisor", join(ROOT, "apps/server/native/kb-supervisor.c"), [
      "-D_GNU_SOURCE",
      "-static",
    ]);
  if (name === "fence") {
    gcc("pause-child", buildArtifactPath("pause.c", project), []);
    gcc("fork-ignore-child", buildArtifactPath("fork-ignore.c", project), []);
  }
  // Any suite whose tests call ownProcess() needs the owner binary; derived from the
  // sources so a new caller (R45's qwen-process tests) cannot miss it.
  if (usesSource(suite, "ownProcess("))
    gcc("process-owner", join(ROOT, "packages/test-utils/src/kb/process-fixture.c"), []);
  if (
    name === "qwen-process" ||
    suite.qwenModel ||
    usesSource(suite, 'buildArtifactPath("child-guard")')
  )
    gcc("child-guard", join(ROOT, "apps/worker/src/native/child-guard.c"));
  // Every suite that starts the SSH fixture (mirror, deployment) needs its image prebuilt.
  if (usesSource(suite, "createSshFixture("))
    add("ssh-image", process.execPath, [
      "--import",
      "tsx",
      join(ROOT, "packages/test-utils/src/kb/ssh.ts"),
      "--prebuild-image",
    ]);
  return steps;
}

function prepareBuildSources(name, project) {
  mkdirSync(buildArtifactDirectory(project), { recursive: true });
  if (name !== "fence") return;
  writeFileSync(
    buildArtifactPath("pause.c", project),
    "#include <unistd.h>\nint main(void){ for(;;) pause(); return 0; }\n",
  );
  writeFileSync(buildArtifactPath("fork-ignore.c", project), FORK_IGNORE_SOURCE);
}

const FORK_IGNORE_SOURCE = [
  "#include <fcntl.h>",
  "#include <signal.h>",
  "#include <stdlib.h>",
  "#include <string.h>",
  "#include <unistd.h>",
  "static void write_path(const char *path, const char *msg) {",
  "  int fd;",
  "  ssize_t n;",
  "  if (!path || !path[0]) return;",
  "  fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);",
  "  if (fd < 0) return;",
  "  n = write(fd, msg, strlen(msg));",
  "  (void)n;",
  "  (void)close(fd);",
  "}",
  "int main(void) {",
  '  const char *ready = getenv("CHILD_READY");',
  '  const char *leak = getenv("LEAK_PATH");',
  "  pid_t child = fork();",
  "  if (child < 0) return 1;",
  "  if (child == 0) {",
  "    (void)signal(SIGTERM, SIG_IGN);",
  '    write_path(ready, "ready");',
  "    sleep(8);",
  '    write_path(leak, "leaked");',
  "    _exit(0);",
  "  }",
  "  for (;;) pause();",
  "  return 0;",
  "}\n",
].join("\n");

/**
 * Every suite runs under a pinned non-UTC process TZ and a distinct non-UTC
 * PostgreSQL session TimeZone, so a timestamp that depends on either offset
 * fails here instead of only on a production host outside UTC.
 * Override with KB_TEST_TZ / KB_TEST_PG_TIMEZONE, or with an inherited `TZ`
 * (the form the acceptance criteria spell: `TZ=<zone> pnpm test:kb <suite>`).
 * KB_TEST_TZ wins when both are set, because it is what the runner re-exports
 * and what the fixture guard compares the live process zone against.
 */
export const DEFAULT_TEST_TZ = "America/Chicago";
export const DEFAULT_TEST_PG_TIMEZONE = "Pacific/Kiritimati";
const FALLBACK_TEST_PG_TIMEZONE = "Pacific/Pago_Pago";

function canonicalZone(zone) {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
}

function assertNonUtcZone(zone, variable) {
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`${variable}=${zone} is not a valid IANA time zone.`);
  }
  // Probe both solstices: a zone at UTC+0 for part of the year (Europe/London)
  // would hide an offset bug for half the year.
  for (const probe of [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)]) {
    const offset = new Intl.DateTimeFormat("en-US", {
      timeZone: resolved,
      timeZoneName: "longOffset",
    })
      .formatToParts(probe)
      .find((part) => part.type === "timeZoneName")?.value;
    if (/^(?:GMT|UTC)(?:[+-]0?0(?::?00)?)?$/.test(offset ?? "")) {
      throw new Error(`${variable}=${zone} has a UTC offset of zero; pick a non-UTC zone.`);
    }
  }
  return zone;
}

/**
 * An inherited `TZ` selects the process zone, so `TZ=<zone> pnpm test:kb <suite>`
 * does what it says. A zone at UTC+0 (or an unparseable one) cannot decide the
 * pin — that is the sandbox the suites exist to expose — so it falls back to the
 * default with a warning rather than silently discarding the variable.
 */
function inheritedProcessTz(env) {
  if (!env.TZ) return undefined;
  try {
    return assertNonUtcZone(env.TZ, "TZ");
  } catch (error) {
    console.warn(
      `test-kb: ignoring the inherited TZ=${env.TZ} (${error instanceof Error ? error.message : String(error)}) ` +
        `and running under the pinned ${DEFAULT_TEST_TZ}. Set KB_TEST_TZ to pick a zone.`,
    );
    return undefined;
  }
}

/** Resolves the Node child TZ and the fixture's PostgreSQL TimeZone. */
export function resolveTestTimeZones(env = process.env) {
  const tz = env.KB_TEST_TZ
    ? assertNonUtcZone(env.KB_TEST_TZ, "KB_TEST_TZ")
    : (inheritedProcessTz(env) ?? DEFAULT_TEST_TZ);
  const explicitPg = env.KB_TEST_PG_TIMEZONE;
  const pgTimeZone = assertNonUtcZone(
    explicitPg ||
      (canonicalZone(tz) === canonicalZone(DEFAULT_TEST_PG_TIMEZONE)
        ? FALLBACK_TEST_PG_TIMEZONE
        : DEFAULT_TEST_PG_TIMEZONE),
    "KB_TEST_PG_TIMEZONE",
  );
  if (canonicalZone(pgTimeZone) === canonicalZone(tz)) {
    throw new Error(`KB_TEST_PG_TIMEZONE must differ from KB_TEST_TZ (both ${tz}).`);
  }
  return { tz, pgTimeZone };
}

export const POSTGRES_IMAGE =
  "postgres:18.6-trixie@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42";
export const REDIS_IMAGE =
  "valkey/valkey:9.1.3-trixie@sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dev-dist",
  ".git",
  "target",
  ".turbo",
  "coverage",
]);

export function matchGlob(file, pattern) {
  const normalized = file.replaceAll("\\", "/");
  const variants = [pattern.replaceAll("\\", "/")];
  if (pattern.includes("/**/")) variants.push(pattern.replace("/**/", "/"));
  return variants.some((variant) => {
    const source = variant
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replaceAll("<<<GLOBSTAR>>>", ".*");
    return new RegExp(`^${source}$`).test(normalized);
  });
}

export function listIntegrationFiles(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".integration.test.ts")) {
        files.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

export function filesForSuite(suite, files) {
  return files.filter((file) => suite.include.some((pattern) => matchGlob(file, pattern)));
}

export function assertSuiteCoverage(suites = SUITES, files = listIntegrationFiles()) {
  const owners = new Map();
  for (const [name, suite] of Object.entries(suites)) {
    for (const file of filesForSuite(suite, files)) {
      const previous = owners.get(file);
      if (previous) throw new Error(`${file} belongs to both ${previous} and ${name}`);
      owners.set(file, name);
    }
  }
  const orphaned = files.filter((file) => !owners.has(file));
  if (orphaned.length > 0) {
    throw new Error(`Integration tests are not registered in any suite: ${orphaned.join(", ")}`);
  }
  return owners;
}

export function resolveSuiteName(argv = process.argv.slice(2)) {
  const args = argv.filter((arg) => arg !== "--");
  if (args.length !== 1) {
    throw new Error(
      `Usage: pnpm test:kb -- <suite>|all or --reap-dead-runs (registered: ${Object.keys(SUITES).join(", ")})`,
    );
  }
  const name = args[0];
  if (name === "all") return "all";
  if (!SUITES[name]) {
    throw new Error(`Unknown suite: ${name}. Registered: ${Object.keys(SUITES).join(", ")}`);
  }
  return name;
}

/**
 * A browser run passes only when Playwright really executed tests and every
 * one of them passed: zero executed, skipped or flaky tests fail the suite.
 */
export function assertBrowserReport(report) {
  const stats = report?.stats;
  if (!stats || typeof stats.expected !== "number")
    throw new Error("Playwright produced no JSON report; no browser tests ran.");
  if (stats.expected === 0) throw new Error("No browser tests executed.");
  if ((stats.unexpected ?? 0) > 0 || (stats.flaky ?? 0) > 0)
    throw new Error("Browser tests failed.");
  if ((stats.skipped ?? 0) > 0) throw new Error("Browser tests were skipped.");
  return stats.expected;
}

export function checkPrerequisites(options = {}) {
  const requireBin = (bin, args, message) => {
    try {
      execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new Error(message);
    }
  };
  if (options.docker !== false) {
    requireBin(
      options.dockerBin ?? "docker",
      ["info"],
      "Docker is required for pnpm test:kb (daemon not reachable).",
    );
  }
  if (options.git !== false) {
    requireBin(options.gitBin ?? "git", ["--version"], "Git is required for pnpm test:kb.");
  }
}

/**
 * Directory holding the pinned age v1.3.2 binaries for suites that run real
 * age. KB_AGE_DIR (an operator-provided install) wins but must hold exactly the
 * pinned version; otherwise scripts/lib/age-pin.mjs downloads the official
 * archive, verifies its SHA-256 and caches it per user. Never a skip.
 */
export async function resolveAgeDir(env = process.env, ensure = ensureAge) {
  if (env.KB_AGE_DIR)
    return assertPinnedAgeDir(resolve(env.KB_AGE_DIR), `KB_AGE_DIR=${env.KB_AGE_DIR}`);
  return ensure({ env });
}

export function redactText(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out.replace(/(\w+:\/\/[^:/?#]+:)[^@/\s]+@/g, "$1***@");
}

export function writeFailureArtifact(project, error, secrets = []) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const body = redactText(
    [
      `fixture=${project}`,
      error?.message ?? String(error),
      error?.stdout ?? "",
      error?.stderr ?? "",
    ].join("\n"),
    secrets,
  );
  const path = join(ARTIFACT_DIR, `${project}.log`);
  writeFileSync(path, body);
  return path;
}

function compose(project, args, env) {
  return execFileSync(
    "bash",
    [join(ROOT, "scripts/compose.sh"), "-f", COMPOSE_FILE, "-p", project, ...args],
    {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function publishedPort(run, service, mapping) {
  const value = (await run(["port", service, mapping])).trim().split(":").at(-1);
  if (!/^\d+$/.test(value ?? ""))
    throw new Error(`Could not resolve published port for ${service}`);
  return value;
}

async function startServices(project, suite, secrets, pgTimeZone, run) {
  const profiles = suite.services.flatMap((service) => ["--profile", service]);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    KB_TEST_PG_PASSWORD: secrets.pgPassword,
    KB_TEST_PG_TIMEZONE: pgTimeZone,
    COMPOSE_PROJECT_NAME: project,
  };
  const invoke = (args) =>
    run(
      "bash",
      [join(ROOT, "scripts/compose.sh"), "-f", COMPOSE_FILE, "-p", project, ...args],
      env,
      Object.values(secrets),
      project,
    );
  await invoke([...profiles, "up", "-d", "--wait", "--wait-timeout", "60"]);
  const urls = {};
  if (suite.services.includes("postgres")) {
    urls.pgPort = await publishedPort(invoke, "postgres", "5432");
  }
  if (suite.services.includes("redis")) {
    urls.redisPort = await publishedPort(invoke, "redis", "6379");
  }
  return urls;
}

function stopServices(project, secrets) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    KB_TEST_PG_PASSWORD: secrets.pgPassword,
    COMPOSE_PROJECT_NAME: project,
  };
  try {
    compose(
      project,
      [
        "--profile",
        "postgres",
        "--profile",
        "redis",
        "down",
        "-v",
        "--remove-orphans",
        "--timeout",
        "5",
      ],
      env,
    );
  } catch (error) {
    writeFailureArtifact(project, error, Object.values(secrets));
  }
  try {
    const ids = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (ids.length > 0) execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
  } catch {
    // Best-effort after compose down.
  }
}

/**
 * Run-owned resource names use `kb-test-<suite>-<runner pid>-<6 hex>` as a prefix.
 * Container ownership requires a label; an image or container name alone is insufficient.
 */
export function parseRunProject(name) {
  const match = /^(kb-test-[a-z0-9-]+?-(\d+)-[0-9a-f]{6})(?=$|[-_:])/.exec(String(name ?? ""));
  return match ? { project: match[1], pid: Number(match[2]) } : null;
}

/** A run is live while its runner pid exists or any process still carries its project. */
export function runIsLive(project, pid, procRoot = "/proc") {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") return true;
  }
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(join(procRoot, entry, "environ"), "latin1").includes(project)) return true;
    } catch {
      // Permission errors (including non-dumpable descendants and other UIDs)
      // cannot establish exit. Even ENOENT can hide a live process under hidepid.
      try {
        process.kill(Number(entry), 0);
        return true;
      } catch (error) {
        if (error?.code !== "ESRCH") return true;
      }
    }
  }
  return false;
}

const dockerText = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });

const CONTAINER_FORMAT =
  '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "io.knowledge-base.test-project"}}';

// Exact names created by docker.ts callers and the SSH/fence fixtures.
// A name alone never grants ownership: the runner label is still mandatory.
const FIXTURE_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FIXTURE_NAME = new RegExp(
  `^(?:kb-(?:ssh|ssh-readonly|memory|push-hook|fence-smoke)-${FIXTURE_UUID}|kb-fence-\\d+-[0-9a-f]{1,6})$`,
);

/** All explicit ownership signals must agree; never infer ownership from an image. */
function containerRunProject([, names, image, composeOwner, testOwner]) {
  const owners = [composeOwner, testOwner].filter(Boolean);
  if (owners.length === 0) return null;
  const run = parseRunProject(owners[0]);
  if (!run || owners.some((owner) => parseRunProject(owner)?.project !== run.project)) return null;
  const containerNames = String(names).split(",");
  let namedResource = false;
  for (const name of [image, ...containerNames]) {
    const namedRun = parseRunProject(name);
    if (namedRun && namedRun.project !== run.project) return null;
    if (namedRun) namedResource = true;
  }
  if (!namedResource && (!testOwner || !containerNames.every((name) => FIXTURE_NAME.test(name))))
    return null;
  return run.project;
}

/**
 * A killed runner never reaches its finally: its containers (including a `docker run`
 * left in Created), networks, volumes and image tags outlive it and keep the daemon
 * busy for every later run. Remove only run-labelled KB resources whose runner is gone;
 * a live run's and every other project's resources are never listed for removal.
 */
export function reapDeadRuns({ docker = dockerText, isLive = runIsLive, log = () => {} } = {}) {
  const live = new Map();
  const dead = (name) => {
    const run = parseRunProject(name);
    if (!run || run.pid === process.pid) return null;
    if (!live.has(run.project)) live.set(run.project, isLive(run.project, run.pid));
    return live.get(run.project) ? null : run.project;
  };
  const lines = (args) => {
    try {
      return docker(args).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const remove = (kind, args, ids) => {
    if (ids.length === 0) return;
    try {
      docker([...args, ...ids]);
      log(`test-kb: reaped ${ids.length} ${kind} of exited runs\n`);
    } catch {
      // Best effort: a concurrent reaper or a still-draining daemon may win the race.
    }
  };
  const containers = lines(["ps", "-a", "--format", CONTAINER_FORMAT])
    .map((line) => line.split("\t"))
    .filter((row) => dead(containerRunProject(row)))
    .map(([id]) => id);
  remove("containers", ["rm", "-f", "-v"], containers);
  remove(
    "networks",
    ["network", "rm"],
    lines(["network", "ls", "--format", "{{.Name}}"]).filter((name) => dead(name)),
  );
  remove(
    "volumes",
    ["volume", "rm"],
    lines(["volume", "ls", "--format", "{{.Name}}"]).filter((name) => dead(name)),
  );
  // Untag only; an image still used by any container stays (no --force).
  for (const image of lines(["images", "--format", "{{.Repository}}:{{.Tag}}"]).filter((name) =>
    dead(name),
  ))
    remove("image tags", ["rmi"], [image]);
}

/** Remove only explicitly owned containers, even when another project reuses this image. */
export function removeImageContainers(image, project, docker = dockerText) {
  const ids = docker(["ps", "-a", "--filter", `ancestor=${image}`, "--format", CONTAINER_FORMAT])
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((row) => row[0] && row[2] === image && containerRunProject(row) === project)
    .map(([id]) => id);
  if (ids.length > 0) docker(["rm", "-f", "-v", ...ids]);
}

/**
 * A deadline-killed `docker run` leaves a container on the run's image; remove the run's
 * own containers first and attempt every tag before reporting any failure.
 */
function removeRunImages(images, project) {
  const errors = [];
  for (const image of images) {
    if (!image) continue;
    try {
      const exists = execFileSync("docker", ["images", "-q", image], { encoding: "utf8" }).trim();
      if (!exists) continue;
      removeImageContainers(image, project);
      execFileSync("docker", ["rmi", image], { stdio: "pipe" });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

/** Docker label the dead-run reaper uses to attribute a container to its runner. */
const TEST_PROJECT_LABEL = "io.knowledge-base.test-project";

/**
 * R3-W1: the git-heavy suites (PR merge, change sets, push, smart HTTP) run
 * against the git the shipped images contain, not only the host's newer one.
 * Builds Dockerfile's `base` stage (the runner is FROM base, so this is the
 * runtime git layer) and copies its git binary, exec path and templates out.
 * Two logging wrappers make that copy the only git a suite can reach:
 * `bin/git` (first on PATH: the server, the tests and, through the server's
 * resolved git, the smart-HTTP backend) and `git-core/git` (the exec path's
 * git: receive-pack's children and the pre-receive hook, whose PATH git
 * prefixes with its exec path). Each logs `path <cmd>` or `core <name> <cmd>`
 * to `invocations.log`, which assertImageGitReached() checks after the run.
 * Debian git links only libc, zlib and pcre2, so it runs on any glibc host at
 * least as new as its symbols (2.38 for trixie). Every Docker step is bounded
 * by the build budget; the extraction container carries the runner label and
 * is removed by its known name whether or not its creation was acknowledged.
 */
export async function installImageGit({
  project,
  env,
  secrets,
  timeoutMs = BUILD_TIMEOUT_MS,
  run = runCaptured,
  cleanupRun = run,
}) {
  const image = `${project}-git`;
  const versionContainer = `${project}-git-version`;
  const container = `${project}-git`;
  const label = `${TEST_PROJECT_LABEL}=${project}`;
  const dir = buildArtifactPath("image-git", project);
  const deadline = Date.now() + Math.min(timeoutMs, BUILD_TIMEOUT_MS);
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("Image git extraction exceeded the build budget");
    return left;
  };
  const docker = (args) => run("docker", args, env, secrets, project, remaining());
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  try {
    await docker([
      "build",
      "--file",
      "Dockerfile",
      "--target",
      "base",
      "--label",
      label,
      "--tag",
      image,
      ".",
    ]);
    const expected = String(
      await docker([
        "run",
        "--rm",
        "--network=none",
        "--label",
        label,
        "--name",
        versionContainer,
        image,
        "git",
        "--version",
      ]),
    ).trim();
    // Cleanup below is registered by this known name before the create is sent.
    await docker(["create", "--label", label, "--name", container, image]);
    await docker(["cp", `${container}:/usr/bin/git`, join(dir, "git")]);
    await docker(["cp", `${container}:/usr/lib/git-core`, join(dir, "git-core")]);
    await docker(["cp", `${container}:/usr/share/git-core/templates`, join(dir, "templates")]);
    const q = (path) => `'${path}'`;
    const log = q(join(dir, "invocations.log"));
    const exports = `GIT_EXEC_PATH=${q(join(dir, "git-core"))} GIT_TEMPLATE_DIR=${q(join(dir, "templates"))}`;
    writeFileSync(
      join(dir, "bin", "git"),
      `#!/bin/sh\nprintf 'path %s\\n' "$1" >> ${log}\n${exports} exec ${q(join(dir, "git"))} "$@"\n`,
      { mode: 0o755 },
    );
    // The exec path's git and its dashed builtin links dispatch to the same binary.
    rmSync(join(dir, "git-core", "git"));
    writeFileSync(
      join(dir, "git-core", "git"),
      `#!/bin/sh\nname=\${0##*/}\nprintf 'core %s %s\\n' "$name" "$1" >> ${log}\ncase "$name" in git-*) set -- "\${name#git-}" "$@" ;; esac\n${exports} exec ${q(join(dir, "git"))} "$@"\n`,
      { mode: 0o755 },
    );
    const actual = execFileSync(join(dir, "bin", "git"), ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    if (actual !== expected)
      throw new Error(`The copied image git reports "${actual}", the image "${expected}".`);
    rmSync(join(dir, "invocations.log"), { force: true });
    process.stdout.write(`test-kb: running against the image's ${expected}\n`);
    return join(dir, "bin");
  } finally {
    // Cleanup must remain available after the suite cancellation signal fires.
    await removeOwnedDocker(
      cleanupRun,
      env,
      secrets,
      project,
      ["rm", "--force", versionContainer],
      "version container",
    );
    await removeOwnedDocker(
      cleanupRun,
      env,
      secrets,
      project,
      ["rm", "--force", container],
      "container",
    );
    await removeOwnedDocker(
      cleanupRun,
      env,
      secrets,
      project,
      ["image", "rm", "--force", image],
      "image",
    );
  }
}

/** Best effort with a bound; "already gone" is success, any other failure is reported. */
async function removeOwnedDocker(run, env, secrets, project, args, kind) {
  try {
    await run("docker", args, env, secrets, project, 60_000);
  } catch (error) {
    const text = `${error?.stderr ?? ""}${error?.message ?? ""}`;
    if (!/No such (container|image)/i.test(text))
      process.stderr.write(
        `test-kb: could not remove the image-git ${kind}: ${text.slice(0, 300)}\n`,
      );
  }
}

/** The suite's server, backend and hook really ran the copied git (R3-W1 review). */
export function assertImageGitReached(binDir, required) {
  const logPath = join(dirname(binDir), "invocations.log");
  const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
  const missing = required.filter((pattern) => !lines.some((line) => line.startsWith(pattern)));
  if (missing.length)
    throw new Error(
      `The image git was not reached by: ${missing.join(", ")} (logged: ${[...new Set(lines.filter(Boolean))].slice(0, 40).join("; ")})`,
    );
  process.stdout.write(`test-kb: image git reached by ${required.join(", ")}\n`);
}

export async function runCaptured(file, args, env, secrets, project, timeoutMs, signal) {
  let supervisor;
  let drainIncomplete = false;
  const groups = buildArtifactPath("build-groups", project);
  try {
    let out;
    if (
      existsSync(groups) &&
      readdirSync(groups).some((name) => name.startsWith("docker-") && name.endsWith(".json"))
    )
      throw Object.assign(
        new Error(
          "Previous Docker build drain is incomplete; retain the build namespace for inspection",
        ),
        { drainIncomplete: true },
      );
    mkdirSync(groups, { recursive: true });
    // Behavioral commands have no build deadline, but still own their descendants
    // until exit/cancellation. Synchronous exec blocked SIGINT and skipped cleanup.
    supervisor = createBuildSupervisor({
      timeoutMs: timeoutMs ?? null,
      groupDirectory: groups,
      signal,
    });
    out = (await supervisor.run(file, args, ROOT, { env, capture: true })).stdout;
    process.stdout.write(redactText(out, secrets));
    return out;
  } catch (error) {
    drainIncomplete = error.drainIncomplete === true;
    const combined = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message}`;
    process.stderr.write(redactText(combined, secrets));
    writeFailureArtifact(project, error, secrets);
    throw error;
  } finally {
    supervisor?.close();
    if (supervisor && !drainIncomplete) rmSync(groups, { recursive: true, force: true });
  }
}

/**
 * A supervised suite runs its real-process integration files under the native
 * supervisor and its mocked unit files under plain Vitest. The supervisor admits one
 * control connection from its own Node pid for its whole life and tears Node down
 * when that connection closes, so the supervised run needs a single long-lived worker
 * thread (no per-file isolation), which the mocked unit files cannot share.
 */
/**
 * V8 flags for an isolated-first invocation (NODE_OPTIONS, inherited by
 * Vitest's forked test process). Pinning the young generation small keeps its
 * one-time growth to V8's default maximum (tens of MiB, whatever the workload)
 * out of a cold-start RSS measurement; `--expose-gc` lets the measurement take
 * its baseline after a full collection, so start-up garbage that a later GC
 * returns cannot hide growth.
 */
export const ISOLATED_NODE_OPTIONS = "--max-semi-space-size=2 --expose-gc";

/**
 * The Vitest runs of a non-supervised suite, in order. Each `isolatedFirst`
 * file (which must also be in `include`) runs before everything else, alone,
 * in its own Vitest invocation (its own process tree), with
 * KB_TEST_ISOLATED_FILE naming it and ISOLATED_NODE_OPTIONS appended to
 * NODE_OPTIONS; the remaining includes run together after.
 */
export function vitestInvocations(suite) {
  const isolated = suite.isolatedFirst ?? [];
  for (const file of isolated)
    if (!suite.include.includes(file))
      throw new Error(`isolatedFirst file ${file} is not in the suite's include list`);
  const rest = suite.include.filter((pattern) => !isolated.includes(pattern));
  return [
    ...isolated.map((file) => ({
      include: [file],
      isolated: file,
      nodeOptions: ISOLATED_NODE_OPTIONS,
    })),
    ...(rest.length > 0 ? [{ include: rest }] : []),
  ];
}

export function splitSupervisedIncludes(include) {
  const supervised = include.filter((pattern) => pattern.endsWith(".integration.test.ts"));
  const plain = include.filter((pattern) => !pattern.endsWith(".integration.test.ts"));
  if (supervised.length === 0) throw new Error("A supervised suite needs an integration file.");
  return [supervised, plain];
}

/** Direct Node + one non-isolated thread keep the fence fd and the control connection. */
export function supervisedVitestArgv(nodePath) {
  return [
    "--",
    nodePath,
    join(ROOT, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    VITEST_CONFIG,
    "--pool=threads",
    "--maxWorkers=1",
    "--isolate=false",
  ];
}

export async function runSuite(name, suite = SUITES[name], options = {}) {
  if (!suite) throw new Error(`Unknown suite: ${name}`);
  if (
    options.buildTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.buildTimeoutMs) || options.buildTimeoutMs <= 0)
  )
    throw new Error("The build timeout must be a positive integer");
  const files = filesForSuite(suite, options.files ?? listIntegrationFiles());
  if (files.length === 0 && (suite.nodeTests?.length ?? 0) === 0 && !suite.playwright) {
    throw new Error(`Suite ${name} matched no tests.`);
  }
  // The model lane verifies its artifact before any build or test: missing or
  // tampered bytes fail here, never a skip.
  const modelPath = suite.qwenModel
    ? (await verifyModelArtifact((options.env ?? process.env).KB_QWEN_MODEL_PATH)).path
    : undefined;
  const gemmaPath = suite.qwenModel
    ? (
        await verifyModelArtifact(
          (options.env ?? process.env).KB_GEMMA_MODEL_PATH,
          loadArtifactIdentity(join(ROOT, "packages/api/src/lib/kb/fixtures/gemma-artifact.json")),
        )
      ).path
    : undefined;
  const ageDir = suite.age ? await resolveAgeDir(options.env ?? process.env) : undefined;
  const skipServices =
    options.buildOnly === true || options.skipServices === true || suite.services.length === 0;
  if (!skipServices) checkPrerequisites(options.prerequisites);
  else if (suite.requireDocker)
    checkPrerequisites({ git: false, ...(options.prerequisites ?? {}) });
  // A suite owns only its project. Other runs' abandoned fixtures belong to
  // their coordinator (`pnpm test:kb -- --reap-dead-runs`); shared-host tests
  // must never reap those resources as a side effect of running a suite.
  const project =
    options.project ??
    (options.buildOnly
      ? ((options.env ?? process.env).KB_TEST_PROJECT ?? "standalone")
      : `kb-test-${name}-${process.pid}-${randomBytes(3).toString("hex")}`);
  const secrets = {
    pgPassword: randomBytes(16).toString("hex"),
  };
  const secretList = Object.values(secrets);
  const { tz, pgTimeZone } = resolveTestTimeZones(options.env ?? process.env);
  const controller = new AbortController();
  const interrupt = (signal) => controller.abort(new Error(`test-kb interrupted by ${signal}`));
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const run = (...args) => {
    controller.signal.throwIfAborted();
    const [file, argv, env, secrets, project, timeout] = args;
    return runCaptured(file, argv, env, secrets, project, timeout, controller.signal);
  };
  let started = false;
  // Deployment images serve only this run's env; a build-only invocation has no consumer.
  const deploymentImages =
    name === "deployment" && !options.buildOnly
      ? {
          server: `${project}-server`,
          worker: `${project}-worker`,
        }
      : undefined;
  let built = false;
  let drainIncomplete = false;
  const suppliedModelImage = suite.qwenModel
    ? (options.env ?? process.env).KB_QWEN_IMAGE || undefined
    : undefined;
  const workerImage =
    name === "backup" || suite.qwenModel ? (suppliedModelImage ?? `${project}-worker`) : undefined;
  const ownsWorkerImage = workerImage !== undefined && !suppliedModelImage;
  const sshImage =
    usesSource(suite, "createSshFixture(") && !options.buildOnly
      ? `kb-mirror-ssh-fixture:${project}`
      : undefined;
  try {
    const childEnv = {
      ...process.env,
      // Asset-enabled cases opt in with their own in-process fixture settings.
      KB_ASSET_S3_ENABLED: "false",
      TZ: tz,
      KB_TEST_TZ: tz,
      KB_TEST_PG_TIMEZONE: pgTimeZone,
      KB_TEST_ID: project.replace(/[^a-z0-9]/g, "").slice(-8) || randomBytes(4).toString("hex"),
      KB_TEST_PROJECT: project,
      KB_TEST_SUITE: name,
    };
    delete childEnv.KB_TEST_ISOLATED_FILE;
    if (ageDir) childEnv.PATH = [ageDir, childEnv.PATH].filter(Boolean).join(delimiter);
    if (!skipServices) {
      started = true; // Own partial compose startup too, including interruption.
      const urls = await startServices(project, suite, secrets, pgTimeZone, run);
      controller.signal.throwIfAborted();
      childEnv.KB_TEST_PG_HOST = "127.0.0.1";
      if (urls.pgPort) {
        childEnv.KB_TEST_PG_PORT = urls.pgPort;
        childEnv.KB_TEST_PG_SUPERUSER_PASSWORD = secrets.pgPassword;
        secretList.push(secrets.pgPassword);
      }
      if (urls.redisPort) childEnv.KB_TEST_REDIS_URL = `redis://127.0.0.1:${urls.redisPort}`;
      delete childEnv.DATABASE_URL;
      delete childEnv.REDIS_URL;
    }
    if (files.length > 0 || suite.playwright) {
      if (deploymentImages) {
        for (const [role, image] of Object.entries(deploymentImages)) {
          childEnv[`KB_TEST_DEPLOYMENT_${role.toUpperCase()}_IMAGE`] = image;
          await run(
            "docker",
            [
              "build",
              "--file",
              role === "server" ? "Dockerfile" : "Dockerfile.worker",
              "--tag",
              image,
              ".",
            ],
            childEnv,
            secretList,
            project,
            Math.min(options.buildTimeoutMs ?? BUILD_TIMEOUT_MS, BUILD_TIMEOUT_MS),
          );
        }
        // The builds leave GBs of exported layers in the page cache. On ext4 (data=ordered)
        // the next container create's metadata fsync waits for that writeback, so the
        // suite's first bounded `docker run` would pay the build's I/O. Flush it here,
        // inside the build phase that caused it.
        await run(
          "sync",
          [],
          childEnv,
          secretList,
          project,
          Math.min(options.buildTimeoutMs ?? 600_000, 600_000),
        );
      }
      childEnv.KB_TEST_INCLUDE = suite.include.join("\n");
      if (ownsWorkerImage)
        await run(
          "docker",
          [
            "build",
            ...(suite.qwenModel
              ? ["--platform", nativeDockerPlatform().platform, "--target", "runner"]
              : []),
            "--file",
            "Dockerfile.worker",
            "--tag",
            workerImage,
            ".",
          ],
          childEnv,
          secretList,
          project,
          Math.min(options.buildTimeoutMs ?? BUILD_TIMEOUT_MS, BUILD_TIMEOUT_MS),
        );
      else if (suppliedModelImage)
        await run(
          "docker",
          ["image", "inspect", "--format", "{{.Id}}", suppliedModelImage],
          childEnv,
          secretList,
          project,
          10_000,
        );
      if (suite.qwenModel)
        await run(
          process.execPath,
          [join(ROOT, "scripts/build-embedding-runtime.mjs"), "--install"],
          childEnv,
          secretList,
          project,
          Math.min(options.buildTimeoutMs ?? BUILD_TIMEOUT_MS, BUILD_TIMEOUT_MS),
        );
      if (name === "mirror" || name === "entry-canary" || suite.qwenModel)
        await run(
          "pnpm",
          ["--filter", "worker", "build"],
          childEnv,
          secretList,
          project,
          Math.min(options.buildTimeoutMs ?? BUILD_TIMEOUT_MS, BUILD_TIMEOUT_MS),
        );
      if (modelPath) childEnv.KB_QWEN_MODEL_PATH = modelPath;
      if (gemmaPath) childEnv.KB_GEMMA_MODEL_PATH = gemmaPath;
      if (name === "git-push" || name === "entry-canary")
        await run(
          "pnpm",
          ["--filter", "server", "build"],
          childEnv,
          secretList,
          project,
          Math.min(options.buildTimeoutMs ?? BUILD_TIMEOUT_MS, BUILD_TIMEOUT_MS),
        );
      prepareBuildSources(name, project);
      for (const step of buildPrerequisites(name, suite, project)) {
        process.stdout.write(`test-kb: prebuild ${step.artifact} (outside Vitest)\n`);
        const output = await run(
          step.file,
          step.args,
          { ...childEnv, CARGO_TARGET_DIR: join(ROOT, "apps/cli/target") },
          secretList,
          project,
          // Fault probes may shorten only the build budget, never a Vitest deadline.
          Math.min(options.buildTimeoutMs ?? BUILD_TIMEOUT_MS, BUILD_TIMEOUT_MS),
        );
        if (step.artifact === "sdk-interop") {
          const artifacts = output
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          const test = artifacts.find(
            (artifact) =>
              artifact.reason === "compiler-artifact" &&
              artifact.target?.name === "sdk_interop" &&
              artifact.executable,
          );
          if (!test) throw new Error("cargo produced no SDK interop executable");
          writeFileSync(
            buildArtifactPath("sdk-interop.json", project),
            JSON.stringify({ executable: test.executable }),
          );
        }
      }
      built = true;
      if (options.buildOnly) return;
    }
    let imageGitBin;
    if (suite.imageGit && files.length > 0) {
      const imageGit = await installImageGit({
        project,
        env: childEnv,
        secrets: secretList,
        timeoutMs: options.buildTimeoutMs,
        run,
        cleanupRun: runCaptured,
      });
      childEnv.PATH = [imageGit, childEnv.PATH].filter(Boolean).join(delimiter);
      // Test wrappers assert they delegate to exactly this git (fixtures/git-wrapper.ts).
      childEnv.KB_TEST_IMAGE_GIT = join(imageGit, "git");
      imageGitBin = imageGit;
    }
    if (files.length > 0) {
      const vitest = (include, extraEnv = {}) =>
        run(
          "pnpm",
          ["exec", "vitest", "run", "--config", VITEST_CONFIG],
          { ...childEnv, ...extraEnv, KB_TEST_INCLUDE: include.join("\n") },
          secretList,
          project,
        );
      if (suite.supervised) {
        const [supervised, plain] = splitSupervisedIncludes(suite.include);
        if (plain.length > 0) await vitest(plain);
        const dataRoot = mkdtempSync(join(tmpdir(), "kb-git-http-"));
        try {
          // The data-volume skeleton init-kb-volumes.mjs provisions: the supervisor
          // opens <KB_DATA_ROOT>/repos/.private/server.fence and cannot create it.
          ensureKbDataSkeleton(dataRoot);
          await run(
            join(ROOT, "apps/server/native/kb-supervisor"),
            supervisedVitestArgv(process.execPath),
            {
              ...childEnv,
              KB_TEST_INCLUDE: supervised.join("\n"),
              KB_TEST_SUPERVISED: "1",
              KB_DATA_ROOT: dataRoot,
            },
            secretList,
            project,
          );
        } finally {
          rmSync(dataRoot, { recursive: true, force: true });
        }
      } else {
        for (const run of vitestInvocations(suite))
          await vitest(
            run.include,
            run.isolated
              ? {
                  KB_TEST_ISOLATED_FILE: run.isolated,
                  NODE_OPTIONS: [childEnv.NODE_OPTIONS, run.nodeOptions].filter(Boolean).join(" "),
                }
              : {},
          );
      }
    }
    if (imageGitBin) assertImageGitReached(imageGitBin, suite.imageGit.reached);
    if (options.buildOnly) return;
    if (suite.playwright) {
      const reportDir = mkdtempSync(join(tmpdir(), "kb-browser-report-"));
      const reportPath = join(reportDir, "report.json");
      try {
        await run(
          "pnpm",
          [
            "--filter",
            "web",
            "exec",
            "playwright",
            "test",
            "--config",
            join(ROOT, suite.playwright),
          ],
          { ...childEnv, KB_BROWSER_REPORT: reportPath },
          secretList,
          project,
        );
        if (!existsSync(reportPath))
          throw new Error("Playwright produced no JSON report; no browser tests ran.");
        const count = assertBrowserReport(JSON.parse(readFileSync(reportPath, "utf8")));
        process.stdout.write(`test-kb: ${count} browser tests passed\n`);
      } finally {
        rmSync(reportDir, { recursive: true, force: true });
      }
    }
    if (modelPath) await runImageSmoke({ modelPath, image: workerImage });
    if (gemmaPath)
      await runImageSmoke({
        modelPath: gemmaPath,
        image: workerImage,
        modelId: "embeddinggemma-2-q8_0",
        evidenceOut: (options.env ?? process.env).KB_GEMMA_EVIDENCE_OUT,
      });
    for (const nodeTest of suite.nodeTests ?? []) {
      if (!existsSync(join(ROOT, nodeTest))) throw new Error(`Missing node test ${nodeTest}`);
      await run(
        process.execPath,
        [...(nodeTest.endsWith(".ts") ? ["--import", "tsx"] : []), "--test", join(ROOT, nodeTest)],
        childEnv,
        secretList,
        project,
      );
    }
  } catch (error) {
    drainIncomplete = error.drainIncomplete === true;
    throw error;
  } finally {
    try {
      if (started) stopServices(project, secrets);
    } finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      const images = [];
      if (!drainIncomplete) {
        if (sshImage) images.push(sshImage);
        if (ownsWorkerImage && (!options.buildOnly || !built)) images.push(workerImage);
        images.push(...Object.values(deploymentImages ?? {}));
      }
      try {
        removeRunImages(images, project);
      } finally {
        if (!drainIncomplete && (!options.buildOnly || !built))
          rmSync(buildArtifactDirectory(project), { recursive: true, force: true });
      }
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = argv.filter((arg) => arg !== "--");
  if (args.includes("--reap-dead-runs")) {
    if (args.length !== 1)
      throw new Error("Coordinator cleanup must run alone: pnpm test:kb -- --reap-dead-runs");
    checkPrerequisites({ git: false });
    reapDeadRuns({ log: (message) => process.stdout.write(message) });
    return;
  }
  const buildOnly = argv.includes("--build-only");
  const name = resolveSuiteName(argv.filter((arg) => arg !== "--build-only"));
  assertSuiteCoverage();
  const names = name === "all" ? Object.keys(SUITES) : [name];
  for (const suiteName of names) await runSuite(suiteName, SUITES[suiteName], { buildOnly });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(redactText(error?.message ?? error));
    process.exit(1);
  });
}
