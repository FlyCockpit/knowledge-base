import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** Static component tests still need a real router for internal Link hrefs and useRouter. */
export function renderWithTestRouter(children: ReactNode): string {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/en-US"] }),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>{children}</RouterContextProvider>,
  );
}
