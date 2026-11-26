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
 * The admin also needs one personal access token and one API key (created on
 * Settings → MCP access / API keys) for the revoke dialogs.
 */
import { readFileSync } from "node:fs";

import type { CheckRun } from "./browser-check-lib.ts";

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

interface Account {
  email: string;
  password: string;
}

interface Fixture {
  admin?: Account;
  user?: Account;
  kbId?: string;
}

/** The accounts file, or nothing (the checks then fail at sign-in with the reason). */
function readFixture(): Fixture {
  const file = process.env.BROWSER_CHECKS_ACCOUNTS;
  if (!file) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Fixture;
}

const FIXTURE = readFixture();
const KB = `/en-US/kbs/${FIXTURE.kbId ?? "set-kbId-in-BROWSER_CHECKS_ACCOUNTS"}`;

// The decided cookie consent (apps/web/src/lib/consent.ts), so the banner is
// not part of what the checks measure.
const CONSENT_SCRIPT =
  "localStorage.setItem('knowledge-base.consent.v1', JSON.stringify({ v: 1, analytics: false, decidedAt: Date.now() })); true";

/**
 * Page script that types the account into the sign-in form the way React sees
 * typing (the native value setter, then an input event).
 */
function fillSignInForm(account: Account): string {
  return `(() => {
    const set = (selector, value) => {
      const input = document.querySelector(selector);
      if (!input) throw new Error("no " + selector);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set('input[autocomplete="email"]', ${JSON.stringify(account.email)});
    set('input[autocomplete="current-password"]', ${JSON.stringify(account.password)});
    return true;
  })()`;
}

/** Who the browser session is signed in as; a check signs in once per role. */
let signedInAs: Role | undefined;

/**
 * Leaves the browser signed in as `role` with cookie consent decided (the
 * banner is not part of what the checks measure): fills the sign-in form with
 * the account from `BROWSER_CHECKS_ACCOUNTS`. Signing in again as the same
 * role is a no-op, so a run signs in once per role, not once per dialog.
 */
export async function signIn(run: CheckRun, role: Role, _options: SignInOptions = {}) {
  const { base, browser } = run;
  if (role === signedInAs) return;
  await browser.run(["cookies", "clear"]);
  signedInAs = undefined;
  await browser.run(["open", `${base}/en-US/login`]);
  await browser.run(["eval", CONSENT_SCRIPT]);
  if (role === "anonymous") {
    signedInAs = role;
    return;
  }
  const account = FIXTURE[role];
  if (!account)
    throw new Error(
      `no "${role}" account: set BROWSER_CHECKS_ACCOUNTS (scripts/browser-checks.config.ts)`,
    );
  await browser.run(["wait", 'input[autocomplete="current-password"]']);
  // Through stdin, so the password is in no process's arguments and in no
  // error message (a failed command's message quotes its arguments).
  await browser.run(["eval", "--stdin"], fillSignInForm(account));
  // Submit the form itself: a pointer click can land on whatever floats over
  // the button at this viewport (the cookie banner, dev tools).
  await browser.run(["eval", "document.querySelector('main form').requestSubmit(); true"]);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if ((await browser.run(["eval", "location.pathname"])).replaceAll('"', "") !== "/en-US/login") {
      signedInAs = role;
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`signing in as ${role} did not leave the sign-in page within 30s`);
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
    ready: '[data-testid="kb-delete"]',
    steps: [{ click: '[data-testid="kb-delete"]' }],
  },
  {
    name: "Rebuild index",
    path: `${KB}/settings?tab=search`,
    role: "admin",
    ready: '[data-testid="profile-rebuild"]',
    steps: [{ click: '[data-testid="profile-rebuild"]' }],
  },
  {
    name: "Revoke API key",
    path: "/en-US/settings/api-keys",
    role: "admin",
    ready: '[aria-label^="Details for "]',
    steps: [{ click: 'section[aria-labelledby="api-keys-title"] [aria-label^="Revoke "]' }],
  },
  {
    name: "Revoke token",
    path: "/en-US/settings/mcp",
    role: "admin",
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
}

/** Signed-in pages `check:shell-loading` hard-reloads (pick two or more different shapes). */
export const SHELL_PAGES: ShellPage[] = [
  {
    name: "knowledge bases",
    path: "/en-US/kbs",
    role: "admin",
    ready: `main a[href="${KB}"]`,
  },
  {
    name: "KB settings",
    path: `${KB}/settings`,
    role: "admin",
    // The first tab's panel: only once the KB has loaded (the settings frame
    // itself also shows while loading and on errors).
    ready: '[data-testid="kb-settings-panel-members"]',
  },
  {
    name: "admin users",
    path: "/en-US/admin/users",
    role: "admin",
    ready: '[aria-label^="Actions for "]',
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
