import type { KnowledgeBase, OperationIntent, User } from "@knowledge-base/db/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDeep } from "vitest-mock-extended";

import {
  createKnowledgeBase,
  updateKnowledgeBase,
  validateKbDescription,
  validateKbName,
  validateKbSlug,
} from "./bases";
import { KbDomainError } from "./errors";
import { canonicalRequestHash } from "./operation-intent";
import { kbDescriptionSchema, kbNameSchema } from "./protocol/common";
import { kbWriteToolSchemas } from "./protocol/writes";
import { setKbRecoveryComplete } from "./recovery";
import type { KbRuntimeConfig } from "./runtime";

describe("kb metadata bounds", () => {
  it.each([
    [kbNameSchema, validateKbName, 1, 120],
    [kbDescriptionSchema, validateKbDescription, 10, 2000],
  ] as const)(
    "uses the same scalar bounds in protocol and domain",
    (schema, validate, min, max) => {
      for (const size of [min - 1, min, max - 1, max, max + 1]) {
        const value = "😀".repeat(size);
        const valid = size >= min && size <= max;
        expect(schema.safeParse(value).success).toBe(valid);
        if (valid) expect(() => validate(value)).not.toThrow();
        else expect(() => validate(value)).toThrow(KbDomainError);
      }
    },
  );

  it("rejects NUL, Markdown-forbidden controls and lone surrogates but preserves tab/CR/LF and joiners", () => {
    for (const value of [
      "description\0bad",
      "description\u0001bad",
      "description\u007fbad",
      "description\ud800bad",
      "description\udfffbad",
    ]) {
      expect(kbDescriptionSchema.safeParse(value).success).toBe(false);
      expect(() => validateKbDescription(value)).toThrow(KbDomainError);
    }
    const description = "description\t\n\r\u200c\u200d";
    expect(kbDescriptionSchema.safeParse(description).success).toBe(true);
    expect(() => validateKbDescription(description)).not.toThrow();
    expect(() => validateKbName("joiners\u200c\u200d")).not.toThrow();
  });
  it("enforces name, slug, and description limits", () => {
    expect(() => validateKbName("")).toThrow(KbDomainError);
    expect(() => validateKbSlug("Bad_Slug")).toThrow(KbDomainError);
    expect(() => validateKbDescription("short")).toThrow(KbDomainError);
    validateKbName("Notes");
    validateKbSlug("notes");
    validateKbDescription("ten chars!!");
  });

  it("rejects control characters and lone surrogates in names", () => {
    expect(() => validateKbName("bad\u0000name")).toThrow(KbDomainError);
    expect(() => validateKbName("bad\u0001name")).toThrow(KbDomainError);
    expect(() => validateKbName("bad\u007fname")).toThrow(KbDomainError);
    expect(() => validateKbName("tab\tname")).toThrow(KbDomainError);
    expect(() => validateKbName("multi\nline")).toThrow(KbDomainError);
    expect(() => validateKbName("\ud800lone")).toThrow(KbDomainError);
    expect(() => validateKbName("lone\udfff")).toThrow(KbDomainError);
    validateKbName("emoji 😀 pair \ud83d\ude00");
  });
});

describe("metadata scalar bounds match the common schema", () => {
  it.each(["😀", "界", "é"])("accepts exact scalar boundaries for %s", (scalar) => {
    const input = {
      name: scalar.repeat(120),
      slug: "unicode",
      description: scalar.repeat(2000),
      idempotencyKey: "unicode-create-key-0000",
    };
    expect(kbWriteToolSchemas.knowledge_bases_create.input.safeParse(input).success).toBe(true);
    expect(() => validateKbName(input.name)).not.toThrow();
    expect(() => validateKbDescription(input.description)).not.toThrow();
    expect(() => validateKbName(scalar.repeat(121))).toThrow(KbDomainError);
    expect(() => validateKbDescription(scalar.repeat(2001))).toThrow(KbDomainError);
    expect(() => validateKbDescription(scalar.repeat(10))).not.toThrow();
    expect(() => validateKbDescription(scalar.repeat(9))).toThrow(KbDomainError);
  });

  it("rejects invalid descriptions while preserving Markdown whitespace", () => {
    for (const description of [
      "valid length \u0007control",
      "valid length \u007fcontrol",
      "valid length \ud800surrogate",
    ]) {
      expect(() => validateKbDescription(description)).toThrow(KbDomainError);
    }
    validateKbDescription("valid\tMarkdown\r\nwhitespace");
  });
});

describe("metadata update replay ordering at the service boundary", () => {
  beforeEach(() => setKbRecoveryComplete(true));
  afterEach(() => setKbRecoveryComplete(false));

  function fixture() {
    const runtime = mockDeep<KbRuntimeConfig>();
    runtime.canonicalOrigin = "https://kb.example.invalid";
    const kb = mockDeep<KnowledgeBase>();
    Object.assign(kb, {
      id: "a".repeat(24),
      ownerId: "owner",
      state: "ACTIVE",
      name: "Valid",
      slug: "valid",
      description: "A valid metadata description",
      metadataVersion: 2,
      headSha: "b".repeat(40),
      activeGenerationId: null,
    });
    const user = mockDeep<User>();
    Object.assign(user, {
      id: "owner",
      role: "user",
      banned: false,
      banExpires: null,
      twoFactorEnabled: true,
      createdAt: new Date("2020-01-01"),
    });
    runtime.prisma.user.findUnique.mockResolvedValue(user);
    runtime.prisma.appSetting.findMany.mockResolvedValue([]);
    runtime.prisma.knowledgeBase.findUnique.mockResolvedValue(kb);
    const input = {
      kbId: kb.id,
      metadataVersion: 1,
      idempotencyKey: "metadata-update-key-0000",
      name: "Valid",
    };
    const receipt = mockDeep<OperationIntent>();
    Object.assign(receipt, {
      requestHash: canonicalRequestHash(input),
      phase: "FINALIZED",
      responseBody: { operationId: "11111111-1111-4111-8111-111111111111" },
    });
    runtime.prisma.operationIntent.findFirst.mockResolvedValue(receipt);
    return { runtime, input, kb, receipt };
  }

  // Transports reject this metadata structurally (shared schema); the domain
  // service itself still checks the receipt before fresh validation.
  it("replays valid metadata but mismatches changed invalid metadata at the service", async () => {
    const { runtime, input, receipt } = fixture();
    const replay = await updateKnowledgeBase(runtime, "owner", input);
    expect(replay.operationId).toBe("11111111-1111-4111-8111-111111111111");
    for (const change of [{ name: "bad\u0007name" }, { description: "invalid\u0007description" }]) {
      const changed = { ...input, ...change };
      expect(kbWriteToolSchemas.knowledge_bases_update.input.safeParse(changed).success).toBe(
        false,
      );
      await expect(updateKnowledgeBase(runtime, "owner", changed)).rejects.toMatchObject({
        code: "IDEMPOTENCY_MISMATCH",
      });
    }
    expect(receipt.phase).toBe("FINALIZED");
    expect(runtime.coordinator.run).not.toHaveBeenCalled();
  });

  it("rejects fresh invalid metadata before the coordinator or any write", async () => {
    const { runtime, input } = fixture();
    runtime.prisma.operationIntent.findFirst.mockResolvedValue(null);
    await expect(
      updateKnowledgeBase(runtime, "owner", { ...input, name: "bad\u0007name" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(runtime.coordinator.run).not.toHaveBeenCalled();
    expect(runtime.prisma.knowledgeBase.update).not.toHaveBeenCalled();
  });

  it("create also detects changed invalid metadata before fresh validation", async () => {
    const { runtime } = fixture();
    const input = {
      name: "Valid",
      slug: "valid",
      description: "A valid metadata description",
      idempotencyKey: "metadata-create-key-0000",
    };
    runtime.prisma.$queryRaw.mockResolvedValue([
      {
        opId: "11111111-1111-4111-8111-111111111111",
        requestHash: canonicalRequestHash(input),
        phase: "FINALIZED",
        reservedKbId: "a".repeat(24),
        responseBody: { operationId: "11111111-1111-4111-8111-111111111111" },
      },
    ]);
    expect((await createKnowledgeBase(runtime, "owner", input)).operationId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    await expect(
      createKnowledgeBase(runtime, "owner", { ...input, name: "bad\u0007name" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    expect(runtime.coordinator.run).not.toHaveBeenCalled();
  });

  it("requires live authority before disclosing a key mismatch", async () => {
    const { runtime, input } = fixture();
    runtime.prisma.knowledgeBase.findUnique.mockResolvedValue(null);
    await expect(
      updateKnowledgeBase(runtime, "owner", { ...input, name: "bad\u0007name" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(runtime.prisma.operationIntent.findFirst).not.toHaveBeenCalled();
  });
});
