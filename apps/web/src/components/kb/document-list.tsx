import { cn } from "@knowledge-base/ui/lib/utils";
import { ChevronRight, FileText } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { kbDocumentHref } from "@/components/kb/kb-links";
import { routerClick } from "@/components/kb/kb-list";

/** What a row needs from a `documents.list` item. */
type DocumentListEntry = { path: string; title: string | null };

type DocumentFolderGroup<T extends DocumentListEntry> = {
  /** The folder's path with its trailing `/`; "" for documents at the KB root. */
  folder: string;
  items: T[];
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The loaded documents grouped by the folder that holds them: documents at
 * the KB root first, then one group per folder, folders by path. Within a
 * group the server's order (by path) is kept. Only loaded pages are grouped;
 * a later page may add documents to a folder already shown.
 */
export function groupDocumentsByFolder<T extends DocumentListEntry>(
  items: readonly T[],
): DocumentFolderGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const folder = item.path.slice(0, item.path.lastIndexOf("/") + 1);
    const group = groups.get(folder);
    if (group) group.push(item);
    else groups.set(folder, [item]);
  }
  return [...groups]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : compare(a, b)))
    .map(([folder, groupItems]) => ({
      folder,
      items: [...groupItems].sort((a, b) => compare(a.path, b.path)),
    }));
}

/** The title a row shows: the document's own, else its file name without `.md`. */
export function documentDisplayTitle(entry: DocumentListEntry): string {
  if (entry.title) return entry.title;
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  return name.endsWith(".md") && name.length > 3 ? name.slice(0, -3) : name;
}

/** The collapsed folders after one folder's toggle. */
export function toggleFolder(collapsed: ReadonlySet<string>, folder: string): ReadonlySet<string> {
  const next = new Set(collapsed);
  if (next.has(folder)) next.delete(folder);
  else next.add(folder);
  return next;
}

/**
 * A KB's documents, grouped by folder (collapsible, open by default).
 * Each row shows the title first and the path under it.
 */
export function KbDocumentList<T extends DocumentListEntry>({
  lang,
  kbId,
  items,
  onOpen,
}: {
  lang: string;
  kbId: string;
  items: readonly T[];
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation("kb");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (folder: string) => setCollapsed((current) => toggleFolder(current, folder));
  return (
    <ul
      className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"
      data-testid="kb-document-list"
    >
      {groupDocumentsByFolder(items).map((group) =>
        group.folder === "" ? (
          group.items.map((doc) => (
            <li key={doc.path}>
              <DocumentRow lang={lang} kbId={kbId} doc={doc} onOpen={onOpen} />
            </li>
          ))
        ) : (
          <KbDocumentFolder
            key={group.folder}
            folder={group.folder}
            open={!collapsed.has(group.folder)}
            onToggle={() => toggle(group.folder)}
            countLabel={t("detail.folderCount", { count: group.items.length })}
          >
            {group.items.map((doc) => (
              <li key={doc.path}>
                <DocumentRow lang={lang} kbId={kbId} doc={doc} onOpen={onOpen} nested />
              </li>
            ))}
          </KbDocumentFolder>
        ),
      )}
    </ul>
  );
}

export function KbDocumentFolder({
  folder,
  open,
  onToggle,
  countLabel,
  children,
}: {
  folder: string;
  open: boolean;
  onToggle: () => void;
  countLabel: string;
  children: ReactNode;
}) {
  const listId = useId();
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
        className="flex min-h-[44px] w-full min-w-0 items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">
          {folder.slice(0, -1)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{countLabel}</span>
      </button>
      {open && (
        <ul id={listId} className="divide-y border-t">
          {children}
        </ul>
      )}
    </li>
  );
}

function DocumentRow({
  lang,
  kbId,
  doc,
  onOpen,
  nested = false,
}: {
  lang: string;
  kbId: string;
  doc: DocumentListEntry;
  onOpen: (path: string) => void;
  nested?: boolean;
}) {
  return (
    <a
      href={kbDocumentHref(lang, kbId, { path: doc.path })}
      onClick={routerClick(() => onOpen(doc.path))}
      className={cn(
        "flex min-h-[44px] min-w-0 items-center gap-3 py-2.5 pr-4 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        nested ? "pl-11" : "pl-4",
      )}
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{documentDisplayTitle(doc)}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{doc.path}</span>
      </span>
    </a>
  );
}
