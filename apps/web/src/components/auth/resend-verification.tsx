import { Button } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { friendly, isRateLimit } from "@/utils/friendly-error";

/**
 * Request a fresh email-verification link.
 *
 * Two shapes, one behaviour:
 *   • `email` given (we just created the account) → a single resend button.
 *   • `email` omitted (the user arrived on an expired link) → an email field.
 *
 * Account enumeration: Better-Auth's `/send-verification-email` is already
 * enumeration-safe for anonymous callers — it enforces a constant-time floor so
 * "unknown address" and "real unverified address" take the same wall-clock time,
 * and returns `{ status: true }` either way. We mirror `forgot-password` on top
 * of that: only rate limiting is surfaced, every other failure falls through to
 * the same neutral confirmation so the UI never distinguishes the two cases.
 *
 * The link's destination is not set here — `packages/auth` rewrites every
 * verification email's `callbackURL` to the locale-prefixed `/verify-email`
 * page, so there is no per-caller redirect to keep in sync (or to tamper with).
 */
export function ResendVerification({ email }: { email?: string }) {
  const { t } = useTranslation(["auth"]);
  const [sent, setSent] = useState(false);

  // Terminal state: one link per visit. Re-requesting is a page refresh away,
  // which keeps a bored user from using this button as an email cannon.
  //
  // Two server-side ceilings back this up — NOT `signupLimiter`, which only
  // mounts on /api/auth/sign-up/*: `authLimiter` (per IP, all of /api/auth/*
  // except get-session) and `emailRecipientLimiter` (per recipient address,
  // 3/hour by default), which is what actually stops a rotating-IP flood of one
  // mailbox. Both surface as a 429 that `resend()` below turns into a toast.
  if (sent) {
    return (
      <p className="text-center text-sm text-muted-foreground">{t("auth:verifyEmail.resent")}</p>
    );
  }

  return email ? (
    <ResendButton email={email} onSent={() => setSent(true)} />
  ) : (
    <ResendForm onSent={() => setSent(true)} />
  );
}

/**
 * Fire the resend and report whether the caller should flip to the sent state.
 * Returns false only for rate limiting, the one failure a user can act on.
 */
async function resend(email: string): Promise<boolean> {
  const result = await authClient.sendVerificationEmail({ email });
  if (result.error) {
    if (isRateLimit(result.error)) {
      toast.error(friendly(result.error));
      return false;
    }
    console.error("[resend-verification.send]", result.error);
  }
  return true;
}

function ResendButton({ email, onSent }: { email: string; onSent: () => void }) {
  const { t } = useTranslation(["auth"]);
  const [sending, setSending] = useState(false);

  const handleClick = async () => {
    setSending(true);
    try {
      if (await resend(email)) onSent();
    } finally {
      setSending(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-[44px] w-full"
      disabled={sending}
      onClick={handleClick}
    >
      {sending ? t("auth:verifyEmail.resending") : t("auth:verifyEmail.resend")}
    </Button>
  );
}

function ResendForm({ onSent }: { onSent: () => void }) {
  const { t } = useTranslation(["auth"]);

  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      if (await resend(value.email)) onSent();
    },
    validators: {
      // Validation messages come from the locale-aware Zod error map installed
      // in `@/i18n/zod`. Don't pass inline strings here.
      onSubmit: z.object({
        email: z.email(),
      }),
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="email">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:fields.email")}
            type="email"
            autoComplete="email"
          />
        )}
      </form.Field>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t("auth:verifyEmail.resending") : t("auth:verifyEmail.resend")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
