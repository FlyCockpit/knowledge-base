// This entry loads no application graph. Bootstrap and every dependency run
// behind pipes owned by superviseService, including during module evaluation.
import "@knowledge-base/env/load-dotenv";
import { superviseService } from "@knowledge-base/env/service-output";

superviseService(
  "server",
  new URL(import.meta.url.endsWith(".ts") ? "./bootstrap.ts" : "./service.mjs", import.meta.url),
);
