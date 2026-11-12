/**
 * Isolated test process, trusting only its disposable fixture CA in addition
 * to Node's normal roots. The pool regression uses the unmodified transport.
 * TLS identity, redirect and body cases mock the connector here, never a production export or
 * policy switch, to dial a local socket while retaining the public URL's TLS
 * options and Node's real certificate verification.
 */
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent, createServer, globalAgent, type RequestOptions, request } from "node:https";
import { type AddressInfo, connect } from "node:net";
import { mock } from "node:test";
import {
  type DnsLookupFn,
  kbHttpsRequest,
  readBoundedResponseBody,
} from "@knowledge-base/api/lib/kb/egress";

type CaseOutcome = {
  name: string;
  ok: boolean;
  body?: string;
  statusCode?: number;
  lookupCalls: number;
  error?: string;
};

const CASES = [
  { name: "v4-literal-ip-san", host: "93.184.216.34" },
  { name: "v6-literal-ip-san", host: "[2606:4700::1111]" },
  { name: "hostname-pinned-dns-san", host: "egress-fixture.test" },
  { name: "hostname-mismatch-rejected", host: "unlisted-name.test" },
  { name: "v4-ip-mismatch-rejected", host: "93.184.216.35" },
  { name: "v6-ip-mismatch-rejected", host: "[2606:4700::1112]" },
];

async function run() {
  const certPath = process.env.KB_TEST_TLS_CERT;
  const keyPath = process.env.KB_TEST_TLS_KEY;
  if (!certPath || !keyPath) {
    throw new Error("KB_TEST_TLS_CERT and KB_TEST_TLS_KEY must point at the fixture certificate");
  }

  let requestsReceived = 0;
  let authorizationRequests = 0;
  let bodyBytes = 0;
  const tlsOptions = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  const destination = { requestsReceived: 0, authorizationRequests: 0, bodyBytes: 0 };
  const destinationServer = createServer(tlsOptions, (req, res) => {
    destination.requestsReceived += 1;
    if (req.headers.authorization) destination.authorizationRequests += 1;
    req.on("data", (chunk: Buffer) => {
      destination.bodyBytes += chunk.byteLength;
    });
    req.on("end", () => res.end("redirect-destination"));
  });
  const redirectRequests: {
    statusCode: number;
    method: string | undefined;
    authorization: string | undefined;
    body: string;
  }[] = [];
  const server = createServer(tlsOptions, (req, res) => {
    const redirectStatus =
      req.url === "/redirect/302" ? 302 : req.url === "/redirect/307" ? 307 : undefined;
    const chunks: Buffer[] = [];
    requestsReceived += 1;
    if (req.headers.authorization) authorizationRequests += 1;
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.byteLength;
      if (redirectStatus) chunks.push(chunk);
    });
    req.on("end", () => {
      if (redirectStatus) {
        redirectRequests.push({
          statusCode: redirectStatus,
          method: req.method,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const destinationPort = (destinationServer.address() as AddressInfo).port;
        res.writeHead(redirectStatus, {
          location: `https://egress-fixture.test:${destinationPort}/destination`,
        });
        // Leave the response unfinished: only client disposal can close it.
        res.flushHeaders();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      if (req.url === "/bounds") {
        // The test sends bytes only after the caller has selected decoding.
        res.flushHeaders();
        return;
      }
      res.end("fixture-body");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    await new Promise<void>((resolve) => destinationServer.listen(0, "127.0.0.1", resolve));
    const destinationPort = (destinationServer.address() as AddressInfo).port;
    const url = `https://egress-fixture.test:${port}/`;
    // Wait for the actual free event, not a sleep: the hostile socket must be
    // idle in the global pool before attempting the checked KB request.
    const freeSocket = once(globalAgent, "free", { signal: AbortSignal.timeout(2000) });
    const primeBody = await new Promise<string>((resolve, reject) => {
      const req = request(
        url,
        {
          servername: "egress-fixture.test",
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
          },
          signal: AbortSignal.timeout(2000),
        },
        (res) => {
          readBoundedResponseBody(res).then(
            (body) => resolve(Buffer.from(body).toString("utf8")),
            reject,
          );
        },
      );
      req.once("error", reject);
      req.end();
    });
    const [primedSocket] = await freeSocket;
    const poolPrimed = Object.values(globalAgent.freeSockets).some((sockets) =>
      sockets?.includes(primedSocket),
    );
    let lookupCalls = 0;
    let rejected = false;
    try {
      const response = await kbHttpsRequest(
        url,
        {
          method: "POST",
          providerBearerToken: "disposable-pool-token-canary",
          body: Buffer.from("disposable-pool-body-canary"),
        },
        { timeoutMs: 2000 },
        {
          lookup: (_hostname, _options, callback) => {
            lookupCalls += 1;
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
          },
        },
      );
      await readBoundedResponseBody(response);
    } catch {
      rejected = true;
    }
    const pool = {
      primeBody,
      poolPrimed,
      primedAddress: primedSocket.remoteAddress,
      rejected,
      lookupCalls,
      requestsReceived,
      authorizationRequests,
      bodyBytes,
    };
    globalAgent.destroy();

    // Test-only TCP connector seam. Public IPs never leave this process:
    // connect a local socket, then let Node's original HTTPS connector apply
    // the untouched public host/servername and verify the real certificate.
    // This bypasses DNS ONLY for TLS identity/redirect/body cases; the pool regression
    // above exercises the real DNS path without this hook.
    const createConnection = Agent.prototype.createConnection;
    mock.method(
      Agent.prototype,
      "createConnection",
      function (this: Agent, options: RequestOptions) {
        const targetPort = Number(options.port);
        if (targetPort !== port && targetPort !== destinationPort) {
          throw new Error("TLS fixture must connect only to its observed servers");
        }
        return createConnection.call(this, {
          ...options,
          socket: connect({ host: "127.0.0.1", port: targetPort }),
        });
      },
    );

    const outcomes: CaseOutcome[] = [];
    for (const fixtureCase of CASES) {
      let caseLookupCalls = 0;
      const lookup: DnsLookupFn = () => {
        caseLookupCalls += 1;
        throw new Error("TLS identity fixture must use only its local socket");
      };
      try {
        const response = await kbHttpsRequest(
          `https://${fixtureCase.host}:${port}/`,
          { method: "GET" },
          { timeoutMs: 2000 },
          { lookup },
        );
        const body = Buffer.from(await readBoundedResponseBody(response)).toString("utf8");
        outcomes.push({
          name: fixtureCase.name,
          ok: true,
          body,
          statusCode: response.statusCode,
          lookupCalls: caseLookupCalls,
        });
      } catch (error) {
        outcomes.push({
          name: fixtureCase.name,
          ok: false,
          lookupCalls: caseLookupCalls,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const redirects = [];
    for (const statusCode of [302, 307]) {
      const sourceRequest = once(server, "request", { signal: AbortSignal.timeout(2000) });
      let rejected = false;
      let errorMessage: string | undefined;
      // Observe rejection of the request itself, not a later body-read error.
      const pending = kbHttpsRequest(
        `${url}redirect/${statusCode}`,
        {
          method: "POST",
          providerBearerToken: "disposable-redirect-token-canary",
          body: Buffer.from("disposable-redirect-body-canary"),
        },
        { timeoutMs: 10_000 },
      ).catch((error: unknown) => {
        rejected = true;
        errorMessage = error instanceof Error ? error.message : String(error);
      });
      const [, response] = (await sourceRequest) as [IncomingMessage, ServerResponse];
      // Observe the real peer close before the request deadline or fixture
      // cleanup can dispose it. No sleep and no mocked response.destroy().
      const closed = once(response, "close", { signal: AbortSignal.timeout(2000) }).then(
        () => true,
        () => false,
      );
      const [, responseClosed] = await Promise.all([pending, closed]);
      redirects.push({
        statusCode,
        rejected,
        error: errorMessage,
        responseClosed,
        responseDestroyed: response.destroyed,
        responseEnded: response.writableEnded,
      });
    }
    const bounds = [];
    for (const [name, body, encoding] of [
      ["ascii", Buffer.alloc(128, "a"), "utf8"],
      ["multibyte", Buffer.from("€€€"), "utf8"],
      ["incomplete-utf16", Buffer.alloc(9), "utf16le"],
    ] as const) {
      for (const consumer of ["direct", "reader-default", "reader-larger"]) {
        const sourceRequest = once(server, "request", { signal: AbortSignal.timeout(2000) });
        const pending = kbHttpsRequest(
          `${url}bounds`,
          {},
          { maxResponseBytes: 8, timeoutMs: 10_000 },
        );
        const [, source] = (await sourceRequest) as [IncomingMessage, ServerResponse];
        const closed = once(source, "close", { signal: AbortSignal.timeout(2000) }).then(
          () => true,
          () => false,
        );
        const response = await pending;
        response.setEncoding(encoding);
        let rejected = false;
        let errorMessage: string | undefined;
        let deliveredBytes = 0;
        const reading = (async () => {
          try {
            if (consumer === "direct") {
              for await (const chunk of response)
                deliveredBytes += Buffer.byteLength(chunk, encoding);
            } else {
              deliveredBytes += (
                await readBoundedResponseBody(
                  response,
                  consumer === "reader-larger" ? { maxResponseBytes: 1024 } : undefined,
                )
              ).byteLength;
            }
          } catch (error) {
            rejected = true;
            errorMessage = error instanceof Error ? error.message : String(error);
          }
        })();
        source.write(body);
        const responseClosed = await closed;
        bounds.push({
          name,
          consumer,
          rejected,
          error: errorMessage,
          deliveredBytes,
          responseDestroyed: response.destroyed,
          responseClosed,
          sourceDestroyed: source.destroyed,
          sourceEnded: source.writableEnded,
        });
        // Cleanup follows observation so it cannot satisfy the regression.
        response.destroy();
        await reading;
      }
    }
    return { pool, outcomes, redirects, redirectRequests, destination, bounds };
  } finally {
    mock.restoreAll();
    globalAgent.destroy();
    destinationServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      destinationServer.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const result = await run();
process.stdout.write(`${JSON.stringify(result)}\n`);
