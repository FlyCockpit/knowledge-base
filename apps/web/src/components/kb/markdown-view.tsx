import { CodeSnippet } from "@knowledge-base/ui/components/code-snippet";
import { useRouter } from "@tanstack/react-router";
import { memo, type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { kbDocumentHref } from "@/components/kb/kb-links";
import { routerClick } from "@/components/kb/kb-list";
import {
  type AssetRef,
  ExternalMedia,
  isRenderableMime,
  kbAssetUrl,
  MediaEmbed,
  MissingAsset,
  resolveAssetDestination,
  UnpreviewedAsset,
} from "@/components/kb/media";
import { WideContent } from "@/components/wide-content";
import { rehypeHeadingIds } from "@/lib/markdown-heading-slugs";

/**
 * The KB Markdown renderer: `react-markdown` + `remark-gfm`, which
 * parse with micromark and render React elements only. Raw HTML is never
 * interpreted (no raw-HTML rehype plugin; react-markdown turns HTML nodes into
 * text), nothing here injects inner HTML, a strict URL transform keeps
 * only http(s)/mailto and KB-relative destinations, and media resolve only
 * through the revision-bound `/kb-assets` route for a manifest entry of THIS
 * document's commit, so rendering never fetches remote content.
 */
export type MarkdownContext = {
  lang: string;
  kbId: string;
  /** Commit the document was read at; every relative link and asset pins it. */
  rev: string;
  documentPath: string;
  assets: readonly AssetRef[];
  /** Shared by body links/images and metadata citations for this inventory. */
  assetsByPath?: ReadonlyMap<string, AssetRef>;
  /**
   * Editor preview: `assets` are only the media the saved document
   * already references, so an unknown relative image in the draft is "not
   * previewed yet" rather than a missing asset. Nothing is fetched for it.
   */
  draft?: boolean;
  /** Auxiliary previews namespace IDs; canonical document views keep shareable section slugs. */
  fragmentPrefix?: string;
  /**
   * Editor preview only (R3-W7): images staged for the next save, shown from
   * a local `blob:` object URL. Nothing is fetched from the server for them.
   */
  staged?: readonly (AssetRef & { objectUrl: string })[];
};

export type KbViewerDocument = {
  path: string;
  markdown: string;
  commitSha: string;
  documentCitations: { label: string; target: string }[];
  assetRefs: AssetRef[];
};

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Absolute http/https URL without embedded credentials, else null. */
export function safeExternalHref(target: string): string | null {
  const value = target.trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** A `mailto:` URL with an address, else null. Never opens a new window. */
function safeMailtoHref(target: string): string | null {
  const value = target.trim();
  if (!/^mailto:/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "mailto:" || url.pathname.length === 0) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** KB-relative: no scheme, not protocol-relative, not empty. */
const isRelative = (value: string) =>
  value.length > 0 && !SCHEME.test(value) && !value.startsWith("//");

/**
 * The only URL policy the renderer applies to parsed Markdown (react-markdown
 * `urlTransform`). Links keep http(s) (no credentials), mailto, in-page
 * fragments and KB-relative paths; images keep KB-relative paths only (no
 * remote fetch, not even https); every other URL-bearing attribute is dropped.
 * The link and image components below then resolve what survives.
 */
export function kbUrlTransform(url: string, key: string): string {
  const value = url.trim();
  if (key === "href") {
    return safeExternalHref(value) ?? safeMailtoHref(value) ?? (isRelative(value) ? value : "");
  }
  if (key === "src") return isRelative(value) && !value.startsWith("#") ? value : "";
  return "";
}

type LinkTarget =
  | { kind: "external"; href: string }
  | { kind: "mailto"; href: string }
  | { kind: "fragment"; href: string }
  | { kind: "document"; href: string }
  | { kind: "asset"; href: string; asset: AssetRef }
  | null;

const REVISION = /^[0-9a-f]{40}$/;

type IndexedContext = MarkdownContext & { assetsByPath: ReadonlyMap<string, AssetRef> };

function indexContext(ctx: MarkdownContext): IndexedContext {
  return { ...ctx, assetsByPath: ctx.assetsByPath ?? new Map(ctx.assets.map((a) => [a.path, a])) };
}

function assetHref(ctx: MarkdownContext, asset: AssetRef): string | null {
  if (!isRenderableMime(asset.mime) || !REVISION.test(ctx.rev)) return null;
  try {
    return kbAssetUrl(ctx.kbId, asset.hash, ctx.rev);
  } catch {
    return null;
  }
}

function resolveLink(destination: string, ctx: IndexedContext): LinkTarget {
  const trimmed = destination.trim();
  if (SCHEME.test(trimmed) || trimmed.startsWith("//")) {
    const external = safeExternalHref(trimmed);
    if (external) return { kind: "external", href: external };
    const mailto = safeMailtoHref(trimmed);
    return mailto ? { kind: "mailto", href: mailto } : null;
  }
  if (/^#[^\s]+$/.test(trimmed))
    return { kind: "fragment", href: `#${ctx.fragmentPrefix ?? ""}${trimmed.slice(1)}` };
  const path = resolveAssetDestination(trimmed, ctx.documentPath);
  if (!path) return null;
  const asset = ctx.assetsByPath.get(path);
  if (asset) {
    const href = assetHref(ctx, asset);
    return href ? { kind: "asset", href, asset } : null;
  }
  if (path.toLowerCase().endsWith(".md"))
    return {
      kind: "document",
      href: kbDocumentHref(ctx.lang, ctx.kbId, {
        path,
        rev: REVISION.test(ctx.rev) ? ctx.rev : undefined,
        hash: trimmed.includes("#") ? trimmed.slice(trimmed.indexOf("#") + 1) : undefined,
      }),
    };
  return null;
}

/** Clickable href for a front-matter citation, or null (rendered as text). */
export function citationHref(target: string, ctx: MarkdownContext): string | null {
  const link = resolveLink(target, indexContext(ctx));
  return link?.kind === "external" || link?.kind === "document" ? link.href : null;
}

/** YAML front matter is metadata, not body: strip a leading `---` … `---` block. */
function stripFrontMatter(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return markdown;
  const close = lines.indexOf("---", 1);
  return close < 0 ? markdown : lines.slice(close + 1).join("\n");
}

type HastNode = { type: string; value?: string; children?: HastNode[] };

/** Plain text of a parsed (hast) subtree; used for code blocks. */
function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * Elements GFM can produce. Anything else (there should be nothing: raw HTML
 * is text) is dropped with its children kept as text.
 */
const ALLOWED_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "strong",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

function externalAnchor(href: string, children: ReactNode) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className="underline underline-offset-4"
    >
      {children}
    </a>
  );
}

function renderLink(
  destination: string,
  children: ReactNode,
  ctx: IndexedContext,
  navigate: (href: string) => void,
  id?: string,
  describedBy?: string,
): ReactNode {
  const link = destination ? resolveLink(destination, ctx) : null;
  if (!link) return <span>{children}</span>;
  if (link.kind === "external") return externalAnchor(link.href, children);
  if (link.kind === "asset") {
    const name = link.asset.path.split("/").at(-1) ?? link.asset.path;
    return (
      <a
        href={link.href}
        download={link.asset.mime === "application/pdf" ? name : undefined}
        className="underline underline-offset-4"
      >
        {children}
      </a>
    );
  }
  return (
    <a
      id={id}
      aria-describedby={describedBy}
      href={link.href}
      onClick={link.kind === "document" ? routerClick(() => navigate(link.href)) : undefined}
      className="underline underline-offset-4"
    >
      {children}
    </a>
  );
}

function renderImage(destination: string, alt: string, ctx: IndexedContext): ReactNode {
  const trimmed = destination.trim();
  if (!trimmed || SCHEME.test(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("#"))
    return <ExternalMedia alt={alt} />;
  const path = resolveAssetDestination(trimmed, ctx.documentPath);
  if (!path) return <ExternalMedia alt={alt} />;
  const staged = ctx.draft ? ctx.staged?.find((image) => image.path === path) : undefined;
  if (staged?.objectUrl.startsWith("blob:"))
    return <MediaEmbed asset={staged} url={staged.objectUrl} alt={alt} />;
  const asset = ctx.assetsByPath.get(path);
  if (!asset) return ctx.draft ? <UnpreviewedAsset path={path} /> : <MissingAsset path={path} />;
  return <MediaEmbed asset={asset} url={assetHref(ctx, asset) ?? ""} alt={alt} />;
}

/**
 * A document renders under its page's own `<h1>` (the file name), so its
 * Markdown headings sit one level lower in the outline: `#` becomes `<h2>`,
 * down to `<h6>` (R2-19). Each keeps its source level's look via `md-hN`.
 */
const DEMOTED = { h1: "h2", h2: "h3", h3: "h4", h4: "h5", h5: "h6", h6: "h6" } as const;
function demotedHeadings(): Components {
  return Object.fromEntries(
    Object.entries(DEMOTED).map(([source, Tag]) => [
      source,
      ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <Tag
          id={typeof node?.properties.id === "string" ? node.properties.id : undefined}
          className={`md-${source}`}
        >
          {children}
        </Tag>
      ),
    ]),
  );
}

function components(
  ctx: IndexedContext,
  copyLabel: string,
  navigate: (href: string) => void,
): Components {
  return {
    ...demotedHeadings(),
    a: ({ href, children, id, "aria-describedby": describedBy }) =>
      renderLink(typeof href === "string" ? href : "", children, ctx, navigate, id, describedBy),
    img: ({ src, alt }) =>
      renderImage(typeof src === "string" ? src : "", typeof alt === "string" ? alt : "", ctx),
    pre: ({ node }: ExtraProps) => (
      <CodeSnippet
        code={textOf(node as HastNode | undefined).replace(/\n$/, "")}
        copyLabel={copyLabel}
      />
    ),
    input: ({ type, checked }) =>
      type === "checkbox" ? (
        <input type="checkbox" checked={Boolean(checked)} disabled readOnly className="mr-2" />
      ) : null,
    blockquote: ({ children }) => (
      <blockquote className="border-l-4 pl-3 text-muted-foreground">{children}</blockquote>
    ),
    ul: ({ children }) => <ul className="list-disc pl-6">{children}</ul>,
    ol: ({ children, start }) => (
      <ol start={start === 1 ? undefined : start} className="list-decimal pl-6">
        {children}
      </ol>
    ),
    table: ({ children }) => (
      <WideContent>
        <table>{children}</table>
      </WideContent>
    ),
  };
}

/**
 * Typography for rendered KB documents: a long-read measure and
 * a real heading scale, as wrapper classes only, so the renderer above (its
 * allowed elements, URL policy and media resolution) stays exactly as is.
 */
const MARKDOWN_CLASS_NAME = [
  "kb-markdown min-w-0 max-w-[72ch] break-words text-[0.9375rem] leading-7 sm:text-base",
  "[&>*+*]:mt-4 [&>:first-child]:mt-0",
  "[&_.md-h1]:font-heading [&_.md-h1]:mt-10 [&_.md-h1]:text-3xl [&_.md-h1]:leading-tight [&_.md-h1]:font-semibold [&_.md-h1]:tracking-tight [&_.md-h1]:text-balance",
  "[&_.md-h2]:font-heading [&_.md-h2]:mt-10 [&_.md-h2]:border-b [&_.md-h2]:pb-2 [&_.md-h2]:text-2xl [&_.md-h2]:leading-snug [&_.md-h2]:font-semibold [&_.md-h2]:tracking-tight",
  "[&_.md-h3]:font-heading [&_.md-h3]:mt-8 [&_.md-h3]:text-xl [&_.md-h3]:leading-snug [&_.md-h3]:font-semibold",
  "[&_.md-h4]:mt-6 [&_.md-h4]:text-lg [&_.md-h4]:font-semibold",
  "[&_.md-h5]:mt-6 [&_.md-h5]:font-semibold [&_.md-h6]:mt-6 [&_.md-h6]:font-semibold [&_.md-h6]:text-muted-foreground",
  "[&_a]:font-medium [&_a]:text-primary [&_a]:decoration-primary/40 [&_a:hover]:decoration-primary",
  "[&_strong]:font-semibold",
  "[&_li]:mt-1.5 [&_li]:ps-1 [&_li::marker]:text-muted-foreground [&_li>ul]:mt-1.5 [&_li>ol]:mt-1.5",
  "[&_li:has(>input)]:list-none",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.875em]",
  "[&_pre]:text-sm [&_pre]:leading-relaxed",
  "[&_blockquote]:py-1 [&_blockquote_p]:leading-relaxed",
  "[&_hr]:my-8 [&_hr]:border-border",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_th]:border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-start [&_th]:font-semibold [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
  "[&_sup]:text-xs [&_section]:mt-10 [&_section]:border-t [&_section]:pt-4 [&_section]:text-sm",
].join(" ");

export const MarkdownView = memo(function MarkdownView({
  markdown,
  context,
}: {
  markdown: string;
  context: MarkdownContext;
}) {
  const router = useRouter();
  const { t } = useTranslation("common");
  const indexed = useMemo(() => indexContext(context), [context]);
  const copyLabel = t("actions.copy");
  const markdownComponents = useMemo(
    () =>
      components(indexed, copyLabel, (href) => {
        void router.navigate({ href });
      }),
    [indexed, copyLabel, router],
  );
  return (
    <div className={MARKDOWN_CLASS_NAME}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHeadingIds, { prefix: context.fragmentPrefix }]]}
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        urlTransform={kbUrlTransform}
        components={markdownComponents}
      >
        {stripFrontMatter(markdown)}
      </Markdown>
    </div>
  );
});

/** Rendered document at its pinned commit, with front-matter citations as untrusted text. */
export function KbRenderedDocument({
  lang,
  kbId,
  document,
  showRevision = true,
  fragmentPrefix,
}: {
  lang: string;
  kbId: string;
  document: KbViewerDocument;
  /** Off where a document header already shows the revision. */
  showRevision?: boolean;
  fragmentPrefix?: string;
}) {
  const router = useRouter();
  const { t } = useTranslation("kb");
  const assetsByPath = useMemo(
    () => new Map(document.assetRefs.map((asset) => [asset.path, asset])),
    [document.assetRefs],
  );
  const context = useMemo<MarkdownContext>(
    () => ({
      lang,
      kbId,
      rev: document.commitSha,
      documentPath: document.path,
      assets: document.assetRefs,
      assetsByPath,
      fragmentPrefix,
    }),
    [
      lang,
      kbId,
      document.commitSha,
      document.path,
      document.assetRefs,
      assetsByPath,
      fragmentPrefix,
    ],
  );
  return (
    <article data-testid="kb-rendered-document" className="min-w-0 space-y-4">
      {showRevision && (
        <p className="text-xs text-muted-foreground">
          {t("viewer.revision", { sha: document.commitSha.slice(0, 12) })}
        </p>
      )}
      <MarkdownView markdown={document.markdown} context={context} />
      {document.documentCitations.length > 0 && (
        <section className="max-w-[72ch] space-y-2 border-t pt-4">
          <h2 className="text-sm font-medium">{t("viewer.citations")}</h2>
          <ul className="list-disc space-y-1 pl-6 text-sm">
            {document.documentCitations.map((citation, index) => {
              const href = citationHref(citation.target, context);
              return (
                <li key={index} className="break-all">
                  {href ? (
                    <a
                      href={href}
                      onClick={
                        href.startsWith("/")
                          ? routerClick(() => {
                              void router.navigate({ href });
                            })
                          : undefined
                      }
                      rel="noopener noreferrer nofollow"
                      referrerPolicy="no-referrer"
                      target={href.startsWith("http") ? "_blank" : undefined}
                      className="underline underline-offset-4"
                    >
                      {citation.label}
                    </a>
                  ) : (
                    <span>{citation.label}</span>
                  )}{" "}
                  <span className="text-muted-foreground">{citation.target}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}
