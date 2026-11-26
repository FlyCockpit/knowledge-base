import { Button } from "@knowledge-base/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@knowledge-base/ui/components/sheet";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Files, X } from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { WideContent } from "@/components/wide-content";

export type StripTab = {
  key: string;
  /** Short name on the tab (the file name). */
  label: string;
  /** Full description (the path, and the version when not main). */
  title: string;
  dirty: boolean;
};

/** Pure: the tab a strip key moves to (Left/Right wrap, Home/End), or null for other keys. */
export function tabStripTarget(
  keys: readonly string[],
  current: string,
  key: string,
): string | null {
  const at = keys.indexOf(current);
  if (at < 0 || keys.length === 0) return null;
  switch (key) {
    case "ArrowRight":
      return keys[(at + 1) % keys.length]!;
    case "ArrowLeft":
      return keys[(at - 1 + keys.length) % keys.length]!;
    case "Home":
      return keys[0]!;
    case "End":
      return keys[keys.length - 1]!;
    default:
      return null;
  }
}

/**
 * Open files as tabs (the wsmp terminal strip pattern): a WAI-ARIA tablist
 * with one tab stop, arrow keys move and activate, Delete closes the focused
 * tab, middle-click closes, and each tab has its own close button. The panel
 * it controls has the id `panelId`.
 */
export function TabStrip({
  tabs,
  activeKey,
  onActivate,
  onClose,
  ariaLabel,
  panelId,
  className,
}: {
  tabs: readonly StripTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  ariaLabel: string;
  /** The document panel's id (`aria-controls`). */
  panelId?: string;
  className?: string;
}) {
  const { t } = useTranslation("kb");
  const baseId = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const keys = tabs.map((tab) => tab.key);
  // The single tab stop: the active tab, else the first.
  const stop = activeKey !== null && keys.includes(activeKey) ? activeKey : (keys[0] ?? null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.key === "Delete") {
      event.preventDefault();
      onClose(key);
      return;
    }
    const target = tabStripTarget(keys, key, event.key);
    if (target === null) return;
    event.preventDefault();
    onActivate(target);
    refs.current.get(target)?.focus();
  };

  if (tabs.length === 0) return null;
  return (
    <WideContent
      role="tablist"
      aria-label={ariaLabel}
      data-testid="kb-tab-strip"
      className={cn("flex items-stretch border-b bg-muted/30", className)}
    >
      {tabs.map((tab) => {
        const selected = tab.key === activeKey;
        const labelId = `${baseId}-${keys.indexOf(tab.key)}`;
        return (
          <div
            key={tab.key}
            role="presentation"
            className={cn(
              "group/tab relative flex max-w-64 shrink-0 items-center border-r",
              selected
                ? "bg-background after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-primary"
                : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            <button
              ref={(node) => {
                if (node) refs.current.set(tab.key, node);
                else refs.current.delete(tab.key);
              }}
              type="button"
              role="tab"
              id={labelId}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={tab.key === stop ? 0 : -1}
              title={tab.title}
              data-tab-key={tab.key}
              onClick={() => onActivate(tab.key)}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                onClose(tab.key);
              }}
              onKeyDown={(event) => onKeyDown(event, tab.key)}
              className="flex min-h-10 min-w-0 items-center gap-2 py-2 pr-1 pl-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:min-h-11"
            >
              <span className="min-w-0 truncate">{tab.label}</span>
              {tab.dirty && (
                <>
                  <span
                    aria-hidden
                    data-testid="tab-dirty"
                    className="size-2 shrink-0 rounded-full bg-primary"
                  />
                  <span className="sr-only">, {t("workspace.tabs.unsaved")}</span>
                </>
              )}
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              aria-label={t("workspace.tabs.close", { name: tab.label })}
              title={t("workspace.tabs.close", { name: tab.label })}
              onClick={() => onClose(tab.key)}
              className="mr-1 shrink-0 opacity-60 group-hover/tab:opacity-100 pointer-coarse:size-11"
            >
              <X aria-hidden className="size-3.5" />
            </Button>
          </div>
        );
      })}
    </WideContent>
  );
}

/**
 * Narrow widths have no strip: one button opens a sheet of the open files
 * ("Recent files"), each with its own close button.
 */
export function TabSwitcher({
  tabs,
  activeKey,
  onActivate,
  onClose,
}: {
  tabs: readonly StripTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
}) {
  const { t } = useTranslation("kb");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="touch"
        onClick={() => setOpen(true)}
        data-testid="kb-tab-switcher"
        aria-label={t("workspace.tabs.switcherButton", { count: tabs.length })}
      >
        <Files aria-hidden className="size-4" />
        {/* Phones show the count only; the full label is the button's name. */}
        <span className="max-sm:sr-only">
          {t("workspace.tabs.switcherButton", { count: tabs.length })}
        </span>
        <span aria-hidden className="tabular-nums sm:hidden">
          {tabs.length}
        </span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[80svh]">
          <SheetHeader>
            <SheetTitle>{t("workspace.tabs.switcher")}</SheetTitle>
            <SheetDescription>{t("workspace.tabs.switcherDescription")}</SheetDescription>
          </SheetHeader>
          <TabSwitcherList
            tabs={tabs}
            activeKey={activeKey}
            onActivate={(key) => {
              setOpen(false);
              onActivate(key);
            }}
            onClose={onClose}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The switcher's list on its own (rendered inside the sheet; tested statically). */
export function TabSwitcherList({
  tabs,
  activeKey,
  onActivate,
  onClose,
}: {
  tabs: readonly StripTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
}) {
  const { t } = useTranslation("kb");
  if (tabs.length === 0) {
    return (
      <p className="px-4 pb-4 text-sm text-muted-foreground">{t("workspace.tabs.switcherEmpty")}</p>
    );
  }
  return (
    <ul className="min-h-0 divide-y overflow-y-auto overflow-x-clip px-2 pb-[max(1rem,var(--safe-area-bottom,0px))]">
      {tabs.map((tab) => (
        <li key={tab.key} className="flex items-center gap-1">
          <button
            type="button"
            aria-current={tab.key === activeKey ? "page" : undefined}
            onClick={() => onActivate(tab.key)}
            className={cn(
              "flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              tab.key === activeKey && "font-medium",
            )}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-mono text-sm">{tab.label}</span>
              {tab.dirty && (
                <>
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
                  <span className="sr-only">, {t("workspace.tabs.unsaved")}</span>
                </>
              )}
            </span>
            <span className="w-full min-w-0 truncate font-mono text-xs text-muted-foreground">
              {tab.title}
            </span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            aria-label={t("workspace.tabs.close", { name: tab.label })}
            onClick={() => onClose(tab.key)}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
