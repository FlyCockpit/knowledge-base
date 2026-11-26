/** The KB workspace journey: tree → tabs → edit → save → dirty close → reload restores. */
import { randomUUID } from "node:crypto";
import enKb from "@knowledge-base/locales/src/en-US/kb.json" with { type: "json" };
import { expect, type Page, type Request, test } from "@playwright/test";
import { minimalPng } from "../../../packages/api/src/lib/kb/fixtures/media-bytes";
import type { KbBrowserFixtureData } from "../../../packages/test-utils/src/kb/browser";
import type {} from "./kb-editor.harness";

const raw = process.env.KB_BROWSER_FIXTURE;
if (!raw) throw new Error("Run through pnpm test:kb -- browser");
const fx = JSON.parse(raw) as KbBrowserFixtureData;
let actors: { cookies: { owner: string; manager: string }; ownerUserId?: string } = fx.settings;

const ALPHA = "guides/alpha.md";
const BETA = "guides/beta.md";
const README = "readme.md";

async function as(page: Page) {
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: fx.cookie.name, value: actors.cookies.owner, url: fx.origin, httpOnly: true },
    {
      name: "better-auth.session_token",
      value: actors.cookies.owner,
      url: fx.origin,
      httpOnly: true,
    },
  ]);
}

async function boot(page: Page) {
  // The workspace's layout (drawer, sticky panes, breakpoints) needs the app CSS.
  await page.addInitScript(() => window.sessionStorage.setItem("kb-harness-styled", "1"));
  await as(page);
  const response = await page.request.post(`${fx.origin}/fixture/editor/actors`);
  expect(response.ok()).toBe(true);
  actors = await response.json();
  // The protected layout's viewer (whose tabs and drafts are remembered).
  await page.addInitScript(
    (id) => window.sessionStorage.setItem("kb-harness-viewer", id),
    actors.ownerUserId ?? "",
  );
  await as(page);
  await page.goto(`${fx.origin}/kb-editor`);
  await expect(page.getByRole("button", { name: enKb.list.create, exact: true })).toBeVisible({
    timeout: 25_000,
  });
}

/** A fresh KB with three documents, made through the real routers. */
async function createKb(page: Page) {
  return page.evaluate(
    async ({ slug, docs }) => {
      const { orpc, kbAttachmentSchema } = window.__kbEditor;
      const created = await orpc.kbs.create.call({
        name: slug,
        slug,
        description: "Workspace journey KB",
        idempotencyKey: crypto.randomUUID(),
      });
      let kb = kbAttachmentSchema.parse(created.kb);
      for (const [path, markdown] of docs) {
        await orpc.documents.create.call({
          kbId: kb.id,
          baseRevision: kb.headSha!,
          path,
          content: { markdown },
          idempotencyKey: crypto.randomUUID(),
        });
        kb = kbAttachmentSchema.parse((await orpc.kbs.get.call({ kbId: kb.id }))?.kb);
      }
      return kb;
    },
    {
      slug: `workspace-${randomUUID()}`,
      docs: [
        [ALPHA, "# Alpha\n\nFirst guide.\n\n## Setup\n\nInstall it.\n"],
        [BETA, "# Beta\n\nSecond guide.\n"],
        [README, "# Read me\n\nStart here.\n"],
      ] as [string, string][],
    },
  );
}

async function go(page: Page, href: string) {
  await page.evaluate(async (href) => {
    await window.__kbEditor.router.navigate({ href });
  }, href);
}

async function serverText(page: Page, kbId: string, path: string) {
  return page.evaluate(
    async ({ kbId, path }) =>
      window.__kbEditor.documentSchema.parse(
        await window.__kbEditor.orpc.documents.get.call({ kbId, path }),
      ).markdown,
    { kbId, path },
  );
}

const mod = process.platform === "darwin" ? "Meta" : "Control";
const tree = (page: Page) => page.getByRole("tree", { name: enKb.workspace.tree.label });
const tabs = (page: Page) => page.getByRole("tablist", { name: enKb.workspace.tabs.label });
const markdown = (page: Page) => page.getByTestId("editor-markdown");

test("desktop: tree → two tabs → edit → save → discard a dirty close → reload restores", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}`);

  // The tree lists folders first; opening a folder shows its files.
  await expect(tree(page)).toBeVisible();
  await tree(page).getByRole("treeitem", { name: "guides" }).click();
  await tree(page).getByRole("treeitem", { name: "alpha.md" }).click();
  await expect(page).toHaveURL(/path=guides%2Falpha\.md/);
  await expect(page.getByTestId("kb-rendered-document")).toContainText("First guide.");
  // Keyboard: Down moves to beta.md, Enter opens it as a second tab (focus stays in the tree).
  await tree(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/path=guides%2Fbeta\.md/);
  await expect(tabs(page).getByRole("tab")).toHaveCount(2);
  await expect(tabs(page).getByRole("tab", { name: /beta\.md/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Second guide.");
  await expect(tree(page)).toBeFocused();

  // E (outside the tree, where letters find files) opens the edit view;
  // typing marks the tab unsaved; ⌘S / Ctrl+S saves.
  await page.getByTestId("kb-rendered-document").click();
  await page.locator("body").press("e");
  await expect(markdown(page)).toBeVisible();
  await markdown(page).fill("# Beta\n\nSecond guide, edited.\n");
  await expect(tabs(page).getByRole("tab", { name: /beta\.md.*unsaved changes/ })).toBeVisible();
  await markdown(page).press(`${mod}+s`);
  await expect(tabs(page).getByRole("tab", { name: /unsaved changes/ })).toHaveCount(0);
  expect(await serverText(page, kb.id, BETA)).toContain("Second guide, edited.");

  // A dirty close asks; Discard closes without saving.
  await markdown(page).fill("# Beta\n\nThis must not be saved.\n");
  await tabs(page)
    .getByRole("button", { name: enKb.workspace.tabs.close.replace("{{name}}", "beta.md") })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("beta.md");
  await dialog.getByRole("button", { name: enKb.workspace.dirtyClose.discard }).click();
  await expect(tabs(page).getByRole("tab")).toHaveCount(1);
  await expect(page).toHaveURL(/path=guides%2Falpha\.md/);
  expect(await serverText(page, kb.id, BETA)).toContain("Second guide, edited.");
  expect(await serverText(page, kb.id, BETA)).not.toContain("must not be saved");

  // Open readme too, then reload: the strip and the active tab come back.
  await tree(page).getByRole("treeitem", { name: README }).click();
  await expect(tabs(page).getByRole("tab")).toHaveCount(2);
  await page.reload();
  await expect(tabs(page).getByRole("tab")).toHaveCount(2, { timeout: 25_000 });
  await expect(tabs(page).getByRole("tab", { name: README })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(tabs(page).getByRole("tab", { name: "alpha.md" })).toBeVisible();
});

test("phone: drawer → read → edit → save → back → recent files", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}`);

  // No tab strip on a phone: the files live in a drawer.
  await expect(tabs(page)).toHaveCount(0);
  await page.getByRole("button", { name: enKb.workspace.shell.files, exact: true }).click();
  await tree(page).getByRole("treeitem", { name: README }).click();
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Start here.");
  await expect(tree(page)).toHaveCount(0);

  // The toolbar fits a phone: its controls don't overlap.
  const boxes = await page
    .getByTestId("kb-workspace-toolbar")
    .locator(":scope > button, :scope > div > button, :scope > button[data-testid]")
    .evaluateAll((els) =>
      els
        .map((el) => el.getBoundingClientRect().toJSON() as DOMRect)
        .filter((box) => box.width > 0),
    );
  for (let i = 1; i < boxes.length; i++)
    expect(boxes[i]!.left).toBeGreaterThanOrEqual(boxes[i - 1]!.right - 1);
  expect(Math.max(...boxes.map((b) => b.right))).toBeLessThanOrEqual(390);
  // One view at a time: edit replaces reading.
  await page.locator("body").press("e");
  await expect(markdown(page)).toBeVisible();
  await expect(page.getByTestId("kb-rendered-document")).toHaveCount(0);
  await markdown(page).fill("# Read me\n\nStart here, from a phone.\n");
  await page.getByRole("button", { name: enKb.editor.save, exact: true }).click();
  await expect(page.getByTestId("editor-save-status")).toContainText(enKb.editor.saved);
  expect(await serverText(page, kb.id, README)).toContain("from a phone");

  // Back (the app's, not the browser's) leaves the file; Recent files brings it back.
  await page.getByRole("button", { name: enKb.workspace.shell.back }).click();
  await expect(page.getByTestId("kb-rendered-document")).toHaveCount(0);
  await expect(page.getByTestId("kb-tab-switcher")).toHaveAccessibleName(
    enKb.workspace.tabs.switcherButton.replace("{{count}}", "1"),
  );
  await page.getByTestId("kb-tab-switcher").click();
  // The file's row (its name, then its path), not its "Close readme.md" button.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^readme\.md/ })
    .click();
  await expect(page).toHaveURL(/path=readme\.md/);
});

test("desktop: hidden editor saves, outline jumps to the read view, Delete keeps focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}/documents?path=${encodeURIComponent(ALPHA)}`);
  await expect(page.getByTestId("kb-rendered-document")).toContainText("First guide.");
  await tree(page).getByRole("treeitem", { name: README }).click();
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Start here.");
  await tabs(page).getByRole("tab", { name: "alpha.md" }).click();
  await expect(page.getByTestId("kb-rendered-document")).toContainText("First guide.");

  // Edit, then hide the editor (`E`): the draft is still the tab's and still saves.
  await page.locator("body").press("e");
  await markdown(page).fill("# Alpha\n\nFirst guide, hidden edit.\n\n## Setup\n\nInstall it.\n");
  // Out of the text field first: there, `e` is typing.
  await markdown(page).blur();
  await page.locator("body").press("e");
  await expect(markdown(page)).toHaveCount(0);
  await expect(tabs(page).getByRole("tab", { name: /alpha\.md.*unsaved changes/ })).toBeVisible();
  // The outline jumps to its heading in the read view.
  await page.getByRole("button", { name: enKb.workspace.sidebar.outline, exact: true }).click();
  await page
    .getByRole("navigation", { name: enKb.workspace.outline.label })
    .getByRole("link", { name: "Setup" })
    .click();
  await expect(page).toHaveURL(/#setup$/);
  await expect(page.locator("#setup")).toBeInViewport();
  // Closing asks; Save works with the editor hidden, then the tab closes.
  await tabs(page)
    .getByRole("button", { name: enKb.workspace.tabs.close.replace("{{name}}", "alpha.md") })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: enKb.workspace.dirtyClose.save })
    .click();
  await expect(tabs(page).getByRole("tab")).toHaveCount(1);
  expect(await serverText(page, kb.id, ALPHA)).toContain("hidden edit");

  // Delete on a focused tab closes it and keeps keyboard focus in the strip.
  await page.getByRole("button", { name: enKb.workspace.sidebar.files, exact: true }).click();
  // `guides/` is open already: alpha.md is in it.
  await tree(page).getByRole("treeitem", { name: "beta.md" }).click();
  await expect(tabs(page).getByRole("tab")).toHaveCount(2);
  await tabs(page).getByRole("tab", { name: "beta.md" }).focus();
  await page.keyboard.press("Delete");
  await expect(tabs(page).getByRole("tab")).toHaveCount(1);
  await expect(tabs(page).getByRole("tab", { name: README })).toBeFocused();
});

test("desktop: with draft storage blocked, leaving an edited tab asks first", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // sessionStorage refuses writes (privacy settings, a full quota): drafts can't be kept.
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage && !key.startsWith("kb-harness-"))
        throw new DOMException("blocked", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}/documents?path=${encodeURIComponent(README)}`);
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Start here.");
  await tree(page).getByRole("treeitem", { name: "index.md" }).click();
  await tabs(page).getByRole("tab", { name: README }).click();
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Start here.");
  await page.locator("body").press("e");
  await markdown(page).fill("# Read me\n\nNot kept anywhere else.\n");
  await tabs(page).getByRole("tab", { name: "index.md" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(README);
  await dialog.getByRole("button", { name: enKb.workspace.dirtyClose.cancel }).click();
  // Cancel stays on the edited file with its text.
  await expect(markdown(page)).toHaveValue(/Not kept anywhere else/);
  await tabs(page).getByRole("tab", { name: "index.md" }).click();
  await dialog.getByRole("button", { name: enKb.workspace.dirtyClose.save }).click();
  await expect(page).toHaveURL(/path=index\.md/);
  await expect(tabs(page).getByRole("tab", { name: /unsaved changes/ })).toHaveCount(0);
  expect(await serverText(page, kb.id, README)).toContain("Not kept anywhere else.");
});

test("desktop: closing a New document with Save creates it and closes its tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}/documents?mode=new`);
  await expect(tabs(page).getByRole("tab", { name: enKb.detail.newDocument })).toBeVisible();
  await page.getByTestId("editor-path").fill("notes/fresh.md");
  await markdown(page).fill("# Fresh\n\nWritten in a new tab.\n");
  await tabs(page)
    .getByRole("button", {
      name: enKb.workspace.tabs.close.replace("{{name}}", enKb.detail.newDocument),
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: enKb.workspace.dirtyClose.save })
    .click();
  // The save gave the tab its path; the close followed it.
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(0);
  expect(await serverText(page, kb.id, "notes/fresh.md")).toContain("Written in a new tab.");
});

test("desktop: edits of a tab you leave are there when you come back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}/documents?path=${encodeURIComponent(README)}`);
  await expect(page.getByTestId("document-edit")).toBeVisible();
  await page.locator("body").press("e");
  await markdown(page).fill("# Read me\n\nUnsaved, then away and back.\n");
  await tree(page).getByRole("treeitem", { name: "index.md" }).click();
  await expect(tabs(page).getByRole("tab", { name: /readme\.md.*unsaved changes/ })).toBeVisible();
  await tabs(page)
    .getByRole("tab", { name: /readme\.md/ })
    .click();
  await expect(markdown(page)).toHaveValue(/Unsaved, then away and back\./);
  await expect(tabs(page).getByRole("tab", { name: /readme\.md.*unsaved changes/ })).toBeVisible();
});

test("desktop: closing another dirty tab asks in place; Save opens it and saves it there", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}/documents?path=${encodeURIComponent(ALPHA)}`);
  await expect(page.getByTestId("kb-rendered-document")).toContainText("First guide.");
  // alpha.md and readme.md: edited, then left; their drafts are kept (dots on their tabs).
  await page.locator("body").press("e");
  await markdown(page).fill("# Alpha\n\nKept, then discarded.\n");
  await tree(page).getByRole("treeitem", { name: README }).click();
  await expect(page.getByTestId("document-edit")).toBeVisible();
  await page.locator("body").press("e");
  await markdown(page).fill("# Read me\n\nKept draft.\n");
  await tree(page).getByRole("treeitem", { name: "index.md" }).click();
  await expect(tabs(page).getByRole("tab", { name: /alpha\.md.*unsaved changes/ })).toBeVisible();
  await expect(tabs(page).getByRole("tab", { name: /readme\.md.*unsaved changes/ })).toBeVisible();
  const dialog = page.getByRole("alertdialog");
  // Closing alpha.md asks right here; Discard drops its draft without leaving index.md.
  await tabs(page)
    .getByRole("button", { name: enKb.workspace.tabs.close.replace("{{name}}", "alpha.md") })
    .click();
  await expect(dialog).toContainText("alpha.md");
  await dialog.getByRole("button", { name: enKb.workspace.dirtyClose.discard }).click();
  await expect(tabs(page).getByRole("tab", { name: "alpha.md" })).toHaveCount(0);
  await expect(page).toHaveURL(/path=index\.md/);
  expect(await serverText(page, kb.id, ALPHA)).toContain("First guide.");
  // Closing readme.md with Save opens it and saves it with its own Save; its tab closes.
  await expect(dialog).toHaveCount(0);
  await tabs(page)
    .getByRole("button", { name: enKb.workspace.tabs.close.replace("{{name}}", README) })
    .click();
  await expect(dialog).toContainText(README);
  await dialog.getByRole("button", { name: enKb.workspace.dirtyClose.save }).click();
  await expect(tabs(page).getByRole("tab", { name: README })).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  expect(await serverText(page, kb.id, README)).toContain("Kept draft.");
});

function isUpload(request: Request) {
  const text = `${decodeURIComponent(request.url())} ${request.postData() ?? ""}`;
  return request.url().includes("/rpc") && text.includes("kbUploads");
}

test("desktop: an image still uploading keeps the editor open and nothing saves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}/documents?path=${encodeURIComponent(README)}`);
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Start here.");
  await page.locator("body").press("e");
  await markdown(page).fill("# Read me\n\nWith a picture.\n");
  // Hold the upload: its placeholder is in the text meanwhile.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Stays installed: once released, every request just continues.
  await page.route("**/rpc**", async (route) => {
    if (isUpload(route.request())) await held;
    await route.continue();
  });
  await page
    .getByTestId("editor-image-input")
    .setInputFiles({ name: "held.png", mimeType: "image/png", buffer: minimalPng() });
  await markdown(page).blur();
  // `E` does not hide an editor with an upload in flight; ⌘S saves nothing.
  await page.locator("body").press("e");
  await expect(markdown(page)).toBeVisible();
  await page.locator("body").press(`${mod}+s`);
  await expect(page.getByTestId("editor-save")).toBeDisabled();
  expect(await serverText(page, kb.id, README)).not.toContain("With a picture.");
  // Leaving for another file waits for the upload: nothing can be decided yet.
  await tree(page).getByRole("treeitem", { name: "index.md" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByRole("button", { name: enKb.workspace.dirtyClose.discard }),
  ).toBeDisabled();
  release();
  await expect(
    dialog.getByRole("button", { name: enKb.workspace.dirtyClose.discard }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: enKb.workspace.dirtyClose.cancel }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/path=readme\.md/);
  await expect(page.getByTestId("editor-save")).toBeEnabled();
  await page.locator("body").press(`${mod}+s`);
  await expect(tabs(page).getByRole("tab", { name: /unsaved changes/ })).toHaveCount(0);
  const saved = await serverText(page, kb.id, README);
  expect(saved).toContain("With a picture.");
  expect(saved).not.toContain("kb-upload:");
});

test("desktop: a dirty tab whose file is gone closes with Discard; a failed save explains itself", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}/documents?path=${encodeURIComponent(ALPHA)}`);
  await expect(page.getByTestId("kb-rendered-document")).toContainText("First guide.");
  await page.locator("body").press("e");
  await markdown(page).fill("# Alpha\n\nEdited, then the file goes.\n");
  await tree(page).getByRole("treeitem", { name: README }).click();
  await expect(tabs(page).getByRole("tab", { name: /alpha\.md.*unsaved changes/ })).toBeVisible();
  // Someone else deletes alpha.md meanwhile.
  await page.evaluate(
    async ({ kbId, path }) => {
      const { orpc, kbAttachmentSchema } = window.__kbEditor;
      const kb = kbAttachmentSchema.parse((await orpc.kbs.get.call({ kbId }))?.kb);
      await orpc.documents.delete.call({
        kbId,
        baseRevision: kb.headSha,
        path,
        confirm: "DELETE",
        idempotencyKey: crypto.randomUUID(),
      });
    },
    { kbId: kb.id, path: ALPHA },
  );
  await tabs(page)
    .getByRole("button", { name: enKb.workspace.tabs.close.replace("{{name}}", "alpha.md") })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("alpha.md");
  await dialog.getByRole("button", { name: enKb.workspace.dirtyClose.discard }).click();
  await expect(tabs(page).getByRole("tab", { name: "alpha.md" })).toHaveCount(0);

  // readme.md: edited here and on the server; Save in the close dialog conflicts.
  await tabs(page).getByRole("tab", { name: README }).click();
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Start here.");
  await page.locator("body").press("e");
  await markdown(page).fill("# Read me\n\nMine.\n");
  await page.evaluate(
    async ({ kbId, path }) => {
      const { orpc, kbAttachmentSchema } = window.__kbEditor;
      const kb = kbAttachmentSchema.parse((await orpc.kbs.get.call({ kbId }))?.kb);
      await orpc.documents.update.call({
        kbId,
        baseRevision: kb.headSha,
        path,
        content: { markdown: "# Read me\n\nTheirs.\n" },
        idempotencyKey: crypto.randomUUID(),
      });
    },
    { kbId: kb.id, path: README },
  );
  await tabs(page)
    .getByRole("button", { name: enKb.workspace.tabs.close.replace("{{name}}", README) })
    .click();
  await dialog.getByRole("button", { name: enKb.workspace.dirtyClose.save }).click();
  // Not saved: the dialog steps aside, the tab stays, focus is on the editor's Save.
  await expect(dialog).toHaveCount(0);
  await expect(tabs(page).getByRole("tab", { name: /readme\.md.*unsaved changes/ })).toBeVisible();
  await expect(page.getByTestId("editor-save")).toBeFocused();
  expect(await serverText(page, kb.id, README)).toContain("Theirs.");
});

test("desktop: the KB home restores no active tab; Copy link is the app's own URL", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  const kb = await createKb(page);
  await go(page, `/en-US/kbs/${kb.id}/documents?path=${encodeURIComponent(README)}`);
  await expect(page.getByTestId("kb-rendered-document")).toContainText("Start here.");
  await page.getByTestId("document-reference").click();
  await expect(page.getByRole("dialog")).toContainText(
    `${fx.origin}/en-US/kbs/${kb.id}/documents?path=readme.md`,
  );
  await page.keyboard.press("Escape");
  // In the file tree a letter finds a file; it never toggles the editor.
  await tree(page).focus();
  await page.keyboard.press("e");
  await expect(page).not.toHaveURL(/mode=edit/);
  await go(page, `/en-US/kbs/${kb.id}`);
  await page.reload();
  await expect(tabs(page).getByRole("tab", { name: README })).toBeVisible({ timeout: 25_000 });
  await expect(tabs(page).getByRole("tab", { selected: true })).toHaveCount(0);
  await expect(page.getByRole("tabpanel")).toHaveCount(0);
});
