/**
 * The slice of a TanStack Form instance this helper touches, so it accepts any
 * `useForm` result without naming its long generic signature.
 */
type FormWithFieldMeta<TName extends string, TMeta extends { errorMap: object }> = {
  setFieldMeta: (field: TName, updater: (prev: TMeta) => TMeta) => void;
};

/**
 * Show a server's answer under the field it is about (wrong password, address
 * already registered), with the same `aria-invalid` / `aria-describedby` /
 * `role="alert"` wiring `TextField` gives a validation error.
 *
 * It writes the field's `onSubmit` error slot, where a submit-time validation
 * error would sit. TanStack Form derives `meta.errors` from `errorMap`, so
 * writing `meta.errors` directly does not stick. A field clears its `onSubmit`
 * slot on its next change (with or without validators of its own), so the
 * message goes away as soon as the user edits that field; until then
 * `canSubmit` is false, so the same rejected values are not sent again.
 * docs/ui.md § Server errors on a field.
 */
export function setServerFieldError<TName extends string, TMeta extends { errorMap: object }>(
  form: FormWithFieldMeta<TName, TMeta>,
  field: TName,
  message: string,
) {
  form.setFieldMeta(field, (prev) => ({
    ...prev,
    errorMap: { ...prev.errorMap, onSubmit: message },
  }));
}

/**
 * Drop a server answer from a field without touching the field itself. Use it
 * when the answer was about two fields but shown under one: a wrong email or
 * password is shown under the password, and correcting only the email must
 * let the form submit again.
 */
export function clearServerFieldError<TName extends string, TMeta extends { errorMap: object }>(
  form: FormWithFieldMeta<TName, TMeta>,
  field: TName,
) {
  form.setFieldMeta(field, (prev) => ({
    ...prev,
    errorMap: { ...prev.errorMap, onSubmit: undefined },
  }));
}
