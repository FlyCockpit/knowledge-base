import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import type { Context } from "../context";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("@knowledge-base/env/shared", () => ({
  env: { KB_MASTER_KEY: new Secret("fixture-master") },
}));
vi.mock("../lib/kb/runtime", () => ({ getKbRuntime: () => ({}) }));
const inspectBudget = vi.hoisted(() => vi.fn(async (_key: string) => {}));
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => inspectBudget }));
vi.mock("../lib/kb/mirror", async (original) => ({
  ...(await original<typeof import("../lib/kb/mirror")>()),
  getMirrorStatus: vi.fn(),
  configureMirror: vi.fn(),
  rotateMirrorKey: vi.fn(),
  disconnectMirror: vi.fn(),
  queueMirrorAttempt: vi.fn(),
  inspectMirrorRemote: vi.fn(),
  enableUntestedMirror: vi.fn(),
}));

import {
  configureMirror,
  disconnectMirror,
  enableUntestedMirror,
  getMirrorStatus,
  inspectMirrorRemote,
  rotateMirrorKey,
} from "../lib/kb/mirror";
import { KB_TOOL_NAMES } from "../lib/kb/protocol/catalog";
import { kbMirrorRouter } from "./kb-mirror";

const kbId = "a".repeat(24);
const context = {
  session: { user: { id: "owner", role: "user", twoFactorEnabled: true } },
} as Context;
const keyView = {
  keyId: "k".repeat(24),
  keyVersion: 1,
  remoteVersion: 1,
  state: "PENDING" as const,
  url: "ssh://git@git.example.com/o/r.git",
  hostKeys: [
    {
      algorithm: "ssh-ed25519",
      key: "ssh-ed25519 AAAA",
      fingerprint: "SHA256:x",
      check: "UNPINNED" as const,
    },
  ],
  publicKey: "ssh-ed25519 AAAA",
  fingerprint: "SHA256:y",
  createdAt: "2026-09-26T00:00:00.000Z",
  provider: null,
  deployKeyUrl: null,
};
const status = {
  kbId,
  state: "PENDING" as const,
  remoteVersion: 0,
  active: null,
  pending: keyView,
  pushEnabled: false as const,
  lastAttempt: null,
};

describe("human mirror controls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies anonymous calls including activate/push and exposes no private-key route", async () => {
    const client = createRouterClient(kbMirrorRouter, { context: () => ({ session: null }) });
    await expect(client.status({ kbId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      client.configure({
        kbId,
        url: keyView.url,
        hostKeys: ["ssh-ed25519 AAAA"],
        hostKeyCheck: "CONFIRMED",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.inspect({ kbId, url: keyView.url })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      client.enableUntested({ kbId, keyId: keyView.keyId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.rotate({ kbId, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.disconnect({ kbId, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.activate({ kbId, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.push({ kbId, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(Object.keys(kbMirrorRouter).sort()).toEqual([
      "activate",
      "configure",
      "disconnect",
      "enableUntested",
      "inspect",
      "push",
      "rotate",
      "status",
    ]);
    expect(getMirrorStatus).not.toHaveBeenCalled();
    expect(inspectMirrorRemote).not.toHaveBeenCalled();
    expect(inspectBudget).not.toHaveBeenCalled();
  });

  it("passes the browser principal and master key; serialized responses never carry key material", async () => {
    const client = createRouterClient(kbMirrorRouter, { context: () => context });
    const leaky = {
      operationId: randomUUID(),
      mirror: {
        ...status,
        ciphertext: "LEAK-ciphertext",
        pending: { ...keyView, ciphertext: "LEAK-ciphertext", privateKey: "LEAK-private" },
      },
      privateKey: "LEAK-private",
    };
    vi.mocked(configureMirror).mockResolvedValue(leaky as never);
    const input = {
      kbId,
      url: keyView.url,
      hostKeys: ["ssh-ed25519 AAAA"],
      hostKeyCheck: "CONFIRMED" as const,
      idempotencyKey: randomUUID(),
    };
    const result = await client.configure(input);
    expect(configureMirror).toHaveBeenCalledWith(
      {},
      { kind: "browser", userId: "owner" },
      input,
      "fixture-master",
    );
    expect(JSON.stringify(result)).not.toContain("LEAK");
    expect(result.mirror.pending?.publicKey).toBe(keyView.publicKey);

    vi.mocked(getMirrorStatus).mockResolvedValue({ ...status, seed: "LEAK" } as never);
    expect(JSON.stringify(await client.status({ kbId }))).not.toContain("LEAK");
    vi.mocked(rotateMirrorKey).mockResolvedValue(leaky as never);
    expect(
      JSON.stringify(await client.rotate({ kbId, idempotencyKey: randomUUID() })),
    ).not.toContain("LEAK");
    vi.mocked(disconnectMirror).mockResolvedValue(leaky as never);
    expect(
      JSON.stringify(await client.disconnect({ kbId, idempotencyKey: randomUUID() })),
    ).not.toContain("LEAK");
    vi.mocked(enableUntestedMirror).mockResolvedValue(leaky as never);
    expect(
      JSON.stringify(
        await client.enableUntested({ kbId, keyId: keyView.keyId, idempotencyKey: randomUUID() }),
      ),
    ).not.toContain("LEAK");
  });

  it("charges the per-user remote-check budget before inspecting and projects only public fields", async () => {
    const client = createRouterClient(kbMirrorRouter, { context: () => context });
    vi.mocked(inspectMirrorRemote).mockResolvedValue({
      url: keyView.url,
      host: "git.example.com",
      port: 22,
      provider: null,
      deployKeyUrl: null,
      fingerprintsSource: null,
      reachable: true,
      hostKeys: keyView.hostKeys,
      verdict: "CONFIRM",
      banner: "LEAK-banner",
    } as never);
    const result = await client.inspect({ kbId, url: "git@git.example.com:o/r" });
    expect(inspectBudget).toHaveBeenCalledWith("owner");
    expect(inspectMirrorRemote).toHaveBeenCalledWith(
      {},
      { kind: "browser", userId: "owner" },
      { kbId, url: "git@git.example.com:o/r" },
    );
    expect(result.verdict).toBe("CONFIRM");
    expect(JSON.stringify(result)).not.toContain("LEAK");
    inspectBudget.mockRejectedValueOnce(new Error("over budget"));
    vi.mocked(inspectMirrorRemote).mockClear();
    await expect(client.inspect({ kbId, url: keyView.url })).rejects.toBeDefined();
    expect(inspectMirrorRemote).not.toHaveBeenCalled();
  });

  it("scrubs exception data", async () => {
    const client = createRouterClient(kbMirrorRouter, { context: () => context });
    vi.mocked(rotateMirrorKey).mockRejectedValue(new Error("-----BEGIN OPENSSH PRIVATE KEY-----"));
    await expect(client.rotate({ kbId, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Mirror operation unavailable",
    });
  });

  it.each([
    ["NOT_A_GIT_URL", "notaurl"],
    ["SSH_USER_NOT_GIT", "root@git.example.com:o/r.git"],
    ["HTTPS_PORT", "https://git.example.com:3000/o/r"],
    ["PRIVATE_NETWORK_HOST", "https://10.1.2.3/o/r"],
  ])("names the %s refusal of a remote", async (reason, url) => {
    const client = createRouterClient(kbMirrorRouter, { context: () => context });
    const { normalizeMirrorRemote } = await import("../lib/kb/mirror-remote");
    vi.mocked(inspectMirrorRemote).mockImplementation(async (_r, _p, raw) => {
      normalizeMirrorRemote((raw as { url: string }).url);
      throw new Error("unreachable");
    });
    await expect(client.inspect({ kbId, url })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason },
    });
  });

  it("never names a reason outside the closed set", async () => {
    const client = createRouterClient(kbMirrorRouter, { context: () => context });
    const { KbDomainError } = await import("../lib/kb/errors");
    vi.mocked(inspectMirrorRemote).mockRejectedValue(
      new KbDomainError("INVALID_ARGUMENT", "x", undefined, { reason: "remote said: secret" }),
    );
    await expect(client.inspect({ kbId, url: keyView.url })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: undefined,
    });
  });

  it("names the private-network egress block and nothing else", async () => {
    const client = createRouterClient(kbMirrorRouter, { context: () => context });
    const input = {
      kbId,
      url: "ssh://git@127.0.0.1:2222/e2e/mirror.git",
      hostKeys: ["ssh-ed25519 AAAA"],
      hostKeyCheck: "CONFIRMED" as const,
      idempotencyKey: randomUUID(),
    };
    const { parseMirrorSshUrl } = await import("../lib/kb/ssh-url");
    vi.mocked(configureMirror).mockImplementation(async (_runtime, _principal, raw) => {
      parseMirrorSshUrl((raw as { url: string }).url);
      throw new Error("unreachable");
    });
    await expect(client.configure(input)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "PRIVATE_NETWORK_HOST" },
    });
    await expect(
      client.configure({ ...input, url: "ssh://git@github.com/no-git-suffix" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: undefined });
  });

  it("the MCP common catalog has no mirror tool", () => {
    expect(KB_TOOL_NAMES.filter((name) => /mirror|deploy|remote/i.test(name))).toEqual([]);
  });
});
