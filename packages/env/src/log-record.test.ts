import { describe, expect, it } from "vitest";
import { logRecord, PASSWORD_PEPPER_DOCS, validateLogRecord } from "./log-record";

const fingerprint = "0123456789abcdef";

describe("password pepper records", () => {
  const record = logRecord("password-pepper", {
    event: "key-refused",
    fingerprint,
    unknownFingerprint: fingerprint,
    count: 2,
    docs: PASSWORD_PEPPER_DOCS,
  });
  it("accepts only the exact event-specific fields", () => {
    expect(validateLogRecord(record)).toEqual(record);
    for (const change of [
      { fingerprint: "0123456789abcdeg" },
      { fingerprint: `${fingerprint}0` },
      { unknownFingerprint: "ABCDEF0123456789" },
      { count: -1 },
      { count: 1.5 },
      { event: "other" },
      { docs: "other" },
      { extra: "data" },
      { previousFingerprint: undefined },
    ])
      expect(validateLogRecord({ ...record, ...change })).toBeUndefined();
    expect(validateLogRecord({ ...record, event: "ok" })).toBeUndefined();
    expect(
      validateLogRecord({ ...record, unknownFingerprints: `${fingerprint}, 1111111111111111` }),
    ).toBeDefined();
    for (const unknownFingerprints of [
      [fingerprint],
      [fingerprint, "invalid"],
      ["1111111111111111", fingerprint],
    ])
      expect(validateLogRecord({ ...record, unknownFingerprints })).toBeUndefined();
  });
});
