import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createServer, loadConfigFromFile } from "vite";

test("development proxies every relative KB surface with browser authority headers intact", async () => {
  const seen: { url: string; method: string; origin?: string; cookie?: string; site?: string }[] =
    [];
  const upstream = createHttpServer((req, res) => {
    seen.push({
      url: req.url!,
      method: req.method!,
      origin: req.headers.origin,
      cookie: req.headers.cookie,
      site: req.headers["sec-fetch-site"] as string | undefined,
    });
    res.writeHead(200, {
      "content-type": req.url!.startsWith("/kb-assets/")
        ? "image/png"
        : req.url!.startsWith("/kb-exports/")
          ? "application/zip"
          : "application/x-git-upload-pack-advertisement",
    });
    res.end("fixture bytes");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing upstream port");
  const previousTarget = process.env.VITE_DEV_SERVER_URL;
  process.env.VITE_DEV_SERVER_URL = `http://127.0.0.1:${address.port}`;
  let dev: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "test" },
      resolve(import.meta.dirname, "../vite.config.ts"),
    );
    if (!loaded) throw new Error("missing development config");
    // Use Vite's actual proxy middleware/config with an isolated ephemeral API.
    // SPA/SSR/build plugins do not own this transport boundary.
    dev = await createServer({
      configFile: false,
      root: resolve(import.meta.dirname, ".."),
      plugins: [],
      logLevel: "silent",
      server: { ...loaded.config.server, host: "127.0.0.1", port: 0, watch: null },
    });
    await dev.listen();
    const web = dev.httpServer?.address();
    if (!web || typeof web === "string") throw new Error("missing development port");
    const origin = `http://127.0.0.1:${web.port}`;
    const paths = [
      "/kb-assets/aaaaaaaaaaaaaaaaaaaaaaaa/sha256:hash?rev=revision",
      "/kb-exports/aaaaaaaaaaaaaaaaaaaaaaaa/transfer",
      "/git/aaaaaaaaaaaaaaaaaaaaaaaa.git/info/refs?service=git-upload-pack",
      "/git/aaaaaaaaaaaaaaaaaaaaaaaa.git/git-upload-pack",
    ];
    for (const [index, path] of paths.entries()) {
      const response = await fetch(`${origin}${path}`, {
        method: index === 3 ? "POST" : "GET",
        headers: { origin, cookie: "fixture=disposable", "sec-fetch-site": "same-origin" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("fixture bytes");
      expect(seen.at(-1)).toEqual({
        url: path,
        method: index === 3 ? "POST" : "GET",
        origin,
        cookie: "fixture=disposable",
        site: "same-origin",
      });
    }
    const unmatched = await fetch(`${origin}/kb-assets-unrelated/example`);
    expect(await unmatched.text()).not.toBe("fixture bytes");
    expect(seen).toHaveLength(4);
  } finally {
    if (previousTarget === undefined) delete process.env.VITE_DEV_SERVER_URL;
    else process.env.VITE_DEV_SERVER_URL = previousTarget;
    await dev?.close();
    await new Promise<void>((done, fail) =>
      upstream.close((error) => (error ? fail(error) : done())),
    );
  }
});
