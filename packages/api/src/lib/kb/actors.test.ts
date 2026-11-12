import { describe, expect, it } from "vitest";
import { actedByTrailer, displayLine, resolveActors, sameActorPerson, withTrailer } from "./actors";
import type { LockQuery } from "./lock";

const GRANT = "00000000-0000-4000-8000-000000000001";
const OAUTH = "00000000-0000-4000-8000-000000000002";
function fakeQuery(): { query: LockQuery; sql: string[] } {
  const sql: string[] = [];
  const query = (async (text: string) => {
    sql.push(text);
    if (text.includes('FROM "user"'))
      return { rows: [{ id: "bob", name: "Bob Builder" }], rowCount: 1 };
    return {
      rows: [
        {
          id: GRANT,
          userId: "bob",
          userName: "Bob Builder",
          tokenName: "bob-direct",
          clientName: null,
          clientId: "pat",
        },
        {
          id: OAUTH,
          userId: "ada",
          userName: "Ada\nLovelace",
          tokenName: null,
          clientName: "Claude",
          clientId: "client-1",
        },
      ],
      rowCount: 2,
    };
  }) as LockQuery;
  return { query, sql };
}

describe("PR actors and the Acted-by trailer", () => {
  it("resolves sessions and grants to the person and how they acted", async () => {
    const { query } = fakeQuery();
    const actors = await resolveActors(query, ["user:bob", `grant:${GRANT}`, `grant:${OAUTH}`]);
    expect(actors.get("user:bob")).toEqual({ userId: "bob", name: "Bob Builder", via: null });
    expect(actors.get(`grant:${GRANT}`)).toEqual({
      userId: "bob",
      name: "Bob Builder",
      via: "bob-direct",
    });
    // Names become one bounded display line.
    expect(actors.get(`grant:${OAUTH}`)).toEqual({
      userId: "ada",
      name: "Ada Lovelace",
      via: "Claude",
    });
  });
  it("skips malformed keys without querying for them", async () => {
    const { query, sql } = fakeQuery();
    expect((await resolveActors(query, ["grant:not-a-uuid", "nobody"])).size).toBe(0);
    expect(sql).toEqual([]);
  });
  it("one person owns what any of their credentials opened", async () => {
    const { query } = fakeQuery();
    expect(await sameActorPerson(query, "user:bob", "bob", `grant:${GRANT}`)).toBe(true);
    expect(await sameActorPerson(query, `grant:${OAUTH}`, "ada", `grant:${GRANT}`)).toBe(false);
    expect(await sameActorPerson(query, "user:x", "x", "user:x")).toBe(true);
  });
  it("formats the trailer without emails", async () => {
    const { query } = fakeQuery();
    expect(await actedByTrailer(query, "user:bob")).toBe("Acted-by: Bob Builder via web");
    expect(await actedByTrailer(query, `grant:${GRANT}`)).toBe(
      "Acted-by: Bob Builder via bob-direct",
    );
    expect(withTrailer("Update a.md\n", "Acted-by: Bob Builder via web")).toBe(
      "Update a.md\n\nActed-by: Bob Builder via web\n",
    );
    expect(withTrailer("Update a.md", null)).toBe("Update a.md\n");
    // A dream's digest trailers and Acted-by stay one trailer block.
    expect(
      withTrailer(
        "Dream\n\nKb-Op-Digest: sha256:a\nKb-Source-Digest: sha256:b",
        "Acted-by: X via web",
      ),
    ).toBe("Dream\n\nKb-Op-Digest: sha256:a\nKb-Source-Digest: sha256:b\nActed-by: X via web\n");
    // A one-paragraph title that merely looks like "Key: value" is not a trailer block.
    expect(withTrailer("Fix: typo", "Acted-by: X via web")).toBe(
      "Fix: typo\n\nActed-by: X via web\n",
    );
    expect(displayLine(`${"x".repeat(100)}`)?.length).toBe(80);
    expect(displayLine("‮\u0000 ")).toBeNull();
  });
});
