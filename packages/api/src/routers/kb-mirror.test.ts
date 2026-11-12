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
vi.mock("../lib/kb/mirror", async (original) => ({
  ...(await original<typeof import("../lib/kb/mirror")>()),
  getMirrorStatus: vi.fn(),
  configureMirror: vi.fn(),
  rotateMirrorKey: vi.fn(),
  disconnectMirror: vi.fn(),
  queueMirrorAttempt: vi.fn(),
}));

import {
  configureMirror,
  disconnectMirror,
  getMirrorStatus,
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
  hostKeys: [{ algorithm: "ssh-ed25519", key: "ssh-ed25519 AAAA", fingerprint: "SHA256:x" }],
  publicKey: "ssh-ed25519 AAAA",
  fingerprint: "SHA256:y",
  createdAt: "2026-09-26T00:00:00.000Z",
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
        idempotencyKey: randomUUID(),
      }),
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
      "push",
      "rotate",
      "status",
    ]);
    expect(getMirrorStatus).not.toHaveBeenCalled();
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
  });

  it("scrubs exception data", async () => {
    const client = createRouterClient(kbMirrorRouter, { context: () => context });
    vi.mocked(rotateMirrorKey).mockRejectedValue(new Error("-----BEGIN OPENSSH PRIVATE KEY-----"));
    await expect(client.rotate({ kbId, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Mirror operation unavailable",
    });
  });

  it("names the private-network egress block and nothing else (R2-18)", async () => {
    const client = createRouterClient(kbMirrorRouter, { context: () => context });
    const input = {
      kbId,
      url: "ssh://git@127.0.0.1:2222/e2e/mirror.git",
      hostKeys: ["ssh-ed25519 AAAA"],
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
