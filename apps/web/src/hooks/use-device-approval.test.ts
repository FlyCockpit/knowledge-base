import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimDevice,
  createDeviceHttp,
  type DeviceClaim,
  type DeviceDeps,
  type DeviceProgress,
  deviceGrant,
  initialProgress,
  normalizeUserCode,
  runDeviceDecision,
} from "./use-device-approval";
import { emptySelection, type LiveKbOption, selectionReducer } from "./use-mcp-consent";

const CODE = "ABCD2345";
const NONCE = "00000000-0000-4000-8000-00000000000a";
const KB_A = "a".repeat(24);
const live: LiveKbOption[] = [{ kbId: KB_A, name: "Alpha", bits: ["read", "propose", "write"] }];
const claim: DeviceClaim = {
  userCode: CODE,
  clientId: "kb-cli",
  scopes: ["mcp:read"],
  nonce: NONCE,
};

type Call = { op: string; input?: unknown };

/** Unit recorder for orchestration; real wire order is covered by kb-device.spec.ts. */
function recorder(overrides: Partial<Record<keyof DeviceDeps, (...a: never[]) => unknown>> = {}) {
  const calls: Call[] = [];
  const deps: DeviceDeps = {
    claim: async (userCode) => {
      calls.push({ op: "GET claim", input: userCode });
      return (
        (overrides.claim as DeviceDeps["claim"] | undefined)?.(userCode) ?? {
          ok: true,
          data: {
            user_code: CODE,
            client_id: "kb-cli",
            scope: "mcp:read",
            status: "pending",
            nonce: NONCE,
          },
        }
      );
    },
    select: async (input) => {
      calls.push({ op: "select", input });
      const override = overrides.select as DeviceDeps["select"] | undefined;
      return override ? override(input) : { nonce: input.nonce };
    },
    decide: async (decision, input) => {
      calls.push({ op: `POST ${decision}`, input });
      const override = overrides.decide as DeviceDeps["decide"] | undefined;
      return override ? override(decision, input) : { ok: true, data: { success: true } };
    },
  };
  return { calls, deps };
}

const readGrant = () =>
  deviceGrant(
    selectionReducer(emptySelection(), { type: "toggleBit", kbId: KB_A, bit: "read" }),
    live,
    claim.scopes,
  );

const orpcError = (code: string, data?: unknown) => Object.assign(new Error(code), { code, data });

describe("user code input", () => {
  it("normalizes the displayed code and rejects anything that is not 8 code characters", () => {
    expect(normalizeUserCode("abcd-2345")).toBe(CODE);
    expect(normalizeUserCode(" ABCD 2345 ")).toBe(CODE);
    expect(normalizeUserCode("ABCD234")).toBeNull();
    expect(normalizeUserCode("ABCD23456")).toBeNull();
    expect(normalizeUserCode("ABCD23$5")).toBeNull();
    expect(normalizeUserCode(undefined)).toBeNull();
  });
});

describe("GET claim", () => {
  it("parses a pending claim into scopes and the app-owned nonce", async () => {
    const { calls, deps } = recorder({
      claim: () => ({
        ok: true,
        data: {
          user_code: CODE,
          client_id: "kb-cli",
          scope: "mcp:read mcp:write",
          status: "pending",
          nonce: NONCE,
        },
      }),
    });
    await expect(claimDevice(deps, CODE)).resolves.toEqual({
      kind: "claimed",
      claim: {
        userCode: CODE,
        clientId: "kb-cli",
        scopes: ["mcp:read", "mcp:write"],
        nonce: NONCE,
      },
    });
    expect(calls).toEqual([{ op: "GET claim", input: CODE }]);
  });

  it("a wrong, expired or already-used code (server refusal) is an explicit unavailable state", async () => {
    for (const status of [400, 403, 404]) {
      const { deps } = recorder({ claim: () => ({ ok: false, status }) });
      await expect(claimDevice(deps, CODE)).resolves.toEqual({ kind: "unavailable" });
    }
  });

  it("non-pending, mismatched or nonce-less claims are never reviewable", async () => {
    const bad = [
      { user_code: CODE, client_id: "kb-cli", scope: "mcp:read", status: "approved", nonce: NONCE },
      { user_code: CODE, client_id: "kb-cli", scope: "mcp:read", status: "denied", nonce: NONCE },
      {
        user_code: "ZZZZ2345",
        client_id: "kb-cli",
        scope: "mcp:read",
        status: "pending",
        nonce: NONCE,
      },
      { user_code: CODE, client_id: "kb-cli", scope: "mcp:read", status: "pending" },
      { user_code: CODE, client_id: "kb-cli", scope: "mcp:read", status: "pending", nonce: "x" },
      { user_code: CODE, client_id: "kb-cli", scope: "", status: "pending", nonce: NONCE },
    ];
    for (const data of bad) {
      const { deps } = recorder({ claim: () => ({ ok: true, data }) });
      await expect(claimDevice(deps, CODE)).resolves.toEqual({ kind: "unavailable" });
    }
  });

  it("no session is a sign-in state; transport failure throws for an inline retry", async () => {
    const { deps } = recorder({ claim: () => ({ ok: false, status: 401 }) });
    await expect(claimDevice(deps, CODE)).resolves.toEqual({ kind: "signIn" });
    const failing = recorder({ claim: () => ({ ok: false, status: 503 }) });
    await expect(claimDevice(failing.deps, CODE)).rejects.toThrow();
  });
});

describe("decision flow and request order", () => {
  it("approve: GET claim -> app selection -> POST approve, with the exact selection and nonce", async () => {
    const { calls, deps } = recorder();
    const claimed = await claimDevice(deps, CODE);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const result = await runDeviceDecision(deps, {
      claim: claimed.claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "approve",
    });
    expect(result.phase).toEqual({ kind: "approved" });
    expect(calls.map((c) => c.op)).toEqual(["GET claim", "select", "POST approve"]);
    expect(calls[1]?.input).toEqual({
      userCode: CODE,
      nonce: NONCE,
      selection: {
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        acl: [{ kbId: KB_A, bits: ["read"] }],
        allowCreate: false,
        createdKbBits: [],
      },
    });
    expect(calls[2]?.input).toEqual({ userCode: CODE, nonce: NONCE });
  });

  it("deny: GET claim -> POST deny, never recording a selection", async () => {
    const { calls, deps } = recorder();
    const claimed = await claimDevice(deps, CODE);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const result = await runDeviceDecision(deps, {
      claim: claimed.claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "deny",
    });
    expect(result.phase).toEqual({ kind: "denied" });
    expect(calls.map((c) => c.op)).toEqual(["GET claim", "POST deny"]);
  });

  it("an empty ACL is submitted as an explicit empty ACL, not widened", async () => {
    const { calls, deps } = recorder();
    const grant = deviceGrant(emptySelection(), live, claim.scopes);
    const result = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: grant,
      decision: "approve",
    });
    expect(result.phase).toEqual({ kind: "approved" });
    expect(calls[0]?.input).toMatchObject({ selection: { acl: [] } });
  });

  it("selection scopes are exactly the claimed scopes; offline_access never travels", () => {
    const grant = deviceGrant(emptySelection(), live, ["mcp:read", "offline_access", "mcp:write"]);
    expect(grant.scopes).toEqual(["mcp:read", "mcp:write"]);
  });

  it("an unresolved selection issue sends nothing", async () => {
    const { calls, deps } = recorder();
    const create = selectionReducer(emptySelection(), { type: "setAllowCreate", value: true });
    const result = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: deviceGrant(create, live, ["mcp:read"]),
      decision: "approve",
    });
    expect(result.phase).toEqual({ kind: "review" });
    expect(calls).toEqual([]);
  });

  it("never sends a decision without the app-owned nonce", async () => {
    const { calls, deps } = recorder();
    for (const decision of ["approve", "deny"] as const) {
      const result = await runDeviceDecision(deps, {
        claim: { ...claim, nonce: "" },
        progress: initialProgress(),
        selection: readGrant(),
        decision,
      });
      expect(result.phase).toEqual({ kind: "unavailable" });
    }
    expect(calls).toEqual([]);
  });
});

describe("refusal states", () => {
  it("changed live rights: selection refused, nothing approved, and the user may pick again", async () => {
    let refuse = true;
    const { calls, deps } = recorder({
      select: (input: { nonce: string }) => {
        if (refuse) throw orpcError("BAD_REQUEST");
        return { nonce: input.nonce };
      },
    });
    const first = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "approve",
    });
    expect(first.phase).toEqual({ kind: "rightsChanged" });
    expect(first.progress.intent).toBe("none");
    expect(calls.map((c) => c.op)).toEqual(["select"]);
    refuse = false;
    const second = await runDeviceDecision(deps, {
      claim,
      progress: first.progress,
      selection: deviceGrant(emptySelection(), live, claim.scopes),
      decision: "approve",
    });
    expect(second.phase).toEqual({ kind: "approved" });
    expect(calls.map((c) => c.op)).toEqual(["select", "select", "POST approve"]);
  });

  it("an expired or consumed code during selection is unavailable, not a rights problem", async () => {
    const { calls, deps } = recorder({
      select: () => {
        throw orpcError("BAD_REQUEST", { error: "invalid_grant" });
      },
    });
    const result = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "approve",
    });
    expect(result.phase).toEqual({ kind: "unavailable" });
    expect(calls.map((c) => c.op)).toEqual(["select"]);
  });

  it("CSRF/security-check failure on approve (403) is refused and never reported as success", async () => {
    const { calls, deps } = recorder({ decide: () => ({ ok: false, status: 403 }) });
    const result = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "approve",
    });
    expect(result.phase).toEqual({ kind: "refused" });
    expect(calls.map((c) => c.op)).toEqual(["select", "POST approve"]);
  });

  it("CSRF failure on deny is refused too", async () => {
    const { deps } = recorder({ decide: () => ({ ok: false, status: 403 }) });
    const result = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "deny",
    });
    expect(result.phase).toEqual({ kind: "refused" });
  });

  it("an expired session mid-flow asks to sign in", async () => {
    const { deps } = recorder({
      select: () => {
        throw orpcError("UNAUTHORIZED");
      },
    });
    const result = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "approve",
    });
    expect(result.phase).toEqual({ kind: "signIn" });
  });
});

describe("network retry", () => {
  it("a lost selection response is retried with the same selection; a refusal then never approves", async () => {
    let attempt = 0;
    const { calls, deps } = recorder({
      select: () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("Failed to fetch");
        throw orpcError("BAD_REQUEST", { error: "invalid_grant" });
      },
    });
    const grant = readGrant();
    const first = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: grant,
      decision: "approve",
    });
    expect(first.phase).toEqual({ kind: "error" });
    expect(first.progress.intent).toBe("uncertain");
    const second = await runDeviceDecision(deps, {
      claim,
      progress: first.progress,
      selection: grant,
      decision: "approve",
    });
    expect(second.phase).toEqual({ kind: "unavailable" });
    expect(calls.map((c) => c.op)).toEqual(["select", "select"]);
    expect(calls[0]?.input).toEqual(calls[1]?.input);
  });

  it("after a recorded intent, retry re-sends only the approval, never a second intent", async () => {
    let attempt = 0;
    const { calls, deps } = recorder({
      decide: () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("Failed to fetch");
        return { ok: true, data: { success: true } };
      },
    });
    const first = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "approve",
    });
    expect(first.phase).toEqual({ kind: "error", decisionUncertain: true });
    expect(first.progress.intent).toBe("recorded");
    const second = await runDeviceDecision(deps, {
      claim,
      progress: first.progress,
      selection: readGrant(),
      decision: "approve",
    });
    expect(second.phase).toEqual({ kind: "approved" });
    expect(calls.map((c) => c.op)).toEqual(["select", "POST approve", "POST approve"]);
  });

  it("a lost approval response followed by a refusal is reported as uncertain, not as failure or success", async () => {
    let attempt = 0;
    const { deps } = recorder({
      decide: () => {
        attempt += 1;
        if (attempt === 1) return { ok: false, status: 502 };
        return { ok: false, status: 403 };
      },
    });
    const first = await runDeviceDecision(deps, {
      claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "approve",
    });
    expect(first.phase).toEqual({ kind: "error", decisionUncertain: true });
    const second = await runDeviceDecision(deps, {
      claim,
      progress: first.progress,
      selection: readGrant(),
      decision: "approve",
    });
    expect(second.phase).toEqual({ kind: "uncertain" });
  });

  it("a recorded intent cannot be swapped for a different selection", async () => {
    const { calls, deps } = recorder();
    const progress: DeviceProgress = {
      ...initialProgress(),
      intent: "recorded",
      intentKey: "something-else",
    };
    const result = await runDeviceDecision(deps, {
      claim,
      progress,
      selection: readGrant(),
      decision: "approve",
    });
    expect(result.phase).toEqual({ kind: "refused" });
    expect(calls).toEqual([]);
  });
});

describe("HTTP wiring", () => {
  it("claims with GET user_code and decides with the nonce header and a JSON body only", async () => {
    const seen: { path: string; options: Record<string, unknown> }[] = [];
    const $fetch = vi.fn(async (path: string, options: Record<string, unknown>) => {
      seen.push({ path, options });
      return { data: { ok: 1 }, error: null };
    });
    const http = createDeviceHttp($fetch);
    await http.claim(CODE);
    await http.decide("approve", { userCode: CODE, nonce: NONCE });
    await http.decide("deny", { userCode: CODE, nonce: NONCE });
    expect(seen).toEqual([
      { path: "/device", options: { method: "GET", query: { user_code: CODE } } },
      {
        path: "/device/approve",
        options: {
          method: "POST",
          body: { userCode: CODE },
          headers: { "content-type": "application/json", "x-device-approval-nonce": NONCE },
        },
      },
      {
        path: "/device/deny",
        options: {
          method: "POST",
          body: { userCode: CODE },
          headers: { "content-type": "application/json", "x-device-approval-nonce": NONCE },
        },
      },
    ]);
  });

  it("maps a failed auth response to its HTTP status", async () => {
    const http = createDeviceHttp(async () => ({ data: null, error: { status: 403 } }));
    await expect(http.claim(CODE)).resolves.toEqual({ ok: false, status: 403 });
  });
});

describe("secret hygiene", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("the full flow writes nothing to browser storage and logs nothing", async () => {
    const storage = () => ({
      setItem: vi.fn(),
      getItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    });
    const local = storage();
    const session = storage();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { deps } = recorder({
      decide: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const claimed = await claimDevice(deps, CODE);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const first = await runDeviceDecision(deps, {
      claim: claimed.claim,
      progress: initialProgress(),
      selection: readGrant(),
      decision: "approve",
    });
    await runDeviceDecision(deps, {
      claim: claimed.claim,
      progress: first.progress,
      selection: readGrant(),
      decision: "deny",
    });
    for (const store of [local, session]) {
      expect(store.setItem).not.toHaveBeenCalled();
      expect(store.getItem).not.toHaveBeenCalled();
    }
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });
});
