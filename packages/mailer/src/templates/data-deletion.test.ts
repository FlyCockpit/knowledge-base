import { describe, expect, it } from "vitest";
import { renderDataDeletion } from "./data-deletion.js";

const args = {
  name: "drop_x",
  effects: "column x",
  deletedAt: new Date("2026-11-11T00:00:00Z"),
  backup: "backup-id.age",
  note: null,
  locale: "en-US",
};
describe("renderDataDeletion", () => {
  it("localizes both supported bundles and falls back to English", () => {
    const en = renderDataDeletion(args);
    const es = renderDataDeletion({ ...args, locale: "es-MX" });
    expect(es.subject).toContain("eliminación");
    expect(es.html).toContain('lang="es-MX"');
    expect(renderDataDeletion({ ...args, locale: "unsupported" })).toEqual(en);
    expect(en.html).toContain("docs/backup-restore.md");
    expect(en.html).toContain("isolated database and data volume");
  });
  it("escapes every data field and provides translated null fallbacks", () => {
    const { html } = renderDataDeletion({
      ...args,
      name: "<script>",
      effects: '<img src="x">',
      backup: "<bundle>",
      note: "<note>",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;bundle&gt;");
    expect(html).toContain("&lt;note&gt;");
    const missing = renderDataDeletion({ ...args, effects: null, backup: null, locale: "es-MX" });
    expect(missing.html).toContain("No se registró");
    expect(missing.html).toContain("Consulta contract.sql");
  });
});
