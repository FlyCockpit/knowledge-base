export declare const AGE_VERSION: string;
export declare const AGE_COMMIT: string;
export declare const AGE_SHA256: Readonly<Record<"amd64" | "arm64", string>>;
export declare function ageArch(arch?: string): "amd64" | "arm64";
export declare function isPinnedAgeDir(dir: string, version?: string): boolean;
export declare function ensureAge(options?: {
  arch?: string;
  dir?: string;
  env?: NodeJS.ProcessEnv;
  download?: (url: string) => Promise<Buffer>;
  sha256?: string;
  tarBin?: string;
  lockWaitMs?: number;
}): Promise<string>;
export declare function resolveAgeDir(
  env?: NodeJS.ProcessEnv,
  ensure?: (options: { env: NodeJS.ProcessEnv }) => Promise<string>,
): Promise<string>;
export declare function putPinnedAgeOnPath(
  env?: NodeJS.ProcessEnv,
  platform?: string,
): Promise<string>;
