import { Button } from "@knowledge-base/ui/components/button";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { KbRenderedDocument, type KbViewerDocument } from "@/components/kb/markdown-view";
import { isRenderableMime, kbAssetUrl, MediaEmbed } from "@/components/kb/media";
import { LoadMore } from "@/components/load-more";
import { useKbAccessLoss } from "@/hooks/use-kb-editor";
import type {
  AssetDelta,
  FileDelta,
  PrReviewSources,
  PrSummary,
  ReviewedDiff,
} from "@/hooks/use-pr-review";

/** Markdown cards rendered without a click; the rest render on demand (read budget). */
const AUTO_RENDER = 10;

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/**
 * Supplementary line diff (common prefix/suffix, changed middle). The rendered
 * before/after pair is the review surface; this is never a substitute for it.
 */
export function lineDiff(before: string | null, after: string | null): DiffLine[] {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [
    ...a.slice(0, start).map((text) => ({ kind: "same" as const, text })),
    ...a.slice(start, endA).map((text) => ({ kind: "removed" as const, text })),
    ...b.slice(start, endB).map((text) => ({ kind: "added" as const, text })),
    ...a.slice(endA).map((text) => ({ kind: "same" as const, text })),
  ];
}

export function PrDiffProgress({
  count,
  complete,
  drift,
}: {
  count: number;
  complete: boolean;
  drift: boolean;
}) {
  const { t } = useTranslation("kb");
  if (drift)
    return (
      <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm">
        {t("pr.diff.drift")}
      </p>
    );
  return complete ? (
    <p data-testid="pr-diff-complete" className="text-sm text-muted-foreground">
      {t("pr.diff.complete", { count })}
    </p>
  ) : (
    <p data-testid="pr-diff-incomplete" role="status" className="text-sm font-medium">
      {t("pr.diff.incomplete", { count })}
    </p>
  );
}

function AssetSide({
  kbId,
  asset,
  rev,
  label,
}: {
  kbId: string;
  asset: AssetDelta["before"];
  rev: string;
  label: string;
}) {
  const { t } = useTranslation("kb");
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {asset ? (
        <>
          <p className="break-all font-mono text-xs">{asset.hash}</p>
          <p className="text-xs text-muted-foreground">
            {asset.mime} · {t("pr.assets.size", { size: asset.size })}
          </p>
          {isRenderableMime(asset.mime) ? (
            <MediaEmbed asset={asset} url={kbAssetUrl(kbId, asset.hash, rev)} alt={asset.path} />
          ) : (
            <p className="text-xs text-muted-foreground">{t("pr.assets.noPreview")}</p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("pr.assets.absent")}</p>
      )}
    </div>
  );
}

/** One touched asset: exact before/after manifest hashes, previews bound to base/head. */
export function PrAssetDeltaRow({
  kbId,
  baseSha,
  headSha,
  delta,
}: {
  kbId: string;
  baseSha: string;
  headSha: string;
  delta: AssetDelta;
}) {
  const { t } = useTranslation("kb");
  const kind = !delta.before ? "added" : !delta.after ? "removed" : "replaced";
  return (
    <li data-testid="pr-asset" data-path={delta.path} className="space-y-2 p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded border px-1.5 text-xs">{t(`pr.assets.${kind}`)}</span>
        <span className="break-all font-mono">{delta.path}</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <AssetSide kbId={kbId} asset={delta.before} rev={baseSha} label={t("pr.before")} />
        <AssetSide kbId={kbId} asset={delta.after} rev={headSha} label={t("pr.after")} />
      </div>
    </li>
  );
}

/** Rendered Markdown at the base (before) and head (after) revisions, via the safe viewer. */
export function PrRenderedPair({
  lang,
  kbId,
  before,
  after,
}: {
  lang: string;
  kbId: string;
  before: KbViewerDocument | null;
  after: KbViewerDocument | null;
}) {
  const { t } = useTranslation("kb");
  const fragmentPrefix = `pr-${useId()}-`;
  const side = (doc: KbViewerDocument | null, label: string, testId: string, absent: string) => (
    <section data-testid={testId} className="min-w-0 space-y-2 rounded-md border p-3">
      <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
      {doc ? (
        <KbRenderedDocument
          lang={lang}
          kbId={kbId}
          document={doc}
          fragmentPrefix={`${fragmentPrefix}${testId}-`}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{absent}</p>
      )}
    </section>
  );
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {side(before, t("pr.before"), "pr-before", t("pr.absentBefore"))}
      {side(after, t("pr.after"), "pr-after", t("pr.absentAfter"))}
    </div>
  );
}

/** Same key shape as `orpc.documents.get.queryOptions`, so access loss clears it. */
const documentKey = (input: { kbId: string; path: string; rev: string }) =>
  [["documents", "get"], { input, type: "query" }] as const;

function PrFileCard({
  lang,
  kbId,
  pr,
  file,
  loadDocument,
  autoRender,
}: {
  lang: string;
  kbId: string;
  pr: PrSummary;
  file: FileDelta;
  loadDocument: PrReviewSources["loadDocument"];
  autoRender: boolean;
}) {
  const { t } = useTranslation("kb");
  const markdown = file.path.toLowerCase().endsWith(".md");
  const [open, setOpen] = useState(autoRender);
  const [showText, setShowText] = useState(false);
  const read = (rev: string, present: boolean) => {
    const input = { kbId, path: file.path, rev };
    return {
      queryKey: documentKey(input),
      queryFn: () => loadDocument(input),
      enabled: markdown && open && present,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    };
  };
  // Bodies are addressed by immutable commit SHA: base for "before", head for "after".
  const needBefore = file.beforeBlobSha !== null;
  const needAfter = file.afterBlobSha !== null;
  const before = useQuery(read(pr.baseSha, needBefore));
  const after = useQuery(read(pr.headSha, needAfter));
  // Only a side this card actually reads can report a denial; an absent side's
  // cache (never read here) must not trigger the KB access check.
  useKbAccessLoss(kbId, [needBefore ? before.error : null, needAfter ? after.error : null]);
  const loading = (needBefore && before.isPending) || (needAfter && after.isPending);
  const failed = (needBefore && before.isError) || (needAfter && after.isError);
  return (
    <li data-testid="pr-file" data-path={file.path} className="min-w-0 space-y-3 p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded border px-1.5 text-xs">{t(`pr.files.${file.status}`)}</span>
        <span className="break-all font-mono">{file.path}</span>
      </p>
      {!markdown ? (
        <p className="text-xs text-muted-foreground">{t("pr.files.notMarkdown")}</p>
      ) : !open ? (
        <Button variant="outline" className="min-h-[44px]" onClick={() => setOpen(true)}>
          {t("pr.files.render")}
        </Button>
      ) : failed ? (
        <InlineRetry
          message={t("pr.files.loadFailed")}
          onRetry={() => {
            if (needBefore) void before.refetch();
            if (needAfter) void after.refetch();
          }}
        />
      ) : loading ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <PrRenderedPair
            lang={lang}
            kbId={kbId}
            before={needBefore ? (before.data ?? null) : null}
            after={needAfter ? (after.data ?? null) : null}
          />
          <Button
            data-testid="pr-text-diff-toggle"
            variant="ghost"
            className="min-h-[44px]"
            aria-expanded={showText}
            // One toggle per file: the name says which (R2-19).
            aria-label={t(showText ? "pr.files.hideTextDiffNamed" : "pr.files.showTextDiffNamed", {
              path: file.path,
            })}
            onClick={() => setShowText((v) => !v)}
          >
            {showText ? t("pr.files.hideTextDiff") : t("pr.files.showTextDiff")}
          </Button>
          {showText && (
            <div
              data-testid="pr-text-diff"
              className="overflow-x-auto overflow-y-hidden whitespace-pre rounded-md border p-3 font-mono text-xs"
            >
              {lineDiff(
                needBefore ? (before.data?.markdown ?? "") : null,
                needAfter ? (after.data?.markdown ?? "") : null,
              ).map((line, index) => (
                <span
                  key={index}
                  className={
                    line.kind === "added"
                      ? "block bg-green-500/10"
                      : line.kind === "removed"
                        ? "block bg-red-500/10"
                        : "block"
                  }
                >
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
                  {line.text}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </li>
  );
}

/** The reviewed diff: rendered file pairs, touched assets and explicit pagination state. */
export function PrDiff({
  lang,
  kbId,
  diff,
  loadDocument,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  lang: string;
  kbId: string;
  diff: ReviewedDiff;
  loadDocument: PrReviewSources["loadDocument"];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation("kb");
  const count = diff.files.length + diff.touchedAssets.length;
  let markdownSeen = 0;
  return (
    <div className="min-w-0 space-y-6">
      <PrDiffProgress count={count} complete={diff.complete} drift={diff.drift} />
      <section className="min-w-0 space-y-2" aria-labelledby="pr-files">
        <h3 id="pr-files" className="font-semibold">
          {t("pr.files.title")}
        </h3>
        {diff.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("pr.files.none")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {diff.files.map((file) => {
              const auto = file.path.toLowerCase().endsWith(".md") && markdownSeen++ < AUTO_RENDER;
              return (
                <PrFileCard
                  key={file.path}
                  lang={lang}
                  kbId={kbId}
                  pr={diff.pr}
                  file={file}
                  loadDocument={loadDocument}
                  autoRender={auto}
                />
              );
            })}
          </ul>
        )}
      </section>
      <section className="min-w-0 space-y-2" aria-labelledby="pr-assets-title">
        <h3 id="pr-assets-title" className="font-semibold">
          {t("pr.assets.title")}
        </h3>
        {diff.touchedAssets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("pr.assets.none")}</p>
        ) : (
          <ul data-testid="pr-assets" className="divide-y rounded-md border">
            {diff.touchedAssets.map((delta) => (
              <PrAssetDeltaRow
                key={delta.path}
                kbId={kbId}
                baseSha={diff.pr.baseSha}
                headSha={diff.pr.headSha}
                delta={delta}
              />
            ))}
          </ul>
        )}
      </section>
      {!diff.drift && hasNextPage && (
        <div data-testid="pr-load-more-wrap">
          <LoadMore
            hasNextPage
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={onLoadMore}
            label={t("pr.diff.loadMore")}
          />
        </div>
      )}
    </div>
  );
}
