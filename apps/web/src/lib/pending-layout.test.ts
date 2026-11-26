import { describe, expect, it } from "vitest";

import { kbPendingFrame, resolvePendingLayout } from "./pending-layout";

const ROOT = { routeId: "__root__" };
const LANG = { routeId: "/$lang" };
const APP = { routeId: "/$lang/_app" };
const ADMIN = { routeId: "/$lang/_app/admin", staticData: { pendingFrame: "admin" as const } };
const USERS = {
  routeId: "/$lang/_app/admin/users",
  staticData: { pendingShape: "list" as const, pendingWidth: "wide" as const },
};
const SETTINGS = {
  routeId: "/$lang/_app/_auth/settings",
  staticData: { pendingFrame: "settings" as const },
};
const SECURITY = {
  routeId: "/$lang/_app/_auth/settings/security",
  staticData: { pendingShape: "form" as const },
};

const AUTH = { routeId: "/$lang/_app/_auth" };
const KB = {
  routeId: "/$lang/_app/_auth/kbs/$kbId",
  staticData: { pendingFrame: "kb" as const, pendingShape: "detail" as const },
};
const KB_SETTINGS = {
  routeId: "/$lang/_app/_auth/kbs/$kbId/settings",
  staticData: { pendingShape: "form" as const },
};

describe("resolvePendingLayout", () => {
  it("draws every frame below the pending boundary and the leaf's shape", () => {
    expect(resolvePendingLayout([ROOT, LANG, APP, ADMIN, USERS], APP.routeId)).toEqual({
      shape: "list",
      width: "wide",
      frames: ["admin"],
      contained: false,
    });
  });

  it("leaves out frames that are already on screen above the boundary", () => {
    expect(resolvePendingLayout([ROOT, LANG, APP, ADMIN, USERS], USERS.routeId)).toEqual({
      shape: "list",
      width: "wide",
      frames: [],
      contained: false,
    });
  });

  it("puts a settings form inside the settings frame", () => {
    expect(resolvePendingLayout([ROOT, LANG, APP, SETTINGS, SECURITY], APP.routeId)).toEqual({
      shape: "form",
      width: "default",
      frames: ["settings"],
      contained: false,
    });
  });

  it("draws a KB's breadcrumbs frame around the KB page, the leaf's shape winning", () => {
    expect(resolvePendingLayout([ROOT, LANG, APP, AUTH, KB, KB_SETTINGS], AUTH.routeId)).toEqual({
      shape: "form",
      width: "default",
      frames: ["kb"],
      contained: false,
    });
    expect(resolvePendingLayout([ROOT, LANG, APP, AUTH, KB], KB.routeId)).toEqual({
      shape: "detail",
      width: "default",
      frames: ["kb"],
      contained: false,
    });
  });

  it("adds no page container inside a settings or KB layout that is already on screen", () => {
    expect(
      resolvePendingLayout([ROOT, LANG, APP, AUTH, SETTINGS, SECURITY], SECURITY.routeId),
    ).toEqual({ shape: "form", width: "default", frames: [], contained: true });
    expect(
      resolvePendingLayout([ROOT, LANG, APP, AUTH, KB, KB_SETTINGS], KB_SETTINGS.routeId),
    ).toMatchObject({ frames: [], contained: true });
    // The admin layout draws only its sub-nav: its pages bring their own container.
    expect(resolvePendingLayout([ROOT, LANG, APP, ADMIN, USERS], USERS.routeId).contained).toBe(
      false,
    );
  });

  it("resolves a frame that depends on the page below the layout", () => {
    const KB_FN = { routeId: KB.routeId, staticData: { pendingFrame: kbPendingFrame } };
    const DOCUMENT = {
      routeId: "/$lang/_app/_auth/kbs/$kbId/documents",
      staticData: { pendingShape: "document" as const, pendingWidth: "full" as const },
    };
    expect(resolvePendingLayout([ROOT, APP, AUTH, KB_FN, DOCUMENT], AUTH.routeId)).toEqual({
      shape: "document",
      width: "full",
      frames: ["workspace"],
      contained: false,
    });
    expect(
      resolvePendingLayout([ROOT, APP, AUTH, KB_FN, KB_SETTINGS], AUTH.routeId).frames,
    ).toEqual(["kb"]);
    // The KB home (the layout is the leaf) is the workspace too.
    expect(resolvePendingLayout([ROOT, APP, AUTH, KB_FN], AUTH.routeId).frames).toEqual([
      "workspace",
    ]);
    expect(kbPendingFrame("/$lang/_app/_auth/kbs/$kbId/prs/$number")).toBe("kb");
    // The workspace already on screen draws the container: a document loading
    // inside it is the content alone.
    expect(
      resolvePendingLayout([ROOT, APP, AUTH, KB_FN, DOCUMENT], DOCUMENT.routeId),
    ).toMatchObject({ frames: [], contained: true });
  });

  it("falls back to a default-width list for routes that declare nothing", () => {
    expect(resolvePendingLayout([ROOT, LANG, APP], APP.routeId)).toEqual({
      shape: "list",
      width: "default",
      frames: [],
      contained: false,
    });
  });

  it("reads from the top when the boundary is unknown", () => {
    expect(resolvePendingLayout([ROOT, ADMIN, USERS], undefined).frames).toEqual(["admin"]);
    expect(resolvePendingLayout([ROOT, ADMIN, USERS], "/nowhere").frames).toEqual(["admin"]);
  });
});
