/**
 * Browser-suite harness: mounts the production viewer components with the
 * fixture document. Loaded only by tests/kb-browser.setup.ts (Playwright).
 */
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { KbDocumentEditor } from "@/components/kb/document-editor";
import { KbDownloads } from "@/components/kb/downloads";
import { KbRenderedDocument, type KbViewerDocument } from "@/components/kb/markdown-view";
import type { ExportCompleteInput } from "@/hooks/use-kb-export";
import { orpc } from "@/utils/orpc";

// Transport regression: invoke two real procedures in the same batch window.
Object.assign(window, {
  __r39AckWithSibling: (input: ExportCompleteInput) =>
    Promise.allSettled([
      orpc.kbExports.complete.call(input),
      orpc.kbs.get.call({ kbId: input.kbId }),
    ]),
});

const params = new URLSearchParams(window.location.search);
const kbId = params.get("kbId") ?? "";
const i18n = createInstance();
await i18n.init({
  lng: "en-US",
  fallbackLng: "en-US",
  ns: ["kb", "common"],
  defaultNS: "kb",
  resources: { "en-US": { kb: enKb, common: enCommon } },
  interpolation: { escapeValue: false },
});
const response = await fetch(`/fixture/document?${params}`, { credentials: "same-origin" });
const document: KbViewerDocument = await response.json();
/**
 * Editor: the production editing session (raw Markdown + live preview)
 * writing through the app's real `orpc.documents.*` client to the fixture's
 * real routers; the spec reads the saved bytes back.
 */
function EditorHarness() {
  const { data } = useQuery(orpc.kbs.get.queryOptions({ input: { kbId } }));
  if (!data) return null;
  return (
    <KbDocumentEditor
      lang="en-US"
      kb={data.kb}
      isNew={false}
      initialPath={document.path}
      initialMarkdown={document.markdown}
      viewingRevision={null}
      preview={{ rev: document.commitSha, assets: document.assetRefs }}
      onOpenLatest={() => {}}
    />
  );
}

createRoot(window.document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <I18nextProvider i18n={i18n}>
      <main>
        {params.get("view") === "editor" ? (
          <EditorHarness />
        ) : (
          <>
            <KbRenderedDocument lang="en-US" kbId={kbId} document={document} />
            <KbDownloads
              kbId={kbId}
              rev={document.commitSha}
              origin={window.location.origin}
              prepare={orpc.kbExports.prepare.mutationOptions()}
              complete={orpc.kbExports.complete.mutationOptions()}
            />
          </>
        )}
      </main>
    </I18nextProvider>
  </QueryClientProvider>,
);
