import { describe, expect, it, vi } from "vitest";

vi.mock("pg", () => ({ Client: vi.fn() }));

import { Client } from "pg";
import { CREDENTIAL_TEARDOWN_MS, credentialQuery } from "./credential-query";

describe("owned credential SQL", () => {
  it("pre-abort never opens a connection or invokes the authority callback", async () => {
    const signal = AbortSignal.abort();
    const run = vi.fn();
    await expect(credentialQuery("unused")(signal, run)).rejects.toBeDefined();
    expect(Client).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("an abort during the connect handshake settles and never runs the callback", async () => {
    // pg@8: once end() runs before the startup handshake finishes, connect()
    // never settles; only the client's "end" event reports the closed socket.
    const listeners = new Set<(error?: Error) => void>();
    const client = {
      on: vi.fn((event: string, listener: (error?: Error) => void) => {
        if (event === "end") listeners.add(listener);
        return client;
      }),
      removeListener: vi.fn((event: string, listener: (error?: Error) => void) => {
        if (event === "end") listeners.delete(listener);
        return client;
      }),
      connect: vi.fn(() => new Promise<void>(() => {})),
      query: vi.fn(),
      end: vi.fn(async () => {
        for (const listener of [...listeners]) listener();
      }),
    };
    // biome-ignore lint/complexity/useArrowFunction: Client is constructed with `new`.
    vi.mocked(Client).mockImplementation(function () {
      return client;
    } as unknown as () => Client);
    const controller = new AbortController();
    const run = vi.fn();
    const settled = credentialQuery("unused")(controller.signal, run);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalled());
    controller.abort();
    await expect(settled).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  /**
   * Connections whose peer answers SQL (except `hang` prefixes; `fail` prefixes
   * reject, as pg's query_timeout does on the cancel connection; `after` delays
   * a reply until a promise settles; `timeout` statements fail with the given
   * SQLSTATE once their `SET LOCAL statement_timeout` elapses, as PostgreSQL
   * cancels them) but never closes a socket on `end()`.
   * Like pg, destroying a socket fails its pending queries and ends its client.
   * The first connection is the transaction's, the second the cancel's.
   */
  function silentPeer(
    options: {
      hang?: string[];
      fail?: string[];
      after?: Record<string, Promise<void>>;
      timeout?: Record<string, string>;
    } = {},
  ) {
    const sent: string[] = [];
    const destroyed: number[] = [];
    let made = 0;
    const make = () => {
      const index = made++;
      const hung = new Set<(error: Error) => void>();
      const enders = new Set<() => void>();
      let closed = false;
      let statementTimeoutMs = 0;
      const destroy = vi.fn(() => {
        closed = true;
        destroyed.push(index);
        for (const reject of hung) reject(new Error("Connection terminated"));
        hung.clear();
        for (const end of enders) end();
        enders.clear();
      });
      const client = {
        on: vi.fn(() => client),
        removeListener: vi.fn(() => client),
        connect: vi.fn(async () => {}),
        query: vi.fn(async (text: string | { text: string }) => {
          const sql = typeof text === "string" ? text : text.text;
          sent.push(sql);
          if (closed) throw new Error("Connection terminated");
          if (options.fail?.some((prefix) => sql.startsWith(prefix)))
            throw new Error("Query read timeout");
          const limit = /^SET LOCAL statement_timeout = '(\d+)ms'$/.exec(sql);
          if (limit) statementTimeoutMs = Number(limit[1]);
          const timedOut = Object.entries(options.timeout ?? {}).find(([prefix]) =>
            sql.startsWith(prefix),
          );
          if (timedOut)
            return new Promise((_, reject) => {
              hung.add(reject);
              setTimeout(() => {
                hung.delete(reject);
                reject(Object.assign(new Error("canceling statement"), { code: timedOut[1] }));
              }, statementTimeoutMs);
            });
          if (options.hang?.some((prefix) => sql.startsWith(prefix)))
            return new Promise((_, reject) => hung.add(reject));
          const gate = Object.entries(options.after ?? {}).find(([prefix]) =>
            sql.startsWith(prefix),
          );
          if (gate) await gate[1];
          return { rows: sql.includes("pg_backend_pid") ? [{ pid: 7 }] : [] };
        }),
        end: vi.fn(() =>
          closed
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                enders.add(resolve);
              }),
        ),
        connection: { stream: { destroy } },
      };
      return client;
    };
    // biome-ignore lint/complexity/useArrowFunction: Client is constructed with `new`.
    vi.mocked(Client).mockImplementation(function () {
      return make();
    } as unknown as () => Client);
    /** Whether the transaction's own socket (connection 0) was destroyed. */
    const destroy = { called: () => destroyed.includes(0) };
    return { destroy, sent };
  }

  it("a committed query whose peer never closes settles within the teardown bound", async () => {
    vi.useFakeTimers();
    try {
      const { destroy, sent } = silentPeer();
      let settled = false;
      const done = credentialQuery("unused")(new AbortController().signal, async () => "ok").then(
        (value) => {
          settled = true;
          return value;
        },
      );
      await vi.advanceTimersByTimeAsync(CREDENTIAL_TEARDOWN_MS - 1);
      // Ownership is held until the closure is joined.
      expect(settled).toBe(false);
      expect(destroy.called()).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(done).resolves.toBe("ok");
      expect(destroy.called()).toBe(true);
      // No ROLLBACK after an acknowledged COMMIT.
      expect(sent).toContain("COMMIT");
      expect(sent).not.toContain("ROLLBACK");
    } finally {
      vi.useRealTimers();
    }
  });

  it("without proof that the backend finished, ownership is kept however long the peer is silent", async () => {
    vi.useFakeTimers();
    try {
      // The callback's SQL never answers and neither does the cancel query:
      // no COMMIT, no termination proof.
      const { destroy } = silentPeer({
        hang: ["SELECT slow"],
        fail: ["SELECT pg_terminate_backend"],
      });
      let settled = false;
      const done = credentialQuery("unused")(new AbortController().signal, (query) =>
        query("SELECT slow"),
      ).finally(() => {
        settled = true;
      });
      done.catch(() => {});
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(false);
      expect(destroy.called()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a backend proven terminated releases ownership within the bound even if the peer stays silent", async () => {
    vi.useFakeTimers();
    try {
      // The callback hangs; at the 30 s deadline stop() terminates the backend
      // (the cancel query proves it), but the peer never closes the socket.
      const { destroy, sent } = silentPeer({ hang: ["SELECT slow"] });
      let settled = false;
      const done = credentialQuery("unused")(new AbortController().signal, (query) =>
        query("SELECT slow"),
      ).finally(() => {
        settled = true;
      });
      done.catch(() => {});
      // Terminated at 30 s; the socket close, the cancel connection and the
      // final end() each get one bounded teardown.
      await vi.advanceTimersByTimeAsync(30_000 + 4 * CREDENTIAL_TEARDOWN_MS);
      expect(settled).toBe(true);
      await expect(done).rejects.toBeDefined();
      expect(destroy.called()).toBe(true);
      expect(sent.some((sql) => sql.startsWith("SELECT pg_terminate_backend"))).toBe(true);
      // No ROLLBACK on a terminated backend.
      expect(sent).not.toContain("ROLLBACK");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["statement timeout", "57014"],
    ["transaction timeout", "25P04"],
  ])(
    "PostgreSQL's %s at the shared deadline is the typed deadline refusal, not a driver error",
    async (_, code) => {
      vi.useFakeTimers();
      try {
        // PostgreSQL enforces the same 30 s deadline as the process; the server
        // side may trip first (by a millisecond, or more after a wall-clock step).
        let locked!: () => void;
        const lockReply = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const { sent } = silentPeer({
          timeout: { "SELECT slow": code },
          after: { "SELECT pg_advisory_xact_lock": lockReply },
        });
        const done = credentialQuery("unused")(new AbortController().signal, (query) =>
          query("SELECT slow"),
        );
        done.catch(() => {});
        await vi.advanceTimersByTimeAsync(0);
        // A wall-clock step forward after the deadline was taken must not
        // shorten the statement_timeout handed to the server.
        vi.setSystemTime(Date.now() + 20_000);
        locked();
        await vi.advanceTimersByTimeAsync(0);
        expect(sent.at(-1)).toBe("SELECT slow");
        expect(sent.at(-2)).toMatch(/^SET LOCAL statement_timeout = '(29\d{3}|30000)ms'$/);
        await vi.advanceTimersByTimeAsync(30_000 + 4 * CREDENTIAL_TEARDOWN_MS);
        await expect(done).rejects.toMatchObject({
          code: "STORAGE_UNAVAILABLE",
          message: "Admission deadline exceeded",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("a COMMIT that answers after the caller's abort still proves completion", async () => {
    vi.useFakeTimers();
    try {
      let reply!: () => void;
      const commitReply = new Promise<void>((resolve) => {
        reply = resolve;
      });
      // Cancellation never proves termination and the peer never closes.
      const { destroy, sent } = silentPeer({
        fail: ["SELECT pg_terminate_backend"],
        after: { COMMIT: commitReply },
      });
      const controller = new AbortController();
      let settled = false;
      const done = credentialQuery("unused")(controller.signal, async () => "ok").finally(() => {
        settled = true;
      });
      done.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toContain("COMMIT");
      controller.abort();
      reply();
      await vi.advanceTimersByTimeAsync(10 * CREDENTIAL_TEARDOWN_MS);
      // The caller is refused (aborted), yet teardown is bounded by the proof.
      expect(settled).toBe(true);
      await expect(done).rejects.toBeDefined();
      expect(destroy.called()).toBe(true);
      expect(sent).not.toContain("ROLLBACK");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cancel after the handshake but before BEGIN is bounded even if the peer stays silent", async () => {
    vi.useFakeTimers();
    try {
      // Connected, but the first query (the backend pid) never answers.
      const { destroy, sent } = silentPeer({ hang: ["SELECT pg_backend_pid"] });
      const controller = new AbortController();
      let settled = false;
      const done = credentialQuery("unused")(controller.signal, async () => "never").finally(() => {
        settled = true;
      });
      done.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(CREDENTIAL_TEARDOWN_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
      await expect(done).rejects.toBeDefined();
      expect(destroy.called()).toBe(true);
      expect(sent).not.toContain("BEGIN");
      expect(sent.some((sql) => sql.startsWith("SELECT pg_terminate_backend"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps concurrent credential connections and sheds the excess as busy", async () => {
    vi.useFakeTimers();
    // Fresh slot accounting: earlier tests leave silent-peer calls holding slots.
    vi.resetModules();
    const {
      CREDENTIAL_CONNECTIONS_MAX,
      CredentialCapacityError,
      credentialQuery,
      credentialSlotsForTests,
    } = await import("./credential-query");
    try {
      // Connections that succeed and close normally; the callback holds them.
      const client = {
        on: vi.fn(() => client),
        removeListener: vi.fn(() => client),
        connect: vi.fn(async () => {}),
        query: vi.fn(async (text: string | { text: string }) => ({
          rows: String(typeof text === "string" ? text : text.text).includes("pg_backend_pid")
            ? [{ pid: 7 }]
            : [],
        })),
        end: vi.fn(async () => {}),
      };
      // biome-ignore lint/complexity/useArrowFunction: Client is constructed with `new`.
      vi.mocked(Client).mockImplementation(function () {
        return client;
      } as unknown as () => Client);
      vi.mocked(Client).mockClear();
      const sql = credentialQuery("unused");
      let open!: () => void;
      const held = new Promise<void>((resolve) => {
        open = resolve;
      });
      const holders = Array.from({ length: CREDENTIAL_CONNECTIONS_MAX }, () =>
        sql(new AbortController().signal, () => held),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(credentialSlotsForTests()).toEqual({ inUse: CREDENTIAL_CONNECTIONS_MAX, waiting: 0 });
      expect(Client).toHaveBeenCalledTimes(CREDENTIAL_CONNECTIONS_MAX);

      // One more waits without a connection, then is refused as busy.
      const shed = sql(new AbortController().signal, async () => "never");
      shed.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(credentialSlotsForTests().waiting).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(shed).rejects.toBeInstanceOf(CredentialCapacityError);
      expect(Client).toHaveBeenCalledTimes(CREDENTIAL_CONNECTIONS_MAX);

      // A waiter gets the next freed slot; an aborted waiter leaves the queue.
      const queued = sql(new AbortController().signal, async () => "served");
      const leaving = new AbortController();
      const abandoned = sql(leaving.signal, async () => "never");
      abandoned.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      leaving.abort();
      await expect(abandoned).rejects.toBeDefined();
      expect(credentialSlotsForTests().waiting).toBe(1);
      open();
      await expect(queued).resolves.toBe("served");
      await Promise.all(holders);
      expect(credentialSlotsForTests()).toEqual({ inUse: 0, waiting: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
