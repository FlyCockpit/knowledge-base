import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  answers: [] as ((value: unknown) => void)[],
}));

// The server-rendered app shell has hydrated (lib/app-shell-hydration.ts).
vi.mock("@/lib/app-shell-hydration", () => ({ appShellHydrated: async () => {} }));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: () =>
    new Promise((resolve) => {
      probe.answers.push(resolve);
    }),
}));

import {
  admitRouteIdentity,
  announceDocumentIdentity,
  connectIdentityPeers,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  resetDocumentIdentityForTests,
} from "./document-identity";
import { resolveRouteSession } from "./route-session";

const channel = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
const resolved = (id: string) => ({ status: "resolved" as const, session: { user: { id } } });
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

beforeEach(() => {
  probe.answers = [];
  vi.stubGlobal("window", { location: { reload: vi.fn() } });
  resetDocumentIdentityForTests(() => channel);
  connectIdentityPeers(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetDocumentIdentityForTests();
});

describe("resolveRouteSession", () => {
  it("reprobes an old guard even after the watcher confirms the newer account", async () => {
    await admitRouteIdentity({ status: "resolved", session: null });
    let admitted = false;
    const guard = resolveRouteSession().then((resolution) => {
      admitted = true;
      return resolution;
    });
    channel.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    await admitRouteIdentity(resolved("b"), identityVerificationGeneration());
    expect(isDocumentIdentityUnverified()).toBe(false);
    probe.answers[0]?.(resolved("a"));
    await settle();
    expect(admitted).toBe(false);
    expect(probe.answers).toHaveLength(2);
    probe.answers[1]?.(resolved("b"));
    await expect(guard).resolves.toEqual(resolved("b"));
  });

  it("a guard's answer for the same account confirms an unverified identity", async () => {
    announceDocumentIdentity(null);
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(isDocumentIdentityUnverified()).toBe(true);
    const guard = resolveRouteSession();
    probe.answers[0]?.(resolved("a"));
    await guard;
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("an announcement that arrives while the probe runs makes the guard ask again", async () => {
    announceDocumentIdentity(null);
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    let admitted = false;
    const guard = resolveRouteSession().then((resolution) => {
      admitted = true;
      return resolution;
    });
    // Another tab announces mid-probe: this answer may carry the old cookie.
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    probe.answers[0]?.(resolved("a"));
    await settle();
    expect(admitted).toBe(false);
    expect(probe.answers).toHaveLength(2);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // The second probe, asked after it, settles it and admits.
    probe.answers[1]?.(resolved("a"));
    await guard;
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("asks at most three times, then admits nothing (a retryable failed probe)", async () => {
    announceDocumentIdentity(null);
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    const guard = resolveRouteSession();
    for (let i = 0; i < 3; i++) {
      await settle();
      channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      probe.answers[i]?.(resolved("a"));
    }
    await expect(guard).resolves.toEqual({ status: "error" });
    expect(probe.answers).toHaveLength(3);
    expect(isDocumentIdentityUnverified()).toBe(true);
  });

  it("a probe the document's identity was never questioned during asks once", async () => {
    const guard = resolveRouteSession();
    probe.answers[0]?.(resolved("a"));
    await guard;
    expect(probe.answers).toHaveLength(1);
  });
});
