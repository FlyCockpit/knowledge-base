import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PublicShell } from "@/components/public-shell";
import { ensureSessionHint } from "@/lib/session-hint";

export const Route = createFileRoute("/$lang/_public")({
  // Seed the session-cookie hint before any public page renders, so the
  // header's action ("Sign In" or "Open app") is already right in the SSR HTML
  // of a cookie-bearing request, and the landing page's redirect reads this
  // same cache entry (lib/session-hint.ts). An anonymous request renders the
  // anonymous header, identical for every visitor and cacheable; ssr-cache.ts
  // never caches a request that carries a Better-Auth cookie.
  // docs/ui.md § Public header session hint.
  beforeLoad: async ({ context }) => {
    await ensureSessionHint(context.queryClient);
  },
  component: PublicLayout,
});

// Header, the one page scroller and the footer live in the shared public shell
// (also used by the 404). See docs/ui.md § Shell rules.
function PublicLayout() {
  return (
    <PublicShell>
      <Outlet />
    </PublicShell>
  );
}
