/** Real TLS peer for the unmodified model transport; only the fixture supplies
 * loopback pins and a nonstandard port. The production DNS guard is separate.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, globalAgent, request } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DnsLookupFn } from "@knowledge-base/api/lib/kb/egress";
import {
  defaultModelTransport,
  downloadModelArtifact,
  type ModelTransport,
} from "@knowledge-base/api/lib/kb/model-artifact";

const cert = process.env.KB_TEST_TLS_CERT;
const key = process.env.KB_TEST_TLS_KEY;
if (!cert || !key) throw new Error("disposable TLS fixture paths required");
const sockets = new Set<Socket>();
const peers: {
  address: string | undefined;
  port: number | undefined;
  host: string;
  sni: string | false;
}[] = [];
const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  peers.push({
    address: req.socket.localAddress,
    port: req.socket.remotePort,
    host: req.headers.host ?? "",
    sni: "servername" in req.socket ? String(req.socket.servername) : false,
  });
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "https://cdn-lfs.huggingface.co/final" });
    res.end();
    return;
  }
  if (req.url === "/headers-stall") return;
  res.writeHead(200);
  if (req.url === "/body-stall") {
    res.write("x");
    return;
  }
  res.end("fixture-model");
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const transport = defaultModelTransport(150);
function hop(
  host = "huggingface.co",
  path = "/",
  address = "127.0.0.1",
  signal = new AbortController().signal,
) {
  return {
    url: new URL(`https://${host}:${port}${path}`),
    address,
    family: 4 as const,
    servername: host,
    headers: { "accept-encoding": "identity" },
    signal,
  };
}
async function read(body: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
try {
  // Prime a real reusable global socket. agent:false must ignore it even when
  // the URL origin matches but this request's pinned address cannot connect.
  const prime = await new Promise<string>((resolve, reject) => {
    request(
      hop().url,
      {
        agent: globalAgent,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        },
      },
      (response) => {
        void read(response).then(resolve, reject);
      },
    )
      .once("error", reject)
      .end();
  });
  assert.equal(prime, "fixture-model");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(Object.values(globalAgent.freeSockets).some((list) => (list?.length ?? 0) > 0));
  const count = peers.length;
  await assert.rejects(transport.request(hop("huggingface.co", "/", "127.0.0.2")), {
    code: "MODEL_DOWNLOAD_FAILED",
  });
  assert.equal(peers.length, count);
  for (const host of ["huggingface.co", "cdn-lfs.huggingface.co", "huggingface.co"]) {
    assert.equal(await read((await transport.request(hop(host))).body), "fixture-model");
    const peer = peers.at(-1)!;
    assert.equal(peer.address, "127.0.0.1");
    assert.equal(peer.host, `${host}:${port}`);
    assert.equal(peer.sni, host);
  }
  assert.equal(new Set(peers.map((peer) => peer.port)).size, peers.length);
  await assert.rejects(transport.request(hop("wrong-san.test")), { code: "MODEL_DOWNLOAD_FAILED" });
  assert.equal(peers.length, count + 3);
  const preabort = new AbortController();
  preabort.abort();
  await assert.rejects(
    transport.request(hop("huggingface.co", "/", "127.0.0.1", preabort.signal)),
    { code: "MODEL_CANCELLED" },
  );
  assert.equal(peers.length, count + 3);
  await assert.rejects(transport.request(hop("huggingface.co", "/headers-stall")), {
    code: "MODEL_DOWNLOAD_FAILED",
  });
  const abort = new AbortController();
  const body = (
    await transport.request(hop("huggingface.co", "/body-stall", "127.0.0.1", abort.signal))
  ).body;
  const iterator = body[Symbol.asyncIterator]();
  assert.equal(Buffer.from((await iterator.next()).value).toString(), "x");
  const pending = iterator.next();
  abort.abort();
  await assert.rejects(pending);

  // Exercise the real automatic redirect/DNS guards and TLS/body/file path
  // together. The fixture connector maps each already-validated public pin
  // to our local peer/port; it preserves hostname, SNI and certificate checks.
  // The direct cases above separately execute the unmodified socket pin.
  const dir = mkdtempSync(join(tmpdir(), "kb-model-tls-download-"));
  try {
    const resolutions: string[] = [];
    let privateRedirect = false;
    const lookup: DnsLookupFn = (hostname, _options, callback) => {
      resolutions.push(hostname);
      callback(null, [
        {
          address:
            hostname === "cdn-lfs.huggingface.co" && privateRedirect ? "127.0.0.1" : "18.160.1.1",
          family: 4,
        },
      ]);
    };
    const connector: ModelTransport = {
      request: (req) => {
        assert.equal(req.address, "18.160.1.1");
        const url = new URL(req.url);
        url.port = String(port);
        return transport.request({ ...req, url, address: "127.0.0.1" });
      },
    };
    const bytes = Buffer.from("fixture-model");
    const expected = {
      fileName: "fixture.gguf",
      url: "https://huggingface.co/redirect",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const download = () =>
      downloadModelArtifact({
        dir,
        epoch: 1,
        expected,
        signal: new AbortController().signal,
        onProgress: () => {},
        deps: { transport: connector, lookup },
      });
    const before = peers.length;
    assert.equal((await download()).outcome, "PUBLISHED");
    assert.deepEqual(resolutions, ["huggingface.co", "cdn-lfs.huggingface.co"]);
    assert.deepEqual(
      peers.slice(before).map((peer) => peer.sni),
      ["huggingface.co", "cdn-lfs.huggingface.co"],
    );
    assert.equal(readFileSync(join(dir, expected.fileName)).toString(), "fixture-model");
    // A private answer on a later automatic hop is rejected before dialing it.
    rmSync(join(dir, expected.fileName));
    resolutions.length = 0;
    privateRedirect = true;
    const deniedBefore = peers.length;
    await assert.rejects(download(), { code: "MODEL_PRIVATE_NETWORK" });
    assert.deepEqual(resolutions, ["huggingface.co", "cdn-lfs.huggingface.co"]);
    assert.equal(peers.length, deniedBefore + 1);
    assert.equal(existsSync(join(dir, expected.fileName)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write("TLS pin/SAN/fresh-socket/pool/preabort/header-timeout/body-abort PASS\n");
} finally {
  globalAgent.destroy();
  for (const socket of sockets) socket.destroy();
  server.close();
  await once(server, "close");
}
