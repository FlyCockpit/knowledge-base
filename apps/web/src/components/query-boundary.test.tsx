import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { QueryBoundary } from "@/components/query-boundary";

/**
 * The regression this file guards: TanStack Query keeps the last successful
 * `data` when a background refetch (or `fetchNextPage`) fails, and sets
 * `status: "error"` at the same time. An `if (isError)` branch that runs before
 * the data check throws the already-rendered list away.
 */
describe("QueryBoundary", () => {
  const i18n = createInstance();

  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["common"],
      defaultNS: "common",
      resources: { "en-US": { common: enCommon } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });

  function render(query: {
    data: string[] | undefined;
    isPending: boolean;
    isError: boolean;
    error?: unknown;
  }): string {
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <QueryBoundary
          query={{ ...query, refetch: () => undefined }}
          skeleton={<div>SKELETON</div>}
          errorMessage="Failed to load posts."
          isEmpty={(data) => data.length === 0}
          empty={<div>EMPTY</div>}
        >
          {(data) => (
            <ul>
              {data.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </I18nextProvider>,
    );
  }

  it("renders the skeleton while pending", () => {
    const html = render({ data: undefined, isPending: true, isError: false });
    expect(html).toContain("SKELETON");
    expect(html).not.toContain("Failed to load posts.");
  });

  it("renders the retry card when the first load fails", () => {
    const html = render({ data: undefined, isPending: false, isError: true });
    expect(html).toContain("Failed to load posts.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("EMPTY");
  });

  it("keeps rendered data when a refetch fails, and shows retry above it", () => {
    const html = render({ data: ["alpha", "beta"], isPending: false, isError: true });
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).toContain("Failed to load posts.");
    // The retry banner precedes the content it belongs to.
    expect(html.indexOf("Failed to load posts.")).toBeLessThan(html.indexOf("alpha"));
  });

  it("renders the empty state when a refetch fails over an empty result", () => {
    const html = render({ data: [], isPending: false, isError: true });
    expect(html).toContain("EMPTY");
    expect(html).toContain("Failed to load posts.");
  });

  it("renders children on success", () => {
    const html = render({ data: ["alpha"], isPending: false, isError: false });
    expect(html).toContain("alpha");
    expect(html).not.toContain("Failed to load posts.");
  });

  it("renders the empty state on an empty success", () => {
    const html = render({ data: [], isPending: false, isError: false });
    expect(html).toContain("EMPTY");
  });
  it.each(["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"])(
    "hides retained private rows after %s",
    (code) => {
      const out = render({
        data: ["private alpha"],
        isPending: false,
        isError: true,
        error: { code },
      });
      expect(out).not.toContain("private alpha");
      expect(out).toContain("Try again");
    },
  );
});
