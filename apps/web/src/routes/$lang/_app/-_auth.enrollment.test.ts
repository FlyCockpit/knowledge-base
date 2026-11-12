import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Both 2FA enrollment screens share `useTwoFactorEnrollment`; its request
// lifecycle (single-flight guard, retry after failure, verify blocked while
// enable is pending, six-digit codes) is covered in
// hooks/use-two-factor-enrollment.test.ts. These routes keep their components
// private for route splitting, so this checks the wiring from source: each
// screen uses the hook with its own copy and log scope, and neither keeps a
// second, drifting copy of the request code.
const SCREENS = [
  {
    path: "./_auth.tsx",
    logScope: '"_auth"',
    messages: [
      'startFailed: t("twoFactor.couldNotStartSetup")',
      'enabled: t("twoFactor.enabledSuccess")',
      'invalidCode: t("errors.invalidTotp")',
    ],
  },
  {
    path: "./_auth/settings/security.tsx",
    logScope: '"settings.security"',
    messages: [
      'startFailed: t("settings:security.couldNotStartSetup")',
      'enabled: t("settings:security.enabledSuccess")',
      'invalidCode: t("auth:errors.invalidTotp")',
    ],
  },
];

for (const screen of SCREENS) {
  describe(`2FA enrollment wiring in ${screen.path}`, () => {
    const source = readFileSync(new URL(screen.path, import.meta.url), "utf8");

    it("uses the shared hook with this screen's log scope and copy", () => {
      expect(source).toContain('from "@/hooks/use-two-factor-enrollment"');
      expect(source).toContain(`logScope: ${screen.logScope}`);
      for (const message of screen.messages) expect(source).toContain(message);
    });

    it("does not call the enrollment endpoints directly", () => {
      expect(source).not.toMatch(/twoFactor\.(enable|verifyTotp)\(/);
      expect(source).not.toContain("enrollmentPending");
    });
  });
}
