/** The search relevance meter's details: a named dialog, keyboard-operable, focus returns.
 * Unknown calibration's neutral rank-only behavior is covered by search-results.test.tsx.
 */
import { randomUUID } from "node:crypto";
import enKb from "@knowledge-base/locales/src/en-US/kb.json" with { type: "json" };
import { expect, type Page, test } from "@playwright/test";
import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";
import type {} from "./kb-editor.harness";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("Run through pnpm test:kb -- browser");
const fx = JSON.parse(raw) as KbBrowserFixtureData;
let actors: { cookies: { owner: string } } = fx.settings;

async function as(page: Page) {
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: fx.cookie.name, value: actors.cookies.owner, url: fx.origin, httpOnly: true },
    {
      name: "better-auth.session_token",
      value: actors.cookies.owner,
      url: fx.origin,
      httpOnly: true,
    },
  ]);
}

test("relevance details open as a named dialog, close on Escape and return focus", async ({
  page,
}) => {
  await as(page);
  const response = await page.request.post(`${fx.origin}/fixture/editor/actors`);
  expect(response.ok()).toBe(true);
  actors = await response.json();
  await as(page);
  await page.goto(`${fx.origin}/kb-editor`);
  await expect(page.getByRole("button", { name: enKb.list.create, exact: true })).toBeVisible({
    timeout: 25_000,
  });
  const kbId = await page.evaluate(async (slug) => {
    const { orpc, kbAttachmentSchema, queryClient } = window.__kbEditor;
    const created = await orpc.kbs.create.call({
      name: slug,
      slug,
      description: "Relevance details KB",
      idempotencyKey: crypto.randomUUID(),
    });
    const kb = kbAttachmentSchema.parse(created.kb);
    const sha = kb.headSha ?? "0".repeat(40);
    // A served reply as the browser receives it (the harness keeps it fresh for 5 min).
    queryClient.setQueryData(
      orpc.search.hybrid.queryOptions({ input: { kbId: kb.id, query: "flour and gluten" } })
        .queryKey,
      {
        generationId: "g".repeat(24),
        freshness: "current",
        indexedCommitSha: sha,
        headSha: sha,
        indexNotices: [],
        calibration: "embeddinggemma-2-q8_0",
        indexedCommittedAt: null,
        results: [
          {
            knowledgeBaseId: kb.id,
            knowledgeBaseName: slug,
            path: "baking/sourdough.md",
            documentId: null,
            commitSha: sha,
            blobSha: "b".repeat(40),
            contentHash: `sha256:${"c".repeat(64)}`,
            chunkIndex: 0,
            span: { startToken: 0, endToken: 6, startByte: 0, endByte: 30 },
            snippet: "Strong flour builds the gluten network.",
            score: 0.9,
            mode: "hybrid",
            indexGenerationId: "g".repeat(24),
            freshness: "current",
            documentCitations: [],
            assetRefs: [],
            matchedRow: null,
            relevance: { semantic: 0.71, semanticRank: 1, keyword: true, keywordRank: 1 },
          },
        ],
      } as never,
    );
    return kb.id;
  }, `relevance-${randomUUID()}`);
  await page.evaluate(async (href) => {
    await window.__kbEditor.router.navigate({ href });
  }, `/en-US/kbs/${kbId}`);

  const search = page.getByRole("searchbox", { name: enKb.search.queryLabel }).first();
  await search.fill("flour and gluten");
  await search.press("Enter");
  const trigger = page.getByRole("button", { name: /how close is this match\?/ });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: enKb.search.relevance.meterLabel });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("0.71");
  await expect(dialog).toContainText(enKb.search.relevance.keywordYes);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
