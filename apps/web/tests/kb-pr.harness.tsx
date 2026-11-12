/**
 * Browser-suite harness for rendered PR review: mounts the production
 * `PrReviewPanel` against the fixture's PR endpoints, which call the real
 * `getPullRequest` / PR publication services as the cookie's user.
 */
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { KbViewerDocument } from "@/components/kb/markdown-view";
import { PrReviewPanel } from "@/components/kb/pr-actions";
import { type PrPage, type PrReviewSources, usePrReview } from "@/hooks/use-pr-review";

const params = new URLSearchParams(window.location.search);
const kbId = params.get("kbId") ?? "";
const number = Number(params.get("number"));
const i18n = createInstance();
await i18n.init({
  lng: "en-US",
  fallbackLng: "en-US",
  ns: ["kb", "common"],
  defaultNS: "kb",
  resources: { "en-US": { kb: enKb, common: enCommon } },
  interpolation: { escapeValue: false },
});

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  // Same shape as an oRPC error: `data` is the router's error data.
  if (!response.ok) throw Object.assign(new Error(body.code), { data: body });
  return body as T;
}

const viewer = await json<{ actorKey: string; bits: string[] }>(
  await fetch(`/fixture/pr-viewer?${new URLSearchParams({ kbId })}`),
);
const sources: PrReviewSources = {
  pageKey: ["fixture", "pr", kbId, number],
  fetchPage: async (cursor) =>
    json<PrPage>(
      await fetch(
        `/fixture/pr?${new URLSearchParams({ kbId, number: String(number), cursor: cursor ?? "" })}`,
      ),
    ),
  review: async (input) =>
    json(
      await fetch("/fixture/pr-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ),
  loadDocument: async (input) =>
    json<KbViewerDocument>(await fetch(`/fixture/document?${new URLSearchParams(input)}`)),
};

function Harness() {
  // This fixture's actor is fixed for the entire document lifetime.
  const review = usePrReview({
    kbId,
    actor: { key: viewer.actorKey, isCurrent: () => true },
    sources,
  });
  return (
    <PrReviewPanel
      lang="en-US"
      kbId={kbId}
      number={number}
      bits={viewer.bits}
      viewerActorKey={viewer.actorKey}
      loadDocument={sources.loadDocument}
      review={review}
    />
  );
}

createRoot(window.document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <I18nextProvider i18n={i18n}>
      <main>
        <Harness />
      </main>
    </I18nextProvider>
  </QueryClientProvider>,
);
