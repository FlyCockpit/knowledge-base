export declare function buildArtifactDirectory(project?: string): string;
export declare function buildArtifactPath(name: string, project?: string): string;
export declare function requireBuiltArtifact(
  path: string,
  command: string,
  executable?: boolean,
): string;
export declare function sdkInteropBinary(): string;
