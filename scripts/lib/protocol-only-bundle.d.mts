/** The part of a rolldown output chunk the check reads. */
export interface BundleChunk {
  type: "chunk" | "asset";
  fileName: string;
  name?: string;
  isEntry?: boolean;
  imports?: readonly string[];
  dynamicImports?: readonly string[];
  moduleIds?: readonly string[];
}
export function protocolOnlyViolations(
  chunks: readonly BundleChunk[],
  protocolOnly: readonly string[],
  loggingEntry: string,
): string[];
export function assertProtocolOnlyBundle(
  protocolOnly: readonly string[],
  loggingEntry?: string,
): (context: { chunks: readonly BundleChunk[] }) => void;
