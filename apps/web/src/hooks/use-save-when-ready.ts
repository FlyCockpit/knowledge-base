import { useEffect, useRef } from "react";

import type { WorkspaceEditor } from "@/stores/kb-workspace";

/**
 * Save was chosen in the close question for a file whose editor wasn't open:
 * the file is opened, and once its editor is ready (registered, unsaved, no
 * save or upload in flight) it is saved once, with the editor's own Save. A
 * success then completes the leave (`useResolvePendingClose`, clean after
 * unsaved); a failure stays on the file with the editor saying why.
 */
export function useSaveWhenReady(
  pending: { key: string; id: number; saveWhenReady?: boolean } | null,
  editor: WorkspaceEditor | null,
  /** The file opened without an editor (gone, PR closed): it can't be saved. */
  orphaned: boolean,
  on: {
    unsavable: () => void;
    /** The save of question `id` did not go through. */
    failed: (id: number) => void;
    nothing: () => void;
  },
): void {
  const latest = useRef({ editor, on });
  latest.current = { editor, on };
  const waiting = Boolean(pending?.saveWhenReady);
  const ready = Boolean(
    waiting && editor?.dirty && editor.canSave && !editor.pending && !editor.uploading,
  );
  const key = pending?.key ?? null;
  // Opened and clean (its kept draft was gone): nothing to save. The question
  // is dropped and the file stays open; nothing is closed on a clean state.
  const clean = Boolean(waiting && editor && !editor.dirty && !editor.pending && !editor.uploading);
  // One attempt per question: a failed save stays on the file, never retried here.
  const tried = useRef<string | null>(null);
  // Unsavable once opened (no editor, or one that can't save now: write access
  // lost, read-only): Save gives way to Discard / Cancel.
  const unsavable = Boolean(
    waiting && (orphaned || (editor?.dirty && !editor.canSave && !editor.pending)),
  );
  useEffect(() => {
    if (unsavable) latest.current.on.unsavable();
  }, [unsavable]);
  useEffect(() => {
    if (clean) latest.current.on.nothing();
  }, [clean]);
  useEffect(() => {
    if (!waiting) tried.current = null;
  }, [waiting]);
  const question = pending?.id ?? null;
  useEffect(() => {
    if (!ready || key === null || question === null || tried.current === key) return;
    const current = latest.current.editor;
    if (!current) return;
    tried.current = key;
    void current.save().then((saved) => {
      if (!saved) latest.current.on.failed(question);
    });
  }, [ready, key, question]);
}
