import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PERMISSION_BITS,
  PermissionChoices,
  PermissionSummary,
} from "@/components/kb/permission-descriptions";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb", "settings"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb, settings: enSettings } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const escaped = (text: string) => text.replaceAll("'", "&#x27;");
const bits = enSettings.credentials.picker.bits;

describe("member permission choices", () => {
  it("explains each permission with the API keys' wording, plus what is implied", () => {
    const html = wrap(<PermissionChoices value={["write"]} onChange={() => {}} />);
    for (const bit of PERMISSION_BITS) {
      expect(html).toContain(enKb.settings.bits[bit]);
      expect(html).toContain(escaped(bits[bit].description));
    }
    expect(html).toContain(enKb.settings.members.permissionsImplied);
    // Each box is described by its own line.
    const write = html.match(/<input[^>]*data-testid="permission-write"[^>]*>/)?.[0] ?? "";
    expect(write).toMatch(/checked=""/);
    expect(write).toMatch(/aria-describedby="[^"]+-write"/);
    // Its accessible name stays just the permission ("Read", "Write"...).
    expect(write).toMatch(/aria-labelledby="[^"]+-write-label"/);
    expect(html.match(/<input[^>]*data-testid="permission-read"[^>]*>/)?.[0]).not.toMatch(
      /checked=""/,
    );
  });

  it("summarises granted permissions in words, in picker order", () => {
    const html = wrap(<PermissionSummary bits={["write", "read"]} />);
    expect(html).toContain(escaped(bits.read.description));
    expect(html).toContain(escaped(bits.write.description));
    expect(html).not.toContain(escaped(bits.manage.description));
    expect(html.indexOf(enKb.settings.bits.read)).toBeLessThan(
      html.indexOf(enKb.settings.bits.write),
    );
  });
});
