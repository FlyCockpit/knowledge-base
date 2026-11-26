import { beforeEach, describe, expect, it, vi } from "vitest";

import { FILE_REQUEST_TTL_MS, useKbWorkspaceStore } from "@/stores/kb-workspace";
import { claimFileRequest, fileRequestFor } from "./use-workspace-file-request";

const KB = "k".repeat(24);
const move = { kind: "move" as const, path: "a.md", toPath: "b.md" };
const ME = "user:me";

describe("fileRequestFor", () => {
  const pending = { owner: ME, kbId: KB, request: move, at: 1_000, id: 1 };
  const always = () => true;
  it("hands a fresh request of the right kind and KB to the page that accepts it", () => {
    expect(fileRequestFor(pending, ME, KB, "move", always, 2_000)).toEqual(move);
    expect(fileRequestFor(pending, ME, KB, "move", (r) => r.path === "a.md", 2_000)).toEqual(move);
  });
  it("ignores another KB, another kind, another path and a stale request", () => {
    expect(fileRequestFor(pending, ME, "o".repeat(24), "move", always, 2_000)).toBeNull();
    expect(fileRequestFor(pending, ME, KB, "delete", always, 2_000)).toBeNull();
    expect(fileRequestFor(pending, ME, KB, "move", (r) => r.path === "x.md", 2_000)).toBeNull();
    expect(
      fileRequestFor(pending, ME, KB, "move", always, 1_000 + FILE_REQUEST_TTL_MS + 1),
    ).toBeNull();
    expect(fileRequestFor(null, ME, KB, "move", always, 2_000)).toBeNull();
  });
  it("is never another account's, nor anyone's without a viewer", () => {
    expect(fileRequestFor(pending, "user:other", KB, "move", always, 2_000)).toBeNull();
    expect(fileRequestFor(pending, null, KB, "move", always, 2_000)).toBeNull();
  });
});

describe("file requests in the workspace store", () => {
  beforeEach(() => useKbWorkspaceStore.setState({ fileRequest: null }));
  it("keeps the newest request and takes only the one named", () => {
    const store = useKbWorkspaceStore.getState();
    store.requestFile(ME, KB, move);
    const first = useKbWorkspaceStore.getState().fileRequest;
    store.requestFile(ME, KB, { kind: "delete", path: "a.md" });
    const second = useKbWorkspaceStore.getState().fileRequest;
    expect(second?.request).toEqual({ kind: "delete", path: "a.md" });
    expect(second?.id).toBeGreaterThan(first?.id ?? 0);
    // Taking an older request leaves the newer one.
    expect(store.takeFileRequest(first?.id ?? -1)).toBe(false);
    expect(useKbWorkspaceStore.getState().fileRequest).toEqual(second);
    expect(store.takeFileRequest(second?.id ?? -1)).toBe(true);
    expect(store.takeFileRequest(second?.id ?? -1)).toBe(false);
    expect(useKbWorkspaceStore.getState().fileRequest).toBeNull();
  });
  it("forgets a request when the workspace that asked goes", () => {
    useKbWorkspaceStore.getState().requestFile(ME, KB, move);
    useKbWorkspaceStore.getState().clearFileRequest();
    expect(useKbWorkspaceStore.getState().fileRequest).toBeNull();
  });
  it("applies a request once, also when the effect runs again (StrictMode replay)", () => {
    useKbWorkspaceStore.getState().requestFile(ME, KB, move);
    const pending = useKbWorkspaceStore.getState().fileRequest;
    if (!pending) throw new Error("no request");
    const apply = vi.fn();
    const take = useKbWorkspaceStore.getState().takeFileRequest;
    expect(claimFileRequest(pending, move, take, apply)).toBe(true);
    // The replayed effect holds the same `pending`: it claims nothing.
    expect(claimFileRequest(pending, move, take, apply)).toBe(false);
    expect(apply).toHaveBeenCalledOnce();
  });
});
