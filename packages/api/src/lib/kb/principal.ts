import type { LockQuery } from "./lock";

export type KbAdmissionCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "STORAGE_UNAVAILABLE";

export class KbAdmissionError extends Error {
  readonly name = "KbAdmissionError";
  constructor(
    readonly code: KbAdmissionCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export type BrowserPrincipal = {
  kind: "browser";
  userId: string;
  banned?: boolean;
  twoFactorSatisfied?: boolean;
  isInstanceAdmin?: boolean;
};

export type TokenPrincipal = {
  kind: "token";
  userId: string;
  grantId: string;
  grantGeneration: string;
  scopes: readonly string[];
  /** null = a never-expiring PAT (explicit human choice); OAuth always has a date. */
  expiresAt: Date | null;
  storedAcl: ReadonlyMap<string, readonly string[]>;
  /** Server-verified binding, retained through delayed/locked reauthorization. */
  credential?: { kind: "PAT" | "OAUTH"; clientId: string; resource: string; tokenId?: string };
  /**
   * Tool-group demands of the operation this principal is acting for: each
   * entry is satisfied by any one of its groups, and every entry must be.
   * Checked by every admission (dispatch, domain and lock-held rechecks)
   * against the live grant's groups. Set only through `demandToolGroups`.
   */
  toolGroupDemands?: readonly (readonly string[])[];
};

export type Principal = BrowserPrincipal | TokenPrincipal;

export type TokenAdmission = {
  generationActive: boolean;
  instanceEnabled: boolean;
  expired: boolean;
  banned: boolean;
  twoFactorSatisfied: boolean;
  /** Live tool groups of the grant generation; absent satisfies no demand. */
  toolGroups?: readonly string[];
  /**
   * The temporary access (elevations) in force in this same read, sorted ids
   * with the earliest expiry among them (`validUntil`, null when none). A
   * decision built from this admission is only valid while the same set is in
   * force; it has no other meaning.
   */
  elevations?: { ids: readonly string[]; validUntil: Date | null };
};

/**
 * Delivers output built from one elevation snapshot only while that snapshot
 * still holds. Locks cannot stop time: temporary access may expire between
 * the inputs and the delivery decision. `load` builds inputs from a fresh
 * admission (its `elevations` are the snapshot every elevation-dependent read
 * used); `publish` produces the output; `recheck` is the final admission. The
 * output is returned only when the final recheck sees exactly the snapshot's
 * elevations; otherwise it is rebuilt once, and if the set changed again the
 * output is built from the base grant alone (`load(true)`: no elevation
 * contributes), which can only show less than the credential may use.
 */
export async function decideOnElevationSnapshot<
  I extends { elevations?: TokenAdmission["elevations"] },
  T,
>(steps: {
  load: (baseOnly: boolean) => Promise<I>;
  publish: (inputs: I) => Promise<T>;
  recheck: () => Promise<TokenAdmission>;
  /** Test seam: runs after output is built, before its final recheck. */
  beforeDecision?: () => Promise<void>;
}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inputs = await steps.load(false);
    const published = await steps.publish(inputs);
    await steps.beforeDecision?.();
    const final = await steps.recheck();
    if (sameElevations(inputs.elevations, final.elevations)) return published;
  }
  const published = await steps.publish(await steps.load(true));
  await steps.recheck();
  return published;
}

/** Whether two admissions saw exactly the same elevations in force. */
export function sameElevations(
  a: TokenAdmission["elevations"],
  b: TokenAdmission["elevations"],
): boolean {
  const left = a?.ids ?? [];
  const right = b?.ids ?? [];
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

export type LiveIdentity = {
  banned: boolean;
  twoFactorSatisfied: boolean;
  instanceEnabled: boolean;
};

/**
 * Full grant validity callback for unified authorize. The production adapter
 * (`createGrantCredentialVerifier`) re-reads the exact grant generation, its
 * PAT tombstone, the live user, and the stored GrantKbAcl on every call; a
 * digest lookup alone is never admission.
 */
export type CredentialVerifier = {
  inspect(principal: TokenPrincipal): Promise<TokenAdmission>;
  /** Rebind reads to the transaction holding the authority lock. */
  forQuery?(query: LockQuery): CredentialVerifier;
  /** Live stored grant ceiling for one KB. When absent, the principal snapshot is used. */
  grantBits?(principal: TokenPrincipal, kbId: string): Promise<readonly string[]>;
};

export function assertLiveIdentity(identity: LiveIdentity | null): void {
  if (!identity || identity.banned || !identity.twoFactorSatisfied || !identity.instanceEnabled) {
    throw new KbAdmissionError("UNAUTHORIZED", "Credential is not admissible");
  }
}

export function actorKeyFor(principal: Principal): string {
  return principal.kind === "token" ? `grant:${principal.grantId}` : `user:${principal.userId}`;
}

export function tokenHasOauthScope(scopes: readonly string[], mutation: boolean): boolean {
  if (mutation) return scopes.includes("mcp:write");
  return scopes.includes("mcp:read") || scopes.includes("mcp:write");
}

/**
 * The principal with one more tool-group demand (any of `groups`). Browser
 * principals hold no grant and are returned unchanged, as is an empty set
 * (the supporting tools belong to no group).
 */
export function demandToolGroups<P extends Principal>(principal: P, groups: readonly string[]): P {
  if (principal.kind !== "token" || groups.length === 0) return principal;
  return { ...principal, toolGroupDemands: [...(principal.toolGroupDemands ?? []), groups] };
}

/** Whether a grant's live groups satisfy every demand. */
export function toolGroupsSatisfy(
  demands: readonly (readonly string[])[] | undefined,
  granted: readonly string[] | undefined,
): boolean {
  return (demands ?? []).every((anyOf) => anyOf.some((group) => granted?.includes(group)));
}

/**
 * Full admission, then the principal's tool-group demands against the same
 * live grant read. Returns the admission so callers can reuse it.
 */
export async function assertTokenAdmissible(
  principal: TokenPrincipal,
  verifier: CredentialVerifier,
): Promise<TokenAdmission> {
  const admission = await verifier.inspect(principal);
  if (
    !admission.generationActive ||
    !admission.instanceEnabled ||
    admission.expired ||
    admission.banned ||
    !admission.twoFactorSatisfied
  ) {
    throw new KbAdmissionError("UNAUTHORIZED", "Credential is not admissible");
  }
  if (!toolGroupsSatisfy(principal.toolGroupDemands, admission.toolGroups)) {
    throw new KbAdmissionError("FORBIDDEN", "Tool group not granted");
  }
  return admission;
}
