import { describe, expect, it, vi } from "vitest";

vi.mock("pg", () => ({ Client: vi.fn() }));

import { Client } from "pg";
import { credentialQuery } from "./credential-query";

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
});
