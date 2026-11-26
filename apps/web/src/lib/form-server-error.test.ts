import { FieldApi, FormApi } from "@tanstack/react-form";
import { describe, expect, it } from "vitest";
import z from "zod";

import { clearServerFieldError, setServerFieldError } from "./form-server-error";

const WRONG = "That email or password doesn't match.";

/**
 * Same shape as the sign-in form: one form-level submit schema, no field
 * validators, and an `onSubmit` that reports the server's answer on a field.
 */
function signInForm() {
  const form = new FormApi({
    defaultValues: { email: "ada@example.com", password: "wrong-password" },
    validators: { onSubmit: z.object({ email: z.email(), password: z.string().min(1) }) },
    onSubmit: ({ formApi }) => setServerFieldError(formApi, "password", WRONG),
  });
  form.mount();
  const password = new FieldApi({ form, name: "password" });
  password.mount();
  // As on the sign-in page: editing the email clears the credential answer
  // shown under the password.
  const email = new FieldApi({
    form,
    name: "email",
    listeners: { onChange: () => clearServerFieldError(form, "password") },
  });
  email.mount();
  return { form, password, email };
}

describe("setServerFieldError", () => {
  it("puts the message on that field only and blocks resending the same values", async () => {
    const { form, password, email } = signInForm();
    await form.handleSubmit();
    expect(password.state.meta.errors).toEqual([WRONG]);
    expect(email.state.meta.errors).toEqual([]);
    expect(form.state.canSubmit).toBe(false);
  });

  it("clears once the user edits the field", async () => {
    const { form, password } = signInForm();
    await form.handleSubmit();
    password.handleChange("another-try");
    expect(password.state.meta.errors).toEqual([]);
    expect(form.state.canSubmit).toBe(true);
  });

  it("gives way to the schema's own error on the next submit", async () => {
    const { form, password } = signInForm();
    await form.handleSubmit();
    password.handleChange("");
    await form.handleSubmit();
    expect(password.state.meta.errors).toHaveLength(1);
    expect(password.state.meta.errors[0]).not.toBe(WRONG);
  });

  it("clears from the other credential: fixing only the email makes the form submittable", async () => {
    const { form, password, email } = signInForm();
    await form.handleSubmit();
    expect(form.state.canSubmit).toBe(false);
    email.handleChange("ada.l@example.com");
    expect(password.state.meta.errors).toEqual([]);
    expect(password.state.value).toBe("wrong-password");
    expect(form.state.canSubmit).toBe(true);
  });
});
