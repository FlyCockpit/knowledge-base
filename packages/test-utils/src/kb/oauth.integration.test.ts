import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { createAssetStorageLifecycle } from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import {
  AUTHORITY_LOCK_CLASSID,
  AUTHORITY_LOCK_OBJID,
  type LockQuery,
} from "@knowledge-base/api/lib/kb/lock";
import {
  createGrantCredentialVerifier,
  revokeGrant,
} from "@knowledge-base/api/lib/mcp-token-access";
import { createMcpConsentService } from "@knowledge-base/auth/mcp-consent";
import { resolveMcpPlugins } from "@knowledge-base/auth/mcp-plugins";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { PROTOCOL_VERSION_META_KEY, resourceUrlFromServerUrl } from "@modelcontextprotocol/server";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { Hono } from "hono";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from "jose";
import { Client } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import { z } from "zod";
import { openKbPostgresClusterFromEnv } from "./index";

const wiring = vi.hoisted(() => ({ settings: vi.fn(), assetStorage: vi.fn() }));
vi.mock("@knowledge-base/db", () => ({
  default: {
    appSetting: {
      findMany: (args: unknown) => wiring.settings(args),
      findUnique: (args: unknown) => wiring.assetStorage(args),
    },
  },
}));
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://oauth.example.invalid",
    BETTER_AUTH_SECRET: new Secret("disposable-oauth-integration-secret-only"),
    PUBLIC_APP_URL: "https://translation-metadata.example.invalid",
    KB_MASTER_KEY: new Secret(Buffer.alloc(32, 1).toString("base64")),
    KB_DATA_ROOT: "/tmp/r31b-unused-data",
  },
}));
vi.mock("@knowledge-base/queue", () => ({ redisConnection: {} }));
// Production verification reads signing keys in-process from Better Auth
// (`auth.api.getJwks`); route that read to this fixture's own instance. No
// test stubs `fetch` for keys: verification never touches the network.
const keyStore = vi.hoisted(() => ({
  getJwks: (): Promise<unknown> => Promise.reject(new Error("unset")),
}));
vi.mock("@knowledge-base/auth", () => ({ auth: { api: { getJwks: () => keyStore.getJwks() } } }));
vi.mock("../../../../apps/server/src/kb-write-coordinator.js", () => ({
  getKbWriteCoordinator: vi.fn(),
  gitMutatingExecutor: vi.fn(),
}));

// Cross-project fixture; the owning server project type-checks these modules.
const {
  mountMcpOAuth,
  MCP_DISCOVERY_PATHS,
}: {
  mountMcpOAuth: (
    app: Hono,
    options: {
      baseUrl: string;
      handler: (request: Request) => Promise<Response>;
    },
  ) => (request: Request) => Promise<Response>;
  MCP_DISCOVERY_PATHS: readonly string[];
} = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp-discovery.ts")).href
);
const { createBearerAdmission } = (await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/auth.ts")).href
)) as {
  createBearerAdmission(options: {
    origin: string;
    /** Production owned SQL port, or an injected query (durable replay without the port). */
    withQuery?: ReturnType<typeof credentialQuery>;
    query?: LockQuery;
    gate?: ReturnType<typeof createAdmissionGate>;
  }): (request: Request) => Promise<{ recheck(): Promise<void> }>;
};
const { createAdmissionGate } = (await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/admission.ts")).href
)) as {
  createAdmissionGate(): {
    closed: boolean;
    outstanding: number;
    close(): Promise<void>;
    admit(signal: AbortSignal): { signal: AbortSignal; release(): void } | null;
  };
};
const pairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
wiring.settings.mockImplementation((args) => prisma.appSetting.findMany(args));
const baseUrl = "https://oauth.example.invalid";
const resource = `${baseUrl}/mcp`;
const secret = "disposable-oauth-integration-secret-only";
const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  baseURL: baseUrl,
  secret,
  trustedOrigins: [baseUrl],
  plugins: [...resolveMcpPlugins({ baseUrl, secret, db: prisma })],
});
keyStore.getJwks = () => auth.api.getJwks();
const service = createMcpConsentService({ db: prisma, secret, resource });
const verifier = createGrantCredentialVerifier(prismaAssetQuery(prisma));
const revocationRuntime: Parameters<typeof revokeGrant>[0] = {
  canonicalOrigin: baseUrl,
  coordinator: {
    run: (options) =>
      runLockedOperation({
        ...options,
        connectionString: db.urls.runtime,
        kind: "authority",
        run: (lease) =>
          options.run({
            lease,
            signal: lease.scope.signal,
            issueWriteCapability() {
              throw new Error("No Git writes in OAuth fixture");
            },
          }),
      }),
  },
};
function appFor() {
  const app = new Hono();
  const handler = mountMcpOAuth(app, { baseUrl, handler: auth.handler });
  app.all("/api/auth/*", (c) => handler(c.req.raw));
  // Human control operation requires a live session.
  app.post("/human-revoke/:id", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.newResponse(null, 401);
    await revokeGrant(revocationRuntime, session.user.id, c.req.param("id"));
    return c.json({ revoked: true });
  });
  app.all("*", (c) => c.text("shell"));
  return app;
}
const app = appFor();
function send(path: string, init: RequestInit = {}, target = app) {
  return target.request(baseUrl + path, {
    ...init,
    headers: { host: new URL(baseUrl).host, ...init.headers },
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
});
async function fixture(dpopBound = false) {
  const user = await prisma.user.create({
    data: {
      name: "OAuth",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) },
  });
  const signed = `${session.token}.${createHmac("sha256", secret).update(session.token).digest("base64")}`;
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(signed)}`;
  const registration = await send("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Fixture",
      redirect_uris: ["https://client.invalid/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:read offline_access",
    }),
  });
  expect(registration.status).toBe(201);
  const { client_id: clientId } = z
    .object({ client_id: z.string() })
    .parse(await registration.json());
  if (dpopBound)
    await prisma.oauthClient.update({ where: { clientId }, data: { dpopBoundAccessTokens: true } });
  const pkce = "v".repeat(43);
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://client.invalid/cb",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(pkce).digest("base64url"),
    resource,
    scope: "mcp:read offline_access",
    state: randomUUID(),
  });
  const response = await send(`/api/auth/oauth2/authorize?${query}`, { headers: { cookie } });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!, baseUrl);
  expect(location.origin).toBe(baseUrl);
  expect(location.pathname).toBe("/en-US/mcp-consent");
  const oauthQuery = location.search.slice(1);
  const actor = { userId: user.id, sessionId: session.id };
  const intent = await service.prepare(actor, oauthQuery);
  async function approve() {
    return service.approve(actor, {
      ...intent,
      oauthQuery,
      selection: {
        scopes: ["mcp:read", "offline_access"],
        toolGroups: MCP_TOOL_GROUPS.filter((group) => group !== "sealed"),
        acl: [],
      },
      explicitConsent: true,
    });
  }
  async function consent() {
    return send("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { cookie, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ oauth_query: oauthQuery, accept: true }),
    });
  }
  async function code() {
    const res = await consent();
    expect(res.status).toBe(200);
    const redirect = new URL(z.object({ url: z.string() }).parse(await res.json()).url);
    expect(redirect.origin).toBe("https://client.invalid");
    expect(redirect.searchParams.get("iss")).toBe(`${baseUrl}/api/auth`);
    return redirect.searchParams.get("code")!;
  }
  function token(form: Record<string, string>, proof?: string) {
    return send("/api/auth/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(proof ? { dpop: proof } : {}),
      },
      body: new URLSearchParams({
        client_id: clientId,
        resource,
        ...(form.grant_type === "authorization_code"
          ? { redirect_uri: "https://client.invalid/cb" }
          : {}),
        ...form,
      }),
    });
  }
  return { user, session, cookie, clientId, approve, consent, code, token, pkce, intent };
}

const dpopSurfaces = [
  ["/mcp", "POST"],
  ["/kb-assets/kb/hash", "GET"],
  ["/kb-exports/kb/transfer", "GET"],
] as const;

async function resourceDpopFixture() {
  const f = await fixture(true);
  await f.approve();
  const key = await generateKeyPair("ES256");
  const jwk = await exportJWK(key.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const tokenProof = await new SignJWT({
    htm: "POST",
    htu: `${baseUrl}/api/auth/oauth2/token`,
    iat: now,
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
    .sign(key.privateKey);
  const response = await f.token(
    {
      grant_type: "authorization_code",
      code: await f.code(),
      code_verifier: f.pkce,
    },
    tokenProof,
  );
  expect(response.status).toBe(200);
  const pair = pairSchema.parse(await response.json());
  const jwks = await (await send("/api/auth/jwks")).json();
  const request = async (path: string, method: string, iat = now, jti = randomUUID()) => {
    const proof = await new SignJWT({
      htm: method,
      htu: `${baseUrl}${path}`,
      iat,
      jti,
      ath: createHash("sha256").update(pair.access_token).digest("base64url"),
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .sign(key.privateKey);
    return new Request(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `DPoP ${pair.access_token}`, dpop: proof },
    });
  };
  const admission = () =>
    createBearerAdmission({
      origin: baseUrl,
      withQuery: credentialQuery(db.urls.runtime),
    });
  const jkt = await calculateJwkThumbprint(jwk);
  const reservationId = (path: string, method: string, jti: string) => {
    const replayKey = createHash("sha256")
      .update(`${jkt}\n${method}\n${baseUrl}${path}\n${jti}`)
      .digest("base64url");
    return createHash("sha256").update(`reserve:dpop-proof:${replayKey}`).digest("base64url");
  };
  return { now, request, admission, jwks, reservationId };
}

// A new Node process has no module-local replay state or JWKS cache. Only the
// real verification table and credential SQL port can preserve the reservation.
async function replacementAdmission(request: Request, jwks: unknown) {
  const script = `
    import { createBearerAdmission } from './apps/server/src/mcp/auth.ts';
    import { credentialQuery } from './packages/api/src/lib/kb/credential-query.ts';
    const [input, keys, connection] = process.argv.slice(1).map(JSON.parse);
    globalThis.fetch = async () => { throw new Error('OAuth verification must not fetch JWKS'); };
    const admit = createBearerAdmission({origin: input.origin, withQuery: credentialQuery(connection), loadJwks: async () => keys});
    try {
      await admit(new Request(input.url, {method: input.method, headers: input.headers}));
      process.stdout.write('admitted');
    } catch (error) {
      process.stdout.write(error.code ?? 'unexpected');
    }
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
      JSON.stringify({
        origin: baseUrl,
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
      }),
      JSON.stringify(jwks),
      JSON.stringify(db.urls.runtime),
    ],
    { cwd: resolve(import.meta.dirname, "../../../.."), timeout: 15_000 },
  );
  return stdout;
}
async function claims(token: string) {
  const keys = (await (await send("/api/auth/jwks")).json()) as import("jose").JSONWebKeySet;
  return (
    await jwtVerify(token, createLocalJWKSet(keys), {
      issuer: `${baseUrl}/api/auth`,
      audience: resource,
    })
  ).payload;
}
async function admitted(token: string) {
  const c = await claims(token);
  return verifier.inspect({
    kind: "token",
    userId: c.sub!,
    grantId: String(c.mcp_grant_id),
    grantGeneration: String(c.mcp_grant_id),
    scopes: String(c.scope).split(" "),
    expiresAt: new Date(c.exp! * 1000),
    storedAcl: new Map(),
  });
}
// These helpers keep signatures, provider issuance, replay SQL and clocks real.
async function senderBoundFixture() {
  const f = await fixture(true);
  await f.approve();
  const key = await generateKeyPair("ES256");
  const jwk = await exportJWK(key.publicKey);
  const jkt = await calculateJwkThumbprint(jwk);
  const proof = (htu: string, iat: number, ath?: string, jti = randomUUID()) =>
    new SignJWT({ htm: "POST", htu, iat, jti, ...(ath ? { ath } : {}) })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .sign(key.privateKey);
  const issued = await f.token(
    { grant_type: "authorization_code", code: await f.code(), code_verifier: f.pkce },
    await proof(`${baseUrl}/api/auth/oauth2/token`, Math.floor(Date.now() / 1000)),
  );
  expect(issued.status).toBe(200);
  const pair = pairSchema.parse(await issued.json());
  return {
    token: f.token,
    pair,
    proof,
    async request(iat = Math.floor(Date.now() / 1000), signal?: AbortSignal) {
      const jti = randomUUID();
      const replayKey = createHash("sha256")
        .update(`${jkt}\nPOST\n${resource}\n${jti}`)
        .digest("base64url");
      const id = createHash("sha256").update(`reserve:dpop-proof:${replayKey}`).digest("base64url");
      return {
        id,
        expiresAt: (iat + 301) * 1000,
        validUntil: (Math.floor(iat) + 301) * 1000,
        request: new Request(resource, {
          method: "POST",
          signal,
          headers: {
            authorization: `DPoP ${pair.access_token}`,
            dpop: await proof(
              resource,
              iat,
              createHash("sha256").update(pair.access_token).digest("base64url"),
              jti,
            ),
          },
        }),
      };
    },
  };
}
async function pollUntil(check: () => Promise<boolean>, timeout = 3000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < end);
  throw new Error("Boundary observation deadline exceeded");
}

// Forward real PostgreSQL traffic, withholding only the selected INSERT's
// replies (and optionally termination requests). Never substitute SQL effects.
async function lostReplayReply(blockTermination: boolean) {
  const target = new URL(db.urls.runtime);
  const destination = { host: target.hostname, port: Number(target.port) };
  const sockets = new Set<Socket>();
  const held: Array<{ socket: Socket; chunks: Buffer[]; ended: boolean; released: boolean }> = [];
  let armed = true;
  const server = createServer((socket) => {
    const upstream = createConnection(destination);
    sockets.add(socket);
    sockets.add(upstream);
    let history = "";
    let withholding: (typeof held)[number] | undefined;
    let blocked = false;
    socket.on("data", (chunk: Buffer) => {
      history = (history + chunk.toString("utf8")).slice(-4096);
      if (history.includes('INSERT INTO "verification"') && armed && !withholding) {
        armed = false;
        withholding = { socket, chunks: [], ended: false, released: false };
        held.push(withholding);
      }
      if (blockTermination && history.includes("pg_terminate_backend")) blocked = true;
      if (!blocked) upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (withholding && !withholding.released) withholding.chunks.push(chunk);
      else socket.write(chunk);
    });
    upstream.on("end", () => {
      if (withholding && !withholding.released) withholding.ended = true;
      else socket.end();
    });
    socket.on("end", () => upstream.end());
    socket.on("close", () => {
      sockets.delete(socket);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      if (!withholding) socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => {
      if (!withholding) socket.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP fixture address");
  target.hostname = "127.0.0.1";
  target.port = String(address.port);
  const release = () => {
    for (const entry of held) {
      entry.released = true;
      for (const chunk of entry.chunks.splice(0)) entry.socket.write(chunk);
      if (entry.ended) entry.socket.end();
    }
  };
  return {
    url: target.href,
    release,
    async close() {
      release();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("DCR loopback redirects (RFC 8252)", () => {
  const register = (redirect: string) =>
    send("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Loopback",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    });
  it.each([
    "http://127.0.0.1:53682/callback",
    "http://[::1]:8080/cb",
    "http://localhost:3000/oauth/callback",
    "http://127.0.0.1/cb",
  ])("registers a public client on %s as native", async (redirect) => {
    const response = await register(redirect);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ application_type: "native" });
  });
  it.each([
    "http://public.example\\@127.0.0.1/cb",
    "http://public.example@127.0.0.1/cb",
    "http://user:pw@localhost/cb",
    "http://127.0.0.1@public.example/cb",
    "http://localhost\\.public.example/cb",
    "http://%31%32%37.0.0.1/cb",
    "http://127.0.0.1%2F@public.example/cb",
    "http://localhost.public.example/cb",
    "http://127.0.0.2/cb",
  ])("never treats the ambiguous or non-loopback %s as native", async (redirect) => {
    const response = await register(redirect);
    expect(response.status).toBe(400);
    expect(await prisma.oauthClient.count({ where: { redirectUris: { has: redirect } } })).toBe(0);
  });
});

describe("OAuth provider wire integration", () => {
  it("rejects a proof that expires during authority wait after real provider cleanup", async () => {
    const f = await senderBoundFixture();
    const admit = createBearerAdmission({
      origin: baseUrl,
      withQuery: credentialQuery(db.urls.runtime),
    });
    const proof = await f.request(Math.floor(Date.now() / 1000) - 299);
    await expect(admit(proof.request)).resolves.toBeDefined();
    await expect(admit(proof.request)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const holder = new Client({ connectionString: db.urls.runtime });
    holder.on("error", () => {});
    await holder.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [
        AUTHORITY_LOCK_CLASSID,
        AUTHORITY_LOCK_OBJID,
      ]);
      pending = admit(proof.request);
      const outcome = pending.then(
        () => "admitted",
        () => "denied",
      );
      await pollUntil(
        async () =>
          (
            await db.query(
              "runtime",
              "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND application_name LIKE 'kb-admission-%'",
              [pid],
            )
          ).rows.length === 1,
      );
      await new Promise((r) => setTimeout(r, Math.max(0, proof.expiresAt + 25 - Date.now())));
      expect(await prisma.verification.count({ where: { id: proof.id } })).toBe(1);
      const cleanup = await send(
        `/api/auth/reset-password/missing-${randomUUID()}?callbackURL=${encodeURIComponent(`${baseUrl}/en-US/reset-password`)}`,
      );
      expect(cleanup.status).toBe(302);
      expect(cleanup.headers.get("location")).toContain("INVALID_TOKEN");
      expect(await prisma.verification.count({ where: { id: proof.id } })).toBe(0);
      await holder.query("COMMIT");
      expect(await outcome).toBe("denied");
      expect(await prisma.verification.count({ where: { id: proof.id } })).toBe(0);
      await expect(admit((await f.request()).request)).resolves.toBeDefined();
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
      await pending?.catch(() => {});
    }
  });
  it.each([0, 0.5])(
    "provider denies an unconsumed proof that expires while its replay insertion is blocked (iat fraction %s)",
    async (fraction) => {
      const f = await senderBoundFixture();
      const iat = Math.floor(Date.now() / 1000) - 299 + fraction;
      const proof = await f.proof(`${baseUrl}/api/auth/oauth2/token`, iat);
      const holder = new Client({ connectionString: db.urls.runtime });
      holder.on("error", () => {});
      await holder.connect();
      let pending: Promise<Response> | undefined;
      try {
        const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
          .pid;
        await holder.query("BEGIN");
        await holder.query('LOCK TABLE "verification" IN SHARE MODE');
        const exchange = Promise.resolve(
          f.token({ grant_type: "refresh_token", refresh_token: f.pair.refresh_token }, proof),
        );
        pending = exchange;
        await pollUntil(
          async () =>
            (
              await db.query(
                "runtime",
                "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%INSERT%verification%'",
                [pid],
              )
            ).rows.length === 1,
        );
        await new Promise((r) =>
          setTimeout(r, Math.max(0, (Math.floor(iat) + 301) * 1000 + 25 - Date.now())),
        );
        await holder.query("COMMIT");
        const denied = await exchange;
        expect(denied.status).toBe(400);
        expect(await denied.json()).toMatchObject({ error: "invalid_dpop_proof" });
        const fresh = await f.token(
          { grant_type: "refresh_token", refresh_token: f.pair.refresh_token },
          await f.proof(`${baseUrl}/api/auth/oauth2/token`, Math.floor(Date.now() / 1000)),
        );
        expect(fresh.status).toBe(200);
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        await holder.end();
        await pending?.catch(() => {});
      }
    },
  );
  it.each([0, 0.5])(
    "rejects a proof whose successful replay INSERT reply arrives after freshness ends (iat fraction %s)",
    async (fraction) => {
      const f = await senderBoundFixture();
      const proxy = await lostReplayReply(false);
      const proof = await f.request(Math.floor(Date.now() / 1000) - 299 + fraction);
      const admit = createBearerAdmission({
        origin: baseUrl,
        withQuery: credentialQuery(proxy.url),
      });
      const pending = admit(proof.request);
      const outcome = pending.then(
        () => "admitted",
        () => "denied",
      );
      try {
        await pollUntil(
          async () =>
            (
              await db.query(
                "runtime",
                `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.state='idle in transaction' AND a.query LIKE '%INSERT INTO "verification"%' AND l.classid=$1::oid AND l.objid=$2::oid AND l.granted`,
                [AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID],
              )
            ).rows.length === 1,
        );
        await new Promise((r) => setTimeout(r, Math.max(0, proof.validUntil + 25 - Date.now())));
        proxy.release();
        expect(await outcome).toBe("denied");
        await expect(admit((await f.request()).request)).resolves.toBeDefined();
      } finally {
        proxy.release();
        await pending.catch(() => {});
        await proxy.close();
      }
    },
  );
  it.each(["caller abort", "server deadline"] as const)(
    "lost replay INSERT reply bounds authority lifetime on %s and preserves drain ownership",
    async (mode) => {
      const f = await senderBoundFixture();
      const proxy = await lostReplayReply(mode === "server deadline");
      const gate = createAdmissionGate();
      const controller = new AbortController();
      const proof = await f.request(undefined, controller.signal);
      const admit = createBearerAdmission({
        origin: baseUrl,
        gate,
        withQuery: credentialQuery(proxy.url),
      });
      const started = Date.now();
      const pending = admit(proof.request);
      const denied = expect(pending).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      let pid = 0;
      try {
        await pollUntil(async () => {
          const state = await db.query(
            "runtime",
            `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.state='idle in transaction' AND a.query LIKE '%INSERT INTO "verification"%' AND l.classid=$1::oid AND l.objid=$2::oid AND l.granted`,
            [AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID],
          );
          pid = Number(state.rows[0]?.pid ?? 0);
          return pid > 0;
        });
        expect(gate.outstanding).toBe(1);
        if (mode === "caller abort") controller.abort();
        else await new Promise((r) => setTimeout(r, Math.max(0, started + 31_000 - Date.now())));
        await denied;
        await pollUntil(
          async () =>
            (await db.query("runtime", "SELECT pid FROM pg_stat_activity WHERE pid=$1", [pid])).rows
              .length === 0,
        );
        expect(await prisma.verification.count({ where: { id: proof.id } })).toBe(0);
        if (mode === "server deadline") {
          // The server stopped the effect, but its reply and the control query
          // are still withheld. A caller timeout cannot release this permit.
          expect(gate.outstanding).toBe(1);
          proxy.release();
        }
        await gate.close();
        expect(gate.outstanding).toBe(0);
        const successor = createBearerAdmission({
          origin: baseUrl,
          withQuery: credentialQuery(db.urls.runtime),
        });
        await expect(
          successor(
            new Request(proof.request.url, { method: "POST", headers: proof.request.headers }),
          ),
        ).resolves.toBeDefined();
        await expect(admit((await f.request()).request)).rejects.toMatchObject({
          code: "STORAGE_UNAVAILABLE",
        });
      } finally {
        controller.abort();
        proxy.release();
        await pending.catch(() => {});
        await gate.close();
        await proxy.close();
      }
    },
    45_000,
  );

  it("browser prepare/approve uses the auth resource with independent translation metadata", async () => {
    const { configureServerKbRuntime } = await import(
      pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/kb-runtime.ts")).href
    );
    const { configureKbRuntime, getKbRuntime } = await import("@knowledge-base/api/lib/kb/runtime");
    const { env } = await import("@knowledge-base/env/server");
    const previousEnv = { KB_DATA_ROOT: env.KB_DATA_ROOT, DATABASE_URL: env.DATABASE_URL };
    const dataRoot = await mkdtemp(join(tmpdir(), "kb-oauth-runtime-"));
    const assetStorage = createAssetStorageLifecycle("SERVER");
    try {
      Object.assign(env, { KB_DATA_ROOT: dataRoot, DATABASE_URL: new Secret(db.urls.runtime) });
      wiring.assetStorage.mockResolvedValueOnce({
        value: JSON.stringify({ version: 1, mode: "disk", activeGeneration: randomUUID() }),
      });
      await configureServerKbRuntime(assetStorage);
      expect(wiring.assetStorage).toHaveBeenCalledWith({
        where: { key: "kb.asset-storage" },
        select: { value: true },
      });
      expect(getKbRuntime().assetStorage).toBe(assetStorage);
      expect(getKbRuntime().blobStore).toBeDefined();
      expect(getKbRuntime().canonicalOrigin).toBe(baseUrl);
      configureKbRuntime({ ...getKbRuntime(), prisma });
      const { mcpConsentRouter } = await import(
        pathToFileURL(resolve(import.meta.dirname, "../../../api/src/routers/mcp-consent.ts")).href
      );
      const { createRouterClient } = await import(
        pathToFileURL(
          resolve(import.meta.dirname, "../../../api/node_modules/@orpc/server/dist/index.mjs"),
        ).href
      );
      const f = await fixture();
      const parameters = new URLSearchParams({
        client_id: f.clientId,
        redirect_uri: "https://client.invalid/cb",
        response_type: "code",
        resource,
        scope: "mcp:read offline_access",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(f.pkce).digest("base64url"),
        state: randomUUID(),
      });
      const continuation = await send(`/api/auth/oauth2/authorize?${parameters}`, {
        headers: { cookie: f.cookie },
      });
      const oauthQuery = new URL(continuation.headers.get("location")!, baseUrl).search.slice(1);
      const client = createRouterClient(mcpConsentRouter, {
        context: () => ({ session: { user: f.user, session: f.session } }),
      });
      const reviewed = await client.prepare({ oauthQuery });
      expect(reviewed.resource).toBe(resource);
      const approved = await client.approve({
        referenceId: reviewed.referenceId,
        nonce: reviewed.nonce,
        oauthQuery,
        selection: {
          scopes: ["mcp:read", "offline_access"],
          toolGroups: MCP_TOOL_GROUPS.filter((group) => group !== "sealed"),
          acl: [],
        },
        explicitConsent: true,
      });
      expect(approved.grantId).toBeTruthy();
    } finally {
      Object.assign(env, previousEnv);
      await assetStorage.stop();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
  it("rejects library consent/token mutations before effects; human revocation preserves tombstones", async () => {
    const f = await fixture();
    const approved = await f.approve();
    const issued = await f.token({
      grant_type: "authorization_code",
      code: await f.code(),
      code_verifier: f.pkce,
    });
    const pair = pairSchema.parse(await issued.json());
    const artifact = await prisma.oauthConsent.findFirstOrThrow({
      where: { userId: f.user.id, clientId: f.clientId },
    });
    for (const cookie of [undefined, f.cookie, (await fixture()).cookie]) {
      for (const [path, body] of [
        ["delete-consent", { id: artifact.id }],
        ["update-consent", { id: artifact.id, update: { scopes: ["mcp:read"] } }],
        [
          "revoke",
          { client_id: f.clientId, token: pair.refresh_token, token_type_hint: "refresh_token" },
        ],
        [
          "revoke",
          { client_id: f.clientId, token: pair.access_token, token_type_hint: "access_token" },
        ],
      ] as const) {
        const res = await send(`/api/auth/oauth2/${path}`, {
          method: "POST",
          headers: {
            origin: baseUrl,
            "content-type":
              path === "revoke" ? "application/x-www-form-urlencoded" : "application/json",
            ...(cookie ? { cookie } : {}),
          },
          body:
            path === "revoke"
              ? new URLSearchParams(body as Record<string, string>)
              : JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "invalid_request" });
      }
    }
    expect(await prisma.oauthConsent.findUnique({ where: { id: artifact.id } })).toEqual(artifact);
    expect((await admitted(pair.access_token)).generationActive).toBe(true);
    const refreshed = await f.token({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    const next = pairSchema.parse(await refreshed.json());
    const revoked = await send(`/human-revoke/${approved.grantId}`, {
      method: "POST",
      headers: { cookie: f.cookie },
    });
    expect(revoked.status).toBe(200);
    expect((await admitted(pair.access_token)).generationActive).toBe(false);
    expect((await admitted(next.access_token)).generationActive).toBe(false);
    const denied = await f.token({
      grant_type: "refresh_token",
      refresh_token: next.refresh_token,
    });
    if (denied.status === 200)
      expect(
        (await admitted(pairSchema.parse(await denied.json()).access_token)).generationActive,
      ).toBe(false);
    else expect(denied.status).toBe(400);
    expect(await prisma.mcpGrant.findUnique({ where: { id: approved.grantId } })).toMatchObject({
      revokedAt: expect.any(Date),
    });
    expect(
      await prisma.consentIntent.findUnique({ where: { referenceId: f.intent.referenceId } }),
    ).toMatchObject({ grantId: approved.grantId, approvedAt: expect.any(Date) });
  });
  it("provider DPoP tokens authenticate at MCP with durable single-use resource proofs", async () => {
    const f = await fixture(true);
    await f.approve();
    const key = await generateKeyPair("ES256");
    const jwk = await exportJWK(key.publicKey);
    const issuedAt = Math.floor(Date.now() / 1000);
    const proof = (htu: string, patch: object = {}) =>
      new SignJWT({ htm: "POST", htu, iat: issuedAt, jti: randomUUID(), ...patch })
        .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
        .sign(key.privateKey);
    const res = await f.token(
      { grant_type: "authorization_code", code: await f.code(), code_verifier: f.pkce },
      await proof(`${baseUrl}/api/auth/oauth2/token`),
    );
    expect(res.status).toBe(200);
    const pair = pairSchema.parse(await res.json());
    expect(pair.token_type).toBe("DPoP");
    const ath = createHash("sha256").update(pair.access_token).digest("base64url");
    const query = prismaAssetQuery(prisma);
    const admit = () => createBearerAdmission({ origin: baseUrl, query });
    const request = (dpop: string, scheme = "DPoP") =>
      new Request("https://spoofed.invalid/mcp", {
        method: "POST",
        headers: {
          authorization: `${scheme} ${pair.access_token}`,
          dpop,
          cookie: "ignored",
          forwarded: "host=spoofed.invalid",
        },
      });
    // Signature, binding, admission, key loading and replay use production code and real SQL.
    try {
      for (const patch of [{ htu: `${baseUrl}/wrong` }, { htm: "GET" }, { ath: "wrong" }])
        await expect(
          admit()(request(await proof(resource, { ath, ...patch }))),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        admit()(
          new Request("https://spoofed.invalid/api/assets/fixture", {
            method: "POST",
            headers: {
              authorization: `DPoP ${pair.access_token}`,
              dpop: await proof(resource, { ath }),
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        admit()(
          new Request("https://spoofed.invalid/api/assets/fixture", {
            method: "POST",
            headers: {
              authorization: `DPoP ${pair.access_token}`,
              dpop: await proof(`${baseUrl}/api/assets/fixture`, { ath }),
            },
          }),
        ),
      ).resolves.toBeDefined();
      const { createMcpEndpoint } = await import(
        pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/handler.ts"))
          .href
      );
      const { createAdmissionGate } = await import(
        pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/admission.ts"))
          .href
      );
      const gate = createAdmissionGate();
      // Discovery decides on an authority-locked transaction: give it this
      // database's real lock coordinator (the server's own is mocked here).
      const endpoint = createMcpEndpoint({
        admit: admit(),
        gate,
        origin: baseUrl,
        runtime: () => ({ prisma, coordinator: revocationRuntime.coordinator }),
      });
      try {
        const wireProof = await proof(resource, { ath });
        const wireRequest = () =>
          new Request(resource, {
            method: "POST",
            headers: {
              authorization: `DPoP ${pair.access_token}`,
              dpop: wireProof,
              "content-type": "application/json",
              "mcp-method": "tools/list",
              "mcp-protocol-version": "2026-07-28",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
              params: {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientInfo": { name: "oauth-dpop", version: "1" },
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            }),
          });
        const response = await endpoint.fetch(wireRequest());
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ result: { tools: expect.any(Array) } });
        expect((await endpoint.fetch(wireRequest())).status).toBe(401);
      } finally {
        await gate.close();
        await endpoint.close();
      }
      expect(gate.outstanding).toBe(0);
      const valid = await proof(resource, { ath });
      await expect(admit()(request(valid, "Bearer"))).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      const outcomes = await Promise.allSettled([admit()(request(valid)), admit()(request(valid))]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
      await expect(admit()(request(valid))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime((issuedAt + 300) * 1000 + 500);
      await prisma.verification.deleteMany({
        where: { identifier: { startsWith: "dpop-proof:" }, expiresAt: { lte: new Date() } },
      });
      await expect(admit()(request(valid))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(admit()(request(await proof(resource, { ath })))).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("SDK profile/resource and actual discovery endpoints agree; spoofed forwarding cannot change issuer", async () => {
    // The pinned SDK 2.3.1 keeps LATEST_PROTOCOL_VERSION on the legacy handshake line
    // (2025-11-25) and speaks 2026-07-28 through the per-request `_meta` envelope under
    // this key; the mcp suite drives that profile over the real wire.
    expect(PROTOCOL_VERSION_META_KEY).toBe("io.modelcontextprotocol/protocolVersion");
    expect(resourceUrlFromServerUrl(new URL(resource)).toString()).toBe(resource);
    for (const path of MCP_DISCOVERY_PATHS) {
      const res = await send(path, {
        headers: {
          forwarded: "host=evil.invalid",
          "x-forwarded-host": "evil.invalid",
          "x-forwarded-proto": "http",
        },
      });
      expect(res.status).toBe(200);
      const body = z
        .object({
          resource: z.string().optional(),
          issuer: z.string().optional(),
          token_endpoint: z.string().optional(),
          client_id_metadata_document_supported: z.boolean().optional(),
        })
        .parse(await res.json());
      if (path.includes("protected-resource")) expect(body.resource).toBe(resource);
      else {
        expect(body.issuer).toBe(`${baseUrl}/api/auth`);
        expect(body.token_endpoint).toBe(`${baseUrl}/api/auth/oauth2/token`);
        expect(body.client_id_metadata_document_supported).toBe(true);
      }
      expect(JSON.stringify(body)).not.toContain("evil.invalid");
    }
  });
  it("rejects malformed paths, blank scopes, foreign resources and spoofed host locally", async () => {
    for (const [path, status] of [
      ["/api/auth/oauth2/%61uthorize", 404],
      ["/api/auth/oauth2/authorize/", 404],
      ["/api/auth/oauth2/authorize?scope=+&redirect_uri=https://evil.invalid", 400],
      ["/api/auth/oauth2/authorize?scope=mcp:read&resource=https://evil.invalid", 400],
    ] as const) {
      const res = await send(path);
      expect(res.status).toBe(status);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(
      (await send(MCP_DISCOVERY_PATHS[0]!, { headers: { host: "evil.invalid" } })).status,
    ).toBe(400);
  });
  it("requires durable approval before code; valid code and refresh carry the same generation and lifetimes", async () => {
    const f = await fixture();
    expect((await f.consent()).status).toBe(400);
    expect(await prisma.mcpGrant.count({ where: { userId: f.user.id } })).toBe(0);
    const approval = await f.approve();
    const res = await f.token({
      grant_type: "authorization_code",
      code: await f.code(),
      code_verifier: f.pkce,
    });
    expect(res.status).toBe(200);
    const pair = pairSchema.parse(await res.json());
    expect(pair.expires_in).toBe(600);
    expect((await claims(pair.access_token)).mcp_grant_id).toBe(approval.grantId);
    expect((await admitted(pair.access_token)).generationActive).toBe(true);
    const refreshed = await f.token({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    const next = pairSchema.parse(await refreshed.json());
    expect(next.refresh_token).not.toBe(pair.refresh_token);
    expect((await claims(next.access_token)).mcp_grant_id).toBe(approval.grantId);
    const rows = await prisma.oauthRefreshToken.findMany({
      where: { clientId: f.clientId },
      take: 5,
    });
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(259200_000);
    // MCP is always on: discovery and JWKS answer; human revoke works.
    for (const path of [...MCP_DISCOVERY_PATHS, "/api/auth/jwks"])
      expect((await send(path)).status).toBe(200);
    expect(
      (
        await send(`/human-revoke/${approval.grantId}`, {
          method: "POST",
          headers: { cookie: f.cookie },
        })
      ).status,
    ).toBe(200);
    const replay = await f.token({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
    });
    expect(replay.status).toBe(200); // upstream's inert retry response is permitted
    const cached = pairSchema.parse(await replay.json());
    expect(cached.access_token).toBe(next.access_token);
    expect((await admitted(cached.access_token)).generationActive).toBe(false);
    expect(
      (await f.token({ grant_type: "refresh_token", refresh_token: cached.refresh_token })).status,
    ).toBe(400);
    expect(await prisma.mcpGrant.count({ where: { userId: f.user.id } })).toBe(1);
  });
  it("closed or missing consent generations cannot mint code or refresh authority", async () => {
    const closed = await fixture();
    const approval = await closed.approve();
    const code = await closed.code();
    await revokeGrant(revocationRuntime, closed.user.id, approval.grantId);
    const denied = await closed.token({
      grant_type: "authorization_code",
      code,
      code_verifier: closed.pkce,
    });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: "invalid_grant" });
    expect(await prisma.oauthRefreshToken.count({ where: { clientId: closed.clientId } })).toBe(0);
    const missing = await fixture();
    await missing.approve();
    const issued = await missing.token({
      grant_type: "authorization_code",
      code: await missing.code(),
      code_verifier: missing.pkce,
    });
    expect(issued.status).toBe(200);
    const pair = pairSchema.parse(await issued.json());
    await prisma.consentIntent.update({
      where: { referenceId: missing.intent.referenceId },
      data: { grantId: null },
    });
    const refresh = await missing.token({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
    });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
    expect(await prisma.mcpGrant.count({ where: { userId: missing.user.id } })).toBe(1);
  });
  it("DPoP validates htu and signature; replay remains denied through the final verifier second", async () => {
    const f = await fixture(true);
    await f.approve();
    const code = await f.code();
    const key = await generateKeyPair("ES256");
    const jwk = await exportJWK(key.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const proof = (htu: string, iat = now) =>
      new SignJWT({ htm: "POST", htu, iat, jti: randomUUID() })
        .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
        .sign(key.privateKey);
    const form = { grant_type: "authorization_code", code, code_verifier: f.pkce };
    const wrong = await f.token(form, await proof(resource));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_dpop_proof" });
    const valid = await proof(`${baseUrl}/api/auth/oauth2/token`, now + 5);
    const res = await f.token({ ...form, code: await f.code() }, valid);
    expect(res.status).toBe(200);
    const pair = pairSchema.parse(await res.json());
    expect(pair.token_type).toBe("DPoP");
    const originalFetch = globalThis.fetch;
    // The resource server must not reach its own public origin for keys.
    const network = vi.fn(async () => {
      throw new Error("OAuth verification must not fetch JWKS");
    });
    vi.stubGlobal("fetch", network);
    try {
      const admit = createBearerAdmission({
        origin: baseUrl,
        withQuery: credentialQuery(db.urls.runtime),
      });
      for (const [path, method] of [
        ["/mcp", "POST"],
        ["/kb-assets/kb/hash", "GET"],
        ["/kb-exports/kb/transfer", "GET"],
      ] as const) {
        const boundProof = await new SignJWT({
          htm: method,
          htu: `${baseUrl}${path}`,
          iat: now,
          jti: randomUUID(),
          ath: createHash("sha256").update(pair.access_token).digest("base64url"),
        })
          .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
          .sign(key.privateKey);
        const request = new Request(`${baseUrl}${path}`, {
          method,
          headers: { authorization: `DPoP ${pair.access_token}`, dpop: boundProof },
        });
        const actor = await admit(request);
        await actor.recheck();
        await expect(admit(request)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }

    const broken = valid.split(".");
    broken[1] = Buffer.from(
      JSON.stringify({ htm: "GET", htu: resource, iat: now, jti: randomUUID() }),
    ).toString("base64url");
    const badSignature = await f.token(
      { grant_type: "refresh_token", refresh_token: pair.refresh_token },
      broken.join("."),
    );
    expect(badSignature.status).toBe(400);
    expect(await badSignature.json()).toMatchObject({ error: "invalid_dpop_proof" });
    // Exercise the provider at the last accepted floor-clock second.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((now + 305) * 1000 + 500);
    await prisma.verification.deleteMany({
      where: { identifier: { startsWith: "dpop-proof:" }, expiresAt: { lte: new Date() } },
    });
    const retry = await f.token(
      { grant_type: "refresh_token", refresh_token: pair.refresh_token },
      valid,
    );
    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ error: "invalid_dpop_proof" });
    const reservations = await prisma.verification.findMany({
      where: { identifier: { startsWith: "dpop-proof:" } },
      take: 10,
    });
    expect(reservations.some((r) => r.expiresAt.getTime() === (now + 306) * 1000)).toBe(true);
  });

  it.each(dpopSurfaces)(
    "resource %s retains DPoP replays throughout the final accepted second",
    async (path, method) => {
      const f = await resourceDpopFixture();
      try {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(f.now * 1000);
        const jti = randomUUID();
        const request = await f.request(path, method, f.now, jti);
        const admit = f.admission();
        await (await admit(request)).recheck();
        const id = f.reservationId(path, method, jti);
        expect((await prisma.verification.findUnique({ where: { id } }))?.expiresAt).toEqual(
          new Date((f.now + 301) * 1000),
        );
        await expect(admit(request)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        for (const age of [299_999, 300_000, 300_500, 300_999]) {
          vi.setSystemTime(f.now * 1000 + age);
          // Exercise the actual cleanup predicate while the verifier still accepts.
          await prisma.verification.deleteMany({
            where: { identifier: { startsWith: "dpop-proof:" }, expiresAt: { lte: new Date() } },
          });
          await expect(admit(request)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
          // A distinct proof at the same age must still be admitted.
          await expect(admit(await f.request(path, method))).resolves.toBeDefined();
        }
        vi.setSystemTime((f.now + 301) * 1000);
        await expect(admit(request)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        // Reuse an expired key before the janitor removes its old row.
        await expect(admit(await f.request(path, method, f.now + 301, jti))).resolves.toBeDefined();
        expect((await prisma.verification.findUnique({ where: { id } }))?.expiresAt).toEqual(
          new Date((f.now + 602) * 1000),
        );
        await prisma.verification.deleteMany({
          where: { identifier: { startsWith: "dpop-proof:" }, expiresAt: { lte: new Date() } },
        });
        expect(
          await prisma.verification.count({
            where: { identifier: { startsWith: "dpop-proof:" }, expiresAt: { lte: new Date() } },
          }),
        ).toBe(0);
        await expect(admit(request)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("resource DPoP reservations are atomic and survive process replacement on every surface", async () => {
    const f = await resourceDpopFixture();
    try {
      for (const [path, method] of dpopSurfaces) {
        const request = await f.request(path, method);
        const attempts = await Promise.allSettled([f.admission()(request), f.admission()(request)]);
        expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const rejected = attempts.find((r) => r.status === "rejected");
        expect(rejected).toMatchObject({ reason: { code: "UNAUTHORIZED" } });
        expect(await replacementAdmission(request, f.jwks)).toBe("UNAUTHORIZED");
        expect(await replacementAdmission(await f.request(path, method), f.jwks)).toBe("admitted");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["sql-failure", "cancellation", "deadline"] as const)(
    "resource DPoP reservation fails closed and rolls back on %s before re-entry",
    async (failure) => {
      const f = await resourceDpopFixture();
      const controller = new AbortController();
      const jti = randomUUID();
      const original = await f.request("/mcp", "POST", f.now, jti);
      const sql = credentialQuery(db.urls.runtime);
      let inserted = false;
      const admit = createBearerAdmission({
        origin: baseUrl,
        withQuery: (signal, run) =>
          sql(signal, async (query) => {
            const fault: LockQuery = async <R>(text: string, values?: unknown[]) => {
              const result = await query<R>(text, values);
              if (text.includes('INSERT INTO "verification"')) {
                inserted = true;
                if (failure === "sql-failure") throw new Error("Injected after real SQL insertion");
                controller.abort(
                  new DOMException(
                    "Fixture interruption",
                    failure === "deadline" ? "TimeoutError" : "AbortError",
                  ),
                );
              }
              return result;
            };
            return run(fault);
          }),
      });
      try {
        await expect(
          admit(new Request(original, { signal: controller.signal })),
        ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
        expect(inserted).toBe(true);
        expect(
          await prisma.verification.findUnique({
            where: { id: f.reservationId("/mcp", "POST", jti) },
          }),
        ).toBeNull();
        await expect(f.admission()(original)).resolves.toBeDefined();
        await expect(f.admission()(original)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("shutdown retains the OAuth permit until replay SQL rolls back and drains", async () => {
    const f = await resourceDpopFixture();
    const gate = createAdmissionGate();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jti = randomUUID();
    const request = await f.request("/mcp", "POST", f.now, jti);
    const sql = credentialQuery(db.urls.runtime);
    const admit = createBearerAdmission({
      origin: baseUrl,
      gate,
      withQuery: (signal, run) =>
        sql(signal, async (query) => {
          const hold: LockQuery = async <R>(text: string, values?: unknown[]) => {
            const result = await query<R>(text, values);
            if (text.includes('INSERT INTO "verification"')) {
              entered();
              await blocked;
            }
            return result;
          };
          return run(hold);
        }),
    });
    let closing: Promise<void> | undefined;
    try {
      const denied = expect(admit(request)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      await ready;
      let drained = false;
      closing = gate.close().then(() => {
        drained = true;
      });
      await denied;
      expect(gate.outstanding).toBe(1);
      expect(drained).toBe(false);
      release();
      await closing;
      expect(gate.outstanding).toBe(0);
      expect(
        await prisma.verification.findUnique({
          where: { id: f.reservationId("/mcp", "POST", jti) },
        }),
      ).toBeNull();
      await expect(admit(request)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      await expect(f.admission()(request)).resolves.toBeDefined();
    } finally {
      release();
      await closing;
      vi.unstubAllGlobals();
    }
  });
});
