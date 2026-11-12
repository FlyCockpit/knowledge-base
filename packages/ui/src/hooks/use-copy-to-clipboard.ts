import * as React from "react";

/**
 * Legacy fallback for non-secure contexts (plain-http LAN dev, some embedded
 * webviews) where `navigator.clipboard` is unavailable or rejects.
 */
function copyViaExecCommand(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/**
 * Shared copy-to-clipboard behavior for `CopyField` / `CodeSnippet` (and any
 * bespoke copy button that can't compose those components). `copy(value)`
 * resolves `true` on success and flips `copied` on for `resetAfterMs`
 * (default 1.5 s) so the caller can swap in a check icon.
 */
function useCopyToClipboard({ resetAfterMs = 1500 }: { resetAfterMs?: number } = {}) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Note: the apps/web useEffect ban applies to components/routes there, not
  // to packages/ui hooks — this mirrors use-async-search.ts.
  React.useEffect(() => {
    return () => {
      if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = React.useCallback(
    async (value: string): Promise<boolean> => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(value);
        ok = true;
      } catch {
        ok = copyViaExecCommand(value);
      }
      if (ok) {
        if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current);
        setCopied(true);
        timeoutRef.current = setTimeout(() => setCopied(false), resetAfterMs);
      }
      return ok;
    },
    [resetAfterMs],
  );

  return { copied, copy };
}

export { useCopyToClipboard };
