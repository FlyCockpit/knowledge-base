import { canonicalMcpResource } from "@knowledge-base/auth/mcp-config";

const MCP_AUTHORIZE_PATH = "/api/auth/oauth2/authorize";
const allowedScopes = new Set(["mcp:read", "mcp:write", "offline_access"]);
const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Configuration, never forwarding input, owns issuer/resource/DPoP authority. */
export function canonicalOAuthRequest(request: Request, baseUrl: string, webOrigin = baseUrl) {
  const configured = new URL(baseUrl);
  const raw = new URL(request.url);
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (
    !host ||
    host.toLowerCase() !== configured.host.toLowerCase() ||
    raw.host.toLowerCase() !== host.toLowerCase() ||
    raw.pathname.startsWith("//") ||
    (origin !== null && origin !== configured.origin && origin !== new URL(webOrigin).origin)
  ) {
    throw new Error("Untrusted OAuth authority");
  }
  const nominated = new Set(
    (request.headers.get("connection") ?? "").split(",").map((s) => s.trim().toLowerCase()),
  );
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (
      hopHeaders.has(name) ||
      nominated.has(name) ||
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      name === "x-real-ip" ||
      name.startsWith("proxy-")
    )
      headers.delete(name);
  }
  headers.set("host", configured.host);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(`${configured.origin}${raw.pathname}${raw.search}`, init);
}
function error(code: string, status = 400) {
  return Response.json({ error: code }, { status, headers: { "cache-control": "no-store" } });
}

/** Restrict the accepted grammar before upstream may redirect or default scope. */
export async function guardMcpAuthorize(
  request: Request,
  baseUrl: string,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== MCP_AUTHORIZE_PATH) return null;
  let values: URLSearchParams;
  if (request.method === "GET") {
    values = new URL(request.url).searchParams;
    if (values.getAll("scope").length > 1 || values.getAll("resource").length > 1)
      return error("invalid_request");
  } else if (request.method === "POST") {
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/x-www-form-urlencoded"
    )
      return error("invalid_request", 415);
    try {
      // better-call's form parser takes the last value, without consuming input.
      const form = await request.clone().formData();
      values = new URLSearchParams();
      for (const [key, value] of form) values.set(key, value.toString());
    } catch {
      return error("invalid_request");
    }
  } else return new Response(null, { status: 404 });
  const scope = values.get("scope") ?? "";
  const scopes = scope.split(" ");
  if (
    !scope ||
    scopes.some((s) => !allowedScopes.has(s)) ||
    !scopes.some((s) => s === "mcp:read" || s === "mcp:write") ||
    new Set(scopes).size !== scopes.length
  )
    return error("invalid_scope");
  if (values.get("resource") !== canonicalMcpResource(baseUrl)) return error("invalid_target");
  // No alternate request objects/PAR that could replace the parameters inspected here.
  if (values.has("request") || values.has("request_uri")) return error("invalid_request");
  return null;
}
