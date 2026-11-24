import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { gitCloneUrl, KbDownloadsView } from "@/components/kb/downloads";
import type { ExportJob } from "@/hooks/use-kb-export";

const KB = "e".repeat(24);
const job = (overrides: Partial<ExportJob> = {}): ExportJob => ({
  transferId: "0b4f7c3e-1f2a-4b3c-8d4e-5f6a7b8c9d0e",
  kind: "whole",
  rev: "abcdef1234".padEnd(40, "0"),
  state: "building",
  progress: { doneBytes: 50, totalBytes: 200 },
  size: null,
  contentHash: null,
  expiresAt: null,
  error: null,
  ...overrides,
});

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
        view={{ status: "idle", lookupFailed: false }}
        startError={null}
        starting={false}
        cancelling={false}
        cancelFailed={false}
        onExport={() => {}}
        onCancel={() => {}}
        onDownload={() => {}}
        onRetryLookup={() => {}}
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

  it("shows a preparing job's progress, keeps starts disabled and offers cancel", () => {
    const out = render({ view: { status: "preparing", job: job(), percent: 25 } });
    expect(out).toContain("Whole knowledge base ZIP at revision abcdef1");
    expect(out).toContain("Preparing the ZIP… 25%");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="25"');
    expect(out).toContain('role="status"');
    expect(out).toContain("Cancel export");
    expect(out).toContain("keeps preparing it if you close this page");
    expect(out.match(/<button[^>]*disabled=""/g)?.length).toBe(2);
  });

  it("a failed cancel is reported inline and the cancel button stays available to retry", () => {
    const view = { status: "preparing", job: job(), percent: 25 } as const;
    expect(render({ view })).not.toContain("Could not cancel the export");
    const out = render({ view, cancelFailed: true });
    expect(out).toContain('role="alert"');
    expect(out).toContain("Could not cancel the export. Try again.");
    expect(out).toContain("Cancel export");
    // The two start buttons stay disabled; cancel itself is enabled for the retry.
    expect(out.match(/<button[^>]*disabled=""/g)?.length).toBe(2);
  });

  it("an unknown total shows indeterminate progress", () => {
    const out = render({
      view: { status: "preparing", job: job({ state: "pending" }), percent: null },
    });
    expect(out).toContain("Preparing the ZIP…");
    expect(out).not.toContain("aria-valuenow");
  });

  it("a ready job is downloaded only by an explicit button, and can be discarded", () => {
    const ready = job({ state: "ready", size: 42, contentHash: `sha256:${"0".repeat(64)}` });
    const out = render({ view: { status: "ready", job: ready, download: null } });
    expect(out).toContain("The ZIP is ready to download (42 bytes).");
    expect(out).toContain("Download ZIP");
    expect(out).toContain("Discard");
    expect(out.match(/<button[^>]*disabled=""/g) ?? []).toHaveLength(0);
    const done = render({
      view: { status: "ready", job: ready, download: { status: "done", size: 42 } },
    });
    expect(done).toContain("Download ready (42 bytes).");
    expect(done).not.toContain("Download ZIP");
    expect(
      render({ view: { status: "ready", job: ready, download: { status: "expired" } } }),
    ).toMatch(/role="alert"[^>]*>[^<]*expired/);
  });

  it("a failed job names the reason and offers a retry", () => {
    const out = render({
      view: {
        status: "failed",
        job: job({
          state: "failed",
          error: { code: "DEADLINE_EXCEEDED", message: "server text" },
        }),
      },
    });
    expect(out).toMatch(/role="alert"[^>]*>The export took longer than its time limit/);
    expect(out).toContain("Try again");
    // An unknown code falls back to a generic storage message, never server text.
    const unknown = render({
      view: {
        status: "failed",
        job: job({ state: "failed", error: { code: "SOMETHING_NEW", message: "server text" } }),
      },
    });
    expect(unknown).toContain("Storage was unavailable");
    expect(unknown).not.toContain("server text");
  });

  it("shows cancelled, expired, capacity and lookup states", () => {
    expect(render({ view: { status: "cancelled", job: job({ state: "cancelled" }) } })).toContain(
      "Export cancelled.",
    );
    expect(render({ view: { status: "expired", job: job({ state: "expired" }) } })).toMatch(
      /role="alert"[^>]*>[^<]*expired/,
    );
    expect(render({ startError: "capacity" })).toContain("Another export is still being prepared");
    expect(render({ startError: "other" })).toContain("Couldn&#x27;t prepare the download");
    expect(render({ view: { status: "idle", lookupFailed: true } })).toContain(
      "Couldn&#x27;t check for an earlier export.",
    );
    expect(render({ view: { status: "loading" } })).toContain("kb-downloads-loading");
  });
});
