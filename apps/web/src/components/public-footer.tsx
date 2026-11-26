import { ConsentPreferencesButton } from "@/components/consent/consent-preferences-button";

/**
 * The public pages' one footer, rendered by `PublicShell` after the page, never
 * by a route. `PublicShell` makes the scroller's content a `min-h-full` flex
 * column, so on a short page this sits at the bottom of the viewport and on a
 * long one it follows the content (docs/ui.md § Shell rules).
 *
 * Anonymous visitors must be able to withdraw consent as easily as they gave
 * it, and every public page, the 404 included, renders this footer. Public
 * links (privacy, terms, source) go here too. The shell's frame already pads
 * its bottom by the safe-area inset, so this footer needs no inset of its own.
 */
export function PublicFooter() {
  return (
    <footer data-public-footer className="border-t">
      <div className="container mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-2 px-4 py-4">
        <ConsentPreferencesButton />
      </div>
    </footer>
  );
}
