import enBundle from "../locales/en-US/data-deletion.json" with { type: "json" };
import esBundle from "../locales/es-MX/data-deletion.json" with { type: "json" };
import { type MailerLocale, resolveMailerLocale } from "../locales/index.js";
import { escapeHtml } from "./html.js";

const BUNDLES: Record<MailerLocale, typeof enBundle> = { "en-US": enBundle, "es-MX": esBundle };
export interface RenderDataDeletionArgs {
  name: string;
  effects: string | null;
  deletedAt: Date;
  backup: string | null;
  note: string | null;
  locale: string;
}
export interface RenderDataDeletionResult {
  subject: string;
  html: string;
}

export function renderDataDeletion(args: RenderDataDeletionArgs): RenderDataDeletionResult {
  const locale = resolveMailerLocale(args.locale);
  const bundle = BUNDLES[locale];
  const t = (key: keyof typeof enBundle) => bundle[key] || enBundle[key];
  const field = (key: keyof typeof enBundle, value: string) =>
    `<dt>${escapeHtml(t(key))}</dt><dd>${escapeHtml(value)}</dd>`;
  return {
    subject: t("subject"),
    html: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8" /></head><body>
      <h1>${escapeHtml(t("heading"))}</h1><p>${escapeHtml(t("body"))}</p><dl>
      ${field("migration", args.name)}
      ${field("deletedAt", args.deletedAt.toISOString())}
      ${field("effects", args.effects ?? t("unknownEffects"))}
      ${field("backup", args.backup ?? t("noBackup"))}
      ${args.note ? field("note", args.note) : ""}
      </dl><p>${escapeHtml(t("recovery"))}</p></body></html>`,
  };
}
