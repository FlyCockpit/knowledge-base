/** Selection contract: docs/mcp.md. Walk the artifact, never validator issues. */
import { casefoldPathKey, normalizeKbPath } from "../paths";
import { compareIsoUtc, parseIsoUtcParts } from "./common";

export type SchemaNode = boolean | { [key: string]: unknown };
export type SchemaDiagnostic = {
  path: string[];
  keyword: string;
  member?: string;
  min?: number;
  max?: number;
};
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const node = (v: unknown): SchemaNode => (typeof v === "boolean" || object(v) ? v : false);
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
};
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const control = (value: string, allowWhitespace: boolean) =>
  [...value].some(
    (c) => c.charCodeAt(0) < 32 && !(allowWhitespace && [9, 10, 13].includes(c.charCodeAt(0))),
  );
const depth = (v: unknown): number =>
  v !== null && typeof v === "object" ? 1 + Math.max(-1, ...Object.values(v).map(depth)) : 0;
const types: Record<string, (v: unknown) => boolean> = {
  object,
  array: Array.isArray,
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
};
function select(
  v: unknown,
  selector: string,
  path: string[] = [],
): { value: unknown; path: string[] }[] {
  if (!selector) return [{ value: v, path }];
  const [head, ...tail] = selector.split(".");
  const key = head?.endsWith("[]") ? head.slice(0, -2) : head;
  if (object(v) && key && Object.hasOwn(v, key)) {
    const child = v[key];
    if (head?.endsWith("[]"))
      return Array.isArray(child)
        ? child.flatMap((value, i) => select(value, tail.join("."), [...path, key, String(i)]))
        : [];
    return select(child, tail.join("."), [...path, key]);
  }
  return [];
}
/** First violation, in the canonical keyword and traversal order. */
export function schemaDiagnostic(
  schema: SchemaNode,
  value: unknown,
  path: string[] = [],
): SchemaDiagnostic | null {
  const fail = (keyword: string, member?: string): SchemaDiagnostic => ({
    path,
    keyword,
    ...(member === undefined ? {} : { member }),
  });
  if (schema === true) return null;
  if (schema === false) return fail("false");
  const bounds = (keyword: string, minKey: string, maxKey: string): SchemaDiagnostic => ({
    ...fail(keyword),
    ...(Number.isSafeInteger(schema[minKey]) ? { min: Number(schema[minKey]) } : {}),
    ...(Number.isSafeInteger(schema[maxKey]) ? { max: Number(schema[maxKey]) } : {}),
  });
  const declaredTypes = Array.isArray(schema.type)
    ? schema.type
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  if (
    declaredTypes.length &&
    !declaredTypes.some((t) => typeof t === "string" && types[t]?.(value))
  )
    return fail("type");
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength)
      return bounds("minLength", "minLength", "maxLength");
    if (typeof schema.maxLength === "number" && length > schema.maxLength)
      return bounds("maxLength", "minLength", "maxLength");
    if (
      typeof schema["x-kb-utf8-max-bytes"] === "number" &&
      Buffer.byteLength(value) > schema["x-kb-utf8-max-bytes"]
    )
      return fail("x-kb-utf8-max-bytes");
    if (schema["x-kb-no-control-chars"] && control(value, true))
      return fail("x-kb-no-control-chars");
    if (
      schema["x-kb-metadata-text"] &&
      (value.includes(String.fromCharCode(127)) ||
        control(value, schema["x-kb-metadata-text"] !== "name"))
    )
      return fail("x-kb-metadata-text");
    const b64 = schema["x-kb-base64-canonical"];
    if (object(b64)) {
      const decoded = Buffer.from(value, "base64");
      if (
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
        decoded.toString("base64") !== value ||
        decoded.length < Number(b64.minBytes) ||
        decoded.length > Number(b64.maxBytes)
      )
        return fail("x-kb-base64-canonical");
    }
    if (schema["x-kb-path"] && !normalizeKbPath(value).ok) return fail("x-kb-path");
    if (
      schema["x-kb-path-prefix"] &&
      !normalizeKbPath(value.endsWith("/") ? value.slice(0, -1) : value).ok
    )
      return fail("x-kb-path-prefix");
    if (schema["x-kb-iso-utc-instant"] && !parseIsoUtcParts(value))
      return fail("x-kb-iso-utc-instant");
  }
  if (value !== null && typeof value === "object") {
    if (
      typeof schema["x-kb-json-encoded-max-bytes"] === "number" &&
      Buffer.byteLength(JSON.stringify(value)) > schema["x-kb-json-encoded-max-bytes"]
    )
      return fail("x-kb-json-encoded-max-bytes");
    if (
      typeof schema["x-kb-json-depth-max"] === "number" &&
      depth(value) > schema["x-kb-json-depth-max"]
    )
      return fail("x-kb-json-depth-max");
    const range = schema["x-kb-iso-range"];
    if (object(range)) {
      const a = select(value, String(range.after))[0]?.value;
      const b = select(value, String(range.before))[0]?.value;
      if (
        a !== undefined &&
        b !== undefined &&
        (typeof a !== "string" || typeof b !== "string" || compareIsoUtc(a, b) !== -1)
      )
        return fail("x-kb-iso-range");
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => equal(v, value))) return fail("enum");
  if (Object.hasOwn(schema, "const") && !equal(schema.const, value)) return fail("const");
  if (
    typeof value === "string" &&
    typeof schema.pattern === "string" &&
    !new RegExp(schema.pattern).test(value)
  )
    return bounds("pattern", "minLength", "maxLength");
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return bounds("minimum", "minimum", "maximum");
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return bounds("maximum", "minimum", "maximum");
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      return bounds("minItems", "minItems", "maxItems");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      return bounds("maxItems", "minItems", "maxItems");
    if (schema.items !== undefined)
      for (const [i, child] of value.entries()) {
        const issue = schemaDiagnostic(node(schema.items), child, [...path, String(i)]);
        if (issue) return issue;
      }
  } else if (object(value)) {
    const properties = object(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(properties).sort())
      if (Object.hasOwn(value, key)) {
        const issue = schemaDiagnostic(node(properties[key]), value[key], [...path, key]);
        if (issue) return issue;
      }
    if (Array.isArray(schema.required))
      for (const key of schema.required)
        if (typeof key === "string" && !Object.hasOwn(value, key)) return fail("required", key);
    for (const key of Object.keys(value).sort())
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false)
          return fail("additionalProperties", /^[A-Za-z0-9_]{1,64}$/.test(key) ? key : undefined);
        if (object(schema.additionalProperties)) {
          const issue = schemaDiagnostic(schema.additionalProperties, value[key], [...path, "*"]);
          if (issue) return issue;
        }
      }
    if (
      schema.propertyNames !== undefined &&
      Object.keys(value)
        .sort()
        .some((key) => schemaDiagnostic(node(schema.propertyNames), key, path))
    )
      return fail("propertyNames");
  }
  // A selected branch owns its bounds. A constraint on a value declared by
  // the parent is a refinement, and cannot introduce another bound owner.
  const owned = (issue: SchemaDiagnostic | null): SchemaDiagnostic | null => {
    if (!issue || issue.path.length <= path.length) return issue;
    let owner: SchemaNode = schema;
    for (const segment of issue.path.slice(path.length)) {
      if (!object(owner)) return issue;
      owner = node(
        /^\d+$/.test(segment)
          ? owner.items
          : object(owner.properties)
            ? owner.properties[segment]
            : undefined,
      );
    }
    if (!object(owner)) return issue;
    const { min: _min, max: _max, ...rest } = issue;
    return rest;
  };
  const union = (options: unknown[], keyword: string): SchemaDiagnostic | null => {
    const issues = options.map((s) => schemaDiagnostic(node(s), value, path));
    const passes = issues.filter((v) => v === null).length;
    if ((keyword === "anyOf" && passes > 0) || (keyword === "oneOf" && passes === 1)) return null;
    if (passes > 1) return fail(keyword);
    const selected = options.findIndex(
      (s) =>
        object(s) &&
        object(s.properties) &&
        Object.values(s.properties).some((p) => object(p) && Object.hasOwn(p, "const")) &&
        Object.entries(s.properties).every(
          ([key, p]) =>
            !object(p) ||
            !Object.hasOwn(p, "const") ||
            (object(value) && equal(value[key], p.const)),
        ),
    );
    if (selected >= 0) return issues[selected]!;
    let best: SchemaDiagnostic | null = null;
    for (const issue of issues)
      if (
        issue &&
        issue.path.join("/").length > path.join("/").length &&
        (!best || issue.path.join("/").length > best.path.join("/").length)
      )
        best = issue;
    return best ? owned(best) : fail(keyword);
  };
  if (Array.isArray(schema.anyOf)) {
    const issue = union(schema.anyOf, "anyOf");
    if (issue) return issue;
  }
  if (Array.isArray(schema.allOf))
    for (const sub of schema.allOf) {
      const issue = owned(schemaDiagnostic(node(sub), value, path));
      if (issue) return issue;
    }
  if (Array.isArray(schema.oneOf)) {
    const issue = union(schema.oneOf, "oneOf");
    if (issue) return issue;
  }
  if (schema.not !== undefined && !schemaDiagnostic(node(schema.not), value, path))
    return fail("not");
  if (schema.if !== undefined) {
    const branch = !schemaDiagnostic(node(schema.if), value, path) ? schema.then : schema.else;
    if (branch !== undefined) {
      const issue = owned(schemaDiagnostic(node(branch), value, path));
      if (issue) return issue;
    }
  }
  for (const keyword of ["x-kb-unique-items", "x-kb-change-paths"]) {
    const selectors = schema[keyword];
    if (Array.isArray(selectors))
      for (const selector of selectors) {
        const seen = new Set<unknown>();
        const written = new Set<string>();
        for (const item of select(value, String(selector))) {
          let identity: unknown;
          if (keyword === "x-kb-change-paths") {
            if (!object(item.value) || typeof item.value.path !== "string") continue;
            identity = `${item.value.op === "assetPut" || item.value.op === "assetRemove" ? "asset" : "document"}:${item.value.path}`;
            const folded = casefoldPathKey(item.value.path);
            const removal = item.value.op === "delete" || item.value.op === "assetRemove";
            if (!removal && written.has(folded))
              return { path: [...path, ...item.path, "path"], keyword };
            if (!removal) written.add(folded);
          } else identity = item.value;
          if (seen.has(identity))
            return {
              path: [...path, ...item.path, ...(keyword === "x-kb-change-paths" ? ["path"] : [])],
              keyword,
            };
          seen.add(identity);
        }
      }
  }
  return null;
}
