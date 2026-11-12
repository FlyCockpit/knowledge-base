import type { RouteSessionResolution } from "@/lib/route-session-access";

/** Fixture transport for the server function; the real provider resolves its cookie. */
export async function getRouteSession(): Promise<RouteSessionResolution> {
  const response = await fetch("/fixture/mcp/session", { credentials: "include" });
  if (!response.ok) throw new Error("Fixture session probe failed");
  return response.json();
}
