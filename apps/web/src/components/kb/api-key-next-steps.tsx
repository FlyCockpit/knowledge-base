import { CodeSnippet } from "@knowledge-base/ui/components/code-snippet";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  API_KEY_ENV,
  apiKeyCheckCommands,
  type ChildCeiling,
  childMintCommands,
  KB_DOCS,
  restApiOpenApiUrl,
} from "@/lib/mcp-connect";

/** The REST API guide and the served OpenAPI document, opened in a new tab. */
export function RestApiLinks({ serverUrl }: { serverUrl: string }) {
  const { t } = useTranslation("settings");
  const links = [
    { href: KB_DOCS.restApi, label: t("apiKeys.next.guide") },
    { href: restApiOpenApiUrl(serverUrl), label: t("apiKeys.next.openApi") },
  ];
  return (
    <div className="flex flex-wrap gap-x-4">
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-foreground underline underline-offset-4"
        >
          {link.label}
          <ExternalLink className="size-3.5" aria-hidden />
          <span className="sr-only">{t("connect.opensInNewTab")}</span>
        </a>
      ))}
    </div>
  );
}

/**
 * What to do with an API key: mint an MCP token for one of its knowledge
 * bases (a key that may mint), or check the key. Shown after the one-time
 * reveal and in the key's details; the key itself never appears in it.
 */
export function ApiKeyNextSteps({
  serverUrl,
  ceiling,
}: {
  serverUrl: string;
  /** The key's child ceiling, or null when it can't mint tokens. */
  ceiling: ChildCeiling | null;
}) {
  const { t } = useTranslation("settings");
  return (
    <section className="min-w-0 space-y-2" aria-labelledby="api-key-next">
      <h3 id="api-key-next" className="text-sm font-medium">
        {t(ceiling ? "apiKeys.next.mintTitle" : "apiKeys.next.checkTitle")}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t(
          ceiling === null
            ? "apiKeys.next.checkHint"
            : ceiling.reach === "created"
              ? "apiKeys.next.mintCreatedHint"
              : "apiKeys.next.mintHint",
          { env: API_KEY_ENV },
        )}
      </p>
      <CodeSnippet
        code={
          ceiling
            ? childMintCommands(serverUrl, ceiling, {
                listedId: t("apiKeys.next.listedId"),
                createdId: t("apiKeys.next.createdId"),
              })
            : apiKeyCheckCommands(serverUrl)
        }
        copyLabel={t(ceiling ? "apiKeys.next.copyMint" : "apiKeys.next.copyCheck")}
      />
      <RestApiLinks serverUrl={serverUrl} />
    </section>
  );
}
