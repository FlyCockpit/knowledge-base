/** Shared paths only: timed consumers never invoke a compiler. */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function buildArtifactDirectory(project = process.env.KB_TEST_PROJECT ?? "standalone") {
  // Runner projects are unique; standalone prebuilds use a documented fixed namespace.
  if (!/^[a-zA-Z0-9-]+$/.test(project)) throw new Error("Invalid test build project");
  return join(tmpdir(), `kb-test-builds-${project}`);
}
export function buildArtifactPath(name, project) {
  return join(buildArtifactDirectory(project), name);
}
export function requireBuiltArtifact(path, command, executable = true) {
  try {
    if (!statSync(path).isFile()) throw new Error("Artifact is not a file");
    accessSync(path, executable ? constants.X_OK : constants.R_OK);
  } catch {
    throw new Error(
      `Missing prebuilt artifact ${path}; run via pnpm test:kb, which prebuilds it. For a standalone run, prebuild with: ${command}`,
    );
  }
  return path;
}
export function sdkInteropBinary() {
  const command = "pnpm test:kb --build-only client-interop";
  let executable;
  try {
    executable = JSON.parse(readFileSync(buildArtifactPath("sdk-interop.json"), "utf8")).executable;
  } catch {
    throw new Error(
      `Missing prebuilt SDK interop tests; run via pnpm test:kb, which prebuilds them. For a standalone run, prebuild with: ${command}`,
    );
  }
  if (typeof executable !== "string") throw new Error("Invalid SDK interop artifact manifest");
  return requireBuiltArtifact(executable, command);
}
