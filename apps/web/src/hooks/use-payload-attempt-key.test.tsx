import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { usePayloadAttemptKey } from "./use-payload-attempt-key";

function Harness() {
  const attempt = usePayloadAttemptKey();
  const first = attempt.keyFor({ name: "A" });
  expect(attempt.keyFor({ name: "A" })).toBe(first);
  const changed = attempt.keyFor({ name: "B" });
  expect(changed).not.toBe(first);
  expect(changed).toMatch(/^[0-9a-f-]{36}$/);
  attempt.settle();
  expect(attempt.keyFor({ name: "B" })).not.toBe(changed);
  return null;
}

it("retains a UUID for identical payloads and renews on changed payload or settlement", () => {
  renderToStaticMarkup(<Harness />);
});
