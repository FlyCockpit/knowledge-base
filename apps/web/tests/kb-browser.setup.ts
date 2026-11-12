/**
 * One built browser harness origin plus the fixture's REAL asset/export routes.
 * The runner prebuilds the CLI and Vite harness; setup only validates and previews them.
 */

import { join, resolve } from "node:path";
import { type PreviewServer, preview } from "vite";
import type { createKbBrowserFixture } from "../../../packages/test-utils/src/kb/browser";
import {
  buildArtifactPath,
  requireBuiltArtifact,
} from "../../../packages/test-utils/src/kb/build-artifacts.mjs";

const webRoot = resolve(import.meta.dirname, "..");
const HARNESS_BY_PATH: Record<string, string> = {
  "/": "viewer",
  "/index.html": "viewer",
  "/pr": "pr",
  "/lifecycle": "lifecycle",
  "/kb-settings": "settings",
  "/r38": "editor",
  "/en-US/mcp-consent": "mcp",
  "/en-US/settings/mcp": "mcp",
  "/en-US/device": "mcp",
  "/mcp-exit": "mcp",
};

export default async function globalSetup() {
  const directory = buildArtifactPath("browser-harness");
  const command = "pnpm test:kb --build-only browser";
  // Harness entries first: their check does not depend on a local cargo target.
  requireBuiltArtifact(join(directory, "complete.json"), command, false);
  for (const entry of new Set(Object.values(HARNESS_BY_PATH)))
    requireBuiltArtifact(join(directory, "dist", `${entry}.html`), command, false);
  requireBuiltArtifact(resolve(webRoot, "../cli/target/debug/kb"), command);
  const nodeEnvironment = process.env.NODE_ENV;
  // The loopback-only PG/auth fixture retains its explicit test environment.
  process.env.NODE_ENV = "test";
  let server: PreviewServer | undefined;
  let fixture: Awaited<ReturnType<typeof createKbBrowserFixture>> | undefined;
  const requests = new Set<Promise<void>>();
  const close = async () => {
    const failures: unknown[] = [];
    await server?.close().catch((error) => failures.push(error));
    await Promise.all([...requests]);
    await fixture?.close().catch((error) => failures.push(error));
    if (nodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnvironment;
    if (failures.length) throw new AggregateError(failures, "browser fixture cleanup failed");
  };
  try {
    server = await preview({
      root: directory,
      configFile: false,
      envDir: false,
      appType: "custom",
      logLevel: "warn",
      build: { outDir: join(directory, "dist") },
      preview: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "kb-browser-fixture",
          configurePreviewServer(previewServer) {
            previewServer.middlewares.use((req, res, next) => {
              const work = Promise.resolve()
                .then(async () => {
                  if (fixture && (await fixture.handle(req, res))) return;
                  const original = req.url ?? "/";
                  const [path] = original.split("?");
                  const entry = path?.startsWith("/en-US/kbs")
                    ? "editor"
                    : path
                      ? HARNESS_BY_PATH[path]
                      : undefined;
                  if (entry) req.url = `/${entry}.html${original.slice(path!.length)}`;
                  next();
                })
                .catch((error) => {
                  res.statusCode = 500;
                  res.end(String(error));
                });
              requests.add(work);
              void work.then(() => requests.delete(work));
            });
          },
        },
      ],
    });
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("browser fixture has no port");
    const { createKbBrowserFixture } = await import("../../../packages/test-utils/src/kb/browser");
    fixture = await createKbBrowserFixture({ origin: `http://127.0.0.1:${address.port}` });
    process.env.KB_BROWSER_FIXTURE = JSON.stringify(fixture.data);
    return close;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "browser setup and cleanup failed");
    }
    throw error;
  }
}
