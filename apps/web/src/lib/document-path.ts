import {
  isKbNamespacePath,
  isMarkdownPath,
  normalizeKbPath,
} from "@knowledge-base/api/lib/kb/paths";

/**
 * Why a new document's path can't be saved, in the words the path field
 * shows (`kb:editor.pathIssue.<issue>`). The rule is the server's own
 * (`normalizeKbPath`, `isMarkdownPath`, `isKbNamespacePath`), run before a
 * save, so the field explains what to change instead of a refused save.
 * `exists` and `caseCollision` depend on what the KB holds: only the
 * server's answer reports them.
 */
export type DocumentPathIssue =
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
  | "caseCollision"
  | "invalid";

/** The issue with a typed path (already trimmed, as `submitPath` sends it), or null. */
export function documentPathIssue(path: string): DocumentPathIssue | null {
  if (path.length === 0) return "empty";
  // The server takes NFC paths only; the composed form is the same text.
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
  return null;
}

/** A save refusal's closed reason, for a refusal naming the path field. */
export function pathIssueFromReason(reason: unknown): DocumentPathIssue {
  switch (reason) {
    case "NOT_MARKDOWN_PATH":
      return "notMarkdown";
    case "RESERVED_PATH":
      return "reserved";
    case "PATH_CASE_COLLISION":
      return "caseCollision";
    case "CONTROL_CHARACTER":
      return "characters";
    case "PATH_EXISTS":
      return "exists";
    default:
      return "invalid";
  }
}
