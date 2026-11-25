import type { McpAuthoringMode } from "@knowledge-base/auth/mcp-authoring-mode";
import { MCP_TOOL_GROUPS, type McpToolGroup } from "@knowledge-base/auth/mcp-tool-groups";

import { allowedKbBits, expandKbBits, type KbBit } from "@/hooks/use-mcp-consent";
import { MCP_TOOLS } from "@/lib/mcp-tools";

/**
 * Copy-paste setup for MCP clients and the REST control plane, shown on
 * Settings → MCP access and API keys (docs/mcp.md, docs/rest-api.md).
 *
 * Secrets never go into argv or shell history (docs/mcp.md): token snippets
 * read the secret into an environment variable with `read -rs`, and the
 * clients expand that variable when they connect. Only the JSON for a
 * client's private config file carries the literal token.
 */

/** The name the snippets register this server under (as in docs/mcp.md). */
export const MCP_SERVER_NAME = "kb";
/** Where token snippets keep an MCP token. */
export const MCP_TOKEN_ENV = "KB_MCP_TOKEN";
/** Where the REST snippets keep an API key. */
export const API_KEY_ENV = "KB_API_KEY";
/** The one MCP wire profile the server speaks (docs/mcp.md, "Wire profile"). */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

const DOCS_BASE = "https://github.com/FlyCockpit/knowledge-base/blob/main/docs";
/** The operator and integrator guides, in the public repository. */
export const KB_DOCS = {
  mcp: `${DOCS_BASE}/mcp.md`,
  restApi: `${DOCS_BASE}/rest-api.md`,
} as const;

/** This server's MCP endpoint: only the origin of `serverUrl` survives. */
export function mcpServerUrl(serverUrl: string): string {
  return `${new URL(serverUrl).origin}/mcp`;
}

/** The OpenAPI document of the REST control plane (served without a credential). */
export function restApiOpenApiUrl(serverUrl: string): string {
  return `${new URL(serverUrl).origin}/api/v1/openapi.json`;
}

/** Shell-quote one argument for a POSIX shell (single quotes unless it is plainly safe). */
function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Reads a secret into an exported variable without echoing it or recording it in history. */
function readSecret(envVar: string): string {
  return `read -rs ${envVar} && export ${envVar}`;
}

export type McpClient = "claude" | "codex" | "other";
export const MCP_CLIENTS: readonly McpClient[] = ["claude", "codex", "other"];

/**
 * The setup for one client. Without a token the client signs in with OAuth
 * (the browser approval page); with one it sends the token as a bearer header.
 */
export function mcpClientSnippet(client: McpClient, serverUrl: string, token?: string): string {
  const url = mcpServerUrl(serverUrl);
  const quoted = shellArg(url);
  switch (client) {
    case "claude": {
      const add = `claude mcp add --transport http ${MCP_SERVER_NAME} ${quoted}`;
      if (token === undefined) return add;
      // Single quotes: Claude Code stores `${KB_MCP_TOKEN}` and expands it when it connects.
      return `${readSecret(MCP_TOKEN_ENV)}\n${add} --header 'Authorization: Bearer \${${MCP_TOKEN_ENV}}'`;
    }
    case "codex":
      return token === undefined
        ? `codex mcp add ${MCP_SERVER_NAME} --url ${quoted}\ncodex mcp login ${MCP_SERVER_NAME}`
        : `${readSecret(MCP_TOKEN_ENV)}\ncodex mcp add ${MCP_SERVER_NAME} --url ${quoted} --bearer-token-env-var ${MCP_TOKEN_ENV}`;
    case "other":
      return JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: "http",
              url,
              ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
            },
          },
        },
        null,
        2,
      );
  }
}

/** Groups with a tool that changes data: a credential holding one needs `mcp:write`. */
const WRITE_GROUPS: ReadonlySet<McpToolGroup> = new Set(
  MCP_TOOLS.filter((tool) => !tool.readOnly).flatMap((tool) => tool.groups),
);

/** Whether these tool groups can change anything (then the credential writes and needs a write mode). */
export function groupsWrite(groups: readonly McpToolGroup[]): boolean {
  return groups.some((group) => WRITE_GROUPS.has(group));
}

/** The MCP scope the chosen tool groups need: write when any of them changes data. */
export function scopeForGroups(groups: readonly McpToolGroup[]): "mcp:read" | "mcp:write" {
  return groupsWrite(groups) ? "mcp:write" : "mcp:read";
}

/** What an API key lets its child tokens hold, as the key row reports it. */
export type ChildCeiling = {
  /** Where the key reaches: a key limited to KBs it creates must create one first. */
  reach: "all" | "selected" | "created";
  bits: readonly KbBit[];
  childToolGroups: readonly string[];
  childAuthoringMode: McpAuthoringMode | null;
};

/**
 * The JSON body of a child-token mint within the key's ceiling: its tool
 * groups without the opt-in ones (sealed values, KB admin), the key's bits
 * capped to those groups' preset, and the key's write mode.
 */
export function childMintBody(key: Omit<ChildCeiling, "reach">): Record<string, unknown> {
  const all = MCP_TOOL_GROUPS.filter((group) => key.childToolGroups.includes(group));
  const plain = all.filter((group) => group !== "sealed" && group !== "kb_admin");
  const toolGroups = plain.length > 0 ? plain : all;
  const allowed = allowedKbBits(toolGroups);
  const bits = expandKbBits(key.bits).filter((bit) => allowed.includes(bit));
  return {
    name: "My agent",
    bits: bits.length > 0 ? bits : ["read"],
    toolGroups,
    ...(key.childAuthoringMode && groupsWrite(toolGroups)
      ? { authoringMode: key.childAuthoringMode }
      : {}),
  };
}

const API_AUTH = "kb_auth";
/**
 * The REST preamble: read the key without echoing it, and a function that
 * prints its header with the shell's `printf` builtin, so `curl -H @-` reads
 * it from stdin and the key never appears in any process's arguments.
 */
function apiPreamble(): string[] {
  return [
    `read -rs ${API_KEY_ENV}`,
    `${API_AUTH}() { printf 'Authorization: Bearer %s\\n' "$${API_KEY_ENV}"; }`,
  ];
}
const jsonArg = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", `'\\''`)}'`;

/** Check what an API key may do (`GET /api/v1/key`). */
export function apiKeyCheckCommands(serverUrl: string): string {
  const api = `${new URL(serverUrl).origin}/api/v1`;
  return [...apiPreamble(), `${API_AUTH} | curl -sS -H @- "${api}/key"`].join("\n");
}

/** A random Idempotency-Key, made once per intended request (64 bits from /dev/urandom). */
const randomKey = (prefix: string) => `"${prefix}-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')"`;

/** What the person fills in where the commands can't know the knowledge base id (translated). */
export type MintPlaceholders = { listedId: string; createdId: string };

/**
 * Mint an MCP token for one of the key's knowledge bases: list them (or, for
 * a key limited to KBs it creates, create one), then mint with a fresh random
 * Idempotency-Key that only a retry of the same request reuses.
 */
export function childMintCommands(
  serverUrl: string,
  key: ChildCeiling,
  placeholders: MintPlaceholders,
): string {
  const api = `${new URL(serverUrl).origin}/api/v1`;
  const placeholder = (text: string) => shellArg(`<${text}>`);
  const pick =
    key.reach === "created"
      ? [
          `${API_AUTH} | curl -sS -X POST "${api}/kbs" -H @- \\`,
          `  -H "Content-Type: application/json" -H "Idempotency-Key: $CREATE_KEY" \\`,
          `  -d ${jsonArg({ name: "My project", slug: "my-project", description: "Notes for my project." })}`,
          `KB_ID=${placeholder(placeholders.createdId)}`,
        ]
      : [
          `${API_AUTH} | curl -sS -H @- "${api}/kbs"`,
          `KB_ID=${placeholder(placeholders.listedId)}`,
        ];
  return [
    ...apiPreamble(),
    ...(key.reach === "created" ? [`CREATE_KEY=${randomKey("create")}`] : []),
    ...pick,
    `MINT_KEY=${randomKey("mint")}`,
    `${API_AUTH} | curl -sS -X POST "${api}/kbs/$KB_ID/tokens" -H @- \\`,
    `  -H "Content-Type: application/json" -H "Idempotency-Key: $MINT_KEY" \\`,
    `  -d ${jsonArg(childMintBody(key))}`,
  ].join("\n");
}
