/**
 * Authenticated headless flows for scripts/image-smoke.sh, run on the host
 * against the HTTPS front (NODE_EXTRA_CA_CERTS trusts Caddy's local CA).
 *
 * Exactly the requests the web app and an MCP client make, no browser:
 *   1. sign up (better-auth) → verify through the link mailed to mailpit
 *      → sign in (session cookie) → create a KB (oRPC kbs.create)
 *   2. PAT: oRPC mcpTokens.create (Read preset, read on the KB) → MCP tools/list
 *   3. OAuth: DCR (public native client, loopback redirect) → authorize with the
 *      session cookie and PKCE → oRPC mcpConsent.prepare/approve (the consent
 *      page's procedures) → /oauth2/consent → code from the redirect → token
 *      exchange → MCP tools/list
 * Env: SMOKE_ORIGIN, SMOKE_MAILPIT (mailpit REST base URL), optional
 * SMOKE_ADMIN_EMAIL (the graph's ADMIN_EMAIL; default admin@example.test). Prints one
 * `PASS|FAIL <label>: <detail>` line per check; exits non-zero on any FAIL.
 * Never prints secrets (tokens, cookies, passwords).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

const ORIGIN = process.env.SMOKE_ORIGIN;
const MAILPIT = process.env.SMOKE_MAILPIT;
if (!ORIGIN || !MAILPIT) throw new Error("SMOKE_ORIGIN and SMOKE_MAILPIT are required");
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "http://127.0.0.1:53682/callback";
const READ_TOOLS = ["knowledge_documents_get", "knowledge_documents_list", "knowledge_search"];
const WRITE_TOOLS = ["knowledge_documents_create", "knowledge_documents_update"];

let failed = false;
const report = (ok, label, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  return ok;
};
class Step extends Error {}
const must = (ok, what) => {
  if (!ok) throw new Step(what);
};

const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function call(path, init = {}) {
  const headers = new Headers(init.headers);
  // Browsers send Origin on state-changing requests, not on navigations.
  if ((init.method ?? "GET") !== "GET") headers.set("origin", ORIGIN);
  if (jar.size > 0 && init.cookies !== false) headers.set("cookie", cookieHeader());
  const response = await fetch(new URL(path, ORIGIN), {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  return response;
}
const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
/** On a wrong status, fail with the (error) body; success bodies are never printed. */
async function expectStatus(response, status, label) {
  if (response.status === status) return;
  const body = (await response.text().catch(() => "")).slice(0, 200);
  throw new Step(`${label} answered ${response.status} ${body}`);
}
/** oRPC RPC protocol, as the web client sends it. */
async function rpc(path, input) {
  const init = json({ json: input });
  init.headers["x-csrf-token"] = "orpc";
  const response = await call(`/rpc/${path}`, init);
  const body = await response.json().catch(() => null);
  must(
    response.status === 200,
    `rpc ${path} answered ${response.status} ${JSON.stringify(body?.json ?? null).slice(0, 200)}`,
  );
  return body.json;
}
async function toolsList(authorization) {
  const response = await call("/mcp", {
    method: "POST",
    cookies: false,
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": "tools/list",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "image-smoke", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = await response.json().catch(() => null);
  const names = (body?.result?.tools ?? []).map((tool) => tool.name).sort();
  return { status: response.status, names, error: body?.error ?? null };
}
function assertReadTools(label, listed) {
  const missing = READ_TOOLS.filter((name) => !listed.names.includes(name));
  const extra = WRITE_TOOLS.filter((name) => listed.names.includes(name));
  report(
    listed.status === 200 && !listed.error && missing.length === 0 && extra.length === 0,
    label,
    `HTTP ${listed.status}, ${listed.names.length} tools [${listed.names.join(", ")}]` +
      (missing.length ? `; missing ${missing.join(", ")}` : "") +
      (extra.length ? `; unexpected ${extra.join(", ")}` : ""),
  );
}

async function verificationLink(email) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${MAILPIT}/api/v1/messages`)).json();
    const message = list.messages?.find((m) => m.To?.some((to) => to.Address === email));
    if (message) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
      const href = /href="([^"]*\/api\/auth\/verify-email\?[^"]*)"/.exec(full.HTML ?? "")?.[1];
      if (href) return href.replaceAll("&amp;", "&");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Step(`no verification mail for ${email} in mailpit`);
}

async function main() {
  // 1. account, session, knowledge base
  // Production signup admits only the bootstrap ADMIN_EMAIL on a fresh instance.
  const email = process.env.SMOKE_ADMIN_EMAIL ?? "admin@example.test";
  const password = randomBytes(18).toString("base64url");
  const signUp = await call(
    "/api/auth/sign-up/email",
    json({ email, password, name: "Image Smoke" }),
  );
  await expectStatus(signUp, 200, "sign-up");
  const link = new URL(await verificationLink(email));
  const verified = await call(`${link.pathname}${link.search}`, { cookies: false });
  must(verified.status >= 200 && verified.status < 400, `verify-email answered ${verified.status}`);
  jar.clear();
  const signIn = await call("/api/auth/sign-in/email", json({ email, password }));
  await expectStatus(signIn, 200, "sign-in");
  must(
    [...jar.keys()].some((name) => name.endsWith("session_token")),
    "sign-in set no session cookie",
  );
  const created = await rpc("kbs/create", {
    name: "Image smoke",
    slug: `smoke-${randomBytes(4).toString("hex")}`,
    description: "Production image smoke",
    idempotencyKey: randomUUID(),
  });
  const kbId = created?.kb?.id;
  must(typeof kbId === "string", "kbs.create returned no KB id");
  report(true, "f. sign-up, mailpit verification, sign-in and kbs.create", `KB ${kbId}`);

  // 2. personal access token
  try {
    const minted = await rpc("mcpTokens/create", {
      name: "image smoke",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [{ kbId, bits: ["read"] }],
    });
    must(typeof minted?.secret === "string", "mcpTokens.create returned no secret");
    assertReadTools(
      "g. PAT (oRPC mcpTokens.create) MCP tools/list",
      await toolsList(`Bearer ${minted.secret}`),
    );
  } catch (error) {
    report(false, "g. PAT MCP tools/list", error instanceof Step ? error.message : String(error));
  }

  // 3. OAuth authorization code + PKCE
  try {
    const registration = await call("/api/auth/oauth2/register", {
      // An MCP client registers anonymously, without the user's session.
      cookies: false,
      ...json({
        client_name: "image smoke oauth",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        application_type: "native",
        scope: "mcp:read",
      }),
    });
    await expectStatus(registration, 201, "DCR");
    const { client_id: clientId } = await registration.json();
    const verifier = randomBytes(32).toString("base64url");
    const state = randomUUID();
    const authorize = await call(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        resource: RESOURCE,
        scope: "mcp:read",
        state,
      })}`,
    );
    // Better Auth answers a 302, or {redirect, url} to a fetch-style request.
    let next = authorize.status === 302 ? authorize.headers.get("location") : null;
    if (authorize.status === 200) next = (await authorize.json()).url;
    else if (!next) await expectStatus(authorize, 302, "authorize");
    must(typeof next === "string", "authorize gave no redirect");
    const consentPage = new URL(next, ORIGIN);
    must(
      consentPage.pathname.endsWith("/mcp-consent"),
      `authorize redirected to ${consentPage.pathname}`,
    );
    // The consent page's own projection of the signed query (buildSignedOAuthQuery).
    const params = new URLSearchParams(consentPage.search);
    const signed = new Set(params.getAll("ba_param"));
    const oauthQuery = new URLSearchParams(
      [...params].filter(([key]) => key === "sig" || key === "ba_param" || signed.has(key)),
    ).toString();
    const review = await rpc("mcpConsent/prepare", { oauthQuery });
    await rpc("mcpConsent/approve", {
      referenceId: review.referenceId,
      nonce: review.nonce,
      oauthQuery,
      selection: { scopes: ["mcp:read"], toolGroups: ["read"], acl: [{ kbId, bits: ["read"] }] },
      explicitConsent: true,
    });
    const consent = await call(
      "/api/auth/oauth2/consent",
      json({ accept: true, oauth_query: oauthQuery }),
    );
    await expectStatus(consent, 200, "oauth2/consent");
    const redirect = new URL((await consent.json()).url);
    must(
      redirect.origin + redirect.pathname === REDIRECT &&
        redirect.searchParams.get("state") === state,
      "consent did not redirect to the registered loopback callback",
    );
    const code = redirect.searchParams.get("code");
    must(Boolean(code), "redirect carried no code");
    const exchanged = await call("/api/auth/oauth2/token", {
      method: "POST",
      cookies: false,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
      }),
    });
    await expectStatus(exchanged, 200, "token exchange");
    const { access_token: accessToken, token_type: tokenType } = await exchanged.json();
    must(typeof accessToken === "string", "token exchange returned no access token");
    must(/^bearer$/i.test(tokenType ?? ""), `unexpected token type ${tokenType}`);
    assertReadTools(
      "h. OAuth (DCR → authorize → consent → token) MCP tools/list",
      await toolsList(`Bearer ${accessToken}`),
    );
  } catch (error) {
    report(false, "h. OAuth MCP tools/list", error instanceof Step ? error.message : String(error));
  }
}

try {
  await main();
} catch (error) {
  report(false, "f. account setup", error instanceof Step ? error.message : String(error));
}
process.exitCode = failed ? 1 : 0;
