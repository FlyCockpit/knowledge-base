import { useEffect, useState } from "react";

import {
  EDITOR_IMAGE_MIMES,
  linkedStagedImages,
  type PendingUpload,
  type StagedImage,
} from "@/hooks/use-kb-editor";

/**
 * Unsaved document drafts survive a reload, a crash or leaving the page
 * by accident, in this browser tab only (`sessionStorage`: gone when the
 * tab closes, never shared with another tab or device). The key carries
 * the signed-in user, so another person in the same tab never gets a draft.
 * The KB's drafts are dropped as its access is lost (`forgetKbDrafts`).
 *
 * A draft records the head it was written on. Reopened, the editor
 * starts there (`useKbEditor`'s `recovered` + `baseRevision`), so a document
 * that changed meanwhile is a conflict the user resolves, never an overwrite.
 */

const PREFIX = "kb-draft:v1:";
const SHA = /^[0-9a-f]{40}$/;
/** sessionStorage holds a few MiB per origin; a draft larger than this is not kept. */
const DRAFT_MAX_CHARS = 2 * 1024 * 1024;
const WRITE_DELAY_MS = 400;

export type StoredDraft = {
  markdown: string;
  /** The head the draft was written on (its next save's base). */
  base: string;
  /** A new draft's typed path. */
  path?: string;
  /**
   * PR mode (resolving a pull request against main): the PR head the draft
   * was written against, next to `base` (main). Both are what its save names.
   */
  proposalHead?: string;
  /**
   * Images uploaded for the draft and linked from it, not yet saved: the
   * next save publishes them (or says the upload expired), so a recovered
   * draft never commits a link to an image it lost.
   */
  images?: StagedImage[];
  savedAt: number;
};

/** A staged upload's content hash, as `runImageStage` names it. */
const HASH = /^sha256:[0-9a-f]{64}$/;

function storedImages(value: unknown): StagedImage[] | null {
  if (!Array.isArray(value)) return null;
  const images: StagedImage[] = [];
  for (const item of value as Partial<StagedImage>[]) {
    if (
      typeof item?.path !== "string" ||
      typeof item.uploadId !== "string" ||
      typeof item.hash !== "string" ||
      !HASH.test(item.hash) ||
      typeof item.size !== "number" ||
      typeof item.mime !== "string" ||
      !(EDITOR_IMAGE_MIMES as readonly string[]).includes(item.mime)
    )
      return null;
    images.push({
      path: item.path,
      uploadId: item.uploadId,
      hash: item.hash,
      size: item.size,
      mime: item.mime,
    });
  }
  return images;
}

/** What a draft belongs to: a user's document target (a new draft has path ""). */
export type DraftTarget = {
  userId: string;
  kbId: string;
  path: string;
  /** null on main; a proposal's number when the target is that proposal. */
  proposal: number | null;
  /** PR mode: resolving that proposal against main (its own drafts). */
  resolving?: boolean;
};

export function draftKey(target: DraftTarget): string {
  return `${PREFIX}${JSON.stringify([
    target.userId,
    target.kbId,
    target.proposal === null
      ? "main"
      : target.resolving
        ? `resolve:${target.proposal}`
        : target.proposal,
    target.path,
  ])}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Storage disabled (privacy settings): drafts are simply not kept.
    return null;
  }
}

export function readDraft(key: string): StoredDraft | null {
  const raw = storage()?.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredDraft>;
    const images = value.images === undefined ? [] : storedImages(value.images);
    if (
      images === null ||
      typeof value.markdown !== "string" ||
      typeof value.base !== "string" ||
      !SHA.test(value.base) ||
      typeof value.savedAt !== "number" ||
      (value.path !== undefined && typeof value.path !== "string") ||
      (value.proposalHead !== undefined &&
        (typeof value.proposalHead !== "string" || !SHA.test(value.proposalHead)))
    )
      return null;
    return {
      markdown: value.markdown,
      base: value.base,
      savedAt: value.savedAt,
      ...(value.path !== undefined ? { path: value.path } : {}),
      ...(value.proposalHead !== undefined ? { proposalHead: value.proposalHead } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
  } catch {
    return null;
  }
}

export function writeDraft(key: string, draft: StoredDraft): void {
  const store = storage();
  if (!store) return;
  if (draft.markdown.length > DRAFT_MAX_CHARS) {
    store.removeItem(key);
    return;
  }
  try {
    store.setItem(key, JSON.stringify(draft));
  } catch {
    // Quota exceeded: keep nothing rather than a stale copy.
    store.removeItem(key);
  }
}

export function clearDraft(key: string): void {
  storage()?.removeItem(key);
}

/** Access to the KB is gone: drop every draft of it in this tab. */
export function forgetKbDrafts(kbId: string): void {
  const store = storage();
  if (!store) return;
  const doomed: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const [, kb] = JSON.parse(key.slice(PREFIX.length)) as unknown[];
      if (kb === kbId) doomed.push(key);
    } catch {
      doomed.push(key);
    }
  }
  for (const key of doomed) store.removeItem(key);
}

/** An upload placeholder link (`insertImagesIntoDraft`), with the break before it. */
const UPLOAD_PLACEHOLDER = /(?:\n\n)?!\[[^\]\n]*\]\(kb-upload:[^)\s]*\)/g;

/**
 * The draft to keep: the live text as if a pending upload were abandoned
 * now. Its placeholder block goes back to the selection it replaced, and
 * any other placeholder (an upload this tab could not finish after a reload)
 * is dropped. Everything typed meanwhile, before or after it, stays.
 */
export function storableDraft(markdown: string, pending: PendingUpload | null): string {
  const text =
    pending && pending.inserted !== "" && markdown.includes(pending.inserted)
      ? markdown.replace(pending.inserted, () => pending.selected)
      : markdown;
  return text.replace(UPLOAD_PLACEHOLDER, "");
}

export type DraftState = {
  key: string | null;
  dirty: boolean;
  /** A save is in flight: leaving could lose its outcome. */
  pending: boolean;
  markdown: string;
  base: string;
  path?: string;
  /** PR mode: the proposal head the session's saves name. */
  proposalHead?: string;
  /** The session's staged images; those the draft links are kept with it. */
  images?: readonly StagedImage[];
  /** An image insertion still uploading: kept around, never as its placeholder. */
  pendingUpload?: PendingUpload | null;
};

/**
 * The draft-keeping rules, apart from React so they are testable:
 *
 * - unsaved: stored `delay` ms after the last change, and at once when the
 *   page hides, unloads or the editor unmounts (an in-app navigation);
 * - saved or discarded (not dirty): its entry is removed;
 * - a key change (a new draft's create moved it to its path): the old entry
 *   is removed, the draft now lives under the new key;
 * - `guard`: unsaved work or a save in flight, so leaving should ask;
 * - an image still uploading is never stored as its `kb-upload:` placeholder:
 *   the kept text is `storableDraft` (the selection it replaced back, every
 *   other edit kept).
 */
export class DraftKeeper {
  private state: DraftState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly delay = WRITE_DELAY_MS) {}

  get guard(): boolean {
    return Boolean(this.state && (this.state.dirty || this.state.pending));
  }

  update(next: DraftState): void {
    const previous = this.state;
    this.state = next;
    if (previous?.key && previous.key !== next.key) {
      this.cancel();
      clearDraft(previous.key);
    }
    if (next.key === null) {
      this.cancel();
      return;
    }
    if (!next.dirty) {
      this.cancel();
      clearDraft(next.key);
      return;
    }
    this.cancel();
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  /** Store the unsaved draft now. */
  flush(): void {
    this.cancel();
    const state = this.state;
    if (!state?.key || !state.dirty) return;
    const markdown = storableDraft(state.markdown, state.pendingUpload ?? null);
    const images = linkedStagedImages(markdown, state.images ?? []).map(
      ({ path, uploadId, hash, size, mime }) => ({ path, uploadId, hash, size, mime }),
    );
    writeDraft(state.key, {
      markdown,
      base: state.base,
      savedAt: Date.now(),
      ...(state.path !== undefined ? { path: state.path } : {}),
      ...(state.proposalHead !== undefined ? { proposalHead: state.proposalHead } : {}),
      ...(images.length > 0 ? { images } : {}),
    });
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Keeps the session's draft in this tab while it is unsaved
 * (`DraftKeeper`), and asks before the page unloads with unsaved work or a
 * save in flight (the browser's own `beforeunload` prompt). `key` null:
 * nothing is kept (a read-only view).
 */
export function useDocumentDraft(state: DraftState): {
  /**
   * Store the unsaved draft now and say whether it really was kept (read back):
   * false when storage refused it (blocked, quota) or it is too large to keep.
   * Leaving an editor whose draft wasn't kept must ask first.
   */
  keepNow: () => boolean;
} {
  const [keeper] = useState(() => new DraftKeeper());
  const { key, dirty, pending, markdown, base, path, proposalHead, images, pendingUpload } = state;
  useEffect(() => {
    keeper.update({
      key,
      dirty,
      pending,
      markdown,
      base,
      path,
      proposalHead,
      images,
      pendingUpload,
    });
  }, [keeper, key, dirty, pending, markdown, base, path, proposalHead, images, pendingUpload]);
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") keeper.flush();
    };
    const flush = () => keeper.flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
      // Leaving the page in the app: keep what is unsaved.
      keeper.flush();
    };
  }, [keeper]);
  const guard = dirty || pending;
  useEffect(() => {
    // Registered only while needed: a beforeunload listener can keep the
    // page out of the browser's back/forward cache.
    if (!guard) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      keeper.flush();
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [keeper, guard]);
  return {
    keepNow: () => {
      if (!key) return false;
      keeper.flush();
      return readDraft(key) !== null;
    },
  };
}
