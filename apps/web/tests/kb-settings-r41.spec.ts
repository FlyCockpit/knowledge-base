import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";

const fx = JSON.parse(process.env.KB_BROWSER_FIXTURE ?? "null") as KbBrowserFixtureData;
if (!fx) throw new Error("Run through pnpm test:kb -- browser");
const s = fx.settings;
const TAB_PANEL = { members: "members-panel", sealed: "sealed-panel" } as const;
async function owner(
  page: Page,
  view = "providers",
  kbId = s.editor.kbId,
  who: keyof typeof s.cookies = "owner",
  tab: keyof typeof TAB_PANEL = "sealed",
) {
  await page
    .context()
    .addCookies([{ name: fx.cookie.name, value: s.cookies[who], url: fx.origin, httpOnly: true }]);
  await page.goto(
    `${fx.origin}/kb-settings?${new URLSearchParams(view === "providers" ? { view, kbId } : { view, kbId, tab })}`,
  );
  await expect(
    page.getByTestId(view === "providers" ? "providers-panel" : TAB_PANEL[tab]),
  ).toBeVisible();
}
/** KB settings are tabs (Members · Search & index · Sealed values · Mirror). */
async function selectTab(page: Page, tab: "members" | "search" | "sealed" | "mirror") {
  await page.getByTestId(`kb-settings-tab-${tab}`).click();
}
async function navigate(
  page: Page,
  search: { view?: string; kbId?: string; accept?: string; transfer?: string; tab?: string },
) {
  await page.evaluate(
    (next) =>
      (window as unknown as { __kbNavigate: (s: typeof next) => Promise<void> }).__kbNavigate(next),
    search,
  );
}
async function cache(page: Page) {
  return page.evaluate(() => {
    const client = (
      window as unknown as { __kbQueryClient: import("@tanstack/react-query").QueryClient }
    ).__kbQueryClient;
    return JSON.stringify([
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    ]);
  });
}
async function fillProvider(page: Page, name: string) {
  const dialog = page.getByRole("dialog");
  if (await dialog.getByLabel("Name", { exact: true }).count())
    await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog
    .getByLabel("Endpoint URL")
    .fill(`https://${name.toLowerCase().replaceAll(" ", "-")}.example.invalid/embeddings`);
  await dialog.getByLabel("Model", { exact: true }).fill("模型-é");
  await dialog.getByLabel("Dimensions").fill("8");
  await dialog.getByLabel("API key").fill(`fixture-${name.replaceAll(" ", "-")}`);
}
type Outcome = "success" | "rejection" | "interruption";
const registrants = { success: "known", rejection: "member", interruption: "manager" } as const;
/** Hold a real RPC response AFTER the real handler has committed; no service mock. */
async function delay(page: Page, procedure: string, outcome: Outcome) {
  let reply: unknown;
  let release!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route(`**/rpc/${procedure}*`, async (route) => {
    try {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      reply = await response.json();
      reached();
      await gate;
      if (outcome === "success") await route.fulfill({ response });
      else if (outcome === "interruption") await route.abort("failed");
      else
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            json: {
              defined: false,
              code: "INTERNAL_SERVER_ERROR",
              status: 503,
              message: "Fixture unavailable",
            },
          }),
        });
    } finally {
      finished();
    }
  });
  return { waiting, done, release, reply: () => reply };
}

for (const mode of ["create", "probe"] as const) {
  for (const outcome of ["success", "rejection", "interruption"] as const) {
    test(`R41 ${mode}: pending close and late ${outcome} preserve the reopened draft and forget secrets`, async ({
      page,
    }) => {
      // Keep the real 5/minute provider budget intact for each registrant.
      await owner(page, "providers", s.editor.kbId, registrants[outcome]);
      const name = `R41 ${randomUUID().slice(0, 8)}`;
      await page.getByTestId("provider-create").click();
      await fillProvider(page, name);
      if (mode === "probe") {
        await page.getByTestId("provider-save").press("Enter");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const row = page.getByTestId("provider-row").filter({ hasText: name });
        await expect(row).toBeVisible();
        await row.getByTestId("provider-probe").click();
        await fillProvider(page, name);
      }
      const held = await delay(page, `embeddingProviders/${mode}`, outcome);
      try {
        await page.getByTestId("provider-save").press("Enter");
        await held.waiting;
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Cancel", exact: true })
          .press("Enter");
        expect(await cache(page)).not.toContain(`fixture-${name.replaceAll(" ", "-")}`);
        await page.getByTestId("provider-create").click();
        await fillProvider(page, "New draft B");
        const settled = page.waitForResponse((r) =>
          r.url().includes("/rpc/embeddingProviders/listMine"),
        );
        held.release();
        await held.done;
        await settled;
        await expect(page.getByRole("dialog").getByLabel("Name", { exact: true })).toHaveValue(
          "New draft B",
        );
        await expect(page.getByRole("dialog").getByLabel("API key")).toHaveValue(
          "fixture-New-draft-B",
        );
        expect(await cache(page)).not.toContain(`fixture-${name.replaceAll(" ", "-")}`);
        await expect(page.getByTestId("provider-row").filter({ hasText: name })).toBeVisible();
      } finally {
        held.release();
        await held.done;
      }
    });
  }
}

for (const outcome of ["success", "rejection", "interruption"] as const) {
  for (const retire of [false, true]) {
    test(`R41 sealed pending ${retire ? "unmount" : "edited draft"} survives late ${outcome}`, async ({
      page,
    }) => {
      await owner(page, "kb");
      const literal = `sealed-r41-${randomUUID()}`;
      await page.getByLabel("Secret value").fill(literal);
      const held = await delay(page, "kbSealed/enroll", outcome);
      try {
        await page.getByTestId("sealed-enroll").click();
        await held.waiting;
        if (retire) {
          await navigate(page, { kbId: s.kbId });
          await expect(page.getByLabel("Secret value")).toHaveValue("");
          expect(await cache(page)).not.toContain(literal);
        }
        await page.getByLabel("Secret value").fill("new plaintext draft B");
        await page.getByLabel("Consumer ID").fill("new recipient draft B");
        if (!retire) {
          // Even an implicit/programmatic submit while A is pending must not
          // transfer A's completion ownership to the edited draft.
          await page.getByTestId("sealed-enroll").evaluate((button) => {
            button.closest("form")!.requestSubmit();
          });
        }
        held.release();
        await held.done;
        if (!retire) {
          if (outcome === "success")
            await expect(page.getByTestId("sealed-reference")).toBeVisible();
          else await expect(page.getByTestId("sealed-error")).toBeVisible();
          await expect(page.getByTestId("sealed-enroll")).toBeEnabled();
        } else {
          await expect
            .poll(async () =>
              page.evaluate(() =>
                (
                  window as unknown as {
                    __kbQueryClient: import("@tanstack/react-query").QueryClient;
                  }
                ).__kbQueryClient
                  .getMutationCache()
                  .getAll()
                  .some((m) => m.state.status === "pending"),
              ),
            )
            .toBe(false);
          await expect(page.getByTestId("sealed-reference")).toHaveCount(0);
        }
        await expect(page.getByLabel("Secret value")).toHaveValue("new plaintext draft B");
        await expect(page.getByLabel("Consumer ID")).toHaveValue("new recipient draft B");
        expect(await cache(page)).not.toContain(literal);
        if (!retire) {
          // A changed draft starts a new operation even when A committed but
          // its acknowledgement was rejected or interrupted.
          await page.unroute("**/rpc/kbSealed/enroll*");
          await page.getByTestId("sealed-enroll").press("Enter");
          await expect(page.getByLabel("Secret value")).toHaveValue("");
          await expect(page.getByTestId("sealed-reference")).toBeVisible();
          await expect(page.getByLabel("Consumer ID")).toHaveValue("new recipient draft B");
        }
      } finally {
        held.release();
        await held.done;
      }
    });
  }
}

for (const outcome of ["rejection", "interruption"] as const) {
  test(`R41 unchanged sealed retry after ${outcome} reuses its committed receipt`, async ({
    page,
  }) => {
    await owner(page, "kb");
    const literal = `unchanged-r41-${randomUUID()}`;
    const keys: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/rpc/kbSealed/enroll")) {
        const body = JSON.parse(request.postData()!) as { json: { idempotencyKey: string } };
        keys.push(body.json.idempotencyKey);
      }
    });
    await page.getByLabel("Secret value").fill(literal);
    const held = await delay(page, "kbSealed/enroll", outcome);
    try {
      await page.getByTestId("sealed-enroll").click();
      await held.waiting;
      held.release();
      await held.done;
      await expect(page.getByTestId("sealed-error")).toBeVisible();
      await expect(page.getByTestId("sealed-enroll")).toBeEnabled();
      await expect(page.getByLabel("Secret value")).toHaveValue(literal);
      await page.unroute("**/rpc/kbSealed/enroll*");
      const replay = page.waitForResponse((response) =>
        response.url().includes("/rpc/kbSealed/enroll"),
      );
      await page.getByTestId("sealed-enroll").press("Enter");
      const response = await replay;
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual(held.reply());
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      await expect(page.getByLabel("Secret value")).toHaveValue("");
      await expect(page.getByTestId("sealed-reference")).toBeVisible();
      expect(await cache(page)).not.toContain(literal);
    } finally {
      held.release();
      await held.done;
    }
  });
}

test("R41 warm and cold KB navigation retires profile approvals, sealed/member/mirror drafts", async ({
  page,
}) => {
  await owner(page, "kb");
  for (const warm of [false, true]) {
    const a = warm ? s.kbId : s.editor.kbId;
    const b = warm ? s.editor.kbId : s.kbId;
    await navigate(page, { kbId: a });
    await selectTab(page, "sealed");
    await expect(page.getByTestId("sealed-panel")).toBeVisible();
    await page.getByLabel("Secret value").fill("retired KB draft");
    await selectTab(page, "members");
    await page.getByLabel("Email address").fill("retired@example.invalid");
    await selectTab(page, "mirror");
    await page
      .getByLabel("Remote SSH URL")
      .fill("ssh://git@retired.example.invalid/owner/repo.git");
    // Hidden tabs keep their drafts while this KB stays open.
    await expect(page.getByLabel("Secret value")).toHaveValue("retired KB draft");
    await selectTab(page, "search");
    await page.getByTestId("profile-rebuild").click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await navigate(page, { kbId: b });
    await expect(page.getByTestId("profile-panel")).toBeVisible();
    await expect(page.getByTestId("sealed-panel")).toBeAttached();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByLabel("Secret value")).toHaveValue("");
    await expect(page.getByLabel("Email address")).toHaveValue("");
    await expect(page.getByLabel("Remote SSH URL")).toHaveValue("");
  }
});

test("R41 acceptance state belongs to each kind and request; an old success cannot accept the next link", async ({
  page,
  browser,
}) => {
  await owner(page, "kb", s.editor.kbId, "owner", "members");
  const offer = async () => {
    if (await page.getByTestId("invite-another").count())
      await page.getByTestId("invite-another").click();
    await page.getByLabel("Email address").fill(s.knownEmail);
    await page.getByLabel("Read", { exact: true }).check();
    await page.getByTestId("invite-submit").click();
    const result = page.getByTestId("invite-result");
    await expect(result).toBeVisible();
    return new URL((await result.getAttribute("data-href"))!, fx.origin).searchParams.get(
      "accept",
    )!;
  };
  const context = await browser.newContext();
  try {
    const recipient = await context.newPage();
    await context.addCookies([
      { name: fx.cookie.name, value: s.cookies.known, url: fx.origin, httpOnly: true },
    ]);
    const first = await offer();
    await recipient.goto(`${fx.origin}/kb-settings?kbId=${s.editor.kbId}&accept=${first}`);
    await recipient.getByTestId("share-accept-submit").click();
    await expect(recipient.getByTestId("share-accept-done")).toBeVisible();
    const second = await offer();
    await navigate(recipient, { kbId: s.editor.kbId, accept: second });
    await expect(recipient.getByTestId("share-accept-submit")).toBeVisible();
    const held = await delay(recipient, "kbs/shareAccept", "success");
    try {
      await recipient.getByTestId("share-accept-submit").click();
      await held.waiting;
      const third = await offer();
      await navigate(recipient, { kbId: s.editor.kbId, accept: third });
      held.release();
      await held.done;
      await expect
        .poll(async () =>
          recipient.evaluate(() =>
            (
              window as unknown as { __kbQueryClient: import("@tanstack/react-query").QueryClient }
            ).__kbQueryClient
              .getMutationCache()
              .getAll()
              .some((m) => m.state.status === "pending"),
          ),
        )
        .toBe(false);
      await expect(recipient.getByTestId("share-accept-submit")).toBeVisible();
      await expect(recipient.getByTestId("share-accept-done")).toHaveCount(0);
      await recipient.unroute("**/rpc/kbs/shareAccept*");
      await recipient.getByTestId("share-accept-submit").click();
      await expect(recipient.getByTestId("share-accept-done")).toBeVisible();
    } finally {
      held.release();
      await held.done;
    }
    await navigate(recipient, { kbId: s.editor.kbId, transfer: randomUUID() });
    await expect(recipient.getByTestId("transfer-accept-submit")).toBeVisible();
    await expect(recipient.getByTestId("share-accept")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("R41 invalid local inputs report errors; name-less Unicode re-probe and exact revoke still work", async ({
  page,
}) => {
  await owner(page);
  let calls = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && /embeddingProviders\/(create|probe)/.test(r.url())) calls++;
  });
  await page.getByTestId("provider-create").click();
  await fillProvider(page, "Valid Unicode");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("   ");
  await page.getByTestId("provider-save").press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("Check the values");
  expect(calls).toBe(0);
  await dialog.getByLabel("Name", { exact: true }).fill("invalid\0name");
  await page.getByTestId("provider-save").press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("Check the values");
  expect(calls).toBe(0);
  await dialog.getByLabel("Name", { exact: true }).fill("模型 🌟");
  await dialog.getByLabel("Model", { exact: true }).fill("invalid\0model");
  await page.getByTestId("provider-save").press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("Check the values");
  expect(calls).toBe(0);
  await dialog.getByLabel("Model", { exact: true }).fill("é\u200d模型");
  await page.getByTestId("provider-save").press("Enter");
  await expect(dialog).toHaveCount(0);
  const row = page.getByTestId("provider-row").filter({ hasText: "模型 🌟" });
  await row.getByTestId("provider-probe").click();
  await fillProvider(page, "Valid reprobe");
  await page.getByTestId("provider-save").press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveAttribute("data-revision", "2");
  expect(calls).toBe(2);
  // A client that bypasses the local validator still gets BAD_REQUEST from
  // the real oRPC handler, before any provider service admission.
  const input = {
    name: "a\0b",
    endpointUrl: "https://fixture.example.invalid/embed",
    model: "m",
    dimensions: 8,
    apiKey: "fixture-only",
    idempotencyKey: randomUUID(),
  };
  for (const body of [{ ...input }, { ...input, name: "valid", model: "a\0b" }]) {
    const result = await page.request.post(`${fx.origin}/rpc/embeddingProviders/create`, {
      headers: { "x-csrf-token": "orpc" },
      data: { json: body },
    });
    expect(result.status()).toBe(400);
    expect(await result.json()).toMatchObject({ json: { code: "BAD_REQUEST" } });
  }
  const { name: _name, ...config } = input;
  const result = await page.request.post(`${fx.origin}/rpc/embeddingProviders/probe`, {
    headers: { "x-csrf-token": "orpc" },
    data: {
      json: { ...config, model: "a\0b", providerId: await row.getAttribute("data-provider-id") },
    },
  });
  expect(result.status()).toBe(400);
  expect(await result.json()).toMatchObject({ json: { code: "BAD_REQUEST" } });
  await row.getByTestId("provider-revoke").click();
  const revoke = page.getByRole("alertdialog");
  await revoke.getByPlaceholder("REVOKE").fill("REVOKE");
  await revoke.getByRole("button", { name: "Revoke provider" }).press("Enter");
  await expect(row).toHaveAttribute("data-status", "revoked");
  await navigate(page, { kbId: s.editor.kbId, tab: "sealed" });
  await expect(page.getByTestId("sealed-panel")).toBeVisible();
  await page.getByLabel("Reference to revoke").fill("invalid reference");
  await page.getByTestId("sealed-revoke").click();
  await expect(page.getByRole("alert")).toContainText("Enter one exact sealed reference");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByLabel("Secret value").fill("revoke fixture");
  await page.getByTestId("sealed-enroll").click();
  const token = page.getByTestId("sealed-reference");
  await expect(token).toBeVisible();
  await page
    .getByLabel("Reference to revoke")
    .fill(`  ${await token.getAttribute("data-reference")}  `);
  await page.getByTestId("sealed-revoke").click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByPlaceholder("DELETE").fill("DELETE");
  await confirmation.getByRole("button", { name: "Revoke record" }).press("Enter");
  await expect(page.getByTestId("sealed-revoke-done")).toBeVisible();
});

// builtin-ready replaces the instance-wide built-in model row; restore it so the
// admin model-panel specs that run later in this worker start from their own state.
test.afterEach(async ({ page }) => {
  await page
    .context()
    .addCookies([{ name: fx.cookie.name, value: s.cookies.owner, url: fx.origin, httpOnly: true }]);
  const reset = await page.request.post(`${fx.origin}/fixture/settings/builtin-reset`);
  expect(reset.status(), await reset.text()).toBe(200);
});

test("R41 enabled built-in is selectable by a manager and attaches its exact revision through the real router", async ({
  page,
}) => {
  await owner(page, "kb");
  const prepared = await page.request.post(`${fx.origin}/fixture/settings/builtin-ready`);
  expect(prepared.status(), await prepared.text()).toBe(200);
  const builtin = (await prepared.json()) as { providerId: string; revision: number };
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: fx.cookie.name, value: s.cookies.manager, url: fx.origin, httpOnly: true },
    ]);
  await page.goto(`${fx.origin}/kb-settings?kbId=${s.kbId}&tab=search`);
  const choices = page.getByTestId("profile-choice");
  await expect(
    choices.locator(`option[value="${builtin.providerId}:${builtin.revision}"]`),
  ).toHaveCount(1);
  await expect(choices.locator("option")).toHaveCount(2);
  // Reset just this query so the production batch plugin sends a single
  // request; do not accidentally intercept an unrelated batched procedure.
  await page.route("**/rpc/embeddingProviders/listSystem*", (route) => route.abort("failed"));
  await page.evaluate(async () => {
    const client = (
      window as unknown as { __kbQueryClient: import("@tanstack/react-query").QueryClient }
    ).__kbQueryClient;
    const query = client
      .getQueryCache()
      .getAll()
      .find((item) => JSON.stringify(item.queryKey).includes("listSystem"));
    if (!query) throw new Error("Missing system provider query");
    await client.resetQueries({ queryKey: query.queryKey, exact: true });
  });
  const profile = page.getByTestId("profile-panel");
  await expect(profile.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(profile.getByText(/^No ready providers are available/)).toHaveCount(0);
  await page.unroute("**/rpc/embeddingProviders/listSystem*");
  await profile.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    choices.locator(`option[value="${builtin.providerId}:${builtin.revision}"]`),
  ).toHaveCount(1);
  await choices.selectOption(`${builtin.providerId}:${builtin.revision}`);
  const operations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /kbIndex\/(setProfile|rebuild)/.test(request.url()))
      operations.push(new URL(request.url()).pathname);
  });
  await page.getByTestId("profile-apply").click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByPlaceholder("RUN").fill("RUN");
  const attached = page.waitForResponse((r) => r.url().includes("/rpc/kbIndex/setProfile"));
  await confirm.getByRole("button", { name: "Start build" }).press("Enter");
  const response = await attached;
  expect(response.status()).toBe(200);
  expect(response.request().postData()).toContain(`"providerId":"${builtin.providerId}"`);
  expect(response.request().postData()).toContain(`"revision":${builtin.revision}`);
  await expect(page.getByTestId("profile-status")).toHaveAttribute(
    "data-phase",
    /pending|building/,
  );
  expect(operations).toEqual(["/rpc/kbIndex/setProfile"]);
  await page.getByTestId("profile-rebuild").click();
  await confirm.getByPlaceholder("RUN").fill("RUN");
  const rebuilt = page.waitForResponse((r) => r.url().includes("/rpc/kbIndex/rebuild"));
  await confirm.getByRole("button", { name: "Start build" }).press("Enter");
  expect((await rebuilt).status()).toBe(200);
  expect(operations).toEqual(["/rpc/kbIndex/setProfile", "/rpc/kbIndex/rebuild"]);
});

test("R41 owner changes the sealed-share flag through the real control; manager cannot expose it", async ({
  page,
}) => {
  await owner(page, "kb", s.kbId, "owner", "members");
  const row = page.locator(`[data-testid="member-row"][data-user-id="${s.managerUserId}"]`);
  const toggle = row.getByRole("checkbox", { name: "Include sealed values" });
  await expect(toggle).not.toBeChecked();
  for (const includeSealedValues of [true, false]) {
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pattern = "**/rpc/kbs/shareSetSealedValues*";
    // Delay admission, not just the reply: checked state alone must never be
    // mistaken for persistence while this real owner request is still held.
    await page.route(pattern, async (route) => {
      reached();
      await gate;
      await route.continue();
    });
    try {
      const changed = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== "/rpc/kbs/shareSetSealedValues") return false;
        const input = response.request().postDataJSON()?.json;
        return (
          input?.kbId === s.kbId &&
          input?.shareUserId === s.managerUserId &&
          input?.includeSealedValues === includeSealedValues
        );
      });
      await toggle.setChecked(includeSealedValues);
      await waiting;
      await expect(toggle).toBeChecked({ checked: includeSealedValues });
      await expect(toggle).toBeDisabled();
      await expect(toggle).toHaveAttribute("aria-busy", "true");
      release();
      expect((await changed).status()).toBe(200);
      // onSuccess awaits shareList invalidation; enabled means that refresh
      // has settled and the checkbox is displaying the stored value again.
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked({ checked: includeSealedValues });
    } finally {
      release();
      await page.unroute(pattern);
    }
    if (includeSealedValues) {
      await page.reload();
      await expect(toggle).toBeChecked();
    }
  }
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: fx.cookie.name, value: s.cookies.manager, url: fx.origin, httpOnly: true },
    ]);
  await page.reload();
  await expect(page.getByTestId("members-panel")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Include sealed values" })).toHaveCount(0);
  // Hiding the control is not the boundary: the manager's direct call is refused
  // and the owner still sees the flag off.
  const forged = await page.request.post(`${fx.origin}/rpc/kbs/shareSetSealedValues`, {
    headers: { "x-csrf-token": "orpc" },
    data: { json: { kbId: s.kbId, shareUserId: s.managerUserId, includeSealedValues: true } },
  });
  expect(forged.status(), await forged.text()).toBe(403);
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([{ name: fx.cookie.name, value: s.cookies.owner, url: fx.origin, httpOnly: true }]);
  await page.reload();
  await expect(toggle).not.toBeChecked();
});
