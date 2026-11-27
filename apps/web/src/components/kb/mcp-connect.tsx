import { Button } from "@knowledge-base/ui/components/button";
import { CodeSnippet } from "@knowledge-base/ui/components/code-snippet";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { ExternalLink, KeyRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SegmentedControl } from "@/components/segmented-control";
import {
  KB_DOCS,
  MCP_CLIENTS,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_TOKEN_ENV,
  type McpClient,
  mcpClientSnippet,
  mcpServerUrl,
} from "@/lib/mcp-connect";

/**
 * Per-client setup: Claude Code, Codex, or any other MCP client's JSON.
 * Without `token` every client signs in with OAuth; with it (the one-time
 * reveal) the snippets use the token. Exported for tests.
 */
export function McpClientSetup({
  serverUrl,
  token,
  initialClient = "claude",
}: {
  serverUrl: string;
  token?: string;
  initialClient?: McpClient;
}) {
  const { t } = useTranslation("settings");
  const [client, setClient] = useState<McpClient>(initialClient);
  const mode = token === undefined ? "oauth" : "token";
  return (
    <div className="min-w-0 space-y-3">
      <SegmentedControl<McpClient>
        value={client}
        onChange={setClient}
        ariaLabel={t("connect.clientLabel")}
        items={MCP_CLIENTS.map((value) => ({ value, label: t(`connect.clients.${value}`) }))}
      />
      <CodeSnippet
        code={mcpClientSnippet(client, serverUrl, token)}
        copyLabel={t("connect.copySnippet", { client: t(`connect.clients.${client}`) })}
      />
      <p className="text-sm text-muted-foreground">
        {t(`connect.hints.${mode}.${client}`, {
          name: MCP_SERVER_NAME,
          env: MCP_TOKEN_ENV,
        })}
      </p>
    </div>
  );
}

/**
 * Settings → MCP access, first: the server URL and how to add it to a client.
 * OAuth first (no secret to copy); a token for clients that can't sign in.
 */
export function McpConnectCard({
  serverUrl,
  onUseToken,
}: {
  serverUrl: string;
  onUseToken: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <section
      className="min-w-0 space-y-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-6"
      aria-labelledby="mcp-connect"
    >
      <div className="space-y-1">
        <h2 id="mcp-connect" className="text-lg font-semibold">
          {t("connect.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("connect.description")}</p>
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-medium">{t("connect.urlLabel")}</h3>
        <CopyField value={mcpServerUrl(serverUrl)} copyLabel={t("connect.copyUrl")} />
      </div>
      <McpClientSetup serverUrl={serverUrl} />
      <p className="text-sm text-muted-foreground">
        {t("connect.protocol", {
          version: MCP_PROTOCOL_VERSION,
          legacyVersion: MCP_LEGACY_PROTOCOL_VERSION,
        })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" className="min-h-[44px]" onClick={onUseToken}>
          <KeyRound className="size-4" aria-hidden />
          {t("connect.useToken")}
        </Button>
        <a
          href={KB_DOCS.mcp}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] items-center gap-1 px-2 text-sm font-medium underline underline-offset-4"
        >
          {t("connect.docs")}
          <ExternalLink className="size-3.5" aria-hidden />
          <span className="sr-only">{t("connect.opensInNewTab")}</span>
        </a>
      </div>
    </section>
  );
}
