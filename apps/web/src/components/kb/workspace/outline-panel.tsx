import { cn } from "@knowledge-base/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { documentOutline, type OutlineHeading } from "@/lib/kb-workspace/outline";

/** Indent per heading level below the document's shallowest one. */
const INDENT = ["pl-2", "pl-5", "pl-8", "pl-11", "pl-14", "pl-17"] as const;

/**
 * The open document's headings as a table of contents. Each entry is a
 * link to the heading's `#id` on this same document URL (search kept), which
 * the root hash handling scrolls to and focuses. `markdown` null: nothing
 * open (or not read yet), so there is no outline to show.
 */
export function OutlinePanel({
  lang,
  kbId,
  path,
  markdown,
  onNavigate,
}: {
  lang: string;
  kbId: string;
  path: string;
  markdown: string | null;
  /** After an entry is followed (e.g. close the phone drawer). */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation("kb");
  const headings = useMemo(() => (markdown === null ? [] : documentOutline(markdown)), [markdown]);
  return (
    <nav
      aria-label={t("workspace.outline.label")}
      data-testid="workspace-outline"
      data-path={path}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-clip p-2"
    >
      {markdown === null ? (
        <p className="px-2 py-1 text-sm text-muted-foreground">
          {t("workspace.outline.noDocument")}
        </p>
      ) : headings.length === 0 ? (
        <p className="px-2 py-1 text-sm text-muted-foreground">{t("workspace.outline.empty")}</p>
      ) : (
        <OutlineList lang={lang} kbId={kbId} headings={headings} onNavigate={onNavigate} />
      )}
    </nav>
  );
}

export function OutlineList({
  lang,
  kbId,
  headings,
  onNavigate,
}: {
  lang: string;
  kbId: string;
  headings: readonly OutlineHeading[];
  onNavigate?: () => void;
}) {
  const top = Math.min(...headings.map((heading) => heading.level));
  return (
    <ul className="space-y-0.5">
      {headings.map((heading) => (
        <li key={heading.id}>
          <Link
            to="/$lang/kbs/$kbId/documents"
            params={{ lang, kbId }}
            // Headings live in the read view (the editor's preview has its own
            // ids); the open draft stays with its session.
            search={(prev) => ({ ...prev, mode: undefined })}
            hash={heading.id}
            title={heading.text}
            onClick={onNavigate}
            className={cn(
              "flex min-h-8 items-center rounded-md pr-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11",
              INDENT[heading.level - top] ?? INDENT[5],
              heading.level === top && "font-medium text-foreground",
            )}
          >
            <span className="min-w-0 truncate">{heading.text || heading.id}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
