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
      const timer = setTimeout(
        () => controller.abort(new DOMException("Deadline exceeded", "TimeoutError")),
        30_000,
      );
      timer.unref();
      return {
        signal: controller.signal,
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
