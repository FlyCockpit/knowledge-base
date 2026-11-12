import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KB_TOOL_NAMES } from "../packages/api/src/lib/kb/protocol/catalog.js";
import { kbReadToolSchemas } from "../packages/api/src/lib/kb/protocol/reads.js";
import { kbWriteToolSchemas } from "../packages/api/src/lib/kb/protocol/writes.js";
import { checkDocCitations } from "./check-doc-citations.js";
import {
  checkKbProtocolArtifacts,
  generateKbProtocolArtifacts,
  writeKbProtocolArtifacts,
} from "./generate-kb-protocol.js";
import { assertNoUndeclaredRefinements, zodToJsonSchema } from "./lib/zod-json-schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(ROOT, "packages/api/src/lib/kb/protocol/schema.json");

test("generator is deterministic", () => {
  const first = generateKbProtocolArtifacts();
  const second = generateKbProtocolArtifacts();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("write twice yields byte-identical artifacts", () => {
  const trackedSchema = readFileSync(SCHEMA_PATH, "utf8");
  const directory = mkdtempSync(join(tmpdir(), "kb-protocol-test-"));
  try {
    writeKbProtocolArtifacts(directory);
    const schemaOnce = readFileSync(join(directory, "schema.json"), "utf8");
    writeKbProtocolArtifacts(directory);
    const schemaTwice = readFileSync(join(directory, "schema.json"), "utf8");
    assert.equal(schemaOnce, schemaTwice);
    assert.equal(readFileSync(SCHEMA_PATH, "utf8"), trackedSchema);
    assert.equal(checkKbProtocolArtifacts(directory), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("check fails when generated artifacts drift", () => {
  const trackedSchema = readFileSync(SCHEMA_PATH, "utf8");
  const directory = mkdtempSync(join(tmpdir(), "kb-protocol-test-"));
  try {
    writeKbProtocolArtifacts(directory);
    const original = readFileSync(join(directory, "schema.json"), "utf8");
    writeFileSync(join(directory, "schema.json"), `${original}\n`);
    assert.equal(checkKbProtocolArtifacts(directory), false);
    writeFileSync(join(directory, "schema.json"), original);
    const fixturesPath = join(directory, "fixtures.json");
    rmSync(fixturesPath);
    assert.equal(checkKbProtocolArtifacts(directory), false);
    writeKbProtocolArtifacts(directory);
    assert.equal(readFileSync(SCHEMA_PATH, "utf8"), trackedSchema);
    assert.equal(checkKbProtocolArtifacts(directory), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("request-metadata schema drift fails the generator check", () => {
  const directory = mkdtempSync(join(tmpdir(), "kb-protocol-meta-test-"));
  try {
    writeKbProtocolArtifacts(directory);
    const path = join(directory, "schema.json");
    const artifact = JSON.parse(readFileSync(path, "utf8")) as {
      requestMeta: { properties: Record<string, unknown> };
    };
    assert.ok(artifact.requestMeta.properties["io.modelcontextprotocol/related-task"]);
    delete artifact.requestMeta.properties["io.modelcontextprotocol/related-task"];
    writeFileSync(path, JSON.stringify(artifact));
    assert.equal(checkKbProtocolArtifacts(directory), false);
    const cases = generateKbProtocolArtifacts().fixtures.requestMetadata;
    for (const value of [5, { taskId: 1 }]) {
      const row = cases.find(
        (row) =>
          JSON.stringify(row.value) ===
          JSON.stringify({ "io.modelcontextprotocol/related-task": value }),
      );
      assert.equal(row?.valid, false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every declared refinement in the tool trees passes the contract audit", () => {
  for (const group of [kbReadToolSchemas, kbWriteToolSchemas]) {
    for (const tool of Object.values(group)) {
      assertNoUndeclaredRefinements(tool.input);
      assertNoUndeclaredRefinements(tool.output);
    }
  }
});

test("a refinement without an exported contract fails generation instead of being silently dropped", () => {
  const mutated = kbWriteToolSchemas.knowledge_bases_create.input.refine(() => false);
  assert.throws(() => assertNoUndeclaredRefinements(mutated), /no exported validation contract/);
  assert.throws(() => zodToJsonSchema(mutated), /no exported validation contract/);
});

test("contract payloads flow into the emitted JSON Schema", () => {
  const declared = zodToJsonSchema(kbReadToolSchemas.knowledge_structured_search.input) as Record<
    string,
    unknown
  >;
  assert.deepEqual(declared["x-kb-iso-range"], {
    after: "timestamp.after",
    before: "timestamp.before",
  });
  assert.ok(Array.isArray(declared.anyOf));
  assert.ok(declared.anyOf.length > 0);
});

// Task 68: examples are literal protocol fixtures, checked against live schemas.
const OPERATOR_DOCS = [
  "README.md",
  "SECURITY.md",
  "AGENTS.md",
  "sitemap.md",
  "apps/cli/README.md",
  "apps/cli/AGENTS.md",
  "apps/cli/SECURITY.md",
  "apps/cli/docs/adding-tokio.md",
  "apps/cli/docs/adding-sqlite.md",
  "docs/product.md",
  "docs/access-matrix.md",
  "docs/hosting.md",
  ...[
    "mcp",
    "git",
    "assets",
    "embeddings",
    "deploy",
    "backup-restore",
    "cli",
    "cockpit-adapter",
  ].map((name) => `docs/${name}.md`),
];
const doc = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("operator examples use shared fixtures and input/output schemas, including empty/default and primary actions", () => {
  const fixtures = JSON.parse(doc("packages/api/src/lib/kb/protocol/fixtures.json")) as {
    tools: Record<
      string,
      {
        validInput: unknown;
        validOutput: unknown;
        validInputVariants: Array<{ value: unknown }>;
        validOutputVariants: Array<{ value: unknown }>;
      }
    >;
  };
  const examples = new Set<string>();
  const boundaryExamples = new Set<string>();
  for (const path of OPERATOR_DOCS) {
    for (const match of doc(path).matchAll(
      /```json kb\/1 (knowledge_\w+) (input|output)\n([\s\S]*?)\n```/g,
    )) {
      const name = match[1] ?? "";
      const direction = match[2] as "input" | "output";
      const value: unknown = JSON.parse(match[3] ?? "");
      const schemas = { ...kbReadToolSchemas, ...kbWriteToolSchemas };
      const schema = schemas[name as keyof typeof schemas];
      assert.ok(schema, `${path}: unknown tool ${name}`);
      schema[direction].parse(value);
      const fixture = fixtures.tools[name];
      assert.ok(fixture);
      const candidates =
        direction === "input"
          ? [fixture.validInput, ...fixture.validInputVariants.map((variant) => variant.value)]
          : [fixture.validOutput, ...fixture.validOutputVariants.map((variant) => variant.value)];
      assert.ok(
        candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)),
        `${path}: ${name} ${direction} must come from a shared fixture`,
      );
      examples.add(`${name} ${direction}`);
      if (name === "knowledge_bases_list" && direction === "input") {
        if (JSON.stringify(value) === "{}") boundaryExamples.add("default-list-input");
      }
      if (name === "knowledge_bases_list" && direction === "output") {
        const page = kbReadToolSchemas.knowledge_bases_list.output.parse(value);
        if (page.items.length === 0 && page.nextCursor === null)
          boundaryExamples.add("empty-list-output");
      }
      if (name === "knowledge_changes_apply" && direction === "output") {
        const result = kbWriteToolSchemas.knowledge_changes_apply.output.parse(value);
        if (result.kind === "noop")
          boundaryExamples.add(result.proposal === null ? "main-noop" : "proposal-noop");
      }
    }
  }
  for (const example of [
    "knowledge_bases_list input",
    "knowledge_bases_list output",
    "knowledge_documents_get input",
    "knowledge_changes_apply input",
    "knowledge_changes_apply output",
    "knowledge_export_complete input",
  ])
    assert.ok(examples.has(example), `missing example ${example}`);
  for (const boundary of ["default-list-input", "empty-list-output", "main-noop", "proposal-noop"])
    assert.ok(boundaryExamples.has(boundary), `missing boundary example ${boundary}`);
});

test("operator guide links the complete live catalog, schema and access matrix", () => {
  const guide = doc("docs/mcp.md");
  for (const target of ["mcp-tool-coverage.md", "schema.json", "access-matrix.md"])
    assert.ok(guide.includes(target), target);
  const coverage = doc("docs/mcp-tool-coverage.md");
  const names = [...coverage.matchAll(/^\| (knowledge_\w+) \|/gm)].map((match) => match[1]);
  assert.deepEqual(names.toSorted(), [...KB_TOOL_NAMES].toSorted());
});

test("authored operator docs have no retired template, token, worker, rank or merge advice", () => {
  for (const path of OPERATOR_DOCS) {
    const text = doc(path);
    for (const pattern of [
      /SYSTEM_QWEN/,
      /KB_MCP_ENABLED/,
      /ADMIN_EMAILS/,
      /\/api\/(?:assets|images)\//,
      /1\s*\/\s*\(60\s*\+\s*rank0\)/,
      /(?:use|run)\s+git push[^\n]*--force/i,
      /token as (?:the )?username/i,
      /embedded worker/i,
      /(?:commercial template|starter branding|template.*(?:synchronous|baseline|forked))/i,
      /cross-compilation Just Works/i,
    ])
      assert.doesNotMatch(text, pattern, path);
  }
});

test("operator safety documents preserve private grants, fenced restore and host-only resolution", () => {
  assert.match(doc("docs/mcp.md"), /expanded grant.*∩.*expanded live/);
  assert.match(doc("docs/git.md"), /single-ref.*fast-forward/);
  assert.match(doc("docs/git.md"), /clean divergent/i);
  assert.match(doc("docs/backup-restore.md"), /revoke.*OAuth.*PAT.*device.*browser/i);
  assert.match(
    doc("docs/backup-restore.md"),
    /empty.*database.*data volume.*empty or skeleton-only/is,
  );
  assert.match(doc("docs/cockpit-adapter.md"), /plaintext\s+never[^.]*tool/i);
  assert.match(doc("docs/cockpit-adapter.md"), /DreamOutcome::advances_consumer_ledger\(\)/);
  assert.match(doc("docs/cockpit-adapter.md"), /only `Applied` and main `Noop` return true/);
  assert.match(doc("docs/cockpit-adapter.md"), /consumer ledger deferred until merge/);
  assert.match(doc("docs/cli.md"), /state\.sqlite[^.]*not disposable/i);
});

test("model documentation pins artifacts and separates host evidence from architecture execution", () => {
  const text = doc("docs/embeddings.md");
  const artifacts = JSON.parse(doc("packages/api/src/lib/kb/fixtures/builtin-models.json")) as {
    models: Array<{ sha256: string }>;
  };
  for (const artifact of artifacts.models) assert.ok(text.includes(artifact.sha256));
  for (const term of [
    "3.22.2",
    "4096",
    "1024",
    "1/(60+rank1)",
    "child exits",
    "Node26",
    "host spike",
    "arm64",
    "not executed",
  ])
    assert.ok(text.includes(term), term);
});

test("citation checker includes new docs, notes and CLI relative links without weakening errors", () => {
  const root = mkdtempSync(join(tmpdir(), "kb-doc-scope-"));
  try {
    for (const path of ["docs/mcp.md", "docs/hosting.md", "apps/cli/README.md"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "[Missing](./missing.md)\n");
    }
    const result = checkDocCitations({ root });
    assert.equal(result.errors.length, 3, result.errors.join("\n"));
    assert.equal(result.docLinkCount, 3);
    assert.equal(result.warnings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
