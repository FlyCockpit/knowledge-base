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
});
