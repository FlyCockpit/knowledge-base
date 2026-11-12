import { type ComponentProps, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import LanguageSwitcherSelect from "./language-switcher-select";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  changeLanguage: vi.fn(),
  setItem: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: fixture.navigate }) }));
vi.mock("@tanstack/react-query", () => ({ useMutation: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: "anonymous" } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en-US", changeLanguage: fixture.changeLanguage },
  }),
}));

function Harness() {
  const element = LanguageSwitcherSelect();
  if (
    !isValidElement<ComponentProps<typeof import("@knowledge-base/ui/components/select").Select>>(
      element,
    )
  )
    throw new Error("Missing locale select");
  element.props.onValueChange?.(
    "es-MX",
    {} as Parameters<NonNullable<typeof element.props.onValueChange>>[1],
  );
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("keeps the current document, search, fragment and scroll position while switching languages", () => {
  vi.stubGlobal("window", {
    location: { pathname: "/en-US/kbs/one/documents" },
    localStorage: { setItem: fixture.setItem },
  });

  renderToStaticMarkup(<Harness />);
  const options = fixture.navigate.mock.calls[0]![0];
  expect(options.hash).toBe(true);
  expect(options.resetScroll).toBe(false);
  expect(options.replace).toBe(true);
  expect(options.params({ lang: "en-US", kbId: "one" })).toEqual({ lang: "es-MX", kbId: "one" });
  expect(options.search({ path: "guide.md", rev: "sha" })).toEqual({
    path: "guide.md",
    rev: "sha",
  });
});
