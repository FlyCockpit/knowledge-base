import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportDescriptor, preflightExportEntries, writeExportZip } from "./exports";
import { kbReadToolSchemas } from "./protocol/reads";

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

describe("export job descriptor", () => {
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    kbId: "a".repeat(24),
    actorKey: "user:u",
    kind: "whole",
    rev: "b".repeat(40),
    size: 100,
    contentHash: `sha256:${"c".repeat(64)}`,
    expiresAt: new Date(Date.now() + 60_000),
    failureCode: null,
    progressBytes: 40,
    totalBytes: 80,
  };
  const valid = (job: ReturnType<typeof exportDescriptor>) =>
    kbReadToolSchemas.knowledge_export_status.output.parse(job);
  it("maps every row state onto the wire job and hides bytes until ready", () => {
    const cases = [
      ["PENDING", "pending"],
      ["WRITING", "building"],
      ["READY", "ready"],
      ["FAILED", "failed"],
      ["CANCELLED", "cancelled"],
      ["ABORTED", "expired"],
      ["DOWNLOADED", "expired"],
    ] as const;
    for (const [state, wire] of cases) {
      const job = valid(
        exportDescriptor({
          ...row,
          state,
          failureCode: state === "FAILED" ? "QUOTA_EXCEEDED" : null,
        }),
      );
      expect(job.state, state).toBe(wire);
      if (wire === "ready") {
        expect(job).toMatchObject({ size: 100, contentHash: row.contentHash, error: null });
        expect(job.progress).toEqual({ doneBytes: 80, totalBytes: 80 });
      } else {
        expect(job).toMatchObject({ size: null, contentHash: null, expiresAt: null });
      }
      if (wire === "failed")
        expect(job.error).toEqual({ code: "QUOTA_EXCEEDED", message: expect.any(String) });
      else expect(job.error).toBeNull();
    }
  });
  it("a READY row past its expiry is expired; an unknown failure code is STORAGE_UNAVAILABLE", () => {
    expect(
      valid(exportDescriptor({ ...row, state: "READY", expiresAt: new Date(Date.now() - 1) }))
        .state,
    ).toBe("expired");
    expect(
      valid(exportDescriptor({ ...row, state: "FAILED", failureCode: "SOMETHING_ELSE" })).error,
    ).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
