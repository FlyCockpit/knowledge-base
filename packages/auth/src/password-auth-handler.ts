import { withPasswordSignInFence } from "./password-sign-in-fence.js";
import { PASSWORD_WRITE_PATHS, withPasswordWriteLock } from "./password-write-lock.js";

const AUTH_BASE_PATH = "/api/auth";
const PASSWORD_SIGN_IN_PATH = `${AUTH_BASE_PATH}/sign-in/email`;

type PasswordAuth = {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (input: { headers: Headers }) => Promise<{
      user: { id: string };
      session: { id: string };
    } | null>;
  };
};

/**
 * The HTTP password-security boundary shared by the server and operational
 * harness. The caller supplies the canonical Better Auth instance; its raw
 * handler runs exactly once, inside the appropriate fence or write lock.
 * Server middleware still owns header sanitization, rate limits and admin gates.
 */
export function handlePasswordAuthRequest(auth: PasswordAuth, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const run = () => auth.handler(request);
  if (request.method === "POST" && path === PASSWORD_SIGN_IN_PATH) {
    return withPasswordSignInFence(request, run);
  }
  const authPath = path.startsWith(`${AUTH_BASE_PATH}/`) ? path.slice(AUTH_BASE_PATH.length) : "";
  if (request.method === "POST" && PASSWORD_WRITE_PATHS.has(authPath)) {
    return withPasswordWriteLock(authPath, request, run, {
      getSession: (headers) => auth.api.getSession({ headers }),
    });
  }
  return run();
}
