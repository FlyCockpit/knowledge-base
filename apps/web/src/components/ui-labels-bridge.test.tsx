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
  onPopup,
}: {
  useContent: typeof DialogContent | typeof SheetContent | typeof AlertDialogContent;
  onPopup: (popup: ReactElement<PopupProps>) => void;
}) {
  const root = useContent({ children: "Body" });
  if (!isValidElement<{ children: ReactNode }>(root)) throw new Error("Missing portal");
  const candidate = Children.toArray(root.props.children).find(
    (child) =>
      isValidElement<{ "data-slot"?: string }>(child) &&
      child.props["data-slot"]?.endsWith("content"),
  );
  if (!isValidElement<PopupProps>(candidate)) throw new Error("Missing popup");
  onPopup(candidate);
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
  let popup: ReactElement<PopupProps> | undefined;

  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UiLabelsBridge>
        <PopupHarness
          useContent={useContent}
          onPopup={(result) => {
            popup = result;
          }}
        />
      </UiLabelsBridge>
    </I18nextProvider>,
  );
  if (!popup) throw new Error("Popup not inspected");
  return popup.props;
}

describe("modal accessibility", () => {
  it.each([
    ["dialog", DialogContent],
    ["sheet", SheetContent],
  ] as const)("translates the shared close label for %s", async (_name, Content) => {
    const popup = await inspect("es-MX", Content);
    const close = Children.toArray(popup.children).find(
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
  it.each([
    ["dialog", DialogContent],
    ["alert", AlertDialogContent],
  ] as const)("bounds the popup and contains both scroll axes for %s", async (_name, Content) => {
    const out = (await inspect("en-US", Content)).className;
    expect(out).toContain("max-h-[calc(100svh");
    expect(out).toContain("--safe-area-top");
    expect(out).toContain("--safe-area-bottom");
    expect(out).toContain("overflow-y-auto");
    expect(out).toContain("overflow-x-hidden");
    expect(out).toContain("overscroll-contain");
  });
});
