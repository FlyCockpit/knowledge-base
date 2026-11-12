import { join } from "node:path";
import {
  drainMutatingChild,
  pingProcessFence,
  spawnMutatingChild,
  waitMutatingChild,
} from "./kb-process.js";

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

const dataRoot = process.env.KB_DATA_ROOT;
if (!dataRoot) {
  log("FAIL missing KB_DATA_ROOT");
  process.exit(2);
}
const cwd = join(dataRoot, "repos");

await pingProcessFence();
log(`READY ${process.pid} ${process.ppid}`);

const quick = await spawnMutatingChild({
  opId: "op_quick",
  argv: [process.execPath, "-e", "process.exit(7)"],
  cwd,
});
const waited = await waitMutatingChild("op_quick", quick.pid);
log(`WAITED ${waited.status}`);

try {
  await drainMutatingChild("op_quick", quick.pid);
  log("DRAIN_AFTER_WAIT success");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`DRAIN_AFTER_WAIT ${message}`);
}

const live = await spawnMutatingChild({
  opId: "op_live",
  argv: [process.execPath, "-e", "setTimeout(() => {}, 20000)"],
  cwd,
});
try {
  await drainMutatingChild("op_stale", live.pid);
  log("STALE_DRAIN success");
} catch (error) {
  log(`STALE_DRAIN ${error instanceof Error ? error.message : String(error)}`);
}
process.kill(live.pid, 0);
log("LIVE_PRESERVED");
const quick2 = await spawnMutatingChild({
  opId: "op_quick2",
  argv: [process.execPath, "-e", "process.exit(0)"],
  cwd,
});
await new Promise((resolve) => setTimeout(resolve, 400));

const results = await Promise.allSettled([
  drainMutatingChild("op_live", live.pid),
  waitMutatingChild("op_quick2", quick2.pid),
  drainMutatingChild("op_missing", 2_147_000_000),
]);
const names = ["op_live", "op_quick2", "op_missing"] as const;
for (const [index, result] of results.entries()) {
  const name = names[index] ?? `op_${index}`;
  if (result.status === "fulfilled") {
    log(`CONCUR ${name} ok ${result.value.status}`);
  } else {
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    log(`CONCUR ${name} fail ${message}`);
  }
}

log("DONE");
process.exit(0);
