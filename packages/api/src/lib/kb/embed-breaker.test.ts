import { describe, expect, it } from "vitest";
import {
  createEmbedBreaker,
  EMBED_BREAKER_COOLDOWN_MS,
  EMBED_BREAKER_MAX_COOLDOWN_MS,
} from "./embed-breaker";

describe("query embedding breaker (R3-L4)", () => {
  it("opens on failure, lets one half-open probe through after the cooldown, closes on success", () => {
    let now = 0;
    const breaker = createEmbedBreaker(() => now);
    const first = breaker.admit("p:1");
    expect(first).toEqual({ key: "p:1", probe: false });
    breaker.fail(first as Exclude<typeof first, "open">);
    expect(breaker.admit("p:1")).toBe("open");
    expect(breaker.admit("p:2")).toEqual({ key: "p:2", probe: false });
    now = EMBED_BREAKER_COOLDOWN_MS;
    const probe = breaker.admit("p:1");
    expect(probe).toEqual({ key: "p:1", probe: true });
    // One probe at a time.
    expect(breaker.admit("p:1")).toBe("open");
    breaker.succeed(probe as Exclude<typeof probe, "open">);
    expect(breaker.admit("p:1")).toEqual({ key: "p:1", probe: false });
  });

  it("doubles the cooldown on a failed probe up to the maximum; concurrent failures open once", () => {
    let now = 0;
    const breaker = createEmbedBreaker(() => now);
    const a = breaker.admit("k") as { key: string; probe: boolean };
    const b = breaker.admit("k") as { key: string; probe: boolean };
    breaker.fail(a);
    breaker.fail(b);
    now = EMBED_BREAKER_COOLDOWN_MS - 1;
    expect(breaker.admit("k")).toBe("open");
    let openedAt = 0;
    let cooldown = EMBED_BREAKER_COOLDOWN_MS;
    for (let i = 0; i < 6; i++) {
      now = openedAt + cooldown;
      const probe = breaker.admit("k") as { key: string; probe: boolean };
      expect(probe.probe).toBe(true);
      breaker.fail(probe);
      openedAt = now;
      cooldown = Math.min(cooldown * 2, EMBED_BREAKER_MAX_COOLDOWN_MS);
      now = openedAt + cooldown - 1;
      expect(breaker.admit("k")).toBe("open");
    }
    expect(cooldown).toBe(EMBED_BREAKER_MAX_COOLDOWN_MS);
  });

  it("a released probe frees the half-open slot without a verdict", () => {
    let now = 0;
    const breaker = createEmbedBreaker(() => now);
    breaker.fail(breaker.admit("k") as { key: string; probe: boolean });
    now = EMBED_BREAKER_COOLDOWN_MS;
    const probe = breaker.admit("k") as { key: string; probe: boolean };
    breaker.release(probe);
    expect(breaker.admit("k")).toEqual({ key: "k", probe: true });
  });
});
