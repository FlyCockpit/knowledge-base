/**
 * A secret value that cannot render (R3-W3). String conversion, JSON,
 * `util.inspect` (and so console formatting) and template strings all yield
 * "[redacted]"; only an explicit `.reveal()` at the point of use — the mailer
 * transport, the HMAC, the database driver — returns the value. Every
 * secret-classified env var is parsed into one (see vars/*.ts and
 * secret.test.ts, which pins that against the env manifest).
 *
 * Browser-safe: no node imports (`util.inspect.custom` is a registered symbol).
 */
const REDACTED = "[redacted]";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class Secret<T = string> {
  readonly #value: T;
  constructor(value: T) {
    this.#value = value;
    Object.freeze(this);
  }
  /** The value, for the one call that needs it. Never log or store the result. */
  reveal(): T {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
  [INSPECT](): string {
    return REDACTED;
  }
}

/** zod transform helper: a present string becomes a Secret, absence stays absent. */
export function toSecret<T extends string | undefined>(
  value: T,
): T extends string ? Secret<string> : undefined {
  return (value === undefined ? undefined : new Secret(value)) as T extends string
    ? Secret<string>
    : undefined;
}
