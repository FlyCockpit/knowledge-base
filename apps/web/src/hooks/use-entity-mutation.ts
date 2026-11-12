import { toast } from "@knowledge-base/ui/components/sileo";
import {
  type QueryKey,
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

/**
 * oRPC mutation with the usual success side-effects: invalidate a namespace,
 * success toast. The error toast lives on the global MutationCache in
 * `router.tsx`.
 *
 * Reach for this when a mutation's success story is "tell the user it worked
 * and refresh the list". Use a plain `useMutation(orpc.x.y.mutationOptions())`
 * when it isn't — optimistic updates, a mutation whose result you render
 * instead of invalidating, or an error branch the call site handles itself.
 * See AGENTS.md § Data fetching.
 *
 * `successMessage` is optional: omit it for autosave-style mutations that
 * should not toast on every save.
 *
 * The invalidation is deliberately **not** awaited. React Query keeps a
 * mutation `pending` until `onSuccess` resolves, so awaiting a refetch of a
 * ten-page infinite list would leave the button stuck on "Deleting…" long
 * after the delete succeeded. Feedback fires first; the refetch catches up.
 * If a call site truly needs fresh data before its next step (navigating to a
 * screen that must not show the stale row), await
 * `queryClient.invalidateQueries(...)` in its own `onSuccess`.
 */
export function useEntityMutation<TData, TError, TVariables, TOnMutateResult>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
  extras: {
    invalidateKey: QueryKey;
    successMessage?: string;
  },
) {
  const queryClient = useQueryClient();
  const userOnSuccess = options.onSuccess;

  return useMutation({
    ...options,
    onSuccess: async (data, variables, onMutateResult, context) => {
      if (extras.successMessage) toast.success(extras.successMessage);
      await userOnSuccess?.(data, variables, onMutateResult, context);
      void queryClient.invalidateQueries({ queryKey: extras.invalidateKey });
    },
  });
}
