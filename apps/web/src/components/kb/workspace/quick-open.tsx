import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@knowledge-base/ui/components/command";
import { FileText } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { fuzzyFilter } from "@/lib/kb-workspace/fuzzy";

const RESULT_LIMIT = 50;

/** Pure: `text` split into plain and matched pieces, for ranges given in the text's own offsets. */
export function highlightSegments(
  text: string,
  ranges: readonly [number, number][],
): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(at, Math.min(rawStart, text.length));
    const end = Math.max(start, Math.min(rawEnd, text.length));
    if (start > at) out.push({ text: text.slice(at, start), match: false });
    if (end > start) out.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}

/** Ranges of a whole path, shifted into the part [from, to). */
function rangesIn(
  ranges: readonly [number, number][],
  from: number,
  to: number,
): [number, number][] {
  return ranges
    .filter(([a, b]) => b > from && a < to)
    .map(([a, b]) => [Math.max(a, from) - from, Math.min(b, to) - from]);
}

function Highlighted({ text, ranges }: { text: string; ranges: readonly [number, number][] }) {
  return highlightSegments(text, ranges).map((piece, index) =>
    piece.match ? (
      <mark
        key={index}
        className="bg-transparent font-semibold text-foreground underline underline-offset-2"
      >
        {piece.text}
      </mark>
    ) : (
      <span key={index}>{piece.text}</span>
    ),
  );
}

/** One result row: the file name with its matches, then its folder, dimmed. */
export function QuickOpenRow({
  path,
  ranges,
}: {
  path: string;
  ranges: readonly [number, number][];
}): ReactNode {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
  return (
    <>
      <FileText aria-hidden className="size-4 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 font-mono text-sm">
          <Highlighted text={name} ranges={rangesIn(ranges, slash + 1, path.length)} />
        </span>
        {folder && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            <Highlighted text={folder} ranges={rangesIn(ranges, 0, slash + 1)} />
          </span>
        )}
      </span>
    </>
  );
}

/**
 * ⌘P "Go to file": fuzzy-matches the KB's paths in memory (no request per
 * keystroke), best 50 first. Enter opens; ⌘/Ctrl+Enter opens in a new tab.
 */
export function QuickOpen({
  open,
  onOpenChange,
  paths,
  onOpen,
  mac,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: readonly string[];
  onOpen: (path: string, opts: { newTab?: boolean }) => void;
  mac: boolean;
}) {
  const { t } = useTranslation("kb");
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("workspace.quickOpen.title")}
      description={t("workspace.quickOpen.description")}
      className="sm:max-w-xl"
    >
      {open && (
        <QuickOpenPanel
          paths={paths}
          mac={mac}
          onOpen={(path, opts) => {
            onOpenChange(false);
            onOpen(path, opts);
          }}
        />
      )}
    </CommandDialog>
  );
}

/** The dialog's content on its own, so each opening starts with an empty query. */
function QuickOpenPanel({
  paths,
  onOpen,
  mac,
  initialQuery = "",
}: {
  paths: readonly string[];
  onOpen: (path: string, opts: { newTab?: boolean }) => void;
  mac: boolean;
  initialQuery?: string;
}) {
  const { t } = useTranslation("kb");
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState("");
  const results = useMemo(() => fuzzyFilter(query, paths, RESULT_LIMIT), [query, paths]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || !(mac ? event.metaKey : event.ctrlKey)) return;
    const path = results.find((r) => r.path === selected)?.path ?? results[0]?.path;
    if (!path) return;
    event.preventDefault();
    onOpen(path, { newTab: true });
  };
  return (
    <Command
      shouldFilter={false}
      value={selected}
      onValueChange={setSelected}
      onKeyDown={onKeyDown}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t("workspace.quickOpen.placeholder")}
        aria-label={t("workspace.quickOpen.title")}
        autoComplete="off"
        inputMode="search"
      />
      <CommandList className="max-h-[min(60svh,28rem)]">
        <CommandEmpty>{t("workspace.quickOpen.empty")}</CommandEmpty>
        {results.map((result) => (
          <CommandItem
            key={result.path}
            value={result.path}
            onSelect={() => onOpen(result.path, {})}
            className="min-h-11 pointer-fine:md:min-h-9"
          >
            <QuickOpenRow path={result.path} ranges={result.ranges} />
          </CommandItem>
        ))}
      </CommandList>
      <p className="hidden border-t px-3 py-2 text-xs text-muted-foreground sm:block">
        {t("workspace.quickOpen.hint", { mod: mac ? "⌘" : "Ctrl" })}
      </p>
    </Command>
  );
}
