import { describe, expect, it } from "vitest";

describe("git write capability worker boundary", () => {
  it.each([
    "lib/kb/issue-write-capability",
    "server/issue-git-write-capability",
    "lib/kb/write-capability-state",
  ])("cannot resolve the private issuance surface: %s", async (path) => {
    const spec = `@knowledge-base/api/${path}`;
    await expect(import(/* @vite-ignore */ spec)).rejects.toThrow(
      /is not exported|ERR_PACKAGE_PATH_NOT_EXPORTED/,
    );
  });

  it("cannot mint or self-register a no-op fence through surviving exports", async () => {
    const pub = await import("@knowledge-base/api/lib/kb/write-capability");
    expect(Object.keys(pub).sort()).toEqual(["assertGitWriteCapability", "isGitWriteCapability"]);
    const lock = await import("@knowledge-base/api/lib/kb/lock");
    const authority = await import("@knowledge-base/api/lib/kb/authority-lock");
    for (const surface of [pub, lock, authority]) {
      for (const name of [
        "issueGitWriteCapability",
        "createGitWriteIssuer",
        "mintGitWriteIssuer",
        "registerGitWriteFenceAssert",
        "issuedCapabilities",
      ]) {
        expect(surface).not.toHaveProperty(name);
      }
    }
    const selfRegistered = { opId: "worker", kbId: "kb1", assertFence: () => undefined };
    expect(pub.isGitWriteCapability(selfRegistered)).toBe(false);
    expect(() => pub.assertGitWriteCapability(selfRegistered)).toThrow(/not issued/);
  });
});
