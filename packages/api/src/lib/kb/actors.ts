import type { LockQuery } from "./lock";

/**
 * The person behind a KB actor key and how they acted:
 * `user:<id>` is a web session, `grant:<id>` a PAT or OAuth app of its user.
 * `via` is the token or app name, or null for the web. `userId` is null only
 * when the grant's user no longer exists.
 */
export type ActorIdentity = {
  userId: string | null;
  name: string | null;
  via: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ACTORS = 100;
const NAME_MAX_CHARS = 80;

/** One display line: no control/format/separator characters, collapsed whitespace, bounded. */
export function displayLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return chars.length <= NAME_MAX_CHARS
    ? cleaned
    : `${chars.slice(0, NAME_MAX_CHARS - 1).join("")}…`;
}

/** Resolve up to 100 distinct actor keys in two bounded reads; unknown keys are absent. */
export async function resolveActors(
  query: LockQuery,
  keys: readonly string[],
): Promise<Map<string, ActorIdentity>> {
  const distinct = [...new Set(keys)].slice(0, MAX_ACTORS);
  const userIds = distinct.filter((k) => k.startsWith("user:")).map((k) => k.slice(5));
  const grantIds = distinct
    .filter((k) => k.startsWith("grant:"))
    .map((k) => k.slice(6))
    .filter((id) => UUID.test(id));
  const out = new Map<string, ActorIdentity>();
  if (userIds.length > 0) {
    const users = await query<{ id: string; name: string | null }>(
      `SELECT id, name FROM "user" WHERE id = ANY($1::text[])`,
      [userIds],
    );
    for (const row of users.rows)
      out.set(`user:${row.id}`, { userId: row.id, name: displayLine(row.name), via: null });
  }
  if (grantIds.length > 0) {
    const grants = await query<{
      id: string;
      userId: string | null;
      userName: string | null;
      tokenName: string | null;
      clientName: string | null;
      clientId: string;
    }>(
      `SELECT g.id::text AS id, g."userId", u.name AS "userName", pt.name AS "tokenName",
              c.name AS "clientName", g."clientId"
         FROM mcp_grant g
         LEFT JOIN "user" u ON u.id = g."userId"
         LEFT JOIN mcp_personal_token pt ON pt."grantId" = g.id
         LEFT JOIN oauth_client c ON c."clientId" = g."clientId"
        WHERE g.id = ANY($1::uuid[])`,
      [grantIds],
    );
    for (const row of grants.rows)
      out.set(`grant:${row.id}`, {
        userId: row.userId,
        name: displayLine(row.userName),
        via: displayLine(row.tokenName ?? row.clientName ?? row.clientId),
      });
  }
  return out;
}

/** The user an actor key acts for, or null when it cannot be resolved. */
async function actorUserId(query: LockQuery, actorKey: string): Promise<string | null> {
  if (actorKey.startsWith("user:")) return actorKey.slice(5) || null;
  return (await resolveActors(query, [actorKey])).get(actorKey)?.userId ?? null;
}

/** Whether two actor keys act for the same person (the person owns the PR). */
export async function sameActorPerson(
  query: LockQuery,
  actorKey: string,
  userId: string,
  ownerActorKey: string,
): Promise<boolean> {
  if (actorKey === ownerActorKey) return true;
  const owner = await actorUserId(query, ownerActorKey);
  return owner !== null && owner === userId;
}

/**
 * `Acted-by:` commit trailer: the person and the credential, never an
 * email. Git keeps the system author; this names who acted.
 */
export async function actedByTrailer(query: LockQuery, actorKey: string): Promise<string | null> {
  const actor = (await resolveActors(query, [actorKey])).get(actorKey);
  if (!actor) return null;
  const name = actor.name ?? "Unknown user";
  return `Acted-by: ${name} via ${actor.via ?? "web"}`;
}

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*: \S/;

/**
 * Append a trailer to a commit message (no-op without one). Git reads only
 * the last paragraph as trailers, so an existing trailer block (a dream's
 * Kb-Op-Digest) is extended rather than followed by a second paragraph.
 */
export function withTrailer(message: string, trailer: string | null): string {
  const body = message.replace(/\s+$/u, "");
  if (!trailer) return `${body}\n`;
  const paragraphs = body.split("\n\n");
  const last = paragraphs.at(-1)!;
  const trailerBlock =
    paragraphs.length > 1 && last.split("\n").every((line) => TRAILER_LINE.test(line));
  return trailerBlock ? `${body}\n${trailer}\n` : `${body}\n\n${trailer}\n`;
}
