import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "../../../../queue/src/jobs";
import {
  AUDIT_MAP,
  type AuditClassification,
  assertAuditCoverage,
  auditOperationsFor,
} from "./audit-map";
import { KB_TOOL_CATALOG, KB_TOOL_NAMES } from "./protocol/catalog";

const ROOT = resolve(import.meta.dirname, "../../../../..");

function durableJobKinds(): string[] {
  const schema = readFileSync(resolve(ROOT, "packages/db/prisma/schema/kb-jobs.prisma"), "utf8");
  const body = /enum DurableJobKind \{([^}]*)\}/.exec(schema)?.[1] ?? "";
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => /^[A-Z_]+$/.test(line));
}

function productionSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) productionSources(path, out);
    else if (
      /\.(ts|mjs)$/.test(name) &&
      !/\.test\.|\.integration\.|fixture|^audit-map\.ts$/.test(name)
    )
      out.push(readFileSync(path, "utf8"));
  }
  return out;
}

/** Inventory actual persistence calls, never event declarations/comments/imports. */
function emitterSites(sources: string[]) {
  const sites: Array<{ action: string; source: string }> = [];
  for (const source of sources) {
    const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
    const text = (node: unknown) => {
      if (!node || typeof node !== "object") return "";
      const start = Reflect.get(node, "start"),
        end = Reflect.get(node, "end");
      return typeof start === "number" && typeof end === "number" ? source.slice(start, end) : "";
    };
    const walk = (node: unknown, visitor: (node: object) => void) => {
      if (!node || typeof node !== "object") return;
      visitor(node);
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) {
          for (const item of child) walk(item, visitor);
        } else if (child && typeof child === "object") walk(child, visitor);
      }
    };
    walk(file, (node) => {
      const callee = text(Reflect.get(node, "callee"));
      if (
        Reflect.get(node, "type") !== "CallExpression" ||
        !(
          ["recordAuditEvent", "recordAuditFailure"].includes(callee) ||
          /\.auditEvent\.create$/.test(callee)
        )
      )
        return;
      for (const arg of Reflect.get(node, "arguments") as unknown[]) {
        walk(arg, (property) => {
          if (
            Reflect.get(property, "type") === "ObjectProperty" &&
            text(Reflect.get(property, "key")) === "action"
          )
            sites.push({ action: text(Reflect.get(property, "value")), source });
        });
      }
    });
  }
  return sites;
}

function hasEmitter(sites: ReturnType<typeof emitterSites>, event: string, derivedFrom?: string) {
  return sites.some(({ action, source }) => {
    if (action.includes(`"${event}"`) || action.includes(`'${event}'`)) return true;
    // These existing helpers persist a parameter-derived action. Require that
    // persistence site AND its producing literal/template in the same module.
    if (!/^(?:action|operation|input\.action)(?:\.toLowerCase\(\))?$/.test(action)) return false;
    return (
      source.includes(`"${event}"`) ||
      source.includes(`"${event.toUpperCase()}"`) ||
      (derivedFrom !== undefined && source.includes(derivedFrom))
    );
  });
}

describe("audit map", () => {
  it("classifies every MCP tool consistently with the catalog's read-only flag", () => {
    for (const name of KB_TOOL_NAMES) {
      const entry = AUDIT_MAP[`mcp:${name}`] as AuditClassification | undefined;
      expect(entry, name).toBeDefined();
      // A KB-read tool may still audit the artifact it creates (export_prepare);
      // every mutating tool must name its event.
      if (KB_TOOL_CATALOG[name].readOnly) expect(["read-only", "audited"]).toContain(entry?.class);
      else expect(entry?.class, name).toBe("audited");
    }
  });

  it("classifies every durable job kind and every BullMQ queue", () => {
    for (const kind of durableJobKinds())
      expect(AUDIT_MAP[`job:${kind}`], `job:${kind}`).toBeDefined();
    for (const queue of Object.values(QUEUE_NAMES))
      expect(AUDIT_MAP[`queue:${queue}`], `queue:${queue}`).toBeDefined();
  });

  it("names a real emitted event for every audited operation", () => {
    const sources = [
      ...productionSources(resolve(ROOT, "packages/api/src")),
      ...productionSources(resolve(ROOT, "packages/auth/src")),
      ...productionSources(resolve(ROOT, "apps/server/src")),
      ...productionSources(resolve(ROOT, "apps/worker/src")),
    ];
    const sites = emitterSites(sources);
    for (const [operation, entry] of Object.entries(AUDIT_MAP)) {
      if (entry.class !== "audited") continue;
      expect(entry.events.length, operation).toBeGreaterThan(0);
      for (const event of entry.events) {
        // Services derive some names from their operation constant (e.g. MIRROR_ROTATE).
        // Template-derived names declare the exact source template that produces them.
        expect(hasEmitter(sites, event, entry.derivedFrom), `${operation} -> ${event}`).toBe(true);
      }
    }
  });

  it("fails emitter coverage when a persistence call is removed despite remaining declarations", () => {
    const declaration = 'const events = ["kb_create"]; // action: "kb_create"';
    const call = 'recordAuditEvent(query, { action: "kb_create" });';
    expect(hasEmitter(emitterSites([declaration, call]), "kb_create")).toBe(true);
    expect(hasEmitter(emitterSites([declaration]), "kb_create")).toBe(false);
    const sources = productionSources(resolve(ROOT, "packages/api/src"));
    expect(hasEmitter(emitterSites(sources), "kb_create")).toBe(true);
    // Historical declaration remains in AUDIT_MAP; remove the owning service's
    // actual emission and ensure the production inventory no longer certifies it.
    const removed = sources.map((s) => s.replace('action: "kb_create",', 'action: "removed",'));
    expect(hasEmitter(emitterSites(removed), "kb_create")).toBe(false);
  });

  it("covers every audit-map family", () => {
    const events = new Set(
      Object.values(AUDIT_MAP).flatMap((entry) => (entry.class === "audited" ? entry.events : [])),
    );
    for (const event of [
      "kb_create",
      "kb_update",
      "kb_tombstone",
      "transfer_request",
      "transfer_accept",
      "share_invite",
      "share_accept",
      "share_revoke",
      "changes_apply",
      "export_prepare",
      "pr_create",
      "pr_merge",
      "pr_close",
      "pr_source_advance",
      "provider_create",
      "provider_attach",
      "provider_revoke",
      "provider_probe",
      "generation_activate",
      "generation_fail",
      "generation_retry",
      "pat_mint",
      "pat_revoke",
      "grant_revoke",
      "device_approve",
      "device_deny",
      "MCP_CONSENT_APPROVED",
      "git_push",
      "mirror_configure",
      "mirror_activate_request",
      "mirror_rotate",
      "mirror_disconnect",
      "mirror_attempt",
      "model_enable",
      "model_download",
      "model_disable",
      "sealed_enroll",
      "sealed_grant",
      "sealed_resolve_denied",
    ])
      expect(events.has(event), event).toBe(true);
    // Backup/restore run in the server image, outside the application processes.
    expect(AUDIT_MAP["ops:backup"]?.class).toBe("out-of-band");
    expect(AUDIT_MAP["ops:restore"]?.class).toBe("out-of-band");
  });

  it("rejects an unclassified new mutation and a stale classification", () => {
    const current = Object.keys(AUDIT_MAP)
      .filter((op) => op.startsWith("rpc:"))
      .map((op) => op.slice(4));
    expect(current).toContain("kbs.create");
    expect(auditOperationsFor({ rpcLeaves: current })).toContain("mcp:knowledge_search");
    expect(() => assertAuditCoverage({ rpcLeaves: current })).not.toThrow();
    expect(() =>
      assertAuditCoverage({ rpcLeaves: [...current, "kbs.accidentalMutation"] }),
    ).toThrow(/unclassified/i);
    expect(() =>
      assertAuditCoverage({ rpcLeaves: current.filter((leaf) => leaf !== "kbs.create") }),
    ).toThrow(/stale/i);
  });
});
