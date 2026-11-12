# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** through [GitHub private vulnerability reporting](https://github.com/FlyCockpit/knowledge-base/security/advisories/new). Do not open public issues, discussions or pull requests for security problems.

We aim to acknowledge reports within 72 hours.

## Supported versions

Knowledge Base 1.0.0 is the first public release. Only the latest release on `main` receives security fixes.

## Security controls shipped by default

- pnpm 12 supply-chain hardening — release-age gate (7 d), exotic-subdep
  blocking, build-script allowlist, sha512-pinned package manager
  (`pnpm-workspace.yaml`, `package.json#packageManager`).
- SHA-pinned GitHub Actions kept current by Dependabot
  (`.github/dependabot.yml`).
- Trufflehog verified-secret scanning on every PR (`.github/workflows/pr-checks.yml`).
- Trivy HIGH/CRITICAL image scanning on every container build
  (`.github/workflows/build-image.yml`).
- `pnpm audit` on every PR with `--audit-level=high`.
- Non-root `USER node` in the production server and worker images.
- Tight Content-Security-Policy and `secureHeaders` middleware
  (`apps/server/src/security-headers.ts`).
- Tiered rate limiting — per-IP credential (10/minute), auth (30/minute) and
  signup (10/hour) budgets, plus per-recipient email budgets
  (`apps/server/src/rate-limit.ts`).
- Hard production-boot guards in `packages/env/src/server.ts`:
  a weak `BETTER_AUTH_SECRET` refuses to start in production.
- Live grant ceiling intersected with owner/share permissions across MCP, Git,
  media and exports; instance admin never bypasses private-KB authority.
- Revision-bound `/kb-assets/:kbId/:hash?rev=<sha>` admission, trusted MIME,
  private/no-store and nosniff/sandbox headers; no public bearer URL bypass.
- Single-writer process fences, durable one-ref journals and whole-history
  validation before publication; queued effects reauthorize before reservation.
- Sealed plaintext never a tool result: exact human-approved recipient envelopes,
  provider/deploy-key encryption and pinned network egress.
- Offline fenced encrypted bundles; restored browser/OAuth/PAT/device authority
  is revoked, mirrors disconnected and deploy ciphertext destroyed before admission.

Keep operator age identity, master key and authentication secrets separately;
[backup/restore](./docs/backup-restore.md) specifies custody. Treat Markdown,
model text, snippets and citations as untrusted data. Credential-pattern redaction
is a conservative floor, not a secrecy guarantee; clients must redact their own
secrets. Root/store owners and drivers with database credentials remain trusted.
See [MCP permissions](./docs/mcp.md), [Git](./docs/git.md) and
[deployment](./docs/deploy.md) for precise boundaries and limits.

See `AGENTS.md` § "Agent Safety Rules" for the full list of guardrails an
AI coding agent must respect when working in this repo.

## Features that need a paid GitHub tier

The defaults above work on **any repository**, public or private, with no
GitHub Advanced Security (GHAS) subscription. These are intentionally NOT
shipped because they require GHAS on private repos:

- CodeQL (generic JS/TS SAST) — free on public repos; GHAS on private.
- GitHub Dependency Review Action — free on public; GHAS on private.

If the repository is public, or you have GHAS, add either as a workflow at no
behavioral cost.
