import { useEffect, useRef, useState } from "react";

import type { WorkspaceEditor } from "@/stores/kb-workspace";

/**
 * A pending leave (close, Back, switch) is carried out once the file's editor,
 * seen unsaved for this question, reports it clean: it was saved. Nothing else
 * completes it (a session restoring its kept draft may register clean for a
 * moment; that must never close a file with unsaved work). The one place a
 * Save completes a leave, so it runs once.
 */
export function useResolvePendingClose(
  pending: { key: string; id: number } | null,
  editor: WorkspaceEditor | null,
  finish: () => void,
): void {
  const latest = useRef(finish);
  latest.current = finish;
  const ours = pending !== null && editor?.key === pending.key ? editor : null;
  // Whether this question's file was seen unsaved (per question: a New
  // document's first save moves its key, not its question).
  const id = pending?.id ?? null;
  const [seen, setSeen] = useState<{ id: number | null; dirty: boolean }>({
    id: null,
    dirty: false,
  });
  let now = seen;
  if (now.id !== id) now = { id, dirty: false };
  if (ours?.dirty && !now.dirty) now = { id, dirty: true };
  if (now !== seen) setSeen(now);
  // Saved and settled: no save of it still in flight.
  const settled = ours !== null && !ours.dirty && !ours.pending && now.dirty;
  useEffect(() => {
    if (settled) latest.current();
  }, [settled]);
}
