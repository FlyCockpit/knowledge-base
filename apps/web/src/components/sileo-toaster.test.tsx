import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import esSettings from "@knowledge-base/locales/src/es-MX/settings.json";
import { Toaster, toast } from "@knowledge-base/ui/components/sileo";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * The text a screen reader derives for each toast button: its content minus
 * subtrees hidden with aria-hidden, plus any SVG <title> left in the markup.
 */
function toastNames(markup: string) {
  const buttons = markup.match(/<button[^>]*data-sileo-toast[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return buttons.map((button) => {
    let visible = button;
    // Drop aria-hidden SVGs (decorative; never part of the accessible name).
    visible = visible.replace(/<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>/g, "");
    return visible
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  });
}

describe("Toaster accessible names", () => {
  it("has no English library labels: every decorative SVG is hidden and untitled", () => {
    toast.success(enSettings.credentials.revokeSuccess);
    toast.error(enSettings.credentials.revokeError);
    toast.info(enSettings.credentials.revokeSuccess);
    toast.warning(enSettings.credentials.revokeSuccess);
    toast.message(enSettings.credentials.revokeSuccess);
    const markup = renderToStaticMarkup(<Toaster />);
    expect(markup).toContain("data-sileo-toast");
    expect(markup).not.toContain("<title");
    expect(markup).not.toMatch(/sileo notification/i);
    for (const svg of markup.match(/<svg[^>]*>/g) ?? []) {
      expect(svg).toContain('aria-hidden="true"');
    }
    toast.clear();
  });

  it("names a toast by its localized message alone in every shipped locale", () => {
    for (const settings of [enSettings, esSettings]) {
      const message = settings.credentials.revokeSuccess;
      toast.clear();
      toast.success(message);
      const names = toastNames(renderToStaticMarkup(<Toaster />));
      expect(names.at(-1)).toBe(message);
    }
    expect(esSettings.credentials.revokeSuccess).not.toBe(enSettings.credentials.revokeSuccess);
    toast.clear();
  });
});
