import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deviceSelection, digestDeviceCode, resolveDevicePlugins } from "./device-approval";

const empty = { scopes: ["mcp:read"], toolGroups: ["read"], acl: [] };
describe("device approval contract", () => {
  it("accepts explicit empty ACL with no implicit create or recipient capability", () => {
    expect(deviceSelection.parse(empty)).toEqual({
      ...empty,
      allowCreate: false,
      createdKbBits: [],
      recipients: [],
    });
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
