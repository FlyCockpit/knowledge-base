/** R38: real route/client/router regressions; faults occur AFTER real handlers. */
import { randomUUID } from "node:crypto";
import enCommon from "@knowledge-base/locales/src/en-US/common.json" with { type: "json" };
import enKb from "@knowledge-base/locales/src/en-US/kb.json" with { type: "json" };
import { expect, type Page, type Request, test } from "@playwright/test";
import { minimalPng } from "../../../packages/api/src/lib/kb/fixtures/media-bytes";
import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";
import type {} from "./kb-editor.harness";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("Run through pnpm test:kb -- browser");
const fx = JSON.parse(raw) as KbBrowserFixtureData;
const s = fx.settings;
let actors: {
  cookies: { owner: string; manager: string };
  managerUserId: string;
  managerEmail?: string;
} = s;
const docPath = "notes/edit.md";
const pendingHolds = new Set<() => Promise<void>>();
test.afterEach(async () => {
  await Promise.all([...pendingHolds].map((release) => release()));
});
const markdown = (page: Page) => page.getByTestId("editor-markdown");
const save = (page: Page) => page.getByRole("button", { name: enKb.editor.save, exact: true });
// Documents open read-first; these specs drive the editor, so
// they open a document straight in edit mode.
const at = (kbId: string, path?: string) =>
  `/en-US/kbs/${kbId}${path === undefined ? "" : `/documents?${new URLSearchParams(path ? { path, mode: "edit" } : { mode: "new" })}`}`;

async function as(page: Page, who: "owner" | "manager") {
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: fx.cookie.name, value: actors.cookies[who], url: fx.origin, httpOnly: true },
    // Routed PR pages need the actor's real Better Auth session (fixture-only
    // values are not valid signed sessions and read as signed out there).
    {
      name: "better-auth.session_token",
      value: actors.cookies[who],
      url: fx.origin,
      httpOnly: true,
    },
  ]);
}
async function boot(page: Page) {
  await as(page, "owner");
  const response = await page.request.post(`${fx.origin}/fixture/editor/actors`);
  expect(response.ok()).toBe(true);
  actors = await response.json();
  await as(page, "owner");
  await page.goto(`${fx.origin}/r38`);
  await expect(page.getByRole("button", { name: enKb.list.create, exact: true })).toBeVisible({
    timeout: 25_000,
  });
}
async function createKb(page: Page, text?: string) {
  return page.evaluate(
    async ({ slug, text, docPath }) => {
      const { orpc, kbAttachmentSchema } = window.__r38;
      const created = await orpc.kbs.create.call({
        name: slug,
        slug,
        description: "R38 browser regression KB",
        idempotencyKey: crypto.randomUUID(),
      });
      const kb = kbAttachmentSchema.parse(created.kb);
      if (text !== undefined)
        await orpc.documents.create.call({
          kbId: kb.id,
          baseRevision: kb.headSha!,
          path: docPath,
          content: { markdown: text },
          idempotencyKey: crypto.randomUUID(),
        });
      return kbAttachmentSchema.parse((await orpc.kbs.get.call({ kbId: kb.id }))?.kb);
    },
    { slug: `r38-${randomUUID()}`, text, docPath },
  );
}
async function go(page: Page, href: string) {
  await page.evaluate(async (href) => {
    await window.__r38.router.navigate({ href });
  }, href);
}
async function prime(page: Page, kbId: string, document = false) {
  await page.evaluate(
    async ({ kbId, document, docPath }) => {
      const { queryClient, orpc } = window.__r38;
      await queryClient.fetchQuery(orpc.kbs.get.queryOptions({ input: { kbId } }));
      if (document)
        await queryClient.fetchQuery(
          orpc.documents.get.queryOptions({ input: { kbId, path: docPath } }),
        );
    },
    { kbId, document, docPath },
  );
}
async function read(page: Page, kbId: string, path = docPath) {
  return page.evaluate(
    ({ kbId, path }) =>
      window.__r38.orpc.documents.get
        .call({ kbId, path })
        .then((r) => window.__r38.documentSchema.parse(r)),
    {
      kbId,
      path,
    },
  );
}
function isCall(request: Request, root: string, op: string) {
  const text = `${decodeURIComponent(request.url())} ${request.postData() ?? ""}`;
  return (
    request.url().includes("/rpc") &&
    (text.includes(`/${root}/${op}`) || text.includes(`"path":["${root}","${op}"]`))
  );
}
async function dropOnce(page: Page, root: string, op: string) {
  let dropped = false;
  const calls: string[] = [];
  await page.route("**/rpc**", async (route) => {
    if (!isCall(route.request(), root, op)) return route.continue();
    calls.push(route.request().postData() ?? route.request().url());
    if (dropped) return route.continue();
    dropped = true;
    const response = await route.fetch();
    expect(response.ok(), `fault must follow a successful real ${root}.${op}`).toBe(true);
    if (op !== "get") return route.abort("failed");
    // Reads share a transport with fresh KB checks. Fail only the intended
    // dependency; aborting the batch would also fail the parent layout.
    const error = {
      json: {
        defined: false,
        code: "INTERNAL_SERVER_ERROR",
        status: 503,
        message: "Fixture unavailable",
      },
    };
    if (!route.request().url().includes("/__batch__"))
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify(error),
      });
    const requests = route.request().postDataJSON() as { url: string }[];
    const body = (await response.text())
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data: ")) return line;
        const item = JSON.parse(line.slice(6)) as {
          index: number;
          status: number;
          body: unknown;
        };
        if (new URL(requests[item.index]!.url).pathname.endsWith(`/${root}/${op}`)) {
          item.status = 503;
          item.body = error;
        }
        return `data: ${JSON.stringify(item)}`;
      })
      .join("\n");
    return route.fulfill({ response, body });
  });
  return calls;
}
async function holdOnce(
  page: Page,
  root: string,
  op: string,
  only: (request: Request) => boolean = () => true,
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
  await page.route("**/rpc**", async (route) => {
    if (held || !isCall(route.request(), root, op) || !only(route.request()))
      return route.continue();
    held = true;
    const response = await route.fetch();
    entered();
    await gate;
    try {
      await route.fulfill({ response });
    } finally {
      finished();
    }
  });
  const release = async () => {
    resume();
    await done;
    pendingHolds.delete(release);
  };
  pendingHolds.add(release);
  return { handled, release };
}
async function mutationsSettled(page: Page) {
  // reset()/unmount can retire observers while the actual mutation and its
  // async invalidation callback still run. Assert the successor only afterward.
  await expect
    .poll(() => page.evaluate(() => window.__r38.queryClient.isMutating()), { timeout: 15_000 })
    .toBe(0);
}
async function fillCreate(page: Page, suffix: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(enKb.create.name, { exact: true }).fill(`Intent ${suffix}`);
  await dialog.getByLabel(enKb.create.slug, { exact: true }).fill(`intent-${randomUUID()}`);
  await dialog
    .getByLabel(enKb.create.descriptionLabel, { exact: true })
    .fill(`Private draft ${suffix}`);
}

test("R5 offline save explains its pause and resumes the same draft", async ({ page }) => {
  await boot(page);
  const kb = await createKb(page, "Before offline");
  await go(page, at(kb.id, docPath));
  await expect(markdown(page)).toHaveValue("Before offline");
  await markdown(page).fill("Saved after reconnecting");
  await page.context().setOffline(true);
  try {
    await save(page).click();
    await expect(page.getByText(enKb.editor.offline, { exact: true })).toBeVisible();
    await expect(markdown(page)).toHaveValue("Saved after reconnecting");
  } finally {
    await page.context().setOffline(false);
  }
  await expect(page.getByText(enKb.outcome.appliedTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(enKb.editor.offline, { exact: true })).toHaveCount(0);
  expect((await read(page, kb.id)).markdown).toBe("Saved after reconnecting");
});

test("R5 returning to a head document refreshes its cached revision", async ({ page }) => {
  await boot(page);
  const kb = await createKb(page, "Cached before remote edit");
  await go(page, readAt(kb.id));
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Cached before remote edit");
  await go(page, at(kb.id));
  await page.evaluate(
    ({ kbId, baseRevision, path }) =>
      window.__r38.orpc.documents.update.call({
        kbId,
        baseRevision,
        path,
        content: { markdown: "Fresh after remote edit" },
        idempotencyKey: crypto.randomUUID(),
      }),
    { kbId: kb.id, baseRevision: kb.headSha!, path: docPath },
  );
  await go(page, readAt(kb.id));
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Fresh after remote edit");
});

test("R5 missing paths on main and a pinned revision explain their absence", async ({ page }) => {
  await boot(page);
  const kb = await createKb(page, "Existing document");
  for (const rev of [undefined, kb.headSha!]) {
    const search = new URLSearchParams({ path: "notes/missing.md", ...(rev ? { rev } : {}) });
    await go(page, `/en-US/kbs/${kb.id}/documents?${search}`);
    await expect(page.getByText(enKb.document.notFound, { exact: true })).toBeVisible();
    await expect(page.getByText(enKb.editor.loadFailed, { exact: true })).toHaveCount(0);
  }
});

test("R5 resolving the last PR conflict retires its comparisons and staged image note", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page, "Common base");
  expect(
    (await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}&proposer=1`)).ok(),
  ).toBe(true);
  const update = () =>
    page.evaluate(
      ({ kbId, baseRevision, path }) =>
        window.__r38.orpc.documents.update.call({
          kbId,
          baseRevision,
          path,
          content: { markdown: "Changed on this branch" },
          idempotencyKey: crypto.randomUUID(),
        }),
      { kbId: kb.id, baseRevision: kb.headSha!, path: docPath },
    );
  await as(page, "manager");
  await update();
  const number = await page.evaluate(
    async (kbId) =>
      (await window.__r38.orpc.pullRequests.list.call({ kbId, limit: 5, status: "OPEN" })).items[0]!
        .number,
    kb.id,
  );
  await as(page, "owner");
  // Use different text so the two replacements conflict.
  await page.evaluate(
    ({ kbId, baseRevision, path }) =>
      window.__r38.orpc.documents.update.call({
        kbId,
        baseRevision,
        path,
        content: { markdown: "Changed on main" },
        idempotencyKey: crypto.randomUUID(),
      }),
    { kbId: kb.id, baseRevision: kb.headSha!, path: docPath },
  );
  await as(page, "manager");
  await go(page, `${at(kb.id, docPath)}&pr=${number}`);
  await expect(page.getByTestId("pr-mode-conflict")).toBeVisible();
  await markdown(page).fill("Resolved both versions");
  await page
    .getByTestId("editor-image-input")
    .setInputFiles({ name: "resolved.png", mimeType: "image/png", buffer: minimalPng() });
  await expect(markdown(page)).toHaveValue(/assets\/resolved-/);
  const propose = page.getByRole("button", { name: enKb.editor.propose, exact: true });
  await expect(propose).toBeEnabled();
  await propose.click();
  await expect(page.getByTestId("pr-mode-conflict")).toHaveCount(0);
  await expect(page.getByText(enKb.prMode.base, { exact: true })).toHaveCount(0);
  await expect(page.getByText(enKb.prMode.theirs, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/resolved.png is uploaded and linked/)).toHaveCount(0);
  expect((await read(page, kb.id)).markdown).toBe("Changed on main");
});

// Independently fresh kbs.get must never bless cached document bytes.
test("F1 cached document pins its own commit, preserves conflict draft and advances only after save", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page, "Snapshot A");
  await go(page, at(kb.id, docPath));
  await expect(markdown(page)).toHaveValue("Snapshot A");
  await go(page, at(kb.id));
  const remote = await page.evaluate(
    async ({ kbId, baseRevision, path }) => {
      const { orpc, queryClient } = window.__r38;
      const result = await orpc.documents.update.call({
        kbId,
        baseRevision,
        path,
        content: { markdown: "Remote B" },
        idempotencyKey: crypto.randomUUID(),
      });
      await queryClient.fetchQuery({
        ...orpc.kbs.get.queryOptions({ input: { kbId } }),
        staleTime: 0,
      });
      return window.__r38.parseApplyResult(result);
    },
    { kbId: kb.id, baseRevision: kb.headSha!, path: docPath },
  );
  await go(page, at(kb.id, docPath));
  await expect(markdown(page)).toHaveValue("Snapshot A");
  await markdown(page).fill("Local draft C");
  await save(page).click();
  await expect(page.getByText(enKb.outcome.conflictTitle, { exact: true })).toBeVisible();
  await expect(markdown(page)).toHaveValue("Local draft C");
  expect((await read(page, kb.id)).markdown).toBe("Remote B");
  // The version that saving would replace is read and shown before adopting.
  await expect(page.getByTestId("revision-preview")).toContainText("Remote B");
  await page.getByRole("button", { name: enKb.outcome.adoptHead }).click();
  await expect(
    page.getByText(`Editing on ${remote.commitSha.slice(0, 12)}`, { exact: true }),
  ).toBeVisible();
  await save(page).click();
  await expect(page.getByText(enKb.outcome.appliedTitle, { exact: true })).toBeVisible();
  await markdown(page).fill("Next draft D");
  await save(page).click();
  await expect(save(page)).toBeEnabled();
  expect((await read(page, kb.id)).markdown).toBe("Next draft D");
});

test("F1 metadata pins opening fields/version across dirty refetch; reopen uses fresh snapshot", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page);
  await go(page, at(kb.id));
  await page.getByTestId("kb-edit").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(enKb.create.name, { exact: true }).fill("Local metadata");
  await page.evaluate(
    async ({ kbId, metadataVersion }) => {
      const { orpc, queryClient } = window.__r38;
      await orpc.kbs.update.call({
        kbId,
        metadataVersion,
        name: "Remote metadata",
        idempotencyKey: crypto.randomUUID(),
      });
      await queryClient.fetchQuery({
        ...orpc.kbs.get.queryOptions({ input: { kbId } }),
        staleTime: 0,
      });
    },
    { kbId: kb.id, metadataVersion: kb.metadataVersion },
  );
  await expect(dialog.getByLabel(enKb.create.name, { exact: true })).toHaveValue("Local metadata");
  await dialog.getByRole("button", { name: enKb.manage.save, exact: true }).press("Enter");
  await expect(dialog.getByText(enKb.manage.conflict, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      (kbId) => window.__r38.orpc.kbs.get.call({ kbId }).then((r) => r?.kb.name),
      kb.id,
    ),
  ).toBe("Remote metadata");
  await page.keyboard.press("Escape");
  await page.getByTestId("kb-edit").click();
  await expect(dialog.getByLabel(enKb.create.name, { exact: true })).toHaveValue("Remote metadata");
  await dialog.getByLabel(enKb.create.name, { exact: true }).fill("Legitimate new snapshot");
  await dialog.getByRole("button", { name: enKb.manage.save, exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Legitimate new snapshot", exact: true }),
  ).toBeVisible();
});

for (const existing of [false, true])
  test(`F2 cached KB switch resets ${existing ? "existing" : "new"} document session`, async ({
    page,
  }) => {
    await boot(page);
    const a = await createKb(page, existing ? "Private A" : undefined);
    const b = await createKb(page, existing ? "Private B" : undefined);
    await prime(page, b.id, existing);
    await go(page, at(a.id, existing ? docPath : ""));
    await expect(markdown(page)).toBeVisible();
    await markdown(page).fill("A unsaved private draft");
    if (!existing)
      await page.getByLabel(enKb.editor.pathLabel, { exact: true }).fill("private-a.md");
    // Same-KB metadata refresh cannot retire a dirty editor.
    await page.evaluate(async (kbId) => {
      const { queryClient, orpc } = window.__r38;
      await queryClient.fetchQuery({
        ...orpc.kbs.get.queryOptions({ input: { kbId } }),
        staleTime: 0,
      });
    }, a.id);
    await expect(markdown(page)).toHaveValue("A unsaved private draft");
    await go(page, at(b.id, existing ? docPath : ""));
    await expect(markdown(page)).toHaveValue(existing ? "Private B" : "");
    if (!existing)
      await expect(page.getByLabel(enKb.editor.pathLabel, { exact: true })).toHaveValue("");
  });

test("F2 KB header overlays and submitted search filters retire with KB identity", async ({
  page,
}) => {
  await boot(page);
  const a = await createKb(page);
  const b = await createKb(page);
  await prime(page, b.id);
  await go(page, at(a.id));
  await page.getByLabel(enKb.search.typeLabel, { exact: true }).fill("private-a-filter");
  await page.getByLabel(enKb.search.typeLabel, { exact: true }).press("Enter");
  await expect(page.getByText(enKb.search.indexUnavailable, { exact: true })).toBeVisible();
  await page.getByTestId("kb-edit").click();
  await page
    .getByRole("dialog")
    .getByLabel(enKb.create.name, { exact: true })
    .fill("A overlay draft");
  await go(page, at(b.id));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel(enKb.search.typeLabel, { exact: true })).toHaveValue("");
  await expect(page.getByText(enKb.search.indexUnavailable, { exact: true })).toHaveCount(0);
});

test("F2 retired editor delete cannot navigate away from cached successor", async ({ page }) => {
  await boot(page);
  const a = await createKb(page, "Delete A");
  const b = await createKb(page);
  await prime(page, b.id);
  await go(page, at(a.id, docPath));
  const hold = await holdOnce(page, "documents", "delete");
  await page.getByRole("button", { name: enKb.editor.delete, exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByPlaceholder("DELETE").fill("DELETE");
  await dialog.getByRole("button", { name: enCommon.actions.delete, exact: true }).press("Enter");
  await hold.handled;
  await go(page, at(b.id, ""));
  await markdown(page).fill("Successor B");
  await hold.release();
  await mutationsSettled(page);
  await expect(markdown(page)).toHaveValue("Successor B");
  await expect(page).toHaveURL(new RegExp(`/kbs/${b.id}/documents`));
});

test("a recovered create leaves New document with the live draft; its path stays fixed meanwhile", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page);
  const path = "notes/recovered.md";
  await go(page, at(kb.id, ""));
  const pathField = page.getByLabel(enKb.editor.pathLabel);
  await pathField.fill(path);
  await markdown(page).fill("First draft");
  // The create lands, but its reply is lost: the outcome is unknown.
  await dropOnce(page, "documents", "create");
  await save(page).click();
  await expect(page.getByText(enKb.editor.retryable, { exact: true })).toBeVisible();
  // The unresolved create names this path: renaming it now is refused.
  await expect(pathField).toHaveAttribute("readonly", "");
  await markdown(page).fill("Second draft");
  await save(page).click();
  // The recovered create moves the session's target; the page follows it
  // and keeps the same draft (no reload of the saved text).
  await expect.poll(() => new URL(page.url()).searchParams.get("path")).toBe(path);
  expect(new URL(page.url()).searchParams.get("mode")).toBe("edit");
  await expect(page.getByRole("heading", { name: enKb.detail.newDocument })).toHaveCount(0);
  await expect(markdown(page)).toHaveValue("Second draft");
  await mutationsSettled(page);
  expect((await read(page, kb.id, path)).markdown).toBe("Second draft");
});

const readAt = (kbId: string, path = docPath) =>
  `/en-US/kbs/${kbId}/documents?${new URLSearchParams({ path })}`;

/** Confirm the open Delete document dialog. */
async function confirmDelete(page: Page) {
  const dialog = page.getByRole("alertdialog");
  await dialog.getByPlaceholder("DELETE").fill("DELETE");
  await dialog.getByRole("button", { name: enCommon.actions.delete, exact: true }).press("Enter");
}

/** Bases sent by every documents.delete, in order. */
function watchDeletes(page: Page) {
  const bases: string[] = [];
  page.on("request", (request) => {
    if (!isCall(request, "documents", "delete")) return;
    const body = request.postData() ?? "";
    const match = /"baseRevision":"([0-9a-f]{40})"/.exec(body);
    if (match) bases.push(match[1]!);
  });
  return bases;
}

test("P3 header delete after a proposed edit targets the proposal head", async ({ page }) => {
  await boot(page);
  const kb = await createKb(page, "Main text");
  expect(
    (await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}&proposer=1`)).ok(),
  ).toBe(true);
  await as(page, "manager");
  const bases = watchDeletes(page);
  await go(page, at(kb.id, docPath));
  await markdown(page).fill("Proposed text");
  await page.getByRole("button", { name: enKb.editor.propose, exact: true }).click();
  // A save that chooses a proposal opens that complete target's session.
  await expect.poll(() => new URL(page.url()).searchParams.get("proposal")).toMatch(/^\d+$/);
  await expect(markdown(page)).toHaveValue("Proposed text");
  const proposalHead = await page.evaluate(
    ({ kbId }) =>
      window.__r38.orpc.pullRequests.list
        .call({ kbId, limit: 5, status: "OPEN" })
        .then((page) => page.items[0]?.headSha ?? null),
    { kbId: kb.id },
  );
  expect(proposalHead).toMatch(/^[0-9a-f]{40}$/);
  // The same session's Delete writes against the proposal it just advanced to.
  await page.getByRole("button", { name: enKb.editor.delete, exact: true }).click();
  await confirmDelete(page);
  // R6: deleted in the proposal is a state of its own, never a failed read
  // (its head read reports PATH_NOT_FOUND) and nothing deletes it again.
  const number = Number(new URL(page.url()).searchParams.get("proposal"));
  const notice = page.getByText(
    enKb.document.deletedInProposal.replace("{{number}}", String(number)),
  );
  await expect(notice).toBeVisible();
  expect(bases).toEqual([proposalHead]);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const deletedState = async () => {
    await expect(notice).toBeVisible();
    await expect(page.getByText(enKb.editor.loadFailed)).toHaveCount(0);
    await expect(page.getByRole("button", { name: enKb.editor.delete, exact: true })).toHaveCount(
      0,
    );
    await expect(markdown(page)).toHaveCount(0);
  };
  await deletedState();
  // The same on re-entry, from the proposal head's read and its base.
  await page.reload();
  await deletedState();
  // A refetch of the proposal (focus, a save's invalidation) keeps the state
  // keyed on the head it last saw: no skeleton while the answer is held.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  await page.route("**/rpc**", async (route) => {
    if (!isCall(route.request(), "pullRequests", "get")) return route.continue();
    holding = true;
    await held;
    await route.continue().catch(() => {});
  });
  // Not awaited: the refetch it starts is the one held above.
  await page.evaluate(() => {
    void window.__r38.queryClient.invalidateQueries({
      queryKey: window.__r38.orpc.pullRequests.get.key(),
    });
  });
  await expect.poll(() => holding).toBe(true);
  await deletedState();
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  release();
  await page.unroute("**/rpc**");
  await deletedState();
  // Main still has it, one step away.
  await page.getByRole("button", { name: enKb.document.openMain, exact: true }).click();
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Main text");
  // Main is untouched until a reviewer merges.
  expect((await read(page, kb.id)).markdown).toBe("Main text");
});

for (const existing of [false, true])
  test(`R4 a proposed ${existing ? "edit" : "create"} keeps one editing target across saves, reads, reload, history and lookup failure`, async ({
    page,
  }) => {
    await boot(page);
    const kb = await createKb(page, existing ? "Main text" : undefined);
    const path = existing ? docPath : "notes/proposed-new.md";
    expect(
      (await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}&proposer=1`)).ok(),
    ).toBe(true);
    await as(page, "manager");
    const propose = () => page.getByRole("button", { name: enKb.editor.propose, exact: true });
    const proposals = () =>
      page.evaluate(
        ({ kbId }) =>
          window.__r38.orpc.pullRequests.list
            .call({ kbId, limit: 5, status: "OPEN" })
            .then((page) => page.items.map((pr) => ({ number: pr.number, version: pr.version }))),
        { kbId: kb.id },
      );
    const save = async (text: string, version: number) => {
      await markdown(page).fill(text);
      await propose().click();
      await expect.poll(proposals).toEqual([{ number, version }]);
      await expect(propose()).toBeEnabled();
    };
    // A read right after a save shows that save (the proposal's new head).
    const doneShows = async (text: string) => {
      await page.getByRole("link", { name: enKb.document.doneEditing, exact: true }).click();
      await expect(page.getByTestId("kb-rendered-document")).toContainText(text);
      await page.getByTestId("document-edit").click();
      await expect(markdown(page)).toHaveValue(text);
    };
    if (existing) await go(page, at(kb.id, docPath));
    else {
      await go(page, at(kb.id, ""));
      await page.getByLabel(enKb.editor.pathLabel).fill(path);
    }
    await markdown(page).fill("One");
    await propose().click();
    // The URL names the proposal: the target is now that proposal.
    await expect.poll(() => new URL(page.url()).searchParams.get("proposal")).toMatch(/^\d+$/);
    const number = Number(new URL(page.url()).searchParams.get("proposal"));
    expect(await proposals()).toEqual([{ number, version: 1 }]);
    await expect(page.getByText(`In pull request #${number}`)).toBeVisible();
    await expect(page.getByRole("heading", { name: enKb.detail.newDocument })).toHaveCount(0);
    // Successive saves, then a read: the latest head every time.
    await save("Two", 2);
    await save("Three", 3);
    await doneShows("Three");
    // An inserted image is staged (R3-W7): it writes nothing until the next
    // save, which commits it with the draft and advances the read head.
    await markdown(page).fill("Draft with image");
    await expect(page.getByTestId("editor-insert-image")).toBeEnabled();
    await page.getByTestId("editor-image-input").setInputFiles({
      name: "proposal.png",
      mimeType: "image/png",
      buffer: minimalPng(),
    });
    await expect(markdown(page)).toHaveValue(/Draft with image/);
    await expect(markdown(page)).toHaveValue(/assets\/proposal-/);
    await expect(propose()).toBeEnabled();
    expect(await proposals()).toEqual([{ number, version: 3 }]);
    await propose().click();
    await expect.poll(proposals).toEqual([{ number, version: 4 }]);
    await expect(propose()).toBeEnabled();
    const imageHead = await page.evaluate(
      async ({ kbId, number }) =>
        (await window.__r38.orpc.pullRequests.get.call({ kbId, number })).pr.headSha,
      { kbId: kb.id, number },
    );
    await page.getByRole("link", { name: enKb.document.doneEditing, exact: true }).click();
    await expect(page.getByTestId("kb-rendered-document")).toContainText("Draft with image");
    await expect(
      page.getByText(enKb.document.revision.replace("{{sha}}", imageHead.slice(0, 12)), {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByTestId("document-edit").click();
    await expect(markdown(page)).toHaveValue(/Draft with image/);
    // Reload reopens the proposal's head; the next save extends it.
    const proposalHref = new URL(page.url());
    await page.reload();
    await expect(markdown(page)).toHaveValue(/Draft with image[\s\S]*assets\/proposal-/, {
      timeout: 25_000,
    });
    await save("Four", 5);
    // Main and proposal are different targets with their own sessions,
    // switched in place (the route stays mounted) and through history.
    if (existing) {
      await go(page, at(kb.id, docPath));
      await expect(markdown(page)).toHaveValue("Main text");
      await page.goBack();
      await expect(markdown(page)).toHaveValue("Four");
      await page.goForward();
      await expect(markdown(page)).toHaveValue("Main text");
      await page.goBack();
      await expect(markdown(page)).toHaveValue("Four");
    }
    // Leave and return: still the same proposal.
    await go(page, at(kb.id));
    await go(page, proposalHref.pathname + proposalHref.search);
    await expect(markdown(page)).toHaveValue("Four");
    await save("Five", 6);
    // A failed proposal lookup never falls back to main; its retry recovers it.
    await go(page, at(kb.id));
    await dropOnce(page, "pullRequests", "get");
    await go(page, proposalHref.pathname + proposalHref.search);
    await expect(page.getByText(`Couldn't load pull request #${number}.`)).toBeVisible();
    await expect(markdown(page)).toHaveCount(0);
    await page.getByRole("button", { name: enCommon.actions.tryAgain, exact: true }).click();
    await expect(markdown(page)).toHaveValue("Five");
    await save("Six", 7);
    // Main never changed.
    if (existing) expect((await read(page, kb.id)).markdown).toBe("Main text");
  });

test("P3 a reopened page's delete updates the open proposal and shows its numbered toast", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page, "Main text");
  expect(
    (await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}&proposer=1`)).ok(),
  ).toBe(true);
  await as(page, "manager");
  await go(page, at(kb.id, docPath));
  await markdown(page).fill("Proposed text");
  await page.getByRole("button", { name: enKb.editor.propose, exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("proposal")).toMatch(/^\d+$/);
  await expect(markdown(page)).toHaveValue("Proposed text");
  // Reopened (a new page session) it reads main again: its first delete
  // targets main and conflicts with the caller's open proposal.
  await go(page, at(kb.id));
  await go(page, readAt(kb.id));
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Main text");
  const bases = watchDeletes(page);
  await page.getByRole("button", { name: enKb.editor.delete, exact: true }).click();
  await confirmDelete(page);
  const again = page.getByRole("alertdialog");
  await expect(again).toContainText(/Your open proposal #\d+ already has changes/);
  // What is shown is the document at the proposal head, not main.
  const preview = again.getByTestId("revision-preview");
  await expect(preview).toHaveAttribute("data-state", "ready");
  await expect(preview).toContainText("Proposed text");
  await expect(preview).not.toContainText("Main text");
  expect(bases).toEqual([kb.headSha]);
  const proposal = () =>
    page.evaluate(
      ({ kbId }) =>
        window.__r38.orpc.pullRequests.list
          .call({ kbId, limit: 5, status: "OPEN" })
          .then((page) => page.items[0] ?? null),
      { kbId: kb.id },
    );
  const before = await proposal();
  await confirmDelete(page);
  // This update starts from main, so its receipt is announced by the app's
  // real toast host, independently of the editor's inline outcome notice.
  await expect(
    page
      .locator("[data-sileo-toast]")
      .getByText(enKb.outcome.proposedTitle.replace("{{number}}", String(before?.number)), {
        exact: true,
      }),
  ).toBeVisible();
  // The second confirmation went to the proposal head and updated it.
  await expect.poll(() => bases.length).toBe(2);
  expect(bases[1]).toBe(before?.headSha);
  await expect.poll(async () => (await proposal())?.version).toBe((before?.version ?? 0) + 1);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect((await read(page, kb.id)).markdown).toBe("Main text");
});

test("P3 delete after a concurrent edit re-reads, asks again and deletes the latest", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page, "Version A");
  await go(page, readAt(kb.id));
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Version A");
  const bases = watchDeletes(page);
  const remote = await page.evaluate(
    async ({ kbId, baseRevision, path }) => {
      const { orpc } = window.__r38;
      const result = await orpc.documents.update.call({
        kbId,
        baseRevision,
        path,
        content: { markdown: "Version B" },
        idempotencyKey: crypto.randomUUID(),
      });
      return window.__r38.parseApplyResult(result);
    },
    { kbId: kb.id, baseRevision: kb.headSha!, path: docPath },
  );
  await page.getByRole("button", { name: enKb.editor.delete, exact: true }).click();
  await confirmDelete(page);
  // Nothing was deleted: the dialog shows the reported head and asks again.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`revision ${remote.commitSha.slice(0, 12)}`);
  const preview = dialog.getByTestId("revision-preview");
  await expect(preview).toHaveAttribute("data-rev", remote.commitSha);
  await expect(preview).toContainText("Version B");
  expect((await read(page, kb.id)).markdown).toBe("Version B");
  await confirmDelete(page);
  await expect(page).toHaveURL(new RegExp(`/kbs/${kb.id}$`));
  expect(bases).toEqual([kb.headSha, remote.commitSha]);
  await expect(read(page, kb.id)).rejects.toThrow();
});

test("P3 a failed re-read of the reported head keeps delete disabled until Retry succeeds", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page, "Version A");
  await go(page, readAt(kb.id));
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Version A");
  const bases = watchDeletes(page);
  const remote = await page.evaluate(
    async ({ kbId, baseRevision, path }) =>
      window.__r38.parseApplyResult(
        await window.__r38.orpc.documents.update.call({
          kbId,
          baseRevision,
          path,
          content: { markdown: "Unseen version B" },
          idempotencyKey: crypto.randomUUID(),
        }),
      ),
    { kbId: kb.id, baseRevision: kb.headSha!, path: docPath },
  );
  // Every read of the exact reported head fails until the spec lifts it.
  let failing = true;
  await page.route("**/rpc**", async (route) => {
    const request = route.request();
    const text = `${decodeURIComponent(request.url())} ${request.postData() ?? ""}`;
    if (failing && isCall(request, "documents", "get") && text.includes(remote.commitSha))
      return route.abort("failed");
    return route.continue();
  });
  await page.getByRole("button", { name: enKb.editor.delete, exact: true }).click();
  await confirmDelete(page);
  const dialog = page.getByRole("alertdialog");
  const preview = dialog.getByTestId("revision-preview");
  await expect(preview).toHaveAttribute("data-state", "error");
  await expect(preview).not.toContainText("Unseen version B");
  await dialog.getByPlaceholder("DELETE").fill("DELETE");
  await expect(
    dialog.getByRole("button", { name: enCommon.actions.delete, exact: true }),
  ).toBeDisabled();
  expect(bases).toEqual([kb.headSha]);
  failing = false;
  // Keyboard activation: the harness loads no app CSS, so the backdrop would take a click.
  await preview.getByRole("button", { name: enCommon.actions.tryAgain }).press("Enter");
  await expect(preview).toHaveAttribute("data-state", "ready");
  await expect(preview).toContainText("Unseen version B");
  await confirmDelete(page);
  await expect(page).toHaveURL(new RegExp(`/kbs/${kb.id}$`));
  expect(bases).toEqual([kb.headSha, remote.commitSha]);
});

for (const sibling of [true, false])
  test(`R5 refuses leading-space paths without changing main or a sibling (sibling ${sibling ? "present" : "absent"})`, async ({
    page,
  }) => {
    const spaced = " notes/spaced.md";
    const plain = "notes/spaced.md";
    await boot(page);
    const kb = await createKb(page);
    const write = (path: string, text: string) =>
      page.evaluate(
        async ({ kbId, path, text }) => {
          const { orpc, parseApplyResult } = window.__r38;
          const head = (await orpc.kbs.get.call({ kbId }))!.kb.headSha!;
          return parseApplyResult(
            await orpc.documents.create.call({
              kbId,
              baseRevision: head,
              path,
              content: { markdown: text },
              idempotencyKey: crypto.randomUUID(),
            }),
          );
        },
        { kbId: kb.id, path, text },
      );
    const before = sibling ? (await write(plain, "Unchanged sibling")).commitSha : kb.headSha;
    // Existing paths are never trimmed into another document. This path now
    // fails admission before either a create or a read can target a sibling.
    await expect(write(spaced, "Refused document")).rejects.toThrow(/portable/);
    await expect(read(page, kb.id, spaced)).rejects.toThrow("Invalid path");
    expect(
      await page.evaluate(
        async (kbId) => (await window.__r38.orpc.kbs.get.call({ kbId })).kb.headSha,
        kb.id,
      ),
    ).toBe(before);
    if (sibling) expect((await read(page, kb.id, plain)).markdown).toBe("Unchanged sibling");
    else await expect(read(page, kb.id, plain)).rejects.toThrow();
  });

for (const failed of [false, true])
  test(`F4 retired create ${failed ? "failure" : "success"} preserves reopened intent`, async ({
    page,
  }) => {
    await boot(page);
    if (failed)
      await page.evaluate(() =>
        window.__r38.orpc.kbs.create.call({
          name: "Taken",
          slug: "r38-taken",
          description: "Existing KB for collision",
          idempotencyKey: crypto.randomUUID(),
        }),
      );
    const hold = await holdOnce(page, "kbs", "create");
    await page.getByRole("button", { name: enKb.list.create, exact: true }).click();
    await fillCreate(page, "A");
    if (failed)
      await page
        .getByRole("dialog")
        .getByLabel(enKb.create.slug, { exact: true })
        .fill("r38-taken");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: enKb.create.submit, exact: true })
      .press("Enter");
    await hold.handled;
    await page
      .getByRole("dialog")
      .getByRole("button", { name: enCommon.actions.cancel, exact: true })
      .press("Enter");
    await page.getByRole("button", { name: enKb.list.create, exact: true }).click();
    await fillCreate(page, "B");
    await hold.release();
    await mutationsSettled(page);
    await expect(
      page.getByRole("dialog").getByLabel(enKb.create.name, { exact: true }),
    ).toHaveValue("Intent B");
    await expect(
      page.getByRole("dialog").getByText(enKb.create.error, { exact: true }),
    ).toHaveCount(0);
    await expect(page).toHaveURL(/\/en-US\/kbs$/);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: enKb.create.submit, exact: true })
      .press("Enter");
    await expect(page.getByRole("heading", { name: "Intent B", exact: true })).toBeVisible();
  });

for (const failed of [false, true])
  test(`F4 retired metadata ${failed ? "conflict" : "success"} preserves reopened draft`, async ({
    page,
  }) => {
    await boot(page);
    const kb = await createKb(page);
    await go(page, at(kb.id));
    await page.getByTestId("kb-edit").click();
    if (failed)
      await page.evaluate(
        ({ kbId, metadataVersion }) =>
          window.__r38.orpc.kbs.update.call({
            kbId,
            metadataVersion,
            name: "Remote C",
            idempotencyKey: crypto.randomUUID(),
          }),
        { kbId: kb.id, metadataVersion: kb.metadataVersion },
      );
    const hold = await holdOnce(page, "kbs", "update");
    await page
      .getByRole("dialog")
      .getByLabel(enKb.create.name, { exact: true })
      .fill("A pending metadata");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: enKb.manage.save, exact: true })
      .press("Enter");
    await hold.handled;
    await page.keyboard.press("Escape");
    await page.getByTestId("kb-edit").click();
    await page
      .getByRole("dialog")
      .getByLabel(enKb.create.name, { exact: true })
      .fill("B new metadata draft");
    await hold.release();
    await mutationsSettled(page);
    await expect(
      page.getByRole("dialog").getByLabel(enKb.create.name, { exact: true }),
    ).toHaveValue("B new metadata draft");
    await expect(
      page.getByRole("dialog").getByText(enKb.manage.conflict, { exact: true }),
    ).toHaveCount(0);
  });

for (const failed of [false, true])
  test(`F4 retired KB delete ${failed ? "conflict" : "success"} cannot close successor overlay or navigate`, async ({
    page,
  }) => {
    await boot(page);
    const a = await createKb(page);
    const b = await createKb(page);
    await prime(page, b.id);
    await go(page, at(a.id));
    await page.getByTestId("kb-delete").click();
    const hold = await holdOnce(page, "kbs", "delete");
    if (failed)
      await page.evaluate(
        ({ kbId, metadataVersion }) =>
          window.__r38.orpc.kbs.update.call({
            kbId,
            metadataVersion,
            name: "Changed A",
            idempotencyKey: crypto.randomUUID(),
          }),
        { kbId: a.id, metadataVersion: a.metadataVersion },
      );
    await page.getByRole("alertdialog").getByPlaceholder("DELETE").fill("DELETE");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: enCommon.actions.delete, exact: true })
      .press("Enter");
    await hold.handled;
    await go(page, at(b.id));
    await page.getByTestId("kb-delete").click();
    await hold.release();
    await mutationsSettled(page);
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/kbs/${b.id}$`));
  });

for (const [root, operation] of [
  ["kbUploads", "begin"],
  ["kbUploads", "write"],
  ["kbUploads", "finish"],
  ["documents", "update"],
  ["documents", "create"],
]) {
  test(`F5 staged retry after lost ${root}.${operation} acknowledgement recovers exact receipt`, async ({
    page,
  }) => {
    await boot(page);
    const creating = root === "documents" && operation === "create";
    const kb = await createKb(page, creating ? undefined : "Original");
    await go(page, at(kb.id, creating ? "" : docPath));
    if (creating) await page.getByLabel(enKb.editor.pathLabel, { exact: true }).fill(docPath);
    // Only the lost-write case needs multiple chunks; other faults use the
    // smallest useful staged payload to keep shared-host I/O low.
    const big = "Large text ".repeat(
      root === "kbUploads" && operation === "write" ? 20_000 : 12_000,
    );
    await markdown(page).fill(big);
    const calls = await dropOnce(page, root!, operation!);
    await save(page).click();
    await expect(page.getByText(enKb.editor.retryable, { exact: true })).toBeVisible();
    if (root === "documents") {
      expect((await read(page, kb.id)).markdown).toBe(big);
      // Receipt lookup must also precede expiry checks on consumed uploads.
      expect(
        (await page.request.post(`${fx.origin}/fixture/editor/expire-upload?kbId=${kb.id}`)).ok(),
      ).toBe(true);
    }
    await save(page).click();
    await expect(page.getByText(enKb.outcome.appliedTitle, { exact: true })).toBeVisible();
    expect((await read(page, kb.id)).markdown).toBe(big);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toBe(calls[1]);
    await markdown(page).fill("A new operation after receipt");
    await save(page).click();
    await expect(save(page)).toBeEnabled();
    expect((await read(page, kb.id)).markdown === "A new operation after receipt").toBe(true);
  });
}

test("F5 expired preparation is rejected and a fresh attempt stages anew", async ({ page }) => {
  await boot(page);
  const kb = await createKb(page, "Original");
  await go(page, at(kb.id, docPath));
  const big = "Expiry text ".repeat(12_000);
  await markdown(page).fill(big);
  await dropOnce(page, "kbUploads", "finish");
  await save(page).click();
  await expect(page.getByText(enKb.editor.retryable, { exact: true })).toBeVisible();
  expect(
    (await page.request.post(`${fx.origin}/fixture/editor/expire-upload?kbId=${kb.id}`)).ok(),
  ).toBe(true);
  await save(page).click();
  await expect(page.getByText(enKb.editor.rejected, { exact: true })).toBeVisible();
  expect((await read(page, kb.id)).markdown).toBe("Original");
  await save(page).click();
  await expect(page.getByText(enKb.outcome.appliedTitle, { exact: true })).toBeVisible();
  expect((await read(page, kb.id)).markdown).toBe(big);
});

for (const structured of [false, true])
  test(`F3/F8 ${structured ? "structured" : "hybrid"} denial after cached success clears real KB query keys`, async ({
    page,
  }) => {
    await boot(page);
    const a = await createKb(page, "PRIVATE cached document");
    const b = await createKb(page, "Other KB retained");
    expect((await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${a.id}`)).ok()).toBe(
      true,
    );
    await prime(page, b.id, true);
    await as(page, "manager");
    await go(page, at(a.id));
    await prime(page, a.id, true);
    await page.evaluate(async (kbId) => {
      const { queryClient, orpc } = window.__r38;
      await queryClient.fetchQuery(orpc.kbMirror.status.queryOptions({ input: { kbId } }));
      await queryClient.fetchQuery(orpc.embeddingProviders.listMine.queryOptions({ input: {} }));
    }, a.id);
    const label = structured ? enKb.search.typeLabel : enKb.search.queryLabel;
    await page.getByLabel(label, { exact: true }).fill("private-query");
    // A prior success in this exact real key then a denied refetch must trigger
    // the check even though TanStack retains successful data on refetch errors.
    await page.evaluate(
      ({ kbId, structured }) => {
        const { queryClient, orpc } = window.__r38;
        const meta = {
          freshness: "current" as const,
          generationId: "a".repeat(24),
          indexedCommitSha: "1".repeat(40),
          headSha: "1".repeat(40),
          indexNotices: [],
        };
        if (structured) {
          const options = orpc.search.structured.infiniteOptions({
            input: (cursor: string | null) => ({ kbId, type: "private-query", limit: 20, cursor }),
            initialPageParam: null,
            getNextPageParam: (last) => last.nextCursor,
          });
          queryClient.setQueryData(options.queryKey, {
            pages: [{ ...meta, items: [], nextCursor: null }],
            pageParams: [null],
          });
        } else {
          queryClient.setQueryData(
            orpc.search.hybrid.queryOptions({ input: { kbId, query: "private-query" } }).queryKey,
            { ...meta, generationId: "a".repeat(24), results: [] },
          );
        }
      },
      { kbId: a.id, structured },
    );
    await page.getByLabel(label, { exact: true }).press("Enter");
    await expect(page.getByText(enKb.search.noResults, { exact: true })).toBeVisible();
    await as(page, "owner");
    await page.evaluate(
      ({ kbId, shareUserId }) => window.__r38.orpc.kbs.shareRevoke.call({ kbId, shareUserId }),
      { kbId: a.id, shareUserId: actors.managerUserId },
    );
    await as(page, "manager");
    await page.evaluate(
      async ({ kbId, structured }) => {
        const { queryClient } = window.__r38;
        await queryClient.refetchQueries({
          predicate: (q) =>
            Array.isArray(q.queryKey[0]) &&
            q.queryKey[0][0] === "search" &&
            q.queryKey[0][1] === (structured ? "structured" : "hybrid") &&
            JSON.stringify(q.queryKey).includes(kbId),
        });
      },
      { kbId: a.id, structured },
    );
    await expect(page.getByText(enKb.detail.unavailable, { exact: true })).toBeVisible();
    const cache = await page.evaluate(() =>
      window.__r38.queryClient
        .getQueryCache()
        .getAll()
        .map((q) => ({ key: q.queryKey, data: q.state.data })),
    );
    expect(JSON.stringify(cache)).not.toContain("PRIVATE cached document");
    expect(
      cache.filter((q) => JSON.stringify(q.key).includes(a.id)).every((q) => q.data === undefined),
    ).toBe(true);
    expect(JSON.stringify(cache)).toContain("Other KB retained");
    expect(JSON.stringify(cache)).toContain("embeddingProviders");
  });

test("F8 confirmed tombstone evicts actual mirror keys; refused owner action retains them", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page, "Readable cached document");
  expect((await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}`)).ok()).toBe(
    true,
  );
  await as(page, "manager");
  await prime(page, kb.id, true);
  await page.evaluate(async (kbId) => {
    const { queryClient, orpc, recheckKbAccess } = window.__r38;
    await queryClient.fetchQuery(orpc.kbMirror.status.queryOptions({ input: { kbId } }));
    const kb = window.__r38.kbAttachmentSchema.parse((await orpc.kbs.get.call({ kbId }))?.kb);
    let denied = false;
    try {
      await orpc.kbs.delete.call({
        kbId,
        metadataVersion: kb.metadataVersion,
        confirm: "DELETE",
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "FORBIDDEN")
        throw error;
      denied = true;
    }
    if (!denied) throw new Error("manager delete unexpectedly succeeded");
    if ((await recheckKbAccess(queryClient, kbId)) !== "kept")
      throw new Error("read-retaining refusal evicted KB");
    if (!queryClient.getQueryData(orpc.kbMirror.status.queryOptions({ input: { kbId } }).queryKey))
      throw new Error("mirror removed after action refusal");
  }, kb.id);
  await as(page, "owner");
  await page.evaluate(
    ({ kbId, metadataVersion }) =>
      window.__r38.orpc.kbs.delete.call({
        kbId,
        metadataVersion,
        confirm: "DELETE",
        idempotencyKey: crypto.randomUUID(),
      }),
    { kbId: kb.id, metadataVersion: kb.metadataVersion },
  );
  await as(page, "manager");
  const result = await page.evaluate(async (kbId) => {
    const { queryClient, orpc, recheckKbAccess } = window.__r38;
    const loss = await recheckKbAccess(queryClient, kbId);
    return {
      loss,
      mirror: queryClient.getQueryData(
        orpc.kbMirror.status.queryOptions({ input: { kbId } }).queryKey,
      ),
    };
  }, kb.id);
  expect(result).toEqual({ loss: "lost", mirror: undefined });
});

test("F3 index unavailable retains readable private cache", async ({ page }) => {
  await boot(page);
  const kb = await createKb(page, "Keep cached document");
  await prime(page, kb.id, true);
  await go(page, at(kb.id));
  await page.getByLabel(enKb.search.queryLabel, { exact: true }).fill("search");
  await page.getByLabel(enKb.search.queryLabel, { exact: true }).press("Enter");
  await expect(page.getByText(enKb.search.indexUnavailable, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      ({ kbId, path }) => {
        const { queryClient, orpc } = window.__r38;
        return queryClient.getQueryData(
          orpc.documents.get.queryOptions({ input: { kbId, path } }).queryKey,
        )?.markdown;
      },
      { kbId: kb.id, path: docPath },
    ),
  ).toBe("Keep cached document");
});

test("F6/F7 scalar validation permits complete astral filters and rejects invalid fields before RPC", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page);
  await go(page, at(kb.id));
  const calls: string[] = [];
  page.on("request", (r) => {
    if (isCall(r, "search", "hybrid") || isCall(r, "search", "structured"))
      calls.push(r.postData() ?? r.url());
  });
  for (const [label, bound, message] of [
    [enKb.search.queryLabel, 1024, enKb.search.queryInvalid],
    [enKb.search.typeLabel, 256, enKb.search.typeInvalid],
    [enKb.search.titleLabel, 256, enKb.search.titleInvalid],
    [enKb.search.tagsLabel, 64, enKb.search.tagsInvalid],
  ] as const) {
    for (const clear of [
      enKb.search.queryLabel,
      enKb.search.typeLabel,
      enKb.search.titleLabel,
      enKb.search.tagsLabel,
    ])
      await page.getByLabel(clear, { exact: true }).fill("");
    const field = page.getByLabel(label, { exact: true });
    const valid = "🧭".repeat(bound);
    await field.focus();
    await page.keyboard.insertText(valid);
    await expect(field).toHaveValue(valid);
    const before = calls.length;
    await field.press("Enter");
    await expect.poll(() => calls.length).toBe(before + 1);
    await expect(page.getByText(enKb.search.indexUnavailable, { exact: true })).toBeVisible();
    await field.fill("🧭".repeat(bound - 1) + "ab");
    await field.press("Enter");
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    expect(calls).toHaveLength(before + 1);
  }
  await page.getByLabel(enKb.search.tagsLabel, { exact: true }).fill("x".repeat(65));
  await page.getByLabel(enKb.search.tagsLabel, { exact: true }).press("Enter");
  await expect(page.getByText(enKb.search.tagsInvalid, { exact: true })).toBeVisible();
  const before = calls.length;
  await page
    .getByLabel(enKb.search.tagsLabel, { exact: true })
    .fill(Array.from({ length: 17 }, (_, i) => `t${i}`).join(","));
  await page.getByLabel(enKb.search.tagsLabel, { exact: true }).press("Enter");
  await expect(page.getByText(enKb.search.tagsInvalid, { exact: true })).toBeVisible();
  expect(calls).toHaveLength(before);
});

test("F4 create completion rechecks ownership after awaited list invalidation", async ({
  page,
}) => {
  await boot(page);
  await page.getByRole("button", { name: enKb.list.create, exact: true }).click();
  await fillCreate(page, "A");
  const hold = await holdOnce(page, "kbs", "list");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enKb.create.submit, exact: true })
    .press("Enter");
  await hold.handled;
  await page
    .getByRole("dialog")
    .getByRole("button", { name: enCommon.actions.cancel, exact: true })
    .press("Enter");
  await page.getByRole("button", { name: enKb.list.create, exact: true }).click();
  await fillCreate(page, "B after invalidation");
  await hold.release();
  await mutationsSettled(page);
  await expect(page.getByRole("dialog").getByLabel(enKb.create.name, { exact: true })).toHaveValue(
    "Intent B after invalidation",
  );
  await expect(page).toHaveURL(/\/en-US\/kbs$/);
});

test("F5 staged receipt replay rechecks live authority after revocation", async ({ page }) => {
  await boot(page);
  const kb = await createKb(page, "Writer original");
  expect(
    (await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}&writer=1`)).ok(),
  ).toBe(true);
  await as(page, "manager");
  await go(page, at(kb.id, docPath));
  const big = "Private staged writer text ".repeat(5_100);
  await markdown(page).fill(big);
  const calls = await dropOnce(page, "documents", "update");
  await save(page).click();
  await expect(page.getByText(enKb.editor.retryable, { exact: true })).toBeVisible();
  expect((await read(page, kb.id)).markdown).toBe(big);
  await as(page, "owner");
  await page.evaluate(
    ({ kbId, shareUserId }) => window.__r38.orpc.kbs.shareRevoke.call({ kbId, shareUserId }),
    { kbId: kb.id, shareUserId: actors.managerUserId },
  );
  await as(page, "manager");
  await save(page).click();
  await expect(page.getByText(enKb.detail.unavailable, { exact: true })).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toBe(calls[1]);
  await expect(page.getByText(enKb.outcome.appliedTitle, { exact: true })).toHaveCount(0);
});

test("F6 rejects overlong and excess tags without silently changing filters or sending RPC", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page);
  await go(page, at(kb.id));
  const calls: string[] = [];
  page.on("request", (request) => {
    if (isCall(request, "search", "structured")) calls.push(request.postData() ?? request.url());
  });
  const tags = page.getByLabel(enKb.search.tagsLabel, { exact: true });
  for (const invalid of ["x".repeat(65), Array.from({ length: 17 }, (_, i) => `t${i}`).join(",")]) {
    await tags.fill(invalid);
    await tags.press("Enter");
    await expect(page.getByText(enKb.search.tagsInvalid, { exact: true })).toBeVisible();
    await expect(tags).toHaveValue(invalid);
    expect(calls).toHaveLength(0);
  }
  const valid = Array.from({ length: 16 }, (_, i) => `t${i}`).join(",");
  await tags.fill(`${valid},t0`);
  await tags.press("Enter");
  await expect.poll(() => calls.length).toBe(1);
  await expect(page.getByText(enKb.search.indexUnavailable, { exact: true })).toBeVisible();
});

for (const earlier of ["success", "denial"] as const) {
  test(`R46r3 F2 fresh access admission ignores an older delayed ${earlier}`, async ({ page }) => {
    await boot(page);
    const kb = await createKb(page, "F2 private cached document");
    expect((await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}`)).ok()).toBe(
      true,
    );
    await as(page, "manager");
    await prime(page, kb.id, true);
    const revoke = async () => {
      await as(page, "owner");
      await page.evaluate(
        ({ kbId, shareUserId }) => window.__r38.orpc.kbs.shareRevoke.call({ kbId, shareUserId }),
        { kbId: kb.id, shareUserId: actors.managerUserId },
      );
      await as(page, "manager");
    };
    if (earlier === "denial") await revoke();
    const held = await holdOnce(page, "kbs", "get");
    let reads = 0;
    page.on("request", (request) => {
      if (isCall(request, "kbs", "get")) reads++;
    });
    await page.evaluate((kbId) => {
      const { orpc, queryClient } = window.__r38;
      // Keep a raw subscriber too: Query cancellation cannot simply erase
      // the older transport request and accidentally hide transport dedupe.
      void orpc.kbs.get.call({ kbId }).catch(() => undefined);
      void queryClient
        .fetchQuery({ ...orpc.kbs.get.queryOptions({ input: { kbId } }), staleTime: 0 })
        .catch(() => undefined);
    }, kb.id);
    await held.handled;
    if (earlier === "success") {
      await revoke();
    } else {
      await as(page, "owner");
      const invitation = await page.evaluate(
        ({ kbId, email }) =>
          window.__r38.orpc.kbs.shareInvite.call({
            kbId,
            email,
            permissions: ["manage"],
            idempotencyKey: crypto.randomUUID(),
          }),
        { kbId: kb.id, email: actors.managerEmail! },
      );
      await as(page, "manager");
      await page.evaluate(
        (requestId) => window.__r38.orpc.kbs.shareAccept.call({ requestId }),
        invitation.requestId,
      );
    }
    const result = await page.evaluate(
      async ({ kbId, docPath, earlier, metadataVersion }) => {
        const { orpc, queryClient, recheckKbAccess } = window.__r38;
        // A real post-change action denial precedes the access check.
        let code: unknown;
        try {
          if (earlier === "success") await orpc.documents.get.call({ kbId, path: docPath });
          else {
            await orpc.kbs.delete.call({
              kbId,
              metadataVersion,
              confirm: "DELETE",
              idempotencyKey: crypto.randomUUID(),
            });
          }
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        if (code !== (earlier === "success" ? "NOT_FOUND" : "FORBIDDEN"))
          throw new Error(`Expected real denial, got ${code}`);
        const outcome = await Promise.race([
          recheckKbAccess(queryClient, kbId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Fresh check joined a held older response")), 8_000),
          ),
        ]);
        return {
          outcome,
          cached: queryClient.getQueryData(
            orpc.documents.get.queryOptions({ input: { kbId, path: docPath } }).queryKey,
          ),
        };
      },
      { kbId: kb.id, docPath, earlier, metadataVersion: kb.metadataVersion },
    );
    // The fresh decision must settle BEFORE we release the pre-change response.
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(result.outcome).toBe(earlier === "success" ? "lost" : "kept");
    if (earlier === "success") expect(result.cached).toBeUndefined();
    else expect(JSON.stringify(result.cached)).toContain("F2 private cached document");
    await held.release();
    const cached = await page.evaluate(
      ({ kbId, docPath }) => {
        const { orpc, queryClient } = window.__r38;
        return {
          kb: queryClient.getQueryData(orpc.kbs.get.queryOptions({ input: { kbId } }).queryKey),
          doc: queryClient.getQueryData(
            orpc.documents.get.queryOptions({ input: { kbId, path: docPath } }).queryKey,
          ),
        };
      },
      { kbId: kb.id, docPath },
    );
    if (earlier === "success") expect(cached).toEqual({ kb: undefined, doc: undefined });
    else expect(JSON.stringify(cached)).toContain("F2 private cached document");
  });
}

async function accessPr(page: Page) {
  actors = {
    cookies: { owner: s.cookies.owner, manager: fx.pr.cookies.reviewer },
    managerUserId: "",
  };
  await as(page, "owner");
  const res = await page.request.post(`${fx.origin}/fixture/pr-case`);
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as {
    pr: { kbId: string; number: number; baseSha: string; headSha: string };
    reviewerUserId: string;
    reviewerEmail: string;
    reviewerCookie: string;
  };
  actors.cookies.manager = data.reviewerCookie;
  actors.managerUserId = data.reviewerUserId;
  actors.managerEmail = data.reviewerEmail;
  await as(page, "manager");
  const href = `/en-US/kbs/${data.pr.kbId}/prs/${data.pr.number}`;
  await page.goto(`${fx.origin}/r38?${new URLSearchParams({ start: href })}`);
  await expect(page.getByTestId("pr-review")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("pr-after").first()).toContainText("Private after 0");
  await expect(page.getByTestId("pr-before").first()).toContainText("Private before 0");
  await expect(page.getByTestId("pr-before")).toHaveCount(10);
  await expect(page.getByTestId("pr-after")).toHaveCount(10);
  return data.pr;
}
async function revokePrAccess(page: Page, kbId: string, retainRead = false) {
  await as(page, "owner");
  if (retainRead) {
    const invitation = await page.evaluate(
      ({ kbId, email }) =>
        window.__r38.orpc.kbs.shareInvite.call({
          kbId,
          email,
          permissions: ["read"],
          idempotencyKey: crypto.randomUUID(),
        }),
      { kbId, email: actors.managerEmail! },
    );
    await as(page, "manager");
    await page.evaluate(
      (requestId) => window.__r38.orpc.kbs.shareAccept.call({ requestId }),
      invitation.requestId,
    );
  } else {
    await page.evaluate(
      ({ kbId, shareUserId }) => window.__r38.orpc.kbs.shareRevoke.call({ kbId, shareUserId }),
      { kbId, shareUserId: actors.managerUserId },
    );
    await as(page, "manager");
  }
}
async function assertPrivatePrForgotten(page: Page, kbId: string) {
  await expect(page.getByText(enKb.detail.unavailable, { exact: true })).toBeVisible();
  await expect(page.getByTestId("pr-review")).toHaveCount(0);
  const data = await page.evaluate(
    (kbId) =>
      window.__r38.queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => JSON.stringify(q.queryKey).includes(kbId))
        .map((q) => q.state.data),
    kbId,
  );
  expect(data.every((value) => value === undefined)).toBe(true);
}
for (const decision of ["merge", "close"] as const) {
  for (const retainRead of [false, true]) {
    test(`R46r3 F3 ${decision} denial ${retainRead ? "retains readable" : "forgets revoked"} PR content`, async ({
      page,
    }) => {
      const pr = await accessPr(page);
      await revokePrAccess(page, pr.kbId, retainRead);
      let rechecks = 0;
      page.on("request", (req) => {
        if (isCall(req, "kbs", "get")) rechecks++;
      });
      await page.getByTestId(`pr-${decision}`).click();
      const dialog = page.getByRole("alertdialog");
      // Closing is a plain confirmation (R2-27); merging still types MERGE.
      if (decision === "merge") await dialog.getByPlaceholder("MERGE").fill("MERGE");
      await dialog
        .getByRole("button", {
          name: decision === "merge" ? enKb.pr.confirm.mergeAction : enKb.pr.confirm.closeAction,
        })
        .press("Enter");
      if (retainRead) {
        await expect(page.getByTestId("pr-outcome")).toHaveAttribute("data-kind", "forbidden");
        await expect.poll(() => rechecks).toBeGreaterThan(0);
        await expect(page.getByTestId("pr-after").first()).toContainText("Private after 0");
        const cache = await page.evaluate(
          (kbId) =>
            window.__r38.queryClient
              .getQueryCache()
              .getAll()
              .filter((q) => JSON.stringify(q.queryKey).includes(kbId))
              .map((q) => q.state.data),
          pr.kbId,
        );
        expect(JSON.stringify(cache)).toContain("Private after 0");
      } else await assertPrivatePrForgotten(page, pr.kbId);
      expect(rechecks).toBeGreaterThan(0);
    });
  }
}
for (const side of ["before", "after"] as const) {
  test(`R46r3 F3 lazy ${side} body denial forgets revoked PR content`, async ({ page }) => {
    const pr = await accessPr(page);
    await revokePrAccess(page, pr.kbId);
    // Let the sibling side load from its real pre-revocation response, so
    // the selected before/after denial independently owns the recheck.
    const opposite = side === "before" ? pr.headSha : pr.baseSha;
    await page.evaluate(
      async ({ kbId, rev }) => {
        const { queryClient, orpc } = window.__r38;
        // Existing cached immutable bytes from a loaded card, with the selected
        // lazy-card key. The denied side still calls the real document router.
        const cached = queryClient.getQueryData<
          Awaited<ReturnType<typeof orpc.documents.get.call>>
        >(orpc.documents.get.queryOptions({ input: { kbId, path: "notes/00.md", rev } }).queryKey);
        queryClient.setQueryData(
          orpc.documents.get.queryOptions({ input: { kbId, path: "notes/10.md", rev } }).queryKey,
          cached,
        );
      },
      { kbId: pr.kbId, rev: opposite },
    );
    const lazy = page.locator('[data-testid="pr-file"][data-path="notes/10.md"]');
    await lazy.getByRole("button", { name: enKb.pr.files.render }).click();
    await assertPrivatePrForgotten(page, pr.kbId);
  });
}

test("R46r3 F3 missing lazy document retains a still-readable PR and cached bodies", async ({
  page,
}) => {
  const pr = await accessPr(page);
  let rechecks = 0;
  page.on("request", (req) => {
    if (isCall(req, "kbs", "get")) rechecks++;
  });
  await page.route("**/rpc**", async (route) => {
    const req = route.request();
    if (!isCall(req, "documents", "get")) return route.continue();
    // Ask the real router for a missing file in the same readable KB.
    // Its real NOT_FOUND response travels through the production card hook.
    const url = new URL(req.url());
    for (const [name, value] of url.searchParams)
      url.searchParams.set(name, value.replaceAll("notes/10.md", "notes/missing.md"));
    await route.continue({
      url: url.href,
      ...(req.postData()
        ? { postData: req.postData()!.replaceAll("notes/10.md", "notes/missing.md") }
        : {}),
    });
  });
  await page
    .locator('[data-testid="pr-file"][data-path="notes/10.md"]')
    .getByRole("button", { name: enKb.pr.files.render })
    .click();
  await expect(page.locator('[data-testid="pr-file"][data-path="notes/10.md"]')).toContainText(
    enKb.pr.files.loadFailed,
  );
  await expect(page.getByTestId("pr-after").first()).toContainText("Private after 0");
  // A missing path at a readable revision (PATH_NOT_FOUND) is that file's
  // state, never a denial: nothing re-checks KB access over it. A recheck
  // starts from the failed read, so assert only once every fetch settled.
  await expect
    .poll(() => page.evaluate(() => window.__r38.queryClient.isFetching()), { timeout: 15_000 })
    .toBe(0);
  expect(rechecks).toBe(0);
  const cached = await page.evaluate(
    (kbId) =>
      window.__r38.queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => JSON.stringify(q.queryKey).includes(kbId))
        .map((q) => q.state.data),
    pr.kbId,
  );
  expect(JSON.stringify(cached)).toContain("Private after 0");
});

test("R4 receipt advances a live session without discarding typing during a held save", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page, "Main text");
  expect(
    (await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}&proposer=1`)).ok(),
  ).toBe(true);
  await as(page, "manager");
  await go(page, at(kb.id, docPath));
  await expect(markdown(page)).toHaveValue("Main text");
  const held = await holdOnce(page, "documents", "update");
  await markdown(page).fill("Saved One");
  await page.getByTestId("editor-save").click();
  await held.handled;
  await markdown(page).fill("Unsaved Two");
  await held.release();
  await mutationsSettled(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("proposal")).toMatch(/^\d+$/);
  await expect(markdown(page)).toHaveValue("Unsaved Two");
  // The next write uses this same session's proposal and advanced head.
  await page.getByTestId("editor-save").click();
  await mutationsSettled(page);
  await page.getByRole("link", { name: enKb.document.doneEditing, exact: true }).click();
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Unsaved Two");
  expect((await read(page, kb.id)).markdown).toBe("Main text");
});

test("R4 a new session cannot use cached proposal bytes after New document and failed resolution", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page, "Main text");
  expect(
    (await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}&proposer=1`)).ok(),
  ).toBe(true);
  await as(page, "manager");
  await go(page, at(kb.id, docPath));
  await markdown(page).fill("Old proposal");
  await page.getByTestId("editor-save").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("proposal")).toMatch(/^\d+$/);
  await mutationsSettled(page);
  const href = new URL(page.url());
  const number = Number(href.searchParams.get("proposal"));
  await go(page, at(kb.id, ""));
  await expect(page.getByLabel(enKb.editor.pathLabel)).toBeVisible();
  await page.evaluate(
    async ({ kbId, number, path }) => {
      const { orpc } = window.__r38;
      const pr = (await orpc.pullRequests.get.call({ kbId, number })).pr;
      await orpc.documents.update.call({
        kbId,
        path,
        baseRevision: pr.headSha,
        proposalNumber: number,
        proposalHeadSha: pr.headSha,
        idempotencyKey: crypto.randomUUID(),
        content: { markdown: "Advanced elsewhere" },
      });
    },
    { kbId: kb.id, number, path: docPath },
  );
  await dropOnce(page, "pullRequests", "get");
  await go(page, href.pathname + href.search);
  await expect(page.getByText(`Couldn't load pull request #${number}.`)).toBeVisible();
  await expect(markdown(page)).toHaveCount(0);
  await page.getByRole("button", { name: enCommon.actions.tryAgain, exact: true }).click();
  await expect(markdown(page)).toHaveValue("Advanced elsewhere");
});

for (const write of ["text", "image"] as const)
  for (const refresh of ["proposal", "document", "main"] as const)
    test(`R4 ${write} receipt keeps the draft but exposes no stale bytes after failed ${refresh} refresh`, async ({
      page,
    }) => {
      await boot(page);
      const kb = await createKb(page, "ORIGINAL MAIN");
      if (refresh !== "main") {
        expect(
          (
            await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}&proposer=1`)
          ).ok(),
        ).toBe(true);
        await as(page, "manager");
      }
      await go(page, at(kb.id, docPath));
      await expect(markdown(page)).toHaveValue("ORIGINAL MAIN");
      // Document failures on a later proposal head also must not expose a
      // previous proposal revision as a fallback.
      if (refresh === "document") {
        await markdown(page).fill("EARLIER PROPOSAL");
        await page.getByTestId("editor-save").click();
        await mutationsSettled(page);
        // Query mutation counts reach zero before the editor finishes receipt
        // refreshes. Wait for its operation to finish before faulting the next
        // read or selecting a file through the otherwise disabled image button.
        await expect(page.getByTestId("editor-save")).toBeEnabled();
      }
      await page.route("**/rpc**", async (route) => {
        const router = refresh === "proposal" ? "pullRequests" : "documents";
        if (!isCall(route.request(), router, "get")) return route.continue();
        const response = await route.fetch();
        const error = {
          json: {
            defined: false,
            code: "INTERNAL_SERVER_ERROR",
            status: 503,
            message: "Fixture unavailable",
          },
        };
        if (!route.request().url().includes("/__batch__"))
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify(error),
          });
        // Fail only this member of the real streaming batch. Aborting the
        // HTTP request would also fail kbs.get and unmount the entire page.
        const requests = route.request().postDataJSON() as { url: string }[];
        const body = (await response.text())
          .split("\n")
          .map((line) => {
            if (!line.startsWith("data: ")) return line;
            const item = JSON.parse(line.slice(6)) as {
              index: number;
              status: number;
              body: unknown;
            };
            if (new URL(requests[item.index]!.url).pathname.endsWith(`/${router}/get`)) {
              item.status = 503;
              item.body = error;
            }
            return `data: ${JSON.stringify(item)}`;
          })
          .join("\n");
        return route.fulfill({ response, body });
      });
      await markdown(page).fill("LIVE DRAFT");
      // An image is staged, then committed by the save with the draft (R3-W7).
      if (write === "image") {
        await page.getByTestId("editor-image-input").setInputFiles({
          name: "receipt.png",
          mimeType: "image/png",
          buffer: minimalPng(),
        });
        await expect(markdown(page)).toHaveValue(/assets\/receipt-/);
      }
      await page.getByTestId("editor-save").click();
      await mutationsSettled(page);
      if (refresh !== "main")
        await expect.poll(() => new URL(page.url()).searchParams.get("proposal")).toMatch(/^\d+$/);
      await expect(
        page.getByRole("button", { name: enCommon.actions.tryAgain, exact: true }),
      ).toBeVisible();
      await expect(markdown(page)).toHaveValue(
        write === "text" ? "LIVE DRAFT" : /LIVE DRAFT[\s\S]*assets\/receipt-/,
      );
      await page.getByRole("link", { name: enKb.document.doneEditing, exact: true }).click();
      await expect(page.getByTestId("kb-rendered-document")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: enCommon.actions.tryAgain, exact: true }),
      ).toBeVisible();
      await page.unroute("**/rpc**");
      await page.getByRole("button", { name: enCommon.actions.tryAgain, exact: true }).click();
      await expect(page.getByTestId("kb-rendered-document")).toContainText("LIVE DRAFT");
      await page.getByTestId("document-edit").click();
      await expect(markdown(page)).toHaveValue(
        write === "text" ? "LIVE DRAFT" : /LIVE DRAFT[\s\S]*assets\/receipt-/,
      );
    });

test("R4 a held proposal receipt preserves Done editing selected while saving", async ({
  page,
}) => {
  await boot(page);
  const kb = await createKb(page, "ORIGINAL MAIN");
  expect(
    (await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kb.id}&proposer=1`)).ok(),
  ).toBe(true);
  await as(page, "manager");
  await go(page, at(kb.id, docPath));
  await expect(markdown(page)).toHaveValue("ORIGINAL MAIN");
  const held = await holdOnce(page, "documents", "update");
  await markdown(page).fill("SAVED PROPOSAL");
  await page.getByTestId("editor-save").click();
  await held.handled;
  await page.getByRole("link", { name: enKb.document.doneEditing, exact: true }).click();
  await expect(markdown(page)).toHaveCount(0);
  await held.release();
  await mutationsSettled(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("proposal")).toMatch(/^\d+$/);
  expect(new URL(page.url()).searchParams.has("mode")).toBe(false);
  await expect(markdown(page)).toHaveCount(0);
  await expect(page.getByTestId("kb-rendered-document")).toContainText("SAVED PROPOSAL");
});

const shareAsProposer = async (page: Page, kbId: string) =>
  expect(
    (await page.request.post(`${fx.origin}/fixture/editor/share?kbId=${kbId}&proposer=1`)).ok(),
  ).toBe(true);

for (const write of ["update", "image", "create"] as const)
  test(`R5 a held ${write} receipt cannot take navigation back from another KB's pending loader`, async ({
    page,
  }) => {
    await boot(page);
    const kbA = await createKb(page, "MAIN A");
    const kbB = await createKb(page, "MAIN B");
    await shareAsProposer(page, kbA.id);
    await shareAsProposer(page, kbB.id);
    await as(page, "manager");
    const path = write === "create" ? "notes/created-a.md" : docPath;
    if (write === "create") {
      await go(page, at(kbA.id, ""));
      await page.getByLabel(enKb.editor.pathLabel).fill(path);
    } else {
      await go(page, at(kbA.id, docPath));
      await expect(markdown(page)).toHaveValue("MAIN A");
    }
    // An image is staged and then committed by the held save (R3-W7).
    const held = await holdOnce(page, "documents", write === "create" ? "create" : "update");
    await markdown(page).fill("SAVED IN A");
    if (write === "image") {
      await page.getByTestId("editor-image-input").setInputFiles({
        name: "held.png",
        mimeType: "image/png",
        buffer: minimalPng(),
      });
      await expect(markdown(page)).toHaveValue(/assets\/held-/);
    }
    await page.getByTestId("editor-save").click();
    await held.handled;
    // The user leaves for KB B; B's layout loader (its kbs.get) is still pending.
    const loader = await holdOnce(page, "kbs", "get", (request) =>
      (request.postData() ?? request.url()).includes(kbB.id),
    );
    const leaving = go(page, at(kbB.id, docPath));
    await loader.handled;
    // A's receipt completes now: its follow-up refreshes A's KB read.
    const receiptDone = page.waitForRequest(
      (request) =>
        isCall(request, "kbs", "get") && (request.postData() ?? request.url()).includes(kbA.id),
    );
    await held.release();
    await receiptDone;
    await mutationsSettled(page);
    // A create completes (and would navigate) only after those refreshes settle.
    await expect
      .poll(() =>
        page.evaluate(
          (kbB) =>
            window.__r38.queryClient.isFetching({
              predicate: (query) => !JSON.stringify(query.queryKey).includes(kbB),
            }),
          kbB.id,
        ),
      )
      .toBe(0);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    // B's loader really is still pending while A's receipt completes.
    expect(await page.evaluate(() => window.__r38.router.state.status)).toBe("pending");
    expect(new URL(page.url()).pathname).toContain(kbB.id);
    await loader.release();
    await leaving;
    const url = new URL(page.url());
    expect(url.pathname).toContain(kbB.id);
    expect(url.searchParams.has("proposal")).toBe(false);
    await expect(markdown(page)).toHaveValue("MAIN B");
    // The receipt itself was real: A has the writer's proposal.
    const open = await page.evaluate(
      ({ kbId }) =>
        window.__r38.orpc.pullRequests.list
          .call({ kbId, limit: 5, status: "OPEN" })
          .then((page) => page.items.length),
      { kbId: kbA.id },
    );
    expect(open).toBe(1);
  });

for (const status of ["CLOSED", "MERGED"] as const)
  for (const view of ["editing", "done"] as const)
    test(`R5 a ${status} proposal shows its notice and takes no writes, keeping the draft (${view})`, async ({
      page,
    }) => {
      await boot(page);
      const kb = await createKb(page, "MAIN TEXT");
      await shareAsProposer(page, kb.id);
      await as(page, "manager");
      await go(page, at(kb.id, docPath));
      await markdown(page).fill("PROPOSED");
      await page.getByTestId("editor-save").click();
      await expect.poll(() => new URL(page.url()).searchParams.get("proposal")).toMatch(/^\d+$/);
      await mutationsSettled(page);
      await expect(page.getByTestId("editor-save")).toBeEnabled();
      const number = Number(new URL(page.url()).searchParams.get("proposal"));
      await markdown(page).fill("UNSAVED DRAFT");
      if (view === "done") {
        await page.getByRole("link", { name: enKb.document.doneEditing, exact: true }).click();
        await expect(markdown(page)).toHaveCount(0);
      }
      // Merging takes the owner's review bit; the author may close their own.
      if (status === "MERGED") await as(page, "owner");
      await page.evaluate(
        async ({ kbId, number, merge }) => {
          const { orpc } = window.__r38;
          const pr = (await orpc.pullRequests.get.call({ kbId, number })).pr;
          const kb = (await orpc.kbs.get.call({ kbId }))!.kb;
          await orpc.pullRequests.review.call({
            kbId,
            number,
            decision: merge ? "merge" : "close",
            expectedHeadSha: pr.headSha,
            expectedTargetSha: kb.headSha!,
            idempotencyKey: crypto.randomUUID(),
            confirm: merge ? "MERGE" : "CLOSE",
          });
        },
        { kbId: kb.id, number, merge: status === "MERGED" },
      );
      if (status === "MERGED") await as(page, "manager");
      await page.evaluate(() =>
        window.__r38.queryClient.invalidateQueries({
          queryKey: window.__r38.orpc.pullRequests.get.key(),
        }),
      );
      const notice = page.getByText(
        enKb.document.proposalClosed.replace("{{number}}", String(number)),
      );
      await expect(notice).toBeVisible();
      await expect(
        page.getByRole("button", { name: enKb.document.openMain, exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("document-edit")).toHaveCount(0);
      if (view === "done") {
        // Reopening the editor shows the kept draft, but nothing can save it.
        const href = new URL(page.url());
        href.searchParams.set("mode", "edit");
        await go(page, href.pathname + href.search);
      }
      await expect(markdown(page)).toHaveValue("UNSAVED DRAFT");
      await expect(page.getByTestId("editor-save")).toHaveCount(0);
      await expect(page.getByTestId("editor-insert-image")).toHaveCount(0);
      await expect(notice).toBeVisible();
      await page.getByRole("button", { name: enKb.document.openMain, exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.has("proposal")).toBe(false);
      await expect(page.getByTestId("kb-rendered-document")).toContainText(
        status === "MERGED" ? "PROPOSED" : "MAIN TEXT",
      );
    });
