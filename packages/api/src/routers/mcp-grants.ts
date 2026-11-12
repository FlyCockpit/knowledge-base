import { z } from "zod";
import { protectedProcedure } from "../index";
import { getKbRuntime } from "../lib/kb/runtime";
import {
  countActiveCredentials,
  endGrantElevation,
  grantAclPageInput,
  grantPageInput,
  grantUpdateInput,
  listGrantAcl,
  listGrants,
  revokeAllCredentials,
  revokeGrant,
  updateGrant,
} from "../lib/mcp-token-access";
import { createProcedureBudget } from "../lib/procedure-budget";
import { mcpControl } from "./mcp-tokens";

/** Each edit takes the global authority lock and writes audit rows. */
const updateBudget = createProcedureBudget({
  keyPrefix: "rl:mcp-grant-update",
  points: 30,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Connection edit rate limit",
  unavailableMessage: "Connection edit unavailable",
  unavailableLog: "[mcp] Grant update budget unavailable",
});

/** End now takes the global authority lock and writes an audit row. */
const endElevationBudget = createProcedureBudget({
  keyPrefix: "rl:mcp-grant-elevation-end",
  points: 30,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Temporary access rate limit",
  unavailableMessage: "Temporary access unavailable",
  unavailableLog: "[mcp] Elevation end budget unavailable",
});

/** "Revoke all" walks every live grant under the authority lock, in batches. */
const revokeAllBudget = createProcedureBudget({
  keyPrefix: "rl:mcp-grant-revoke-all",
  points: 5,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Revoke all rate limit",
  unavailableMessage: "Revoke all unavailable",
  unavailableLog: "[mcp] Revoke-all budget unavailable",
});

/** Counting takes the authority lock; bounded per user like the edits. */
const countActiveBudget = createProcedureBudget({
  keyPrefix: "rl:mcp-grant-count-active",
  points: 60,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Credential count rate limit",
  unavailableMessage: "Credential count unavailable",
  unavailableLog: "[mcp] Active-credential count budget unavailable",
});

/**
 * Human view of the user's own MCP grant generations (PAT and, later, OAuth)
 * with their stored KB ceilings, in-place widening/narrowing, temporary access
 * (an `updateMine` with a `duration`, ended early by `endElevationMine`), and
 * permanent revocation. Browser session + 2FA only; tokens cannot enumerate, edit or
 * revoke grants through oRPC, and a token can never change its own access.
 */
export const mcpGrantsRouter = {
  listMine: protectedProcedure
    .input(grantPageInput)
    .handler(({ context, input }) =>
      mcpControl(() => listGrants(getKbRuntime(), context.session.user.id, input)),
    ),
  listAclMine: protectedProcedure
    .input(grantAclPageInput)
    .handler(({ context, input }) =>
      mcpControl(() => listGrantAcl(getKbRuntime(), context.session.user.id, input)),
    ),
  updateMine: protectedProcedure.input(grantUpdateInput).handler(async ({ context, input }) => {
    await updateBudget(context.session.user.id);
    return mcpControl(() => updateGrant(getKbRuntime(), context.session.user.id, input));
  }),
  endElevationMine: protectedProcedure
    .input(z.strictObject({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      await endElevationBudget(context.session.user.id);
      return mcpControl(() => endGrantElevation(getKbRuntime(), context.session.user.id, input.id));
    }),
  /** Live PATs and connected apps right now, independent of history paging. */
  countActiveMine: protectedProcedure.handler(async ({ context }) => {
    await countActiveBudget(context.session.user.id);
    return mcpControl(() => countActiveCredentials(getKbRuntime(), context.session.user.id));
  }),
  /** Revoke every live PAT and connected app; returns after the last batch. */
  revokeAllMine: protectedProcedure.handler(async ({ context }) => {
    await revokeAllBudget(context.session.user.id);
    return mcpControl(() => revokeAllCredentials(getKbRuntime(), context.session.user.id));
  }),
  revokeMine: protectedProcedure
    .input(z.strictObject({ id: z.uuid() }))
    .handler(({ context, input }) =>
      mcpControl(() => revokeGrant(getKbRuntime(), context.session.user.id, input.id)),
    ),
};
