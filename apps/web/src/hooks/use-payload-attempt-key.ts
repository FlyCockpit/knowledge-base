import { useRef } from "react";

const newKey = () => crypto.randomUUID();

/** Keeps one idempotency key per identical payload until the server answers. */
export function usePayloadAttemptKey() {
  const ref = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    keyFor(payload: unknown) {
      const fingerprint = JSON.stringify(payload);
      if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, key: newKey() };
      return ref.current.key;
    },
    settle() {
      ref.current = null;
    },
  };
}
