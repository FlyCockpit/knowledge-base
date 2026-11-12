/** Runner-only browser harness prerequisite; never opens a browser or seeds services. */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, type InlineConfig } from "vite";
import { buildArtifactPath } from "../../../packages/test-utils/src/kb/build-artifacts.mjs";

const webRoot = resolve(import.meta.dirname, "..");
const directory = buildArtifactPath("browser-harness");
// A failed refresh must never leave a previously complete harness admissible.
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
try {
  const input: Record<string, string> = {};
  // Every tests/kb-<entry>.harness.tsx is an entry: a hand-kept list silently
  // missed the editor harness (2026-10-10); setup still checks each routed entry.
  const entries = readdirSync(resolve(webRoot, "tests"))
    .map((name) => /^kb-(.+)\.harness\.tsx$/.exec(name)?.[1])
    .filter((entry): entry is string => entry !== undefined)
    .sort();
  for (const entry of entries) {
    input[entry] = join(directory, `${entry}.html`);
    // No CSP: hostile payload non-execution must be enforced by the renderer.
    writeFileSync(
      input[entry]!,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>KB browser harness</title></head><body><div id="root"></div><script type="module" src="/tests/kb-${entry}.harness.tsx"></script></body></html>`,
    );
  }
  const config: InlineConfig = {
    root: directory,
    configFile: false,
    envDir: false,
    appType: "custom",
    logLevel: "warn",
    plugins: [
      {
        name: "kb-browser-app-styles",
        enforce: "pre",
        transform(source, id) {
          if (id !== resolve(webRoot, "../../packages/ui/src/styles/globals.css")) return;
          // Preserve the app scan that dev mode obtained from its web root.
          // The temporary build root contains only the owned HTML entries.
          return `${source}\n@source ${JSON.stringify(join(webRoot, "src"))};\n`;
        },
      },
      tailwindcss(),
      react(),
    ],
    resolve: {
      alias: {
        "/tests": resolve(webRoot, "tests"),
        "@/server/auth-session": resolve(webRoot, "tests/kb-mcp-session.ts"),
        "@": resolve(webRoot, "src"),
        "@locales": resolve(webRoot, "../../packages/locales/src"),
      },
    },
    build: {
      outDir: join(directory, "dist"),
      target: "esnext",
      rolldownOptions: { input },
    },
    preview: { host: "127.0.0.1", port: 0 },
  };
  await build(config);
  writeFileSync(join(directory, "complete.json"), JSON.stringify({ entries: Object.keys(input) }));
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  throw error;
}
