import { generateKeyPairSync, randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("KB_BROWSER_FIXTURE is unset; run through `pnpm test:kb -- browser`.");
const fx = JSON.parse(raw) as KbBrowserFixtureData;
const s = fx.settings;
type Who = keyof typeof s.cookies;

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([{ name: fx.cookie.name, value: s.cookies[who], url: fx.origin, httpOnly: true }]);
}

const kbUrl = (kbId: string, extra: Record<string, string> = {}) =>
  `${fx.origin}/kb-settings?${new URLSearchParams({ view: "kb", kbId, ...extra })}`;
const providersUrl = () => `${fx.origin}/kb-settings?view=providers`;

async function open(page: Page, url: string, testId: string) {
  await page.goto(url);
  await expect(page.getByTestId(testId)).toBeVisible({ timeout: 25_000 });
}

/** Every mutation leaves through oRPC `/rpc`; no fixture or hand-rolled request bypass. */
function watchMutations(page: Page) {
  const bodies: string[] = [];
  const bypass: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET") return;
    const url = new URL(request.url());
    if (url.pathname.startsWith("/rpc")) bodies.push(`${url.pathname} ${request.postData() ?? ""}`);
    else bypass.push(url.pathname);
  });
  return { bodies, bypass };
}

async function confirmToken(page: Page, token: string, button: string) {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder(token).fill(token);
  // Keyboard activation: the harness loads no app CSS, so the modal's unstyled
  // backdrop would swallow a pointer click.
  await dialog.getByRole("button", { name: button }).press("Enter");
}

/** Everything a page could still hold: DOM plus the TanStack query and mutation caches. */
async function everything(page: Page): Promise<string> {
  return page.evaluate(() => {
    const client = (
      window as unknown as { __kbQueryClient: import("@tanstack/react-query").QueryClient }
    ).__kbQueryClient;
    return [
      document.documentElement.outerHTML,
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => [q.queryKey, q.state.data]),
      ),
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => [m.state.variables, m.state.data]),
      ),
    ].join("\n");
  });
}

async function state(page: Page, kbId: string) {
  const res = await page.request.get(`${fx.origin}/fixture/settings/state?kbId=${kbId}`);
  return (await res.json()) as {
    ownerId: string;
    metadataVersion: number;
    members: { userId: string; bits: string[] }[];
  };
}

test("share invites: identical neutral feedback for known and unknown email; share only after recipient accepts", async ({
  page,
}) => {
  const watch = watchMutations(page);
  const inviteStatuses: number[] = [];
  page.on("response", (response) => {
    const request = response.request();
    if (`${request.url()} ${request.postData() ?? ""}`.includes("shareInvite"))
      inviteStatuses.push(response.status());
  });
  await as(page, "owner");
  await open(page, kbUrl(s.kbId), "members-panel");

  const feedback: string[] = [];
  for (const email of [s.knownEmail, s.unknownEmail]) {
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Read", { exact: true }).check();
    await page.getByTestId("invite-submit").click();
    const result = page.getByTestId("invite-result");
    await expect(result).toBeVisible();
    feedback.push(
      (await result.innerHTML()).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").replace(/\s+/g, " "),
    );
    await page.getByTestId("invite-another").click();
  }
  expect(feedback[0]).toBe(feedback[1]);
  // Same transport outcome for both addresses.
  expect(inviteStatuses).toHaveLength(2);
  expect(inviteStatuses[0]).toBe(inviteStatuses[1]);
  // Pending until the recipient accepts: nobody new is a member yet.
  expect((await state(page, s.kbId)).members.map((m) => m.userId)).not.toContain(s.knownUserId);
  await expect(
    page.locator(`[data-testid="member-row"][data-user-id="${s.knownUserId}"]`),
  ).toHaveCount(0);

  // Re-invite the known address to get a live request id, then accept as the recipient.
  await page.getByLabel("Email address").fill(s.knownEmail);
  await page.getByLabel("Read", { exact: true }).check();
  await page.getByTestId("invite-submit").click();
  const href = await page.getByTestId("invite-result").getAttribute("data-href");
  const requestId = new URL(href!, fx.origin).searchParams.get("accept")!;
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

  await as(page, "known");
  await open(page, kbUrl(s.kbId, { accept: requestId }), "share-accept");
  await page.getByTestId("share-accept-submit").click();
  await expect(page.getByTestId("share-accept-done")).toBeVisible();
  expect((await state(page, s.kbId)).members.map((m) => m.userId)).toContain(s.knownUserId);

  // A read-only member sees no controls at all.
  await open(page, kbUrl(s.kbId), "kb-settings");
  await expect(page.getByTestId("invite-submit")).toHaveCount(0);
  await expect(page.getByTestId("sealed-panel")).toHaveCount(0);
  await expect(page.getByTestId("profile-apply")).toHaveCount(0);

  // Owner sees the accepted member.
  await as(page, "owner");
  await open(page, kbUrl(s.kbId), "members-panel");
  await expect(
    page.locator(`[data-testid="member-row"][data-user-id="${s.knownUserId}"]`),
  ).toBeVisible();
  expect(watch.bypass).toEqual([]);
});

test("transfer needs the recipient's acceptance at the pinned metadataVersion; a denied owner-only action keeps the view, actual loss clears it", async ({
  browser,
}) => {
  const ownerPage = await (await browser.newContext()).newPage();
  const watch = watchMutations(ownerPage);
  await as(ownerPage, "owner");
  await open(ownerPage, kbUrl(s.transferKbId), "members-panel");
  const before = await state(ownerPage, s.transferKbId);
  const row = ownerPage.locator(`[data-testid="member-row"][data-user-id="${s.memberUserId}"]`);
  await row.getByTestId("member-transfer").click();
  await confirmToken(ownerPage, "TRANSFER", "Request transfer");
  const requested = ownerPage.getByTestId("transfer-requested");
  await expect(requested).toBeVisible();
  const requestId = new URL(
    (await requested.getAttribute("data-href"))!,
    fx.origin,
  ).searchParams.get("transfer")!;
  expect(watch.bodies.some((b) => b.includes(`"metadataVersion":${before.metadataVersion}`))).toBe(
    true,
  );
  // Requesting changes nothing until the named recipient accepts.
  expect((await state(ownerPage, s.transferKbId)).ownerId).toBe(s.ownerUserId);

  // Anyone else holding the link is refused.
  const other = await (await browser.newContext()).newPage();
  await as(other, "manager");
  await open(other, kbUrl(s.transferKbId, { transfer: requestId }), "transfer-accept");
  await other.getByTestId("transfer-accept-submit").click();
  await expect(other.getByTestId("control-error")).toHaveAttribute("data-kind", "denied");
  expect((await state(other, s.transferKbId)).ownerId).toBe(s.ownerUserId);

  await as(other, "member");
  await open(other, kbUrl(s.transferKbId, { transfer: requestId }), "transfer-accept");
  await other.getByTestId("transfer-accept-submit").click();
  await expect(other.getByTestId("transfer-accept-done")).toBeVisible();
  expect((await state(other, s.transferKbId)).ownerId).toBe(s.memberUserId);

  // The former owner keeps `manage`. Their still-open page still shows
  // owner controls from before the transfer; an owner-only action is refused.
  // That denial is NOT access loss — a refreshed permission check keeps
  // the KB view and cache and only re-derives the controls.
  const stale = ownerPage.locator(`[data-testid="member-row"][data-user-id="${s.memberUserId}"]`);
  await stale.getByTestId("member-transfer").click();
  await confirmToken(ownerPage, "TRANSFER", "Request transfer");
  await expect(ownerPage.getByTestId("member-transfer")).toHaveCount(0);
  await expect(ownerPage.getByTestId("sealed-panel")).toHaveCount(0);
  await expect(ownerPage.getByTestId("kb-delete")).toHaveCount(0);
  await expect(ownerPage.getByTestId("kb-settings-unavailable")).toHaveCount(0);
  await expect(ownerPage.getByTestId("members-panel")).toBeVisible();
  await expect(ownerPage.getByTestId("invite-submit")).toBeVisible();
  const cachedFor = (page: Page, kbId: string) =>
    page.evaluate((id) => {
      const client = (
        window as unknown as { __kbQueryClient: import("@tanstack/react-query").QueryClient }
      ).__kbQueryClient;
      return client
        .getQueryCache()
        .getAll()
        .filter((q) => JSON.stringify(q.queryKey).includes(id) && q.state.data !== undefined)
        .length;
    }, kbId);
  expect(await cachedFor(ownerPage, s.transferKbId)).toBeGreaterThan(0);
  expect((await state(ownerPage, s.transferKbId)).members).toContainEqual(
    expect.objectContaining({ userId: s.ownerUserId }),
  );

  // The new owner removes the former owner (they can).
  await as(other, "member");
  await open(other, kbUrl(s.transferKbId), "members-panel");
  await other
    .locator(`[data-testid="member-row"][data-user-id="${s.ownerUserId}"]`)
    .getByTestId("member-revoke")
    .click();
  await confirmToken(other, "REVOKE", "Revoke access");
  await expect(
    other.locator(`[data-testid="member-row"][data-user-id="${s.ownerUserId}"]`),
  ).toHaveCount(0);

  // Now the former owner's next action is denied AND the re-check says access
  // is gone: the KB's cached data is dropped and the page says so.
  await ownerPage.getByLabel("Email address").fill(`${randomUUID()}@example.invalid`);
  await ownerPage.getByLabel("Read", { exact: true }).check();
  await ownerPage.getByTestId("invite-submit").click();
  await expect(ownerPage.getByTestId("kb-settings-unavailable")).toBeVisible();
  await expect(ownerPage.getByTestId("invite-submit")).toHaveCount(0);
  await expect(ownerPage.getByTestId("sealed-panel")).toHaveCount(0);
  expect(await cachedFor(ownerPage, s.transferKbId)).toBe(0);
  expect(watch.bypass).toEqual([]);
});

test("owner-only controls: the owner sees delete, transfer and sealed; a non-owner manager sees none of them", async ({
  page,
}) => {
  await as(page, "owner");
  await open(page, kbUrl(s.kbId), "members-panel");
  await expect(page.getByTestId("kb-delete")).toBeVisible();
  await expect(page.getByTestId("kb-edit")).toBeVisible();
  await expect(page.getByTestId("kb-settings-tab-sealed")).toBeVisible();
  await page.getByTestId("kb-settings-tab-sealed").click();
  await expect(page.getByTestId("sealed-panel")).toBeVisible();
  await page.getByTestId("kb-settings-tab-members").click();
  await expect(
    page
      .locator(`[data-testid="member-row"][data-user-id="${s.managerUserId}"]`)
      .getByTestId("member-transfer"),
  ).toBeVisible();

  await as(page, "manager");
  await open(page, kbUrl(s.kbId), "members-panel");
  // Manage-level controls stay; owner-only ones are absent (not merely disabled).
  await expect(page.getByTestId("kb-edit")).toBeVisible();
  await expect(page.getByTestId("invite-submit")).toBeVisible();
  await expect(page.getByTestId("member-revoke").first()).toBeVisible();
  await expect(page.getByTestId("kb-delete")).toHaveCount(0);
  await expect(page.getByTestId("member-transfer")).toHaveCount(0);
  await expect(page.getByTestId("sealed-panel")).toHaveCount(0);
  await expect(page.getByTestId("kb-settings-tab-sealed")).toHaveCount(0);
});

test("provider secrets live only in the transient form; a late revoke shows probe failure; profile binds the exact revision", async ({
  page,
}) => {
  const watch = watchMutations(page);
  const KEY = `sk-canary-${randomUUID()}`;
  const ENDPOINT = `https://provider-${randomUUID().slice(0, 8)}.example.invalid/v1/embeddings`;
  await as(page, "owner");
  await open(page, providersUrl(), "providers-panel");

  await page.getByTestId("provider-create").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Canary provider");
  await dialog.getByLabel("Endpoint URL").fill(ENDPOINT);
  await dialog.getByLabel("Model").fill("canary-embed");
  await dialog.getByLabel("Dimensions").fill("8");
  await dialog.getByLabel("API key").fill(KEY);
  await dialog.getByTestId("provider-save").press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.locator('[data-testid="provider-row"]', { hasText: "Canary provider" });
  await expect(row).toHaveAttribute("data-probe", "probing");
  const providerId = (await row.getAttribute("data-provider-id"))!;

  // After close: neither the key nor the endpoint survives in DOM, query or mutation caches.
  const dump = await everything(page);
  expect(dump).not.toContain(KEY);
  expect(dump).not.toContain(ENDPOINT);

  // Revoked elsewhere while the probe is still pending: failure, never success.
  await page.request.post(`${fx.origin}/fixture/settings/revoke-provider?providerId=${providerId}`);
  await expect(row).toHaveAttribute("data-probe", "failed", { timeout: 20_000 });
  await expect(row).toHaveAttribute("data-status", "revoked");

  // A second provider re-probed to revision 2; only revision 2 becomes ready.
  await page.getByTestId("provider-create").click();
  await dialog.getByLabel("Name").fill("Exact provider");
  await dialog.getByLabel("Endpoint URL").fill(ENDPOINT);
  await dialog.getByLabel("Model").fill("exact-embed");
  await dialog.getByLabel("Dimensions").fill("8");
  await dialog.getByLabel("API key").fill(KEY);
  await dialog.getByTestId("provider-save").press("Enter");
  const exact = page.locator('[data-testid="provider-row"]', { hasText: "Exact provider" });
  await expect(exact).toHaveAttribute("data-revision", "1");
  const exactId = (await exact.getAttribute("data-provider-id"))!;
  await exact.getByTestId("provider-probe").click();
  await dialog.getByLabel("Endpoint URL").fill(ENDPOINT);
  await dialog.getByLabel("Model").fill("exact-embed");
  await dialog.getByLabel("Dimensions").fill("8");
  await dialog.getByLabel("API key").fill(KEY);
  await dialog.getByTestId("provider-save").press("Enter");
  await expect(exact).toHaveAttribute("data-revision", "2");
  await page.request.post(
    `${fx.origin}/fixture/settings/provider-ready?providerId=${exactId}&revision=2`,
  );
  await expect(exact).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
  expect(await everything(page)).not.toContain(KEY);

  await open(page, kbUrl(s.kbId, { tab: "search" }), "profile-panel");
  const choice = page.getByTestId("profile-choice");
  await expect(choice.locator(`option[value="${exactId}:2"]`)).toHaveCount(1);
  await expect(choice.locator(`option[value^="${providerId}:"]`)).toHaveCount(0);
  await choice.selectOption(`${exactId}:2`);
  await page.getByTestId("profile-apply").click();
  // The KB may already carry a pending build from an earlier spec, so the
  // phase alone does not prove this submission reached the server.
  const attached = page.waitForResponse((r) => r.url().includes("/rpc/kbIndex/setProfile"));
  await confirmToken(page, "RUN", "Start build");
  expect((await attached).status()).toBe(200);
  await expect(page.getByTestId("profile-status")).toHaveAttribute(
    "data-phase",
    /pending|building/,
  );
  const set = watch.bodies.find((b) => b.includes("setProfile") || b.includes(`"revision":2`));
  expect(set).toContain(exactId);
  expect(set).toContain('"revision":2');
  expect(set).toContain('"confirm":"RUN"');
  expect(watch.bypass.filter((p) => !p.startsWith("/fixture/"))).toEqual([]);
});

test("sealed enrollment shows only the opaque reference; grants name one record and one key; managers without ownership see no sealed controls", async ({
  page,
}) => {
  const watch = watchMutations(page);
  const SECRET = `sealed-canary-${randomUUID()}`;
  await as(page, "owner");
  await open(page, kbUrl(s.kbId, { tab: "sealed" }), "sealed-panel");
  await page.getByLabel("Secret value").fill(SECRET);
  await page.getByTestId("sealed-enroll").click();
  const reference = page.getByTestId("sealed-reference");
  await expect(reference).toBeVisible();
  const token = (await reference.getAttribute("data-reference"))!;
  expect(token).toMatch(/^\{\{sealed:v1:knowledge_base:[0-9a-f-]{36}:[0-9a-f-]{36}\}\}$/);
  await expect(page.getByLabel("Secret value")).toHaveValue("");
  expect(await everything(page)).not.toContain(SECRET);
  // The literal was sent once and never requested back.
  expect(watch.bodies.filter((b) => b.includes(SECRET))).toHaveLength(1);

  const publicKey = generateKeyPairSync("x25519")
    .publicKey.export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  const recipientKeyId = randomUUID();
  await page.getByLabel("Sealed reference").fill(token);
  const kinds = page.getByLabel("Consumer kind");
  await expect(kinds.locator("option")).toHaveCount(1);
  await expect(kinds).toHaveValue("pat");
  await page.getByLabel("Consumer ID").fill(s.sealedConsumerGrantId);
  await page.getByLabel("Recipient key ID").fill(recipientKeyId);
  await page.getByLabel("Recipient public key").fill(publicKey);
  await page.getByTestId("sealed-grant").click();
  await expect(page.getByTestId("sealed-grant-done")).toBeVisible();
  const grants = watch.bodies.filter((body) => body.includes('"recipientKeyId"'));
  expect(grants).toHaveLength(1);
  const grantBody: unknown = JSON.parse(grants[0]!.slice(grants[0]!.indexOf(" ") + 1));
  expect(grantBody).toMatchObject({
    json: {
      kbId: s.kbId,
      reference: token,
      consumerKind: "pat",
      consumerId: s.sealedConsumerGrantId,
      recipientKeyId,
      recipientPublicKey: publicKey,
    },
  });
  expect(await everything(page)).not.toContain(SECRET);

  await page.getByLabel("Reference to revoke").fill(token);
  await page.getByTestId("sealed-revoke").click();
  await confirmToken(page, "DELETE", "Revoke record");
  await expect(page.getByTestId("sealed-revoke-done")).toBeVisible();

  // Sealed control is owner-only, so a manager who is not the owner
  // never sees it (the server refuses such a manager regardless).
  await as(page, "manager");
  await open(page, kbUrl(s.kbId, { tab: "sealed" }), "members-panel");
  await expect(page.getByTestId("kb-settings-tab-sealed")).toHaveCount(0);
  await expect(page.getByTestId("sealed-panel")).toHaveCount(0);
  await expect(page.getByTestId("sealed-reference")).toHaveCount(0);
  expect(watch.bypass).toEqual([]);
});

test("46r10 admin model panel lists both models with recommendation and applies the selected tier through oRPC", async ({
  page,
}) => {
  await as(page, "owner");
  const prepared = await page.request.post(`${fx.origin}/fixture/settings/model-admin`);
  expect(prepared.status(), await prepared.text()).toBe(200);
  expect(await prepared.json()).toMatchObject({ role: "admin" });
  await as(page, "owner");
  const statusResponse = page.waitForResponse((response) =>
    response.url().includes("/rpc/kbModel/status"),
  );
  await open(page, `${fx.origin}/kb-settings?view=model`, "model-admin-panel");
  const response = await statusResponse;
  expect(
    response.status(),
    response.status() === 200 ? "model status" : await response.text(),
  ).toBe(200);
  await expect(page.getByTestId("model-options").locator("tbody tr")).toHaveCount(8);
  await expect(page.getByTestId("model-options")).toContainText("EmbeddingGemma 2");
  await expect(page.getByTestId("model-options")).toContainText("Qwen3-Embedding-0.6B");
  await expect(page.getByTestId("model-options")).toContainText("Recommended");
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "Qwen3-Embedding-0.6B", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toContainText(
    "Qwen3-Embedding-0.6B",
  );
  await page.getByRole("combobox", { name: "Context length (tokens)", exact: true }).click();
  await page.getByRole("option", { name: "2048", exact: true }).click();
  const applied = page.waitForResponse((response) =>
    response.url().includes("/rpc/kbModel/setRuntimeConfig"),
  );
  await page.getByRole("button", { name: "Apply settings" }).click();
  // R3-W9: applying is confirmed with its impact first.
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByTestId("model-affected-kbs")).toBeVisible();
  // Keyboard activation: the harness's unstyled backdrop swallows pointer clicks.
  await confirm.getByRole("button", { name: "Apply settings", exact: true }).press("Enter");
  const result = await applied;
  expect(result.request().postData()).toContain('"contextTokens":2048');
  expect(await result.json()).toMatchObject({
    json: { modelId: "qwen3-embedding-0.6b-q8_0", runtime: { contextTokens: 2048 } },
  });
  await expect(page.getByTestId("model-status")).toContainText("Qwen3-Embedding-0.6B-Q8_0.gguf");
  await expect(page.getByTestId("model-runtime")).toContainText("Context 2048 tokens");
  await page.request.post(`${fx.origin}/fixture/settings/model-user`);
});

test("46r10 insufficient memory greys every option, explains rejection and blocks enable", async ({
  page,
}) => {
  await as(page, "owner");
  const prepared = await page.request.post(`${fx.origin}/fixture/settings/model-admin`, {
    data: { budgetMiB: 512 },
  });
  expect(prepared.status(), await prepared.text()).toBe(200);
  await as(page, "owner");
  const statusResponse = page.waitForResponse((response) =>
    response.url().includes("/rpc/kbModel/status"),
  );
  await open(page, `${fx.origin}/kb-settings?view=model`, "model-admin-panel");
  const response = await statusResponse;
  expect(
    response.status(),
    response.status() === 200 ? "model status" : await response.text(),
  ).toBe(200);
  await expect(
    page.getByTestId("model-options").locator('tbody tr[aria-disabled="true"]'),
  ).toHaveCount(8);
  await expect(page.getByTestId("model-options")).toContainText("90%");
  await expect(page.getByRole("button", { name: "Enable and download" })).toBeDisabled();
  await page.request.post(`${fx.origin}/fixture/settings/model-user`);
});
