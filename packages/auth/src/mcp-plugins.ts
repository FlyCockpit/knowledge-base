import { createHash } from "node:crypto";
import { cimd } from "@better-auth/cimd";
import { defineRequestState } from "@better-auth/core/context";
import { mcp } from "@better-auth/mcp";
import { DEFAULT_LOCALE } from "@knowledge-base/config/locales";
import type { PrismaClient } from "@knowledge-base/db/client";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { fetchClientMetadataResource } from "./mcp-cimd";
import { canonicalMcpResource } from "./mcp-config";
import { createMcpConsentService, McpConsentError, verifyOAuthQuery } from "./mcp-consent";
import {
  issueMcpGenerationClaims,
  MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
  MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS,
  MCP_REFRESH_RETRY_WINDOW_SECONDS,
} from "./mcp-refresh";

const scopes = ["mcp:read", "mcp:write", "offline_access"];
const digest = (token: string) => createHash("sha256").update(token).digest("base64url");
const invalidGrant = () => new APIError("BAD_REQUEST", { error: "invalid_grant" });

const NATIVE_HTTP_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * An `http` redirect on an exact loopback host (`localhost`, `127.0.0.1`, `[::1]`),
 * with an optional port and path. Fails closed on anything ambiguous: userinfo
 * (`@`), backslashes, percent-encoding or whitespace in the authority, and any
 * disagreement between this literal reading and WHATWG URL parsing (which is what
 * Better Auth and the browser use). Both must name the same loopback host.
 */
export function isStrictLoopbackHttpRedirect(uri: string): boolean {
  if (/[\\\s]/.test(uri)) return false;
  const literal = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(?:[/?][^#]*)?$/i.exec(
    uri,
  );
  if (!literal) return false;
  const host = literal[1]!.toLowerCase();
  const port = literal[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hostname.toLowerCase() === host &&
    NATIVE_HTTP_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) &&
    // WHATWG drops a default/explicit port identically; any other rewrite is a disagreement.
    (port === undefined || parsed.port === "" || parsed.port === String(Number(port)))
  );
}

function isLoopbackHost(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase();
    return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Dynamic client registration redirect policy in front of Better Auth's
 * validator. RFC 8252 §7.3: a public client (`token_endpoint_auth_method:
 * "none"`) whose redirects are all `http` on an exact loopback host is a native
 * app, so a missing `application_type` means "native" for it. Every other
 * request keeps Better Auth's rules; this only replaces its self-contradictory
 * web-client message with one that says what to change.
 */
export function registrationRedirectPolicy(
  body: unknown,
): { kind: "native" } | { kind: "reject"; description: string } | null {
  if (!body || typeof body !== "object") return null;
  const metadata = body as Record<string, unknown>;
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || !uris.every((uri) => typeof uri === "string")) return null;
  const type = metadata.application_type;
  if (type !== undefined && type !== "web" && type !== "native") return null;
  const loopbackHttp = uris.filter(isStrictLoopbackHttpRedirect);
  if (
    type === undefined &&
    metadata.token_endpoint_auth_method === "none" &&
    uris.length > 0 &&
    loopbackHttp.length === uris.length
  )
    return { kind: "native" };
  if (type === "native") return null;
  const [loopback] = loopbackHttp;
  if (loopback !== undefined)
    return {
      kind: "reject",
      description: `loopback http redirect URIs are for native clients: register with application_type "native" (a public client with token_endpoint_auth_method "none" whose redirect URIs are all loopback http is treated as native): ${loopback}`,
    };
  const httpsLoopback = uris.find((uri) => uri.startsWith("https:") && isLoopbackHost(uri));
  if (httpsLoopback !== undefined)
    return {
      kind: "reject",
      description: `web clients must not use loopback redirect URIs; use https on a public host, or register with application_type "native" and an http loopback redirect URI: ${httpsLoopback}`,
    };
  const insecure = uris.find((uri) => !uri.startsWith("https:"));
  if (insecure !== undefined)
    return {
      kind: "reject",
      description: `web clients require https redirect URIs: ${insecure}`,
    };
  return null;
}

/** One provider, one durable authority boundary. No grant is inferred from artifacts. */
export function resolveMcpPlugins(options: { baseUrl: string; secret: string; db?: PrismaClient }) {
  if (!options.db) throw new Error("MCP provider requires durable storage");
  const db = options.db;
  const resource = canonicalMcpResource(options.baseUrl);
  const consentPage = `/${DEFAULT_LOCALE}/mcp-consent`;
  const consent = createMcpConsentService({ db, secret: options.secret, resource });
  const approval = defineRequestState<{
    referenceId: string;
    userId: string;
    sessionId: string;
    scopes: string[];
  } | null>(() => null);
  const boundary = {
    id: "kb-oauth-authority",
    init(ctx) {
      const adapter = ctx.adapter;
      return {
        context: {
          // Better Auth rebuilds internalAdapter AFTER plugin init. Wrap the
          // underlying insertion boundary so every DB replay reservation gets
          // the verifier's final floor-clock second. Resource admission owns
          // its SQL reservation and applies the same grace there.
          adapter: {
            ...adapter,
            create: async <T extends Record<string, unknown>, R = T>(
              input: Parameters<typeof adapter.create<T, R>>[0],
            ): Promise<R> => {
              const data = input.data;
              const expiresAt: unknown = data.expiresAt;
              if (
                input.model === "verification" &&
                typeof data.identifier === "string" &&
                data.identifier.startsWith("dpop-proof:") &&
                expiresAt instanceof Date
              ) {
                const retainedUntil = new Date(expiresAt.getTime() + 1000);
                const validUntil = (Math.floor(expiresAt.getTime() / 1000) + 1) * 1000;
                const assertFresh = () => {
                  if (Date.now() >= validUntil)
                    throw new APIError("BAD_REQUEST", { error: "invalid_dpop_proof" });
                };
                assertFresh();
                const result = await adapter.create<T, R>({
                  ...input,
                  data: { ...data, expiresAt: retainedUntil },
                });
                // The verifier checked age before awaiting this adapter. Its
                // reservation is unusable if SQL/transport outlasted that age.
                assertFresh();
                return result;
              }
              return adapter.create<T, R>(input);
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/register",
          handler: createAuthMiddleware(async (ctx) => {
            const decision = registrationRedirectPolicy(ctx.body);
            if (decision?.kind === "reject")
              throw new APIError("BAD_REQUEST", {
                error: "invalid_redirect_uri",
                error_description: decision.description,
              });
            if (decision?.kind === "native")
              return { context: { body: { ...ctx.body, application_type: "native" } } };
          }),
        },
        {
          // Library artifact mutations do not change the application's durable
          // generation. Only signed approval and the human grant control may
          // mutate authority; reject these paths before any library effects.
          matcher: (ctx) =>
            ["/oauth2/delete-consent", "/oauth2/update-consent", "/oauth2/revoke"].includes(
              ctx.path ?? "",
            ),
          handler: createAuthMiddleware(async () => {
            throw new APIError("BAD_REQUEST", {
              error: "invalid_request",
              error_description:
                "Use the application's MCP grant controls to revoke access or approve new scopes.",
            });
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/oauth2/consent" || ctx.path === "/oauth2/continue",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.path === "/oauth2/consent" && ctx.body?.accept === false) return;
            const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
            const raw: unknown = ctx.body?.oauth_query;
            if (!session || typeof raw !== "string") throw invalidGrant();
            try {
              const query = verifyOAuthQuery(raw, options.secret, resource);
              const actor = { userId: session.user.id, sessionId: session.session.id };
              const { referenceId } = await consent.prepare(actor, raw);
              const requested =
                typeof ctx.body?.scope === "string" ? ctx.body.scope.split(" ") : query.scopes;
              await issueMcpGenerationClaims(db, {
                ...actor,
                referenceId,
                clientId: query.clientId,
                resource,
                scopes: requested,
                grantType: "authorization_code",
              });
              await approval.set({ ...actor, referenceId, scopes: requested });
            } catch (error) {
              if (error instanceof McpConsentError) throw invalidGrant();
              throw error;
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
  return [
    boundary,
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      resource,
      loginPage: `/${DEFAULT_LOCALE}/mcp-login`,
      consentPage,
      postLogin: {
        page: consentPage,
        shouldRedirect: async () => (await approval.get()) === null,
        consentReferenceId: async ({ user, session, scopes: requested }) => {
          const state = await approval.get();
          if (
            !state ||
            user.id !== state.userId ||
            session.id !== state.sessionId ||
            !requested.every((scope) => state.scopes.includes(scope))
          )
            throw invalidGrant();
          return state.referenceId;
        },
      },
      scopes,
      allowPublicClientPrelogin: true,
      clientRegistrationDefaultScopes: ["mcp:read"],
      clientRegistrationAllowedScopes: ["mcp:write", "offline_access"],
      clientRegistrationRequirePKCE: true,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      grantTypes: ["authorization_code", "refresh_token"],
      accessTokenExpiresIn: MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
      refreshTokenExpiresIn: MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS,
      refreshTokenReuseInterval: MCP_REFRESH_RETRY_WINDOW_SECONDS,
      enforcePerClientResources: true,
      storeTokens: { hash: digest },
      dpop: { proofMaxAgeSeconds: 300 },
      clientPrivileges: () => false,
      resourcePrivileges: () => false,
      extensions: [
        {
          claims: {
            accessToken: async (input) => {
              if (
                !input.user ||
                !input.referenceId ||
                !input.grantType ||
                input.resources?.length !== 1 ||
                input.resources[0] !== resource
              )
                throw invalidGrant();
              const raw: unknown = input.ctx.body?.refresh_token;
              const refresh =
                input.grantType === "refresh_token" && typeof raw === "string"
                  ? await db.oauthRefreshToken.findUnique({ where: { token: digest(raw) } })
                  : null;
              if (
                input.grantType === "refresh_token" &&
                (!refresh ||
                  refresh.referenceId !== input.referenceId ||
                  refresh.userId !== input.user.id ||
                  refresh.clientId !== input.client.clientId ||
                  !refresh.resources.includes(resource))
              )
                throw invalidGrant();
              try {
                return await issueMcpGenerationClaims(db, {
                  userId: input.user.id,
                  clientId: input.client.clientId,
                  referenceId: input.referenceId,
                  resource,
                  scopes: input.scopes,
                  grantType: input.grantType,
                  tokenScopes: refresh?.scopes,
                  tokenExpiresAt: refresh?.expiresAt,
                });
              } catch (error) {
                if (error instanceof McpConsentError) throw invalidGrant();
                throw error;
              }
            },
          },
        },
      ],
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
  ] as const;
}
