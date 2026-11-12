import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VEC_VERSION } from "./format";
import { loadSqlite, loadVec } from "./sqlite";
import { buildTestIndex } from "./testing";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sqlite loader", () => {
  it("loads the stock addon and sqlite-vec into a readonly plain-path handle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-index-sqlite-"));
    dirs.push(dir);
    const built = await buildTestIndex({
      indexDir: dir,
      documents: [{ path: "a.md", chunks: ["x"] }],
    });
    const db = new (loadSqlite())(built.path, { readonly: true, fileMustExist: true });
    try {
      expect(db.readonly).toBe(true);
      expect(loadVec(db)).toBe(VEC_VERSION);
      expect((db.prepare("SELECT vec_version() AS v").get() as { v: string }).v).toBe("v0.1.9");
      // SQL load_extension() stays disabled; only the native API loads extensions.
      expect(() => db.prepare("SELECT load_extension('x')").get()).toThrow(/not authorized/);
    } finally {
      db.close();
    }
  });
});
