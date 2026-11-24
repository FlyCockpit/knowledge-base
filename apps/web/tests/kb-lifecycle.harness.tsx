/** Mounted production consumers for resource/selection lifecycle regression tests. */
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { KbRenderedDocument, MarkdownView } from "@/components/kb/markdown-view";
import { PrAssetDeltaRow, PrRenderedPair } from "@/components/kb/pr-diff";

const KB = "a".repeat(24);
const asset = {
  path: "media/pic.png",
  hash: `sha256:${"1".repeat(64)}`,
  size: 1,
  mime: "image/png",
};
const mode = new URLSearchParams(location.search).get("mode");
const i18n = createInstance();
await i18n.init({
  lng: "en-US",
  ns: ["kb", "common"],
  resources: { "en-US": { kb: enKb, common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
function Lifecycle() {
  const [selection, setSelection] = useState("A");
  const [mounted, setMounted] = useState(true);
  const rev = (selection === "A" ? "1" : "2").repeat(40);
  let assets = [asset];
  let markdown = "![picture](../media/pic.png)";
  if (mode === "volume") {
    assets = Array.from({ length: 8192 }, (_, i) => ({ ...asset, path: `media/${i}.png` }));
    markdown =
      assets.map((a) => `[asset](../${a.path})\n`).join("") +
      `[repeat](../media/8191.png)\n`.repeat(10000);
    markdown += `\n${"bounded prose ".repeat(Math.floor((2 * 1024 * 1024 - markdown.length - 1) / 14))}`;
  }
  const doc = {
    path: "notes/a.md",
    markdown,
    commitSha: rev,
    documentCitations: [],
    assetRefs: assets,
  };
  return (
    <main>
      <button type="button" onClick={() => setSelection("A")}>
        Select A
      </button>
      <button type="button" onClick={() => setSelection("B")}>
        Select B
      </button>
      <button type="button" onClick={() => setMounted(!mounted)}>
        Toggle mount
      </button>
      <p data-testid="selection">{selection}</p>
      {mounted &&
        (mode === "preview" ? (
          <MarkdownView
            markdown={markdown}
            context={{ lang: "en-US", kbId: KB, rev, documentPath: doc.path, assets, draft: true }}
          />
        ) : mode === "pr-asset" ? (
          <ul>
            <PrAssetDeltaRow
              kbId={KB}
              baseSha={rev}
              headSha={rev}
              delta={{ path: asset.path, before: asset, after: null }}
            />
          </ul>
        ) : mode === "pr-document" ? (
          <PrRenderedPair lang="en-US" kbId={KB} before={doc} after={null} />
        ) : (
          <KbRenderedDocument lang="en-US" kbId={KB} document={doc} />
        ))}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <I18nextProvider i18n={i18n}>
      <Lifecycle />
    </I18nextProvider>
  </QueryClientProvider>,
);
