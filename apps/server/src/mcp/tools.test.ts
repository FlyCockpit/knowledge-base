import { KB_TOOL_GROUPS, KB_TOOL_NAMES } from "@knowledge-base/api/lib/kb/protocol/catalog";
import fixtures from "@knowledge-base/api/lib/kb/protocol/fixtures.json";
import schema from "@knowledge-base/api/lib/kb/protocol/schema.json";
import { describe, expect, it, vi } from "vitest";
import { createAdmissionGate } from "./admission";
import { type BearerAdmission, bindBearerAdmission } from "./context";
import { buildDiscovery, type DiscoveryInputs } from "./discovery";
import { createMcpEndpoint } from "./handler";
import { validateToolCall } from "./tools";

const admission = {
  generationActive: true,
  instanceEnabled: true,
  expired: false,
  banned: false,
  twoFactorSatisfied: true,
  toolGroups: [...KB_TOOL_GROUPS],
};
const actor: BearerAdmission = bindBearerAdmission(
  {
    kind: "token",
    userId: "fixture",
    grantId: "fixture",
    grantGeneration: "fixture",
    scopes: ["mcp:write"],
    expiresAt: new Date("2099-01-01"),
    storedAcl: new Map(),
  },
  { inspect: async () => admission },
);
function request(
  name?: string,
  args: unknown = {},
  client: { name: string; capabilities: unknown } = { name: "fixture", capabilities: {} },
) {
  const method = name ? "tools/call" : "tools/list";
  return new Request("https://kb.example.invalid/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...(name ? { name, arguments: args } : {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: client.name, version: "1" },
          "io.modelcontextprotocol/clientCapabilities": client.capabilities,
        },
      },
    }),
  });
}

const allGroups = async (): Promise<DiscoveryInputs> => ({
  toolGroups: [...KB_TOOL_GROUPS],
  scopes: ["mcp:write"],
  aclBits: ["manage"],
  allowCreate: true,
  createdKbBits: ["read", "manage"],
  // No KB mapping (as above the enum cap), so every schema is the pinned contract.
  kbs: null,
});

describe("complete MCP catalog", () => {
  it("lists exactly the contract schemas, excludes controls and uses envelope output schemas", async () => {
    const endpoint = createMcpEndpoint({
      admit: async () => actor,
      origin: "https://kb.example.invalid",
      gate: createAdmissionGate(),
      discover: async (_actor, publish) => publish(buildDiscovery(await allGroups())),
    });
    try {
      const response = await endpoint.fetch(request());
      const body = (await response.json()) as {
        result: {
          tools: {
            name: keyof typeof schema.tools;
            inputSchema: { additionalProperties: boolean };
            outputSchema: { properties: { data: unknown } };
          }[];
        };
      };
      expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        ...KB_TOOL_NAMES,
      ]);
      for (const tool of body.result.tools) {
        const contract = schema.tools[tool.name as keyof typeof schema.tools];
        expect(tool.inputSchema).toEqual(contract.input);
        expect(tool.outputSchema.properties.data).toEqual(contract.output);
        expect(tool.inputSchema.additionalProperties).toBe(false);
      }
      const unknown = await endpoint.fetch(request("kbs.shareInvite"));
      expect(await unknown.json()).toHaveProperty("error");
    } finally {
      await endpoint.close();
    }
  });
  it("rejects unknown fields and missing/mismatched confirmations before runtime access", async () => {
    const runtime = vi.fn(() => {
      throw new Error("must not touch storage");
    });
    const endpoint = createMcpEndpoint({
      admit: async () => actor,
      origin: "https://kb.example.invalid",
      gate: createAdmissionGate(),
      runtime,
    });
    try {
      for (const name of KB_TOOL_NAMES) {
        const fixture = fixtures.tools[name];
        const invalid = { ...fixture.validInput, actor: "forged" };
        const response = await endpoint.fetch(request(name, invalid));
        // The refusal names the unknown argument by pointer, never echoing a value.
        expect(
          (
            (await response.json()) as {
              result: { structuredContent: { error: { code: string; details: unknown } } };
            }
          ).result.structuredContent.error,
        ).toMatchObject({
          code: "INVALID_ARGUMENT",
          details: { reason: "UNKNOWN_ARGUMENT", field: "/actor" },
        });
        for (const bad of fixture.invalidInputs)
          expect(() => validateToolCall(name, bad.value)).toThrow();
        if ("confirm" in fixture.validInput) {
          const { confirm: _, ...missing } = fixture.validInput;
          expect(() => validateToolCall(name, missing)).toThrow();
        }
      }
      expect(runtime).not.toHaveBeenCalled();
    } finally {
      await endpoint.close();
    }
  });
});

describe("reasons for every client", () => {
  it("names the argument and why, whoever the client is", async () => {
    const endpoint = createMcpEndpoint({
      admit: async () => actor,
      origin: "https://kb.example.invalid",
      gate: createAdmissionGate(),
      runtime: vi.fn(() => {
        throw new Error("must not touch storage");
      }),
    });
    const details = async (client: { name: string; capabilities: unknown }) =>
      (
        (await (
          await endpoint.fetch(request("knowledge_bases_list", { unknown: 1 }, client))
        ).json()) as { result: { structuredContent: { error: { details: unknown } } } }
      ).result.structuredContent.error.details;
    try {
      const reason = { reason: "UNKNOWN_ARGUMENT", field: "/unknown" };
      for (const name of ["kb-cli", "kb-client", "Claude"])
        expect(await details({ name, capabilities: {} })).toEqual(reason);
    } finally {
      await endpoint.close();
    }
  });
});
