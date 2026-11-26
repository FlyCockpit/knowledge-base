import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PublicShell } from "@/components/public-shell";

// Header, the one page scroller and the footer live in the shared public shell
// (also used by the 404). See docs/ui.md § Shell rules.
export const Route = createFileRoute("/$lang/_public")({
  component: PublicLayout,
});

function PublicLayout() {
  return (
    <PublicShell>
      <Outlet />
    </PublicShell>
  );
}
