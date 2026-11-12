import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { ADMIN_EMAIL, env, SIGNUP_ENABLED } from "@knowledge-base/env/server";
import type { BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import {
  assertOrdinaryAccountDeletionAllowed,
  getAccountRemovalExecutor,
  runWithAllowedAccountDeletion,
} from "./account-deletion-policy.js";
import {
  isPermanentBanWrite,
  recordTwoFactorGraceStartAtCreation,
  recordTwoFactorGraceStartForRoleChange,
  revokeUserMcpGrants,
  settleOutgoingTwoFactorMcpGrants,
  withOutgoingTwoFactorMcpSettlement,
} from "./ban.js";
import { canonicalizeEmail } from "./email.js";
import { isAdminRole, isImpersonatedSession } from "./roles.js";
import { getAdminMutationActor, readLiveAdminPolicy } from "./session-authority.js";
import { sanitizeUserCreateData, sanitizeUserUpdateData } from "./user-columns.js";
import {
  getAllowedUserCreationMode,
  SIGNUP_DISABLED_MESSAGE,
  type UserCreationMode,
} from "./user-creation-policy.js";

/** Library endpoints must also reject previously issued impersonated sessions.
 * Session resolution here calls the library's internal endpoint, not this hook.
 * Sign-out remains available solely to discard the unusable legacy session.
 */
export const rejectImpersonatedSession = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/sign-out") return;
  const session = await getSessionFromCtx(ctx);
  if (isImpersonatedSession(session)) throw new APIError("FORBIDDEN");
});

export const BOOTSTRAP_STATE_ID = "singleton";
export const FIRST_USER_ROLE = "admin";
export const DEFAULT_ROLE = "user";

export type BootstrapPolicy = {
  nodeEnv: string;
  adminEmail: string | undefined;
  signupEnabled: boolean;
};

export type BootstrapDecision =
  | { action: "reject"; message: string }
  | {
      action: "create";
      role: string;
      canonicalEmail?: string;
      completeBootstrap: boolean;
    };

export type BootstrapStateSnapshot = {
  completedAt: Date | null;
};

const USER_MODEL_NAMES = new Set(["user", "User"]);

export function isUserModel(model: string): boolean {
  return USER_MODEL_NAMES.has(model);
}

export function preserveRequestedRole(requestedRole: unknown): string {
  if (typeof requestedRole === "string") {
    const trimmed = requestedRole.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_ROLE;
  }
  if (Array.isArray(requestedRole)) {
    const roles = requestedRole
      .filter((role): role is string => typeof role === "string")
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
    return roles.length > 0 ? roles.join(",") : DEFAULT_ROLE;
  }
  return DEFAULT_ROLE;
}

export function isAdminBootstrapSignupEnabled(input: {
  signupEnabled: boolean;
  bootstrapComplete: boolean;
  nodeEnv: string;
  adminEmail: string | undefined;
}): boolean {
  if (input.signupEnabled || input.bootstrapComplete) return false;
  if (input.nodeEnv === "production") return input.adminEmail !== undefined;
  return true;
}

/**
 * Pure first-user / post-bootstrap create decision. The wrapped adapter
 * evaluates this after locking the singleton so concurrent creates share one
 * outcome: at most one admin, and ADMIN_EMAIL never re-promotes after
 * completion.
 */
export function decideUserCreate(input: {
  bootstrapComplete: boolean;
  policy: BootstrapPolicy;
  creationMode: UserCreationMode | undefined;
  email: unknown;
  requestedRole?: unknown;
}): BootstrapDecision {
  const isInvite = input.creationMode === "admin-invite";
  const email = canonicalizeEmail(input.email);
  const production = input.policy.nodeEnv === "production";

  if (input.bootstrapComplete) {
    if (!input.policy.signupEnabled && !isInvite) {
      return { action: "reject", message: SIGNUP_DISABLED_MESSAGE };
    }
    return {
      action: "create",
      role: isInvite ? preserveRequestedRole(input.requestedRole) : DEFAULT_ROLE,
      completeBootstrap: false,
    };
  }

  if (isInvite) {
    const role = preserveRequestedRole(input.requestedRole);
    return { action: "create", role, completeBootstrap: isAdminRole(role) };
  }

  if (production) {
    if (!email || !input.policy.adminEmail || email !== input.policy.adminEmail) {
      return { action: "reject", message: SIGNUP_DISABLED_MESSAGE };
    }
    return {
      action: "create",
      role: FIRST_USER_ROLE,
      canonicalEmail: input.policy.adminEmail,
      completeBootstrap: true,
    };
  }

  return {
    action: "create",
    role: FIRST_USER_ROLE,
    ...(email && email === input.policy.adminEmail
      ? { canonicalEmail: input.policy.adminEmail }
      : {}),
    completeBootstrap: true,
  };
}

export async function runBootstrappedUserCreate<R extends { id?: unknown }>(input: {
  data: Record<string, unknown>;
  createUser: (data: Record<string, unknown>) => Promise<R>;
  lockState: () => Promise<BootstrapStateSnapshot>;
  adoptExistingUsers?: () => Promise<BootstrapStateSnapshot | null>;
  complete: (userId: string | null, at: Date) => Promise<void>;
  policy: BootstrapPolicy;
  creationMode: UserCreationMode | undefined;
}): Promise<R> {
  const state = await input.lockState();
  let bootstrapComplete = state.completedAt != null;
  if (!bootstrapComplete && input.adoptExistingUsers) {
    const adopted = await input.adoptExistingUsers();
    bootstrapComplete = adopted?.completedAt != null;
  }
  const decision = decideUserCreate({
    bootstrapComplete,
    policy: input.policy,
    creationMode: input.creationMode,
    email: input.data.email,
    requestedRole: input.data.role,
  });
  if (decision.action === "reject") {
    throw new Error(decision.message);
  }
  const created = await input.createUser({
    ...input.data,
    role: decision.role,
    ...(decision.canonicalEmail ? { email: decision.canonicalEmail } : {}),
  });
  if (decision.completeBootstrap) {
    const userId = created.id;
    if (typeof userId !== "string" || userId.length === 0) {
      throw new Error("Bootstrap user create did not return an id");
    }
    await input.complete(userId, new Date());
  }
  return created;
}

type BootstrapUserDelegate = {
  findFirst: (args: {
    where?: { email: string };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
};

type BootstrapStateRead = {
  findUnique: (args: {
    where: { id: string };
    select?: { completedAt: true };
  }) => Promise<{ completedAt: Date | null } | null>;
};

type BootstrapPrismaTx = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  /** Needed only for ban writes, which tombstone MCP grants in the same transaction. */
  $executeRawUnsafe?: (sql: string, ...values: unknown[]) => Promise<unknown>;
  bootstrapState: {
    upsert: (args: {
      where: { id: string };
      create: { id: string };
      update: Record<string, never>;
    }) => Promise<unknown>;
    findUnique: BootstrapStateRead["findUnique"];
    update: (args: {
      where: { id: string };
      data: { completedAt: Date; userId: string | null };
    }) => Promise<unknown>;
  };
  user: BootstrapUserDelegate;
};

type BootstrapPrisma = BootstrapPrismaTx & {
  $transaction: <T>(fn: (tx: BootstrapPrismaTx) => Promise<T>) => Promise<T>;
  knowledgeBase: {
    count(args: { where: { ownerId: string; state: "ACTIVE" } }): Promise<number>;
  };
};

export async function isBootstrapComplete(prisma: {
  bootstrapState: BootstrapStateRead;
  user: BootstrapUserDelegate;
}): Promise<boolean> {
  const row = await prisma.bootstrapState.findUnique({
    where: { id: BOOTSTRAP_STATE_ID },
    select: { completedAt: true },
  });
  if (row?.completedAt != null) return true;
  // A restored or pre-singleton database can have User rows while the
  // singleton is still empty. Treat that as complete so the bootstrap form
  // is not advertised and the next create cannot promote a second admin.
  const existing = await prisma.user.findFirst({ select: { id: true } });
  return existing != null;
}

export async function adoptExistingUsers(
  tx: BootstrapPrismaTx,
  policy: BootstrapPolicy,
): Promise<BootstrapStateSnapshot | null> {
  const existing = await tx.user.findFirst({ select: { id: true } });
  if (!existing) return null;
  let userId: string | null = null;
  if (policy.adminEmail) {
    const configured = await tx.user.findFirst({
      where: { email: policy.adminEmail },
      select: { id: true },
    });
    userId = configured?.id ?? null;
  }
  const completedAt = new Date();
  await tx.bootstrapState.update({
    where: { id: BOOTSTRAP_STATE_ID },
    data: { completedAt, userId },
  });
  return { completedAt };
}

/**
 * Stamp the singleton in its own committed transaction when users already
 * exist. The user-insert transaction may still reject or hit a unique email
 * collision; this write has already committed so completion stays sticky.
 */
export async function persistBootstrapAdoption(prisma: BootstrapPrisma): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const state = await lockBootstrapState(tx);
    if (state.completedAt != null) return;
    await adoptExistingUsers(tx, currentPolicy());
  });
}

export async function lockBootstrapState(tx: BootstrapPrismaTx): Promise<BootstrapStateSnapshot> {
  // ON CONFLICT so concurrent first-user creates do not abort the transaction
  // on a unique-violation (PostgreSQL cannot continue after that error).
  await tx.$executeRaw`INSERT INTO bootstrap_state (id) VALUES (${BOOTSTRAP_STATE_ID}) ON CONFLICT (id) DO NOTHING`;
  // Parameterized FOR UPDATE so concurrent first-user creates serialize on
  // the singleton row. Prisma findUnique does not take a row lock.
  await tx.$queryRaw`SELECT 1 FROM bootstrap_state WHERE id = ${BOOTSTRAP_STATE_ID} FOR UPDATE`;
  const row = await tx.bootstrapState.findUnique({
    where: { id: BOOTSTRAP_STATE_ID },
    select: { completedAt: true },
  });
  return { completedAt: row?.completedAt ?? null };
}

function currentPolicy(): BootstrapPolicy {
  return {
    nodeEnv: env.NODE_ENV,
    adminEmail: ADMIN_EMAIL,
    signupEnabled: SIGNUP_ENABLED,
  };
}

type AdapterCreateArgs = {
  model: string;
  data: Record<string, unknown>;
  select?: string[];
  forceAllowId?: boolean;
};

type AdapterCreate = {
  create: (args: AdapterCreateArgs) => Promise<unknown>;
};

type AdapterDeleteArgs = {
  model: string;
  where: unknown;
};

type AdapterDelete = {
  delete: (args: AdapterDeleteArgs) => Promise<unknown>;
};

type AdapterDeleteManyArgs = {
  model: string;
  where: unknown;
};

type AdapterDeleteMany = {
  deleteMany: (args: AdapterDeleteManyArgs) => Promise<unknown>;
};

type AdapterLike = AdapterCreate &
  AdapterDelete &
  AdapterDeleteMany & {
    update: (args: AdapterUpdateArgs) => Promise<unknown>;
    updateMany: (args: AdapterUpdateArgs) => Promise<unknown>;
    transaction: <R>(callback: (trx: AdapterLike) => Promise<R>) => Promise<R>;
  };

type AdapterUpdateArgs = {
  model: string;
  where: unknown;
  update: Record<string, unknown>;
};

function createPrismaAdapter(client: unknown, options: BetterAuthOptions): AdapterLike {
  return prismaAdapter(client as never, { provider: "postgresql" })(
    options,
  ) as unknown as AdapterLike;
}

async function runUserCreateOnClient(
  args: AdapterCreateArgs,
  tx: BootstrapPrismaTx,
  insertAdapter: AdapterLike,
  adminChecks?: Array<() => void>,
): Promise<{ id?: unknown }> {
  if (getAllowedUserCreationMode() === "admin-invite" && !getAdminMutationActor()) {
    throw new APIError("FORBIDDEN");
  }
  if (getAdminMutationActor()) await lockIdentityAuthority(tx);
  const check = await checkAdminMutation(tx, adminChecks);
  const result = await runBootstrappedUserCreate({
    // Caller-supplied server-owned columns never reach the row (user-columns.ts).
    data: sanitizeUserCreateData(args.data),
    createUser: async (data) => {
      const created = (await insertAdapter.create({ ...args, data })) as { id?: unknown };
      // A user the forced-2FA policy covers at creation starts the grace at
      // createdAt, so a later policy re-activation cannot grant a second one.
      const exec = tx.$executeRawUnsafe?.bind(tx);
      if (exec && typeof created.id === "string") {
        await recordTwoFactorGraceStartAtCreation(
          (sql, params) => exec(sql, ...params),
          created.id,
        );
      }
      return created;
    },
    lockState: () => lockBootstrapState(tx),
    adoptExistingUsers: () => adoptExistingUsers(tx, currentPolicy()),
    complete: async (userId, at) => {
      await tx.bootstrapState.update({
        where: { id: BOOTSTRAP_STATE_ID },
        data: { completedAt: at, userId },
      });
    },
    policy: currentPolicy(),
    creationMode: getAllowedUserCreationMode(),
  });
  check?.();
  return result;
}

async function checkAdminMutation(tx: BootstrapPrismaTx, checks?: Array<() => void>) {
  const actorId = getAdminMutationActor();
  if (!actorId) return undefined;
  const { check } = await readLiveAdminPolicy(tx, actorId, () => new APIError("FORBIDDEN"));
  checks?.push(check);
  return check;
}

/**
 * Wrap Better Auth's Prisma adapter so singleton selection, first-user insert,
 * and admin role assignment share one database transaction. A pre-create hook
 * plus an unlocked insert cannot provide this atomicity.
 *
 * `create` and `transaction` are both wrapped. OAuth JIT runs
 * `adapter.transaction` and then `create` on the transactional adapter
 * (Better Auth ALS). Wrapping only `create` on the outer object leaves that
 * path unenforced. When already inside a transaction, user create uses the
 * same client rather than opening a nested `$transaction`.
 */
function extractUserId(where: unknown): string | undefined {
  if (Array.isArray(where)) {
    for (const entry of where) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as { field?: unknown; value?: unknown };
      if (row.field === "id" && typeof row.value === "string" && row.value.length > 0) {
        return row.value;
      }
    }
    return undefined;
  }
  if (where && typeof where === "object" && !Array.isArray(where)) {
    const id = (where as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/**
 * Better Auth's `internalAdapter.deleteUser` cascade wipes sessions, then
 * ACCOUNTS, then the user — non-transactionally, with the only hook seam
 * (`user.delete.before`) firing after credentials are already gone. The
 * account-by-userId `deleteMany` is the cascade's irreversible step, and in
 * this configuration it has no other caller, so a removal the policy would
 * block stops here instead of destroying login credentials it cannot
 * restore. The HTTP surface is served by `apps/server/src/admin-remove-user.ts`;
 * this guard is defense in depth for programmatic callers.
 */
function extractAccountCascadeUserId(args: AdapterDeleteManyArgs): string | undefined {
  if (args.model !== "account" || !Array.isArray(args.where)) return undefined;
  for (const entry of args.where) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { field?: unknown; value?: unknown };
    if (row.field === "userId" && typeof row.value === "string" && row.value.length > 0) {
      return row.value;
    }
  }
  return undefined;
}

function bindBootstrapPolicy<T extends AdapterLike>(
  inner: T,
  txClient: BootstrapPrismaTx,
  options: BetterAuthOptions,
  root: BootstrapPrisma,
  startTransaction: (<R>(fn: (tx: BootstrapPrismaTx) => Promise<R>) => Promise<R>) | null,
  outgoingState?: { written: boolean; adminChecks: Array<() => void> },
): T {
  // Better Auth's admin role/ban endpoints and 2FA/email-verification flows
  // all write through these methods, including on its transactional adapter.
  // Hold the shared authority lock until that SAME transaction commits.
  const updateUser = (method: "update" | "updateMany", rawArgs: AdapterUpdateArgs) => {
    if (!isUserModel(rawArgs.model)) return inner[method](rawArgs);
    // Server-owned columns are never written through Better Auth (user-columns.ts).
    const args = { ...rawArgs, update: sanitizeUserUpdateData(rawArgs.update) };
    const write = async (tx: BootstrapPrismaTx, writer: AdapterLike) => {
      await lockIdentityAuthority(tx);
      const check = await checkAdminMutation(tx, outgoingState?.adminChecks);
      const exec = tx.$executeRawUnsafe?.bind(tx);
      if (!exec) throw new Error("identity write cannot settle MCP lapse");
      // Bulk adapter updates may use filters other than an exact id. Settle all
      // due holders in that case, before the write can hide a lapse.
      const userId = method === "updateMany" ? null : (extractUserId(args.where) ?? null);
      if (outgoingState) outgoingState.written = true;
      const nextRole = args.update.role;
      const result = await withOutgoingTwoFactorMcpSettlement(
        (sql, params) => exec(sql, ...params),
        userId,
        async () => {
          // Better Auth's admin set-role writes here too. A role write that
          // brings the user under forced 2FA starts their grace now.
          if (userId && typeof nextRole === "string") {
            await recordTwoFactorGraceStartForRoleChange(
              (sql, params) => exec(sql, ...params),
              userId,
              nextRole,
            );
          }
          return writer[method](args);
        },
      );
      // Better Auth's admin ban endpoint writes `banned: true` through here.
      // A PERMANENT ban tombstones the user's MCP grants in the same
      // authority-locked transaction; a later unban never reactivates them.
      // A temporary ban only suspends them: admission refuses while
      // the ban holds and re-admits the same credential once it lifts.
      if (isPermanentBanWrite(args.update)) {
        const userId = extractUserId(args.where);
        if (!userId) throw new Error("ban write cannot revoke MCP grants");
        await revokeUserMcpGrants((sql, params) => exec(sql, ...params), userId, "ban");
      }
      check?.();
      return result;
    };
    return startTransaction
      ? startTransaction((tx) => write(tx, createPrismaAdapter(tx, options)))
      : write(txClient, inner);
  };
  // Sign-out, individual/bulk revocation and admin revocation all reach one
  // of these adapter methods. Serialize deletion with device identity reads
  // through commit, including calls on Better Auth's transactional adapter.
  const deleteSession = (method: "delete" | "deleteMany", args: AdapterDeleteArgs) => {
    const write = async (tx: BootstrapPrismaTx, writer: AdapterLike) => {
      await lockIdentityAuthority(tx);
      const check = await checkAdminMutation(tx, outgoingState?.adminChecks);
      const result = await writer[method](args);
      check?.();
      return result;
    };
    return startTransaction
      ? startTransaction((tx) => write(tx, createPrismaAdapter(tx, options)))
      : write(txClient, inner);
  };
  const adapter = {
    ...inner,
    update: (args: AdapterUpdateArgs) => updateUser("update", args),
    updateMany: (args: AdapterUpdateArgs) => updateUser("updateMany", args),
    create: async (args: AdapterCreateArgs) => {
      if (args.model.toLowerCase() === "session" && args.data.impersonatedBy) {
        throw new APIError("FORBIDDEN");
      }
      if (!isUserModel(args.model)) return inner.create(args);
      if (!startTransaction) {
        return runUserCreateOnClient(args, txClient, inner, outgoingState?.adminChecks);
      }
      await persistBootstrapAdoption(root);
      return startTransaction((tx) =>
        runUserCreateOnClient(args, tx, createPrismaAdapter(tx, options)),
      );
    },
    delete: async (args: AdapterDeleteArgs) => {
      if (args.model === "session" || args.model === "Session")
        return deleteSession("delete", args);
      if (isUserModel(args.model)) {
        const userId = extractUserId(args.where);
        if (userId) {
          const executor = getAccountRemovalExecutor();
          if (executor) {
            await runWithAllowedAccountDeletion("ordinary", () => executor(userId));
            return { id: userId };
          }
          await assertOrdinaryAccountDeletionAllowed(root, userId);
        }
      }
      return inner.delete(args);
    },
    deleteMany: async (args: AdapterDeleteManyArgs) => {
      if (args.model === "session" || args.model === "Session")
        return deleteSession("deleteMany", args);
      const cascadeUserId = extractAccountCascadeUserId(args);
      if (cascadeUserId) {
        await assertOrdinaryAccountDeletionAllowed(root, cascadeUserId);
      }
      return inner.deleteMany(args);
    },
    transaction: async <R>(callback: (trx: AdapterLike) => Promise<R>): Promise<R> => {
      if (!startTransaction) return callback(adapter);
      await persistBootstrapAdoption(root);
      return startTransaction(async (tx) => {
        const txInner = createPrismaAdapter(tx, options);
        const outgoingState = { written: false, adminChecks: [] as Array<() => void> };
        const result = await callback(
          bindBootstrapPolicy(txInner, tx, options, root, null, outgoingState),
        );
        // The shared authority lock is still held by this transaction, not by
        // the bookkeeping flag. Settle after any user callback delay, before
        // its enrollment/role changes and paired tombstones commit together.
        if (outgoingState.written) {
          const exec = tx.$executeRawUnsafe?.bind(tx);
          if (!exec) throw new Error("identity transaction cannot settle MCP lapse");
          await settleOutgoingTwoFactorMcpGrants((sql, params) => exec(sql, ...params));
        }
        for (const check of outgoingState.adminChecks) check();
        return result;
      });
    },
  };
  return adapter as T;
}

export function createBootstrapDatabaseAdapter(prisma: BootstrapPrisma) {
  return (options: BetterAuthOptions) => {
    const inner = createPrismaAdapter(prisma, options);
    return bindBootstrapPolicy(inner, prisma, options, prisma, (fn) => prisma.$transaction(fn));
  };
}
