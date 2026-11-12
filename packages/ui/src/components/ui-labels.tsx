import * as React from "react";

const UiLabelsContext = React.createContext<{ close: string }>({ close: "Close" });

export function UiLabelsProvider({
  labels,
  children,
}: {
  labels: { close: string };
  children: React.ReactNode;
}) {
  return <UiLabelsContext.Provider value={labels}>{children}</UiLabelsContext.Provider>;
}

export function useUiLabels() {
  return React.useContext(UiLabelsContext);
}
