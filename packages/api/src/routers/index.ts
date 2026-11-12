import { isAdminBootstrapSignupEnabled, isBootstrapComplete } from "@knowledge-base/auth/bootstrap";
import prisma from "@knowledge-base/db";
import {
  ADMIN_EMAIL,
  env,
  FORCE_SSO,
  SIGNUP_ENABLED,
  SSO_ENABLED,
} from "@knowledge-base/env/server";
import { isEmailConfigured } from "@knowledge-base/mailer";
import type { RouterClient } from "@orpc/server";
import { publicProcedure } from "../index";
import { authRouter } from "./auth";
import { cliCredentialsRouter } from "./cli-credentials";
import { documentsRouter } from "./documents";
import { embeddingProvidersRouter } from "./embedding-providers";
import { kbAssetsRouter } from "./kb-assets";
import { kbExportsRouter } from "./kb-exports";
import { kbIndexRouter } from "./kb-index";
import { kbMirrorRouter } from "./kb-mirror";
import { kbModelRouter } from "./kb-model";
import { kbSealedRouter } from "./kb-sealed";
import { kbUploadsRouter } from "./kb-uploads";
import { kbsRouter } from "./kbs";
import { mcpConsentRouter } from "./mcp-consent";
import { mcpGrantsRouter } from "./mcp-grants";
import { mcpTokensRouter } from "./mcp-tokens";
import { pullRequestsRouter } from "./pull-requests";
import { pushRouter } from "./push";
import { queueRouter } from "./queue";
import { searchRouter } from "./search";
import { settingsRouter } from "./settings";
import { usersRouter } from "./users";

export const appRouter = {
  cliCredentials: cliCredentialsRouter,
  kbIndex: kbIndexRouter,
  kbSealed: kbSealedRouter,
  kbMirror: kbMirrorRouter,
  kbModel: kbModelRouter,
  health: {
    // No RPC readiness probe: a DB-touching `ready` procedure would be an
    // anonymous datastore-drain vector bounded only by the generic /rpc
    // limiter. Readiness is the HTTP /ready route, which has its own
    // readyLimiter bucket (apps/server/src/rate-limit.ts).
    check: publicProcedure.handler(() => {
      return "OK";
    }),
  },
  appConfig: publicProcedure.handler(async () => {
    const bootstrapComplete = await isBootstrapComplete(prisma);
    return {
      ssoEnabled: SSO_ENABLED,
      forceSso: FORCE_SSO,
      ssoProviderName: env.SSO_PROVIDER_NAME,
      signupEnabled: SIGNUP_ENABLED,
      adminBootstrapSignupEnabled: isAdminBootstrapSignupEnabled({
        signupEnabled: SIGNUP_ENABLED,
        bootstrapComplete,
        nodeEnv: env.NODE_ENV,
        adminEmail: ADMIN_EMAIL,
      }),
      // Gates the login challenge's "email me a code" affordance. The delivery
      // unreliability of Better-Auth's send-otp endpoint (it swallows SMTP
      // failures) is handled separately by the `auth.verifyEmailTransport`
      // preflight; this flag only reflects whether email is configured at all.
      emailEnabled: isEmailConfigured(),
    };
  }),
  auth: authRouter,
  settings: settingsRouter,
  push: pushRouter,
  queue: queueRouter,
  users: usersRouter,
  kbs: kbsRouter,
  documents: documentsRouter,
  pullRequests: pullRequestsRouter,
  kbUploads: kbUploadsRouter,
  kbAssets: kbAssetsRouter,
  kbExports: kbExportsRouter,
  embeddingProviders: embeddingProvidersRouter,
  search: searchRouter,
  mcpTokens: mcpTokensRouter,
  mcpGrants: mcpGrantsRouter,
  mcpConsent: mcpConsentRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
