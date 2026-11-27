import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export function useRedirectWhenAuthenticated({
  status,
  href,
  enabled,
}: {
  status: string;
  href: string;
  enabled: boolean;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    if (enabled && status === "authenticated") void navigate({ href, replace: true });
  }, [enabled, status, href, navigate]);
}
