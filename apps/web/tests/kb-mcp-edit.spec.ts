import { expect, type Locator, type Page, test } from "@playwright/test";
import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("Run through pnpm test:kb -- browser");
const fx = JSON.parse(raw) as KbBrowserFixtureData;

type Scenario = {
  grantId: string;
  clientId: string;
  revoked: string;
  downgraded: string;
  filler: string[];
};
type EditState = {
  toolGroups: string[];
  widenedAt: string | null;
  acl: { kbId: string; bits: string[] }[];
  elevations: { id: string; toolGroups: string[]; revokedAt: string | null; expiresAt: string }[];
};

async function scenario(page: Page, query = ""): Promise<Scenario> {
  const response = await page.request.post(`${fx.origin}/fixture/mcp/edit-scenario${query}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function editState(page: Page, grantId: string): Promise<EditState> {
  const response = await page.request.get(`${fx.origin}/fixture/mcp/edit-state?grantId=${grantId}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
const bitsOf = (state: EditState, kbId: string) =>
  state.acl.find((entry) => entry.kbId === kbId)?.bits;

/** Opens Edit access for the app and loads its complete stored ACL. */
async function openEdit(page: Page, seeded: Scenario): Promise<Locator> {
  await page.goto(`${fx.origin}/en-US/settings/mcp`);
  const row = page.locator("li").filter({ has: page.getByText(seeded.clientId, { exact: true }) });
  // R2-19: each row's control names its app.
  await row
    .getByRole("button", { name: `Edit access for ${seeded.clientId}`, exact: true })
    .click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(`Edit access for “${seeded.clientId}”`)).toBeVisible();
  return sheet;
}
/**
 * Loads every remaining page (stored ACL first, then the live KB picker).
 *
 * A click swaps "Load more" for "Loading more…" only after React re-renders,
 * so checking the labels right after a click can see neither and stop while a
 * page is still in flight (the next "Load more" then appears unclicked). Each
 * click therefore waits for its page's response, and the Sheet is complete
 * only when the editing form is shown and neither button remains.
 */
async function loadEverything(sheet: Locator) {
  const more = sheet.getByRole("button", { name: "Load more", exact: true });
  const loading = sheet.getByRole("button", { name: "Loading more…" });
  const save = sheet.getByRole("button", { name: "Save changes", exact: true });
  for (let i = 0; i < 40; i += 1) {
    await expect(loading).toHaveCount(0);
    if ((await more.count()) > 0) {
      // Each click fetches exactly one page; wait for it before looking again,
      // so a page still in flight is never mistaken for the end of the list.
      const page = sheet
        .page()
        .waitForResponse((response) =>
          /\/rpc\/(mcpGrants\/listAclMine|kbs\/list)\b/.test(response.url()),
        );
      await more.first().click();
      await page;
      continue;
    }
    if ((await save.count()) > 0) {
      // The form is up; its first picker page may still be loading.
      await sheet.page().waitForLoadState("networkidle");
      if ((await more.count()) === 0 && (await loading.count()) === 0) break;
      continue;
    }
    await expect(more.or(save).first()).toBeVisible();
  }
  await expect(save).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expect(more).toHaveCount(0);
}
const kbBox = (sheet: Locator, legend: string, bit: string) =>
  sheet
    .locator("fieldset")
    .filter({ has: sheet.page().locator("legend", { hasText: legend }) })
    // Named "<KB name>: <bit>"; the fieldset filter already picks the KB.
    .getByRole("checkbox", { name: new RegExp(`: ${bit}$`) });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error(`MCP edit page error: ${error.message}`));
  await page.context().addCookies([
    { ...fx.cookie, url: fx.origin, httpOnly: true },
    { ...fx.mcp.cookie, url: fx.origin, httpOnly: true },
  ]);
});

test("Edit access waits for the complete stored ACL, then removes stored permissions live authority no longer covers", async ({
  page,
}) => {
  const seeded = await scenario(page, "?fillers=60");
  const sheet = await openEdit(page, seeded);
  // 62 stored entries: nothing is editable until every page is loaded.
  await expect(sheet.getByText("Load them all before editing.", { exact: false })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  await expect(sheet.getByRole("checkbox")).toHaveCount(0);
  await loadEverything(sheet);
  await expect(sheet.getByRole("button", { name: "Save changes", exact: true })).toBeVisible();

  // The revoked share appears by id, removal-only; the downgraded share keeps its stored write.
  const revokedRead = kbBox(sheet, seeded.revoked, "Read");
  await expect(revokedRead).toBeChecked();
  await expect(revokedRead).toBeEnabled();
  const downWrite = kbBox(sheet, "Edit downgraded", "Write");
  await expect(downWrite).toBeChecked();
  await downWrite.click();
  await expect(downWrite).not.toBeChecked();
  // A stale bit, once removed, cannot be added back.
  await expect(downWrite).toBeDisabled();
  await revokedRead.click();
  await expect(revokedRead).toBeDisabled();

  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/mcpGrants/updateMine"))
      requests.push(request.postData() ?? "");
  });
  await sheet.getByRole("button", { name: "Save changes", exact: true }).click();
  // Narrowing only: no confirmation step.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  const sent = (JSON.parse(requests[0]!) as { json: Record<string, unknown> }).json;
  expect(sent).toEqual({
    id: seeded.grantId,
    acl: [
      { kbId: seeded.downgraded, bits: ["read", "propose"] },
      { kbId: seeded.revoked, bits: [] },
    ].sort((a, b) => a.kbId.localeCompare(b.kbId)),
  });
  const after = await editState(page, seeded.grantId);
  expect(bitsOf(after, seeded.revoked)).toBeUndefined();
  expect(bitsOf(after, seeded.downgraded)).toEqual(["read", "propose"]);
  expect(after.acl).toHaveLength(61);
  expect(after.widenedAt).toBeNull();
});

test("additions need confirmation; a KB created while the Sheet is open is never touched", async ({
  page,
}) => {
  const seeded = await scenario(page, "?fillers=3");
  const sheet = await openEdit(page, seeded);
  await loadEverything(sheet);
  // The agent creates a KB meanwhile, and the lists refetch.
  const appended = await page.request.post(
    `${fx.origin}/fixture/mcp/edit-append?grantId=${seeded.grantId}`,
  );
  const { kbId } = (await appended.json()) as { kbId: string };
  await page.evaluate(async () => {
    const w = window as unknown as {
      __kbQueryClient: import("@tanstack/react-query").QueryClient;
    };
    await w.__kbQueryClient.invalidateQueries();
  });

  // The custom group set keeps Advanced open: add Export.
  await sheet.getByRole("checkbox", { name: "Export", exact: true }).click();
  // An addition is reviewed before it is saved: the button says so.
  await expect(sheet.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(sheet.getByText("Step 2 of 2", { exact: false })).toBeVisible();
  await expect(sheet.getByText("Confirm added access", { exact: true })).toBeFocused();
  await expect(sheet.getByText("Adding", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Export tools", { exact: true })).toBeVisible();
  // Back keeps the draft; nothing has been saved.
  await sheet.getByRole("button", { name: "Back", exact: true }).click();
  await expect(sheet.getByRole("checkbox", { name: "Export", exact: true })).toBeChecked();
  expect((await editState(page, seeded.grantId)).toolGroups).toEqual(["read", "edit"]);

  await sheet.getByRole("button", { name: "Review changes", exact: true }).click();
  await sheet.getByRole("button", { name: "Add access", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const after = await editState(page, seeded.grantId);
  expect(after.toolGroups).toEqual(["read", "edit", "export"]);
  expect(after.widenedAt).not.toBeNull();
  expect(bitsOf(after, kbId)).toEqual(["read"]);
  expect(after.acl).toHaveLength(6);
  // The list marks the widening.
  const row = page.locator("li").filter({ has: page.getByText(seeded.clientId, { exact: true }) });
  await expect(row.getByText(/^Access widened on /)).toBeVisible();
});

test("choosing Read caps a 257-entry stored ACL in one save", async ({ page }) => {
  const seeded = await scenario(page, "?fillers=255&bits=write");
  const sheet = await openEdit(page, seeded);
  await loadEverything(sheet);
  await sheet.getByRole("button", { name: "Read", exact: true }).click();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/mcpGrants/updateMine"))
      requests.push(request.postData() ?? "");
  });
  await sheet.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const sent = (JSON.parse(requests[0]!) as { json: Record<string, unknown> }).json;
  expect(sent).toEqual({ id: seeded.grantId, toolGroups: ["read"], aclCap: ["read"] });
  const after = await editState(page, seeded.grantId);
  expect(after.toolGroups).toEqual(["read"]);
  expect(after.acl).toHaveLength(257);
  expect(after.acl.every((entry) => JSON.stringify(entry.bits) === '["read"]')).toBe(true);
});

test("temporary access only adds, is confirmed with its duration, and End now removes it", async ({
  page,
}) => {
  const seeded = await scenario(page, "?fillers=3");
  let sheet = await openEdit(page, seeded);
  await loadEverything(sheet);
  await sheet.getByRole("button", { name: "1 hour", exact: true }).click();
  await expect(sheet.getByText("Temporary access only adds.", { exact: false })).toBeVisible();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/rpc/mcpGrants/updateMine"))
      requests.push(request.postData() ?? "");
  });
  await sheet.getByRole("checkbox", { name: "Export", exact: true }).click();
  await sheet.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(sheet.getByText("Confirm added access", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Export tools", { exact: true })).toBeVisible();
  await expect(sheet.getByText("ends on its own after 1 hour", { exact: false })).toBeVisible();
  await sheet.getByRole("button", { name: "Add access", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  const sent = (JSON.parse(requests[0]!) as { json: Record<string, unknown> }).json;
  expect(sent).toEqual({
    id: seeded.grantId,
    toolGroups: ["read", "edit", "export"],
    duration: "1h",
  });

  // The base grant is unchanged; the addition is a separate, expiring record.
  const elevated = await editState(page, seeded.grantId);
  expect(elevated.toolGroups).toEqual(["read", "edit"]);
  expect(elevated.widenedAt).toBeNull();
  expect(elevated.elevations).toHaveLength(1);
  expect(elevated.elevations[0]).toMatchObject({ toolGroups: ["export"], revokedAt: null });

  // Listed on the connection with its remaining time and End now.
  const row = page.locator("li").filter({ has: page.getByText(seeded.clientId, { exact: true }) });
  await expect(row.getByText("Temporary access", { exact: true })).toBeVisible();
  await expect(row.getByText(/^Ends in (60 minutes|1 hour)/)).toBeVisible();

  // Temporary edits that remove anything are refused before saving.
  sheet = await openEdit(page, seeded);
  await loadEverything(sheet);
  await sheet.getByRole("button", { name: "1 day", exact: true }).click();
  await sheet.getByRole("checkbox", { name: "Edit", exact: true }).click();
  await expect(sheet.getByText("Temporary access can only add.", { exact: false })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Review changes", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await row.getByRole("button", { name: "End now", exact: true }).click();
  // The pending button relabels at once; the section goes only after the ended list is refetched.
  await expect(row.getByText("Temporary access", { exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "End now", exact: true })).toHaveCount(0);
  const ended = await editState(page, seeded.grantId);
  expect(ended.elevations[0]?.revokedAt).not.toBeNull();
  expect(ended.toolGroups).toEqual(["read", "edit"]);
});
