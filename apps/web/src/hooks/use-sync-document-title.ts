import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

export function useSyncDocumentTitle() {
  const title = useRouterState({
    select: (state) => {
      // Match HeadContent's asset boundary for pending and not-found matches.
      let end = state.matches.length;
      for (let i = 0; i < end; i++) {
        const match = state.matches[i];
        if (!match) continue;
        if ("_assetEnd" in match && typeof match._assetEnd === "number") {
          end = Math.min(end, Math.max(i + 1, match._assetEnd));
        } else if (match.status !== "success" || match._notFound) {
          end = i + 1;
          break;
        }
      }
      for (let i = end - 1; i >= 0; i--) {
        const meta = state.matches[i]?.meta;
        if (!meta) continue;
        for (let j = meta.length - 1; j >= 0; j--) {
          const item = meta[j];
          if (item && "title" in item && typeof item.title === "string" && item.title)
            return item.title;
        }
      }
      return undefined;
    },
  });
  useEffect(() => {
    if (title !== undefined) document.title = title;
  }, [title]);
}
