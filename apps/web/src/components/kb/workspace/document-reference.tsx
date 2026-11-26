import { buttonVariants } from "@knowledge-base/ui/components/button";
import { CodeSnippet } from "@knowledge-base/ui/components/code-snippet";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Popover, PopoverContent, PopoverTrigger } from "@knowledge-base/ui/components/popover";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { kbDocumentHref } from "@/components/kb/kb-links";

/** The document's shareable URL in this app (on main: the latest version). */
export function documentLink(origin: string, lang: string, kbId: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${kbDocumentHref(lang, kbId, { path })}`;
}

/**
 * What an MCP client calls to read this document: `knowledge_documents_get`
 * with exactly the fields its input schema accepts (`kbId`, `path`; no `rev`,
 * so the agent reads the latest version).
 */
export function agentReference(kbId: string, path: string): string {
  return `knowledge_documents_get ${JSON.stringify({ kbId, path }, null, 2)}`;
}

/**
 * "Copy link": the document's URL for people, and the reference an agent
 * (an MCP client) uses to fetch the same document.
 */
export function DocumentReference({
  origin,
  lang,
  kbId,
  kbName,
  path,
  className,
}: {
  origin: string;
  lang: string;
  kbId: string;
  kbName: string;
  path: string;
  className?: string;
}) {
  const { t } = useTranslation("kb");
  return (
    <Popover>
      <PopoverTrigger
        className={cn(buttonVariants({ variant: "outline", size: "touch" }), className)}
        data-testid="document-reference"
      >
        <Link2 aria-hidden className="size-4" />
        {/* Icon only on phones (the toolbar is narrow); the name stays. */}
        <span className="max-sm:sr-only">{t("workspace.reference.copyLink")}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(28rem,calc(100vw-2rem))]">
        <DocumentReferenceBody
          origin={origin}
          lang={lang}
          kbId={kbId}
          kbName={kbName}
          path={path}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The popover's content (exported for tests). */
export function DocumentReferenceBody({
  origin,
  lang,
  kbId,
  kbName,
  path,
}: {
  origin: string;
  lang: string;
  kbId: string;
  kbName: string;
  path: string;
}) {
  const { t } = useTranslation("kb");
  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("workspace.reference.linkTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("workspace.reference.linkDescription")}</p>
      </div>
      <CopyField
        value={documentLink(origin, lang, kbId, path)}
        copyLabel={t("workspace.reference.copyLinkLabel")}
      />
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium">{t("workspace.reference.agentTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {t("workspace.reference.agentDescription", { name: kbName, path })}
        </p>
        <CodeSnippet
          code={agentReference(kbId, path)}
          copyLabel={t("workspace.reference.copyAgentLabel")}
        />
      </div>
    </div>
  );
}
