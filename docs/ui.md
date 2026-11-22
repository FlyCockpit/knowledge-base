# UI

Layout rules for the web app that the code alone does not make obvious. The general rules (one scroller, overlays, touch targets, i18n) live in [AGENTS.md](../AGENTS.md); this file records measured values.

## Edge lines

Set 11-22 by the orchestrator's gridlines pass, owner-requested. This app follows the template's edge lines (FlyCockpit/template, `patterns/design-system.md` § Edge lines). This section lists only where this app's shell differs from them or adds containers the template does not have. Change a value only with the owner's approval, and record the new value here.

Terms are the template's. The **text line** is where labels, headings and bare icons start. The **box line** is where filled, bordered or shadowed controls start. The **trailing line** is where the last item in a row ends. An item is within tolerance when its ink is within 1px of its line. Values hold at 390px and 1440px unless a row says otherwise.

| Container | Text line | Box line | Trailing line | Centre / icon column |
|---|---|---|---|---|
| App header (`Header`, `px-4` at every width; the signed-in `MainNav` spacer is hidden below `md:` so it adds no gap) | 16px: the brand (short name below `sm:`) | — | 16px: the user menu button's box ends here | Every item centres on the header row. Measured with the default brand: a display name at the user button's `max-w-28` still ends on the 16px line down to 356px; below that the control group (`shrink-0`) runs into the trailing padding, and past the viewport edge below about 340px. |
| Signed-in sidebar, expanded (`AppSidebar`, `w-60`) | Labels at 50px (icon column plus `gap-3`) | 8px (`px-2`): the nav link boxes (`touch`, `px-3.5`) | 8px: the link boxes and the right-aligned collapse toggle (`icon-touch` in `p-2`) end here | Nav icons are `size-4`, left-aligned on one column whose box starts 22px in. The footer group (Settings, Admin) uses the same lines. |
| Signed-in sidebar, collapsed (`w-16`) | — | — | — | The 44px links (`icon-touch`, groups `items-center`) and the toggle centre on one vertical line, the rail's centre inside its 1px end border. |
| Page content (`PageShell` and the KB pages: `container mx-auto max-w-*` with `px-4`) | 16px inside the centred page container. Where the main column (right of the sidebar at `md:` and up) is wider than the container's maximum width, the container's margins come first. | Same as the text line | 16px inside the container | — |
| Section tabs (`SectionTabs` in `WideContent`: KB Documents / Pull requests / Settings; the admin section strip is a `SelectorRow` with the same spacing) | Icon and label 12px inside the tab (`px-3`) | The first tab's box starts on the page text line | The strip scrolls sideways on phones | — |
| KB settings tablist (Members, Search & index, Sealed values, Mirror) | Labels 18px inside the strip (`p-1` plus the tab's `px-3.5`) | The strip's box (`bg-muted/60 p-1`) starts on the page text line; tab boxes sit 4px inside it | The strip's box ends 4px past its last tab | — |
| KB list card (dashboard, `/kbs`) | 16px inside the card: the icon tile, then the slug and badge row | Same as the card's text line | 16px | The name and description start after the icon tile and the gap. |
| Bordered list (KB documents) | 16px inside the list: file icon, then the path | — | 16px | — |
| Markdown editor and preview | Textarea text at the field's own padding (1px border plus `px-3`, `md:px-2.5`); preview text 16px inside its 1px border | The textarea and the preview box start on their column's line | — | The "Markdown" header row is as tall as its Insert image button; the "Preview" label row is shorter, so the two labels do not share a centre line. |
| Dialog close (`DialogContent`) | — | — | The 28px button (`icon-sm` is 28px at every width here; the template has 44px on phones) ends 8px in (`right-2`). Its 16px icon box ends 14px in; the X glyph ends about 17–18px in. | Centred on the title line at every width (`top-3`). The hit expansion (`after:-inset-2`) is measured from the button's padding box (inside its 1px border), so the target is 42px and ends 1px inside the popup's clipped edge (`overflow-x-hidden`). Moving the button further out would clip it. |
| Sheet close (`SheetContent`) | — | — | Same button and placement as the dialog (`top-3 right-2`; the template uses a 44px `icon-touch` at `top-1 right-0`) | Centred on the header title (`p-4`). |

Dropdown menus (the 32px label line, the 10px icon column, `inset` for rows without an icon), the settings sub-nav (`md:-ml-3` on the track, so the icons sit on the heading's line), BottomNav and Select listboxes use the template's lines unchanged. `SegmentedControl` keeps the template's box lines (`border p-1`, toggles inside it), but its toggles have only `min-h-[44px]`, no 44px minimum width, so a short label such as "All" sits in a narrower box than the template's.

Known conflicts, left for the owner (11-22): the dialog and sheet close targets (42px) and short `SegmentedControl` toggles (no 44px minimum width) fall below the 44px mobile touch-target rule in [AGENTS.md § PWA](../AGENTS.md). Fixing them changes control or hit-area sizes, which an alignment pass does not do.

The template's two rules apply here too. Boxes share the text line inside pages, cards and forms. A miss is fixed in the container (its padding, `inset`, `px-*` on a track, or the shared close-button placement), never with a one-off margin on one item.
