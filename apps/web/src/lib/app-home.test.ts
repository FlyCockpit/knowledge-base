import { describe, expect, it } from "vitest";

import { safeRedirectTo } from "@/utils/safe-redirect";

import { APP_HOME, appHomeHref } from "./app-home";

describe("APP_HOME", () => {
  it("is the knowledge bases list", () => {
    expect(APP_HOME).toBe("/$lang/kbs");
    expect(appHomeHref("es-MX")).toBe("/es-MX/kbs");
  });

  it("is where a missing or unsafe redirect lands", () => {
    expect(safeRedirectTo(undefined, "en-US")).toBe("/en-US/kbs");
    expect(safeRedirectTo("https://evil.example/", "en-US")).toBe("/en-US/kbs");
    expect(safeRedirectTo("/en-US/login?x=1", "en-US")).toBe("/en-US/kbs");
    expect(safeRedirectTo("/en-US/signup", "en-US")).toBe("/en-US/kbs");
    expect(safeRedirectTo("/es-MX/settings", "en-US")).toBe("/en-US/kbs");
    expect(safeRedirectTo("/en-US/settings/mcp", "en-US")).toBe("/en-US/settings/mcp");
  });
});
