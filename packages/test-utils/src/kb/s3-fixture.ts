import { once } from "node:events";
import { createServer } from "node:http";

/** In-process S3-compatible fixture. Exercises the pinned SDK's real HTTP body,
 * metadata and conditional-create behavior without another image/dependency.
 */
export async function createAssetS3Fixture() {
  const objects = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  const requests: {
    method: string;
    key: string;
    headers: Record<string, string | string[] | undefined>;
    bytes?: Buffer;
  }[] = [];
  let listPageSize = 1000;
  let putStatus = 200;
  let losePutResponse = false;
  let hangPut = false;
  let corruptGet = false;
  let getStatus = 200;
  let missingHeadStatus = 404;
  let gate: { offset: number; reached(): void; wait: Promise<void>; release(): void } | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    const key = decodeURIComponent(url.pathname);
    const request = {
      method: req.method!,
      key,
      headers: req.headers,
      bytes: undefined as Buffer | undefined,
    };
    requests.push(request);
    const fail = (code: number, name: string) => {
      res.writeHead(code, { "content-type": "application/xml" });
      res.end(`<Error><Code>${name}</Code></Error>`);
    };
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      if (getStatus !== 200) return fail(getStatus, "ServiceUnavailable");
      const bucketKey = key.replace(/\/$/, "");
      const prefix = `${bucketKey}/${url.searchParams.get("prefix") ?? ""}`;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const at = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = keys.slice(
        at,
        at + Math.min(listPageSize, Number(url.searchParams.get("max-keys") ?? 1000)),
      );
      const truncated = at + page.length < keys.length;
      const xml = (v: string) =>
        v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${at + page.length}</NextContinuationToken>` : ""}${page.map((k) => `<Contents><Key>${xml(k.slice(bucketKey.length + 1))}</Key><Size>${objects.get(k)!.bytes.length}</Size></Contents>`).join("")}</ListBucketResult>`,
      );
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      request.bytes = Buffer.concat(chunks);
      if (hangPut) return;
      if (putStatus !== 200)
        return fail(putStatus, putStatus === 403 ? "AccessDenied" : "ServiceUnavailable");
      if (objects.has(key) && req.headers["if-none-match"] === "*")
        return fail(412, "PreconditionFailed");
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers))
        if (name.startsWith("x-amz-meta-") && typeof value === "string")
          metadata[name.slice(11)] = value;
      objects.set(key, { bytes: request.bytes, metadata });
      if (losePutResponse) {
        losePutResponse = false;
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { etag: '"fixture-etag-is-not-a-hash"' });
      res.end();
      return;
    }
    if (req.method !== "HEAD" && req.method !== "GET") return fail(405, "MethodNotAllowed");
    if (getStatus !== 200) return fail(getStatus, "ServiceUnavailable");
    const object = objects.get(key);
    if (!object) return fail(req.method === "HEAD" ? missingHeadStatus : 404, "NoSuchKey");
    const headers: Record<string, string | number> = {
      "content-length": object.bytes.length,
      etag: '"fixture-etag-is-not-a-hash"',
    };
    for (const [name, value] of Object.entries(object.metadata))
      headers[`x-amz-meta-${name}`] = value;
    res.writeHead(200, headers);
    const bytes = Buffer.from(object.bytes);
    if (corruptGet && bytes.length) bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    if (req.method === "GET" && gate) {
      const current = gate;
      res.write(bytes.subarray(0, current.offset));
      current.reached();
      res.once("close", current.release);
      await current.wait;
      res.off("close", current.release);
      if (!res.destroyed) res.end(bytes.subarray(current.offset));
    } else res.end(req.method === "HEAD" ? undefined : bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port unavailable");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    setListPageSize: (size: number) => {
      listPageSize = size;
    },
    requests,
    setMissingHeadStatus: (code: number) => {
      missingHeadStatus = code;
    },
    setGetStatus: (code: number) => {
      getStatus = code;
    },
    pauseGetsAfter(offset: number) {
      const reached = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      gate = { offset, reached: reached.resolve, wait: resumed.promise, release: resumed.resolve };
      return { reached: reached.promise, release: resumed.resolve };
    },
    setPutStatus: (code: number) => {
      putStatus = code;
    },
    loseNextPutResponse: () => {
      losePutResponse = true;
    },
    hangPuts: (hang: boolean) => {
      hangPut = hang;
    },
    corruptGets: (corrupt: boolean) => {
      corruptGet = corrupt;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        gate?.release();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
