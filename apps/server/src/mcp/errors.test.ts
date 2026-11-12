import { KbAdmissionError } from "@knowledge-base/api/lib/kb/principal";
import { expect, it } from "vitest";
import { AuthServiceUnavailableError, admissionErrorResponse } from "./errors";

it("redacts failures and supplies an origin-bound challenge only for 401", async () => {
  for (const [code, status] of [
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["STORAGE_UNAVAILABLE", 503],
  ] as const) {
    const response = admissionErrorResponse(
      new KbAdmissionError(code, "private canary"),
      "https://kb.example.invalid",
    );
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private canary");
    expect(response.headers.has("www-authenticate")).toBe(status === 401);
  }
});

it("names signing-key outages without changing the internal admission class", async () => {
  const error = new AuthServiceUnavailableError();
  expect(error).toBeInstanceOf(KbAdmissionError);
  expect(error.code).toBe("STORAGE_UNAVAILABLE");
  const response = admissionErrorResponse(error, "https://kb.example.invalid");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "AUTH_UNAVAILABLE" });
  expect(response.headers.has("www-authenticate")).toBe(false);
});
