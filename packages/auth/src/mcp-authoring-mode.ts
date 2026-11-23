/**
 * How a write-capable MCP grant may author content (the "write mode" in the
 * UI, docs and `kb login --write-mode`): `dream` consolidations only, `edit`
 * direct edits only, or `both`. A read-only grant has none. Checked live on
 * every mutation, like tool groups.
 */
export const MCP_AUTHORING_MODES = ["dream", "edit", "both"] as const;
export type McpAuthoringMode = (typeof MCP_AUTHORING_MODES)[number];

/** What one mutation needs: a dream, or a direct edit. */
export type McpAuthoringNeed = "dream" | "edit";

export const MCP_AUTHORING_MODE_DB = { dream: "DREAM", edit: "EDIT", both: "BOTH" } as const;
export type McpAuthoringModeDb = (typeof MCP_AUTHORING_MODE_DB)[McpAuthoringMode];

export function isMcpAuthoringMode(value: unknown): value is McpAuthoringMode {
  return typeof value === "string" && (MCP_AUTHORING_MODES as readonly string[]).includes(value);
}

export function authoringModeFromDb(value: string | null | undefined): McpAuthoringMode | null {
  switch (value) {
    case "DREAM":
      return "dream";
    case "EDIT":
      return "edit";
    case "BOTH":
      return "both";
    default:
      return null;
  }
}

export function authoringModeToDb(mode: McpAuthoringMode | null): McpAuthoringModeDb | null {
  return mode === null ? null : MCP_AUTHORING_MODE_DB[mode];
}

/** The needs a mode satisfies. */
export function authoringCapabilities(mode: McpAuthoringMode | null): McpAuthoringNeed[] {
  if (mode === "both") return ["dream", "edit"];
  return mode === null ? [] : [mode];
}

export function authoringModeAllows(
  mode: McpAuthoringMode | null,
  need: McpAuthoringNeed,
): boolean {
  return authoringCapabilities(mode).includes(need);
}

/** `mode` grants nothing `ceiling` does not (null ceiling = no limit). */
export function authoringModeWithin(
  mode: McpAuthoringMode,
  ceiling: McpAuthoringMode | null,
): boolean {
  if (ceiling === null) return true;
  const allowed = authoringCapabilities(ceiling);
  return authoringCapabilities(mode).every((need) => allowed.includes(need));
}

/** Device-flow scope token carrying the CLI's requested ceiling (`kb login --write-mode`). */
export const DEVICE_WRITE_MODE_SCOPE_PREFIX = "kb:write-mode:";

export function deviceWriteModeCeiling(scope: string | null | undefined): McpAuthoringMode | null {
  for (const token of (scope ?? "").split(" ")) {
    if (!token.startsWith(DEVICE_WRITE_MODE_SCOPE_PREFIX)) continue;
    const mode = token.slice(DEVICE_WRITE_MODE_SCOPE_PREFIX.length);
    if (isMcpAuthoringMode(mode)) return mode;
  }
  return null;
}
