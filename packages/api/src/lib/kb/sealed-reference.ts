import { remoteSealedNamespace } from "./attachment";
import { KbDomainError } from "./errors";
import type { LockQuery } from "./lock";
import { uuidSchema } from "./protocol/common";
import type { SealedReferenceOccurrence, TreeValidationFailure } from "./validate-tree";

export function parseSealedReference(reference: string): { namespace: string; recordId: string } {
  const parts = /^\{\{sealed:v1:knowledge_base:([^:]+):([^:]+)\}\}$/.exec(reference);
  if (!parts || !uuidSchema.safeParse(parts[1]).success || !uuidSchema.safeParse(parts[2]).success)
    throw new KbDomainError("UNRESOLVED_REFERENCE", "Unresolved reference");
  return { namespace: parts[1]!, recordId: parts[2]! };
}
export function sealedReference(namespace: string, recordId: string): string {
  const reference = `{{sealed:v1:knowledge_base:${namespace}:${recordId}}}`;
  parseSealedReference(reference);
  return reference;
}

export function sealedTreeValidator(namespace: string, live: ReadonlySet<string>) {
  return (refs: readonly SealedReferenceOccurrence[]): TreeValidationFailure | null => {
    for (const occurrence of refs) {
      try {
        // parse-markdown's internal occurrences omit the delimiters; source/wire never do.
        const ref = parseSealedReference(`{{${occurrence.reference}}}`);
        if (ref.namespace === namespace && live.has(ref.recordId)) continue;
      } catch {
        /* All dead, malformed and foreign references share one rejection. */
      }
      return {
        ok: false,
        code: "TREE_SEALED",
        message: "Unresolved sealed reference",
        path: occurrence.path,
      };
    }
    return null;
  };
}

/** Caller holds authority until publication reservation. Snapshot remains valid for that
 * reserved publication even if revocation wins after COMMITTING. No ciphertext is loaded. */
export async function loadSealedTreeValidator(
  query: LockQuery,
  kbId: string,
  canonicalOrigin?: string,
) {
  if (!canonicalOrigin) return undefined;
  const namespace = remoteSealedNamespace(canonicalOrigin, kbId),
    live = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const { rows }: { rows: { recordId: string }[] } = await query<{ recordId: string }>(
      `SELECT "recordId" FROM sealed_record WHERE "kbId"=$1 AND namespace=$2::uuid
       AND ($3::uuid IS NULL OR "recordId">$3::uuid) AND "revokedAt" IS NULL AND ciphertext IS NOT NULL
       ORDER BY "recordId" LIMIT 256`,
      [kbId, namespace, after],
    );
    for (const row of rows) live.add(row.recordId);
    if (rows.length < 256) return sealedTreeValidator(namespace, live);
    after = rows.at(-1)!.recordId;
  }
}
