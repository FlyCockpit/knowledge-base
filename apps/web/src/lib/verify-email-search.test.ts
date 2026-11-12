import { defaultParseSearch } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { parseVerifyEmailSearch } from "./verify-email-search";

/**
 * These cases go through `defaultParseSearch` — the router's ACTUAL parser —
 * rather than hand-built objects. That is the whole point: the original bug was
 * that `?ok=1` reaches `validateSearch` as the number 1, and a test asserting
 * on the raw string `"?ok=1"` (as the verification-callback suite does) cannot
 * see it. Anything that stubs the parser reintroduces the blind spot.
 */
const parseUrl = (search: string) => defaultParseSearch(search) as Record<string, unknown>;
const fromUrl = (search: string) => parseVerifyEmailSearch(parseUrl(search));

describe("parseVerifyEmailSearch", () => {
  it("recognizes the ?ok=1 marker buildCallback actually emits", () => {
    // Regression: JSON.parse("1") === 1, so this arrives as a number.
    expect(parseUrl("?ok=1").ok).toBe(1);
    expect(fromUrl("?ok=1")).toEqual({ ok: true, error: undefined });
  });

  it("accepts the other spellings of the marker", () => {
    expect(fromUrl("?ok=true").ok).toBe(true);
    // Quoted in the URL, so JSON.parse yields the string "1".
    expect(fromUrl('?ok="1"').ok).toBe(true);
  });

  it("treats a bare visit as unknown, not success", () => {
    // A guard redirect arrives with no params; rendering it as success would
    // tell an unverified user their address is already confirmed.
    expect(fromUrl("")).toEqual({ ok: undefined, error: undefined });
    expect(fromUrl("?lang=en-US")).toEqual({ ok: undefined, error: undefined });
  });

  it("surfaces an error code as a string", () => {
    expect(fromUrl("?error=TOKEN_EXPIRED")).toEqual({ ok: undefined, error: "TOKEN_EXPIRED" });
  });

  it("keeps the error when Better-Auth appends it to the success callback", () => {
    // The real failure shape: our ?ok=1 callback with &error= tacked on.
    expect(fromUrl("?ok=1&error=TOKEN_EXPIRED")).toEqual({ ok: true, error: "TOKEN_EXPIRED" });
  });

  it("ignores values that are not a recognized marker", () => {
    expect(fromUrl("?ok=0").ok).toBeUndefined();
    expect(fromUrl("?ok=false").ok).toBeUndefined();
    expect(fromUrl("?ok=maybe").ok).toBeUndefined();
    expect(fromUrl("?error=1").error).toBeUndefined();
  });
});
