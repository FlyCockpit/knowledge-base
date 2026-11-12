import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";

import {
  type CredentialSelection,
  emptySelection,
  type GrantSelection,
  type LiveKbOption,
  SELECTABLE_SCOPES,
  type SelectableScope,
  selectionIssues,
  selectionKey,
  selectionReducer,
  toGrantSelection,
  useLiveKbOptions,
} from "@/hooks/use-mcp-consent";
import { authClient } from "@/lib/auth-client";
import { orpc } from "@/utils/orpc";

/**
 * Browser half of the device (CLI) approval protocol (CONTRACT: device exchange).
 *
 * Order is fixed: GET `/api/auth/device?user_code=` with the session cookie
 * claims the code and returns the app-owned approval nonce; approval then
 * records ONE immutable selection (`cliCredentials.selectDeviceIntent`) and only
 * afterwards POSTs `/api/auth/device/approve` with that nonce. Denial skips the
 * selection. The browser never sees the device code or the minted PAT (the CLI
 * exchanges it), and nothing here is written to storage or logged.
 *
 * Retry safety: a selection whose response was lost is re-sent verbatim; if the
 * server then refuses, the page stops (it cannot prove the recorded intent is
 * this page's) instead of approving. A recorded intent is never re-sent.
 */

const USER_CODE = /^[A-Z0-9]{8}$/;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts the displayed `ABCD-2345` form; `null` unless exactly 8 code characters. */
export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[\s-]/g, "").toUpperCase();
  return USER_CODE.test(value) ? value : null;
}

export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export type DeviceClaim = {
  userCode: string;
  clientId: string;
  scopes: SelectableScope[];
  nonce: string;
  recipientKey?: { recipientKeyId: string; recipientPublicKey: string };
};
export type DeviceRecipient = {
  kbId: string;
  namespace: string;
  recordId: string;
  recipientKeyId: string;
  recipientPublicKey: string;
  expiresAt: string;
};
export type DeviceGrant = GrantSelection & { recipients?: DeviceRecipient[] };
export type AuthResult = { ok: true; data: unknown } | { ok: false; status: number };
export type DeviceDecision = "approve" | "deny";
export type DeviceDeps = {
  claim: (userCode: string) => Promise<AuthResult>;
  select: (input: { userCode: string; nonce: string; selection: DeviceGrant }) => Promise<unknown>;
  decide: (
    decision: DeviceDecision,
    input: { userCode: string; nonce: string },
  ) => Promise<AuthResult>;
};

export type DevicePhase =
  | { kind: "review" }
  | { kind: "submitting"; decision: DeviceDecision }
  | { kind: "approved" }
  | { kind: "denied" }
  /** Wrong, expired, already decided or consumed code (the server does not distinguish). */
  | { kind: "unavailable" }
  /** Selection refused against live rights; nothing recorded, the user may pick again. */
  | { kind: "rightsChanged" }
  /** Approve/deny refused: security check (origin/nonce), expiry or rights changed after selection. */
  | { kind: "refused" }
  /** An earlier decision's response was lost and the retry was refused. */
  | { kind: "uncertain" }
  | { kind: "signIn" }
  | { kind: "error"; decisionUncertain?: boolean };

export type DeviceProgress = {
  intent: "none" | "uncertain" | "recorded";
  intentKey: string | null;
  decisionUncertain: boolean;
};
export const initialProgress = (): DeviceProgress => ({
  intent: "none",
  intentKey: null,
  decisionUncertain: false,
});

const pendingClaim = (userCode: string) => ({
  user_code: (v: unknown) => v === userCode,
  client_id: (v: unknown) => typeof v === "string" && v.length > 0,
  status: (v: unknown) => v === "pending",
  nonce: (v: unknown) => typeof v === "string" && NONCE.test(v),
  scope: (v: unknown) => typeof v === "string",
});

function parseClaim(userCode: string, data: unknown): DeviceClaim | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const [key, valid] of Object.entries(pendingClaim(userCode)))
    if (!valid(record[key])) return null;
  const requested = String(record.scope).split(" ");
  const scopes = SELECTABLE_SCOPES.filter((s) => requested.includes(s));
  if (scopes.length === 0) return null;
  const key = record.recipient_key as Record<string, unknown> | null | undefined;
  if (
    key != null &&
    (typeof key !== "object" ||
      typeof key.recipientKeyId !== "string" ||
      !NONCE.test(key.recipientKeyId) ||
      typeof key.recipientPublicKey !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(key.recipientPublicKey))
  )
    return null;
  return {
    userCode,
    clientId: String(record.client_id),
    scopes,
    nonce: String(record.nonce),
    ...(key
      ? {
          recipientKey: {
            recipientKeyId: String(key.recipientKeyId),
            recipientPublicKey: String(key.recipientPublicKey),
          },
        }
      : {}),
  };
}

export type ClaimOutcome =
  | { kind: "claimed"; claim: DeviceClaim }
  | { kind: "unavailable" }
  | { kind: "signIn" };

/** GET claim. Refusals are states; transport/server failures throw (inline retry; GET is repeatable). */
export async function claimDevice(deps: DeviceDeps, userCode: string): Promise<ClaimOutcome> {
  const result = await deps.claim(userCode);
  if (!result.ok) {
    if (result.status === 401) return { kind: "signIn" };
    if (result.status >= 400 && result.status < 500) return { kind: "unavailable" };
    throw new Error("Device claim unavailable");
  }
  const claim = parseClaim(userCode, result.data);
  return claim ? { kind: "claimed", claim } : { kind: "unavailable" };
}

/** Grant selection for a device: scopes are exactly those the CLI requested (no offline_access). */
export function deviceGrant(
  selection: CredentialSelection,
  live: readonly LiveKbOption[],
  scopes: readonly string[],
  recipients: readonly DeviceRecipient[] = [],
): DeviceGrant {
  return {
    ...toGrantSelection(selection, live),
    scopes: SELECTABLE_SCOPES.filter((s) => scopes.includes(s)),
    ...(recipients.length ? { recipients: [...recipients] } : {}),
  };
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;
const errorData = (error: unknown) => (error as { data?: unknown } | null)?.data;

function decisionPhase(result: AuthResult, decision: DeviceDecision, progress: DeviceProgress) {
  if (result.ok) return decision === "approve" ? "approved" : "denied";
  if (result.status === 401) return "signIn";
  if (result.status >= 500) return "error";
  return progress.decisionUncertain ? "uncertain" : "refused";
}

/** One approve/deny attempt. Never sends a decision without the nonce, never records two intents. */
export async function runDeviceDecision(
  deps: DeviceDeps,
  input: {
    claim: DeviceClaim;
    progress: DeviceProgress;
    selection: DeviceGrant;
    decision: DeviceDecision;
  },
): Promise<{ phase: DevicePhase; progress: DeviceProgress }> {
  const { claim, decision } = input;
  let progress = input.progress;
  const done = (kind: DevicePhase["kind"]) => ({
    phase: (kind === "error" && progress.decisionUncertain
      ? { kind, decisionUncertain: true }
      : { kind }) as DevicePhase,
    progress,
  });
  if (!NONCE.test(claim.nonce)) return done("unavailable");
  const target = { userCode: claim.userCode, nonce: claim.nonce };

  if (decision === "approve") {
    const key = selectionKey(input.selection);
    if (progress.intentKey !== null && progress.intentKey !== key) return done("refused");
    if (selectionIssues(input.selection).length > 0) return done("review");
    if (progress.intent !== "recorded") {
      try {
        await deps.select({ ...target, selection: input.selection });
        progress = { ...progress, intent: "recorded", intentKey: key };
      } catch (error) {
        const code = errorCode(error);
        if (code === "UNAUTHORIZED") return done("signIn");
        if (code === "BAD_REQUEST" || code === "FORBIDDEN" || code === "NOT_FOUND") {
          // A refused re-send after a lost response cannot prove whose intent was recorded.
          if (progress.intent === "uncertain") return done("unavailable");
          const data = errorData(error) as { error?: unknown } | undefined;
          if (data?.error !== undefined) return done("unavailable");
          progress = initialProgress();
          return done("rightsChanged");
        }
        progress = { ...progress, intent: "uncertain", intentKey: key };
        return done("error");
      }
    }
  }

  let result: AuthResult;
  try {
    result = await deps.decide(decision, target);
  } catch {
    progress = { ...progress, decisionUncertain: true };
    return done("error");
  }
  const phase = decisionPhase(result, decision, progress);
  if (phase === "error") progress = { ...progress, decisionUncertain: true };
  return done(phase);
}

type AuthFetch = (
  path: string,
  options: Record<string, unknown>,
) => Promise<{ data: unknown; error: { status?: number } | null }>;

/** Better Auth transport (cookies included by the client). The browser adds `Origin`. */
export function createDeviceHttp($fetch: AuthFetch): Pick<DeviceDeps, "claim" | "decide"> {
  const wrap = async (path: string, options: Record<string, unknown>): Promise<AuthResult> => {
    const { data, error } = await $fetch(path, options);
    return error ? { ok: false, status: error.status ?? 500 } : { ok: true, data };
  };
  return {
    claim: (userCode) => wrap("/device", { method: "GET", query: { user_code: userCode } }),
    decide: (decision, { userCode, nonce }) =>
      wrap(`/device/${decision}`, {
        method: "POST",
        body: { userCode },
        headers: { "content-type": "application/json", "x-device-approval-nonce": nonce },
      }),
  };
}

const authHttp = createDeviceHttp(
  (path, options) => authClient.$fetch<unknown>(path, options) as ReturnType<AuthFetch>,
);

/** Device page state: claim, live KB picker model and the decision flow. */
export function useDeviceApproval(userCode: string | null) {
  const { mutateAsync: select } = useMutation(
    orpc.cliCredentials.selectDeviceIntent.mutationOptions(),
  );
  const deps = useMemo<DeviceDeps>(() => ({ ...authHttp, select }), [select]);
  const claim = useQuery({
    queryKey: ["device-claim", userCode],
    queryFn: () => claimDevice(deps, userCode ?? ""),
    enabled: userCode !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const kbs = useLiveKbOptions();
  const [selection, dispatch] = useReducer(selectionReducer, undefined, emptySelection);
  const [recipients, setRecipients] = useState<DeviceRecipient[]>([]);
  const [phase, setPhase] = useState<DevicePhase>({ kind: "review" });
  const progress = useRef<DeviceProgress>(initialProgress());
  // Once an intent may exist, the selection is frozen so a retry re-sends the same one.
  const [frozen, setFrozen] = useState(false);
  const { data } = claim;
  const claimed = data?.kind === "claimed" ? data.claim : null;
  const grant = useMemo(
    () => deviceGrant(selection, kbs.live, claimed?.scopes ?? [], recipients),
    [selection, kbs.live, claimed?.scopes, recipients],
  );

  const submit = useCallback(
    async (decision: DeviceDecision) => {
      if (!claimed) return;
      setPhase({ kind: "submitting", decision });
      const result = await runDeviceDecision(deps, {
        claim: claimed,
        progress: progress.current,
        selection: grant,
        decision,
      });
      progress.current = result.progress;
      setFrozen(result.progress.intent !== "none");
      setPhase(result.phase);
    },
    [claimed, deps, grant],
  );

  const outcome: DevicePhase | null =
    data?.kind === "unavailable" || data?.kind === "signIn" ? { kind: data.kind } : null;
  return {
    claim,
    claimed,
    kbs,
    selection,
    dispatch: frozen ? () => undefined : dispatch,
    grant,
    recipients,
    addRecipient: (recipient: DeviceRecipient) => {
      if (frozen || phase.kind === "submitting") return;
      setRecipients((previous) =>
        previous.length < 256 &&
        !previous.some(
          (r) => r.namespace === recipient.namespace && r.recordId === recipient.recordId,
        )
          ? [...previous, recipient]
          : previous,
      );
    },
    removeRecipient: (recordId: string) => {
      if (!frozen && phase.kind !== "submitting")
        setRecipients((previous) => previous.filter((r) => r.recordId !== recordId));
    },
    issues: selectionIssues(grant),
    phase: outcome ?? phase,
    submit,
    /** After a transient failure: back to review with the same claim and progress. */
    resetError: () => setPhase({ kind: "review" }),
    /** After changed rights: refresh live KBs and pick again. */
    reviewAgain: () => {
      kbs.query.refetch();
      setPhase({ kind: "review" });
    },
  };
}
