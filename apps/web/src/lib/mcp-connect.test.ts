import { MCP_TOOL_PRESETS } from "@knowledge-base/auth/mcp-tool-groups";
import { describe, expect, it } from "vitest";

import {
  apiKeyCheckCommands,
  childMintBody,
  childMintCommands,
  groupsWrite,
  KB_DOCS,
  mcpClientSnippet,
  mcpServerUrl,
  restApiOpenApiUrl,
  scopeForGroups,
} from "@/lib/mcp-connect";

const SERVER = "https://kb.example.com";
const SECRET = `kbp_${"0".repeat(16)}_${"S".repeat(43)}`;

describe("server URLs", () => {
  it("keeps only the origin of the configured server URL", () => {
    expect(mcpServerUrl("https://user:pw@kb.example.com:8443/app?x#y")).toBe(
      "https://kb.example.com:8443/mcp",
    );
    expect(restApiOpenApiUrl(`${SERVER}/`)).toBe(`${SERVER}/api/v1/openapi.json`);
  });

  it("links the guides in the public repository", () => {
    expect(KB_DOCS.mcp).toMatch(/^https:\/\/github\.com\/FlyCockpit\/knowledge-base\/.+\/mcp\.md$/);
    expect(KB_DOCS.restApi).toMatch(/\/rest-api\.md$/);
  });
});

describe("mcpClientSnippet", () => {
  it("signs in with OAuth when there is no token", () => {
    expect(mcpClientSnippet("claude", SERVER)).toBe(
      "claude mcp add --transport http kb https://kb.example.com/mcp",
    );
    expect(mcpClientSnippet("codex", SERVER)).toBe(
      "codex mcp add kb --url https://kb.example.com/mcp\ncodex mcp login kb",
    );
    expect(JSON.parse(mcpClientSnippet("other", SERVER))).toEqual({
      mcpServers: { kb: { type: "http", url: "https://kb.example.com/mcp" } },
    });
  });

  it("never puts a token on a command line: the shell reads it into KB_MCP_TOKEN", () => {
    const claude = mcpClientSnippet("claude", SERVER, SECRET);
    const codex = mcpClientSnippet("codex", SERVER, SECRET);
    for (const snippet of [claude, codex]) {
      expect(snippet).not.toContain(SECRET);
      expect(snippet.split("\n")[0]).toBe("read -rs KB_MCP_TOKEN && export KB_MCP_TOKEN");
    }
    // Single-quoted, so Claude Code stores the reference and expands it when it connects.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell reference, literally.
    expect(claude).toContain("--header 'Authorization: Bearer ${KB_MCP_TOKEN}'");
    expect(codex).toContain("--bearer-token-env-var KB_MCP_TOKEN");
  });

  it("puts the token only into the JSON for a client's private settings file", () => {
    expect(JSON.parse(mcpClientSnippet("other", SERVER, SECRET))).toEqual({
      mcpServers: {
        kb: {
          type: "http",
          url: "https://kb.example.com/mcp",
          headers: { Authorization: `Bearer ${SECRET}` },
        },
      },
    });
  });

  it("quotes a URL the shell would otherwise glob", () => {
    expect(mcpClientSnippet("claude", "http://[::1]:3000")).toBe(
      "claude mcp add --transport http kb 'http://[::1]:3000/mcp'",
    );
  });
});

describe("scopeForGroups", () => {
  it("writes exactly when a group holds a tool that changes data", () => {
    expect(scopeForGroups(MCP_TOOL_PRESETS.read)).toBe("mcp:read");
    expect(scopeForGroups(MCP_TOOL_PRESETS.propose)).toBe("mcp:write");
    expect(scopeForGroups(MCP_TOOL_PRESETS.direct)).toBe("mcp:write");
    expect(scopeForGroups(["read", "export", "sealed"])).toBe("mcp:read");
    expect(groupsWrite(["kb_admin"])).toBe(true);
    expect(groupsWrite(["index_admin"])).toBe(true);
    expect(groupsWrite([])).toBe(false);
  });
});

describe("child token minting example", () => {
  it("stays inside the key's ceiling, without the opt-in groups", () => {
    expect(
      childMintBody({
        bits: ["manage"],
        childToolGroups: ["read", "edit", "export", "pull_requests", "sealed", "kb_admin"],
        childAuthoringMode: "edit",
      }),
    ).toEqual({
      name: "My agent",
      // A custom group set has no preset ceiling: the key's bits pass as they are.
      bits: ["read", "propose", "write", "review", "manage"],
      toolGroups: ["read", "edit", "export", "pull_requests"],
      authoringMode: "edit",
    });
    // A preset caps the bits: Propose edits never reaches write.
    expect(
      childMintBody({
        bits: ["write"],
        childToolGroups: [...MCP_TOOL_PRESETS.propose],
        childAuthoringMode: "both",
      }),
    ).toMatchObject({ bits: ["read", "propose"], authoringMode: "both" });
    // Read-only tools send no write mode.
    expect(
      childMintBody({ bits: ["read"], childToolGroups: ["read"], childAuthoringMode: null }),
    ).toEqual({ name: "My agent", bits: ["read"], toolGroups: ["read"] });
  });

  const readOnly = {
    bits: ["read"],
    childToolGroups: ["read"],
    childAuthoringMode: null,
  } as const;
  const HOLES = { listedId: "an id from that list", createdId: "the kb id in that reply" };
  const PREAMBLE = [
    "read -rs KB_API_KEY",
    `kb_auth() { printf 'Authorization: Bearer %s\\n' "$KB_API_KEY"; }`,
  ];

  it("keeps the key off every command line: printf (a shell builtin) feeds curl -H @-", () => {
    const commands = childMintCommands(SERVER, { reach: "all", ...readOnly }, HOLES);
    const lines = commands.split("\n");
    expect(lines.slice(0, 2)).toEqual(PREAMBLE);
    // The key is never exported to children nor expanded into an argument.
    expect(commands).not.toContain("export KB_API_KEY");
    expect(lines.filter((line) => line.includes("$KB_API_KEY"))).toEqual([PREAMBLE[1]]);
    for (const line of lines.filter((l) => l.includes("curl "))) {
      expect(line).toMatch(/^kb_auth \| curl -sS .*-H @-/);
    }
    expect(commands).not.toMatch(/kbk_/);
    expect(apiKeyCheckCommands(SERVER)).toBe(
      [...PREAMBLE, `kb_auth | curl -sS -H @- "${SERVER}/api/v1/key"`].join("\n"),
    );
  });

  it("lists the key's KBs, then mints with a random Idempotency-Key a retry can reuse", () => {
    const commands = childMintCommands(SERVER, { reach: "all", ...readOnly }, HOLES);
    expect(commands).toContain(`kb_auth | curl -sS -H @- "${SERVER}/api/v1/kbs"\n`);
    // 64 random bits per intended mint, never a clock value two quick mints could share.
    expect(commands).toContain(`MINT_KEY="mint-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')"`);
    expect(commands).not.toContain("date +%s");
    // The placeholder is translated text, quoted so the shell takes it literally.
    expect(commands).toContain("KB_ID='<an id from that list>'");
    expect(commands).toContain(`-X POST "${SERVER}/api/v1/kbs/$KB_ID/tokens" -H @-`);
    expect(commands).toContain(`-H "Idempotency-Key: $MINT_KEY"`);
    expect(commands).toContain(`-d '{"name":"My agent","bits":["read"],"toolGroups":["read"]}'`);
  });

  it("creates a KB first for a key that reaches only the KBs it creates", () => {
    const commands = childMintCommands(SERVER, { reach: "created", ...readOnly }, HOLES);
    expect(commands).not.toContain(`-H @- "${SERVER}/api/v1/kbs"\n`);
    expect(commands).toContain(`kb_auth | curl -sS -X POST "${SERVER}/api/v1/kbs" -H @-`);
    // A body the REST create schema accepts: slug pattern, description of 10+ characters.
    const body = /-d '(\{"name":"My project".*?\})'/.exec(commands)?.[1];
    expect(JSON.parse(body ?? "null")).toEqual({
      name: "My project",
      slug: "my-project",
      description: "Notes for my project.",
    });
    expect(commands.indexOf('/api/v1/kbs" -H @-')).toBeLessThan(commands.indexOf("/tokens"));
    expect(commands).toContain(
      `CREATE_KEY="create-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')"`,
    );
    expect(commands).toContain(`-H "Idempotency-Key: $CREATE_KEY"`);
    expect(commands).toContain("KB_ID='<the kb id in that reply>'");
  });
});
