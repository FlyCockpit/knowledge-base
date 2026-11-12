# Sitemap

Current routes for the web app (`apps/web/src/routes/`).

Every URL is prefixed with a locale segment — `/{lang}/...` where `{lang}` is one of the supported BCP 47 tags (currently `en-US`, `es-MX`). Visiting an unprefixed path or an unknown locale 302s to `/${DEFAULT_LOCALE}/...`.

## Public Routes

Only indexable content pages belong in `apps/server/src/seo.ts` `PUBLIC_PATHS` for `/sitemap.xml` and `/llms.txt`. Auth and restricted utility routes below are public routes in the router sense, but intentionally excluded from SEO discovery.

| Path | Description |
|------|-------------|
| `/{lang}/` | Landing page. All of its copy lives in the i18n bundles (`packages/locales/src/<lang>/common.json`, `home.*`) — edit it there, not in the component. The only entry in `PUBLIC_PATHS`. |
| `/{lang}/login` | Sign in page with SSO, email/password, and 2FA support. Shows a "Sign Up" link to `/{lang}/signup` when `SIGNUP_ENABLED=true` |
| `/{lang}/signup` | Create-account page (email/password). Gated on `SIGNUP_ENABLED`; redirects to `/{lang}/login` when signup is disabled or the visitor is already signed in |
| `/{lang}/forgot-password` | Request a password-reset link (email/password). Always shows the same "check your email" success state (no account enumeration); deflects to `/{lang}/login` when `FORCE_SSO` or SMTP is unconfigured |
| `/{lang}/reset-password` | Complete a password reset from the emailed link — reads `?token=`/`?error=` from Better-Auth's `/api/auth/reset-password/:token` redirect. Renders an invalid/expired state with a link back to `/{lang}/forgot-password`; on success toasts and redirects to `/{lang}/login` |
| `/{lang}/mcp-login` | MCP OAuth provider login page. No UI of its own: a signed-in visitor continues to `/{lang}/mcp-consent`, anyone else goes to `/{lang}/login?redirectTo=<consent URL>`; the signed OAuth query is carried raw. Not in SEO discovery. |
| `/{lang}/mcp-consent` | MCP OAuth consent (session required; anonymous visitors bounce to `/{lang}/mcp-login`). Renders only server-validated client/redirect/resource/scopes from `mcpConsent.prepare`, an explicit per-KB bit picker (nothing preselected, empty ACL stated), optional create bits (sealed values require the CLI or a PAT); approve/deny. Not in SEO discovery. |
| `/{lang}/device` | CLI device approval (Better Auth `verificationUri`; session required, any signed-in user, not admin-only; anonymous visitors go to `/{lang}/login?redirectTo=<device URL>`). Without a valid `?user_code=` it asks for the code. Claims the code with a cookie `GET /api/auth/device?user_code=`, then shows the code to compare and the same explicit KB picker as consent (nothing preselected, empty ACL stated); approve records the selection then posts the nonce-bound approval; deny posts denial only. Explicit wrong/expired/used, refused, uncertain, changed-rights and sign-in states. Not in SEO discovery. |
| `/{lang}/verify-email` | Landing page for the emailed account-verification link. Better-Auth's `/api/auth/verify-email` validates the token first and redirects here — with `?ok=1` on success, or `?ok=1&error=TOKEN_EXPIRED\|INVALID_TOKEN\|USER_NOT_FOUND` when the token fails. A **bare** visit is treated as unverified. Renders a confirmation (with a sign-in CTA; verification creates no session) or a pending/expired-link state with a resend form. |

## Authenticated Routes

All require an active session (enforced by the `_auth` layout).

| Path | Description |
|------|-------------|
| `/{lang}/dashboard` | Signed-in home with a link to the knowledge-base list; admin users/jobs/settings stay under `/admin`. |
| `/{lang}/kbs` | Knowledge bases in two sections, "Owned" and "Shared with me" (`kbs.list` with `relation`, each its own cursor pages + Load more; every item carries `isOwner`). Create → Dialog; when the returned capability bits lack `read` the new KB is not opened. The instance admin role grants no extra KBs. |
| `/{lang}/kbs/{kbId}` | One KB: name/description, write mode, per-KB search (hybrid query, or the structured service when type/title/tags filters are set; freshness shown; an unavailable index shows an error and no results), and the document list. Edit details → Sheet (pinned `metadataVersion`; a conflict reloads) with `manage`; Delete → AlertDialog typing DELETE only for the owner (`isOwner`; the server enforces it). A denied action starts a fresh `kbs.get` admission after cancelling any older cached read; only a re-check that says read access is gone clears the KB's cached private data. |
| `/{lang}/kbs/{kbId}/documents?path=&rev=&mode=new` | Raw Markdown textarea editor (bytes saved exactly as typed) with a live preview through the same safe renderer (only media the saved document already references are shown; nothing remote is fetched). `rev` pins a commit (search citations always pass the cited commit) and is read-only when it is not the branch head. Save/propose/delete send the full branch `baseRevision` and an idempotency key reused only for a retry of the identical payload; >128 KiB goes through upload staging. Shows applied (commit + index job), proposed (link to the proposal), noop, and conflict (keeps the text, shows the new head; continuing on it is an explicit choice). |
| `/{lang}/kbs/{kbId}/prs?status=` | Pull requests of one KB (`pullRequests.list`, cursor pages + Load more), filterable by OPEN/CONFLICT/CLOSED/MERGED (CONFLICT = no longer applies to main, rechecked when main moved). Each row names its author and how they acted. Linked from the KB page. |
| `/{lang}/kbs/{kbId}/prs/{number}` | Rendered PR review: before (base SHA) / after (head SHA) Markdown through the safe viewer with an optional text diff, and touched assets (added/removed/replaced) with exact hashes and revision-bound previews. Diff pages (≤50 deltas) keep the first page's exact base/head/target; completeness is shown only after the final page. The header names the author ("Opened by Bob Builder via bob-direct", or "via web"). Merge (needs `review`, complete diff, type MERGE) and close (`review`, or the author — the person, from any of their credentials — with `propose`, plain confirmation) submit exactly the displayed head/target SHAs; while the PR is CONFLICT (it no longer applies to main) Merge stays visible but disabled with the explanation. A CONFLICT carries server details: moved main and/or proposal head asks to view the new diff (nothing is resubmitted or re-read to guess), a PR closed/merged elsewhere says so, and a content conflict explains that the author can update it by proposing again against main; no generic toast is added. Merge/close denials still trigger an actor-bound fresh KB read-access check after navigating away; an actor change before or during that check cannot retire the successor actor's cache. Before/after document denials trigger a fresh KB read-access check; confirmed loss clears the diff and bodies, while operation-only or missing-file refusals preserve readable content. Confirmations and pending outcomes belong to one KB/PR/actor; changing identity or displayed revisions requires fresh confirmation. Added/deleted file retries read only the existing side. Merged PRs show the recorded merge commit. |
| `/{lang}/kbs/{kbId}/settings?accept=&transfer=` | KB settings, linked from the KB page. Members (needs `manage`): neutral share invite (identical feedback and acceptance link for every address; no user lookup), accepted-member list by user id, revoke (AlertDialog typing REVOKE), and (owner only) transfer request to an accepted member pinned to the current `metadataVersion` (typing TRANSFER). `accept`/`transfer` show the recipient's acceptance card even before they can read the KB; ownership changes only on acceptance. Embedding profile: generation state (the old usable generation keeps serving while a build runs), attach one exact ready provider revision or rebuild (typing RUN). Sealed values (shown to the owner only; the server enforces ownership): bounded secret input → opaque reference only, exact one-record/one-key grant, record revoke (typing DELETE); no record listing or read-back. A denied control action re-checks `kbs.get`: the KB view and cache stay and the controls re-derive, unless that check says read access is gone. |
| `/{lang}/settings` | Profile settings (name, email display) |
| `/{lang}/settings/security` | Two-factor authentication enable/disable |
| `/{lang}/settings/mcp` | The user's own personal access tokens and connected OAuth apps: list, revoke (AlertDialog with type-to-confirm), and create a PAT (Dialog with the shared KB picker; secret shown once and cleared on close). Create offers expiry presets (30/90/365 days, default 90), a custom date, or No expiry (with a warning); a no-expiry token is listed as "Never expires". |
| `/{lang}/settings/embedding-providers` | The user's own OpenAI-compatible embedding providers (`embeddingProviders.listMine`, public projections only): add (Dialog; endpoint and API key live only in the transient form, cleared on close, never fetched back), re-probe (new revision with re-entered settings), revoke (AlertDialog typing REVOKE). Each row carries its latest probe state: pending polls until that exact revision is ready; a probe that fails in the worker shows "failed" with a reason, one with no worker progress for 2 minutes after its due time or last heartbeat (dispatch publication does not renew this clock) is made terminal by the next list read and shows "timed out" (never "Probing…" forever); a provider revoked meanwhile shows the probe as failed. |

## Admin Routes

Gated by the `admin` layout (`apps/web/src/routes/$lang/_app/admin.tsx`). Non-admins (and unauthenticated visitors) see a 404 instead of a redirect — the admin tree is hidden, not just protected.

| Path | Description |
|------|-------------|
| `/{lang}/admin` | Overview — backup status and shortcuts to users, jobs, and settings |
| `/{lang}/admin/users` | User management — invite, search/filter, promote/demote, archive/restore, delete (AlertDialog with type-to-confirm). Self-actions are blocked client- and server-side. |
| `/{lang}/admin/jobs` | Failed background jobs across all BullMQ queues. |
| `/{lang}/admin/settings` | Admin-only settings panel (e.g. force-2FA toggle) |

## Navigation

Navigation destinations are defined once in `apps/web/src/lib/nav-items.ts` and filtered by
audience (`public`, `authenticated`, `admin`) plus placement (`desktop`, `mobile`,
`userMenu`).

- **Desktop**: Header main nav shows Home to everyone. Signed-in users also see Dashboard, Knowledge bases and Settings. Admins also see Admin.
- **Mobile**: Bottom tab bar renders the same set as desktop.
- **User menu**: Signed-out visitors get Sign In / Sign Up actions. Signed-in users get Settings; Admin appears only for admins.
- **Cookie banner**: global UI, not a page. Mounted once in `__root.tsx`.

## Notes

- Keep this file updated as new pages are added.
- The `_auth` layout also enforces mandatory 2FA setup when the role-scoped 2FA policy requires it.
- The `admin` layout returns 404 for non-admins; do not add admin links to navigation visible to all users.
- All client-side links should preserve the current locale segment — use `<Link to="/$lang/dashboard" params={{ lang }} />` rather than hardcoded `/dashboard` strings.

## Operator documentation

Repository guides are Markdown files, not public app routes; `PUBLIC_PATHS`
remains the landing page only. See [MCP](./docs/mcp.md), [Git](./docs/git.md),
[assets](./docs/assets.md), [embeddings](./docs/embeddings.md),
[deployment](./docs/deploy.md), [backup/restore](./docs/backup-restore.md),
[CLI](./docs/cli.md) and [Cockpit adapter](./docs/cockpit-adapter.md).
