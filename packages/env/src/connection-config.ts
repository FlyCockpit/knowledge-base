/** Driver syntax belongs to the driver. Retain only closed startup diagnostics
 * if constructing one fails; its exception/cause may contain credentials. Only
 * that synchronous construction is a configuration error: a failed connection
 * keeps its own class and stable driver code at the caller's stage. */
export class ConnectionConfigError extends Error {
  readonly code = "CONNECTION_CONFIG";
  readonly stage: "postgres" | "redis";
  readonly reason = "DRIVER_REJECTED";
  constructor(readonly setting: "DATABASE_URL" | "REDIS_URL") {
    super("Connection driver rejected configuration");
    this.stage = setting === "DATABASE_URL" ? "postgres" : "redis";
  }
  logDetail() {
    return { setting: this.setting, reason: this.reason };
  }
}

export function initializeConnection<T>(setting: "DATABASE_URL" | "REDIS_URL", create: () => T): T {
  try {
    return create();
  } catch {
    throw new ConnectionConfigError(setting);
  }
}
