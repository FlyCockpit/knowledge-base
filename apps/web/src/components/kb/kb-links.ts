/**
 * Document URL; `rev` pins an immutable commit (citations always pass theirs).
 * `pr` opens the editor on that pull request's version (PR mode).
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

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An acceptance request id from a link's search params (`?accept=` / `?transfer=`), else undefined. */
export const acceptRequestId = (value: unknown): string | undefined =>
  typeof value === "string" && REQUEST_ID.test(value) ? value : undefined;

/**
 * KB settings opened from a share invitation (`?accept=<id>`): the recipient
 * cannot read the KB until they accept, so no `kbs.get` runs for it there
 * (it would only answer "not found"). The invitation preview names the KB.
 */
export const awaitsInvitationAccept = (onSettings: boolean, accept: unknown): boolean =>
  onSettings && acceptRequestId(accept) !== undefined;
