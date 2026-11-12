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
      !isValidElement<{ children: ReactNode; render: ReactElement<{ className: string }> }>(close)
    )
      throw new Error("Missing close button");
    const out = renderToStaticMarkup(close.props.children);
    expect(out).toContain(esCommon.actions.close);
    expect(out).not.toContain(">Close<");
    // 28px icon + 8px expansion on each side = 44px target.
    expect(close.props.render.props.className).toContain("after:-inset-2");
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
