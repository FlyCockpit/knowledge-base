import { useState } from "react";

const newKey = () => crypto.randomUUID().replaceAll("-", "");

/** Retain the key for an identical retry; renew after success or a changed secret draft. */
export function useRenewableAttemptKey() {
  const [key, setKey] = useState(newKey);
  return {
    key,
    renew: () => {
      const next = newKey();
      setKey(next);
      return next;
    },
  };
}
