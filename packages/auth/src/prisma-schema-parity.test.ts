import { diffSchema, getExpectedSchema } from "@better-auth/core/db/internal";
import { PrismaClient } from "@knowledge-base/db/client";
import { createPrismaPgAdapter } from "@knowledge-base/db/prisma-adapter";
import { genericOAuth } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import { auth } from "./index";

// Every Better Auth write goes through the Prisma adapter, whose schema check compares the
// tables this configuration writes with the generated client's data model and refuses the
// call on any drift (SCHEMA_MISMATCH). This test runs that same comparison offline against
// the real generated client, with every schema-bearing plugin switched on, so a plugin
// upgrade that adds a column fails `pnpm test` instead of every sign-in, 2FA or device start.
// SSO (genericOAuth) stays off: it fetches OIDC discovery at init and declares no tables,
// which the last case pins.
// Load the real plugin/client modules during collection (vi.mock is hoisted). These
// assertions compare synchronous schema data; cold module transforms are not test work.

vi.mock("@knowledge-base/env/server", () => ({
  env: {
    NODE_ENV: "test",
    BETTER_AUTH_URL: "https://kb.example.test",
    PUBLIC_APP_URL: "https://kb.example.test",
    BETTER_AUTH_SECRET: new Secret("parity-fixture-secret-parity-fixture-secret"),
    CORS_ORIGIN: "",
  },
  ADMIN_EMAIL: undefined,
  SIGNUP_ENABLED: true,
  SSO_ENABLED: false,
  FORCE_SSO: false,
}));
vi.mock("@knowledge-base/mailer", () => ({
  isEmailConfigured: () => true,
  renderResetPassword: vi.fn(),
  renderTwoFactorOtp: vi.fn(),
  renderVerifyEmail: vi.fn(),
  sendEmail: vi.fn(),
}));
// Better Auth initializes plugins eagerly (the MCP plugin reads its resource row). This
// stand-in answers every model read as empty without a database.
vi.mock("@knowledge-base/db", () => {
  const delegate = new Proxy(
    {},
    {
      get: (_target, method) =>
        method === "then"
          ? undefined
          : async () => (method === "findMany" ? [] : method === "count" ? 0 : null),
    },
  );
  return {
    default: new Proxy({}, { get: (_target, prop) => (prop === "then" ? undefined : delegate) }),
  };
});

type RuntimeField = {
  name: string;
  kind: string;
  isRequired?: boolean;
  hasDefaultValue?: boolean;
  isUpdatedAt?: boolean;
};
type RuntimeDataModel = { models: Record<string, { fields: RuntimeField[] }> };

/** The generated client's data model, read the way @better-auth/prisma-adapter reads it. */
function generatedDataModel(): RuntimeDataModel {
  // Constructing the client never connects; no query is issued.
  const client = new PrismaClient({
    adapter: createPrismaPgAdapter({ connectionString: "postgresql://parity@127.0.0.1:1/none" }),
  });
  const model = Reflect.get(client, "_runtimeDataModel") as RuntimeDataModel | undefined;
  if (!model || typeof model !== "object" || !("models" in model))
    throw new Error("generated Prisma client carries no runtime data model");
  return model;
}

/** Mirrors @better-auth/prisma-adapter introspectPrismaDataModel (not exported). */
function introspect(dataModel: RuntimeDataModel) {
  return Object.entries(dataModel.models).map(([model, { fields }]) => ({
    name: model.charAt(0).toLowerCase() + model.slice(1),
    columns: fields
      .filter((field) => field.kind !== "object")
      .map((field) => ({
        name: field.name,
        nullable: field.isRequired !== true,
        hasDefault: field.hasDefaultValue === true || field.isUpdatedAt === true,
      })),
  }));
}

describe("Better Auth plugin tables match the Prisma schema", () => {
  it("every table and column the full plugin set writes exists, and nothing else is required", () => {
    const expected = getExpectedSchema(auth.options);
    // The schema-bearing plugin set is really configured: admin, 2FA, device and MCP/OAuth.
    expect(Object.keys(expected)).toEqual(
      expect.arrayContaining([
        "user",
        "session",
        "account",
        "verification",
        "twoFactor",
        "deviceCode",
        "jwks",
        "oauthClient",
        "oauthResource",
        "oauthClientResource",
        "oauthRefreshToken",
        "oauthAccessToken",
        "oauthConsent",
        "oauthClientAssertion",
      ]),
    );
    expect(auth.options.plugins?.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining(["admin", "two-factor"]),
    );
    expect(diffSchema(expected, introspect(generatedDataModel()))).toEqual([]);
  });

  it("the comparison detects a missing column (guards against a vacuous pass)", () => {
    const dataModel = generatedDataModel();
    const twoFactor = dataModel.models.TwoFactor;
    expect(twoFactor).toBeDefined();
    const stripped: RuntimeDataModel = {
      models: {
        ...dataModel.models,
        TwoFactor: {
          fields: (twoFactor?.fields ?? []).filter((field) => field.name !== "lockedUntil"),
        },
      },
    };
    expect(diffSchema(getExpectedSchema(auth.options), introspect(stripped))).toEqual([
      { kind: "missing-column", table: "twoFactor", column: "lockedUntil" },
    ]);
  });

  it("SSO adds no tables, so leaving it off loses no coverage", () => {
    expect(genericOAuth({ config: [] }).schema).toBeUndefined();
  });
});
