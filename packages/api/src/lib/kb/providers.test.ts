import { describe, expect, it, vi } from "vitest";
import { createProvider, providerCreateInput, providerProbeInput } from "./providers";

const input = {
  name: "Provider",
  endpointUrl: "https://example.com/embed",
  model: "m",
  dimensions: 2,
  apiKey: "fixture-canary",
  idempotencyKey: "test",
};
describe("provider enrollment boundaries", () => {
  it("rejects NUL in final name/model for create and model re-probe, preserving Unicode", () => {
    for (const field of ["name", "model"]) {
      expect(providerCreateInput.safeParse({ ...input, [field]: "a\0b" }).success).toBe(false);
    }
    const { name: _name, ...configuration } = input;
    expect(
      providerProbeInput.safeParse({ ...configuration, providerId: "p".repeat(24), model: "a\0b" })
        .success,
    ).toBe(false);
    expect(
      providerCreateInput.parse({ ...input, name: "  模型 🌟  ", model: "é\u200d模型" }),
    ).toMatchObject({ name: "模型 🌟", model: "é\u200d模型" });
  });
  it("requires explicit valid encryption configuration before allocating durable work", async () => {
    const run = vi.fn();
    for (const masterKey of [undefined, "invalid"])
      await expect(
        createProvider(
          { coordinator: { run }, prisma: {} as never, ratePort: {} as never },
          "user",
          input,
          masterKey,
        ),
      ).rejects.toMatchObject({ code: "ENCRYPTION_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects extra ownership/config fields and credential header injection at the entry point", () => {
    for (const delta of [
      { ownerId: "other" },
      { kind: "SYSTEM_BUILTIN" },
      { dimensions: 2001 },
      { dimensions: 0 },
      { apiKey: "key\r\nHeader: value" },
      { apiKey: "" },
      { idempotencyKey: "bad key" },
    ])
      expect(providerCreateInput.safeParse({ ...input, ...delta }).success).toBe(false);
    expect(providerCreateInput.parse(input).dimensions).toBe(2);
    expect(providerProbeInput.safeParse(input).success).toBe(false);
  });
});
