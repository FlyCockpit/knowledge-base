import { Button } from "@knowledge-base/ui/components/button";
import { useCopyToClipboard } from "@knowledge-base/ui/hooks/use-copy-to-clipboard";
import { edgeAttributes, useScrollEdges } from "@knowledge-base/ui/hooks/use-scroll-edges";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import * as React from "react";

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
  /**
   * Wrap long lines instead of scrolling them (logs, tool output). Leave off
   * for commands and config, where a line break would change the meaning.
   */
  wrap?: boolean;
};

/**
 * Multi-line copyable block (JSON, config, env block) with a copy button in
 * its own top-right gutter. The layout contract is baked in: a
 * `min-w-0 max-w-full` box (border and fill; restyle it with `className`)
 * holding a `<pre>` that scrolls itself horizontally and ends where the
 * button's column begins, so scrolled text never sits under the button. A
 * long line fades out at the edge that has more to scroll (`scroll-fade-x`).
 * Safe inside `DialogContent` by default; never turns the page into a
 * horizontal scroller. Code text is `font-mono text-xs leading-5`, the same as
 * `CopyField` (docs/ui.md § Shared controls).
 */
function CodeSnippet({
  code,
  copyLabel = "Copy code",
  onCopied,
  onCopyError,
  className,
  preClassName,
  wrap = false,
  ...props
}: CodeSnippetProps) {
  const { copied, copy } = useCopyToClipboard();
  const preRef = React.useRef<HTMLPreElement>(null);
  const edges = useScrollEdges(preRef, code);

  return (
    <div
      data-slot="code-snippet"
      className={cn("flex min-w-0 max-w-full items-start rounded-md border bg-muted", className)}
      {...props}
    >
      <pre
        ref={preRef}
        data-slot="code-snippet-pre"
        {...edgeAttributes(edges)}
        className={cn(
          "min-w-0 flex-1 overflow-x-auto overscroll-x-contain scroll-fade-x py-3 pl-3 font-mono text-xs leading-5",
          wrap && "whitespace-pre-wrap [overflow-wrap:anywhere]",
          preClassName,
        )}
      >
        {code}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="min-h-[44px] min-w-[44px] shrink-0"
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
