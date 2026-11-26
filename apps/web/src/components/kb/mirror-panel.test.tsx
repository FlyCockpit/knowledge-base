import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import esKb from "@knowledge-base/locales/src/es-MX/kb.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  attemptResultKey,
  currentInspection,
  type MirrorInspectionLike,
  type MirrorStatusLike,
  MirrorStatusView,
  mirrorControls,
  mirrorErrorReason,
  mirrorNeedsPolling,
  mirrorViewState,
  pastedHostKeysValid,
  pushSummaryKey,
  setupApproval,
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
const kbId = "a".repeat(24);
const kb = { id: kbId, capabilities: ["manage"] };
const key = (state: "ACTIVE" | "PENDING", n: number, provider: "github" | null = null) => ({
  keyId: `key${n}`.padEnd(24, "0"),
  keyVersion: n,
  remoteVersion: n,
  state,
  url: provider
    ? `ssh://git@github.com/team/kb${n}.git`
    : `ssh://git@git.example.com/team/kb${n}.git`,
  hostKeys: [
    {
      algorithm: "ssh-ed25519",
      key: HOST_KEY,
      fingerprint: `SHA256:host${n}`,
      check: provider ? ("PUBLISHED" as const) : ("UNPINNED" as const),
    },
  ],
  publicKey: `ssh-ed25519 PUBLIC${n}`,
  fingerprint: `SHA256:deploy${n}`,
  createdAt: "2026-09-26T00:00:00.000Z",
  provider,
  deployKeyUrl: provider ? `https://github.com/team/kb${n}/settings/keys/new` : null,
});
const attempt = (action: "PUSH" | "ACTIVATE", state: string, resultCode: string | null = null) => ({
  attemptId: crypto.randomUUID(),
  action,
  state,
  resultCode,
  createdAt: "2026-09-26T00:00:00.000Z",
  finishedAt: state === "QUEUED" || state === "RESERVED" ? null : "2026-09-26T00:00:05.000Z",
});
const status = (over: Partial<MirrorStatusLike> = {}): MirrorStatusLike => ({
  kbId,
  state: "DISCONNECTED",
  remoteVersion: 0,
  active: null,
  pending: null,
  pushEnabled: false,
  lastAttempt: null,
  lastTest: null,
  lastPush: null,
  ...over,
});
const inspection = (over: Partial<MirrorInspectionLike> = {}): MirrorInspectionLike => ({
  url: "ssh://git@git.example.com/team/kb.git",
  host: "git.example.com",
  port: 22,
  provider: null,
  deployKeyUrl: null,
  fingerprintsSource: null,
  reachable: true,
  hostKeys: [
    { algorithm: "ssh-ed25519", key: HOST_KEY, fingerprint: "SHA256:h", check: "UNPINNED" },
  ],
  verdict: "CONFIRM",
  ...over,
});
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
const esc = (text: string) => text.replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
const view = (s: MirrorStatusLike) =>
  render(<MirrorStatusView kb={kb} status={s} onChange={() => {}} onRemove={() => {}} />);

describe("mirror controls visibility", () => {
  it("is visible only with manage", () => {
    expect(mirrorControls(["read", "propose", "write", "review", "manage"]).visible).toBe(true);
    expect(mirrorControls(["read", "propose", "write", "review"]).visible).toBe(false);
    expect(mirrorControls([]).visible).toBe(false);
  });
});

describe("mirror state machine", () => {
  it("no remote → setup", () => {
    expect(mirrorViewState(status()).kind).toBe("setup");
  });

  it.each([
    [null, "untested"],
    [attempt("ACTIVATE", "QUEUED"), "running"],
    [attempt("ACTIVATE", "RESERVED"), "running"],
    [attempt("ACTIVATE", "FAILED", "READ_ONLY_KEY"), "failed"],
    [attempt("ACTIVATE", "CANCELLED", "SUPERSEDED"), "interrupted"],
  ])("pending key with test %j → add-key/%s", (test, kind) => {
    const state = mirrorViewState(
      status({ state: "PENDING", pending: key("PENDING", 1), lastTest: test }),
    );
    expect(state).toMatchObject({ kind: "add-key", test: { kind } });
  });

  it("only a first key's failed test may be overridden, never past a host-key mismatch", () => {
    const first = (code: string) =>
      mirrorViewState(
        status({
          state: "PENDING",
          pending: key("PENDING", 1),
          lastTest: attempt("ACTIVATE", "FAILED", code),
        }),
      );
    expect(first("READ_ONLY_KEY")).toMatchObject({ test: { overridable: true } });
    expect(first("HOST_KEY_MISMATCH")).toMatchObject({ test: { overridable: false } });
    const rotation = mirrorViewState(
      status({
        state: "ACTIVE",
        active: key("ACTIVE", 1),
        pending: key("PENDING", 2),
        lastTest: attempt("ACTIVATE", "FAILED", "KEY_NOT_ADDED"),
      }),
    );
    expect(rotation).toMatchObject({
      kind: "connected",
      rotation: { test: { kind: "failed", overridable: false } },
    });
  });

  it("active key → connected, with pushing, last push and a just-verified next step", () => {
    const active = key("ACTIVE", 1);
    expect(
      mirrorViewState(
        status({
          state: "ACTIVE",
          active,
          lastAttempt: attempt("ACTIVATE", "COMPLETED", "VERIFIED"),
        }),
      ),
    ).toMatchObject({
      kind: "connected",
      justVerified: true,
      pushing: false,
      lastPush: null,
      rotation: null,
    });
    const push = attempt("PUSH", "RESERVED");
    expect(
      mirrorViewState(status({ state: "ACTIVE", active, lastAttempt: push, lastPush: push })),
    ).toMatchObject({
      pushing: true,
      justVerified: false,
    });
  });
});

describe("polling", () => {
  it("polls while any shown attempt can still change, including an older unknown push", () => {
    expect(mirrorNeedsPolling(status())).toBe(false);
    expect(mirrorNeedsPolling(status({ lastAttempt: attempt("ACTIVATE", "QUEUED") }))).toBe(true);
    expect(
      mirrorNeedsPolling(
        status({
          lastAttempt: attempt("ACTIVATE", "FAILED", "KEY_NOT_ADDED"),
          lastTest: attempt("ACTIVATE", "FAILED", "KEY_NOT_ADDED"),
          lastPush: attempt("PUSH", "UNKNOWN", "REMOTE_OUTCOME_UNKNOWN"),
        }),
      ),
    ).toBe(true);
    expect(
      mirrorNeedsPolling(
        status({
          lastAttempt: attempt("PUSH", "COMPLETED", "PUSHED"),
          lastPush: attempt("PUSH", "COMPLETED", "PUSHED"),
        }),
      ),
    ).toBe(false);
  });
});

describe("an inspection reply belongs to the URL in the field", () => {
  const data = inspection();
  it("applies while the field still holds the inspected URL", () => {
    expect(currentInspection(data, "git@h.example:o/r", " git@h.example:o/r ")).toBe(data);
  });
  it("is discarded once the URL is edited, even if the reply arrives later", () => {
    // Inspect A, edit to B before A's reply: A's result must never be approvable.
    expect(currentInspection(data, "git@a.example:o/r", "git@b.example:o/r")).toBeNull();
    expect(
      setupApproval(currentInspection(data, "a", "b"), { confirmed: true, pasted: null }),
    ).toBeNull();
    expect(currentInspection(undefined, "a", "a")).toBeNull();
    expect(currentInspection(data, undefined, "")).toBeNull();
  });
});

describe("setup approval", () => {
  it("approves a provider-verified remote with only its published keys", () => {
    const published = inspection({
      verdict: "PUBLISHED",
      provider: "github",
      hostKeys: [
        { algorithm: "ssh-ed25519", key: HOST_KEY, fingerprint: "SHA256:a", check: "PUBLISHED" },
        {
          algorithm: "ecdsa-sha2-nistp384",
          key: "ecdsa x",
          fingerprint: "SHA256:b",
          check: "UNPINNED",
        },
      ],
    });
    expect(setupApproval(published, { confirmed: false, pasted: null })).toEqual({
      hostKeys: [HOST_KEY],
      hostKeyCheck: "PUBLISHED",
    });
  });
  it("never approves a mismatch, even with pasted keys", () => {
    expect(
      setupApproval(inspection({ verdict: "MISMATCH" }), { confirmed: true, pasted: HOST_KEY }),
    ).toBeNull();
  });
  it("needs the explicit confirmation for any other host (no trust on first use)", () => {
    expect(setupApproval(inspection(), { confirmed: false, pasted: null })).toBeNull();
    expect(setupApproval(inspection(), { confirmed: true, pasted: null })).toEqual({
      hostKeys: [HOST_KEY],
      hostKeyCheck: "CONFIRMED",
    });
    expect(
      setupApproval(inspection({ verdict: "UNREACHABLE", hostKeys: [] }), {
        confirmed: true,
        pasted: null,
      }),
    ).toBeNull();
  });
  it("accepts pasted full keys as an explicit approval", () => {
    const unreachable = inspection({ verdict: "UNREACHABLE", hostKeys: [], reachable: false });
    expect(setupApproval(unreachable, { confirmed: false, pasted: `${HOST_KEY}\n` })).toEqual({
      hostKeys: [HOST_KEY],
      hostKeyCheck: "CONFIRMED",
    });
    expect(
      setupApproval(unreachable, {
        confirmed: false,
        pasted: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
      }),
    ).toBeNull();
    expect(setupApproval(null, { confirmed: true, pasted: null })).toBeNull();
  });
  it("splits one host key per line", () => {
    expect(splitHostKeys(`${HOST_KEY}\n\n  ${HOST_KEY}  \n`)).toEqual([HOST_KEY, HOST_KEY]);
    expect(pastedHostKeysValid(Array(9).fill(HOST_KEY).join("\n"))).toBe(false);
  });
});

describe("outcome wording", () => {
  it.each([
    [{ state: "QUEUED", resultCode: null }, "running"],
    [{ state: "FAILED", resultCode: "KEY_NOT_ADDED" }, "KEY_NOT_ADDED"],
    [{ state: "FAILED", resultCode: "PUSH_REJECTED" }, "other"],
    [{ state: "FAILED", resultCode: "SOMETHING_NEW" }, "other"],
    [{ state: "COMPLETED", resultCode: "RECONCILED" }, "RECONCILED"],
    [{ state: "UNKNOWN", resultCode: "REMOTE_OUTCOME_UNKNOWN" }, "unknown"],
    [{ state: "CANCELLED", resultCode: "SUPERSEDED" }, "cancelled"],
  ])("%j → %s", (input, expected) => {
    expect(attemptResultKey(input)).toBe(expected);
  });
  it("every result and reason key exists in every shipped locale", () => {
    const keys = [
      "running",
      "pushing",
      "VERIFIED",
      "PUSHED",
      "RECONCILED",
      "HOST_KEY_MISMATCH",
      "KEY_NOT_ADDED",
      "REPO_NOT_FOUND",
      "READ_ONLY_KEY",
      "REMOTE_DIVERGED",
      "NETWORK_UNAVAILABLE",
      "interrupted",
      "cancelled",
      "unknown",
      "other",
    ];
    for (const bundle of [enKb, esKb]) {
      const mirror = bundle.settings.mirror as unknown as Record<string, Record<string, unknown>>;
      for (const k of keys) expect(mirror.results![k], k).toEqual(expect.any(String));
      for (const p of ["github", "gitlab", "bitbucket", "other"])
        expect(mirror.providerSteps![p]).toHaveLength(3);
      for (const r of [
        "NOT_A_GIT_URL",
        "SSH_USER_NOT_GIT",
        "HTTPS_PORT",
        "PRIVATE_NETWORK_HOST",
        "HOST_NOT_FOUND",
        "HOST_KEY_MISMATCH",
        "HOST_KEYS_UNCONFIRMED",
      ])
        expect(mirror.reasons![r], r).toEqual(expect.any(String));
    }
  });
  it("names only closed-set server reasons", () => {
    expect(mirrorErrorReason({ data: { reason: "HOST_NOT_FOUND" } })).toBe("HOST_NOT_FOUND");
    expect(mirrorErrorReason({ data: { reason: "<script>" } })).toBeNull();
    expect(mirrorErrorReason(new Error("x"))).toBeNull();
  });
});

describe("rendered states", () => {
  it("setup shows the next step and the remote step, no key material", () => {
    const html = view(status());
    expect(html).toContain('data-testid="mirror-setup"');
    expect(html).toContain(esc(enKb.settings.mirror.setupIntro));
    expect(html).toContain('data-testid="mirror-inspect"');
    expect(html).not.toContain("PRIVATE KEY");
  });

  it("add-key shows the public key, provider link and steps, calm key guidance and the test", () => {
    const html = view(status({ state: "PENDING", pending: key("PENDING", 1, "github") }));
    expect(html).toContain("ssh-ed25519 PUBLIC1");
    expect(html).toContain('href="https://github.com/team/kb1/settings/keys/new"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('data-provider="github"');
    expect(html).toContain("Allow write access");
    // The security note is guidance, not an error.
    expect(html).toMatch(/data-testid="mirror-key-guidance" data-tone="info"/);
    expect(html).not.toMatch(/data-testid="mirror-key-guidance"[^>]*role="alert"/);
    expect(html).toContain('data-testid="mirror-test"');
    expect(html).toContain(esc(enKb.settings.mirror.addKeyIntro));
    expect(html).not.toContain('data-testid="mirror-override"');
  });

  it("a failed test explains what to do and offers the confirmed override", () => {
    const html = view(
      status({
        state: "PENDING",
        pending: key("PENDING", 1),
        lastTest: attempt("ACTIVATE", "FAILED", "READ_ONLY_KEY"),
      }),
    );
    expect(html).toContain('data-code="READ_ONLY_KEY"');
    expect(html).toContain(esc(enKb.settings.mirror.results.READ_ONLY_KEY));
    expect(html).toContain('data-testid="mirror-override"');
    expect(html).toContain('data-provider="other"');
  });

  it("Bitbucket gets account-key guidance and no deploy-key link", () => {
    const pending = { ...key("PENDING", 1), provider: "bitbucket" as const, deployKeyUrl: null };
    const html = view(status({ state: "PENDING", pending }));
    expect(html).toContain('data-provider="bitbucket"');
    expect(html).toContain("read-only");
    expect(html).not.toContain("settings/keys/new");
  });

  it("connected shows the behaviour, the next step and the three actions", () => {
    const html = view(
      status({ state: "ACTIVE", active: key("ACTIVE", 1, "github"), pushEnabled: true }),
    );
    expect(html).toContain('data-testid="mirror-connected"');
    expect(html).toContain("Connected to GitHub");
    expect(html).toContain(esc(enKb.settings.mirror.behaviour));
    expect(html).toContain(esc(enKb.settings.mirror.noPushYet));
    for (const id of ["mirror-push", "mirror-rotate", "mirror-disconnect"])
      expect(html).toContain(`data-testid="${id}"`);
    // The active public key stays copyable (needed after an override).
    expect(html).toContain("ssh-ed25519 PUBLIC1");
  });

  it("a failed push states the error in plain words", () => {
    const push = attempt("PUSH", "FAILED", "REMOTE_DIVERGED");
    const html = view(
      status({
        state: "ACTIVE",
        active: key("ACTIVE", 1),
        pushEnabled: true,
        lastAttempt: push,
        lastPush: push,
      }),
    );
    expect(html).toContain('data-code="REMOTE_DIVERGED"');
    expect(html).toContain(esc(enKb.settings.mirror.results.REMOTE_DIVERGED));
  });

  it("an uncertain push is never summarised as failed", () => {
    expect(["COMPLETED", "FAILED", "UNKNOWN", "CANCELLED"].map(pushSummaryKey)).toEqual([
      "ok",
      "failed",
      "unknown",
      "cancelled",
    ]);
    const push = attempt("PUSH", "UNKNOWN", "REMOTE_OUTCOME_UNKNOWN");
    const html = view(
      status({
        state: "ACTIVE",
        active: key("ACTIVE", 1),
        pushEnabled: true,
        lastAttempt: push,
        lastPush: push,
      }),
    );
    expect(html).toContain(enKb.settings.mirror.lastPushSummary.unknown);
    expect(html).not.toContain(` · ${enKb.settings.mirror.lastPushSummary.failed}`);
    expect(html).toContain(esc(enKb.settings.mirror.results.unknown));
  });

  it("an in-flight push shows as pushing even when a later test is newer", () => {
    const state = mirrorViewState(
      status({
        state: "ACTIVE",
        active: key("ACTIVE", 1),
        pending: key("PENDING", 2),
        lastAttempt: attempt("ACTIVATE", "QUEUED"),
        lastPush: attempt("PUSH", "RESERVED"),
      }),
    );
    expect(state).toMatchObject({ kind: "connected", pushing: true });
  });

  it("rotation keeps the card and adds the new key's steps", () => {
    const html = view(
      status({
        state: "ACTIVE",
        active: key("ACTIVE", 1),
        pending: key("PENDING", 2),
        pushEnabled: true,
      }),
    );
    expect(html).toContain('data-testid="mirror-rotation"');
    expect(html).toContain("ssh-ed25519 PUBLIC2");
    expect(html).not.toContain('data-testid="mirror-rotate"');
  });
});
