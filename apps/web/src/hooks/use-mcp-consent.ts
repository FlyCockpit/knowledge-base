import {
  MCP_DEFAULT_TOOL_PRESET,
  MCP_TOOL_GROUPS,
  MCP_TOOL_PRESET_KB_BITS,
  MCP_TOOL_PRESETS,
  type McpToolGroup,
  presetForGroups,
} from "@knowledge-base/auth/mcp-tool-groups";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";

import { consentAuthClient } from "@/lib/auth-client";
import { orpc } from "@/utils/orpc";

/**
 * Credential selection model shared by OAuth consent and PAT creation, plus
 * the consent-page submission flow.
 *
 * Invariants (CONTRACT human credential input):
 * - Nothing is ever preselected: no scope, KB, bit or create capability
 *   starts checked, and there is no "all KBs" shortcut. Tool groups start on
 *   the narrowest preset, Read; a grant always names its groups.
 * - OAuth never carries sealed recipients. Device approval extends this
 *   ceiling with exact records and a CLI-registered recipient key.
 * - Only KBs/bits the server reports as held live can be submitted; anything
 *   else in local state (or in the URL) is dropped, never sent.
 * - The signed OAuth query is forwarded verbatim; unsigned URL parameters never
 *   seed the selection. The durable nonce/reference from `prepare` is the only
 *   submit token, and once it approved one selection it cannot approve another.
 */

/** Mirrors `MCP_KB_PERMISSIONS` in `@knowledge-base/auth/mcp-grant` (test-enforced). */
export const KB_BITS = ["read", "propose", "write", "review", "manage"] as const;
export type KbBit = (typeof KB_BITS)[number];

const IMPLIED: Record<KbBit, readonly KbBit[]> = {
  read: ["read"],
  propose: ["read", "propose"],
  write: ["read", "propose", "write"],
  review: ["read", "review"],
  manage: KB_BITS,
};

/** Mirrors `expandMcpBits` (test-enforced): the bits a selection actually stores. */
export function expandKbBits(bits: readonly string[]): KbBit[] {
  const expanded = new Set(bits.filter(isKbBit).flatMap((bit) => IMPLIED[bit]));
  return KB_BITS.filter((bit) => expanded.has(bit));
}

export const SELECTABLE_SCOPES = ["mcp:read", "mcp:write"] as const;
export type SelectableScope = (typeof SELECTABLE_SCOPES)[number];
const MCP_SCOPES = ["mcp:read", "mcp:write", "offline_access"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
const isMcpScope = (value: string): value is McpScope =>
  (MCP_SCOPES as readonly string[]).includes(value);

export type LiveKbOption = {
  kbId: string;
  name: string;
  bits: readonly KbBit[];
  namespace?: string;
};
export type CredentialSelection = {
  scopes: readonly SelectableScope[];
  toolGroups: readonly McpToolGroup[];
  acl: Readonly<Record<string, readonly KbBit[]>>;
  allowCreate: boolean;
  createdKbBits: readonly KbBit[];
};

export type SelectionAction =
  | { type: "toggleScope"; scope: SelectableScope }
  | { type: "toggleBit"; kbId: string; bit: KbBit }
  | { type: "setAllowCreate"; value: boolean }
  | { type: "toggleCreatedBit"; bit: KbBit }
  | { type: "setToolGroups"; groups: readonly McpToolGroup[] }
  | { type: "toggleToolGroup"; group: McpToolGroup }
  | { type: "reset" };

export type GrantSelection = {
  scopes: McpScope[];
  toolGroups: McpToolGroup[];
  acl: { kbId: string; bits: KbBit[] }[];
  allowCreate: boolean;
  createdKbBits: KbBit[];
};

export function emptySelection(): CredentialSelection {
  return {
    scopes: [],
    toolGroups: MCP_TOOL_PRESETS[MCP_DEFAULT_TOOL_PRESET],
    acl: {},
    allowCreate: false,
    createdKbBits: [],
  };
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function selectionReducer(
  state: CredentialSelection,
  action: SelectionAction,
): CredentialSelection {
  switch (action.type) {
    case "toggleScope":
      return { ...state, scopes: toggle(state.scopes, action.scope) };
    case "toggleBit": {
      if (!allowedKbBits(state.toolGroups).includes(action.bit)) return state;
      const bits = toggle(state.acl[action.kbId] ?? [], action.bit);
      const acl = { ...state.acl };
      if (bits.length === 0) delete acl[action.kbId];
      else acl[action.kbId] = bits;
      return { ...state, acl };
    }
    case "setAllowCreate":
      // `knowledge_bases_create` lives in the kb_admin group: what is ticked is
      // what the agent gets, so the capability and its group move together.
      return effectiveSelection({
        ...state,
        toolGroups: canonicalGroups(
          action.value
            ? [...state.toolGroups, "kb_admin"]
            : state.toolGroups.filter((group) => group !== "kb_admin"),
        ),
        allowCreate: action.value,
        createdKbBits: action.value ? state.createdKbBits : [],
      });
    case "toggleCreatedBit":
      if (!allowedKbBits(state.toolGroups).includes(action.bit)) return state;
      return { ...state, createdKbBits: toggle(state.createdKbBits, action.bit) };
    case "setToolGroups":
      return withCreateGroup({ ...state, toolGroups: canonicalGroups(action.groups) });
    case "toggleToolGroup":
      return withCreateGroup({
        ...state,
        toolGroups: canonicalGroups(toggle(state.toolGroups, action.group)),
      });
    case "reset":
      return emptySelection();
  }
}

/** Creation is only callable through kb_admin: dropping the group drops the capability. */
function withCreateGroup(state: CredentialSelection): CredentialSelection {
  const next = effectiveSelection(state);
  return next.allowCreate && !next.toolGroups.includes("kb_admin")
    ? { ...next, allowCreate: false, createdKbBits: [] }
    : next;
}

const canonicalBits = (bits: readonly KbBit[], allowed: readonly KbBit[] = KB_BITS) =>
  KB_BITS.filter((bit) => bits.includes(bit) && allowed.includes(bit));
const canonicalGroups = (groups: readonly McpToolGroup[]) =>
  MCP_TOOL_GROUPS.filter((group) => groups.includes(group));

/**
 * KB permissions the selected tool groups may carry: a preset's ceiling
 * (Propose edits never reaches main), or every bit for a custom group set.
 */
export function allowedKbBits(groups: readonly McpToolGroup[]): readonly KbBit[] {
  const preset = presetForGroups(groups);
  return preset ? MCP_TOOL_PRESET_KB_BITS[preset] : KB_BITS;
}

/**
 * The one derivation of what a selection may grant: every KB and created-KB
 * bit capped to the tool preset's ceiling. Used for display and submission by
 * PAT mint, OAuth consent and device approval alike.
 */
export function effectiveSelection(selection: CredentialSelection): CredentialSelection {
  const allowed = allowedKbBits(selection.toolGroups);
  const acl: Record<string, readonly KbBit[]> = {};
  for (const [kbId, bits] of Object.entries(selection.acl)) {
    const capped = canonicalBits(bits, allowed);
    if (capped.length) acl[kbId] = capped;
  }
  return { ...selection, acl, createdKbBits: canonicalBits(selection.createdKbBits, allowed) };
}

/** Exact wire selection: only live KBs/bits within the preset's ceiling survive. */
export function toGrantSelection(
  raw: CredentialSelection,
  live: readonly LiveKbOption[],
): GrantSelection {
  const selection = effectiveSelection(raw);
  const acl = live.flatMap((kb) => {
    const bits = canonicalBits(selection.acl[kb.kbId] ?? [], kb.bits);
    return bits.length ? [{ kbId: kb.kbId, bits }] : [];
  });
  return {
    scopes: SELECTABLE_SCOPES.filter((scope) => selection.scopes.includes(scope)),
    toolGroups: canonicalGroups(selection.toolGroups),
    acl,
    allowCreate: selection.allowCreate,
    createdKbBits: selection.allowCreate ? expandKbBits(selection.createdKbBits) : [],
  };
}

export type SelectionIssue =
  | "scopeRequired"
  | "toolGroupRequired"
  | "createNeedsRead"
  | "createNeedsWriteScope";

export function selectionIssues(grant: GrantSelection): SelectionIssue[] {
  const issues: SelectionIssue[] = [];
  if (!grant.scopes.some((s) => s === "mcp:read" || s === "mcp:write")) {
    issues.push("scopeRequired");
  }
  if (grant.toolGroups.length === 0) issues.push("toolGroupRequired");
  if (grant.allowCreate && !grant.createdKbBits.includes("read")) issues.push("createNeedsRead");
  if (grant.allowCreate && !grant.scopes.includes("mcp:write")) {
    issues.push("createNeedsWriteScope");
  }
  return issues;
}

export function selectionKey(grant: GrantSelection): string {
  return JSON.stringify(grant);
}

/** Live KBs the signed-in user holds, with their live bits, for the picker. */
export function useLiveKbOptions() {
  const query = useInfiniteQuery(
    orpc.kbs.list.infiniteOptions({
      input: (cursor: string | null) => ({ limit: 50, cursor }),
      initialPageParam: null,
      getNextPageParam: (last) => last?.nextCursor ?? null,
    }),
  );
  const { data } = query;
  const live = useMemo<LiveKbOption[]>(
    () =>
      (data?.pages ?? []).flatMap((page) =>
        (page?.items ?? []).map((kb) => ({
          kbId: kb.id,
          name: kb.name,
          namespace: kb.sealedNamespace,
          bits: canonicalBits(kb.capabilities.filter((b): b is KbBit => isKbBit(b))),
        })),
      ),
    [data],
  );
  return { query, live };
}

function isKbBit(value: string): value is KbBit {
  return (KB_BITS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Signed OAuth query + consent submission
// ---------------------------------------------------------------------------

/**
 * Same projection as Better Auth's `oauthProviderClient()` (1.7.4
 * `buildSignedOAuthQuery`): keep only `sig`, `ba_param` and the parameters
 * `ba_param` lists, verbatim and in URL order. Built from the RAW
 * `window.location.search` because router search parsing collapses repeated
 * `ba_param` keys. `null` when the URL carries no signed transaction.
 */
export function buildSignedOAuthQuery(rawSearch: string): string | null {
  const params = new URLSearchParams(rawSearch);
  if (!params.has("sig")) return null;
  const signed = new Set(params.getAll("ba_param"));
  if (signed.size === 0) return null;
  const out = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "sig" || key === "ba_param" || signed.has(key)) out.append(key, value);
  }
  return out.toString();
}

/** The only navigation signal accepted: `redirect === true` plus a nonempty url. */
export function resolveOauthRedirectUrl(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.redirect !== true) return null;
  return typeof record.url === "string" && record.url.length > 0 ? record.url : null;
}

export type ConsentPhase =
  | { kind: "review" }
  | { kind: "submitting" }
  | { kind: "redirecting"; url: string; reused: boolean }
  | { kind: "denied"; url: string }
  | { kind: "restart" }
  | { kind: "incomplete"; grantId: string; reused: boolean }
  | { kind: "uncertain" }
  | { kind: "sealed" }
  | { kind: "error" };

export type ConsentToken = { referenceId: string; nonce: string; previousGrantId: string | null };
export type ApproveInput = {
  referenceId: string;
  nonce: string;
  oauthQuery: string;
  selection: GrantSelection;
  explicitConsent: true;
  reuseGrantId?: string;
};
export type ConsentDeps = {
  approve: (input: ApproveInput) => Promise<{ referenceId: string; grantId: string }>;
  continueConsent: (input: { accept: boolean; oauthQuery: string }) => Promise<unknown>;
  isCurrent?: () => boolean;
};

const REJECTION_CODES = new Set(["BAD_REQUEST", "NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]);

/** Definitive server refusals (expired/mismatched intent, revoked rights) vs transient failures. */
export function isConsentRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && REJECTION_CODES.has(code);
}

/** The server's typed refusal of a sealed-value request. */
const SEALED_REFUSAL = "SEALED_VALUES_REQUIRE_CLI_OR_PAT";

/** Maps an approval failure: typed sealed refusal, definitive refusal, or retryable error. */
export function consentErrorPhase(error: unknown): ConsentPhase {
  const data = (error as { data?: unknown } | null)?.data;
  if (
    isConsentRejection(error) &&
    typeof data === "object" &&
    data !== null &&
    (data as { reason?: unknown }).reason === SEALED_REFUSAL
  )
    return { kind: "sealed" };
  return { kind: isConsentRejection(error) ? "restart" : "error" };
}

/**
 * One consent decision. Approval commits the durable intent first; only then
 * does the provider continuation issue a code. A lost approval reply is unknown;
 * any continuation failure preserves the committed approval. Retries must use
 * the exact attempted selection, even when the approval reply was lost.
 */
export async function runConsentSubmit(
  deps: ConsentDeps,
  input: {
    oauthQuery: string;
    token: ConsentToken;
    approvedKey: string | null;
    selection: GrantSelection;
    requestedScopes: readonly string[];
    approvedGrant?: { grantId: string; reused: boolean };
    deny?: boolean;
  },
): Promise<{ phase: ConsentPhase; approvedKey: string | null }> {
  const { oauthQuery, token, approvedKey } = input;
  const current = deps.isCurrent ?? (() => true);
  if (!current()) return { phase: { kind: "review" }, approvedKey };
  if (input.deny) {
    try {
      const url = resolveOauthRedirectUrl(
        await deps.continueConsent({ accept: false, oauthQuery }),
      );
      return { phase: url ? { kind: "denied", url } : { kind: "restart" }, approvedKey };
    } catch {
      return { phase: { kind: "error" }, approvedKey };
    }
  }
  const selection = { ...input.selection, scopes: input.requestedScopes.filter(isMcpScope) };
  const key = selectionKey(selection);
  // A submit token that already approved one selection can never approve another.
  if (approvedKey !== null && approvedKey !== key)
    return {
      phase: input.approvedGrant
        ? { kind: "incomplete", ...input.approvedGrant }
        : { kind: "uncertain" },
      approvedKey,
    };
  if (selectionIssues(selection).length > 0) return { phase: { kind: "review" }, approvedKey };
  let grantId: string;
  try {
    const approved = await deps.approve({
      referenceId: token.referenceId,
      nonce: token.nonce,
      oauthQuery,
      selection,
      explicitConsent: true,
      ...(token.previousGrantId ? { reuseGrantId: token.previousGrantId } : {}),
    });
    grantId = approved.grantId;
  } catch (error) {
    if (input.approvedGrant)
      return { phase: { kind: "incomplete", ...input.approvedGrant }, approvedKey };
    // A later refusal cannot disprove an earlier reply-lost approval.
    if (approvedKey !== null || !isConsentRejection(error))
      return { phase: { kind: "uncertain" }, approvedKey: key };
    return { phase: consentErrorPhase(error), approvedKey };
  }
  const committed = { grantId, reused: token.previousGrantId === grantId };
  if (!current()) return { phase: { kind: "incomplete", ...committed }, approvedKey: key };
  try {
    const url = resolveOauthRedirectUrl(await deps.continueConsent({ accept: true, oauthQuery }));
    if (!url) return { phase: { kind: "incomplete", ...committed }, approvedKey: key };
    return {
      phase: {
        kind: "redirecting",
        url,
        reused: token.previousGrantId !== null && grantId === token.previousGrantId,
      },
      approvedKey: key,
    };
  } catch {
    return { phase: { kind: "incomplete", ...committed }, approvedKey: key };
  }
}

async function continueConsent(input: { accept: boolean; oauthQuery: string }): Promise<unknown> {
  const result = await consentAuthClient.$fetch<unknown>("/oauth2/consent", {
    method: "POST",
    body: { accept: input.accept, oauth_query: input.oauthQuery },
  });
  return result.error ? { error: result.error } : result.data;
}

/** Consent page state: server review, live KB picker model and the submit flow. */
export function useMcpConsent(rawSearch: string, enabled: boolean) {
  const router = useRouter();
  const oauthQuery = useMemo(() => buildSignedOAuthQuery(rawSearch), [rawSearch]);
  const review = useQuery({
    ...orpc.mcpConsent.prepare.queryOptions({ input: { oauthQuery: oauthQuery ?? "" } }),
    enabled: enabled && oauthQuery !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const kbs = useLiveKbOptions();
  // Each request owns its attempts and navigation. Layout cleanup fences pending
  // completions at replacement/unmount, before another page becomes interactive.
  const owner = useMemo(
    () => ({
      oauthQuery,
      active: false,
      busy: false,
      attempt: null as GrantSelection | null,
      approvedKey: null as string | null,
      approvedGrant: undefined as { grantId: string; reused: boolean } | undefined,
    }),
    [oauthQuery],
  );
  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  const [draft, setDraft] = useState({ owner, selection: emptySelection() });
  const [outcome, setOutcome] = useState<{ owner: typeof owner; phase: ConsentPhase }>({
    owner,
    phase: { kind: "review" },
  });
  const selection = draft.owner === owner ? draft.selection : emptySelection();
  const phase = outcome.owner === owner ? outcome.phase : ({ kind: "review" } as const);
  const dispatch = (action: SelectionAction) => {
    if (!owner.active || owner.busy || owner.attempt) return;
    setDraft((previous) => ({
      owner,
      selection: selectionReducer(
        previous.owner === owner ? previous.selection : emptySelection(),
        action,
      ),
    }));
  };
  const { mutateAsync: approve } = useMutation(
    orpc.mcpConsent.approve.mutationOptions({ gcTime: 0 }),
  );
  const { data } = review;
  const grant = useMemo(
    () => ({
      ...toGrantSelection(selection, kbs.live),
      scopes: (data?.scopes ?? []).filter(isMcpScope),
    }),
    [selection, kbs.live, data?.scopes],
  );

  const submit = useCallback(
    async (deny = false) => {
      const isCurrent = () =>
        owner.active && buildSignedOAuthQuery(router.history.location.search) === oauthQuery;
      if (!isCurrent() || owner.busy || !data || oauthQuery === null) return;
      owner.busy = true;
      if (!deny) owner.attempt ??= data.approval?.selection ?? grant;
      setOutcome({ owner, phase: { kind: "submitting" } });
      const result = await runConsentSubmit(
        { approve, continueConsent, isCurrent },
        {
          oauthQuery,
          token: {
            referenceId: data.referenceId,
            nonce: data.nonce,
            previousGrantId: data.previousGrantId,
          },
          approvedKey:
            owner.approvedKey ?? (data.approval ? selectionKey(data.approval.selection) : null),
          approvedGrant:
            owner.approvedGrant ??
            (data.approval
              ? {
                  grantId: data.approval.grantId,
                  reused: data.previousGrantId === data.approval.grantId,
                }
              : undefined),
          selection: owner.attempt ?? grant,
          requestedScopes: data.scopes,
          deny,
        },
      );
      if (!isCurrent()) return;
      owner.busy = false;
      owner.approvedKey = result.approvedKey;
      if (result.phase.kind === "incomplete") owner.approvedGrant = result.phase;
      if (result.phase.kind === "review") owner.attempt = null;
      setOutcome({ owner, phase: result.phase });
      if (result.phase.kind === "redirecting" || result.phase.kind === "denied") {
        window.location.assign(result.phase.url);
      }
    },
    [approve, data, grant, oauthQuery, owner, router],
  );

  const reviewRejected = review.isError && isConsentRejection(review.error);
  return {
    oauthQuery,
    review,
    kbs,
    selection,
    dispatch,
    grant,
    issues: selectionIssues(grant),
    phase:
      oauthQuery === null || reviewRejected
        ? ({ kind: "restart" } as const)
        : phase.kind === "review" && data?.approval
          ? ({
              kind: "incomplete",
              grantId: data.approval.grantId,
              reused: data.previousGrantId === data.approval.grantId,
            } as const)
          : phase,
    submit,
    /** Back to review after a transient failure; the same submit token is reused. */
    resetError: () => setOutcome({ owner, phase: { kind: "review" } }),
  };
}
