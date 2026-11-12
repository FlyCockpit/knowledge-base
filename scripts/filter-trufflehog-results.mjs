import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fail-closed post-filter for TruffleHog JSON results. Removes only five
 * immutable, independently demonstrated inert template fixtures: two original
 * placeholders on baseline commit 71f54c... and three mocked test URLs on
 * commit 2a434e.... Every other finding, malformed line, verified result, or
 * scanner operational error still fails the gate. Never logs
 * Raw/Decoded/VerificationError payloads.
 */

export const HISTORICAL_COMMIT = "71f54c29777f0bf37f54ca0def7337b3d54e07a9";
// Immutable historical evidence; deleting the old runtime does not change PR-range findings.
export const HISTORICAL_FILE = "scripts/db-applier.sh";
export const HISTORICAL_DETECTOR_TYPE = 968;
export const HISTORICAL_DETECTOR_NAME = "Postgres";
export const HISTORICAL_RAW_LENGTH = 36;
export const HISTORICAL_RAW_SHA256 =
  "ff1ab345f59fa395fbc844310efbb00fcaadf9f0dfc1c6bdaacfebedd3c7a8c8";

/** Exact demonstrated (decoder, line) pairs — not independent sets. */
export const HISTORICAL_IDENTITIES = [
  { decoder: "HTML", line: 315 },
  { decoder: "PLAIN", line: 318 },
];

const FIXTURE_COMMIT = "2a434e63deee048231a094b140af7ebc5bae90b5";
const FIXTURE_RAW_LENGTH = 45;
const FIXTURE_DETECTOR_TYPE = 968;
const FIXTURE_DETECTOR_NAME = "Postgres";
const SECRET_REPRESENTATION_FIELDS = ["Raw", "RawV2", "Decoded"];

/**
 * Complete exact identities, not independently matchable fields. The three
 * current-commit entries are non-networked test fixtures observed in the
 * immutable PR range; the source now assembles them from fragments, but the
 * committed finding remains reachable to a PR-range scan. Do not add a path,
 * test, example, hash-only, or decoder-only exemption here.
 */
export const REVIEWED_INERT_IDENTITIES = [
  ...HISTORICAL_IDENTITIES.map(({ decoder, line }) => ({
    commit: HISTORICAL_COMMIT,
    file: HISTORICAL_FILE,
    line,
    decoder,
    detectorType: HISTORICAL_DETECTOR_TYPE,
    detectorName: HISTORICAL_DETECTOR_NAME,
    rawLength: HISTORICAL_RAW_LENGTH,
    rawSha256: HISTORICAL_RAW_SHA256,
  })),
  {
    commit: FIXTURE_COMMIT,
    file: "packages/api/src/lib/backup-freshness.test.ts",
    line: 13,
    decoder: "PLAIN",
    detectorType: FIXTURE_DETECTOR_TYPE,
    detectorName: FIXTURE_DETECTOR_NAME,
    rawLength: FIXTURE_RAW_LENGTH,
    rawSha256: "69397108ae1557d85e033b68a251f559cc82b25be80da38d28b93d3b8ef8cfc6",
  },
  {
    commit: FIXTURE_COMMIT,
    file: "scripts/test-backup-writer.mjs",
    line: 28,
    decoder: "PLAIN",
    detectorType: FIXTURE_DETECTOR_TYPE,
    detectorName: FIXTURE_DETECTOR_NAME,
    rawLength: FIXTURE_RAW_LENGTH,
    rawSha256: "10418e4a0b488906e6fed6caa3642791718ec9c7886bccf4b2a88db89d5da8fd",
  },
  {
    commit: FIXTURE_COMMIT,
    file: "scripts/test-db-applier-state-machine.mjs",
    line: 7,
    decoder: "PLAIN",
    detectorType: FIXTURE_DETECTOR_TYPE,
    detectorName: FIXTURE_DETECTOR_NAME,
    rawLength: FIXTURE_RAW_LENGTH,
    rawSha256: "10418e4a0b488906e6fed6caa3642791718ec9c7886bccf4b2a88db89d5da8fd",
  },
];

/** Synthetic sentinel used only in tests — must never appear in failure output. */
export const TEST_RAW_SENTINEL = "SYNTHETIC_TRUFFLEHOG_RAW_SENTINEL_VALUE";

/**
 * Reconstruct the known template placeholder from non-triggering fragments so
 * committed fixtures do not contain a contiguous scanner-triggering URL.
 */
export function buildPlaceholderRaw() {
  const scheme = ["post", "gresql", "://"].join("");
  const user = ["user", ":"].join("");
  const secret = ["pass", "word"].join("");
  const host = ["@", "host", ":"].join("");
  const port = "5432";
  return `${scheme}${user}${secret}${host}${port}`;
}

/** Builds the observed API-test fixture without committing a contiguous URL. */
function buildFreshnessFixtureRaw() {
  return ["post", "gresql://reader:", "inert@db.example.com:5432"].join("");
}

/** Builds the observed mock-orchestration fixture without committing a URL. */
function buildMockFixtureRaw() {
  return ["post", "gresql://inert:", "inert@mock-db.example:5432"].join("");
}

/**
 * @param {unknown} value
 */
function rawSha256(value) {
  if (typeof value !== "string") return null;
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {Record<string, unknown>} result
 */
function structuredConnectionStringAgrees(result, identity) {
  const secretParts = result.SecretParts;
  if (secretParts === undefined || secretParts === null) return false;
  if (typeof secretParts !== "object" || Array.isArray(secretParts)) return false;
  const keys = Object.keys(secretParts);
  if (keys.length !== 1 || keys[0] !== "connection_string") return false;
  const connectionString = /** @type {Record<string, unknown>} */ (secretParts).connection_string;
  if (typeof connectionString !== "string" || connectionString.length === 0) return false;
  if (connectionString.length !== identity.rawLength) return false;
  return rawSha256(connectionString) === identity.rawSha256;
}

function secretRepresentationsAgree(result, identity) {
  if (!structuredConnectionStringAgrees(result, identity)) return false;
  // Preserve the original two historical identities exactly: their established
  // matcher accepts any nonempty Raw/RawV2/Decoded representation that agrees
  // with their pinned bytes. The newer observed records have a narrower,
  // explicitly evidenced Raw + RawV2 shape below.
  if (identity.commit === HISTORICAL_COMMIT) {
    /** @type {string[]} */
    const present = [];
    for (const field of SECRET_REPRESENTATION_FIELDS) {
      const value = result[field];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string") return false;
      present.push(value);
    }
    if (present.length === 0) return false;
    return present.every(
      (value) => value.length === identity.rawLength && rawSha256(value) === identity.rawSha256,
    );
  }
  // The pinned scanner output has exactly Raw, RawV2, and SecretParts. An
  // additional decoded representation is a different finding, not an excuse
  // to broaden this fixture-only exception.
  if (result.Decoded !== undefined && result.Decoded !== null) return false;
  for (const field of ["Raw", "RawV2"]) {
    const value = result[field];
    if (typeof value !== "string") return false;
    if (value.length !== identity.rawLength || rawSha256(value) !== identity.rawSha256) {
      return false;
    }
  }
  return true;
}

/**
 * @param {Record<string, unknown>} result
 */
function reviewedIdentityFor(result) {
  const git = result.SourceMetadata?.Data?.Git;
  if (!git || typeof git !== "object") return undefined;
  return REVIEWED_INERT_IDENTITIES.find(
    (identity) =>
      git.commit === identity.commit &&
      git.file === identity.file &&
      git.line === identity.line &&
      result.DecoderName === identity.decoder &&
      result.DetectorType === identity.detectorType &&
      result.DetectorName === identity.detectorName,
  );
}

/**
 * @param {Record<string, unknown>} result
 */
export function isHistoricalTemplatePlaceholder(result) {
  const identity = reviewedIdentityFor(result);
  if (!identity) return false;
  const verified = result.Verified;
  const verificationError = result.VerificationError;

  if (verified !== false) return false;
  if (typeof verificationError !== "string" || verificationError.length === 0) {
    return false;
  }
  return secretRepresentationsAgree(result, identity);
}

/**
 * @param {unknown[]} results
 */
export function filterTrufflehogResults(results) {
  if (!Array.isArray(results)) {
    throw new Error("TruffleHog output is not a JSON array");
  }
  return results.filter((result) => !isHistoricalTemplatePlaceholder(result));
}

/**
 * @param {string} text
 */
export function parseTrufflehogJsonLines(text) {
  /** @type {unknown[]} */
  const results = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("TruffleHog JSON parse error");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("TruffleHog JSON line is not an object");
    }
    results.push(parsed);
  }
  return results;
}

/**
 * @param {unknown[]} remaining
 */
export function formatResidualSummary(remaining) {
  return remaining.map((result, index) => {
    const record = /** @type {Record<string, unknown>} */ (result);
    const metadata = /** @type {Record<string, unknown> | undefined} */ (record.SourceMetadata);
    const data = /** @type {Record<string, unknown> | undefined} */ (metadata?.Data);
    const git = /** @type {Record<string, unknown> | undefined} */ (data?.Git);
    const file = typeof git?.file === "string" ? git.file : "unknown";
    const line = typeof git?.line === "number" ? git.line : "unknown";
    const detector = record.DetectorName ?? "unknown";
    const verified = record.Verified === true ? "verified" : "unverified";
    const raw = record.Raw ?? record.RawV2;
    const hash = typeof raw === "string" ? rawSha256(raw) : "unknown";
    return `${index + 1}. ${detector} ${verified} ${file}:${line} sha256=${hash}`;
  });
}

const BASELINE_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/trufflehog-historical-baseline.jsonl",
);

/**
 * @param {Record<string, unknown>} record
 */
function hydrateBaselineRecord(record) {
  const raw = buildPlaceholderRaw();
  return {
    ...record,
    Raw: raw,
    RawV2: raw,
    SecretParts: { connection_string: raw },
  };
}

async function loadBaselineRecords() {
  const text = await readFile(process.env.TRUFFLEHOG_BASELINE_FIXTURE ?? BASELINE_FIXTURE, "utf8");
  return parseTrufflehogJsonLines(text).map((record) =>
    hydrateBaselineRecord(/** @type {Record<string, unknown>} */ (record)),
  );
}

/** @param {(typeof REVIEWED_INERT_IDENTITIES)[number]} identity */
function buildReviewedFixtureRecord(identity) {
  const raw =
    identity.file === "packages/api/src/lib/backup-freshness.test.ts"
      ? buildFreshnessFixtureRaw()
      : buildMockFixtureRaw();
  if (raw.length !== identity.rawLength || rawSha256(raw) !== identity.rawSha256) {
    throw new Error("reviewed fixture source no longer matches its exact identity");
  }
  return {
    SourceMetadata: {
      Data: {
        Git: { commit: identity.commit, file: identity.file, line: identity.line },
      },
    },
    DetectorType: identity.detectorType,
    DetectorName: identity.detectorName,
    DecoderName: identity.decoder,
    Verified: false,
    VerificationError: "inert fixture is not externally verified",
    Raw: raw,
    RawV2: raw,
    SecretParts: { connection_string: raw },
  };
}

async function loadReviewedRecords() {
  const baseline = await loadBaselineRecords();
  const currentFixtures = REVIEWED_INERT_IDENTITIES.slice(HISTORICAL_IDENTITIES.length).map(
    buildReviewedFixtureRecord,
  );
  return [...baseline, ...currentFixtures];
}

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} overrides
 */
function withOverrides(base, overrides) {
  return { ...base, ...overrides };
}

function assertNoSecretSentinels(text) {
  const forbidden = [TEST_RAW_SENTINEL, "postgresql://", "USER:PASSWORD", "user:password"];
  for (const needle of forbidden) {
    if (text.includes(needle)) {
      throw new Error(`failure output leaked forbidden sentinel: ${needle.slice(0, 8)}…`);
    }
  }
}

async function selfTest() {
  const baseline = await loadBaselineRecords();
  if (baseline.length !== 2) {
    throw new Error(`expected exactly 2 baseline records, got ${baseline.length}`);
  }
  const reviewed = await loadReviewedRecords();
  if (reviewed.length !== REVIEWED_INERT_IDENTITIES.length) {
    throw new Error(`expected exactly ${REVIEWED_INERT_IDENTITIES.length} reviewed records`);
  }
  const html = /** @type {Record<string, unknown>} */ (reviewed[0]);
  const plain = /** @type {Record<string, unknown>} */ (reviewed[1]);
  const currentFixture = /** @type {Record<string, unknown>} */ (reviewed[2]);

  for (const [index, record] of reviewed.entries()) {
    if (!isHistoricalTemplatePlaceholder(record)) {
      throw new Error(`expected reviewed inert identity ${index + 1} to match`);
    }
  }
  if (filterTrufflehogResults(reviewed).length !== 0) {
    throw new Error("expected all five reviewed inert fixtures to be filtered");
  }

  const swappedHtmlOnPlain = withOverrides(plain, {
    DecoderName: "HTML",
    SourceMetadata: {
      Data: { Git: { commit: HISTORICAL_COMMIT, file: HISTORICAL_FILE, line: 318 } },
    },
  });
  if (filterTrufflehogResults([swappedHtmlOnPlain]).length !== 1) {
    throw new Error("swapped HTML decoder on PLAIN line should remain");
  }

  const swappedPlainOnHtml = withOverrides(html, {
    DecoderName: "PLAIN",
    SourceMetadata: {
      Data: { Git: { commit: HISTORICAL_COMMIT, file: HISTORICAL_FILE, line: 315 } },
    },
  });
  if (filterTrufflehogResults([swappedPlainOnHtml]).length !== 1) {
    throw new Error("swapped PLAIN decoder on HTML line should remain");
  }

  const divergentRawV2 = withOverrides(html, {
    RawV2: `${"y".repeat(HISTORICAL_RAW_LENGTH)}`,
  });
  if (filterTrufflehogResults([divergentRawV2]).length !== 1) {
    throw new Error("divergent RawV2 should remain");
  }

  const divergentDecoded = withOverrides(html, {
    Decoded: `${"z".repeat(HISTORICAL_RAW_LENGTH)}`,
  });
  if (filterTrufflehogResults([divergentDecoded]).length !== 1) {
    throw new Error("divergent Decoded should remain");
  }

  const missingRaw = withOverrides(html, { Raw: "", RawV2: "" });
  if (filterTrufflehogResults([missingRaw]).length !== 1) {
    throw new Error("missing secret representations should remain");
  }

  const divergentConnectionString = withOverrides(html, {
    SecretParts: { connection_string: `${"w".repeat(HISTORICAL_RAW_LENGTH)}` },
  });
  if (filterTrufflehogResults([divergentConnectionString]).length !== 1) {
    throw new Error("divergent SecretParts.connection_string should remain");
  }

  const invalidSecretPartsShapes = [
    ["absent", { SecretParts: undefined }],
    ["null", { SecretParts: null }],
    ["array", { SecretParts: [] }],
    ["emptyObject", { SecretParts: {} }],
    ["nullConnectionString", { SecretParts: { connection_string: null } }],
    ["emptyConnectionString", { SecretParts: { connection_string: "" } }],
    ["nonStringConnectionString", { SecretParts: { connection_string: 1 } }],
    [
      "extraKey",
      {
        SecretParts: {
          connection_string: buildPlaceholderRaw(),
          extra: "field",
        },
      },
    ],
  ];
  for (const [label, override] of invalidSecretPartsShapes) {
    const mutated = withOverrides(html, override);
    if (isHistoricalTemplatePlaceholder(mutated)) {
      throw new Error(`invalid SecretParts shape ${label} should not match`);
    }
    if (filterTrufflehogResults([mutated]).length !== 1) {
      throw new Error(`invalid SecretParts shape ${label} should remain`);
    }
  }

  const numericVerificationError = withOverrides(html, { VerificationError: 1 });
  if (isHistoricalTemplatePlaceholder(numericVerificationError)) {
    throw new Error("numeric VerificationError should not match");
  }
  if (filterTrufflehogResults([numericVerificationError]).length !== 1) {
    throw new Error("numeric VerificationError should remain");
  }

  const objectVerificationError = withOverrides(html, { VerificationError: { message: "x" } });
  if (isHistoricalTemplatePlaceholder(objectVerificationError)) {
    throw new Error("object VerificationError should not match");
  }
  if (filterTrufflehogResults([objectVerificationError]).length !== 1) {
    throw new Error("object VerificationError should remain");
  }

  const mutations = [
    [
      "commit",
      {
        SourceMetadata: { Data: { Git: { commit: "deadbeef", file: HISTORICAL_FILE, line: 315 } } },
      },
    ],
    [
      "file",
      {
        SourceMetadata: {
          Data: { Git: { commit: HISTORICAL_COMMIT, file: "other.sh", line: 315 } },
        },
      },
    ],
    [
      "line",
      {
        SourceMetadata: {
          Data: { Git: { commit: HISTORICAL_COMMIT, file: HISTORICAL_FILE, line: 999 } },
        },
      },
    ],
    ["decoder", { DecoderName: "BASE64" }],
    ["detectorType", { DetectorType: 999 }],
    ["detectorName", { DetectorName: "Other" }],
    ["verified", { Verified: true }],
    ["missingVerificationError", { VerificationError: "" }],
    [
      "connectionString",
      { SecretParts: { connection_string: `${"w".repeat(HISTORICAL_RAW_LENGTH)}` } },
    ],
    ["numericVerificationError", { VerificationError: 1 }],
    ["objectVerificationError", { VerificationError: { message: "x" } }],
    ["rawLength", { Raw: `${"x".repeat(HISTORICAL_RAW_LENGTH)}extra` }],
    ["rawHash", { Raw: "x".repeat(HISTORICAL_RAW_LENGTH) }],
    [
      "pathPrefix",
      {
        SourceMetadata: {
          Data: { Git: { commit: HISTORICAL_COMMIT, file: `evil/${HISTORICAL_FILE}`, line: 315 } },
        },
      },
    ],
  ];
  for (const [label, override] of mutations) {
    const mutated = withOverrides(html, override);
    if (filterTrufflehogResults([mutated]).length !== 1) {
      throw new Error(`mutation ${label} should remain`);
    }
  }

  const currentFixtureMutations = [
    [
      "currentCommit",
      {
        SourceMetadata: {
          Data: {
            Git: {
              commit: "0".repeat(40),
              file: "packages/api/src/lib/backup-freshness.test.ts",
              line: 13,
            },
          },
        },
      },
    ],
    [
      "currentPath",
      {
        SourceMetadata: {
          Data: { Git: { commit: FIXTURE_COMMIT, file: "other.test.ts", line: 13 } },
        },
      },
    ],
    [
      "currentLine",
      {
        SourceMetadata: {
          Data: {
            Git: {
              commit: FIXTURE_COMMIT,
              file: "packages/api/src/lib/backup-freshness.test.ts",
              line: 14,
            },
          },
        },
      },
    ],
    ["currentDecoder", { DecoderName: "HTML" }],
    ["currentDetectorType", { DetectorType: 999 }],
    ["currentDetectorName", { DetectorName: "Other" }],
    ["currentVerified", { Verified: true }],
    ["currentVerificationError", { VerificationError: "" }],
    ["currentDecodedRepresentation", { Decoded: buildFreshnessFixtureRaw() }],
    ["currentRaw", { Raw: "x".repeat(FIXTURE_RAW_LENGTH) }],
    [
      "crossedCurrentFixture",
      {
        Raw: reviewed[3].Raw,
        RawV2: reviewed[3].RawV2,
        SecretParts: reviewed[3].SecretParts,
      },
    ],
  ];
  for (const [label, override] of currentFixtureMutations) {
    if (filterTrufflehogResults([withOverrides(currentFixture, override)]).length !== 1) {
      throw new Error(`current fixture mutation ${label} should remain`);
    }
  }

  parseTrufflehogJsonLines(`${JSON.stringify(html)}\n`);
  let threw = false;
  try {
    parseTrufflehogJsonLines("{not json");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected malformed JSON line to throw");

  const summary = formatResidualSummary([withOverrides(html, { Verified: true })]).join("\n");
  assertNoSecretSentinels(summary);
  if (!summary.includes("sha256=")) {
    throw new Error("expected metadata-only residual summary to include a hash");
  }

  console.log("filter-trufflehog-results self-test OK");
}

async function cliIntegrationTest() {
  const script = new URL(import.meta.url).pathname;
  const reviewed = await loadReviewedRecords();
  const stdin = `${reviewed.map((record) => JSON.stringify(record)).join("\n")}\n`;

  const pass = spawnSync(process.execPath, [script], {
    input: stdin,
    encoding: "utf8",
  });
  if (pass.status !== 0) {
    throw new Error(`stdin CLI pass path failed with status ${pass.status ?? "unknown"}`);
  }
  assertNoSecretSentinels(`${pass.stdout}${pass.stderr}`);

  const currentFixtureVerified = spawnSync(process.execPath, [script], {
    input: `${JSON.stringify(withOverrides(reviewed[2], { Verified: true }))}\n`,
    encoding: "utf8",
  });
  if (currentFixtureVerified.status !== 1) {
    throw new Error(
      `verified current fixture should fail with exit 1, got ${currentFixtureVerified.status ?? "unknown"}`,
    );
  }
  assertNoSecretSentinels(`${currentFixtureVerified.stdout}${currentFixtureVerified.stderr}`);

  const fail = spawnSync(process.execPath, [script], {
    input: `${JSON.stringify(withOverrides(reviewed[0], { Verified: true }))}\n`,
    encoding: "utf8",
  });
  if (fail.status !== 1) {
    throw new Error(`verified finding should fail with exit 1, got ${fail.status ?? "unknown"}`);
  }
  assertNoSecretSentinels(`${fail.stdout}${fail.stderr}`);
  if (!fail.stderr.includes("sha256=")) {
    throw new Error("expected metadata-only residual summary on stderr");
  }

  const divergentConnectionString = spawnSync(process.execPath, [script], {
    input: `${JSON.stringify(
      withOverrides(reviewed[0], {
        SecretParts: { connection_string: `${"w".repeat(HISTORICAL_RAW_LENGTH)}` },
      }),
    )}\n`,
    encoding: "utf8",
  });
  if (divergentConnectionString.status !== 1) {
    throw new Error(
      `divergent SecretParts.connection_string should fail with exit 1, got ${
        divergentConnectionString.status ?? "unknown"
      }`,
    );
  }
  assertNoSecretSentinels(`${divergentConnectionString.stdout}${divergentConnectionString.stderr}`);

  const cliInvalidSecretPartsShapes = [
    ["absent", { SecretParts: undefined }],
    ["null", { SecretParts: null }],
    ["array", { SecretParts: [] }],
    ["emptyObject", { SecretParts: {} }],
    ["nullConnectionString", { SecretParts: { connection_string: null } }],
    ["emptyConnectionString", { SecretParts: { connection_string: "" } }],
    ["nonStringConnectionString", { SecretParts: { connection_string: 1 } }],
    [
      "extraKey",
      {
        SecretParts: {
          connection_string: buildPlaceholderRaw(),
          extra: "field",
        },
      },
    ],
  ];
  for (const [label, override] of cliInvalidSecretPartsShapes) {
    const result = spawnSync(process.execPath, [script], {
      input: `${JSON.stringify(withOverrides(reviewed[0], override))}\n`,
      encoding: "utf8",
    });
    if (result.status !== 1) {
      throw new Error(
        `invalid SecretParts shape ${label} should fail with exit 1, got ${
          result.status ?? "unknown"
        }`,
      );
    }
    assertNoSecretSentinels(`${result.stdout}${result.stderr}`);
  }

  const numericVerificationError = spawnSync(process.execPath, [script], {
    input: `${JSON.stringify(withOverrides(reviewed[0], { VerificationError: 1 }))}\n`,
    encoding: "utf8",
  });
  if (numericVerificationError.status !== 1) {
    throw new Error(
      `numeric VerificationError should fail with exit 1, got ${
        numericVerificationError.status ?? "unknown"
      }`,
    );
  }
  assertNoSecretSentinels(`${numericVerificationError.stdout}${numericVerificationError.stderr}`);

  const malformed = spawnSync(process.execPath, [script], {
    input: "{not-json\n",
    encoding: "utf8",
  });
  if (malformed.status !== 1) {
    throw new Error(`malformed JSON should fail with exit 1, got ${malformed.status ?? "unknown"}`);
  }
  assertNoSecretSentinels(`${malformed.stdout}${malformed.stderr}`);

  console.log("filter-trufflehog-results CLI integration test OK");
}

function createFakeDockerScript() {
  const dir = mkdtempSync(join(tmpdir(), "trufflehog-fake-docker-"));
  const fakeDocker = join(dir, "docker");
  const script = `#!/usr/bin/env bash
set -euo pipefail
mode="\${FAKE_DOCKER_TRUFFLEHOG_MODE:-}"
output_file="\${FAKE_DOCKER_TRUFFLEHOG_OUTPUT:-}"
args_file="\${FAKE_DOCKER_TRUFFLEHOG_ARGS:-}"
if [ -n "$args_file" ]; then
  printf '%s\\n' "$@" > "$args_file"
fi
case "$mode" in
  exit0_empty)
    exit 0
    ;;
  exit183_valid)
    if [ -n "$output_file" ] && [ -f "$output_file" ]; then
      cat "$output_file"
    fi
    exit 183
    ;;
  exit183_empty)
    exit 183
    ;;
  exit42_garbage)
    echo "scanner operational failure"
    exit 42
    ;;
  exit42_with_json)
    if [ -n "$output_file" ] && [ -f "$output_file" ]; then
      cat "$output_file"
    fi
    exit 42
    ;;
  *)
    echo "unknown fake docker mode: $mode" >&2
    exit 99
    ;;
esac
`;
  writeFileSync(fakeDocker, script, "utf8");
  chmodSync(fakeDocker, 0o755);
  return { dir, fakeDocker };
}

/**
 * @param {Record<string, string>} env
 * @param {number} expectedExit
 * @param {string} label
 */
function gitCommit(revision) {
  const result = spawnSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    encoding: "utf8",
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not resolve inert wrapper-test commit ${revision}`);
  }
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("wrapper-test commit was not a lowercase full SHA");
  }
  return commit;
}

function runWrapper(env, expectedExit, label, base, head) {
  const result = spawnSync("bash", ["scripts/trufflehog-pr-scan.sh", base, head], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  });
  if (result.status !== expectedExit) {
    throw new Error(
      `${label}: expected exit ${expectedExit}, got ${result.status ?? "unknown"} (stderr: ${result.stderr.slice(0, 200)})`,
    );
  }
  assertNoSecretSentinels(`${result.stdout}${result.stderr}`);
}

async function wrapperIntegrationTest() {
  const { dir } = createFakeDockerScript();
  const reviewed = await loadReviewedRecords();
  const validOutput = join(dir, "valid.jsonl");
  const argsOutput = join(dir, "args.txt");
  writeFileSync(validOutput, `${reviewed.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const pathPrefix = `${dir}:${process.env.PATH ?? ""}`;
  const baseEnv = {
    PATH: pathPrefix,
    TRUFFLEHOG_WRAPPER_SELF_TEST: "1",
    FAKE_DOCKER_TRUFFLEHOG_OUTPUT: validOutput,
    FAKE_DOCKER_TRUFFLEHOG_ARGS: argsOutput,
  };
  const head = gitCommit("HEAD");
  const base = gitCommit("HEAD^");

  try {
    runWrapper(
      { ...baseEnv, FAKE_DOCKER_TRUFFLEHOG_MODE: "exit0_empty" },
      0,
      "exit 0 clean",
      base,
      head,
    );
    runWrapper(
      { ...baseEnv, FAKE_DOCKER_TRUFFLEHOG_MODE: "exit183_valid" },
      0,
      "exit 183 valid",
      base,
      head,
    );
    runWrapper(
      { ...baseEnv, FAKE_DOCKER_TRUFFLEHOG_MODE: "exit183_empty" },
      1,
      "exit 183 empty",
      base,
      head,
    );
    runWrapper(
      { ...baseEnv, FAKE_DOCKER_TRUFFLEHOG_MODE: "exit42_garbage" },
      42,
      "exit 42 garbage",
      base,
      head,
    );
    runWrapper(
      { ...baseEnv, FAKE_DOCKER_TRUFFLEHOG_MODE: "exit42_with_json" },
      42,
      "exit 42 with json",
      base,
      head,
    );

    const scannerArgs = readFileSync(argsOutput, "utf8");
    if (!scannerArgs.includes("--results=verified,unverified,unknown,filtered_unverified")) {
      throw new Error("wrapper must request every TruffleHog result class");
    }

    runWrapper(
      { ...baseEnv, FAKE_DOCKER_TRUFFLEHOG_MODE: "exit0_empty" },
      1,
      "invalid base commit fails before scanner",
      "0".repeat(40),
      head,
    );
    runWrapper(
      { ...baseEnv, FAKE_DOCKER_TRUFFLEHOG_MODE: "exit0_empty" },
      1,
      "empty commit range fails before scanner",
      head,
      head,
    );

    const overrideAttempt = spawnSync("bash", ["scripts/trufflehog-pr-scan.sh", base, head], {
      env: {
        ...process.env,
        ...baseEnv,
        FAKE_DOCKER_TRUFFLEHOG_MODE: "exit42_garbage",
        TRUFFLEHOG_FINDINGS_EXIT: "invalid",
        TRUFFLEHOG_IMAGE: "example.invalid/scanner:latest",
      },
      encoding: "utf8",
      cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    });
    if (overrideAttempt.status !== 42) {
      throw new Error(
        `override attempt should still fail on operational exit 42, got ${overrideAttempt.status ?? "unknown"}`,
      );
    }
    assertNoSecretSentinels(`${overrideAttempt.stdout}${overrideAttempt.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("trufflehog-pr-scan wrapper integration test OK");
}

if (process.argv[1]?.endsWith("filter-trufflehog-results.mjs")) {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    process.exit(0);
  }
  if (process.argv.includes("--cli-test")) {
    await selfTest();
    await cliIntegrationTest();
    await wrapperIntegrationTest();
    process.exit(0);
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");
  const remaining = filterTrufflehogResults(parseTrufflehogJsonLines(input));
  if (remaining.length > 0) {
    for (const line of formatResidualSummary(remaining)) {
      console.error(line);
    }
    process.exit(1);
  }
}
