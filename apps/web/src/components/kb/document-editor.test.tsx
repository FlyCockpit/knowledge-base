import { browserConflictDetails } from "@knowledge-base/api/lib/kb/browser-conflict";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { type ComponentProps, type ReactElement, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DocumentEditorView,
  imageInsertAt,
  insertImagesIntoDraft,
  KbProposalDocumentEditor,
  KbSessionEditor,
  submitPath,
} from "@/components/kb/document-editor";
import { kbDocumentHref, proposalHref } from "@/components/kb/kb-links";
import type { KbViewerDocument } from "@/components/kb/markdown-view";
import {
  describeEditorError,
  type ImageStageRun,
  kbControls,
  previewAfterSaves,
} from "@/hooks/use-kb-editor";
import { renderWithTestRouter as renderToStaticMarkup } from "@/lib/router-test-utils";
import { orpc } from "@/utils/orpc";

/**
 * The type-to-confirm dialog renders in a portal (nothing in static markup):
 * a stand-in shows the props each render passes, so the wiring is visible.
 */
vi.mock("@/components/confirm-delete-dialog", () => ({
  ConfirmDeleteDialog: (props: {
    open: boolean;
    title: string;
    description: string;
    confirmToken: string;
    confirmLabel?: string;
  }) => (
    <div
      data-testid="confirm-delete-dialog"
      data-open={String(props.open)}
      data-token={props.confirmToken}
    >
      {props.title} | {props.description} | {props.confirmLabel}
    </div>
  ),
}));

const KB = "a".repeat(24);
const HEAD = "1".repeat(40);
const NEW_HEAD = "2".repeat(40);
const OLD = "9".repeat(40);

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb", "common"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

type Props = ComponentProps<typeof DocumentEditorView>;
function render(overrides: Partial<Props>) {
  const props: Props = {
    lang: "en-US",
    kbId: KB,
    path: "notes/a.md",
    isNew: false,
    markdown: "local draft text",
    onMarkdownChange: () => {},
    onPathChange: () => {},
    controls: kbControls(["read", "propose", "write"]),
    viewingRevision: null,
    baseRevision: HEAD,
    outcome: null,
    pending: false,
    onSave: () => {},
    onAdoptHead: () => {},
    preview: { rev: HEAD, assets: [] },
    ...overrides,
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <DocumentEditorView {...props} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("DocumentEditorView controls", () => {
  it("explains a paused offline save while keeping its draft", () => {
    const out = render({ pending: true, paused: true });
    expect(out).toContain('role="status"');
    expect(out).toContain("The change will be sent when you reconnect.");
    expect(out).toContain("local draft text");
  });
  it("read-only KB renders a read-only textarea and no save/delete", () => {
    const out = render({ controls: kbControls(["read"]) });
    expect(out).toContain("readOnly");
    expect(out).not.toContain(enKb.editor.save);
    expect(out).not.toContain(enKb.editor.propose);
    expect(out).not.toContain(enKb.editor.delete);
  });
  it("propose-only KB offers 'propose', never a direct save", () => {
    const out = render({ controls: kbControls(["read", "propose"]) });
    expect(out).toContain(enKb.editor.propose);
    expect(out).not.toContain(`>${enKb.editor.save}<`);
  });
  it("write KB offers a direct save", () => {
    expect(render({})).toContain(enKb.editor.save);
  });
  it("the textarea has an accessible label", () => {
    const out = render({});
    const id = /<textarea[^>]*\sid="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`for="${id}"`);
  });
  it("viewing an old cited revision is read-only even with write", () => {
    const out = render({ viewingRevision: OLD });
    expect(out).toContain("readOnly");
    expect(out).toContain(OLD.slice(0, 12));
    expect(out).not.toContain(enKb.editor.save);
  });
  it("a closed write target keeps the draft readable with no save, image or proposal note", () => {
    const out = render({
      controls: kbControls(["read", "propose"]),
      closed: true,
      image: { onFiles: () => {}, status: null },
    });
    expect(out).toContain("local draft text");
    expect(out).toContain("readOnly");
    expect(out).not.toContain(enKb.editor.propose);
    expect(out).not.toContain(enKb.editor.proposalNote);
    expect(out).not.toContain('data-testid="editor-insert-image"');
  });
});

describe("DocumentEditorView outcomes", () => {
  it("proposed result links the PR and is not presented as a main update", () => {
    const out = render({
      outcome: { kind: "proposed", proposalNumber: 7, proposalHead: NEW_HEAD, created: true },
    });
    expect(out).toContain(`href="${proposalHref("en-US", KB, 7)}"`);
    expect(out).toContain("Proposal #7 created");
    expect(out).not.toContain(enKb.outcome.appliedTitle);
    const updated = render({
      outcome: { kind: "proposed", proposalNumber: 7, proposalHead: NEW_HEAD, created: false },
    });
    expect(updated).toContain("Proposal #7 updated");
  });
  it("applied result shows commit and index state", () => {
    const out = render({
      outcome: {
        kind: "applied",
        commitSha: NEW_HEAD,
        indexJobId: "00000000-0000-4000-8000-0000000000bb",
      },
    });
    expect(out).toContain(enKb.outcome.appliedTitle);
    expect(out).toContain(NEW_HEAD.slice(0, 12));
    expect(out).toContain(enKb.outcome.indexQueued);
  });
  it("noop is distinct", () => {
    const out = render({ outcome: { kind: "noop", commitSha: HEAD } });
    expect(out).toContain(enKb.outcome.noopTitle);
    expect(out).not.toContain(enKb.outcome.appliedTitle);
  });
  it("conflict keeps the local text and shows the actual new head", () => {
    const out = render({
      outcome: { kind: "conflict", headSha: NEW_HEAD, proposalNumber: null },
    });
    expect(out).toContain("local draft text");
    expect(out).toContain(NEW_HEAD);
    expect(out).toContain(enKb.outcome.adoptHead);
    // Adopting overwrites that head: it waits until the head itself was read and shown.
    expect(out).toContain('data-testid="revision-preview" data-state="loading"');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Continue editing on the new version/);
  });
});

describe("hrefs", () => {
  it("document href pins the cited commit", () => {
    expect(kbDocumentHref("en-US", KB, { path: "a b.md", rev: OLD })).toBe(
      `/en-US/kbs/${KB}/documents?path=a+b.md&rev=${OLD}`,
    );
  });
});

describe("raw Markdown editor with a live, safe preview", () => {
  const preview = (out: string) => {
    const at = out.indexOf('data-testid="editor-preview"');
    expect(at).toBeGreaterThan(-1);
    return out.slice(at);
  };
  it("the textarea holds the raw Markdown exactly; the preview renders the same draft", () => {
    const draft = "# Title\n\nSome **bold** text\n\n- [x] done\n";
    const out = render({ markdown: draft });
    // Raw text editor: the draft is the textarea value, not rendered markup.
    expect(out).toContain(`>${draft.replace(/\n/g, "\n")}</textarea>`);
    const shown = preview(out);
    expect(shown).toMatch(/<h2 id="preview-[^"]+-title" class="md-h1">Title<\/h2>/);
    expect(shown).toContain("<strong>bold</strong>");
    expect(shown).toContain('type="checkbox"');
  });
  it("the preview follows the draft (a changed draft re-renders)", () => {
    expect(preview(render({ markdown: "## First" }))).toMatch(
      /<h3 id="preview-[^"]+-first" class="md-h2">First<\/h3>/,
    );
    const next = preview(render({ markdown: "## Second" }));
    expect(next).toMatch(/<h3 id="preview-[^"]+-second" class="md-h2">Second<\/h3>/);
    expect(next).not.toContain("First");
  });
  it("the preview uses the same security rules and never fetches remote content", () => {
    const out = preview(
      render({
        markdown:
          '<script>window.__pwned=1</script>\n\n![x](https://attacker.example/p.png) [j](javascript:alert(1)) <img src="https://attacker.example/q.png">',
      }),
    );
    expect(out).not.toMatch(/<(script|img|iframe)\b/i);
    expect(out).not.toMatch(/(src|href)="[^"]*attacker\.example/);
    expect(out).not.toMatch(/href="javascript:/i);
    expect(out).toContain("External image not loaded");
  });
  it("relative media in the preview resolve only through the pinned KB asset route", () => {
    const PNG = `sha256:${"1".repeat(64)}`;
    const out = preview(
      render({
        markdown: "![pic](../media/pic.png)",
        preview: {
          rev: HEAD,
          assets: [{ path: "media/pic.png", hash: PNG, size: 1, mime: "image/png" }],
        },
      }),
    );
    expect(out).toContain(`src="/kb-assets/${KB}/${PNG}?rev=${HEAD}"`);
  });
  it("a relative image the saved document does not use yet is 'not previewed', never fetched", () => {
    const out = preview(render({ markdown: "![new](../media/new.png)" }));
    expect(out).toMatch(/media\/new\.png isn(&#x27;|')t previewed yet/);
    expect(out).not.toContain("Missing asset");
    expect(out).not.toMatch(/<img\b/);
  });
  it("read-only and pinned-revision views show no editing preview", () => {
    expect(render({ controls: kbControls(["read"]) })).not.toContain(
      'data-testid="editor-preview"',
    );
    expect(render({ viewingRevision: OLD })).not.toContain('data-testid="editor-preview"');
  });
});

describe("submitPath", () => {
  it("trims only a new document's typed path; an existing path is sent exactly", () => {
    expect(submitPath("  notes/new.md ", true)).toBe("notes/new.md");
    expect(submitPath(" notes/a.md", false)).toBe(" notes/a.md");
  });
});

describe("DocumentEditorView image upload", () => {
  const image = { onFiles: () => {}, status: null };
  it("offers Insert image with the accepted types only when editable", () => {
    const out = render({ image });
    expect(out).toContain(enKb.editor.image.insert);
    expect(out).toContain('accept="image/png,image/jpeg,image/gif,image/webp"');
    expect(out).not.toContain("image/svg");
    expect(render({ image, controls: kbControls(["read"]) })).not.toContain(
      enKb.editor.image.insert,
    );
  });
  it("shows progress and specific errors", () => {
    const uploading = render({
      image: { ...image, status: { kind: "uploading", name: "cat.png", percent: 40 } },
    });
    expect(uploading).toContain("Uploading cat.png… 40%");
    expect(uploading).toContain("<progress");
    const failed = render({
      image: { ...image, status: { kind: "error", name: "cat.png", error: "type" } },
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("cat.png isn&#x27;t a supported image");
  });
});

describe("image insertion while typing (R3-W7)", () => {
  const staged = (path: string): ImageStageRun => ({
    ok: true,
    image: {
      path,
      uploadId: "00000000-0000-4000-8000-000000000001",
      hash: `sha256:${"a".repeat(64)}`,
      size: 3,
      mime: "image/png",
    },
    markdown: `![x](/${path})`,
  });
  function harness(initial: string) {
    let draft = initial;
    let id = 0;
    const pending: ((run: ImageStageRun) => void)[] = [];
    const statuses: unknown[] = [];
    const done = (files: { name: string }[], at: { start: number; end: number }) =>
      insertImagesIntoDraft({
        files,
        at,
        selected: initial.slice(at.start, at.end),
        newId: () => `id${++id}`,
        placeholderAlt: (name) => `Uploading ${name}`,
        updateDraft: (update) => {
          draft = update(draft);
        },
        insert: () => new Promise<ImageStageRun>((resolve) => pending.push(resolve)),
        onStatus: (status) => statuses.push(status),
      });
    return {
      done,
      statuses,
      get draft() {
        return draft;
      },
      type: (update: (d: string) => string) => {
        draft = update(draft);
      },
      resolve: async (run: ImageStageRun) => {
        await Promise.resolve();
        pending.shift()?.(run);
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  }

  it("lands where the selection was, as its own paragraph, even while the user types", async () => {
    const h = harness("hello TARGET world");
    const finished = h.done([{ name: "a.png" }], { start: 6, end: 12 });
    expect(h.draft).toBe("hello \n\n![Uploading a.png](kb-upload:id1)\n\n world");
    // Typing before the placeholder while the upload is still running.
    h.type((d) => `PREFIX ${d}`);
    await h.resolve(staged("assets/a.png"));
    await finished;
    expect(h.draft).toBe("PREFIX hello \n\n![x](/assets/a.png)\n\n world");
    expect(h.statuses.at(-1)).toEqual({ kind: "staged", name: "a.png" });
  });

  it("inserts at the caret only once the textarea was focused", () => {
    expect(imageInsertAt(null, 20)).toEqual({ start: 20, end: 20 });
    expect(imageInsertAt({ selectionStart: 3, selectionEnd: 5 }, 20)).toEqual({ start: 3, end: 5 });
  });

  it("an untouched editor appends at the end and never corrupts the first heading", async () => {
    const initial = "# Team notes\n\nBody text.";
    // The view passes the end of the draft while the textarea was never focused.
    const h = harness(initial);
    const finished = h.done([{ name: "d.png" }], { start: initial.length, end: initial.length });
    await h.resolve(staged("assets/d.png"));
    await finished;
    expect(h.draft).toBe("# Team notes\n\nBody text.\n\n![x](/assets/d.png)");
    expect(h.draft.split("\n")[0]).toBe("# Team notes");
  });

  it("an image at the caret on a heading line gets its own paragraph", async () => {
    const h = harness("# Title\nNext");
    const finished = h.done([{ name: "a.png" }], { start: 0, end: 0 });
    await h.resolve(staged("assets/a.png"));
    await finished;
    expect(h.draft).toBe("![x](/assets/a.png)\n\n# Title\nNext");
    const after = harness("# Title\nNext");
    const end = after.done([{ name: "a.png" }], { start: 7, end: 7 });
    await after.resolve(staged("assets/a.png"));
    await end;
    expect(after.draft).toBe("# Title\n\n![x](/assets/a.png)\n\nNext");
  });

  it("separates several images with blank lines", async () => {
    const h = harness("text\n");
    const finished = h.done([{ name: "a.png" }, { name: "b.png" }, { name: "c.png" }], {
      start: 5,
      end: 5,
    });
    for (const name of ["a", "b", "c"]) await h.resolve(staged(`assets/${name}.png`));
    await finished;
    expect(h.draft).toBe(
      "text\n\n![x](/assets/a.png)\n\n![x](/assets/b.png)\n\n![x](/assets/c.png)",
    );
  });

  it("restores the selection when the first upload fails and drops the rest", async () => {
    const h = harness("hello TARGET world");
    const finished = h.done([{ name: "a.png" }, { name: "b.png" }], { start: 6, end: 12 });
    h.type((d) => `${d}!`);
    await h.resolve({ ok: false, error: "retryable" });
    await finished;
    expect(h.draft).toBe("hello TARGET world!");
  });

  it("drops a later failed image with its separator, keeping the staged ones", async () => {
    const h = harness("");
    const finished = h.done([{ name: "a.png" }, { name: "b.png" }], { start: 0, end: 0 });
    await h.resolve(staged("assets/a.png"));
    await h.resolve({ ok: false, error: "rejected" });
    await finished;
    expect(h.draft).toBe("![x](/assets/a.png)");
  });

  it("keeps a staged image linked if its placeholder was deleted", async () => {
    const h = harness("text");
    const finished = h.done([{ name: "a.png" }], { start: 4, end: 4 });
    h.type(() => "rewritten");
    await h.resolve(staged("assets/a.png"));
    await finished;
    expect(h.draft).toBe("rewritten\n\n![x](/assets/a.png)");
  });
});

describe("staged images in the live preview (R3-W7)", () => {
  it("shows a staged image from its local object URL, never the server route", () => {
    const out = render({
      markdown: "![cat](/assets/cat-12345678.png)",
      stagedImages: [
        {
          path: "assets/cat-12345678.png",
          uploadId: "00000000-0000-4000-8000-000000000001",
          hash: `sha256:${"c".repeat(64)}`,
          size: 3,
          mime: "image/png",
          objectUrl: "blob:https://kb.example/123",
        },
      ],
    });
    expect(out).toContain('src="blob:https://kb.example/123"');
    expect(out).not.toContain("/kb-assets/");
  });

  it("says a staged image is added when you save", () => {
    const out = render({
      image: { onFiles: () => {}, status: { kind: "staged", name: "cat.png" } },
    });
    expect(out).toContain("added to the knowledge base when you save");
  });
});

describe("save outcomes for staged images and pull requests (R3-W6, R3-W7)", () => {
  it("too many images asks to save first", () => {
    const out = render({ outcome: { kind: "error", reason: "tooManyImages" } });
    expect(out).toContain("at most 7 new images");
  });

  it("PROPOSAL_CONFLICT from the documents router lists the paths and links their resolution", () => {
    // Exactly what the router sends: domain details through the shared mapping.
    const domain = {
      headSha: HEAD,
      proposalNumber: 4,
      reason: "PROPOSAL_CONFLICT",
      baseSha: OLD,
      proposalHeadSha: NEW_HEAD,
      contentIncluded: false,
      paths: [
        {
          path: "notes/b.md",
          kind: "document",
          base: null,
          theirs: null,
          yours: null,
          baseSha: OLD,
          theirsSha: HEAD,
          yoursSha: NEW_HEAD,
        },
      ],
    };
    const outcome = describeEditorError(
      new ORPCError("CONFLICT", {
        data: { code: "CONFLICT", details: browserConflictDetails(domain) ?? {} },
      }),
    );
    expect(outcome).toMatchObject({ kind: "conflict", proposalNumber: 4 });
    const out = render({ outcome });
    expect(out).toContain('data-testid="editor-proposal-conflict"');
    expect(out).toContain("Pull request #4 still conflicts with main");
    expect(out).toContain("notes/b.md");
    expect(out).toContain(proposalHref("en-US", KB, 4));
    expect(out).toContain(
      kbDocumentHref("en-US", KB, { path: "notes/b.md", mode: "edit", pr: 4 }).replace(
        /&/g,
        "&amp;",
      ),
    );
    // Re-saving onto main's head would fail the same way: no "continue on head".
    expect(out).not.toContain(enKb.outcome.adoptHead);
  });
});

describe("a new document's path is fixed by its unresolved create (P r4e minor 2)", () => {
  const pathReadOnly =
    /<input[^>]*value="notes\/a.md"[^>]*readOnly|<input[^>]*readOnly[^>]*value="notes\/a.md"/;
  it("locks only the path; the draft stays editable (the session keeps it across the create)", () => {
    const out = render({ isNew: true, pathLocked: true, pending: true });
    expect(out).toMatch(pathReadOnly);
    expect(out).not.toMatch(/<textarea[^>]*readOnly/);
    const open = render({ isNew: true });
    expect(open).not.toMatch(pathReadOnly);
  });
});

function SessionEditorPreviewHarness({
  useRender,
  previews,
}: {
  useRender: (pass: number) => ReactElement<Props>;
  previews: Props["preview"][];
}) {
  const [pass, setPass] = useState(0);
  const element = useRender(pass);
  previews.push(element.props.preview);
  if (pass === 0) setPass(1);
  return element;
}

describe("committed images keep rendering after a save (R3-W7)", () => {
  it("a PR-mode preview shows the committed image at the proposal head", () => {
    const hash = `sha256:${"d".repeat(64)}`;
    const preview = previewAfterSaves(
      { rev: HEAD, assets: [] },
      {
        rev: NEW_HEAD,
        assets: [{ path: "assets/cat-12345678.png", hash, size: 3, mime: "image/png" }],
      },
    );
    const out = render({ markdown: "![cat](/assets/cat-12345678.png)", preview, stagedImages: [] });
    expect(out).toContain(`/kb-assets/${KB}/${hash}?rev=${NEW_HEAD}`);
    expect(out).not.toContain("blob:");
  });

  const useSessionEditor = KbSessionEditor;
  it.each([false, true])(
    "memoizes the merged preview while typing and updates on a new commit (%s)",
    (advanceCommit) => {
      const asset = {
        path: "assets/cat.png",
        hash: `sha256:${"d".repeat(64)}`,
        size: 3,
        mime: "image/png",
      };
      const opened = { rev: HEAD, assets: [] };
      const editor: ComponentProps<typeof KbSessionEditor>["editor"] = {
        markdown: "![cat](/assets/cat.png)",
        setMarkdown: () => {},
        baseRevision: NEW_HEAD,
        path: "notes/a.md",
        setPath: () => {},
        pathEditable: false,
        exists: true,
        outcome: null,
        pending: false,
        paused: false,
        proposal: true,
        submit: async () => undefined,
        adoptHead: () => {},
        insertImage: async () => undefined,
        stagedImages: [],
        committed: { rev: NEW_HEAD, assets: [asset] },
      };
      const nextCommit = { rev: "3".repeat(40), assets: [asset] };
      const previews: Props["preview"][] = [];
      const out = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <SessionEditorPreviewHarness
            previews={previews}
            useRender={(pass) =>
              useSessionEditor({
                lang: "en-US",
                kb: { id: KB, headSha: HEAD, capabilities: ["read", "write"] },
                isNew: false,
                viewingRevision: null,
                // The wrapper can change while the revision and asset references stay stable.
                preview: { ...opened },
                onOpenLatest: () => {},
                editor: {
                  ...editor,
                  markdown: `${editor.markdown}${pass === 1 ? "\n\nnew body" : ""}`,
                  committed: pass === 1 && advanceCommit ? nextCommit : editor.committed,
                },
              })
            }
          />
        </I18nextProvider>,
      );
      expect(previews).toHaveLength(2);
      if (advanceCommit) expect(previews[1]).not.toBe(previews[0]);
      else expect(previews[1]).toBe(previews[0]);
      expect(out).toContain(`?rev=${advanceCommit ? nextCommit.rev : NEW_HEAD}`);
      expect(out).toContain("new body");
    },
  );
});

describe("PR mode deletion-only resolution (R3-W6)", () => {
  const MAIN = "7".repeat(40);
  const PR = "8".repeat(40);
  const BASE = "6".repeat(40);
  const PATH = "notes/gone.md";
  function renderPrMode(options: {
    yours: "missing" | "present";
    theirs: "missing" | "present";
    conflicted: boolean;
  }) {
    // Seeded results stand: an errored read is not refetched on mount.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
    });
    client.setQueryData(orpc.pullRequests.conflicts.queryKey({ input: { kbId: KB, number: 5 } }), {
      status: "CONFLICT",
      headSha: PR,
      targetSha: MAIN,
      isDream: false,
      truncated: false,
      paths: options.conflicted
        ? [
            {
              path: PATH,
              kind: "document",
              recorded: true,
              standing: false,
              baseSha: BASE,
              theirsSha: MAIN,
              yoursSha: PR,
            },
          ]
        : [],
    });
    const seed = (rev: string, state: "missing" | "present") => {
      const queryKey = orpc.documents.get.queryKey({ input: { kbId: KB, path: PATH, rev } });
      if (state === "present")
        // A test fixture of the read's fields the editor uses.
        client.setQueryData<KbViewerDocument>(queryKey as readonly unknown[], {
          path: PATH,
          markdown: `# at ${rev.slice(0, 1)}\n`,
          commitSha: rev,
          documentCitations: [],
          assetRefs: [],
        });
      else
        client
          .getQueryCache()
          .build(client, { queryKey })
          .setState({
            status: "error",
            error: Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" }),
            fetchStatus: "idle",
          });
    };
    seed(PR, options.yours);
    seed(MAIN, options.theirs);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <KbProposalDocumentEditor
            lang="en-US"
            kb={{ id: KB, headSha: MAIN, capabilities: ["read", "propose"] }}
            number={5}
            path={PATH}
            onLeave={() => {}}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
  }

  it("a recorded deletion absent on both sides offers Keep the deletion, never 'missing'", () => {
    const out = renderPrMode({ yours: "missing", theirs: "missing", conflicted: true });
    expect(out).toContain('data-state="ready"');
    expect(out).toContain('data-testid="pr-mode-both-deleted"');
    expect(out).toContain('data-testid="pr-mode-delete"');
    expect(out).toContain(enKb.prMode.keepDeletion);
    // The deletion waits for the type-to-confirm dialog (closed until clicked).
    expect(out).toMatch(
      /data-testid="confirm-delete-dialog" data-open="false" data-token="DELETE"/,
    );
    expect(out).toContain("Delete notes/gone.md in pull request #5?");
    expect(out).not.toContain('data-testid="pr-mode" data-state="missing"');
    expect(out).not.toContain('data-testid="pr-mode-conflict"');
    // No draft to edit when there is no version.
    expect(out).not.toContain('data-testid="editor-markdown"');
  });

  it("main deleted a path the PR still has: edit it, or accept main's deletion", () => {
    const out = renderPrMode({ yours: "present", theirs: "missing", conflicted: true });
    expect(out).toContain('data-testid="pr-mode-main-deleted"');
    expect(out).toContain('data-testid="pr-mode-delete"');
    expect(out).toMatch(
      /data-testid="confirm-delete-dialog" data-open="false" data-token="DELETE"/,
    );
    expect(out).toContain("Accept main&#x27;s deletion");
    expect(out).toContain('data-testid="editor-markdown"');
  });

  it("a path in neither version and not in conflict is just missing", () => {
    const out = renderPrMode({ yours: "missing", theirs: "missing", conflicted: false });
    expect(out).toContain('data-testid="pr-mode" data-state="missing"');
    expect(out).not.toContain('data-testid="pr-mode-delete"');
  });
});
