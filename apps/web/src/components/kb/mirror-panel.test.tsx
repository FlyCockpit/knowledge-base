import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MirrorStatusView,
  mirrorControls,
  mirrorFormIssues,
  splitHostKeys,
} from "@/components/kb/mirror-panel";

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

const HOST_KEY = `ssh-ed25519 ${"A".repeat(68)}`;
const key = (state: "ACTIVE" | "PENDING", n: number) => ({
  keyId: `key${n}`.padEnd(24, "0"),
  keyVersion: n,
  remoteVersion: n,
  state,
  url: `ssh://git@git.example.com/team/kb${n}.git`,
  hostKeys: [{ algorithm: "ssh-ed25519", key: HOST_KEY, fingerprint: `SHA256:host${n}` }],
  publicKey: `ssh-ed25519 PUBLIC${n}`,
  fingerprint: `SHA256:deploy${n}`,
  createdAt: "2026-09-26T00:00:00.000Z",
});
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

describe("mirror controls visibility", () => {
  it("is visible only with manage", () => {
    expect(mirrorControls(["read", "propose", "write", "review", "manage"]).visible).toBe(true);
    expect(mirrorControls(["read", "propose", "write", "review"]).visible).toBe(false);
    expect(mirrorControls([]).visible).toBe(false);
  });
});

describe("mirror configure form", () => {
  it("accepts one canonical ssh URL and full host public keys", () => {
    expect(
      mirrorFormIssues({ url: "ssh://git@git.example.com/team/kb.git", hostKeys: HOST_KEY }),
    ).toEqual([]);
  });
  it("rejects SCP syntax, fingerprint-only host keys and empty input", () => {
    expect(mirrorFormIssues({ url: "git@github.com:o/r.git", hostKeys: HOST_KEY })).toContain(
      "url",
    );
    expect(
      mirrorFormIssues({
        url: "ssh://git@git.example.com/team/kb.git",
        hostKeys: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
      }),
    ).toContain("hostKeys");
    expect(mirrorFormIssues({ url: "", hostKeys: "" })).toEqual(["url", "hostKeys"]);
  });
  it("splits one host key per line and drops blank lines", () => {
    expect(splitHostKeys(`${HOST_KEY}\n\n  ${HOST_KEY}  \n`)).toEqual([HOST_KEY, HOST_KEY]);
  });
});

describe("mirror status view", () => {
  it("shows public half, exact host keys with fingerprints, state and the compromise consequence", () => {
    const html = render(
      <MirrorStatusView
        status={{
          kbId: "a".repeat(24),
          state: "ACTIVE",
          remoteVersion: 1,
          active: key("ACTIVE", 1),
          pending: key("PENDING", 2),
          pushEnabled: false,
        }}
      />,
    );
    for (const text of [
      "ssh-ed25519 PUBLIC1",
      "ssh-ed25519 PUBLIC2",
      "SHA256:deploy1",
      "SHA256:host2",
      HOST_KEY,
      "ssh://git@git.example.com/team/kb1.git",
    ])
      expect(html).toContain(text);
    expect(html).toContain('data-testid="mirror-compromise-warning"');
    expect(html).toContain(enKb.settings.mirror.compromise.replaceAll("'", "&#x27;"));
    expect(html).toContain('data-state="ACTIVE"');
    expect(html).toContain('data-state="PENDING"');
    expect(html).not.toMatch(/PRIVATE KEY|ciphertext/i);
  });
  it("renders the disconnected state without keys", () => {
    const html = render(
      <MirrorStatusView
        status={{
          kbId: "a".repeat(24),
          state: "DISCONNECTED",
          remoteVersion: 3,
          active: null,
          pending: null,
          pushEnabled: false,
        }}
      />,
    );
    expect(html).toContain(enKb.settings.mirror.disconnected);
    expect(html).not.toContain("ssh-ed25519");
  });
});

it("shows unknown outcomes with explicit remote-inspection guidance", () => {
  const html = render(
    <MirrorStatusView
      status={{
        kbId: "a".repeat(24),
        state: "ACTIVE",
        remoteVersion: 1,
        active: key("ACTIVE", 1),
        pending: null,
        pushEnabled: true,
        lastAttempt: {
          attemptId: "fixture",
          state: "UNKNOWN",
          resultCode: "REMOTE_OUTCOME_UNKNOWN",
        },
      }}
    />,
  );
  expect(html).toContain(enKb.settings.mirror.attempts.UNKNOWN);
  expect(html).not.toContain("PRIVATE KEY");
});
