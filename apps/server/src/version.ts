/**
 * This server's release version. Server, worker and the `kb` CLI version in
 * lockstep: the Release workflow refuses a tag that differs from this,
 * `apps/server/package.json` or `apps/cli/Cargo.toml` (cli-install.test.ts
 * keeps the three equal). `/install.sh` and `/install.ps1` install the CLI
 * release of exactly this version.
 */
export const SERVER_VERSION = "1.0.0";
