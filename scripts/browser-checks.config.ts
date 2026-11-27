/**
 * The app's own settings for `pnpm check:dialogs` and
 * `pnpm check:shell-loading`: how to sign in, every dialog to open, and the
 * signed-in pages to hard-reload. The check scripts and
 * `browser-check-lib.ts` stay identical to the template's; only this file
 * changes per app.
 * Usage: docs/ui.md § Dialog fit check
 *
 * knowledge-base has no mock mode: run a stack (`pnpm dev:docker <port>`),
 * sign up the accounts below on it, and pass `--url`. The accounts and the
 * ids of the data they own live in a JSON file outside the repo, named by
 * `BROWSER_CHECKS_ACCOUNTS` (never committed):
 *
 *   {
 *     "admin": { "email": "…", "password": "…" },   the instance admin (first sign-up)
 *     "user": { "email": "…", "password": "…" },    a second, non-admin account
 *     "kbId": "…"                                   a KB the admin owns
 *   }
 *
 * An account with two-factor sign-in adds `"totpSecret": "…"`: the setup key
 * shown on Settings → Security when 2FA was turned on (the Base32 key an
 * authenticator app takes), and the checks type a current code at the second
 * step.
 *
 * The admin also needs one personal access token and one API key (created on
 * Settings → MCP access / API keys) for the revoke dialogs.
 */
import { existsSync, readFileSync } from "node:fs";

import {
  type Account,
  type CheckRun,
  decideConsent,
  formSignIn,
  totpCode,
} from "./browser-check-lib.ts";

/**
 * Start a mock-mode dev server when no `--url` is given. This app has no mock
 * mode: the checks run against a running stack and sign in for real.
 */
export const MOCK_SERVER = false;

export type Role = "anonymous" | "user" | "admin";

export interface SignInOptions {
  /** Mock mode only (per-procedure scenarios); ignored on a real stack. */
  overrides?: Record<string, string>;
  /** Mock mode only (every response 2s late); ignored on a real stack. */
  slow?: boolean;
}

interface FixtureAccount {
  email: string;
  password: string;
  totpSecret?: string;
}

interface Fixture {
  admin?: FixtureAccount;
  user?: FixtureAccount;
  kbId?: string;
}

/**
 * The accounts file, or why it is not usable. Never throws at import (the
 * dialog list reads `kbId`), and never echoes the file's text: a JSON.parse
 * message quotes the source around the error, which can be a password.
 */
export function readFixture(file = process.env.BROWSER_CHECKS_ACCOUNTS): {
  fixture: Fixture;
  problem?: string;
} {
  const how = "see the header of scripts/browser-checks.config.ts for its format";
  if (!file)
    return { fixture: {}, problem: `set BROWSER_CHECKS_ACCOUNTS to the accounts file; ${how}` };
  if (!existsSync(file)) return { fixture: {}, problem: `no accounts file at ${file}; ${how}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { fixture: {}, problem: `${file} is not valid JSON; ${how}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { fixture: {}, problem: `${file} is not an accounts object; ${how}` };
  return { fixture: parsed as Fixture };
}

const { fixture: FIXTURE, problem: FIXTURE_PROBLEM } = readFixture();
const KB = `/en-US/kbs/${FIXTURE.kbId ?? "set-kbId-in-BROWSER_CHECKS_ACCOUNTS"}`;
/** What the KB-bound dialogs and pages need, for their failure messages. */
const A_KB = 'a KB the admin owns, named by "kbId" in the accounts file';

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * The bytes of an authenticator setup key (RFC 4648 Base32, any case, spaces
 * and `=` padding ignored), the form 2FA setup shows and `otpauth://` URIs
 * carry. Throws, without echoing the key, when it is not Base32.
 */
export function base32Bytes(key: string): Buffer {
  const clean = key.replace(/[\s=]/g, "").toUpperCase();
  const invalid = new Error('an account\'s "totpSecret" is not a Base32 setup key');
  // Base32 groups end on a whole byte: a final group of 1, 3 or 6 characters
  // cannot be a key's tail, and an empty key would sign codes with no key.
  if (clean.length === 0 || [1, 3, 6].includes(clean.length % 8)) throw invalid;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw invalid;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** The sign-in account for `role` from the fixture, or what to fix. */
export function fixtureAccount(
  role: "user" | "admin",
  { fixture, problem }: { fixture: Fixture; problem?: string } = {
    fixture: FIXTURE,
    problem: FIXTURE_PROBLEM,
  },
): Account {
  if (problem) throw new Error(problem);
  const entry = fixture[role];
  if (!entry || typeof entry.email !== "string" || typeof entry.password !== "string")
    throw new Error(
      `the accounts file has no "${role}" account with email and password (scripts/browser-checks.config.ts)`,
    );
  const key = entry.totpSecret ? base32Bytes(entry.totpSecret) : undefined;
  return {
    email: entry.email,
    password: entry.password,
    ...(key ? { totp: () => totpCode(key) } : {}),
  };
}

/** Who the browser session is signed in as; a check signs in once per role. */
let signedInAs: Role | undefined;

/**
 * Leaves the browser signed in as `role` with cookie consent decided (the
 * banner is not part of what the checks measure), through the app's own
 * sign-in form with the account from `BROWSER_CHECKS_ACCOUNTS`
 * (`formSignIn`: it waits for the form to hydrate and survives the full page
 * load the sign-in ends in). Signing in again as the same role is a no-op, so
 * a run signs in once per role, not once per dialog. `fixture` is for tests.
 */
export async function signIn(
  run: CheckRun,
  role: Role,
  _options: SignInOptions = {},
  fixture?: { fixture: Fixture; problem?: string },
) {
  const { base, browser } = run;
  if (role === signedInAs) return;
  await browser.run(["cookies", "clear"]);
  signedInAs = undefined;
  if (role === "anonymous") {
    await browser.run(["open", `${base}/en-US/login`]);
    await decideConsent({ browser });
  } else {
    await formSignIn(run, fixtureAccount(role, fixture));
  }
  signedInAs = role;
}

export type DialogStep =
  /** Click the first element matching a CSS selector. */
  | { click: string }
  /** Click the button, link or menu item whose trimmed text is exactly this. */
  | { clickText: string };

export interface DialogCase {
  /** Unique; shown in failures and used by `--only`. */
  name: string;
  /** Path with the locale, opened after signing in as `role`. */
  path: string;
  role: Role;
  overrides?: Record<string, string>;
  /** What must exist on the stack for it to open, said when it does not. */
  needs?: string;
  /** Wait for this selector before the steps. */
  ready: string;
  /** Steps that open the dialog. */
  steps: DialogStep[];
}

/**
 * Every dialog the app ships that the checks' stack can open (the admin, a
 * second user, one KB the admin owns, and one personal access token and one
 * API key the admin created on the Create pages), confirmations included.
 * Dialogs that need more data or state first are not listed yet: an open PR
 * (merge, close), an accepted member (revoke, transfer), a mirror, sealed
 * values (the panel needs a sealed-ready KB: add, give access, revoke,
 * delete), a document (delete, download, restore an earlier revision), a
 * provider (revoke), the model runtime and the 2FA policy confirmations.
 * Create API key and Create token are pages, and API key details is a wide
 * side sheet, not dialogs. A dialog that cannot
 * fit moves to a page or a wide side sheet and leaves this list; there is no
 * exemption field.
 */
export const DIALOGS: DialogCase[] = [
  {
    name: "Create knowledge base",
    path: "/en-US/kbs",
    role: "user",
    ready: "main h1",
    steps: [{ clickText: "New knowledge base" }],
  },
  {
    name: "Delete knowledge base",
    path: KB,
    role: "admin",
    needs: A_KB,
    ready: '[data-testid="kb-delete"]',
    steps: [{ click: '[data-testid="kb-delete"]' }],
  },
  {
    name: "Rebuild index",
    path: `${KB}/settings?tab=search`,
    role: "admin",
    needs: A_KB,
    ready: '[data-testid="profile-rebuild"]',
    steps: [{ click: '[data-testid="profile-rebuild"]' }],
  },
  {
    name: "Revoke API key",
    path: "/en-US/settings/api-keys",
    role: "admin",
    needs: "an API key the admin created (Settings → API keys)",
    ready: '[aria-label^="Details for "]',
    steps: [{ click: 'section[aria-labelledby="api-keys-title"] [aria-label^="Revoke "]' }],
  },
  {
    name: "Revoke token",
    path: "/en-US/settings/mcp",
    role: "admin",
    needs: "a personal access token the admin created (Settings → MCP access)",
    ready: 'section[aria-labelledby="credentials-tokens"] [aria-label^="Revoke "]',
    steps: [{ click: 'section[aria-labelledby="credentials-tokens"] [aria-label^="Revoke "]' }],
  },
  {
    name: "Add embedding provider",
    path: "/en-US/settings/embedding-providers",
    role: "user",
    ready: '[data-testid="provider-create"]',
    steps: [{ click: '[data-testid="provider-create"]' }],
  },
  {
    name: "Invite user",
    path: "/en-US/admin/users",
    role: "admin",
    ready: "main h1",
    steps: [{ clickText: "Invite user" }],
  },
  {
    name: "Promote user",
    path: "/en-US/admin/users",
    role: "admin",
    needs: 'the second, non-admin "user" account',
    ready: '[aria-label^="Actions for "]',
    steps: [
      { click: '[aria-label^="Actions for "]:not([disabled])' },
      { clickText: "Promote to admin" },
    ],
  },
];

export interface ShellPage {
  name: string;
  path: string;
  role: Role;
  /**
   * A selector that exists only once the page's real content has loaded, not
   * in any skeleton (a row's action button, say; a card or a list item also
   * exists in the skeleton).
   */
  ready: string;
  /** What must exist on the stack for `ready` to appear, said when it does not. */
  needs?: string;
}

/** Signed-in pages `check:shell-loading` hard-reloads (pick two or more different shapes). */
export const SHELL_PAGES: ShellPage[] = [
  {
    name: "knowledge bases",
    path: "/en-US/kbs",
    role: "admin",
    ready: `main a[href="${KB}"]`,
    needs: A_KB,
  },
  {
    name: "KB settings",
    path: `${KB}/settings`,
    role: "admin",
    needs: A_KB,
    // The first tab's panel: only once the KB has loaded (the settings frame
    // itself also shows while loading and on errors).
    ready: '[data-testid="kb-settings-panel-members"]',
  },
  {
    name: "admin users",
    path: "/en-US/admin/users",
    role: "admin",
    ready: '[aria-label^="Actions for "]',
    needs: 'the second, non-admin "user" account',
  },
  {
    name: "settings API keys",
    path: "/en-US/settings/api-keys",
    role: "admin",
    ready: "#api-keys-title",
  },
  {
    name: "settings MCP access",
    path: "/en-US/settings/mcp",
    role: "admin",
    ready: 'section[aria-labelledby="credentials-tokens"]',
  },
  {
    name: "create API key",
    path: "/en-US/settings/api-keys/new",
    role: "admin",
    ready: 'form[data-slot="form-page"] [role="radiogroup"]',
  },
  {
    name: "create token",
    path: "/en-US/settings/mcp/new",
    role: "admin",
    ready: 'form[data-slot="form-page"] [role="radiogroup"]',
  },
];
