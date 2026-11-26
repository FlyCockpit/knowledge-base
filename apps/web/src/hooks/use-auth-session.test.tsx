import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SessionUnconfirmed } from "@/lib/session-unconfirmed";

import { useAuthSession } from "./use-auth-session";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    // Better Auth's atom still holds the previous account.
    useSession: () => ({
      data: { user: { id: "a", name: "Ada" } },
      isPending: false,
      isRefetching: false,
      error: null,
      refetch: vi.fn(),
    }),
    $store: { atoms: {} },
  },
}));
vi.mock("./use-network-status", () => ({ useNetworkStatus: () => true }));

function Status() {
  const { state } = useAuthSession();
  return <>{state.status === "authenticated" ? state.session.user.id : state.status}</>;
}

describe("useAuthSession", () => {
  it("reports the atom's session", () => {
    expect(renderToStaticMarkup(<Status />)).toBe("a");
  });

  it("names nobody under SessionUnconfirmed (the app shell's pending state)", () => {
    expect(
      renderToStaticMarkup(
        <SessionUnconfirmed>
          <Status />
        </SessionUnconfirmed>,
      ),
    ).toBe("pending");
  });
});
