import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A secret shown exactly once: a warning panel, the value through `CopyField`,
 * and (when `onDone` is given) an explicit "I copied it". The parent drops the
 * value from state when this closes, so it never renders again.
 */
export function SecretReveal({
  value,
  title,
  description,
  copyLabel,
  doneLabel,
  onDone,
  children,
}: {
  value: string;
  title: string;
  description?: string;
  copyLabel: string;
  doneLabel?: string;
  onDone?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-secret-reveal>
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
      >
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
        />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{title}</p>
          {description ? <p className="text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      <CopyField value={value} copyLabel={copyLabel} />
      {children}
      {onDone && doneLabel ? (
        <Button type="button" size="touch" onClick={onDone}>
          {doneLabel}
        </Button>
      ) : null}
    </div>
  );
}
