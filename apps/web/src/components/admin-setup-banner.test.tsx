import enAdmin from "@knowledge-base/locales/src/en-US/admin.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shell's admin-setup banners: the ADMIN_EMAIL warning (unchanged) and the
 * SETUP_KEY reminder, shown to a verified admin while the server reports the
 * key set, hidden once it is removed, and never queried for anyone else.
 */
const fixture = vi.hoisted(() => ({
  setupKeySet: undefined as boolean | undefined,
  status: { adminEmailsEmpty: false, adminExists: true } as
    | { adminEmailsEmpty: boolean; adminExists: boolean }
    | undefined,
  role: "admin",
  emailVerified: true,
  degraded: false,
  setupKeyEnabled: [] as boolean[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: string; enabled?: boolean }) => {
    if (options.queryKey === "setupKeyStatus") {
      fixture.setupKeyEnabled.push(options.enabled === true);
      return {
        data:
          options.enabled && fixture.setupKeySet !== undefined
            ? { setupKeySet: fixture.setupKeySet }
            : undefined,
      };
    }
    return {
      data: options.enabled ? fixture.status : undefined,
      isPending: !options.enabled || fixture.status === undefined,
      isError: false,
      refetch: () => {},
    };
  },
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    settings: {
      adminSetupStatus: { queryOptions: () => ({ queryKey: "adminSetupStatus" }) },
      setupKeyStatus: { queryOptions: () => ({ queryKey: "setupKeyStatus" }) },
    },
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: {
      status: "authenticated",
      session: {
        user: { role: fixture.role, emailVerified: fixture.emailVerified },
        session: { id: "s1" },
      },
    },
    meta: { isDegraded: fixture.degraded },
  }),
}));

const { AdminSetupBanner } = await import("./admin-setup-banner");
const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { admin: enAdmin } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

beforeEach(() => {
  fixture.setupKeySet = undefined;
  fixture.status = { adminEmailsEmpty: false, adminExists: true };
  fixture.role = "admin";
  fixture.emailVerified = true;
  fixture.degraded = false;
  fixture.setupKeyEnabled = [];
});

function render(): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <AdminSetupBanner />
    </I18nextProvider>,
  );
}

describe("AdminSetupBanner — SETUP_KEY reminder", () => {
  it("warns an admin while SETUP_KEY is set", () => {
    fixture.setupKeySet = true;
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Remove SETUP_KEY");
    expect(html).toContain('<code class="font-mono">SETUP_KEY</code> is still set on the server.');
  });

  it("is gone once SETUP_KEY is removed", () => {
    fixture.setupKeySet = false;
    expect(render()).toBe("");
  });

  it("renders nothing while the answer is loading", () => {
    expect(render()).toBe("");
  });

  it("shows even while the admin-setup status is still loading", () => {
    fixture.setupKeySet = true;
    fixture.status = undefined;
    expect(render()).toContain("Remove SETUP_KEY");
  });

  it("never asks the server for a non-admin, an unverified admin, or a degraded session", () => {
    fixture.setupKeySet = true;
    for (const setup of [
      () => {
        fixture.role = "user";
      },
      () => {
        fixture.emailVerified = false;
      },
      () => {
        fixture.degraded = true;
      },
    ]) {
      fixture.role = "admin";
      fixture.emailVerified = true;
      fixture.degraded = false;
      fixture.setupKeyEnabled = [];
      setup();
      expect(render()).not.toContain("Remove SETUP_KEY");
      expect(fixture.setupKeyEnabled).toEqual([false]);
    }
  });

  it("counts a multi-role value that includes admin", () => {
    fixture.setupKeySet = true;
    fixture.role = "user, Admin";
    expect(render()).toContain("Remove SETUP_KEY");
  });

  it("stacks under the ADMIN_EMAIL warning instead of replacing it", () => {
    fixture.setupKeySet = true;
    fixture.status = { adminEmailsEmpty: true, adminExists: false };
    const html = render();
    expect(html).toContain("No administrators configured");
    expect(html).toContain("Remove SETUP_KEY");
    expect(html.indexOf("No administrators configured")).toBeLessThan(
      html.indexOf("Remove SETUP_KEY"),
    );
  });
});
