import { createHash } from "node:crypto";
import type { CredentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import { getOperationLease, type LockQuery } from "@knowledge-base/api/lib/kb/lock";
import {
  type CredentialVerifier,
  KbAdmissionError,
  type TokenPrincipal,
} from "@knowledge-base/api/lib/kb/principal";
import {
  authenticatePersonalToken,
  createGrantCredentialVerifier,
} from "@knowledge-base/api/lib/mcp-token-access";
import {
  revokeLapsedTwoFactorMcpGrants,
  settleLapsedTwoFactorMcpGrants,
} from "@knowledge-base/auth/ban";
import { canonicalMcpResource, parseMcpScopes } from "@knowledge-base/auth/mcp-config";
import type { PrismaClient } from "@knowledge-base/db/client";
import { logInternalError } from "@knowledge-base/env/log";
import {
  enforceDpopBinding,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import { z } from "zod";
import type { createAdmissionGate } from "./admission";
import { type BearerAdmitter, bindBearerAdmission } from "./context";
import { AuthServiceUnavailableError } from "./errors";

const unauthorized = () => new KbAdmissionError("UNAUTHORIZED", "Credential is not admissible");
class OAuthInfrastructureError extends Error {}
const jwksSchema = z.object({ keys: z.array(z.object({ kty: z.string() }).passthrough()) });

/**
 * Durable DPoP proof reservation shared with the provider: the same
 * deterministic Verification primary key (`sha256("reserve:dpop-proof:" + key)`)
 * owns single use across admitters and restarts, and both boundaries retain
 * the final floor-clock second (+1s). Freshness is checked after authority
 * acquisition and again after the committed insert's reply, so cleanup cannot
 * reopen a proof that expired while its verifier was waiting on storage. A
 * marker whose own retention has lapsed may be renewed before the janitor runs
 * (the post-reply freshness check still governs admission). Storage failures
 * are a redacted 503; a replay stays 401.
 */
function durableDpopReplayStore(sql: CredentialQuery, signal: AbortSignal) {
  return {
    async reserve({ key, expiresAt }: { key: string; expiresAt: Date }) {
      const identifier = `dpop-proof:${key}`;
      const id = createHash("sha256").update(`reserve:${identifier}`).digest("base64url");
      // Match the verifier's floor clock even when iat has fractional seconds.
      const validUntil = (Math.floor(expiresAt.getTime() / 1000) + 1) * 1000;
      let result: { rows: unknown[] };
      try {
        result = await sql(signal, (query) => {
          if (Date.now() >= validUntil) return Promise.resolve({ rows: [], rowCount: 0 });
          return query(
            `INSERT INTO "verification" (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, now(), now())
             ON CONFLICT (id) DO UPDATE
               SET "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = EXCLUDED."updatedAt"
               WHERE "verification"."expiresAt" <= $5
             RETURNING id`,
            [id, identifier, key, new Date(expiresAt.getTime() + 1000), new Date()],
          );
        });
      } catch {
        throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Credential service unavailable");
      }
      return result.rows.length === 1 && Date.now() < validUntil;
    },
  };
}

/**
 * Reads the public signing keys from the Better Auth instance that minted the
 * token. Same process, same key store: no network hop to the public origin, so
 * split-horizon DNS, missing hairpin NAT or a private CA cannot break OAuth.
 */
export type JwksLoader = () => Promise<unknown>;

let authModule: Promise<typeof import("@knowledge-base/auth")> | undefined;
const inProcessJwks: JwksLoader = async () => {
  // Lazy and shared: keep this transport module free of import-time auth or
  // database IO; a failed first import is retried by the next verification.
  authModule ??= import("@knowledge-base/auth").catch((error: unknown) => {
    authModule = undefined;
    throw error;
  });
  return (await authModule).auth.api.getJwks();
};

function describeCause(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
  return `${error.name}${code}: ${error.message}`.slice(0, 300);
}

/** Better Auth owns signatures/claims and sender binding; this port owns key loading and replay I/O. */
export function oauthVerifier(
  origin: string,
  sql: CredentialQuery,
  loadJwks: JwksLoader = inProcessJwks,
) {
  const jwksCacheKey = {};
  // `origin` is fixed for the verifier's lifetime.
  const issuer = new URL("/api/auth", origin).href;
  const audience = canonicalMcpResource(origin);
  return async (request: Request): Promise<Record<string, unknown>> => {
    request.signal.throwIfAborted();
    const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
    if (!authorization?.token || authorization.scheme === "Unknown") throw unauthorized();
    // The key read this request started, if any (a request that joins another
    // request's in-flight read leaves ownership with that request).
    let read: Promise<unknown> | undefined;
    const payload = await verifyJwsAccessToken(authorization.token, {
      verifyOptions: { issuer, audience },
      jwksCacheKey,
      jwksFetch: async () => {
        try {
          read = loadJwks();
          return jwksSchema.parse(await read);
        } catch (cause) {
          throw new OAuthInfrastructureError(describeCause(cause));
        }
      },
    }).catch(async (error: unknown) => {
      // JOSE separates key-service configuration failures from invalid JWTs.
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      // Better Auth races its key fetch against a 5-second timeout, but the
      // in-process read cannot be cancelled. Never let it outlive its owner:
      // this verification (and the admission permit that owns it) settles only
      // once the read has. The permit's abort/deadline answers the caller
      // promptly in the meantime (see `owned` below).
      if (code === "ERR_JWKS_TIMEOUT" && read) await read.catch(() => undefined);
      if (
        error instanceof OAuthInfrastructureError ||
        ["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JWKS_MULTIPLE_MATCHING_KEYS"].includes(
          String(code),
        )
      ) {
        // A disconnect is not an outage; anything else is operator-actionable.
        if (!request.signal.aborted)
          logInternalError("mcp.oauth", error, {
            code: typeof code === "string" ? code : undefined,
          });
        throw new AuthServiceUnavailableError();
      }
      throw unauthorized();
    });
    request.signal.throwIfAborted();
    await enforceDpopBinding({
      payload,
      authorization,
      proofJwt: request.headers.get("dpop"),
      method: request.method,
      url: request.url,
      proofMaxAgeSeconds: 300,
      replayStore: durableDpopReplayStore(sql, request.signal),
    }).catch((error: unknown) => {
      if (error instanceof KbAdmissionError) throw error;
      throw unauthorized();
    });
    request.signal.throwIfAborted();
    return payload;
  };
}

/**
 * No cookie or synthetic session branch. Each recheck uses live SQL, never a
 * cached ACL. MCP is always on. A banned user is refused (a temporary
 * ban suspends); an unenrolled user past the forced-2FA grace is refused
 * AND their grants are settled under the authority lock with live policy.
 */
export function createBearerAdmission(options: {
  /** Injected query is for in-memory tests; production supplies the owned SQL port. */
  query?: LockQuery;
  withQuery?: CredentialQuery;
  gate?: ReturnType<typeof createAdmissionGate>;
  origin: string;
  isClosing?: () => boolean;
  verifyOAuth?: (request: Request) => Promise<Record<string, unknown>>;
  /** OAuth signing keys; defaults to the in-process Better Auth key store. */
  loadJwks?: JwksLoader;
  now?: () => Date;
  /**
   * Connection injection for the `query`-only path; settlement still owns the
   * real authority transaction. Unused with `withQuery`, which settles on its
   * own authority-locked transaction.
   */
  identityDb?: Pick<PrismaClient, "$transaction">;
}): BearerAdmitter {
  if (!options.withQuery && !options.query) throw new Error("Missing credential query port");
  const sql: CredentialQuery = options.withQuery ?? (async (_signal, run) => run(options.query!));
  const owned = <T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const permit = options.gate?.admit(signal);
    if (options.gate && !permit)
      return Promise.reject(new KbAdmissionError("STORAGE_UNAVAILABLE", "Admission closed"));
    if (!permit) return run(signal);
    // The caller's deadline and the I/O owner's lifetime are distinct. Even
    // when cancellation cannot reach SQL, a 503 settles promptly while this
    // permit remains held until the transport and its cleanup actually settle.
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(new KbAdmissionError("STORAGE_UNAVAILABLE", "Admission closed"));
      permit.signal.addEventListener("abort", cancel, { once: true });
      if (permit.signal.aborted) cancel();
      const finish = () => {
        permit.signal.removeEventListener("abort", cancel);
        permit.release();
      };
      Promise.resolve()
        .then(() => run(permit.signal))
        .then(
          (value) => {
            finish();
            resolve(value);
          },
          (error: unknown) => {
            finish();
            reject(error);
          },
        );
    });
  };
  const withQuery: CredentialQuery = (signal, run) => owned(signal, (active) => sql(active, run));
  const resource = canonicalMcpResource(options.origin);
  // The outer OAuth permit owns signature/JWKS/reservation work. Supply its
  // SQL port directly to avoid reacquiring an admission permit during close.
  const verifyOAuth = options.verifyOAuth ?? oauthVerifier(options.origin, sql, options.loadJwks);
  const now = options.now ?? (() => new Date());
  return async (request, mode = {}) => {
    const assertOpen = () => {
      if (options.gate?.closed || options.isClosing?.() || request.signal.aborted)
        throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Admission closed");
    };
    assertOpen();
    const header = request.headers.get("authorization") ?? "";
    const match = header.length <= 8192 && /^(Bearer|DPoP) ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
    if (!match) throw unauthorized();
    const raw = match[2]!;
    let principal: TokenPrincipal | null;
    if (raw.startsWith("kbp_")) {
      if (match[1]!.toLowerCase() !== "bearer") throw unauthorized();
      principal = await withQuery(request.signal, (query) =>
        authenticatePersonalToken(query, raw, now()),
      );
    } else {
      if (mode.selfRevoke) throw unauthorized();
      let claims: Record<string, unknown>;
      const headers = new Headers({ authorization: header });
      const proof = request.headers.get("dpop");
      if (proof !== null) {
        if (proof.length > 8192) throw unauthorized();
        headers.set("dpop", proof);
      }
      // Canonical resource URL: trust only the configured authority, retain the
      // actual operation path; never trust forwarded authority or carry cookies.
      const incoming = new URL(request.url);
      const canonical = new URL(resource);
      canonical.pathname = incoming.pathname;
      canonical.search = incoming.search;
      try {
        claims = await owned(request.signal, (signal) =>
          verifyOAuth(new Request(canonical, { method: request.method, headers, signal })),
        );
      } catch (error) {
        assertOpen();
        if (error instanceof KbAdmissionError) throw error;
        throw unauthorized();
      }
      assertOpen();
      if (
        typeof claims.sub !== "string" ||
        !claims.sub ||
        typeof claims.client_id !== "string" ||
        !claims.client_id ||
        typeof claims.mcp_grant_id !== "string" ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        claims.aud !== resource
      )
        throw unauthorized();
      const scope = claims.scope;
      if (
        typeof scope !== "string" &&
        !(Array.isArray(scope) && scope.every((s) => typeof s === "string"))
      )
        throw unauthorized();
      principal = {
        kind: "token",
        userId: claims.sub,
        grantId: claims.mcp_grant_id,
        grantGeneration: claims.mcp_grant_id,
        scopes: parseMcpScopes(scope),
        expiresAt: new Date(claims.exp * 1000),
        storedAcl: new Map(),
        credential: { kind: "OAUTH", clientId: claims.client_id, resource },
      };
    }
    assertOpen();
    if (!principal?.credential || principal.credential.resource !== resource) throw unauthorized();
    const settleLapsed = async (userId: string) => {
      // Keep this transport module free of import-time database IO. Injected
      // callers supply a client; standalone callers resolve the default only
      // if an overdue lapse actually needs settling.
      const db = options.identityDb ?? (await import("@knowledge-base/db")).default;
      await settleLapsedTwoFactorMcpGrants(db, userId);
    };
    const bindQuery = (query: LockQuery) =>
      createGrantCredentialVerifier(query, now, { resource, assertOpen });
    const inherited = () => {
      const lease = getOperationLease();
      // Consumers such as exports can supply a SQL store without input.query.
      // An inherited lease still owns those reads: never reacquire authority
      // on another connection while holding authority or a KB lock here.
      return lease ? bindQuery(lease.query) : undefined;
    };
    const verifier: CredentialVerifier = {
      inspect: (value: TokenPrincipal) => {
        const held = inherited();
        return held
          ? held.inspect(value)
          : withQuery(request.signal, (query) =>
              createGrantCredentialVerifier(query, now, {
                resource,
                assertOpen,
                // This owned port holds authority for the complete live policy
                // read and both tombstones, on this same transaction. Without
                // it (injected test query), settlement owns its own authority
                // transaction and re-reads live policy there.
                revokeLapsedTwoFactor: options.withQuery
                  ? (userId) => revokeLapsedTwoFactorMcpGrants(query, userId)
                  : settleLapsed,
              }).inspect(value),
            );
      },
      grantBits: (value: TokenPrincipal, kbId: string) => {
        const held = inherited();
        return held
          ? held.grantBits!(value, kbId)
          : withQuery(request.signal, (query) => bindQuery(query).grantBits!(value, kbId));
      },
      // Ordinary asset reads also pass a Prisma query adapter. Only a live
      // operation context may rebind transport ownership to a supplied query.
      forQuery: (query) => (getOperationLease() ? bindQuery(query) : verifier),
    };
    const admitted = bindBearerAdmission(principal, verifier, assertOpen);
    await admitted.recheck();
    return admitted;
  };
}
