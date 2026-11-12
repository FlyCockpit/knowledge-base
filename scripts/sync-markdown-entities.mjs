/** Generate the server/local CommonMark named-reference table from the exact
 * character-entities data already pinned by the approved GFM renderer. No
 * runtime package/dependency is added. Re-run after a renderer dependency bump.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const web = createRequire(new URL("../apps/web/package.json", import.meta.url));
const markdown = createRequire(web.resolve("react-markdown"));
const parse = createRequire(markdown.resolve("remark-parse"));
const fromMarkdown = createRequire(parse.resolve("mdast-util-from-markdown"));
const decode = createRequire(fromMarkdown.resolve("decode-named-character-reference"));
const { characterEntities } = await import(decode.resolve("character-entities"));
const output = `${JSON.stringify(characterEntities, null, 2)}\n`;
// Preserve the pinned source data's MIT attribution with the generated table.
const files = [
  [new URL("../packages/api/src/lib/kb/fixtures/markdown-entities.json", import.meta.url), output],
  [
    new URL("../packages/api/src/lib/kb/fixtures/markdown-entities.LICENSE", import.meta.url),
    readFileSync(join(dirname(decode.resolve("character-entities")), "license")),
  ],
];
for (const [path, contents] of files) {
  if (process.argv.includes("--check")) {
    if (!readFileSync(path).equals(Buffer.from(contents)))
      throw new Error(`Generated Markdown entities drifted: ${path}`);
  } else writeFileSync(path, contents);
}
