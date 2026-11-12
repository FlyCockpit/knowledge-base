import { type EffectCallback, useEffect } from "react";

/**
 * Runs a callback once on mount. This is the approved escape hatch
 * for one-time external sync (useEffect with empty deps).
 */
export function useMountEffect(fn: EffectCallback) {
  // Intentional run-once-on-mount: the empty dep array is the whole point of
  // this approved escape hatch. oxlint matches disable directives by full rule
  // name, so both the eslint and react-doctor spellings must be listed.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps
  // biome-ignore lint/correctness/useExhaustiveDependencies: run-once-on-mount is the entire purpose of this escape hatch; the empty dep array is deliberate.
  useEffect(fn, []);
}
