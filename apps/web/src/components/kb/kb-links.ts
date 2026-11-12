/**
 * Document URL; `rev` pins an immutable commit (citations always pass theirs).
 * `pr` opens the editor on that pull request's version (PR mode, R3-W6).
 */
export function kbDocumentHref(
  lang: string,
  kbId: string,
  target: { path?: string; rev?: string; mode?: "edit"; pr?: number; hash?: string },
): string {
  const params = new URLSearchParams();
  if (target.path) params.set("path", target.path);
  if (target.rev) params.set("rev", target.rev);
  if (target.mode) params.set("mode", target.mode);
  if (target.pr !== undefined) params.set("pr", String(target.pr));
  const query = params.toString();
  return `/${encodeURIComponent(lang)}/kbs/${encodeURIComponent(kbId)}/documents${query ? `?${query}` : ""}${target.hash ? `#${target.hash}` : ""}`;
}

/** Proposal review page. */
export const proposalHref = (lang: string, kbId: string, number: number) =>
  `/${encodeURIComponent(lang)}/kbs/${encodeURIComponent(kbId)}/prs/${number}`;
