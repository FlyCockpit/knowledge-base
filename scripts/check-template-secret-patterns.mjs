import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const DOCKER_DEFAULT_SECRET_SHA256 =
  "7b392ad9b78b37bfede6f3c8d35f7a26c4f2641ebff21f7599b7fe2a6387fd9d";
const DATABASE_USERS = new Set(["postgres"]);
const DATABASE_PASSWORDS = new Set(["password", "test", "drill"]);
const DATABASE_PORTS = new Set(["", "5432", "55432"]);

// Exact path + complete-line digest: reviewed non-secret PEM syntax only.
const INERT_PRIVATE_KEY_LINES = new Set(
  [
    // Inert credential-detector/redaction fixture contains a marker and synthetic text only.
    [
      "apps/cli/crates/kb-local/src/sensitive_text.rs",
      "da2398ec7a7aefaa9617f05e4fa479e787763470fb8a61143e34b83f80227579",
    ],
    // Inert credential-detector/redaction fixture contains a marker and synthetic text only.
    [
      "apps/cli/crates/kb-local/src/sensitive_text.rs",
      "fde8b33924fbc4026d9c86a3eeee274a2a6bdc1242ba31ce4b83b5a0cec74167",
    ],
    // Inert credential-detector/redaction fixture contains a marker and synthetic text only.
    [
      "apps/cli/crates/kb-local/src/sensitive_text.rs",
      "19c99024ca7d90b3a64d0186884653fe41be9c2562d9d0d6fd11b9b24b36c3fa",
    ],
    // Inert credential-detector/redaction fixture contains a marker and synthetic text only.
    [
      "apps/cli/crates/kb-local/src/sensitive_text.rs",
      "0e57b5bc586d4579e74e4a9484d9aaf89e70f0555289613b1249af24045ebc55",
    ],
    // Inert credential-detector/redaction fixture contains a marker and synthetic text only.
    [
      "apps/cli/crates/kb-local/src/sensitive_text.rs",
      "a841636bfd50935a723714b34b3f8f742b5fa3d3427ca16693082bea293d9a52",
    ],
    // Inert credential-detector/redaction fixture contains a marker and synthetic text only.
    [
      "packages/api/src/lib/kb/chunk.test.ts",
      "40d1f19db60e7ae6faa16a21ad94dda50566485db6ef4e645e61dc3f4f67cf07",
    ],
    // Runtime PEM encoder template interpolates freshly generated key bytes; no stored private key.
    [
      "packages/api/src/lib/kb/deploy-key.ts",
      "f87c0d8c6ff976b74c74be8821322e114062f225d67b9e42e6e5f6134d5d2af1",
    ],
    // Inert credential-detector/redaction fixture contains a marker and synthetic text only.
    [
      "packages/api/src/lib/kb/redact-for-embed.test.ts",
      "6db42279bdf4a3757a80087b541a647beabe37c252aa683d72eba9d6726a4018",
    ],
    // Inert credential-detector/redaction fixture contains a marker and synthetic text only.
    [
      "packages/api/src/lib/kb/sensitive-text.test.ts",
      "a25d82fcff4519cdda2e09fcf891f07d77e8f51044e151960cb644c9c8d8ff50",
    ],
    // Inert credential-detector/redaction fixture contains a marker and synthetic text only.
    [
      "packages/api/src/routers/kb-mirror.test.ts",
      "ffe0dec501e7e3282e10ec37892982c72ced002de42edc41821aba0fdcb1ae86",
    ],
    // A PEM marker with 1000 repetitions of "opaque-canary", not key bytes.
    [
      "apps/cli/crates/kb-local/tests/chunks.rs",
      "e1cb1dad5d540c8a7cfb96dba32e54d930d92473e17297da20910053f4e9b8dd",
    ],
    // A PEM marker followed only by the literal "canary" for query rejection.
    [
      "apps/cli/crates/kb-local/tests/chunks.rs",
      "ddc03155f33ffc66842824b47ae995aaadb0c900863cd6b70ad8dd079dd5f7ee",
    ],
  ].map(([file, digest]) => `${file}:${digest}`),
);

const INERT_DATABASE_LINES = new Set(
  [
    // Intentionally unreachable port 1, invalid/invalid: tests boot rejection
    // before DB admission, without contacting a real database or using a secret.
    [
      "packages/test-utils/src/kb/deployment.integration.test.ts",
      "76bb7921565a9a3c4f03538aaf5a2849c0506289979e332be1ebd9d39abe913d",
    ],
  ].map(([file, digest]) => `${file}:${digest}`),
);

const INERT_APPLICATION_SECRET_LINES = new Set(
  [
    // Image smoke: a disposable per-run secret read from /dev/urandom into this
    // process's environment only; the line stores no value.
    ["scripts/image-smoke.sh", "3b874fd28c5647aba0d077091996ceaa02cf91875c353549638b4a457adee40a"],
  ].map(([file, digest]) => `${file}:${digest}`),
);

const PINNED_LINE_SETS = [
  ["database-credential", INERT_DATABASE_LINES],
  ["private-key", INERT_PRIVATE_KEY_LINES],
  ["application-secret", INERT_APPLICATION_SECRET_LINES],
];

const PATTERNS = [
  {
    kind: "application-secret",
    expression:
      "(^|[[:space:]])(BETTER_AUTH_SECRET|VAPID_PRIVATE_KEY)[[:space:]]*=[[:space:]]*[^[:space:]#]+",
  },
  {
    kind: "database-credential",
    expression:
      "DATABASE_URL[[:space:]]*=[[:space:]]*postgres(ql)?://[^[:space:]]+:[^[:space:]@]+@",
  },
  { kind: "private-key", expression: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function secretAssignments(line) {
  return [...line.matchAll(/\b(BETTER_AUTH_SECRET|VAPID_PRIVATE_KEY)\s*=\s*([^\s#]+)/g)].map(
    (match) => ({ key: match[1], value: match[2] }),
  );
}

function databasePlaceholders(line) {
  const matches = [...line.matchAll(/\bDATABASE_URL\s*=\s*(postgres(?:ql)?:\/\/[^\s`"'\\]+)/g)];
  if (matches.length === 0) return false;
  return matches.every((match) => databasePlaceholder(match[1] ?? ""));
}

function databasePlaceholder(value) {
  if (!value) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
    parsed.hostname === "localhost" &&
    DATABASE_USERS.has(parsed.username) &&
    DATABASE_PASSWORDS.has(parsed.password) &&
    DATABASE_PORTS.has(parsed.port) &&
    // The database name is product identity, not a credential. Permit one
    // ordinary local identifier so a rebrand does not require editing this
    // scanner, while retaining exact disposable host/user/password semantics.
    /^[A-Za-z0-9_-]+$/.test(parsed.pathname.slice(1)) &&
    !parsed.search &&
    !parsed.hash
  );
}

/**
 * These are semantic placeholders, not path/prefix exemptions. A matching
 * detector line is still rejected unless its value itself is one of the small,
 * documented non-credential forms below. The docker default is pinned by hash
 * so changing it requires an intentional review of this allowlist.
 */
function documentedSecretAssignment(file, assignment) {
  if (
    file === ".env.docker.defaults" &&
    assignment.key === "BETTER_AUTH_SECRET" &&
    sha256(assignment.value) === DOCKER_DEFAULT_SECRET_SHA256
  ) {
    return true;
  }
  if (assignment.key === "VAPID_PRIVATE_KEY" && assignment.value === "…") return true;
  if (assignment.key !== "BETTER_AUTH_SECRET") return false;
  return new Set([
    '"your-secret-min-32-chars"',
    "$(openssl",
    "<openssl",
    ["$", "{{server.BETTER_AUTH_SECRET}}"].join(""),
  ]).has(assignment.value);
}

export function isDocumentedPlaceholder(finding) {
  if (finding.kind === "database-credential") {
    return (
      INERT_DATABASE_LINES.has(`${finding.file}:${sha256(finding.text)}`) ||
      databasePlaceholders(finding.text)
    );
  }
  if (finding.kind === "private-key") {
    return INERT_PRIVATE_KEY_LINES.has(`${finding.file}:${sha256(finding.text)}`);
  }
  if (INERT_APPLICATION_SECRET_LINES.has(`${finding.file}:${sha256(finding.text)}`)) return true;
  const assignments = secretAssignments(finding.text);
  return (
    assignments.length > 0 &&
    assignments.every((assignment) => documentedSecretAssignment(finding.file, assignment))
  );
}

function parseGitGrep(output) {
  const findings = [];
  for (const entry of output.split("\n")) {
    if (!entry) continue;
    const match = /^([^:\n]+):(\d+):(.*)$/.exec(entry);
    if (!match) throw new Error("git grep returned an unreadable finding");
    const [, file, lineText, text] = match;
    const line = Number(lineText);
    if (!file || text === undefined) continue;
    if (!Number.isInteger(line) || line < 1) {
      throw new Error("git grep returned an unreadable line number");
    }
    findings.push({ file, line, text });
  }
  return findings;
}

function scanPattern(pattern) {
  const result = spawnSync("git", ["grep", "-n", "-E", "-e", pattern.expression, "--", "."], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `could not run the tracked-file template secret scan (${result.error?.code ?? result.status ?? "unknown"})`,
    );
  }
  return parseGitGrep(result.stdout).map((finding) => ({ ...finding, kind: pattern.kind }));
}

export function collectResidualFindings(findings) {
  return findings.filter((finding) => !isDocumentedPlaceholder(finding));
}

/**
 * A pinned line whose source moved or disappeared is a stale exemption: it no
 * longer documents anything, and it would silently re-admit that exact line in
 * that file later. Every pin must match exactly one current scanner finding.
 */
export function collectStalePins(findings) {
  const stale = [];
  for (const [kind, pins] of PINNED_LINE_SETS) {
    const seen = new Map();
    for (const finding of findings) {
      if (finding.kind !== kind) continue;
      const key = `${finding.file}:${sha256(finding.text)}`;
      if (pins.has(key)) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const pin of pins)
      if (seen.get(pin) !== 1) stale.push({ kind, pin, count: seen.get(pin) ?? 0 });
  }
  return stale;
}

function selfTest() {
  // These landed fixtures contain no usable secret: an unreachable database
  // endpoint, synthetic redaction canaries and a runtime-generated secret.
  // Pin complete lines, never files.
  for (const [fixtureFile, kind, needle] of [
    [
      "packages/test-utils/src/kb/deployment.integration.test.ts",
      "database-credential",
      "invalid:invalid",
    ],
    [
      "apps/cli/crates/kb-local/tests/chunks.rs",
      "private-key",
      ["-----BEGIN", " PRIVATE KEY-----"].join(""),
    ],
    ["scripts/image-smoke.sh", "application-secret", '="$(head -c 48 /dev/urandom'],
  ]) {
    const lines = readFileSync(new URL(fixtureFile, ROOT), "utf8")
      .split("\n")
      .filter((line) => line.includes(needle));
    if (lines.length !== (kind === "private-key" ? 2 : 1))
      throw new Error("fixture inventory drift");
    for (const line of lines) {
      const finding = { file: fixtureFile, line: 1, text: line, kind };
      if (collectResidualFindings([finding]).length !== 0)
        throw new Error("inert landed fixture must pass");
      for (const changed of [
        { ...finding, file: "unreviewed.ts" },
        { ...finding, text: `${line} changed-material` },
      ]) {
        if (collectResidualFindings([changed]).length !== 1)
          throw new Error("fixture exemption widened");
      }
    }
  }
  // Reviewed inert PEM markers must be exact-line exceptions, not exemptions
  // for a directory, file, key type, or a marker followed by arbitrary bytes.
  const file = "packages/api/src/lib/kb/sensitive-text.test.ts";
  const marker = ["-----BEGIN RSA", " PRIVATE KEY-----"].join("");
  const text = readFileSync(new URL(file, ROOT), "utf8")
    .split("\n")
    .find((line) => line.includes(marker));
  if (!text) throw new Error("missing inert credential-detector fixture");
  const inert = { file, line: 1, text, kind: "private-key" };
  if (collectResidualFindings([inert]).length !== 0)
    throw new Error("reviewed inert marker must pass");
  for (const changed of [
    { ...inert, file: "unreviewed.ts" },
    { ...inert, text: `${text} extra-material` },
    { ...inert, text: marker },
  ]) {
    if (collectResidualFindings([changed]).length !== 1)
      throw new Error("unreviewed private-key occurrence must fail");
  }
  const database = ["post", "gresql://postgres:password@localhost:5432/knowledge_base"].join("");
  const authKey = ["BETTER_AUTH", "_SECRET"].join("");
  const vapidKey = ["VAPID_PRIVATE", "_KEY"].join("");
  const assignment = (key, value) => [key, "=", value].join("");
  const safe = [
    {
      file: ".env.example",
      line: 1,
      text: `DATABASE_URL=${database}`,
      kind: "database-credential",
    },
    {
      file: ".env.example",
      line: 2,
      text: `DATABASE_URL=${database.replace("knowledge_base", "renamed_app")}`,
      kind: "database-credential",
    },
    {
      file: ".env.docker.defaults",
      line: 1,
      text: assignment(
        authKey,
        ["docker_dev_placeholder_do_not_use_in_production_", "1234567890abcdef"].join(""),
      ),
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 1,
      text: assignment(authKey, '"your-secret-min-32-chars"'),
      kind: "application-secret",
    },
    { file: "README.md", line: 1, text: assignment(vapidKey, "…"), kind: "application-secret" },
  ];
  if (collectResidualFindings(safe).length !== 0) {
    throw new Error("documented semantic placeholders should be accepted");
  }
  const unsafe = safe.concat([
    {
      file: "example.example",
      line: 2,
      text: `DATABASE_URL=${database.replace("password", "not-a-placeholder")}`,
      kind: "database-credential",
    },
    {
      file: "example.example",
      line: 3,
      text: `${`DATABASE_URL=${database.replace("knowledge_base", "renamed_app?sslmode=require")}`}`,
      kind: "database-credential",
    },
    {
      file: ".env.docker.defaults",
      line: 2,
      text: assignment(authKey, "changed-value"),
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 2,
      text: assignment(vapidKey, "not-a-placeholder"),
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 3,
      text: `DATABASE_URL=${database} ${assignment(authKey, "not-a-placeholder")}`,
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 4,
      text: `DATABASE_URL=${database} ${["-----BE", "GIN PRIVATE KEY-----"].join("")}`,
      kind: "private-key",
    },
    {
      file: "README.md",
      line: 5,
      text: `${assignment(authKey, '"your-secret-min-32-chars"')} ${assignment(authKey, "not-a-placeholder")}`,
      kind: "application-secret",
    },
    {
      file: "README.md",
      line: 6,
      text: `DATABASE_URL=${database} DATABASE_URL=${database.replace("password", "not-a-placeholder")}`,
      kind: "database-credential",
    },
  ]);
  if (collectResidualFindings(unsafe).length !== 8) {
    throw new Error(
      "each matched credential occurrence must satisfy its own semantic placeholder check",
    );
  }
  // A pin must fail the scan once its line is gone or duplicated, so a removed
  // fixture cannot leave a silent exemption behind.
  const pinned = { file: "scripts/image-smoke.sh", line: 1, kind: "application-secret" };
  pinned.text = readFileSync(new URL(pinned.file, ROOT), "utf8")
    .split("\n")
    .find((line) => line.includes('="$(head -c 48 /dev/urandom'));
  const present = (extra) =>
    collectStalePins(extra).filter(({ pin }) => pin.startsWith(`${pinned.file}:`));
  if (present([pinned]).length !== 0) throw new Error("present pin reported stale");
  if (present([]).length !== 1) throw new Error("removed pinned line must be reported stale");
  if (present([pinned, pinned]).length !== 1)
    throw new Error("duplicated pinned line must be reported");
  console.log("template secret-pattern self-test OK");
}

function main() {
  const findings = PATTERNS.flatMap(scanPattern);
  const stale = collectStalePins(findings);
  for (const { kind, pin, count } of stale) {
    console.error(
      `::error::Stale ${kind} pin ${pin} matches ${count} tracked line(s); expected exactly 1. Remove or re-review it.`,
    );
  }
  const residual = collectResidualFindings(findings);
  if (residual.length > 0) {
    for (const finding of residual) {
      console.error(`::error file=${finding.file},line=${finding.line}::Potential ${finding.kind}`);
    }
    console.error(
      "::error::Potential private secret committed. Rotate the secret and remove it from git history if it was real.",
    );
    process.exit(1);
  }
  if (stale.length > 0) process.exit(1);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  main();
}
