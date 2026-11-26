/**
 * Pure rules of the workspace tree's file operations: the paths a rename,
 * move, new file or upload produces, and whether the server would take them.
 * The server stays the authority (a refusal it reports still shows); these
 * only let the UI explain a bad name before anything is sent.
 *
 * Folders are "a/b/" (trailing slash) and the KB root is "", as in tree.ts.
 */
import {
  isKbNamespacePath,
  isMarkdownPath,
  normalizeKbPath,
} from "@knowledge-base/api/lib/kb/paths";

import {
  ASSET_MAX_BYTES,
  DOCUMENT_STAGED_ASSETS_MAX,
  isEditorImageMime,
  STAGED_MARKDOWN_MAX_BYTES,
} from "@/hooks/use-kb-editor";

/**
 * Why a document path can't be used, as the field explains it
 * (`kb:workspace.fileOps.pathIssue.<issue>`). Same closed reasons as the
 * editor's path field; `exists` needs the KB's own listing.
 */
export type FilePathIssue =
  | "empty"
  | "absolute"
  | "segment"
  | "characters"
  | "portable"
  | "reserved"
  | "tooLong"
  | "tooDeep"
  | "notMarkdown"
  | "exists"
  | "invalid";

/** The server's own path rule (`normalizeKbPath`, markdown, namespace), or null when usable. */
export function pathIssue(path: string, existing?: ReadonlySet<string>): FilePathIssue | null {
  if (path.length === 0) return "empty";
  const normalized = normalizeKbPath(path.normalize("NFC"));
  if (!normalized.ok) {
    switch (normalized.issue.code) {
      case "PATH_ABSOLUTE":
        return "absolute";
      case "PATH_EMPTY":
      case "PATH_DOT":
      case "PATH_DOTDOT":
        return "segment";
      case "PATH_BACKSLASH":
      case "PATH_CONTROL":
      case "PATH_BOM":
      case "PATH_NOT_UTF8":
        return "characters";
      case "PATH_NOT_PORTABLE":
        return "portable";
      case "PATH_GIT_RESERVED":
      case "PATH_WINDOWS_RESERVED":
        return "reserved";
      case "PATH_TOO_LONG":
        return "tooLong";
      case "PATH_TOO_DEEP":
        return "tooDeep";
      default:
        return "invalid";
    }
  }
  if (isKbNamespacePath(normalized.path)) return "reserved";
  if (!isMarkdownPath(normalized.path)) return "notMarkdown";
  if (existing && hasPathCaseless(existing, normalized.path)) return "exists";
  return null;
}

/** An existing document path, compared without case (the server refuses case collisions). */
function hasPathCaseless(existing: ReadonlySet<string>, path: string): boolean {
  if (existing.has(path)) return true;
  const lower = path.toLowerCase();
  for (const other of existing) if (other.toLowerCase() === lower) return true;
  return false;
}

/** The folder a path lives in ("" for the root). */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash + 1);
}

/** The last segment of a path. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A typed name made a document name: trimmed, `.md` added when missing. */
export function documentName(raw: string): string {
  const name = raw.trim();
  if (name === "") return "";
  return name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
}

/** `folder` + `name` (the folder may be "" or end in "/"; a typed name may hold sub-folders). */
export function joinPath(folder: string, name: string): string {
  const base = folder === "" || folder.endsWith("/") ? folder : `${folder}/`;
  return `${base}${name.replace(/^\/+/, "")}`;
}

/** A file renamed in place: same folder, the new name as a document name. */
export function renamedPath(path: string, newName: string): string {
  return joinPath(folderOf(path), documentName(newName));
}

/** A file moved into `targetFolder`, keeping its name. */
export function movedPath(path: string, targetFolder: string): string {
  return joinPath(targetFolder, nameOf(path));
}

/**
 * Whether dropping `source` on `targetFolder` is a move. Only files move in
 * this version: a folder move is one Git rename per document (N commits),
 * which the server has no single operation for. Dropping a file into the
 * folder it is already in is no move.
 */
export function canDrop(source: { kind: "file" | "folder"; path: string }, targetFolder: string) {
  if (source.kind !== "file") return false;
  if (targetFolder !== "" && !targetFolder.endsWith("/")) return false;
  return folderOf(source.path) !== targetFolder;
}

/** A dropped OS file, as far as planning needs it. */
export type DroppedFile = { name: string; type: string; size: number };

export type UploadPlan =
  /** A Markdown file: created as a document at `path`. */
  | { file: DroppedFile; kind: "document"; path: string }
  /** An image: inserted into a new document in the folder (images live in documents). */
  | { file: DroppedFile; kind: "image" }
  | {
      file: DroppedFile;
      kind: "refused";
      reason: "type" | "tooLarge" | "exists" | "path" | "oneAtATime" | "tooManyImages";
      issue?: FilePathIssue;
    };

const isMarkdownFile = (file: DroppedFile) =>
  file.type === "text/markdown" || file.type === "text/x-markdown" || /\.md$/i.test(file.name);

/**
 * What a drop of OS files onto `folder` would do, per file, within the app's
 * own limits (the editor's staged Markdown and asset ceilings). A drop opens
 * one New document draft: the first usable Markdown file is its text (later
 * ones wait for another drop), and images are staged into it.
 */
export function planUpload(
  files: readonly DroppedFile[],
  folder: string,
  existing: ReadonlySet<string>,
): UploadPlan[] {
  let document = false;
  let images = 0;
  return files.map((file): UploadPlan => {
    if (isMarkdownFile(file)) {
      if (file.size > STAGED_MARKDOWN_MAX_BYTES)
        return { file, kind: "refused", reason: "tooLarge" };
      const path = joinPath(folder, documentName(file.name));
      const issue = pathIssue(path, existing);
      if (issue === "exists") return { file, kind: "refused", reason: "exists" };
      if (issue) return { file, kind: "refused", reason: "path", issue };
      if (document) return { file, kind: "refused", reason: "oneAtATime" };
      document = true;
      return { file, kind: "document", path };
    }
    if (isEditorImageMime(file.type)) {
      if (file.size > ASSET_MAX_BYTES) return { file, kind: "refused", reason: "tooLarge" };
      // One save takes at most this many images.
      if (images >= DOCUMENT_STAGED_ASSETS_MAX)
        return { file, kind: "refused", reason: "tooManyImages" };
      images++;
      return { file, kind: "image" };
    }
    return { file, kind: "refused", reason: "type" };
  });
}

/**
 * The New document draft a drop opens (null: nothing in it can be added): the
 * Markdown file's path, or one named after the first image, in `folder`.
 * `markdown` and `images` index into `plan` (the dropped files, in order).
 */
export function dropDraft(
  plan: readonly UploadPlan[],
  folder: string,
): { path: string; markdown: number | null; images: number[] } | null {
  const images = plan.flatMap((item, index) => (item.kind === "image" ? [index] : []));
  const markdown = plan.findIndex((item) => item.kind === "document");
  const item = plan[markdown];
  if (item?.kind === "document") return { path: item.path, markdown, images };
  const first = images[0] === undefined ? undefined : plan[images[0]];
  if (!first) return null;
  const base = first.file.name.replace(/\.[^./]*$/, "") || "image";
  return { path: joinPath(folder, documentName(base)), markdown: null, images };
}
