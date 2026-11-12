import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@knowledge-base/ui/components/select";
import { Textarea } from "@knowledge-base/ui/components/textarea";
import { cn } from "@knowledge-base/ui/lib/utils";
import type * as React from "react";
import { useId } from "react";

/**
 * Narrow field shape so `@knowledge-base/ui` does not depend on TanStack Form.
 * A `<form.Field>` render-prop object satisfies this structurally.
 */
type FieldLike<TValue> = {
  name: string;
  state: {
    value: TValue;
    meta: { errors: readonly unknown[] };
  };
  handleBlur: () => void;
  handleChange: (value: TValue) => void;
};

export function fieldErrorMessages(errors: readonly unknown[]): string[] {
  const messages: string[] = [];
  for (const err of errors) {
    if (typeof err === "string" && err) {
      messages.push(err);
      continue;
    }
    if (err && typeof err === "object" && "message" in err) {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === "string" && msg) messages.push(msg);
    }
  }
  return messages;
}

export function FieldError({ id, errors }: { id?: string; errors: readonly unknown[] }) {
  const messages = fieldErrorMessages(errors);
  if (messages.length === 0) return null;
  return (
    <div id={id} role="alert">
      {messages.map((msg, index) => (
        // Two validators can produce the same message; the position in the
        // list is what actually identifies an entry here.
        <p key={`${index}-${msg}`} className="text-sm text-destructive">
          {msg}
        </p>
      ))}
    </div>
  );
}

/**
 * The DOM's own `inputMode` union, minus `undefined` — so the prop stays
 * type-checked against the real values instead of a hand-rolled enum.
 */
type RequiredInputMode = NonNullable<React.HTMLAttributes<HTMLInputElement>["inputMode"]>;

/** The DOM's own `autoComplete` token type, minus `undefined`. */
type RequiredAutoComplete = NonNullable<
  React.InputHTMLAttributes<HTMLInputElement>["autoComplete"]
>;

/**
 * Input `type`s whose software keyboard follows from the type alone, so
 * `inputMode` is optional on them. Plain `type="text"` is deliberately absent:
 * a text input can want any keyboard, and only the call site knows which.
 */
const INPUT_MODE_BY_TYPE = {
  email: "email",
  number: "numeric",
  // A password field gets the full keyboard even when the password is digits —
  // a numeric or email keyboard would leave the user unable to type it. An
  // explicit `inputMode` still overrides this inference, so only pass one here
  // deliberately.
  password: "text",
  search: "search",
  tel: "tel",
  url: "url",
} satisfies Record<string, RequiredInputMode>;

type InferredInputModeType = keyof typeof INPUT_MODE_BY_TYPE;

/** Widened view for the runtime lookup — an arbitrary `type` may not be a key. */
const inputModeByType: Partial<Record<string, RequiredInputMode>> = INPUT_MODE_BY_TYPE;

type TextFieldOwnProps = {
  field: FieldLike<string>;
  label: string;
  description?: React.ReactNode;
  /** Required — see the `TextField` JSDoc. */
  autoComplete: RequiredAutoComplete;
  /** Classes for the `<Input>` itself. `className` styles the wrapper. */
  inputClassName?: string;
} & Omit<
  React.ComponentProps<typeof Input>,
  | "id"
  | "name"
  | "value"
  | "onBlur"
  | "aria-invalid"
  | "aria-describedby"
  | "inputMode"
  | "autoComplete"
  | "type"
>;

type TextFieldProps = TextFieldOwnProps &
  (
    | { type: InferredInputModeType; inputMode?: RequiredInputMode }
    | {
        type?: Exclude<React.HTMLInputTypeAttribute, InferredInputModeType>;
        inputMode: RequiredInputMode;
      }
  );

/**
 * Single-line text field wired to a TanStack Form `field` object. Owns the
 * `htmlFor`/`id` pairing, `aria-invalid`, `aria-describedby`, and the error
 * message.
 *
 * `autoComplete` is **required by the type on purpose**, and `inputMode` is
 * required whenever it cannot be inferred. This ships as a mobile PWA:
 * `inputMode` picks the software keyboard the user gets (an email field that
 * opens a QWERTY keyboard with no `@` is a real cost), and `autoComplete` is
 * what lets the browser and the platform password manager fill and save
 * credentials. Both are easy to forget and invisible on a desktop dev machine,
 * so the compiler asks for them rather than a reviewer.
 *
 * `type="email" | "url" | "tel" | "search" | "number" | "password"` each imply
 * one right keyboard, so `inputMode` is optional there — do not repeat it.
 * Every other field, `type="text"` included, must say which keyboard it wants.
 * On the inferred types an explicit `inputMode` overrides the inference; only
 * do that deliberately (a numeric keyboard on a `type="password"` field, say,
 * locks the user out of a password that has letters in it).
 *
 * Common pairs — free text `inputMode="text"` with a real autofill token or
 * `autoComplete="off"`; email `type="email" autoComplete="email"`; sign-in
 * password `type="password" autoComplete="current-password"`; signup/reset
 * password `type="password" autoComplete="new-password"`; slugs and URLs
 * `inputMode="url" autoComplete="off"`; search `inputMode="search"
 * autoComplete="off"`; numbers `inputMode="numeric"` or `"decimal"`; OTP
 * `inputMode="numeric" autoComplete="one-time-code"`. Reach for
 * `autoComplete="off"` only when no autofill token actually describes the
 * field. See AGENTS.md § Forms.
 *
 * A supplied `onChange` runs **in addition to** `field.handleChange`, never
 * instead of it — the field always stays in sync with what the user typed, so
 * `onChange={() => setDirty(true)}` cannot accidentally freeze the input.
 *
 * `className` styles the **wrapper** (label + input + description + error), so
 * layout classes like `sm:col-span-2` land where you want them. To style the
 * input itself — `font-mono`, a width — pass `inputClassName`.
 */
function TextField({
  field,
  label,
  description,
  className,
  inputClassName,
  onChange,
  type,
  inputMode,
  ...inputProps
}: TextFieldProps) {
  // Two forms on one page can both have a "name" field; the React id keeps
  // their labels, errors, and descriptions pointing at the right inputs.
  const reactId = useId();
  const id = `${reactId}-${field.name}`;
  const errorId = `${id}-error`;
  const descriptionId = `${id}-description`;
  const messages = fieldErrorMessages(field.state.meta.errors);
  const invalid = messages.length > 0;
  const describedBy =
    [description ? descriptionId : null, invalid ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        {...inputProps}
        className={inputClassName}
        type={type}
        inputMode={inputMode ?? (type ? inputModeByType[type] : undefined)}
        id={id}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => {
          field.handleChange(event.target.value);
          onChange?.(event);
        }}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      {description ? (
        <div id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </div>
      ) : null}
      <FieldError id={errorId} errors={field.state.meta.errors} />
    </div>
  );
}

type TextareaFieldProps = {
  field: FieldLike<string>;
  label: string;
  description?: React.ReactNode;
  /** Optional here, defaulting to `"text"` — see the `TextareaField` JSDoc. */
  inputMode?: RequiredInputMode;
  /** Required — see the `TextareaField` JSDoc. */
  autoComplete: RequiredAutoComplete;
  /** Classes for the `<Textarea>` itself. `className` styles the wrapper. */
  inputClassName?: string;
} & Omit<
  React.ComponentProps<typeof Textarea>,
  | "id"
  | "name"
  | "value"
  | "onBlur"
  | "aria-invalid"
  | "aria-describedby"
  | "inputMode"
  | "autoComplete"
>;

/**
 * Multi-line counterpart to {@link TextField}, same `field` contract.
 *
 * `autoComplete` is **required by the type** for the same reason it is on
 * `TextField` — a textarea can be a street address worth autofilling or a
 * free-text note where autofill is meaningless (`"off"`), and only the call
 * site knows which. `inputMode` defaults to `"text"`
 * because that is right for nearly every textarea; override it when the field
 * takes something else. See AGENTS.md § Forms.
 *
 * As on `TextField`, a supplied `onChange` runs in addition to
 * `field.handleChange`, never instead of it, and `className` styles the
 * wrapper while `inputClassName` styles the `<Textarea>`.
 */
function TextareaField({
  field,
  label,
  description,
  className,
  inputClassName,
  onChange,
  inputMode = "text",
  ...textareaProps
}: TextareaFieldProps) {
  const reactId = useId();
  const id = `${reactId}-${field.name}`;
  const errorId = `${id}-error`;
  const descriptionId = `${id}-description`;
  const messages = fieldErrorMessages(field.state.meta.errors);
  const invalid = messages.length > 0;
  const describedBy =
    [description ? descriptionId : null, invalid ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        {...textareaProps}
        className={inputClassName}
        inputMode={inputMode}
        id={id}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => {
          field.handleChange(event.target.value);
          onChange?.(event);
        }}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      {description ? (
        <div id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </div>
      ) : null}
      <FieldError id={errorId} errors={field.state.meta.errors} />
    </div>
  );
}

type SelectFieldProps<TValue extends string> = {
  field: {
    name: string;
    state: {
      value: TValue;
      meta: { errors: readonly unknown[] };
    };
    handleChange: (value: TValue) => void;
  };
  label: string;
  description?: React.ReactNode;
  /** Placeholder shown while no option is chosen. */
  placeholder?: string;
  /** Localized display for the selected value when its ID is not its label. */
  valueLabel?: React.ReactNode;
  /**
   * Classes for the `<SelectTrigger>` itself (width overrides etc.). The
   * trigger keeps its 44px mobile touch target from select.tsx; `className`
   * styles the wrapper.
   */
  triggerClassName?: string;
  /** The `<SelectItem>`s. SelectField owns the surrounding Select plumbing. */
  children: React.ReactNode;
} & Omit<
  React.ComponentProps<typeof SelectTrigger>,
  "id" | "name" | "value" | "onValueChange" | "aria-invalid" | "aria-describedby" | "children"
>;

/**
 * Select wired to a TanStack Form `field` object — the select counterpart to
 * {@link TextField}. Owns the `htmlFor`/`id` pairing, `aria-invalid`,
 * `aria-describedby`, and the error message, so a field-bound `<Select>` never
 * hand-wires them (the `htmlFor={field.name}` policy rule enforces this).
 *
 * The trigger defaults to full width; most call sites need nothing beyond
 * `field`, `label`, `placeholder`, and the options. A `<SelectItem>` with
 * `value=""` is the conventional "unset" option — pair it with
 * `placeholder` so the empty state reads right.
 */
function SelectField<TValue extends string>({
  field,
  label,
  description,
  placeholder,
  valueLabel,
  className,
  triggerClassName,
  children,
  ...triggerProps
}: SelectFieldProps<TValue>) {
  const reactId = useId();
  const id = `${reactId}-${field.name}`;
  const errorId = `${id}-error`;
  const descriptionId = `${id}-description`;
  const messages = fieldErrorMessages(field.state.meta.errors);
  const invalid = messages.length > 0;
  const describedBy =
    [description ? descriptionId : null, invalid ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={field.state.value}
        // Base UI fires `null` when a clearable select is cleared; these
        // selects are not clearable, and a null is dropped rather than fed to
        // the field. The `as TValue` is the field-boundary assertion the old
        // hand-rolled call sites made: the string arriving here is one of the
        // caller's own <SelectItem> values, which are TValue by construction.
        onValueChange={(value) => {
          if (value !== null) field.handleChange(value as TValue);
        }}
      >
        <SelectTrigger
          {...triggerProps}
          className={cn("w-full", triggerClassName)}
          id={id}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        >
          <SelectValue placeholder={placeholder}>{valueLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
      {description ? (
        <div id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </div>
      ) : null}
      <FieldError id={errorId} errors={field.state.meta.errors} />
    </div>
  );
}

export { SelectField, TextareaField, TextField };
