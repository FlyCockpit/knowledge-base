import { MCP_TOOL_GROUPS, type McpToolGroup } from "@knowledge-base/auth/mcp-tool-groups";

import {
  allowedKbBits,
  type CredentialSelection,
  effectiveSelection,
  expandKbBits,
  KB_BITS,
  type KbBit,
  SELECTABLE_SCOPES,
  type SelectableScope,
} from "@/hooks/use-mcp-consent";
import { MCP_TOOLS } from "@/lib/mcp-tools";

/**
 * Editing an existing connection (`mcpGrants.updateMine`): the stored ceiling
 * as an editable selection, and the exact edit a draft makes against it.
 *
 * The server stays authoritative: it expands bits, validates every added bit
 * against live rights and rejects (never clips). This only decides what to
 * send and lists what is added or removed for the confirmation step.
 */

/** The stored ceiling of one grant, as the credential lists return it. */
export type GrantCeiling = {
  scopes: readonly string[];
  toolGroups: readonly string[];
  acl: readonly { kbId: string; bits: readonly string[] }[];
  allowCreate: boolean;
  createdKbBits: readonly string[];
};

/** The editable selection of a grant: exactly its stored ceiling, nothing added. */
export function selectionFromGrant(grant: GrantCeiling): CredentialSelection {
  const acl: Record<string, readonly KbBit[]> = {};
  for (const entry of grant.acl) {
    const bits = expandKbBits(entry.bits);
    if (bits.length) acl[entry.kbId] = bits;
  }
  return {
    scopes: SELECTABLE_SCOPES.filter((scope) => grant.scopes.includes(scope)),
    toolGroups: MCP_TOOL_GROUPS.filter((group) => grant.toolGroups.includes(group)),
    acl,
    allowCreate: grant.allowCreate,
    createdKbBits: grant.allowCreate ? expandKbBits(grant.createdKbBits) : [],
  };
}

/** Wire input of `mcpGrants.updateMine` without its id. `acl` is a per-KB patch. */
type GrantEditInput = {
  scopes?: SelectableScope[];
  toolGroups?: McpToolGroup[];
  acl?: { kbId: string; bits: KbBit[] }[];
  /** Server-side narrowing of every stored entry; no per-entry payload. */
  aclCap?: KbBit[];
  allowCreate?: boolean;
  createdKbBits?: KbBit[];
  /** Temporary access: absent for a permanent edit. */
  duration?: ElevationDuration;
};

export type GrantEditChanges = {
  scopes: SelectableScope[];
  toolGroups: McpToolGroup[];
  kbs: { kbId: string; bits: KbBit[] }[];
  /** Removed only: every stored KB limited to these bits; `count` known stored KBs above it. */
  cap: { bits: KbBit[]; count: number } | null;
  allowCreate: boolean;
  createdKbBits: KbBit[];
};

export type GrantEditPlan = {
  input: GrantEditInput;
  added: GrantEditChanges;
  removed: GrantEditChanges;
  empty: boolean;
  widens: boolean;
};

const without = <T>(a: readonly T[], b: readonly T[]) => a.filter((value) => !b.includes(value));
const same = <T>(a: readonly T[], b: readonly T[]) =>
  without(a, b).length === 0 && without(b, a).length === 0;
const noChanges = (): GrantEditChanges => ({
  scopes: [],
  toolGroups: [],
  kbs: [],
  cap: null,
  allowCreate: false,
  createdKbBits: [],
});

/**
 * The edit a draft makes against the stored ceiling it was opened from (a
 * stable snapshot). The draft is capped to its tool preset first (the same
 * `effectiveSelection` mint and consent submit) and compared in expanded form,
 * so toggling an implied bit is no change.
 *
 * - Only KBs the user toggled (`touched`) are patched; nothing is ever deleted
 *   by diffing, so KBs that appear later (creator appends) are never touched.
 * - A preset with a KB-permission ceiling is sent as one `aclCap`, which the
 *   server applies to every stored entry atomically, whatever its size.
 */
export function grantEditPlan(
  baseline: CredentialSelection,
  draft: CredentialSelection,
  options: { scopesEditable: boolean; touched: ReadonlySet<string> },
): GrantEditPlan {
  const next = effectiveSelection(draft);
  const input: GrantEditInput = {};
  const added = noChanges();
  const removed = noChanges();

  if (options.scopesEditable && !same(baseline.scopes, next.scopes)) {
    input.scopes = SELECTABLE_SCOPES.filter((scope) => next.scopes.includes(scope));
    removed.scopes = without(baseline.scopes, input.scopes);
    // As on the server: an added scope widens when it adds a capability (mcp:write
    // implies reads) or nothing was removed; swapping write for read only narrows.
    const gainsWrite = input.scopes.includes("mcp:write") && !baseline.scopes.includes("mcp:write");
    const gainsRead = input.scopes.length > 0 && baseline.scopes.length === 0;
    if (gainsWrite || gainsRead || removed.scopes.length === 0)
      added.scopes = without(input.scopes, baseline.scopes);
  }
  if (!same(baseline.toolGroups, next.toolGroups)) {
    input.toolGroups = MCP_TOOL_GROUPS.filter((group) => next.toolGroups.includes(group));
    added.toolGroups = without(input.toolGroups, baseline.toolGroups);
    removed.toolGroups = without(baseline.toolGroups, input.toolGroups);
  }
  if (baseline.allowCreate !== next.allowCreate) {
    input.allowCreate = next.allowCreate;
    added.allowCreate = next.allowCreate;
    removed.allowCreate = !next.allowCreate;
  }
  const createdBefore = baseline.allowCreate ? expandKbBits(baseline.createdKbBits) : [];
  const createdAfter = next.allowCreate ? expandKbBits(next.createdKbBits) : [];
  if (!same(createdBefore, createdAfter)) {
    // Turning creation off clears the created bits on the server.
    if (next.allowCreate) input.createdKbBits = createdAfter;
    added.createdKbBits = without(createdAfter, createdBefore);
    removed.createdKbBits = without(createdBefore, createdAfter);
  }
  const ceiling = allowedKbBits(next.toolGroups);
  if (ceiling.length < KB_BITS.length) {
    const above = Object.values(baseline.acl).filter(
      (bits) => without(expandKbBits(bits), ceiling).length > 0,
    ).length;
    // Choosing a capped preset limits every stored KB, including ones not loaded here.
    if (input.toolGroups || above > 0) {
      input.aclCap = [...ceiling];
      if (above > 0) removed.cap = { bits: [...ceiling], count: above };
    }
  }
  const patch: { kbId: string; bits: KbBit[] }[] = [];
  for (const kbId of [...options.touched].sort()) {
    const before = expandKbBits(baseline.acl[kbId] ?? []);
    const after = expandKbBits(next.acl[kbId] ?? []);
    if (same(before, after)) continue;
    patch.push({ kbId, bits: after });
    const gained = without(after, before);
    const lost = without(before, after);
    if (gained.length) added.kbs.push({ kbId, bits: gained });
    if (lost.length) removed.kbs.push({ kbId, bits: lost });
  }
  if (patch.length) input.acl = patch;

  const widens =
    added.scopes.length > 0 ||
    added.toolGroups.length > 0 ||
    added.kbs.length > 0 ||
    added.allowCreate ||
    added.createdKbBits.length > 0;
  return { input, added, removed, empty: Object.keys(input).length === 0, widens };
}

/** Temporary access lengths `mcpGrants.updateMine` accepts (7 days at most). */
export const ELEVATION_DURATIONS = ["1h", "1d", "7d"] as const;
export type ElevationDuration = (typeof ELEVATION_DURATIONS)[number];
/** How long an edit lasts: permanent, or temporary access that lapses on its own. */
export type EditDuration = "permanent" | ElevationDuration;
/** Mirrors the server's limit on temporary access in force per connection. */
export const MAX_ACTIVE_ELEVATIONS = 5;

/** Groups whose every tool changes data: useless without `mcp:write`, which temporary access never adds. */
const WRITE_ONLY_GROUPS = MCP_TOOL_GROUPS.filter((group) => {
  const tools = MCP_TOOLS.filter((tool) => tool.groups.includes(group));
  return tools.length > 0 && tools.every((tool) => !tool.readOnly);
});

export type TemporaryIssue = "limit" | "removes" | "needsWrite";

/**
 * Whether an edit removes anything. On the server a permanent narrowing also
 * ends every active temporary access of the connection.
 */
export function planNarrows(plan: GrantEditPlan): boolean {
  const { removed } = plan;
  return (
    removed.scopes.length > 0 ||
    removed.toolGroups.length > 0 ||
    removed.kbs.length > 0 ||
    removed.cap !== null ||
    removed.allowCreate ||
    removed.createdKbBits.length > 0
  );
}

/**
 * Why an edit cannot be made temporary, or null. Temporary access only adds
 * (it never removes or changes scopes), at most MAX_ACTIVE_ELEVATIONS are in
 * force at once, and it cannot add `mcp:write`, so groups that only change
 * data are refused without it. The server enforces the same rules.
 */
export function temporaryIssue(
  plan: GrantEditPlan,
  options: { writeScope: boolean; activeElevations: number },
): TemporaryIssue | null {
  if (options.activeElevations >= MAX_ACTIVE_ELEVATIONS) return "limit";
  if (planNarrows(plan)) return "removes";
  if (
    !options.writeScope &&
    plan.added.toolGroups.some((group) => WRITE_ONLY_GROUPS.includes(group))
  )
    return "needsWrite";
  return null;
}

/**
 * The wire input of a temporary edit: the same additions, never a scope edit,
 * and no cap (a cap that narrows nothing is dropped; one that narrows is a
 * removal, refused by `temporaryIssue`).
 */
export function temporaryInput(plan: GrantEditPlan, duration: ElevationDuration): GrantEditInput {
  const { scopes: _scopes, aclCap: _aclCap, ...additions } = plan.input;
  return { ...additions, duration };
}
