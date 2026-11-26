import { createFileRoute, redirect } from "@tanstack/react-router";

import { APP_HOME } from "@/lib/app-home";

/**
 * `/$lang/dashboard` was the signed-in home before the home became the
 * knowledge bases list (`APP_HOME`, lib/app-home.ts). Bookmarks and installed
 * shortcuts still point here, so this route only forwards them: no page, no
 * session lookup. `APP_HOME` sits under the `_auth` gate, which sends a
 * signed-out visitor to sign-in from there. docs/ui.md § The signed-in home.
 */
export const Route = createFileRoute("/$lang/dashboard")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: APP_HOME, params: { lang: params.lang }, replace: true });
  },
});
