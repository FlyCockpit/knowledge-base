import { useEffect, useEffectEvent, useRef } from "react";

/**
 * Calls `retry` once each time `offline` turns from true to false. For
 * offline error states that promise "this will load when you reconnect".
 *
 * It follows the status value (`!useNetworkStatus()`), not a second `online`
 * listener: the status store's own listener runs first and re-renders
 * synchronously, and the effect cleanup that follows removed a later listener
 * in the middle of the same dispatch, so the retry never ran.
 */
export function useRetryOnReconnect(retry: () => void, offline: boolean): void {
  const onReconnect = useEffectEvent(retry);
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) onReconnect();
    wasOffline.current = offline;
  }, [offline]);
}
