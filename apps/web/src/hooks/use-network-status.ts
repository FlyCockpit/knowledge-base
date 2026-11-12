import { useSyncExternalStore } from "react";

const getServerSnapshot = () => true;

function getSnapshot(): boolean {
  return typeof window === "undefined" ? getServerSnapshot() : window.navigator.onLine;
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);

  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

/** Browser connectivity hint for presentation only; it does not prove reachability. */
export function useNetworkStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
