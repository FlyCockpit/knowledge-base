import { useEffect } from "react";

import { type ParentLink, registerFileDropTarget } from "@/lib/file-drop-registry";

/**
 * Register `element` as a file-drop target for the document-level
 * `FileDropGuard` while it is mounted. The registry is the single drop
 * dispatcher — components that use this hook must NOT also handle React
 * `onDrop` (that would double-handle the drop). Keep React `onDragOver` /
 * `onDragLeave` for the visual highlight only.
 *
 * Pass the element from a callback ref + `useState<HTMLElement | null>` in
 * the component — direct `useEffect` stays banned in `components/**` and
 * `routes/**`; this hook (in `apps/web/src/hooks/`) is the approved
 * encapsulation boundary. `useMountEffect` would be the wrong primitive
 * here: routes mount and unmount, and the registration must follow the
 * element, not the first mount.
 *
 * `onFiles` is a dependency, not a render-time ref write: registration is a
 * Map.set, so an inline caller closure just re-registers. Writing
 * `ref.current` during render trips `react-doctor/no-ref-current-in-render`.
 */
export function useFileDropTarget<T extends ParentLink<T>>(
  element: T | null,
  onFiles: (files: File[]) => void,
): void {
  useEffect(() => {
    if (!element) return;
    return registerFileDropTarget(element, onFiles);
  }, [element, onFiles]);
}
