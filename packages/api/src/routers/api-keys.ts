import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  apiKeyMintInput,
  childPageInput,
  listApiKeyChildrenForOwner,
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  revokeApiKeyChild,
} from "../lib/api-keys";
import { getKbRuntime } from "../lib/kb/runtime";
import { pageInput } from "../lib/mcp-token-access";
import { mcpControl } from "./mcp-tokens";

/** API key and token ids are 24 lowercase hex characters (also the list cursors). */
const apiKeyId = z.string().regex(/^[0-9a-f]{24}$/);
const tokenId = apiKeyId;
const keyPageInput = pageInput.extend({ cursor: apiKeyId.nullable().optional() }).strict();

/**
 * Human REST API key management (Settings → API keys). Browser session +
 * satisfied 2FA only (protectedProcedure), exactly like PATs: an API key is a
 * bearer credential and never an oRPC session, so a key can never mint, list
 * or revoke keys. A key mints only its own child MCP tokens, over the REST API.
 */
export const apiKeysRouter = {
  create: protectedProcedure
    .input(apiKeyMintInput)
    .handler(({ context, input }) =>
      mcpControl(() => mintApiKey(getKbRuntime(), context.session.user.id, input)),
    ),
  listMine: protectedProcedure
    .input(keyPageInput)
    .handler(({ context, input }) =>
      mcpControl(() => listApiKeys(getKbRuntime(), context.session.user.id, input)),
    ),
  revokeMine: protectedProcedure
    .input(z.strictObject({ id: apiKeyId }))
    .handler(({ context, input }) =>
      mcpControl(() => revokeApiKey(getKbRuntime(), context.session.user.id, input.id)),
    ),
  listChildrenMine: protectedProcedure
    .input(childPageInput.extend({ apiKeyId }).strict())
    .handler(({ context, input }) => {
      const { apiKeyId: id, ...page } = input;
      return mcpControl(() =>
        listApiKeyChildrenForOwner(getKbRuntime(), context.session.user.id, id, page),
      );
    }),
  revokeChildMine: protectedProcedure
    .input(z.strictObject({ apiKeyId, tokenId }))
    .handler(({ context, input }) =>
      mcpControl(() =>
        revokeApiKeyChild(
          getKbRuntime(),
          { userId: context.session.user.id, apiKeyId: input.apiKeyId },
          input.tokenId,
        ),
      ),
    ),
};
