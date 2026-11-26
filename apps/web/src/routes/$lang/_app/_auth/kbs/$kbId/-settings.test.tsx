import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
// @ts-expect-error — TanStack exposes the private route component through this Vite split module.
import { component as Component } from "./settings?tsr-split=component";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  props: undefined as
    | undefined
    | { accept?: string; onShareAccepted?: (kbId: string) => void; kbId: string },
}));
vi.mock("@tanstack/react-router", () => ({
  lazyRouteComponent: () => () => null,
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ lang: "es-MX", kbId: "kb-from-link" }),
    useSearch: () => ({ accept: REQUEST }),
    useNavigate: () => fixture.navigate,
  }),
}));
vi.mock("@/components/kb/members-panel", () => ({
  KB_SETTINGS_TABS: ["members", "search", "sealed", "mirror"],
  KbSettingsView: (props: NonNullable<typeof fixture.props>) => {
    fixture.props = props;
    return null;
  },
}));

it("opens the accepted KB's documents after a share invitation is accepted", () => {
  renderToStaticMarkup(<Component />);
  expect(fixture.props?.accept).toBe(REQUEST);
  fixture.props?.onShareAccepted?.("kb-accepted");
  expect(fixture.navigate).toHaveBeenCalledWith({
    to: "/$lang/kbs/$kbId",
    params: { lang: "es-MX", kbId: "kb-accepted" },
    replace: true,
  });
});
