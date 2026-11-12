import { expect, type Page, test } from "@playwright/test";

import type {
  KbBrowserFixtureData,
  KbBrowserPr,
} from "../../../packages/test-utils/src/kb/browser";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("KB_BROWSER_FIXTURE is unset; run through `pnpm test:kb -- browser`.");
const fx = JSON.parse(raw) as KbBrowserFixtureData;

const prUrl = (pr: KbBrowserPr) =>
  `${fx.origin}/pr?${new URLSearchParams({ kbId: pr.kbId, number: String(pr.number) })}`;

async function signIn(page: Page, who: "author" | "reviewer") {
  await page
    .context()
    .addCookies([
      { name: fx.cookie.name, value: fx.pr.cookies[who], url: fx.origin, httpOnly: true },
    ]);
}

async function ready(page: Page) {
  // Global setup prepares the module graph; this bounds the actual rendered view.
  await expect(page.getByTestId("pr-review")).toBeVisible({ timeout: 45_000 });
}

async function mainRev(page: Page, kbId: string): Promise<string> {
  const res = await page.request.get(`${fx.origin}/fixture/main?kbId=${kbId}`);
  return ((await res.json()) as { rev: string }).rev;
}

async function confirm(page: Page, token: "MERGE" | "DELETE") {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  // Closing is a plain confirmation (R2-27); merging still types MERGE.
  if (token === "MERGE") await dialog.getByPlaceholder(token).fill(token);
  await dialog
    .getByRole("button", { name: token === "MERGE" ? "Merge pull request" : "Close pull request" })
    // Keyboard activation: the harness loads no app CSS, so the modal's inert
    // backdrop layer is unstyled and would swallow a pointer click.
    .press("Enter");
}

test("reviewer sees both rendered revisions, exact touched hashes and inert HTML, then merges", async ({
  page,
}) => {
  const pr = fx.pr.review;
  const reviews: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/fixture/pr-review")) reviews.push(request.postDataJSON());
  });
  await signIn(page, "reviewer");
  await page.goto(prUrl(pr));
  await ready(page);
  await expect(page.getByTestId("pr-diff-complete")).toBeVisible();

  const card = page.locator(`[data-testid="pr-file"][data-path="${fx.pr.docPath}"]`);
  const before = card.getByTestId("pr-before");
  const after = card.getByTestId("pr-after");
  await expect(before).toContainText("Plain words before.");
  await expect(before).toContainText(pr.baseSha.slice(0, 12));
  await expect(after.locator("strong")).toHaveText("bold words");
  await expect(after.locator("em")).toHaveText("emphasis");
  await expect(after.locator("table td").last()).toHaveText("42");
  await expect(after).toContainText(pr.headSha.slice(0, 12));

  // Media inside each rendered side is bound to that side's revision and hash.
  const beforeImg = before.getByRole("img", { name: "Picture" });
  const afterImg = after.getByRole("img", { name: "Picture" });
  await expect(beforeImg).toHaveAttribute(
    "src",
    `/kb-assets/${pr.kbId}/${pr.hashes.picBefore}?rev=${pr.baseSha}`,
  );
  await expect(afterImg).toHaveAttribute(
    "src",
    `/kb-assets/${pr.kbId}/${pr.hashes.picAfter}?rev=${pr.headSha}`,
  );
  for (const img of [beforeImg, afterImg])
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  await expect(after.locator("video[aria-label='Clip']")).toHaveAttribute("controls", "");

  // Touched assets: exact hashes for replacement, addition and removal.
  const assets = page.getByTestId("pr-assets");
  const replaced = assets.locator('[data-path="media/pic.png"]');
  await expect(replaced).toContainText("Replaced");
  await expect(replaced).toContainText(pr.hashes.picBefore);
  await expect(replaced).toContainText(pr.hashes.picAfter);
  await expect(assets.locator('[data-path="media/clip.mp4"]')).toContainText(pr.hashes.clip);
  await expect(assets.locator('[data-path="media/clip.mp4"]')).toContainText("Added");
  await expect(assets.locator('[data-path="media/sound.wav"]')).toContainText(pr.hashes.sound);
  await expect(assets.locator('[data-path="media/sound.wav"]')).toContainText("Removed");

  // Raw HTML in the proposal is inert text.
  await expect(after).toContainText("<script>window.__kbPwned = 'pr-script'</script>");
  expect(await page.evaluate(() => (window as { __kbPwned?: unknown }).__kbPwned)).toBeUndefined();
  const hits = await page.request.get(`${fx.origin}/fixture/attacker-hits`);
  expect(((await hits.json()) as { hits: number }).hits).toBe(0);

  // Text diff is only an optional supplement.
  await card.getByTestId("pr-text-diff-toggle").click();
  await expect(card.getByTestId("pr-text-diff")).toContainText(
    "+Now **bold words** and _emphasis_.",
  );

  await page.getByTestId("pr-merge").click();
  const reviewed = page.waitForResponse((response) =>
    response.url().endsWith("/fixture/pr-review"),
  );
  await confirm(page, "MERGE");
  const reviewResponse = await reviewed;
  expect(reviewResponse.ok(), await reviewResponse.text()).toBe(true);
  await expect(page.getByTestId("pr-status")).toHaveText("Merged");
  const merged = await mainRev(page, pr.kbId);
  await expect(page.getByTestId("pr-merge-commit")).toContainText(merged);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({
    decision: "merge",
    confirm: "MERGE",
    expectedHeadSha: pr.headSha,
    expectedTargetSha: pr.targetSha,
  });

  // A retry of the same reviewed request returns the durable recorded result.
  const retry = await page.request.post(`${fx.origin}/fixture/pr-review`, { data: reviews[0] });
  expect(retry.ok()).toBe(true);
  expect(((await retry.json()) as { pr: { mergeCommitSha: string } }).pr.mergeCommitSha).toBe(
    merged,
  );
  expect(await mainRev(page, pr.kbId)).toBe(merged);
  // Reloading shows the recorded merge, with no actions left.
  await page.reload();
  await ready(page);
  await expect(page.getByTestId("pr-status")).toHaveText("Merged");
  await expect(page.getByTestId("pr-merge-commit")).toContainText(merged);
  await expect(page.getByTestId("pr-merge")).toHaveCount(0);
});

test("main advanced between view and click: CONFLICT, main unchanged, refresh required, no silent resubmit", async ({
  page,
}) => {
  const pr = fx.pr.conflict;
  await signIn(page, "reviewer");
  await page.goto(prUrl(pr));
  await ready(page);
  await expect(page.getByTestId("pr-diff-complete")).toBeVisible();
  await expect(page.getByTestId("pr-reviewed-target")).toContainText(pr.targetSha.slice(0, 12));

  const advanced = await page.request.post(`${fx.origin}/fixture/advance-main?kbId=${pr.kbId}`);
  const advancedRev = ((await advanced.json()) as { rev: string }).rev;
  const callsBefore = (
    (await (await page.request.get(`${fx.origin}/fixture/pr-review-calls`)).json()) as {
      calls: number;
    }
  ).calls;
  const submitted: Record<string, unknown>[] = [];
  const rereads: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/fixture/pr-review")) submitted.push(request.postDataJSON());
    else if (new URL(request.url()).pathname === "/fixture/pr") rereads.push(request.url());
  });

  await page.getByTestId("pr-merge").click();
  await confirm(page, "MERGE");
  await expect(page.getByTestId("pr-outcome")).toHaveAttribute("data-kind", "changed");
  // The server's structured details say main (the target) moved; the
  // page shows that exact reason without re-reading the PR to guess.
  await expect(page.getByTestId("pr-outcome")).toHaveAttribute("data-reason", "target");
  await expect(page.getByTestId("pr-outcome")).toContainText("Main changed after this diff");
  expect(rereads).toEqual([]);
  await expect(page.getByTestId("pr-refresh")).toBeVisible();
  await expect(page.getByTestId("pr-merge")).toBeDisabled();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({
    expectedHeadSha: pr.headSha,
    expectedTargetSha: pr.targetSha,
  });
  // No main change: main is exactly the other writer's commit.
  expect(await mainRev(page, pr.kbId)).toBe(advancedRev);
  await expect(page.getByTestId("pr-status")).toHaveText("Open");

  // Refreshing shows the new diff; nothing is resubmitted without a new click.
  await page.getByTestId("pr-refresh").click();
  await expect(page.getByTestId("pr-reviewed-target")).toContainText(advancedRev.slice(0, 12));
  await expect(page.getByTestId("pr-outcome")).toHaveCount(0);
  await page.waitForTimeout(500);
  const callsAfter = (
    (await (await page.request.get(`${fx.origin}/fixture/pr-review-calls`)).json()) as {
      calls: number;
    }
  ).calls;
  expect(callsAfter - callsBefore).toBe(1);
  expect(submitted).toHaveLength(1);
});

test(">200 deltas paginate to the full set; no 'complete' indicator before the final page", async ({
  page,
}) => {
  const pr = fx.pr.large;
  await signIn(page, "reviewer");
  await page.goto(prUrl(pr));
  await ready(page);
  const rows = page.getByTestId("pr-file");
  let pages = 1;
  await expect(rows).toHaveCount(50);
  while ((await page.getByTestId("pr-diff-complete").count()) === 0) {
    await expect(page.getByTestId("pr-diff-incomplete")).toBeVisible();
    await expect(page.getByTestId("pr-merge")).toBeDisabled();
    await page.getByTestId("pr-load-more-wrap").getByRole("button").click();
    pages += 1;
    await expect(rows).toHaveCount(Math.min(pr.count, pages * 50));
    expect(pages).toBeLessThanOrEqual(5);
  }
  expect(pages).toBe(5);
  await expect(rows).toHaveCount(pr.count);
  await expect(page.getByTestId("pr-diff-complete")).toContainText(String(pr.count));
  await expect(page.getByTestId("pr-diff-incomplete")).toHaveCount(0);
  await expect(page.getByTestId("pr-merge")).toBeEnabled();
});

test("propose-only author can close but never sees merge", async ({ page }) => {
  const pr = fx.pr.close;
  await signIn(page, "author");
  await page.goto(prUrl(pr));
  await ready(page);
  await expect(page.getByTestId("pr-diff-complete")).toBeVisible();
  await expect(page.getByTestId("pr-merge")).toHaveCount(0);
  await page.getByTestId("pr-close").click();
  await confirm(page, "DELETE");
  await expect(page.getByTestId("pr-status")).toHaveText("Closed");
  expect(await mainRev(page, pr.kbId)).toBe(pr.targetSha);
});
