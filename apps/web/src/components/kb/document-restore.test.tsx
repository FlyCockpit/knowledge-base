import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { DeletedDocuments, deletedListState } from "@/components/kb/deleted-documents";
import {
  compactDiff,
  DeletedDocumentNotice,
  deletedDocumentInput,
  restoreTarget,
} from "@/components/kb/document-restore";
import { lineDiff } from "@/components/kb/pr-diff";
import { renderWithTestRouter } from "@/lib/router-test-utils";
import { orpc } from "@/utils/orpc";

const KB = "kb1";
const DELETE = "d".repeat(40);
const LAST = "c".repeat(40);

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb", "common"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

const web = { kind: "web" as const, name: "Ana", via: null };
type DeletedRow = NonNullable<
  Awaited<ReturnType<AppRouterClient["documents"]["deleted"]>>
>["items"][number];
const deletion: DeletedRow = {
  path: "notes/a.md",
  deletedSha: DELETE,
  revision: LAST,
  deletedAt: "2026-11-20T10:00:00.000Z",
  actor: web,
};

function renderNotice(rows: DeletedRow[], canRestore = true) {
  const client = new QueryClient();
  client.setQueryData(
    orpc.documents.deleted.queryOptions({ input: deletedDocumentInput(KB, "notes/a.md") }).queryKey,
    () => ({ items: rows, nextCursor: null, windowDays: null, capped: false }),
  );
  return renderWithTestRouter(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <DeletedDocumentNotice
          lang="en-US"
          kbId={KB}
          kbHeadSha={DELETE}
          canRestore={canRestore}
          proposing={false}
          path="notes/a.md"
          onRestored={() => {}}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("compactDiff", () => {
  it("keeps changes with two lines of context and collapses the rest", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n");
    expect(compactDiff(lineDiff(before, after))).toEqual([
      { kind: "gap", count: 2 },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
      { kind: "removed", text: "e" },
      { kind: "added", text: "E" },
      { kind: "same", text: "f" },
      { kind: "same", text: "g" },
      { kind: "gap", count: 1 },
    ]);
  });

  it("shows a deleted document's whole text as coming back", () => {
    expect(compactDiff(lineDiff(null, "one\ntwo"))).toEqual([
      { kind: "added", text: "one" },
      { kind: "added", text: "two" },
    ]);
  });
});

describe("restoreTarget", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const KB_HEAD = "c".repeat(40);
  const P = "d".repeat(40);
  const gone = new ORPCError("NOT_FOUND", { data: { details: { reason: "PATH_NOT_FOUND" } } });
  const old = { markdown: "old text", commitSha: A };

  it("ignores the version a failed refetch kept after a delete", () => {
    const target = restoreTarget({
      source: old,
      // Read before the delete, then 404: the cache still holds the old version.
      current: { data: { markdown: "old text", commitSha: B }, error: gone, isError: true },
      against: null,
      kbHeadSha: KB_HEAD,
    });
    expect(target).toMatchObject({ deleted: true, ready: true, same: false, head: KB_HEAD });
    expect(target.now).toBeUndefined();
  });

  it("writes onto a conflict's reported head, e.g. the caller's own pull request", () => {
    expect(
      restoreTarget({
        source: old,
        current: { data: { markdown: "proposed text", commitSha: P }, error: null, isError: false },
        against: { headSha: P, proposalNumber: 4 },
        kbHeadSha: KB_HEAD,
      }),
    ).toMatchObject({ deleted: false, ready: true, same: false, head: P });
  });

  it("has nothing to restore when the version is already current, and waits for reads", () => {
    expect(
      restoreTarget({
        source: old,
        current: { data: { markdown: "old text", commitSha: B }, error: null, isError: false },
        against: null,
        kbHeadSha: KB_HEAD,
      }),
    ).toMatchObject({ same: true, head: B });
    expect(
      restoreTarget({
        source: undefined,
        current: { data: undefined, error: null, isError: false },
        against: null,
        kbHeadSha: KB_HEAD,
      }).ready,
    ).toBe(false);
  });
});

describe("a document main deleted", () => {
  it("says when and by whom, and offers its last version back", () => {
    const out = renderNotice([deletion]);
    expect(out).toContain('data-testid="document-deleted"');
    expect(out).toContain("This document was deleted on");
    expect(out).toContain("Ana in the web app");
    expect(out).toContain('data-testid="document-restore-last"');
    expect(out).toContain(enKb.restore.restoreLast);
    // "View the last version" opens the revision before the deletion.
    expect(out).toContain(`rev=${LAST}`);
    expect(out).not.toContain(`rev=${DELETE}`);
  });

  it("offers only to view the last version to a reader who can't write", () => {
    const out = renderNotice([deletion], false);
    expect(out).not.toContain('data-testid="document-restore-last"');
    expect(out).toContain(enKb.restore.viewLast);
  });

  it("offers Try again when the deletion lookup failed, never 'doesn't exist'", async () => {
    // As after the failed fetch (a static render would otherwise refetch on mount).
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    await client.prefetchQuery({
      queryKey: orpc.documents.deleted.queryOptions({
        input: deletedDocumentInput(KB, "notes/a.md"),
      }).queryKey,
      queryFn: () => Promise.reject(new Error("offline")),
      retry: false,
    });
    const out = renderWithTestRouter(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <DeletedDocumentNotice
            lang="en-US"
            kbId={KB}
            kbHeadSha={DELETE}
            canRestore
            proposing={false}
            path="notes/a.md"
            onRestored={() => {}}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(out).toContain(enKb.document.deletedLoadFailed.replace("'", "&#x27;"));
    expect(out).not.toContain("This document doesn&#x27;t exist");
  });

  it("is the plain not-found line for a path main never deleted", () => {
    const out = renderNotice([]);
    expect(out).not.toContain('data-testid="document-deleted"');
    expect(out).toContain("This document doesn&#x27;t exist at this revision.");
  });
});

describe("Recently deleted on the KB page", () => {
  it("is collapsed and reads nothing until asked for", () => {
    const client = new QueryClient();
    const out = renderWithTestRouter(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <DeletedDocuments
            lang="en-US"
            kbId={KB}
            kbHeadSha={DELETE}
            canRestore
            proposing={false}
            onRestored={() => {}}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(out).toContain('data-testid="deleted-documents-toggle"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(enKb.deleted.title);
    const deleted = client.getQueryCache().findAll({ queryKey: orpc.documents.deleted.key() });
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.every((query) => query.isDisabled())).toBe(true);
    expect(out).not.toContain('data-testid="deleted-documents"');
  });
});

describe("Recently deleted list text", () => {
  const page = (items: DeletedRow[], capped = false) => ({
    items,
    nextCursor: null,
    windowDays: 30,
    capped,
  });
  it("states the window when nothing was deleted in it", () => {
    expect(deletedListState([page([])], false)).toEqual({
      rows: [],
      days: 30,
      note: { key: "deleted.empty", days: 30 },
    });
  });
  it("never says nothing was deleted when the scan was cut short", () => {
    expect(deletedListState([page([], true)], false).note).toEqual({ key: "deleted.cappedEmpty" });
    expect(enKb.deleted.cappedEmpty).not.toContain("No documents were deleted");
    // Empty means none is still deleted (an Undo leaves the list empty), not
    // that nothing was ever deleted.
    expect(enKb.deleted.empty).toContain("are still deleted");
  });
  it("notes a cut-short list under its rows, and says nothing extra otherwise", () => {
    expect(deletedListState([page([deletion]), page([], true)], false)).toMatchObject({
      rows: [deletion],
      note: { key: "deleted.capped" },
    });
    expect(deletedListState([page([deletion])], false).note).toBeNull();
  });
  it("shows nothing once access is denied", () => {
    expect(deletedListState([page([deletion], true)], true)).toEqual({
      rows: [],
      days: null,
      note: null,
    });
  });
});
