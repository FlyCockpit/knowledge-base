import { describe, expect, it, vi } from "vitest";

import {
  type AuthSessionStateInput,
  getAuthSessionState,
  rememberConfirmedAnonymous,
} from "./auth-session-state";

type TestSession = { user: { id: string } };

const confirmedSession: TestSession = { user: { id: "confirmed-user" } };

function input(
  overrides: Partial<AuthSessionStateInput<TestSession>> = {},
): AuthSessionStateInput<TestSession> {
  return {
    data: null,
    isPending: false,
    isRefetching: false,
    error: null,
    isOnline: true,
    refetch: vi.fn().mockResolvedValue(undefined),
    confirmedAnonymous: false,
    ...overrides,
  };
}

describe("getAuthSessionState", () => {
  it("classifies the unresolved initial state as pending", () => {
    const result = getAuthSessionState(input({ isPending: true, isRefetching: true }));

    expect(result.state).toEqual({ status: "pending" });
    expect(result.meta).toEqual({
      isRefetching: true,
      isOffline: false,
      isDegraded: false,
    });
  });

  it("classifies a successful empty response as confirmed anonymous", () => {
    const result = getAuthSessionState(input());

    expect(result.state).toEqual({ status: "anonymous" });
  });

  it("exposes a confirmed authenticated session", () => {
    const result = getAuthSessionState(input({ data: confirmedSession }));

    expect(result.state).toEqual({ status: "authenticated", session: confirmedSession });
    expect(result.meta.isDegraded).toBe(false);
  });

  it("retains confirmed identity through a transient error", () => {
    const result = getAuthSessionState(
      input({ data: confirmedSession, error: new Error("transient failure") }),
    );

    expect(result.state).toEqual({ status: "authenticated", session: confirmedSession });
    expect(result.meta.isDegraded).toBe(true);
    expect(result).not.toHaveProperty("error");
  });

  it("classifies an initial transient failure without identity as error", () => {
    const result = getAuthSessionState(input({ error: new Error("initial failure") }));

    expect(result.state).toEqual({ status: "error" });
    expect(result.meta.isDegraded).toBe(false);
  });

  it("exposes background refetching without replacing authenticated state", () => {
    const result = getAuthSessionState(input({ data: confirmedSession, isRefetching: true }));

    expect(result.state.status).toBe("authenticated");
    expect(result.meta.isRefetching).toBe(true);
  });

  it("marks retained identity as offline and degraded", () => {
    const result = getAuthSessionState(input({ data: confirmedSession, isOnline: false }));

    expect(result.state.status).toBe("authenticated");
    expect(result.meta).toEqual({
      isRefetching: false,
      isOffline: true,
      isDegraded: true,
    });
  });

  it("classifies confirmed unauthorized session loss as anonymous", () => {
    const result = getAuthSessionState(input({ error: { status: 401 } }));

    expect(result.state).toEqual({ status: "anonymous" });
    expect(result.meta.isDegraded).toBe(false);
  });

  it("keeps retry and refetch bound to Better Auth's stable action", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    const result = getAuthSessionState(input({ error: new Error("retryable"), refetch }));

    expect(result.actions.retry).toBe(refetch);
    expect(result.actions.refetch).toBe(refetch);
    await result.actions.retry();
    expect(refetch).toHaveBeenCalledOnce();
  });

  // Better Auth 1.7 sets `isPending: data === null` on every request, so a
  // refocus refetch of an anonymous session is indistinguishable from the
  // first load without memory (dist/client/query.mjs, onRequest).
  it("keeps a settled anonymous visitor anonymous while Better Auth refetches", () => {
    const result = getAuthSessionState(
      input({ isPending: true, isRefetching: true, confirmedAnonymous: true }),
    );

    expect(result.state).toEqual({ status: "anonymous" });
    expect(result.meta.isRefetching).toBe(true);
  });

  it("still gates the first load, before anything settled", () => {
    const result = getAuthSessionState(
      input({ isPending: true, isRefetching: true, confirmedAnonymous: false }),
    );

    expect(result.state).toEqual({ status: "pending" });
  });

  it("keeps a settled anonymous visitor anonymous through a failed refetch", () => {
    const result = getAuthSessionState(
      input({ error: new Error("server unreachable"), confirmedAnonymous: true }),
    );

    expect(result.state).toEqual({ status: "anonymous" });
    expect(result.meta.isDegraded).toBe(false);
  });

  it("lets a confirmed session replace remembered anonymity", () => {
    const result = getAuthSessionState(input({ data: confirmedSession, confirmedAnonymous: true }));

    expect(result.state).toEqual({ status: "authenticated", session: confirmedSession });
  });
});

describe("rememberConfirmedAnonymous", () => {
  it("remembers anonymity until a session is confirmed", () => {
    let memory = false;
    memory = rememberConfirmedAnonymous(memory, { status: "pending" });
    expect(memory).toBe(false);
    memory = rememberConfirmedAnonymous(memory, { status: "error" });
    expect(memory).toBe(false);
    memory = rememberConfirmedAnonymous(memory, { status: "anonymous" });
    expect(memory).toBe(true);
    memory = rememberConfirmedAnonymous(memory, { status: "pending" });
    expect(memory).toBe(true);
    memory = rememberConfirmedAnonymous(memory, { status: "error" });
    expect(memory).toBe(true);
    memory = rememberConfirmedAnonymous(memory, {
      status: "authenticated",
      session: confirmedSession,
    });
    expect(memory).toBe(false);
  });
});
