import { useState } from "react";
import { isPathNotFound } from "@/hooks/use-kb-editor";

type ReadState = "missing" | "success" | "error" | "fetching" | "other";

/** Remember a missing answer only for the same read while it is refetching. */
export function missingDocumentState(previous: string | null, key: string | null, read: ReadState) {
  const remembered = key !== previous ? null : previous;
  const next =
    key && read === "missing" ? key : read === "success" || read === "error" ? null : remembered;
  return {
    key: next,
    missing: key !== null && (read === "missing" || (read === "fetching" && next === key)),
  };
}

export function useMissingDocument(
  key: string | null,
  query: { error: unknown; isSuccess: boolean; isError: boolean; isPending: boolean },
): boolean {
  const read: ReadState = isPathNotFound(query.error)
    ? "missing"
    : query.isSuccess
      ? "success"
      : query.isError
        ? "error"
        : query.isPending
          ? "fetching"
          : "other";
  const [remembered, setRemembered] = useState<string | null>(null);
  const next = missingDocumentState(remembered, key, read);
  if (next.key !== remembered) setRemembered(next.key);
  return next.missing;
}
