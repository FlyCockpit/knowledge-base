import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { orpc } from "@/utils/orpc";

import { useKbRecentChanges } from "./use-kb-recent-changes";

vi.mock("@/hooks/use-kb-editor", () => ({ useKbAccessLoss: () => false }));

const KB = "k".repeat(24);

function Feed() {
  useKbRecentChanges(KB, true);
  return null;
}

describe("useKbRecentChanges", () => {
  it("drops the feed once nothing shows it, so a later visit never reads an old one", () => {
    const client = new QueryClient();
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Feed />
      </QueryClientProvider>,
    );
    const [query] = client
      .getQueryCache()
      .findAll({ queryKey: orpc.documents.recentChanges.key({ input: { kbId: KB } }) });
    expect(query?.options.gcTime).toBe(0);
  });
});
