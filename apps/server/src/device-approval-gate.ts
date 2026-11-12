import type { createDeviceApprovalService } from "@knowledge-base/auth/device-approval";
import { z } from "zod";

type Options = {
  baseUrl: string;
  webOrigin?: string;
  getSession: (input: {
    headers: Headers;
  }) => Promise<{ user: { id: string }; session: { id: string } } | null>;
  service: Pick<ReturnType<typeof createDeviceApprovalService>, "check">;
};
const deny = (status: 401 | 403 | 404) =>
  Response.json(
    { error: "Device approval unavailable" },
    { status, headers: { "cache-control": "no-store" } },
  );
/** Mount before Better Auth. Its own hook repeats the check for non-Hono callers. */
export async function guardDeviceApproval(
  request: Request,
  options: Options,
): Promise<Response | null> {
  const raw = new URL(request.url).pathname;
  let path: string;
  try {
    path = decodeURIComponent(raw).replace(/\/+$/, "");
  } catch {
    return deny(404);
  }
  if (path !== "/api/auth/device" && !path.startsWith("/api/auth/device/")) return null;
  if (raw !== path || path === "/api/auth/device/token") return deny(404);
  if (path === "/api/auth/device/code") return null;
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  const session = await options.getSession({ headers });
  if (!session) return deny(401);
  if (path === "/api/auth/device" && request.method === "GET") {
    const origin = headers.get("origin");
    const trusted =
      origin !== null &&
      [
        new URL(options.baseUrl).origin,
        new URL(options.webOrigin ?? options.baseUrl).origin,
      ].includes(origin);
    return (origin && !trusted) || (headers.get("sec-fetch-site") === "cross-site" && !trusted)
      ? deny(403)
      : null;
  }
  if (
    request.method !== "POST" ||
    !["/api/auth/device/approve", "/api/auth/device/deny"].includes(path)
  )
    return deny(404);
  const origin = headers.get("origin");
  const nonce = headers.get("x-device-approval-nonce");
  if (
    !origin ||
    ![
      new URL(options.baseUrl).origin,
      new URL(options.webOrigin ?? options.baseUrl).origin,
    ].includes(origin) ||
    !z.uuid().safeParse(nonce).success ||
    headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
  )
    return deny(403);
  try {
    const body = z
      .strictObject({ userCode: z.string().regex(/^[A-Z0-9]{8}$/) })
      .parse(await request.clone().json());
    await options.service.check(
      { userId: session.user.id, sessionId: session.session.id },
      { ...body, nonce: z.uuid().parse(nonce) },
      path.endsWith("/approve") ? "approve" : "deny",
    );
    return null;
  } catch {
    return deny(403);
  }
}
