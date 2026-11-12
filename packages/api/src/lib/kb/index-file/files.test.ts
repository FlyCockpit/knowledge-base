import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseIndexFileName,
  removeEarlierAttemptTemps,
  removeGenerationFiles,
  unlinkIndexFile,
} from "./files";

const GEN = "gtestgentestgentestgent1";
const OTHER = "gothergenothergenothergn";

describe("index file names", () => {
  it("parses finals, attempt temps, their journals and side files", () => {
    expect(parseIndexFileName(`${GEN}.sqlite`)).toEqual({ kind: "final", generationId: GEN });
    expect(parseIndexFileName(`${GEN}.a3.tmp`)).toEqual({
      kind: "temp",
      generationId: GEN,
      attempt: 3,
      journal: false,
    });
    expect(parseIndexFileName(`${GEN}.a12.tmp-journal`)).toEqual({
      kind: "temp",
      generationId: GEN,
      attempt: 12,
      journal: true,
    });
    for (const side of ["-journal", "-wal", "-shm"])
      expect(parseIndexFileName(`${GEN}.sqlite${side}`)).toEqual({
        kind: "side",
        generationId: GEN,
      });
  });

  it("leaves unparseable names unknown", () => {
    for (const name of [
      "notes.txt",
      `${GEN}.a0.tmp`,
      `${GEN}.a1.tmp.bak`,
      `${GEN.toUpperCase()}.sqlite`,
      "short.sqlite",
      `../${GEN}.sqlite`,
    ])
      expect(parseIndexFileName(name)).toEqual({ kind: "unknown" });
  });
});

describe("generation file removal", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes one generation's final, temps and journals, nothing else, tolerating ENOENT", async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-index-files-"));
    for (const name of [
      `${GEN}.sqlite`,
      `${GEN}.a1.tmp`,
      `${GEN}.a1.tmp-journal`,
      `${GEN}.a2.tmp`,
      `${GEN}.sqlite-wal`,
      `${OTHER}.sqlite`,
      `${OTHER}.a1.tmp`,
      "stray",
    ])
      writeFileSync(join(dir, name), "x");
    await expect(removeGenerationFiles(dir, GEN)).resolves.toBe(4);
    expect(readdirSync(dir).sort()).toEqual(
      [`${GEN}.sqlite-wal`, `${OTHER}.a1.tmp`, `${OTHER}.sqlite`, "stray"].sort(),
    );
    await expect(removeGenerationFiles(dir, GEN)).resolves.toBe(0);
    await expect(removeGenerationFiles(join(dir, "missing"), GEN)).resolves.toBe(0);
    await expect(unlinkIndexFile(join(dir, "missing"))).resolves.toBeUndefined();
  });
});

describe("attempt-owned reset cleanup", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes only earlier attempts' temps and journals, never finals or later attempts", async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-index-attempts-"));
    for (const name of [
      `${GEN}.sqlite`,
      `${GEN}.a1.tmp`,
      `${GEN}.a1.tmp-journal`,
      `${GEN}.a2.tmp`,
      `${GEN}.a3.tmp`,
      `${GEN}.a3.tmp-journal`,
      `${OTHER}.a1.tmp`,
    ])
      writeFileSync(join(dir, name), "x");
    await expect(removeEarlierAttemptTemps(dir, GEN, 2)).resolves.toBe(2);
    expect(readdirSync(dir).sort()).toEqual(
      [
        `${GEN}.sqlite`,
        `${GEN}.a2.tmp`,
        `${GEN}.a3.tmp`,
        `${GEN}.a3.tmp-journal`,
        `${OTHER}.a1.tmp`,
      ].sort(),
    );
    // A superseded attempt 1 running its reset late touches nothing of attempts 2 and 3.
    await expect(removeEarlierAttemptTemps(dir, GEN, 1)).resolves.toBe(0);
    await expect(removeEarlierAttemptTemps(join(dir, "missing"), GEN, 5)).resolves.toBe(0);
  });
});
