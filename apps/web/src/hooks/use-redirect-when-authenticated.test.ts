import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));
const { useRedirectWhenAuthenticated } = await import("./use-redirect-when-authenticated");

describe("useRedirectWhenAuthenticated", () => {
  beforeEach(() => navigate.mockClear());
  it("replaces the anonymous page when a session arrives", () => {
    useRedirectWhenAuthenticated({ status: "anonymous", href: "/en-US/kbs", enabled: true });
    expect(navigate).not.toHaveBeenCalled();
    useRedirectWhenAuthenticated({ status: "authenticated", href: "/en-US/kbs", enabled: true });
    expect(navigate).toHaveBeenCalledWith({ href: "/en-US/kbs", replace: true });
  });
  it("does not interrupt a disabled challenge", () => {
    useRedirectWhenAuthenticated({ status: "authenticated", href: "/en-US/kbs", enabled: false });
    expect(navigate).not.toHaveBeenCalled();
  });
});
