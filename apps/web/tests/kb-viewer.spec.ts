import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";

import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("KB_BROWSER_FIXTURE is unset; run through `pnpm test:kb -- browser`.");
const fx = JSON.parse(raw) as KbBrowserFixtureData;

const viewer = (path: string, rev: string) =>
  `${fx.origin}/?${new URLSearchParams({ kbId: fx.kbId, rev, path })}`;

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: fx.cookie.name, value: fx.cookie.value, url: fx.origin, httpOnly: true },
  ]);
  const reset = await context.request.post(`${fx.origin}/fixture/reset-exports`);
  expect(reset.ok()).toBe(true);
});

function assertSandboxHeaders(headers: Record<string, string>) {
  expect(headers["content-security-policy"]).toBe(
    "sandbox; default-src 'none'; frame-ancestors 'none'",
  );
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["cache-control"]).toBe("private, no-store");
  expect(headers["access-control-allow-origin"]).toBeUndefined();
}

async function ready(page: Page) {
  // Global setup prepares the module graph; this bounds the actual rendered view.
  await expect(page.getByTestId("kb-rendered-document")).toBeVisible({ timeout: 45_000 });
}

test("renders image, MP4 and audio at an old revision after HEAD removed them", async ({
  page,
}) => {
  const assetResponses: { url: string; status: number; headers: Record<string, string> }[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/kb-assets/"))
      assetResponses.push({
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
      });
  });
  await page.goto(viewer(fx.mediaPath, fx.oldRev));
  await ready(page);

  const img = page.getByRole("img", { name: "Fixture picture" });
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(await img.getAttribute("src")).toBe(
    `/kb-assets/${fx.kbId}/${fx.hashes.png}?rev=${fx.oldRev}`,
  );

  const video = page.locator("video[aria-label='Fixture clip']");
  await expect(video).toHaveAttribute("controls", "");
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((el) => (el as HTMLVideoElement).error)).toBeNull();

  const audio = page.locator("audio[aria-label='Fixture sound']");
  await expect(audio).toHaveAttribute("controls", "");
  await expect
    .poll(() => audio.evaluate((el) => (el as HTMLAudioElement).readyState))
    .toBeGreaterThanOrEqual(1);
  expect(await audio.evaluate((el) => (el as HTMLAudioElement).error)).toBeNull();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Actual network responses, as the browser received them.
  for (const hash of [fx.hashes.png, fx.hashes.mp4, fx.hashes.wav]) {
    const seen = assetResponses.filter((r) => r.url.includes(hash));
    expect(seen.length).toBeGreaterThan(0);
    for (const response of seen) {
      expect([200, 206]).toContain(response.status);
      expect(response.url).toContain(`rev=${fx.oldRev}`);
      assertSandboxHeaders(response.headers);
    }
  }

  // At HEAD the manifest no longer lists them: visible errors, no silent omission.
  await page.goto(viewer(fx.mediaPath, fx.headRev));
  await ready(page);
  await expect(page.getByRole("alert")).toHaveCount(3);
  await expect(page.getByRole("alert").first()).toContainText("Missing asset: media/pic.png");
  await expect(page.locator("img, video, audio")).toHaveCount(0);
});

test("cross-KB hash and wrong revision fail; failures keep sandbox headers", async ({
  page,
  request,
}) => {
  await page.goto(viewer(fx.mediaPath, fx.oldRev));
  await ready(page);
  const own = await page.request.get(
    `${fx.origin}/kb-assets/${fx.kbId}/${fx.hashes.png}?rev=${fx.oldRev}`,
  );
  expect(own.status()).toBe(200);
  assertSandboxHeaders(own.headers());
  for (const url of [
    `/kb-assets/${fx.kbId}/${fx.hashes.other}?rev=${fx.oldRev}`,
    `/kb-assets/${fx.otherKbId}/${fx.hashes.png}?rev=${fx.oldRev}`,
    `/kb-assets/${fx.kbId}/${fx.hashes.png}?rev=${fx.headRev}`,
  ]) {
    const response = await page.request.get(`${fx.origin}${url}`);
    expect(response.status()).toBe(404);
    assertSandboxHeaders(response.headers());
  }
  // The standalone request fixture has no browser cookies: no session, no access.
  const anonymous = await request.get(
    `${fx.origin}/kb-assets/${fx.kbId}/${fx.hashes.png}?rev=${fx.oldRev}`,
  );
  expect(anonymous.status()).toBe(401);
});

test("hostile Markdown never executes or requests an attacker URL", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const attackerRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(fx.attackerOrigin)) attackerRequests.push(request.url());
  });
  await page.goto(viewer(fx.hostilePath, fx.oldRev));
  await ready(page);
  await page.waitForLoadState("networkidle");

  expect(await page.evaluate(() => (window as { __kbPwned?: unknown }).__kbPwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(attackerRequests).toEqual([]);
  const hits = await page.request.get(`${fx.origin}/fixture/attacker-hits`);
  expect(await hits.json()).toEqual({ hits: 0 });

  const doc = page.getByTestId("kb-rendered-document");
  await expect(doc.locator("script, iframe, svg, object, embed, img")).toHaveCount(0);
  for (const href of await doc
    .locator("a")
    .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? "")))
    expect(href).not.toMatch(/^\s*(javascript|data|file|vbscript):/i);
  // The raw HTML is shown as inert text and the missing asset is announced.
  await expect(doc).toContainText("<script>window.__kbPwned = 'script'</script>");
  await expect(page.getByRole("alert")).toContainText("Missing asset: media/missing.png");
  await expect(doc).toContainText("External image not loaded");
});

/** The requester's job, read through the production status procedure. */
async function exportJob(page: Page, transferId: string) {
  const response = await page.request.post(`${fx.origin}/rpc/kbExports/status`, {
    data: { json: { kbId: fx.kbId, transferId } },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).json as {
    state: string;
    size: number | null;
    contentHash: string | null;
  };
}

/** Starts an export and waits for the background job to become downloadable. */
async function startAndAwaitReady(page: Page, name: string) {
  const started = page.waitForResponse(
    (response) => response.url().includes("/rpc/kbExports/prepare") && response.ok(),
  );
  await page.getByRole("button", { name }).click();
  const job = (await (await started).json()).json as { transferId: string; state: string };
  expect(["pending", "building", "ready"]).toContain(job.state);
  // The build is the server's; the panel polls status until it is ready.
  await expect(page.getByRole("button", { name: "Download ZIP" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("kb-downloads")).toContainText("ready to download");
  return job.transferId;
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport });
    test("prepare runs in the background; download and clone controls work by keyboard; ZIP is the exact artifact", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: fx.origin,
      });
      const completed: unknown[] = [];
      page.on("response", async (response) => {
        if (response.url().includes("/rpc/kbExports/complete") && response.ok())
          completed.push((await response.json()).json);
      });
      await page.goto(viewer(fx.mediaPath, fx.oldRev));
      await ready(page);

      // Media controls are reachable by keyboard focus.
      for (const selector of [
        "video[aria-label='Fixture clip']",
        "audio[aria-label='Fixture sound']",
      ]) {
        await page.locator(selector).focus();
        await expect(page.locator(selector)).toBeFocused();
      }

      const whole = page.getByRole("button", { name: "Download whole knowledge base (ZIP)" });
      const started = page.waitForResponse(
        (response) => response.url().includes("/rpc/kbExports/prepare") && response.ok(),
      );
      // Starts stay disabled while the panel checks for an earlier job; a
      // disabled button cannot take focus, so wait for the lookup first.
      await expect(whole).toBeEnabled();
      await whole.focus();
      await expect(whole).toBeFocused();
      await page.keyboard.press("Enter");
      const transferId = ((await (await started).json()).json as { transferId: string }).transferId;
      const downloadButton = page.getByRole("button", { name: "Download ZIP" });
      await expect(downloadButton).toBeVisible({ timeout: 30_000 });
      // Nothing downloads until the user asks for it.
      const job = await exportJob(page, transferId);
      expect(job.state).toBe("ready");
      await downloadButton.focus();
      const downloadPromise = page.waitForEvent("download");
      await page.keyboard.press("Enter");
      const download = await downloadPromise;
      const bytes = await readFile((await download.path())!);
      expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
      expect(bytes.length).toBe(job.size);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(job.contentHash);
      await expect(page.getByRole("status")).toContainText("Download ready");
      // The verified download is acknowledged, which releases the export.
      await expect.poll(() => completed).toEqual([{ transferId, released: true }]);
      const state = await page.request.get(
        `${fx.origin}/fixture/export-state?transferId=${transferId}`,
      );
      expect(await state.json()).toEqual({ state: "DOWNLOADED", released: true });
      await expect(whole).toBeEnabled();

      // Clone URL: copyable by keyboard, never carries a secret.
      const cloneUrl = `${fx.origin}/git/${fx.kbId}.git`;
      const copy = page.getByRole("button", { name: "Copy clone URL" });
      await copy.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(cloneUrl);
      await expect(page.getByTestId("kb-downloads")).toContainText(cloneUrl);
      await expect(page.getByTestId("kb-downloads")).toContainText("as the password");
      expect(cloneUrl).not.toContain("@");
      expect(await page.getByTestId("kb-downloads").innerText()).not.toMatch(/kbp_|token=/);
      // No horizontal overflow at this width.
      const overflow = await page
        .getByTestId("kb-downloads")
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test("a job survives closing the page: a new page resumes it and downloads it", async ({
  page,
  context,
}) => {
  await page.goto(viewer(fx.mediaPath, fx.oldRev));
  await ready(page);
  const transferId = await startAndAwaitReady(page, "Download assets (ZIP)");
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(viewer(fx.mediaPath, fx.oldRev));
  await ready(reopened);
  await expect(reopened.getByTestId("kb-downloads")).toContainText("Assets ZIP at revision");
  const download = reopened.waitForEvent("download");
  await reopened.getByRole("button", { name: "Download ZIP" }).click();
  await download;
  await expect(reopened.getByRole("status")).toContainText("Download ready");
  await expect
    .poll(async () =>
      (
        await reopened.request.get(`${fx.origin}/fixture/export-state?transferId=${transferId}`)
      ).json(),
    )
    .toEqual({ state: "DOWNLOADED", released: true });
});

test("a ready job can be discarded; it is released and a new one can start", async ({ page }) => {
  await page.goto(viewer(fx.mediaPath, fx.oldRev));
  await ready(page);
  const transferId = await startAndAwaitReady(page, "Download whole knowledge base (ZIP)");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("status")).toContainText("Export cancelled.");
  const state = await page.request.get(
    `${fx.origin}/fixture/export-state?transferId=${transferId}`,
  );
  expect(await state.json()).toEqual({ state: "CANCELLED", released: true });
  // The slot is free again.
  await startAndAwaitReady(page, "Download assets (ZIP)");
});

test("saved ZIP stays done while production acknowledgement stalls; deadline and grace release it", async ({
  page,
}) => {
  await page.goto(viewer(fx.mediaPath, fx.oldRev));
  await ready(page);
  let release!: () => void;
  const hold = new Promise<void>((done) => {
    release = done;
  });
  const failed = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("/rpc/kbExports/complete"),
  );
  await page.route("**/rpc/kbExports/complete*", async (route) => {
    await hold;
    await route.fulfill({ json: { json: { released: true } } }).catch(() => {});
  });
  const transferId = await startAndAwaitReady(page, "Download whole knowledge base (ZIP)");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP" }).click();
  await download;
  await expect(page.getByRole("status")).toContainText("Download ready", { timeout: 3000 });
  const whole = page.getByRole("button", { name: "Download whole knowledge base (ZIP)" });
  await expect(whole).toBeEnabled();
  await failed; // The real RPCLink's five-second deadline aborts the stalled request.
  release();
  await expect(page.getByRole("status")).toContainText("Download ready");
  const grace = await page.request.post(`${fx.origin}/fixture/expire-export-grace`, {
    data: { transferId },
  });
  expect(grace.ok()).toBe(true);
  const state = await page.request.get(
    `${fx.origin}/fixture/export-state?transferId=${transferId}`,
  );
  expect(await state.json()).toEqual({ state: "DOWNLOADED", released: true });
});

test("ACK deadline owns its fetch while a simultaneous production read succeeds", async ({
  page,
}) => {
  await page.goto(viewer(fx.mediaPath, fx.oldRev));
  await ready(page);
  let release!: () => void;
  const hold = new Promise<void>((done) => {
    release = done;
  });
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/rpc/")) urls.push(new URL(request.url()).pathname);
  });
  await page.route("**/rpc/kbExports/complete*", async (route) => {
    await hold;
    await route.fulfill({ json: { json: { released: true } } }).catch(() => {});
  });
  const aborted = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().includes("/rpc/kbExports/complete"),
    timeout: 8000,
  });
  const pending = page.evaluate(
    (input) =>
      (
        window as unknown as {
          __ackWithSibling: (value: typeof input) => Promise<PromiseSettledResult<unknown>[]>;
        }
      ).__ackWithSibling(input),
    { kbId: fx.kbId, transferId: "00000000-0000-4000-8000-000000000001" },
  );
  void pending.catch(() => undefined);
  try {
    await aborted;
    const outcomes = await pending;
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "fulfilled"]);
    expect(urls).toContain("/rpc/kbExports/complete");
    expect(urls).toContain("/rpc/kbs/get");
    expect(urls.some((url) => url.includes("__batch__"))).toBe(false);
  } finally {
    release();
  }
});

test("an expired transfer fails visibly and saves nothing", async ({ page }) => {
  await page.goto(viewer(fx.mediaPath, fx.oldRev));
  await ready(page);
  await startAndAwaitReady(page, "Download assets (ZIP)");
  // The ready artifact expires server-side while the panel still shows it.
  const expire = await page.request.post(`${fx.origin}/fixture/reset-exports`);
  expect(expire.ok()).toBe(true);
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  const artifact = page.waitForResponse((r) => r.url().includes("/kb-exports/"));
  await page.getByRole("button", { name: "Download ZIP" }).click();
  const refused = await artifact;
  expect(refused.status()).toBe(404);
  assertSandboxHeaders(refused.headers());
  await expect(page.getByRole("alert")).toContainText("expired or is no longer available");
  expect(downloads).toBe(0);
});

test("editor: typing updates the safe live preview; saving sends exactly the typed bytes", async ({
  page,
}) => {
  const ed = fx.settings.editor;
  const docUrl = `${fx.origin}/fixture/document?${new URLSearchParams({ kbId: ed.kbId, path: ed.path })}`;
  const before = (await (await page.request.get(docUrl)).json()) as { commitSha: string };
  const attackerRequests: string[] = [];
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(fx.attackerOrigin)) attackerRequests.push(request.url());
    if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/rpc/"))
      writes.push(request.postData() ?? "");
  });
  const hitsBefore = (
    (await (await page.request.get(`${fx.origin}/fixture/attacker-hits`)).json()) as {
      hits: number;
    }
  ).hits;

  await page.goto(
    `${fx.origin}/?${new URLSearchParams({ view: "editor", kbId: ed.kbId, path: ed.path })}`,
  );
  const textarea = page.getByTestId("editor-markdown");
  await expect(textarea).toBeVisible({ timeout: 45_000 });
  const preview = page.getByTestId("editor-preview");
  // A document's own `# H1` renders one level down, under the page's h1.
  await expect(preview.locator("h2").first()).toHaveText("Draft start");

  // Raw Markdown with bytes a rich editor would rewrite: trailing spaces, tabs,
  // non-ASCII, raw HTML, a KB image, a remote image and a GFM table.
  const typed = [
    "# Typed title",
    "",
    "Trailing spaces   ",
    '\ttab\tand ünïcödé ✓ <b>raw</b> <img src=x onerror="window.__kbPwned=1">',
    "",
    "![pic](../media/pic.png)",
    "",
    "![new](../media/new.png)",
    "",
    `![remote](${fx.attackerOrigin}/pixel.png)`,
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
  ].join("\n");
  await textarea.fill(typed);

  // The preview follows the draft through the safe renderer.
  await expect(preview.locator("h2").first()).toHaveText("Typed title");
  await expect(preview.locator("table td")).toHaveText(["1", "2"]);
  await expect(preview).toContainText("<b>raw</b>");
  await expect(preview.locator("b")).toHaveCount(0);
  const pic = preview.getByRole("img", { name: "pic" });
  expect(await pic.getAttribute("src")).toBe(
    `/kb-assets/${ed.kbId}/${ed.pngHash}?rev=${before.commitSha}`,
  );
  await expect
    .poll(() => pic.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(preview).toContainText("External image not loaded: remote");
  await expect(preview).toContainText("media/new.png isn't previewed yet");
  expect(await page.evaluate(() => (window as { __kbPwned?: unknown }).__kbPwned)).toBeUndefined();
  // Typing more keeps updating it.
  await textarea.press("End");
  await textarea.pressSequentially("## Tail");
  const final = `${typed}## Tail`;
  await expect(preview.locator("h3").last()).toHaveText("Tail");
  expect(await textarea.inputValue()).toBe(final);

  // Observe the real mutation response before starting the unchanged 15s
  // UI reaction assertion. Publication and browser rendering have separate
  // owners; neither receives an extra retry or a larger deadline.
  const savedResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/rpc/documents/update")
    );
  });
  await page.getByTestId("editor-save").click();
  const saveResponse = await savedResponse;
  expect(saveResponse.ok(), `${saveResponse.status()}: ${await saveResponse.text()}`).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Saved to main" })).toBeVisible();
  // The write carried exactly the typed text, and the stored document is
  // byte-identical to it under the server's `provenance: human` stamp.
  expect(writes.some((body) => body.includes(JSON.stringify(final).slice(1, -1)))).toBe(true);
  const saved = (await (await page.request.get(docUrl)).json()) as {
    markdown: string;
    commitSha: string;
  };
  expect(saved.commitSha).not.toBe(before.commitSha);
  expect(
    Buffer.from(saved.markdown, "utf8").equals(
      Buffer.from(`---\nprovenance: human\n---\n${final}`, "utf8"),
    ),
  ).toBe(true);

  // Rendering never fetched remote content.
  expect(attackerRequests).toEqual([]);
  const hitsAfter = (
    (await (await page.request.get(`${fx.origin}/fixture/attacker-hits`)).json()) as {
      hits: number;
    }
  ).hits;
  expect(hitsAfter).toBe(hitsBefore);
});
