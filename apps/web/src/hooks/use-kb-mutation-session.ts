import { useLayoutEffect, useRef } from "react";

/** A mounted editing/overlay session owns UI completion, including across awaits. */
export function useKbMutationSession() {
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return active;
}
