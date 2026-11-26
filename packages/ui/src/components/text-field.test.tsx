import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SelectField } from "./text-field";

function field<T extends string>(value: T, errors: readonly unknown[] = []) {
  return {
    name: "role",
    state: { value, meta: { errors } },
    handleChange: () => {},
  };
}

const ROLES = [
  { value: "user", label: "Member" },
  { value: "admin", label: "Administrator" },
] as const;

/** The text of the closed trigger's value slot. */
function closedValue(html: string): string {
  const match = html.match(/data-slot="select-value"[^>]*>(.*?)<\/span>/);
  return (match?.[1] ?? "").replace(/<[^>]+>/g, "");
}

describe("SelectField", () => {
  it("shows the chosen option's label in the closed trigger, never the raw value", () => {
    const html = renderToStaticMarkup(
      <SelectField field={field("admin")} label="Role" options={ROLES} />,
    );
    expect(closedValue(html)).toBe("Administrator");
    expect(closedValue(html)).not.toContain("admin");
  });

  it("follows the value: another choice shows its own label", () => {
    const html = renderToStaticMarkup(
      <SelectField field={field("user")} label="Role" options={ROLES} />,
    );
    expect(closedValue(html)).toBe("Member");
  });

  it("shows the label of the empty-string 'unset' option", () => {
    const html = renderToStaticMarkup(
      <SelectField
        field={field("")}
        label="Plan"
        options={[
          { value: "", label: "No plan" },
          { value: "f16", label: "16 GB" },
        ]}
      />,
    );
    expect(closedValue(html)).toBe("No plan");
  });

  it("shows the placeholder while the value matches no option", () => {
    const html = renderToStaticMarkup(
      <SelectField field={field("")} label="Role" placeholder="Choose a role" options={ROLES} />,
    );
    expect(closedValue(html)).toBe("Choose a role");
  });

  it("wires the label, the invalid state and the error message to the trigger", () => {
    const html = renderToStaticMarkup(
      <SelectField field={field("user", ["Pick a role"])} label="Role" options={ROLES} />,
    );
    const id = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(`aria-describedby="${id}-error"`);
    expect(html).toContain("Pick a role");
  });
});
