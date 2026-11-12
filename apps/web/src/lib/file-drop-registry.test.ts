import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dataTransferHasFiles,
  findFileDropTarget,
  registerFileDropTarget,
} from "./file-drop-registry";

/**
 * Plain-object node stubs on purpose: the registry must duck-type the parent
 * chain (`parentElement ?? parentNode`), never `instanceof Element` — these
 * tests run in Vitest's node environment with no DOM at all.
 */
type FakeNode = {
  parentElement: FakeNode | null;
  parentNode?: FakeNode | null;
};

function makeNode(parentElement: FakeNode | null = null, parentNode?: FakeNode | null): FakeNode {
  return { parentElement, parentNode };
}

const cleanups: (() => void)[] = [];

function register(element: FakeNode, onFiles: (files: File[]) => void) {
  const unregister = registerFileDropTarget(element, onFiles);
  cleanups.push(unregister);
  return unregister;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("findFileDropTarget", () => {
  it("returns the registered target when it appears in composedPath", () => {
    const onFiles = vi.fn();
    const target = makeNode();
    const leaf = makeNode(target);
    register(target, onFiles);

    const hit = findFileDropTarget([leaf, target] as unknown as EventTarget[]);
    expect(hit).not.toBeNull();
    hit?.onFiles([]);
    expect(onFiles).toHaveBeenCalledWith([]);
  });

  it("returns null on a miss", () => {
    const registered = makeNode();
    register(registered, vi.fn());

    const stranger = makeNode(makeNode());
    expect(findFileDropTarget([stranger] as unknown as EventTarget[])).toBeNull();
    expect(findFileDropTarget([])).toBeNull();
  });

  it("prefers the innermost registered element over an ancestor", () => {
    const outerFiles = vi.fn();
    const innerFiles = vi.fn();
    const outer = makeNode();
    const inner = makeNode(outer);
    const leaf = makeNode(inner);
    register(outer, outerFiles);
    register(inner, innerFiles);

    // composedPath is ordered target-first, so inner precedes outer.
    findFileDropTarget([leaf, inner, outer] as unknown as EventTarget[])?.onFiles([]);
    expect(innerFiles).toHaveBeenCalledTimes(1);
    expect(outerFiles).not.toHaveBeenCalled();
  });

  it("does not let a sibling zone steal a drop", () => {
    const aFiles = vi.fn();
    const bFiles = vi.fn();
    const parent = makeNode();
    const zoneA = makeNode(parent);
    const zoneB = makeNode(parent);
    register(zoneA, aFiles);
    register(zoneB, bFiles);

    findFileDropTarget([zoneA, parent] as unknown as EventTarget[])?.onFiles([]);
    expect(aFiles).toHaveBeenCalledTimes(1);
    expect(bFiles).not.toHaveBeenCalled();
  });

  it("walks the parentElement chain when composedPath is truncated", () => {
    const onFiles = vi.fn();
    const target = makeNode();
    const mid = makeNode(target);
    const leaf = makeNode(mid);
    register(target, onFiles);

    // Only the event target itself — the ancestors come from the walk.
    findFileDropTarget([leaf] as unknown as EventTarget[])?.onFiles([]);
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("falls back to parentNode when parentElement is null", () => {
    const onFiles = vi.fn();
    const target = makeNode();
    // e.g. a text node / shadow boundary: no parentElement, only parentNode.
    const leaf = makeNode(null, target);
    register(target, onFiles);

    findFileDropTarget([leaf] as unknown as EventTarget[])?.onFiles([]);
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("stops unregistered targets from matching after cleanup", () => {
    const onFiles = vi.fn();
    const target = makeNode();
    const unregister = register(target, onFiles);

    unregister();
    expect(findFileDropTarget([target] as unknown as EventTarget[])).toBeNull();
  });
});

describe("dataTransferHasFiles", () => {
  it("accepts a drag carrying OS files", () => {
    expect(dataTransferHasFiles({ types: ["Files"] })).toBe(true);
  });

  it("ignores in-page HTML and link drags", () => {
    expect(dataTransferHasFiles({ types: ["text/plain"] })).toBe(false);
    expect(dataTransferHasFiles({ types: ["text/html", "text/uri-list"] })).toBe(false);
  });

  it("ignores a null dataTransfer", () => {
    expect(dataTransferHasFiles(null)).toBe(false);
  });
});
