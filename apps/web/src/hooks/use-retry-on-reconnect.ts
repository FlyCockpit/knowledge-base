import { useEffect, useEffectEvent } from "react";

/**
 * Calls `retry` once when the browser fires `online`, while `enabled`. For
 * offline error states that promise "this will load when you reconnect".
 */
export function useRetryOnReconnect(retry: () => void, enabled: boolean): void {
  const onOnline = useEffectEvent(retry);
  useEffect(() => {
    if (!enabled) return;
    const listener = () => onOnline();
    window.addEventListener("online", listener, { once: true });
    return () => window.removeEventListener("online", listener);
  }, [enabled]);
}
