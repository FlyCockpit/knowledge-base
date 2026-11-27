vi.mock("@knowledge-base/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deviceSelection, digestDeviceCode, resolveDevicePlugins } from "./device-approval";
import { authoringModeWithin, deviceWriteModeCeiling } from "./mcp-authoring-mode";

const empty = { scopes: ["mcp:read"], toolGroups: ["read"], acl: [] };
describe("device approval contract", () => {
  it("accepts explicit empty ACL with no implicit create or recipient capability", () => {
    expect(deviceSelection.parse(empty)).toEqual({
      ...empty,
      allowCreate: false,
      createdKbBits: [],
      authoringMode: null,
      recipients: [],
    });
  });
  it("requires a write mode with write access, within the CLI's requested ceiling", () => {
    expect(deviceSelection.safeParse({ ...empty, scopes: ["mcp:write"] }).success).toBe(false);
    expect(
      deviceSelection.parse({ ...empty, scopes: ["mcp:write"], authoringMode: "dream" })
        .authoringMode,
    ).toBe("dream");
    expect(deviceWriteModeCeiling("mcp:read mcp:write")).toBeNull();
    expect(deviceWriteModeCeiling("mcp:read mcp:write kb:write-mode:dream")).toBe("dream");
    expect(deviceWriteModeCeiling("mcp:write kb:write-mode:bogus")).toBeNull();
    expect(authoringModeWithin("dream", "both")).toBe(true);
    expect(authoringModeWithin("both", "dream")).toBe(false);
    expect(authoringModeWithin("edit", "dream")).toBe(false);
    expect(authoringModeWithin("edit", null)).toBe(true);
  });
  it("rejects unknown, offline, forged create, duplicate and wildcard authority", () => {
    for (const input of [
      { ...empty, scopes: ["offline_access"] },
      { ...empty, acl: [{ kbId: "*", bits: ["read"] }] },
      { ...empty, allowCreate: true, createdKbBits: ["read"] },
      { ...empty, createdKbBits: ["manage"] },
      { ...empty, scopes: ["mcp:read", "mcp:read"] },
      { ...empty, userId: "victim" },
      { ...empty, recipients: [{ recipientKeyId: randomUUID() }] },
      { scopes: ["mcp:read"], acl: [] },
      { ...empty, toolGroups: [] },
      { ...empty, toolGroups: ["everything"] },
    ])
      expect(deviceSelection.safeParse(input).success).toBe(false);
  });
  it("permits explicit write/create with read-only created KB bits", () => {
    expect(
      deviceSelection.parse({
        ...empty,
        scopes: ["mcp:write"],
        authoringMode: "edit",
        toolGroups: ["read", "kb_admin"],
        allowCreate: true,
        createdKbBits: ["read"],
      }).createdKbBits,
    ).toEqual(["read"]);
  });
  it("digests with a separate domain; plugin maps the stored field and hashes before adapter IO", async () => {
    const raw = "disposable-device-secret-for-unit-test";
    expect(digestDeviceCode(raw)).toMatch(/^[a-f0-9]{64}$/);
    expect(digestDeviceCode(raw)).not.toBe(raw);
    const plugins = resolveDevicePlugins({ baseUrl: "https://kb.invalid", db: {} as never });
    const plugin = plugins.find((p) => p.id === "device-authorization")!;
    const field = plugin.schema!.deviceCode!.fields.deviceCode!;
    expect(field.fieldName).toBe("deviceCodeDigest");
    expect(await field.transform!.input(raw)).toBe(digestDeviceCode(raw));
  });
});
