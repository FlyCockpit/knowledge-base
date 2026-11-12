import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptKbSecret } from "./envelope";

const state = vi.hoisted(() => ({ query: vi.fn(), identity: vi.fn() }));
vi.mock("./authority-lock", () => ({
  runLockedOperation: async (options: { run: (lease: unknown) => unknown }) =>
    options.run({ transaction: (run: (query: unknown) => unknown) => run(state.query) }),
}));
vi.mock("./permissions", () => ({ sqlAuthorityStore: () => ({ loadIdentity: state.identity }) }));
vi.mock("./embed-client", async (original) => ({
  ...(await original<typeof import("./embed-client")>()),
  requestOpenAiEmbeddings: vi.fn(async () => [[1, 0]]),
}));

import { requestOpenAiEmbeddings } from "./embed-client";
import { createProviderEmbedder } from "./embedder";

const pin = { providerId: "p".repeat(24), revision: 1, ownerId: "owner" };
const masterKey = Buffer.alloc(32, 7);
const row = {
  endpointUrl: "https://example.com/embed",
  model: "m",
  dimensions: 2,
  ciphertext: JSON.stringify(
    encryptKbSecret(
      "fixture-canary",
      {
        aadVersion: 1,
        purpose: "provider-secret",
        userId: pin.ownerId,
        objectId: pin.providerId,
        revision: "1",
      },
      masterKey,
    ),
  ),
  aadVersion: 1,
  keyVersion: 1,
  state: "COMPLETE",
};
const embedder = () =>
  createProviderEmbedder(
    { connectionString: "fixture", masterKey: masterKey.toString("base64") },
    pin,
  );
describe("pinned embedder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.identity.mockResolvedValue({
      banned: false,
      twoFactorSatisfied: true,
      instanceEnabled: true,
    });
    state.query.mockResolvedValue({ rows: [row] });
  });
  it("checks the same immutable revision before dispatch and before returning for both purposes", async () => {
    for (const purpose of ["document", "query"] as const)
      expect(await embedder().embed(["x"], { purpose })).toEqual([[1, 0]]);
    expect(state.query).toHaveBeenCalledTimes(4);
    for (const [, values] of state.query.mock.calls)
      expect(values).toEqual([pin.providerId, 1, "owner"]);
  });
  it("rejects sensitive queries/documents before provider/key lookup and external calls", async () => {
    await expect(
      embedder().embed(["sk-fixture-canary-0123456789"], { purpose: "query" }),
    ).rejects.toMatchObject({ code: "SENSITIVE_QUERY" });
    await expect(
      embedder().embed(["sk-fixture-canary-0123456789"], { purpose: "document" }),
    ).rejects.toMatchObject({
      code: "SENSITIVE_QUERY",
      message: "Sensitive document text rejected",
    });
    expect(state.query).not.toHaveBeenCalled();
    expect(requestOpenAiEmbeddings).not.toHaveBeenCalled();
  });
  it("rejects pending, missing/revoked/ownerless providers before networking and drops late results", async () => {
    vi.mocked(requestOpenAiEmbeddings).mockClear();
    for (const rows of [[], [{ ...row, state: "PENDING" }], [{ ...row, keyVersion: 2 }]]) {
      state.query.mockResolvedValue({ rows });
      await expect(embedder().embed(["x"], { purpose: "query" })).rejects.toMatchObject({
        code: "INDEX_UNAVAILABLE",
      });
    }
    expect(requestOpenAiEmbeddings).not.toHaveBeenCalled();
    state.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    await expect(embedder().embed(["x"], { purpose: "document" })).rejects.toMatchObject({
      code: "INDEX_UNAVAILABLE",
    });
    expect(requestOpenAiEmbeddings).toHaveBeenCalledTimes(1);
  });
  it("runs the request fence after key lookup and before the provider request", async () => {
    const beforeDispatch = vi.fn(async () => {
      throw new Error("cancelled query");
    });
    await expect(
      embedder().embed(["query"], { purpose: "query", beforeDispatch }),
    ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    expect(state.query).toHaveBeenCalledTimes(1);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(requestOpenAiEmbeddings).not.toHaveBeenCalled();
  });
});
