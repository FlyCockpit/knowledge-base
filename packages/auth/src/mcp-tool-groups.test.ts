import { describe, expect, it } from "vitest";

import {
  MCP_TOOL_GROUPS,
  MCP_TOOL_PRESET_KB_BITS,
  MCP_TOOL_PRESETS,
  parseStoredToolGroups,
  presetForGroups,
} from "./mcp-tool-groups";

describe("MCP tool groups", () => {
  it("presets are canonical subsets of the closed group set", () => {
    for (const groups of Object.values(MCP_TOOL_PRESETS)) {
      expect(parseStoredToolGroups([...groups])).toEqual([...groups]);
    }
    expect(MCP_TOOL_PRESETS.read).toEqual(["read"]);
  });

  it("fails closed on a stored set that is empty, unknown, duplicated or out of order", () => {
    expect(parseStoredToolGroups([...MCP_TOOL_GROUPS])).toEqual([...MCP_TOOL_GROUPS]);
    for (const stored of [
      [],
      null,
      undefined,
      "read",
      ["unknown"],
      ["read", "read"],
      ["edit", "read"],
      [1],
    ]) {
      expect(parseStoredToolGroups(stored)).toBeNull();
    }
  });

  it("names presets exactly and caps their KB permissions", () => {
    expect(presetForGroups(["pull_requests", "read", "edit"])).toBe("propose");
    expect(presetForGroups(["read", "edit"])).toBeNull();
    expect(presetForGroups([])).toBeNull();
    expect(MCP_TOOL_PRESET_KB_BITS.propose).toEqual(["read", "propose"]);
    expect(MCP_TOOL_PRESET_KB_BITS.direct).not.toContain("manage");
  });
});
