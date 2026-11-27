import { randomUUID } from "node:crypto";
import prisma, { type Prisma } from "@knowledge-base/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { adminOr404Procedure, liveAdminOr404Procedure } from "../index";
import {
  cursorPage,
  cursorPageInput,
  decodeCursor,
  forEachPage,
  keysetWhere,
  pageTake,
} from "../lib/pagination";

const CLIENT_SELECT = {
  id: true,
  clientId: true,
  name: true,
  redirectUris: true,
  createdAt: true,
  updatedAt: true,
  disabled: true,
  userId: true,
  _count: { select: { oauthAccessTokens: true, oauthRefreshTokens: true, oauthConsents: true } },
} satisfies Prisma.OauthClientSelect;

// PostgreSQL timestamps cannot reach JavaScript's minimum date; reserve it for nulls.
const NULL_DATE = new Date(-8640000000000000);

export const oauthClientsRouter = {
  list: adminOr404Procedure.input(cursorPageInput.optional()).handler(async ({ input }) => {
    const limit = input?.limit ?? 20;
    const cursor = input?.cursor ? decodeCursor(input.cursor) : null;
    const where: Prisma.OauthClientWhereInput = !cursor
      ? {}
      : cursor.sortValue.getTime() === NULL_DATE.getTime()
        ? { createdAt: null, id: { lt: cursor.id } }
        : {
            OR: [
              { createdAt: { lt: cursor.sortValue } },
              { createdAt: cursor.sortValue, id: { lt: cursor.id } },
              { createdAt: null },
            ],
          };
    const rows = await prisma.oauthClient.findMany({
      where,
      orderBy: [{ createdAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      take: pageTake(limit),
      select: CLIENT_SELECT,
    });
    const page = cursorPage(
      rows.map((row) => ({ ...row, sortDate: row.createdAt ?? NULL_DATE })),
      limit,
      "sortDate",
    );
    const groups = page.items.length
      ? await prisma.mcpGrant.groupBy({
          by: ["clientId"],
          where: { clientId: { in: page.items.map((row) => row.clientId) }, revokedAt: null },
          _count: { _all: true },
        })
      : [];
    const counts = new Map(groups.map((group) => [group.clientId, group._count._all]));
    return {
      items: page.items.map(({ sortDate: _, ...row }) => ({
        ...row,
        dynamic: row.userId === null,
        activeGrantCount: counts.get(row.clientId) ?? 0,
      })),
      nextCursor: page.nextCursor,
    };
  }),
  delete: liveAdminOr404Procedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .handler(async ({ input, context }) => {
      const tx = context.authorityTx;
      const existing = await tx.oauthClient.findUnique({
        where: { id: input.id },
        select: { clientId: true },
      });
      if (!existing) throw new ORPCError("NOT_FOUND");
      const where = { clientId: existing.clientId };
      await forEachPage(
        (page) =>
          tx.mcpGrant.findMany({
            where: { ...where, revokedAt: null, ...keysetWhere(page.afterId) },
            select: { id: true, userId: true },
            orderBy: { id: "asc" },
            take: page.take,
          }),
        100,
        async (grants) => {
          await tx.mcpGrant.updateMany({
            where: { ...where, revokedAt: null, id: { in: grants.map((grant) => grant.id) } },
            data: { revokedAt: new Date(), revokeReason: "admin_client_deleted" },
          });
          for (const grant of grants) {
            await tx.auditEvent.create({
              data: {
                opId: randomUUID(),
                action: "grant_revoke",
                outcome: "SUCCESS",
                actorKey: `user:${context.session.user.id}`,
                actorUserIdSnapshot: context.session.user.id,
                actorUserId: context.session.user.id,
                grantIdSnapshot: grant.id,
                metadata: { reasonCode: "admin_client_deleted" },
              },
            });
          }
        },
      );
      await tx.oauthAccessToken.deleteMany({ where });
      await tx.oauthRefreshToken.deleteMany({ where });
      await tx.oauthConsent.deleteMany({ where });
      await tx.oauthClientResource.deleteMany({ where });
      await tx.oauthClient.delete({ where: { id: input.id } });
      return { deleted: true as const, clientId: existing.clientId };
    }),
};
