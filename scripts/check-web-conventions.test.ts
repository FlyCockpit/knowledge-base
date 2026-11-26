import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  checkWebConventions,
  formatFinding,
  scanWebCss,
  scanWebSource,
} from "./check-web-conventions.ts";

// A git hook (or any caller) may export GIT_DIR, GIT_INDEX_FILE and the like;
// inherited by the scratch repositories' git calls (here and in
// checkWebConventions), they would point at the caller's repository. Drop every
// GIT_* variable, stop discovery at the temp dir, and turn hooks off for every
// git call in this process and its children (a global core.hooksPath must not
// judge these repos; `git init` and `git add` run hooks too).
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
process.env.GIT_CONFIG_VALUE_0 = "/dev/null";

const FILE = "apps/web/src/components/example.tsx";
function rules(source: string, file = FILE): string[] {
  return scanWebSource(file, source).map((finding) => finding.rule);
}
function accepts(source: string, file = FILE): void {
  assert.deepEqual(scanWebSource(file, source), [], source);
}
function rejects(rule: string, source: string, file = FILE): void {
  assert.ok(rules(source, file).includes(rule), source);
}

describe("scanWebSource G8: the shells own the scroller and the footer", () => {
  it("rejects a scrollbar gutter on the page scroller and a footer in a route file", () => {
    rejects(
      "G8",
      '<main id="main-content" className="min-h-0 overflow-y-auto overflow-x-clip [scrollbar-gutter:stable]" />',
      "apps/web/src/components/public-shell.tsx",
    );
    rejects("G8", '<main className="md:[scrollbar-gutter:stable_both-edges]" />');
    rejects("G8", '<main style={{ scrollbarGutter: "stable" }} />');
    rejects(
      "G8",
      'const frame = { scrollbarGutter: "stable both-edges" }; <main style={{ ...frame }} />',
    );
    rejects("G8", "<footer>links</footer>", "apps/web/src/routes/$lang/_public/index.tsx");
    rejects("G8", '<footer className="mt-auto" />', "apps/web/src/routes/$lang/_app/route.tsx");
    const blog = "apps/web/src/routes/$lang/_public/blog/$slug.tsx";
    rejects("G8", "<div><article>Body</article><footer>links</footer></div>", blog);
    rejects("G8", "<main><footer>links</footer></main>", blog);
  });
  it("accepts a footer that belongs to an article, section or other sectioning element in a route", () => {
    const blog = "apps/web/src/routes/$lang/_public/blog/$slug.tsx";
    accepts("<article><h1>Post</h1><footer>By Ada</footer></article>", blog);
    accepts("<section><div><footer>Updated today</footer></div></section>", blog);
    accepts("<blockquote><p>Quote</p><footer>Ada</footer></blockquote>", blog);
    accepts("<figure><img alt='' /><footer>Credit</footer></figure>", blog);
  });
  it("accepts a gutter on a nested pane, an explicit auto gutter and the shared footer component", () => {
    accepts('<main className="[scrollbar-gutter:auto]" />');
    accepts('<main style={{ scrollbarGutter: "auto" }} />');
    accepts(
      '<div style={{ scrollbarGutter: "stable" }} />',
      "apps/web/src/components/inbox-pane.tsx",
    );
    accepts(
      '<div className="min-h-0 overflow-y-auto overflow-x-clip [scrollbar-gutter:stable]" />',
      "apps/web/src/components/inbox-pane.tsx",
    );
    accepts('<footer className="border-t" />', "apps/web/src/components/public-footer.tsx");
  });
});

describe("scanWebSource G10: text scales and stays at least 12px", () => {
  it("rejects px font sizes and rem/em sizes below 0.75", () => {
    for (const token of [
      "text-[10px]",
      "text-[13px]",
      "md:text-[18px]",
      "text-[10px]/4",
      "text-[length:11px]",
      "text-[0.625rem]",
      "text-[.7em]",
    ])
      rejects("G10", `<span className="${token} font-medium" />`);
    rejects("G10", '<span className={cn("uppercase", compact && "text-[11px]")} />');
  });
  it("accepts the type scale, rem sizes from 0.75 and non-size text utilities", () => {
    for (const token of [
      "text-xs",
      "text-sm/relaxed",
      "text-[0.75rem]",
      "text-[1.125rem]",
      "text-[0.875em]",
      "[&_code]:text-[0.875em]",
      "text-[var(--step)]",
      "text-[length:var(--step)]",
      "text-(--step)",
      "min-h-[44px]",
    ])
      accepts(`<span className="${token}" />`);
    accepts('<span className="text-[10px]" />', "apps/web/src/components/example.test.tsx");
  });
});

describe("scanWebSource G9: surfaces follow the app theme", () => {
  it("rejects literal colour classes and prefers-color-scheme in app source", () => {
    for (const token of [
      "bg-[#f2f2f2]",
      "text-[rgb(0,0,0)]",
      "dark:bg-[oklch(0.2_0_0)]",
      "border-[color:#fff]",
      "fill-[hsl(0_0%_100%)]",
    ])
      rejects("G9", `<div className="${token}" />`);
    rejects("G9", 'const dark = matchMedia("(prefers-color-scheme: dark)").matches;');
    rejects("G9", '<div style={{ backgroundColor: "#fff", color: "#000" }} />');
    rejects("G9", 'const bg = "rgb(0 0 0)"; <div style={{ background: bg }} />');
    rejects("G9", 'const styles = { backgroundColor: "#fff" }; <div style={styles} />');
    rejects("G9", 'const base = { color: "#000" }; <div style={{ ...base, margin: 0 }} />');
    rejects("G9", '<div style={{ clipPath: "url(#fade)", color: "#fade" }} />');
    rejects("G9", '<div style={{ background: "url(#grad) #fff" }} />');
    rejects(
      "G9",
      "const q = `(prefers-color-scheme: dark)`;",
      "packages/ui/src/components/toaster.tsx",
    );
  });
  it("accepts tokens, opacity modifiers, comments and tests", () => {
    for (const token of [
      "bg-popover",
      "text-foreground",
      "bg-black/10",
      "bg-[var(--popover)]",
      "dark:bg-input/30",
      "text-(--state-success)",
    ])
      accepts(`<div className="${token}" />`);
    accepts('<div style={{ color: "var(--foreground)", paddingTop: "var(--safe-area-top)" }} />');
    accepts('const swatch = { color: "#fff" }; // data, not a style');
    accepts('<div style={{ clipPath: "url(#fade)", mask: "url( \'#m\' )" }} />');
    accepts('<div style={{ maskImage: `url("#fade-mask")` }} />');
    accepts('<div style={{ clipPath: "url(/shapes.svg#fade)", mask: "url(\'/m.svg#a\')" }} />');
    accepts('<><a href="#main-content">Skip</a><a href="#fade">Top</a></>');
    accepts("// unlike the OS prefers-color-scheme, the stored choice wins\nconst x = 1;");
    accepts(
      'const q = "(prefers-color-scheme: dark)";',
      "apps/web/src/components/theme-provider.test.tsx",
    );
  });
});

describe("scanWebSource parsing", () => {
  it("parses .ts files without JSX, so a generic arrow is not a tag", () => {
    assert.deepEqual(
      scanWebSource("apps/web/src/lib/example.ts", "export const id = <T>(value: T): T => value;"),
      [],
    );
  });
  it("fails malformed source closed", () => {
    assert.equal(rules("const = {{{")[0], "parse");
  });
});

describe("scanWebCss", () => {
  const file = "packages/ui/src/styles/example.css";
  it("ignores comments and strings", () => {
    assert.equal(scanWebCss(file, '/* .x { color: #fff } */ .a { content: "#fff"; }').length, 0);
  });
  it("keeps literal colours and color-scheme queries in the theme's token file (G9)", () => {
    const app = "apps/web/src/index.css";
    for (const css of [
      ".toast { background: #f2f2f2; }",
      ".toast { color: rgba(0, 0, 0, 0.5); }",
      ":root { --brand: oklch(0.5 0.1 200); }",
      "@media (prefers-color-scheme: dark) { .x { color: var(--foreground); } }",
    ])
      assert.ok(
        scanWebCss(app, css).some((f) => f.rule === "G9"),
        css,
      );
    assert.equal(
      scanWebCss(app, ".x { color: var(--foreground); background: transparent; }").length,
      0,
    );
    assert.equal(scanWebCss(app, '/* #fff */ .x { content: "#fff"; }').length, 0);
    for (const css of [
      ".x { clip-path: url(#fade); }",
      ".x { clip-path: url(/shapes.svg#fade); }",
      ".x { mask: url( #mask-1 ); fill: url('#grad'); }",
      "#fade { color: var(--foreground); }",
      "a[href='#fade'] { color: var(--primary); }",
    ])
      assert.equal(scanWebCss(app, css).length, 0, css);
    for (const css of [".x { fill: url(#grad) #fade; }", ".x { color: #ABCDEF; }"])
      assert.ok(
        scanWebCss(app, css).some((f) => f.rule === "G9"),
        css,
      );
    assert.equal(
      scanWebCss("packages/ui/src/styles/globals.css", ":root { --popover: oklch(1 0 0); }").length,
      0,
    );
  });
  it("skips G9 on a line marked theme-exempt with a reason, and only there", () => {
    accepts(
      '// theme-exempt: QR codes stay dark on white so phones can scan them\nconst qr = <div style={{ background: "#fff" }} />;',
    );
    accepts(
      'const qr = <div className="bg-[#fff]" />; // theme-exempt: QR codes must stay dark on white',
    );
    accepts(
      'const qr = (\n  <div\n    style={{\n      // theme-exempt: QR codes stay dark on white to scan\n      backgroundColor: "#fff",\n    }}\n  />\n);',
    );
    rejects(
      "G9",
      'const qr = (\n  <div\n    style={{\n      // theme-exempt: QR codes stay dark on white to scan\n      backgroundColor: "#fff",\n      color: "#000",\n    }}\n  />\n);',
    );
    accepts(
      'const qr = (\n  <div\n    className={cn(\n      "p-2",\n      // theme-exempt: QR codes stay dark on white to scan\n      "bg-[#fff]",\n    )}\n  />\n);',
    );
    rejects("G9", '// theme-exempt:\nconst qr = <div style={{ background: "#fff" }} />;');
    rejects(
      "G9",
      '// theme-exempt: QR codes stay dark on white\nconst a = 1;\nconst qr = <div style={{ background: "#fff" }} />;',
    );
    const app = "apps/web/src/index.css";
    assert.equal(
      scanWebCss(
        app,
        "/* theme-exempt: the board is the same in both themes */\n.sq { background: #f0d9b5; }",
      ).length,
      0,
    );
    assert.ok(
      scanWebSource(
        FILE,
        '// theme-exempt: fixed art\n<main className="[scrollbar-gutter:stable]" />',
      ).some((f) => f.rule === "G8"),
      "theme-exempt never silences other rules",
    );
  });
  it("rejects a scrollbar gutter on the page scroller (G8)", () => {
    for (const css of [
      "main { scrollbar-gutter: stable; }",
      "#main-content { scrollbar-gutter: stable both-edges; }",
      ".shell > main:not(.x) { scrollbar-gutter: stable; }",
      ".pane, main:is(.a, .b) { scrollbar-gutter: stable; }",
    ])
      assert.equal(scanWebCss("apps/web/src/index.css", css)[0]?.rule, "G8", css);
    for (const css of [
      ".pane { scrollbar-gutter: stable; }",
      "main .pane { scrollbar-gutter: stable; }",
      "#main-content > .list { scrollbar-gutter: stable; }",
      "main { scrollbar-gutter: auto; }",
      "main { scrollbar-gutter: auto !important; }",
      ".pane:not(#main-content) { scrollbar-gutter: stable; }",
      ".pane:not(main, #main-content) { scrollbar-gutter: stable; }",
    ])
      assert.equal(scanWebCss("apps/web/src/index.css", css).length, 0, css);
  });
  it("fails malformed source closed", () => {
    assert.equal(scanWebCss(file, ".a { color: var(--foreground);")[0]?.rule, "parse");
    assert.equal(scanWebCss(file, ".a { } }")[0]?.rule, "parse");
  });
});

describe("checkWebConventions source enumeration and diagnostics", () => {
  it("enumerates tracked plus nonignored untracked web/ui source, ignoring deleted and ignored paths", () => {
    const root = mkdtempSync(join(tmpdir(), "web-conventions-"));
    const write = (file: string, source: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    };
    try {
      // Isolated temporary Git index only; never touches the user's index or creates commits.
      execFileSync("git", ["init", "--quiet", root]);
      write(".gitignore", "ignored/\napps/web/src/components/ignored.tsx\n");
      write(FILE, '<div className="bg-[#fff]" />');
      execFileSync("git", ["add", FILE], { cwd: root });
      write("apps/web/src/routes/untracked.tsx", "<footer>links</footer>");
      write(
        "packages/ui/src/components/untracked.tsx",
        '<main className="[scrollbar-gutter:stable]" />',
      );
      write("packages/ui/src/styles/example.css", ".x { color: #fff; }");
      write("apps/server/src/outside.tsx", '<div className="bg-[#fff]" />');
      write("apps/web/src/components/ignored.tsx", '<div className="bg-[#fff]" />');
      write("apps/web/src/deleted.ts", "const value = 1;");
      execFileSync("git", ["add", "apps/web/src/deleted.ts"], { cwd: root });
      rmSync(join(root, "apps/web/src/deleted.ts"));
      const findings = checkWebConventions(root);
      assert.equal(findings.length, 4, findings.join("\n"));
      for (const finding of findings) {
        assert.match(finding, /^[^:]+:\d+ G[89]: /);
        assert.match(finding, /Fix:/);
        assert.match(finding, /docs\/ui\.md/);
      }
      assert.ok(
        findings.every(
          (finding) =>
            !finding.includes("ignored") &&
            !finding.includes("deleted") &&
            !finding.includes("outside"),
        ),
      );
      write("apps/web/src/broken.ts", "const = {{{");
      assert.ok(
        checkWebConventions(root).some((finding) => finding.includes("broken.ts:1 parse:")),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails Git enumeration errors closed", () => {
    const root = mkdtempSync(join(tmpdir(), "web-conventions-no-git-"));
    try {
      assert.match(checkWebConventions(root).join("\n"), /Cannot enumerate.*Fix Git access/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("formats findings as file:line rule: message", () => {
    assert.equal(
      formatFinding({ file: "a.tsx", line: 3, rule: "G9", message: "m" }),
      "a.tsx:3 G9: m",
    );
  });
});
