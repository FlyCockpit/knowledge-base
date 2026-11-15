import { AsyncLocalStorage } from "node:async_hooks";

export type AccountDeletionMode = "ordinary" | "admin-force";

const accountDeletionModeStorage = new AsyncLocalStorage<AccountDeletionMode>();

export const OWNED_ACTIVE_KB_BLOCK_MESSAGE =
  "This account still owns knowledge bases. Transfer or delete them first, or ask an admin to remove the account.";

export function getAllowedAccountDeletionMode(): AccountDeletionMode | undefined {
  return accountDeletionModeStorage.getStore();
}

export function runWithAllowedAccountDeletion<T>(
  mode: AccountDeletionMode,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return accountDeletionModeStorage.run(mode, fn);
}

export function isAdminForceAccountDeletion(): boolean {
  return getAllowedAccountDeletionMode() === "admin-force";
}

type OwnedKbCounter = {
  knowledgeBase: {
    count(args: { where: { ownerId: string; state: { not: "TOMBSTONED" } } }): Promise<number>;
  };
};

export async function assertOrdinaryAccountDeletionAllowed(
  prisma: OwnedKbCounter,
  userId: string,
): Promise<void> {
  if (isAdminForceAccountDeletion()) return;
  // Any owned KB that is not TOMBSTONED (ACTIVE, quarantined REPAIR_REQUIRED,
  // or a CREATING row nothing has settled) would be left ownerless by the
  // user delete. The owner can delete or transfer it; an admin can force.
  // `removeUserAccount` settles CREATING rows under its locks first and
  // applies its own pre-check (packages/api/src/lib/kb/account-removal.ts).
  const owned = await prisma.knowledgeBase.count({
    where: { ownerId: userId, state: { not: "TOMBSTONED" } },
  });
  if (owned > 0) {
    throw new Error(OWNED_ACTIVE_KB_BLOCK_MESSAGE);
  }
}

export type AccountRemovalExecutor = (userId: string) => Promise<void>;

let accountRemovalExecutor: AccountRemovalExecutor | undefined;

export function registerAccountRemovalExecutor(executor: AccountRemovalExecutor): void {
  accountRemovalExecutor = executor;
}

export function getAccountRemovalExecutor(): AccountRemovalExecutor | undefined {
  return accountRemovalExecutor;
}

export function resetAccountRemovalExecutorForTests(): void {
  accountRemovalExecutor = undefined;
}
