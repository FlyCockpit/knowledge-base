import { Button } from "@knowledge-base/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@knowledge-base/ui/components/dropdown-menu";
import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useTheme } from "@/components/theme-provider";

const THEMES = ["light", "dark", "system"] as const;
type ThemeChoice = (typeof THEMES)[number];

/** next-themes reports `undefined` before it reads storage: that is "system". */
export function currentThemeChoice(theme: string | undefined): ThemeChoice {
  return THEMES.find((choice) => choice === theme) ?? "system";
}

/**
 * The real Base UI theme menu. The choices are radio items (role
 * `menuitemradio`, `aria-checked`, a check mark) bound to the stored theme,
 * so the menu shows which one is in force. Lazy-loaded by `mode-toggle.tsx` on first
 * interaction so the shared Base UI overlay chunk stays off the eager bundle.
 * It mounts `defaultOpen` so the click that triggered the load opens the menu
 * immediately — no effect choreography, no second click.
 */
export default function ModeToggleMenu() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation("nav");

  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon-touch" />}>
        <Sun className="size-[1.2rem] scale-100 rotate-0 transition-transform dark:scale-0 dark:-rotate-90" />
        <Moon className="absolute size-[1.2rem] scale-0 rotate-90 transition-transform dark:scale-100 dark:rotate-0" />
        <span className="sr-only">{t("themeToggle.label")}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={currentThemeChoice(theme)}
          onValueChange={(value: ThemeChoice) => setTheme(value)}
        >
          {THEMES.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice} closeOnClick>
              {t(`themeToggle.${choice}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
