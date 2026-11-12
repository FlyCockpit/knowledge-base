import { DEFAULT_APP_NAME } from "@knowledge-base/env/app-name";
import { mailboxSchema } from "@knowledge-base/env/mailbox";
import { webVars } from "@knowledge-base/env/vars/web";

/**
 * The From: header for outgoing mail. SMTP_FROM may carry its own display name
 * (`"Acme" <no-reply@acme.example>`); a bare address gets the app's name, so
 * mail reads "KnowledgeBase" by default or the deployment's
 * VITE_APP_NAME override.
 */
export function senderHeader(from: string, appName: string): string {
  if (!mailboxSchema.safeParse(from).success) return from;
  const quoted = appName.replace(/[\\"]/g, (char) => `\\${char}`);
  return `"${quoted}" <${from}>`;
}

/** The display name for mail: VITE_APP_NAME validated by its canonical schema, else the default. */
export function senderName(): string {
  // Same canonical schema as the server's resolveAppName; empty counts as unset.
  return webVars.VITE_APP_NAME.parse(process.env.VITE_APP_NAME || undefined) ?? DEFAULT_APP_NAME;
}
