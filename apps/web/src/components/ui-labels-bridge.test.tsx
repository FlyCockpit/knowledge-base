import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import esCommon from "@knowledge-base/locales/src/es-MX/common.json";
import { AlertDialogContent } from "@knowledge-base/ui/components/alert-dialog";
import { DialogContent } from "@knowledge-base/ui/components/dialog";
import { SheetContent } from "@knowledge-base/ui/components/sheet";
import { createInstance } from "i18next";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { UiLabelsBridge } from "./ui-labels-bridge";

type PopupProps = { className?: string; children?: ReactNode };
// Capture the real popup element before its portal (SSR portals render nothing).
function PopupHarness({
  useContent,
  sink,
}: {
  useContent: typeof DialogContent | typeof SheetContent | typeof AlertDialogContent;
  /** Receives the popup element (a holder, not a callback: nothing is called during render). */
  sink: { popup?: ReactElement<PopupProps> };
}) {
  const root = useContent({ children: "Body" });
  if (!isValidElement<{ children: ReactNode }>(root)) throw new Error("Missing portal");
  const candidate = Children.toArray(root.props.children).find(
    (child) =>
      isValidElement<{ "data-slot"?: string }>(child) &&
      child.props["data-slot"]?.endsWith("content"),
  );
  if (!isValidElement<PopupProps>(candidate)) throw new Error("Missing popup");
  sink.popup = candidate;
  return null;
}
async function inspect(
  language: string,
  useContent: typeof DialogContent | typeof SheetContent | typeof AlertDialogContent,
) {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    resources: { "en-US": { common: enCommon }, "es-MX": { common: esCommon } },
    defaultNS: "common",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  const sink: { popup?: ReactElement<PopupProps> } = {};

  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UiLabelsBridge>
        <PopupHarness useContent={useContent} sink={sink} />
      </UiLabelsBridge>
    </I18nextProvider>,
  );
  const { popup } = sink;
  if (!popup) throw new Error("Popup not inspected");
  return popup.props;
}

/**
 * The popup's direct children, with the dialog's sticky close anchor
 * (`dialog-close-anchor`, which keeps the button in the corner while the body
 * scrolls) unwrapped, so the close button is found wherever the popup puts it.
 */
function popupChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<{ "data-slot"?: string; children?: ReactNode }>(child) &&
    child.props["data-slot"] === "dialog-close-anchor"
      ? Children.toArray(child.props.children)
      : [child],
  );
}

describe("modal accessibility", () => {
  it.each([
    ["dialog", DialogContent],
    ["sheet", SheetContent],
  ] as const)("translates the shared close label for %s", async (_name, Content) => {
    const popup = await inspect("es-MX", Content);
    const close = popupChildren(popup.children).find(
      (child) =>
        isValidElement<{ "data-slot"?: string }>(child) &&
        child.props["data-slot"]?.endsWith("close"),
    );
    if (
      !isValidElement<{
        children: ReactNode;
        render: ReactElement<{ className: string; size?: string }>;
      }>(close)
    )
      throw new Error("Missing close button");
    const out = renderToStaticMarkup(close.props.children);
    expect(out).toContain(esCommon.actions.close);
    expect(out).not.toContain(">Close<");
    const { className, size } = close.props.render.props;
    // Flush with a clipping edge, so the focus ring is drawn inside the box.
    expect(className).toContain("focus-visible:ring-inset");
    expect(className).toContain("focus-visible:ring-offset-0");
    if (_name === "dialog") {
      // A 44px square centred on the 28px button. An inset expansion starts at
      // the padding box, inside the 1px border (`-inset-2` gave 42px).
      expect(size).toBe("icon-sm");
      for (const part of [
        "absolute",
        "top-3",
        "right-2",
        "after:absolute",
        "after:top-1/2",
        "after:left-1/2",
        "after:size-11",
        "after:-translate-x-1/2",
        "after:-translate-y-1/2",
      ])
        expect(className.split(" ")).toContain(part);
      expect(className).not.toMatch(/after:-?inset-/);
    } else {
      // A 44px button flush with the edge, centred on the header title.
      expect(size).toBe("icon-touch");
      for (const part of ["absolute", "top-1", "right-0"])
        expect(className.split(" ")).toContain(part);
    }
  });
  it("bounds the alert popup and contains both scroll axes", async () => {
    const out = (await inspect("en-US", AlertDialogContent)).className;
    expect(out).toContain("max-h-[calc(100svh");
    expect(out).toContain("--safe-area-top");
    expect(out).toContain("--safe-area-bottom");
    expect(out).toContain("overflow-y-auto");
    expect(out).toContain("overflow-x-hidden");
    expect(out).toContain("overscroll-contain");
  });
  it("bounds the dialog popup and scrolls only its body, both axes contained", async () => {
    const popup = await inspect("en-US", DialogContent);
    expect(popup.className).toContain("max-h-[calc(100svh");
    expect(popup.className).toContain("--safe-area-top");
    expect(popup.className).toContain("--safe-area-bottom");
    expect(popup.className).toContain("overflow-hidden");
    expect(popup.className).not.toContain("overflow-y-auto");
    const body = popupChildren(popup.children).find(
      (child) =>
        isValidElement<{ "data-slot"?: string }>(child) &&
        child.props["data-slot"] === "dialog-body",
    );
    if (!isValidElement<{ className: string }>(body)) throw new Error("Missing dialog body");
    for (const part of ["min-h-0", "overflow-y-auto", "overflow-x-hidden", "overscroll-contain"])
      expect(body.props.className.split(" ")).toContain(part);
  });
});
