import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { ArrowRight, Bot, CircleHelp, User } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { CheckRow } from "@/components/kb/check-row";
import { LoadMore } from "@/components/load-more";
import { useKbRecentChanges } from "@/hooks/use-kb-recent-changes";
import { actorName, type RecentChange } from "@/lib/kb-workspace/agent-activity";
import { formatRelativeTime } from "@/utils/relative-time";

/**
 * "Recently changed": the KB's latest document commits on main, who made
 * each (an agent, a person, or unknown, as the server attributes it) and
 * when, with the changed files one click away. Agent rows stand out; "Agents
 * only" filters to them.
 */
export function RecentChangesPanel({
  lang,
  kbId,
  onOpen,
}: {
  lang: string;
  kbId: string;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation("kb");
  const id = useId();
  const [agentsOnly, setAgentsOnly] = useState(false);
  const recent = useKbRecentChanges(kbId, true);
  if (recent.lost) return null;
  const shown = agentsOnly
    ? recent.items.filter((item) => item.actor.kind === "agent")
    : recent.items;
  return (
    <section
      aria-label={t("workspace.activity.label")}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="recent-changes"
    >
      <div className="border-b px-3 py-1">
        <CheckRow
          id={`${id}-agents`}
          checked={agentsOnly}
          disabled={false}
          onToggle={() => setAgentsOnly((on) => !on)}
          label={t("workspace.activity.agentsOnly")}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip">
        {recent.isPending ? (
          <div className="space-y-3 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : recent.isError && recent.items.length === 0 ? (
          <div className="p-3">
            <InlineRetry message={t("workspace.activity.loadFailed")} onRetry={recent.refetch} />
          </div>
        ) : (
          <>
            <RecentChangesList items={shown} lang={lang} now={Date.now()} onOpen={onOpen} />
            {shown.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">
                {t(agentsOnly ? "workspace.activity.emptyAgents" : "workspace.activity.empty")}
              </p>
            )}
            {recent.isError && (
              <div className="p-3">
                <InlineRetry
                  message={t("workspace.activity.loadFailed")}
                  onRetry={recent.refetch}
                />
              </div>
            )}
            <LoadMore
              hasNextPage={recent.hasNextPage}
              isFetchingNextPage={recent.isFetchingNextPage}
              onLoadMore={recent.fetchNextPage}
            />
          </>
        )}
      </div>
    </section>
  );
}

/** The commit rows (pure: `now` is passed, so it renders the same in tests). */
export function RecentChangesList({
  items,
  lang,
  now,
  onOpen,
}: {
  items: readonly RecentChange[];
  lang: string;
  now: number;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation("kb");
  if (items.length === 0) return null;
  return (
    <ol className="divide-y">
      {items.map((item) => {
        const agent = item.actor.kind === "agent";
        const name = actorName(item.actor);
        const atMs = item.at === null ? Number.NaN : Date.parse(item.at);
        const Icon = agent ? Bot : item.actor.kind === "human" ? User : CircleHelp;
        const who = agent
          ? name
            ? t("workspace.activity.agentNamed", { name })
            : t("workspace.activity.agent")
          : item.actor.kind === "human"
            ? name
              ? t("workspace.activity.personNamed", { name })
              : t("workspace.activity.person")
            : t("workspace.activity.unknown");
        return (
          <li
            key={item.sha}
            data-actor={item.actor.kind}
            className={cn("space-y-1.5 px-3 py-2.5 text-sm", agent && "bg-primary/5")}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                  agent ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                )}
              >
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{who}</span>
              </span>
              {Number.isFinite(atMs) && (
                <time
                  dateTime={item.at!}
                  title={new Date(atMs).toLocaleString(lang)}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {formatRelativeTime(atMs, lang, now)}
                </time>
              )}
            </div>
            <p className="break-words text-muted-foreground">{item.subject}</p>
            {item.pathsUnknown ? (
              <p className="text-xs text-muted-foreground">
                {t("workspace.activity.pathsUnknown")}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {item.paths.map((entry) => {
                  const change = t(`workspace.activity.change.${entry.change}`);
                  return (
                    <li key={`${entry.change}:${entry.from ?? ""}:${entry.path}`}>
                      {entry.change === "deleted" ? (
                        <span className="flex min-h-8 items-center gap-1.5 font-mono text-xs text-muted-foreground line-through pointer-coarse:min-h-11">
                          <span className="sr-only">{change}: </span>
                          {entry.path}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onOpen(entry.path)}
                          className="flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-start font-mono text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
                        >
                          <span className="sr-only">{change}: </span>
                          {entry.change === "renamed" && entry.from && (
                            <>
                              <span className="truncate text-muted-foreground">{entry.from}</span>
                              <ArrowRight aria-hidden className="size-3 shrink-0" />
                            </>
                          )}
                          <span className="truncate">{entry.path}</span>
                          <span aria-hidden className="ms-auto shrink-0 text-muted-foreground">
                            {change}
                          </span>
                        </button>
                      )}
                    </li>
                  );
                })}
                {item.morePaths > 0 && (
                  <li className="text-xs text-muted-foreground">
                    {t("workspace.activity.morePaths", { count: item.morePaths })}
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
