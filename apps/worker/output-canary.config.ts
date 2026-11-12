// Same bundler and workspace inclusion as the shipped worker. This entry is a
// test prerequisite only; no production bundle includes the canary.
export default {
  entry: {
    index: new URL("./src/lib/output-canary.fixture.ts", import.meta.url).pathname,
    child: new URL("./src/lib/output-canary-child.fixture.ts", import.meta.url).pathname,
  },
  format: "esm",
  deps: { alwaysBundle: [/@knowledge-base\/.*/] },
};
