// Small fake Qwen model child for the real-process lifecycle suite
// (qwen-process.integration.test.ts). Speaks the exact parent<->child IPC
// protocol of apps/worker/src/lib/qwen-child.ts but loads no native addon, so
// clock and barriers are deterministic. Behavior is selected by FAKE_QWEN_MODE
// (comma list); barriers are files under FAKE_QWEN_DIR.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_QWEN_DIR ?? "";
const modes = new Set((process.env.FAKE_QWEN_MODE ?? "").split(",").filter(Boolean));
const pid = process.pid;
const mark = (name) => writeFileSync(join(dir, `${name}.${pid}`), "");
const waitFor = (name) =>
  new Promise((resolveWait) => {
    const poll = setInterval(() => {
      if (existsSync(join(dir, name))) {
        clearInterval(poll);
        resolveWait();
      }
    }, 5);
  });

if (modes.has("stubborn")) process.on("SIGTERM", () => {});
if (modes.has("stubborn") || modes.has("ignore-disconnect")) setInterval(() => {}, 1000);
process.on("disconnect", () => {
  if (!modes.has("ignore-disconnect")) process.exit(1);
});

const vector = () =>
  Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : i === 1 ? (pid % 997) + 1 : 0));

process.on("message", async (message) => {
  if (message?.t === "shutdown") {
    if (!modes.has("stubborn")) process.exit(0);
    return;
  }
  if (message?.t === "count") {
    mark("counting");
    if (modes.has("hold-count")) await waitFor("release-count");
    process.send({
      t: "counts",
      token: message.token,
      counts: message.texts.map((text) => text.length + 1),
      limit: Number(process.env.KB_QWEN_CONTEXT_TOKENS),
    });
    return;
  }
  if (message?.t === "probe") {
    mark("probing");
    if (modes.has("hold-probe")) await waitFor("release-probe");
    process.send({ t: "result", token: message.token, vectors: [vector()], peakRssBytes: null });
    return;
  }
  if (message?.t !== "embed") return;
  appendFileSync(join(dir, "embeds.log"), `${pid} ${message.token} ${message.texts.join("|")}\n`);
  if (modes.has("crash-once") && !existsSync(join(dir, "crashed"))) {
    writeFileSync(join(dir, "crashed"), String(pid));
    process.kill(pid, "SIGKILL");
    return;
  }
  if (modes.has("hold-embed") || (modes.has("hold-document") && message.purpose === "document")) {
    mark("embedding");
    await waitFor("release-embed");
  }
  if (modes.has("stale-first"))
    process.send({
      t: "result",
      token: `stale-${message.token}`,
      vectors: message.texts.map(vector),
    });
  process.send({ t: "result", token: message.token, vectors: message.texts.map(vector) });
});

mark("started");
if (modes.has("hold-load")) {
  mark("loading");
  await waitFor("release-load");
}
process.send({ t: "ready" });
