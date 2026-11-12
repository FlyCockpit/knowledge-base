import { expandMcpBits, MCP_KB_PERMISSIONS } from "@knowledge-base/auth/mcp-grant";
import { describe, expect, it } from "vitest";

import { type CredentialSelection, expandKbBits, selectionReducer } from "@/hooks/use-mcp-consent";
import {
  grantEditPlan,
  MAX_ACTIVE_ELEVATIONS,
  planNarrows,
  selectionFromGrant,
  temporaryInput,
  temporaryIssue,
} from "@/lib/mcp-grant-edit";

const KB_A = "a".repeat(24);
const KB_B = "b".repeat(24);
const KB_GONE = "c".repeat(24);

const stored = {
  scopes: ["mcp:read"],
  toolGroups: ["read", "edit"],
  acl: [
    { kbId: KB_A, bits: ["read", "propose", "write"] },
    // No live right any more: the picker shows it removal-only.
    { kbId: KB_GONE, bits: ["read"] },
  ],
  allowCreate: false,
  createdKbBits: [],
};
type Action = Parameters<typeof selectionReducer>[1];
/** The Sheet's dispatch: applies actions and records toggled KBs. */
function edit(base: CredentialSelection, ...actions: Action[]) {
  const touched = new Set<string>();
  const draft = actions.reduce((state, action) => {
    if (action.type === "toggleBit") touched.add(action.kbId);
    return selectionReducer(state, action);
  }, base);
  return { draft, touched };
}
const plan = (
  base: CredentialSelection,
  { draft, touched }: ReturnType<typeof edit>,
  scopesEditable = true,
) => grantEditPlan(base, draft, { scopesEditable, touched });

describe("grant edit plan", () => {
  it("expands bits exactly like the server", () => {
    for (const bit of MCP_KB_PERMISSIONS) expect(expandKbBits([bit])).toEqual(expandMcpBits([bit]));
    expect(expandKbBits(["propose", "review", "nope"])).toEqual(
      expandMcpBits(["propose", "review", "nope"]),
    );
  });

  it("starts from exactly the stored ceiling and sends nothing when unchanged", () => {
    const baseline = selectionFromGrant(stored);
    expect(baseline).toEqual({
      scopes: ["mcp:read"],
      toolGroups: ["read", "edit"],
      acl: { [KB_A]: ["read", "propose", "write"], [KB_GONE]: ["read"] },
      allowCreate: false,
      createdKbBits: [],
    });
    expect(plan(baseline, edit(baseline))).toMatchObject({ empty: true, widens: false, input: {} });
    // Unchecking an implied bit changes nothing that would be stored.
    const implied = edit(baseline, { type: "toggleBit", kbId: KB_A, bit: "read" });
    expect(plan(baseline, implied).empty).toBe(true);
  });

  it("sends only changed fields and a patch of toggled KBs, listing additions and removals", () => {
    const baseline = selectionFromGrant(stored);
    const result = plan(
      baseline,
      edit(
        baseline,
        { type: "toggleScope", scope: "mcp:write" },
        { type: "toggleToolGroup", group: "assets" },
        { type: "toggleToolGroup", group: "pull_requests" },
        { type: "toggleBit", kbId: KB_A, bit: "write" },
        { type: "toggleBit", kbId: KB_B, bit: "read" },
      ),
    );
    // Direct edits (R3-W8: with pull_requests) caps at write, which no stored entry exceeds.
    expect(result.input).toEqual({
      scopes: ["mcp:read", "mcp:write"],
      toolGroups: ["read", "edit", "assets", "pull_requests"],
      aclCap: ["read", "propose", "write"],
      acl: [
        { kbId: KB_A, bits: ["read", "propose"] },
        { kbId: KB_B, bits: ["read"] },
      ],
    });
    expect(JSON.stringify(result.input)).not.toContain(KB_GONE);
    expect(result.widens).toBe(true);
    expect(result.added).toEqual({
      scopes: ["mcp:write"],
      toolGroups: ["assets", "pull_requests"],
      kbs: [{ kbId: KB_B, bits: ["read"] }],
      cap: null,
      allowCreate: false,
      createdKbBits: [],
    });
    expect(result.removed.kbs).toEqual([{ kbId: KB_A, bits: ["write"] }]);
    expect(result.removed.cap).toBeNull();
  });

  it("never deletes a KB it was not told to: entries outside the snapshot are untouched", () => {
    const baseline = selectionFromGrant(stored);
    // A KB the agent creates while the Sheet is open is absent from the snapshot and the draft.
    const result = plan(baseline, edit(baseline, { type: "toggleToolGroup", group: "export" }));
    expect(result.input).toEqual({ toolGroups: ["read", "edit", "export"] });
  });

  it("removing a KB sends empty bits; narrowing only does not need confirmation", () => {
    const baseline = selectionFromGrant(stored);
    const result = plan(
      baseline,
      edit(
        baseline,
        { type: "toggleBit", kbId: KB_A, bit: "write" },
        { type: "toggleBit", kbId: KB_A, bit: "propose" },
        { type: "toggleBit", kbId: KB_A, bit: "read" },
        { type: "toggleBit", kbId: KB_GONE, bit: "read" },
      ),
    );
    expect(result.input).toEqual({
      acl: [
        { kbId: KB_A, bits: [] },
        { kbId: KB_GONE, bits: [] },
      ],
    });
    expect(result.widens).toBe(false);
  });

  it("a capped preset is one server-side cap, whatever the stored ACL size", () => {
    const acl = Array.from({ length: 257 }, (_, i) => ({
      kbId: `k${String(i).padStart(23, "0")}`,
      bits: ["read", "propose", "write"],
    }));
    const baseline = selectionFromGrant({ ...stored, acl });
    const result = plan(baseline, edit(baseline, { type: "setToolGroups", groups: ["read"] }));
    expect(result.input).toEqual({ toolGroups: ["read"], aclCap: ["read"] });
    expect(result.removed.cap).toEqual({ bits: ["read"], count: 257 });
    expect(result.widens).toBe(false);
  });

  it("never sends scopes for an app, and swapping write for read only narrows", () => {
    const baseline = selectionFromGrant({ ...stored, scopes: ["mcp:write"] });
    const swapped = edit(
      baseline,
      { type: "toggleScope", scope: "mcp:write" },
      { type: "toggleScope", scope: "mcp:read" },
    );
    expect(plan(baseline, swapped, false).empty).toBe(true);
    const result = plan(baseline, swapped);
    expect(result.input.scopes).toEqual(["mcp:read"]);
    expect(result.added.scopes).toEqual([]);
    expect(result.widens).toBe(false);
  });

  it("turning creation on sends the created bits; turning it off clears them on the server", () => {
    const baseline = selectionFromGrant({ ...stored, scopes: ["mcp:write"] });
    const on = plan(
      baseline,
      edit(
        baseline,
        { type: "setAllowCreate", value: true },
        { type: "toggleCreatedBit", bit: "read" },
      ),
    );
    // Creation brings its tool group (kb_admin holds knowledge_bases_create).
    expect(on.input).toMatchObject({ allowCreate: true, createdKbBits: ["read"] });
    expect(on.input.toolGroups).toContain("kb_admin");
    expect(on.added).toMatchObject({ allowCreate: true, createdKbBits: ["read"] });
    const creating = selectionFromGrant({
      ...stored,
      scopes: ["mcp:write"],
      allowCreate: true,
      createdKbBits: ["read"],
    });
    const off = plan(creating, edit(creating, { type: "setAllowCreate", value: false }));
    expect(off.input).toEqual({ allowCreate: false });
    expect(off.removed).toMatchObject({ allowCreate: true, createdKbBits: ["read"] });
    expect(off.widens).toBe(false);
  });
});

describe("temporary access edits", () => {
  const base = selectionFromGrant({
    scopes: ["mcp:write"],
    toolGroups: ["read"],
    acl: [{ kbId: KB_A, bits: ["read"] }],
    allowCreate: false,
    createdKbBits: [],
  });
  const options = { writeScope: true, activeElevations: 0 };

  it("sends the additions with a duration, never scopes or a cap", () => {
    const additions = plan(
      base,
      edit(
        base,
        { type: "setToolGroups", groups: ["read", "edit", "pull_requests"] },
        { type: "toggleBit", kbId: KB_A, bit: "propose" },
        { type: "toggleBit", kbId: KB_B, bit: "read" },
      ),
      false,
    );
    expect(temporaryIssue(additions, options)).toBeNull();
    // The Propose edits preset sends a cap that narrows nothing here.
    expect(additions.input.aclCap).toEqual(["read", "propose"]);
    expect(additions.removed.cap).toBeNull();
    const input = temporaryInput(additions, "1h");
    expect(input).toEqual({
      toolGroups: ["read", "edit", "pull_requests"],
      acl: [
        { kbId: KB_A, bits: ["read", "propose"] },
        { kbId: KB_B, bits: ["read"] },
      ],
      duration: "1h",
    });
    expect(input).not.toHaveProperty("scopes");
    expect(input).not.toHaveProperty("aclCap");
  });

  it("refuses removals, a full set of active grants, and write-only groups without write", () => {
    const removes = plan(base, edit(base, { type: "toggleBit", kbId: KB_A, bit: "read" }), false);
    expect(temporaryIssue(removes, options)).toBe("removes");
    const widens = plan(
      base,
      edit(base, { type: "setToolGroups", groups: ["read", "kb_admin"] }),
      false,
    );
    expect(temporaryIssue(widens, options)).toBeNull();
    expect(temporaryIssue(widens, { ...options, activeElevations: MAX_ACTIVE_ELEVATIONS })).toBe(
      "limit",
    );
    expect(temporaryIssue(widens, { ...options, writeScope: false })).toBe("needsWrite");
    // Groups with read-only tools stay useful without write.
    const exportOnly = plan(
      base,
      edit(base, { type: "setToolGroups", groups: ["read", "export"] }),
      false,
    );
    expect(temporaryIssue(exportOnly, { ...options, writeScope: false })).toBeNull();
  });

  it("knows when a permanent edit narrows (it then ends active temporary access)", () => {
    const narrows = plan(base, edit(base, { type: "toggleBit", kbId: KB_A, bit: "read" }));
    expect(planNarrows(narrows)).toBe(true);
    const widens = plan(base, edit(base, { type: "setToolGroups", groups: ["read", "export"] }));
    expect(planNarrows(widens)).toBe(false);
    const swaps = plan(base, edit(base, { type: "setToolGroups", groups: ["export"] }));
    expect(planNarrows(swaps)).toBe(true);
  });
});
