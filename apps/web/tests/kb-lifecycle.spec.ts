import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";

const fx = JSON.parse(process.env.KB_BROWSER_FIXTURE!) as KbBrowserFixtureData;
const A = "1".repeat(40);
const B = "2".repeat(40);
const TRANSFER = "00000000-0000-4000-8000-000000000001";
const bytes = Buffer.from("PK verified browser fixture");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
for (const mode of ["document", "preview", "pr-document", "pr-asset"]) {
  test(`${mode}: failed A then successful B and late A failure leave B usable`, async ({
    page,
  }) => {
    await page.route("**/kb-assets/**", (route) =>
      route.fulfill(
        new URL(route.request().url()).searchParams.get("rev") === A
          ? { status: 404, body: "missing" }
          : { status: 200, contentType: "image/png", body: png },
      ),
    );
    await page.goto(`${fx.origin}/lifecycle?mode=${mode}`);
    await expect(page.getByRole("alert")).toContainText("Couldn't load");
    await page.getByRole("button", { name: "Select B" }).click();
    const image = page.locator("img");
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    // Re-enter A with a real in-flight failed response; select B before it arrives.
    await page.unroute("**/kb-assets/**");
    const late = deferred();
    const entered = deferred();
    await page.route("**/kb-assets/**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("rev") === A) {
        entered.release();
        await late.promise;
        await route.fulfill({ status: 404, body: "late missing" }).catch(() => {});
      } else await route.fulfill({ status: 200, contentType: "image/png", body: png });
    });
    await page.getByRole("button", { name: "Select A" }).click();
    await entered.promise;
    await page.getByRole("button", { name: "Select B" }).click();
    late.release();
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(image).toHaveAttribute("src", new RegExp(`rev=${B}$`));
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
for (const result of ["success", "failure", "unmount", "reentry"] as const) {
  test(`export: delayed A ${result} cannot own B or a remount`, async ({ page }) => {
    const pending = deferred();
    const entered = deferred();
    const delivered = deferred();
    const requests: string[] = [];
    const completions: unknown[] = [];
    await page.route("**/lifecycle/prepare", async (route) => {
      const input = route.request().postDataJSON();
      requests.push(input.rev);
      if (input.rev === A) {
        entered.release();
        await pending.promise;
      }
      await route.fulfill(
        result === "failure" && input.rev === A
          ? { status: 503, body: "failed" }
          : {
              json: {
                transferId: TRANSFER,
                rev: input.rev,
                size: bytes.length,
                contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                expiresAt: new Date(Date.now() + 60000).toISOString(),
                mime: "application/zip",
              },
            },
      );
      if (input.rev === A) delivered.release();
    });
    await page.route("**/kb-exports/**", (route) => route.fulfill({ status: 200, body: bytes }));
    await page.route("**/lifecycle/complete", (route) => {
      completions.push(route.request().postDataJSON());
      return route.fulfill({ json: { released: true } });
    });
    await page.goto(`${fx.origin}/lifecycle?mode=export`);
    const whole = page.getByRole("button", { name: "Download whole knowledge base (ZIP)" });
    await whole.focus();
    await page.keyboard.press("Enter");
    await entered.promise;
    expect(requests).toEqual([A]);
    if (result === "unmount") await page.getByRole("button", { name: "Toggle mount" }).click();
    else await page.getByRole("button", { name: "Select B" }).click();
    if (result === "reentry") await page.getByRole("button", { name: "Select A" }).click();
    pending.release();
    await delivered.promise;
    if (result !== "failure") await expect.poll(() => completions.length).toBe(1);
    if (result === "unmount") await page.getByRole("button", { name: "Toggle mount" }).click();
    await expect(whole).toBeEnabled();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    const download = page.waitForEvent("download");
    await whole.click();
    await download;
    await expect(page.getByRole("status")).toContainText("Download ready");
    expect(requests).toEqual([A, result === "unmount" || result === "reentry" ? A : B]);
  });
}
test("maximum document/inventory browser render resolves 18,192 destinations", async ({ page }) => {
  const start = Date.now();
  await page.goto(`${fx.origin}/lifecycle?mode=volume`);
  await expect(page.locator("article a")).toHaveCount(18192, { timeout: 45000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.locator("article a").last().getAttribute("href")).toContain(`rev=${A}`);
  console.log(
    `R39 supported volume: ${Date.now() - start}ms, <=2MiB source / 8192 assets / 18192 destinations`,
  );
});
