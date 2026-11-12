import { type MutationObserverOptions, useMutation } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";

import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";

type SecretUiCallbacks<TData, TError> = {
  onSuccess?: (data: TData) => void;
  onError?: (error: TError) => void;
  onSettled?: () => void;
};

/** Cache closures own these slots, never a form's callback or render scope. */
export function transientSecretSessionCallbacks<TData, TError>(
  session: { current: boolean },
  busy: { current: boolean },
  ui: { current: SecretUiCallbacks<TData, TError> | null },
  settled?: () => unknown,
): Pick<MutationObserverOptions<TData, TError, void>, "onSuccess" | "onError" | "onSettled"> {
  return {
    onSuccess: (data) => {
      if (session.current) ui.current?.onSuccess?.(data);
    },
    onError: (error) => {
      if (session.current) ui.current?.onError?.(error);
    },
    onSettled: async () => {
      try {
        await settled?.();
      } finally {
        busy.current = false;
        if (session.current) ui.current?.onSettled?.();
        ui.current = null;
      }
    },
  };
}

function consumeSecretInput<TInput>(input: { current: { value: TInput } | null }) {
  return () => {
    const pending = input.current;
    input.current = null;
    if (!pending) throw new Error("Secret-entry session retired");
    return pending.value;
  };
}

/**
 * Consume a transient input before invoking the generated oRPC transport.
 * TanStack retains pending mutations after reset, so their variables must be
 * empty from the start. Session callbacks detach form references on retirement.
 */
export function transientSecretOptions<TData, TError, TInput>(
  options: Pick<
    MutationObserverOptions<TData, TError, TInput>,
    "mutationFn" | "mutationKey" | "meta"
  >,
  takeInput: () => TInput,
  callbacks: Pick<
    MutationObserverOptions<TData, TError, void>,
    "onSuccess" | "onError" | "onSettled"
  >,
): MutationObserverOptions<TData, TError, void> {
  return {
    ...options,
    ...callbacks,
    gcTime: 0,
    retry: false,
    mutationFn: (_, context) => {
      if (!options.mutationFn) throw new Error("Missing mutation transport");
      return options.mutationFn(takeInput(), context);
    },
  };
}

/** A secret-entry session owns UI callbacks; settled public queries may still refresh after retirement. */
export function useTransientSecretMutation<TData, TError, TInput>(
  options: Pick<
    MutationObserverOptions<TData, TError, TInput>,
    "mutationFn" | "mutationKey" | "meta"
  >,
  callbacks: {
    onSuccess?: (data: TData) => void;
    onError?: (error: TError) => void;
    onSettled?: () => unknown;
  },
) {
  const input = useRef<{ value: TInput } | null>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const ui = useRef<SecretUiCallbacks<TData, TError> | null>(null);
  const session = useKbMutationSession();
  useLayoutEffect(
    () => () => {
      input.current = null;
      ui.current = null;
    },
    [],
  );
  const mutation = useMutation(
    transientSecretOptions(
      options,
      consumeSecretInput(input),
      transientSecretSessionCallbacks(session, busy, ui, callbacks.onSettled),
    ),
  );
  return {
    ...mutation,
    isPending: pending || mutation.isPending,
    mutate: (value: TInput) => {
      if (!session.current || busy.current) return false;
      busy.current = true;
      setPending(true);
      ui.current = {
        onSuccess: callbacks.onSuccess,
        onError: callbacks.onError,
        onSettled: () => setPending(false),
      };
      input.current = { value };
      mutation.mutate();
      return true;
    },
    reset: () => {
      input.current = null;
      mutation.reset();
    },
  };
}
