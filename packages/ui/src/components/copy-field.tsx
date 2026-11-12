import { Button } from "@knowledge-base/ui/components/button";
import { useCopyToClipboard } from "@knowledge-base/ui/hooks/use-copy-to-clipboard";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import type * as React from "react";

type CopyFieldProps = React.ComponentProps<"div"> & {
  /** The text placed on the clipboard (and rendered, single-line). */
  value: string;
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
};

/**
 * Single-line copyable value (shell command, API key, URL) with a copy
 * button. The layout contract is baked in: the value region scrolls itself
 * horizontally (`min-w-0 overflow-x-auto`), never the page, so it is safe
 * inside `DialogContent` by default.
 */
function CopyField({
  value,
  copyLabel = "Copy value",
  onCopied,
  onCopyError,
  className,
  ...props
}: CopyFieldProps) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div
      data-slot="copy-field"
      className={cn("flex min-w-0 max-w-full items-center gap-2", className)}
      {...props}
    >
      <code
        data-slot="copy-field-value"
        className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain no-scrollbar rounded-md border bg-muted px-2.5 py-1.5 font-mono text-sm whitespace-nowrap"
      >
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="min-h-[44px] min-w-[44px] shrink-0"
        aria-label={copyLabel}
        disabled={!value}
        onClick={async () => {
          if (await copy(value)) onCopied?.();
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

export { CopyField };
