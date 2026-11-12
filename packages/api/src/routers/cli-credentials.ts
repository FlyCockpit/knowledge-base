import { randomUUID } from "node:crypto";
import {
  createDeviceApprovalService,
  DeviceApprovalError,
  deviceExchangeInput,
  deviceIntentInput,
  deviceRecipientInput,
} from "@knowledge-base/auth/device-approval";
import { canonicalMcpResource, McpPatExpiryError } from "@knowledge-base/auth/mcp-config";
import { McpConsentError } from "@knowledge-base/auth/mcp-consent";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure, publicProcedure } from "../index";
import { prismaAssetQuery } from "../lib/kb/asset-authz";
import { KbDomainError } from "../lib/kb/errors";
import { getKbRuntime } from "../lib/kb/runtime";
import { mintPersonalTokenInTransaction } from "../lib/mcp-token-access";
import { createProcedureBudget } from "../lib/procedure-budget";

const budget = createProcedureBudget({
  keyPrefix: "rl:device-exchange",
  points: 60,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Device exchange rate limit",
  unavailableMessage: "Device exchange unavailable",
  unavailableLog: "[device] Exchange budget unavailable",
});
const recipientBudget = createProcedureBudget({
  keyPrefix: "rl:device-recipient",
  points: 30,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Device recipient registration rate limit",
  unavailableMessage: "Device recipient registration unavailable",
  unavailableLog: "[device] Recipient registration budget unavailable",
});
function service() {
  const runtime = getKbRuntime();
  return createDeviceApprovalService({
    db: runtime.prisma,
    resource: canonicalMcpResource(runtime.canonicalOrigin),
  });
}
async function control<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DeviceApprovalError)
      throw new ORPCError("BAD_REQUEST", {
        message: "Device authorization unavailable",
        data: { error: error.code },
      });
    throw new ORPCError(
      error instanceof z.ZodError ||
        error instanceof McpConsentError ||
        error instanceof McpPatExpiryError ||
        error instanceof KbDomainError
        ? "BAD_REQUEST"
        : "INTERNAL_SERVER_ERROR",
      { message: "Device authorization unavailable" },
    );
  }
}
/** Human selection is cookie/2FA only. Public polling knows only code and name. */
export const cliCredentialsRouter = {
  registerDeviceRecipient: publicProcedure
    .route({ method: "POST" })
    .input(deviceRecipientInput)
    .handler(async ({ context, input }) => {
      await recipientBudget(context.clientIp ?? "unknown");
      return control(() => service().registerRecipient(input));
    }),
  selectDeviceIntent: protectedProcedure
    .input(deviceIntentInput)
    .handler(({ context, input }) =>
      control(() =>
        service().select(
          { userId: context.session.user.id, sessionId: context.session.session.id },
          input,
        ),
      ),
    ),
  exchangeDeviceCode: publicProcedure
    .route({ method: "POST" })
    .input(deviceExchangeInput)
    .handler(async ({ context, input }) => {
      await budget(context.clientIp ?? "unknown");
      return control(() =>
        service().exchange(input, async (tx, userId, selection, name, expiresAt) => {
          const { recipients: _recipients, ...ceiling } = selection;
          const minted = await mintPersonalTokenInTransaction(
            prismaAssetQuery(tx),
            randomUUID(),
            getKbRuntime().canonicalOrigin,
            userId,
            {
              ...ceiling,
              scopes: z.array(z.enum(["mcp:read", "mcp:write"])).parse(ceiling.scopes),
              name,
              expiresAt,
            },
          );
          return {
            credentialId: minted.token.id,
            grantId: minted.grantId,
            secret: minted.secret,
            // The device flow always mints a dated PAT (resolvePatExpiry).
            expiresAt,
          };
        }),
      );
    }),
};
