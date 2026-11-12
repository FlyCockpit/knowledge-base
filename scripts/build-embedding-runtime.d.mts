export declare function createBuildSupervisor(options?: {
  signal?: AbortSignal;
  timeoutMs?: number;
  graceMs?: number;
  /** Build-only hang guard for Docker daemon drain acknowledgement; defaults to timeoutMs. */
  drainTimeoutMs?: number;
  inheritedFd?: number;
  groupDirectory?: string | null;
}): {
  check(): void;
  run(
    cmd: string,
    argv: string[],
    cwd: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      capture?: boolean;
      maxBuffer?: number;
    },
  ): Promise<{ stdout: string; stderr: string }>;
  close(): void;
};
export declare function buildEmbeddingRuntime(args?: string[]): Promise<void>;
