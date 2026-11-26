import { MCP_TOOL_PRESETS } from "@knowledge-base/auth/mcp-tool-groups";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";

import { patDraftGrant, patDraftIssueKeys } from "@/components/kb/credential-list";
import { defaultPatSelection, patDraftSummary, patIssuesByPlace } from "@/components/kb/pat-create";
import { type LiveKbOption, selectionReducer } from "@/hooks/use-mcp-consent";

const live: LiveKbOption[] = [
  { kbId: "a".repeat(24), name: "Engineering", bits: ["read", "propose", "write"] },
  { kbId: "b".repeat(24), name: "Shared notes", bits: ["read"] },
];

describe("PAT create page draft", () => {
  it("starts on Read: read-only scope, no knowledge base, no write mode, nothing missing", () => {
    const selection = defaultPatSelection();
    expect(selection.toolGroups).toEqual(MCP_TOOL_PRESETS.read);
    expect(selection.acl).toEqual({});
    expect(selection.authoringMode).toBeNull();
    expect(selection.allowCreate).toBe(false);
    const grant = patDraftGrant(selection, live);
    expect(grant.scopes).toEqual(["mcp:read"]);
    expect(patDraftIssueKeys(grant)).toEqual([]);
  });

  it("places each problem at the part of the page it is about", () => {
    const writing = selectionReducer(defaultPatSelection(), {
      type: "setToolGroups",
      groups: MCP_TOOL_PRESETS.propose,
    });
    expect(patIssuesByPlace(patDraftGrant(writing, live))).toEqual({
      writeMode: "settings:credentials.picker.issues.writeModeRequired",
    });
    const noGroups = selectionReducer(defaultPatSelection(), { type: "setToolGroups", groups: [] });
    expect(patIssuesByPlace(patDraftGrant(noGroups, live)).tools).toBe(
      "settings:credentials.picker.issues.toolGroupRequired",
    );
  });

  it("says what Create will make in one line", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: "en-US",
      resources: { "en-US": { settings: enSettings } },
      defaultNS: "settings",
      interpolation: { escapeValue: false },
    });
    const t = i18n.getFixedT("en-US", "settings");
    const none = patDraftGrant(defaultPatSelection(), live);
    expect(patDraftSummary(t, "read", none, live, "Expires in 90 days")).toBe(
      "Read · Knowledge bases: none selected. · Expires in 90 days",
    );
    const withKb = selectionReducer(defaultPatSelection(), {
      type: "toggleBit",
      kbId: "b".repeat(24),
      bit: "read",
    });
    expect(patDraftSummary(t, "read", patDraftGrant(withKb, live), live, "No expiry")).toBe(
      "Read · Shared notes · No expiry",
    );
  });
});
