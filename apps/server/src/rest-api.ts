import {
  ApiKeyInadmissibleError,
  type ApiKeyView,
  apiKeyChildMintInput,
  assertApiKeyMayDelete,
  type ChildTokenView,
  canonicalApiResource,
  describeApiKey,
  idempotencyKeySchema,
  listApiKeyChildren,
  mintApiKeyChild,
  revokeApiKeyChild,
  revokeApiKeySelf,
  touchApiKey,
} from "@knowledge-base/api/lib/api-keys";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import {
  createKnowledgeBaseAsGrant,
  deleteKnowledgeBase,
  getKnowledgeBaseAttachment,
  listKnowledgeBases,
  mapKbDomainError,
} from "@knowledge-base/api/lib/kb/bases";
import { CredentialCapacityError } from "@knowledge-base/api/lib/kb/credential-query";
import { KB_CURSOR_MAX_BYTES } from "@knowledge-base/api/lib/kb/cursor";
import { describeCreateLimit } from "@knowledge-base/api/lib/kb/instance-limits";
import { KbAdmissionError } from "@knowledge-base/api/lib/kb/principal";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { logInternalError } from "@knowledge-base/env/log";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { createAdmissionGate } from "./mcp/admission";
import type { BearerAdmission, BearerAdmitter } from "./mcp/context";

/**
 * The REST control plane (`/api/v1`): create, list, read and delete KBs, and
 * mint, list and revoke child MCP tokens, for a REST API key (`kbk_…`) only.
 *
 * A thin layer: every route calls the same grant-checked domain functions the
 * MCP tools and the web use, with the key as a token principal whose stored
 * ceiling is intersected with the owner's live bits on every check. No
 * content reads or writes: content stays on MCP, done by child tokens.
 *
 * One route table drives both the Hono routes and the OpenAPI document
 * (`GET /api/v1/openapi.json`, checked in as docs/rest-api.openapi.json).
 */

export const REST_API_BASE = "/api/v1";
/** Mirrored by body-policy.ts (REST_API_MAX_BODY_BYTES) for the transport cap. */
const BODY_MAX_BYTES = 16 * 1024;

const kbIdParam = z.string().regex(/^[a-z0-9]{24,32}$/);
const tokenIdParam = z.string().regex(/^[0-9a-f]{24}$/);
/** The REST error body of a limiter refusal (index.ts mounts the limiter). */
export function restLimiterRefusal(status: 429 | 503, retryAfterSeconds: number) {
  return status === 429
    ? { error: { code: "RATE_LIMITED", message: "Rate limited", retryAfterSeconds } }
    : { error: { code: "STORAGE_UNAVAILABLE", message: "Temporarily unavailable" } };
}

const childPageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  // A child-list cursor is the last token id of the page.
  cursor: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
});
const pageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  // The shared signed-cursor bound (a KB list cursor embeds the KB name).
  cursor: z.string().min(1).max(KB_CURSOR_MAX_BYTES).optional(),
});

const permission = z.enum(["read", "propose", "write", "review", "manage"]);
const isoDate = z.string().describe("ISO 8601 timestamp");

const kbSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  defaultBranch: z.literal("main"),
  headSha: z.string(),
  metadataVersion: z.number().int(),
  capabilities: z.array(permission).describe("The key's live bits on this KB"),
  writeMode: z.string(),
  embeddingGeneration: z.string().nullable(),
  attachmentLocator: z.string().describe("The MCP attachment locator for this KB"),
  sealedNamespace: z.string(),
});
const kbPageSchema = z.object({ items: z.array(kbSchema), nextCursor: z.string().nullable() });

const childSchema = z.object({
  id: z.string(),
  name: z.string(),
  lookupPrefix: z.string(),
  grantId: z.string(),
  apiKeyId: z.string(),
  kbId: z.string().nullable(),
  bits: z.array(permission),
  scopes: z.array(z.enum(["mcp:read", "mcp:write"])),
  toolGroups: z.array(z.string()),
  authoringMode: z.enum(["dream", "edit", "both"]).nullable(),
  allowCreate: z.boolean(),
  createdKbBits: z.array(permission).describe("Bits on a KB this token creates"),
  kbCount: z.number().int().describe("The minted KB plus every KB this token created"),
  createdAt: isoDate,
  expiresAt: isoDate.nullable().describe("null = never expires"),
  revokedAt: isoDate.nullable(),
});
const childPageSchema = z.object({
  items: z.array(childSchema),
  nextCursor: z.string().nullable(),
});

const keySchema = z.object({
  id: z.string(),
  name: z.string(),
  lookupPrefix: z.string(),
  grantId: z.string(),
  reach: z.enum(["all", "selected", "created"]),
  bits: z.array(permission),
  allowCreate: z.boolean(),
  allowDelete: z.boolean(),
  allowMintChildren: z.boolean(),
  childToolGroups: z.array(z.string()),
  childAuthoringMode: z.enum(["dream", "edit", "both"]).nullable(),
  childAllowCreate: z.boolean(),
  childrenEndWithKey: z.boolean(),
  createdAt: isoDate,
  expiresAt: isoDate.nullable().describe("null = never expires"),
  lastUsedAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
  liveChildren: z.number().int(),
  kbCount: z.number().int(),
});

const errorSchema = z.object({
  error: z.object({
    code: z.string().describe("Stable error code, e.g. NOT_FOUND, RATE_LIMITED"),
    message: z.string(),
    retryAfterSeconds: z.number().int().optional(),
    limit: z.number().int().optional(),
    windowSeconds: z.number().int().optional(),
  }),
});

const createKbBody = z.strictObject({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(63),
  description: z.string().min(10).max(2000),
});
const revokeKeyBody = z.strictObject({ revokeChildren: z.boolean().optional() });
const deleteKbBody = z.strictObject({
  metadataVersion: z.number().int().min(1),
  confirm: z.literal("DELETE"),
});

type Json = Record<string, unknown>;
type RouteContext = {
  admitted: BearerAdmission;
  runtime: KbRuntimeConfig;
  resource: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  idempotencyKey: string | null;
};
type RouteResult = { status: 200 | 201; body: unknown };

export type RestRoute = {
  method: "get" | "post" | "delete";
  /** OpenAPI path under /api/v1, e.g. `/kbs/{kbId}`. */
  path: string;
  operationId: string;
  summary: string;
  /** Mutations require an `Idempotency-Key` header. */
  idempotent: boolean;
  params?: Record<string, z.ZodType>;
  query?: z.ZodObject;
  body?: z.ZodType;
  success: { status: 200 | 201; description: string; schema: z.ZodType };
  /** A second success status with the same body shape (an idempotent replay). */
  replay?: { status: 200; description: string };
  /** Error statuses this route documents besides 400/401/429/503. */
  errors: readonly number[];
  run(ctx: RouteContext): Promise<RouteResult>;
};

function iso<T extends Record<string, unknown>>(value: T): Json {
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
  );
}
const keyJson = (key: ApiKeyView) => iso(key);
const childJson = (token: ChildTokenView) => iso(token);
const page = <T>(items: T[], nextCursor: string | null, map: (item: T) => unknown) => ({
  items: items.map(map),
  nextCursor,
});

export const REST_ROUTES: readonly RestRoute[] = [
  {
    method: "get",
    path: "/key",
    operationId: "getApiKey",
    summary: "The presented API key: its reach, toggles and child ceilings",
    idempotent: false,
    success: { status: 200, description: "The key", schema: keySchema },
    errors: [],
    async run({ admitted, runtime, resource }) {
      return {
        status: 200,
        body: keyJson(await describeApiKey(runtime, admitted.principal, resource)),
      };
    },
  },
  {
    method: "delete",
    path: "/key",
    operationId: "revokeApiKey",
    summary:
      "Revoke the presented key itself; revokeChildren (default: the key's childrenEndWithKey) also revokes its independent child tokens, and children that end with the key are always revoked. Naturally idempotent: no Idempotency-Key; once revoked the key answers 401",
    idempotent: false,
    body: revokeKeyBody,
    success: {
      status: 200,
      description: "Revoked (idempotent)",
      schema: z.object({ id: z.string(), revoked: z.literal(true), children: z.number().int() }),
    },
    errors: [],
    async run({ admitted, runtime, resource, body }) {
      const input = body as z.infer<typeof revokeKeyBody>;
      const result = await revokeApiKeySelf(runtime, admitted.principal, resource, input);
      return { status: 200, body: result };
    },
  },
  {
    method: "get",
    path: "/kbs",
    operationId: "listKbs",
    summary: "List the KBs this key reaches (its ceiling ∩ your live access)",
    idempotent: false,
    query: pageQuery,
    success: { status: 200, description: "One page of KBs", schema: kbPageSchema },
    errors: [],
    async run({ admitted, runtime, query }) {
      const result = await listKnowledgeBases(
        runtime,
        admitted.principal,
        query as z.infer<typeof pageQuery>,
        admitted.verifier,
      );
      return { status: 200, body: result };
    },
  },
  {
    method: "post",
    path: "/kbs",
    operationId: "createKb",
    summary: "Create a KB you own (needs the key's allowCreate); the key reaches it afterwards",
    idempotent: true,
    body: createKbBody,
    success: {
      status: 201,
      description: "Created (or the replay of the same Idempotency-Key)",
      schema: z.object({ operationId: z.string(), kb: kbSchema }),
    },
    errors: [403, 409],
    async run({ admitted, runtime, body, idempotencyKey }) {
      const input = body as z.infer<typeof createKbBody>;
      const result = await createKnowledgeBaseAsGrant(
        runtime,
        admitted.principal,
        admitted.verifier,
        {
          ...input,
          idempotencyKey: idempotencyKey!,
        },
      );
      return { status: 201, body: result };
    },
  },
  {
    method: "get",
    path: "/kbs/{kbId}",
    operationId: "getKb",
    summary: "Read one KB's metadata",
    idempotent: false,
    params: { kbId: kbIdParam },
    success: { status: 200, description: "The KB", schema: kbSchema },
    errors: [404],
    async run({ admitted, runtime, params }) {
      const kb = await getKnowledgeBaseAttachment(
        runtime,
        admitted.principal,
        params.kbId!,
        admitted.verifier,
      );
      return { status: 200, body: kb };
    },
  },
  {
    method: "delete",
    path: "/kbs/{kbId}",
    operationId: "deleteKb",
    summary:
      "Delete (tombstone) a KB you own: needs the key's allowDelete and live manage; same rules as knowledge_bases_delete",
    idempotent: true,
    params: { kbId: kbIdParam },
    body: deleteKbBody,
    success: {
      status: 200,
      description: "Tombstoned (or the replay of the same Idempotency-Key)",
      schema: z.object({ operationId: z.string(), tombstoned: z.literal(true) }),
    },
    errors: [403, 404, 409],
    async run({ admitted, runtime, resource, params, body, idempotencyKey }) {
      const input = body as z.infer<typeof deleteKbBody>;
      await assertApiKeyMayDelete(runtime, admitted.principal, resource);
      const result = await deleteKnowledgeBase(
        runtime,
        admitted.principal,
        { kbId: params.kbId!, ...input, idempotencyKey: idempotencyKey! },
        admitted.verifier,
      );
      return { status: 200, body: result };
    },
  },
  {
    method: "post",
    path: "/kbs/{kbId}/tokens",
    operationId: "mintChildToken",
    summary:
      "Mint a child MCP token for one KB (within the key's ceilings and your live access); the secret is shown once",
    idempotent: true,
    params: { kbId: kbIdParam },
    body: apiKeyChildMintInput,
    success: {
      status: 201,
      description:
        "Minted. A replay of the same Idempotency-Key returns 200 with the same token and secret null",
      schema: z.object({
        token: childSchema,
        secret: z.string().nullable(),
        replayed: z.boolean(),
      }),
    },
    replay: {
      status: 200,
      description:
        "Replay of the same Idempotency-Key and body: the same token with secret null and replayed true",
    },
    errors: [403, 404, 409],
    async run({ admitted, runtime, resource, params, body, idempotencyKey }) {
      const minted = await mintApiKeyChild(
        runtime,
        admitted.principal,
        resource,
        params.kbId!,
        body as z.input<typeof apiKeyChildMintInput>,
        idempotencyKey!,
      );
      return {
        status: minted.replayed ? 200 : 201,
        body: { ...minted, token: childJson(minted.token) },
      };
    },
  },
  {
    method: "get",
    path: "/kbs/{kbId}/tokens",
    operationId: "listKbChildTokens",
    summary: "List this key's child tokens for one KB (revoked and expired included)",
    idempotent: false,
    params: { kbId: kbIdParam },
    query: childPageQuery,
    success: { status: 200, description: "One page of child tokens", schema: childPageSchema },
    errors: [],
    async run({ admitted, runtime, resource, params, query }) {
      const result = await listApiKeyChildren(runtime, admitted.principal, resource, {
        ...(query as z.infer<typeof childPageQuery>),
        kbId: params.kbId,
      });
      return { status: 200, body: page(result.items, result.nextCursor, childJson) };
    },
  },
  {
    method: "get",
    path: "/tokens",
    operationId: "listChildTokens",
    summary: "List every child token of this key (revoked and expired included)",
    idempotent: false,
    query: childPageQuery,
    success: { status: 200, description: "One page of child tokens", schema: childPageSchema },
    errors: [],
    async run({ admitted, runtime, resource, query }) {
      const result = await listApiKeyChildren(
        runtime,
        admitted.principal,
        resource,
        query as z.infer<typeof childPageQuery>,
      );
      return { status: 200, body: page(result.items, result.nextCursor, childJson) };
    },
  },
  {
    method: "delete",
    path: "/tokens/{tokenId}",
    operationId: "revokeChildToken",
    summary: "Revoke one child token of this key (naturally idempotent: no Idempotency-Key)",
    idempotent: false,
    params: { tokenId: tokenIdParam },
    success: {
      status: 200,
      description: "Revoked",
      schema: z.object({ id: z.string(), revoked: z.literal(true) }),
    },
    errors: [404],
    async run({ admitted, runtime, resource, params }) {
      const result = await revokeApiKeyChild(
        runtime,
        { principal: admitted.principal, resource },
        params.tokenId!,
      );
      return { status: 200, body: result };
    },
  },
];

// --- HTTP plumbing ----------------------------------------------------------

const STATUS: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  INVALID_CURSOR: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 409,
  QUOTA_EXCEEDED: 409,
  REPAIR_REQUIRED: 409,
  RATE_LIMITED: 429,
  STORAGE_UNAVAILABLE: 503,
  CANCELLED: 503,
  DEADLINE_EXCEEDED: 503,
};
const MESSAGE: Record<string, string> = {
  INVALID_ARGUMENT: "Invalid request",
  INVALID_CURSOR: "Invalid cursor",
  NOT_FOUND: "Not found",
  FORBIDDEN: "Forbidden",
  CONFLICT: "Conflict",
  IDEMPOTENCY_MISMATCH: "This Idempotency-Key was used with a different request",
  QUOTA_EXCEEDED: "Quota exceeded",
  REPAIR_REQUIRED: "The knowledge base requires repair",
  RATE_LIMITED: "Rate limited",
  STORAGE_UNAVAILABLE: "Temporarily unavailable",
  CANCELLED: "Temporarily unavailable",
  DEADLINE_EXCEEDED: "Temporarily unavailable",
  UNAUTHORIZED: "A valid REST API key is required",
  INTERNAL: "Internal error",
};

class RequestError extends Error {
  constructor(
    readonly code: "INVALID_ARGUMENT" | "UNSUPPORTED_MEDIA_TYPE" | "PAYLOAD_TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}

function problem(
  status: number,
  code: string,
  message: string,
  extra: Json = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message, ...extra } },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;.*)?$/i.test(type)) {
    throw new RequestError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("INVALID_ARGUMENT", "A JSON body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new RequestError("PAYLOAD_TOO_LARGE", "Body too large");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("INVALID_ARGUMENT", "Body is not valid JSON");
  }
}

async function assertNoBody(request: Request): Promise<void> {
  const reader = request.body?.getReader();
  if (!reader) return;
  const first = await reader.read();
  if (!first.done) {
    await reader.cancel().catch(() => {});
    throw new RequestError("INVALID_ARGUMENT", "This request takes no body");
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestError("INVALID_ARGUMENT", `Invalid ${what}`);
  return parsed.data;
}

export function createRestApi(options: {
  admit: BearerAdmitter;
  runtime: () => KbRuntimeConfig;
  origin: string;
  gate: ReturnType<typeof createAdmissionGate>;
  isClosing(): boolean;
}) {
  const app = new Hono();
  const resource = canonicalApiResource(options.origin);
  const unauthorized = () =>
    problem(
      401,
      "UNAUTHORIZED",
      MESSAGE.UNAUTHORIZED!,
      {},
      {
        "www-authenticate": 'Bearer realm="knowledge-base-api"',
      },
    );

  async function failure(
    error: unknown,
    route: RestRoute,
    runtime: KbRuntimeConfig,
    admitted?: BearerAdmission,
  ) {
    // The key was revoked, expired or its owner lost admission mid-request.
    if (error instanceof ApiKeyInadmissibleError) return unauthorized();
    // Credential connections busy: a short retryable wait, not a refusal.
    if (error instanceof CredentialCapacityError) {
      return problem(
        503,
        "STORAGE_UNAVAILABLE",
        MESSAGE.STORAGE_UNAVAILABLE!,
        {},
        {
          "retry-after": "1",
        },
      );
    }
    if (error instanceof RequestError) {
      const status =
        error.code === "UNSUPPORTED_MEDIA_TYPE"
          ? 415
          : error.code === "PAYLOAD_TOO_LARGE"
            ? 413
            : 400;
      return problem(status, error.code, error.message);
    }
    // The key lost admission on the domain transaction (revoked, expired,
    // banned since the bearer check): a credential failure, so 401 like the
    // bearer check itself, never the 403 the domain mapping would give it.
    if (error instanceof KbAdmissionError && error.code === "UNAUTHORIZED") return unauthorized();
    const mapped = mapKbDomainError(error);
    // The KB lifecycle functions fold a lost credential into FORBIDDEN. Tell
    // the two apart with one more live check of the key: still admissible
    // means a real permission denial (403); otherwise the key died (401).
    if (mapped?.code === "FORBIDDEN" && admitted) {
      const recheck = await Promise.resolve()
        .then(() => admitted.recheck())
        .then(
          () => null,
          (cause: unknown) => cause,
        );
      // Only a credential refusal is a dead key; a busy or unavailable
      // credential store stays a retryable infrastructure answer.
      if (
        recheck instanceof KbAdmissionError &&
        (recheck.code === "UNAUTHORIZED" || recheck.code === "FORBIDDEN")
      ) {
        return unauthorized();
      }
      if (recheck !== null) {
        const known = recheck instanceof CredentialCapacityError || mapKbDomainError(recheck);
        if (known) return failure(recheck, route, runtime);
        // A raw credential-store error (connection, SQL): retryable, not a 500.
        logInternalError("rest-api.request", recheck);
        return problem(
          503,
          "STORAGE_UNAVAILABLE",
          MESSAGE.STORAGE_UNAVAILABLE!,
          {},
          {
            "retry-after": "5",
          },
        );
      }
    }
    if (!mapped) {
      logInternalError("rest-api.request", error);
      return problem(500, "INTERNAL", MESSAGE.INTERNAL!);
    }
    const status = STATUS[mapped.code] ?? 500;
    if (status === 500) {
      logInternalError("rest-api.request", error);
      return problem(500, "INTERNAL", MESSAGE.INTERNAL!);
    }
    if (status === 429) {
      const retry = Math.max(1, mapped.retryAfterSeconds ?? 60);
      if (route.operationId === "createKb") {
        const refusal = await describeCreateLimit(prismaAssetQuery(runtime.prisma), retry);
        return problem(
          429,
          "RATE_LIMITED",
          refusal.message,
          {
            retryAfterSeconds: refusal.retryAfterSeconds,
            limit: refusal.limit,
            windowSeconds: refusal.windowSeconds,
          },
          { "retry-after": String(refusal.retryAfterSeconds) },
        );
      }
      return problem(
        429,
        "RATE_LIMITED",
        MESSAGE.RATE_LIMITED!,
        { retryAfterSeconds: retry },
        { "retry-after": String(retry) },
      );
    }
    if (status === 503) {
      return problem(
        503,
        mapped.code,
        MESSAGE[mapped.code] ?? MESSAGE.STORAGE_UNAVAILABLE!,
        {},
        {
          "retry-after": "5",
        },
      );
    }
    return problem(status, mapped.code, MESSAGE[mapped.code] ?? mapped.code);
  }

  async function handle(c: Context, route: RestRoute): Promise<Response> {
    if (options.isClosing())
      return problem(503, "STORAGE_UNAVAILABLE", MESSAGE.STORAGE_UNAVAILABLE!);
    const permit = options.gate.admit(c.req.raw.signal);
    if (!permit) return problem(503, "STORAGE_UNAVAILABLE", MESSAGE.STORAGE_UNAVAILABLE!);
    const runtime = options.runtime();
    let admitted: BearerAdmission | undefined;
    try {
      const request = new Request(c.req.raw, { signal: permit.signal });
      try {
        admitted = await options.admit(request);
      } catch (error) {
        // Credential connections busy: a short retryable wait, not a refusal.
        if (error instanceof CredentialCapacityError) {
          return problem(
            503,
            "STORAGE_UNAVAILABLE",
            MESSAGE.STORAGE_UNAVAILABLE!,
            {},
            {
              "retry-after": "1",
            },
          );
        }
        const mapped = mapKbDomainError(error);
        // An error that is not a credential decision (the credential store is
        // down: a raw connection or SQL error) is retryable, never a 401.
        if (!mapped) {
          logInternalError("rest-api.request", error);
          return problem(
            503,
            "STORAGE_UNAVAILABLE",
            MESSAGE.STORAGE_UNAVAILABLE!,
            {},
            {
              "retry-after": "5",
            },
          );
        }
        // Any credential failure is a plain 401: never say why.
        if (mapped.code === "FORBIDDEN" || mapped.code === "NOT_FOUND") return unauthorized();
        return failure(error, route, runtime);
      }
      const apiKeyId = admitted.principal.credential?.tokenId;
      if (admitted.principal.credential?.kind !== "API_KEY" || !apiKeyId) return unauthorized();
      const params: Record<string, string> = {};
      for (const [name, schema] of Object.entries(route.params ?? {})) {
        const value = c.req.param(name) ?? "";
        if (!schema.safeParse(value).success) {
          return problem(404, "NOT_FOUND", MESSAGE.NOT_FOUND!);
        }
        params[name] = value;
      }
      const query = route.query
        ? parseOrThrow(route.query, c.req.query(), "query")
        : (() => {
            if (Object.keys(c.req.query()).length > 0) {
              throw new RequestError("INVALID_ARGUMENT", "This request takes no query");
            }
            return {};
          })();
      let idempotencyKey: string | null = null;
      if (route.idempotent) {
        idempotencyKey = c.req.header("idempotency-key") ?? null;
        if (!idempotencyKey || !idempotencyKeySchema.safeParse(idempotencyKey).success) {
          throw new RequestError(
            "INVALID_ARGUMENT",
            "An Idempotency-Key header (1–128 of A-Z a-z 0-9 _ -) is required",
          );
        }
      }
      let body: unknown;
      if (route.body) body = parseOrThrow(route.body, await readJson(request), "body");
      else await assertNoBody(request);
      // Use is recorded only after admission; never part of it.
      await touchApiKey(prismaAssetQuery(runtime.prisma), apiKeyId).catch(() => {});
      const result = await route.run({
        admitted,
        runtime,
        resource,
        params,
        query: query as Record<string, unknown>,
        body,
        idempotencyKey,
      });
      return Response.json(result.body, {
        status: result.status,
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      return failure(error, route, runtime, admitted);
    } finally {
      permit.release();
    }
  }

  const document = buildOpenApiDocument(options.origin);
  app.get(`${REST_API_BASE}/openapi.json`, (c) =>
    c.json(document, 200, { "cache-control": "public, max-age=300" }),
  );
  for (const route of REST_ROUTES) {
    const path = `${REST_API_BASE}${route.path.replace(/\{(\w+)\}/g, ":$1")}`;
    app.on(route.method.toUpperCase(), path, (c) => handle(c, route));
  }
  app.all(`${REST_API_BASE}/*`, () => problem(404, "NOT_FOUND", MESSAGE.NOT_FOUND!));
  return app;
}

// --- OpenAPI ----------------------------------------------------------------

function jsonSchema(schema: z.ZodType): Json {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
  delete out.$schema;
  return out;
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Invalid request (body, query or Idempotency-Key)",
  401: "Missing, unknown, revoked or expired API key (MCP tokens are refused here)",
  403: "The key's ceiling or your live access does not allow this",
  404: "Not found, or not reachable by this key",
  409: "Conflict: idempotency mismatch, quota exceeded, metadata version or slug conflict",
  413: "Body too large",
  415: "Content-Type must be application/json",
  429: "Rate limited; wait Retry-After seconds (a create names the limit and window)",
  503: "Temporarily unavailable; retry",
};

/**
 * The OpenAPI 3.1 document, generated from {@link REST_ROUTES}. `origin` only
 * fills `servers`; the checked-in copy uses a placeholder origin.
 */
export function buildOpenApiDocument(origin: string): Json {
  const paths: Record<string, Json> = {};
  for (const route of REST_ROUTES) {
    const parameters: Json[] = [];
    for (const [name, schema] of Object.entries(route.params ?? {})) {
      parameters.push({ name, in: "path", required: true, schema: jsonSchema(schema) });
    }
    if (route.query) {
      for (const [name, schema] of Object.entries(route.query.shape)) {
        parameters.push({
          name,
          in: "query",
          required: false,
          schema: jsonSchema(schema as z.ZodType),
        });
      }
    }
    if (route.idempotent) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description:
          "Retry a mutation with the same key and body to get the same result; a refusal stores nothing, so the same key may be retried",
        schema: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
      });
    }
    const statuses = [...new Set([400, 401, ...route.errors, 429, 503])].sort((a, b) => a - b);
    if (route.body) statuses.push(413, 415);
    const responses: Json = {
      [String(route.success.status)]: {
        description: route.success.description,
        content: { "application/json": { schema: jsonSchema(route.success.schema) } },
      },
      ...(route.replay
        ? {
            [String(route.replay.status)]: {
              description: route.replay.description,
              content: { "application/json": { schema: jsonSchema(route.success.schema) } },
            },
          }
        : {}),
    };
    for (const status of [...new Set(statuses)].sort((a, b) => a - b)) {
      responses[String(status)] = {
        description: ERROR_DESCRIPTIONS[status],
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      };
    }
    const operation: Json = {
      operationId: route.operationId,
      summary: route.summary,
      security: [{ apiKey: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: jsonSchema(route.body) } },
            },
          }
        : {}),
      responses,
    };
    const key = route.path;
    paths[key] = { ...(paths[key] ?? {}), [route.method]: operation };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Knowledge Base control-plane API",
      version: "1",
      description:
        "Create, list and delete knowledge bases and mint child MCP tokens with a REST API key (kbk_…). Content stays on MCP.",
    },
    servers: [{ url: canonicalApiResource(origin).replace(/\/$/, "") }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "A REST API key from Settings → API keys (kbk_…). MCP tokens are refused.",
        },
      },
      schemas: { Error: jsonSchema(errorSchema) },
    },
    paths,
  };
}
