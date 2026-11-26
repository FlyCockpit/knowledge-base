import { describe, expect, it } from "vitest";

import { actorName, agentBadges, type RecentChange } from "./agent-activity";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const agent = { kind: "agent" as const, label: "Ana", via: "Claude Code" };
const human = { kind: "human" as const, label: "Ana", via: null };
const change = (
  at: string | null,
  actor: RecentChange["actor"],
  paths: RecentChange["paths"],
): RecentChange => ({
  sha: Math.random().toString(16).slice(2).padEnd(40, "0"),
  at,
  subject: "x",
  actor,
  paths,
  morePaths: 0,
  pathsUnknown: false,
});

describe("agentBadges", () => {
  it("keeps the latest agent change per present document within the window", () => {
    const badges = agentBadges(
      [
        change(hoursAgo(1), human, [{ path: "a.md", change: "modified" }]),
        change(hoursAgo(2), agent, [{ path: "a.md", change: "modified" }]),
        change(hoursAgo(3), agent, [{ path: "a.md", change: "added" }]),
        change(hoursAgo(24 * 8), agent, [{ path: "old.md", change: "modified" }]),
        change(null, agent, [{ path: "untimed.md", change: "modified" }]),
      ],
      NOW,
    );
    expect([...badges.keys()]).toEqual(["a.md"]);
    expect(badges.get("a.md")).toEqual({
      at: hoursAgo(2),
      label: "Ana",
      via: "Claude Code",
      change: "modified",
    });
  });

  it("drops documents deleted later and follows later renames", () => {
    const badges = agentBadges(
      [
        change(hoursAgo(1), human, [{ path: "gone.md", change: "deleted" }]),
        change(hoursAgo(2), human, [{ path: "new.md", change: "renamed", from: "old.md" }]),
        change(hoursAgo(3), agent, [
          { path: "gone.md", change: "modified" },
          { path: "old.md", change: "modified" },
          { path: "removed-by-agent.md", change: "deleted" },
        ]),
      ],
      NOW,
    );
    expect([...badges.keys()]).toEqual(["new.md"]);
  });

  it("names an agent by its token or app, a person by their label", () => {
    expect(actorName(agent)).toBe("Claude Code");
    expect(actorName({ ...agent, via: null })).toBe("Ana");
    expect(actorName(human)).toBe("Ana");
    expect(actorName({ kind: "unknown", label: null, via: null })).toBeNull();
  });
});
