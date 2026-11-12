import { randomUUID } from "node:crypto";
import { expect, type Page, type Route, test } from "@playwright/test";
import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("Run through pnpm test:kb -- browser");
const fx = JSON.parse(raw) as KbBrowserFixtureData;

type State = {
  grants: {
    id: string;
    clientId: string;
    revokedAt: string | null;
    acl: { kbId: string; bits: string[] }[];
    consentIntents: { nonce: string; approvedAt: string | null }[];
  }[];
  tokens: { id: string; name: string; revokedAt: string | null }[];
};
async function state(page: Page): Promise<State> {
  const response = await page.request.get(`${fx.origin}/fixture/mcp/state`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function start(page: Page) {
  const name = `App ${randomUUID()}`;
  const response = await page.request.get(
    `${fx.origin}/fixture/mcp/start?name=${encodeURIComponent(name)}`,
  );
  expect(response.ok()).toBe(true);
  return { ...((await response.json()) as { clientId: string; url: string }), name };
}
async function navigate(page: Page, href: string) {
  await page.evaluate(async (url) => {
    const router = (
      window as unknown as {
        __mcpRouter: { history: { push(url: string): void }; load(): Promise<void> };
      }
    ).__mcpRouter;
    // Raw signed URLs cannot pass through stringifySearch (which folds repeated ba_param).
    const target = new URL(url);
    router.history.push(target.pathname + target.search);
    await router.load();
  }, href);
}
async function review(page: Page, request: Awaited<ReturnType<typeof start>>) {
  await page.goto(request.url);
  await expect(page.getByText(`Authorize ${request.name}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
}
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function hold(page: Page, pattern: string, fault?: (route: Route) => Promise<void>) {
  const ready = deferred();
  const delivery = deferred();
  let body = "";
  await page.route(pattern, async (route) => {
    await fault?.(route);
    const response = await route.fetch();
    expect(response.status()).toBe(fault ? 400 : 200);
    body = await response.text();
    ready.release();
    await delivery.promise;
    await route.fulfill({ response });
  });
  return { ready: ready.promise, release: delivery.release, body: () => body };
}
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error(`MCP browser page error: ${error.message}`));
  await page.context().addCookies([
    { ...fx.cookie, url: fx.origin, httpOnly: true },
    { ...fx.mcp.cookie, url: fx.origin, httpOnly: true },
  ]);
  await page.route("https://client.invalid/cb**", (route) =>
    route.fulfill({ body: "App callback" }),
  );
});

test("F1 provider refusal after commit shows saved approval and offers Settings revocation", async ({
  page,
}) => {
  const request = await start(page);
  await review(page, request);
  await page.route("**/api/auth/oauth2/consent", async (route) => {
    await page.request.post(`${fx.origin}/fixture/mcp/disable-client?clientId=${request.clientId}`);
    await route.continue();
  });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByText("Approval saved; connection incomplete", { exact: true }),
  ).toBeVisible();
  const grant = (await state(page)).grants.find((g) => g.clientId === request.clientId)!;
  expect(grant.revokedAt).toBeNull();
  expect(grant.consentIntents[0]?.approvedAt).toBeTruthy();
  await expect(page.getByText(/Nothing was approved/)).toHaveCount(0);
  await page.getByRole("link", { name: "Review connected apps" }).click();
  await expect(page.getByText(request.clientId, { exact: true })).toBeVisible();
  const row = page.locator("li").filter({ has: page.getByText(request.clientId, { exact: true }) });
  // R2-19: the row's control names the app (its client name).
  await row.getByRole("button", { name: /^Revoke / }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByPlaceholder(request.clientId).fill(request.clientId);
  await dialog.getByRole("button", { name: "Revoke", exact: true }).press("Enter");
  await expect
    .poll(async () => (await state(page)).grants.find((g) => g.id === grant.id)?.revokedAt)
    .toBeTruthy();
});

test("F1/F4 reply-lost approval retries and re-entry preserve nonce and exact committed ACL", async ({
  page,
}) => {
  const request = await start(page);
  await review(page, request);
  // Per-KB boxes are named "<KB name>: Read".
  await page
    .getByRole("checkbox", { name: /: Read$/ })
    .first()
    .press("Space");
  const inputs: string[] = [];
  const callback = async (route: Route) => {
    inputs.push(route.request().postData() ?? "");
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort("failed");
  };
  await page.route("**/rpc/mcpConsent/approve", callback);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("We couldn't confirm the approval", { exact: true })).toBeVisible();
  const original = (await state(page)).grants.find((g) => g.clientId === request.clientId)!;
  expect(original.acl).toHaveLength(1);
  // Reload loses component memory; the server's receipt still supplies the exact selection.
  await page.reload();
  await expect(
    page.getByText("Approval saved; connection incomplete", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry the same selection" }).click();
  await expect.poll(() => inputs.length).toBe(2);
  const after = (await state(page)).grants.filter((g) => g.clientId === request.clientId);
  expect(after).toHaveLength(1);
  expect(after[0]?.id).toBe(original.id);
  expect(after[0]?.acl).toEqual(original.acl);
  expect(after[0]?.consentIntents[0]?.nonce).toBe(original.consentIntents[0]?.nonce);
  expect(JSON.parse(inputs[1]!).json.nonce).toBe(JSON.parse(inputs[0]!).json.nonce);
  await page.unroute("**/rpc/mcpConsent/approve", callback);
  await page.getByRole("button", { name: "Retry the same selection" }).click();
  await expect(page).toHaveURL(/https:\/\/client.invalid\/cb\?code=/);
});

test("F4 same-route signed-request replacement clears every selection", async ({ page }) => {
  const a = await start(page);
  const b = await start(page);
  await review(page, a);
  // Per-KB boxes are named "<KB name>: Read".
  await page
    .getByRole("checkbox", { name: /: Read$/ })
    .first()
    .press("Space");
  await navigate(page, b.url);
  await expect(page.getByText(`Authorize ${b.name}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await expect(page.getByText(/No knowledge bases selected/)).toBeVisible();
});

test("F4 a replaced approval completion cannot continue or overwrite the newer review", async ({
  page,
}) => {
  const a = await start(page);
  const b = await start(page);
  await review(page, a);
  let continuations = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/auth/oauth2/consent")) continuations += 1;
  });
  const held = await hold(page, "**/rpc/mcpConsent/approve");
  try {
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await held.ready;
    await navigate(page, b.url);
    const delivered = page.waitForResponse((r) => r.url().endsWith("/rpc/mcpConsent/approve"));
    held.release();
    await delivered;
    await settled(page);
    await expect(page.getByText(`Authorize ${b.name}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect.poll(() => continuations).toBe(0);
    expect((await state(page)).grants.some((g) => g.clientId === a.clientId)).toBe(true);
  } finally {
    held.release();
  }
});

for (const mode of ["success-unmount", "failure-replace", "success-replace"] as const) {
  test(`F4 late provider ${mode} cannot navigate or overwrite the current request`, async ({
    page,
  }) => {
    const a = await start(page);
    const b = await start(page);
    await review(page, a);
    const held = await hold(
      page,
      "**/api/auth/oauth2/consent",
      mode === "failure-replace"
        ? async () => {
            await page.request.post(
              `${fx.origin}/fixture/mcp/disable-client?clientId=${a.clientId}`,
            );
          }
        : undefined,
    );
    try {
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await held.ready;
      const destination = mode === "success-unmount" ? `${fx.origin}/mcp-exit` : b.url;
      await navigate(page, destination);
      const delivered = page.waitForResponse((r) => r.url().endsWith("/api/auth/oauth2/consent"));
      held.release();
      await delivered;
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      if (mode === "success-unmount") {
        await expect(page).toHaveURL(`${fx.origin}/mcp-exit`);
        await expect(page.getByText("Fixture exit", { exact: true })).toBeVisible();
      } else {
        await expect(page.getByText(`Authorize ${b.name}`, { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
        await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
      }
    } finally {
      held.release();
    }
  });
}

async function openMint(page: Page, name: string) {
  await page.goto(`${fx.origin}/en-US/settings/mcp`);
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await page.getByRole("textbox", { name: "Token name", exact: true }).fill(name);
  const readScope = page.getByRole("checkbox", { name: "Read (mcp:read)", exact: true });
  await expect(readScope).toBeEnabled();
  await readScope.press("Space");
  await expect(readScope).toBeChecked();
}
async function caches(page: Page) {
  return page.evaluate(() => {
    const client = (
      window as unknown as { __kbQueryClient: import("@tanstack/react-query").QueryClient }
    ).__kbQueryClient;
    return JSON.stringify({
      queries: client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      mutations: client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    });
  });
}

async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const client = (
          window as unknown as { __kbQueryClient: import("@tanstack/react-query").QueryClient }
        ).__kbQueryClient;
        return client
          .getMutationCache()
          .getAll()
          .some((m) => m.state.status === "pending");
      }),
    )
    .toBe(false);
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

test("F2 reply-lost PAT mint refreshes the list and requires unrecoverable-token revocation", async ({
  page,
}) => {
  const name = `Lost ${randomUUID()}`;
  await openMint(page, name);
  await page.route("**/rpc/mcpTokens/create", async (route) => {
    expect((await route.fetch()).status()).toBe(200);
    await route.abort("failed");
  });
  await page.getByRole("dialog").getByRole("button", { name: "Create token", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("We could not confirm whether");
  await expect(page.getByRole("alert")).toContainText("revoke it before trying again");
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Create token", exact: true }),
  ).toBeDisabled();
  const token = (await state(page)).tokens.find((t) => t.name === name)!;
  expect(token.revokedAt).toBeNull();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  const row = page.locator("li").filter({ has: page.getByText(name, { exact: true }) });
  await row.getByRole("button", { name: `Revoke ${name}`, exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByPlaceholder(name).fill(name);
  await confirm.getByRole("button", { name: "Revoke", exact: true }).press("Enter");
  await expect
    .poll(async () => (await state(page)).tokens.find((t) => t.id === token.id)?.revokedAt)
    .toBeTruthy();
  expect(await caches(page)).not.toContain("kbp_");
});

test("F2 pending close/reopen does not reveal the old secret or replace a newer draft", async ({
  page,
}) => {
  await openMint(page, `Pending ${randomUUID()}`);
  const held = await hold(page, "**/rpc/mcpTokens/create");
  try {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create token", exact: true })
      .click();
    await held.ready;
    const secret = (JSON.parse(held.body()) as { json: { secret: string } }).json.secret;
    expect(secret).toMatch(/^kbp_/);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Create token", exact: true }).click();
    const name = `New draft ${randomUUID()}`;
    await page.getByRole("textbox", { name: "Token name", exact: true }).fill(name);
    const delivered = page.waitForResponse((r) => r.url().endsWith("/rpc/mcpTokens/create"));
    held.release();
    await delivered;
    await settled(page);
    await expect.poll(async () => (await caches(page)).includes(secret)).toBe(false);
    await expect(page.getByRole("textbox", { name: "Token name", exact: true })).toHaveValue(name);
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy token" })).toHaveCount(0);
  } finally {
    held.release();
  }
});

test("empty/default PAT creation by keyboard submits once and clears the secret on close", async ({
  page,
}) => {
  const name = `Normal ${randomUUID()}`;
  await openMint(page, name);
  const inputs: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/rpc/mcpTokens/create")) inputs.push(req.postData() ?? "");
  });
  await page.getByRole("textbox", { name: "Token name", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "Copy token" })).toBeVisible();
  expect(inputs).toHaveLength(1);
  const input = (
    JSON.parse(inputs[0]!) as {
      json: {
        acl: unknown[];
        scopes: string[];
        toolGroups: string[];
        allowCreate: boolean;
        createdKbBits: unknown[];
        expiresAt: string;
      };
    }
  ).json;
  expect(input).toMatchObject({
    acl: [],
    scopes: ["mcp:read"],
    // A new connection starts on the Read preset.
    toolGroups: ["read"],
    allowCreate: false,
    createdKbBits: [],
  });
  expect(Math.round((Date.parse(input.expiresAt) - Date.now()) / 86_400_000)).toBe(90);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(async () => (await caches(page)).includes("kbp_")).toBe(false);
});

test("fresh OAuth denial returns the real access_denied callback without a grant", async ({
  page,
}) => {
  const request = await start(page);
  await review(page, request);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page).toHaveURL(/https:\/\/client.invalid\/cb\?error=access_denied/);
  // Callback is cross-origin; use the fixture-cookie API context for durable inspection.
  expect((await state(page)).grants.some((g) => g.clientId === request.clientId)).toBe(false);
});

test("F5/F6 OAuth filtering and permission pages survive count changes and unchanged-preview tail replacement", async ({
  page,
}) => {
  const response = await page.request.post(`${fx.origin}/fixture/mcp/inventory`);
  expect(response.ok()).toBe(true);
  const seeded = (await response.json()) as { clientId: string; lastKb: string };
  // Every fixture KB is readable, so its permission row shows the KB's name.
  const kbLabel = (kbId: string) => `Permission fixture ${kbId}`;
  await page.goto(`${fx.origin}/en-US/settings/mcp`);
  await expect(page.getByText(seeded.clientId, { exact: true })).toBeVisible();
  const row = page.locator("li").filter({ has: page.getByText(seeded.clientId, { exact: true }) });
  await expect(row.locator("ul > li")).toHaveCount(256);
  await expect(
    row.getByText("More knowledge base permissions exist. Load more to inspect them."),
  ).toBeVisible();
  await row.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(row.locator("ul > li")).toHaveCount(257);
  await expect(row.getByText(kbLabel(seeded.lastKb), { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
  expect((await page.request.post(`${fx.origin}/fixture/mcp/inventory?append=true`)).ok()).toBe(
    true,
  );
  await page.evaluate(async () => {
    const w = window as unknown as {
      __kbQueryClient: import("@tanstack/react-query").QueryClient;
      __mcpGrantQueryKey: unknown[];
    };
    await w.__kbQueryClient.invalidateQueries({ queryKey: w.__mcpGrantQueryKey });
  });
  await expect(row.getByRole("button", { name: "Load more", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(row.locator("ul > li")).toHaveCount(258);
  await expect(row.getByText(kbLabel("z".repeat(24)), { exact: true })).toBeVisible();
  expect(
    (await page.request.post(`${fx.origin}/fixture/mcp/inventory?replaceTail=true`)).ok(),
  ).toBe(true);
  await page.evaluate(async () => {
    const w = window as unknown as {
      __kbQueryClient: import("@tanstack/react-query").QueryClient;
      __mcpGrantQueryKey: unknown[];
    };
    // Refetch only the outer list; a previously complete tail must be abandoned.
    await w.__kbQueryClient.invalidateQueries({ queryKey: w.__mcpGrantQueryKey });
  });
  await expect(row.locator("ul > li")).toHaveCount(256);
  await expect(row.getByRole("button", { name: "Load more", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(row.locator("ul > li")).toHaveCount(258);
  await expect(row.getByText(kbLabel("z".repeat(24)), { exact: true })).toHaveCount(0);
  await expect(row.getByText(kbLabel(seeded.lastKb), { exact: true })).toHaveCount(0);
  await expect(row.getByText(kbLabel("w".repeat(24)), { exact: true })).toBeVisible();
  await expect(row.getByText(kbLabel("y".repeat(24)), { exact: true })).toBeVisible();
});
