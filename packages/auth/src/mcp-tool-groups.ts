/**
 * MCP tool groups and presets (pure; no IO and no Node built-ins, so the web
 * app imports this module directly).
 */

/**
 * MCP tool groups a grant can hold, in canonical (display and storage) order.
 * A closed set validated on every write and on every admission; adding a group
 * is additive. `KB_TOOL_GROUPS` in the kb/1 catalog is this same list.
 */
export const MCP_TOOL_GROUPS = [
  "read",
  "edit",
  "assets",
  "export",
  "pull_requests",
  "index_admin",
  "kb_admin",
  "sealed",
] as const;
export type McpToolGroup = (typeof MCP_TOOL_GROUPS)[number];

/**
 * Fixed group sets the web app offers; "Advanced" exposes the groups
 * themselves. Every preset that edits carries `pull_requests`: an edit made
 * with propose-only access becomes a pull request, and the person behind it
 * may follow and close it from any of their credentials that can propose
 * so no preset hands out a token that opens PRs it cannot manage
 * (R3-W8). Merging still needs the review permission no editing preset holds.
 */
export const MCP_TOOL_PRESETS = {
  read: ["read"],
  propose: ["read", "edit", "pull_requests"],
  direct: ["read", "edit", "assets", "pull_requests"],
} as const satisfies Record<string, readonly McpToolGroup[]>;
export type McpToolPreset = keyof typeof MCP_TOOL_PRESETS;
/**
 * The KB permissions each preset may carry. Propose edits never reaches main
 * (no write, review or manage); Direct edits stops at write. Custom group sets
 * have no ceiling. Applied to both selected KB bits and created-KB bits.
 */
export const MCP_TOOL_PRESET_KB_BITS = {
  read: ["read"],
  propose: ["read", "propose"],
  direct: ["read", "propose", "write"],
} as const satisfies Record<McpToolPreset, readonly string[]>;

/** The preset whose groups are exactly `groups`, or null for a custom set. */
export function presetForGroups(groups: readonly string[]): McpToolPreset | null {
  const presets = Object.keys(MCP_TOOL_PRESETS) as McpToolPreset[];
  return (
    presets.find(
      (preset) =>
        MCP_TOOL_PRESETS[preset].length === new Set(groups).size &&
        MCP_TOOL_PRESETS[preset].every((group) => groups.includes(group)),
    ) ?? null
  );
}

/** New connections start on the Read preset. */
export const MCP_DEFAULT_TOOL_PRESET: McpToolPreset = "read";

export function isMcpToolGroup(value: unknown): value is McpToolGroup {
  return typeof value === "string" && (MCP_TOOL_GROUPS as readonly string[]).includes(value);
}

/**
 * The stored group set, or null when the row is not exactly a canonical
 * non-empty set of known groups. Admission treats null as an inactive grant.
 */
export function parseStoredToolGroups(value: unknown): McpToolGroup[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const order = value.map((group) => (isMcpToolGroup(group) ? MCP_TOOL_GROUPS.indexOf(group) : -1));
  for (let i = 0; i < order.length; i += 1) {
    if (order[i]! < 0 || (i > 0 && order[i]! <= order[i - 1]!)) return null;
  }
  return value as McpToolGroup[];
}
