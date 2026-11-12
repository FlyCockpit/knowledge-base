import { isAdminRole } from "@knowledge-base/auth/roles";
import { ORPCError } from "@orpc/server";

/**
 * Which column carries the owner id, and whose id it must equal.
 *
 * `field` names a real column on the model being queried. `id` must come from
 * the verified session — never from input.
 */
export type OwnerScope = {
  field: string;
  id: string;
};

/**
 * Run an owner-scoped lookup and collapse a miss into NOT_FOUND.
 *
 * The owner clause is a REQUIRED argument that this helper merges into the
 * query itself, so there is no way to call it without one. That is the whole
 * point: a version that only null-checked a row the caller had already fetched
 * read as "ownership checked" at the call site while the actual check lived in
 * a `where` the caller could simply forget — an IDOR that looks correct in
 * review.
 *
 * The merge is `AND`-composed rather than spread into the caller's `where`, so
 * neither a caller key of the same name nor a caller `OR` can widen it away.
 *
 * NOT_FOUND rather than FORBIDDEN is deliberate: a row that exists but belongs
 * to someone else must be indistinguishable from a row that does not exist, or
 * the error code itself becomes an existence oracle.
 *
 * ```ts
 * const row = await findOwnedOrThrow({
 *   find: (args) => prisma.pushSubscription.findFirst(args),
 *   args: { where: { id: input.id }, select: { id: true } },
 *   owner: { field: "userId", id: context.session.user.id },
 *   notFound: "Subscription not found",
 * });
 * ```
 */
export async function findOwnedOrThrow<TArgs extends { where: object }, TRow>(options: {
  /** Thin wrapper over the Prisma delegate: `(args) => prisma.model.findFirst(args)`. */
  find: (args: TArgs) => PromiseLike<TRow | null>;
  /** The rest of the query — `where` (without the owner clause), `select`, `orderBy`. */
  args: TArgs;
  owner: OwnerScope;
  /** Message for the 404. Say what was not found, never why. */
  notFound: string;
}): Promise<TRow> {
  const ownerWhere = { [options.owner.field]: options.owner.id };
  // Prisma's arg types are per-model, so the merged object is re-asserted as
  // the caller's own inferred `TArgs`. The added keys are structural (`where`
  // only), and the cast is here rather than at the call sites so a caller
  // never has to reach for one.
  const scoped = {
    ...options.args,
    where: { AND: [options.args.where, ownerWhere] },
  } as unknown as TArgs;

  const row = await options.find(scoped);
  if (row == null) {
    throw new ORPCError("NOT_FOUND", { message: options.notFound });
  }
  return row;
}

/**
 * Owner *or* admin. Use only when an admin is supposed to see another
 * user's row. Surfaces that must stay owner-scoped even for admins (standing
 * credentials, anything personal) should use {@link findOwnedOrThrow} instead,
 * which puts the owner clause in the query.
 */
export function assertOwnerOrAdmin(
  ownerId: string | null | undefined,
  user: { id: string; role?: string | null },
  message = "Not found",
): void {
  if (ownerId === user.id) return;
  if (isAdminRole(user.role)) return;
  throw new ORPCError("NOT_FOUND", { message });
}
