import { describe, expect, it } from "vitest";

import { getNavItems, toLangRoute } from "./nav-items";

describe("nav-items", () => {
  it("returns public desktop items for signed-out visitors", () => {
    const items = getNavItems({
      placement: "desktop",
      isAuthenticated: false,
    }).map((item) => item.path);

    expect(items).toEqual(["/"]);
  });

  it("keeps the header nav public and puts app sections in the signed-in sidebar", () => {
    const header = getNavItems({
      placement: "desktop",
      isAuthenticated: true,
      role: "user",
    }).map((item) => item.path);
    const sidebar = getNavItems({
      placement: "sidebar",
      isAuthenticated: true,
      role: "user",
    });

    expect(header).toEqual([]);
    expect(sidebar.map((item) => item.path)).toEqual(["/dashboard", "/kbs", "/settings"]);
    expect(sidebar.map((item) => item.group)).toEqual(["main", "main", "footer"]);
    expect(getNavItems({ placement: "sidebar", isAuthenticated: false })).toEqual([]);
  });

  it("adds admin destinations only when the shared admin role helper matches", () => {
    const nonAdminItems = getNavItems({
      placement: "sidebar",
      isAuthenticated: true,
      role: "manager",
    }).map((item) => item.path);
    const adminItems = getNavItems({
      placement: "sidebar",
      isAuthenticated: true,
      role: "user, admin",
    }).map((item) => item.path);

    expect(nonAdminItems).not.toContain("/admin");
    expect(adminItems).toContain("/admin");
  });

  it("keeps mobile navigation compact and role-aware", () => {
    const signedOutItems = getNavItems({
      placement: "mobile",
      isAuthenticated: false,
    }).map((item) => item.path);
    const adminItems = getNavItems({
      placement: "mobile",
      isAuthenticated: true,
      role: "admin",
    }).map((item) => item.path);

    expect(signedOutItems).toEqual(["/"]);
    // Signed in, the dashboard is home: no separate Home tab next to it.
    expect(adminItems).toEqual(["/dashboard", "/kbs", "/settings", "/admin"]);
  });

  it("derives user-menu destinations from the shared nav model", () => {
    const userItems = getNavItems({
      placement: "userMenu",
      isAuthenticated: true,
      role: "user",
    }).map((item) => item.path);
    const adminItems = getNavItems({
      placement: "userMenu",
      isAuthenticated: true,
      role: "admin",
    }).map((item) => item.path);

    expect(userItems).toEqual(["/settings"]);
    expect(adminItems).toEqual(["/settings", "/admin"]);
  });

  it("builds typed locale-prefixed routes", () => {
    expect(toLangRoute("/")).toBe("/$lang");
    expect(toLangRoute("/dashboard")).toBe("/$lang/dashboard");
    expect(toLangRoute("/settings")).toBe("/$lang/settings");
  });
});
