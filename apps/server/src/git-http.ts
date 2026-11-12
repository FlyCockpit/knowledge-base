import { randomUUID } from "node:crypto";
import { admitSecurityEvent, recordAuditEvent } from "@knowledge-base/api/lib/kb/audit";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { authorizeDocumentRead } from "@knowledge-base/api/lib/kb/documents-read";
import type { LiveAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { authorize } from "@knowledge-base/api/lib/kb/permissions";
import {
  actorKeyFor,
  KbAdmissionError,
  type Principal,
} from "@knowledge-base/api/lib/kb/principal";
import { createPushSpooler, PushSpoolError } from "@knowledge-base/api/lib/kb/push-spool";
import {
  inspectPushRequest,
  type PushCommand,
  PushRefusedError,
} from "@knowledge-base/api/lib/kb/push-validation";
import { logEvent, logInternalError } from "@knowledge-base/env/log";
import { Hono } from "hono";
import { gitCgiEnvironment, runGitCgi } from "./git-cgi";
import { isAdmissionOpen } from "./kb-process";
import type { BearerAdmitter } from "./mcp/context";
import { type PushOptions, receivePush } from "./push-context";

/** Private Git HTTP has its own admission lifetime, independent of MCP's 30s tool cap. */
export function createGitHttp(options: {
  reposDir: string;
  admit: BearerAdmitter;
  store: LiveAuthorityStore;
  retainedRefs(kbId: string): Promise<string[]>;
  push?: PushOptions;
}) {
  // requestId: set by the server-wide request-id middleware when mounted.
  const app = new Hono<{ Variables: { requestId?: string } }>();
  let closed = false;
  const active = new Map<AbortController, Promise<void>>();
  const spooler = createPushSpooler({ root: options.reposDir });
  app.all("/git/*", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (closed || !isAdmissionOpen()) return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    c.req.raw.signal.addEventListener("abort", cancel, { once: true });
    if (c.req.raw.signal.aborted) cancel();
    let resolve: () => void = () => {};
    active.set(
      abort,
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    let spool: Awaited<ReturnType<typeof spooler.spool>> | undefined;
    let finishing: Promise<void> | undefined;
    const finish = () =>
      (finishing ??= (async () => {
        try {
          await spool?.dispose();
        } finally {
          c.req.raw.signal.removeEventListener("abort", cancel);
          active.delete(abort);
          resolve();
        }
      })());
    let cgiOwned = false;
    const requestId = randomUUID();
    let pushActor: Principal | undefined;
    let pushSucceeded = false;
    // Set once the token is authenticated; FORBIDDEN after this is a 403 with a reason.
    let gitService: "fetch" | "push" | undefined;
    let pushBody: Buffer | undefined;
    let pushRequest: { command: PushCommand; capabilities: Set<string> } | undefined;
    let logKbId: string | undefined;
    try {
      const header = c.req.header("authorization") ?? "";
      const basic = header.length <= 8192 && /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
      const decoded = basic ? Buffer.from(basic[1]!, "base64").toString("utf8") : "";
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (
        !basic ||
        !decoded.includes(":") ||
        !/^kbp_[a-z0-9]{16}_[A-Za-z0-9_-]{43}$/.test(password)
      )
        throw new KbAdmissionError("UNAUTHORIZED", "PAT_REQUIRED");
      const admitted = await options.admit(
        new Request(c.req.url, {
          headers: { authorization: `Bearer ${password}` },
          signal: abort.signal,
        }),
      );
      if (admitted.principal.credential?.kind !== "PAT")
        throw new KbAdmissionError("UNAUTHORIZED", "PAT_REQUIRED");
      const url = new URL(c.req.url);
      const match =
        /^\/git\/([a-z0-9]{24,32})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
          url.pathname,
        );
      if (!match) return c.json({ error: "NOT_FOUND" }, 404);
      const kbId = match[1]!;
      logKbId = kbId;
      const discovery = match[2] === "info/refs";
      // Git fetch needs the `read` tool group and Git push needs `edit`, on
      // every authorization of this request (discovery, CGI and push rechecks).
      const pushing =
        (discovery ? url.searchParams.get("service") : match[2]) === "git-receive-pack";
      gitService = pushing ? "push" : "fetch";
      const actor = admitted.demandToolGroups([pushing ? "edit" : "read"]);
      // Capture the authenticated actor before live read/propose checks can reject.
      // Discovery/fetch and unauthenticated traffic are outside this push event.
      if (match[2] === "git-receive-pack" && c.req.method === "POST") pushActor = actor.principal;
      const reauthorize = async () => {
        abort.signal.throwIfAborted();
        await authorizeDocumentRead({
          principal: actor.principal,
          verifier: actor.verifier,
          kbId,
          operation: "read",
          store: options.store,
        });
        abort.signal.throwIfAborted();
      };
      await reauthorize();
      if ((discovery && c.req.method !== "GET") || (!discovery && c.req.method !== "POST"))
        return c.json({ error: "METHOD_NOT_ALLOWED" }, 405);
      const service = discovery ? url.searchParams.get("service") : match[2];
      if (
        (discovery &&
          (url.search !== `?service=${service}` ||
            !["git-upload-pack", "git-receive-pack"].includes(service ?? ""))) ||
        (!discovery && url.search)
      )
        return c.json({ error: "INVALID_ARGUMENT" }, 400);
      const receive = service === "git-receive-pack";
      if (receive) {
        if (!options.push) return c.json({ error: "RECEIVE_PACK_UNAVAILABLE" }, 501);
        await authorize({
          store: options.store,
          principal: actor.principal,
          verifier: actor.verifier,
          kbId,
          operation: "propose",
        });
      }
      const protocol = c.req.header("git-protocol") ?? null;
      if (protocol !== null && !/^version=[012]$/.test(protocol))
        return c.json({ error: "INVALID_ARGUMENT" }, 400);
      if (!discovery) {
        if (
          c.req.header("content-type") !== `application/x-${service}-request` ||
          (c.req.header("content-encoding") ?? "identity") !== "identity"
        )
          return c.json({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415);
        spool = await spooler.spool(
          new Request(c.req.raw, { signal: abort.signal }),
          actor.principal.userId,
        );
      }
      const body = receive && !discovery && spool ? await spool.file.readFile() : undefined;
      pushBody = body;
      const command = body ? inspectPushRequest(body) : undefined;
      if (body && command) pushRequest = { command, capabilities: pushCapabilities(body) };
      const env = gitCgiEnvironment({
        reposDir: options.reposDir,
        kbId,
        userId: actor.principal.userId,
        method: discovery ? "GET" : "POST",
        discovery,
        protocol,
        length: spool?.size ?? 0,
        refs: [
          ...new Set([
            ...(await options.retainedRefs(kbId)),
            ...(command ? [command.refName] : []),
          ]),
        ],
        receive,
      });
      await reauthorize();
      if (receive && !discovery && options.push && spool && command) {
        const response = await receivePush({
          ...options.push,
          reposDir: options.reposDir,
          kbId,
          principal: actor.principal,
          verifier: actor.verifier,
          store: options.store,
          signal: abort.signal,
          env,
          command,
          file: spool.file,
          opId: requestId,
        });
        pushSucceeded = true;
        return response;
      }
      // CGI owns completion through native drain, including a late spawn ack.
      cgiOwned = true;
      const response = await runGitCgi({
        env,
        signal: abort.signal,
        reauthorize,
        file: spool?.file,
        onDone: finish,
      });
      return response;
    } catch (error) {
      if (error instanceof PushSpoolError) return c.json({ error: error.message }, error.status);
      // A refusal the pusher can act on: Git prints it against the ref (R3-W10).
      if (error instanceof PushRefusedError) {
        logEvent("git-http.refused", { opId: requestId, kbId: logKbId, reason: error.refusal });
        const request =
          pushRequest ??
          (pushBody && error.refs.length > 0
            ? { refs: error.refs, capabilities: pushCapabilities(pushBody) }
            : undefined);
        const report = request && receivePackRefusal(request, error.message);
        return report ?? c.text(`${error.message}\n`, 409);
      }
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code === "FORBIDDEN" && gitService) {
        // Authenticated but not permitted: a 401 would make Git discard good
        // credentials. The reason names only rights this token already holds or lacks.
        const reason = refusalReason(gitService, error, pushRequest?.command.refName);
        if (pushRequest) {
          const report = receivePackRefusal(pushRequest, reason);
          if (report) return report;
        }
        return c.text(`${reason}\n`, 403);
      }
      if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
        c.header("WWW-Authenticate", 'Basic realm="knowledge-base", charset="UTF-8"');
        return c.json({ error: "UNAUTHORIZED" }, 401);
      }
      if (code === "NOT_FOUND") return c.json({ error: "NOT_FOUND" }, 404);
      // Unexpected: the client sees only 503, so the operator log carries the cause (R3-W3).
      logInternalError("git-http", error, {
        requestId: c.get("requestId"),
        opId: requestId,
        service: gitService,
        kbId: logKbId,
        code: typeof code === "string" ? code : undefined,
      });
      return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
    } finally {
      if (!cgiOwned) {
        try {
          // receivePush owns child cleanup through drain before it returns/throws.
          // Keep this request registered until its bounded, redacted audit settles.
          if (pushActor && !pushSucceeded && options.push) {
            const actorKey = actorKeyFor(pushActor);
            if (admitSecurityEvent(actorKey)) {
              try {
                await runLockedOperation({
                  connectionString: options.push.connectionString,
                  opId: randomUUID(),
                  kind: "authority",
                  run: (lease) =>
                    lease.transaction(async (query) => {
                      // A reply/transport failure after publication is still one logical
                      // success. Recovery finalizes that same opId; do not invent a reject.
                      const committed = await query(
                        `SELECT 1 FROM operation_intent WHERE "opId"=$1 AND phase IN ('COMMITTING','FINALIZED')`,
                        [requestId],
                      );
                      if (committed.rows.length) return;
                      await recordAuditEvent(query, {
                        opId: requestId,
                        action: "git_push",
                        outcome: "FAILURE",
                        actorKey,
                        actorUserIdSnapshot: pushActor!.userId,
                        grantIdSnapshot: pushActor!.kind === "token" ? pushActor!.grantId : null,
                        metadata: { reasonCode: "PUSH_REJECTED", requestId },
                      });
                    }),
                });
              } catch {
                // A denial remains uniform if storage is unavailable (same policy as
                // sealed-resolve denials). Never log the client's body/ref/token/error.
                logEvent("git-http.audit-unavailable", { opId: requestId });
              }
            }
          }
        } finally {
          await finish();
        }
      }
    }
  });
  return {
    app,
    async close() {
      closed = true;
      for (const abort of active.keys()) abort.abort();
      await Promise.all(active.values());
    },
  };
}

function refusalReason(service: "fetch" | "push", error: unknown, refName?: string): string {
  if (error instanceof Error && error.message === "Tool group not granted") {
    return service === "push"
      ? "This token cannot push: it does not include the edit tool group. Create a token with edit access."
      : "This token cannot fetch: it does not include the read tool group.";
  }
  if (service === "fetch") return "This token is not allowed to read this knowledge base.";
  if (refName === "refs/heads/main") {
    return "Pushing to main requires Write access. Push a branch instead and open a pull request.";
  }
  return "Your access to this knowledge base does not allow pushing. Pushing a branch requires Propose access; pushing main requires Write.";
}

/** Capabilities from the first receive-pack command line (after the NUL). */
function pushCapabilities(body: Buffer): Set<string> {
  const size = Number.parseInt(body.subarray(0, 4).toString("ascii"), 16);
  if (!Number.isInteger(size) || size < 5 || size > body.length) return new Set();
  const line = body.subarray(4, size).toString("utf8");
  const nul = line.indexOf("\0");
  return new Set(
    nul < 0
      ? []
      : line
          .slice(nul + 1)
          .trim()
          .split(" ")
          .filter(Boolean),
  );
}

// https://git-scm.com/docs/gitprotocol-common#_pkt_line_format
const PKT_LINE_MAX_BYTES = 65520;
function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  if (data.length + 4 > PKT_LINE_MAX_BYTES) throw new RangeError("Git pkt-line exceeds maximum");
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, "0")), data]);
}

/** Frame bytes, not strings: UTF-8 and inner pkt-lines may cross band boundaries. */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const capacity = PKT_LINE_MAX_BYTES - 5; // Four length bytes and one band byte.
  for (let offset = 0; offset < data.length; offset += capacity)
    packets.push(
      pktLine(Buffer.concat([Buffer.from([band]), data.subarray(offset, offset + capacity)])),
    );
  return packets;
}

/**
 * A receive-pack result that rejects every pushed ref, so Git prints
 * `! [remote rejected] <ref> (<reason>)` (and `remote: <reason>` over the
 * progress band) instead of an opaque "RPC failed; HTTP 403".
 */
function receivePackRefusal(
  request:
    | { command: PushCommand; capabilities: Set<string> }
    | { refs: readonly string[]; capabilities: Set<string> },
  reason: string,
): Response | undefined {
  // report-status-v2 (current Git) reports a rejected ref with the same `ng` line.
  if (!request.capabilities.has("report-status") && !request.capabilities.has("report-status-v2"))
    return undefined;
  const status = Buffer.concat([
    pktLine("unpack ok\n"),
    ...("refs" in request ? request.refs : [request.command.refName]).map((ref) =>
      pktLine(`ng ${ref} ${reason}\n`),
    ),
    Buffer.from("0000"),
  ]);
  const sideband = request.capabilities.has("side-band-64k");
  const body = sideband
    ? Buffer.concat([
        ...sidebandPackets(2, Buffer.from(`${reason}\n`, "utf8")),
        ...sidebandPackets(1, status),
        Buffer.from("0000"),
      ])
    : status;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-receive-pack-result",
      "Cache-Control": "private, no-store",
    },
  });
}
