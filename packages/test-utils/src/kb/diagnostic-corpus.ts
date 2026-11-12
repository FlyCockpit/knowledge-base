/** Generate diagnostic defects at every input node, including every union branch. */
import { type SchemaNode, schemaDiagnostic } from "@knowledge-base/api/lib/kb/protocol/diagnostics";
import fixtures from "@knowledge-base/api/lib/kb/protocol/fixtures.json";
import artifact from "@knowledge-base/api/lib/kb/protocol/schema.json";

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const node = (v: unknown): SchemaNode => (typeof v === "boolean" || object(v) ? v : true);
type Defect = { label: string; value: unknown };
function sample(schema: SchemaNode, seed?: unknown): unknown {
  if (seed !== undefined && !schemaDiagnostic(schema, seed)) return seed;
  if (typeof schema === "boolean") return null;
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return sample(node(alternatives[0]));
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object" || object(schema.properties))
    return Object.fromEntries(
      Object.entries(object(schema.properties) ? schema.properties : {}).map(([key, sub]) => [
        key,
        sample(node(sub)),
      ]),
    );
  if (type === "array")
    return Array.from({ length: Math.max(1, Number(schema.minItems ?? 0)) }, () =>
      sample(node(schema.items)),
    );
  if (type === "integer" || type === "number") return Math.max(0, Number(schema.minimum ?? 0));
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (schema["x-kb-path"] || schema["x-kb-path-prefix"]) return "sample.md";
  if (schema["x-kb-iso-utc-instant"]) return "2026-01-01T00:00:00Z";
  if (schema["x-kb-base64-canonical"]) return "YQ==";
  if (typeof schema.pattern === "string") {
    const candidates = [
      "a".repeat(24),
      "00000000-0000-4000-8000-000000000001",
      "b".repeat(40),
      `sha256:${"c".repeat(64)}`,
      "fixture-idempotency-key-01",
      "sample",
      "sample.md",
      "YQ==",
    ];
    const matching = candidates.find((v) => !schemaDiagnostic(schema, v));
    if (matching !== undefined) return matching;
  }
  return "x".repeat(Math.max(1, Number(schema.minLength ?? 1)));
}
function* defects(schema: SchemaNode, seed: unknown, at = ""): Generator<Defect> {
  if (typeof schema === "boolean") return;
  const base = sample(schema, seed);
  yield { label: `${at}:wrong-type`, value: typeof base === "string" ? 1 : "wrong" };
  if (typeof schema.pattern === "string")
    yield { label: `${at}:invalid-pattern`, value: "!invalid!" };
  if (schema.enum || Object.hasOwn(schema, "const"))
    yield { label: `${at}:invalid-enum`, value: "invalid-variant" };
  for (const [min, max, kind] of [
    ["minLength", "maxLength", "string"],
    ["minItems", "maxItems", "array"],
    ["minimum", "maximum", "number"],
  ] as const) {
    for (const [key, delta] of [
      [min, -1],
      [max, 1],
    ] as const)
      if (typeof schema[key] === "number") {
        const size = schema[key] + delta;
        if (kind !== "number" && (size < 0 || size > 2_097_153)) continue;
        yield {
          label: `${at}:${key}`,
          value:
            kind === "string"
              ? "x".repeat(size)
              : kind === "array"
                ? Array.from({ length: size }, () => sample(node(schema.items)))
                : size,
        };
      }
  }
  for (const key of [
    "x-kb-utf8-max-bytes",
    "x-kb-json-encoded-max-bytes",
    "x-kb-json-depth-max",
    "x-kb-no-control-chars",
    "x-kb-metadata-text",
    "x-kb-path",
    "x-kb-path-prefix",
    "x-kb-iso-utc-instant",
    "x-kb-base64-canonical",
  ])
    if (schema[key] !== undefined) {
      let value: unknown = "\u0001";
      if (key === "x-kb-utf8-max-bytes")
        value = "é".repeat(Math.floor(Number(schema[key]) / 2) + 1);
      if (key === "x-kb-json-encoded-max-bytes")
        value = { payload: "x".repeat(Number(schema[key])) };
      if (key === "x-kb-json-depth-max") {
        value = 0;
        for (let i = 0; i <= Number(schema[key]); i++) value = { child: value };
      }
      yield { label: `${at}:${key}`, value };
    }
  if (object(schema.properties) && object(base)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      const present = { ...base, [key]: sample(node(sub), base[key]) };
      const { [key]: _omitted, ...absent } = present;
      yield { label: `${at}/${key}:missing`, value: absent };
      for (const defect of defects(node(sub), present[key], `${at}/${key}`))
        yield { ...defect, value: { ...present, [key]: defect.value } };
    }
    yield {
      label: `${at}:multiple-defects`,
      value: Object.fromEntries([
        ...Object.keys(schema.properties).map((key) => [key, null]),
        ["unknown", true],
      ]),
    };
    yield { label: `${at}:unknown`, value: { ...base, unknown: true } };
  }
  if (schema.items !== undefined && Array.isArray(base))
    for (const defect of defects(node(schema.items), base[0], `${at}/0`))
      yield { ...defect, value: [defect.value, ...base.slice(1)] };
  for (const keyword of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(schema[keyword])) {
      const branches = schema[keyword];
      if (keyword !== "allOf") yield { label: `${at}:invalid-union`, value: {} };
      for (const [index, branch] of branches.entries()) {
        const branchSeed = sample(node(branch), base);
        for (const defect of defects(node(branch), branchSeed, `${at}:${keyword}${index}`))
          yield {
            ...defect,
            value:
              keyword === "allOf" && object(base) && object(defect.value)
                ? { ...base, ...defect.value }
                : defect.value,
          };
      }
      if (keyword !== "allOf") {
        const values = branches.map((branch) => sample(node(branch)));
        if (values.every(object)) {
          const ambiguous = Object.fromEntries(
            Object.keys(Object.assign({}, ...values)).map((key) => [key, "!invalid!"]),
          );
          // Multiple defects across content branches, e.g. huge Markdown AND invalid uploadId.
          for (const [index, branch] of branches.entries())
            for (const defect of defects(node(branch), values[index], `${at}:ambiguous${index}`))
              if (object(defect.value))
                yield { ...defect, value: { ...ambiguous, ...defect.value } };
        }
      }
    }
  for (const keyword of ["if", "then", "else", "not"])
    if (schema[keyword] !== undefined)
      for (const defect of defects(node(schema[keyword]), base, `${at}:${keyword}`)) yield defect;
}
export function diagnosticCorpus() {
  return Object.entries(artifact.tools).flatMap(([tool, row]) => {
    const schema: SchemaNode = row.input;
    const fixture = fixtures.tools[tool as keyof typeof fixtures.tools];
    const seeds: unknown[] = [
      fixture.validInput,
      ...fixture.validInputVariants.map((v) => v.value),
    ];
    const seen = new Set<string>();
    return seeds.flatMap((seed) =>
      [...defects(schema, seed)]
        .filter((defect) => {
          const key = JSON.stringify(defect.value);
          if (!object(defect.value) || seen.has(key) || !schemaDiagnostic(schema, defect.value))
            return false;
          seen.add(key);
          return true;
        })
        .map((defect) => ({ tool, ...defect })),
    );
  });
}
