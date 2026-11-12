import { MCP_KB_PERMISSIONS } from "@knowledge-base/auth/mcp-grant";
import { MCP_TOOL_PRESETS } from "@knowledge-base/auth/mcp-tool-groups";
import { describe, expect, it, vi } from "vitest";

import {
  buildSignedOAuthQuery,
  type ConsentDeps,
  consentErrorPhase,
  emptySelection,
  KB_BITS,
  type LiveKbOption,
  resolveOauthRedirectUrl,
  runConsentSubmit,
  selectionIssues,
  selectionKey,
  selectionReducer,
  toGrantSelection,
} from "./use-mcp-consent";

const KB_A = "a".repeat(24);
const KB_B = "b".repeat(24);
const live: LiveKbOption[] = [
  { kbId: KB_A, name: "Alpha", bits: ["read", "propose", "write"] },
  { kbId: KB_B, name: "Beta", bits: ["read"] },
];
function apply(...actions: Parameters<typeof selectionReducer>[1][]) {
  return actions.reduce(selectionReducer, emptySelection());
}

describe("credential selection model", () => {
  it("mirrors the server's permission vocabulary exactly", () => {
    expect([...KB_BITS]).toEqual([...MCP_KB_PERMISSIONS]);
  });

  it("starts with nothing selected: no scopes, no KBs, no create; tools on the Read preset", () => {
    const grant = toGrantSelection(emptySelection(), live);
    expect(grant).toEqual({
      scopes: [],
      toolGroups: ["read"],
      acl: [],
      allowCreate: false,
      createdKbBits: [],
    });
  });

  it("submits exactly the individually selected KB bits and create bits", () => {
    const state = apply(
      { type: "setToolGroups", groups: [...MCP_TOOL_PRESETS.direct] },
      { type: "toggleScope", scope: "mcp:write" },
      { type: "toggleBit", kbId: KB_A, bit: "propose" },
      { type: "toggleBit", kbId: KB_B, bit: "read" },
      { type: "setAllowCreate", value: true },
      { type: "toggleCreatedBit", bit: "read" },
      { type: "toggleCreatedBit", bit: "write" },
    );
    expect(toGrantSelection(state, live)).toEqual({
      scopes: ["mcp:write"],
      // Allowing creation adds kb_admin, the group holding knowledge_bases_create.
      toolGroups: ["read", "edit", "assets", "pull_requests", "kb_admin"],
      acl: [
        { kbId: KB_A, bits: ["propose"] },
        { kbId: KB_B, bits: ["read"] },
      ],
      allowCreate: true,
      createdKbBits: ["read", "propose", "write"],
    });
  });

  it("allowing creation adds kb_admin; unticking it or dropping the group removes both", () => {
    const allowed = apply(
      { type: "toggleScope", scope: "mcp:write" },
      { type: "setAllowCreate", value: true },
      { type: "toggleCreatedBit", bit: "read" },
    );
    expect(allowed.toolGroups).toEqual(["read", "kb_admin"]);
    expect(selectionReducer(allowed, { type: "setAllowCreate", value: false })).toMatchObject({
      toolGroups: ["read"],
      allowCreate: false,
      createdKbBits: [],
    });
    expect(selectionReducer(allowed, { type: "toggleToolGroup", group: "kb_admin" })).toMatchObject(
      { toolGroups: ["read"], allowCreate: false, createdKbBits: [] },
    );
    expect(
      selectionReducer(allowed, { type: "setToolGroups", groups: [...MCP_TOOL_PRESETS.direct] }),
    ).toMatchObject({ allowCreate: false, createdKbBits: [] });
  });

  it("unchecking the last bit removes the KB; an empty selection stays an explicit empty ACL", () => {
    const state = apply(
      { type: "toggleScope", scope: "mcp:read" },
      { type: "toggleBit", kbId: KB_A, bit: "read" },
      { type: "toggleBit", kbId: KB_A, bit: "read" },
    );
    const grant = toGrantSelection(state, live);
    expect(grant.acl).toEqual([]);
    expect(Array.isArray(grant.acl)).toBe(true);
  });

  it("caps permissions to the preset: Direct then Propose submits nothing above Propose", () => {
    const direct = apply(
      { type: "setToolGroups", groups: [...MCP_TOOL_PRESETS.direct] },
      { type: "toggleScope", scope: "mcp:write" },
      { type: "toggleBit", kbId: KB_A, bit: "write" },
      { type: "toggleBit", kbId: KB_A, bit: "propose" },
      { type: "toggleBit", kbId: KB_B, bit: "read" },
      { type: "setAllowCreate", value: true },
      { type: "toggleCreatedBit", bit: "read" },
      { type: "toggleCreatedBit", bit: "write" },
    );
    expect(toGrantSelection(direct, live).acl).toEqual([
      { kbId: KB_A, bits: ["propose", "write"] },
      { kbId: KB_B, bits: ["read"] },
    ]);
    const propose = selectionReducer(direct, {
      type: "setToolGroups",
      groups: ["read", "edit", "pull_requests"],
    });
    expect(toGrantSelection(propose, live)).toMatchObject({
      toolGroups: ["read", "edit", "pull_requests"],
      acl: [
        { kbId: KB_A, bits: ["propose"] },
        { kbId: KB_B, bits: ["read"] },
      ],
      // A preset is an exact group set without kb_admin, so creation drops out.
      allowCreate: false,
      createdKbBits: [],
    });
    // Submission caps even a draft that still carries stronger bits.
    expect(
      toGrantSelection(
        {
          ...direct,
          toolGroups: ["read", "edit", "pull_requests"],
          acl: { [KB_A]: ["write", "manage"] },
        },
        [{ kbId: KB_A, name: "Alpha", bits: ["read", "propose", "write", "review", "manage"] }],
      ).acl,
    ).toEqual([]);
    // Toggling a bit above the ceiling is ignored.
    expect(selectionReducer(propose, { type: "toggleBit", kbId: KB_A, bit: "write" })).toBe(
      propose,
    );
    // A custom group set has no ceiling.
    const custom = selectionReducer(propose, { type: "toggleToolGroup", group: "assets" });
    expect(
      toGrantSelection(
        selectionReducer(custom, { type: "toggleBit", kbId: KB_A, bit: "write" }),
        live,
      ).acl[0],
    ).toEqual({ kbId: KB_A, bits: ["propose", "write"] });
  });

  it("picks tool groups by preset or individually, always in canonical order", () => {
    const direct = apply({
      type: "setToolGroups",
      groups: ["pull_requests", "assets", "edit", "read"],
    });
    expect(toGrantSelection(direct, live).toolGroups).toEqual([...MCP_TOOL_PRESETS.direct]);
    const custom = apply(
      { type: "toggleToolGroup", group: "sealed" },
      { type: "toggleToolGroup", group: "read" },
      { type: "toggleToolGroup", group: "export" },
    );
    expect(toGrantSelection(custom, live).toolGroups).toEqual(["export", "sealed"]);
    const none = apply({ type: "toggleToolGroup", group: "read" });
    expect(selectionIssues(toGrantSelection(none, live))).toContain("toolGroupRequired");
  });

  it("disabling create clears create bits so they can never be submitted", () => {
    const state = apply(
      { type: "setAllowCreate", value: true },
      { type: "toggleCreatedBit", bit: "read" },
      { type: "setAllowCreate", value: false },
    );
    expect(toGrantSelection(state, live)).toMatchObject({
      allowCreate: false,
      createdKbBits: [],
    });
  });

  it("drops KBs and bits the user does not hold live (hidden/forged rights cannot be submitted)", () => {
    const state = apply(
      { type: "setToolGroups", groups: ["read", "edit"] },
      { type: "toggleBit", kbId: KB_B, bit: "manage" },
      { type: "toggleBit", kbId: "z".repeat(24), bit: "read" },
      { type: "toggleBit", kbId: KB_A, bit: "write" },
    );
    expect(toGrantSelection(state, live).acl).toEqual([{ kbId: KB_A, bits: ["write"] }]);
  });

  it("a credential selection never carries a sealed recipient capability", () => {
    const grant = toGrantSelection(apply({ type: "toggleScope", scope: "mcp:read" }), live);
    expect(grant).not.toHaveProperty("recipients");
    expect(Object.keys(emptySelection())).not.toContain("recipients");
  });

  it("submits Manage's implied permissions for newly created knowledge bases", () => {
    const selection = apply(
      { type: "setToolGroups", groups: ["read", "edit", "kb_admin"] },
      { type: "toggleScope", scope: "mcp:write" },
      { type: "setAllowCreate", value: true },
      { type: "toggleCreatedBit", bit: "manage" },
    );
    const grant = toGrantSelection(selection, live);
    expect(grant.createdKbBits).toEqual(KB_BITS);
    expect(selectionIssues(grant)).toEqual([]);
  });
  it("reports blocking issues instead of broadening", () => {
    expect(selectionIssues(toGrantSelection(emptySelection(), live))).toContain("scopeRequired");
    const createNoRead = apply(
      { type: "toggleScope", scope: "mcp:write" },
      { type: "setAllowCreate", value: true },
      { type: "toggleCreatedBit", bit: "write" },
    );
    expect(selectionIssues(toGrantSelection(createNoRead, live))).not.toContain("createNeedsRead");
    expect(
      selectionIssues({ ...toGrantSelection(createNoRead, live), createdKbBits: [] }),
    ).toContain("createNeedsRead");
    const createNoWriteScope = apply(
      { type: "toggleScope", scope: "mcp:read" },
      { type: "setAllowCreate", value: true },
      { type: "toggleCreatedBit", bit: "read" },
    );
    expect(selectionIssues(toGrantSelection(createNoWriteScope, live))).toContain(
      "createNeedsWriteScope",
    );
    const ok = apply({ type: "toggleScope", scope: "mcp:read" });
    expect(selectionIssues(toGrantSelection(ok, live))).toEqual([]);
  });
});

describe("signed OAuth query passthrough", () => {
  it("forwards only signed parameters verbatim and ignores injected unsigned bits", () => {
    const raw =
      "?client_id=c&scope=mcp%3Aread&sig=abc%2B%3D&ba_param=client_id&ba_param=scope&ba_param=ba_param&acl=" +
      KB_A +
      "&bits=manage&allowCreate=true";
    const query = buildSignedOAuthQuery(raw);
    expect(query).toBe(
      "client_id=c&scope=mcp%3Aread&sig=abc%2B%3D&ba_param=client_id&ba_param=scope&ba_param=ba_param",
    );
    // URL content never seeds the selection
    expect(toGrantSelection(emptySelection(), live).acl).toEqual([]);
  });

  it("returns null for an unsigned URL", () => {
    expect(buildSignedOAuthQuery("?client_id=c&scope=mcp%3Aread")).toBeNull();
    expect(buildSignedOAuthQuery("?client_id=c&sig=x")).toBeNull();
  });

  it("navigates only on a server-issued redirect with a URL", () => {
    expect(resolveOauthRedirectUrl({ redirect: true, url: "https://c/cb?code=1" })).toBe(
      "https://c/cb?code=1",
    );
    expect(resolveOauthRedirectUrl({ redirect: false, url: "https://c" })).toBeNull();
    expect(resolveOauthRedirectUrl({ redirect: true, url: "" })).toBeNull();
    expect(resolveOauthRedirectUrl(null)).toBeNull();
  });
});

describe("consent submission", () => {
  const token = {
    referenceId: "f".repeat(64),
    nonce: "00000000-0000-4000-8000-00000000000a",
    previousGrantId: null as string | null,
  };
  const selected = toGrantSelection(
    apply(
      { type: "toggleScope", scope: "mcp:read" },
      { type: "toggleBit", kbId: KB_A, bit: "read" },
    ),
    live,
  );
  function deps(overrides: Partial<ConsentDeps> = {}): ConsentDeps {
    return {
      approve: vi.fn(async () => ({ referenceId: token.referenceId, grantId: "g-new" })),
      continueConsent: vi.fn(async () => ({ redirect: true, url: "https://client/cb?code=x" })),
      ...overrides,
    };
  }

  it("approves the exact selection with the durable nonce/reference, then follows the server redirect", async () => {
    const d = deps();
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token,
      approvedKey: null,
      selection: selected,
      requestedScopes: ["mcp:read"],
    });
    expect(d.approve).toHaveBeenCalledWith({
      referenceId: token.referenceId,
      nonce: token.nonce,
      oauthQuery: "q",
      selection: {
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        acl: [{ kbId: KB_A, bits: ["read"] }],
        allowCreate: false,
        createdKbBits: [],
      },
      explicitConsent: true,
    });
    expect(d.continueConsent).toHaveBeenCalledWith({ accept: true, oauthQuery: "q" });
    expect(result).toEqual({
      phase: { kind: "redirecting", url: "https://client/cb?code=x", reused: false },
      approvedKey: selectionKey(selected),
    });
  });

  it("passes the previous grant for server-decided subset reuse and reports the server's decision", async () => {
    const d = deps({ approve: vi.fn(async () => ({ referenceId: "r", grantId: "g-old" })) });
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token: { ...token, previousGrantId: "g-old" },
      approvedKey: null,
      selection: selected,
      requestedScopes: ["mcp:read"],
    });
    expect(vi.mocked(d.approve).mock.calls[0]?.[0]).toMatchObject({ reuseGrantId: "g-old" });
    expect(result.phase).toMatchObject({ kind: "redirecting", reused: true });
  });

  it("server denial (revoked share, nonce mismatch, expiry) shows restart and never success", async () => {
    const rejected = Object.assign(new Error("Bad"), { code: "BAD_REQUEST" });
    const d = deps({ approve: vi.fn(async () => Promise.reject(rejected)) });
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token,
      approvedKey: null,
      selection: selected,
      requestedScopes: ["mcp:read"],
    });
    expect(result.phase).toEqual({ kind: "restart" });
    expect(result.approvedKey).toBeNull();
    expect(d.continueConsent).not.toHaveBeenCalled();
  });

  it("a sealed-values refusal shows the typed sealed error, not a generic restart", async () => {
    const sealed = Object.assign(new Error("Sealed"), {
      code: "BAD_REQUEST",
      data: { reason: "SEALED_VALUES_REQUIRE_CLI_OR_PAT" },
    });
    const d = deps({ approve: vi.fn(async () => Promise.reject(sealed)) });
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token,
      approvedKey: null,
      selection: selected,
      requestedScopes: ["mcp:read"],
    });
    expect(result.phase).toEqual({ kind: "sealed" });
    expect(result.approvedKey).toBeNull();
    expect(d.continueConsent).not.toHaveBeenCalled();
    expect(consentErrorPhase(sealed)).toEqual({ kind: "sealed" });
    expect(consentErrorPhase(Object.assign(new Error("x"), { code: "BAD_REQUEST" }))).toEqual({
      kind: "restart",
    });
    expect(consentErrorPhase(new Error("network"))).toEqual({ kind: "error" });
  });

  it("a provider refusal preserves the committed grant and exact selection", async () => {
    const d = deps({ continueConsent: vi.fn(async () => ({ error: "invalid_grant" })) });
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token,
      approvedKey: null,
      selection: selected,
      requestedScopes: ["mcp:read"],
    });
    expect(result.phase).toEqual({ kind: "incomplete", grantId: "g-new", reused: false });
    expect(result.approvedKey).toBe(selectionKey(selected));
  });

  it("transient failures stay retryable without claiming success", async () => {
    const d = deps({ approve: vi.fn(async () => Promise.reject(new Error("network"))) });
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token,
      approvedKey: null,
      selection: selected,
      requestedScopes: ["mcp:read"],
    });
    expect(result.phase).toEqual({ kind: "uncertain" });
    expect(result.approvedKey).toBe(selectionKey(selected));
  });

  it("an expanded reconsent cannot reuse the already-approved submit token", async () => {
    const d = deps();
    const expanded = toGrantSelection(
      apply(
        { type: "toggleScope", scope: "mcp:read" },
        { type: "toggleBit", kbId: KB_A, bit: "read" },
        { type: "toggleBit", kbId: KB_B, bit: "read" },
      ),
      live,
    );
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token,
      approvedKey: selectionKey(selected),
      selection: expanded,
      requestedScopes: ["mcp:read"],
    });
    expect(result.phase).toEqual({ kind: "uncertain" });
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("a later refusal cannot disprove a reply-lost approval", async () => {
    const d = deps({
      approve: vi.fn(async () => {
        throw { code: "BAD_REQUEST" };
      }),
    });
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token,
      approvedKey: selectionKey(selected),
      selection: selected,
      requestedScopes: ["mcp:read"],
    });
    expect(result.phase).toEqual({ kind: "uncertain" });
    expect(d.continueConsent).not.toHaveBeenCalled();
  });

  it("provider transport loss preserves an earlier reused approval and its exact retry", async () => {
    const d = deps({
      approve: vi.fn(async () => ({ referenceId: "r", grantId: "g-old" })),
      continueConsent: vi.fn(async () => {
        throw new TypeError("lost");
      }),
    });
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token: { ...token, previousGrantId: "g-old" },
      approvedKey: null,
      selection: selected,
      requestedScopes: ["mcp:read"],
    });
    expect(result.phase).toEqual({ kind: "incomplete", grantId: "g-old", reused: true });
    expect(result.approvedKey).toBe(selectionKey(selected));
  });

  it("deny posts a refusal and follows only the server redirect", async () => {
    const d = deps({
      continueConsent: vi.fn(async () => ({
        redirect: true,
        url: "https://client/cb?error=access_denied",
      })),
    });
    const result = await runConsentSubmit(d, {
      oauthQuery: "q",
      token,
      approvedKey: null,
      selection: selected,
      requestedScopes: ["mcp:read"],
      deny: true,
    });
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.continueConsent).toHaveBeenCalledWith({ accept: false, oauthQuery: "q" });
    expect(result.phase).toEqual({
      kind: "denied",
      url: "https://client/cb?error=access_denied",
    });
  });
});
