import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { BookOpen, ChevronDown, GripVertical, Pin, PinOff } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { dropPin, movePin, type PinnedKb, useKbPins } from "@/hooks/use-kb-pins";
import {
  readSidebarKbsOpen,
  recentKbsSnapshot,
  subscribeRecentKbs,
  writeSidebarKbsOpen,
} from "@/lib/recent-kbs";

/** Remembered ids sent: the server skips pinned ones, then names up to 5 readable. */
const SIDEBAR_RECENT_ASKED = 10;

/**
 * The sidebar's "Knowledge bases" entry, expandable: its link, a disclosure
 * button (remembered per viewer), and under it the viewer's pinned bases
 * (their order), a few recently opened ones, and View all.
 */
export function KbSidebarSection({
  lang,
  userId,
  currentKbId,
  link,
}: {
  lang: string;
  userId: string;
  currentKbId: string | null;
  /** The existing "Knowledge bases" sidebar link. */
  link: ReactNode;
}) {
  const { t } = useTranslation("nav");
  const listId = useId();
  const [open, setOpen] = useState(() => readSidebarKbsOpen(userId));
  const toggle = () => {
    writeSidebarKbsOpen(userId, !open);
    setOpen(!open);
  };
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center">
        <div className="min-w-0 flex-1 [&>a]:w-full">{link}</div>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={t("sidebar.kbs.toggle")}
          title={t("sidebar.kbs.toggle")}
          onClick={toggle}
          className="shrink-0 text-muted-foreground"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 transition-transform duration-(--duration-base) motion-reduce:transition-none",
              !open && "-rotate-90",
            )}
          />
        </Button>
      </div>
      <div id={listId} hidden={!open}>
        {open && <KbSidebarList lang={lang} userId={userId} currentKbId={currentKbId} />}
      </div>
    </div>
  );
}

function KbSidebarList({
  lang,
  userId,
  currentKbId,
}: {
  lang: string;
  userId: string;
  currentKbId: string | null;
}) {
  const { t } = useTranslation("nav");
  // Follows every KB opened (this tab at once, other tabs through `storage`).
  const remembered = useSyncExternalStore(
    subscribeRecentKbs,
    () => recentKbsSnapshot(userId),
    () => recentKbsSnapshot(userId),
  );
  // The server names the ones the viewer can read now (unreadable ones are left out).
  const pins = useKbPins({ recent: remembered.slice(0, SIDEBAR_RECENT_ASKED) });
  const [said, setAnnouncement] = useState<{ kbId: string; text: string } | null>(null);
  // An announcement lasts while its KB is a readable pin (never a name it lost).
  const announcement = announcementFor(said, pins.items);
  const pinnedIds = new Set(pins.items.map((item) => item.kbId));
  const recent = pins.recent.filter((kb) => !pinnedIds.has(kb.kbId));
  const reorder = (next: PinnedKb[], moved: string) => {
    const at = next.findIndex((item) => item.kbId === moved);
    const name = next[at]?.name ?? "";
    // Said once when made; cleared when taken (so the same move later is said
    // again); refused, the live region says the order stayed.
    pins.reorder(next, (done) =>
      setAnnouncement(done ? null : { kbId: moved, text: t("sidebar.kbs.moveRefused", { name }) }),
    );
    setAnnouncement({
      kbId: moved,
      text: t("sidebar.kbs.moved", { name, position: at + 1, count: next.length }),
    });
  };
  return (
    <KbSidebarListView
      lang={lang}
      pinned={pins.items}
      recent={recent}
      currentKbId={currentKbId}
      announcement={announcement}
      busy={pins.busy}
      pinning={pins.pinning}
      state={
        pins.isOffline ? "offline" : pins.isPending ? "pending" : pins.isError ? "error" : "ready"
      }
      onRetry={pins.refetch}
      onPin={(kb) => pins.pin(kb)}
      onUnpin={(kbId) => pins.unpin(kbId)}
      onMove={(kbId, delta) => {
        const next = movePin(pins.items, kbId, delta);
        if (next.some((item, at) => item.kbId !== pins.items[at]?.kbId)) reorder(next, kbId);
      }}
      onDrop={(kbId, overId) => {
        const next = dropPin(pins.items, kbId, overId);
        if (next.some((item, at) => item.kbId !== pins.items[at]?.kbId)) reorder(next, kbId);
      }}
    />
  );
}

/** Pure: the reorder announcement to keep, only while its KB is still one of the readable pins. */
export function announcementFor(
  said: { kbId: string; text: string } | null,
  pinned: readonly PinnedKb[],
): string {
  return said && pinned.some((item) => item.kbId === said.kbId) ? said.text : "";
}

/**
 * Pure view of the sublist (tests render it). Pinned rows reorder by drag
 * (fine pointers) or Alt+ArrowUp/Down; every row has a pin toggle, shown
 * on hover or focus and always on touch.
 */
export function KbSidebarListView({
  lang,
  pinned,
  recent,
  currentKbId,
  announcement,
  busy = false,
  pinning = null,
  state = "ready",
  onRetry,
  onPin,
  onUnpin,
  onMove,
  onDrop,
}: {
  lang: string;
  pinned: readonly PinnedKb[];
  recent: readonly PinnedKb[];
  currentKbId: string | null;
  announcement: string;
  /** A pin change is in flight: pin, unpin and reorder wait for it. */
  busy?: boolean;
  /** A KB a pin request is in flight for: its toggle shows pressed until the list is read again. */
  pinning?: string | null;
  /**
   * The pins read: still pending (a skeleton), paused offline (says so; it
   * resumes on reconnect), failed (rows kept, a retry), or ready.
   */
  state?: "pending" | "offline" | "error" | "ready";
  onRetry?: () => void;
  onPin: (kb: PinnedKb) => void;
  onUnpin: (kbId: string) => void;
  onMove: (kbId: string, delta: -1 | 1) => void;
  onDrop: (kbId: string, overId: string) => void;
}) {
  const { t } = useTranslation("nav");
  const { t: tErrors } = useTranslation("errors");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const row = (kb: PinnedKb, kind: "pinned" | "recent") => {
    const current = kb.kbId === currentKbId;
    const pressed = kind === "pinned" || pinning === kb.kbId;
    const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
      if (kind !== "pinned" || !event.altKey || busy) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      onMove(kb.kbId, event.key === "ArrowUp" ? -1 : 1);
    };
    return (
      <li
        key={`${kind}:${kb.kbId}`}
        data-kb-row={kind}
        className={cn(
          "group/kb relative flex min-w-0 items-center rounded-md",
          over === kb.kbId && dragging !== kb.kbId && "shadow-[inset_0_2px_0_0_var(--primary)]",
          dragging === kb.kbId && "opacity-50",
        )}
        draggable={kind === "pinned" && !busy}
        onDragStart={(event) => {
          if (kind !== "pinned") return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", kb.name);
          setDragging(kb.kbId);
        }}
        onDragOver={(event) => {
          if (kind !== "pinned" || dragging === null) return;
          event.preventDefault();
          setOver(kb.kbId);
        }}
        onDragLeave={() => setOver((value) => (value === kb.kbId ? null : value))}
        onDrop={(event) => {
          if (kind !== "pinned" || dragging === null) return;
          event.preventDefault();
          onDrop(dragging, kb.kbId);
          setDragging(null);
          setOver(null);
        }}
        onDragEnd={() => {
          setDragging(null);
          setOver(null);
        }}
      >
        <Link
          to="/$lang/kbs/$kbId"
          params={{ lang, kbId: kb.kbId }}
          aria-current={current ? "page" : undefined}
          aria-keyshortcuts={kind === "pinned" ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          title={kind === "pinned" ? `${kb.name} — ${t("sidebar.kbs.reorderHint")}` : kb.name}
          onKeyDown={onKeyDown}
          className={cn(
            buttonVariants({ variant: "ghost", size: "touch" }),
            "min-w-0 flex-1 justify-start gap-2 pr-10 pl-4 text-sm font-normal text-muted-foreground hover:text-foreground",
            current && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
          )}
        >
          {kind === "pinned" ? (
            <GripVertical
              aria-hidden
              className="size-3.5 shrink-0 cursor-grab pointer-coarse:hidden"
            />
          ) : (
            <BookOpen aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate">{kb.name}</span>
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-pressed={pressed}
          disabled={busy}
          aria-label={t("sidebar.kbs.pin", { name: kb.name })}
          title={t(pressed ? "sidebar.kbs.unpin" : "sidebar.kbs.pin", { name: kb.name })}
          onClick={() => (kind === "pinned" ? onUnpin(kb.kbId) : onPin(kb))}
          className="absolute right-1 opacity-0 group-hover/kb:opacity-100 group-focus-within/kb:opacity-100 focus-visible:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
        >
          {pressed ? (
            <PinOff aria-hidden className="size-3.5" />
          ) : (
            <Pin aria-hidden className="size-3.5" />
          )}
        </Button>
      </li>
    );
  };
  return (
    <div
      className="max-h-[min(24rem,45svh)] min-w-0 overflow-x-clip overflow-y-auto overscroll-contain py-1"
      data-testid="sidebar-kb-list"
    >
      {pinned.length > 0 && (
        <section aria-label={t("sidebar.kbs.pinned")}>
          <p aria-hidden className="px-4 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">
            {t("sidebar.kbs.pinned")}
          </p>
          <ul className="flex flex-col">{pinned.map((kb) => row(kb, "pinned"))}</ul>
        </section>
      )}
      {recent.length > 0 && (
        <section aria-label={t("sidebar.kbs.recent")}>
          <p aria-hidden className="px-4 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
            {t("sidebar.kbs.recent")}
          </p>
          <ul className="flex flex-col">{recent.map((kb) => row(kb, "recent"))}</ul>
        </section>
      )}
      {state === "pending" && pinned.length === 0 && (
        <div className="space-y-1 px-4 py-1" data-testid="kb-sidebar-pins-loading">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      )}
      {state === "offline" && (
        <p
          className="px-4 py-1 text-xs text-muted-foreground"
          data-testid="kb-sidebar-pins-offline"
        >
          {tErrors("offlineContent")}
        </p>
      )}
      {state === "error" && (
        <InlineRetry
          className="mx-2"
          message={t("sidebar.kbs.loadFailed")}
          onRetry={() => onRetry?.()}
        />
      )}
      {state === "ready" && pinned.length === 0 && recent.length === 0 && (
        <p className="px-4 py-1 text-xs text-muted-foreground">{t("sidebar.kbs.empty")}</p>
      )}
      <Link
        to="/$lang/kbs"
        params={{ lang }}
        activeOptions={{ exact: true }}
        className={cn(
          buttonVariants({ variant: "ghost", size: "touch" }),
          "w-full justify-start pl-4 text-sm font-normal text-primary",
        )}
      >
        {t("sidebar.kbs.viewAll")}
      </Link>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
