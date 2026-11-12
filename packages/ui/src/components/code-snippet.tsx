import { Button } from "@knowledge-base/ui/components/button";
import { useCopyToClipboard } from "@knowledge-base/ui/hooks/use-copy-to-clipboard";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import type * as React from "react";

type CodeSnippetProps = Omit<React.ComponentProps<"div">, "children"> & {
  /** The snippet — rendered in the `<pre>` and placed on the clipboard. */
  code: string;
  /**
   * aria-label for the copy button. The default is accessibility text (the
   * allowed hardcoded-string exception) — pass a translated string where the
   * call site has one.
   */
  copyLabel?: string;
  /** Fired after a successful copy — wire toasts at the call site. */
  onCopied?: () => void;
  /** Fired when both the async clipboard API and the fallback fail. */
  onCopyError?: () => void;
  /** Extra classes for the inner `<pre>` (e.g. `max-h-72 overflow-y-auto`). */
  preClassName?: string;
};

/**
 * Multi-line copyable block (JSON, config, env block) with a copy button
 * pinned top-right. The layout contract is baked in: `min-w-0 max-w-full`
 * wrapper + a `<pre>` that scrolls itself horizontally, so it is safe inside
 * `DialogContent` by default and never turns the page into a horizontal
 * scroller.
 */
function CodeSnippet({
  code,
  copyLabel = "Copy code",
  onCopied,
  onCopyError,
  className,
  preClassName,
  ...props
}: CodeSnippetProps) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div
      data-slot="code-snippet"
      className={cn("relative min-w-0 max-w-full", className)}
      {...props}
    >
      <pre
        data-slot="code-snippet-pre"
        className={cn(
          "overflow-x-auto overscroll-x-contain rounded-md border bg-muted p-3 pr-12 font-mono text-xs",
          preClassName,
        )}
      >
        {code}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-1 right-1 min-h-[44px] min-w-[44px] bg-muted/80 backdrop-blur-sm"
        aria-label={copyLabel}
        disabled={!code}
        onClick={async () => {
          if (await copy(code)) onCopied?.();
          else onCopyError?.();
        }}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-4" />
        ) : (
          <Copy aria-hidden="true" className="size-4" />
        )}
      </Button>
    </div>
  );
}

export { CodeSnippet };
