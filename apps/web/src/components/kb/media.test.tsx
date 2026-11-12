import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  ExternalMedia,
  kbAssetUrl,
  MediaEmbed,
  MissingAsset,
  resolveAssetDestination,
} from "@/components/kb/media";

const KB = "b".repeat(24);
const REV = "4".repeat(40);
const HASH = `sha256:${"c".repeat(64)}`;

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
const render = (node: ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

describe("resolveAssetDestination mirrors the server's reference resolution", () => {
  it.each([
    ["pic.png", "notes/a.md", "notes/pic.png"],
    ["./pic.png", "notes/a.md", "notes/pic.png"],
    ["../media/pic.png", "notes/deep/a.md", "notes/media/pic.png"],
    ["/media/pic.png", "notes/a.md", "media/pic.png"],
    ["media/my%20pic.png", "a.md", "media/my pic.png"],
    ["media/pic.png?x=1#frag", "a.md", "media/pic.png"],
    ["media/bad%zzname.png", "a.md", "media/bad%zzname.png"],
  ])("%s from %s -> %s", (destination, documentPath, expected) => {
    expect(resolveAssetDestination(destination, documentPath)).toBe(expected);
  });

  it.each([
    ["../../escape.png", "notes/a.md"],
    ["https://example.com/a.png", "a.md"],
    ["//example.com/a.png", "a.md"],
    ["data:image/png;base64,AA==", "a.md"],
    ["javascript%3Aalert(1)", "a.md"],
    ["#frag", "a.md"],
    ["", "a.md"],
  ])("%s is not a relative asset", (destination, documentPath) => {
    expect(resolveAssetDestination(destination, documentPath)).toBeNull();
  });
});

describe("kbAssetUrl", () => {
  it("builds the exact session-authenticated route", () => {
    expect(kbAssetUrl(KB, HASH, REV)).toBe(`/kb-assets/${KB}/${HASH}?rev=${REV}`);
  });

  it("refuses malformed identifiers instead of building a URL", () => {
    expect(() => kbAssetUrl("../x", HASH, REV)).toThrow();
    expect(() => kbAssetUrl(KB, "sha256:zz", REV)).toThrow();
    expect(() => kbAssetUrl(KB, HASH, "HEAD")).toThrow();
  });
});

describe("MediaEmbed", () => {
  const embed = (mime: string, path = "media/file") =>
    render(
      <MediaEmbed
        asset={{ path, hash: HASH, size: 1, mime }}
        url={kbAssetUrl(KB, HASH, REV)}
        alt="Described media"
      />,
    );

  it.each(["image/jpeg", "image/png", "image/gif", "image/webp"])(
    "%s renders an image with alt text",
    (mime) => {
      const out = embed(mime);
      expect(out).toMatch(/<img\b/);
      expect(out).toContain('alt="Described media"');
      expect(out).toContain(`src="/kb-assets/${KB}/${HASH}?rev=${REV}"`);
    },
  );

  it.each(["video/mp4", "video/webm"])("%s renders a video with controls", (mime) => {
    const out = embed(mime);
    expect(out).toMatch(/<video\b[^>]*\bcontrols=""/);
    expect(out).toContain('aria-label="Described media"');
    expect(out).not.toContain("autoPlay");
    expect(out).not.toContain("autoplay");
  });

  it.each(["audio/mpeg", "audio/wav", "audio/ogg"])("%s renders audio with controls", (mime) => {
    const out = embed(mime);
    expect(out).toMatch(/<audio\b[^>]*\bcontrols=""/);
    expect(out).toContain('aria-label="Described media"');
  });

  it("a PDF is a download link only, never inline", () => {
    const out = embed("application/pdf", "docs/report.pdf");
    expect(out).not.toMatch(/<(iframe|object|embed|img)\b/);
    expect(out).toMatch(/<a\b[^>]*\bdownload="report.pdf"/);
    expect(out).toContain("Download report.pdf (PDF)");
  });

  it.each(["image/svg+xml", "text/html", "application/octet-stream"])(
    "untrusted %s is not rendered inline and not requested",
    (mime) => {
      const out = embed(mime, "media/x");
      expect(out).not.toMatch(/<(img|video|audio|iframe|object|embed|a)\b/);
      expect(out).toContain('role="alert"');
    },
  );
});

describe("visible failure states", () => {
  it("missing asset is announced", () => {
    const out = render(<MissingAsset path="media/gone.png" />);
    expect(out).toContain('role="alert"');
    expect(out).toContain("Missing asset: media/gone.png");
  });

  it("external media shows alt text without a request", () => {
    const out = render(<ExternalMedia alt="remote chart" />);
    expect(out).toContain("External image not loaded: remote chart");
    expect(out).not.toMatch(/\s(src|href)=/);
  });
});
