import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import { FieldError } from "@knowledge-base/ui/components/text-field";
import type { ComponentProps, Ref } from "react";

type PlainFieldProps = {
  id: string;
  label: string;
  /** The server's answer about this field (wrong code, wrong password); null when there is none. */
  error: string | null;
  inputRef?: Ref<HTMLInputElement>;
} & Omit<ComponentProps<typeof Input>, "id" | "aria-invalid" | "aria-describedby" | "ref">;

/**
 * Label + input + inline error for the auth inputs that live in local state
 * rather than a TanStack Form (the 2FA code and the password that starts 2FA
 * setup). Same wiring `TextField` gives a form field: `aria-invalid`,
 * `aria-describedby` pointing at the message, and the message in a
 * `role="alert"` region so it is announced. docs/ui.md § Server errors on a field.
 */
export function PlainField({ id, label, error, inputRef, ...inputProps }: PlainFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        {...inputProps}
        ref={inputRef}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      <FieldError id={errorId} errors={error ? [error] : []} />
    </div>
  );
}

/** Length of a TOTP / email one-time code. */
const ONE_TIME_CODE_LENGTH = 6;

/**
 * The six-digit 2FA code input used by the sign-in challenge, the required
 * 2FA setup and Settings → Security. `onComplete` runs on Enter once all six
 * digits are in.
 */
export function OneTimeCodeField({
  id,
  label,
  value,
  error,
  inputRef,
  onValueChange,
  onComplete,
}: {
  id: string;
  label: string;
  value: string;
  error: string | null;
  inputRef?: Ref<HTMLInputElement>;
  onValueChange: (value: string) => void;
  onComplete: () => void;
}) {
  return (
    <PlainField
      id={id}
      label={label}
      error={error}
      inputRef={inputRef}
      placeholder="000000"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={ONE_TIME_CODE_LENGTH}
      className="text-center text-lg tracking-widest"
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.length === ONE_TIME_CODE_LENGTH) onComplete();
      }}
    />
  );
}
