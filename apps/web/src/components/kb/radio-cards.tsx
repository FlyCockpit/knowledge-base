import { useId } from "react";

/**
 * One required choice as native radios, each with a label and a line saying
 * what it means. `value: null` means nothing is chosen yet (nothing is ever
 * preselected for a credential). Used by the credential create dialogs.
 */
export function RadioCards<T extends string>({
  legend,
  hint,
  options,
  value,
  onChange,
  disabled = false,
}: {
  legend: string;
  hint?: string;
  options: readonly { value: T; label: string; description: string }[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const base = useId();
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      <div role="radiogroup" aria-label={legend} className="space-y-1">
        {options.map((option) => {
          const id = `${base}-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md p-2 has-[:checked]:bg-muted has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
            >
              <input
                id={id}
                type="radio"
                name={`${base}-choice`}
                value={option.value}
                checked={value === option.value}
                disabled={disabled}
                onChange={() => onChange(option.value)}
                // The name is the title alone; the line below it describes the choice.
                aria-labelledby={`${id}-label`}
                aria-describedby={`${id}-desc`}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span className="min-w-0 space-y-1">
                <span id={`${id}-label`} className="block text-sm leading-snug font-medium">
                  {option.label}
                </span>
                <span id={`${id}-desc`} className="block text-xs text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
