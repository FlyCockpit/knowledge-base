import { connectServiceLog, logEvent } from "@knowledge-base/env/log";

// Connected before anything logs, exactly as the service bootstrap does.
connectServiceLog();
if (process.argv[2] === "--exit-code") {
  process.exit(23);
} else if (process.argv[2] === "--signal") {
  logEvent("worker.started");
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      logEvent("worker.shutdown-start", { signal });
      // The parent must retain the channel through the whole graceful drain.
      setTimeout(() => {
        logEvent("worker.job-completed", { count: 1 });
        process.exit(0);
      }, 30);
    });
  setInterval(() => {}, 1000);
} else {
  await import(process.argv[2]!);
  const { spawn } = await import("node:child_process");
  const { createQwenSupervisor } = await import("./qwen-lifecycle");
  const supervisor = createQwenSupervisor({
    childEntry: process.argv[3]!,
    modelPath: "/unused/model.gguf",
    lease: {
      acquire: async () => true,
      renew: async () => true,
      release: async () => {},
    },
    budgetBytes: () => 64 * 1024 ** 3,
    spawn: (_command, _args, options) => spawn(process.execPath, [process.argv[3]!], options),
  });
  try {
    await supervisor.countTokens({
      purpose: "query",
      texts: ["test"],
      runtime: {
        modelId: "qwen3-embedding-0.6b-q8_0",
        epoch: 1,
        config: { contextTokens: 4096, kvKeyType: "f16", kvValueType: "f16" },
      },
    });
  } finally {
    await supervisor.close();
  }
}
