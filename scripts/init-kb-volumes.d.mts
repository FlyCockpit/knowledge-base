export declare const DEFAULT_KB_DATA_ROOT: string;
export declare const KB_DATA_LAYOUT: Readonly<{
  repos: "repos";
  assets: "assets";
  models: "models";
  index: "index";
}>;
export type KbDataPaths = {
  reposDir: string;
  assetsDir: string;
  modelsDir: string;
  indexDir: string;
};
export declare function kbDataPaths(root: string): KbDataPaths;
export declare function ensureKbDataSkeleton(root: string, uid?: number, gid?: number): string;
export declare function isSkeletonOnly(root: string): boolean;
export declare function initKbVolumes(
  env?: NodeJS.ProcessEnv,
): KbDataPaths & { root: string; uid: number; gid: number };
export declare function checkDataVolume(env?: NodeJS.ProcessEnv): void;
export declare function checkRuntimeDeployment(role: string, env?: NodeJS.ProcessEnv): void;

export declare function checkMigrationArtifacts(
  root: string,
  artifact?: (path: string) => void,
): void;
