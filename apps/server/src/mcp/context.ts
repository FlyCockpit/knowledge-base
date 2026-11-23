import {
  assertTokenAdmissible,
  type CredentialVerifier,
  demandAuthoring,
  demandToolGroups,
  KbAdmissionError,
  type TokenAdmission,
  type TokenPrincipal,
  tokenHasOauthScope,
} from "@knowledge-base/api/lib/kb/principal";
import type { McpAuthoringNeed } from "@knowledge-base/auth/mcp-authoring-mode";

/** Data-plane identity only. Staging, assets and transfers consume this same actor. */
export type BearerAdmission = {
  principal: TokenPrincipal;
  verifier: CredentialVerifier;
  /**
   * Full live admission of exactly this principal, tool-group demands
   * included (FORBIDDEN when a demanded group is gone).
   */
  recheck(): Promise<TokenAdmission>;
  /** This admission narrowed by one more tool-group demand; its recheck enforces it. */
  demandToolGroups(groups: readonly string[]): BearerAdmission;
  /** This admission narrowed by a write-mode demand (`dream` or `edit`); its recheck enforces it. */
  demandAuthoring(need: McpAuthoringNeed): BearerAdmission;
};
export type BearerAdmitter = (
  request: Request,
  options?: { selfRevoke?: boolean },
) => Promise<BearerAdmission>;

/**
 * The only constructor of a bearer admission. Its recheck enforces exactly the
 * bound principal (tool-group demands included) and a narrower admission is
 * derived, never copied, so no recheck closure outlives the principal it checks.
 */
export function bindBearerAdmission(
  principal: TokenPrincipal,
  verifier: CredentialVerifier,
  assertOpen: () => void = () => {},
): BearerAdmission {
  return {
    principal,
    verifier,
    recheck: async () => {
      assertOpen();
      const admission = await assertTokenAdmissible(principal, verifier);
      if (!tokenHasOauthScope(principal.scopes, false))
        throw new KbAdmissionError("FORBIDDEN", "Insufficient scope");
      assertOpen();
      return admission;
    },
    demandToolGroups: (groups) =>
      bindBearerAdmission(demandToolGroups(principal, groups), verifier, assertOpen),
    demandAuthoring: (need) =>
      bindBearerAdmission(demandAuthoring(principal, need), verifier, assertOpen),
  };
}
