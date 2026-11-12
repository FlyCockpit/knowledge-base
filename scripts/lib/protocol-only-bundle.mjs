/** Protocol-only bundle entries (the pre-receive hook, the mirror helper, the
 * model child, the index reader thread) answer on their own protocol channel
 * and must never load the logger: its stderr default would reach a Git client,
 * a parent's capture or a dropped pipe. The built artifact is the proof. After
 * each tsdown build, this walks every chunk an entry can load (static and
 * dynamic imports, as rolldown resolved them) and fails the build if one of
 * them contains the logger module. Types: ./protocol-only-bundle.d.mts. */

const LOGGER = /(?:^|[\\/])packages[\\/]env[\\/]src[\\/]log\.ts$/;

/** Each problem as one line; empty when every protocol-only entry is clean. */
export function protocolOnlyViolations(chunks, protocolOnly, loggingEntry) {
  const byFile = new Map(
    chunks.flatMap((chunk) => (chunk.type === "chunk" ? [[chunk.fileName, chunk]] : [])),
  );
  const entry = (name) =>
    [...byFile.values()].find((chunk) => chunk.isEntry && chunk.name === name);
  /** The chain of chunk files from the entry to the first chunk holding the logger. */
  const loggerPath = (start) => {
    const from = new Map([[start.fileName, undefined]]);
    const queue = [start];
    for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
      if (chunk.moduleIds?.some((id) => LOGGER.test(id))) {
        const path = [];
        for (let file = chunk.fileName; file; file = from.get(file)) path.unshift(file);
        return path;
      }
      for (const next of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
        const target = byFile.get(next);
        if (!target || from.has(next)) continue;
        from.set(next, chunk.fileName);
        queue.push(target);
      }
    }
    return undefined;
  };

  const problems = [];
  // Positive control: the service does log, so a walk that cannot see the
  // logger (no module ids, a renamed module) fails instead of passing.
  const service = entry(loggingEntry);
  if (!service) problems.push(`no "${loggingEntry}" entry chunk in the build output`);
  else if (!loggerPath(service))
    problems.push(`the "${loggingEntry}" entry does not reach the logger: the check is blind`);
  for (const name of protocolOnly) {
    const chunk = entry(name);
    if (!chunk) {
      problems.push(`no "${name}" entry chunk in the build output`);
      continue;
    }
    const path = loggerPath(chunk);
    if (path) problems.push(`protocol-only entry "${name}" loads the logger: ${path.join(" -> ")}`);
  }
  return problems;
}

/** tsdown `build:done` hook: fail the build on any violation. */
export function assertProtocolOnlyBundle(protocolOnly, loggingEntry = "service") {
  return ({ chunks }) => {
    const problems = protocolOnlyViolations(chunks, protocolOnly, loggingEntry);
    if (problems.length > 0) throw new Error(problems.join("\n"));
  };
}
