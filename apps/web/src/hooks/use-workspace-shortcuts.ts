import { useEffect, useRef } from "react";

import {
  commandForKey,
  isMacPlatform,
  isTypingTarget,
  type WorkspaceCommand,
} from "@/lib/kb-workspace/shortcuts";

/**
 * The workspace's keyboard shortcuts, on the window while the workspace is
 * mounted. A handler returning false leaves the key to the browser (nothing
 * to do, e.g. Save with no editor open). Keys pressed inside a dialog belong
 * to the dialog.
 */
export function useWorkspaceShortcuts(
  handlers: Partial<Record<WorkspaceCommand, () => boolean | undefined>>,
  enabled = true,
): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const mac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[role="dialog"],[role="alertdialog"]'))
        return;
      // Plain letters typed in the file tree find files there (type-to-find).
      const inTree = target instanceof Element && target.closest('[role="tree"]') !== null;
      const command = commandForKey(event, { mac, typing: isTypingTarget(target) || inTree });
      if (!command) return;
      const handler = latest.current[command];
      if (!handler) return;
      if (handler() === false) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [enabled]);
}
