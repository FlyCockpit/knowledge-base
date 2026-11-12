/**
 * KB share invitation and ownership-transfer offer emails.
 *
 * Both messages carry the acceptance link as a button and as copyable text.
 * The share invitation is identical for every address — known account or
 * not — and also links to sign-up, which returns to the acceptance page, so
 * the email never reveals whether the address has an account.
 */
import enBundle from "../locales/en-US/kb-invitation.json" with { type: "json" };
import esBundle from "../locales/es-MX/kb-invitation.json" with { type: "json" };
import { type MailerLocale, resolveMailerLocale } from "../locales/index.js";
import { escapeHtml, safeHref } from "./html.js";

interface MessageBundle {
  subject: string;
  heading: string;
  body: string; // {{inviter}} and {{kb}} placeholders
  cta: string;
  signupHint: string;
  signupCta: string;
}

interface KbInvitationBundle {
  shareInvite: MessageBundle;
  transferOffer: MessageBundle;
  fallbackLabel: string;
  ignoreFooter: string;
}

const BUNDLES: Record<MailerLocale, KbInvitationBundle> = {
  "en-US": enBundle as KbInvitationBundle,
  "es-MX": esBundle as KbInvitationBundle,
};

function pick(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) =>
    Object.hasOwn(vars, key) ? vars[key]! : `{{${key}}}`,
  );
}

export interface RenderKbInvitationResult {
  subject: string;
  html: string;
}

function render(
  kind: "shareInvite" | "transferOffer",
  args: {
    inviterName: string;
    kbName: string;
    acceptUrl: string;
    signupUrl: string | null;
    locale: string;
  },
): RenderKbInvitationResult {
  const locale = resolveMailerLocale(args.locale);
  const bundle = BUNDLES[locale] ?? BUNDLES["en-US"];
  const en = BUNDLES["en-US"];
  const message = bundle[kind];
  const enMessage = en[kind];
  const subject = pick(message.subject, enMessage.subject);
  const heading = pick(message.heading, enMessage.heading);
  const body = interpolate(pick(message.body, enMessage.body), {
    inviter: escapeHtml(args.inviterName),
    kb: escapeHtml(args.kbName),
  });
  const cta = pick(message.cta, enMessage.cta);
  const fallbackLabel = pick(bundle.fallbackLabel, en.fallbackLabel);
  const ignoreFooter = pick(bundle.ignoreFooter, en.ignoreFooter);
  const acceptHref = safeHref(args.acceptUrl);
  const signup =
    args.signupUrl === null
      ? ""
      : `<p style="margin:0 0 8px;font-size:14px;color:#52525b;line-height:1.5">${pick(
          message.signupHint,
          enMessage.signupHint,
        )}</p>
          <p style="margin:0 0 24px;text-align:center">
            <a href="${safeHref(args.signupUrl)}" style="display:inline-block;padding:10px 24px;border:1px solid #18181b;color:#18181b;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px">${pick(
              message.signupCta,
              enMessage.signupCta,
            )}</a>
          </p>`;

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;max-width:480px">
        <tr><td>
          <h1 style="margin:0 0 16px;font-size:22px;color:#18181b">${heading}</h1>
          <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.5">${body}</p>
          <p style="margin:0 0 24px;text-align:center">
            <a href="${acceptHref}" style="display:inline-block;padding:12px 32px;background:#18181b;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px">${cta}</a>
          </p>
          ${signup}
          <p style="margin:0 0 8px;font-size:13px;color:#71717a">${fallbackLabel}</p>
          <p style="margin:0 0 24px;font-size:13px;color:#18181b;font-family:ui-monospace,Menlo,Monaco,monospace;word-break:break-all">${acceptHref}</p>
          <p style="margin:0;font-size:13px;color:#a1a1aa;line-height:1.5">${ignoreFooter}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html };
}

export interface RenderKbShareInviteArgs {
  /** Inviter display name. HTML-escaped. */
  inviterName: string;
  /** Knowledge base name. HTML-escaped. */
  kbName: string;
  /** Absolute acceptance URL. */
  acceptUrl: string;
  /** Absolute sign-up URL that returns to `acceptUrl`. */
  signupUrl: string;
  locale: string;
}

export function renderKbShareInvite(args: RenderKbShareInviteArgs): RenderKbInvitationResult {
  return render("shareInvite", args);
}

export interface RenderKbTransferOfferArgs {
  inviterName: string;
  kbName: string;
  acceptUrl: string;
  locale: string;
}

export function renderKbTransferOffer(args: RenderKbTransferOfferArgs): RenderKbInvitationResult {
  return render("transferOffer", { ...args, signupUrl: null });
}
