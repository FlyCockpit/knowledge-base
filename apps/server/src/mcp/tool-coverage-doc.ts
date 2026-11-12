import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KB_TOOL_BINDINGS,
  KB_TOOL_CATALOG,
  KB_TOOL_NAMES,
} from "@knowledge-base/api/lib/kb/protocol/catalog";

const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");

// Explicit leaves: new handlers cannot inherit a namespace-wide exclusion.
const humanOnly = {
  appConfig: "public browser configuration",
  "health.check": "public liveness",
  "auth.passwordCapabilities": "browser authentication",
  "auth.verifyEmailTransport": "browser authentication",
  "auth.updateLocale": "browser preference",
  "cliCredentials.selectDeviceIntent": "human device approval",
  "cliCredentials.exchangeDeviceCode": "device credential exchange",
  "cliCredentials.registerDeviceRecipient": "device public recipient registration",
  "embeddingProviders.create": "human provider credentials",
  "embeddingProviders.probe": "human provider credentials",
  "embeddingProviders.listMine": "human provider credentials",
  "embeddingProviders.listSystem": "human provider credentials",
  "embeddingProviders.revoke": "human provider credentials",
  "kbSealed.enroll": "human sealed enrollment",
  "kbSealed.grant": "human sealed consumer approval",
  "kbSealed.revoke": "human sealed revocation",
  "kbMirror.status": "human mirror control",
  "kbMirror.configure": "human mirror control",
  "kbMirror.rotate": "human mirror control",
  "kbMirror.disconnect": "human mirror control",
  "kbMirror.activate": "human mirror control",
  "kbMirror.push": "human mirror control",
  "kbIndex.settings": "human index settings (web only)",
  "kbIndex.setQuantization": "human index settings (web only)",
  "kbIndex.setChunkLimit": "human index settings (web only)",
  "kbIndex.chunkCeiling": "instance administration",
  "kbIndex.setChunkCeiling": "instance administration",
  "kbModel.attachedKnowledgeBases": "instance administration",
  "kbModel.status": "instance administration",
  "kbModel.enable": "instance administration",
  "kbModel.disable": "instance administration",
  "kbModel.remove": "instance administration",
  "kbModel.setRuntimeConfig": "instance administration",
  "pullRequests.conflicts":
    "browser PR conflict list (conflict details travel in PROPOSAL_CONFLICT over MCP)",
  "pullRequests.forDocument": "browser editor lookup of the viewer's own PR",
  "kbs.shareInvite": "human sharing",
  "kbs.shareAccept": "human sharing",
  "kbs.shareList": "human sharing",
  "kbs.shareRevoke": "human sharing",
  "kbs.shareUpdate": "human sharing",
  "kbs.shareSetSealedValues": "human sharing",
  "kbs.transferRequest": "human ownership transfer",
  "kbs.transferAccept": "human ownership transfer",
  "mcpConsent.prepare": "human consent",
  "mcpConsent.approve": "human consent",
  "mcpGrants.endElevationMine": "human credential management",
  "mcpGrants.listMine": "human credential management",
  "mcpGrants.listAclMine": "human credential management",
  "mcpGrants.updateMine": "human credential management",
  "mcpGrants.countActiveMine": "human credential management",
  "mcpGrants.revokeMine": "human credential management",
  "mcpGrants.revokeAllMine": "human credential management",
  "mcpTokens.create": "human credential mint",
  "mcpTokens.listMine": "human credential management",
  "mcpTokens.revokeMine": "human credential management",
  "push.subscribe": "browser notifications",
  "push.unsubscribe": "browser notifications",
  "push.send": "instance administration",
  "push.vapidPublicKey": "browser notifications",
  "queue.auditExport": "instance administration",
  "queue.backupStatus": "instance administration",
  "queue.enqueueEcho": "instance administration",
  "queue.getJob": "instance administration",
  "queue.listFailed": "instance administration",
  "settings.getAll": "browser settings",
  "settings.adminSetupStatus": "browser settings",
  "settings.myNotificationPreferences": "browser preferences",
  "settings.updateMyNotificationPreferences": "browser preferences",
  "settings.update": "instance administration",
  "users.list": "instance administration",
  "users.invite": "instance administration",
  "users.setRole": "instance administration",
  "users.archive": "instance administration",
  "users.unarchive": "instance administration",
  "users.remove": "instance administration",
  "users.removeForce": "instance administration",
};

/** Follow only appRouter's static object graph, imports and spreads; fail closed on novel syntax. */
export function inventoryRouterLeaves(root: string): string[] {
  const leaves: string[] = [];
  const visiting = new Set<string>();
  type Node = { type: string; [key: string]: unknown };
  const node = (value: unknown): Node => {
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string")
      throw new Error("Unexpected router AST");
    return value as Node;
  };
  const text = (value: unknown): string => {
    const n = node(value);
    const result = n.type === "Identifier" ? n.name : n.value;
    if (typeof result !== "string") throw new Error("Computed router key");
    return result;
  };
  function symbol(file: string, name: string, prefix: string) {
    const key = `${file}:${name}`;
    if (visiting.has(key)) throw new Error(`Cyclic router ${key}`);
    visiting.add(key);
    const source = parse(readFileSync(file, "utf8"), {
      sourceType: "module",
      plugins: ["typescript"],
    });
    let found = false;
    for (const raw of source.program.body) {
      const statement = raw.type === "ExportNamedDeclaration" ? raw.declaration : raw;
      if (statement?.type === "ImportDeclaration")
        for (const binding of statement.specifiers) {
          if (binding.type === "ImportSpecifier" && binding.local.name === name) {
            if (!statement.source.value.startsWith(".")) throw new Error(`External router ${name}`);
            symbol(
              resolve(dirname(file), `${statement.source.value}.ts`),
              text(binding.imported),
              prefix,
            );
            found = true;
          }
        }
      if (statement?.type === "VariableDeclaration")
        for (const declaration of statement.declarations)
          if (
            declaration.id.type === "Identifier" &&
            declaration.id.name === name &&
            declaration.init
          ) {
            walk(declaration.init, file, prefix);
            found = true;
          }
    }
    visiting.delete(key);
    if (!found) throw new Error(`Unresolved router ${key}`);
  }
  function walk(value: unknown, file: string, prefix: string): void {
    const n = node(value);
    if (n.type === "Identifier") {
      symbol(file, text(n), prefix);
      return;
    }
    if (["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(n.type)) {
      walk(n.expression, file, prefix);
      return;
    }
    if (n.type === "CallExpression") {
      const callee = node(n.callee);
      if (callee.type === "MemberExpression" && text(callee.property) === "handler") {
        leaves.push(prefix);
        return;
      }
    }
    if (n.type !== "ObjectExpression" || !Array.isArray(n.properties))
      throw new Error(`Unclassified router expression ${file}:${prefix}`);
    for (const raw of n.properties) {
      const property = node(raw);
      if (property.type === "SpreadElement") {
        walk(property.argument, file, prefix);
        continue;
      }
      if (property.type !== "ObjectProperty" || property.computed)
        throw new Error(`Unclassified router member ${file}:${prefix}`);
      const child = prefix ? `${prefix}.${text(property.key)}` : text(property.key);
      walk(property.value, file, child);
    }
  }
  symbol(resolve(root, "packages/api/src/routers/index.ts"), "appRouter", "");
  let handlers = 0;
  function count(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) count(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    const n = value as Record<string, unknown>;
    if (n.type === "CallExpression") {
      const callee = node(n.callee);
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        text(callee.property) === "handler"
      )
        handlers++;
    }
    for (const child of Object.values(n)) count(child);
  }
  const routers = resolve(root, "packages/api/src/routers");
  for (const file of readdirSync(routers))
    if (file.endsWith(".ts") && !file.endsWith(".test.ts"))
      count(
        parse(readFileSync(resolve(routers, file), "utf8"), {
          sourceType: "module",
          plugins: ["typescript"],
        }),
      );
  if (handlers !== leaves.length) throw new Error("Unclassified or multiply mounted oRPC handler");
  if (new Set(leaves).size !== leaves.length) throw new Error("Duplicate router leaf");
  return leaves.sort();
}
export function assertCoverage(leaves: string[]): void {
  const classified = [
    ...Object.keys(humanOnly),
    ...Object.values(KB_TOOL_BINDINGS).flatMap((row) => (row.rpc ? [row.rpc] : [])),
  ].sort();
  if (JSON.stringify(classified) !== JSON.stringify([...leaves].sort()))
    throw new Error("oRPC coverage drift: classify every new/removed leaf explicitly");
  if (Object.keys(KB_TOOL_BINDINGS).sort().join() !== [...KB_TOOL_NAMES].sort().join())
    throw new Error("Tool binding drift");
}
export function generateCoverage(leaves: string[]): string {
  assertCoverage(leaves);
  return [
    "# MCP tool coverage",
    "",
    "Generated by `pnpm kb:tools:generate`; `pnpm kb:tools:check` rejects drift.",
    "",
    "Only the common kb/1 data plane is exposed. Document, citation and model text is untrusted data and is never executed as instructions. Authenticated actors and sealed namespaces come from the server. The domain journal owns mutation audit/receipts; transport retries do not add audit events.",
    "",
    "Each tool belongs to the tool groups a connection can be granted. A tool with several groups is available with any of them (each upload call's `kind` is checked against the groups). Supporting tools belong to no group: they are advertised when a connection needs knowledge base discovery or a base revision, and any connection with read authority may call them.",
    "",
    "| Tool | Group | Domain operation | Browser oRPC equivalent | Success audit / classification |",
    "| --- | --- | --- | --- | --- |",
    ...KB_TOOL_NAMES.map((name) => {
      const b = KB_TOOL_BINDINGS[name];
      const groups = KB_TOOL_CATALOG[name].groups;
      const group = groups.length > 0 ? groups.join(", ") : "supporting";
      return `| ${name} | ${group} | ${b.domain} | ${b.rpc ?? "none (MCP data plane)"} | ${b.audit} |`;
    }),
    "",
    "Every remaining oRPC leaf is explicitly excluded from MCP (including public browser/device bootstrap endpoints).",
    "",
    "| oRPC leaf | Human/control-plane exclusion |",
    "| --- | --- |",
    ...Object.entries(humanOnly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, reason]) => `| ${name} | ${reason} |`),
    "",
  ].join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "../../../..");
  const path = resolve(root, "docs/mcp-tool-coverage.md");
  const expected = generateCoverage(inventoryRouterLeaves(root));
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== expected)
      throw new Error("MCP coverage document drift; run pnpm kb:tools:generate");
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, expected);
  }
}
