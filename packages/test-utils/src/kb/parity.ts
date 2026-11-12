/** Official SDK protocol client over an owned real CLI stdio transport. */
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type BaseContext,
  type JSONRPCMessage,
  Protocol,
  type Transport,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export const callResult = z.object({
  isError: z.boolean(),
  structuredContent: z.object({
    schemaVersion: z.literal("kb/1"),
    data: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        details: z.record(z.string(), z.unknown()),
      })
      .optional(),
  }),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  resultType: z.literal("complete").optional(),
});
class SdkPeer extends Protocol<BaseContext> {
  protected buildContext(ctx: BaseContext) {
    return ctx;
  }
  protected assertCapabilityForMethod() {}
  protected assertNotificationCapability() {}
  protected assertRequestHandlerCapability() {}
  async initialize(transport: Transport) {
    // Match the Rust CLI fixtures: cold durable-store startup has its own
    // watchdog, before normal SDK request deadlines begin.
    const result = await this.request(
      {
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          clientInfo: { name: "parity", version: "1" },
          capabilities: {},
        },
      },
      { timeout: 180000 },
    );
    if (result.protocolVersion !== "2026-07-28") throw new Error("stdio profile mismatch");
    this._negotiatedProtocolVersion = result.protocolVersion;
    // The pinned SDK codec omits the legacy initialized notification; local
    // stdio explicitly retains that handshake, while tool calls use its codec.
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }
}
export async function localPeer(binary: string, root: string, extra: string[] = []) {
  return stdioPeer(binary, ["mcp", "--root", root, ...extra], isolatedCliEnv(root));
}
/** No fixture process can reach the desktop keyring or the real user home. */
function isolatedCliEnv(root: string): NodeJS.ProcessEnv {
  const bus = join(root, "nobus");
  if (existsSync(bus)) throw new Error("fixture bus must not exist");
  const { DBUS_SESSION_BUS_ADDRESS: _bus, XDG_RUNTIME_DIR: _runtime, ...env } = process.env;
  return {
    ...env,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
}
/** Import a disposable token through the actual private-state command. */
export async function remotePeer(
  binary: string,
  root: string,
  resource: string,
  token: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  // Remote CLI fixtures must never discover the developer's home or keyring:
  // the isolation keys win over any caller-supplied environment.
  const isolated = isolatedCliEnv(root);
  const env: NodeJS.ProcessEnv = {
    ...isolated,
    ...extraEnv,
    HOME: isolated.HOME,
    XDG_CONFIG_HOME: isolated.XDG_CONFIG_HOME,
    XDG_DATA_HOME: isolated.XDG_DATA_HOME,
    XDG_CACHE_HOME: isolated.XDG_CACHE_HOME,
    DBUS_SESSION_BUS_ADDRESS: isolated.DBUS_SESSION_BUS_ADDRESS,
    KB_CONFIG_DIR: join(root, "config"),
    KB_DATA_DIR: join(root, "data"),
  };
  delete env.XDG_RUNTIME_DIR;
  await new Promise<void>((resolve, reject) => {
    const login = execFile(
      binary,
      ["login", "--server", resource, "--allow-loopback-http", "--token-stdin"],
      { env, timeout: 120000 },
      (error) => (error ? reject(error) : resolve()),
    );
    login.stdin!.end(token);
  });
  return stdioPeer(binary, ["mcp", "--server", resource, "--allow-loopback-http"], env);
}
async function stdioPeer(binary: string, args: string[], env = process.env) {
  const child = spawn(binary, args, { stdio: "pipe", env });
  let setup: Record<string, unknown> = {};
  let buffer = "";
  let diagnostics = "";
  const transport: Transport = {
    async start() {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          if (Buffer.byteLength(buffer.slice(0, end)) > 8 * 1024 * 1024) {
            transport.onerror?.(new Error("oversized CLI response"));
            child.kill();
            return;
          }
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === "fixture") setup = parsed.result;
            else transport.onmessage?.(parsed as JSONRPCMessage);
          } catch {
            transport.onerror?.(new Error("non-JSON CLI stdout"));
          }
        }
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024 + 1) {
          transport.onerror?.(new Error("oversized CLI response"));
          child.kill();
          return;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-65536);
      });
      child.on("error", (e) => transport.onerror?.(e));
      child.on("exit", () => transport.onclose?.());
    },
    async send(message) {
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    async close() {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await once(child, "exit");
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
  const peer = new SdkPeer();
  await peer.connect(transport);
  let initialized: { instructions?: unknown };
  try {
    initialized = await peer.initialize(transport);
  } catch (e) {
    await peer.close();
    throw new Error(`CLI initialization failed: ${diagnostics}`, { cause: e });
  }
  return {
    child,
    peer,
    setup: () => setup,
    diagnostics: () => diagnostics,
    /** Server instructions the CLI forwarded in its initialize reply. */
    instructions: () => initialized.instructions,
    async list() {
      return peer.request({ method: "tools/list" });
    },
    async call(name: string, args: Record<string, unknown>) {
      return callResult.parse(
        await peer.request({ method: "tools/call", params: { name, arguments: args } }),
      );
    },
    async unsupported() {
      return peer.request({ method: "shell/execute" }, z.unknown());
    },
    async close() {
      await peer.close();
      if (child.exitCode !== 0) throw new Error(`CLI failed: ${diagnostics}`);
    },
  };
}
/** Only generated identities and revision/timestamp metadata are normalized.
 * Blob/source hashes, source spans, errors and effect-bearing values stay exact. */
export function normalize(value: unknown, field = ""): unknown {
  // These two maps contain user data, including keys named id/rev/createdAt.
  if (field === "frontMatter" || field === "matchedRow") return value;
  if (Array.isArray(value)) return value.map((v) => normalize(v, field));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
  if (typeof value !== "string") return value;
  if (/^(attachmentLocator|sealedNamespace|authorActorKey)$/.test(field)) return `<${field}>`;
  if (
    /^(id|kbId|knowledgeBaseId|operationId|uploadId|transferId|indexJobId|generationId|embeddingGeneration|providerId|indexGenerationId|activeGenerationId|desiredGenerationId|jobId)$/.test(
      field,
    )
  )
    return "<id>";
  if (
    /^(rev|headSha|baseSha|targetSha|commitSha|baseRevision|indexedCommitSha|mergeCommitSha)$/.test(
      field,
    )
  )
    return "<revision>";
  if (/^(expiresAt|createdAt)$/.test(field)) return "<instant>";
  return value;
}
