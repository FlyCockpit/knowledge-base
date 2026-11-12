import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { useRenewableAttemptKey } from "./use-renewable-attempt-key";

function Harness({ keys, onRenewed }: { keys: string[]; onRenewed: (key: string) => void }) {
  const attempt = useRenewableAttemptKey();
  const [pass, setPass] = useState(0);
  keys.push(attempt.key);
  if (pass === 1) onRenewed(attempt.renew());
  if (pass < 2) setPass(pass + 1);
  return null;
}

it("keeps a compact key across rerenders until explicitly renewed", () => {
  const keys: string[] = [];
  let renewed = "";

  renderToStaticMarkup(
    <Harness
      keys={keys}
      onRenewed={(key) => {
        renewed = key;
      }}
    />,
  );
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).toBe(renewed);
  expect(keys[2]).not.toBe(keys[0]);
  expect(renewed).toMatch(/^[0-9a-f]{32}$/);
});
