/** Every MCP request ends after this long (its permit aborts with a TimeoutError). */
export const MCP_REQUEST_DEADLINE_MS = 30_000;

/** A permit owns work until it settles. Cancellation alone never proves drain. */
export function createAdmissionGate() {
  let closed = false;
  const active = new Set<AbortController>();
  const waiters = new Set<() => void>();
  return {
    get closed() {
      return closed;
    },
    get outstanding() {
      return active.size;
    },
    admit(client: AbortSignal) {
      if (closed) return null;
      const controller = new AbortController();
      active.add(controller);
      const cancel = () => controller.abort(client.reason);
      client.addEventListener("abort", cancel, { once: true });
      if (client.aborted) cancel();
      const deadlineAt = Date.now() + MCP_REQUEST_DEADLINE_MS;
      const timer = setTimeout(
        () => controller.abort(new DOMException("Deadline exceeded", "TimeoutError")),
        MCP_REQUEST_DEADLINE_MS,
      );
      timer.unref();
      return {
        signal: controller.signal,
        /** When `signal` aborts with the request deadline (epoch ms). */
        deadlineAt,
        release() {
          clearTimeout(timer);
          client.removeEventListener("abort", cancel);
          active.delete(controller);
          if (closed && active.size === 0) {
            for (const resolve of waiters) resolve();
            waiters.clear();
          }
        },
      };
    },
    close() {
      closed = true;
      for (const controller of active) controller.abort();
      return active.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.add(resolve));
    },
  };
}
