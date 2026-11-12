import { type ZodTypeAny, z } from "zod";

export type JsonSchema = Record<string, unknown>;

const REPRESENTABLE_CONTRACT_KEYS = new Set([
  "allOf",
  "anyOf",
  "if",
  "then",
  "else",
  "not",
  "minLength",
  "maxLength",
  "pattern",
  "type",
  "additionalProperties",
]);

function isContractKey(key: string): boolean {
  return key.startsWith("x-kb-") || REPRESENTABLE_CONTRACT_KEYS.has(key);
}

function isZodSchemaNode(value: unknown): value is ZodTypeAny {
  if (typeof value !== "object" || value === null) return false;
  const inner = (value as { _zod?: unknown })._zod;
  if (typeof inner !== "object" || inner === null) return false;
  const def = (inner as { def?: unknown }).def;
  if (typeof def !== "object" || def === null) return false;
  return typeof (def as { type?: unknown }).type === "string";
}

function isCustomRefinement(check: unknown): boolean {
  if (typeof check !== "object" || check === null) return false;
  const def = (check as { _zod?: { def?: { check?: unknown } } })._zod?.def;
  return def?.check === "custom";
}

/**
 * Fails when any schema in the tree carries a runtime refinement (a Zod
 * `custom` check from `.superRefine`/`.refine`) without a registered
 * validation-contract payload. Without this guard, refinements would be
 * silently discarded by `z.toJSONSchema` and the exported artifact would
 * disagree with the runtime schema.
 */
export function assertNoUndeclaredRefinements(root: ZodTypeAny): void {
  const visited = new Set<unknown>();

  const visit = (node: ZodTypeAny): void => {
    if (visited.has(node)) return;
    visited.add(node);
    const def = node._zod.def as { type?: unknown; checks?: unknown };
    if (Array.isArray(def.checks) && def.checks.some(isCustomRefinement)) {
      const meta = z.globalRegistry.get(node);
      if (meta === undefined || !Object.keys(meta).some(isContractKey)) {
        throw new Error(
          `kb protocol schema of type ${String(def.type)} carries a runtime refinement with no exported validation contract — wrap it with withKbContract`,
        );
      }
    }
    for (const value of Object.values(def)) {
      visitDefValue(value);
    }
  };

  /** def children appear as schema nodes, arrays of nodes (union options), or plain objects of nodes (object shapes). */
  const visitDefValue = (value: unknown): void => {
    if (isZodSchemaNode(value)) {
      visit(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isZodSchemaNode(item)) visit(item);
      }
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const nested of Object.values(value)) {
        if (isZodSchemaNode(nested)) visit(nested);
      }
    }
  };

  visit(root);
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  assertNoUndeclaredRefinements(schema);
  const jsonSchema = z.toJSONSchema(schema) as JsonSchema;
  const serialized = JSON.stringify(jsonSchema);
  if (serialized.includes("unsupported")) {
    throw new Error("zodToJsonSchema produced an unsupported conversion marker");
  }
  return jsonSchema;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, replacer, 2)}\n`;

  function replacer(_key: string, input: unknown): unknown {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const sorted: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        sorted[key] = (input as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return input;
  }
}
