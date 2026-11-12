import { toast } from "@knowledge-base/ui/components/sileo";
import { useTranslation } from "react-i18next";

import { useMountEffect } from "@/hooks/use-mount-effect";
import { dataTransferHasFiles, findFileDropTarget } from "@/lib/file-drop-registry";

/**
 * Document-level drop swallow: a file dragged onto the SPA must never
 * navigate the tab to the file. Registered zones (via `useFileDropTarget`)
 * claim their drops; unclaimed drops get a polite toast — they never
 * auto-upload. Renders nothing.
 *
 * Mounted in `__root.tsx` inside `ClientOnly` (needs `document`, and toasts
 * must not SSR) as a static import so the listeners exist on public pages
 * too. Keep this module lightweight — heavy imports would ride the eager root chunk.
 *
 * `useMountEffect` is the approved one-time external-sync escape hatch
 */
export function FileDropGuard() {
  const { t } = useTranslation("common");
  useMountEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      const target = findFileDropTarget(event.composedPath());
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = target ? "copy" : "none";
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      // Read the Map at event time — targets register after this mount.
      const target = findFileDropTarget(event.composedPath());
      if (target) {
        target.onFiles(files);
        return;
      }
      // Polite notice, not an error.
      toast.message(t("fileDrop.ignored"));
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  });
  return null;
}
