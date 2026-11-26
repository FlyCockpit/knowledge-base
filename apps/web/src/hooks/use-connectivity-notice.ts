import { useSyncExternalStore } from "react";

import {
  type ConnectivityNotice,
  type ConnectivityNoticeStore,
  createConnectivityNotice,
} from "@/lib/connectivity-notice";

let store: ConnectivityNoticeStore | undefined;

function getStore(): ConnectivityNoticeStore {
  store ??= createConnectivityNotice(window, () => window.navigator.onLine);
  return store;
}

const subscribe = (listener: () => void) => getStore().subscribe(listener);
const getSnapshot = () => getStore().getSnapshot();
// SSR and hydration render the empty band; the client catches up on mount.
const getServerSnapshot = (): ConnectivityNotice => null;

/** The offline band's state: "offline", a short "back-online", or null. */
export function useConnectivityNotice(): ConnectivityNotice {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
