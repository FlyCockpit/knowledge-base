import { isUserBanned } from "@knowledge-base/auth/ban";
import { expandMcpBits } from "@knowledge-base/auth/mcp-grant";
import {
  FORCE_2FA_INTERNAL_USERS_SETTING_KEY,
  FORCE_2FA_PUBLIC_USERS_SETTING_KEY,
  FORCE_2FA_SETTING_KEYS,
  forcedTwoFactorSettingKeyForRole,
  isForcedTwoFactorEnabled,
  isTwoFactorRequirementSatisfied,
} from "@knowledge-base/auth/two-factor-policy";
import type { Prisma, PrismaClient } from "@knowledge-base/db/client";
import type { HeldLockLease, LockQuery } from "./lock";
import { KbLockError } from "./lock";
import {
  assertLiveIdentity,
  assertTokenAdmissible,
  type CredentialVerifier,
  KbAdmissionError,
  type LiveIdentity,
  type Principal,
  type TokenPrincipal,
  tokenHasOauthScope,
} from "./principal";

export { type KbAdmissionCode, KbAdmissionError, type LiveIdentity } from "./principal";

export const PERMISSIONS = ["read", "propose", "write", "review", "manage"] as const;
export type Permission = (typeof PERMISSIONS)[number];
/** Owner-only operations additionally require the `manage` bit (§1.9: index chunk limit). */
export type KbOperation = Permission | "delete" | "configure_index_limit";

export type KnowledgeBaseState = "CREATING" | "ACTIVE" | "TOMBSTONED" | "REPAIR_REQUIRED";

export type KnowledgeBaseRecord = {
  id: string;
  ownerId: string | null;
  state: KnowledgeBaseState;
};

export type ShareRecord = {
  bits: readonly string[];
  revokedAt: Date | null;
};

export type LiveAuthorityStore = {
  loadKb(id: string): Promise<KnowledgeBaseRecord | null>;
  loadShare(kbId: string, userId: string): Promise<ShareRecord | null>;
  loadIdentity(userId: string): Promise<LiveIdentity | null>;
};

export type Authorization = {
  kbId: string;
  ownerId: string | null;
  state: KnowledgeBaseState;
  bits: Permission[];
  principal: Principal;
};

const kbSelect = {
  id: true,
  ownerId: true,
  state: true,
} satisfies Prisma.KnowledgeBaseSelect;

const shareSelect = {
  bits: true,
  revokedAt: true,
} satisfies Prisma.KbShareSelect;

const userSelect = {
  banned: true,
  banExpires: true,
  twoFactorEnabled: true,
  role: true,
  createdAt: true,
  twoFactorGraceStartedAt: true,
} satisfies Prisma.UserSelect;

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function expandBits(bits: readonly string[]): Permission[] {
  return expandMcpBits(bits);
}

export function intersectBits(
  left: readonly Permission[],
  right: readonly Permission[],
): Permission[] {
  const other = new Set(right);
  return PERMISSIONS.filter((permission) => left.includes(permission) && other.has(permission));
}

function identityFromUser(
  user: {
    banned?: boolean | null;
    banExpires?: Date | string | null;
    twoFactorEnabled?: boolean | null;
    role?: string | null;
    createdAt?: Date | string | null;
    twoFactorGraceStartedAt?: Date | string | null;
  },
  settings: ReadonlyMap<string, string>,
): LiveIdentity {
  const key = forcedTwoFactorSettingKeyForRole(user.role);
  const forced = isForcedTwoFactorEnabled(key, settings.get(key));
  return {
    banned: isUserBanned(user),
    twoFactorSatisfied: isTwoFactorRequirementSatisfied(user, forced),
    // Browser authority has no instance-disable setting yet. The MCP enablement
    // source must be enforced by the credential adapter when auth chunks land;
    // token admission already requires that adapter's live instanceEnabled value.
    instanceEnabled: true,
  };
}

export function prismaAuthorityStore(db: PrismaClient): LiveAuthorityStore {
  return {
    async loadKb(id) {
      return db.knowledgeBase.findUnique({ where: { id }, select: kbSelect });
    },
    async loadShare(kbId, userId) {
      return db.kbShare.findUnique({
        where: { kbId_userId: { kbId, userId } },
        select: shareSelect,
      });
    },
    async loadIdentity(userId) {
      const user = await db.user.findUnique({ where: { id: userId }, select: userSelect });
      if (!user) return null;
      const settings = await db.appSetting.findMany({
        where: { key: { in: [...FORCE_2FA_SETTING_KEYS] } },
        select: { key: true, value: true },
        // pagination:audited — bounded by the compile-time settings key list
        take: FORCE_2FA_SETTING_KEYS.length,
      });
      return identityFromUser(user, new Map(settings.map((row) => [row.key, row.value])));
    },
  };
}

function asState(value: unknown): KnowledgeBaseState | null {
  switch (value) {
    case "CREATING":
    case "ACTIVE":
    case "TOMBSTONED":
    case "REPAIR_REQUIRED":
      return value;
    default:
      return null;
  }
}

export function sqlAuthorityStore(query: LockQuery): LiveAuthorityStore {
  return {
    async loadKb(id) {
      const result = await query<{ id: string; ownerId: string | null; state: string }>(
        `SELECT id, "ownerId", state::text AS state FROM "knowledge_base" WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      const state = asState(row.state);
      if (!state) return null;
      return { id: row.id, ownerId: row.ownerId, state };
    },
    async loadShare(kbId, userId) {
      const result = await query<{ bits: string[] | null; revokedAt: Date | string | null }>(
        `SELECT bits, "revokedAt" FROM "kb_share" WHERE "kbId" = $1 AND "userId" = $2`,
        [kbId, userId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        bits: Array.isArray(row.bits) ? row.bits : [],
        revokedAt: row.revokedAt ? new Date(row.revokedAt) : null,
      };
    },
    async loadIdentity(userId) {
      const result = await query<{
        banned: boolean | null;
        banExpires: Date | string | null;
        twoFactorEnabled: boolean | null;
        role: string | null;
        createdAt: Date | string | null;
        twoFactorGraceStartedAt: Date | string | null;
        forcePublic: string | null;
        forceInternal: string | null;
      }>(
        `SELECT u.banned, u."banExpires", u."twoFactorEnabled", u.role, u."createdAt",
                u."twoFactorGraceStartedAt",
                pub.value AS "forcePublic", internal.value AS "forceInternal"
           FROM "user" u
           LEFT JOIN "app_setting" pub ON pub.key = $2
           LEFT JOIN "app_setting" internal ON internal.key = $3
          WHERE u.id = $1`,
        [userId, FORCE_2FA_PUBLIC_USERS_SETTING_KEY, FORCE_2FA_INTERNAL_USERS_SETTING_KEY],
      );
      const row = result.rows[0];
      if (!row) return null;
      const settings = new Map<string, string>();
      if (typeof row.forcePublic === "string") {
        settings.set(FORCE_2FA_PUBLIC_USERS_SETTING_KEY, row.forcePublic);
      }
      if (typeof row.forceInternal === "string") {
        settings.set(FORCE_2FA_INTERNAL_USERS_SETTING_KEY, row.forceInternal);
      }
      return identityFromUser(row, settings);
    },
  };
}

export async function liveBitsFor(
  store: LiveAuthorityStore,
  kb: KnowledgeBaseRecord,
  userId: string,
): Promise<Permission[]> {
  if (kb.ownerId === userId) return [...PERMISSIONS];
  const share = await store.loadShare(kb.id, userId);
  if (!share || share.revokedAt) return [];
  return expandBits(share.bits);
}

function ownerOnly(operation: KbOperation): operation is "delete" | "configure_index_limit" {
  return operation === "delete" || operation === "configure_index_limit";
}

function requiredBit(operation: KbOperation): Permission {
  return ownerOnly(operation) ? "manage" : operation;
}

function isMutation(operation: KbOperation): boolean {
  return operation !== "read";
}

const MISSING = "Knowledge base not found";

export type AuthorizeInput = {
  principal: Principal;
  kbId: string;
  operation: KbOperation;
  store: LiveAuthorityStore;
  verifier?: CredentialVerifier;
  query?: LockQuery;
};

async function loadLiveIdentity(
  store: LiveAuthorityStore,
  userId: string,
): Promise<LiveIdentity | null> {
  try {
    return await store.loadIdentity(userId);
  } catch (error) {
    if (error instanceof KbAdmissionError) throw error;
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Credential cannot be verified");
  }
}

/** The stored grant ceiling: live GrantKbAcl via the verifier, else the principal snapshot. */
async function storedGrantBits(
  principal: TokenPrincipal,
  kbId: string,
  verifier: CredentialVerifier | undefined,
): Promise<readonly string[]> {
  if (verifier?.grantBits) return verifier.grantBits(principal, kbId);
  return principal.storedAcl.get(kbId) ?? [];
}

export async function authorize(input: AuthorizeInput): Promise<Authorization> {
  const store = input.query ? sqlAuthorityStore(input.query) : input.store;
  const { principal, kbId, operation } = input;
  const verifier = input.query
    ? (input.verifier?.forQuery?.(input.query) ?? input.verifier)
    : input.verifier;
  if (principal.kind === "browser") {
    const identity = await loadLiveIdentity(store, principal.userId);
    assertLiveIdentity(identity);
  } else {
    if (!verifier) {
      throw new KbAdmissionError("UNAUTHORIZED", "Credential is not admissible");
    }
    await assertTokenAdmissible(principal, verifier);
    if (!tokenHasOauthScope(principal.scopes, isMutation(operation))) {
      const kbForScope = await store.loadKb(kbId);
      const live =
        kbForScope && kbForScope.state !== "TOMBSTONED"
          ? await liveBitsFor(store, kbForScope, principal.userId)
          : [];
      const stored = expandBits(await storedGrantBits(principal, kbId, verifier));
      const readable = intersectBits(stored, live).includes("read");
      throw new KbAdmissionError(
        readable ? "FORBIDDEN" : "NOT_FOUND",
        readable ? "Forbidden" : MISSING,
      );
    }
  }

  const kb = await store.loadKb(kbId);
  if (!kb || kb.state === "TOMBSTONED") {
    throw new KbAdmissionError("NOT_FOUND", MISSING);
  }

  const live = await liveBitsFor(store, kb, principal.userId);
  const stored =
    principal.kind === "token"
      ? expandBits(await storedGrantBits(principal, kbId, verifier))
      : live;
  const effective = principal.kind === "token" ? intersectBits(stored, live) : live;
  if (!effective.includes("read")) {
    throw new KbAdmissionError("NOT_FOUND", MISSING);
  }
  if (ownerOnly(operation) && kb.ownerId !== principal.userId) {
    throw new KbAdmissionError("FORBIDDEN", "Forbidden");
  }
  if (!effective.includes(requiredBit(operation))) {
    throw new KbAdmissionError("FORBIDDEN", "Forbidden");
  }
  return { kbId: kb.id, ownerId: kb.ownerId, state: kb.state, bits: effective, principal };
}

export async function recheckRead(input: AuthorizeInput): Promise<Authorization> {
  return authorize({ ...input, operation: "read" });
}

/**
 * Replay-only admission: a finalized receipt is private to its live actor, but
 * the KB it mutated may since have been tombstoned or reshared, so per-KB
 * authorize() is impossible. Ban, forced-2FA, and instance state are still
 * enforced live before any receipt body is returned.
 */
export async function assertLiveBrowserIdentity(
  store: LiveAuthorityStore,
  userId: string,
  query?: LockQuery,
): Promise<void> {
  const effective = query ? sqlAuthorityStore(query) : store;
  const identity = await loadLiveIdentity(effective, userId);
  assertLiveIdentity(identity);
}

export async function recheckWriteBeforeReservation(
  lease: HeldLockLease,
  input: AuthorizeInput,
): Promise<Authorization> {
  if (!lease.holdingAuthority()) {
    throw new KbLockError(
      "NOT_HELD",
      "write authorization requires the authority lock",
      lease.opId,
    );
  }
  const query = typeof lease.query === "function" ? lease.query : undefined;
  return authorize({ ...input, query });
}
