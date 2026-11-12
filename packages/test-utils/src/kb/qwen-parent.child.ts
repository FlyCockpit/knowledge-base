// Worker-parent stand-in for the parent-SIGKILL case of qwen-process.integration.test.ts.
// Runs the real supervisor (real guard, real fork) and reports its model child PID.
type Supervisor = {
  embed(input: {
    purpose: "document";
    texts: string[];
    runtime: {
      modelId: string;
      epoch: number;
      config: { contextTokens: number; kvKeyType: string; kvValueType: string };
    };
  }): Promise<number[][]>;
  snapshot(): { pid: number | null };
};
/** A READY model epoch plus the admin runtime config it runs under. */
const rt = (epoch: number) => ({
  modelId: "qwen3-embedding-0.6b-q8_0",
  epoch,
  config: { contextTokens: 4096, kvKeyType: "f16", kvValueType: "f16" } as const,
});
// Dynamic module URL keeps this composite TS project inside its root.
const { createQwenSupervisor } = (await import(
  new URL("../../../../apps/worker/src/lib/qwen-lifecycle.ts", import.meta.url).href
)) as { createQwenSupervisor(options: Record<string, unknown>): Supervisor };

const supervisor = createQwenSupervisor({
  guardPath: process.env.QWEN_GUARD ?? "",
  childEntry: process.env.QWEN_CHILD ?? "",
  modelPath: "/nonexistent/model.gguf",
  childEnv: {
    FAKE_QWEN_DIR: process.env.FAKE_QWEN_DIR ?? "",
    FAKE_QWEN_MODE: process.env.FAKE_QWEN_MODE ?? "",
  },
  lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
});
await supervisor.embed({ purpose: "document", texts: ["alive"], runtime: rt(1) });
process.stdout.write(`${JSON.stringify({ childPid: supervisor.snapshot().pid })}\n`);
setInterval(() => {}, 1000);
