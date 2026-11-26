import enNav from "@knowledge-base/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  theme: undefined as string | undefined,
  setTheme: (_theme: string) => {},
  onValueChange: undefined as ((value: string) => void) | undefined,
}));
vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: fixture.theme, setTheme: fixture.setTheme }),
}));
// Base UI mounts the popup only once open on the client, so static markup
// cannot show it. Stand-ins record how the menu wires the real radio parts
// (which render role="menuitemradio", aria-checked and the check mark).
vi.mock("@knowledge-base/ui/components/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => {
    fixture.onValueChange = onValueChange;
    return <div data-group-value={value}>{children}</div>;
  },
  DropdownMenuRadioItem: ({
    value,
    closeOnClick,
    children,
  }: {
    value: string;
    closeOnClick?: boolean;
    children: ReactNode;
  }) => (
    <span data-radio-item={value} data-close-on-click={String(Boolean(closeOnClick))}>
      {children}
    </span>
  ),
}));

const { default: ModeToggleMenu, currentThemeChoice } = await import("./mode-toggle-menu");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { nav: enNav } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

function render(theme: string | undefined) {
  fixture.theme = theme;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ModeToggleMenu />
    </I18nextProvider>,
  );
}

describe("theme menu", () => {
  it("maps the stored theme to one choice, defaulting to system", () => {
    expect(currentThemeChoice("dark")).toBe("dark");
    expect(currentThemeChoice("light")).toBe("light");
    expect(currentThemeChoice(undefined)).toBe("system");
    expect(currentThemeChoice("sepia")).toBe("system");
  });

  it("offers the three themes as radio items checked by the current theme", () => {
    const html = render("dark");
    expect(html).toContain('data-group-value="dark"');
    const items = [
      ...html.matchAll(/data-radio-item="(\w+)" data-close-on-click="(\w+)">([^<]*)</g),
    ];
    expect(items.map(([, value, close, label]) => [value, close, label])).toEqual([
      ["light", "true", enNav.themeToggle.light],
      ["dark", "true", enNav.themeToggle.dark],
      ["system", "true", enNav.themeToggle.system],
    ]);
    expect(render(undefined)).toContain('data-group-value="system"');
  });

  it("stores the picked theme", () => {
    const setTheme = vi.fn();
    fixture.setTheme = setTheme;
    render("light");
    fixture.onValueChange?.("system");
    expect(setTheme).toHaveBeenCalledWith("system");
  });
});
