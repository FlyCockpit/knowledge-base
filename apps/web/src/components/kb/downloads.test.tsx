import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { gitCloneUrl, KbDownloadsView } from "@/components/kb/downloads";

const KB = "e".repeat(24);

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb", "common"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

function render(overrides: Partial<ComponentProps<typeof KbDownloadsView>> = {}) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <KbDownloadsView
        cloneUrl={gitCloneUrl("https://kb.example.com", KB)}
        state={{ status: "idle" }}
        onExport={() => {}}
        {...overrides}
      />
    </I18nextProvider>,
  );
}

describe("gitCloneUrl", () => {
  it("is the smart-HTTP repository URL for the KB id", () => {
    expect(gitCloneUrl("https://kb.example.com", KB)).toBe(`https://kb.example.com/git/${KB}.git`);
    expect(gitCloneUrl("https://kb.example.com/", KB)).toBe(`https://kb.example.com/git/${KB}.git`);
  });

  it("never carries credentials, a path, query or fragment from the origin", () => {
    expect(gitCloneUrl("https://user:kbp_secret@kb.example.com/x?token=kbp_1#y", KB)).toBe(
      `https://kb.example.com/git/${KB}.git`,
    );
  });

  it("refuses a malformed KB id", () => {
    expect(() => gitCloneUrl("https://kb.example.com", "../x")).toThrow();
  });
});

describe("KbDownloadsView", () => {
  it("offers both ZIP downloads and the clone URL with PAT-as-password guidance", () => {
    const out = render();
    expect(out).toContain("Download assets (ZIP)");
    expect(out).toContain("Download whole knowledge base (ZIP)");
    expect(out).toContain(`https://kb.example.com/git/${KB}.git`);
    expect(out).toContain("personal access token");
    expect(out).toContain("as the password");
    expect(out).not.toMatch(/kbp_/);
    // Buttons are real buttons (keyboard reachable), not click-only divs.
    expect(out.match(/<button\b/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("disables both downloads while one is being prepared and announces it", () => {
    const out = render({ state: { status: "preparing", kind: "assets" } });
    expect(out).toContain("Preparing the ZIP");
    expect(out).toContain('role="status"');
    expect(out.match(/<button[^>]*disabled=""/g)?.length).toBe(2);
  });

  it("shows expired and error states visibly", () => {
    expect(render({ state: { status: "expired", kind: "whole" } })).toMatch(
      /role="alert"[^>]*>[^<]*expired/,
    );
    expect(render({ state: { status: "error", kind: "whole" } })).toContain(
      "Couldn&#x27;t prepare the download",
    );
    expect(render({ state: { status: "done", kind: "whole", size: 42 } })).toContain(
      "Download ready (42 bytes).",
    );
  });
});
