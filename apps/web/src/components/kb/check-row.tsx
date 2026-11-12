import { Checkbox } from "@knowledge-base/ui/components/checkbox";
import { Label } from "@knowledge-base/ui/components/label";

/** One labelled checkbox row of the credential pickers, with a 44px touch target. */
export function CheckRow({
  id,
  checked,
  disabled,
  onToggle,
  label,
  accessibleName,
  description,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  label: string;
  /** Replaces the visible label as the checkbox's name when the label alone is ambiguous. */
  accessibleName?: string;
  description?: string;
}) {
  return (
    <div className="flex min-h-[44px] items-start gap-3">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
        // Base UI puts `id` on its hidden input; name the visible role=checkbox explicitly.
        aria-labelledby={accessibleName ? `${id}-name` : `${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        className="mt-1"
      />
      <div className="min-w-0 space-y-1">
        <Label id={`${id}-label`} htmlFor={id} className="leading-snug">
          {label}
        </Label>
        {accessibleName && (
          <span id={`${id}-name`} className="sr-only">
            {accessibleName}
          </span>
        )}
        {description && (
          <p id={`${id}-desc`} className="text-xs text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
