import type { PillTone } from "@/components/status-pill";

export type PrStatus = "OPEN" | "CONFLICT" | "CLOSED" | "MERGED";

/** `kb:pr.status.<key>` for each state. */
export const PR_STATUS_KEY = {
  OPEN: "open",
  CONFLICT: "conflict",
  CLOSED: "closed",
  MERGED: "merged",
} as const satisfies Record<PrStatus, string>;

/** PR states as status pills: open is informational, a conflict needs attention. */
export const PR_STATUS_TONE: Record<PrStatus, PillTone> = {
  OPEN: "info",
  CONFLICT: "busy",
  CLOSED: "muted",
  MERGED: "good",
};
