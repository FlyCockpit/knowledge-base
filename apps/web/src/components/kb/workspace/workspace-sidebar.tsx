import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SegmentedControl } from "@/components/segmented-control";

export type SidebarView = "files" | "search" | "outline" | "activity";

/**
 * The workspace sidebar: Files, Search, (with a document open) Outline and
 * Activity (recent changes, agents' first),
 * one at a time under a segmented switch. Every view stays mounted while
 * hidden, so a search typed or a tree scrolled is still there on return. Each
 * view owns its scroller (`overflow-y-auto overflow-x-clip`) inside this
 * bounded column.
 */
export function WorkspaceSidebar({
  files,
  search,
  outline,
  activity,
  view,
  onViewChange,
}: {
  files: ReactNode;
  search: ReactNode;
  /** Null: no document open, so no Outline view. */
  outline: ReactNode | null;
  /** Recent changes of the KB. */
  activity: ReactNode;
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
}) {
  const { t } = useTranslation("kb");
  const shown: SidebarView = view === "outline" && outline === null ? "files" : view;
  const items: { value: SidebarView; label: string }[] = [
    { value: "files", label: t("workspace.sidebar.files") },
    { value: "search", label: t("workspace.sidebar.search") },
    ...(outline !== null
      ? [{ value: "outline" as const, label: t("workspace.sidebar.outline") }]
      : []),
    { value: "activity", label: t("workspace.sidebar.activity") },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-sidebar" data-view={shown}>
      <div className="border-b px-2 py-1.5">
        <SegmentedControl
          value={shown}
          onChange={onViewChange}
          items={items}
          ariaLabel={t("workspace.sidebar.label")}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col" hidden={shown !== "files"}>
        {files}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" hidden={shown !== "search"}>
        {search}
      </div>
      {outline !== null && (
        <div className="flex min-h-0 flex-1 flex-col" hidden={shown !== "outline"}>
          {outline}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col" hidden={shown !== "activity"}>
        {activity}
      </div>
    </div>
  );
}
