import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { useTranslation } from "react-i18next";

/**
 * The one-line `kb` install commands for this server (apps/server/src/cli-install.ts
 * serves both scripts). Only the origin's scheme/host/port survive, as for clone URLs.
 */
export function cliInstallCommands(origin: string): { unix: string; windows: string } {
  const base = new URL(origin).origin;
  // An IPv6 literal host: quoted so the shell (zsh) does not glob `[...]`, and curl -g
  // so curl does not either.
  if (base.includes("://[")) {
    return {
      unix: `curl -fsSLg '${base}/install.sh' | sh`,
      windows: `irm '${base}/install.ps1' | iex`,
    };
  }
  return {
    unix: `curl -fsSL ${base}/install.sh | sh`,
    windows: `irm ${base}/install.ps1 | iex`,
  };
}

/** Settings → MCP access: install the kb command line and log it in to this server. */
export function CliInstall({ origin }: { origin: string }) {
  const { t } = useTranslation("settings");
  const commands = cliInstallCommands(origin);
  return (
    <section className="min-w-0 space-y-3" aria-labelledby="cli-install">
      <h2 id="cli-install" className="text-lg font-semibold">
        {t("cli.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("cli.description")}</p>
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-medium">{t("cli.unix")}</h3>
        <CopyField value={commands.unix} copyLabel={t("cli.copyUnix")} />
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-medium">{t("cli.windows")}</h3>
        <CopyField value={commands.windows} copyLabel={t("cli.copyWindows")} />
      </div>
      <p className="text-sm text-muted-foreground">{t("cli.hint")}</p>
    </section>
  );
}
