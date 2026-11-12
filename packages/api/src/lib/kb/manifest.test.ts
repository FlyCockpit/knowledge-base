import { describe, expect, it } from "vitest";
import { canonicalManifestBytes, validateManifestDocument } from "./manifest";
import { registerPathWithPrefixes, type SeenPathEntry } from "./paths";

const entry = {
  path: "media/a.png",
  hash: `sha256:${"a".repeat(64)}`,
  size: 12,
  mime: "image/png",
};
const context = {
  trustedBlobs: new Map([[entry.hash, entry]]),
  lineageHashes: new Set([entry.hash]),
  treePaths: new Map<string, SeenPathEntry>(),
};
const bytes = (entries = [entry]) => canonicalManifestBytes({ version: 1, entries });
describe("manifest", () => {
  it("accepts empty and canonical sorted manifests with exact catalog metadata", () => {
    expect(validateManifestDocument(bytes([]), context)).toBeNull();
    expect(validateManifestDocument(bytes(), context)).toBeNull();
    expect(bytes([{ ...entry, path: "z" }, entry]).toString()).toBe(
      JSON.stringify({ version: 1, entries: [entry, { ...entry, path: "z" }] }) + "\n",
    );
  });
  it.each(["size", "mime"] as const)("rejects forged %s even with hash and lineage", (field) => {
    expect(
      validateManifestDocument(
        bytes([{ ...entry, [field]: field === "size" ? 11 : "video/mp4" }]),
        context,
      )?.code,
    ).toBe("MANIFEST_LINEAGE");
  });
  it("rejects unknown catalog, foreign lineage and noncanonical/extra fields", () => {
    expect(validateManifestDocument(bytes(), { ...context, trustedBlobs: new Map() })?.code).toBe(
      "MANIFEST_LINEAGE",
    );
    expect(validateManifestDocument(bytes(), { ...context, lineageHashes: new Set() })?.code).toBe(
      "MANIFEST_LINEAGE",
    );
    expect(validateManifestDocument(Buffer.from(bytes().toString().trimEnd()), context)?.code).toBe(
      "MANIFEST_SORT",
    );
    expect(
      validateManifestDocument(Buffer.from('{"version":1,"entries":[],"extra":1}\n'), context)
        ?.code,
    ).toBe("MANIFEST_SCHEMA");
  });
  it.each(["media/a.png", "MEDIA/a.png", "media/a.png/child", "media"])(
    "rejects colliding manifest path %s",
    (path) => {
      expect(validateManifestDocument(bytes([entry, { ...entry, path }]), context)).not.toBeNull();
    },
  );
  it.each(["docs", "DOCS/a.png", "docs/note.md", "docs/note.md/x", ".assets/x", ".gitignore/x"])(
    "rejects tree or reserved collision %s",
    (path) => {
      const treePaths = new Map<string, SeenPathEntry>();
      registerPathWithPrefixes(treePaths, "docs/note.md", "file");
      expect(
        validateManifestDocument(bytes([{ ...entry, path }]), { ...context, treePaths }),
      ).not.toBeNull();
    },
  );
  it("permits shared exact directory prefixes and multiple paths to one blob", () => {
    const treePaths = new Map<string, SeenPathEntry>();
    registerPathWithPrefixes(treePaths, "media/note.md", "file");
    expect(
      validateManifestDocument(bytes([entry, { ...entry, path: "media/b.png" }]), {
        ...context,
        treePaths,
      }),
    ).toBeNull();
  });
});
