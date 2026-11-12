import type { TestProject } from "vitest/node";

/**
 * The native control socket belongs to Vitest's worker thread. Closing that
 * thread sends SIGTERM to the still-running main process, sometimes before
 * global teardown/reporting. Vitest's terminal cleanup listener would exit
 * immediately and race the actual suite result.
 *
 * This harness owns SIGTERM instead. Check completion at process exit: the
 * worker can close before its final reporting messages reach the main thread.
 * Unfinished/failed files and unhandled errors still fail. The unchanged native
 * drain deadline kills a stalled runner and all its descendants.
 */
export default function setup(project: TestProject) {
  for (const handler of process.listeners("SIGTERM")) process.off("SIGTERM", handler);
  let controlClosed = false;
  process.on("SIGTERM", () => {
    controlClosed = true;
    process.stderr.write(
      "test-kb: supervisor control connection closed; preserving the completed result or failing an interrupted run.\n",
    );
  });
  process.once("exit", () => {
    if (!controlClosed) return;
    const files = project.vitest.state.getFiles();
    const expected = project.vitest.config.include.length;
    const completed =
      expected > 0 &&
      files.length === expected &&
      files.every((file) => file.result?.state === "pass" || file.result?.state === "fail");
    if (
      !completed ||
      files.some((file) => file.result?.state === "fail") ||
      project.vitest.state.getUnhandledErrors().length > 0
    ) {
      process.stderr.write(
        `test-kb: incomplete or failed result: ${files.length}/${expected} files, states ${JSON.stringify(files.map((file) => file.result?.state))}, ${project.vitest.state.getUnhandledErrors().length} unhandled errors.\n`,
      );
      process.exitCode = 1;
    }
  });
}
