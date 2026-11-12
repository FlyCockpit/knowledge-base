import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

type HttpFixtureRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type PublicHttpFixture = {
  origin: string;
  embeddingsUrl: string;
  requests: HttpFixtureRequest[];
  close(): Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function startPublicHttpFixture(options?: {
  handler?: (req: IncomingMessage, res: ServerResponse, body: string) => void;
}): Promise<PublicHttpFixture> {
  const requests: HttpFixtureRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      });
      if (options?.handler) {
        options.handler(req, res, body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: "kb-test-fake",
        }),
      );
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP fixture did not bind a TCP port.");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    embeddingsUrl: `${origin}/v1/embeddings`,
    requests,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}
