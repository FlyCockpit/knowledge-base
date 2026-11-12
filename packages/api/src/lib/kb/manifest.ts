import { isCasSniffMime } from "../sniff-mime";
import { CAS_BLOB_MAX_BYTES } from "./limits";
import {
  casefoldPathKey,
  normalizeKbPath,
  registerPathWithPrefixes,
  type SeenPathEntry,
} from "./paths";

export const KB_MANIFEST_VERSION = 1;

export type AssetManifestEntry = {
  path: string;
  hash: string;
  size: number;
  mime: string;
};

export type ParsedManifest = {
  version: number;
  entries: AssetManifestEntry[];
};

export type ManifestIssueCode =
  | "MANIFEST_INVALID_JSON"
  | "MANIFEST_SCHEMA"
  | "MANIFEST_SORT"
  | "MANIFEST_DUPLICATE"
  | "MANIFEST_COLLISION"
  | "MANIFEST_LINEAGE";

export type ManifestIssue = {
  code: ManifestIssueCode;
  message: string;
  path?: string;
  /** The path issue code (`paths.ts`) behind an invalid entry path. */
  pathIssue?: string;
};

const HASH = /^sha256:[0-9a-f]{64}$/;

/** Most entries one asset manifest holds. */
export const KB_MANIFEST_MAX_ENTRIES = 8192;

export function parseAssetManifest(bytes: Buffer): ParsedManifest | ManifestIssue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { code: "MANIFEST_INVALID_JSON", message: "manifest is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { code: "MANIFEST_SCHEMA", message: "manifest must be an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== KB_MANIFEST_VERSION) {
    return { code: "MANIFEST_SCHEMA", message: "manifest version must be 1" };
  }
  if (
    Object.keys(record).length !== 2 ||
    !Array.isArray(record.entries) ||
    record.entries.length > KB_MANIFEST_MAX_ENTRIES
  ) {
    return { code: "MANIFEST_SCHEMA", message: "manifest entries must be an array" };
  }
  const entries: AssetManifestEntry[] = [];
  for (const item of record.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { code: "MANIFEST_SCHEMA", message: "manifest entry must be an object" };
    }
    const row = item as Record<string, unknown>;
    if (Object.keys(row).length !== 4 || typeof row.path !== "string") {
      return { code: "MANIFEST_SCHEMA", message: "manifest entry path must be a string" };
    }
    if (typeof row.hash !== "string" || !HASH.test(row.hash)) {
      return { code: "MANIFEST_SCHEMA", message: "manifest entry hash must be sha256" };
    }
    if (typeof row.size !== "number" || !Number.isInteger(row.size) || row.size < 1) {
      return { code: "MANIFEST_SCHEMA", message: "manifest entry size must be a positive integer" };
    }
    if (typeof row.mime !== "string" || row.mime.length === 0) {
      return { code: "MANIFEST_SCHEMA", message: "manifest entry mime must be a string" };
    }
    if (row.size > CAS_BLOB_MAX_BYTES) {
      return {
        code: "MANIFEST_SCHEMA",
        message: "manifest entry size exceeds CAS limit",
        path: row.path,
      };
    }
    if (!isCasSniffMime(row.mime)) {
      return {
        code: "MANIFEST_SCHEMA",
        message: "manifest entry mime is not a trusted CAS type",
        path: row.path,
      };
    }
    entries.push({
      path: row.path,
      hash: row.hash,
      size: row.size,
      mime: row.mime,
    });
  }
  return { version: KB_MANIFEST_VERSION, entries };
}

export function canonicalManifestBytes(manifest: ParsedManifest): Buffer {
  // Code-unit order, not locale collation: canonical bytes must be identical
  // in every process and locale.
  const sorted = [...manifest.entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return Buffer.from(
    `${JSON.stringify({ version: manifest.version, entries: sorted.map(({ path, hash, size, mime }) => ({ path, hash, size, mime })) })}\n`,
    "utf8",
  );
}

export type ManifestValidationContext = {
  trustedBlobs: ReadonlyMap<string, { size: number; mime: string }>;
  lineageHashes: ReadonlySet<string>;
  treePaths: ReadonlyMap<string, SeenPathEntry>;
};

export function validateManifestDocument(
  bytes: Buffer,
  ctx: ManifestValidationContext,
): ManifestIssue | null {
  const parsed = parseAssetManifest(bytes);
  if ("code" in parsed) return parsed;
  const canonical = canonicalManifestBytes(parsed);
  if (!bytes.equals(canonical)) {
    return { code: "MANIFEST_SORT", message: "manifest must be canonical sorted JSON" };
  }
  const seenPaths = new Map(ctx.treePaths);
  for (const entry of parsed.entries) {
    const norm = normalizeKbPath(entry.path);
    if (!norm.ok) {
      return {
        code: "MANIFEST_SCHEMA",
        message: norm.issue.message,
        path: entry.path,
        pathIssue: norm.issue.code,
      };
    }
    // Manifest entries are files: an exact or case-folded repeat of a path
    // is always a duplicate here — directory-prefix repeats do not apply.
    const collision = registerPathWithPrefixes(seenPaths, norm.path, "file");
    if (collision) {
      return { code: "MANIFEST_DUPLICATE", message: collision.message, path: entry.path };
    }
    const root = casefoldPathKey(norm.path).split("/")[0];
    if (root === ".assets" || root === ".gitignore") {
      return { code: "MANIFEST_COLLISION", message: "manifest path is reserved", path: entry.path };
    }
    const trusted = ctx.trustedBlobs.get(entry.hash);
    if (!trusted || trusted.size !== entry.size || trusted.mime !== entry.mime) {
      return {
        code: "MANIFEST_LINEAGE",
        message: "manifest metadata differs from trusted catalog",
        path: entry.path,
      };
    }
    if (!ctx.lineageHashes.has(entry.hash)) {
      return {
        code: "MANIFEST_LINEAGE",
        message: "manifest hash is not authorized for this knowledge base",
        path: entry.path,
      };
    }
  }
  return null;
}
