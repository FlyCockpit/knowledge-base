import type { z } from "zod";
import { KbDomainError } from "./errors";
import { normalizeKbPath } from "./paths";
import { schemaDiagnostic } from "./protocol/diagnostics";
import {
  KB_FIELD_POINTER_RE,
  type KbConflictReason,
  type KbInvalidArgumentReason,
} from "./protocol/envelope";
import artifact from "./protocol/schema.json" with { type: "json" };

/**
 * Map refusals to the closed `reason` codes and JSON-pointer `field`
 * the kb/1 INVALID_ARGUMENT (and PATH_EXISTS CONFLICT) details carry.
 * Nothing here echoes caller text: an unsafe pointer is dropped.
 */

/** The inclusive bound a value broke: `min` for too small, `max` for too large. */
export type ArgumentBounds = { min?: number; max?: number };
export type ArgumentDetails = { reason: KbInvalidArgumentReason; field?: string } & ArgumentBounds;

/** A JSON pointer from identifier/index segments, or undefined when any segment is unsafe. */
export function fieldPointer(segments: readonly PropertyKey[]): string | undefined {
  if (segments.length === 0) return undefined;
  const parts = segments.map((segment) => String(segment));
  if (parts.some((part) => !/^[A-Za-z0-9_]{1,64}$/.test(part))) return undefined;
  const pointer = `/${parts.join("/")}`;
  return KB_FIELD_POINTER_RE.test(pointer) ? pointer : undefined;
}

const safeBound = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

export function argumentDetails(
  reason: KbInvalidArgumentReason,
  field?: string,
  bounds: ArgumentBounds = {},
): ArgumentDetails {
  const min = safeBound(bounds.min);
  const max = safeBound(bounds.max);
  return {
    reason,
    ...(field && KB_FIELD_POINTER_RE.test(field) ? { field } : {}),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

export function invalidArgument(
  message: string,
  reason: KbInvalidArgumentReason,
  field?: string,
  bounds?: ArgumentBounds,
): KbDomainError {
  return new KbDomainError(
    "INVALID_ARGUMENT",
    message,
    undefined,
    argumentDetails(reason, field, bounds),
  );
}

/** A write that meets stored state it can't apply to is a CONFLICT with a reason. */
export function reasonedConflict(
  message: string,
  reason: KbConflictReason,
  field?: string,
): KbDomainError {
  return new KbDomainError(
    "CONFLICT",
    message,
    undefined,
    field && KB_FIELD_POINTER_RE.test(field) ? { reason, field } : { reason },
  );
}

/** Creating a path that already exists is a CONFLICT, not a bad argument. */
export function pathExists(message: string, field?: string): KbDomainError {
  return reasonedConflict(message, "PATH_EXISTS", field);
}

/** Path issue codes (`paths.ts`) to reasons. */
export function pathIssueReason(code: string | undefined): KbInvalidArgumentReason {
  switch (code) {
    case "PATH_WINDOWS_RESERVED":
    case "PATH_GIT_RESERVED":
      return "RESERVED_PATH";
    case "PATH_CASE_COLLISION":
      return "PATH_CASE_COLLISION";
    case "PATH_CONTROL":
      return "CONTROL_CHARACTER";
    default:
      return "INVALID_PATH";
  }
}

/** Markdown issue codes (`parse-markdown.ts`) to reasons. */
export function markdownIssueReason(code: string | undefined): KbInvalidArgumentReason {
  if (code === "MARKDOWN_CONTROL") return "CONTROL_CHARACTER";
  if (code === "MARKDOWN_DOCUMENT_ID_DUPLICATE") return "DUPLICATE_DOCUMENT_ID";
  if (code === "MARKDOWN_UTF8") return "INVALID_MARKDOWN";
  if (code?.startsWith("MARKDOWN_")) return "INVALID_FRONT_MATTER";
  return "INVALID_MARKDOWN";
}

/** Asset manifest issue codes (`manifest.ts`, or an entry path's issue) to reasons. */
export function manifestIssueReason(code: string | undefined): KbInvalidArgumentReason {
  switch (code) {
    // An entry path repeating another (exactly or case-folded) or crossing a file.
    case "MANIFEST_DUPLICATE":
      return "PATH_CASE_COLLISION";
    case "MANIFEST_COLLISION":
      return "RESERVED_PATH";
    case undefined:
    case "MANIFEST_INVALID_JSON":
    case "MANIFEST_SCHEMA":
    case "MANIFEST_SORT":
    case "MANIFEST_LINEAGE":
      return "SCHEMA";
    default:
      return pathIssueReason(code);
  }
}

/** A whole-tree validation failure (`validate-tree.ts`) to a reason and the field it names. */
export function treeFailureDetails(
  failure: { code: string; path?: string; issue?: string },
  fieldFor: (path: string | undefined, key: "path" | "content") => string | undefined,
): ArgumentDetails {
  switch (failure.code) {
    case "TREE_PATH":
      return argumentDetails(pathIssueReason(failure.issue), fieldFor(failure.path, "path"));
    case "TREE_FILE_KIND":
      // The KB's own namespace (`.assets/`, reserved root files) is reserved,
      // whatever the extension; anything else is not a Markdown document.
      return argumentDetails(
        failure.issue === undefined ? "NOT_MARKDOWN_PATH" : pathIssueReason(failure.issue),
        fieldFor(failure.path, "path"),
      );
    case "TREE_MARKDOWN":
      return argumentDetails(markdownIssueReason(failure.issue), fieldFor(failure.path, "content"));
    case "TREE_DOCUMENT_ID":
      return argumentDetails("DUPLICATE_DOCUMENT_ID", fieldFor(failure.path, "content"));
    case "TREE_SEALED":
      return argumentDetails("SEALED_REFERENCE_REVOKED", fieldFor(failure.path, "content"));
    case "TREE_BUDGET":
      return argumentDetails("TOO_LARGE", fieldFor(failure.path, "content"));
    case "TREE_MANIFEST":
      return argumentDetails(manifestIssueReason(failure.issue), fieldFor(failure.path, "path"));
    default:
      return { reason: "SCHEMA" };
  }
}

/** The artifact, rather than validation-library issue order, owns selection. */
export function schemaIssueDetails(
  _error: z.ZodError,
  input: unknown,
  tool?: string,
): ArgumentDetails {
  const tools: Record<string, { input: import("./protocol/diagnostics").SchemaNode }> =
    artifact.tools;
  const schema = tool ? tools[tool]?.input : undefined;
  const issue = schema === undefined ? null : schemaDiagnostic(schema, input);
  if (!issue) return { reason: "SCHEMA" };
  const path = issue.member === undefined ? issue.path : [...issue.path, issue.member];
  const last = path.at(-1);
  const field = fieldPointer(path);
  const bounds = { min: issue.min, max: issue.max };
  let reason: KbInvalidArgumentReason = "SCHEMA";
  if (issue.keyword === "additionalProperties") reason = "UNKNOWN_ARGUMENT";
  else if (last === "confirm") reason = "CONFIRM_REQUIRED";
  else if (issue.keyword === "type") reason = "SCHEMA";
  else if (issue.keyword === "required") reason = "MISSING_ARGUMENT";
  else if (issue.keyword === "maxItems" && last === "changes") reason = "TOO_MANY_CHANGES";
  else if (last === "prefix") reason = "INVALID_PREFIX";
  else if (["maxLength", "x-kb-utf8-max-bytes"].includes(issue.keyword) && last === "query")
    reason = "QUERY_TOO_LONG";
  else if (["minimum", "maximum"].includes(issue.keyword) && last === "limit")
    reason = "LIMIT_OUT_OF_RANGE";
  else if (issue.keyword === "x-kb-change-paths") reason = "PATH_CASE_COLLISION";
  else if (issue.keyword === "x-kb-no-control-chars") reason = "CONTROL_CHARACTER";
  else if (issue.keyword === "x-kb-path") {
    let value = input;
    for (const key of issue.path)
      value =
        value !== null && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    if (typeof value === "string") {
      const normalized = normalizeKbPath(value);
      reason = !normalized.ok ? pathIssueReason(normalized.issue.code) : "INVALID_PATH";
      if (/^[A-Za-z]:/.test(value)) reason = "RESERVED_PATH";
    }
  } else if (
    ["maxLength", "x-kb-utf8-max-bytes", "x-kb-json-encoded-max-bytes"].includes(issue.keyword)
  )
    reason = "TOO_LARGE";
  return argumentDetails(reason, field, bounds);
}
