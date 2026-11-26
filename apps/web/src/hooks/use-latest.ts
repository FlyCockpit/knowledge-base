import { useEffect, useRef } from "react";

/**
 * A ref holding the latest committed value, for async handlers that must act
 * on the state as it is when they resume (not as it was when they started).
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
