import type { Prisma } from "@knowledge-base/db";
import { revokeCredentialsInTransaction } from "./credential-revocation.js";
import { CREDENTIAL_PROVIDER_ID, inviteStateSelect, isInvitePending } from "./reset-link-rules.js";

export type PendingInviteActivationTx = Pick<
  Prisma.TransactionClient,
  "user" | "account" | "$executeRawUnsafe" | "deviceCode" | "session"
>;

/** Under password-write -> setup -> identity authority, BEFORE inserting the IdP account. */
export async function clearPendingInvitePassword(tx: PendingInviteActivationTx, userId: string) {
  const state = await tx.user.findUnique({
    where: { id: userId },
    select: inviteStateSelect(new Date()),
  });
  if (!state || !isInvitePending(state)) return false;
  await tx.account.updateMany({
    where: { userId, providerId: CREDENTIAL_PROVIDER_ID },
    data: { password: null },
  });
  await revokeCredentialsInTransaction(tx, userId);
  return true;
}
