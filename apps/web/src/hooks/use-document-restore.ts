import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import {
  describeEditorError,
  type EditorOutcome,
  initialEditorMemory,
  recheckKbAccess,
  runSave,
  type SaveState,
  sha256Hex,
} from "@/hooks/use-kb-editor";
import { orpc } from "@/utils/orpc";

/**
 * Restore an earlier version of a document as a new revision: its text
 * at `revision`, written through the same save path as the editor
 * (`runSave`: staged upload for large text, idempotent retries, proposals
 * for writers who propose, conflicts that wait for a decision). History is
 * never rewritten; the restored text becomes the newest version.
 */
export type RestoreRequest = {
  kbId: string;
  path: string;
  /** The revision whose version of `path` is restored. */
  revision: string;
  /**
   * The document where the write goes, as last read: whether main has the
   * path now and the head that read was at. A document that moved since
   * is a conflict, never overwritten.
   */
  current: { exists: boolean; head: string };
  /**
   * An explicit decision after a conflict: write onto that reported head
   * (and the caller's pull request it heads), as the editor's rebase does.
   */
  rebase?: { headSha: string; proposalNumber: number | null };
};

export function useDocumentRestore() {
  const queryClient = useQueryClient();
  // Every outcome is reported by the caller (dialog, toast): no global toast.
  const quiet = { meta: { skipGlobalErrorToast: true } };
  const create = useMutation({ ...orpc.documents.create.mutationOptions(), ...quiet });
  const update = useMutation({ ...orpc.documents.update.mutationOptions(), ...quiet });
  const remove = useMutation({ ...orpc.documents.delete.mutationOptions(), ...quiet });
  const begin = useMutation({ ...orpc.kbUploads.begin.mutationOptions(), ...quiet });
  const write = useMutation({ ...orpc.kbUploads.write.mutationOptions(), ...quiet });
  const finish = useMutation({ ...orpc.kbUploads.finish.mutationOptions(), ...quiet });
  // An unresolved restore (lost reply) is resent as exactly that record.
  const unresolved = useRef(new Map<string, SaveState>());
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const restore = useCallback(
    async (request: RestoreRequest): Promise<EditorOutcome | null> => {
      if (busy.current) return null;
      busy.current = true;
      setPending(true);
      try {
        let markdown: string;
        try {
          const source = await queryClient.fetchQuery({
            ...orpc.documents.get.queryOptions({
              input: { kbId: request.kbId, path: request.path, rev: request.revision },
            }),
            retry: false,
            meta: { skipGlobalErrorToast: true },
          });
          if (!source) return { kind: "error", reason: "gone" };
          markdown = source.markdown;
        } catch (error) {
          const outcome = describeEditorError(error);
          if (outcome.kind === "error" && outcome.reason === "gone")
            void recheckKbAccess(queryClient, request.kbId);
          return outcome;
        }
        const key = JSON.stringify([request.kbId, request.path, request.revision]);
        const state: SaveState = unresolved.current.get(key) ?? {
          memory: initialEditorMemory(),
          images: [],
          document: { ...request.current, path: request.path },
          proposal: null,
        };
        const run = await runSave(
          {
            create: create.mutateAsync,
            update: update.mutateAsync,
            remove: remove.mutateAsync,
            uploadBegin: begin.mutateAsync,
            uploadWrite: write.mutateAsync,
            uploadFinish: finish.mutateAsync,
            newKey: () => crypto.randomUUID(),
            sha256Hex,
          },
          state,
          {
            kbId: request.kbId,
            intent: { kind: "write", markdown },
            ...(request.rebase ? { rebase: request.rebase } : {}),
          },
        );
        if (run.memory.request) unresolved.current.set(key, run);
        else unresolved.current.delete(key);
        if (run.savedRev !== null) {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: orpc.documents.key() }),
            queryClient.invalidateQueries({ queryKey: orpc.kbs.get.key() }),
            ...(run.proposal !== null
              ? [queryClient.invalidateQueries({ queryKey: orpc.pullRequests.key() })]
              : []),
          ]);
        }
        if (run.outcome.kind === "error" && run.outcome.reason === "gone")
          void recheckKbAccess(queryClient, request.kbId);
        return run.outcome;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [queryClient, create, update, remove, begin, write, finish],
  );

  return { restore, pending };
}
