/** Shared by the KB reservation coordinator and identity/policy writers. */
export const AUTHORITY_LOCK_CLASSID = 0x4b424155; // KBAU
export const AUTHORITY_LOCK_OBJID = 1;

/** Acquire before changing authority, on the transaction that commits the change. */
export async function lockIdentityAuthority(tx: {
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUTHORITY_LOCK_CLASSID}::int, ${AUTHORITY_LOCK_OBJID}::int)`;
}
