import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { fetchClientMetadataResource } from "@knowledge-base/auth/mcp-cimd";

const [cert, key, blocked, allowed] = process.argv.slice(2);
assert(cert && key && blocked && allowed);
let requests = 0;
const localAddresses: (string | undefined)[] = [];
let observeRequest: ((request: IncomingMessage) => void) | undefined;
const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  requests++;
  localAddresses.push(req.socket.localAddress);
  observeRequest?.(req);
  observeRequest = undefined;
  if (req.url === "/stall") return;
  if (req.url === "/stream") {
    res.write("fixture");
    return;
  }
  if (req.url === "/redirect")
    res.writeHead(302, {
      location: `https://cimd-blocked.test:${(server.address() as AddressInfo).port}/`,
    });
  res.end("fixture");
});
await new Promise<void>((resolve) => server.listen(0, "::", resolve));
const port = (server.address() as AddressInfo).port;
const fetchMetadata = async (host: string, path = "/", signal = AbortSignal.timeout(2000)) =>
  fetchClientMetadataResource(`https://${host}:${port}${path}`, { signal });
try {
  for (const host of [
    "cimd-blocked.test",
    "cimd-mixed.test",
    `[${blocked}]`,
    "[100:0:0:1::1]",
    "[2001:1::4]",
    "[::ffff:127.0.0.1]",
    "[64:ff9b::a9fe:a9fe]",
  ])
    await assert.rejects(fetchMetadata(host), /public-routable/);
  assert.equal(requests, 0, "blocked DNS/literals must never reach the listening socket");
  const response = await fetchMetadata("cimd-public.test");
  assert.equal(await response.text(), "fixture");
  assert.equal(requests, 1);
  assert.deepEqual(
    localAddresses,
    [allowed],
    "public exception connects to its pinned real IPv6 address",
  );
  await assert.rejects(fetchMetadata("cimd-wrong-name.test"));
  assert.equal(requests, 1, "TLS hostname verification must precede HTTP delivery");
  const redirect = await fetchMetadata("cimd-public.test", "/redirect");
  assert.equal(redirect.status, 302);
  await redirect.text();
  assert.equal(requests, 2, "metadata transport must never follow redirects");
  await assert.rejects(fetchMetadata("cimd-public.test", "/", AbortSignal.abort()));
  assert.equal(requests, 2, "pre-aborted request must not connect");
  for (const path of ["/stall", "/stream"]) {
    const controller = new AbortController();
    let arrived!: () => void;
    let closed!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const closure = new Promise<void>((resolve) => {
      closed = resolve;
    });
    observeRequest = (req) => {
      req.socket.once("close", closed);
      arrived();
    };
    const pending = fetchMetadata("cimd-public.test", path, controller.signal);
    await arrival;
    const completion = path === "/stream" ? (await pending).text() : pending;
    controller.abort();
    await assert.rejects(completion);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closure,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("aborted TLS socket did not close")), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  assert.equal(await (await fetchMetadata("cimd-public.test")).text(), "fixture");
  assert.equal(requests, 5, "fresh request succeeds after both cancellation paths drain");
  console.log(
    JSON.stringify({
      blockedRequests: 0,
      publicSocket: localAddresses[0],
      requests,
      tlsIdentity: "rejected",
      redirect: "not-followed",
      cancellation: "rejected",
      inFlightCancellation: "drained",
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
