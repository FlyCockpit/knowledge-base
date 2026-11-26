/**
 * Agent awareness of the workspace: which documents an agent changed
 * recently, from `documents.recentChanges` (newest first). Who made a change
 * comes only from the server's own attribution (`actor.kind`).
 */

export type RecentChangeActor = {
  kind: "human" | "agent" | "unknown";
  label: string | null;
  via: string | null;
};

type RecentChangePath = {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  from?: string;
};

export type RecentChange = {
  sha: string;
  at: string | null;
  subject: string;
  actor: RecentChangeActor;
  paths: RecentChangePath[];
  morePaths: number;
  pathsUnknown: boolean;
};

export type AgentBadge = {
  at: string;
  label: string | null;
  via: string | null;
  change: "added" | "modified" | "renamed";
};

const AGENT_BADGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The latest agent change of each document that still exists, within
 * `windowMs` of `now`. Walks newest → oldest: a later delete hides older
 * badges of that path; a later rename carries the older history of the old
 * path to its new one.
 */
export function agentBadges(
  items: readonly RecentChange[],
  now: number,
  windowMs: number = AGENT_BADGE_WINDOW_MS,
): Map<string, AgentBadge> {
  const badges = new Map<string, AgentBadge>();
  // Older path → the path it lives at now (after later renames), or null once deleted.
  const fate = new Map<string, string | null>();
  const resolve = (path: string): string | null => {
    let current: string | null = path;
    const seen = new Set<string>();
    while (current !== null && fate.has(current) && !seen.has(current)) {
      seen.add(current);
      current = fate.get(current) ?? null;
    }
    return current;
  };
  for (const item of items) {
    const at = item.at === null ? Number.NaN : Date.parse(item.at);
    const recent = Number.isFinite(at) && now - at <= windowMs;
    for (const entry of item.paths) {
      const present = resolve(entry.path);
      if (
        recent &&
        item.actor.kind === "agent" &&
        entry.change !== "deleted" &&
        present !== null &&
        !badges.has(present)
      ) {
        badges.set(present, {
          at: item.at!,
          label: item.actor.label,
          via: item.actor.via,
          change: entry.change,
        });
      }
      // Older entries of a path deleted here belong to a document that is gone;
      // older entries of a renamed path belong to where it lives now.
      if (entry.change === "deleted") fate.set(entry.path, null);
      else if (entry.change === "renamed" && entry.from) fate.set(entry.from, present);
    }
  }
  return badges;
}

/** Who made a change, for display: an agent's token/app name, else the person's label. */
export function actorName(actor: RecentChangeActor): string | null {
  if (actor.kind === "agent") return actor.via ?? actor.label;
  return actor.label;
}
