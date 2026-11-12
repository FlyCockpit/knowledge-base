import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightExportEntries, writeExportZip } from "./exports";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kb-zip-unit-"));
  roots.push(root);
  const path = join(root, "artifact.zip");
  return { root, path, file: await open(path, "wx+") };
}

describe("bounded ZIP", () => {
  it("empty ZIP is valid and hash covers its exact bytes", async () => {
    const { path, file } = await fixture();
    const result = await writeExportZip(
      file,
      [],
      async function* () {},
      new AbortController().signal,
    );
    await file.close();
    const bytes = await readFile(path);
    expect(bytes.length).toBe(22);
    expect(result.contentHash).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(
      execFileSync("python3", [
        "-c",
        "import zipfile,sys; assert zipfile.ZipFile(sys.argv[1]).namelist()==[]",
        path,
      ]).length,
    ).toBe(0);
  });
  it("writes exact UTF-8 names, bytes and valid CRCs readable by an independent ZIP implementation", async () => {
    const { path, file } = await fixture();
    await writeExportZip(
      file,
      [
        { path: "docs/café.md", size: 3 },
        { path: ".assets/manifest.json", size: 3 },
      ],
      async function* () {
        yield Buffer.from("one");
      },
      new AbortController().signal,
    );
    await file.close();
    execFileSync("python3", [
      "-c",
      "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.namelist()==['docs/café.md','.assets/manifest.json']; assert z.testzip() is None; assert z.read('docs/café.md')==b'one'",
      path,
    ]);
  });
  it.each(["../x", "/x", "a/../x", "a\\x", "Cafe\u0301.md"])("rejects unsafe name %s", (path) => {
    expect(() => preflightExportEntries([{ path, size: 1 }])).toThrow("Invalid export path");
  });
  it.each([
    ["a", "a"],
    ["a", "A"],
    ["a", "a/b"],
    ["A/b", "a/c"],
    ["straße", "strasse"],
  ])("rejects collisions %s / %s", (a, b) => {
    expect(() =>
      preflightExportEntries([
        { path: a!, size: 1 },
        { path: b!, size: 1 },
      ]),
    ).toThrow("Invalid export path");
  });
  it("rejects 8193 entries and >256 MiB before source or output writes", async () => {
    const { file } = await fixture();
    for (const entries of [
      Array.from({ length: 8193 }, (_, i) => ({ path: `${i}.md`, size: 0 })),
      [{ path: "big", size: 256 * 1024 * 1024 + 1 }],
    ]) {
      let read = false;
      await expect(
        writeExportZip(
          file,
          entries,
          async function* () {
            read = true;
            yield Buffer.from("x");
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      expect(read).toBe(false);
      expect((await file.stat()).size).toBe(0);
    }
    await file.close();
  });
  it("rejects truncated, oversized and cancelled sources without sealing", async () => {
    for (const length of [0, 2]) {
      const { file } = await fixture();
      await expect(
        writeExportZip(
          file,
          [{ path: "x", size: 1 }],
          async function* () {
            yield Buffer.alloc(length);
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect((await file.stat()).mode & 0o200).not.toBe(0);
      await file.close();
    }
    const { file } = await fixture();
    const controller = new AbortController();
    await expect(
      writeExportZip(
        file,
        [{ path: "x", size: 1 }],
        async function* () {
          controller.abort();
          yield Buffer.from("x");
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect((await file.stat()).mode & 0o200).not.toBe(0);
    await file.close();
  });
});
