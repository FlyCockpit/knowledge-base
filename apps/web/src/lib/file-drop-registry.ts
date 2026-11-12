/**
 * Module-level registry of file-drop targets for the document-level
 * `FileDropGuard`. Deliberately a plain `Map` — not Zustand and not React
 * context: there is no drop state for React to render, the guard just reads
 * this Map at event time. Drop zones opt in via `useFileDropTarget`
 * (`apps/web/src/hooks/use-file-drop-target.ts`).
 */

/**
 * Duck-typed parent chain. Deliberately NOT `Element` / `Node`: an
 * `instanceof Element` check fails across realms, on SVG elements, on `Text`
 * nodes, and on plain-object test stubs. Anything with a `parentElement`
 * (and optionally a `parentNode`) link can be walked.
 */
export type ParentLink<T extends ParentLink<T>> = {
  parentElement: T | null;
  /** DOM `parentNode` may be a non-element (`Document`, `ShadowRoot`). */
  parentNode?: object | null;
};

type OnFiles = (files: File[]) => void;

const targets = new Map<object, OnFiles>();

/** Register `element` as a drop target. Returns the unregister function. */
export function registerFileDropTarget<T extends ParentLink<T>>(
  element: T,
  onFiles: OnFiles,
): () => void {
  targets.set(element, onFiles);
  return () => {
    targets.delete(element);
  };
}

function parentOf(node: object): object | null {
  const { parentElement, parentNode } = node as {
    parentElement?: unknown;
    parentNode?: unknown;
  };
  const next = parentElement ?? parentNode ?? null;
  return typeof next === "object" && next !== null ? next : null;
}

/**
 * Hit-test a drop event against the registered targets.
 *
 * `composedPath` is ordered from the event target outward, so the first hit
 * is the **innermost** registered zone — a nested zone claims the drop before
 * its ancestors, and sibling zones never steal each other's drops (a
 * mount-order stack would). Registered elements match by identity (`===`).
 * If the composed path is empty or truncated, fall back to walking
 * `parentElement ?? parentNode` up from the event target.
 */
export function findFileDropTarget(composedPath: EventTarget[]): { onFiles: OnFiles } | null {
  for (const node of composedPath) {
    const onFiles = targets.get(node);
    if (onFiles) return { onFiles };
  }
  let current: object | null = composedPath[0] ?? null;
  const seen = new Set<object>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const onFiles = targets.get(current);
    if (onFiles) return { onFiles };
    current = parentOf(current);
  }
  return null;
}

/**
 * True when the drag actually carries OS files. In-page HTML drags and link
 * drags advertise `text/html` / `text/uri-list`, never `"Files"` — the guard
 * must leave those alone.
 */
export function dataTransferHasFiles(
  dt: { types: readonly string[]; files?: FileList } | null,
): boolean {
  if (!dt) return false;
  return dt.types.includes("Files");
}
