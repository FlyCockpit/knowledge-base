import { AsyncLocalStorage } from "node:async_hooks";

export type AccountDeletionMode = "ordinary" | "admin-force";

const accountDeletionModeStorage = new AsyncLocalStorage<AccountDeletionMode>();

export const OWNED_ACTIVE_KB_BLOCK_MESSAGE =
  "This account still owns active knowledge bases. Transfer or delete them first, or ask an admin to remove the account.";

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
    count(args: { where: { ownerId: string; state: "ACTIVE" } }): Promise<number>;
  };
};

export async function assertOrdinaryAccountDeletionAllowed(
  prisma: OwnedKbCounter,
  userId: string,
): Promise<void> {
  if (isAdminForceAccountDeletion()) return;
  const owned = await prisma.knowledgeBase.count({
    where: { ownerId: userId, state: "ACTIVE" },
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
