import { z } from "zod";

/** ASCII addr-spec supported by our SMTP transport (no lists or display names). */
export const mailboxSchema = z
  .email()
  .max(254)
  .refine((value) => {
    const [local, domain] = value.split("@");
    return (
      !!local &&
      !!domain &&
      local.length <= 64 &&
      domain.length <= 253 &&
      domain.split(".").every((label) => label.length <= 63)
    );
  }, "Invalid mailbox length");

/** One mailbox, optionally with a bounded display name; never a From list/group. */
export const smtpFromSchema = z.string().refine((value) => {
  if ([...value].some((char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127))
    return false;
  if (mailboxSchema.safeParse(value).success) return true;
  const match = /^("(?:[^"\\]|\\[ -~])*"|[^",;:<>\\]+) <([^<>]+)>$/.exec(value);
  return (
    !!match &&
    new TextEncoder().encode(match[1]).length <= 256 &&
    mailboxSchema.safeParse(match[2]).success
  );
}, "SMTP_FROM must be exactly one mailbox, optionally with a display name");
