import { expect, test } from "@playwright/test";
import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";

const fx = JSON.parse(process.env.KB_BROWSER_FIXTURE!) as KbBrowserFixtureData;
const A = "1".repeat(40);
const B = "2".repeat(40);
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
test("maximum document/inventory browser render resolves 18,192 destinations", async ({ page }) => {
  const start = Date.now();
  await page.goto(`${fx.origin}/lifecycle?mode=volume`);
  await expect(page.locator("article a")).toHaveCount(18192, { timeout: 45000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.locator("article a").last().getAttribute("href")).toContain(`rev=${A}`);
  console.log(
    `Supported volume: ${Date.now() - start}ms, <=2MiB source / 8192 assets / 18192 destinations`,
  );
});
