import { describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

const delivery = vi.hoisted(() => ({ run: vi.fn(), send: vi.fn() }));
vi.mock("@knowledge-base/db", () => ({ default: { tag: "prisma" } }));
vi.mock("@knowledge-base/env/shared", () => ({
  env: {
    KB_MASTER_KEY: new Secret("master"),
    DATABASE_URL: new Secret("postgresql://disposable.invalid/kb"),
  },
}));
vi.mock("@knowledge-base/mailer", () => ({
  sendEmail: delivery.send,
  isEmailConfigured: () => true,
}));
vi.mock("@knowledge-base/api/lib/kb/kb-email", () => ({ runKbEmailDelivery: delivery.run }));

import { handleKbEmailJob } from "./kb-email.js";

const durableJobId = "550e8400-e29b-41d4-a716-446655440000";

describe("handleKbEmailJob", () => {
  it("runs the durable delivery with the real mailer transport and the KB master key", async () => {
    delivery.run.mockResolvedValue({ sent: true });
    await expect(handleKbEmailJob({ data: { durableJobId } } as never)).resolves.toEqual({
      sent: true,
    });
    const [db, input] = delivery.run.mock.calls[0]!;
    expect(db).toEqual({ tag: "prisma" });
    expect(input).toMatchObject({
      durableJobId,
      connectionString: "postgresql://disposable.invalid/kb",
      masterKey: "master",
      emailConfigured: true,
    });
    const authorizeSend = vi.fn();
    await input.send({ to: "a@example.com", subject: "s", html: "h" }, authorizeSend);
    expect(delivery.send).toHaveBeenCalledWith({
      to: "a@example.com",
      subject: "s",
      html: "h",
      authorizeSend,
    });
  });

  it("rejects a payload that is not an ids-only durable reference", async () => {
    await expect(
      handleKbEmailJob({ data: { durableJobId, to: "a@example.com" } } as never),
    ).rejects.toThrow();
  });
});
