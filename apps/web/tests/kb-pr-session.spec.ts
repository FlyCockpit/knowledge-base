/** R40: production routes/RPC; faults lose or delay completed real responses. */

import enKb from "@knowledge-base/locales/src/en-US/kb.json" with { type: "json" };
import { expect, type Page, type Request, test } from "@playwright/test";
import type {
  KbBrowserFixtureData,
  KbBrowserPr,
} from "../../../packages/test-utils/src/kb/browser";
import type {} from "./kb-editor.harness";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("Run through pnpm test:kb -- browser");
const fx = JSON.parse(raw) as KbBrowserFixtureData;
type Scenario = {
  a: KbBrowserPr;
  b: KbBrowserPr;
  other: KbBrowserPr;
  cookies: { author: string; reviewer: string };
  authorId: string;
  reviewerId: string;
};
const href = (pr: KbBrowserPr) => `/en-US/kbs/${pr.kbId}/prs/${pr.number}`;
const holds = new Set<() => Promise<void>>();
test.afterEach(async () => {
  await Promise.all([...holds].map((release) => release()));
});
async function as(page: Page, cookie: string) {
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: fx.cookie.name, value: cookie, url: fx.origin, httpOnly: true },
    { name: "better-auth.session_token", value: cookie, url: fx.origin, httpOnly: true },
  ]);
}
async function boot(page: Page, role: "author" | "reviewer" = "reviewer") {
  await as(page, fx.cookie.value);
  const response = await page.request.post(`${fx.origin}/fixture/pr/scenario`);
  expect(response.ok()).toBe(true);
  const scenario = (await response.json()) as Scenario;
  await as(page, scenario.cookies[role]);
  await page.goto(`${fx.origin}/r38?${new URLSearchParams({ start: href(scenario.a) })}`);
  await ready(page);
  return scenario;
}
async function ready(page: Page) {
  await expect(page.getByTestId("pr-review")).toBeVisible({ timeout: 30_000 });
}
async function go(page: Page, href: string) {
  await page.evaluate(async (href) => {
    await window.__r38.router.navigate({ href });
  }, href);
}
async function state(page: Page, pr: KbBrowserPr) {
  return page.evaluate(
    ({ kbId, number }) => window.__r38.orpc.pullRequests.get.call({ kbId, number }),
    pr,
  );
}
function isCall(request: Request, router: string, procedure: string) {
  const data = `${decodeURIComponent(request.url())} ${request.postData() ?? ""}`;
  return (
    request.url().includes("/rpc") &&
    (data.includes(`/${router}/${procedure}`) ||
      data.includes(`"path":["${router}","${procedure}"]`))
  );
}
async function open(page: Page, decision: "merge" | "close") {
  await page.getByTestId(`pr-${decision}`).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  return dialog;
}
async function confirm(page: Page, decision: "merge" | "close") {
  const dialog = await open(page, decision);
  // Closing is a plain confirmation (R2-27); merging still types MERGE.
  if (decision === "merge") await dialog.getByPlaceholder("MERGE").fill("MERGE");
  await dialog
    .getByRole("button", {
      name: decision === "merge" ? "Merge pull request" : "Close pull request",
      exact: true,
    })
    .press("Enter");
}
async function holdReview(
  page: Page,
  drop: boolean,
  expectedStatus = 200,
  router = "pullRequests",
  procedure = "review",
) {
  let entered!: () => void;
  const handled = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let held = false;
  let status: number | null = null;
  await page.route("**/rpc**", async (route) => {
    if (held || !isCall(route.request(), router, procedure)) return route.fallback();
    held = true;
    try {
      const response = await route.fetch();
      status = response.status();
      entered();
      await gate;
      if (drop) await route.abort("failed");
      else await route.fulfill({ response });
    } finally {
      finished();
    }
  });
  const release = async () => {
    resume();
    if (held) await done;
    holds.delete(release);
    // Observe the actual client mutation settling before checking retired UI.
    // A delay alone could pass before the held response was parsed.
    if (!page.isClosed())
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__r38.queryClient
              .getMutationCache()
              .getAll()
              .some((mutation) => mutation.state.status === "pending"),
          ),
        )
        .toBe(false);
  };
  holds.add(release);
  return {
    handled: handled.then(() => expect(status).toBe(expectedStatus)),
    release,
  };
}

for (const decision of ["merge", "close"] as const) {
  for (const destination of ["b", "other"] as const) {
    test(`R40 ${decision} confirmation resets on cached ${destination} navigation and history`, async ({
      page,
    }) => {
      const scenario = await boot(page, decision === "close" ? "author" : "reviewer");
      const target = scenario[destination];
      await go(page, href(target));
      await ready(page);
      await go(page, href(scenario.a));
      await ready(page);
      const dialog = await open(page, decision);
      if (decision === "merge") await dialog.getByPlaceholder("MERGE").fill("MERGE");
      await go(page, href(target));
      await ready(page);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      const fresh = await open(page, decision);
      if (decision === "merge") {
        await expect(fresh.getByPlaceholder("MERGE")).toHaveValue("");
        await expect(
          fresh.getByRole("button", { name: "Merge pull request", exact: true }),
        ).toBeDisabled();
      }
      await fresh.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
      await page.goBack();
      await ready(page);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      expect((await state(page, scenario.a)).pr.status).toBe("OPEN");
      expect((await state(page, target)).pr.status).toBe("OPEN");
      await go(page, href(target));
      await ready(page);
      await confirm(page, decision);
      await expect(page.getByTestId("pr-status")).toHaveText(
        decision === "merge" ? "Merged" : "Closed",
      );
      expect((await state(page, scenario.a)).pr.status).toBe("OPEN");
    });
  }
}

for (const outcome of ["success", "conflict", "retryable"] as const) {
  for (const destination of ["b", "other", "reentry"] as const) {
    test(`R40 late ${outcome} is retired after ${destination}`, async ({ page }) => {
      const s = await boot(page);
      if (outcome === "conflict")
        expect(
          (await page.request.post(`${fx.origin}/fixture/advance-main?kbId=${s.a.kbId}`)).ok(),
        ).toBe(true);
      const held = await holdReview(
        page,
        outcome === "retryable",
        outcome === "conflict" ? 409 : 200,
      );
      await confirm(page, outcome === "conflict" ? "merge" : "close");
      await held.handled;
      if (destination === "reentry") {
        await go(page, `/en-US/kbs/${s.a.kbId}/prs`);
        await expect(page.getByTestId("pr-review")).toHaveCount(0);
        await go(page, href(s.a));
      } else await go(page, href(s[destination]));
      await ready(page);
      await held.release();
      await expect(page.getByTestId("pr-outcome")).toHaveCount(0);
      await expect(page.getByTestId("pr-close")).toBeEnabled();
      await expect(page.getByTestId("pr-merge")).toBeEnabled();
    });
  }
}

test("R40 same-session unknown result retries the exact key and displays the durable receipt", async ({
  page,
}) => {
  const s = await boot(page);
  const keys: string[] = [];
  page.on("request", (request) => {
    if (isCall(request, "pullRequests", "review")) keys.push(request.postData() ?? "");
  });
  const held = await holdReview(page, true);
  await confirm(page, "merge");
  await held.handled;
  expect((await state(page, s.a)).pr.status).toBe("MERGED");
  await held.release();
  await expect(page.getByTestId("pr-outcome")).toHaveAttribute("data-kind", "retryable");
  await confirm(page, "merge");
  await expect(page.getByTestId("pr-status")).toHaveText("Merged");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect((await state(page, s.a)).pr.status).toBe("MERGED");
});

test("R40 actor switch retires typed confirmation, and explicit refresh retires revised confirmation", async ({
  page,
}) => {
  const s = await boot(page);
  await open(page, "close");
  await as(page, s.cookies.author);
  await page.evaluate(async () => {
    await window.__r38.authClient.getSession({ query: { disableCookieCache: true } });
    window.__r38.authClient.$store.notify("$sessionSignal");
  });
  await expect(page.getByTestId("pr-merge")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const next = await open(page, "close");
  await next.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
  await as(page, s.cookies.reviewer);
  await page.evaluate(async () => {
    await window.__r38.authClient.getSession({ query: { disableCookieCache: true } });
    window.__r38.authClient.$store.notify("$sessionSignal");
  });
  await expect(page.getByTestId("pr-merge")).toBeVisible();
  await page.request.post(`${fx.origin}/fixture/advance-main?kbId=${s.a.kbId}`);
  await confirm(page, "merge");
  await expect(page.getByTestId("pr-refresh")).toBeVisible();
  await page.getByTestId("pr-refresh").click();
  await ready(page);
  await expect(page.getByTestId("pr-outcome")).toHaveCount(0);
  const revised = await open(page, "merge");
  await expect(revised.getByPlaceholder("MERGE")).toHaveValue("");
  await revised.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
  await page.reload();
  await ready(page);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

for (const path of ["added.md", "deleted.md"] as const) {
  test(`R40 ${path} recovers a lost existing-side response with an errored absent cache`, async ({
    page,
  }) => {
    const s = await boot(page);
    await go(page, `/en-US/kbs/${s.a.kbId}/prs`);
    const absentRev = path === "added.md" ? s.a.baseSha : s.a.headSha;
    await page.evaluate(
      async (input) => {
        const { queryClient, orpc } = window.__r38;
        const { presentRev, ...documentInput } = input;
        await queryClient
          .fetchQuery({
            queryKey: orpc.documents.get.key({ input: documentInput, type: "query" }),
            queryFn: async () => {
              const doc = await orpc.documents.get.call(documentInput);
              if (!doc) throw new Error("Intentionally absent immutable document");
              return doc;
            },
            retry: false,
          })
          .catch(() => undefined);
        if (
          queryClient.getQueryState(orpc.documents.get.key({ input: documentInput, type: "query" }))
            ?.status !== "error"
        )
          throw new Error("Absent-side cache was not errored");
        // Clear only the present revision so the fault goes through a real read.
        queryClient.removeQueries({
          queryKey: orpc.documents.get.key({
            input: { ...documentInput, rev: presentRev },
            type: "query",
          }),
        });
      },
      {
        kbId: s.a.kbId,
        path,
        rev: absentRev,
        presentRev: path === "added.md" ? s.a.headSha : s.a.baseSha,
      },
    );
    let dropped = false;
    let absentCalls = 0;
    let presentCalls = 0;
    await page.route("**/rpc**", async (route) => {
      const request = route.request();
      if (!isCall(request, "documents", "get") || !(request.postData() ?? "").includes(path))
        return route.continue();
      if ((request.postData() ?? "").includes(absentRev)) {
        absentCalls++;
        return route.continue();
      }
      presentCalls++;
      if (dropped) return route.continue();
      dropped = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    await go(page, href(s.a));
    await ready(page);
    const card = page.locator(`[data-testid="pr-file"][data-path="${path}"]`);
    await card.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(card.getByTestId(path === "added.md" ? "pr-after" : "pr-before")).toContainText(
      path === "added.md" ? "Added document" : "Removed document",
    );
    await expect(card.getByTestId(path === "added.md" ? "pr-before" : "pr-after")).toContainText(
      path === "added.md" ? "Not present before" : "Not present after",
    );
    expect(presentCalls).toBe(2);
    expect(absentCalls).toBe(0);
  });
}

test("R40 late success after actor change cannot overwrite the new actor's session", async ({
  page,
}) => {
  const s = await boot(page);
  const held = await holdReview(page, false);
  await confirm(page, "close");
  await held.handled;
  await as(page, s.cookies.author);
  await page.evaluate(() => {
    window.__r38.authClient.$store.notify("$sessionSignal");
  });
  await expect(page.getByTestId("pr-status")).toHaveText("Closed");
  await held.release();
  await expect(page.getByTestId("pr-outcome")).toHaveCount(0);
  await expect(page.getByTestId("pr-merge")).toHaveCount(0);
  await expect(page.getByTestId("pr-close")).toHaveCount(0);
});

test("R40 replacing displayed revisions retires an already typed confirmation", async ({
  page,
}) => {
  const s = await boot(page);
  const dialog = await open(page, "merge");
  await dialog.getByPlaceholder("MERGE").fill("MERGE");
  expect((await page.request.post(`${fx.origin}/fixture/advance-main?kbId=${s.a.kbId}`)).ok()).toBe(
    true,
  );
  const freshTarget = await page.evaluate(async ({ kbId, number }) => {
    const { queryClient, orpc } = window.__r38;
    const fresh = await orpc.pullRequests.get.call({ kbId, number });
    // Deliver an actual handler's new page without a loading interlude. This
    // specifically exercises the revision boundary, independently of unmount.
    queryClient.setQueriesData(
      { queryKey: orpc.pullRequests.get.key({ input: { kbId, number }, type: "infinite" }) },
      { pages: [fresh], pageParams: [null] },
    );
    return fresh.pr.targetSha;
  }, s.a);
  await expect(page.getByTestId("pr-reviewed-target")).toHaveText(freshTarget.slice(0, 12));
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const revised = await open(page, "merge");
  await expect(revised.getByPlaceholder("MERGE")).toHaveValue("");
  await expect(
    revised.getByRole("button", { name: "Merge pull request", exact: true }),
  ).toBeDisabled();
});

async function changeReviewerAccess(page: Page, s: Scenario, retainRead: boolean) {
  const email = await page.evaluate(
    () => window.__r38.authClient.$store.atoms.session?.get().data?.user.email,
  );
  if (!email) throw new Error("Expected the scenario reviewer's real session");
  await as(page, fx.cookie.value);
  if (retainRead) {
    const invitation = await page.evaluate(
      ({ kbId, email }) =>
        window.__r38.orpc.kbs.shareInvite.call({
          kbId,
          email,
          permissions: ["read"],
          idempotencyKey: crypto.randomUUID(),
        }),
      { kbId: s.a.kbId, email },
    );
    await as(page, s.cookies.reviewer);
    await page.evaluate(
      (requestId) => window.__r38.orpc.kbs.shareAccept.call({ requestId }),
      invitation.requestId,
    );
  } else {
    await page.evaluate(
      ({ kbId, shareUserId }) => window.__r38.orpc.kbs.shareRevoke.call({ kbId, shareUserId }),
      { kbId: s.a.kbId, shareUserId: s.reviewerId },
    );
    await as(page, s.cookies.reviewer);
  }
}
async function privateData(page: Page, kbId: string) {
  return page.evaluate(
    (kbId) =>
      window.__r38.queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => {
          const options = q.queryKey[1] as { input?: { kbId?: string } } | undefined;
          return options?.input?.kbId === kbId;
        })
        .map((q) => q.state.data),
    kbId,
  );
}
for (const decision of ["merge", "close"] as const) {
  for (const retainRead of [false, true]) {
    test(`R40 retired ${decision} denial ${retainRead ? "keeps readable" : "forgets revoked"} cached successor`, async ({
      page,
    }) => {
      const s = await boot(page);
      for (const pr of [s.b, s.other, s.a]) {
        await go(page, href(pr));
        await ready(page);
        await expect(page.getByTestId("pr-after").first()).toContainText("Added document");
      }
      await changeReviewerAccess(page, s, retainRead);
      const held = await holdReview(page, false, retainRead ? 403 : 404);
      await confirm(page, decision);
      await held.handled;
      let reads = 0;
      page.on("request", (request) => {
        if (isCall(request, "kbs", "get")) reads++;
      });
      await go(page, href(s.b));
      await ready(page);
      await expect(page.getByTestId("pr-after").first()).toContainText("Added document");
      expect(reads).toBe(0); // Navigation reuses the fresh same-actor KB observer.
      await held.release();
      await expect.poll(() => reads).toBeGreaterThan(0);
      if (retainRead) {
        await ready(page);
        await expect(page.getByTestId("pr-outcome")).toHaveCount(0);
        await expect(page.getByTestId("pr-merge")).toHaveCount(0);
        await expect(page.getByTestId("pr-close")).toHaveCount(0);
        await expect(page.getByTestId("pr-after").first()).toContainText("Added document");
        expect(JSON.stringify(await privateData(page, s.a.kbId))).toContain("Added document");
        expect((await state(page, s.b)).pr.status).toBe("OPEN");
      } else {
        await expect(page.getByText(enKb.detail.unavailable, { exact: true })).toBeVisible();
        await expect(page.getByTestId("pr-review")).toHaveCount(0);
        expect((await privateData(page, s.a.kbId)).every((data) => data === undefined)).toBe(true);
      }
      expect(JSON.stringify(await privateData(page, s.other.kbId))).toContain("Added document");
    });
  }
}

test("R40 retired denied review cannot recheck or clear a changed actor's cached successor", async ({
  page,
}) => {
  const s = await boot(page);
  await go(page, href(s.b));
  await ready(page);
  await go(page, href(s.a));
  await ready(page);
  await changeReviewerAccess(page, s, false);
  const held = await holdReview(page, false, 404);
  await confirm(page, "close");
  await held.handled;
  await go(page, href(s.b));
  await ready(page);
  await as(page, s.cookies.author);
  await page.evaluate(() => window.__r38.authClient.$store.notify("$sessionSignal"));
  await expect(page.getByTestId("pr-merge")).toHaveCount(0);
  await expect(page.getByTestId("pr-close")).toBeEnabled();
  await expect(page.getByTestId("pr-after").first()).toContainText("Added document");
  let reads = 0;
  page.on("request", (request) => {
    if (isCall(request, "kbs", "get")) reads++;
  });
  await held.release();
  await expect(page.getByTestId("pr-outcome")).toHaveCount(0);
  await expect(page.getByTestId("pr-close")).toBeEnabled();
  expect(reads).toBe(0);
  expect(JSON.stringify(await privateData(page, s.a.kbId))).toContain("Added document");
  expect((await state(page, s.b)).pr.status).toBe("OPEN");
});

for (const retainRead of [false, true]) {
  test(`R40 actor change during a retired ${retainRead ? "readable" : "lost"} access check preserves successor`, async ({
    page,
  }) => {
    const s = await boot(page);
    await go(page, href(s.b));
    await ready(page);
    await go(page, href(s.a));
    await ready(page);
    await changeReviewerAccess(page, s, retainRead);
    const denied = await holdReview(page, false, retainRead ? 403 : 404);
    await confirm(page, "close");
    await denied.handled;
    await go(page, href(s.b));
    await ready(page);
    const access = await holdReview(page, false, retainRead ? 200 : 404, "kbs", "get");
    await denied.release();
    await access.handled;
    await as(page, s.cookies.author);
    await page.evaluate(() => window.__r38.authClient.$store.notify("$sessionSignal"));
    await expect(page.getByTestId("pr-merge")).toHaveCount(0);
    await expect(page.getByTestId("pr-close")).toBeEnabled();
    await expect(page.getByTestId("pr-after").first()).toContainText("Added document");
    await access.release();
    await expect
      .poll(() =>
        page.evaluate(
          (key) =>
            window.__r38.queryClient
              .getQueryCache()
              .getAll()
              .some((q) => q.queryKey.at(-1) === key && q.state.fetchStatus === "fetching"),
          `user:${s.reviewerId}`,
        ),
      )
      .toBe(false);
    await expect(page.getByTestId("pr-outcome")).toHaveCount(0);
    await expect(page.getByTestId("pr-close")).toBeEnabled();
    await expect(page.getByTestId("pr-after").first()).toContainText("Added document");
    expect(JSON.stringify(await privateData(page, s.a.kbId))).toContain("Added document");
    expect((await state(page, s.b)).pr.status).toBe("OPEN");
  });
}
