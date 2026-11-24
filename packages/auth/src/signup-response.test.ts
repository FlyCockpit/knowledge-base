import { runWithRequestState } from "@better-auth/core/context";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";

const envState = vi.hoisted(() => ({ SIGNUP_ENABLED: false }));
vi.mock("@knowledge-base/env/server", () => ({
  get SIGNUP_ENABLED() {
    return envState.SIGNUP_ENABLED;
  },
}));

const { markUserCreatedInRequest, neutralSignUpResponse, SIGN_UP_EMAIL_PATH } = await import(
  "./signup-response"
);
const { runWithAllowedUserCreation } = await import("./user-creation-policy");

// The full flow runs against the real handler in
// signup-response.integration.test.ts; these cover the branches that flow
// cannot reach on demand (a bootstrap completing between the two hooks).
function hooks(isBootstrapComplete = async () => true) {
  const plugin = neutralSignUpResponse({ isBootstrapComplete });
  const before = plugin.hooks?.before?.[0];
  const after = plugin.hooks?.after?.[0];
  if (!before || !after) throw new Error("sign-up hooks missing");
  const input = (returned?: unknown) => ({
    path: SIGN_UP_EMAIL_PATH,
    headers: new Headers(),
    context: { returned },
  });
  type Handler = (ctx: ReturnType<typeof input>) => Promise<unknown>;
  return {
    matches: (path: string) =>
      before.matcher({ path } as never) && after.matcher({ path } as never),
    before: () => (before.handler as unknown as Handler)(input()),
    after: (returned: unknown) => (after.handler as unknown as Handler)(input(returned)),
  };
}

const syntheticUser = { token: null, user: { id: "x", email: "a@example.test", role: null } };
const inRequest = <T>(fn: () => Promise<T>) => runWithRequestState(new WeakMap(), fn);

afterEach(() => {
  envState.SIGNUP_ENABLED = false;
});

describe("neutralSignUpResponse", () => {
  it("applies to /sign-up/email only", () => {
    const h = hooks();
    expect(h.matches(SIGN_UP_EMAIL_PATH)).toBe(true);
    expect(h.matches("/sign-in/email")).toBe(false);
  });

  it("replaces a success body with the neutral one while sign-up is enabled", async () => {
    envState.SIGNUP_ENABLED = true;
    const result = await inRequest(() => hooks().after(syntheticUser));
    expect(result).toEqual({ token: null, user: null });
  });

  it("refuses a 200 that created no user while sign-up is disabled", async () => {
    const result = inRequest(() => hooks().after(syntheticUser));
    await expect(result).rejects.toBeInstanceOf(APIError);
    await expect(result).rejects.toMatchObject({
      statusCode: 422,
      body: { code: "FAILED_TO_CREATE_USER" },
    });
  });

  it("keeps a 200 that really created the user while sign-up is disabled", async () => {
    const result = await inRequest(async () => {
      await markUserCreatedInRequest();
      return hooks().after(syntheticUser);
    });
    expect(result).toEqual({ token: null, user: null });
  });

  it("scopes the creation mark to its own request", async () => {
    await inRequest(() => markUserCreatedInRequest());
    await expect(inRequest(() => hooks().after(syntheticUser))).rejects.toMatchObject({
      statusCode: 422,
    });
    // Outside any request (a script on the adapter) marking is a no-op.
    await expect(markUserCreatedInRequest()).resolves.toBeUndefined();
  });

  it("leaves error responses untouched", async () => {
    const error = APIError.from("BAD_REQUEST", { message: "bad", code: "INVALID_EMAIL" });
    await expect(inRequest(() => hooks().after(error))).resolves.toBeUndefined();
  });

  it("refuses early once bootstrap is complete and sign-up is disabled", async () => {
    await expect(inRequest(() => hooks().before())).rejects.toMatchObject({ statusCode: 422 });
    await expect(inRequest(() => hooks(async () => false).before())).resolves.toBeUndefined();
    envState.SIGNUP_ENABLED = true;
    const notAsked = vi.fn(async () => true);
    await expect(inRequest(() => hooks(notAsked).before())).resolves.toBeUndefined();
    expect(notAsked).not.toHaveBeenCalled();
    envState.SIGNUP_ENABLED = false;
    await expect(
      runWithAllowedUserCreation("admin-invite", () => inRequest(() => hooks(notAsked).before())),
    ).resolves.toBeUndefined();
  });
});
